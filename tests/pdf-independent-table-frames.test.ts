import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {OPS} from "../src/pdf/ops.js"
import {extractPageBlocksWithLines} from "../src/pdf/page-blocks.js"
import type {NormItem} from "../src/pdf/text-line.js"

function extract(repeatHeader: boolean, gap: number) {
  const tops = [400, 360 - gap], xs = [80, 160, 240, 320, 400]
  const header = ["처분 대상", "1차 위반", "2차 위반", "3차 위반"]
  const items: NormItem[] = [], lines: number[][] = []
  for (let t = 0; t < 2; t++) {
    const top = tops[t], first = t && !repeatHeader ? ["다른 대상", "다른 값 1", "다른 값 2", "다른 값 3"] : header
    for (const y of [top, top - 20, top - 40]) lines.push([80, y, 400, y])
    for (const x of xs) lines.push([x, top - 40, x, top])
    for (const [r, row] of [first, [t ? "이송업자" : "응급구조사", "처분 1", "처분 2", "처분 3"]].entries()) {
      row.forEach((text, c) => items.push({text, x: xs[c] + 5, y: top - 14 - r * 20, w: 65, h: 8, fontSize: 8, fontName: "F", isHidden: false}))
    }
  }
  return extractPageBlocksWithLines(items, 59, {
    fnArray: lines.flatMap(() => [OPS.constructPath, OPS.stroke]),
    argsArray: lines.flatMap(line => [[[OPS.moveTo, OPS.lineTo], line], []]),
  }, 595, 842).filter(block => block.type === "table")
}

describe("independent same-page table headings", () => {
  it("keeps separately closed tables with their own repeated heading and a visible gap apart", () => {
    const tables = extract(true, 24)
    assert.equal(tables.length, 2)
    assert.deepEqual(tables.map(block => block.table!.rows), [2, 2])
    assert.deepEqual(tables.map(block => block.bbox!.height), [40, 40])
    assert.deepEqual(tables.map(block => block.table!.cells[1][0].text), ["응급구조사", "이송업자"])
  })

  it("still rejoins adjacent fragments that do not independently restart the heading", () => {
    const tables = extract(false, 24)
    assert.equal(tables.length, 1)
    assert.equal(tables[0].table!.rows, 4)
  })

  it("keeps one connected grid structural even when an internal row repeats its heading", () => {
    const tables = extract(true, 0)
    assert.equal(tables.length, 1)
    assert.equal(tables[0].table!.rows, 4)
  })
})
