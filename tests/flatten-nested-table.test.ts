import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { flattenLayoutTables, buildTable } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

describe("flattenLayoutTables — 중첩표 구조 보존", () => {
  it("레이아웃 표 해체 시 cell.blocks의 중첩 3×3 표를 실제 table 블록으로 보존", () => {
    // 중첩 spec 표 (numRows=3 → 레이아웃 휴리스틱에 걸리지 않아 표로 살아남아야 함)
    const nested = buildTable([
      [{ text: "h1", colSpan: 1, rowSpan: 1 }, { text: "h2", colSpan: 1, rowSpan: 1 }, { text: "h3", colSpan: 1, rowSpan: 1 }],
      [{ text: "a1", colSpan: 1, rowSpan: 1 }, { text: "a2", colSpan: 1, rowSpan: 1 }, { text: "a3", colSpan: 1, rowSpan: 1 }],
      [{ text: "b1", colSpan: 1, rowSpan: 1 }, { text: "b2", colSpan: 1, rowSpan: 1 }, { text: "b3", colSpan: 1, rowSpan: 1 }],
    ])
    assert.equal(nested.rows, 3)
    assert.equal(nested.cols, 3)

    // 외곽 2×1 페이지 레이아웃 표: cell(0,0)=반복 머리말, cell(1,0)=본문(blocks 보유)
    // cell(1,0).text는 줄바꿈 다량 → 레이아웃 휴리스틱(totalNewlines>5) 트리거
    const outer: IRBlock = {
      type: "table",
      pageNumber: 3,
      table: {
        rows: 2,
        cols: 1,
        hasHeader: true,
        cells: [
          [{ text: "머리말 반복 running header", colSpan: 1, rowSpan: 1 }],
          [{
            text: "줄1\n줄2\n줄3\n줄4\n줄5\n줄6\n줄7\n줄8",
            colSpan: 1,
            rowSpan: 1,
            blocks: [
              { type: "paragraph", text: "셀 본문 문단", pageNumber: 3 },
              { type: "table", table: nested, pageNumber: 3 },
            ],
          }],
        ],
      },
    }

    const flat = flattenLayoutTables([outer])

    // 중첩표가 실제 table 블록으로 보존 (문단으로 해체되지 않음)
    const tableBlocks = flat.filter(b => b.type === "table" && b.table)
    assert.equal(tableBlocks.length, 1, "중첩 3×3 표가 실제 table 블록으로 보존되어야 함")
    const preserved = tableBlocks[0].table!
    assert.equal(preserved.rows, 3, "보존된 표 행 수")
    assert.equal(preserved.cols, 3, "보존된 표 열 수")
    assert.equal(preserved.cells[0][0].text, "h1")
    assert.equal(preserved.cells[2][2].text, "b3")

    // 표 셀 텍스트가 문단으로 새어나오지 않음 (해체 안 됨의 반증)
    const paraTexts = flat.filter(b => b.type === "paragraph").map(b => b.text)
    assert.ok(!paraTexts.includes("h1"), "중첩표 셀이 문단으로 해체되지 않아야 함")

    // blocks 내 문단은 보존, blocks 없는 셀(머리말)은 text-split
    assert.ok(paraTexts.includes("셀 본문 문단"), "blocks 내 문단 보존")
    assert.ok(paraTexts.includes("머리말 반복 running header"), "머리말 셀은 text-split")

    // pageNumber 보존
    const headerPara = flat.find(b => b.type === "paragraph" && b.text === "머리말 반복 running header")
    assert.equal(headerPara?.pageNumber, 3, "text-split 문단 pageNumber 보존")
  })

  it("blocks 없는 셀은 기존대로 줄 단위 paragraph로 분해 (회귀 방지)", () => {
    const outer: IRBlock = {
      type: "table",
      pageNumber: 5,
      table: {
        rows: 2,
        cols: 1,
        hasHeader: true,
        cells: [
          [{ text: "머리말", colSpan: 1, rowSpan: 1 }],
          [{ text: "가\n나\n다\n라\n마\n바\n사", colSpan: 1, rowSpan: 1 }],
        ],
      },
    }

    const flat = flattenLayoutTables([outer])

    assert.ok(flat.every(b => b.type === "paragraph"), "표 블록 없이 모두 문단으로 해체")
    const texts = flat.map(b => b.text)
    for (const t of ["머리말", "가", "나", "다", "라", "마", "바", "사"]) {
      assert.ok(texts.includes(t), `'${t}' 문단 존재`)
    }
    assert.ok(flat.every(b => b.pageNumber === 5), "pageNumber 보존")
  })
})
