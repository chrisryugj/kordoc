import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { glyphNameText, remapControlGlyphs, restoreNamedGlyphs } from "../src/pdf/glyph-names.js"
import type { NormItem, PdfTextItem } from "../src/pdf/text-line.js"
const item = (text: string): NormItem => ({ text, x: 72, y: 500, w: 10, h: 10, fontSize: 10, fontName: "font", isHidden: false })
describe("PDF named bullets and invalid scalar names", () => {
  it("restores named bullet controls before sanitation removes them", () => {
    const items = [item("\u0001 Item"), item("\u0002 Other")]
    assert.equal(remapControlGlyphs(items, () => [undefined, "bullet", "openbullet"]), 2)
    assert.deepEqual(items.map(i => i.text), ["• Item", "◦ Other"])
  })
  it("restores a bullet code returned as whitespace by pdfjs", () => {
    const items: PdfTextItem[] = [{ str: " Item", transform: [10, 0, 0, 10, 72, 500], width: 30, height: 10, fontName: "font" }]
    const diffs = [undefined, "bullet"]
    const glyphs = [{ originalCharCode: 1, unicode: " " }, ...Array.from("Item", c => ({ originalCharCode: c.charCodeAt(0), unicode: c }))]
    assert.equal(restoreNamedGlyphs(items, [OPS.setFont, OPS.showText], [["font", 10], [glyphs]], () => diffs), 1)
    assert.equal(items[0].str, "•Item")
  })
  it("rejects invalid Unicode scalar names without throwing or emitting surrogates", () => {
    for (const name of ["u110000", "uFFFFFF", "uD800", "uniDFFF"]) assert.equal(glyphNameText(name), undefined)
    assert.equal(glyphNameText("u1F600"), "😀")
    assert.equal(glyphNameText("uni0041"), "A")
  })
  it("leaves an invalid named control unchanged for normal cleanup", () => {
    const items = [item("\u0001")]
    assert.equal(remapControlGlyphs(items, () => [undefined, "uFFFFFF"]), 0)
    assert.equal(items[0].text, "\u0001")
  })
})
