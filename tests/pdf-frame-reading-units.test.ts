import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {OPS} from "../src/pdf/ops.js"
import {extractPageBlocksWithLines} from "../src/pdf/page-blocks.js"
import {groupFrameParagraphUnits, FRAME_READING_UNITS, recordFrameReadingUnit} from "../src/pdf/frame-cell-blocks.js"
import type {IRBlock} from "../src/types.js"
import type {NormItem} from "../src/pdf/text-line.js"

describe("native frame paragraph reading units", () => {
  it("keeps a closed chart legend together without moving an outside axis label between its lines", () => {
    const word = (text: string, x: number, y: number, w: number, h: number): NormItem =>
      ({text, x, y, w, h, fontSize: h, fontName: "ocr", isHidden: false})
    const items = [word("-+- Put for par", 398, 593, 45, 9), word("→+- Put for birdie", 398, 579, 52, 7),
      word("UP 0.6", 480, 586, 45, 12)]
    const lines = [[394, 575, 452.833, 575], [394, 605.833, 452.833, 605.833],
      [394, 575, 394, 605.833], [452.833, 575, 452.833, 605.833]]
    const blocks = extractPageBlocksWithLines(items, 1, {
      fnArray: lines.flatMap(() => [OPS.constructPath, OPS.stroke]),
      argsArray: lines.flatMap(line => [[[OPS.moveTo, OPS.lineTo], line], []]),
    }, 600, 800)
    assert.deepEqual(blocks.map(b => b.text), ["-+- Put for par", "→+- Put for birdie", "UP 0.6"])
    assert.deepEqual(blocks[0].bbox, {page: 1, x: 398, y: 593, width: 45, height: 9})
    assert.deepEqual(blocks[1].bbox, {page: 1, x: 398, y: 579, width: 52, height: 7})
  })
})

describe("frame unit membership protects unrelated structure", () => {
  const paragraph = (text: string): IRBlock => ({type: "paragraph", text})
  it("leaves a confirmed flow band together and does not reinsert absent frame paragraphs", () => {
    const a = paragraph("box1top"), b = paragraph("box1bottom"), c = paragraph("box2"), missing = paragraph("absent"), outside = paragraph("axis")
    const flow = [a, b, c], units = [flow, [outside]]
    assert.deepEqual(groupFrameParagraphUnits(units, [[a, b], [outside, missing]]), units)
    assert.equal(groupFrameParagraphUnits(units, [[a, b]])[0], flow)
  })
  it("does not group an unrelated body paragraph or another source frame", () => {
    const a = paragraph("first1"), b = paragraph("first2"), c = paragraph("second1"), d = paragraph("second2"), body = paragraph("body")
    const out = groupFrameParagraphUnits([[a], [c], [body], [b], [d]], [[a, b], [c, d]])
    assert.deepEqual(out, [[a, b], [c, d], [body]])
    assert.equal(out.flat().length, 5)
  })
  it("retains nested paragraph/table/paragraph and picture units in their existing order", () => {
    const a = paragraph("before"), b = paragraph("after"), nested: IRBlock = {type: "table", table: {rows: 1, cols: 2, hasHeader: false, cells: [[{text: "L", colSpan: 1, rowSpan: 1}, {text: "R", colSpan: 1, rowSpan: 1}]]}}, image: IRBlock = {type: "image", text: "image.png"}
    const units = [[a], [nested], [b], [image]]
    assert.deepEqual(groupFrameParagraphUnits(units, [[a, nested, b], [b, image]]), units)
  })
})

it("propagates native frame geometry while larger flow units keep precedence", () => {
  const a: IRBlock = {type: "paragraph", text: "A", bbox: {page: 1, x: 10, y: 20, width: 20, height: 10}},
    b: IRBlock = {type: "paragraph", text: "B", bbox: {page: 1, x: 10, y: 5, width: 20, height: 10}},
    c: IRBlock = {type: "paragraph", text: "C", bbox: {page: 1, x: 50, y: 5, width: 20, height: 10}}
  const frame = [a, b], native = {page: 1, x: 7, y: 2, width: 26, height: 31}
  recordFrameReadingUnit(frame, native)
  groupFrameParagraphUnits([[a], [b], [c]], [frame])
  assert.equal(FRAME_READING_UNITS.get(a)?.bbox, native)
  assert.equal(FRAME_READING_UNITS.get(b)?.blocks, frame)
  const flow = [a, b, c]
  groupFrameParagraphUnits([flow], [frame])
  assert.equal(FRAME_READING_UNITS.get(a)?.blocks, flow)
  assert.equal(FRAME_READING_UNITS.get(c)?.blocks, flow)
  assert.deepEqual(FRAME_READING_UNITS.get(a)?.bbox, {page: 1, x: 10, y: 5, width: 60, height: 25})
})
