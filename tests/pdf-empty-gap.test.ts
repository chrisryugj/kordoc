import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildClipCellGrids } from "../src/pdf/clip-cells.js"
import type { LineSegment } from "../src/pdf/line-types.js"
type Rect = { x1: number; y1: number; x2: number; y2: number }
const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.36 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.36 })
describe("괘선 틈 — 빈 열 보존과 셀 간격 구분", () => {
  /** 칸마다 제 테두리(네 변 획) */
  const boxRules = (cs: Rect[]): { hs: LineSegment[]; vs: LineSegment[] } => ({
    hs: cs.flatMap(r => [h(r.y1, r.x1, r.x2), h(r.y2, r.x1, r.x2)]),
    vs: cs.flatMap(r => [v(r.x1, r.y1, r.y2), v(r.x2, r.y1, r.y2)]),
  })
  const xs = [[59.49, 195.5], [198.25, 456], [458.75, 535.39]]

  it("한 축으로만 벌어지고 양끝이 칸마다 제 테두리인 2.75pt 틈은 빈 열로 남긴다 (추진과제표 27×5)", () => {
    const c = [[695.6, 729.4], [662.04, 695.6]].flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1, "한 표로 묶는다")
    assert.equal(grids[0].colXs.length - 1, 5, "칸 사이 빈 열 둘까지 다섯 열")
    assert.equal(grids[0].rowYs.length - 1, 2)
    const gap = grids[0].cells!.filter(x => x.col === 1 || x.col === 3)
    assert.ok(gap.length === 4 && gap.every(x => x.filler), "빈 열 칸은 채움 칸")
  })

  it("세로 틈도 같은 폭이면 셀 간격 표 — 종전대로 닫아 세 열", () => {
    const c = [[698.35, 729.4], [662.04, 695.6]].flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].colXs.length - 1, 3)
  })

  // 칸 안 감싸개(테두리 없는 1칸 표): 폭 467pt·윗변 쪽 20% 위·아래와 안에 글 — 제목 아래 틀 기하에 든다
  const wrap = { x1: 63, y1: 450, x2: 530, y2: 770 }
})
