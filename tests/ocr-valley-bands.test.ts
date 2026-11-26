/** 줄끼리 맞닿은 여러 줄 상자를 골짜기 행에서 가르기 (line-split valleyBands) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { valleyBands, inkStats } from "../src/ocr/line-split.js"

const W = 120, H = 90

/** 세 줄(높이 30)이 빈 행 없이 맞닿은 칸. valley 는 줄 경계 행의 잉크 칸 수, rule 이면 x=2 에 위아래를 꿰는 칸 괘선 */
function cell(valley: number, rule = false) {
  const g = new Uint8Array(W * H).fill(245)
  const dot = (x: number, y: number) => { g[y * W + x] = 40 }
  for (let line = 0; line < 3; line++) {
    const top = line * 30
    for (let y = top + 3; y < top + 27; y++) for (let x = 10; x < 110; x++) if ((x + y) % 3 === 0) dot(x, y)
    for (let y = top + 27; y < top + 33 && y < H; y++) for (let x = 10; x < 10 + valley; x++) dot(x, y)
  }
  if (rule) for (let y = 0; y < H; y++) dot(2, y)
  return g
}

it("splits touching lines at the faint valley rows", () => {
  const g = cell(2)
  const bands = valleyBands(g, W, H, inkStats(g), 3)
  assert.equal(bands?.length, 3)
  assert.ok(Math.abs(bands![0].y1 - 30) <= 4 && Math.abs(bands![1].y1 - 60) <= 4)
})

it("keeps the box whole when the rows between lines are dense", () => {
  const g = cell(90)
  assert.equal(valleyBands(g, W, H, inkStats(g), 3), null)
})

it("ignores a cell rule that runs the full height", () => {
  const g = cell(2, true)
  const bands = valleyBands(g, W, H, inkStats(g), 3)
  assert.equal(bands?.length, 3)
  assert.ok(bands!.every(b => b.x0 >= 10))
})
