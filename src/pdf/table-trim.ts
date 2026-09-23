/**
 * PDF 표 후행 빈 열 정리 — HWPX·HWP5 표 빌더(`table/builder.ts` trimAndReturn)와 같은 규칙.
 *
 * 한컴 PDF 의 클립 셀 그리드는 원본 표의 칸을 그대로 담아, 원본에서 글이 한 자도 없는 마지막 열도 열로 낸다.
 * HWP 계열 파서는 그 열을 잘라 같은 문서가 포맷마다 열 수가 달라졌다(보도자료 머리표 2×3 ↔ 2×4, 행정업무운영
 * 편람 서식 15×6 ↔ 15×7 실측). 칸 단위로 전부 빈 마지막 열을 자르고, 잘린 열에 걸친 병합 셀은 표 폭 안으로 줄인다.
 * `keepTrailingEmptyCols`(#47, 서식 입력란 보존) 옵션이면 건드리지 않는다.
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import { IMAGE_CELLS } from "./table-meta.js"

export function markImageCell(cell: IRCell): void { IMAGE_CELLS.add(cell) }

const emptyCell = (cell: IRCell | undefined): boolean => !cell || (!cell.text?.trim() && !cell.blocks?.length && !IMAGE_CELLS.has(cell))

function trimTable(table: IRTable): void {
  let cols = table.cols
  while (cols > 0 && table.cells.every(row => emptyCell(row[cols - 1]))) cols--
  if (cols === table.cols || cols === 0) return // 전부 빈 표는 그대로 (builder 와 동일)
  table.cells = table.cells.map(row => row.slice(0, cols))
  for (const row of table.cells) {
    for (let c = 0; c < row.length; c++) {
      if (c + row[c].colSpan > cols) row[c].colSpan = cols - c
    }
  }
  table.cols = cols
}

/** 블록 트리 전체(틀 셀 안 중첩표 포함)의 표에서 후행 빈 열을 제자리 정리 */
export function trimTrailingEmptyTableCols(blocks: IRBlock[]): void {
  for (const b of blocks) {
    if (b.type !== "table" || !b.table) continue
    for (const row of b.table.cells) for (const cell of row) if (cell.blocks?.length) trimTrailingEmptyTableCols(cell.blocks)
    trimTable(b.table)
  }
}
