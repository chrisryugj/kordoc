/**
 * 비한컴 PDF(클립 없는 제작기) 읽기 회귀 테스트 — 겹친 런 분해·짧은 괘선 조각 잇기·글자 단위 클러스터 칸 잇기.
 * 입력은 실측 좌표를 옮긴 합성 아이템/연산자 배열이다 (코퍼스 불필요).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { normalizeItems, mergeLineSimple, type PdfTextItem, type NormItem } from "../src/pdf/text-line.js"
import { detectColumns } from "../src/pdf/columns.js"
import { dropShadingClipGrids } from "../src/pdf/table-grid.js"
import type { TableGrid } from "../src/pdf/line-types.js"
import { parsePdfDocument } from "../src/pdf/parser.js"
import { extractLines, chainShortSegments } from "../src/pdf/line-extract.js"
import { detectClusterTables, type ClusterItem } from "../src/pdf/cluster-detector.js"
import { cellTextToString, mapTextToCells } from "../src/pdf/cell-text.js"
import { cleanPdfText } from "../src/pdf/text-clean.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"

const ti = (str: string, x: number, y: number, width: number, size: number): PdfTextItem =>
  ({ str, transform: [size, 0, 0, size, x, y], width, height: size })

describe("normalizeItems — 겹친 런 분해 (MS Print To PDF·cairo)", () => {
  it("한글 런 빈칸에 나중에 얹힌 숫자를 제자리에 넣는다 (중장기위원회 보도자료 실측)", () => {
    const items = normalizeItems([
      ti("기구인 중장기전략위원회 제 차 전체회의를 개최하였다", 56.64, 489, 337.67, 14.04),
      ti("4", 228.12, 489, 7.72, 14.04),
      ti(".", 393.8, 489, 4.49, 14.04),
    ])
    assert.equal(mergeLineSimple(items), "기구인 중장기전략위원회 제4차 전체회의를 개최하였다.")
  })

  it("빈칸 여럿에 든 숫자를 각각 제 빈칸에 (개인정보 규제영향분석서 cairo 실측)", () => {
    const items = normalizeItems([
      ti("제", 279, 673, 10.67, 11),
      ti("조제 항제 호", 299, 673, 60.68, 11),
      ti("30", 289, 673, 11.05, 11),
      ti("1", 319, 673, 6.05, 11),
      ti("8", 343, 673, 6.05, 11),
    ])
    assert.equal(mergeLineSimple(items).replace(/\s/g, ""), "제30조제1항제8호")
  })

  it("괄호가 얹힌 두 글자 런 — 9.18일(금)", () => {
    const items = normalizeItems([
      ti("일 금", 253.76, 515.52, 31.59, 14.04),
      ti("(", 267.36, 515.52, 4.49, 14.04),
      ti(")", 285.47, 515.52, 4.49, 14.04),
    ])
    assert.equal(mergeLineSimple(items), "일(금)")
  })

  it("같은 글을 조금씩 밀어 여러 번 그린 입체 제목은 가르지 않는다 (한컴 여수 계획서)", () => {
    const items = normalizeItems([
      ti("2026년도 주요업무 시행계획", 75.8, 560.63, 330, 31),
      ti("년도", 141.4, 561.2, 59.01, 31),
    ])
    assert.ok(items.some(i => i.text === "2026년도 주요업무 시행계획"), JSON.stringify(items.map(i => i.text)))
  })

  it("얹힌 글이 없는 런은 그대로", () => {
    const items = normalizeItems([ti("박홍근 장관과 권오현", 405.55, 489, 132.96, 14.04)])
    assert.deepEqual(items.map(i => i.text), ["박홍근 장관과 권오현"])
  })
})

/** v4 형식 constructPath + stroke 연산자 배열 */
function strokeOps(segs: Array<[number, number, number, number]>, lineWidth = 0.5) {
  const fnArray: number[] = [OPS.setLineWidth]
  const argsArray: unknown[][] = [[lineWidth]]
  for (const [x1, y1, x2, y2] of segs) {
    fnArray.push(OPS.constructPath, OPS.stroke)
    argsArray.push([[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]], [])
  }
  return { fnArray, argsArray }
}

/** 칸 클립 격자가 없는 쪽의 경로(page-blocks)처럼 짧은 조각을 이은 선 */
function chainedLines(ops: { fnArray: number[]; argsArray: unknown[][] }) {
  const r = extractLines(ops.fnArray, ops.argsArray)
  return { horizontals: chainShortSegments(r.horizontals, r.shortH, "h"), verticals: chainShortSegments(r.verticals, r.shortV, "v") }
}

describe("chainShortSegments — 짧은 괘선 조각 잇기 (예산서 행마다 끊어 그은 세로선)", () => {
  it("긴 조각 사이에 낀 12pt 조각들을 한 세로선으로 잇는다 (부천 세출예산사업명세서 실측)", () => {
    const { fnArray, argsArray } = strokeOps([
      [42.5, 689.6, 42.5, 671.4], // 18.2 (긴 조각)
      [42.5, 671.4, 42.5, 659.4], // 국
      [42.5, 659.4, 42.5, 647.7], // 균
      [42.5, 647.7, 42.5, 635.7], // 도
      [42.5, 635.7, 42.5, 623.9], // 시
      [42.5, 623.9, 42.5, 623.4], // 모서리 0.5pt
    ])
    const { verticals } = chainedLines({ fnArray, argsArray })
    assert.equal(verticals.length, 1, JSON.stringify(verticals))
    assert.ok(Math.abs(verticals[0].y1 - 623.4) < 0.01 && Math.abs(verticals[0].y2 - 689.6) < 0.01, JSON.stringify(verticals[0]))
  })

  it("따로 떨어진 짧은 조각(체크박스 테두리)은 여전히 버린다", () => {
    const { fnArray, argsArray } = strokeOps([
      [300, 300, 308, 300], [308, 300, 308, 308], [308, 308, 300, 308], [300, 308, 300, 300],
    ])
    const r = chainedLines({ fnArray, argsArray })
    assert.equal(r.horizontals.length + r.verticals.length, 0)
  })

  it("긴 조각끼리만 맞닿은 사슬은 종전대로 조각을 그대로 둔다", () => {
    const { fnArray, argsArray } = strokeOps([[100, 700, 100, 680], [100, 680, 100, 650]])
    const { verticals } = chainedLines({ fnArray, argsArray })
    assert.equal(verticals.length, 2)
  })

  it("한컴 점선 테두리(0.5pt 획·0.7pt 간격)는 실선으로 잇지 않는다 (rowbreak-problem-pages 13쪽 발췌 상자)", () => {
    const segs: Array<[number, number, number, number]> = []
    for (let y = 518.3; y > 400; y -= 1.2) segs.push([59.5, y, 59.5, y - 0.5])
    assert.equal(chainedLines(strokeOps(segs, 0.36)).verticals.length, 0)
  })

  it("점선(조각 사이 실간격)은 잇지 않는다", () => {
    const segs: Array<[number, number, number, number]> = []
    for (let x = 100; x < 200; x += 6) segs.push([x, 400, x + 3, 400])
    const { horizontals } = chainedLines(strokeOps(segs))
    assert.equal(horizontals.length, 0)
  })
})

describe("extractPageBlocksWithLines — 짧은 괘선 잇기는 칸 클립 격자가 없는 쪽에서만", () => {
  const item = (text: string, x: number, y: number): NormItem => ({ text, x, y, w: text.length * 10, h: 10, fontSize: 10, fontName: "F", isHidden: false }) as NormItem
  // 8pt 조각을 맞닿게 이어 그린 2x2 상자 (조직도 부서 상자·예산서 행마다 끊은 괘선과 같은 획 조각)
  const page = (withClipTable: boolean) => {
    const fnArray: number[] = [OPS.setLineWidth]
    const argsArray: unknown[][] = [[0.5]]
    if (withClipTable) for (const [x, y, w, h] of [[50, 700, 200, 20], [250, 700, 200, 20]]) {
      fnArray.push(OPS.constructPath, OPS.eoClip, OPS.endPath)
      argsArray.push([[OPS.rectangle], [x, y, w, h]], [], [])
    }
    const segs: number[][] = []
    for (let x = 100; x < 300; x += 8) for (const y of [400, 440, 480]) segs.push([x, y, x + 8, y])
    for (let y = 400; y < 480; y += 8) for (const x of [100, 200, 300]) segs.push([x, y, x, y + 8])
    for (const sg of segs) { fnArray.push(OPS.constructPath, OPS.stroke); argsArray.push([[OPS.moveTo, OPS.lineTo], sg], []) }
    const items = [item("구분", 60, 705), item("내용", 260, 705), item("총무과", 120, 455), item("재무과", 220, 455), item("민원과", 120, 415), item("세무과", 220, 415)]
    return extractPageBlocksWithLines(items, 1, { fnArray, argsArray }, 595, 842)
  }
  const tableTexts = (blocks: ReturnType<typeof page>) => blocks.filter(b => b.type === "table").map(b => b.table!.cells.flat().map(c => c.text).join("|"))

  it("칸 클립 격자가 없는 쪽(예산서·MS Print)은 조각 상자를 이어 표로 읽는다", () => {
    assert.deepEqual(tableTexts(page(false)), ["총무과|재무과|민원과|세무과"])
  })
  it("칸 클립 격자가 있는 쪽(한컴)은 잇지 않는다 — 조직도 상자 조각이 큰 빈 격자로 부서명을 삼키던 것 (rhwp multi-table-002 17x19)", () => {
    assert.deepEqual(tableTexts(page(true)), ["구분|내용"])
  })
})

describe("cellTextToString — 칸에 쌓인 숫자 줄", () => {
  const item = (text: string, y: number) => ({ text, x: 10, y, w: text.length * 5, h: 10, fontSize: 10, fontName: "f" })
  it("천 단위까지 온전한 숫자 뒤 숫자 줄은 잇지 않는다 (부천 예산서 기정액 \"2,240\" / \"0\")", () => {
    assert.equal(cellTextToString([item("2,240", 100), item("0", 85)]), "2,240\n0")
  })
  it("쉼표 뒤에서 잘린 숫자는 잇는다", () => {
    assert.equal(cellTextToString([item("20,775,", 100), item("661", 85)]), "20,775,661")
  })
})

describe("detectClusterTables — 글자 단위로 그린 칸 글", () => {
  const glyphs = (s: string, x: number, y: number, w = 4, fs = 8): ClusterItem[] =>
    [...s].map((ch, i) => ({ text: ch, x: x + i * w, y, w, h: fs, fontSize: fs, fontName: "GulimChe" }))
  const word = (text: string, x: number, y: number): ClusterItem => ({ text, x, y, w: text.length * 8, h: 8, fontSize: 8, fontName: "Gulim" })

  it("전폭 병합 행 뒤 한 칸짜리 행의 글이 병합에 가려 사라지지 않는다 (제약산업 시행규칙 개정령안 \"3) 행정규제\")", () => {
    // 실측 정규화 아이템 [글, x, y, w, 글자 크기, 공백 힌트] — "없음" 한 아이템 행(전폭 병합) 뒤에 "3) 행정규제 …" 행
    const raw: Array<[string, number, number, number, number, number]> = [["가",71,451,14,14,1],[".",85,451,3,14,0],["관계법령",95,451,56,14,1],[":",158,451,4,14,1],["생",169,451,14,14,1],["략",211,451,14,14,0],["나",71,419,14,14,1],[".",85,419,3,14,0],["예산조치",95,419,56,14,1],[":",158,419,4,14,1],["별도조치",169,419,56,14,1],["필요",232,419,28,14,1],["없음",267,419,28,14,1],["다",71,387,14,14,1],[".",85,387,3,14,0],["합",95,387,14,14,1],["의",137,387,14,14,0],[":",158,387,4,14,1],["OOOO",169,387,42,14,1],["부",211,387,14,14,0],["등과",232,387,28,14,1],["합의되었음",267,387,70,14,1],["라",71,355,14,14,1],[".",85,355,3,14,0],["기",95,355,14,14,1],["타",137,355,14,14,0],[":",158,355,4,14,1],["1)",169,355,12,14,1],["신",188,355,14,14,1],["ㆍ",202,355,14,14,0],["구",216,355,14,14,0],["조",230,355,14,14,0],["문",244,355,14,14,0],["대",258,355,14,14,0],["비",272,355,14,14,0],["표",286,355,14,14,0],[",",300,355,3,14,0],["별첨",311,355,28,14,1],["2)",169,323,12,14,1],["입법예고",188,323,56,14,1],["(9999.",244,323,37,14,0],["12.",287,323,17,14,1],["31.",311,323,17,14,1],["∼",335,323,14,14,1],["12.",356,323,17,14,1],["31.)",380,323,23,14,1],["결과",410,323,28,14,1],[",",438,323,3,14,0],["특기할",448,323,42,14,1],["사항",496,323,28,14,1],["없음",181,291,28,14,1],["3)",169,258,12,14,1],["행정규제",188,258,56,14,1],[":",251,258,4,14,1],["규제개혁위원회와",262,258,112,14,1],["협의",381,258,28,14,1],["결과",416,258,28,14,1],[",",444,258,3,14,0],["이견",454,258,28,14,1],["없음",489,258,28,14,1]]
    const items: ClusterItem[] = raw.map(([text, x, y, w, fs, sp]) => ({ text, x, y, w, h: fs, fontSize: fs, fontName: "f", hasSpaceBefore: sp === 1 }))
    const [t] = detectClusterTables(items, 1)
    assert.ok(t, "표 감지")
    const visible: string[] = []
    for (const row of t.table.cells) {
      let skip = 0
      for (const c of row) { if (skip-- > 0) continue; visible.push(c.text); skip = c.colSpan - 1 }
    }
    assert.ok(visible.some(s => s.includes("행정규제")), JSON.stringify(t.table.cells))
  })

  it("0~1pt 간격 글자 조각을 공백 없이 잇는다 — \"2 0 , 7 7 5\" 방지", () => {
    const items: ClusterItem[] = [
      word("구분", 50, 700), word("예산액", 300, 700), word("기정액", 420, 700),
      word("일자리정책과", 50, 680), ...glyphs("20,775,661", 300, 680), ...glyphs("9,243,723", 420, 680),
      word("고용안정", 50, 660), ...glyphs("14,036,788", 300, 660), ...glyphs("9,143,733", 420, 660),
      word("고용촉진", 50, 640), ...glyphs("3,775,655", 300, 640), ...glyphs("4,148,981", 420, 640),
    ]
    const [t] = detectClusterTables(items, 1)
    assert.ok(t, "표 감지")
    const texts = t.table.cells.flat().map(c => c.text)
    for (const n of ["20,775,661", "9,243,723", "14,036,788", "4,148,981"]) assert.ok(texts.includes(n), `${n} 없음: ${JSON.stringify(texts)}`)
  })
})

describe("detectColumns — 조각난 본문 줄은 열이 아니다", () => {
  const n = (text: string, x: number, y: number, w: number, fs = 14): NormItem =>
    ({ text, x, y, w, h: fs, fontSize: fs, fontName: "f", isHidden: false })
  it("앞 조각에 1em 미만으로 이어진 조각 x 는 열 후보가 아니다 (MS Print To PDF 보도자료 2쪽)", () => {
    const lines: NormItem[][] = []
    for (let i = 0; i < 8; i++) {
      const y = 700 - i * 26
      // 한 줄이 서너 조각으로 쪼개졌지만 조각 사이 간격은 낱말 공백(4~7pt)뿐 — 조각 시작 x 는 줄마다 다르다
      const cut1 = 150 + (i % 3) * 60, cut2 = 330 + (i % 2) * 50
      lines.push([n("본문 앞부분 글자들이 이어지는", 57, y, cut1 - 57 - 5), n("가운데 조각 글", cut1, y, cut2 - cut1 - 4), n("끝 조각", cut2, y, 538 - cut2)])
    }
    assert.equal(detectColumns(lines), null)
  })
  it("열 사이가 1em 이상 빈 무괘선 표는 그대로 감지한다", () => {
    const lines: NormItem[][] = []
    for (let i = 0; i < 6; i++) lines.push([n(`항목${i}`, 57, 700 - i * 20, 40), n(`${i}월`, 200, 700 - i * 20, 30), n(`${i * 100}원`, 360, 700 - i * 20, 40)])
    assert.ok(detectColumns(lines)?.length === 3)
  })
})

describe("dropShadingClipGrids — 배경 칠한 칸에만 건 클립(cairo)", () => {
  const cell = (row: number, col: number, x1: number, y1: number, x2: number, y2: number) => ({ row, col, rowSpan: 1, colSpan: 1, bbox: { x1, y1, x2, y2 } })
  // 연구개발 지원 공고 cairo 2쪽 실측: 머리행 두 칸만 클립(=채움), 선 격자는 3x2
  const lineGrid: TableGrid = { rowYs: [221.8, 205, 188, 171], colXs: [74.8, 297.8, 521], bbox: { x1: 74.8, y1: 171, x2: 521, y2: 221.8 }, vertexRadius: 1 }
  const headerClip: TableGrid = {
    rowYs: [221, 205], colXs: [75, 298, 521], bbox: { x1: 75, y1: 205, x2: 521, y2: 221 }, vertexRadius: 1,
    cells: [cell(0, 0, 75, 205, 298, 221), cell(0, 1, 298, 205, 521, 221)],
  }
  const fills = [{ x1: 74, y1: 205, x2: 298, y2: 222 }, { x1: 297, y1: 205, x2: 521, y2: 222 }]

  const rules = [{ x1: 297.8, y1: 171, x2: 297.8, y2: 221.8, lineWidth: 1 }]
  it("선 표의 머리행 음영 클립 조각은 버린다", () => {
    assert.equal(dropShadingClipGrids([headerClip], [lineGrid], fills, rules).length, 0)
  })
  it("상단 음영 두 행만 클립이어도 선 격자의 마지막 흰 행을 보존한다", () => {
    const complete: TableGrid = {
      rowYs: [323.5, 305.875, 285, 258], colXs: [57.5, 216.75, 375.75, 534],
      bbox: { x1: 57.5, y1: 258, x2: 534, y2: 323.5 }, vertexRadius: 1,
    }
    const shaded: TableGrid = {
      rowYs: [323, 305, 285], colXs: [58, 217, 376, 534],
      bbox: { x1: 58, y1: 285, x2: 534, y2: 323 }, vertexRadius: 1,
      cells: [
        cell(0, 0, 58, 305, 534, 323),
        cell(1, 0, 58, 285, 217, 305), cell(1, 1, 217, 285, 376, 305), cell(1, 2, 376, 285, 534, 305),
      ],
    }
    const shades = shaded.cells!.map(c => c.bbox)
    const dividers = [217, 376].map(x => ({ x1: x, y1: 258, x2: x, y2: 305, lineWidth: 1 }))
    assert.equal(dropShadingClipGrids([shaded], [complete], shades, dividers).length, 0)
  })
  it("칸 사이가 괘선 없이 흰 틈으로만 갈린 음영 머리행은 둔다 (한컴 구버전 성과지표 \"실적 | 목표치\")", () => {
    assert.equal(dropShadingClipGrids([headerClip], [lineGrid], fills, []).length, 1)
  })
  it("표 전체 칸에 클립이 있는 한컴식 격자는 둔다 (음영 칸이 섞여도)", () => {
    const full: TableGrid = {
      ...lineGrid, bbox: { x1: 75, y1: 171, x2: 521, y2: 221 },
      cells: [cell(0, 0, 75, 205, 298, 221), cell(0, 1, 298, 205, 521, 221), cell(1, 0, 75, 188, 298, 205), cell(1, 1, 298, 188, 521, 205), cell(2, 0, 75, 171, 298, 188), cell(2, 1, 298, 171, 521, 188)],
    }
    assert.equal(dropShadingClipGrids([full], [lineGrid], fills).length, 1)
  })
  it("흰색으로 칠한 한컴 클립 표는 선 격자 나머지를 다른 클립 표가 덮으면 둔다 (벤처투자조합 등록신청서)", () => {
    const form: TableGrid = { rowYs: [300, 100], colXs: [74.8, 297.8, 521], bbox: { x1: 74.8, y1: 100, x2: 521, y2: 300 }, vertexRadius: 1 }
    const whiteTable: TableGrid = { ...headerClip, bbox: { x1: 75, y1: 205, x2: 521, y2: 221 } }
    const otherTables: TableGrid = {
      rowYs: [300, 222], colXs: [75, 298, 521], bbox: { x1: 75, y1: 100, x2: 521, y2: 204 }, vertexRadius: 1,
      cells: [cell(0, 0, 75, 100, 298, 204), cell(0, 1, 298, 100, 521, 204)],
    }
    assert.equal(dropShadingClipGrids([whiteTable, otherTables], [form], fills, rules).length, 2)
  })
  it("채움 없는 칸 클립은 둔다", () => {
    assert.equal(dropShadingClipGrids([headerClip], [lineGrid], [], rules).length, 1)
  })
})

describe("PDF 리터럴 $ — IR 규약 \\$ (수식 스팬 오인 방지)", () => {
  function onePagePdf(content: string): ArrayBuffer {
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    ]
    let pdf = "%PDF-1.4\n"
    const offsets: number[] = []
    objects.forEach((o, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${o}\nendobj\n` })
    const xref = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
    const b = Buffer.from(pdf, "latin1")
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
  }
  it("\"US $10 ... US $20\" 사이가 수식 스팬으로 열리지 않게 \\$ 로 담는다", async () => {
    const r = await parsePdfDocument(onePagePdf("BT /F1 12 Tf 72 700 Td (Unit price US $10, total US $20) Tj ET"))
    assert.ok(r.markdown.includes("US \\$10") && r.markdown.includes("US \\$20"), r.markdown)
  })
})

describe("mapTextToCells — 괘선 없는 경계를 걸친 낱말", () => {
  it("글자 단위 낱말의 첫 글자만 위 칸(행 병합)으로 떨어지지 않는다 (부천 \"사|회적기업\")", () => {
    const cell = (row: number, col: number, rowSpan: number, x1: number, y1: number, x2: number, y2: number) => ({ row, col, rowSpan, colSpan: 1, bbox: { x1, y1, x2, y2 } })
    // 들여쓰기 열 [59.5,76.6] 은 위 행부터 병합된 칸, 아래 행 이름 칸은 76.6 부터 — 71.3 에서 시작하는 낱말이 경계를 걸친다
    const upper = cell(0, 0, 2, 59.5, 206.7, 76.6, 287.3)
    const name = cell(1, 1, 1, 76.6, 206.7, 292.3, 261.1)
    const glyph = (text: string, x: number) => ({ text, x, y: 249, w: 8, h: 8, fontSize: 8, fontName: "GulimChe" })
    const items = [glyph("사", 71), glyph("회", 80), glyph("적", 89), glyph("기", 97), glyph("업", 106)]
    const m = mapTextToCells(items, [upper, name])
    assert.equal(m.get(upper)!.length, 0)
    assert.equal(cellTextToString(m.get(name)!), "사회적기업")
  })
  it("좁은 칸에 바짝 붙은 서로 다른 칸 글은 모으지 않는다 (창원 월별 일정표 \"10월|11월\")", () => {
    const cell = (col: number, x1: number, x2: number) => ({ row: 0, col, rowSpan: 1, colSpan: 1, bbox: { x1, y1: 100, x2, y2: 115 } })
    const a = cell(0, 400, 415), b = cell(1, 415, 430)
    const t = (text: string, x: number) => ({ text, x, y: 104, w: 14, h: 8, fontSize: 8, fontName: "f" })
    const m = mapTextToCells([t("10월", 401), t("11월", 416)], [a, b])
    assert.deepEqual([m.get(a)!.map(i => i.text), m.get(b)!.map(i => i.text)], [["10월"], ["11월"]])
  })
})

describe("cleanPdfText — 균등배분 후처리와 마크다운 표지", () => {
  it("헤딩·목록 표지는 한 글자 토큰으로 세지 않는다 (\"# 목 차\" 가 \"#목차\" 로 헤딩이 깨지던 것, K-water 제안요청서)", () => {
    assert.equal(cleanPdfText("# 목 차\n\n- 가 나 다\n\n홍 보 담 당 관"), "# 목 차\n\n- 가나다\n\n홍보담당관")
  })
})
