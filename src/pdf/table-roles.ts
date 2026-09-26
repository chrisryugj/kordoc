/**
 * 괘선 없는 표 후보의 역할 판정 — 목차와 산문은 열이 맞아 보여도 데이터 표가 아니다.
 *
 * 클러스터 감지는 글 조각의 x 정렬만으로 열을 세우므로 목차(항목 + 쪽번호)와 단 사이·수식
 * 옆에 벌어진 본문 줄도 표로 묶는다. 여기서는 셀 글의 역할 증거만 본다:
 * - 목차: 마지막 열이 위에서 아래로 증가하는 쪽번호(로마 숫자 머리말 뒤 아라비아 숫자 재시작 허용)
 * - 산문: 한 칸에 문장 여러 줄이 뭉친 긴 칸이 표 글의 과반이고 짧은 라벨 열이 없음
 */

import type { BoundingBox, IRBlock, IRTable } from "../types.js"

/** Paragraph blocks made from a table of contents — a title between two of them is a TOC entry too. */
export const TOC_BLOCKS = new WeakSet<IRBlock>()

const PAGE_LABEL = /^(?:\d{1,4}|[ivxlc]{1,7})$/i

function romanValue(label: string): number {
  const digits: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100 }
  let total = 0
  const chars = label.toLowerCase()
  for (let i = 0; i < chars.length; i++) {
    const value = digits[chars[i]], next = digits[chars[i + 1]] ?? 0
    total += value < next ? -value : value
  }
  return total
}

/** Entries followed by page labels that only grow down the column. */
export function isTableOfContents(table: IRTable): boolean {
  if (table.rows < 3 || table.cols < 2) return false
  const labels: string[] = []
  let entries = 0
  for (const row of table.cells) {
    const texts = row.map(cell => cell.text.trim())
    const last = texts[texts.length - 1]
    if (!last) continue
    if (!PAGE_LABEL.test(last)) return false
    if (/\p{L}/u.test(texts.slice(0, -1).join(""))) entries++
    labels.push(last)
  }
  if (labels.length < 3 || entries < labels.length * 0.8) return false
  let previous: { roman: boolean; value: number } | undefined
  for (const label of labels) {
    const roman = !/^\d/.test(label)
    const value = roman ? romanValue(label) : Number(label)
    // Front matter numbered in roman figures restarts at arabic 1.
    if (previous && previous.roman === roman && value < previous.value) return false
    if (previous && previous.roman && !roman) previous = undefined
    previous = { roman, value }
  }
  return true
}

/** Several wrapped sentences collapsed into single cells carry most of the text,
 * spread over many rows (a real table may only absorb one trailing paragraph). */
export function isProseTable(table: IRTable): boolean {
  let total = 0, long = 0, rows = 0, longRows = 0
  for (const row of table.cells) {
    const lengths = row.map(cell => cell.text.replace(/\s+/g, " ").trim().length)
    if (lengths.some(Boolean)) rows++
    if (lengths.some(length => length >= 80)) longRows++
    for (const length of lengths) {
      total += length
      if (length >= 80) long += length
    }
  }
  if (!(long > 0 && long >= total * 0.5 && longRows >= rows * 0.4)) return false
  // A real table keeps a short label column beside its long descriptions (필드 | 항목 | 의미).
  for (let c = 0; c < table.cols; c++) {
    const filled = table.cells.map(row => row[c]).filter(cell => cell && cell.colSpan < table.cols && cell.text.trim())
      .map(cell => cell!.text.trim())
    if (filled.length >= 3 && filled.length >= rows * 0.6 &&
        filled.every(text => text.length <= 30 && (text.match(/\p{L}/gu)?.length ?? 0) >= 2)) return false
  }
  return true
}

/** A TOC keeps its "entry page" lines in reading order as one text block. */
export function tocBlock(table: IRTable, pageNum: number, bbox: BoundingBox, style?: IRBlock["style"]): IRBlock {
  const text = table.cells.map(row => row.map(cell => cell.text.replace(/\s+/g, " ").trim()).filter(Boolean).join(" "))
    .filter(Boolean).join("\n")
  const block: IRBlock = { type: "paragraph", text, pageNumber: pageNum, bbox, ...(style ? { style } : {}) }
  TOC_BLOCKS.add(block)
  return block
}

const NUMERIC_CELL = /^[\s\d.,%()+\-–−$€£¥]*\d[\s\d.,%()+\-–−$€£¥]*$/

/** A value axis: four or more ticks read top to bottom with one constant step down. */
function hasValueAxis(values: number[]): boolean {
  for (let start = 0; start + 3 < values.length; start++) {
    const step = values[start] - values[start + 1]
    if (step <= 0) continue
    let run = 2
    while (start + run < values.length && Math.abs(values[start + run - 1] - values[start + run] - step) <= step * 1e-6) run++
    if (run >= 4) return true
  }
  return false
}

/** Bars and gridlines of a chart drawn as vectors look like a sparse numeric grid.
 * Evidence: a value-axis column, or mostly empty cells whose text is mostly numbers. */
export function isChartTable(table: IRTable): boolean {
  const texts = table.cells.flat().map(cell => cell.text.trim()).filter(Boolean)
  if (table.rows < 3 || texts.length === 0) return false
  const numeric = texts.filter(text => NUMERIC_CELL.test(text)).length
  if (numeric < texts.length * 0.5) return false
  for (let c = 0; c < table.cols; c++) {
    const ticks = table.cells.flatMap(row => (row[c]?.text ?? "").split(/\s+/))
      .filter(token => /^-?[\d,]+(?:\.\d+)?%?$/.test(token)).map(token => Number(token.replace(/[,%]/g, "")))
    if (hasValueAxis(ticks)) return true
  }
  // Chart values read as quantities (3,230 · 2.5% · -6.4); hyphenated identifiers such as phone numbers do not.
  const values = texts.filter(text => text.split(/\s+/).every(token => /^[-−–]?[\d,]*\.?\d+%?$/.test(token))).length
  const cells = table.rows * table.cols
  return cells - texts.length >= cells * 0.55 && values >= texts.length * 0.8
}
