import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isFormulaTable } from "../src/pdf/table-roles.js"
import { demoteNonHeadingRoles } from "../src/pdf/heading-demote.js"
import { cleanPdfText, joinLatinCellWraps, splitSingleCellTables } from "../src/pdf/text-clean.js"
import { latinSoftWrap } from "../src/pdf/cell-text.js"
import { headerLineAbove } from "../src/pdf/grid-header-line.js"
import { mergeSliverColumns } from "../src/pdf/table-trim.js"
import { dominantStyle, type NormItem } from "../src/pdf/text-line.js"
import { mergeLinkRuns } from "../src/pdf/links.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

const table = (rows: string[][]): IRTable => ({
  rows: rows.length, cols: rows[0].length, hasHeader: true,
  cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
})
const block = (type: "heading" | "paragraph", text: string, x: number, y: number, fontSize: number, fontName: string, width = 200): IRBlock => ({
  type, text, pageNumber: 1, ...(type === "heading" ? { level: 2 } : {}),
  bbox: { page: 1, x, y, width, height: fontSize }, style: { fontSize, fontName },
})
const item = (text: string, x: number, y: number, w: number, fontSize = 10, seq: number | undefined = 1): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "f", isHidden: false, seq })

describe("PDF heading roles (ODL 3rd pass)", () => {
  it("joins a lowercase item marker set apart on the title's line into a body item", () => {
    const blocks = [block("paragraph", "n.", 72, 264, 11, "Bold", 9), block("heading", "In-store Sorting and Recycling Bins.", 99, 264, 11, "Bold")]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].type, "paragraph")
    assert.equal(blocks[0].text, "n. In-store Sorting and Recycling Bins.")
  })

  it("joins a section number set in another face onto its title", () => {
    const sameLine = [block("paragraph", "4", 57, 210, 11, "Regular", 5), block("heading", "Al-Sadu Symbols and Social Significance", 79, 210, 11, "Bold")]
    demoteNonHeadingRoles(sameLine, new Map([[1, 792]]))
    assert.deepEqual(sameLine.map(b => [b.type, b.text]), [["heading", "4 Al-Sadu Symbols and Social Significance"]])
    const above = [block("paragraph", "4", 61, 575, 25, "Regular", 14), block("heading", "Basis Fields", 61, 550, 17, "Regular")]
    demoteNonHeadingRoles(above, new Map([[1, 792]]))
    assert.deepEqual(above.map(b => [b.type, b.text]), [["heading", "4 Basis Fields"]])
  })

  it("returns an italic byline under the title to prose", () => {
    const body = "This report surveys thirty-nine jurisdictions regarding whether, and if so how, they restrict ownership of land by foreigners. ".repeat(3)
    const blocks = [
      block("heading", "Restrictions on Land Ownership by Foreigners", 114, 683, 17, "g1"),
      block("heading", "Staff of the Global Legal Research Directorate", 206, 663, 11, "g4"),
      block("paragraph", body, 72, 546, 11, "g2"),
    ]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]), new Map([["g1", "BookAntiqua-Bold"], ["g4", "BookAntiqua-Italic"], ["g2", "BookAntiqua"]]))
    assert.deepEqual(blocks.map(b => b.type), ["heading", "paragraph", "paragraph"])
  })

  it("rejoins a title wrapped onto a lowercase line and a title split around an ampersand", () => {
    const wrapped = [
      block("heading", "Upstage universal OCR model performance details: Document", 362, 268, 11, "g4", 348),
      block("paragraph", "criteria", 362, 253, 11, "g4", 36),
    ]
    demoteNonHeadingRoles(wrapped, new Map([[1, 400]]))
    assert.deepEqual(wrapped.map(b => b.text), ["Upstage universal OCR model performance details: Document criteria"])
    const split = [
      block("heading", "WHY IT IS IMPORTANT", 553, 453, 17, "g3"),
      block("paragraph", "&", 656, 429, 17, "g4", 11),
      block("heading", "WHAT YOU CAN DO", 562, 407, 17, "g3"),
    ]
    demoteNonHeadingRoles(split, new Map([[1, 612]]))
    assert.deepEqual(split.map(b => b.text), ["WHY IT IS IMPORTANT & WHAT YOU CAN DO"])
  })

  it("does not take unreadably small chart labels for titles", () => {
    const blocks = [block("heading", "Parsing-F1", 390, 60, 6, "g4", 30)]
    demoteNonHeadingRoles(blocks, new Map([[1, 400]]))
    assert.equal(blocks[0].type, "paragraph")
  })
})

describe("PDF line style", () => {
  it("weighs the dominant size by letters, not by item count", () => {
    const style = dominantStyle([item("1.8X", 0, 0, 40, 34), item("↑", 42, 10, 4, 9), item("1", 47, 10, 4, 9)])
    assert.equal(style?.fontSize, 34)
    // Leader dots in their own item do not outvote the entry text.
    const toc = dominantStyle([item("Chemistry of the Cell", 0, 0, 90, 11), item("....", 92, 0, 60, 8), item("....", 150, 0, 60, 8), item("9", 212, 0, 5, 11)])
    assert.equal(toc?.fontSize, 11)
  })
})

describe("PDF table cells and roles", () => {
  it("joins Latin soft wraps in a cell but keeps new items, numbers and Hangul lines", () => {
    assert.equal(latinSoftWrap("GATS XVII", "Reservation"), true)
    assert.equal(latinSoftWrap("To understand the meaning of", "● To understand the importance"), false)
    assert.equal(latinSoftWrap("20,775,661", "5,187,590"), false)
    assert.equal(latinSoftWrap("과장 김철수", "Tel 044"), false)
    const t: IRBlock = { type: "table", table: table([["GATS XVII\nReservation\n(1994)", "Prohibition on\nownership"]]) }
    joinLatinCellWraps([t])
    assert.deepEqual(t.table!.cells[0].map(c => c.text), ["GATS XVII Reservation (1994)", "Prohibition on ownership"])
  })

  it("reads display math laid out on baselines as a formula, not a table", () => {
    assert.equal(isFormulaTable(table([["d", "∣"], ["(Df )(t) =", "f (x)∣ ."], ["dx", "∣ x=t"]])), true)
    assert.equal(isFormulaTable(table([["Year", "Rate"], ["2012", "10%"], ["2013", "6%"]])), false)
    // Checklists of O/X marks are data, even without numbers.
    assert.equal(isFormulaTable(table([["항목", "O"], ["점검", "X"], ["확인", "O"]])), false)
  })

  it("adds an unruled header line sitting on top of a ruled grid", () => {
    const colXs = [100, 250, 350, 450, 550]
    const free = [item("REGIONS", 105, 520, 50), item("2007-2010", 260, 520, 45), item("2010-2013", 360, 520, 45), item("2016-2019", 460, 520, 45)]
    const head = headerLineAbove(free, colXs, 512)
    assert.deepEqual(head?.map(col => col.map(it => it.text).join(" ")), ["REGIONS", "2007-2010", "2010-2013", "2016-2019"])
    // A caption split into two pieces is not a header row.
    assert.equal(headerLineAbove([item("Table 7.1.", 260, 520, 40), item("Types of promotional materials", 360, 520, 150)], colXs, 512), null)
    // OCR text (no stream order) is left alone.
    assert.equal(headerLineAbove(free.map(it => ({ ...it, seq: undefined })), colXs, 512), null)
  })

  it("merges a hairline column that only holds empty or spanning cells", () => {
    const cell = (text: string, colSpan = 1): IRCell => ({ text, colSpan, rowSpan: 1 })
    const grid: IRCell[][] = [
      [cell(""), cell(""), cell("Mitosis"), cell("Meiosis")],
      [cell("# chromosomes", 2), cell(""), cell(""), cell("")],
      [cell(""), cell("# DNA replications"), cell(""), cell("")],
    ]
    const colXs = [102.4, 102.7, 274, 447, 612]
    assert.equal(mergeSliverColumns(grid, colXs, 5), 1)
    assert.deepEqual(grid.map(row => row.map(c => `${c.text}/${c.colSpan}`)), [
      ["/1", "Mitosis/1", "Meiosis/1"],
      ["# chromosomes/1", "/1", "/1"],
      ["# DNA replications/1", "/1", "/1"],
    ])
    assert.deepEqual(colXs, [102.4, 274, 447, 612])
  })

  it("unwraps a caption box whose frame repeats the caption text", () => {
    const inner: IRBlock = { type: "table", table: table([["Diagram 5", "Distribution of YouTube Content (2019-\n2020)"]]) }
    const frame: IRBlock = { type: "table", table: { rows: 1, cols: 1, hasHeader: false,
      cells: [[{ text: "Diagram 5\nDistribution of YouTube Content (2019-\n2020)", colSpan: 1, rowSpan: 1, blocks: [inner] }]] } }
    const out = splitSingleCellTables([frame])
    assert.deepEqual(out.map(b => [b.type, b.text]), [["paragraph", "Diagram 5 Distribution of YouTube Content (2019- 2020)"]])
  })
})

describe("PDF text clean", () => {
  it("closes spaced leader dots and can keep lone numbers", () => {
    assert.equal(cleanPdfText("Foreword . . . . . . xi"), "Foreword ...... xi")
    assert.equal(cleanPdfText("0\n500\n1,000", { keepLoneNumbers: true }), "0\n500\n1,000")
    assert.equal(cleanPdfText("Body\n12\nNext"), "Body\nNext")
  })
})

describe("PDF links", () => {
  it("joins a link wrapped line by line back into one link and drops the underline around it", () => {
    const u = "https://example.org/ksu"
    assert.equal(mergeLinkRuns(`Figure 7.3. [You can read](${u})\n\n[more about KSU](${u}) <u>[Marking Open](${u})</u> (Hare 2020).`),
      `Figure 7.3. [You can read more about KSU Marking Open](${u}) (Hare 2020).`)
    // A two-line underlined link: the per-line underline tags interleave with the link brackets (ODL bench 157).
    assert.equal(mergeLinkRuns(`the chapter, <u>[Our</u> <u>Mental Shortcuts](${u})</u>, that`), `the chapter, [Our Mental Shortcuts](${u}), that`)
    // Different targets and images stay apart.
    assert.equal(mergeLinkRuns(`[a](https://a.org) [b](https://b.org) ![image](image_001.png)`), `[a](https://a.org) [b](https://b.org) ![image](image_001.png)`)
  })

  it("keeps only the text when the link text is the address itself", () => {
    // ODL bench 158·192: the printed address is the link, so [address](address) only repeats it
    assert.equal(mergeLinkRuns("Video: [//www.youtube.com/embed/UBVV8pch1dM](http://www.youtube.com/embed/UBVV8pch1dM)"), "Video: //www.youtube.com/embed/UBVV8pch1dM")
    assert.equal(mergeLinkRuns("2023. [https://huggingface.co/spaces/ HuggingFaceH4/open\\_llm\\_leaderboard.](https://huggingface.co/spaces/HuggingFaceH4/open_llm_leaderboard)"),
      "2023. https://huggingface.co/spaces/ HuggingFaceH4/open\\_llm\\_leaderboard.")
    assert.equal(mergeLinkRuns("<u>[www.law.gov](http://www.law.gov/)</u> · [law@loc.gov](mailto:law@loc.gov)"), "www.law.gov · law@loc.gov")
    assert.equal(mergeLinkRuns("[https://a.org/(x)](https://a.org/%28x%29)"), "https://a.org/(x)")
    // A different target or ordinary link text keeps the link.
    assert.equal(mergeLinkRuns("[https://a.org](https://b.org) [this](https://a.org) [a.org guide](https://a.org)"),
      "[https://a.org](https://b.org) [this](https://a.org) [a.org guide](https://a.org)")
  })
})

describe("PDF gutter scans on corrupted coordinates", () => {
  it("finishes when a bit-flipped item has an absurd x extent", async () => {
    const { detectPanelGutters } = await import("../src/pdf/two-column.js")
    const rects = Array.from({ length: 12 }, (_, i) => ({ x: 50 + (i % 3) * 200, y: 700 - Math.floor(i / 3) * 20, w: 150, h: 10 }))
    rects.push({ x: 60, y: 100, w: 1e30, h: 10 })
    const t = performance.now()
    detectPanelGutters(rects)
    assert.ok(performance.now() - t < 1000)
  })
})
