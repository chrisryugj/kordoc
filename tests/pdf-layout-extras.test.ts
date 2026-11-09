import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { glyphNameText, remapControlGlyphs, restoreNamedGlyphs, restoreUnmappedCidSpaces } from "../src/pdf/glyph-names.js"
import { detectPanelGutters, orderByPanels } from "../src/pdf/two-column.js"
import { splitSingleCellTables } from "../src/pdf/text-clean.js"
import { bridgeSkippedRowVerticals } from "../src/pdf/vertical-bridge.js"
import { demoteNonHeadingRoles } from "../src/pdf/heading-demote.js"
import type { LineSegment } from "../src/pdf/line-types.js"
import type { NormItem, PdfTextItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })
const item = (text: string, x: number, y: number, w = text.length * 5, fontName = "Body", fontSize = 9): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName, isHidden: false })

describe("unmapped CID spaces", () => {
  const g = (code: number, unicode: string, width: number) => ({ originalCharCode: code, unicode, width })
  const raw = (str: string, fontName = "F1"): PdfTextItem => ({ str, transform: [10, 0, 0, 10, 0, 0], width: 50, height: 10, fontName })
  const toUni: (string | undefined)[] = []
  toUni[1] = " "; toUni[0x284c] = "가"; toUni[0x2850] = "간"
  const cid = { composite: true, toUnicode: { _map: toUni } }

  it("turns a space-width glyph missing from ToUnicode back into a space (Print To PDF \"堺\")", () => {
    const items = [raw("가堺간 가"), raw("堺", "F2")]
    const n = restoreUnmappedCidSpaces(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 10], [[g(0x284c, "가", 1000), g(0x583a, "堺", 280), g(0x2850, "간", 1000), g(1, " ", 227), g(0x284c, "가", 1000)]],
        ["F2", 10], [[g(0x583a, "堺", 280)]]],
      n => (n === "F1" ? cid : undefined))
    assert.equal(n, 1)
    assert.equal(items[0].str, "가 간 가")
    assert.equal(items[1].str, "堺") // 단순 글꼴(composite 아님)은 손대지 않는다
  })

  it("leaves wide unmapped glyphs and fonts without a mapped space alone", () => {
    const wide = [raw("가堺")]
    restoreUnmappedCidSpaces(wide, [OPS.setFont, OPS.showText], [["F1", 10], [[g(0x284c, "가", 1000), g(0x583a, "堺", 1000), g(1, " ", 227)]]], () => cid)
    assert.equal(wide[0].str, "가堺")
    const noSpace = { composite: true, toUnicode: { _map: toUni.map((v, i) => (i === 1 ? undefined : v)) } }
    const items = [raw("가堺")]
    restoreUnmappedCidSpaces(items, [OPS.setFont, OPS.showText], [["F1", 10], [[g(0x284c, "가", 1000), g(0x583a, "堺", 280)]]], () => noSpace)
    assert.equal(items[0].str, "가堺")
  })
})

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

  // 연산자 목록 글리프 흉내 — pdfjs showText 인자는 글리프 객체와 자간 숫자가 섞인 배열
  const glyph = (code: number, unicode: string) => ({ originalCharCode: code, unicode })
  const raw = (str: string, fontName = "F1"): PdfTextItem => ({ str, transform: [10, 0, 0, 10, 0, 0], width: 50, height: 10, fontName })

  it("restores small caps and tab/C1 glyph codes from the operator list (ODL 005·010)", () => {
    const diffs: string[] = []
    diffs[9] = "nine.oldstyle"; diffs[129] = "F.a"; diffs[30] = "h.smcp"
    const items = [raw("IG 1 6h.")]
    const n = restoreNamedGlyphs(items, [OPS.setFont, OPS.showText], [["F1", 10],
      [[glyph(129, ""), glyph(73, "I"), glyph(71, "G"), glyph(32, " "), glyph(49, "1"), glyph(9, "\t"), glyph(54, "6"), -20, glyph(30, "h"), glyph(46, ".")]]], () => diffs)
    assert.equal(n, 1)
    assert.equal(items[0].str, "FIG 196H.")
  })

  it("puts a named whitespace glyph that left no space at the end of the previous item (ODL 006 page 19)", () => {
    const diffs: string[] = []
    diffs[9] = "nine.oldstyle"; diffs[129] = "F.a"
    const items = [raw("1"), raw(""), raw("IG")]
    restoreNamedGlyphs(items, [OPS.setFont, OPS.showText], [["F1", 10], [[glyph(49, "1"), glyph(9, "\t"), glyph(129, ""), glyph(73, "I"), glyph(71, "G")]]], () => diffs)
    assert.deepEqual(items.map(it => it.str), ["19", "", "FIG"])
  })

  it("restores digits a ToUnicode map sends to U+FFFD from their glyph names (ODL 001 \"3\uFFFD4\" → \"314\")", () => {
    const diffs: string[] = []
    diffs[19] = "one.SP"
    const items = [raw("3\uFFFD4")]
    restoreNamedGlyphs(items, [OPS.setFont, OPS.showText], [["F1", 10], [[glyph(51, "3"), glyph(19, "\uFFFD"), glyph(52, "4")]]], () => diffs)
    assert.equal(items[0].str, "314")
  })

  it("reads re-encoded TeX CM math fonts by their original symbols, even past a trailing gap space (ODL 029~031)", () => {
    const diffs: string[] = []
    diffs[31] = "thorn"; diffs[30] = "onequarter"; diffs[29] = "C0"; diffs[28] = "eth"; diffs[27] = "Thorn"
    const items = [raw("\u00FE"), raw("\u00BC"), raw("\uFFFD"), raw("\u00F0\u00DE"), raw(" "), raw("=", "F2")]
    restoreNamedGlyphs(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 10], [[glyph(31, "\u00FE"), glyph(30, "\u00BC"), glyph(29, "\uFFFD"), glyph(28, "\u00F0"), glyph(27, "\u00DE")]], ["F2", 10], [[glyph(61, "=")]]],
      name => name === "F1" ? diffs : undefined, name => name === "F1" ? "EEKVNO+TeXCMMathsSymbols" : "EEKVNO+TeXCMMathsItalic")
    assert.deepEqual(items.map(it => it.str), ["+", "=", "\u2212", "()", " ", "/"])
  })

  it("leaves a font untouched when its glyphs cannot be aligned, and fonts without named glyphs alone", () => {
    const diffs: string[] = []
    diffs[30] = "h.smcp"
    const items = [raw("h"), raw("xyz"), raw("h", "F2")]
    const n = restoreNamedGlyphs(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 10], [[glyph(30, "h"), glyph(97, "a")]], ["F2", 10], [[glyph(30, "h")]]], name => name === "F1" ? diffs : undefined)
    assert.equal(n, 0)
    assert.deepEqual(items.map(it => it.str), ["h", "xyz", "h"])
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

  it("leaves a merged label row alone when a column between the gaps is empty — 예산 \"합 계\" 행", () => {
    const hs = [h(400, 100, 400), h(380, 100, 400), h(360, 100, 400), h(340, 100, 400)]
    const vs: LineSegment[] = []
    for (const x of [100, 200, 300, 400]) vs.push(v(x, 380, 400), v(x, 340, 360))
    // 합친 칸 글은 가운데 칸 하나, 오른쪽 칸은 비었다 — 줄무늬 표의 흰 행이 아니라 선 없이 합친 칸
    assert.equal(bridgeSkippedRowVerticals(hs, vs, [item("합계", 140, 365, 20)]).length, vs.length)
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
