import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extendStraddledVerticals } from "../src/pdf/ocr-straddle-verticals.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const H = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
const V = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })

describe("OCR 머리 칸 L자 영역 (extendStraddledVerticals)", () => {
  // 머리 위 524 · 아래 489, 오른쪽 묶음 아래선 509(x 447~538). "2023" 열 417~447, 그 오른쪽 세로선 447 은 509 아래만
  const horizontals = [H(56, 538, 524), H(447, 538, 509), H(56, 538, 489), H(56, 538, 460), H(56, 538, 430), H(56, 538, 400)]
  const verticals = [V(417, 300, 524), V(447, 300, 509), V(475, 300, 524), V(538, 300, 524)]

  it("왼쪽 칸 글이 가로선 연장선에 걸치면 세로선을 위 가로선까지 늘린다", () => {
    const out = extendStraddledVerticals(horizontals, verticals, [{ x: 420, y: 504, w: 24, h: 10 }])
    assert.equal(out[1].y2, 524)
  })
  it("글이 아래 행 안에만 있으면 그대로", () => {
    const out = extendStraddledVerticals(horizontals, verticals, [{ x: 420, y: 494, w: 24, h: 10 }])
    assert.equal(out[1].y2, 509)
  })
})
