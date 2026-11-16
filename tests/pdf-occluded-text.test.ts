/** 뒤에 칠한 불투명 사각형에 가려진 글 · 장 번호 제목 (ODL 079·080·021) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { occludedTextItems } from "../src/pdf/occluded-text.js"
import { detectHeadings } from "../src/pdf/block-detect.js"
import type { PdfTextItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

const glyphs = (s: string) => [...s].map(unicode => ({ unicode }))
const item = (str: string, x: number, y: number, w: number): PdfTextItem => ({ str, transform: [10, 0, 0, 10, x, y], width: w, height: 10 })

describe("occludedTextItems", () => {
  const header = item("Header 6", 100, 798, 60)
  const body = item("Body", 100, 700, 30)

  it("hides text drawn before an opaque full-page fill, keeps text drawn after it", () => {
    const fn = [OPS.showText, OPS.save, OPS.constructPath, OPS.fill, OPS.restore, OPS.showText]
    const args = [[glyphs("Header 6")], [], [[OPS.rectangle], [0, 0, 595, 842]], [], [], [glyphs("Body")]]
    const hidden = occludedTextItems([header, body], fn, args)
    assert.deepEqual([...hidden], [header])
  })

  it("keeps text under a translucent or blended fill", () => {
    const fn = [OPS.showText, OPS.setGState, OPS.constructPath, OPS.fill, OPS.showText]
    for (const gs of [[["ca", 0.5]], [["BM", "Multiply"]]]) {
      const args = [[glyphs("Header 6")], [gs], [[OPS.rectangle], [0, 0, 595, 842]], [], [glyphs("Body")]]
      assert.equal(occludedTextItems([header, body], fn, args).size, 0)
    }
  })

  it("leaves items alone when their text does not line up with the drawn glyphs", () => {
    const fn = [OPS.showText, OPS.constructPath, OPS.fill, OPS.showText]
    const args = [[glyphs("Other")], [[OPS.rectangle], [0, 0, 595, 842]], [], [glyphs("Body")]]
    assert.equal(occludedTextItems([header, body], fn, args).size, 0)
  })
  it("clips Form fills to the Form BBox", () => {
    const outside = item("Outside", 10, 10, 40), inside = item("Inside", 110, 110, 30)
    const fn = [OPS.showText, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd]
    const args = [[glyphs("OutsideInside")], [null, [100, 100, 200, 200]], [[OPS.rectangle], [0, 0, 300, 300]], [], []]
    assert.deepEqual([...occludedTextItems([outside, inside], fn, args)], [inside])
  })

  it("transforms the Form BBox and intersects it with the parent clip", () => {
    const outside = item("Outside", 130, 110, 30), inside = item("Inside", 180, 110, 20)
    const fn = [OPS.showText, OPS.constructPath, OPS.clip, OPS.endPath, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd]
    const args = [[glyphs("OutsideInside")], [[OPS.rectangle], [170, 0, 100, 300]], [], [], [[2, 0, 0, 1, 100, 100], [10, 0, 80, 100]], [[OPS.rectangle], [-100, -100, 400, 400]], [], []]
    assert.deepEqual([...occludedTextItems([outside, inside], fn, args)], [inside])
  })

  it("restores the outer clip after nested Forms and the page clip after leaving them", () => {
    const outer = item("Outer", 110, 110, 30), page = item("Page", 10, 10, 30)
    const fn = [OPS.showText, OPS.paintFormXObjectBegin, OPS.paintFormXObjectBegin, OPS.paintFormXObjectEnd,
      OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd, OPS.constructPath, OPS.fill]
    const args = [[glyphs("OuterPage")], [null, [100, 100, 200, 200]], [null, [150, 150, 200, 200]], [],
      [[OPS.rectangle], [0, 0, 300, 300]], [], [], [[OPS.rectangle], [0, 0, 60, 60]], []]
    assert.deepEqual([...occludedTextItems([outer, page], fn, args)], [outer, page])
  })

  it("does not approximate a skewed Form clip with its bounding rectangle", () => {
    const outside = item("Outside", 105, 190, 10)
    const fn = [OPS.showText, OPS.paintFormXObjectBegin, OPS.constructPath, OPS.fill, OPS.paintFormXObjectEnd]
    const args = [[glyphs("Outside")], [[1, 0, 1, 1, 100, 100], [0, 0, 100, 100]], [[OPS.rectangle], [-200, -200, 600, 600]], [], []]
    assert.equal(occludedTextItems([outside], fn, args).size, 0)
  })

})

describe("chapter number heading", () => {
  it("promotes a large lone number standing right above a display title", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "2", pageNumber: 1, bbox: { page: 1, x: 204, y: 503, width: 15, height: 30 }, style: { fontSize: 30, fontName: "a" } },
      { type: "paragraph", text: "The Lost Homeland", pageNumber: 1, bbox: { page: 1, x: 114, y: 462, width: 195, height: 24 }, style: { fontSize: 24, fontName: "a" } },
      { type: "paragraph", text: "5", pageNumber: 1, bbox: { page: 1, x: 390, y: 40, width: 4, height: 8 }, style: { fontSize: 30, fontName: "a" } },
    ]
    detectHeadings(blocks, 11)
    assert.deepEqual(blocks.map(b => b.type), ["heading", "heading", "paragraph"])
  })
})
