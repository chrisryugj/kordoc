import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {OPS} from "../src/pdf/ops.js"
import {extractPageBlocksWithLines} from "../src/pdf/page-blocks.js"
import type {IRBlock} from "../src/types.js"
import type {NormItem} from "../src/pdf/text-line.js"

const h = (y: number, x1: number, x2: number) => [x1, y, x2, y]
const v = (x: number, y1: number, y2: number) => [x, y1, x, y2]
const item = (text: string, x: number, y: number): NormItem =>
  ({text, x, y, w: 55, h: 8, fontSize: 8, fontName: "F", isHidden: false})
const nestedTables = (blocks: IRBlock[]): IRBlock[] => blocks.flatMap(block => block.table ?
  [block, ...nestedTables(block.table.cells.flatMap(row => row.flatMap(cell => cell.blocks ?? [])))] : [])

describe("one-column frame with genuine nested table", () => {
  it("keeps a short divided frame after attaching its data table, without losing or duplicating text", () => {
    const lines = [h(303.636, 59.52, 391.2), h(244.416, 59.52, 391.2), h(235.596, 59.52, 391.2), h(164.616, 59.52, 391.2),
      ...[59.52, 391.2].flatMap(x => [v(x, 244.416, 303.636), v(x, 164.616, 235.596)]),
      ...[199.236, 184.056, 169.416].map(y => h(y, 67.98, 382.68)),
      ...[144.54, 223.92, 303.3].map(x => v(x, 169.416, 199.236)),
      ...[67.98, 382.68].map(x => v(x, 184.056, 199.236))]
    const shadeOps = [67.98, 144.54, 223.92, 303.3].flatMap((x, i) => [
      {fn: OPS.save, args: []},
      {fn: OPS.constructPath, args: [[OPS.rectangle], [x, 184.056, [76.56, 79.38, 79.38, 79.38][i], 15.18]]},
      {fn: OPS.clip, args: []}, {fn: OPS.endPath, args: []},
      {fn: OPS.constructPath, args: [[OPS.rectangle], [x, 184.056, [76.56, 79.38, 79.38, 79.38][i], 15.18]]},
      {fn: OPS.fill, args: []}, {fn: OPS.restore, args: []},
    ])
    const source = [item("앞 문단", 75, 285), item("뒤 문단", 75, 211),
      ...["처분대상", "1차 위반", "2차 위반", "3차 위반"].map((s, i) => item(s, 75 + i * 79, 189)),
      ...["이송업자", "업무정지 1일", "업무정지 2일", "업무정지 3일"].map((s, i) => item(s, 75 + i * 79, 173))]
    const blocks = extractPageBlocksWithLines(source, 68, {
      fnArray: [...shadeOps.map(op => op.fn), ...lines.flatMap(() => [OPS.constructPath, OPS.stroke])],
      argsArray: [...shadeOps.map(op => op.args), ...lines.flatMap(line => [[[OPS.moveTo, OPS.lineTo], line], []])],
    }, 595, 842)
    const table = nestedTables(blocks).find(block => block.table!.cols === 4)
    assert.ok(table, "the attached table survives the one-column layout filter")
    assert.equal(table.table!.rows, 2)
    assert.deepEqual(table.table!.cells.map(row => row.map(cell => cell.text)), [
      ["처분대상", "1차 위반", "2차 위반", "3차 위반"],
      ["이송업자", "업무정지 1일", "업무정지 2일", "업무정지 3일"],
    ])
    const ownText = blocks.map(block => block.table ? block.table.cells.flat().map(cell => cell.text).join("\n") : block.text).join("\n")
    for (const text of ["앞 문단", "뒤 문단", "이송업자"]) assert.equal(ownText.split(text).length - 1, 1, text)
  })
})
