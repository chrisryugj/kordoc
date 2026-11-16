import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { groupFlowBoxUnits, detectRightArrowRegions } from "../src/pdf/flow-boxes.js"
import type { IRBlock } from "../src/types.js"
import type { TableGrid, LineSegment } from "../src/pdf/line-types.js"
const grids: TableGrid[] = [0, 1, 2, 3].map(i => ({ rowYs: [560, 460], colXs: [60 + i * 80, 120 + i * 80], bbox: { x1: 60 + i * 80, x2: 120 + i * 80, y1: 460, y2: 560 }, vertexRadius: 1 }))
grids[3] = { ...grids[3], rowYs: [560, 530, 515, 460], colXs: [300, 330, 360] }
const hs: LineSegment[] = grids.flatMap(g => [g.bbox.y1, g.bbox.y2].map(y => ({ x1: g.bbox.x1, x2: g.bbox.x2, y1: y, y2: y, lineWidth: 1 })))
const vs: LineSegment[] = grids.flatMap(g => [g.bbox.x1, g.bbox.x2].map(x => ({ x1: x, x2: x, y1: g.bbox.y1, y2: g.bbox.y2, lineWidth: 1 })))
const images = [0, 1, 2].map(i => ({ x1: 124 + i * 80, x2: 136 + i * 80, y1: 505, y2: 515 }))
const text = (t: string, x: number, y: number): IRBlock => ({ type: "paragraph", text: t, pageNumber: 1, bbox: { page: 1, x, y, width: 40, height: 10 } })
const source = () => [text("Second box top", 150, 535), text("First box top", 70, 530), text("Third box top", 230, 530), text("Second box bottom", 150, 475), text("First box bottom", 70, 480), text("Third box bottom", 230, 480), { type: "table", pageNumber: 1, bbox: { page: 1, x: 300, y: 460, width: 60, height: 100 }, table: { rows: 2, cols: 2, hasHeader: false, cells: [[{ text: "Final result", colSpan: 2, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }], [{ text: "Yes", colSpan: 1, rowSpan: 1 }, { text: "No", colSpan: 1, rowSpan: 1 }]] } } as IRBlock]
describe("connected closed-box flow bands", () => {
  it("groups the entire band into left-to-right boxes with independent inner reading order", () => {
    const blocks = source(), before = JSON.stringify(blocks)
    const units = groupFlowBoxUnits(blocks, grids, hs, vs, images)
    assert.equal(units.length, 1)
    assert.deepEqual(units[0].map(b => b.text ?? b.type), ["First box top", "First box bottom", "Second box top", "Second box bottom", "Third box top", "Third box bottom", "table"])
    assert.equal(JSON.stringify(blocks), before)
    assert.ok(units.flat().every(b => blocks.includes(b)))
  })
  it("preserves ordinary cards, missing borders and off-center unrelated images", () => {
    for (const [horizontal, pictures] of [[hs, []], [hs.slice(1), images], [hs, images.map(p => ({ ...p, y1: 470, y2: 480 }))]] as [LineSegment[], typeof images][]) {
      const blocks = source()
      assert.deepEqual(groupFlowBoxUnits(blocks, grids, horizontal, vs, pictures), blocks.map(b => [b]))
    }
  })
  it("keeps nonaligned rows, nested grids and a spanning paragraph independent", () => {
    const blocks = source()
    const moved = grids.map((g, i) => i === 2 ? { ...g, bbox: { ...g.bbox, y1: 420, y2: 520 } } : g)
    assert.deepEqual(groupFlowBoxUnits(blocks, moved, hs, vs, images), blocks.map(b => [b]))
    const paragraph = text("Unrelated paragraph crossing boxes", 70, 490); paragraph.bbox!.width = 210
    const nested = { ...grids[0], bbox: { x1: 70, x2: 100, y1: 480, y2: 530 } }
    const units = groupFlowBoxUnits([...blocks, paragraph], [...grids, nested], hs, vs, images)
    assert.equal(units.length, 2)
    assert.deepEqual(units[1], [paragraph])
  })
})

import { OPS, ImageKind } from "../src/pdf/ops.js"

function arrowPixels(direction: "right" | "left" | "logo" = "right", transparent = false) {
  const width = 40, height = 40, data = new Uint8Array(width * height * 4); data.fill(255)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const q = direction === "left" ? width - 1 - x : x
    const ink = direction === "logo" ? Math.hypot(q - 20, y - 20) < 13 :
      q >= 5 && q <= 35 && (Math.abs(y - 20) <= 3 || q >= 21 && Math.abs(y - 20) <= 35 - q)
    if (ink) data.set([40, 110, 180, transparent ? 0 : 255], (y * width + x) * 4)
  }
  return { width, height, kind: ImageKind.RGBA_32BPP, data }
}
const arrowOps = (mirrored = false) => ({
  f: [0, 1, 2].flatMap(() => [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore]),
  a: [0, 1, 2].flatMap(i => [[], [mirrored ? -12 : 12, 0, 0, 10, (mirrored ? 136 : 124) + i * 80, 505], ["arrow", 40, 40], []]),
})
const arrowPage = (image: ReturnType<typeof arrowPixels>) => {
  const objects = { get: (_id: string, callback?: (value: unknown) => void) => callback?.(image) }
  return { objs: objects, commonObjs: objects }
}
describe("flow connectors require visible right-pointing pixel evidence", () => {
  it("recognizes a right arrow and interprets mirrored paints in page coordinates", async () => {
    const o = arrowOps()
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels()), o.f, o.a)).length, 3)
    const mirror = arrowOps(true)
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels("left")), mirror.f, mirror.a)).length, 3)
  })
  it("does not force rightward order for left arrows or unrelated circular logos", async () => {
    for (const direction of ["left", "logo"] as const) {
      const o = arrowOps()
      assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels(direction)), o.f, o.a)).length, 0)
    }
    const o = arrowOps(true)
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels()), o.f, o.a)).length, 0)
  })
  it("rejects pixel transparency, alpha-zero and clipped-away paints", async () => {
    const o = arrowOps()
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels("right", true)), o.f, o.a)).length, 0)
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels()), [OPS.setGState, ...o.f], [[[["ca", 0]]], ...o.a])).length, 0)
    assert.equal((await detectRightArrowRegions(arrowPage(arrowPixels()), [OPS.constructPath, OPS.clip, OPS.endPath, ...o.f], [[[OPS.rectangle], [0, 0, 1, 1]], [], [], ...o.a])).length, 0)
  })
  it("decodes a repeated small arrow once and rejects large pictures before decoding", async () => {
    const o = arrowOps(), image = arrowPixels(); let count = 0
    const objects = { get: (_id: string, callback?: (value: unknown) => void) => { count++; callback?.(image) } }
    assert.equal((await detectRightArrowRegions({ objs: objects, commonObjs: objects }, o.f, o.a)).length, 3)
    assert.equal(count, 1)
    await detectRightArrowRegions({ objs: objects, commonObjs: objects }, o.f.slice(0, 4), o.a.slice(0, 4))
    assert.equal(count, 1)
    for (let i = 2; i < o.a.length; i += 4) o.a[i] = ["arrow", 2048, 2048]
    await detectRightArrowRegions({ objs: objects, commonObjs: objects }, o.f, o.a)
    assert.equal(count, 1)
  })
})
