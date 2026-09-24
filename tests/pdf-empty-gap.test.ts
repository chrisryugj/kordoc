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

  it("한 축의 양끝 괘선만으로는 셀 간격을 빈 열로 승격하지 않는다", () => {
    const c = [[695.6, 729.4], [662.04, 695.6]].flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1, "한 표로 묶는다")
    assert.equal(grids[0].colXs.length - 1, 3, "내용 열 셋을 유지한다")
    assert.equal(grids[0].rowYs.length - 1, 2)
  })

  it("같은 양끝 괘선 틈이 여러 행에 걸쳐 반복되면 빈 열을 보존한다", () => {
    const ys = Array.from({ length: 6 }, (_, i) => [700 - i * 30, 730 - i * 30])
    const c = ys.flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 6)
    assert.equal(grids[0].colXs.length - 1, 5)
  })

  it("세로 틈도 같은 폭이면 셀 간격 표 — 종전대로 닫아 세 열", () => {
    const c = [[698.35, 729.4], [662.04, 695.6]].flatMap(([y1, y2]) => xs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].colXs.length - 1, 3)
  })

  it("세로 한 축의 개별 상자 사이 간격도 빈 행으로 승격하지 않는다", () => {
    const c = [[100, 130], [67.25, 97.25], [34.5, 64.5]].map(([y1, y2]) => ({ x1: 50, x2: 150, y1, y2 }))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].rowYs.length - 1, 3)
  })

  it("빈 칸 자체의 클립이 있으면 좁은 빈 열도 보존한다", () => {
    const fullXs = [[59.49, 195.5], [195.5, 200.5], [200.5, 456], [456, 461], [461, 535.39]]
    const c = [[695.6, 729.4], [662.04, 695.6]].flatMap(([y1, y2]) => fullXs.map(([x1, x2]) => ({ x1, y1, x2, y2 })))
    const { hs, vs } = boxRules(c)
    const { grids } = buildClipCellGrids(c, hs, vs, 595, 841)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].colXs.length - 1, 5)
  })
})
