import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS, ImageKind } from "../src/pdf/ops.js"
import { restoreImageBullets } from "../src/pdf/image-bullets.js"
import type { NormItem } from "../src/pdf/text-line.js"
const item = (text: string, y: number): NormItem => ({ text, x: 100, y, w: 290, h: 11, fontSize: 11, fontName: "Body", isHidden: false })
function circle(colored = false, filled = false, darkBackground = false) {
  const size = 40, data = new Uint8Array(size * size * 3)
  data.fill(darkBackground ? 100 : 255)
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const radius = Math.hypot(x - 20, y - 20)
    if (filled ? radius <= 12 : radius >= 10 && radius <= 12) {
      const offset = (y * size + x) * 3
      data.set(colored ? [20, 90, 170] : [130, 130, 130], offset)
    }
  }
  return { width: size, height: size, kind: ImageKind.RGB_24BPP, data }
}
const page = (image: ReturnType<typeof circle>) => {
  const objects = { get: (_id: string, callback?: (value: unknown) => void) => callback ? callback(image) : image }
  return { objs: objects, commonObjs: objects }
}
const ops = (x = 86, width = 11, ys = [500, 440]) => ({
  fnArray: ys.flatMap(() => [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]),
  argsArray: ys.flatMap(y => [[], [width, 0, 0, width, x, y], ["icon", 40, 40], []]),
})

describe("geometrically proven raster list bullets", () => {
  it("restores every repeated hollow-circle paint beside aligned text lines", async () => {
    const items = [item("First explanatory paragraph preserves its words.", 500), item("Second explanatory paragraph preserves its words.", 440)]
    const o = ops()
    assert.equal(await restoreImageBullets(items, page(circle()), o.fnArray, o.argsArray), 2)
    assert.deepEqual(items.filter(i => i.text === "○").map(i => i.y), [500, 440])
    assert.deepEqual(items.filter(i => i.text !== "○").map(i => i.text), ["First explanatory paragraph preserves its words.", "Second explanatory paragraph preserves its words."])
  })
  it("keeps a standalone logo and a circular illustration without repeated list evidence", async () => {
    const o = ops(86, 11, [500])
    assert.equal(await restoreImageBullets([item("A long line beside a standalone logo.", 500)], page(circle()), o.fnArray, o.argsArray), 0)
  })
  it("rejects colored icons, solid circular photos and non-white backgrounds", async () => {
    for (const image of [circle(true), circle(false, true), circle(false, false, true)]) {
      const o = ops()
      assert.equal(await restoreImageBullets([item("First explanatory line remains unchanged.", 500), item("Second explanatory line remains unchanged.", 440)], page(image), o.fnArray, o.argsArray), 0)
    }
  })
  it("rejects large images and images too far from the line", async () => {
    for (const o of [ops(40), ops(60, 35), ops(86, 11, [520, 460])]) {
      assert.equal(await restoreImageBullets([item("First explanatory line remains unchanged.", 500), item("Second explanatory line remains unchanged.", 440)], page(circle()), o.fnArray, o.argsArray), 0)
    }
  })
  it("keeps circular diagram labels and differently indented lines", async () => {
    const o = ops()
    assert.equal(await restoreImageBullets([item("Label A", 500), item("Label B", 440)], page(circle()), o.fnArray, o.argsArray), 0)
    const shifted = item("Second explanatory line remains unchanged.", 440)
    shifted.x = 107
    assert.equal(await restoreImageBullets([item("First explanatory line remains unchanged.", 500), shifted], page(circle()), o.fnArray, o.argsArray), 0)
  })
  it("rejects high-resolution pictures before requesting decoded pixels", async () => {
    const o = ops()
    for (let i = 2; i < o.argsArray.length; i += 4) o.argsArray[i] = ["icon", 2048, 2048]
    let resolved = 0
    const objects = { get: () => { resolved++; return undefined } }
    assert.equal(await restoreImageBullets([item("First explanatory line remains unchanged.", 500), item("Second explanatory line remains unchanged.", 440)], { objs: objects, commonObjs: objects }, o.fnArray, o.argsArray), 0)
    assert.equal(resolved, 0)
  })
  it("caches an image classification across repeated pages", async () => {
    const image = circle(), cache = new Map<string, boolean>()
    let resolved = 0
    const objects = { get: (_id: string, callback?: (value: unknown) => void) => { resolved++; callback?.(image); return image } }
    const o = ops()
    for (let n = 0; n < 2; n++) await restoreImageBullets([item("First explanatory line remains unchanged.", 500), item("Second explanatory line remains unchanged.", 440)], { objs: objects, commonObjs: objects }, o.fnArray, o.argsArray, cache)
    assert.equal(resolved, 1)
  })
  it("does not duplicate a text-layer bullet", async () => {
    const o = ops()
    assert.equal(await restoreImageBullets([item("○ First explanatory line already has a marker.", 500), item("○ Second explanatory line already has a marker.", 440)], page(circle()), o.fnArray, o.argsArray), 0)
  })
})

describe("raster bullet visibility", () => {
  const prose = () => [item("First explanatory line remains unchanged.", 500), item("Second explanatory line remains unchanged.", 440)]
  it("does not recover invisible alpha-zero or clipped-away images", async () => {
    for (const setup of [
      { f: [OPS.setGState], a: [[[["ca", 0], ["CA", 0]]]] },
      { f: [OPS.constructPath, OPS.clip, OPS.endPath], a: [[[OPS.rectangle], [0, 0, 1, 1]], [], []] },
    ]) {
      const o = ops()
      assert.equal(await restoreImageBullets(prose(), page(circle()), [...setup.f, ...o.fnArray], [...setup.a, ...o.argsArray]), 0)
    }
  })
  it("allows a one-pixel crop of the proven white image margin", async () => {
    const o = ops()
    assert.equal(await restoreImageBullets(prose(), page(circle()), [OPS.constructPath, OPS.clip, OPS.endPath, ...o.fnArray], [[[OPS.rectangle], [86.2, 440.2, 10.6, 70.6]], [], [], ...o.argsArray]), 2)
  })
  it("restores visibility after a saved transparency state", async () => {
    const o = ops()
    assert.equal(await restoreImageBullets(prose(), page(circle()), [OPS.save, OPS.setGState, OPS.restore, ...o.fnArray], [[], [[["ca", 0]]], [], ...o.argsArray]), 2)
  })
  it("keeps partial and complex clips conservative", async () => {
    const o = ops()
    for (const path of [[[OPS.rectangle], [86, 440, 4, 80]], [[OPS.moveTo, OPS.lineTo, OPS.lineTo, OPS.closePath], [86, 440, 97, 440, 97, 520]]]) {
      assert.equal(await restoreImageBullets(prose(), page(circle()), [OPS.constructPath, OPS.clip, OPS.endPath, ...o.fnArray], [path, [], [], ...o.argsArray]), 0)
    }
  })
  it("applies Form bounding clips and restores the parent state", async () => {
    const o = ops()
    assert.equal(await restoreImageBullets(prose(), page(circle()), [OPS.paintFormXObjectBegin, ...o.fnArray, OPS.paintFormXObjectEnd], [[null, [0, 0, 1, 1]], ...o.argsArray, []]), 0)
    assert.equal(await restoreImageBullets(prose(), page(circle()), [OPS.paintFormXObjectBegin, OPS.setGState, OPS.paintFormXObjectEnd, ...o.fnArray], [[null, [0, 0, 1, 1]], [[["ca", 0]]], [], ...o.argsArray]), 2)
  })
})

describe("raster markers next to a numbered prose list", () => {
  it("recovers a single circle when explicit same-style numbered text proves the list column", async () => {
    const o = ops(86, 11, [440])
    const one = item("① First explanatory paragraph in the original list.", 560), two = item("② Second explanatory paragraph in the original list.", 520)
    one.x = two.x = 86
    assert.equal(await restoreImageBullets([one, two, item("A final instruction preserves its words.", 440)], page(circle()), o.fnArray, o.argsArray), 1)
  })
  it("rejects unrelated numbers with a different font, column or nonsequential order", async () => {
    for (const mode of ["font", "column", "sequence", "hidden"]) {
      const o = ops(86, 11, [440])
      const one = item("① First explanatory paragraph in the original list.", 560), two = item("② Second explanatory paragraph in the original list.", 520)
      one.x = two.x = mode === "column" ? 130 : 86
      if (mode === "hidden") one.isHidden = two.isHidden = true
      if (mode === "font") one.fontName = two.fontName = "Title"
      if (mode === "sequence") two.text = two.text.replace("②", "④")
      assert.equal(await restoreImageBullets([one, two, item("A final instruction preserves its words.", 440)], page(circle()), o.fnArray, o.argsArray), 0)
    }
  })
})
