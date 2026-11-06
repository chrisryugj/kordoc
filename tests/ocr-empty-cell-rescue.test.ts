import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { rescueEmptyCells } from "../src/ocr/empty-cell-rescue.js"
import type { OcrEngine, OcrItem } from "../src/ocr/engine.js"
import { DEFAULT_OCR_TUNING } from "../src/ocr/engine.js"

const W = 1000, H = 800
function page(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const dot = (x: number, y: number) => rgba.fill(0, (y * W + x) * 4, (y * W + x) * 4 + 3)
  // 칸 (100~200, 100~200) 안에 글 잉크
  for (let y = 130; y < 150; y++) for (let x = 120; x < 180; x += 2) dot(x, y)
  return rgba
}
const seg = (x1: number, y1: number, x2: number, y2: number) => ({ x1, y1, x2, y2, thicknessPx: 1 })
// 가로선 100·200, 세로선 100·200·300 — 칸 둘
const ruling = { horizontals: [seg(100, 100, 300, 100), seg(100, 200, 300, 200)], verticals: [seg(100, 100, 100, 200), seg(200, 100, 200, 200), seg(300, 100, 300, 200)] }

function fakeEngine(seen: Array<{ w: number; h: number }>): OcrEngine {
  return { recognizePage: async (_rgba: Uint8Array, w: number, h: number) => { seen.push({ w, h }); return [{ text: "서울시", x: 20, y: 30, w: 60, h: 20, confidence: 0.99 }] } } as unknown as OcrEngine
}

describe("빈 칸 다시 읽기 (rescueEmptyCells)", () => {
  it("잉크가 있고 읽힌 글이 없는 칸만 잘라 읽고, 좌표를 쪽으로 되돌린다", async () => {
    const seen: Array<{ w: number; h: number }> = []
    const out = await rescueEmptyCells(fakeEngine(seen), DEFAULT_OCR_TUNING, page(), W, H, ruling, [])
    assert.equal(seen.length, 1) // 오른쪽 칸은 잉크가 없다
    assert.equal(out.length, 1)
    assert.ok(out[0].x > 100 && out[0].x < 200 && out[0].y > 100 && out[0].y < 200)
  })
  it("이미 글이 읽힌 칸은 다시 읽지 않는다", async () => {
    const seen: Array<{ w: number; h: number }> = []
    const items: OcrItem[] = [{ text: "서울시", x: 120, y: 130, w: 60, h: 20, confidence: 0.99 }]
    assert.equal((await rescueEmptyCells(fakeEngine(seen), DEFAULT_OCR_TUNING, page(), W, H, ruling, items)).length, 0)
    assert.equal(seen.length, 0)
  })
})
