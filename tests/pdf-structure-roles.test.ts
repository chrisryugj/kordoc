import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isChartTable, isProseTable, isTableOfContents, tocBlock, TOC_BLOCKS } from "../src/pdf/table-roles.js"
import { demoteNonHeadingRoles } from "../src/pdf/heading-demote.js"
import { xyCutOrder } from "../src/pdf/xy-cut.js"
import { splitSingleCellTables } from "../src/pdf/text-clean.js"
import type { IRBlock, IRTable } from "../src/types.js"
import type { NormItem } from "../src/pdf/text-line.js"

const table = (rows: string[][]): IRTable => ({
  rows: rows.length, cols: rows[0].length, hasHeader: true,
  cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
})

const heading = (text: string, y: number, extra: Partial<IRBlock> = {}): IRBlock => ({
  type: "heading", level: 2, text, pageNumber: 1,
  bbox: { page: 1, x: 72, y, width: 300, height: 11 }, style: { fontSize: 11, fontName: "Title" }, ...extra,
})
const paragraph = (text: string, y: number): IRBlock => ({
  type: "paragraph", text, pageNumber: 1,
  bbox: { page: 1, x: 72, y, width: 450, height: 11 }, style: { fontSize: 11, fontName: "Body" },
})

describe("PDF table roles", () => {
  it("reads entries with growing page labels as a table of contents", () => {
    assert.equal(isTableOfContents(table([["Preface", "v"], ["About", "viii"], ["Introduction", "1"], ["Methods", "7"]])), true)
    // Numbers that fall down the column are data, not page labels.
    assert.equal(isTableOfContents(table([["Seoul", "31"], ["Busan", "12"], ["Daegu", "9"], ["Incheon", "8"]])), false)
  })

  it("keeps contents lines in reading order", () => {
    const block = tocBlock(table([["Introduction", "1"], ["Methods", "7"], ["Results", "12"]]), 1,
      { page: 1, x: 0, y: 0, width: 100, height: 40 })
    assert.equal(block.type, "paragraph")
    assert.equal(block.text, "Introduction 1\nMethods 7\nResults 12")
    assert.ok(TOC_BLOCKS.has(block))
  })

  it("rejects wrapped prose cells but keeps a table with a short label column", () => {
    const sentence = "This sentence keeps going across the whole column because it is ordinary body prose text."
    assert.equal(isProseTable(table([[sentence, ""], [sentence, ""], [sentence, ""], ["short end", ""]])), true)
    assert.equal(isProseTable(table([
      ["procs", sentence], ["memory", sentence], ["page", sentence], ["disk", "short"],
    ])), false)
  })

  it("recognizes a value axis or a sparse grid of quantities as a chart", () => {
    assert.equal(isChartTable(table([["90\n80\n70\n60\n50", "81"], ["", "56"], ["", "47"]])), true)
    assert.equal(isChartTable(table([["2.5%", "", ""], ["", "-3.1%", ""], ["", "", "-6.4%"]])), true)
    // Phone numbers in a sparse grid are identifiers, not plotted values.
    assert.equal(isChartTable(table([["", "", "(044-201-3823)"], ["", "", "(044-201-4770)"], ["", "", "(044-201-3813)"]])), false)
    assert.equal(isChartTable(table([["Year", "Rate"], ["2012", "10%"], ["2013", "6%"], ["2014", "7%"]])), false)
  })
})

describe("PDF heading demotion", () => {
  it("returns running heads, footers, captions, numbers and sentence fragments to prose", () => {
    const blocks = [
      heading("MOHAVE COMMUNITY COLLEGE\tBIO181", 760, { bbox: { page: 1, x: 48, y: 760, width: 530, height: 14 } }),
      heading("Methods", 600),
      paragraph("Body text follows the section title and continues for a while.", 580),
      heading("Table 2: Evaluation results", 400),
      heading("responses with degrees from the survey", 380),
      heading("S = k ln W,\t(2)", 360),
      heading("14.3%", 340),
      paragraph("More body text.", 300),
      heading("Project No: 2021-2-FR02", 40),
    ]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "heading", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"])
  })

  it("joins a bare section number with the title after it", () => {
    const blocks = [heading("6.", 500), heading("ECO CIRCLE FRAMEWORK", 485), paragraph("Body.", 460)]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].text, "6. ECO CIRCLE FRAMEWORK")
  })

  it("treats a part title between contents entries as an entry", () => {
    const toc = (y: number) => tocBlock(table([["Section 1.1", "3"], ["Section 1.2", "5"], ["Section 1.3", "8"]]), 1,
      { page: 1, x: 72, y, width: 300, height: 40 })
    const blocks = [toc(600), heading("Part II. Chapter Two", 550), toc(480)]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.equal(blocks[1].type, "paragraph")
  })
})

describe("PDF narrow prose gutter", () => {
  it("splits justified columns separated by a narrow gutter", () => {
    const item = (text: string, x: number, y: number, w: number): NormItem =>
      ({ text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false })
    const items: NormItem[] = []
    for (let row = 0; row < 6; row++) {
      items.push(item(`Left column sentence number ${row} keeps going to the edge`, 95, 530 - row * 12, 226))
      items.push(item(`Right column sentence number ${row} keeps going to the edge`, 329, 530 - row * 12, 226))
    }
    const groups = xyCutOrder(items, 21.8)
    assert.equal(groups.length, 2)
    assert.ok(groups[0].every(i => i.x === 95))
    assert.ok(groups[1].every(i => i.x === 329))
  })
})

describe("PDF columns under a spanning caption", () => {
  it("sets apart a caption below both columns and reads left then right", () => {
    const item = (text: string, x: number, y: number, w: number): NormItem =>
      ({ text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false })
    const items: NormItem[] = []
    for (let row = 0; row < 6; row++) {
      items.push(item(`Left column sentence number ${row} keeps going to the edge`, 95, 710 - row * 12, 226))
      items.push(item(`Right column sentence number ${row} keeps going to the edge`, 329, 710 - row * 12, 226))
    }
    const caption = item("Figure 3.1.1: Status of operations during each survey phase (%)", 94, 630, 283)
    items.push(caption)
    const groups = xyCutOrder(items, 20)
    assert.deepEqual(groups.map(g => g.length), [6, 6, 1])
    assert.equal(groups[2][0], caption)
  })
})

describe("PDF one-cell table split", () => {
  it("keeps the caption attached to a one-cell table", () => {
    const blocks: IRBlock[] = [{ type: "table", pageNumber: 1, table: {
      rows: 1, cols: 1, hasHeader: false, caption: "Figure 6.1.2: Survey phases",
      cells: [[{ text: "80 45\n60", colSpan: 1, rowSpan: 1 }]],
    } }]
    assert.deepEqual(splitSingleCellTables(blocks).map(b => b.text), ["Figure 6.1.2: Survey phases", "80 45", "60"])
  })
})
