import { it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { frameLayoutBoxes, recordFrameReadingUnit, FRAME_READING_UNITS } from "../src/pdf/frame-cell-blocks.js"
import { detectColumnGutter } from "../src/pdf/two-column.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

it("keeps independent columns after both single and multiple frame paragraphs are reflowed", () => {
  const word = (text: string, x: number, y: number, w: number, h: number): NormItem =>
    ({ text, x, y, w, h, fontSize: 10, fontName: "F", isHidden: false })
  const items: NormItem[] = []
  for (let i = 0; i < 5; i++) {
    items.push(word(`Left body paragraph ${i}`, 26, [750, 650, 450, 350, 250][i], 260, 10))
    items.push(word(`Right body paragraph ${i}`, 302, [740, 640, 440, 340, 240][i], 260, 25))
  }
  const clauses = ["① first clause.", "② second clause.", "③ third clause.", "④ fourth clause."]
  items.push(word("Left framed paragraph.", 43, 156, 160, 10))
  clauses.forEach((text, i) => items.push(word(text, 320, 544 - i * 15, 105, 10)))
  const frames = [[304, 487, 261, 70], [28, 151, 261, 33]]
  const blocks = extractPageBlocksWithLines(items, 1, {
    fnArray: frames.flatMap(() => [OPS.constructPath, OPS.stroke]),
    argsArray: frames.flatMap(frame => [[[OPS.rectangle], frame], []]),
  }, 595, 842)
  assert.deepEqual(blocks.map(b => b.text), [
    ...Array.from({ length: 5 }, (_, i) => `Left body paragraph ${i}`), "Left framed paragraph.",
    "Right body paragraph 0", "Right body paragraph 1", ...clauses,
    "Right body paragraph 2", "Right body paragraph 3", "Right body paragraph 4",
  ])
  assert.deepEqual(blocks[5].bbox, { page: 1, x: 43, y: 156, width: 160, height: 10 })
  assert.deepEqual(blocks[8].bbox, { page: 1, x: 320, y: 544, width: 105, height: 10 })
})

it("counts each source frame once without changing paragraph bounds or single-block OCR membership", () => {
  const paragraph = (text: string, x: number, y: number): IRBlock =>
    ({ type: "paragraph", text, bbox: { page: 1, x, y, width: 50, height: 10 } })
  const a = paragraph("first", 320, 540), b = paragraph("second", 320, 510), single = paragraph("single", 43, 156)
  const unrelated = paragraph("outside", 200, 590), absent: IRBlock = { type: "paragraph", text: "no bounds" }
  const right = { page: 1, x: 304, y: 487, width: 261, height: 70 }
  const left = { page: 1, x: 28, y: 151, width: 261, height: 33 }
  const original = [a.bbox, b.bbox, single.bbox]
  recordFrameReadingUnit([a, b], right)
  recordFrameReadingUnit([single], left)
  assert.deepEqual(frameLayoutBoxes([a, unrelated, b, single, absent]), [right, unrelated.bbox, left])
  assert.deepEqual([a.bbox, b.bbox, single.bbox], original)
  assert.equal(FRAME_READING_UNITS.get(single), undefined)
  assert.deepEqual(frameLayoutBoxes([unrelated, absent]), [unrelated.bbox])
})

it("does not turn paired label/value rows into independent columns", () => {
  const rows: IRBlock[] = Array.from({ length: 14 }, (_, i) => [
    { type: "paragraph" as const, text: `label ${i}`, bbox: { page: 1, x: 30, y: 700 - i * 30, width: 220, height: 10 } },
    { type: "paragraph" as const, text: `value ${i}`, bbox: { page: 1, x: 310, y: 700 - i * 30, width: 220, height: 10 } },
  ]).flat()
  const boxes = frameLayoutBoxes(rows)
  assert.deepEqual(boxes, rows.map(b => b.bbox))
  assert.equal(detectColumnGutter(boxes.map(b => ({ x: b.x, y: b.y, w: b.width, h: b.height }))), null)
})
