import { it } from "node:test"
import assert from "node:assert/strict"
import { parse } from "../src/index.js"
import { parsePdfDocument } from "../src/pdf/parser.js"

function pdfWithSmallCapAndCover(content = "BT /F1 12 Tf 60 700 Td (h) Tj ET BT /F2 12 Tf 60 600 Td (Hidden) Tj ET 1 g 50 590 100 40 re f BT /F2 12 Tf 60 500 Td (Visible body text remains on this page.) Tj ET"): ArrayBuffer {
  const cmap = "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def /CMapName /SmallCap def /CMapType 2 def 1 begincodespacerange <00> <FF> endcodespacerange 2 beginbfchar <68> <0068> <71> <0000> endbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
  const stream = (s: string) => `<< /Length ${s.length} >>\nstream\n${s}\nendstream`
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 7 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding << /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [104 /h.smcp] >> /ToUnicode 6 0 R >>",
    stream(content), stream(cmap), "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ]
  let pdf = "%PDF-1.4\n"
  const offsets: number[] = []
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
  }
  const xref = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) pdf += String(offset).padStart(10, "0") + " 00000 n \n"
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`
  const bytes = Buffer.from(pdf, "latin1")
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

it("filters covered text even when an earlier small-cap glyph is restored", async () => {
  const result = await parse(pdfWithSmallCapAndCover(), { ocr: false, removeHeaderFooter: false })
  assert.ok(result.success)
  assert.equal(result.markdown, "H\n\nVisible body text remains on this page.")
  assert.ok(result.warnings?.some(w => w.code === "HIDDEN_TEXT_FILTERED"))
})

it("builds the outline after sanitizing the final heading text", async () => {
  const content = "BT /F1 24 Tf 60 700 Td (hq) Tj ET BT /F2 12 Tf 60 600 Td (Normal body text provides the base font size.) Tj ET BT /F2 12 Tf 60 580 Td (Another body line on the same page.) Tj ET"
  const result = await parsePdfDocument(pdfWithSmallCapAndCover(content), { ocr: false, removeHeaderFooter: false })
  const title = result.blocks.find(b => b.type === "heading")
  assert.equal(title?.text, "H")
  assert.deepEqual(result.outline, [{ level: title!.level, text: "H", pageNumber: 1 }])
})
