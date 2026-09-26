import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractPageBlocksFallback } from "../src/pdf/page-blocks.js"
import { detectDocumentStyleHeadings, detectSiblingStyleHeadings, detectRepeatedPageLabels, detectPageLeadHeadings, refineDocumentStyleHeadings } from "../src/pdf/block-detect.js"
import { mergeOcrImageRegions } from "../src/pdf/ocr-region-merge.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

function item(text: string, x: number, y: number, w: number, fontSize = 11, fontName = "Body"): NormItem {
  return { text, x, y, w, h: fontSize, fontSize, fontName, isHidden: false }
}

describe("PDF region and title boundaries", () => {
  it("keeps the text layer while inserting an OCR table into an uncovered image region", () => {
    const above: IRBlock = { type: "paragraph", text: "Original introduction above the image", pageNumber: 1,
      bbox: { page: 1, x: 60, y: 610, width: 400, height: 30 } }
    const below: IRBlock = { type: "paragraph", text: "Original instructions below the image", pageNumber: 1,
      bbox: { page: 1, x: 60, y: 300, width: 400, height: 30 } }
    const table: IRBlock = { type: "table", pageNumber: 1, bbox: { page: 1, x: 80, y: 425, width: 400, height: 130 },
      table: { rows: 2, cols: 2, cells: [[{ text: "Field A" }, { text: "Field B" }], [{ text: "1" }, { text: "2" }]] } }
    const blocks = [above, below]
    assert.equal(mergeOcrImageRegions(blocks, 1, [{ x1: 70, y1: 420, x2: 500, y2: 570 }], [table]), 1)
    assert.deepEqual(blocks, [above, table, below])
    assert.equal(mergeOcrImageRegions(blocks, 1, [{ x1: 70, y1: 420, x2: 500, y2: 570 }], [table]), 0)
  })

  it("uses document prose style to restore a short section title amid other headings", () => {
    const b = (text: string, face: string, y: number, height = 12): IRBlock => ({ type: "paragraph", text, pageNumber: 1,
      bbox: { page: 1, x: 70, y, width: 230, height }, style: { fontName: face, fontSize: 12 } })
    const blocks = [b("A complete earlier paragraph with ordinary body text. ".repeat(8), "Body", 500, 90),
      b("Section overview", "Display", 465),
      b("The next section contains a substantial paragraph of ordinary prose. ".repeat(8), "Body", 300, 150)]
    refineDocumentStyleHeadings(blocks)
    assert.equal(blocks[1].type, "heading")
  })
  it("reads staggered infographic cards one column at a time", () => {
    const items = [item("Semantic Search Pack", 70, 500, 300, 20, "Title"),
      item("The product helps users find more information from their searches.", 70, 450, 540),
      item("A longer introductory sentence about search technology and business data.", 70, 390, 550),
      item("Another introductory sentence describing the product's value.", 70, 320, 550)]
    for (let c = 0; c < 3; c++) {
      const x = [95, 370, 662][c]
      items.push(item(`Card ${c + 1} provides a distinct benefit`, x, 250 - c * 5, 225, 15, "CardTitle"))
      for (let r = 0; r < 4; r++) items.push(item(`Card ${c + 1} body line ${r} explains the benefit with enough words to be distinct.`, x, 185 - r * 16, 225))
    }
    items.push(item("22", 928, 20, 10))
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    assert.ok(blocks.some(b => b.text?.includes("Card 1 body line 0")))
    assert.ok(blocks.some(b => b.text?.includes("Card 2 body line 0")))
    assert.ok(blocks.some(b => b.text?.includes("Card 3 body line 0")))
    assert.ok(blocks.every(b => !b.text?.includes("Card 1 body line 0") || !b.text?.includes("Card 2 body line 0")))
  })

  it("marks an illustrated page title without marking a numbered running header", () => {
    const paragraph = (text: string, y: number): IRBlock => ({ type: "paragraph", text, pageNumber: 1,
      bbox: { page: 1, x: 54, y, width: 340, height: 12 }, style: { fontName: "Body", fontSize: 12 } })
    const title = paragraph("Print vs. Digital", 716)
    const prose = paragraph("Why do readers choose print or digital material? This extended paragraph explains their choices and preferences.", 666)
    const image: IRBlock = { type: "image", text: "figure.png", pageNumber: 1 }
    detectPageLeadHeadings([title, prose, image])
    assert.equal(title.type, "heading")
    const header = paragraph("12 Encinas Franco and Laguna", 716)
    const caption = paragraph("Table 1: Percentage of Government Positions Held by Women During the Presidencies of two leaders", 666)
    detectPageLeadHeadings([header, caption, image])
    assert.equal(header.type, "paragraph")
  })

  it("recognizes a repeated numbered title series", () => {
    const blocks: IRBlock[] = []
    for (let n = 1; n <= 4; n++) blocks.push({ type: "paragraph", text: `0${n} - Instruction section ${n}`, pageNumber: 1,
      bbox: { page: 1, x: 70, y: 700 - n * 40, width: 190, height: 11 }, style: { fontName: "Label", fontSize: 11 } })
    blocks.push({ type: "paragraph", text: "A long body paragraph explaining the steps with enough words to establish the body typeface across this page.", pageNumber: 1,
      bbox: { page: 1, x: 70, y: 470, width: 300, height: 22 }, style: { fontName: "Body", fontSize: 11 } })
    detectRepeatedPageLabels(blocks)
    assert.equal(blocks.filter(b => b.type === "heading").length, 4)
  })

  it("promotes repeated styled titles across both document columns", () => {
    const heading = (text: string, x: number, y: number): IRBlock => ({ type: "heading", level: 2, text, pageNumber: 1,
      bbox: { page: 1, x, y, width: 110, height: 12 }, style: { fontName: "Bold", fontSize: 12 } })
    const paragraph = (text: string, x: number, y: number, face = "Bold"): IRBlock => ({ type: "paragraph", text, pageNumber: 1,
      bbox: { page: 1, x, y, width: 180, height: 12 }, style: { fontName: face, fontSize: 12 } })
    const blocks = [heading("Acknowledgements", 71, 760), paragraph("Limitations", 71, 539),
      paragraph("A longer body paragraph with enough words to establish the main face for this page and its surrounding prose.", 71, 500, "Body"),
      paragraph("Ethics Statement", 306, 735), heading("References", 306, 296)]
    detectSiblingStyleHeadings(blocks)
    assert.equal(blocks.find(b => b.text === "Limitations")?.type, "heading")
    assert.equal(blocks.find(b => b.text === "Ethics Statement")?.type, "heading")
  })

  it("separates captioned stacked tables from two-column body text", () => {
    const items: NormItem[] = []
    const table = (top: number, rows: number) => {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < 6; c++) items.push(item(r === 0 ? `Header ${c}` : `Value ${r}-${c}`, 80 + c * 77, top - r * 12, 45, 8, "Table"))
      }
    }
    table(760, 4)
    items.push(item("Table 3: First ablation study with explanatory caption", 70, 691, 440, 9))
    table(646, 3)
    items.push(item("Table 4: Second ablation study with explanatory caption", 70, 579, 440, 9))
    table(534, 3)
    items.push(item("Table 5: Third ablation study with explanatory caption", 70, 478, 440, 9))
    for (let r = 0; r < 12; r++) {
      items.push(item(`Left paragraph ${r} with longer prose for the document body`, 70, 428 - r * 22, 220))
      items.push(item(`Right paragraph ${r} with longer prose for the document body`, 306, 428 - r * 22, 220))
    }
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    assert.equal(blocks.filter(b => b.type === "table").length, 3)
    assert.ok(blocks.some(b => b.text?.startsWith("Table 3:")))
    assert.ok(blocks.some(b => b.text?.includes("Left paragraph 0")))
    assert.ok(blocks.some(b => b.text?.includes("Right paragraph 0")))
  })

  it("keeps a compact seven-column table above two-column prose intact", () => {
    const rows: Array<Array<[number, number, string]>> = [
      [[315, 51, "Training Datasets"]],
      [[103, 29, "Properties"], [222, 31, "Instruction"], [402, 31, "Alignment"]],
      [[165, 40, "Alpaca-GPT4"], [213, 30, "OpenOrca"], [250, 60, "Synth. Math-Instruct"], [319, 46, "Orca DPO Pairs"], [373, 66, "Ultrafeedback Cleaned"], [447, 69, "Synth. Math-Alignment"]],
      [[95, 46, "Total # Samples"], [179, 12, "52K"], [218, 19, "2.91M"], [273, 16, "126K"], [333, 18, "12.9K"], [397, 18, "60.8K"], [474, 16, "126K"]],
      [[79, 78, "Maximum # Samples Used"], [179, 12, "52K"], [220, 16, "100K"], [274, 12, "52K"], [333, 18, "12.9K"], [397, 18, "60.8K"], [473, 18, "20.1K"]],
      [[99, 37, "Open Source"], [182, 5, "O"], [225, 5, "O"], [279, 4, "✗"], [339, 5, "O"], [404, 5, "O"], [480, 4, "✗"]],
    ]
    const ys = [762, 753, 741, 728, 719, 710]
    const items = rows.flatMap((row, r) => row.map(([x, w, text]) => item(text, x, ys[r], w, 7, "Table")))
    items.push(item("A full-width caption describing the table", 71, 687, 450))
    for (let r = 0; r < 20; r++) {
      items.push(item(`Left paragraph ${r} with enough words to fill a prose column`, 70, 580 - r * 24, 220))
      items.push(item(`Right paragraph ${r} with enough words to fill a prose column`, 306, 574 - r * 24, 220))
    }
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1)
    assert.equal(tables[0].table?.cols, 7)
    assert.equal(tables[0].table?.rows, 6)
    assert.equal(tables[0].table?.cells[0][0].rowSpan, 3)
    assert.equal(tables[0].table?.cells[0][1].colSpan, 6)
    assert.ok(blocks.some(b => b.text?.includes("Left paragraph 0")))
    assert.ok(blocks.some(b => b.text?.includes("Right paragraph 0")))
  })

  it("separates three styled card labels from their values", () => {
    const items = [
      item("A large introductory title", 70, 470, 450, 22, "Title"),
      item("Our Purpose", 69, 300, 66, 13, "Label"),
      item("Our Mission", 313, 300, 64, 13, "Label"),
      item("What We Do", 545, 300, 68, 13, "Label"),
      item("Making AI Beneficial", 69, 260, 149, 18, "Value"),
      item("Easy-to-apply AI", 313, 260, 123, 18, "Value"),
      item("Providing useful AI solutions", 545, 260, 311, 18, "Value"),
      item("• A service bullet with a longer description of the solution", 545, 192, 250, 11, "Bullet"),
      item("• Another service bullet with a longer description of the solution", 545, 175, 260, 11, "Bullet"),
      item("• A third service bullet with a longer description of the solution", 545, 159, 260, 11, "Bullet"),
      item("3", 933, 21, 5, 10, "Footer"),
    ]
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    detectDocumentStyleHeadings(blocks)
    for (const label of ["Our Purpose", "Our Mission", "What We Do"]) {
      assert.ok(blocks.some(b => b.type === "heading" && b.text === label), label)
    }
    assert.ok(blocks.some(b => b.text === "Making AI Beneficial"))
  })

  it("joins a numbered title and styled subtitle without absorbing the body", () => {
    const items = [
      item("1. Shipping as a vector for marine IAS", 90, 687, 194, 12, "Bold"),
      item("List of Philippine Ports is in Appendix 3", 72, 665, 191, 12, "Italic"),
    ]
    for (let r = 0; r < 15; r++) {
      items.push(item(`Ordinary body prose line ${r} with several words about marine movement.`, 72, 643 - r * 22, 201, 12, "Body"))
    }
    const blocks = extractPageBlocksFallback(items, 1, true, true)
    detectDocumentStyleHeadings(blocks)
    assert.equal(blocks[0].type, "heading")
    assert.equal(blocks[0].text, "1. Shipping as a vector for marine IAS List of Philippine Ports is in Appendix 3")
    assert.ok(blocks[1].text?.startsWith("Ordinary body prose"))
  })
})
