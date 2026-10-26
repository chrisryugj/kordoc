import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs } from "../src/ocr/glyph-restore.js"

// 80×36 흰 상자 — 칸 0 「(앞에서 읽힘), 칸 1 한글, 칸 3 쉼표 자리 기호, 칸 5 한글
const W = 80, H = 36
function page(closeCorner: boolean): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  rect(2, 4, 9, 6); rect(2, 4, 4, 17) // 「
  rect(10, 4, 24, 30) // 한글
  if (closeCorner) { rect(28, 28, 38, 30); rect(36, 17, 38, 30) } // 」 — 오른쪽 줄기 + 밑변
  else { rect(31, 25, 35, 29); rect(32, 29, 34, 33) } // 쉼표 — 점 + 꼬리
  rect(45, 4, 60, 30) // 한글
  return rgba
}
const box = { x: 0, y: 0, w: W, h: H }

describe("쉼표로 읽은 닫는 홑낫표", () => {
  it("짝 없는 「 뒤 쉼표 자리가 」 꼴이면 」", () => {
    assert.equal(restoreGlyphs(page(true), W, box, "「가,나", [0, 1, 3, 5], 10), "「가」나")
  })
  it("진짜 쉼표·짝 없는 「 이 없는 줄은 그대로", () => {
    assert.equal(restoreGlyphs(page(false), W, box, "「가,나", [0, 1, 3, 5], 10), "「가,나")
    assert.equal(restoreGlyphs(page(true), W, box, "가가,나", [0, 1, 3, 5], 10), "가가,나")
  })
})
