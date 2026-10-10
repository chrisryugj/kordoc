/**
 * 괘선 없는 표 후보의 역할 판정 — 목차와 산문은 열이 맞아 보여도 데이터 표가 아니다.
 *
 * 클러스터 감지는 글 조각의 x 정렬만으로 열을 세우므로 목차(항목 + 쪽번호)와 단 사이·수식
 * 옆에 벌어진 본문 줄도 표로 묶는다. 여기서는 셀 글의 역할 증거만 본다:
 * - 목차: 마지막 열이 위에서 아래로 증가하는 쪽번호(로마 숫자 머리말 뒤 아라비아 숫자 재시작 허용)
 * - 산문: 한 칸에 문장 여러 줄이 뭉친 긴 칸이 표 글의 과반이고 짧은 라벨 열이 없음
 */

import type { BoundingBox, IRBlock, IRTable } from "../types.js"
import type { NormItem } from "./text-line.js"

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

/** Entries followed by page labels that only grow down the column. A row may carry two entries' labels when the
 *  candidate merged two TOC lines into one row ("51 65" — 교육청 학교 매뉴얼 목차) */
export function isTableOfContents(table: IRTable): boolean {
  if (table.rows < 3 || table.cols < 2) return false
  const labels: string[] = []
  let entries = 0
  for (const row of table.cells) {
    const texts = row.map(cell => cell.text.trim())
    const last = texts[texts.length - 1]
    if (!last) continue
    const parts = last.split(/\s+/)
    if (!parts.every(p => PAGE_LABEL.test(p))) return false
    if (/\p{L}/u.test(texts.slice(0, -1).join(""))) entries += parts.length
    labels.push(...parts)
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

/** The longest run of four or more values falling by one constant step, as [start, length, step]. */
function fallingRun(values: number[]): [number, number, number] | null {
  let best: [number, number, number] | null = null
  for (let start = 0; start + 3 < values.length; start++) {
    const step = values[start] - values[start + 1]
    if (step <= 0) continue
    let run = 2
    while (start + run < values.length && Math.abs(values[start + run - 1] - values[start + run] - step) <= step * 1e-6) run++
    if (run >= 4 && (!best || run > best[1])) best = [start, run, step]
  }
  return best
}

/** A value axis: four or more ticks read top to bottom with one constant step down. */
function hasValueAxis(values: number[]): boolean {
  return fallingRun(values) !== null
}

const TICK = /^-?[\d,]+(?:\.\d+)?%?$/
const QUANTITY = /^[-−–]?[\d,]*\.?\d+%?$/
const quantity = (token: string) => Number(token.replace(/^[−–]/, "-").replace(/[,%]/g, ""))

/** A value axis inside a chart grid read from the text layer — the column's numbers, or the first number of each of its lines (a
 * tick sharing its line with a bar value, "80 45"), fall by one step over at least 80% of them, and the grid's other numbers sit on
 * that scale (a step past either end at most; years are category labels, not plotted values — "2014 2015 2016"). A statistics
 * table's data column holds such a run by chance ("23 21 19 17" among 46 values, 가계동향조사), and a column of years or scores
 * ("10.0 9.0 8.0 7.0") stands beside values far off its scale (예산서 계속비 연도 열, 평가 배점표). */
function isValueAxisColumn(table: IRTable, c: number): boolean {
  const lines = table.cells.flatMap(row => (row[c]?.text ?? "").split("\n").map(line => line.trim().split(/\s+/)))
  const others = table.cells.flatMap(row => row.filter((_, k) => k !== c).map(cell => cell.text.trim().split(/\s+/)))
    .filter(tokens => tokens.every(token => QUANTITY.test(token))).flat().map(quantity)
    .filter(v => !(Number.isInteger(v) && v >= 1900 && v <= 2100))
  for (const ticks of [lines.flat().filter(t => TICK.test(t)).map(quantity), lines.map(tokens => tokens[0]).filter(t => TICK.test(t)).map(quantity)]) {
    const run = fallingRun(ticks)
    if (!run || run[1] < ticks.length * 0.8) continue
    const [start, length, step] = run
    const hi = ticks[start] + step, lo = ticks[start + length - 1] - step
    if (others.filter(v => v >= lo && v <= hi).length >= others.length * 0.8) return true
  }
  return false
}

/** Three rows running each with three or more filled cells — values aligned in rows are a table even in a mostly empty grid
 * (호봉표 whose Korean labels have no text layer). A chart scatters its value labels. */
function hasAlignedRows(table: IRTable): boolean {
  let run = 0
  for (const row of table.cells) {
    run = row.filter(cell => cell.text.trim()).length >= 3 ? run + 1 : 0
    if (run >= 3) return true
  }
  return false
}

/** Value-axis ticks set just outside a chart grid's left or right edge — four or more numbers falling by one step top to bottom.
 * They are chart text: left in the page flow they formed one unit with the legend and source below it, read before the chart values (ODL 077). */
export function valueAxisBeside(free: NormItem[], box: { x1: number; y1: number; x2: number; y2: number }): NormItem[] {
  for (const left of [true, false]) {
    const ticks = free.filter(it => /^-?[\d,]+(?:\.\d+)?%?$/.test(it.text.trim()) && it.y >= box.y1 - it.fontSize && it.y <= box.y2 + it.fontSize &&
      (left ? it.x + it.w <= box.x1 + 3 && it.x + it.w >= box.x1 - it.fontSize * 2 : it.x >= box.x2 - 3 && it.x <= box.x2 + it.fontSize * 2))
      .sort((a, b) => b.y - a.y)
    if (hasValueAxis(ticks.map(it => Number(it.text.trim().replace(/[,%]/g, ""))))) return ticks
  }
  return []
}

/** Bars and gridlines of a chart drawn as vectors look like a sparse numeric grid.
 * Evidence: a value-axis column, or mostly empty cells whose text is mostly numbers scattered rather than aligned in rows.
 * A grid read by OCR from a chart image keeps the looser test — any four numbers falling by one step in a column: OCR puts two ticks
 * on a line ("100% 90%"), bar values among the ticks and a second axis beside the first (보도자료 산업활동동향·주택통계 그래프 그림),
 * while every data table taken for a chart was built from a text layer */
export function isChartTable(table: IRTable, ocr = false): boolean {
  const texts = table.cells.flat().map(cell => cell.text.trim()).filter(Boolean)
  if (table.rows < 3 || texts.length === 0) return false
  const numeric = texts.filter(text => NUMERIC_CELL.test(text)).length
  if (numeric < texts.length * 0.5) return false
  for (let c = 0; c < table.cols; c++) {
    if (!ocr ? isValueAxisColumn(table, c)
      : hasValueAxis(table.cells.flatMap(row => (row[c]?.text ?? "").split(/\s+/)).filter(t => TICK.test(t)).map(t => Number(t.replace(/[,%]/g, ""))))) return true
  }
  // Chart values read as quantities (3,230 · 2.5% · -6.4); hyphenated identifiers such as phone numbers do not.
  const values = texts.filter(text => text.split(/\s+/).every(token => QUANTITY.test(token))).length
  const cells = table.rows * table.cols
  return cells - texts.length >= cells * 0.55 && values >= texts.length * 0.8 && (ocr || !hasAlignedRows(table))
}

/** Display math laid out on several baselines (fraction bars, limits, "d/dx") looks like a sparse grid of short cells.
 * Evidence: a relation sign in some cell and most filled cells being math tokens — a lone variable or an operator-bearing term. */
export function isFormulaTable(table: IRTable): boolean {
  const texts = table.cells.flat().map(cell => cell.text.trim()).filter(Boolean)
  if (texts.length < 3 || table.rows > 8 || !texts.some(text => /=/.test(text))) return false
  const math = texts.filter(text => /^[a-z]{1,2}$/.test(text) || /[=∂∑∫∣Γ∇√∞]/.test(text)).length
  return math >= texts.length * 0.6
}

/** 시험지 선택지·수식 배치 — 수식 글꼴 글(`$…$`)과 선택지 부호가 줄마다 벌어져 무괘선 표 후보가 된다(수능 모의고사 "① $1$ ② $2$ ③ $3$",
 *  해설 "문4） … ③ | $g(x)=…$"). HWPX 원본엔 표가 없다. 선택지 부호(①~⑤)나 문항 표시("문N）")가 있고, 채운 칸의 60% 이상이
 *  수식·선택지 부호·기호 조각("′")일 때만 — 선택지 부호 없는 수식 값 표("$x$ | $f(x)$")는 표로 둔다 */
export function isExamLayoutTable(table: IRTable): boolean {
  const texts = table.cells.flat().map(cell => cell.text.trim()).filter(Boolean)
  if (texts.length < 3 || !texts.some(text => /[①-⑤]|문\d+）/.test(text))) return false
  const layout = texts.filter(text => /\$|[①-⑤]|문\d+）/.test(text) || !/[\p{L}\p{N}]/u.test(text)).length
  return layout >= texts.length * 0.6
}
