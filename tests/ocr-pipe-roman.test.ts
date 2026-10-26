import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 160×40 흰 상자, 띠 8~32. 한글 덩어리 둘(칸 0·1) 뒤에 세로 획(칸 2)
const W = 160, H = 40
function page(stems: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  rect(4, 8, 28, 32); rect(34, 8, 58, 32)
  for (let k = 0; k < stems; k++) rect(70 + k * 7, 8, 73 + k * 7, 32)
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }

describe("세로 막대 | 로 읽은 로마 숫자", () => {
  it("한글 바로 뒤 홑 막대는 획 수대로 Ⅰ·Ⅱ", () => {
    assert.equal(restoreGlyphs(page(1), W, box, "통장|", [1, 4, 7], 10), "통장Ⅰ")
    assert.equal(restoreGlyphs(page(2), W, box, "통장|", [1, 4, 7], 10), "통장Ⅱ")
  })
  it("빈칸 사이 홑 막대·겹 막대는 그대로", () => {
    assert.equal(restoreGlyphs(page(1), W, box, "통장 |", [1, 4, 6, 7], 10), "통장 |")
    assert.equal(restoreGlyphs(page(2), W, box, "통장||", [1, 4, 7, 8], 10), "통장||")
  })
})
