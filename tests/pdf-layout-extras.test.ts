import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { glyphNameText, remapControlGlyphs } from "../src/pdf/glyph-names.js"
import { detectPanelGutters, orderByPanels } from "../src/pdf/two-column.js"
import { splitSingleCellTables } from "../src/pdf/text-clean.js"
import { bridgeSkippedRowVerticals } from "../src/pdf/vertical-bridge.js"
import { demoteNonHeadingRoles } from "../src/pdf/heading-demote.js"
import type { LineSegment } from "../src/pdf/line-types.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })
const item = (text: string, x: number, y: number, w = text.length * 5, fontName = "Body", fontSize = 9): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName, isHidden: false })

describe("glyph names", () => {
  it("maps suffixed, small-cap and ligature glyph names", () => {
    assert.equal(glyphNameText("seven.oldstyle"), "7")
    assert.equal(glyphNameText("c.sc"), "C")
    assert.equal(glyphNameText("f_l"), "fl")
    assert.equal(glyphNameText("uni00E9"), "é")
    assert.equal(glyphNameText("somethingelse"), undefined)
  })

  it("restores control-code glyphs from the font differences", () => {
    const diffs: string[] = []
    diffs[23] = "one.oldstyle"; diffs[8] = "six.oldstyle"; diffs[6] = "five.oldstyle"
    const items = [item("May \u0017 \b\u0006.", 0, 0)]
    remapControlGlyphs(items, () => diffs)
    assert.equal(items[0].text, "May 1 65.")
  })
})

describe("panel gutters", () => {
  it("finds three side-by-side panels and reads them column by column", () => {
    const rects = []
    for (const x of [40, 340, 640]) for (let k = 0; k < 4; k++) rects.push({ x, y: 400 - k * 40, w: 200, h: 12 })
    rects.push({ x: 40, y: 480, w: 800, h: 20 }) // 전폭 제목 줄
    const gutters = detectPanelGutters(rects)
    assert.ok(gutters && gutters.length === 2)
    const order = orderByPanels(rects, r => r, gutters!)
    assert.equal(order[0].w, 800)
    assert.deepEqual(order.slice(1, 5).map(r => r.x), [40, 40, 40, 40])
  })
})

describe("caption boxes", () => {
  it("turns a label + caption 1x2 table into one caption paragraph", () => {
    const table = (cells: string[][]): IRBlock => ({ type: "table", pageNumber: 1,
      table: { rows: cells.length, cols: cells[0].length, hasHeader: false, cells: cells.map(r => r.map(text => ({ text, colSpan: 1, rowSpan: 1 }))) } })
    const out = splitSingleCellTables([table([["Figure 4", "Komnas HAM's YouTube channel\nas of 1 December 2021"]]), table([["Year", "Rate"]])])
    assert.equal(out[0].type, "paragraph")
    assert.equal(out[0].text, "Figure 4 Komnas HAM's YouTube channel as of 1 December 2021")
    assert.equal(out[1].type, "table")
  })
})

describe("skipped-row verticals", () => {
  it("bridges columns that skip one ruled row when its text stays inside the columns", () => {
    const hs = [h(400, 100, 400), h(380, 100, 400), h(360, 100, 400), h(340, 100, 400)]
    const vs: LineSegment[] = []
    for (const x of [100, 200, 300, 400]) vs.push(v(x, 380, 400), v(x, 340, 360))
    const items = [item("Cambodia", 105, 365, 40), item("7.5%", 205, 365, 20), item("1,272", 305, 365, 25)]
    assert.ok(bridgeSkippedRowVerticals(hs, vs, items).length > vs.length)
    const merged = [item("A sentence that runs across the columns", 105, 365, 250)]
    assert.equal(bridgeSkippedRowVerticals(hs, vs, merged).length, vs.length)
  })
})

describe("title roles", () => {
  it("demotes a small kicker above a larger slide title and an unbalanced fragment", () => {
    const blocks: IRBlock[] = [
      { type: "heading", level: 3, text: "Recommendation Pack: Track Record", pageNumber: 1, bbox: { page: 1, x: 40, y: 500, width: 200, height: 10 }, style: { fontSize: 10, fontName: "A" } },
      { type: "heading", level: 1, text: "Recommendation pack shows outstanding performance", pageNumber: 1, bbox: { page: 1, x: 40, y: 470, width: 600, height: 20 }, style: { fontSize: 20, fontName: "B" } },
      { type: "paragraph", text: "body", pageNumber: 1, bbox: { page: 1, x: 40, y: 300, width: 600, height: 10 } },
      { type: "heading", level: 3, text: "Fact-checking) and is used under a CC BY-SA 3.0 license.", pageNumber: 1, bbox: { page: 1, x: 40, y: 200, width: 400, height: 10 } },
      { type: "heading", level: 2, text: "1) 개요", pageNumber: 1, bbox: { page: 1, x: 40, y: 150, width: 100, height: 10 } },
    ]
    demoteNonHeadingRoles(blocks, new Map([[1, 540]]))
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "heading", "paragraph", "paragraph", "heading"])
  })
})
