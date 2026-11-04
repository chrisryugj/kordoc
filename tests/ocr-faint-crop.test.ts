import { it } from "node:test"
import assert from "node:assert/strict"
import { stretchFaintCrop } from "../src/ocr/pdf-ocr.js"

const px = (vals: number[]) => { const a = new Uint8Array(vals.length * 4); vals.forEach((v, i) => { a.set([v, v, v, 255], i * 4) }); return a }

it("stretches a faint figure crop (soft-masked light text) to full contrast (ODL 184)", () => {
  const vals = Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? 225 : 255))
  const a = px(vals)
  stretchFaintCrop(a)
  assert.equal(a[0], 0)
  assert.equal(a[4], 255)
  assert.equal(a[3], 255)
})

it("leaves a crop with normal contrast or a blank crop as it is", () => {
  const normal = px(Array.from({ length: 400 }, (_, i) => (i % 10 === 0 ? 30 : 255)))
  const before = normal.slice()
  stretchFaintCrop(normal)
  assert.deepEqual(normal, before)
  const blank = px(Array.from({ length: 400 }, () => 250))
  const b2 = blank.slice()
  stretchFaintCrop(blank)
  assert.deepEqual(blank, b2)
})
