/** HWP·HWPX OLE 개체(4바이트 길이 머리 + 복합 문서) → 엑셀 개체 표 (src/hwp5/ole-chart.ts) */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parseXls } from "../src/index.js"
import { oleObjectBlocks } from "../src/hwp5/ole-chart.js"

const xls = readFileSync(join(process.cwd(), "tests/fixtures/xls/budget.xls"))
const wrap = (cfb: Buffer) => { const head = Buffer.alloc(4); head.writeUInt32LE(cfb.length); return Buffer.concat([head, cfb]) }

describe("OLE 개체", () => {
  it("엑셀 개체는 시트 표를 그대로, 캡션은 시트 이름", async () => {
    const blocks = oleObjectBlocks(wrap(xls))
    const direct = await parseXls(xls.buffer.slice(xls.byteOffset, xls.byteOffset + xls.byteLength))
    assert.ok(direct.success)
    if (!direct.success) return
    const tables = direct.blocks.filter(b => b.type === "table")
    assert.equal(blocks.length, tables.length)
    assert.ok(blocks.length > 0)
    assert.deepEqual(blocks[0].table!.cells.map(r => r.map(c => c.text)), tables[0].table!.cells.map(r => r.map(c => c.text)))
    const sheet = direct.blocks.find(b => b.type === "heading")?.text
    assert.equal(blocks[0].table!.caption, `엑셀 개체: ${sheet}`)
  })

  it("통합 문서도 차트도 아닌 개체·짧은 자료는 빈 배열", () => {
    assert.deepEqual(oleObjectBlocks(undefined), [])
    assert.deepEqual(oleObjectBlocks(Buffer.alloc(8)), [])
    assert.deepEqual(oleObjectBlocks(wrap(Buffer.from("not a compound file at all"))), [])
  })
})
