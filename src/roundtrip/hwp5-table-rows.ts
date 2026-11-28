/**
 * HWP 5.x 표 행 더하기·빼기 (HWPX table-rows 와 같은 몫). 병합(행·열 합치기) 없는 표·영역(cell zone) 없는 표만.
 *
 * 고치기 전·뒤 행을 맞대어(alignUnits) 남는 새 행은 앞 행(없으면 첫 행)의 칸을 본떠 끼우고 — 칸 머리(LIST_HEADER) 사본에 새 문단 —
 * 남는 옛 행은 칸 레코드를 통째로 지운다. 행 주소(LIST_HEADER @10)를 최종 차례로 다시 매기고, TABLE 레코드의 행 수·행별 칸 수
 * 배열을 고친다(필드 자리는 HWP 5.0 명세, hwp5/to-hwpx/controls.ts tableXml 과 같다). 새 문단 줄 나눔 정보는 한글이 다시 짠다.
 * 짝지어진 행 쌍은 돌려주어 호출자가 칸 글 고치기(종전 경로)를 한다.
 */
import { alignUnits } from "./markdown-units.js"
import { groupEnd, newParagraph, type NewPara } from "./hwp5-cell-lines.js"
import type { ScanCell5, ScanTable5, SectionScan5 } from "./hwp5-patch.js"

const TAG_PARA_HEADER = 0x42, TAG_LIST_HEADER = 0x48
const LAST = 0x80000000

/** 칸 레코드 끝(칸 머리 다음부터 그 칸 문단 묶음 끝까지) */
function cellEnd(scan: SectionScan5, cell: ScanCell5): number {
  const last = cell.paras[cell.paras.length - 1]
  return last ? groupEnd(scan, last.headerIdx) : cell.listHeaderIdx + 1
}

export interface RowsResult { applied: number; pairs: Array<[number, number]> }

/**
 * origRows·editedRows = GFM 행(칸 글). toPlain = GFM 칸 → 평문(못 다루는 서식이면 null). 이 경로로 못 하면 null(호출자가 건너뜀)
 */
export function stageTableRows(
  scan: SectionScan5, table: ScanTable5, origRows: string[][], editedRows: string[][], toPlain: (md: string) => string | null,
): RowsResult | null {
  const { rows, cols, tableIdx } = table
  if (!scan.safe || tableIdx < 0 || origRows.length !== rows || table.cells.size !== rows * cols) return null
  if (origRows.some(r => r.length !== cols) || editedRows.some(r => r.length !== cols) || editedRows.length === 0) return null
  const records = scan.records
  const td = records[tableIdx].data
  if (td.length < 18 + rows * 2 + 4) return null
  if (td.readUInt16LE(18 + rows * 2 + 2) !== 0) return null  // 영역(cell zone) 있는 표는 행 번호가 얽힌다
  const grid: ScanCell5[][] = []
  for (let r = 0; r < rows; r++) {
    const row: ScanCell5[] = []
    for (let c = 0; c < cols; c++) {
      const cell = table.cells.get(`${r},${c}`)
      if (!cell || !cell.paras.length || cell.tables.length) return null
      const lh = records[cell.listHeaderIdx].data
      if (lh.length < 16 || lh.readUInt16LE(12) !== 1 || lh.readUInt16LE(14) !== 1) return null  // 합친 칸
      row.push(cell)
    }
    grid.push(row)
  }
  // 새 행 칸 글이 평문으로 바뀌는지 먼저 본다
  const key = (r: string[]) => r.join("\u0001")
  const pairs = alignUnits(origRows.map(key), editedRows.map(key))
  for (const [o, e] of pairs) if (o === null && e !== null && editedRows[e].some(c => c.split(/<br\s*\/?>/i).some(l => toPlain(l) === null))) return null
  if (pairs.every(([o, e]) => o !== null && e !== null)) return null  // 행 수 그대로 — 호출자 몫

  const level = records[grid[0][0].listHeaderIdx].level
  type Row = { orig: number } | { cells: Array<{ head: Buffer; paras: NewPara[] }> }
  const order: Row[] = []
  const matched: Array<[number, number]> = []
  let prev = -1, applied = 0
  const insertAt = (o: number) => (o >= 0 ? cellEnd(scan, grid[o][cols - 1]) : grid[0][0].listHeaderIdx)
  for (const [o, e] of pairs) {
    if (o !== null && e !== null) { order.push({ orig: o }); matched.push([o, e]); prev = o; continue }
    if (o !== null) {
      for (const cell of grid[o]) for (let j = cell.listHeaderIdx; j < cellEnd(scan, cell); j++) scan.repl.set(j, null)
      prev = o; applied++
      continue
    }
    // 새 행 — 앞 행(없으면 첫 행) 칸마다 칸 머리 사본 + 줄마다 새 문단
    const tplRow = grid[prev >= 0 ? prev : 0]
    const cells = tplRow.map((tc, c) => {
      const lines = editedRows[e!][c].split(/<br\s*\/?>/i).map(l => toPlain(l) ?? "")
      const paras = lines.map(t => newParagraph(scan, tc.paras[0], t.trim(), level))
      paras.forEach((p, k) => p.header.writeUInt32LE(((p.header.readUInt32LE(0) & ~LAST) | (k === paras.length - 1 ? LAST : 0)) >>> 0, 0))
      const head = Buffer.from(records[tc.listHeaderIdx].data)
      head.writeUInt16LE(paras.length, 0)
      return { head, paras }
    })
    order.push({ cells })
    const at = insertAt(prev)
    const list = scan.inserts.get(at) ?? []
    for (const cell of cells) {
      list.push({ tagId: TAG_LIST_HEADER, level, data: cell.head })
      for (const p of cell.paras) list.push({ tagId: TAG_PARA_HEADER, level, data: p.header }, ...p.recs)
    }
    scan.inserts.set(at, list)
    applied++
  }
  // 행 주소 다시 매기기 · TABLE 행 수와 행별 칸 수
  order.forEach((row, k) => {
    if ("orig" in row) {
      if (row.orig === k) return
      for (const cell of grid[row.orig]) {
        const cur = Buffer.from(scan.repl.get(cell.listHeaderIdx) ?? records[cell.listHeaderIdx].data)
        cur.writeUInt16LE(k, 10)
        scan.repl.set(cell.listHeaderIdx, cur)
      }
    } else for (const cell of row.cells) cell.head.writeUInt16LE(k, 10)
  })
  const n = order.length
  const head = td.subarray(0, 18), tail = td.subarray(18 + rows * 2)
  const sizes = Buffer.alloc(n * 2)
  for (let k = 0; k < n; k++) sizes.writeUInt16LE(cols, k * 2)
  const nt = Buffer.concat([head, sizes, tail])
  nt.writeUInt16LE(n, 4)
  scan.repl.set(tableIdx, nt)
  return { applied, pairs: matched }
}
