import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { columnTextToBlocks } from "../src/pdf/page-blocks.js"

describe("PDF aligned column tables", () => {
  it("preserves a generated table between prose as an IR table", () => {
    const text = "Introduction\n| Item | 2024 | 2025 |\n| --- | --- | --- |\n| Apples | 3 | 4 |\n| Pears | 5 | 6 |\nConclusion"
    const blocks = columnTextToBlocks(text, 1, { page: 1, x: 40, y: 20, width: 400, height: 500 })
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "table", "paragraph"])
    assert.equal(blocks[1].table?.rows, 3)
    assert.equal(blocks[1].table?.cols, 3)
    assert.equal(blocks[1].table?.cells[2][0].text, "Pears")
  })
})
