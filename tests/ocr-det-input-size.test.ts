/** OCR det 입력 크기 — 긴 변을 맞추되 아주 납작한 띠는 짧은 변을 지킨다 (src/ocr/engine.ts detInputSize) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { detInputSize } from "../src/ocr/engine.js"

it("fits the long side for page-shaped images (종전 그대로)", () => {
  assert.deepEqual(detInputSize(2480, 3508, 960), { dw: 672, dh: 960 })
  assert.deepEqual(detInputSize(1654, 2339, 960), { dw: 672, dh: 960 })
})

it("keeps the short side of a one-line handwriting strip above the detector's text size (3685×183 → 짧은 변 96)", () => {
  const { dw, dh } = detInputSize(3685, 183, 960)
  assert.equal(dh, 96)
  assert.ok(dw > 960 && dw <= 4096)
  // 긴 변은 4096 까지만
  assert.equal(detInputSize(40000, 100, 960).dw, 4096)
})
