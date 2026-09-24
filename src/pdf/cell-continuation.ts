/**
 * 쪽을 넘는 칸 잇기 (mergeContinuedCells) — 앞 쪽 칸의 이어짐으로 판정된 1칸 조각(CONT_PARTS, clip-cells)을 앞 쪽 표의 그 칸에 붙인다.
 *
 * 한컴 PDF 는 쪽을 넘는 칸을 쪽마다 그 쪽에 그려진 부분만 클립으로 깐다. 여러 칸 행이 넘어가면 뒤 쪽에도 칸 묶음이 생겨 쪽 넘김
 * 잇기(table-parts)가 잇지만, 한 칸만 넘어가면(1열 표의 본문 칸, 규제영향분석서 "근거설명 | 내용" 의 내용 칸) 뒤 쪽 조각은 1칸이다.
 * 그 조각을 새 행으로 붙이면 한 칸이 쪽 수만큼 행으로 갈리고, 조각에 든 표·글은 원본(HWPX) 칸 밖에 놓인다. 여기서는 조각의 글과
 * 표를 앞 쪽 칸 뒤에 이어 붙이고, 칸 안에서 쪽 경계로 갈린 표는 쪽 넘김 잇기로 다시 잇는다.
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import { CONT_PARTS, EMPTY_PARTS, TABLE_COLXS } from "./table-meta.js"
import { mergeCrossPageTables } from "./table-parts.js"

/** 조각의 좌우 변과 앞 표 열 경계를 같은 것으로 보는 거리 (pt) — 격자 열 경계는 클립 좌표 묶음(0.3pt)의 평균 */
const COL_MATCH_TOL = 0.5

/** 표 마지막 행까지 내려오는 칸 가운데 좌우 변이 x1~x2 인 칸 (열 경계를 모르는 1열 표는 그 칸) */
function lastRowCell(t: IRTable, x1: number, x2: number): IRCell | undefined {
  const xs = TABLE_COLXS.get(t)
  const covered = new Set<number>()
  for (let r = 0; r < t.rows; r++) {
    for (let c = 0; c < t.cols; c++) {
      if (covered.has(r * 100000 + c)) continue
      const cell = t.cells[r]?.[c]
      if (!cell) continue
      for (let dr = 0; dr < cell.rowSpan; dr++) for (let dc = 0; dc < cell.colSpan; dc++) covered.add((r + dr) * 100000 + c + dc)
      if (r + cell.rowSpan !== t.rows) continue
      if (xs ? Math.abs(xs[c] - x1) <= COL_MATCH_TOL && Math.abs(xs[c + cell.colSpan] - x2) <= COL_MATCH_TOL : t.cols === 1) return cell
    }
  }
  return undefined
}

/** 칸 내용을 블록으로 — blocks 가 없으면 text 줄마다 문단 (틀 칸 blocks 와 같은 모양) */
const cellBlocks = (cell: IRCell, pageNumber?: number): IRBlock[] =>
  cell.blocks ?? cell.text.split("\n").map(t => t.trim()).filter(Boolean).map(text => ({ type: "paragraph" as const, text, pageNumber }))

/** 표 블록들을 거꾸로 훑어 이어짐 조각을 앞 쪽 표 칸에 붙이고 조각은 뺀다 (세 쪽 넘게 이어지면 뒤 조각부터 앞 조각에 모인다) */
export function mergeContinuedCells(blocks: IRBlock[], pageHeights?: Map<number, number>): void {
  for (let j = blocks.length - 1; j > 0; j--) {
    const part = blocks[j]
    const from = part.table ? CONT_PARTS.get(part.table) : undefined
    if (!from || !part.table) continue
    // 앞 표 — 사이 글은 앞 쪽 꼬리말·이 쪽 머리말 띠뿐이다 (clip-cells 가 조각을 쪽 첫 내용, 앞 칸을 쪽 마지막 내용으로 골랐다)
    let i = j - 1
    while (i >= 0 && blocks[i].type !== "table") i--
    const prev = blocks[i]
    if (i < 0 || !prev.table || prev.pageNumber !== (part.pageNumber ?? 0) - 1) continue
    const cell = lastRowCell(prev.table, from.x1, from.x2)
    const add = part.table.cells[0]?.[0]
    if (!cell || !add) continue
    if (cell.blocks || add.blocks) cell.blocks = [...cellBlocks(cell, prev.pageNumber), ...cellBlocks(add, part.pageNumber)]
    cell.text = [cell.text, add.text].filter(s => s.trim()).join("\n")
    // 앞 쪽 조각이 빈 칸뿐이던 표(쪽 끝에 머리 행만 남은 칸)도 이어진 글을 받았으면 더는 빈 조각이 아니다 — 쪽 넘김 잇기가 버리지 않게
    if (cell.text.trim() || cell.blocks?.length) EMPTY_PARTS.delete(prev.table)
    blocks.splice(j, 1)
    // 칸 안에서 쪽 경계로 갈린 표 (반제품 아이스팩 기준 틀의 2×2 계산 예시: 첫 행만 앞 쪽에 남은 것)
    if (cell.blocks) mergeCrossPageTables(cell.blocks, pageHeights)
  }
}
