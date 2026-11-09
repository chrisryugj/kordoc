import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {OPS} from "../src/pdf/ops.js"
import {extractPageBlocksWithLines} from "../src/pdf/page-blocks.js"
import type {IRBlock} from "../src/types.js"
import {extendNestedShadedHeaders} from "../src/pdf/nested-shaded-headers.js"
import type {TableGrid, LineSegment} from "../src/pdf/line-types.js"
import type {NormItem} from "../src/pdf/text-line.js"

const allTables = (blocks: IRBlock[]): IRBlock[] => blocks.flatMap(b => b.table ?
  [b, ...allTables(b.table.cells.flat().flatMap(c => c.blocks ?? []))] : [])
const word = (text: string, x: number, y: number): NormItem =>
  ({text, x, y, w: 20, h: 7, fontSize: 7, fontName: "F", isHidden: false})
const clips = (x: number, y: number, w: number, h: number, shade = false) => [
  {fn: OPS.save, args: []}, {fn: OPS.constructPath, args: [[OPS.rectangle], [x, y, w, h]]},
  {fn: OPS.clip, args: []}, {fn: OPS.endPath, args: []},
  ...(shade ? [{fn: OPS.constructPath, args: [[OPS.rectangle], [x, y, w, h]]}, {fn: OPS.fill, args: []}] : []),
  {fn: OPS.restore, args: []},
]
const rowYs = [[554.376, 542.256, 530.136, 518.016, 505.896, 493.776, 481.656],
  [445.356, 434.436, 423.456, 403.356, 383.316, 363.216]]
const colXs = [[80.04, 131.76, 199.5, 369.18], [80.04, 122.64, 162.42, 219.54, 369.18]]
function fixture() {
  const ops = [...clips(59.52, 71.856, 330.24, 512.1), ...clips(68.04, 78.036, 313.2, 499.74)]
  const lines = [
    ...[71.856, 583.956].map(y => [59.52, y, 389.76, y]), ...[59.52, 389.76].map(x => [x, 71.856, x, 583.956]),
    ...[78.036, 577.776].map(y => [68.04, y, 381.24, y]), ...[68.04, 381.24].map(x => [x, 78.036, x, 577.776]),
  ]
  const items = [word("before", 90, 563), word("between", 90, 460), word("after", 90, 335)]
  const expected: string[][][] = []
  for (let t = 0; t < 2; t++) {
    const ys = rowYs[t], xs = colXs[t]
    for (let c = 0; c < xs.length - 1; c++) ops.push(...clips(xs[c], ys[1], xs[c + 1] - xs[c], ys[0] - ys[1], true))
    lines.push(...ys.map(y => [xs[0] - .18, y, xs.at(-1)! + .18, y]),
      ...xs.slice(1, -1).map(x => [x, ys.at(-1)!, x, ys[0]]))
    expected.push(ys.slice(0, -1).map((top, r) => xs.slice(0, -1).map((x, c) => {
      const text = "T" + t + "R" + r + "C" + c
      items.push(word(text, x + 3, (top + ys[r + 1]) / 2 - 3))
      return text
    })))
  }
  ops.push(...lines.flatMap(line => [{fn: OPS.constructPath, args: [[OPS.moveTo, OPS.lineTo], line]}, {fn: OPS.stroke, args: []}]))
  return {ops, items, expected}
}
describe("shaded headers inside nested source frames", () => {
  it("retains all body rows and column relationships of two genuine open-sided tables", () => {
    const {ops, items, expected} = fixture()
    const blocks = extractPageBlocksWithLines(items, 44, {fnArray: ops.map(x => x.fn), argsArray: ops.map(x => x.args)}, 454, 652)
    const tables = allTables(blocks).filter(b => b.table!.cols >= 3)
    assert.deepEqual(tables.map(b => [b.table!.rows, b.table!.cols]), [[6, 3], [5, 4]])
    assert.deepEqual(tables.map(b => b.table!.cells.map(row => row.map(c => c.text))), expected)
    const leaf = (bs: IRBlock[]): string[] => bs.flatMap(b => b.table ? b.table.cells.flat().flatMap(c => c.blocks?.length ? leaf(c.blocks) : [c.text]) : [b.text ?? ""])
    const text = leaf(blocks).join(" ")
    assert.ok(text.indexOf("before") < text.indexOf("T0R0C0"))
    assert.ok(text.indexOf("T0R5C2") < text.indexOf("between"))
    assert.ok(text.indexOf("between") < text.indexOf("T1R0C0"))
    assert.ok(text.indexOf("T1R4C3") < text.indexOf("after"))
    for (const cell of expected.flat(2)) assert.equal(text.split(cell).length - 1, 1)
  })
})

function gridFixture() {
  const parent = {x1: 60, x2: 400, y1: 100, y2: 500}
  const frame: TableGrid = {bbox: parent, rowYs: [500, 100], colXs: [60, 400], vertexRadius: 1}
  const xs = [80, 150, 230, 380], ys = [450, 430, 410, 390]
  const header: TableGrid = {bbox: {x1: 80, x2: 380, y1: 430, y2: 450}, rowYs: ys.slice(0, 2), colXs: xs,
    clipParent: parent, vertexRadius: 1, cells: xs.slice(0, -1).map((x, c) => ({row: 0, col: c, rowSpan: 1, colSpan: 1,
      bbox: {x1: x, x2: xs[c + 1], y1: 430, y2: 450}}))}
  const full: TableGrid = {bbox: {x1: 80, x2: 380, y1: 390, y2: 450}, rowYs: ys, colXs: xs, vertexRadius: 1}
  const hs: LineSegment[] = ys.map(y => ({x1: 80, x2: 380, y1: y, y2: y, lineWidth: .36}))
  const vs: LineSegment[] = xs.map(x => ({x1: x, x2: x, y1: 390, y2: 450, lineWidth: .36}))
  const fills = header.cells!.map(c => c.bbox)
  return {clips: [frame, header], lineGrids: [full], hs, vs, fills, header, full}
}
describe("nested shaded header boundary evidence", () => {
  it("retains the source parent and uses only the complete matching grid", () => {
    const f = gridFixture(), out = extendNestedShadedHeaders(f.clips, f.lineGrids, f.hs, f.vs, f.fills)
    assert.equal(out.length, 1)
    assert.equal(f.clips[0].cells, undefined)
    assert.deepEqual(out[0].clipParent, f.header.clipParent)
    assert.deepEqual(out[0].rowYs, f.full.rowYs)
    assert.equal(out[0].cells!.length, 9)
  })
  for (const missing of ["parent", "parent-grid", "shading", "body", "column", "heading-boundary", "vertical", "horizontal", "filler", "other-body-clip", "outside-parent"] as const) {
    it("preserves original clips without " + missing + " evidence", () => {
      const f = gridFixture()
      if (missing === "parent") delete f.header.clipParent
      if (missing === "parent-grid") f.clips.shift()
      if (missing === "shading") f.fills.pop()
      if (missing === "body") f.full.rowYs = f.header.rowYs
      if (missing === "column") f.full.colXs = [80, 170, 230, 380]
      if (missing === "heading-boundary") f.full.rowYs = [450, 425, 410, 390]
      if (missing === "vertical") f.vs.splice(1, 1)
      if (missing === "horizontal") f.hs.splice(2, 1)
      if (missing === "filler") f.header.cells![0].filler = true
      if (missing === "other-body-clip") f.clips.push({bbox: {x1: 80, x2: 380, y1: 390, y2: 410}, colXs: [80, 380], rowYs: [410, 390], vertexRadius: 1})
      if (missing === "outside-parent") f.full.bbox.y1 = 80
      const before = structuredClone(f.clips)
      assert.deepEqual(extendNestedShadedHeaders(f.clips, f.lineGrids, f.hs, f.vs, f.fills), [])
      assert.deepEqual(f.clips, before)
    })
  }
})
