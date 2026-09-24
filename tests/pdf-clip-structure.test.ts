/**
 * PDF 칸 클립 표 구조 — 걸친 그림, 괘선 그어진 틈(셀 간격), 쪽을 넘는 칸 (읽기 품질 2차).
 *
 * 한컴 PDF 1.3 실측을 합성 좌표로 옮겼다: 복학원서 워터마크·결재문서 결문표 덮개(걸침), 결재문서 문서번호 표(아래 여백만큼
 * 짧은 칸 클립), 행정업무운영 편람 설계 기준 표(셀 간격), 경사형 휠체어리프트 기준(47쪽 넘는 본문 칸).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { buildClipCellGrids } from "../src/pdf/clip-cells.js"
import { extractPageBlocksWithLines, type PageCarry } from "../src/pdf/page-blocks.js"
import { mergeContinuedCells } from "../src/pdf/cell-continuation.js"
import { CLIP_TABLES, CONT_PARTS, EMPTY_PARTS, TABLE_COLXS } from "../src/pdf/table-meta.js"
import type { IRBlock, IRTable } from "../src/types.js"
import type { LineSegment } from "../src/pdf/line-types.js"
import type { NormItem } from "../src/pdf/text-line.js"

type Rect = { x1: number; y1: number; x2: number; y2: number }
const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.36 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.36 })

describe("buildClipCellGrids — 표 위에 걸친 그림·글상자는 부모가 못 된다", () => {
  it("좌표 버킷 경계를 넘는 반복 클립도 한 칸으로 센다", () => {
    const left = { x1: 59.9, y1: 100.1, x2: 100, y2: 130 }
    const repeated = { x1: 61.1, y1: 101.3, x2: 101.2, y2: 131.2 }
    const right = { x1: 100, y1: 100.1, x2: 150, y2: 130 }
    const { grids } = buildClipCellGrids([left, repeated, right], [], [], 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].cells?.filter(c => !c.filler).length, 2)
    assert.equal(grids[0].colXs.length - 1, 2)
  })

  it("0.1pt 떨어진 공유 변은 같은 표로 잇고 0.3pt 틈은 가른다", () => {
    const left = { x1: 60, y1: 100, x2: 100, y2: 130 }
    const near = { x1: 100.1, y1: 100, x2: 150, y2: 130 }
    const far = { ...near, x1: 100.3 }
    assert.equal(buildClipCellGrids([left, near], [], [], 595, 841).grids.length, 1)
    assert.equal(buildClipCellGrids([left, far], [], [], 595, 841).grids.length, 0, "단독 클립 둘은 표가 아니다")
  })

  it("워터마크가 서명란 가운데 두 열만 품어도 4×4 한 표 (복학원서)", () => {
    const xs = [63.69, 130.97, 434.17, 450.84, 536.83], ys = [407.79, 377.11, 361.52, 344.86, 328.2]
    const cells: Rect[] = []
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) cells.push({ x1: xs[c], y1: ys[r + 1], x2: xs[c + 1], y2: ys[r] })
    const watermark = { x1: 111.66, y1: 258.68, x2: 482.74, y2: 630.03 } // 가운데 두 열은 품고 양끝 열에는 걸친다
    const { grids } = buildClipCellGrids([watermark, ...cells], [], [], 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 4)
    assert.equal(grids[0].colXs.length - 1, 4)
    assert.ok(!grids[0].clipParent, "워터마크를 틀로 삼지 않는다")
  })

  it("결문표 아래 10행을 덮은 빈 1칸 표(발신명의 행 중간까지)가 표를 가르지 않는다", () => {
    const frame = { x1: 56.61, y1: 14.14, x2: 555.3, y2: 281.81 }
    const cover = { x1: 56.61, y1: 14.14, x2: 555.3, y2: 199.46 } // 발신명의 행(178.72~207.49) 중간에서 끝남
    const rows = [
      { x1: 58.41, y1: 207.49, x2: 553.38, y2: 247.89 },
      { x1: 58.41, y1: 178.72, x2: 106.86, y2: 207.49 }, { x1: 106.86, y1: 178.72, x2: 553.38, y2: 207.49 },
      { x1: 58.41, y1: 167.22, x2: 553.38, y2: 178.72 },
      { x1: 58.41, y1: 145.28, x2: 553.38, y2: 167.22 },
    ]
    const { grids } = buildClipCellGrids([frame, cover, ...rows], [], [], 595, 841)
    const g = grids.find(x => x.cells!.length >= 5)!
    assert.ok(g, "다섯 칸이 한 표")
    assert.equal(g.rowYs.length - 1, 4)
  })

  it("칸 폭을 조금(5.9pt) 넘친 안쪽 칩은 걸침이 아니다 — 두 칸은 부모 자격을 지키고 칩이 따로 표로 빠지지 않는다", () => {
    const left = { x1: 58.08, y1: 255.71, x2: 286.3, y2: 501.31 }, right = { x1: 286.3, y1: 255.71, x2: 551.31, y2: 501.31 }
    const chipL = { x1: 64.57, y1: 445.58, x2: 114.37, y2: 469.31 }, chipR = { x1: 114.37, y1: 445.58, x2: 292.22, y2: 469.31 }
    const { grids } = buildClipCellGrids([left, chipL, chipR, right], [], [], 595, 841)
    assert.equal(grids.length, 1, "종전처럼 1×2 표 하나 — 칩 1×2 가 최상위 표로 새지 않는다")
    assert.equal(grids[0].colXs.length - 1, 2)
  })
})

describe("buildClipCellGrids — 괘선 그어진 틈을 사이에 둔 칸 (셀 간격·짧은 칸 클립)", () => {
  // 결재문서 문서번호 표: 행 사이 1.44·1.32pt 틈, 틈 아래 끝에 행 괘선
  const doc = [
    { x1: 53.85, y1: 706.99, x2: 100.27, y2: 724.73 }, { x1: 100.27, y1: 706.99, x2: 223.2, y2: 724.73 },
    { x1: 53.85, y1: 687.81, x2: 100.27, y2: 705.55 }, { x1: 100.27, y1: 687.81, x2: 223.2, y2: 705.55 },
    { x1: 53.85, y1: 670.19, x2: 100.27, y2: 686.49 }, { x1: 100.27, y1: 670.19, x2: 223.2, y2: 686.49 },
  ]
  const rules = [h(705.55, 53.37, 223.8), h(686.49, 53.37, 223.8)]

  it("틈 안에 괘선이 있으면 한 표 — 행마다 1×2 로 흩어지지 않는다", () => {
    const { grids } = buildClipCellGrids(doc, rules, [v(53.85, 645, 725), v(100.27, 645, 725), v(223.2, 645, 725)], 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 3)
    assert.equal(grids[0].colXs.length - 1, 2)
  })

  it("괘선 없는 틈(칸 안 글줄 클립)은 종전대로 가른다", () => {
    const { grids } = buildClipCellGrids(doc, [], [], 595, 841)
    assert.equal(grids.length, 3, "행마다 따로")
  })

  it("틈에 다른 클립(높이 2.76pt 빈 행)이 있으면 틈이 아니라 행이다 (신구조문대비표)", () => {
    const t = [
      { x1: 73.76, y1: 695.96, x2: 297.56, y2: 720.17 }, { x1: 297.56, y1: 695.96, x2: 521.36, y2: 720.17 },
      { x1: 73.76, y1: 693.2, x2: 297.56, y2: 695.96 }, { x1: 297.56, y1: 693.2, x2: 521.36, y2: 695.96 },
      { x1: 73.76, y1: 290.32, x2: 297.56, y2: 693.2 }, { x1: 297.56, y1: 290.32, x2: 521.36, y2: 693.2 },
    ]
    const { grids } = buildClipCellGrids(t, [h(695.96, 73.64, 521.6)], [], 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 3, "빈 행 유지")
  })

  it("셀 간격 표 — 병합 칸도 같은 틈 가운데로 옮겨 유령 열이 없다 (관인 종류 표)", () => {
    // 3열, 첫 열 둘째 칸은 오른쪽 두 행에 걸친 병합 칸. 칸마다 제 테두리(틈 양끝에 괘선)
    const c = [
      { x1: 76.12, y1: 540.9, x2: 154.4, y2: 559.38 }, { x1: 156.92, y1: 540.9, x2: 323.06, y2: 559.38 }, { x1: 325.58, y1: 540.9, x2: 469.07, y2: 559.38 },
      { x1: 76.12, y1: 470.59, x2: 154.4, y2: 538.26 },
      { x1: 156.92, y1: 505.74, x2: 323.06, y2: 538.26 }, { x1: 325.58, y1: 505.74, x2: 469.07, y2: 538.26 },
      { x1: 156.92, y1: 470.59, x2: 323.06, y2: 503.1 }, { x1: 325.58, y1: 470.59, x2: 469.07, y2: 503.1 },
    ]
    const hs: LineSegment[] = [], vs: LineSegment[] = []
    for (const r of c) { hs.push(h(r.y1, r.x1, r.x2), h(r.y2, r.x1, r.x2)); vs.push(v(r.x1, r.y1, r.y2), v(r.x2, r.y1, r.y2)) }
    const { grids } = buildClipCellGrids(c, hs, vs, 555, 754)
    assert.equal(grids.length, 1)
    const g = grids[0]
    assert.equal(g.colXs.length - 1, 3, "열 3개 — 틈 가장자리 유령 열 없음")
    assert.equal(g.rowYs.length - 1, 3)
    const merged = g.cells!.find(x => x.col === 0 && x.row === 1)!
    assert.equal(merged.rowSpan, 2, "병합 칸은 두 행에 걸친다")
  })

  /** 칸마다 제 테두리(네 변 획)를 그린 셀 간격 표용 괘선 */
  const boxRules = (cs: Rect[], vertical = true): { hs: LineSegment[]; vs: LineSegment[] } => ({
    hs: cs.flatMap(r => [h(r.y1, r.x1, r.x2), h(r.y2, r.x1, r.x2)]),
    vs: vertical ? cs.flatMap(r => [v(r.x1, r.y1, r.y2), v(r.x2, r.y1, r.y2)]) : [],
  })

  it("머리 칸 아래 여러 칸(직각 변 한쪽만 맞음)도 같은 틈 폭이면 한 표 — 정책연구 주체별 역할 표 6×4", () => {
    const c = [
      { x1: 87.51, y1: 583.62, x2: 140.13, y2: 623.09 }, { x1: 142.65, y1: 604.61, x2: 482.38, y2: 623.09 },
      { x1: 142.65, y1: 583.62, x2: 254.14, y2: 602.09 }, { x1: 256.77, y1: 583.62, x2: 368.26, y2: 602.09 }, { x1: 370.78, y1: 583.62, x2: 482.38, y2: 602.09 },
      { x1: 87.51, y1: 529.38, x2: 140.13, y2: 580.98 }, { x1: 142.65, y1: 529.38, x2: 254.14, y2: 580.98 }, { x1: 256.77, y1: 529.38, x2: 368.26, y2: 580.98 }, { x1: 370.78, y1: 529.38, x2: 482.38, y2: 580.98 },
    ]
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 555, 754)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 3)
    assert.equal(grids[0].colXs.length - 1, 4)
    const head = grids[0].cells!.find(x => x.row === 0 && x.col === 1)!
    assert.equal(head.colSpan, 3, "주체별 역할 머리 칸은 세 열에 걸친다")
  })

  it("세로 테두리를 안 그린 셀 간격 표 — 가로 틈 폭이 확인된 세로 틈 폭과 같으면 열끼리 잇는다 (응시번호 3×4)", () => {
    const xs = [[102.37, 153.92], [156.44, 207.98], [210.5, 276.43], [278.95, 466.32]], ys = [[139.9, 154.54], [123.46, 137.26], [107.14, 120.94]]
    const c = ys.flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs } = boxRules(c, false)
    const { grids } = buildClipCellGrids(c, hs, [], 555, 754)
    assert.equal(grids.length, 1, "열마다 3×1 로 갈리지 않는다")
    assert.equal(grids[0].rowYs.length - 1, 3)
    assert.equal(grids[0].colXs.length - 1, 4)
  })

  it("쪽 넘김으로 왼쪽 칸 클립이 없는 행도 같은 열 경계 — 유령 열 없음 (설계 기준 표 5×2)", () => {
    const c = [
      { x1: 86.07, y1: 618.29, x2: 150.56, y2: 639.53 }, { x1: 153.2, y1: 618.29, x2: 482.26, y2: 639.53 },
      { x1: 153.2, y1: 534.78, x2: 482.26, y2: 615.77 }, // 왼쪽 칸 없음
      { x1: 86.07, y1: 274.64, x2: 150.56, y2: 532.26 }, { x1: 153.2, y1: 274.64, x2: 482.26, y2: 532.26 },
    ]
    const { hs, vs } = boxRules(c)
    const g = buildClipCellGrids(c, hs, vs, 555, 754).grids
    assert.equal(g.length, 1)
    assert.equal(g[0].colXs.length - 1, 2)
    assert.equal(g[0].rowYs.length - 1, 3)
  })

  it("한 열에서만 아래 칸이 짧게 떠 있으면 다른 열이 맞닿은 경계로 닫는다 — 유령 행 없음 (조직도 하단)", () => {
    const c = [
      { x1: 100, y1: 394.61, x2: 150, y2: 497.94 }, { x1: 150, y1: 394.61, x2: 200, y2: 497.94 },
      { x1: 100, y1: 390.77, x2: 150, y2: 394.61 }, // 맞닿음
      { x1: 150, y1: 390.77, x2: 200, y2: 393.53 }, // 1.08pt 틈
    ]
    const { grids } = buildClipCellGrids(c, [h(394.61, 100, 200), h(393.53, 150, 200)], [], 595, 841)
    assert.equal(grids.length, 1)
    assert.deepEqual(grids[0].rowYs.map(y => +y.toFixed(2)), [497.94, 394.61, 390.77])
  })

  it("틈 폭이 다른 두 표(3pt 아래 다른 표, 직각 변 한쪽만 맞음)는 잇지 않는다 (조직도 mel-001)", () => {
    const upper = [{ x1: 56.61, y1: 543.13, x2: 82.64, y2: 588.08 }, { x1: 85.51, y1: 543.13, x2: 111.54, y2: 588.08 }] // 2.87pt 가로 틈
    const lower = [{ x1: 56.61, y1: 536.29, x2: 76.4, y2: 540.13 }, { x1: 76.4, y1: 536.29, x2: 99.07, y2: 540.13 }]
    const rules = boxRules(upper)
    const { grids } = buildClipCellGrids([...upper, ...lower], rules.hs, rules.vs, 595, 841)
    assert.equal(grids.length, 2)
  })
})

describe("쪽을 넘는 칸 — 앞 쪽 마지막 칸의 이어짐 (clip-cells continues·lastCells)", () => {
  const giant = { x1: 58.05, y1: 49.27, x2: 536.83, y2: 696.32 }
  const head = [{ x1: 58.05, y1: 746.18, x2: 536.83, y2: 782.98 }, { x1: 58.05, y1: 696.32, x2: 536.83, y2: 746.18 }]

  it("앞 쪽 마지막 내용인 칸을 lastCells 로 낸다 — 아래엔 쪽번호(꼬리말 띠)뿐", () => {
    const r = buildClipCellGrids([...head, giant], [], [], 595, 841, [{ x: 300, y: 400 }, { x: 297, y: 30 }])
    assert.deepEqual(r.page.lastCells, [giant])
    // 표 아래 본문 글이 있으면 마지막 내용이 아니다
    const short = { ...giant, y1: 200 }
    assert.deepEqual(buildClipCellGrids([...head, short], [], [], 595, 841, [{ x: 300, y: 150 }]).page.lastCells, [])
  })

  it("다음 쪽 첫 내용인 홀로 선 클립(좌우 변 같음)은 이어짐 1칸 조각 — 그 안 표는 이 조각에 든다", () => {
    const cont = { x1: 58.05, y1: 45.07, x2: 536.83, y2: 782.98 }
    const inner = [{ x1: 88.15, y1: 726.76, x2: 227.64, y2: 753.98 }, { x1: 227.64, y1: 726.76, x2: 367.12, y2: 753.98 }]
    const { grids } = buildClipCellGrids([cont, ...inner], [], [], 595, 841, [{ x: 300, y: 500 }], [], { lastCells: [giant], clips: [] })
    const part = grids.find(g => g.continues)!
    assert.ok(part, "획 없는 홀로 선 클립이지만 이어짐이라 1칸 조각")
    assert.deepEqual(part.continues, giant)
    const t = grids.find(g => g.cells!.length === 2)!
    assert.deepEqual(t.clipParent, cont, "안쪽 표는 조각 칸에 든다")
    // 앞 쪽 칸 정보가 없으면 종전대로 표가 아니다
    assert.equal(buildClipCellGrids([cont, ...inner], [], [], 595, 841, [{ x: 300, y: 500 }]).grids.filter(g => g.cells!.length === 1).length, 0)
  })

  it("쪽 첫머리에 글이 있으면(서식 번호 \"(서식 5)\") 이어짐이 아니다", () => {
    const next = { x1: 58.05, y1: 59.09, x2: 536.83, y2: 749.66 }
    const r = buildClipCellGrids([next, { x1: 70, y1: 100, x2: 300, y2: 120 }], [], [], 595, 841, [{ x: 70, y: 766 }, { x: 300, y: 400 }], [], { lastCells: [giant], clips: [] })
    assert.ok(!r.grids.some(g => g.continues))
  })

  it("좌우 변이 0.1pt 넘게 다르면 다른 상자다 (\"5 | 시험 방법\" 머리 상자 0.12pt)", () => {
    const next = { x1: 58.05, y1: 400, x2: 536.95, y2: 782.98 }
    const r = buildClipCellGrids([next, { x1: 70, y1: 500, x2: 300, y2: 520 }], [], [], 595, 841, [], [], { lastCells: [giant], clips: [] })
    assert.ok(!r.grids.some(g => g.continues))
  })

  it("본문 영역 클립(좌우 변 같은 클립에 싸인 칸)은 lastCells 에서 뺀다 — 다음 쪽 본문 영역이 쪽을 통째 삼키지 않게", () => {
    const body = { x1: 58.05, y1: 90.74, x2: 533.95, y2: 768.84 }
    const t = [{ x1: 58.05, y1: 120, x2: 533.95, y2: 200 }, { x1: 58.05, y1: 90.74, x2: 533.95, y2: 120 }]
    assert.deepEqual(buildClipCellGrids([body, ...t], [], [], 595, 841, []).page.lastCells, [])
  })
})

describe("mergeContinuedCells — 이어짐 조각을 앞 쪽 표 그 칸에 붙인다", () => {
  const cell = (text: string, extra: Partial<IRTable["cells"][0][0]> = {}) => ({ text, colSpan: 1, rowSpan: 1, ...extra })
  const clipTable = (cells: IRTable["cells"], colXs: number[]): IRTable => {
    const t: IRTable = { rows: cells.length, cols: cells[0].length, cells, hasHeader: false }
    TABLE_COLXS.set(t, colXs)
    CLIP_TABLES.add(t)
    return t
  }
  const part = (c: IRTable["cells"][0][0], from: { x1: number; x2: number }, page: number): IRBlock => {
    const t = clipTable([[c]], [from.x1, from.x2])
    CONT_PARTS.set(t, from)
    return { type: "table", table: t, pageNumber: page, bbox: { page, x: from.x1, y: 40, width: from.x2 - from.x1, height: 700 } }
  }

  it("쪽 경계의 중첩표 빈 마지막 칸에 1칸 이어짐을 채워 유령 행을 만들지 않는다", () => {
    const nested = clipTable([[cell("머리1"), cell("머리2")], [cell("", { colSpan: 2 }), cell("")]], [88, 227, 367])
    const fragment = clipTable([[cell("비고: 육안시험 조건")]], [88, 367])
    const outer = clipTable([[cell("", { blocks: [{ type: "table", table: nested, pageNumber: 1 }] })]], [58, 536])
    const blocks: IRBlock[] = [
      { type: "table", table: outer, pageNumber: 1 },
      part(cell("", { blocks: [{ type: "table", table: fragment, pageNumber: 2 }] }), { x1: 58, x2: 536 }, 2),
    ]
    mergeContinuedCells(blocks)
    const inner = outer.cells[0][0].blocks!
    assert.equal(inner.length, 1)
    assert.equal(inner[0].table!.rows, 2)
    assert.equal(inner[0].table!.cells[1][0].text, "비고: 육안시험 조건")
  })

  it("내용 있는 중첩표 마지막 칸은 다음 쪽 1칸 상자로 덮어쓰지 않는다", () => {
    const nested = clipTable([[cell("머리1"), cell("머리2")], [cell("앞 쪽 별도 설명", { colSpan: 2 }), cell("")]], [88, 227, 367])
    const fragment = clipTable([[cell("비고: 육안시험 조건")]], [88, 367])
    const outer = clipTable([[cell("", { blocks: [{ type: "table", table: nested, pageNumber: 1 }] })]], [58, 536])
    const blocks: IRBlock[] = [
      { type: "table", table: outer, pageNumber: 1 },
      part(cell("", { blocks: [{ type: "table", table: fragment, pageNumber: 2 }] }), { x1: 58, x2: 536 }, 2),
    ]
    mergeContinuedCells(blocks)
    const inner = outer.cells[0][0].blocks!
    assert.equal(inner.length, 2)
    assert.equal(inner[0].table!.rows, 2)
    assert.equal(inner[0].table!.cells[1][0].text, "앞 쪽 별도 설명")
  })

  it("다음 쪽 감싸개 안의 중첩표 본문을 앞 쪽 머리 행과 잇는다", () => {
    const head = clipTable([[cell("구분"), cell("‘16"), cell("‘17")]], [88, 188, 288, 388])
    const body = clipTable([[cell("주거용건물"), cell("88.27"), cell("92.02")], [cell("상승률"), cell("4.3"), cell("4.2")]], [88, 188, 288, 388])
    const header: IRBlock = { type: "table", table: head, pageNumber: 27, bbox: { page: 27, x: 88, y: 60, width: 300, height: 20 } }
    const content: IRBlock = { type: "table", table: body, pageNumber: 28, bbox: { page: 28, x: 88, y: 690, width: 300, height: 90 } }
    const wrapper = clipTable([[cell("주거용건물\n자료출처", { blocks: [content, { type: "paragraph", text: "자료출처", pageNumber: 28 }] })]], [80, 400])
    const outer = clipTable([[cell("근거설명", { blocks: [header] })]], [58, 536])
    const blocks: IRBlock[] = [
      { type: "table", table: outer, pageNumber: 27 },
      part(cell("주거용건물\n자료출처", { blocks: [{ type: "table", table: wrapper, pageNumber: 28, bbox: { page: 28, x: 80, y: 460, width: 320, height: 320 } }] }), { x1: 58, x2: 536 }, 28),
    ]
    mergeContinuedCells(blocks, new Map([[27, 841], [28, 841]]))
    const inner = outer.cells[0][0].blocks!
    assert.equal(inner[0].table?.rows, 3)
    assert.deepEqual(inner[0].table?.cells.map(r => r[0].text), ["구분", "주거용건물", "상승률"])
    assert.equal(inner[1].text, "자료출처")
  })

  it("다음 쪽 감싸개 안의 열 경계가 다르면 별도 표로 둔다", () => {
    const head = clipTable([[cell("구분"), cell("연도")]], [88, 188, 388])
    const body = clipTable([[cell("별도"), cell("값")], [cell("새 표"), cell("1")]], [100, 200, 400])
    const header: IRBlock = { type: "table", table: head, pageNumber: 27, bbox: { page: 27, x: 88, y: 60, width: 300, height: 20 } }
    const content: IRBlock = { type: "table", table: body, pageNumber: 28, bbox: { page: 28, x: 100, y: 690, width: 300, height: 90 } }
    const wrapper = clipTable([[cell("별도 표", { blocks: [content] })]], [80, 420])
    const outer = clipTable([[cell("근거설명", { blocks: [header] })]], [58, 536])
    const blocks: IRBlock[] = [
      { type: "table", table: outer, pageNumber: 27 },
      part(cell("별도 표", { blocks: [{ type: "table", table: wrapper, pageNumber: 28, bbox: { page: 28, x: 80, y: 460, width: 340, height: 320 } }] }), { x1: 58, x2: 536 }, 28),
    ]
    mergeContinuedCells(blocks, new Map([[27, 841], [28, 841]]))
    assert.equal(outer.cells[0][0].blocks?.length, 2)
    assert.equal(outer.cells[0][0].blocks?.[0].table?.rows, 1)
    assert.equal(outer.cells[0][0].blocks?.[1].table?.rows, 1, "감싸개를 보존한다")
  })

  it("세 쪽 조각이 한 칸에 모이고 칸 안 표도 제자리 (5×1 거대 칸)", () => {
    const nested: IRBlock = { type: "table", table: clipTable([[cell("공칭회로전압"), cell("시험전압")], [cell("SELV"), cell("250V")]], [88, 227, 367]), pageNumber: 2 }
    const t = clipTable([[cell("[별표27]")], [cell("1 적용범위")]], [58.05, 536.83])
    const blocks: IRBlock[] = [
      { type: "table", table: t, pageNumber: 1, bbox: { page: 1, x: 58, y: 49, width: 478, height: 733 } },
      { type: "paragraph", text: "- 1 -", pageNumber: 1 },
      part(cell("3.7 구동방식", { blocks: [{ type: "paragraph", text: "3.7 구동방식", pageNumber: 2 }, nested] }), { x1: 58.05, x2: 536.83 }, 2),
      part(cell("5.1.7 정격속도"), { x1: 58.05, x2: 536.83 }, 3),
    ]
    mergeContinuedCells(blocks)
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1, "조각은 앞 표에 붙고 빠진다")
    const body = tables[0].table!.cells[1][0]
    assert.equal(tables[0].table!.rows, 2, "행이 늘지 않는다")
    assert.deepEqual(body.blocks!.map(b => b.type === "table" ? "T" : b.text), ["1 적용범위", "3.7 구동방식", "T", "5.1.7 정격속도"])
    assert.equal(body.text, "1 적용범위\n3.7 구동방식\n5.1.7 정격속도")
  })

  it("여러 칸 행에서는 좌우 변이 같은 마지막 행 칸에 붙는다 (근거설명 | 내용)", () => {
    const t = clipTable([[cell("영향집단"), cell("주민")], [cell("근거설명"), cell("ㅇ 편익 수혜자")]], [58.05, 154.6, 533.95])
    const blocks: IRBlock[] = [
      { type: "table", table: t, pageNumber: 27 },
      part(cell("ㅇ 주택가격 상승률"), { x1: 154.6, x2: 533.95 }, 28),
    ]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(t.cells[1][1].text, "ㅇ 편익 수혜자\nㅇ 주택가격 상승률")
    assert.equal(t.cells[1][0].text, "근거설명")
  })

  it("앞 쪽 조각이 빈 칸뿐이던 표도 이어진 글을 받으면 빈 조각 표시를 뗀다 — 쪽 넘김 잇기가 버리지 않게", () => {
    const t = clipTable([[cell("")]], [58, 500])
    EMPTY_PARTS.add(t)
    const blocks: IRBlock[] = [{ type: "table", table: t, pageNumber: 1 }, part(cell("이어진 글"), { x1: 58, x2: 500 }, 2)]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(t.cells[0][0].text, "이어진 글")
    assert.ok(!EMPTY_PARTS.has(t))
  })

  it("앞 표가 바로 앞 쪽이 아니거나 좌우 변이 맞는 칸이 없으면 그대로 둔다", () => {
    const t = clipTable([[cell("a"), cell("b")]], [58, 200, 500])
    const blocks: IRBlock[] = [{ type: "table", table: t, pageNumber: 1 }, part(cell("c"), { x1: 58, x2: 500 }, 2)]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 2)
    const far: IRBlock[] = [{ type: "table", table: clipTable([[cell("a")]], [58, 500]), pageNumber: 1 }, part(cell("c"), { x1: 58, x2: 500 }, 3)]
    mergeContinuedCells(far)
    assert.equal(far.length, 2)
  })
})

describe("extractPageBlocksWithLines + carry — 쪽을 넘는 칸의 표가 칸 안에 남는다", () => {
  const clipOps = (rects: Rect[]) => ({
    fnArray: rects.flatMap(() => [OPS.constructPath, OPS.eoClip, OPS.endPath]),
    argsArray: rects.flatMap(r => [[[OPS.rectangle], [r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1]], [], []] as unknown[][]),
  })
  const item = (text: string, x: number, y: number, w = text.length * 10): NormItem =>
    ({ text, x, y, w, h: 10, fontSize: 10, fontName: "F", isHidden: false })

  it("1쪽 5×1 의 본문 칸이 2쪽으로 넘어가면 2쪽 표는 그 칸의 중첩표", () => {
    const carry: PageCarry = {}
    const p1 = extractPageBlocksWithLines(
      [item("[별표27] 경사형휠체어리프트", 60, 760), item("1 적용범위", 60, 600), item("- 1 -", 290, 30, 20)], 1,
      clipOps([{ x1: 58.05, y1: 746.18, x2: 536.83, y2: 782.98 }, { x1: 58.05, y1: 49.27, x2: 536.83, y2: 746.18 }]), 595, 841, undefined, true, carry)
    assert.equal(carry.page, 1)
    assert.equal(carry.clip?.lastCells.length, 1)
    const p2 = extractPageBlocksWithLines(
      [item("3.7 구동방식", 60, 770), item("공칭회로전압", 95, 735), item("시험전압", 235, 735), item("SELV", 95, 705), item("250V", 235, 705), item("끝 문단", 60, 300), item("- 2 -", 290, 30, 20)], 2,
      clipOps([
        { x1: 58.05, y1: 45.07, x2: 536.83, y2: 782.98 },
        { x1: 88.15, y1: 726.76, x2: 227.64, y2: 753.98 }, { x1: 227.64, y1: 726.76, x2: 367.12, y2: 753.98 },
        { x1: 88.15, y1: 699.43, x2: 227.64, y2: 726.76 }, { x1: 227.64, y1: 699.43, x2: 367.12, y2: 726.76 },
      ]), 595, 841, undefined, true, carry)
    const blocks = [...p1, ...p2]
    mergeContinuedCells(blocks)
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1, "2쪽 표가 최상위로 빠지지 않는다")
    const body = tables[0].table!.cells[1][0]
    const nested = body.blocks!.filter(b => b.type === "table")
    assert.equal(nested.length, 1)
    assert.deepEqual(nested[0].table!.cells[0].map(c => c.text), ["공칭회로전압", "시험전압"])
    assert.ok(body.text.includes("끝 문단"), "조각 글도 칸에 이어 붙는다")
  })
})

describe("쪽 넘김 이어짐 — 쪽마다 같은 자리의 틀 요소는 이어짐이 아니다", () => {
  it("앞 쪽에도 같은 사각형이 있는 절 제목 띠는 앞 쪽 마지막 틀에 붙지 않는다 (공문 작성 안내서 \"[2]\"·\"[3]\" 띠)", () => {
    const band = { x1: 58.08, y1: 731.14, x2: 548.5, y2: 755.46 }
    const frame4 = { x1: 58.08, y1: 66.49, x2: 548.5, y2: 504.87 }
    const prev = { lastCells: [frame4], clips: [band, frame4] }
    const r = buildClipCellGrids([band, { x1: 58.08, y1: 538.88, x2: 548.5, y2: 661.85 }], [], [], 595, 841, [{ x: 300, y: 740 }], [], prev)
    assert.ok(!r.grids.some(g => g.continues))
    // 앞 칸과 같은 사각형(가운데 쪽 이어짐이 같은 자리에서 끊김)은 이어짐 그대로
    const same = { x1: 58.05, y1: 32.84, x2: 536.83, y2: 782.98 }
    const r2 = buildClipCellGrids([same, { x1: 88, y1: 700, x2: 227, y2: 750 }, { x1: 227, y1: 700, x2: 367, y2: 750 }], [], [], 595, 841, [], [], { lastCells: [same], clips: [same] })
    assert.ok(r2.grids.some(g => g.continues))
  })
})

it("칸 안 클립 표도 클립 표 — 쪽을 넘는 칸에 붙은 조각끼리 클립 표 잇기로 잇게 (휠체어리프트 기준 [표 Ⅰ.1])", () => {
  const clipOps = (rects: Rect[]) => ({
    fnArray: rects.flatMap(() => [OPS.constructPath, OPS.eoClip, OPS.endPath]),
    argsArray: rects.flatMap(r => [[[OPS.rectangle], [r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1]], [], []] as unknown[][]),
  })
  const item = (t: string, x: number, y: number): NormItem => ({ text: t, x, y, w: t.length * 10, h: 10, fontSize: 10, fontName: "F", isHidden: false })
  const frame = [{ x1: 58.05, y1: 746.18, x2: 536.83, y2: 782.98 }, { x1: 58.05, y1: 49.27, x2: 536.83, y2: 746.18 }]
  const t = [{ x1: 88.15, y1: 700, x2: 227.64, y2: 730 }, { x1: 227.64, y1: 700, x2: 367.12, y2: 730 }]
  const blocks = extractPageBlocksWithLines([item("머리", 60, 760), item("부품", 95, 710), item("조건", 235, 710), item("본문", 60, 400)], 1,
    clipOps([...frame, ...t]), 595, 841)
  const outer = blocks.find(b => b.type === "table")!.table!
  const nested = outer.cells[1][0].blocks!.find(b => b.type === "table")!.table!
  assert.ok(CLIP_TABLES.has(nested))
  assert.deepEqual(TABLE_COLXS.get(nested)?.map(x => +x.toFixed(2)), [88.15, 227.64, 367.12])
})
