/**
 * PDF 파서 v3.0 신규 기능 테스트
 * — 폰트 상대 공백 임계값, hasSpaceBefore 전파, 과소분할 표 재구성,
 *   페이지 걸친 표 병합, 캡션 감지, 한국어 리스트 감지, 취소선,
 *   이미지 영역 추출
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  spaceGapThreshold,
  cellTextToString,
  detectEvenSpacedItems,
  extractImageRegions,
  normalizeUndersegmentedTable,
  type TextItem,
} from "../src/pdf/line-detector.js"
import {
  cleanPdfText,
  mergeCrossPageTables,
  detectTableCaptions,
  detectKoreanListBlocks,
  removeHeaderFooterBlocks,
} from "../src/pdf/parser.js"
import { detectClusterTables, type ClusterItem } from "../src/pdf/cluster-detector.js"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

// ─── 헬퍼 ──────────────────────────────────────────────

function ti(text: string, x: number, w: number, opts?: Partial<TextItem>): TextItem {
  return { text, x, y: 100, w, h: 10, fontSize: 10, fontName: "f1", ...opts }
}

function tableBlock(cells: string[][], page: number, bbox?: { x: number; y: number; width: number; height: number }): IRBlock {
  const irCells: IRCell[][] = cells.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 })))
  const table: IRTable = { rows: cells.length, cols: cells[0].length, cells: irCells, hasHeader: true }
  return {
    type: "table",
    table,
    pageNumber: page,
    bbox: { page, x: bbox?.x ?? 50, y: bbox?.y ?? 100, width: bbox?.width ?? 400, height: bbox?.height ?? 200 },
  }
}

// ─── 폰트 상대 공백 임계값 ──────────────────────────────

describe("spaceGapThreshold (fontSize×0.17)", () => {
  it("폰트 크기에 비례한다", () => {
    assert.ok(Math.abs(spaceGapThreshold(10) - 1.7) < 1e-9)
    assert.ok(Math.abs(spaceGapThreshold(20) - 3.4) < 1e-9)
  })

  it("최소 1pt 보장 (0 폰트 방어)", () => {
    assert.equal(spaceGapThreshold(0), 1)
  })
})

describe("cellTextToString — 셀 공백 복원", () => {
  it("hasSpaceBefore 힌트가 있으면 작은 갭에도 공백 삽입 (Type3 폰트)", () => {
    // CRES 실증 패턴: "P1이" + 공백글리프 + "출근해" (갭 2.7pt, fontSize 10.5)
    const items: TextItem[] = [
      ti("P1이", 100, 19),
      ti("출", 122, 9, { hasSpaceBefore: true }),
      ti("근", 131, 9),
      ti("해", 140, 9),
    ]
    assert.equal(cellTextToString(items), "P1이 출근해")
  })

  it("갭이 fontSize×0.17보다 크면 공백 삽입", () => {
    const items: TextItem[] = [ti("구분", 100, 20), ti("내용", 125, 20)] // 갭 5 > 1.7
    assert.equal(cellTextToString(items), "구분 내용")
  })

  it("갭이 임계값 이하면 붙임", () => {
    const items: TextItem[] = [ti("구", 100, 10), ti("분", 111, 10)] // 갭 1 < 1.7
    assert.equal(cellTextToString(items), "구분")
  })
})

describe("detectEvenSpacedItems — 공백 글리프 경계에서 run 분리", () => {
  it("hasSpaceBefore 아이템에서 균등배분 run이 끊긴다", () => {
    // "아침 브리핑" — 1자씩 배치 + 단어 사이 공백 글리프 (균일 갭 3pt)
    const items: TextItem[] = [
      ti("아", 100, 9), ti("침", 112, 9),
      ti("브", 124, 9, { hasSpaceBefore: true }), ti("리", 136, 9), ti("핑", 148, 9),
    ]
    const result = detectEvenSpacedItems(items)
    // '브'는 run 시작이므로 합침 대상 아님 (공백 유지)
    assert.equal(result[2], false)
  })

  it("진짜 균등배분 (공백 글리프 없음)은 여전히 감지", () => {
    const items: TextItem[] = [
      ti("홍", 100, 9), ti("보", 114, 9), ti("담", 128, 9), ti("당", 142, 9), ti("관", 156, 9),
    ]
    const result = detectEvenSpacedItems(items)
    assert.equal(result[1], true)
    assert.equal(result[4], true)
  })
})

// ─── 이미지 영역 추출 ──────────────────────────────────

describe("extractImageRegions", () => {
  it("transform + paintImageXObject에서 bbox 추출", () => {
    const fnArray = [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]
    const argsArray: unknown[][] = [[], [200, 0, 0, 150, 50, 300], ["img1"], []]
    const regions = extractImageRegions(fnArray, argsArray)
    assert.equal(regions.length, 1)
    assert.equal(regions[0].x1, 50)
    assert.equal(regions[0].y1, 300)
    assert.equal(regions[0].x2, 250)
    assert.equal(regions[0].y2, 450)
  })

  it("save/restore로 CTM이 복원된다", () => {
    const fnArray = [
      OPS.save, OPS.transform, OPS.restore,
      OPS.transform, OPS.paintImageXObject,
    ]
    const argsArray: unknown[][] = [
      [], [999, 0, 0, 999, 999, 999], [],
      [100, 0, 0, 100, 10, 20], ["img"],
    ]
    const regions = extractImageRegions(fnArray, argsArray)
    assert.equal(regions.length, 1)
    assert.equal(regions[0].x1, 10)
    assert.equal(regions[0].y1, 20)
    assert.equal(regions[0].x2, 110)
  })

  it("이미지 없으면 빈 배열", () => {
    assert.deepEqual(extractImageRegions([OPS.save, OPS.restore], [[], []]), [])
  })
})

// ─── 과소분할 표 재구성 ────────────────────────────────

describe("normalizeUndersegmentedTable", () => {
  // 3열 그리드 (x: 0-100, 100-200, 200-300), 1행으로 뭉친 표
  const colXs = [0, 100, 200, 300]

  function makeDenseItems(): TextItem[] {
    const items: TextItem[] = []
    // 10줄 × 3열, 줄 간격 20pt (y: 500, 480, ...)
    for (let row = 0; row < 10; row++) {
      const y = 500 - row * 20
      items.push({ text: `왼쪽${row}`, x: 10, y, w: 40, h: 10, fontSize: 10, fontName: "f" })
      items.push({ text: `중간${row}`, x: 110, y, w: 40, h: 10, fontSize: 10, fontName: "f" })
      items.push({ text: `오른${row}`, x: 210, y, w: 40, h: 10, fontSize: 10, fontName: "f" })
    }
    return items
  }

  it("행≤2 + 열≥3 + 줄 8개+ 표를 row band로 재구축", () => {
    const original = [[{ text: "왼쪽들" }, { text: "중간들" }, { text: "오른쪽들" }]]
    const rebuilt = normalizeUndersegmentedTable(original, colXs, makeDenseItems())
    assert.ok(rebuilt, "재구축돼야 함")
    assert.equal(rebuilt!.length, 10)
    assert.equal(rebuilt![0].length, 3)
    assert.equal(rebuilt![0][0], "왼쪽0")
    assert.equal(rebuilt![9][2], "오른9")
  })

  it("행이 3개 이상이면 재구축하지 않음", () => {
    const original = [
      [{ text: "a" }, { text: "b" }, { text: "c" }],
      [{ text: "d" }, { text: "e" }, { text: "f" }],
      [{ text: "g" }, { text: "h" }, { text: "i" }],
    ]
    assert.equal(normalizeUndersegmentedTable(original, colXs, makeDenseItems()), null)
  })

  it("dense 컬럼이 2개 미만이면 재구축하지 않음", () => {
    const sparse: TextItem[] = [
      { text: "한줄", x: 10, y: 500, w: 40, h: 10, fontSize: 10, fontName: "f" },
      { text: "두줄", x: 110, y: 500, w: 40, h: 10, fontSize: 10, fontName: "f" },
    ]
    const original = [[{ text: "한줄" }, { text: "두줄" }, { text: "" }]]
    assert.equal(normalizeUndersegmentedTable(original, colXs, sparse), null)
  })
})

// ─── 페이지 걸친 표 병합 ───────────────────────────────

describe("mergeCrossPageTables", () => {
  it("열 수 동일 + 좌우 경계 근접한 인접 페이지 표를 병합", () => {
    const blocks: IRBlock[] = [
      tableBlock([["구분", "내용"], ["1", "가"]], 1),
      tableBlock([["2", "나"], ["3", "다"]], 2),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 4)
    assert.equal(blocks[0].table!.cells[3][1].text, "다")
  })

  it("반복 헤더 행 제거", () => {
    const blocks: IRBlock[] = [
      tableBlock([["구분", "내용"], ["1", "가"]], 1),
      tableBlock([["구분", "내용"], ["2", "나"]], 2),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 3)
    assert.equal(blocks[0].table!.cells[2][0].text, "2")
  })

  it("열 수가 다르면 병합하지 않음", () => {
    const blocks: IRBlock[] = [
      tableBlock([["a", "b"]], 1),
      tableBlock([["a", "b", "c"]], 2),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 2)
  })

  it("좌우 경계가 멀면 병합하지 않음", () => {
    const blocks: IRBlock[] = [
      tableBlock([["a", "b"]], 1, { x: 50, y: 100, width: 400, height: 100 }),
      tableBlock([["c", "d"]], 2, { x: 250, y: 100, width: 400, height: 100 }),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 2)
  })

  it("같은 페이지 표는 병합하지 않음 (mergeAdjacentTableBlocks 담당)", () => {
    const blocks: IRBlock[] = [
      tableBlock([["a", "b"]], 1),
      tableBlock([["c", "d"]], 1),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 2)
  })

  it("사이에 본문 블록이 있으면 병합하지 않음", () => {
    const blocks: IRBlock[] = [
      tableBlock([["a", "b"]], 1),
      { type: "paragraph", text: "중간 본문", pageNumber: 1 },
      tableBlock([["c", "d"]], 2),
    ]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 3)
  })
})

// ─── 표 캡션 감지 ──────────────────────────────────────

describe("detectTableCaptions", () => {
  function captionPara(text: string, page: number, y: number): IRBlock {
    return {
      type: "paragraph", text, pageNumber: page,
      bbox: { page, x: 60, y, width: 300, height: 12 },
    }
  }

  it("표 직전 '표 N.' 패턴을 caption으로 연결하고 블록 제거", () => {
    const blocks: IRBlock[] = [
      captionPara("표 1. 부서별 예산 현황", 1, 310), // 표 상단(300)에 인접
      tableBlock([["부서", "예산"], ["A과", "100"]], 1, { x: 50, y: 100, width: 400, height: 200 }),
    ]
    detectTableCaptions(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.caption, "표 1. 부서별 예산 현황")
  })

  it("표 직후 '<그림 N>' 패턴도 연결", () => {
    const blocks: IRBlock[] = [
      tableBlock([["a", "b"], ["c", "d"]], 1, { x: 50, y: 100, width: 400, height: 200 }),
      captionPara("<그림 2> 처리 절차도", 1, 80), // 표 하단(100) 바로 아래
    ]
    detectTableCaptions(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.caption, "<그림 2> 처리 절차도")
  })

  it("'표지' 같은 일반 단어는 캡션 아님 (숫자 필수)", () => {
    const blocks: IRBlock[] = [
      captionPara("표지 디자인 안내", 1, 310),
      tableBlock([["a", "b"], ["c", "d"]], 1, { x: 50, y: 100, width: 400, height: 200 }),
    ]
    detectTableCaptions(blocks)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].table!.caption, undefined)
  })

  it("다른 페이지 텍스트는 캡션 아님", () => {
    const blocks: IRBlock[] = [
      captionPara("표 1. 제목", 1, 310),
      tableBlock([["a", "b"], ["c", "d"]], 2, { x: 50, y: 100, width: 400, height: 200 }),
    ]
    detectTableCaptions(blocks)
    assert.equal(blocks.length, 2)
  })

  it("수직으로 먼 텍스트는 캡션 아님", () => {
    const blocks: IRBlock[] = [
      captionPara("표 1. 제목", 1, 500), // 표 상단(300)에서 188pt 떨어짐
      tableBlock([["a", "b"], ["c", "d"]], 1, { x: 50, y: 100, width: 400, height: 200 }),
    ]
    detectTableCaptions(blocks)
    assert.equal(blocks.length, 2)
  })
})

// ─── 한국어 리스트 감지 ────────────────────────────────

describe("detectKoreanListBlocks", () => {
  function para(text: string, page = 1): IRBlock {
    return { type: "paragraph", text, pageNumber: page }
  }

  it("1. 2. 시퀀스를 ordered list로 변환", () => {
    const blocks = [para("1. 첫 번째 항목"), para("2. 두 번째 항목")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[0].listType, "ordered")
    assert.equal(blocks[1].type, "list")
  })

  it("가. 나. 시퀀스를 list로 변환", () => {
    const blocks = [para("가. 쌍방울 사건"), para("나. 대장동 사건")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[1].type, "list")
  })

  it("시퀀스가 없는 단발 번호는 변환하지 않음", () => {
    const blocks = [para("1. 단독 항목"), para("일반 문단"), para("5. 건너뛴 번호")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "paragraph")
    assert.equal(blocks[2].type, "paragraph")
  })

  it("날짜(2026. 6. 9.)는 리스트로 오인하지 않음", () => {
    const blocks = [para("2026. 6. 9.(화) 배포"), para("2026. 6. 10.(수) 시행")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "paragraph")
    assert.equal(blocks[1].type, "paragraph")
  })

  it("상위(1.) 사이의 하위(가.) 항목은 children으로 중첩", () => {
    const blocks = [
      para("1. 추진 배경"),
      para("가. 현황"),
      para("나. 문제점"),
      para("2. 추진 계획"),
    ]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks.length, 2) // 가./나.는 1.의 children으로 이동
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[0].children?.length, 2)
    assert.ok(blocks[0].children![0].text!.startsWith("가."))
    assert.equal(blocks[1].type, "list")
  })

  it("표/헤딩이 끼면 리스트 run이 끊긴다", () => {
    const blocks: IRBlock[] = [
      para("1. 첫 항목"),
      tableBlock([["a", "b"], ["c", "d"]], 1),
      para("가. 별개 항목"),
      para("나. 별개 항목2"),
    ]
    detectKoreanListBlocks(blocks)
    // 가./나.는 1. 의 children이 아니라 독립 리스트
    assert.equal(blocks.length, 4)
    assert.equal(blocks[2].type, "list")
  })

  it("'붙임' 패턴은 시퀀스 없이 리스트로", () => {
    const blocks = [para("붙임 1. 행사 개요 1부. 끝.")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[0].listType, "unordered")
  })

  it("① ② 원문자 시퀀스 감지", () => {
    const blocks = [para("① 첫 항목"), para("② 둘째 항목")]
    detectKoreanListBlocks(blocks)
    assert.equal(blocks[0].type, "list")
    assert.equal(blocks[1].type, "list")
  })
})

// ─── 합성 PDF 통합 테스트 ──────────────────────────────

/** 1페이지 합성 PDF 생성 (Helvetica, 612×792) */
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

describe("합성 PDF 통합 — 취소선/NEEDS_OCR", () => {
  it("텍스트 중심을 가로지르는 얇은 선 → ~~취소선~~ 출력", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const pdf = buildSyntheticPdf(
      "BT /F1 12 Tf 100 700 Td (DELETED TEXT) Tj ET\n" +
      "0.5 w\n98 704.8 m 180 704.8 l S\n" +
      "BT /F1 12 Tf 100 650 Td (normal text here) Tj ET",
    )
    const result = await parsePdfDocument(pdf)
    assert.ok(result.markdown.includes("~~DELETED TEXT~~"), result.markdown)
    assert.ok(result.markdown.includes("normal text here"))
    assert.ok(!result.markdown.includes("~~normal"))
  })

  it("baseline 바로 아래 얇은 선 → <u>밑줄</u> 출력", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const pdf = buildSyntheticPdf(
      "BT /F1 12 Tf 100 700 Td (UNDERLINED TEXT) Tj ET\n" +
      "0.5 w\n98 697.5 m 180 697.5 l S\n" +
      "BT /F1 12 Tf 100 650 Td (normal text here) Tj ET",
    )
    const result = await parsePdfDocument(pdf)
    assert.ok(result.markdown.includes("<u>UNDERLINED TEXT</u>"), result.markdown)
    assert.ok(result.markdown.includes("normal text here"))
    assert.ok(!result.markdown.includes("<u>normal"))
  })

  it("Link 어노테이션(/Annots /URI) → [text](url) 출력", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const content = "BT /F1 12 Tf 100 700 Td (HOMEPAGE) Tj ET"
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R /Annots [6 0 R] >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      "<< /Type /Annot /Subtype /Link /Rect [98 696 180 714] /Border [0 0 0] /A << /S /URI /URI (https://www.korea.kr) >> >>",
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
    const result = await parsePdfDocument(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
    // pdfjs 가 URL 정규화로 트레일링 슬래시를 붙인다
    assert.ok(result.markdown.includes("[HOMEPAGE](https://www.korea.kr/)"), result.markdown)
  })

  it("이미지 전용 PDF → NEEDS_OCR 경고 + isImageBased (무경고 빈 출력 방지)", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const pdf = buildSyntheticPdf(
      "q 500 0 0 700 50 50 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q",
    )
    const result = await parsePdfDocument(pdf)
    assert.equal(result.isImageBased, true)
    assert.ok(result.warnings?.some(w => w.code === "NEEDS_OCR"), JSON.stringify(result.warnings))
  })

  it("본문 충분 + 텍스트 없는 큰 이미지 → SKIPPED_IMAGE 경고", async () => {
    const { parsePdfDocument } = await import("../src/pdf/parser.js")
    const pdf = buildSyntheticPdf(
      "BT /F1 12 Tf 60 750 Td (This page has enough text content to avoid image-based detection.) Tj ET\n" +
      "q 300 0 0 300 150 200 cm BI /W 1 /H 1 /CS /RGB /BPC 8 ID \xff\x00\x00 EI Q",
    )
    const result = await parsePdfDocument(pdf)
    assert.notEqual(result.isImageBased, true)
    assert.ok(result.warnings?.some(w => w.code === "SKIPPED_IMAGE"), JSON.stringify(result.warnings))
  })
})

// ─── 취소선 마크다운 복원 ──────────────────────────────

describe("cleanPdfText — 취소선", () => {
  it("escapeGfm으로 이스케이프된 취소선 쌍을 복원", () => {
    const result = cleanPdfText("개정 전: \\~\\~삭제된 조문\\~\\~ 개정 후: 새 조문")
    assert.ok(result.includes("~~삭제된 조문~~"), result)
  })

  it("인접 run이 붙어 생긴 빈 마크(~~~~)는 제거", () => {
    const result = cleanPdfText("앞~~~~뒤")
    assert.equal(result, "앞뒤")
  })

  it("단일 ~는 이스케이프 유지", () => {
    const result = cleanPdfText("기간: 1월\\~3월")
    assert.ok(result.includes("\\~"))
  })

  it("내용이 사라진 빈 밑줄 쌍(<u></u>)은 제거, 정상 쌍은 유지", () => {
    const result = cleanPdfText("앞<u></u>뒤 <u>개정 조문</u>")
    assert.equal(result.includes("<u></u>"), false)
    assert.ok(result.includes("<u>개정 조문</u>"), result)
  })
})

// ─── 첨자(superscript) 행 — 클러스터 표 오탐 방지 ──────

describe("detectClusterTables — 첨자 행 병합 (본문 문단 드롭 버그)", () => {
  const ci = (text: string, x: number, y: number, w: number, fontSize = 14): ClusterItem =>
    ({ text, x, y, w, h: fontSize, fontSize, fontName: "Test" })

  /** 전체 폭 본문 한 줄 — 9단어, x=57~513, 단어 간 갭 12pt (컬럼 갭 아님) */
  function bodyLine(y: number): ClusterItem[] {
    const items: ClusterItem[] = []
    for (let i = 0; i < 9; i++) {
      items.push(ci(`단어${i}`, 57 + i * 52, y, 40))
    }
    return items
  }

  it("본문 줄 위에 뜬 각주 마커(*)+덧말은 표 헤더로 오인하지 않는다", () => {
    // 실제 사례: 마약류대책협의회 보도자료 p3 — "예방교육*"의 첨자 *와
    // 작은 글씨 덧말 "함께"가 본문 baseline보다 6pt 위에 떠서 별도 행으로 분리됨
    // → 헤더 행으로 오인 → 페이지 본문 전체가 2열 표로 흡수 → builder에서 행 드롭
    const items: ClusterItem[] = [
      ...bodyLine(460),
      // 첨자 행: 아래 본문 줄(y=438, h=14)과 수직으로 겹침 (y=444, h=9)
      ci("*", 220, 444, 4, 9),
      ci("함께", 479, 444, 18, 9),
      ...bodyLine(438),
      ...bodyLine(416),
      ...bodyLine(394),
      ...bodyLine(372),
    ]
    const results = detectClusterTables(items, 3)
    assert.equal(results.length, 0, "본문 문단이 표로 감지되면 안 됨: " +
      JSON.stringify(results.map(r => r.table.cells.map(row => row.map(c => c.text)))))
  })

  it("같은 줄에 첨자 쌍(*, **)만 떠 있어도 열 앵커가 되지 않는다", () => {
    // 실제 사례: 정원진흥기본계획 p3 — "확충*", "제고**"의 첨자 쌍이
    // 별도 행으로 분리되어 fallback 경로의 suspicious row → 열 앵커가 됨
    // (첨자는 단어 끝 바로 뒤(갭 ~2pt)에 위치 — 병합 후 본문 줄에 큰 갭이 생기지 않음)
    const sup = (text: string, x: number, y: number) => ci(text, x, y, 4 + (text.length - 1) * 5, 9.6)
    const items: ClusterItem[] = [
      sup("*", 255, 596.7), sup("**", 463, 596.7),
      ...bodyLine(590.7),
      sup("*", 255, 571.0), sup("**", 463, 571.0),
      ...bodyLine(565.4),
      sup("*", 255, 543.1), sup("**", 463, 543.1),
      ...bodyLine(537.5),
      ...bodyLine(515.0),
    ]
    const results = detectClusterTables(items, 3)
    assert.equal(results.length, 0, "첨자 쌍이 열 앵커가 되면 안 됨: " +
      JSON.stringify(results.map(r => r.table.cells.map(row => row.map(c => c.text)))))
  })

  it("키 큰 rowspan 라벨이 행과 겹쳐도 정상 표 행은 병합되지 않는다", () => {
    // 실제 사례: 위원회 결과 브리핑 p1 — 좌측 세로 라벨 "브리핑"(h=26)이
    // 표의 작은 행(h=9.9)들과 수직으로 겹침. 첨자가 아니므로 병합 금지.
    const row = (texts: string[], y: number): ClusterItem[] =>
      texts.map((t, i) => ci(t, 50 + i * 130, y, t.length * 12, 12))
    const items: ClusterItem[] = [
      ...row(["구분", "담당과", "직책", "연락처"], 400),
      ...row(["가", "혁신기획담당관", "팀장", "1360"], 380),
      ci("브리핑", 20, 365, 40, 26), // 키 큰 세로 라벨 — y=360 행과 겹침
      ...row(["나", "지역미디어정책과", "과장", "1450"], 360),
      ...row(["다", "방송미디어진흥기획과", "과장", "1470"], 340),
    ]
    const results = detectClusterTables(items, 1)
    assert.ok(results.length > 0, "정상 표는 여전히 감지")
    const allText = results[0].table.cells.flat().map(c => c.text).join(" ")
    for (const probe of ["혁신기획담당관", "지역미디어정책과", "방송미디어진흥기획과", "브리핑"]) {
      assert.ok(allText.includes(probe), `행 손실: ${probe} / ${allText}`)
    }
  })
})

// ─── 머리글/바닥글 — 위치 반복만으로 본문 제거 금지 ────

describe("removeHeaderFooterBlocks — 본문 오탐 방지", () => {
  const para = (text: string, page: number, y: number): IRBlock => ({
    type: "paragraph", text, pageNumber: page,
    bbox: { page, x: 57, y, width: 400, height: 14 },
  })
  const heights = new Map([[1, 842], [2, 842], [3, 842]])

  it("페이지 번호(- 1 - 패턴)는 제거된다", () => {
    const blocks: IRBlock[] = [
      para("본문 첫 페이지 내용", 1, 500), para("- 1 -", 1, 30),
      para("본문 둘째 페이지 내용", 2, 500), para("- 2 -", 2, 30),
      para("본문 셋째 페이지 내용", 3, 500), para("- 3 -", 3, 30),
    ]
    const removed = removeHeaderFooterBlocks(blocks, heights, [])
    assert.deepEqual(removed, [1, 3, 5])
  })

  it("같은 y 위치라도 텍스트가 다른 본문 첫 줄은 제거하지 않는다", () => {
    // 실제 사례: 인사말씀 스크립트 — 매 페이지 본문이 같은 y에서 시작하지만
    // 내용이 다름. 위치 반복만으로 제거하면 본문 문단이 통째로 사라진다.
    const blocks: IRBlock[] = [
      para("하지만 서소문 고가차도 철거현장 붕괴사고", 1, 790),
      para("- 1 -", 1, 30),
      para("오늘은 크게 두 가지 주제에 대해 논의하고자 합니다", 2, 790),
      para("- 2 -", 2, 30),
      para("존경하는 참석자 여러분", 3, 790),
      para("- 3 -", 3, 30),
    ]
    const removed = removeHeaderFooterBlocks(blocks, heights, [])
    assert.deepEqual(removed, [1, 3, 5], "페이지 번호만 제거, 본문 첫 줄은 유지")
  })
})
