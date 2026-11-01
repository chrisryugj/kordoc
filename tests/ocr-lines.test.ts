/**
 * OCR 줄 내보내기(ocrLines)·검출 모델 선택(ocrDet·ocrDetLongSide)·로컬 모델 교체(ocrRec·ocrRecDict) 계약.
 *
 * 잠근 계약:
 *  1. 옵션 검증 — 모르는 값·범위 밖·상대 경로·해시 꼴은 parse() 실패 결과(엔진을 띄우기 전), parseImage 직접 호출도 사유를 숨기지 않는다.
 *     사용자 사전은 CRLF 도 읽는다
 *  2. 옵션을 안 주면 기본 설정 객체 그대로(산출 불변), 모델 선택 → 캐시 키
 *  3. 줄 묶음 모양 — 위→아래·왼→오른 정렬, 버린 줄은 dropped
 *  4. 모델이 로컬에 있으면 E2E (없으면 skip — CI 에는 모델 없음):
 *     ocrLines 를 켜도 나머지 결과는 끈 것과 같다, 줄 글이 블록 글과 같다, PDF 쪽 줄의 좌표 단위, 그림 영역 쪽(regionsOnly),
 *     SHA-256 이 다른 로컬 모델은 로드 거부, 같은 바이트의 로컬 모델은 내장 모델과 같은 결과, 사전 크기가 다르면 거부,
 *     없는 파일·디렉터리·ONNX 아닌 파일은 이름과 원인으로 거부(입력 문서 FILE_NOT_FOUND 아님)
 *  5. 기울기 보정 쪽 좌표를 입력 좌표로 되돌리는 식(문서에 적은 식)
 *  6. 폐쇄망: 캐시에 없는 server det 는 받지 않고 반입 방법을 안내한다, 자동 OCR 은 고른 모델이 없으면 돌지 않는다,
 *     세 모델이 모두 로컬 파일이면 캐시 디렉터리 없이 돈다
 *  7. CLI 플래그 → ParseOptions 매핑
 *  8. 같은 옵션이면 CLI --format json·parse-worker protocol 2 응답이 Node parse() 와 같다
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, parseImage } from "../src/index.js"
import { cliOcrEngineOptions } from "../src/cli/convert.js"
import { validateOcrOptions } from "../src/ocr/options.js"
import {
  ALL_OCR_MODELS, DEFAULT_OCR_MODELS, OCR_DET_MODEL, OCR_HANDWRITING_REC_MODEL, OCR_REC_DICT, OCR_REC_MODEL, OCR_SERVER_DET_MODEL, OCR_V6_MEDIUM_DET_MODEL,
  getOcrModelStatus, ocrModelPath, ocrSelectionKey, parseCharacterDict, resolveOcrModels,
} from "../src/ocr/models.js"
import { DEFAULT_BUILTIN_OCR, builtinOcrConfig, pageLines, recognizeOcrPage } from "../src/ocr/pdf-ocr.js"
import { DEFAULT_OCR_TUNING } from "../src/ocr/engine.js"
import { rotateRgba } from "../src/ocr/deskew.js"
import type { ParseOptions } from "../src/types.js"
import { SCAN_SVG, figurePdf, scanFixtures } from "./fixtures/sdk-docs.js"

const HEX = "a".repeat(64)

describe("OCR 엔진 옵션 검증", () => {
  it("맞는 값은 통과", () => {
    for (const ok of [
      undefined, {}, { ocrLines: true }, { ocrLines: false }, { ocrLines: "all" }, { ocrDet: "mobile" }, { ocrDet: "server" },
      { ocrDetLongSide: 32 }, { ocrDetLongSide: 4096 }, { ocrDet: { path: "/m/det.onnx", sha256: HEX.toUpperCase() } },
      { ocrRec: { path: "/m/rec.onnx", sha256: HEX }, ocrRecDict: { path: "/m/rec.yml", sha256: HEX } }, { ocrRec: "handwriting" }, { ocrRec: "auto" },
    ] as ParseOptions[]) assert.equal(validateOcrOptions(ok), null, JSON.stringify(ok))
  })

  it("모르는 값·범위 밖·상대 경로·해시 꼴·남는 키는 사유를 돌려준다", () => {
    const cases: Array<[unknown, RegExp]> = [
      [{ ocrDet: "large" }, /ocrDet/], [{ ocrDet: 1 }, /ocrDet/], [{ ocrLines: "dropped" }, /ocrLines/],
      [{ ocrDetLongSide: 31 }, /ocrDetLongSide/], [{ ocrDetLongSide: 4097 }, /ocrDetLongSide/], [{ ocrDetLongSide: 960.5 }, /ocrDetLongSide/],
      [{ ocrDetLongSide: "960" }, /ocrDetLongSide/], [{ ocrRec: { path: "rec.onnx", sha256: HEX } }, /ocrRec\.path/],
      [{ ocrRec: { path: "/m/rec.onnx", sha256: "abc" } }, /ocrRec\.sha256/], [{ ocrRecDict: { path: "/m/d.yml" } }, /ocrRecDict\.sha256/],
      [{ ocrRec: "/m/rec.onnx" }, /ocrRec/], [{ ocrRec: "Handwriting" }, /ocrRec/], [{ ocrRec: "Auto" }, /ocrRec/], [{ ocrRecDict: "handwriting" }, /ocrRecDict/], [{ ocrDet: { path: "/m/d.onnx", sha256: HEX, url: "x" } }, /url/],
    ]
    for (const [bad, re] of cases) assert.match(validateOcrOptions(bad as ParseOptions) ?? "", re, JSON.stringify(bad))
  })

  it("parse() 는 문서를 읽기 전에 실패 결과로 거부한다", async () => {
    const r = await parse(Buffer.from("%PDF-1.4\n"), { ocrDet: "large" as never })
    assert.equal(r.success, false)
    assert.match(r.success ? "" : r.error, /ocrDet/)
  })
})

describe("사전·직접 호출", () => {
  it("사용자 사전(ocrRecDict)은 CRLF 로 저장돼도 같은 목록", () => {
    const lf = "PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - 가\n  - '#'\n  - 나\nnext: 1\n"
    assert.deepEqual(parseCharacterDict(lf.replace(/\n/g, "\r\n")), parseCharacterDict(lf))
    assert.deepEqual(parseCharacterDict(lf), ["가", "#", "나"])
  })

  it("parseImage 를 바로 불러도 잘못된 옵션 사유를 숨기지 않는다", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const r = await parseImage(toAB(f.png), { ocrDetLongSide: 0 })
    assert.equal(r.success, false)
    assert.match(r.success ? "" : r.error, /ocrDetLongSide/)
  })
})

describe("모델 선택·기본 설정", () => {
  it("옵션이 없으면 기본 설정 객체 그대로 — 엔진은 종전과 같은 모델·튜닝", () => {
    assert.equal(builtinOcrConfig(undefined), DEFAULT_BUILTIN_OCR)
    assert.equal(builtinOcrConfig({ ocr: true, ocrLines: false }), DEFAULT_BUILTIN_OCR)
    assert.equal(DEFAULT_BUILTIN_OCR.tuning, DEFAULT_OCR_TUNING)
    assert.equal(DEFAULT_BUILTIN_OCR.lines, undefined)
  })

  it("ocrDet·ocrDetLongSide·로컬 파일 → 선택·튜닝·캐시 키", () => {
    const c = builtinOcrConfig({ ocrDet: "server", ocrDetLongSide: 1920, ocrLines: "all" })
    assert.equal("spec" in c.models.det && c.models.det.spec, OCR_SERVER_DET_MODEL)
    assert.equal(c.models.rec, DEFAULT_OCR_MODELS.rec)
    assert.equal(c.tuning.detLongSide, 1920)
    assert.equal(c.tuning.textScore, DEFAULT_OCR_TUNING.textScore)
    assert.equal(c.lines, "all")
    const local = resolveOcrModels({ ocrRec: { path: "/m/rec.onnx", sha256: HEX.toUpperCase() } })
    assert.deepEqual(local.rec, { file: { path: "/m/rec.onnx", sha256: HEX } })
    const keys = new Set([DEFAULT_OCR_MODELS, resolveOcrModels({ ocrDet: "mobile" }), resolveOcrModels({ ocrDet: "server" }), local].map(ocrSelectionKey))
    assert.equal(keys.size, 3) // mobile 지정 = 기본
    assert.throws(() => builtinOcrConfig({ ocrDetLongSide: 0 }), /ocrDetLongSide/)
  })

  it("ocrRec: \"handwriting\" → 손글씨 rec(고정 주소·SHA-256)와 내장 사전, 캐시 파일·키는 기본·로컬 파일과 따로", () => {
    const hw = builtinOcrConfig({ ocrRec: "handwriting" }).models
    assert.equal("spec" in hw.rec && hw.rec.spec, OCR_HANDWRITING_REC_MODEL)
    assert.equal(hw.det, DEFAULT_OCR_MODELS.det)
    assert.equal(hw.dict, DEFAULT_OCR_MODELS.dict)
    assert.equal(OCR_HANDWRITING_REC_MODEL.sha256, "1655d6abd17989f1922855dd77922e532e74275fe237e5f07174b623993fef81")
    assert.match(OCR_HANDWRITING_REC_MODEL.url, /\/resolve\/bb4c2714cf6b05e5d13bfe22199d0e6d30866597\/model\/rec_korean_hw\.onnx$/)
    assert.notEqual(OCR_HANDWRITING_REC_MODEL.filename, OCR_REC_MODEL.filename)
    // 같은 바이트를 로컬 파일로 준 선택과도 세션을 나눈다
    const sameBytes = resolveOcrModels({ ocrRec: { path: "/m/rec_korean_hw.onnx", sha256: OCR_HANDWRITING_REC_MODEL.sha256 } })
    assert.equal(new Set([DEFAULT_OCR_MODELS, hw, sameBytes].map(ocrSelectionKey)).size, 3)
    // 명시한 로컬 사전은 그대로 쓴다
    const dict = resolveOcrModels({ ocrRec: "handwriting", ocrRecDict: { path: "/m/d.yml", sha256: HEX } })
    assert.deepEqual(dict.dict, { file: { path: "/m/d.yml", sha256: HEX } })
  })

  it("ocrRec: \"auto\" → 기본 rec 로 읽고, 다시 읽을 손글씨 rec 는 같은 det·사전", () => {
    const c = builtinOcrConfig({ ocrRec: "auto" })
    assert.equal(c.models.rec, DEFAULT_OCR_MODELS.rec)
    assert.equal(c.handwriting && "spec" in c.handwriting.rec && c.handwriting.rec.spec, OCR_HANDWRITING_REC_MODEL)
    assert.equal(c.handwriting?.det, c.models.det)
    assert.equal(c.handwriting?.dict, c.models.dict)
    assert.equal(builtinOcrConfig({ ocrRec: "handwriting" }).handwriting, undefined)
  })

  it("ocrDet: \"medium\" → PP-OCRv6 medium det(고정 SHA-256), 튜닝·rec 는 기본 그대로, 기본 묶음에 들지 않는다", async () => {
    const c = builtinOcrConfig({ ocrDet: "medium" })
    assert.equal("spec" in c.models.det && c.models.det.spec, OCR_V6_MEDIUM_DET_MODEL)
    assert.equal(c.models.rec, DEFAULT_OCR_MODELS.rec)
    assert.deepEqual({ ...c.tuning }, { ...DEFAULT_OCR_TUNING })
    assert.equal(OCR_V6_MEDIUM_DET_MODEL.sha256, "eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1")
    assert.equal(new Set([DEFAULT_OCR_MODELS, resolveOcrModels({ ocrDet: "server" }), c.models].map(ocrSelectionKey)).size, 3)
    const { MODEL_GROUPS } = await import("../src/shared/model-bundle.js")
    assert.ok(!MODEL_GROUPS.flatMap(g => g.specs).some(s => s.filename === OCR_V6_MEDIUM_DET_MODEL.filename))
  })

  it("손글씨 rec 는 기본 다운로드(kordoc models)·모델 번들 묶음에 들지 않는다", async () => {
    assert.deepEqual(ALL_OCR_MODELS, [OCR_DET_MODEL, OCR_REC_MODEL, OCR_REC_DICT])
    const { MODEL_GROUPS } = await import("../src/shared/model-bundle.js")
    const specs = MODEL_GROUPS.flatMap(g => g.specs)
    assert.ok(!specs.includes(OCR_HANDWRITING_REC_MODEL) && !specs.some(s => s.filename === OCR_HANDWRITING_REC_MODEL.filename))
  })
})

describe("쪽 줄 묶음 (pageLines)", () => {
  it("위→아래·왼→오른 정렬, 버린 줄은 dropped, 그림 영역 쪽 표시", () => {
    const kept = [{ text: "둘", x: 50, y: 40, w: 10, h: 10, confidence: 0.9 }, { text: "하나", x: 5, y: 10, w: 20, h: 10, confidence: 0.99 }]
    const dropped = [{ text: "잡음", x: 0, y: 40, w: 8, h: 10, confidence: 0.3 }]
    const p = pageLines(2, 300, 400, 3, 0.5, kept, dropped, true)
    assert.deepEqual(p, {
      pageNumber: 2, width: 300, height: 400, scale: 3, deskewAngle: 0.5, regionsOnly: true,
      lines: [
        { text: "하나", box: { x: 5, y: 10, w: 20, h: 10 }, confidence: 0.99 },
        { text: "잡음", box: { x: 0, y: 40, w: 8, h: 10 }, confidence: 0.3, dropped: true },
        { text: "둘", box: { x: 50, y: 40, w: 10, h: 10 }, confidence: 0.9 },
      ],
    })
    assert.equal("regionsOnly" in pageLines(1, 1, 1, 1, 0, [], undefined), false)
  })
})

async function fixtures(t: { skip(msg: string): void }): Promise<{ png: Buffer; pdf: Buffer } | null> {
  if (!(await getOcrModelStatus()).every(s => s.verified)) { t.skip("OCR 모델 미설치"); return null }
  const f = await scanFixtures()
  if (!f) t.skip("sharp 미설치")
  return f
}

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
const toAB = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
/** ocrLines 를 뺀 결과 — 끈 결과와 견준다 */
const withoutLines = (r: Awaited<ReturnType<typeof parse>>) => { const { ocrLines: _, ...rest } = r as { ocrLines?: unknown }; return rest }

describe("내장 엔진 E2E — ocrLines·로컬 모델 (모델 있을 때만)", () => {
  it("이미지: 켜도 나머지 결과는 같고, 줄 글은 블록 글과 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const off = await parse(f.png)
    const on = await parse(f.png, { ocrLines: true })
    assert.ok(off.success && on.success)
    assert.equal("ocrLines" in off, false)
    assert.deepEqual(withoutLines(on), off)
    const pages = on.ocrLines!
    assert.equal(pages.length, 1)
    const [p] = pages
    assert.equal(p.pageNumber, 1)
    assert.equal(p.width, 840)
    assert.equal(p.height, 260)
    const text = p.lines.map(l => l.text).join(" ")
    assert.match(text, /대한민국/)
    assert.match(text, /검증/)
    for (const l of p.lines) {
      assert.ok(l.confidence >= 0.5 && l.confidence <= 1 && !l.dropped)
      assert.ok(l.box.x >= 0 && l.box.y >= 0 && l.box.x + l.box.w <= p.width && l.box.y + l.box.h <= p.height)
    }
    // 블록 글은 줄 글로만 만든다
    const blockText = on.markdown.replace(/\s/g, "")
    for (const l of p.lines) assert.ok(blockText.includes(l.text.replace(/\s/g, "")), l.text)
    // "all" 은 버린 줄만 더한다
    const all = await parse(f.png, { ocrLines: "all" })
    assert.ok(all.success)
    assert.deepEqual(all.ocrLines![0].lines.filter(l => !l.dropped), p.lines)
    // 기본 긴 변(960)을 그대로 주면 같은 결과
    assert.deepEqual(await parse(f.png, { ocrDetLongSide: 960, ocrDet: "mobile" }), off)
  })

  it("PDF: 쪽 줄은 래스터 px(scale = px/pt), 끄면 결과 불변", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const off = await parse(f.pdf, { ocr: true })
    const on = await parse(f.pdf, { ocr: true, ocrLines: true })
    assert.ok(off.success && on.success)
    assert.deepEqual(withoutLines(on), off)
    const [p] = on.ocrLines!
    assert.equal(p.pageNumber, 1)
    assert.equal(p.scale, 3)
    assert.equal(p.width, 420 * 3)
    assert.equal(p.height, 130 * 3)
    assert.match(p.lines.map(l => l.text).join(""), /대한민국/)
    // OCR 을 끄면 빈 배열(옵션은 켰다)
    const none = await parse(f.pdf, { ocr: false, ocrLines: true })
    assert.ok(none.success)
    assert.deepEqual(none.ocrLines, [])
  })

  it("로컬 rec: SHA-256 이 다르면 로드 거부, 같으면 내장 모델과 같은 결과", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const path = ocrModelPath(OCR_REC_MODEL)
    const bad = await parse(f.png, { ocrRec: { path, sha256: "0".repeat(64) } })
    assert.equal(bad.success, false)
    assert.match(bad.success ? "" : bad.error, /SHA256 mismatch/)
    // PDF 경로는 환경 오류 계약대로 OCR_FAILED 경고 + OCR 없는 결과
    const badPdf = await parse(f.pdf, { ocr: true, ocrRec: { path, sha256: "0".repeat(64) } })
    assert.ok(badPdf.success)
    assert.ok(badPdf.warnings?.some(w => w.code === "OCR_FAILED" && /SHA256 mismatch/.test(w.message)))
    assert.ok(!badPdf.markdown.includes("대한민국"))
    const same = await parse(f.png, { ocrRec: { path, sha256: sha(readFileSync(path)) } })
    assert.deepEqual(same, await parse(f.png))
  })

  it("로컬 사전: 크기가 rec 출력과 다르면 거부", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-dict-"))
    try {
      const yml = Buffer.from("PostProcess:\n  name: CTCLabelDecode\n  character_dict:\n  - 가\n  - 나\n", "utf8")
      const path = join(dir, "dict.yml")
      writeFileSync(path, yml)
      const r = await parse(f.png, { ocrRecDict: { path, sha256: sha(yml) } })
      assert.equal(r.success, false)
      assert.match(r.success ? "" : r.error, /출력 클래스/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("server det (캐시에 있을 때만): 같은 이미지를 읽는다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    try { readFileSync(ocrModelPath(OCR_SERVER_DET_MODEL)) } catch { t.skip("server det 미설치"); return }
    const r = await parse(f.png, { ocrDet: "server", ocrLines: true })
    assert.ok(r.success)
    assert.match(r.ocrLines![0].lines.map(l => l.text).join(""), /대한민국/)
  })
})

describe("손글씨 rec 프리셋 E2E (손글씨 rec 가 캐시에 있을 때만)", () => {
  it("이미지·스캔 PDF: 프리셋 결과 JSON 전체가 같은 파일의 로컬 지정과 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const path = ocrModelPath(OCR_HANDWRITING_REC_MODEL)
    let bytes: Buffer
    try { bytes = readFileSync(path) } catch { t.skip("손글씨 rec 미설치"); return }
    const local: ParseOptions = { ocrRec: { path, sha256: sha(bytes) } }
    const img = await parse(f.png, { ocrRec: "handwriting", ocrLines: "all" })
    assert.ok(img.success)
    assert.match(img.markdown, /대한민국/)
    assert.deepEqual(toWire(img), toWire(await parse(f.png, { ...local, ocrLines: "all" })))
    const pdf = await parse(f.pdf, { ocr: true, ocrRec: "handwriting", ocrLines: "all" })
    assert.ok(pdf.success)
    assert.match(pdf.markdown, /대한민국/)
    assert.deepEqual(toWire(pdf), toWire(await parse(f.pdf, { ...local, ocr: true, ocrLines: "all" })))
    // 자동 OCR 도 캐시에 있으니 돈다
    assert.deepEqual(toWire(await parse(f.pdf, { ocrRec: "handwriting" })), toWire(await parse(f.pdf, local)))
  })

  it("ocrRec: \"auto\" — 확신도 높은 인쇄 쪽은 기본 rec 결과 그대로, 낮은 쪽만 손글씨 rec 로 바꾼다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    try { readFileSync(ocrModelPath(OCR_HANDWRITING_REC_MODEL)) } catch { t.skip("손글씨 rec 미설치"); return }
    assert.deepEqual(toWire(await parse(f.png, { ocrRec: "auto", ocrLines: "all" })), toWire(await parse(f.png, { ocrLines: "all" })))
    assert.deepEqual(toWire(await parse(f.pdf, { ocr: true, ocrRec: "auto" })), toWire(await parse(f.pdf, { ocr: true })))
    // 기본 엔진이 확신 없이 읽은 쪽(가짜 엔진 .5)은 손글씨 rec 로 다시 읽는다 — 확신하는 쪽(.99)은 다시 읽지 않는다
    const { decodeToRgba } = await import("../src/ocr/image-ocr.js")
    const { data, width, height } = await decodeToRgba(f.png.buffer.slice(f.png.byteOffset, f.png.byteOffset + f.png.byteLength) as ArrayBuffer)
    const config = builtinOcrConfig({ ocrRec: "auto" })
    const fake = (confidence: number) => ({ recognizePage: async () => [{ text: "가짜", x: 0, y: 0, w: 10, h: 10, confidence }] }) as never
    const low = await recognizeOcrPage(fake(0.5), config, config.tuning, data, width, height, { droppedLowConf: 0 })
    assert.match(low.map(it => it.text).join(""), /대한민국/)
    const high = await recognizeOcrPage(fake(0.99), config, config.tuning, data, width, height, { droppedLowConf: 0 })
    assert.deepEqual(high.map(it => it.text), ["가짜"])
  })
})

describe("그림 영역만 읽는 쪽 (모델 있을 때만)", () => {
  it("텍스트층이 있는 쪽의 그림 글은 regionsOnly 쪽 줄로, 영역 밖 글줄은 담지 않는다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const sharp = (await import("sharp")).default
    const pdf = figurePdf(await sharp(Buffer.from(SCAN_SVG)).jpeg().toBuffer())
    const off = await parse(pdf, { ocr: true })
    const on = await parse(pdf, { ocr: true, ocrLines: "all" })
    assert.ok(off.success && on.success)
    // pdfjs 표준 글꼴 이름은 문서를 열 때마다 번호가 붙는다("g_d0_f1"·"g_d1_f1") — 옵션과 무관해 걷고 견준다
    const noFontIds = (r: unknown) => JSON.parse(JSON.stringify(r, (k, v) => k === "fontName" && /^g_d\d+_/.test(v) ? "g_d_" : v instanceof Uint8Array ? [...v] : v))
    assert.deepEqual(noFontIds(withoutLines(on)), noFontIds(off))
    assert.match(on.markdown, /Native text layer line/)
    const [p] = on.ocrLines!
    assert.equal(p.regionsOnly, true)
    assert.equal(p.pageNumber, 1)
    const text = p.lines.map(l => l.text).join(" ")
    assert.match(text, /대한민국/)
    assert.doesNotMatch(text, /Native/, "텍스트층 줄(그림 밖)은 영역 쪽 줄이 아니다")
    // 그림은 쪽 아래 20~150pt — 줄 상자(래스터 px, 위 원점)가 그 안
    for (const l of p.lines) {
      const top = 300 - l.box.y / p.scale, bottom = 300 - (l.box.y + l.box.h) / p.scale
      assert.ok(bottom >= 20 - 2 && top <= 150 + 2, `${l.text} ${top}..${bottom}`)
    }
    assert.equal(new Set(p.lines.map(l => `${l.text}@${l.box.x},${l.box.y}`)).size, p.lines.length, "같은 줄을 두 번 담지 않는다")
  })
})

describe("기울기 보정 쪽 좌표 → 입력 좌표 (문서의 식)", () => {
  it("rotateRgba 로 돌린 래스터의 점을 deskewAngle 식으로 되돌리면 입력 점", () => {
    const W = 201, H = 121, x0 = 150, y0 = 30, deg = 2.5
    const rgba = new Uint8Array(W * H * 4).fill(255)
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) rgba.fill(0, ((y0 + dy) * W + x0 + dx) * 4, ((y0 + dy) * W + x0 + dx) * 4 + 3)
    const out = rotateRgba(rgba, W, H, deg)
    // 돌린 래스터에서 가장 어두운 점들의 무게중심
    let sx = 0, sy = 0, n = 0
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const v = 255 - out[(y * W + x) * 4]; if (v > 0) { sx += x * v; sy += y * v; n += v } }
    const x = sx / n, y = sy / n
    const t = deg * Math.PI / 180, cx = (W - 1) / 2, cy = (H - 1) / 2
    const bx = cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), by = cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)
    assert.ok(Math.abs(bx - x0) < 0.5 && Math.abs(by - y0) < 0.5, `${bx},${by}`)
    assert.ok(Math.hypot(x - x0, y - y0) > 2, "돌린 래스터에서는 자리가 다르다")
  })
})

/** 링크를 만들고, 못 만들면(윈도우 비관리자 EPERM) 복사한다 — 만든 경로를 돌려준다 */
function linkOrCopy(src: string, dst: string): string {
  try { symlinkSync(src, dst) } catch { copyFileSync(src, dst) }
  return dst
}

/** 환경 변수를 잠시 바꿔 fn 을 돈다 */
async function withEnv<T>(env: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prev = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]))
  Object.assign(process.env, env)
  try { return await fn() } finally {
    for (const [k, v] of Object.entries(prev)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }
  }
}

describe("폐쇄망(KORDOC_OFFLINE)·모델 캐시", () => {
  it("server det 가 캐시에 없으면 폐쇄망에서는 받지 않고 실패로 알린다 (모델 불필요)", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const empty = mkdtempSync(join(tmpdir(), "kordoc-nomodel-"))
    try {
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: empty }, async () => {
        const img = await parse(f.png, { ocrDet: "server" })
        assert.equal(img.success, false)
        assert.match(img.success ? "" : img.error, /폐쇄망 모드\(KORDOC_OFFLINE\)에서 차단됨: PP-OCRv5 server det/)
        const pdf = await parse(f.pdf, { ocr: true, ocrDet: "server" })
        assert.ok(pdf.success)
        assert.ok(pdf.warnings?.some(w => w.code === "OCR_FAILED" && /폐쇄망/.test(w.message)))
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("자동 OCR(ocr 미지정)은 고른 모델이 캐시에 없으면 돌지 않고 받지도 않는다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const cache = mkdtempSync(join(tmpdir(), "kordoc-cache-"))
    try {
      // 기본 세 파일만 있는 캐시 (server det 없음)
      mkdirSync(join(cache, "ppocr"))
      for (const spec of [OCR_DET_MODEL, OCR_REC_MODEL, OCR_REC_DICT]) linkOrCopy(ocrModelPath(spec), join(cache, "ppocr", spec.filename))
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: cache }, async () => {
        const auto = await parse(f.pdf)
        assert.ok(auto.success && auto.markdown.includes("대한민국"), "기본 모델 자동 OCR")
        const server = await parse(f.pdf, { ocrDet: "server", ocrLines: true })
        assert.ok(server.success)
        assert.ok(!server.markdown.includes("대한민국"))
        assert.ok(server.warnings?.some(w => w.code === "NEEDS_OCR"))
        assert.ok(!server.warnings?.some(w => w.code === "OCR_FAILED"), "받으려 하지 않는다")
        assert.deepEqual(server.ocrLines, [])
      })
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })

  it("세 모델을 모두 로컬 파일(링크 포함)로 주면 캐시를 만들 수 없는 폐쇄망에서도 읽는다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-local-"))
    try {
      const local = (spec: typeof OCR_DET_MODEL) => ({ path: linkOrCopy(ocrModelPath(spec), join(dir, "my-" + spec.filename)), sha256: sha(readFileSync(ocrModelPath(spec))) })
      const options: ParseOptions = { ocrDet: local(OCR_DET_MODEL), ocrRec: local(OCR_REC_MODEL), ocrRecDict: local(OCR_REC_DICT) }
      const want = await parse(f.png)
      // 모델 캐시 자리가 파일 아래라 디렉터리를 만들 수 없다(읽기 전용 HOME 꼴)
      writeFileSync(join(dir, "not-a-dir"), "")
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: join(dir, "not-a-dir", "cache") }, async () => {
        assert.deepEqual(await parse(f.png, options), want)
        const builtin = await parse(f.png, { ocrRec: options.ocrRec })
        assert.equal(builtin.success, false, "내장 det 를 쓰면 캐시가 필요하다 — 위 성공이 캐시 없이 돈 것임을 확인")
      })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("없는 파일·디렉터리·ONNX 가 아닌 파일은 이름과 원인으로 거부 (입력 문서 FILE_NOT_FOUND 로 분류하지 않는다)", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-local-"))
    try {
      const missing = await parse(f.png, { ocrRec: { path: join(dir, "없는.onnx"), sha256: HEX } })
      assert.equal(missing.success, false)
      assert.match(missing.success ? "" : missing.error, /OCR 모델 파일을 읽지 못했습니다: 없는\.onnx \(파일이 없음\)/)
      assert.notEqual(missing.success ? "" : missing.code, "FILE_NOT_FOUND")
      const isDir = await parse(f.png, { ocrRec: { path: dir, sha256: HEX } })
      assert.match(isDir.success ? "" : isDir.error, /OCR 모델 파일을 읽지 못했습니다: .* \(일반 파일이 아님\)/)
      // SHA-256 은 맞지만 ONNX 가 아닌 파일(사전을 rec 자리에)
      const yml = ocrModelPath(OCR_REC_DICT)
      const notOnnx = await parse(f.png, { ocrRec: { path: yml, sha256: sha(readFileSync(yml)) } })
      assert.match(notOnnx.success ? "" : notOnnx.error, /OCR 모델을 열지 못했습니다: rec_korean\.yml/)
      const pdf = await parse(f.pdf, { ocr: true, ocrRec: { path: join(dir, "없는.onnx"), sha256: HEX } })
      assert.ok(pdf.success && pdf.warnings?.some(w => w.code === "OCR_FAILED" && /없는\.onnx \(파일이 없음\)/.test(w.message)))
      assert.ok(!pdf.warnings?.some(w => w.message.includes(dir)), "경고에 전체 경로를 내지 않는다")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("폐쇄망에서 server det 를 막을 때는 models 묶음이 아니라 캐시 반입·로컬 파일을 안내한다", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const empty = mkdtempSync(join(tmpdir(), "kordoc-nomodel-"))
    try {
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: empty }, async () => {
        const r = await parse(f.png, { ocrDet: "server" })
        assert.match(r.success ? "" : r.error, /ppocr\/det_server\.onnx/)
        assert.doesNotMatch(r.success ? "" : r.error, /models --export/)
      })
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })
})

/** fetch 를 잠시 막고 부른 주소를 모은다 — 모델을 받으려 했는지 본다 */
async function withoutNetwork<T>(fn: (calls: string[]) => Promise<T>): Promise<T> {
  const calls: string[] = [], prev = globalThis.fetch
  globalThis.fetch = (async (url: unknown) => { calls.push(String(url)); throw new Error("네트워크 차단(테스트)") }) as typeof fetch
  try { return await fn(calls) } finally { globalThis.fetch = prev }
}

describe("손글씨 rec 프리셋 — 다운로드·폐쇄망", () => {
  it("캐시에 없으면 폐쇄망에서는 받지 않고, 캐시 반입 위치·로컬 파일 옵션을 안내한다 (모델 불필요)", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const empty = mkdtempSync(join(tmpdir(), "kordoc-nomodel-"))
    try {
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: empty }, () => withoutNetwork(async (calls) => {
        const img = await parse(f.png, { ocrRec: "handwriting" })
        assert.equal(img.success, false)
        const msg = img.success ? "" : img.error
        assert.match(msg, /폐쇄망 모드\(KORDOC_OFFLINE\)에서 차단됨: (PP-OCRv5 mobile det|Korean handwriting rec)/)
        const pdf = await parse(f.pdf, { ocr: true, ocrRec: "handwriting" })
        assert.ok(pdf.success && pdf.warnings?.some(w => w.code === "OCR_FAILED" && /폐쇄망/.test(w.message)))
        assert.deepEqual(calls, [])
      }))
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("기본 모델이 있는 캐시에서 손글씨 rec 만 없으면 그 반입 위치를 안내하고, models 묶음을 안내하지 않는다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const cache = mkdtempSync(join(tmpdir(), "kordoc-cache-"))
    try {
      mkdirSync(join(cache, "ppocr"))
      for (const spec of [OCR_DET_MODEL, OCR_REC_MODEL, OCR_REC_DICT]) linkOrCopy(ocrModelPath(spec), join(cache, "ppocr", spec.filename))
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: cache }, async () => {
        const img = await parse(f.png, { ocrRec: "handwriting" })
        assert.equal(img.success, false)
        const msg = img.success ? "" : img.error
        assert.match(msg, /차단됨: Korean handwriting rec/)
        assert.match(msg, /ppocr\/rec_korean_hw\.onnx/)
        assert.match(msg, /ocrRec 에 로컬 파일/)
        assert.doesNotMatch(msg, /models --export/)
        // 명시 OCR 에서 실패해도 기본 rec 로 조용히 바꾸지 않는다 — 캐시의 기본 rec 로 읽으면 "대한민국" 이 나온다
        const pdf = await parse(f.pdf, { ocr: true, ocrRec: "handwriting" })
        assert.ok(pdf.success && pdf.warnings?.some(w => w.code === "OCR_FAILED" && /Korean handwriting rec/.test(w.message)))
        assert.ok(!pdf.markdown.includes("대한민국"))
        // 자동 OCR 은 고른 모델이 없으면 돌지도 받지도 않는다(기본 모델 자동 OCR 은 돈다)
        assert.ok((await parse(f.pdf)).markdown.includes("대한민국"))
        const auto = await parse(f.pdf, { ocrRec: "handwriting" })
        assert.ok(auto.success && !auto.markdown.includes("대한민국"))
        assert.ok(auto.warnings?.some(w => w.code === "NEEDS_OCR"))
        assert.ok(!auto.warnings?.some(w => w.code === "OCR_FAILED"), "받으려 하지 않는다")
      })
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })

  it("자동 OCR·ocr: false 는 온라인이어도 손글씨 rec 를 받지 않는다 (모델 불필요)", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    if (process.env.KORDOC_OFFLINE) { t.skip("KORDOC_OFFLINE 설정됨"); return }
    const empty = mkdtempSync(join(tmpdir(), "kordoc-nomodel-"))
    try {
      await withEnv({ KORDOC_MODEL_CACHE: empty }, () => withoutNetwork(async (calls) => {
        const auto = await parse(f.pdf, { ocrRec: "handwriting" })
        assert.ok(auto.success && auto.warnings?.some(w => w.code === "NEEDS_OCR"))
        assert.ok(!auto.warnings?.some(w => w.code === "OCR_FAILED"))
        const off = await parse(f.pdf, { ocr: false, ocrRec: "handwriting" })
        assert.ok(off.success && !off.warnings?.some(w => w.code === "OCR_FAILED"))
        assert.deepEqual(calls, [])
        assert.equal(existsSync(join(empty, "ppocr", OCR_HANDWRITING_REC_MODEL.filename)), false)
      }))
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it("명시 OCR 은 고정 주소에서 손글씨 rec 만 받으려 한다 (기본 rec 는 받지 않는다)", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    if (process.env.KORDOC_OFFLINE) { t.skip("KORDOC_OFFLINE 설정됨"); return }
    const cache = mkdtempSync(join(tmpdir(), "kordoc-cache-"))
    try {
      // 기본 det·사전만 있는 캐시
      mkdirSync(join(cache, "ppocr"))
      for (const spec of [OCR_DET_MODEL, OCR_REC_DICT]) linkOrCopy(ocrModelPath(spec), join(cache, "ppocr", spec.filename))
      await withEnv({ KORDOC_MODEL_CACHE: cache }, () => withoutNetwork(async (calls) => {
        const r = await parse(f.png, { ocrRec: "handwriting" })
        assert.equal(r.success, false)
        assert.deepEqual(calls, [OCR_HANDWRITING_REC_MODEL.url])
      }))
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })

  it("SHA-256 이 다른(손상된) 캐시 파일은 쓰지 않는다 — 폐쇄망이면 다시 받지 않고 실패 (모델 불필요)", async (t) => {
    const f = await scanFixtures()
    if (!f) { t.skip("sharp 미설치"); return }
    const cache = mkdtempSync(join(tmpdir(), "kordoc-cache-"))
    try {
      mkdirSync(join(cache, "ppocr"))
      // 기본 모델은 진짜(있으면), 손글씨 rec 자리에는 깨진 바이트
      for (const spec of [OCR_DET_MODEL, OCR_REC_MODEL, OCR_REC_DICT]) {
        try { linkOrCopy(ocrModelPath(spec), join(cache, "ppocr", spec.filename)) } catch { /* 모델 없는 CI */ }
      }
      writeFileSync(join(cache, "ppocr", OCR_HANDWRITING_REC_MODEL.filename), "not an onnx model")
      await withEnv({ KORDOC_OFFLINE: "1", KORDOC_MODEL_CACHE: cache }, async () => {
        const r = await parse(f.png, { ocrRec: "handwriting" })
        assert.equal(r.success, false)
        assert.match(r.success ? "" : r.error, /폐쇄망/)
      })
    } finally {
      rmSync(cache, { recursive: true, force: true })
    }
  })
})

describe("CLI 플래그 매핑 (cliOcrEngineOptions)", () => {
  it("CLI 플래그 → ParseOptions (경로는 현재 디렉터리 기준 절대 경로, 숫자 아닌 긴 변은 그대로 넘겨 parse() 가 거부)", () => {
    assert.deepEqual(cliOcrEngineOptions({}), {})
    assert.deepEqual(cliOcrEngineOptions({ ocrLines: true }), { ocrLines: true })
    assert.deepEqual(cliOcrEngineOptions({ ocrLines: true, ocrLinesAll: true }), { ocrLines: "all" })
    assert.deepEqual(cliOcrEngineOptions({ ocrDet: "server", ocrDetSha256: HEX, ocrDetLongSide: "1920" }), { ocrDet: "server", ocrDetLongSide: 1920 })
    assert.deepEqual(cliOcrEngineOptions({ ocrDet: "m/det.onnx", ocrDetSha256: HEX }), { ocrDet: { path: resolve("m/det.onnx"), sha256: HEX } })
    assert.deepEqual(cliOcrEngineOptions({ ocrRec: "/m/rec.onnx" }), { ocrRec: { path: "/m/rec.onnx", sha256: "" } })
    // 프리셋 이름은 경로로 바꾸지 않는다(같은 이름의 파일은 ./handwriting 으로)
    assert.deepEqual(cliOcrEngineOptions({ ocrRec: "handwriting", ocrRecSha256: HEX }), { ocrRec: "handwriting" })
    assert.deepEqual(cliOcrEngineOptions({ ocrRec: "auto" }), { ocrRec: "auto" })
    assert.deepEqual(cliOcrEngineOptions({ ocrRec: "./handwriting", ocrRecSha256: HEX }), { ocrRec: { path: resolve("handwriting"), sha256: HEX } })
    assert.deepEqual(cliOcrEngineOptions({ ocrRecDict: "d.yml", ocrRecDictSha256: HEX }), { ocrRecDict: { path: resolve("d.yml"), sha256: HEX } })
    const bad = cliOcrEngineOptions({ ocrDetLongSide: "abc" })
    assert.match(validateOcrOptions(bad) ?? "", /ocrDetLongSide.*"abc"/)
    assert.match(validateOcrOptions(cliOcrEngineOptions({ ocrRec: "/m/rec.onnx" })) ?? "", /ocrRec\.sha256/)
  })
})

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const toWire = (r: unknown) => JSON.parse(JSON.stringify(r, (_k, v) => v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v))

/** CLI 를 띄워 stdout 을 모은다 (stdin 은 받은 줄을 쓰고 닫는다) */
function run(args: string[], input = ""): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], { stdio: ["pipe", "pipe", "pipe"] })
    const chunks: Buffer[] = []
    child.stdout.on("data", (d: Buffer) => chunks.push(d))
    child.stderr.resume()
    // exit 는 stdout 을 다 읽기 전에 올 수 있다 — close 에서 모은다
    child.on("close", (code) => resolve({ out: Buffer.concat(chunks).toString("utf8"), code }))
    child.stdin.end(input)
  })
}

describe("CLI·parse-worker 결과 = Node parse() (모델 있을 때만)", () => {
  it("같은 OCR 옵션이면 --format json·protocol 2 응답·parse() 가 같다", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    const dir = mkdtempSync(join(tmpdir(), "kordoc-ocrlines-"))
    try {
      const file = join(dir, "스캔 문서.pdf")
      writeFileSync(file, f.pdf)
      const rec = ocrModelPath(OCR_REC_MODEL)
      const sha256 = sha(readFileSync(rec))
      const options: ParseOptions = { ocr: true, ocrLines: "all", ocrDet: "mobile", ocrDetLongSide: 1280, ocrRec: { path: rec, sha256 } }
      const want = toWire(await parse(file, options))
      assert.ok(want.success && want.ocrLines.length === 1)

      const cli = await run([file, "--format", "json", "--silent", "--ocr", "--ocr-lines-all", "--ocr-det", "mobile",
        "--ocr-det-long-side", "1280", "--ocr-rec", rec, "--ocr-rec-sha256", sha256])
      assert.equal(cli.code, 0)
      assert.deepEqual(JSON.parse(cli.out), want)

      const worker = await run(["parse-worker", "--protocol", "2"], JSON.stringify({ id: 1, cmd: "parse", file, options }) + "\n")
      const res = worker.out.split("\n").filter(Boolean).map(l => JSON.parse(l))
      assert.equal(res[1].id, 1)
      assert.deepEqual(res[1].result, want)

      // CLI 의 잘못된 값은 parse() 와 같은 실패 JSON
      const bad = await run([file, "--format", "json", "--silent", "--ocr-det", "large"])
      assert.equal(bad.code, 1)
      assert.match(JSON.parse(bad.out).error, /ocrDet/)
      const noSha = await run([file, "--format", "json", "--silent", "--ocr-rec", rec])
      assert.equal(noSha.code, 1)
      assert.match(JSON.parse(noSha.out).error, /ocrRec\.sha256/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("손글씨 rec 프리셋도 --ocr-rec handwriting·protocol 2 응답·parse() 가 같다 (손글씨 rec 가 캐시에 있을 때만)", async (t) => {
    const f = await fixtures(t)
    if (!f) return
    if (!existsSync(ocrModelPath(OCR_HANDWRITING_REC_MODEL))) { t.skip("손글씨 rec 미설치"); return }
    const dir = mkdtempSync(join(tmpdir(), "kordoc-ocrhw-"))
    try {
      const file = join(dir, "수기 스캔.pdf")
      writeFileSync(file, f.pdf)
      const options: ParseOptions = { ocr: true, ocrLines: "all", ocrRec: "handwriting" }
      const want = toWire(await parse(file, options))
      assert.ok(want.success && want.ocrLines.length === 1)
      const cli = await run([file, "--format", "json", "--silent", "--ocr", "--ocr-lines-all", "--ocr-rec", "handwriting"])
      assert.equal(cli.code, 0)
      assert.deepEqual(JSON.parse(cli.out), want)
      const worker = await run(["parse-worker", "--protocol", "2"], JSON.stringify({ id: 1, cmd: "parse", file, options }) + "\n")
      const res = worker.out.split("\n").filter(Boolean).map(l => JSON.parse(l))
      assert.deepEqual(res[1].result, want)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
