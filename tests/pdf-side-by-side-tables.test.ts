import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {OPS} from "pdfjs-dist/legacy/build/pdf.mjs"
import {extractPageBlocksWithLines} from "../src/pdf/page-blocks.js"
import type {NormItem} from "../src/pdf/text-line.js"

/** 같은 머리를 단 두 표를 쪽 왼쪽·오른쪽에 나란히 (지역별 혼인 건수 꼴) */
function extract() {
  const items: NormItem[] = [], lines: number[][] = []
  const tables = [{x0: 60, top: 700, rows: [["지역", "건수"], ["성남시", "18,202"], ["안양시", "11,771"]]},
    {x0: 320, top: 700, rows: [["지역", "건수"], ["춘천시", "5,433"], ["원주시", "7,709"]]}]
  for (const {x0, top, rows} of tables) {
    const xs = [x0, x0 + 110, x0 + 220]
    for (let r = 0; r <= rows.length; r++) lines.push([x0, top - r * 20, x0 + 220, top - r * 20])
    for (const x of xs) lines.push([x, top - rows.length * 20, x, top])
    rows.forEach((row, r) => row.forEach((text, c) =>
      items.push({text, x: xs[c] + 5, y: top - 14 - r * 20, w: 40, h: 8, fontSize: 8, fontName: "F", isHidden: false})))
  }
  return extractPageBlocksWithLines(items, 1, {
    fnArray: lines.flatMap(() => [OPS.constructPath, OPS.stroke]),
    argsArray: lines.flatMap(line => [[[OPS.moveTo, OPS.lineTo], line], []]),
  }, 595, 842).filter(block => block.type === "table")
}

describe("side-by-side tables", () => {
  it("does not stack the right table under the left one", () => {
    const tables = extract()
    assert.equal(tables.length, 2)
    assert.deepEqual(tables.map(block => block.table!.rows), [3, 3])
    assert.deepEqual(tables.map(block => block.table!.cells[1][0].text), ["성남시", "춘천시"])
  })
})
