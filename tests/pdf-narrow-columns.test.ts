/**
 * 좁은 열 무리 — 선 격자의 15pt 미만 열은 이웃과 합치되, 20pt 안 열이 다섯 넘게 이어진 무리(점수표 한 자리 숫자 열 14~17pt)는
 * 12pt 까지 열로 둔다. 홀로 좁은 열·OCR 래스터 괘선(조직도 상자 변)은 종전대로 합친다 (table-grid enforceMinWidth).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTableGrids } from "../src/pdf/table-grid.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })

describe("좁은 열 무리", () => {
  // 넓은 첫 열(100pt) + 14pt 열 여섯 (평가 기준 별표2 "참여업체수에 따른 배분업체수")
  const xs = [50, 150, 164, 178, 192, 206, 220, 234]
  const horizontals = [100, 120, 140].map(y => h(y, xs[0], xs[xs.length - 1]))
  const verticals = xs.map(x => v(x, 100, 140))

  it("텍스트층 벡터 괘선의 좁은 열 무리는 열마다 선다", () => {
    const grid = buildTableGrids(horizontals, verticals)[0]
    assert.equal(grid.colXs.length - 1, 7)
  })

  it("OCR 래스터 괘선은 종전대로 15pt 미만 열을 합친다", () => {
    const grid = buildTableGrids(horizontals, verticals, false)[0]
    assert.ok(grid.colXs.length - 1 < 7, JSON.stringify(grid.colXs))
  })

  it("홀로 좁은 열은 합친다", () => {
    const lone = [50, 150, 164, 300]
    const grid = buildTableGrids([100, 120, 140].map(y => h(y, 50, 300)), lone.map(x => v(x, 100, 140)))[0]
    assert.equal(grid.colXs.length - 1, 2)
  })
})
