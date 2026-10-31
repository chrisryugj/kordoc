/** 모아찍기 쪽 단 넘김 — 왼쪽 쪽 바닥 클립 표의 넓은 끝 칸이 오른쪽 쪽 머리의 획 상자(1×1)로 이어짐 (table-parts mergeColumnFlow) */

import { it } from "node:test"
import assert from "node:assert/strict"
import type { IRBlock, IRCell } from "../src/types.js"
import { mergeCrossPageTables } from "../src/pdf/table-parts.js"
import { CLIP_TABLES, TABLE_COLXS } from "../src/pdf/table-meta.js"

const cell = (text: string, colSpan = 1): IRCell => ({ text, colSpan, rowSpan: 1 })

function page(rightText: string, rightWidth = 321.8): IRBlock[] {
  // 가로 A4(841×595) 모아찍기: 왼쪽 쪽 아래 "채용 결격사유" 표(머리 + 전폭 본문 칸)가 쪽 바닥까지, 오른쪽 쪽 머리에 이어진 글 상자
  const left: IRBlock = {
    type: "table", pageNumber: 3, bbox: { page: 3, x: 59.1, y: 49.7, width: 321.8, height: 256 },
    table: { rows: 2, cols: 2, cells: [[cell(""), cell("채용 결격사유")], [cell("① 국가공무원법 제33조 결격사유 … 경과한 사람을 포함한다)", 2), { text: "", colSpan: 1, rowSpan: 1 }]] },
  }
  left.table!.cells[1].pop()
  CLIP_TABLES.add(left.table!)
  TABLE_COLXS.set(left.table!, [59.1, 90, 380.9])
  const right: IRBlock = {
    type: "table", pageNumber: 3, bbox: { page: 3, x: 479.6, y: 359.2, width: rightWidth, height: 184.6 },
    table: { rows: 1, cols: 1, cells: [[cell(rightText)]] },
  }
  return [left, right]
}

it("오른쪽 쪽 머리 1×1 상자를 왼쪽 표 끝 칸의 이어진 글로 붙인다", () => {
  const blocks = page("가. 「성폭력범죄의 처벌 등에 관한 특례법」 제2조에 따른 성폭력범죄")
  mergeCrossPageTables(blocks, new Map([[3, 595]]))
  assert.equal(blocks.length, 1)
  assert.match(blocks[0].table!.cells[1][0].text, /포함한다\)\n가\. 「성폭력범죄/)
})

it("폭이 다른 상자는 잇지 않는다", () => {
  const blocks = page("다른 상자 글", 200)
  mergeCrossPageTables(blocks, new Map([[3, 595]]))
  assert.equal(blocks.length, 2)
})
