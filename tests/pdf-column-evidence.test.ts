import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { detectColumns } from "../src/pdf/columns.js"
import type { NormItem } from "../src/pdf/text-line.js"

const part = (text: string, x: number, y: number, w: number): NormItem => ({
  text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false,
})

describe("PDF column evidence", () => {
  it("does not treat repeated formula and prose starts as a data table", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) lines.push([
      part("The full paragraph describes an equation and continues over this line", 90, 700 - r * 16, 150),
      part("with more explanatory prose", 258, 700 - r * 16, 85),
      part("that reaches the right margin.", 351, 700 - r * 16, 150),
    ])
    assert.equal(detectColumns(lines), null)
  })

  it("retains repeated short data rows across three columns", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) lines.push([
      part(`Item ${r}`, 90, 700 - r * 16, 36),
      part(String(r + 10), 200, 700 - r * 16, 20),
      part(String(r + 20), 310, 700 - r * 16, 20),
    ])
    assert.deepEqual(detectColumns(lines), [90, 200, 310])
  })
})
