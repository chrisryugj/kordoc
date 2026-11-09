/** 표의 무괘선 첫 행 "(단위: …)" — 칸 안쪽 여백만큼 표 오른끝에서 들어간 단위 줄은 표 첫 행, 본문 오른끝에 붙은 단위 줄은 문단 (src/pdf/page-blocks.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
import { unframeLayoutTables } from "../src/table/layout-frames.js"

const item = (text: string, x: number, y: number, w: number): NormItem => ({ text, x, y, w, h: 10, fontSize: 10, fontName: "F", isHidden: false }) as NormItem

/** 3행×3열 실선 표(x 100~400, y 400~460) + 표 위 단위 줄(오른끝 = 400 - inset) */
function page(inset: number) {
  const fnArray: number[] = [OPS.setLineWidth]
  const argsArray: unknown[][] = [[0.5]]
  const segs = [[100, 400, 400, 400], [100, 420, 400, 420], [100, 440, 400, 440], [100, 460, 400, 460],
    [100, 400, 100, 460], [200, 400, 200, 460], [300, 400, 300, 460], [400, 400, 400, 460]]
  for (const sg of segs) { fnArray.push(OPS.constructPath, OPS.stroke); argsArray.push([[OPS.moveTo, OPS.lineTo], sg], []) }
  const items = [item("(단위: ha, %)", 400 - inset - 60, 464, 60),
    item("구분", 130, 445, 20), item("2025", 230, 445, 20), item("2026", 330, 445, 20),
    item("벼", 140, 425, 10), item("677", 230, 425, 20), item("670", 330, 425, 20),
    item("고추", 130, 405, 20), item("25", 235, 405, 10), item("25", 335, 405, 10)]
  return extractPageBlocksWithLines(items, 1, { fnArray, argsArray }, 595, 842)
}

describe("표 위 단위 줄", () => {
  it("칸 여백(5pt)만큼 들어간 단위 줄은 표 첫 행", () => {
    const tables = page(5).filter(b => b.type === "table")
    assert.equal(tables.length, 1)
    assert.equal(tables[0].table!.rows, 4)
    assert.equal(tables[0].table!.cells[0][0].text, "(단위: ha, %)")
  })
  it("표 오른끝에 붙은 단위 줄은 문단", () => {
    const blocks = page(0)
    assert.equal(blocks.find(b => b.type === "table")!.table!.rows, 3)
    assert.ok(blocks.some(b => b.type === "paragraph" && b.text?.includes("단위")))
  })
  it("보이는 표 모드에서는 자기 괘선 없는 단위 줄을 문단으로 보존한다", () => {
    const blocks = unframeLayoutTables(page(5))
    assert.equal(blocks.find(b => b.type === "table")!.table!.rows, 3)
    assert.equal(blocks.filter(b => b.type === "paragraph" && b.text?.includes("단위")).length, 1)
    assert.equal(blocks[0].text, "(단위: ha, %)")
  })
})
