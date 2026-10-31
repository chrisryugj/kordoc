import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { dropRuledFragmentClipGrids } from "../src/pdf/table-grid.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"

const PAGE_W = 595, PAGE_H = 842

/** 6열 4행 선 표 안, 한 행의 넷째~여섯째 칸에만 클립이 걸린 꼴(여수 정원표 "합계" 행) */
function fixture() {
  const host: TableGrid = {
    colXs: [50, 100, 150, 200, 250, 300, 350], rowYs: [400, 370, 340, 310, 280],
    bbox: { x1: 50, y1: 280, x2: 350, y2: 400 }, vertexRadius: 1,
  }
  const xs = [200, 250, 300, 350], ys = [340, 310]
  const clip: TableGrid = {
    colXs: xs, rowYs: ys, bbox: { x1: 200, y1: 310, x2: 350, y2: 340 }, vertexRadius: 1,
    cells: xs.slice(1).map((x, col) => ({ row: 0, col, rowSpan: 1, colSpan: 1, bbox: { x1: xs[col], x2: x, y1: 310, y2: 340 } })),
  }
  const verticals: LineSegment[] = host.colXs.map(x => ({ x1: x, x2: x, y1: 280, y2: 400, lineWidth: 1 }))
  return { host, clip, verticals }
}

describe("dropRuledFragmentClipGrids — 선 표 몇 칸에만 걸린 클립", () => {
  it("행·열 경계가 선 표 괘선 자리이고 칸 경계가 그어졌으면 선 표에 맡긴다", () => {
    const { host, clip, verticals } = fixture()
    assert.deepEqual(dropRuledFragmentClipGrids([clip], [host], verticals, PAGE_W, PAGE_H), [])
  })

  it("칸 경계 세로 괘선이 없으면(클립이 선에 없는 경계를 줌) 둔다", () => {
    const { host, clip, verticals } = fixture()
    const v = verticals.filter(l => l.x1 !== 250)
    assert.deepEqual(dropRuledFragmentClipGrids([clip], [host], v, PAGE_W, PAGE_H), [clip])
  })

  it("클립 열 경계가 선 표에 없으면 둔다", () => {
    const { host, clip, verticals } = fixture()
    host.colXs = [50, 100, 150, 200, 275, 350]
    assert.deepEqual(dropRuledFragmentClipGrids([clip], [host], [...verticals, { x1: 275, x2: 275, y1: 280, y2: 400, lineWidth: 1 }], PAGE_W, PAGE_H), [clip])
  })

  it("품는 선 격자가 쪽 테두리 틀(쪽을 거의 다 덮음)이면 클립 표를 둔다", () => {
    const { host, clip, verticals } = fixture()
    host.bbox = { x1: 28, y1: 42, x2: 566, y2: 798 }
    host.colXs = [28, ...host.colXs, 566]
    host.rowYs = [798, ...host.rowYs, 42]
    assert.deepEqual(dropRuledFragmentClipGrids([clip], [host], verticals, PAGE_W, PAGE_H), [clip])
  })

  it("선 표 절반 넘게 클립이 덮으면(한컴처럼 칸마다 클립) 둔다", () => {
    const { host, clip, verticals } = fixture()
    const big: TableGrid = { ...clip, bbox: { x1: 50, y1: 280, x2: 350, y2: 400 }, cells: clip.cells }
    assert.deepEqual(dropRuledFragmentClipGrids([clip, big], [host], verticals, PAGE_W, PAGE_H).includes(clip), true)
  })
})
