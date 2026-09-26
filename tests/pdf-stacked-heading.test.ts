import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { mergeStackedHeadingLines } from "../src/pdf/block-detect.js"
import type { IRBlock } from "../src/types.js"

const heading = (text: string, x: number, y: number, fontSize = 34): IRBlock => ({
  type: "heading", text, level: 1, pageNumber: 1,
  bbox: { page: 1, x, y, width: text.length * 15, height: fontSize },
  style: { fontSize, fontName: "display" },
})

describe("stacked PDF display titles", () => {
  it("joins adjacent lines with the same visual anchor", () => {
    const blocks = [heading("III.", 100, 716, 36), heading("Regulatory", 99, 674, 33), heading("cholesterol", 99, 632, 33)]
    mergeStackedHeadingLines(blocks, 11)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text, "III. Regulatory cholesterol")
  })

  it("leaves ordinary nearby headings separate", () => {
    const blocks = [heading("Scope", 100, 716, 16), heading("Methods", 100, 696, 16)]
    mergeStackedHeadingLines(blocks, 11)
    assert.equal(blocks.length, 2)
  })

  it("joins centered title lines whose type is larger than the body", () => {
    const first = heading("Scaling Large Language Models", 73, 761, 14)
    first.bbox!.width = 449
    const second = heading("With Depth Up-Scaling", 243, 745, 14)
    second.bbox!.width = 109
    const blocks = [first, second]
    mergeStackedHeadingLines(blocks, 9)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].text, "Scaling Large Language Models With Depth Up-Scaling")
  })
})
