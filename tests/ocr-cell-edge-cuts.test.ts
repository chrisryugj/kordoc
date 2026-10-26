import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cellEdgeVerticals, cellEdgeHorizontals } from "../src/ocr/pdf-ocr.js"
import { splitBoxAtRowRules } from "../src/ocr/crop.js"

const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, thicknessPx: 2 })

describe("cellEdgeVerticals — 검출 박스를 가를 표 칸 경계", () => {
  it("위아래 끝이 가로 괘선에 닿는 세로선만, 끝이 뜬 여백선·단 구분선은 뺀다", () => {
    const r = {
      horizontals: [seg(0, 0, 200, 0), seg(0, 100, 200, 100)],
      verticals: [seg(100, 0, 100, 100), seg(150, 20, 150, 80), seg(300, 0, 300, 100)],
    }
    assert.deepEqual(cellEdgeVerticals(r).map(v => v.x1), [100])
  })
  it("양끝이 세로 괘선에 닿는 가로선만 행 경계, 위아래 두 행을 묶은 박스는 그 선에서 가른다", () => {
    const r = {
      horizontals: [seg(0, 50, 200, 50), seg(20, 70, 180, 70)],
      verticals: [seg(0, 0, 0, 100), seg(200, 0, 200, 100)],
    }
    const rows = cellEdgeHorizontals(r)
    assert.deepEqual(rows.map(h => h.y1), [50])
    const parts = splitBoxAtRowRules({ x: 10, y: 30, w: 150, h: 40 }, rows)
    assert.deepEqual(parts.map(b => [b.y, b.h]), [[30, 18], [52, 18]])
    // 선이 박스 끝에 너무 가까우면(조각이 박스 높이 30% 미만) 가르지 않는다
    assert.equal(splitBoxAtRowRules({ x: 10, y: 45, w: 150, h: 40 }, rows).length, 1)
  })
})
