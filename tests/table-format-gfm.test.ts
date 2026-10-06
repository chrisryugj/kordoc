/** tableFormat: "gfm" — 모든 표를 HTML 없이 GFM 파이프 표로, 셀 안 표는 부모 뒤 독립 표 + 관계 표지 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import MarkdownIt from "markdown-it"
import { blocksToPages } from "../src/index.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

const GFM = { tableFormat: "gfm" } as const

const c = (text: string, extra?: Partial<IRCell>): IRCell => ({ text, colSpan: 1, rowSpan: 1, ...extra })
const tbl = (cells: IRCell[][], extra?: Partial<IRTable>): IRTable =>
  ({ rows: cells.length, cols: cells[0].length, cells, hasHeader: true, ...extra })
const tableBlock = (table: IRTable, pageNumber?: number): IRBlock => ({ type: "table", table, ...(pageNumber ? { pageNumber } : {}) })
/** 셀 안에 글 + 표들 */
const nestCell = (text: string, ...tables: IRTable[]): IRCell =>
  c(text, { blocks: [{ type: "paragraph", text }, ...tables.map(tableBlock)] })

/** 부모 2×2 의 (1,1) 칸에 자식 표 */
const oneLevel = (): IRBlock[] => [tableBlock(tbl([
  [c("구분"), c("내용")],
  [c("예산"), nestCell("총액", tbl([[c("항목"), c("금액")], [c("인건비"), c("100")]]))],
  [c("기간"), c("1년")],
]))]

const markerIds = (md: string) => [...md.matchAll(/<!-- <table id="(t\d+)" parent_id="(t\d+)" \/> -->/g)].map(m => [m[1], m[2]])
const cellMarkers = (md: string) => [...md.matchAll(/<!-- <table parent_id="(t\d+)" child_id="(t\d+)" \/> -->/g)].map(m => [m[1], m[2]])

describe("tableFormat gfm — 표 렌더", () => {
  it("병합 칸 표 → 파이프 표, <table 없음, 열 수 유지 (가로 병합은 시작 칸에만, 세로 병합은 덮인 행에 채움)", () => {
    const md = blocksToMarkdown([tableBlock(tbl([
      [c("구분", { colSpan: 2 }), c(""), c("값")],
      [c("가", { rowSpan: 2 }), c("나"), c("1")],
      [c(""), c("다"), c("2")],
    ]))], GFM)
    assert.ok(!md.includes("<table"))
    assert.equal(md, [
      "| 구분 |  | 값 |",
      "| --- | --- | --- |",
      "| 가 | 나 | 1 |",
      "| 가 | 다 | 2 |",
    ].join("\n"))
  })

  it("중첩 표 1단 → 루트 id 표지, 부모 셀 표지, 자식 표 앞 표지, 자식 표는 부모 뒤", () => {
    assert.equal(blocksToMarkdown(oneLevel(), GFM), [
      "<!-- <table id=\"t1\" /> -->",
      "| 구분 | 내용 |",
      "| --- | --- |",
      "| 예산 | 총액 <!-- <table parent_id=\"t1\" child_id=\"t2\" /> --> |",
      "| 기간 | 1년 |",
      "",
      "<!-- <table id=\"t2\" parent_id=\"t1\" /> -->",
      "| 항목 | 금액 |",
      "| --- | --- |",
      "| 인건비 | 100 |",
    ].join("\n"))
  })

  it("중첩 표 3단 → 전위 깊이 우선 순서, id·parent_id 연쇄", () => {
    const leaf = tbl([[c("손자"), c("L3")]])
    const mid = tbl([[c("자식"), nestCell("L2", leaf)]])
    const sib = tbl([[c("자식2"), c("L2b")]])
    const blocks = [tableBlock(tbl([[c("부모"), nestCell("L1", mid)], [c("둘째"), nestCell("L1b", sib)]]))]
    const md = blocksToMarkdown(blocks, GFM)
    assert.ok(md.startsWith("<!-- <table id=\"t1\" /> -->\n| 부모 |"))
    assert.equal((md.match(/<!-- <table id="t\d+" \/> -->/g) ?? []).length, 1) // 루트만 부모 없는 표지
    assert.deepEqual(markerIds(md), [["t2", "t1"], ["t3", "t2"], ["t4", "t1"]])
    assert.deepEqual(cellMarkers(md), [["t1", "t2"], ["t1", "t4"], ["t2", "t3"]])
    // 출력 순서: 부모 → 자식(t2) → 손자(t3) → 자식2(t4)
    const order = ["| 부모 |", "| 자식 |", "| 손자 |", "| 자식2 |"].map(s => md.indexOf(s))
    assert.deepEqual([...order].sort((a, b) => a - b), order)
    assert.ok(order.every(i => i >= 0))
  })

  it("한 셀에 중첩 표 2개 → 표지 2개, 셀 안 순서대로 출력", () => {
    const a = tbl([[c("A표"), c("1")]])
    const b = tbl([[c("B표"), c("2")]])
    const md = blocksToMarkdown([tableBlock(tbl([[c("머리"), c("칸")], [c("몸"), nestCell("앞글", a, b)]]))], GFM)
    assert.match(md, /\| 앞글 <!-- <table parent_id="t1" child_id="t2" \/> --> <!-- <table parent_id="t1" child_id="t3" \/> --> \|/)
    assert.ok(md.indexOf("| A표 |") < md.indexOf("| B표 |"))
    assert.deepEqual(markerIds(md), [["t2", "t1"], ["t3", "t1"]])
  })

  it("renderAsTable 1열 표 → 파이프 표", () => {
    const md = blocksToMarkdown([tableBlock(tbl([[c("항목")], [c("값1")], [c("값2")]], { renderAsTable: true }))], GFM)
    assert.equal(md, "| 항목 |\n| --- |\n| 값1 |\n| 값2 |")
  })

  it("셀 안 구분선은 빼고 문단은 <br> 로 잇는다", () => {
    const md = blocksToMarkdown([tableBlock(tbl([[c("가"), c("나")], [c("다"), c("위\n아래", {
      blocks: [{ type: "paragraph", text: "위" }, { type: "separator" }, { type: "paragraph", text: "아래" }],
    })]]))], GFM)
    assert.match(md, /\| 다 \| 위<br>아래 \|/)
    assert.ok(!md.includes("<table") && !md.includes("<hr"))
  })

  it("markdown-it 렌더 — 표 수 = IR 표 수, 표지 뒤 표가 밀리지 않는다", () => {
    const leaf = tbl([[c("손자"), c("L3")], [c("x"), c("y")]])
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "앞 문단" },
      tableBlock(tbl([[c("부모", { colSpan: 2 }), c("")], [c("칸"), nestCell("L1", tbl([[c("자식"), nestCell("L2", leaf)]]))]])),
      { type: "paragraph", text: "뒤 문단" },
    ]
    const html = new MarkdownIt({ html: true }).render(blocksToMarkdown(blocks, GFM))
    assert.equal((html.match(/<table>/g) ?? []).length, 3)
    // 표지는 주석으로만 남고 표 행이 원문 그대로 새지 않는다
    assert.ok(!/<p>[^<]*\|/.test(html))
    assert.ok(html.includes("<td>y</td>"))
    assert.ok(html.includes("<p>뒤 문단</p>"))
  })
})

describe("tableFormat gfm — 세로 병합 채우기", () => {
  /** 인건비 rowSpan 3, 운영비 rowSpan 2, 임차·위탁 rowSpan 2 · colSpan 2 */
  const mixed = (): IRBlock[] => [tableBlock(tbl([
    [c("구분"), c("항목"), c("금액"), c("비고")],
    [c("인건비", { rowSpan: 3 }), c("책임"), c("100"), c("")],
    [c(""), c("선임"), c("80"), c("")],
    [c(""), c("연구원"), c("60"), c("")],
    [c("운영비", { rowSpan: 2 }), c("임차·위탁", { rowSpan: 2, colSpan: 2 }), c(""), c("2건")],
    [c(""), c(""), c(""), c("")],
  ]))]

  it("rowSpan 은 덮인 행마다 같은 값, colSpan 은 시작 칸에만", () => {
    assert.equal(blocksToMarkdown(mixed(), GFM), [
      "| 구분 | 항목 | 금액 | 비고 |",
      "| --- | --- | --- | --- |",
      "| 인건비 | 책임 | 100 |  |",
      "| 인건비 | 선임 | 80 |  |",
      "| 인건비 | 연구원 | 60 |  |",
      "| 운영비 | 임차·위탁 |  | 2건 |",
      "| 운영비 | 임차·위탁 |  |  |",
    ].join("\n"))
  })

  it("rowSpan 이 표 끝을 넘으면 표 끝에서 자른다", () => {
    const md = blocksToMarkdown([tableBlock(tbl([[c("머리"), c("값")], [c("넘침", { rowSpan: 5 }), c("1")], [c(""), c("2")]]))], GFM)
    assert.equal(md, "| 머리 | 값 |\n| --- | --- |\n| 넘침 | 1 |\n| 넘침 | 2 |")
  })

  it("세로 병합 칸 안 중첩 표 → 표지는 시작 행에만, 자식 표 1회, 덮인 행은 표지 없는 글", () => {
    const child = tbl([[c("자식"), c("v")]])
    const md = blocksToMarkdown([tableBlock(tbl([
      [c("구분"), c("값")],
      [nestCell("병합 글", child), c("1")],
      [c(""), c("2")],
    ].map((row, r) => r === 1 ? [{ ...row[0], rowSpan: 2 }, row[1]] : row)))], GFM)
    assert.match(md, /\| 병합 글 <!-- <table parent_id="t1" child_id="t2" \/> --> \| 1 \|\n\| 병합 글 \| 2 \|/)
    assert.equal(cellMarkers(md).length, 1)
    assert.equal((md.match(/\| 자식 \|/g) ?? []).length, 1)
    assert.deepEqual(markerIds(md), [["t2", "t1"]])
  })

  it("같은 IR 을 기본 경로로 렌더하면 종전 HTML 그대로", () => {
    assert.equal(blocksToMarkdown(mixed()), [
      "<table>",
      "<tr><th>구분</th><th>항목</th><th>금액</th><th>비고</th></tr>",
      "<tr><td rowspan=\"3\">인건비</td><td>책임</td><td>100</td><td></td></tr>",
      "<tr><td>선임</td><td>80</td><td></td></tr>",
      "<tr><td>연구원</td><td>60</td><td></td></tr>",
      "<tr><td rowspan=\"2\">운영비</td><td colspan=\"2\" rowspan=\"2\">임차·위탁</td><td>2건</td></tr>",
      "<tr><td></td></tr>",
      "</table>",
    ].join("\n"))
  })
})

describe("tableFormat gfm — 표 id 일관성", () => {
  it("IR 에 markdownId 로 남는다 (원본 sourceId 와 별개)", () => {
    const blocks = oneLevel()
    blocks[0].table!.sourceId = "123"
    blocksToMarkdown(blocks, GFM)
    const parent = blocks[0].table!
    assert.equal(parent.markdownId, "t1")
    assert.equal(parent.sourceId, "123")
    assert.equal(parent.cells[1][1].blocks![1].table!.markdownId, "t2")
  })

  const twoPages = (): IRBlock[] => [
    { type: "paragraph", text: "1쪽", pageNumber: 1 },
    ...oneLevel().map(b => ({ ...b, pageNumber: 1 })),
    { type: "paragraph", text: "2쪽", pageNumber: 2 },
    tableBlock(tbl([[c("둘째 표"), nestCell("안", tbl([[c("둘째 자식"), c("v")]]))]]), 2),
  ]

  it("쪽이 다른 표 → 전체 Markdown 과 pages[].markdown 의 id 일치", () => {
    const blocks = twoPages()
    const full = blocksToMarkdown(blocks, GFM)
    const pages = blocksToPages(blocks, bs => blocksToMarkdown(bs, GFM))!
    assert.deepEqual(markerIds(full), [["t2", "t1"], ["t4", "t3"]])
    assert.deepEqual(markerIds(pages[0].markdown), [["t2", "t1"]])
    assert.deepEqual(markerIds(pages[1].markdown), [["t4", "t3"]])
  })

})

describe("tableFormat gfm — 옵션", () => {
  it("옵션 미지정 → 종전 HTML 출력 그대로", () => {
    assert.equal(blocksToMarkdown(oneLevel()), [
      "<table>",
      "<tr><th>구분</th><th>내용</th></tr>",
      "<tr><td>예산</td><td>총액<br><table>",
      "<tr><th>항목</th><th>금액</th></tr>",
      "<tr><td>인건비</td><td>100</td></tr>",
      "</table></td></tr>",
      "<tr><td>기간</td><td>1년</td></tr>",
      "</table>",
    ].join("\n"))
    const blocks = oneLevel()
    blocksToMarkdown(blocks)
    assert.equal(blocks[0].table!.markdownId, undefined) // 기본 렌더는 IR 도 건드리지 않는다
  })
})
