import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { inkStats, leadingRing } from "../src/ocr/line-split.js"

// 280×60 흰 상자, 글줄 띠 14~46(32px). 맨 앞 고리(가운데 x 30), 그 뒤 한글 덩어리
const W = 280, H = 60
function line(r: number, t: number): Uint8Array {
  const g = new Uint8Array(W * H).fill(255)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = Math.hypot(x - 30, y - 30)
    if (d <= r && d >= r - t) g[y * W + x] = 0
  }
  for (const x0 of [70, 106, 142]) for (let y = 14; y < 46; y++) for (let x = x0; x < x0 + 30; x++) g[y * W + x] = 0
  return g
}

describe("leadingRing — 인식에서 빠진 줄 머리 도형 ○", () => {
  it("띠 높이만 한 가는 고리 뒤에서 첫 글자가 시작하면 참", () => {
    const g = line(16, 2)
    assert.equal(leadingRing(g, W, H, inkStats(g), 85), true)
  })
  it("속 빈 네모(□)는 가운데 줄이 두 토막이어도 거짓", () => {
    const g = new Uint8Array(W * H).fill(255)
    for (let y = 14; y < 46; y++) for (let x = 14; x < 46; x++) if (x < 16 || x >= 44 || y < 16 || y >= 44) g[y * W + x] = 0
    for (const x0 of [70, 106, 142]) for (let y = 14; y < 46; y++) for (let x = x0; x < x0 + 30; x++) g[y * W + x] = 0
    assert.equal(leadingRing(g, W, H, inkStats(g), 85), false)
  })
  it("첫 글자 자리가 고리에 걸치거나(고리를 글자로 읽음) 작고 굵은 고리(자모 ㅇ)면 거짓", () => {
    const g = line(16, 2)
    assert.equal(leadingRing(g, W, H, inkStats(g), 30), false)
    const jamo = line(8, 4)
    assert.equal(leadingRing(jamo, W, H, inkStats(jamo), 85), false)
  })
})
