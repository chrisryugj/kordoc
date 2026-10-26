/**
 * PDF 한컴 칸 클립 격자 칸의 보이는 변 (cell-edges, v4.17.0) — 보이지 않는 틀 표 풀기(layout-frames)의 PDF 쪽 곁정보.
 *
 * 한컴 PDF 는 테두리 "없음" 칸에도 칸 클립을 깔고, 보이는 테두리만 칸 경계 좌표 그대로 선으로 긋는다(할부거래법 시행령 [별표 1]
 * 분수 막대 = 분자 칸 밑변). 클립 격자 칸에만 변 곁정보를 두고 선 격자·클러스터 표에는 두지 않는다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { cellEdges, joinCellEdges, recordClipCellEdges, CLIP_CELL_EDGES, NO_EDGES } from "../src/pdf/cell-edges.js"
import { extractLines } from "../src/pdf/line-extract.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { joinSplitParts } from "../src/pdf/table-parts.js"
import { mergeContinuedCells } from "../src/pdf/cell-continuation.js"
import { CLIP_TABLES, CONT_PARTS, FILLER_CELLS, TABLE_COLXS, recordCellLines } from "../src/pdf/table-meta.js"
import { CELL_EDGES, unframeLayoutTables, type Edges } from "../src/table/layout-frames.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

const hl = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.24 })
const vl = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.24 })
const BOX = { x1: 100, y1: 600, x2: 200, y2: 640 }

type Ops = { fn: number[]; args: unknown[][] }
const clip = (x: number, y: number, w: number, h: number): Ops => ({ fn: [OPS.constructPath, OPS.eoClip, OPS.endPath], args: [[[OPS.rectangle], [x, y, w, h]], [], []] })
const strokeLine = (x1: number, y1: number, x2: number, y2: number): Ops => ({ fn: [OPS.constructPath, OPS.stroke], args: [[[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]], []] })
const strokeRect = (x: number, y: number, w: number, h: number): Ops => ({ fn: [OPS.constructPath, OPS.stroke], args: [[[OPS.rectangle], [x, y, w, h]], []] })
const color = (r: number, g: number, b: number): Ops => ({ fn: [OPS.setStrokeRGBColor], args: [[r, g, b]] })
const op = (fn: number): Ops => ({ fn: [fn], args: [[]] })
const concat = (...parts: Ops[]) => ({ fnArray: parts.flatMap(p => p.fn), argsArray: parts.flatMap(p => p.args) })
const item = (text: string, x: number, y: number, w = text.length * 6): NormItem =>
  ({ text, x, y, w, h: 10, fontSize: 10, fontName: "F", isHidden: false }) as NormItem

describe("cellEdges — 변 자리 선이 변 길이의 대부분을 덮으면 보이는 변", () => {
  it("칸 경계 좌표에 그은 선(양끝 0.12pt 넘김)은 보이는 변, 선 없는 변은 안 보인다", () => {
    assert.deepEqual(cellEdges(BOX, [hl(99.88, 200.12, 600)], []), { t: false, b: true, l: false, r: false })
    assert.deepEqual(cellEdges(BOX, [hl(100, 200, 640), hl(100, 200, 600)], [vl(100, 600, 640), vl(200, 600, 640)]), { t: true, b: true, l: true, r: true })
  })

  it("변에서 떨어진 선(칸 안 글 밑줄 자리)·변 일부만 덮는 선은 보이는 변이 아니다", () => {
    assert.equal(cellEdges(BOX, [hl(100, 200, 603)], []).b, false)
    assert.equal(cellEdges(BOX, [hl(100, 200, 601)], []).b, true, "셀 간격 표의 괘선 틈 닫은 좌표 — 1.5pt 안")
    assert.equal(cellEdges(BOX, [hl(160, 300, 600)], []).b, false, "변의 40% 만 덮음")
  })

  it("틀 칸 안 들여쓴 상자의 테두리는 위아래 온 폭 칸 변이 아니다 — 97.6% 를 덮어도 양끝이 5.6pt 씩 빈다", () => {
    // 물환경보전법 시행령 [별표 14의2]: 틀 칸 58.05~509.73, 산식 상자 63.69~504.09 (선 63.57~504.33 @639.62)
    const frame = { x1: 58.05, y1: 639.62, x2: 509.73, y2: 762.37 }, box = { x1: 63.69, y1: 601.98, x2: 504.09, y2: 639.62 }
    const top = hl(63.57, 504.33, 639.62)
    assert.equal(cellEdges(frame, [top], []).b, false)
    assert.equal(cellEdges(box, [top], []).t, true)
  })

  it("상자 사이 좁은 간격 칸 — 양옆 상자 괘선 끝(0.12pt)만 들어온 변은 안 보이고, 가로질러 그은 선은 보인다", () => {
    const gap = { x1: 200, y1: 600, x2: 203, y2: 640 }
    assert.equal(cellEdges(gap, [hl(99.88, 200.12, 640), hl(202.88, 300.12, 640)], []).t, false)
    assert.equal(cellEdges(gap, [hl(99.88, 300.12, 640)], []).t, true)
  })

  it("점선 테두리(0.6pt 점·0.8pt 틈 — 한컴 실측)는 보이는 변", () => {
    const dots: LineSegment[] = []
    for (let x = 100; x < 200; x += 1.4) dots.push(hl(x, x + 0.6, 640))
    assert.equal(cellEdges(BOX, dots, []).t, true)
    const late: LineSegment[] = []
    for (let x = 102.5; x < 200; x += 1.4) late.push(hl(x, x + 0.6, 640))
    assert.equal(cellEdges(BOX, late, []).t, true, "무늬가 2.5pt 늦게 시작해도 점선 끝 틈")
  })

  it("옆 칸 변이 걸친 변 — 실선 한 가닥이 변 한끝을 2pt 넘게 비우면 보이지 않는 변이다", () => {
    // 농작업 안전 수칙 보도자료 「<참고>」 머리 상자: 위 빈 칸(241.19~248.03) 오른변 자리에 상자 왼변 선(234.83~245.39)이 61% 걸침
    const blank = { x1: 55.62, y1: 241.19, x2: 67.13, y2: 248.03 }
    assert.equal(cellEdges(blank, [], [vl(67.13, 234.83, 245.39)]).r, false)
    assert.equal(cellEdges(blank, [], [vl(67.13, 241.07, 248.15)]).r, true, "모서리까지 그은 제 변")
    assert.equal(cellEdges(blank, [], [vl(67.13, 242.81, 248.15)]).r, true, "겹선·굵은 선 모서리 들임(1.6pt)")
  })
})

describe("extractLines — 칸 테두리 선이 아닌 선 (nonRules)", () => {
  it("흰 획으로 그은 선은 nonRules 에 든다 (선 목록에는 종전대로 남는다), restore 로 색이 돌아온다", () => {
    const ops = concat(op(OPS.save), color(255, 255, 255), strokeRect(100, 600, 100, 40), op(OPS.restore), strokeLine(100, 500, 200, 500))
    const r = extractLines(ops.fnArray, ops.argsArray)
    assert.equal(r.horizontals.length, 3)
    assert.equal(r.verticals.length, 2)
    const white = [...r.horizontals, ...r.verticals].filter(l => r.nonRules.has(l))
    assert.equal(white.length, 4, "흰 사각형 네 변")
    assert.ok(!r.nonRules.has(r.horizontals.find(l => l.y1 === 500)!), "restore 뒤 검은 선")
  })

  it("칸 음영(두꺼운 m/l 사각형 채움)의 윤곽은 nonRules, 얇은(≤1.5pt) 채움 괘선은 괘선", () => {
    // 한컴 음영 칸: m/l/l/l/l/h 경로 + eoFill (정책브리핑 지진 대응 보도자료 "개 회 식" 행)
    const shade: Ops = { fn: [OPS.constructPath, OPS.eoFill], args: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.lineTo, OPS.lineTo, OPS.closePath], [59.49, 698.72, 59.49, 675.46, 535.15, 675.46, 535.15, 698.72, 59.49, 698.72]], []] }
    const thin: Ops = { fn: [OPS.constructPath, OPS.fill], args: [[[OPS.rectangle], [100, 500, 200, 0.5]], []] }
    const r = extractLines(concat(shade, thin).fnArray, concat(shade, thin).argsArray)
    const shadeLines = [...r.horizontals, ...r.verticals].filter(l => l.y1 !== 500.25)
    assert.ok(shadeLines.length >= 4 && shadeLines.every(l => r.nonRules.has(l)))
    const rule = r.horizontals.find(l => Math.abs(l.y1 - 500.25) < 0.01)
    assert.ok(rule && !r.nonRules.has(rule))
  })

  it("맞붙은 그러데이션 채움 띠는 괘선이 아니다, 이중선 채움 괘선은 괘선이다", () => {
    // 한글 PDF 그러데이션: 0.45pt 띠를 m/l/l/l/h 채움으로 수십 개 맞붙인다 (대광위 보도자료 "목표" 상자)
    const band = (y: number): Ops => ({ fn: [OPS.constructPath, OPS.fill], args: [[[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.lineTo, OPS.closePath], [-311, y, 536.7, y, 536.7, y + 0.45, -311, y + 0.45]], []] })
    const bands = concat(...Array.from({ length: 40 }, (_, k) => band(600 + k * 0.45)))
    const g = extractLines(bands.fnArray, bands.argsArray)
    assert.equal(g.horizontals.filter(l => l.y1 >= 599 && l.y1 <= 620).length, 0)
    const dbl = concat(band(500), band(501.5))
    const d = extractLines(dbl.fnArray, dbl.argsArray)
    assert.equal(d.horizontals.filter(l => l.y1 >= 499 && l.y1 <= 503).length, 4)
  })
})

describe("recordClipCellEdges — 클립 격자 칸에만", () => {
  const cell = { row: 0, col: 0, rowSpan: 1, colSpan: 1, bbox: { ...BOX } }
  it("cells 없는 선 격자는 기록하지 않는다", () => {
    const lineGrid: TableGrid = { rowYs: [640, 600], colXs: [100, 200], bbox: { ...BOX }, vertexRadius: 1 }
    const clipCell = { ...cell, bbox: { ...BOX } }
    recordClipCellEdges([lineGrid, { ...lineGrid, cells: [clipCell] }], [hl(100, 200, 600)], [])
    assert.deepEqual(CLIP_CELL_EDGES.get(clipCell), { t: false, b: true, l: false, r: false })
  })

  it("흰 선은 보이는 변이 아니다", () => {
    const c = { ...cell, bbox: { ...BOX } }
    const white = hl(100, 200, 640)
    recordClipCellEdges([{ rowYs: [640, 600], colXs: [100, 200], bbox: { ...BOX }, vertexRadius: 1, cells: [c] }], [white, hl(100, 200, 600)], [], new Set([white]))
    assert.deepEqual(CLIP_CELL_EDGES.get(c), { t: false, b: true, l: false, r: false })
  })
  it("얇은 빈 채움 띠는 한 괘선을 위·아래 두 테두리로 복제하지 않는다", () => {
    const c = { ...cell, filler: true, bbox: { ...BOX, y1: 600, y2: 601 } }
    recordClipCellEdges([{ rowYs: [601, 600], colXs: [100, 200], bbox: c.bbox, vertexRadius: 1, cells: [c] }], [hl(100, 200, 600)], [])
    assert.deepEqual(CLIP_CELL_EDGES.get(c), { ...NO_EDGES, b: true })
  })
  it("클립이 없는 칸도 실제 가로·세로 테두리는 보존한다", () => {
    const c = { ...cell, filler: true, bbox: { ...BOX } }
    recordClipCellEdges([{ rowYs: [640, 600], colXs: [100, 200], bbox: c.bbox, vertexRadius: 1, cells: [c] }], [hl(100, 200, 600)], [vl(200, 600, 640)])
    assert.deepEqual(CLIP_CELL_EDGES.get(c), { t: false, b: true, l: false, r: true })
  })
  it("얇은 채움 칸도 두 개의 별도 가로선은 보존한다", () => {
    const c = { ...cell, filler: true, bbox: { ...BOX, y1: 600, y2: 601 } }
    recordClipCellEdges([{ rowYs: [601, 600], colXs: [100, 200], bbox: c.bbox, vertexRadius: 1, cells: [c] }], [hl(100, 200, 600), hl(100, 200, 601)], [])
    assert.deepEqual(CLIP_CELL_EDGES.get(c), { t: true, b: true, l: false, r: false })
  })
})

describe("extractPageBlocksWithLines — 칸 클립 표만 IR 칸에 보이는 변", () => {
  // 할부거래법 시행령 [별표 1] 모양: 선 없는 틀(제목 행 + "가. …A=" 2행 병합 | 분자/분모 | 빈 칸), 분자 칸 밑변에만 분수 막대
  const fractionPage = () => {
    const ops = concat(
      clip(50, 700, 450, 20),
      clip(50, 660, 250, 40), clip(300, 680, 100, 20), clip(400, 660, 100, 40), clip(300, 660, 100, 20),
      strokeLine(299.88, 680, 400.12, 680),
    )
    const items = [item("■ 할부거래에 관한 법률 시행령 [별표 1]", 60, 705), item("가. 복리 계산방법: A=P×r×", 60, 675), item("(1+r)", 330, 685), item("(1+r)-1", 330, 664)]
    return extractPageBlocksWithLines(items, 1, ops, 595, 842)
  }

  it("선 없는 칸 클립 틀 → 칸마다 곁정보, layout-frames 가 글과 분수로 푼다", () => {
    const blocks = fractionPage()
    const t = blocks.find(b => b.type === "table")!.table!
    assert.ok(CLIP_TABLES.has(t))
    const num = t.cells.flat().find(c => c.text === "(1+r)")!
    assert.deepEqual(CELL_EDGES.get(num), { t: false, b: true, l: false, r: false }, "분자 칸 밑변 = 분수 막대")
    assert.deepEqual(CELL_EDGES.get(t.cells[0][0]), NO_EDGES)
    const md = blocksToMarkdown(unframeLayoutTables(blocks))
    assert.ok(!md.includes("<table") && !md.includes("| --- |"), md)
    assert.match(md, /가\. 복리 계산방법: A=P×r× \$\\frac\{\(1\+r\)\}\{\(1\+r\)-1\}\$/)
  })

  it("클립 없는 선 격자 표(선으로 만든 표)에는 곁정보가 없어 layout-frames 가 손대지 않는다", () => {
    const ops = concat(
      strokeLine(50, 720, 450, 720), strokeLine(50, 690, 450, 690), strokeLine(50, 660, 450, 660), strokeLine(50, 630, 450, 630),
      strokeLine(50, 630, 50, 720), strokeLine(250, 630, 250, 720), strokeLine(450, 630, 450, 720),
    )
    const items = [item("구분", 60, 700), item("금액", 260, 700), item("가", 60, 670), item("10", 260, 670), item("나", 60, 640), item("20", 260, 640)]
    const blocks = extractPageBlocksWithLines(items, 1, ops, 595, 842)
    const tb = blocks.find(b => b.type === "table")
    assert.ok(tb, "선 격자 표")
    assert.ok(!CLIP_TABLES.has(tb!.table!))
    assert.ok(tb!.table!.cells.flat().every(c => !CELL_EDGES.has(c)))
    assert.equal(unframeLayoutTables([tb!])[0], tb, "그대로")
  })

  it("흰 테두리 칸 클립 표는 선이 안 보이는 틀이다", () => {
    const ops = concat(clip(50, 690, 200, 30), clip(250, 690, 200, 30), clip(50, 660, 400, 30), color(255, 255, 255),
      strokeRect(50, 690, 200, 30), strokeRect(250, 690, 200, 30), strokeRect(50, 660, 400, 30))
    const blocks = extractPageBlocksWithLines([item("가. 첫째", 60, 700), item("나. 둘째", 260, 700), item("다. 셋째", 60, 670)], 1, ops, 595, 842)
    const t = blocks.find(b => b.type === "table")!.table!
    assert.ok(t.cells.flat().filter(c => c.text).every(c => JSON.stringify(CELL_EDGES.get(c)) === JSON.stringify(NO_EDGES)))
    assert.deepEqual(unframeLayoutTables(blocks).map(b => b.type), ["paragraph", "paragraph"])
  })
})

describe("클립 격자 표 위 단위 줄 — 자기 테두리 없는 칸", () => {
  it("\"(단위: …)\" 첫 행은 보이는 변이 없어 layout-frames 가 문단으로 풀고, 괘선 표는 그대로 남는다", () => {
    const parts: Ops[] = []
    for (const y of [400, 420, 440]) for (const x of [100, 200, 300]) parts.push(clip(x, y, 100, 20))
    for (const sg of [[100, 400, 400, 400], [100, 420, 400, 420], [100, 440, 400, 440], [100, 460, 400, 460],
      [100, 400, 100, 460], [200, 400, 200, 460], [300, 400, 300, 460], [400, 400, 400, 460]]) parts.push(strokeLine(sg[0], sg[1], sg[2], sg[3]))
    const items = [item("(단위: ha, %)", 335, 464, 60),
      item("구분", 130, 445, 20), item("2025", 230, 445, 20), item("2026", 330, 445, 20),
      item("벼", 140, 425, 10), item("677", 230, 425, 20), item("670", 330, 425, 20),
      item("고추", 130, 405, 20), item("25", 235, 405, 10), item("25", 335, 405, 10)]
    const blocks = extractPageBlocksWithLines(items, 1, concat(...parts), 595, 842)
    const t = blocks.find(b => b.type === "table")!.table!
    assert.equal(t.rows, 4)
    assert.equal(t.cells[0][0].text, "(단위: ha, %)")
    assert.deepEqual(CELL_EDGES.get(t.cells[0][0]), NO_EDGES)
    assert.deepEqual(CELL_EDGES.get(t.cells[1][0]), { t: true, b: true, l: true, r: true })
    const shown = unframeLayoutTables(blocks.filter(b => b.type === "table"))
    assert.deepEqual(shown.map(b => b.type), ["paragraph", "table"])
    assert.equal(shown[1].table!.rows, 3)
  })
})

/** 앵커 목록 → 덮인 자리까지 채운 IR 격자 ([행, 열, 글, 변, 열병합, 행병합]) */
function grid(rows: number, cols: number, anchors: Array<[number, number, string, Edges, number?, number?]>): IRTable {
  const cells: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  for (const [r, c, text, e, cs = 1, rs = 1] of anchors) {
    cells[r][c] = { text, colSpan: cs, rowSpan: rs }
    CELL_EDGES.set(cells[r][c], e)
  }
  return { rows, cols, cells, hasHeader: rows > 1 }
}
const BOXED: Edges = { t: true, b: true, l: true, r: true }
const lines = (cell: IRCell, spec: Array<[number, number, number]>): void =>
  recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 10, h: 10 })))

describe("쪽 잇기 — 복사·이은 칸에 보이는 변을 옮긴다", () => {
  it("joinSplitParts: 놓은 칸은 변을 그대로, 아무도 안 덮은 채움 자리는 자기 테두리 없는 칸", () => {
    // 앞 조각 끝 행 "기타" 가 두 열을 덮는데 뒤 조각 첫 행은 왼쪽 열만 비어 세로 병합을 잇지 못한다 — 그 자리는 채움 칸으로 남는다
    const prev = grid(2, 3, [[0, 0, "구분", BOXED], [0, 1, "내용", BOXED], [0, 2, "비고", BOXED], [1, 0, "기타", { ...BOXED, b: false }, 2], [1, 2, "가", BOXED]])
    const curr = grid(2, 3, [[0, 0, "", NO_EDGES], [0, 1, "나", BOXED], [0, 2, "다", BOXED], [1, 0, "라", BOXED], [1, 1, "마", BOXED], [1, 2, "바", BOXED]])
    FILLER_CELLS.add(curr.cells[0][0])
    const res = joinSplitParts(prev, [0, 100, 200, 300], curr, [0, 100, 200, 300])
    assert.ok(res)
    const t = res.table
    assert.equal(t.rows, 4)
    assert.notEqual(t.cells[1][0], prev.cells[1][0], "복사한 칸")
    assert.deepEqual(CELL_EDGES.get(t.cells[1][0]), { ...BOXED, b: false })
    assert.deepEqual(CELL_EDGES.get(t.cells[2][1]), BOXED)
    assert.ok(FILLER_CELLS.has(t.cells[2][0]))
    assert.deepEqual(CELL_EDGES.get(t.cells[2][0]), NO_EDGES)
  })

  it("쪼개진 행을 합치면 윗변은 위 조각, 밑변은 아래 조각 — 쪽 경계 쪽 변은 버린다", () => {
    const H: Edges = { t: false, b: false, l: false, r: false }
    const prev = grid(2, 2, [[0, 0, "제1조", H], [0, 1, "목적", H], [1, 0, "제2조", { t: true, b: false, l: false, r: false }], [1, 1, "이 규정은 행정기관의 업무를", { t: true, b: true, l: false, r: true }]])
    const curr = grid(1, 2, [[0, 0, "", H], [0, 1, "효율적으로 처리하기 위하여 정한다.", { t: true, b: true, l: true, r: false }]])
    FILLER_CELLS.add(curr.cells[0][0])
    lines(prev.cells[1][1], [[105, 295, 60], [105, 295, 45]])
    lines(curr.cells[0][1], [[105, 295, 780], [105, 200, 765]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 2)
    assert.deepEqual(CELL_EDGES.get(res.table.cells[1][1]), { t: true, b: true, l: true, r: true })
  })

  it("mergeContinuedCells: 앞 쪽 칸에 붙인 1칸 조각의 밑변을 가져온다", () => {
    const prev = grid(1, 1, [[0, 0, "앞 쪽 글", { t: true, b: false, l: false, r: false }]])
    CLIP_TABLES.add(prev)
    TABLE_COLXS.set(prev, [50, 500])
    const part = grid(1, 1, [[0, 0, "뒤 쪽 글", { t: false, b: true, l: false, r: false }]])
    CLIP_TABLES.add(part)
    CONT_PARTS.set(part, { x1: 50, x2: 500 })
    const blocks: IRBlock[] = [{ type: "table", table: prev, pageNumber: 1 }, { type: "table", table: part, pageNumber: 2 }]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(prev.cells[0][0].text, "앞 쪽 글\n뒤 쪽 글")
    assert.deepEqual(CELL_EDGES.get(prev.cells[0][0]), { t: true, b: true, l: false, r: false })
  })

  it("joinCellEdges: 한쪽이라도 곁정보가 없으면 그대로 둔다", () => {
    const a: IRCell = { text: "a", colSpan: 1, rowSpan: 1 }, b: IRCell = { text: "b", colSpan: 1, rowSpan: 1 }
    joinCellEdges(a, b)
    assert.ok(!CELL_EDGES.has(a))
    CELL_EDGES.set(a, NO_EDGES)
    joinCellEdges(a, b)
    assert.deepEqual(CELL_EDGES.get(a), NO_EDGES)
  })
})
