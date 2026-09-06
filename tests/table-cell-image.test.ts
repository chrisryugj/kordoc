/** #76 Task 4 — 병합 없는 단순 표의 셀 이미지가 직렬화에서 사라지지 않는다 + 순서 보존 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blocksToMarkdown, hasStructuredCellContent } from "../src/table/builder.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

const c = (text: string, blocks?: IRBlock[]): IRCell => ({ text, colSpan: 1, rowSpan: 1, ...(blocks ? { blocks } : {}) })
const t = (cells: IRCell[][]): IRTable => ({ rows: cells.length, cols: cells[0].length, cells, hasHeader: true })

describe("셀 이미지 보존", () => {
  it("2×2 병합 없는 표 — text 에 참조가 없어도 셀 이미지가 GFM 셀에 `![image](src)` 로 남는다", () => {
    const table = t([[c("A"), c("B")], [c("C"), c("", [{ type: "image", text: "images/pic1.png" }])]])
    assert.ok(!hasStructuredCellContent(table), "이미지만으로는 HTML 강제 아님 — GFM 인라인 가능")
    const md = blocksToMarkdown([{ type: "table", table }])
    assert.ok(md.includes("![image](images/pic1.png)"), md)
    assert.ok(!md.includes("<table>"), "단순 표는 GFM 유지")
  })
  it("중첩표·구분선은 GFM 에 담을 수 없어 HTML 표", () => {
    const inner: IRTable = t([[c("n1"), c("n2")], [c("v1"), c("v2")]])
    const table = t([[c("A"), c("B")], [c("C"), c("", [{ type: "table", table: inner }])]])
    assert.ok(hasStructuredCellContent(table))
    assert.ok(blocksToMarkdown([{ type: "table", table }]).includes("<table>"))
  })
  it("이미지 없는 단순 표는 종전대로 GFM", () => {
    const table = t([[c("A"), c("B")], [c("C"), c("D")]])
    assert.ok(!hasStructuredCellContent(table))
    const md = blocksToMarkdown([{ type: "table", table }])
    assert.ok(md.includes("| A | B |") && !md.includes("<table>"), md)
  })
  it("문단 → 이미지 → 문단 순서, 문단 → 중첩표 → 이미지 → 문단 순서 보존", () => {
    const table = t([[c("h1"), c("h2")], [c("x"), c("앞\n뒤", [{ type: "paragraph", text: "앞" }, { type: "image", text: "img/a.png" }, { type: "paragraph", text: "뒤" }])]])
    const md = blocksToMarkdown([{ type: "table", table }])
    assert.ok(md.indexOf("앞") < md.indexOf("![image](img/a.png)") && md.indexOf("img/a.png") < md.indexOf("뒤"), md)
    const inner: IRTable = t([[c("n1"), c("n2")], [c("v1"), c("v2")]])
    const table2 = t([[c("h1"), c("h2")], [c("x"), c("", [{ type: "paragraph", text: "머리" }, { type: "table", table: inner }, { type: "image", text: "img/b.png" }, { type: "paragraph", text: "꼬리" }])]])
    const md2 = blocksToMarkdown([{ type: "table", table: table2 }])
    const i = (s: string) => md2.indexOf(s)
    assert.ok(i("머리") < i("n1") && i("n1") < i("img/b.png") && i("img/b.png") < i("꼬리"), md2)
  })
  it("span 문단만 있는 셀은 구조 콘텐츠가 아니다 — 왕복 채널 GFM 산출 불변", () => {
    const table = t([[c("A"), c("B")], [c("굵게", [{ type: "paragraph", text: "굵게", spans: [{ text: "굵게", bold: true }] }]), c("D")]])
    assert.ok(!hasStructuredCellContent(table))
    assert.ok(!blocksToMarkdown([{ type: "table", table }]).includes("<table>"))
  })
})
