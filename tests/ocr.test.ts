/**
 * 내장 텍스트 OCR (PP-OCRv5) 단위 테스트.
 *
 * 잠근 계약:
 *  1. inference.yml character_dict 파싱 (인용·키 동일 들여쓰기·블록 종료)
 *  2. CTC greedy 디코드 — 중복 붕괴·blank 제거·space 클래스·신뢰도
 *  3. det 확률맵 connected-component bbox (thresh/box_thresh/min_size)
 *  4. runPdfOcr 페이지 번호 1-based 계약 (pdfium page.number 는 0-based —
 *     환산 누락 시 페이지가 한 장씩 밀리는 off-by-one, 수식 OCR 에서 실재했던 결함)
 *  5. OcrProvider 인터페이스 (기존 계약)
 *  6. 모델이 로컬에 있으면 엔진 E2E (없으면 skip — CI 에는 모델 없음):
 *     가로 한글 줄 인식, 세로로 쌓인 글자의 글자별 인식 + 잉크 외곽 좌표
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseCharacterDict, getOcrModelStatus } from "../src/ocr/models.js"
import { ctcDecode, componentBoxes } from "../src/ocr/engine.js"
import { runPdfOcr } from "../src/ocr/pdf-ocr.js"
import type { OcrProvider, ParseWarning } from "../src/types.js"

describe("OCR 사전 파싱 (parseCharacterDict)", () => {
  it("키와 같은 들여쓰기의 리스트 + 인용 문자 + 블록 종료", () => {
    const yml = [
      "PostProcess:",
      "  name: CTCLabelDecode",
      "  character_dict:",
      "  - ᄀ",
      "  - 가",
      "  - '7'",
      "  - ':'",
      "  - ''''",
      "  next_key: value",
    ].join("\n")
    assert.deepEqual(parseCharacterDict(yml), ["ᄀ", "가", "7", ":", "'"])
  })

  it("character_dict 없으면 빈 배열", () => {
    assert.deepEqual(parseCharacterDict("Global:\n  model: x\n"), [])
  })
})

describe("CTC greedy 디코드", () => {
  const dict = ["가", "나", "다"] // 클래스: 0=blank, 1..3=사전, 4=space
  const C = 5

  /** 스텝별 argmax 인덱스 시퀀스로 확률 텐서 구성 (softmax 확률 0.9) */
  function seq(...idx: number[]): Float32Array {
    const data = new Float32Array(idx.length * C).fill(0.025)
    idx.forEach((c, t) => { data[t * C + c] = 0.9 })
    return data
  }

  it("연속 중복 붕괴 후 blank 제거: [가,가,blank,나] → 가나", () => {
    const r = ctcDecode(seq(1, 1, 0, 2), 4, C, dict)
    assert.equal(r?.text, "가나")
  })

  it("blank 로 분리된 같은 글자는 두 번: [가,blank,가] → 가가", () => {
    const r = ctcDecode(seq(1, 0, 1), 3, C, dict)
    assert.equal(r?.text, "가가")
  })

  it("마지막 클래스는 space", () => {
    const r = ctcDecode(seq(1, 4, 2), 3, C, dict)
    assert.equal(r?.text, "가 나")
  })

  it("전부 blank 면 null", () => {
    assert.equal(ctcDecode(seq(0, 0, 0), 3, C, dict), null)
  })

  it("신뢰도 = 채택 스텝 확률 평균", () => {
    const r = ctcDecode(seq(1, 2), 2, C, dict)
    assert.ok(r && Math.abs(r.confidence - 0.9) < 1e-6, `conf=${r?.confidence}`)
  })
})

describe("det 확률맵 성분 bbox (componentBoxes)", () => {
  function probMap(w: number, h: number, rects: Array<[number, number, number, number]>, p = 0.95): Float32Array {
    const m = new Float32Array(w * h)
    for (const [x1, y1, x2, y2] of rects) {
      for (let y = y1; y <= y2; y++) for (let x = x1; x <= x2; x++) m[y * w + x] = p
    }
    return m
  }

  it("분리된 두 영역이 별도 박스로, 위→아래 정렬", () => {
    const m = probMap(40, 20, [[2, 12, 20, 16], [5, 2, 30, 6]])
    const boxes = componentBoxes(m, 40, 20)
    assert.equal(boxes.length, 2)
    assert.deepEqual([boxes[0].y1, boxes[0].x1], [2, 5], "위 영역 먼저")
    assert.deepEqual([boxes[1].y1, boxes[1].x1], [12, 2])
  })

  it("낮은 점수(box_thresh 0.6 미만) 성분은 버림", () => {
    const m = probMap(20, 10, [[2, 2, 15, 6]], 0.45) // thresh 0.3 초과지만 box_thresh 미만
    assert.equal(componentBoxes(m, 20, 10).length, 0)
  })

  it("min_size 미만(양 차원 3px 미만) 성분은 버림", () => {
    const m = probMap(20, 10, [[4, 4, 5, 5]])
    assert.equal(componentBoxes(m, 20, 10).length, 0)
  })
})

describe("runPdfOcr 페이지 번호 계약 (1-based)", () => {
  function tinyTwoPagePdf(): ArrayBuffer {
    const src = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >> endobj
trailer << /Root 1 0 R >>`
    const bytes = new TextEncoder().encode(src)
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }

  it("프로바이더가 받는 pageNumber 와 결과 키가 1-based (off-by-one 회귀)", async () => {
    const seen: number[] = []
    const warnings: ParseWarning[] = []
    const result = await runPdfOcr(
      tinyTwoPagePdf(),
      new Set([1, 2]),
      async (_img, pageNumber) => { seen.push(pageNumber); return `p${pageNumber}` },
      warnings,
    )
    assert.deepEqual(seen, [1, 2], "pdfium 0-based index 가 그대로 새면 [0,1]")
    assert.equal(result.get(1)?.[0]?.text, "p1")
    assert.equal(result.get(2)?.[0]?.text, "p2")
  })

  it("targets 에 없는 페이지는 렌더하지 않는다", async () => {
    const seen: number[] = []
    await runPdfOcr(tinyTwoPagePdf(), new Set([2]), async (_i, n) => { seen.push(n); return "x" }, [])
    assert.deepEqual(seen, [2])
  })
})

describe("OcrProvider 인터페이스", () => {
  it("타입 호환성 — async 함수로 구현 가능", async () => {
    const mockProvider: OcrProvider = async (pageImage, pageNumber, mimeType) => {
      assert.ok(pageImage instanceof Uint8Array || pageImage.length >= 0)
      assert.equal(typeof pageNumber, "number")
      assert.equal(mimeType, "image/png")
      return `페이지 ${pageNumber}의 OCR 결과`
    }

    const result = await mockProvider(new Uint8Array([1, 2, 3]), 1, "image/png")
    assert.equal(result, "페이지 1의 OCR 결과")
  })

  it("에러 throw 가능", async () => {
    const failProvider: OcrProvider = async () => {
      throw new Error("OCR 서비스 연결 실패")
    }

    await assert.rejects(
      () => failProvider(new Uint8Array([]), 1, "image/png"),
      (err: Error) => err.message.includes("OCR 서비스 연결 실패")
    )
  })
})

describe("내장 엔진 E2E (모델 있을 때만)", () => {
  it("합성 한글 이미지 인식", async (t) => {
    const status = await getOcrModelStatus()
    if (!status.every(s => s.verified)) {
      t.skip("OCR 모델 미설치 — `kordoc check-ocr-models` 후 실행됨")
      return
    }
    let sharp: typeof import("sharp")["default"]
    try {
      sharp = (await import("sharp")).default
    } catch {
      t.skip("sharp 미설치")
      return
    }
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="420" height="80"><rect width="420" height="80" fill="white"/><text x="20" y="52" font-size="32" font-family="sans-serif">대한민국 정부 2026</text></svg>`
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { OcrEngine } = await import("../src/ocr/engine.js")
    const engine = await OcrEngine.create()
    try {
      const items = await engine.recognizePage(new Uint8Array(data), info.width, info.height)
      const text = items.map(i => i.text).join("")
      assert.ok(text.includes("대한민국"), `인식 결과: ${text}`)
      assert.ok(text.includes("2026"), `인식 결과: ${text}`)
    } finally {
      await engine.destroy()
    }
  })

  it("목차 줄 — 리더 점은 따로 떼어 인식하고 \"제목 … 쪽번호\" 한 아이템으로", async (t) => {
    const status = await getOcrModelStatus()
    if (!status.every(s => s.verified)) { t.skip("OCR 모델 미설치"); return }
    let sharp: typeof import("sharp")["default"]
    try { sharp = (await import("sharp")).default } catch { t.skip("sharp 미설치"); return }
    // 종전 엔진은 리더를 버리고 쪽번호를 제목에 붙였다("II. 대내외 여건141") — 코퍼스 목차에선 점 뒤 숫자까지
    // 망쳤다("·····5"→"…55", "·····141"→"…11")
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1400" height="90"><rect width="1400" height="90" fill="white"/>` +
      `<text x="30" y="58" font-size="34" font-family="sans-serif" font-weight="bold">Ⅱ. 대내외 여건 ${"\u00b7".repeat(8)}141</text></svg>`
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { OcrEngine } = await import("../src/ocr/engine.js")
    const engine = await OcrEngine.create()
    try {
      const items = await engine.recognizePage(new Uint8Array(data), info.width, info.height)
      const texts = items.map(i => i.text)
      assert.ok(texts.some(s => /여건\s*\u2026\s*141$/.test(s)), `인식 결과: ${JSON.stringify(texts)}`)
    } finally {
      await engine.destroy()
    }
  })

  it("숫자 앞 △ 는 사전 밖이라도 부호를 잃지 않는다", async (t) => {
    const status = await getOcrModelStatus()
    if (!status.every(s => s.verified)) { t.skip("OCR 모델 미설치"); return }
    let sharp: typeof import("sharp")["default"]
    try { sharp = (await import("sharp")).default } catch { t.skip("sharp 미설치"); return }
    // 종전 엔진: "△400,352" → "400,352" (감액이 증액으로 읽힘, 부천 예산서 38곳)
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="80"><rect width="600" height="80" fill="white"/>` +
      `<text x="30" y="52" font-size="30" font-family="sans-serif">\u25b3400,352</text><text x="330" y="52" font-size="30" font-family="sans-serif">1,246,820</text></svg>`
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { OcrEngine } = await import("../src/ocr/engine.js")
    const engine = await OcrEngine.create()
    try {
      const texts = (await engine.recognizePage(new Uint8Array(data), info.width, info.height)).map(i => i.text)
      assert.ok(texts.includes("\u25b3400,352"), `인식 결과: ${JSON.stringify(texts)}`)
      assert.ok(texts.includes("1,246,820"), `△ 없는 숫자에 붙이지 않음: ${JSON.stringify(texts)}`)
    } finally {
      await engine.destroy()
    }
  })

  it("세로로 쌓인 글자(표 칸 세로쓰기)는 글자마다 따로 인식 + 잉크 외곽 좌표", async (t) => {
    const status = await getOcrModelStatus()
    if (!status.every(s => s.verified)) { t.skip("OCR 모델 미설치"); return }
    let sharp: typeof import("sharp")["default"]
    try { sharp = (await import("sharp")).default } catch { t.skip("sharp 미설치"); return }
    // 부천 예산서 표 모양 — 칸 경계 세로선 사이의 세로 라벨 "국/균/도/시" + 오른쪽 숫자 열.
    // det 가 라벨을 세로로 이어 키 큰 박스 하나로 잡고, 종전 엔진은 이를 높이 48 로 짓눌러
    // "시" 하나만 남겼다(나머지 3글자 소실 — 이 합성 페이지에서 재현 확인)
    const chars = ["국", "균", "도", "시"]
    const rows = chars.map((c, i) =>
      `<text x="40" y="${30 + i * 34}" font-size="18" font-family="sans-serif">${c}</text>` +
      `<text x="120" y="${30 + i * 34}" font-size="18" font-family="sans-serif">${(i + 1) * 1234},567</text>`).join("")
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="170"><rect width="800" height="170" fill="white"/>` +
      `<rect x="30" y="0" width="2" height="170" fill="black"/><rect x="100" y="0" width="2" height="170" fill="black"/>${rows}</svg>`
    const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const { OcrEngine } = await import("../src/ocr/engine.js")
    const engine = await OcrEngine.create()
    try {
      const items = await engine.recognizePage(new Uint8Array(data), info.width, info.height)
      const labels = items.filter(i => i.x < 100)
      const got = labels.map(i => i.text.trim())
      const hit = chars.filter(c => got.includes(c)).length
      assert.ok(hit >= 3, `글자별 인식: ${JSON.stringify(got)}`)
      for (const it of labels) {
        assert.ok(it.x >= 32, `칸 경계 세로선은 잉크 외곽에서 빠짐: x=${it.x}`)
        assert.ok(it.h <= 30, `잉크 외곽 높이는 글자 크기 수준: h=${it.h}`)
      }
    } finally {
      await engine.destroy()
    }
  })
})
