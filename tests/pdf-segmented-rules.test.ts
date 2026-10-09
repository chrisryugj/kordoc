/**
 * 줄마다 끊어 그린 괘선 — 같은 x(y) 토막들의 합집합이 칸 높이(폭)의 75% 를 덮으면 칸 경계다(고산군 세입예산서 상세 칸).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractCells } from "../src/pdf/cell-extract.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"

const seg = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ x1, y1, x2, y2, lineWidth: 0.5 })

describe("토막 괘선 칸 경계", () => {
  // 머리 행(600~500) 아래 상세 행(500~40) — 안쪽 세로 괘선 셋이 상세 행에서 20pt 토막 23개로 끊겨 그려졌다
  const colXs = [40, 330, 410, 490, 550], rowYs = [600, 500, 40]
  const grid: TableGrid = { rowYs, colXs, bbox: { x1: 40, y1: 40, x2: 550, y2: 600 }, vertexRadius: 1 }
  const horizontals = rowYs.map(y => seg(40, y, 550, y))
  const verticals = [
    seg(40, 40, 40, 600), seg(550, 40, 550, 600),
    ...[330, 410, 490].flatMap(x => [seg(x, 500, x, 600), ...Array.from({ length: 23 }, (_, k) => seg(x, 40 + k * 20, x, 60 + k * 20))]),
  ]

  it("토막들이 칸 높이를 덮으면 열 경계 — 상세 행이 네 칸", () => {
    const cells = extractCells(grid, horizontals, verticals)
    assert.deepEqual(cells.filter(c => c.row === 1).map(c => c.colSpan), [1, 1, 1, 1])
  })

  it("토막으로만 선 오른쪽 경계는 토막이 끊긴 아래 행까지 칸을 늘리지 않는다 (고흥 세출예산서 위계 선)", () => {
    // 위계 선 x=76 이 긴 행(688~610)엔 토막 셋으로 그려지고 부모 행(610~595, 글이 가로지름)엔 없다. 610 가로선은 67.8 에서 시작해
    // 좁은 위계 칸(59~76) 폭의 절반만 덮는다
    const colXs = [42, 59, 76, 292, 552], rowYs = [722, 688, 610, 595, 579]
    const g: TableGrid = { rowYs, colXs, bbox: { x1: 42, y1: 579, x2: 552, y2: 722 }, vertexRadius: 1 }
    const hs = [seg(42, 722, 552, 722), seg(42, 688, 552, 688), seg(67.8, 610, 552, 610), seg(42, 595, 552, 595), seg(42, 579, 552, 579)]
    const vs = [seg(42, 579, 42, 722), seg(552, 579, 552, 722), seg(59, 579, 59, 722), seg(292, 579, 292, 722),
      seg(76, 662, 76, 688), seg(76, 636, 76, 662), seg(76, 610, 76, 636), seg(76, 579, 76, 595)]
    const cells = extractCells(g, hs, vs)
    const narrow = cells.find(c => c.row === 1 && c.col === 1)
    assert.ok(narrow && narrow.rowSpan === 1, JSON.stringify(cells))
    assert.ok(cells.some(c => c.row === 2 && c.col === 1 && c.colSpan === 2), JSON.stringify(cells))
  })

  it("한 칸 높이의 절반만 덮는 토막 몇 개는 경계가 아니다 — 병합 칸 안 단선", () => {
    const sparse = [seg(40, 40, 40, 600), seg(550, 40, 550, 600), ...[330, 410, 490].flatMap(x => [seg(x, 500, x, 600), seg(x, 300, x, 320), seg(x, 200, x, 220)])]
    const cells = extractCells(grid, horizontals, sparse)
    assert.deepEqual(cells.filter(c => c.row === 1).map(c => c.colSpan), [4])
  })
})
