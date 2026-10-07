/**
 * 쪽 넘김으로 이은 표의 쪽 귀속 (#136 후속) — 이은 표는 첫 쪽 블록 하나라 JSON pages 에서 뒤 쪽 행이 앞 쪽 항목에 실리고, 쪽 내용이
 * 표뿐이면 그 쪽 항목이 빠졌다(조세특례제한법 시행령 [별표 7의2] 11쪽 표 → pages 1개). 문서 마크다운은 이은 그대로, pages 만 쪽마다 가른다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mergeCrossPageTables } from "../src/pdf/table-parts.js"
import { mergeContinuedCells } from "../src/pdf/cell-continuation.js"
import { splitPageTables } from "../src/pdf/table-pages.js"
import { CLIP_TABLES, CONT_PARTS, TABLE_COLXS, recordCellLines } from "../src/pdf/table-meta.js"
import { CELL_EDGES, CELL_PAGES, unframeLayoutTables } from "../src/table/layout-frames.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

function grid(rows: number, cols: number, anchors: Array<[number, number, string, number?, number?]>): IRTable {
  const cells: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  for (const [r, c, text, cs = 1, rs = 1] of anchors) cells[r][c] = { text, colSpan: cs, rowSpan: rs }
  return { rows, cols, cells, hasHeader: rows > 1 }
}

function lines(cell: IRCell, spec: Array<[number, number, number]>): void {
  recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 10, h: 10 })))
}

const tableBlock = (table: IRTable, page: number): IRBlock =>
  ({ type: "table", table, pageNumber: page, bbox: { page, x: 50, y: 70, width: 450, height: 630 } })

/** 표 블록 → [쪽, 행마다 칸 글] */
const view = (blocks: IRBlock[]): Array<[number | undefined, string[][]]> =>
  blocks.map(b => [b.pageNumber, b.table!.cells.map(row => row.map(c => c.text))])

describe("쪽별 사영에서 이은 표 가르기", () => {
  // 반복 머리행 + 본문 행 — 선 격자 표 (pdf-cross-page-rows 와 같은 합성 좌표)
  const blocksOf = (a: string, b: string, nameA = "현행 조문 내용", nameB = "현행 조문 내용"): IRBlock[] => {
    const prev = grid(2, 2, [[0, 0, "현행"], [0, 1, "개정안"], [1, 0, nameA], [1, 1, a]])
    const curr = grid(2, 2, [[0, 0, "현행"], [0, 1, "개정안"], [1, 0, nameB], [1, 1, b]])
    for (const t of [prev, curr]) TABLE_COLXS.set(t, [50, 250, 500])
    lines(prev.cells[1][0], nameA === nameB ? [[60, 180, 100], [60, 180, 80]] : [[60, 130, 80]])
    lines(prev.cells[1][1], [[260, 490, 100], [260, 490, 80]])
    lines(curr.cells[1][0], nameA === nameB ? [[60, 180, 700], [60, 180, 680]] : [[60, 130, 700]])
    lines(curr.cells[1][1], [[260, 490, 700], [260, 400, 680]])
    return [tableBlock(prev, 1), tableBlock(curr, 2)]
  }

  it("뒤 쪽 행은 뒤 쪽 항목으로 — 되풀이 머리 행은 빠진 채", () => {
    const blocks = blocksOf("기관이 지원한다.", "사업을 검토한다.", "가. 첫 기관", "나. 둘째 기관")
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 3)
    assert.deepEqual(view(splitPageTables(blocks)), [
      [1, [["현행", "개정안"], ["가. 첫 기관", "기관이 지원한다."]]],
      [2, [["나. 둘째 기관", "사업을 검토한다."]]],
    ])
    // 문서 블록은 이은 그대로
    assert.equal(blocks[0].table!.rows, 3)
  })

  it("쪼개진 행은 칸 글을 쪽 경계에서 갈라 뒤 쪽 몫을 뒤 쪽 행으로", () => {
    const blocks = blocksOf("기관이 지원하는", "사업의 세부 내용을 검토한다.")
    mergeCrossPageTables(blocks)
    assert.equal(blocks[0].table!.rows, 2)
    const split = splitPageTables(blocks)
    assert.deepEqual(split.map(b => b.pageNumber), [1, 2])
    assert.equal(split[0].table!.cells[1][1].text, "기관이 지원하는")
    assert.equal(split[1].table!.cells[0][1].text, "사업의 세부 내용을 검토한다.")
  })

  it("칸 이어짐(쪽을 넘은 1칸 조각)도 칸 안 블록의 쪽으로 가른다", () => {
    const prev = grid(2, 1, [[0, 0, "비고"], [1, 0, "1. 앞 쪽 글"]])
    const part = grid(1, 1, [[0, 0, "2. 뒤 쪽 글"]])
    for (const t of [prev, part]) CLIP_TABLES.add(t)
    CONT_PARTS.set(part, { x1: 50, x2: 500 })
    const blocks = [tableBlock(prev, 1), tableBlock(part, 2)]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 1)
    assert.deepEqual(view(splitPageTables(blocks)), [
      [1, [["비고"], ["1. 앞 쪽 글"]]],
      [2, [["2. 뒤 쪽 글"]]],
    ])
  })

  it("세 쪽에 걸친 칸 이어짐은 가운데 쪽도 제 항목에", () => {
    const prev = grid(2, 1, [[0, 0, "비고"], [1, 0, "1. 1쪽 글"]])
    const p2 = grid(1, 1, [[0, 0, "2. 2쪽 글"]]), p3 = grid(1, 1, [[0, 0, "3. 3쪽 글"]])
    for (const t of [prev, p2, p3]) CLIP_TABLES.add(t)
    for (const t of [p2, p3]) CONT_PARTS.set(t, { x1: 50, x2: 500 })
    const blocks = [tableBlock(prev, 1), tableBlock(p2, 2), tableBlock(p3, 3)]
    mergeContinuedCells(blocks)
    assert.equal(blocks.length, 1)
    assert.deepEqual(view(splitPageTables(blocks)), [
      [1, [["비고"], ["1. 1쪽 글"]]],
      [2, [["2. 2쪽 글"]]],
      [3, [["3. 3쪽 글"]]],
    ])
  })

  it("되풀이 머리 행만 빠진 잇기는 앞 쪽 칸 글을 가르지 않는다 (머리 글이 칸 글 안에 있어도)", () => {
    const blocks = blocksOf("기관이 개정안을 지원한다.", "사업을 검토한다.", "가. 첫 기관", "나. 둘째 기관")
    mergeCrossPageTables(blocks)
    assert.deepEqual(view(splitPageTables(blocks)), [
      [1, [["현행", "개정안"], ["가. 첫 기관", "기관이 개정안을 지원한다."]]],
      [2, [["나. 둘째 기관", "사업을 검토한다."]]],
    ])
  })

  it("세 쪽에 걸친 쪼개진 행은 쪽마다 가른다", () => {
    const mk = (page: number, a: string, b: string): IRBlock => {
      const t = grid(2, 2, [[0, 0, "현행"], [0, 1, "개정안"], [1, 0, a], [1, 1, b]])
      TABLE_COLXS.set(t, [50, 250, 500])
      lines(t.cells[1][0], [[60, 180, page === 1 ? 100 : 700], [60, 180, page === 1 ? 80 : 680]])
      lines(t.cells[1][1], [[260, 490, page === 1 ? 100 : 700], [260, 490, page === 1 ? 80 : 680]])
      return tableBlock(t, page)
    }
    const blocks = [mk(1, "현행 조문 내용", "기관이 지원하는"), mk(2, "현행 조문 내용", "사업의 세부 내용과"), mk(3, "현행 조문 내용", "그 밖의 사항을 검토한다.")]
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 1)
    const split = splitPageTables(blocks)
    assert.deepEqual(split.map(b => b.pageNumber), [1, 2, 3])
    assert.deepEqual(split.map(b => b.table!.cells.at(-1)![1].text), ["기관이 지원하는", "사업의 세부 내용과", "그 밖의 사항을 검토한다."])
  })

  it("쪽 경계를 넘는 세로 병합 칸은 앞 쪽 끝 행에서 자른다", () => {
    const t = grid(3, 2, [[0, 0, "구분", 1, 3], [0, 1, "첫째"], [1, 1, "둘째"], [2, 1, "셋째"]])
    CELL_PAGES.set(t.cells[2][1], 2)
    const split = splitPageTables([tableBlock(t, 1)])
    assert.deepEqual(split.map(b => [b.pageNumber, b.table!.rows]), [[1, 2], [2, 1]])
    assert.equal(split[0].table!.cells[0][0].rowSpan, 2)
    assert.equal(t.cells[0][0].rowSpan, 3) // 원 표는 그대로
  })

  it("쪽 표시가 없는 표는 그대로 둔다", () => {
    const b = tableBlock(grid(2, 2, [[0, 0, "가"], [0, 1, "나"], [1, 0, "다"], [1, 1, "라"]]), 3)
    assert.equal(splitPageTables([b])[0], b)
  })
})

describe("틀 풀기는 칸이 놓인 쪽을 따른다", () => {
  it("보이지 않는 틀에서 편 문단은 그 행 칸의 쪽", () => {
    const NONE = { t: false, b: false, l: false, r: false }
    const t = grid(2, 1, [[0, 0, "앞 쪽 문단"], [1, 0, "뒤 쪽 비고"]])
    for (const row of t.cells) for (const c of row) CELL_EDGES.set(c, NONE)
    CELL_PAGES.set(t.cells[1][0], 11)
    const out = unframeLayoutTables([{ type: "table", table: t, pageNumber: 1 }])
    assert.deepEqual(out.map(b => [b.type, b.pageNumber, b.text]), [["paragraph", 1, "앞 쪽 문단"], ["paragraph", 11, "뒤 쪽 비고"]])
  })
})
