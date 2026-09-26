import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { attachDropCaps, splitSidebarTitleRegion, splitTrailingColumnRegion } from "../src/pdf/local-regions.js"
import { mergeLineSimple, type NormItem } from "../src/pdf/text-line.js"

function item(text: string, x: number, y: number, w: number, size = 11): NormItem {
  return { text, x, y, w, h: size, fontSize: size, fontName: "Body", isHidden: false }
}

describe("PDF source-preserving local regions", () => {
  it("reads a short column pair below a separate full-width band without losing items", () => {
    const items = [item("running title", 55, 690, 400),
      item("A full-width caption describing the image", 55, 240, 420)]
    for (let row = 0; row < 7; row++) {
      items.push(item(`Left prose continues on visual row ${row} with enough words`, 55, 170 - row * 14, 210))
      items.push(item(`Right prose continues on visual row ${row} with enough words`, 281, 170 - row * 14, 210))
    }
    const regions = splitTrailingColumnRegion(items)
    assert.ok(regions)
    assert.equal(regions.length, 3)
    assert.equal(regions[1].length, 7)
    assert.equal(regions[2].length, 7)
    assert.equal(new Set(regions.flat()).size, items.length)
    assert.ok(items.every(source => regions.flat().includes(source)))
  })

  it("keeps a display sidebar before its separate long prose region", () => {
    const items = [item("running header", 99, 798, 124, 10),
      item("Section", 99, 718, 150, 34), item("Overview", 99, 676, 155, 34),
      item("7", 293, 30, 9, 10)]
    for (let row = 0; row < 26; row++) {
      items.push(item(`A substantial body sentence on row ${row} with enough content to establish prose.`, 307, 719 - row * 16, 190))
    }
    const regions = splitSidebarTitleRegion(items)
    assert.ok(regions)
    assert.deepEqual(regions.map(region => region.length), [1, 2, 26, 1])
    assert.equal(new Set(regions.flat()).size, items.length)
  })

  it("attaches a drop cap to the first line while preserving its original coordinates", () => {
    const first = [item("ndia", 339, 719, 21), item("suffers", 370, 719, 32)]
    const second = [item("cholesterol", 339, 703, 53)]
    const cap = item("I", 304, 687, 31, 77)
    const third = [cap, item("the way of doing business", 339, 687, 157)]
    const result = attachDropCaps([first, second, third])
    assert.equal(mergeLineSimple(result[0]), "India suffers")
    assert.equal(result[2].includes(cap), false)
    assert.equal(cap.y, 687)
    assert.equal(new Set(result.flat()).size, 5)
  })

  it("does not split a single column at ordinary word gaps", () => {
    const items = [item("header", 55, 690, 400), item("caption", 55, 240, 400)]
    for (let row = 0; row < 8; row++) {
      items.push(item("A body sentence with two parts", 55, 170 - row * 14, 155))
      items.push(item("and more text on the same line", 220, 170 - row * 14, 210))
    }
    assert.equal(splitTrailingColumnRegion(items), null)
  })
})
