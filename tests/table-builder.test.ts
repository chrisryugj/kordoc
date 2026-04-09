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

  it("1행 테이블의 hasHeader는 false", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }],
    ]
    const table = buildTable(rows)
    assert.equal(table.hasHeader, false)
  })
})

describe("blocksToMarkdown", () => {
  it("기본 paragraph 블록 변환 — 문단 사이 빈 줄 삽입", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "첫번째 문단" },
      { type: "paragraph", text: "두번째 문단" },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("첫번째 문단"))
    assert.ok(md.includes("두번째 문단"))
    // 문단 사이에 빈 줄(\n\n)이 있어야 마크다운에서 별도 문단으로 렌더링
    assert.ok(md.includes("첫번째 문단\n\n두번째 문단"))
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

  it("colSpan 병합 셀은 첫 열에만 텍스트, 나머지 빈칸", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "병합셀", colSpan: 2, rowSpan: 1 }],
          [{ text: "값1", colSpan: 1, rowSpan: 1 }, { text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("| 병합셀 |"), "colSpan 병합 셀 텍스트가 첫 열에 존재")
    assert.ok(md.includes("| 값1 | 값2 |"))
  })

  it("rowSpan 병합 셀은 빈 칸으로 유지", () => {
    const blocks: IRBlock[] = [
      {
        type: "table",
        table: buildTable([
          [{ text: "헤더1", colSpan: 1, rowSpan: 1 }, { text: "헤더2", colSpan: 1, rowSpan: 1 }],
          [{ text: "행병합", colSpan: 1, rowSpan: 2 }, { text: "값1", colSpan: 1, rowSpan: 1 }],
          [{ text: "값2", colSpan: 1, rowSpan: 1 }],
        ])
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("| 행병합 | 값1 |"), "rowSpan 원본 셀은 내용 표시")
    assert.ok(md.includes("|  | 값2 |"), "rowSpan 병합 위치는 빈 칸")
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
  it("기본 셀 텍스트를 슬래시로 연결 (외부 테이블 pipe 충돌 방지)", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "B", colSpan: 1, rowSpan: 1 }],
      [{ text: "C", colSpan: 1, rowSpan: 1 }, { text: "D", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A / B\nC / D")
  })

  it("셀 내 pipe 문자는 이스케이프", () => {
    const rows: CellContext[][] = [
      [{ text: "A|B", colSpan: 1, rowSpan: 1 }, { text: "C", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A\\|B / C")
  })

  it("빈 셀은 필터링", () => {
    const rows: CellContext[][] = [
      [{ text: "A", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
    ]
    const text = convertTableToText(rows)
    assert.equal(text, "A")
  })
})
