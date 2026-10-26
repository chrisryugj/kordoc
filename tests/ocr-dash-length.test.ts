import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 160×40 흰 상자, 글자 칸 20px(stepPx 10, steps 2k+1 → 칸 가운데 x = 20k+15)
const W = 160, H = 40
function page(dashW: number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const set = (x: number, y: number) => { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  for (let y = 19; y < 22; y++) for (let x = 15 - dashW / 2; x < 15 + dashW / 2; x++) set(x, y) // 칸 0 대시
  for (const k of [1, 2, 3]) for (let y = 6; y < 34; y++) for (let x = 20 * k + 4; x < 20 * k + 26; x++) set(x + 8, y) // 한글 덩어리(띠 28px, 대시와 떨어지게 8px 밀어 둠)
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }
const steps = [1, 3, 5, 7]

describe("OCR 대시 길이", () => {
  it("띠 절반 남짓한 붙임표를 — 로 읽으면 -", () => {
    assert.equal(restoreGlyphs(page(12), W, box, "—조건가", steps, 10), "-조건가")
  })
  it("띠만큼 긴 줄표를 - 로 읽으면 —", () => {
    assert.equal(restoreGlyphs(page(24), W, box, "-상하수", steps, 10), "—상하수")
  })
  it("긴 대시도 줄 머리가 아니거나(숫자 사이) 글자 없는 줄이면 늘리지 않는다", () => {
    assert.equal(restoreGlyphs(page(24), W, box, "5-상하수", [0, 1, 5, 7, 9], 10), "5-상하수")
    assert.equal(restoreGlyphs(page(24), W, box, "-123", steps, 10), "-123")
  })
  it("그 사이 길이는 읽은 대로", () => {
    assert.equal(restoreGlyphs(page(20), W, box, "–상하수", steps, 10), "–상하수")
  })
})
