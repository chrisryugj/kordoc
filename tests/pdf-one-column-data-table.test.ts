import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRTable } from "../src/types.js"

const table = (renderAsTable?: boolean): IRTable => ({
  rows: 4,
  cols: 1,
  hasHeader: true,
  ...(renderAsTable ? { renderAsTable } : {}),
  cells: ["Area", "Recycle", "Reuse", "Reduce"].map(text => [{ text, rowSpan: 1, colSpan: 1 }]),
})

describe("one-column PDF data tables", () => {
  it("keeps repeated data rows as separate HTML cells", () => {
    const markdown = blocksToMarkdown([{ type: "table", table: table(true) }])
    assert.equal((markdown.match(/<tr>/g) ?? []).length, 4)
    assert.match(markdown, /<td>Reduce<\/td>/)
  })

  it("keeps ordinary one-column layout tables as lines", () => {
    const markdown = blocksToMarkdown([{ type: "table", table: table() }])
    assert.doesNotMatch(markdown, /<table>/)
    assert.equal(markdown.trim(), "Area\nRecycle\nReuse\nReduce")
  })
})
