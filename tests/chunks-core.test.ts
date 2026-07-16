/**
 * RAG용 구조 보존 청킹 (src/chunks.ts) 핵심 검증.
 *
 * - breadcrumb 정확성: 헤딩 스택 + listDepth 팝/푸시 + 하위 항목 있는 항목의 승격
 * - granularity 두 모드 (section 병합 / block 1:1)
 * - 표 독립 청크 (병합 금지) + includeTableCells
 * - blockRange 정합: 청크 범위 합집합 = 비어있지 않은 전체 블록, 비중첩·단조 증가
 * - 실파일 검증: markdownToHwpx → parse 왕복 IR (외부 파일 의존 없음)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blocksToChunks } from "../src/chunks.js"
import type { DocChunk } from "../src/chunks.js"
import type { IRBlock, IRTable } from "../src/types.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import { markdownToHwpx, parse } from "../src/index.js"

const TABLE: IRTable = {
  rows: 2,
  cols: 2,
  hasHeader: true,
  cells: [
    [
      { text: "항목", colSpan: 1, rowSpan: 1 },
      { text: "값", colSpan: 1, rowSpan: 1 },
    ],
    [
      { text: "예산", colSpan: 1, rowSpan: 1 },
      { text: "100", colSpan: 1, rowSpan: 1 },
    ],
  ],
}

/** 개조식 문서 IR 모형 — 헤딩 2단 + listDepth 0~2 + 표 + 평문 + 빈 블록 */
const DOC: IRBlock[] = [
  { type: "heading", level: 1, text: "추진 계획", pageNumber: 1 }, // 0
  { type: "heading", level: 2, text: "1. 개요", pageNumber: 1 }, // 1
  { type: "paragraph", text: "도입 문단", pageNumber: 1 }, // 2
  { type: "paragraph", text: "□ 추진 배경", listDepth: 0, pageNumber: 1 }, // 3
  { type: "paragraph", text: "○ 세부 배경 하나", listDepth: 1, pageNumber: 1 }, // 4
  { type: "paragraph", text: "- 세부 근거", listDepth: 2, pageNumber: 2 }, // 5
  { type: "paragraph", text: "○ 세부 배경 둘", listDepth: 1, pageNumber: 2 }, // 6
  { type: "paragraph", text: "", pageNumber: 2 }, // 7 빈 블록 — 스킵 대상
  { type: "table", table: TABLE, pageNumber: 2 }, // 8
  { type: "heading", level: 2, text: "2. 향후 일정", pageNumber: 3 }, // 9
  { type: "paragraph", text: "일정 본문", pageNumber: 3 }, // 10
]

/** blockRange 정합 — 비중첩·단조 증가 + 비어있지 않은 블록 전량 커버 */
function assertRangeIntegrity(chunks: DocChunk[], blocks: IRBlock[]) {
  const covered = new Set<number>()
  let prevEnd = -1
  for (const c of chunks) {
    const [start, end] = c.blockRange
    assert.ok(start > prevEnd, `blockRange 비중첩·단조 증가 위반: ${c.id} [${start},${end}]`)
    assert.ok(end >= start, `blockRange 역전: ${c.id}`)
    prevEnd = end
    for (let i = start; i <= end; i++) covered.add(i)
  }
  blocks.forEach((b, i) => {
    if (blocksToMarkdown([b])) assert.ok(covered.has(i), `비어있지 않은 블록 ${i} 누락`)
  })
}

describe("blocksToChunks — breadcrumb (section 기본)", () => {
  const chunks = blocksToChunks(DOC)

  it("헤딩 스택 — 헤딩 청크는 상위 헤딩만 breadcrumb", () => {
    const [h1, h2] = chunks
    assert.equal(h1.type, "heading")
    assert.equal(h1.text, "# 추진 계획")
    assert.deepEqual(h1.breadcrumb, [])
    assert.equal(h2.text, "## 1. 개요")
    assert.deepEqual(h2.breadcrumb, ["추진 계획"])
  })

  it("listDepth 위계 — 깊이 d 등장 시 depth>=d 팝, 하위 항목 있는 항목은 승격", () => {
    const deep = chunks.find(c => c.text.includes("세부 근거"))!
    assert.deepEqual(deep.breadcrumb, ["추진 계획", "1. 개요", "□ 추진 배경", "○ 세부 배경 하나"])
    // 형제(depth1) 복귀 — depth>=1 팝으로 '하나'가 빠진다
    const sibling = chunks.find(c => c.text.includes("세부 배경 둘"))!
    assert.deepEqual(sibling.breadcrumb, ["추진 계획", "1. 개요", "□ 추진 배경"])
  })

  it("헤딩 등장 시 리스트 위계 리셋", () => {
    const last = chunks.find(c => c.text === "일정 본문")!
    assert.deepEqual(last.breadcrumb, ["추진 계획", "2. 향후 일정"])
  })

  it("section 병합 — 같은 breadcrumb 연속 텍스트 블록은 \\n\\n join", () => {
    // '도입 문단'(평문)과 '□ 추진 배경'(depth0, 승격 전) breadcrumb 동일 → 병합
    const merged = chunks.find(c => c.text.includes("도입 문단"))!
    assert.equal(merged.text, "도입 문단\n\n□ 추진 배경")
    assert.deepEqual(merged.blockRange, [2, 3])
  })

  it("page — 첫 블록의 페이지 정보", () => {
    assert.equal(chunks[0].page, 1)
    const deep = chunks.find(c => c.text.includes("세부 근거"))!
    assert.equal(deep.page, 2)
  })

  it("id 순번 4자리 + 결정성 (같은 입력 → 같은 출력)", () => {
    assert.deepEqual(chunks.map(c => c.id), chunks.map((_, i) => "c" + String(i + 1).padStart(4, "0")))
    assert.deepEqual(blocksToChunks(DOC), chunks)
  })

  it("blockRange 정합 — 빈 블록(7) 제외 전량 커버", () => {
    assertRangeIntegrity(chunks, DOC)
    assert.ok(chunks.every(c => c.blockRange[0] !== 7 && c.blockRange[1] !== 7))
  })
})

describe("blocksToChunks — granularity·표·옵션", () => {
  it("granularity block — 비어있지 않은 블록 1개 = 청크 1개", () => {
    const chunks = blocksToChunks(DOC, { granularity: "block" })
    const nonEmpty = DOC.filter(b => blocksToMarkdown([b]))
    assert.equal(chunks.length, nonEmpty.length)
    assert.ok(chunks.every(c => c.blockRange[0] === c.blockRange[1]))
    // section에서 병합되던 두 블록이 분리, breadcrumb은 동일
    const intro = chunks.find(c => c.text === "도입 문단")!
    const item = chunks.find(c => c.text === "□ 추진 배경")!
    assert.deepEqual(intro.breadcrumb, item.breadcrumb)
    assertRangeIntegrity(chunks, DOC)
  })

  it("표는 항상 독립 청크 — 앞뒤 텍스트와 병합 금지, 구조 요약 포함", () => {
    const chunks = blocksToChunks(DOC)
    const table = chunks.find(c => c.type === "table")!
    assert.deepEqual(table.blockRange, [8, 8])
    assert.deepEqual(table.table, { rows: 2, cols: 2 })
    assert.match(table.text, /\| 항목 \| 값 \|/) // GFM 그대로
    assert.deepEqual(table.breadcrumb, ["추진 계획", "1. 개요", "□ 추진 배경", "○ 세부 배경 둘"])
    // 텍스트 청크에는 table 필드 없음
    assert.ok(chunks.filter(c => c.type !== "table").every(c => c.table === undefined))
  })

  it("includeTableCells — 기본 false, true면 셀 텍스트 행렬 포함", () => {
    const off = blocksToChunks(DOC).find(c => c.type === "table")!
    assert.ok(!("cells" in off.table!))
    const on = blocksToChunks(DOC, { includeTableCells: true }).find(c => c.type === "table")!
    assert.deepEqual(on.table!.cells, [
      ["항목", "값"],
      ["예산", "100"],
    ])
  })

  it("빈 입력 → 빈 배열", () => {
    assert.deepEqual(blocksToChunks([]), [])
  })

  it("page 없는 IR — 필드 자체를 생략", () => {
    const chunks = blocksToChunks([{ type: "paragraph", text: "본문" }])
    assert.equal(chunks.length, 1)
    assert.ok(!("page" in chunks[0]))
  })

  it("listDepth 없는 개조식 부호 문단 — depth 0 항목으로 승격 (파서 실태 반영)", () => {
    // 파서는 '- '·'1) '에만 listDepth(1~)를 채운다 — depth0 '□' 항목은 부호로 식별
    const chunks = blocksToChunks([
      { type: "paragraph", text: "□ 추진 배경" },
      { type: "paragraph", text: "○ 세부 항목", listDepth: 1 },
      { type: "paragraph", text: "평문은 리스트 문맥을 잇는다" },
    ])
    assert.deepEqual(chunks.find(c => c.text.includes("세부 항목"))!.breadcrumb, ["□ 추진 배경"])
    assert.deepEqual(chunks.find(c => c.text.includes("평문"))!.breadcrumb, ["□ 추진 배경", "○ 세부 항목"])
  })
})

describe("blocksToChunks — 실파일 왕복 (markdownToHwpx → parse)", () => {
  const MD = `# 사업 계획

## 1. 개요

도입 문단

| 항목 | 값 |
| --- | --- |
| 예산 | 100 |

## 2. 일정

일정 본문`

  it("왕복 IR에서 breadcrumb·표 청크·blockRange 정합", async () => {
    const buf = await markdownToHwpx(MD)
    const res = await parse(Buffer.from(buf))
    assert.ok(res.success, "왕복 파싱 성공")

    const chunks = blocksToChunks(res.blocks)
    assert.ok(chunks.length > 0)

    // 헤딩 위계가 breadcrumb으로 복원
    const intro = chunks.find(c => c.text.includes("도입 문단"))!
    assert.ok(intro, "도입 문단 청크 존재")
    assert.deepEqual(intro.breadcrumb, ["사업 계획", "1. 개요"])

    // 표 독립 청크 + 구조 요약
    const table = chunks.find(c => c.type === "table")!
    assert.ok(table, "표 청크 존재")
    assert.equal(table.table!.rows, 2)
    assert.equal(table.table!.cols, 2)
    assert.match(table.text, /예산/)
    assert.deepEqual(table.breadcrumb, ["사업 계획", "1. 개요"])

    assertRangeIntegrity(chunks, res.blocks)

    // 결정성 — 같은 IR 두 번 청킹해도 동일
    assert.deepEqual(blocksToChunks(res.blocks), chunks)
  })
})
