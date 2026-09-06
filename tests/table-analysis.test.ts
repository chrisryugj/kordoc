/** #76 Task 2·3·5 — opt-in 분류 배선(재귀·불변식)·IRTable 메타·표현 정책 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, parse } from "../src/index.js"
import { classifyTableTree, chooseTableRepresentation } from "../src/table/analyze.js"
import { collectTableBlocks } from "../src/table/classifier.js"
import type { IRBlock, IRTable } from "../src/types.js"

const DOC = [
  "# 제목", "", "조직도는 아래와 같다.", "",
  "| 이름 | 부서 | 인원 |", "|---|---|---|", "| 홍길동 | 개발 | 10 |", "| 김철수 | 기획 | 7 |", "| 이영희 | 영업 | 12 |", "",
  "<table><tr><th>항목</th><th>상세</th></tr><tr><td>내역</td><td><table><tr><th>중첩A</th><th>중첩B</th></tr><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table></td></tr></table>",
].join("\n")

describe("table analysis — opt-in 배선", () => {
  it("classifyTables 미지정/false → 분류 메타 없음, true → 최상위·중첩 표 모두 독립 분류", async () => {
    const buf = await markdownToHwpx(DOC)
    const plain = await parse(buf)
    assert.ok(plain.success)
    assert.ok(collectTableBlocks(plain.blocks).every(b => b.table!.classification === undefined))
    const off = await parse(buf, { classifyTables: false })
    assert.ok(off.success && collectTableBlocks(off.blocks).every(b => b.table!.classification === undefined))
    const on = await parse(buf, { classifyTables: true })
    assert.ok(on.success)
    const tables = collectTableBlocks(on.blocks)
    assert.ok(tables.length >= 3, `표 ${tables.length}`)
    for (const b of tables) assert.ok(b.table!.classification && ["semantic-table", "non-tabular-layout", "uncertain"].includes(b.table!.classification.kind))
    // 셀 blocks 순서·텍스트·마크다운은 분류와 무관하게 동일
    assert.equal(on.markdown, plain.markdown)
    assert.deepEqual(on.blocks.map(b => b.type), plain.blocks.map(b => b.type))
    // HWPX 표는 sourceId(hp:tbl id) 를 가진다
    assert.ok(tables.every(b => typeof b.table!.sourceId === "string" && b.table!.sourceId!.length > 0))
  })
  it("classifyTableTree — 캡션 blocks·children 재귀, 부모가 자식 분류를 덮지 않는다", () => {
    const inner: IRTable = { rows: 3, cols: 2, hasHeader: true, cells: [["a", "b"], ["1", "2"], ["3", "4"]].map(r => r.map(text => ({ text, colSpan: 1, rowSpan: 1 }))) }
    const wrapper: IRTable = { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "", colSpan: 1, rowSpan: 1, blocks: [{ type: "table", table: inner }] }]] }
    const blocks: IRBlock[] = [{ type: "paragraph", text: "x" }, { type: "table", table: wrapper }]
    classifyTableTree(blocks)
    assert.equal(wrapper.classification!.kind, "non-tabular-layout")
    assert.ok(inner.classification, "중첩표도 분류")
    assert.notEqual(inner.classification!.kind, "non-tabular-layout")
    assert.equal(blocks[0].text, "x")
  })
  it("IRTable 선택 메타 — regions 는 페이지 조각 여럿", () => {
    const t: IRTable = { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "a", colSpan: 1, rowSpan: 1 }]], sourceId: "tbl-1", regions: [{ page: 3, x: 72, y: 610, width: 450, height: 180 }, { page: 4, x: 72, y: 55, width: 450, height: 300 }] }
    assert.equal(t.regions!.length, 2)
  })
  it("chooseTableRepresentation — 단순 gfm / 병합·구조 html / non-tabular+smart visual", () => {
    const simple: IRTable = { rows: 2, cols: 2, hasHeader: true, cells: [["a", "b"], ["c", "d"]].map(r => r.map(text => ({ text, colSpan: 1, rowSpan: 1 }))) }
    assert.equal(chooseTableRepresentation(simple), "gfm")
    const merged: IRTable = { ...simple, cells: [[{ text: "a", colSpan: 2, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }], simple.cells[1]] }
    assert.equal(chooseTableRepresentation(merged), "html")
    const layout: IRTable = { ...simple, classification: { kind: "non-tabular-layout", confidence: 0.8, semanticScore: 0.1, nonTabularScore: 0.9, reasons: ["extreme-sparsity"] } }
    assert.equal(chooseTableRepresentation(layout), "gfm", "기본 모드는 종전 동작")
    assert.equal(chooseTableRepresentation(layout, { smartVisual: true }), "visual")
  })
})
