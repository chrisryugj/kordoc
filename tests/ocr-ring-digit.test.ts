import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 160×40 상자 흰 바탕. 글자 칸 20px(stepPx 10, 칸 k 가운데 = steps 2k+1 → x 20k+15)
const W = 160, H = 40
function page(draw: (set: (x: number, y: number) => void) => void): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  draw((x, y) => { const p = (Math.round(y) * W + Math.round(x)) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 })
  return rgba
}
const rect = (set: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y)
}
/** 칸 k 에 가운데 (cx, 20), 가로 반지름 rx·세로 반지름 ry, 획 t 인 고리 */
const oval = (set: (x: number, y: number) => void, cx: number, rx: number, ry: number, t: number) => {
  for (let y = 20 - ry; y <= 20 + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
    const d = Math.hypot((x - cx) / rx, (y - 20) / ry)
    if (d <= 1 && d >= 1 - t / Math.min(rx, ry)) set(x, y)
  }
}
const box = { x: 0, y: 0, w: W, h: H }
const steps = [1, 3, 5, 7, 9]
const rest = (set: (x: number, y: number) => void) => { rect(set, 30, 8, 38, 32); for (const k of [2, 3, 4]) rect(set, 20 * k + 6, 6, 20 * k + 26, 34) }

describe("줄 머리 고리 뒤가 숫자+한글", () => {
  it("띠 높이만 한 고리를 0 으로 읽은 \"04대보험\" 은 ○4대보험", () => {
    const rgba = page(set => { oval(set, 15, 13, 13, 1.5); rest(set) })
    assert.equal(restoreGlyphs(rgba, W, box, "04대보험", steps, 10), "○4대보험")
  })
  it("세로로 긴 숫자 0(목 코드 \"04기간제\")은 그대로", () => {
    const rgba = page(set => { oval(set, 15, 7, 13, 2.5); rest(set) })
    assert.equal(restoreGlyphs(rgba, W, box, "04기간제", steps, 10), "04기간제")
  })
})
