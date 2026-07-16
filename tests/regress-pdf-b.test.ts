/**
 * PDF 파서 결함 회귀 테스트 (담당 B — 2026-07-16)
 *
 * 1. 표-전용 PDF OCR 오판 — totalChars/페이지품질 집계에 table 셀 텍스트 누락
 * 2. 셀 미매핑 텍스트 무음 소멸 — 그리드 bbox 안 미배정 아이템 프로즈 환원
 * 3. buildGridTable 셀 `|` 미이스케이프 + `\t` 잔존
 * 4. removeHeaderFooterBlocks top/bottom 라벨 교정 (동작 고정)
 * 5. ocrPages 페이지별 실패 격리 + placeholder pageNumber
 * 6. 이미지 추출 상한 검사를 resolveImgData(5초 대기) 앞으로
 * 7. mergeVertices/groupConnectedLines 버킷 그리드 (동작 동일 + 성능)
 * 8. 리스트 중첩 연속성 — 사이 본문 건너뛴 순서 재배열 금지
 * 9. (롤백) 그룹 vertex 자기 선 재계산 — 벤치 matchedRate 게이트 회귀로 미적용
 * 10. XY-Cut 그룹 단위 Y-정렬 — 컬럼 읽기 순서 재인터리브 금지
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS, ImageKind } from "pdfjs-dist/legacy/build/pdf.mjs"
import { parsePdfDocument } from "../src/pdf/parser.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { extractWithColumns } from "../src/pdf/columns.js"
import { removeHeaderFooterBlocks, detectKoreanListBlocks } from "../src/pdf/block-detect.js"
import { ocrPages } from "../src/ocr/provider.js"
import { createPdfImageState, extractPageImages } from "../src/pdf/image-extract.js"
import { buildTableGrids } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { IRBlock, ParseWarning } from "../src/types.js"

// ─── 헬퍼 ──────────────────────────────────────────────

const hseg = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const vseg = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 1 })

function ni(text: string, x: number, y: number, w: number, h = 10, fontSize = 10): NormItem {
  return { text, x, y, w, h, fontSize, fontName: "f1", isHidden: false }
}

/** 선분들을 v4 형식 constructPath+stroke opList로 (extractLines 입력용) */
function lineOpList(segs: Array<[number, number, number, number]>): { fnArray: number[]; argsArray: unknown[][] } {
  const fnArray: number[] = []
  const argsArray: unknown[][] = []
  for (const [x1, y1, x2, y2] of segs) {
    fnArray.push(OPS.constructPath)
    argsArray.push([[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]])
    fnArray.push(OPS.stroke)
    argsArray.push([])
  }
  return { fnArray, argsArray }
}

/** 3행×2열 표 괘선 — h y=550/600/650/700 (x100~500), v x=100/300/500 (y550~700) */
const GRID_SEGS: Array<[number, number, number, number]> = [
  [100, 550, 500, 550], [100, 600, 500, 600], [100, 650, 500, 650], [100, 700, 500, 700],
  [100, 550, 100, 700], [300, 550, 300, 700], [500, 550, 500, 700],
]

/** 위 그리드의 정상 셀 텍스트 (첫 행 라벨 → demote 방지) */
function gridCellItems(): NormItem[] {
  return [
    ni("구분", 110, 670, 30), ni("내용", 310, 670, 30),
    ni("항목A", 110, 615, 30), ni("1234", 310, 615, 30),
    ni("항목B", 110, 565, 30), ni("5678", 310, 565, 30),
  ]
}

/** 1페이지 합성 PDF 생성 (Helvetica, 612×792) — pdf-v3.test.ts와 동일 방식 */
function buildSyntheticPdf(contentStream: string): ArrayBuffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xrefPos = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const o of offsets) pdf += String(o).padStart(10, "0") + " 00000 n \n"
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF`
  const buf = Buffer.from(pdf, "latin1")
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

// ─── 1. 표-전용 PDF OCR 오판 ───────────────────────────

describe("결함 1 — 표-전용 PDF가 이미지 기반으로 오판되지 않는다", () => {
  /** 괘선 표(3행×2열)만 있는 PDF — 모든 텍스트가 table 셀에 들어간다 */
  const tableOnlyPdf = () => buildSyntheticPdf(
    "1 w\n" +
    "100 550 m 500 550 l S\n100 600 m 500 600 l S\n100 650 m 500 650 l S\n100 700 m 500 700 l S\n" +
    "100 550 m 100 700 l S\n300 550 m 300 700 l S\n500 550 m 500 700 l S\n" +
    "BT /F1 10 Tf 110 665 Td (GUBUN) Tj ET\nBT /F1 10 Tf 310 665 Td (AMOUNT) Tj ET\n" +
    "BT /F1 10 Tf 110 615 Td (ALPHA) Tj ET\nBT /F1 10 Tf 310 615 Td (12345) Tj ET\n" +
    "BT /F1 10 Tf 110 565 Td (BRAVO) Tj ET\nBT /F1 10 Tf 310 565 Td (67890) Tj ET",
  )

  it("totalChars에 table 셀 텍스트가 집계돼 isImageBased/NEEDS_OCR이 발화하지 않는다", async () => {
    const result = await parsePdfDocument(tableOnlyPdf())
    assert.ok(result.blocks.some(b => b.type === "table"), "표가 파싱돼야 함")
    assert.notEqual(result.isImageBased, true, "표-전용 문서는 이미지 기반이 아님")
    assert.ok(!result.warnings?.some(w => w.code === "NEEDS_OCR"),
      "NEEDS_OCR 미발화: " + JSON.stringify(result.warnings))
    assert.ok(result.markdown.includes("GUBUN") && result.markdown.includes("12345"), result.markdown)
  })

  it("options.ocr가 있어도 정상 파싱된 표를 버리고 OCR로 교체하지 않는다", async () => {
    let ocrCalled = false
    const result = await parsePdfDocument(tableOnlyPdf(), {
      ocr: async () => { ocrCalled = true; return "OCRTEXT" },
    })
    assert.equal(ocrCalled, false, "표 텍스트가 집계되면 OCR 경로에 진입하지 않아야 함")
    assert.ok(!result.markdown.includes("OCRTEXT"))
    assert.ok(result.markdown.includes("GUBUN"))
  })

  it("페이지 품질(같은 뿌리)도 셀 텍스트를 집계한다 — low_text 오판 금지", async () => {
    const result = await parsePdfDocument(tableOnlyPdf())
    assert.ok(result.pageQuality && result.pageQuality[0].textChars >= 20,
      `textChars=${result.pageQuality?.[0]?.textChars}`)
    assert.equal(result.pageQuality![0].needsOcr, false)
    assert.equal(result.qualitySummary?.needsOcr, false)
  })
})

// ─── 2. 셀 미매핑 텍스트 무음 소멸 ─────────────────────

describe("결함 2 — 그리드 안 셀 미배정 아이템이 프로즈로 환원된다", () => {
  it("교차비율 ≤0.3 아이템(경계 걸침)이 표에도 본문에도 없이 사라지지 않는다", () => {
    // 내부 교차점 (300,650) 정중앙에 걸친 아이템 — 네 셀과의 교차비율이 각 ~0.28
    const straddler = ni("세로쓰기헤더", 270, 620, 60, 60)
    const items = [...gridCellItems(), straddler]
    const blocks = extractPageBlocksWithLines(items, 1, lineOpList(GRID_SEGS), 612, 792)

    const table = blocks.find(b => b.type === "table")
    assert.ok(table?.table, "표는 정상 감지")
    assert.ok(table!.table!.cells.flat().some(c => c.text.includes("1234")), "셀 텍스트 유지")
    assert.ok(!table!.table!.cells.flat().some(c => c.text.includes("세로쓰기헤더")),
      "미배정 아이템은 셀에 없음")
    const allText = blocks.map(b => b.text || "").join("\n")
    assert.ok(allText.includes("세로쓰기헤더"), `프로즈로 환원돼야 함: ${JSON.stringify(blocks)}`)
  })
})

// ─── 3. buildGridTable | 이스케이프 + 탭 제거 ──────────

describe("결함 3 — 열 기반 폴백 표의 셀 | 이스케이프·\\t 정리", () => {
  it("셀 텍스트의 |는 \\|로, \\t는 공백으로 (builder.ts 그리드 경로와 정합)", () => {
    const columns = [0, 100, 200]
    const yLines: NormItem[][] = [
      [ni("구분", 0, 500, 30), ni("내용", 100, 500, 30), ni("비고", 200, 500, 30)],
      [ni("항목가", 0, 480, 30), ni("가|나", 100, 480, 30), ni("제1호", 200, 480, 30)],
      [ni("항목나", 0, 460, 30), ni("탭\t값", 100, 460, 30), ni("제2호", 200, 460, 30)],
    ]
    const out = extractWithColumns(yLines, columns)
    assert.ok(out.includes("가\\|나"), `| 이스케이프: ${out}`)
    assert.ok(!out.includes("\t"), `\\t 잔존 금지: ${JSON.stringify(out)}`)
    assert.ok(out.includes("탭 값"), `\\t → 공백: ${out}`)
    // 이스케이프 후 모든 표 행의 열 구분자 수가 동일해야 함
    const rows = out.split("\n").filter(l => l.startsWith("| "))
    assert.ok(rows.length >= 3)
    const pipeCount = (s: string) => (s.replace(/\\\|/g, "").match(/\|/g) || []).length
    for (const r of rows) assert.equal(pipeCount(r), pipeCount(rows[0]), `열 수 불일치: ${r}`)
  })
})

// ─── 4. 머리글/바닥글 — 라벨 교정 후 동작 고정 ─────────

describe("결함 4 — top/bottom 라벨 교정 (동작 동일성 고정)", () => {
  const para = (text: string, page: number, y: number): IRBlock => ({
    type: "paragraph", text, pageNumber: page,
    bbox: { page, x: 57, y, width: 400, height: 12 },
  })
  const heights = new Map([[1, 842], [2, 842], [3, 842]])

  it("상단 반복 머리글과 하단 페이지 번호가 모두 제거된다", () => {
    const blocks: IRBlock[] = [
      para("기획재정부 보도자료", 1, 800), para("본문 1", 1, 400), para("- 1 -", 1, 20),
      para("기획재정부 보도자료", 2, 800), para("본문 2", 2, 400), para("- 2 -", 2, 20),
      para("기획재정부 보도자료", 3, 800), para("본문 3", 3, 400), para("- 3 -", 3, 20),
    ]
    const removed = removeHeaderFooterBlocks(blocks, heights, [])
    assert.deepEqual(removed, [0, 2, 3, 5, 6, 8], "머리글+바닥글만 제거, 본문 유지")
  })
})

// ─── 5. ocrPages 페이지별 실패 격리 ────────────────────

describe("결함 5 — 한 페이지 실패가 전체 OCR을 폐기하지 않는다", () => {
  it("getPage 실패 페이지만 placeholder(pageNumber 포함)로 격리된다", async () => {
    const fakePage = {
      getViewport: () => ({ width: 10, height: 10 }),
      render: () => ({ promise: Promise.reject(new Error("render fail")) }),
    }
    const doc = {
      numPages: 3,
      getPage: async (n: number) => {
        if (n === 2) throw new Error("page load fail")
        return fakePage
      },
    }
    let providerCalls = 0
    const blocks = await ocrPages(doc as never, async () => { providerCalls++; return "" }, null, 3)
    assert.equal(blocks.length, 3, "3페이지 모두 블록 존재 (전체 폐기 금지)")
    for (let i = 0; i < 3; i++) {
      assert.equal(blocks[i].text, `[OCR 실패: 페이지 ${i + 1}]`)
      assert.equal(blocks[i].pageNumber, i + 1, "placeholder에도 pageNumber 필요")
    }
    assert.equal(providerCalls, 0)
  })
})

// ─── 6. 이미지 상한 검사 위치 ──────────────────────────

describe("결함 6 — 상한 도달 시 resolveImgData(5초 대기)를 건너뛴다", () => {
  it("상한 도달 후 이미지 op는 디코딩 대기 없이 즉시 스킵된다", async () => {
    // get 콜백을 영원히 호출하지 않는 페이지 — 기존 코드는 이미지당 5초 대기
    const neverPage = {
      objs: { get: () => undefined },
      commonObjs: { get: () => undefined },
    }
    const state = createPdfImageState()
    state.imageIndex = 200 // MAX_IMAGES_PER_DOC 도달 상태
    const warnings: ParseWarning[] = []
    const t0 = Date.now()
    const { blocks } = await extractPageImages(
      neverPage, [OPS.paintImageXObject], [["img_1"]], 1, state, warnings)
    const elapsed = Date.now() - t0
    assert.ok(elapsed < 3000, `상한 도달 시 즉시 스킵돼야 함 (${elapsed}ms)`)
    assert.equal(blocks.length, 0)
    assert.ok(warnings.some(w => w.code === "SKIPPED_IMAGE" && w.message.includes("상한")),
      JSON.stringify(warnings))
  })

  it("상한 미도달 인라인 이미지는 여전히 정상 추출된다", async () => {
    const neverPage = { objs: { get: () => undefined }, commonObjs: { get: () => undefined } }
    const state = createPdfImageState()
    const warnings: ParseWarning[] = []
    const imgData = { width: 8, height: 8, kind: ImageKind.RGB_24BPP, data: new Uint8Array(8 * 8 * 3) }
    const { blocks, images } = await extractPageImages(
      neverPage, [OPS.paintInlineImageXObject], [[imgData]], 1, state, warnings)
    assert.equal(blocks.length, 1)
    assert.equal(images[0].filename, "image_001.png")
  })
})

// ─── 7. 버킷 그리드 성능 + 동작 동일성 ─────────────────

describe("결함 7 — mergeVertices/groupConnectedLines 버킷 그리드", () => {
  it("250×250 괘선(62,500 교차점)이 제한 시간 안에 단일 그리드로 구성된다", () => {
    const horizontals: LineSegment[] = []
    const verticals: LineSegment[] = []
    for (let i = 0; i < 250; i++) {
      horizontals.push(hseg(i * 20, 0, 4980))
      verticals.push(vseg(i * 20, 0, 4980))
    }
    const t0 = Date.now()
    const grids = buildTableGrids(horizontals, verticals)
    const elapsed = Date.now() - t0
    // 버킷 그리드 실측 ~0.3s, 기존 O(V²) 실측 ~3s — 부하 여유 포함 2s 경계
    assert.ok(elapsed < 2000, `O(V²) 회귀 의심 (${elapsed}ms)`)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length, 250)
    assert.equal(grids[0].colXs.length, 250)
  })

  it("근접 교차점 병합·그룹 순서가 기존과 동일하다 (적층 2표)", () => {
    // table-grid-split.test.ts 축소판 — 버킷화가 분리/병합 결과를 바꾸지 않는지
    const horizontals = [
      hseg(650, 100, 500), hseg(600, 100, 500),
      hseg(500, 100, 500), hseg(400, 100, 500), hseg(300, 100, 500),
    ]
    const verticals = [
      vseg(100, 601.5, 650), vseg(500, 601.5, 650), vseg(200, 601.5, 650), vseg(300, 601.5, 650),
      vseg(100, 300, 598.5), vseg(500, 300, 598.5), vseg(150, 300, 598.5), vseg(350, 300, 598.5),
    ]
    const grids = buildTableGrids(horizontals, verticals)
    assert.equal(grids.length, 2)
    const [strip, main] = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)
    assert.deepEqual(strip.colXs, [100, 200, 300, 500])
    assert.deepEqual(main.colXs, [100, 150, 350, 500])
  })
})

// ─── 8. 리스트 중첩 연속성 ─────────────────────────────

describe("결함 8 — 사이 본문을 건너뛴 리스트 중첩 순서 재배열 금지", () => {
  const para = (text: string): IRBlock => ({ type: "paragraph", text, pageNumber: 1 })

  it("본문이 낀 하위 항목은 끌어올리지 않고 제자리 평면 리스트로", () => {
    const blocks: IRBlock[] = [
      para("1. 개요"),
      para("가. 현황"),
      para("일반 본문 설명입니다"),
      para("나. 문제점"),
      para("2. 계획"),
    ]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks.length, 4, "인접한 가.만 children으로 이동")
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[0].children?.length, 1)
    assert.ok(blocks[0].children![0].text!.startsWith("가."))
    assert.ok(blocks[1].text!.startsWith("일반 본문"), "본문이 나.보다 앞 (순서 보존)")
    assert.equal(blocks[2].type, "list")
    assert.ok(blocks[2].text!.startsWith("나."), "나.는 본문 뒤 제자리")
    assert.equal(blocks[3].type, "list")
  })

  it("인접한 하위 항목 중첩은 기존과 동일하게 동작", () => {
    const blocks: IRBlock[] = [para("1. 추진 배경"), para("가. 현황"), para("나. 문제점"), para("2. 추진 계획")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].children?.length, 2)
  })
})

// ─── 9. 그룹 vertex 자기 선 재계산 — 벤치 회귀로 롤백 ──
// 비분할 그룹의 vertex bbox 필터(인접 표 좌표 혼입)를 자기 선 재계산으로 바꾸는
// 수정은 pdf-table-gt에서 exact/cellF1을 올리지만 matchedRate가 98.55%→94.2%로
// 게이트(0.98) 아래로 떨어져 롤백함 (2026-07-16 실측). 재시도 시 pair05/07/08
// 매칭 손실을 먼저 해소할 것.

// ─── 10. XY-Cut 그룹 단위 Y-정렬 ───────────────────────

describe("결함 10 — 최종 Y-정렬이 XY-Cut 컬럼 순서를 재인터리브하지 않는다", () => {
  it("표 아래 2단 텍스트가 좌단 전체 → 우단 전체 순으로 나온다", () => {
    const items: NormItem[] = [
      ...gridCellItems(),
      // 좌단 3줄 (x 50~200) / 우단 3줄 (x 350~500), 수직 갭 150pt.
      // y를 어긋나게 해 클러스터 표 감지(정렬 열)가 아닌 2단 프로즈로 남긴다.
      ni("좌1", 50, 400, 150), ni("우1", 350, 391, 150),
      ni("좌2", 50, 380, 150), ni("우2", 350, 371, 150),
      ni("좌3", 50, 360, 150), ni("우3", 350, 351, 150),
    ]
    const blocks = extractPageBlocksWithLines(items, 1, lineOpList(GRID_SEGS), 612, 792)
    assert.equal(blocks[0].type, "table", "최상단 표가 먼저")
    const paras = blocks.filter(b => b.type !== "table").map(b => (b.text || "").trim())
    assert.deepEqual(paras, ["좌1", "좌2", "좌3", "우1", "우2", "우3"],
      `컬럼 순서 보존 (행 인터리브 금지): ${JSON.stringify(paras)}`)
  })
})
