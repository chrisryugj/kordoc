/**
 * OCR 표 마지막 머리 행의 붙은 열 머리 — 열마다 따로인 머리 칸("도심 | 도시클러스터")을 검출기가 한 상자로 읽어 두 열에 걸친 칸 하나가 된다.
 * 바로 아래가 숫자 값 행인 머리 행에서, k 열에 걸친 칸의 글이 낱말(한글 2자+) 정확히 k 개이고 그 열들의 아래 칸 대부분(80%+)이 숫자면
 * 낱말마다 한 칸으로 나눈다. 묶음 머리("전년대비")는 아래에 하위 머리 행이 있어 마지막 머리 행이 아니다(OCR 전용)
 */
import type { IRBlock, IRCell, IRTable } from "../types.js"

const NUMBER = /^[-+−△▲▽▼]?[\d.,]+[%p]?$|^[-–—]$|^\([-+−△▲▽▼]?[\d.,]+%?\)$/

function splitTable(t: IRTable): void {
  if (t.cells.length !== t.rows || t.cells.some(row => row.length !== t.cols)) return
  const own: IRCell[][] = Array.from({ length: t.rows }, () => Array(t.cols))
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
    if (own[r][c]) continue
    const cell = t.cells[r][c]
    for (let i = r; i < Math.min(t.rows, r + Math.max(1, cell.rowSpan ?? 1)); i++)
      for (let j = c; j < Math.min(t.cols, c + Math.max(1, cell.colSpan ?? 1)); j++) own[i][j] ??= cell
  }
  const numericRow = (r: number) => {
    const texts = [...new Set(own[r])].map(c => c.text.trim()).filter(Boolean)
    return texts.length >= 2 && texts.filter(s => NUMBER.test(s.replace(/\s+/g, ""))).length >= texts.length * 0.5
  }
  // 첫 숫자 행 바로 위가 마지막 머리 행
  const first = [...Array(t.rows).keys()].find(numericRow)
  if (first === undefined || first < 1) return
  const r = first - 1
  for (let c = 0; c < t.cols; c++) {
    const cell = t.cells[r][c], k = cell.colSpan ?? 1
    if (own[r][c] !== cell || k < 2 || (cell.rowSpan ?? 1) !== 1 || cell.blocks?.length) continue
    const words = cell.text.trim().split(/\s+/)
    if (words.length !== k || words.some(w => (w.match(/[가-힣]/g) ?? []).length < 2)) continue
    // 걸친 열마다 아래 칸 대부분이 숫자
    let ok = true
    for (let j = c; j < c + k && ok; j++) {
      const below = [...new Set(own.slice(first).map(row => row[j]))].map(x => x.text.trim()).filter(Boolean)
      ok = below.length >= 2 && below.filter(s => NUMBER.test(s.replace(/\s+/g, ""))).length >= below.length * 0.8
    }
    if (!ok) continue
    words.forEach((w, i) => { t.cells[r][c + i] = { ...cell, text: w, colSpan: 1 } })
    c += k - 1
  }
}

/** OCR 블록의 표마다 마지막 머리 행의 붙은 열 머리를 가른다(제자리) */
export function splitOcrJoinedHeaders(blocks: IRBlock[]): IRBlock[] {
  for (const b of blocks) if (b.type === "table" && b.table) splitTable(b.table)
  return blocks
}
