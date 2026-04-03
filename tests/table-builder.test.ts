import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTable, blocksToMarkdown, convertTableToText } from "../src/table/builder.js"
import type { CellContext, IRBlock } from "../src/types.js"

describe("buildTable", () => {
  it("기본 2x2 테이블 빌드", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.rows, 2)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "A")
    assert.equal(table.cells[1][1].text, "D")
    assert.equal(table.hasHeader, true)
  })

  it("colSpan 처리", () => {
    const rows: CellContext[][] = [
      [{ text: "merged", colSpan: 2, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "merged")
    assert.equal(table.cells[0][0].colSpan, 2)
  })

  it("rowSpan 처리", () => {
    const rows: CellContext[][] = [
      [{ text: "span", colSpan: 1, rowSpan: 2 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.rows, 2)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "span")
    assert.equal(table.cells[0][0].rowSpan, 2)
    assert.equal(table.cells[1][1].text, "D")
  })

  it("빈 입력은 빈 테이블 반환", () => {
    const table = buildTable([])
    assert.equal(table.rows, 0)
    assert.equal(table.cols, 0)
  })

  it("1행 테이블의 hasHeader는 true", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.hasHeader, true)
  })
})

describe("blocksToMarkdown", () => {
  it("기본 paragraph 블록 변환", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "첫번째 문단" },
      { type: "paragraph", text: "두번째 문단" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("첫번째 문단"))
    assert.ok(md.includes("두번째 문단"))
  })

  it("[별표 N] 패턴을 H2 헤더로 변환", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "[별표 1] 교육과정" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("## [별표 1] 교육과정"))
  })

  it("[별표 N] + (관련) 패턴 병합", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "[별표 3]" },
      { type: "paragraph", text: "(제5조 관련)" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("## [별표 3] (제5조 관련)"))
  })

  it("(조 관련) 패턴을 italic으로", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "(제10조제2항 관련)" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("*(제10조제2항 관련)*"))
  })

  it("헤더만 있는 테이블은 빈 데이터 행 추가", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "이름", colSpan: 1, rowSpan: 1 }, { text: "나이", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("| 이름 | 나이 |"))
    assert.ok(md.includes("| --- | --- |"))
    // 빈 데이터 행이 추가되어야 함
    assert.ok(md.includes("|  |  |"))
  })

  it("테이블 블록을 마크다운 테이블로 변환", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "헤더1", colSpan: 1, rowSpan: 1 }, { text: "헤더2", colSpan: 1, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("| 헤더1 | 헤더2 |"))
    assert.ok(md.includes("| --- | --- |"))
    assert.ok(md.includes("| 값1 | 값2 |"))
  })
})

describe("convertTableToText", () => {
  it("기본 셀 텍스트를 파이프로 연결", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A | B\nC | D")
  })

  it("빈 셀은 필터링", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A")
  })
})
