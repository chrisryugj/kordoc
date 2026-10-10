/**
 * 걸쳐 겹친 글상자 — 서로 품지 않고 안쪽이 겹친 닫힌 사각형들은 표 격자가 아니다(책 소개 쪽 글상자 다섯이 9×4 표로 짜였다).
 * 표의 칸·행 띠 사각형은 맞닿거나 품을 뿐 걸치지 않는다 (crossing-frames)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hasCrossingFrames } from "../src/pdf/crossing-frames.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"

const h = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.4 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.4 })
const box = (x1: number, y1: number, x2: number, y2: number): [LineSegment[], LineSegment[]] => [[h(x1, x2, y1), h(x1, x2, y2)], [v(x1, y1, y2), v(x2, y1, y2)]]
const grid = (x1: number, y1: number, x2: number, y2: number): TableGrid => ({ rowYs: [y2, y1], colXs: [x1, x2], bbox: { x1, y1, x2, y2 }, vertexRadius: 2 })

describe("hasCrossingFrames", () => {
  it("엇갈려 겹친 두 글상자는 걸침이다 (BookReview 53~331×519~713 · 293~537×502~636)", () => {
    const [h1, v1] = box(53, 519, 331, 713), [h2, v2] = box(293, 502, 537, 636)
    assert.equal(hasCrossingFrames(grid(53, 502, 537, 713), [...h1, ...h2], [...v1, ...v2]), true)
  })
  it("행·열 격자 표와 품은 상자는 걸침이 아니다", () => {
    // 3행 2열 표: 가로선 넷이 온 폭, 세로선 셋이 온 높이
    const hs = [100, 120, 140, 160].map(y => h(50, 250, y)), vs = [50, 150, 250].map(x => v(x, 100, 160))
    assert.equal(hasCrossingFrames(grid(50, 100, 250, 160), hs, vs), false)
    const [ho, vo] = box(50, 100, 300, 300), [hi, vi] = box(80, 150, 200, 250)
    assert.equal(hasCrossingFrames(grid(50, 100, 300, 300), [...ho, ...hi], [...vo, ...vi]), false)
  })
})
