/**
 * 시트 → heading(시트명) + IRTable 블록 — XLSX·XLS 공용.
 *
 * 칸 글은 희소하게 받는다(행 번호 → 그 행의 열별 글). 셀 레코드 하나가 먼 좌표를 주장해도 그 사이 빈 칸을 미리
 * 깔지 않는다 — 종전 XLS 는 (maxRow+1)×(maxCol+1) 밀집 격자를 선할당해 셀 하나(65535행·999열)로 6,553만 칸·
 * 약 500MB 를 잡았다.
 *
 * 표로 펼치는 것은 글 있는 행 × 글 있는 열뿐이다(빈 행·열은 뺀다, #91 — keepAnchoredEmptyCols 면 열은 0 ~ maxCol). 행 상한은 열 수에 맞춘 칸 예산(`sheetRowCap`) —
 * 종전엔 열 수와 무관하게 1만 행에서 경고 없이 잘렸다(4열 사업체 명단 15,212행·59열 개표 결과 22,692행이 1만 행으로,
 * 칸 수로는 예산의 3%·29%). 예산을 넘는 시트는 뒤 행을 자르고 TRUNCATED_TABLE 경고를 낸다.
 */

import type { CellContext, IRBlock, ParseWarning } from "../types.js"
import { buildTable, MAX_TABLE_CELLS } from "../table/builder.js"

/** 병합 범위 (0부터, 양끝 포함) */
export interface SheetMerge {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** XLSX 열 끝(XFD) — 시트 칸은 표 열 상한(MAX_COLS 200)이 아니라 칸 예산(sheetRowCap)으로 막는다. 종전엔 200열 밖 칸을 경고 없이
 *  버려 KOSIS 통계표(426열·365열)에서 칸 12,488개와 그 칸만 있던 행이 빠졌다 */
export const MAX_SHEET_COLS = 16_384

/** 열 수 cols 인 표가 칸 예산(MAX_TABLE_CELLS) 안에서 가질 수 있는 행 수 — 열이 200개면 종전 1만 행 그대로, 더 넓으면 그만큼 줄어든다 */
export function sheetRowCap(cols: number): number {
  return Math.floor(MAX_TABLE_CELLS / Math.max(1, cols))
}

export function sheetToBlocks(
  sheetName: string,
  rows: Map<number, string[]>,
  maxCol: number,
  merges: SheetMerge[],
  sheetIndex: number,
  warnings: ParseWarning[],
  keepAnchoredEmptyCols?: boolean,
): IRBlock[] {
  const blocks: IRBlock[] = []
  if (sheetName) {
    blocks.push({ type: "heading", text: sheetName, level: 2, pageNumber: sheetIndex + 1 })
  }
  if (rows.size === 0 || maxCol < 0) return blocks

  // 유효 행 범위 (앞뒤 빈 행 제거)
  let firstRow = -1
  let lastRow = -1
  for (const [r, cells] of rows) {
    if (!cells.some(v => v !== "")) continue
    if (firstRow === -1 || r < firstRow) firstRow = r
    if (r > lastRow) lastRow = r
  }
  if (firstRow === -1) return blocks

  // 글 있는 행·열만 표로 편다 — 범위 안의 빈 행·열까지 펼치면 셀 6개짜리 희소 시트(A1~BZ5000)가 5,000행×78열 빈 칸
  // 118만 자가 됐다(#91). keepAnchoredEmptyCols(빈 열 유지 계약)면 열은 종전대로 0 ~ maxCol
  const keepRows: number[] = []
  for (let r = firstRow; r <= lastRow; r++) if (rows.get(r)?.some(v => v !== "")) keepRows.push(r)
  let keepCols: number[]
  if (keepAnchoredEmptyCols) keepCols = Array.from({ length: maxCol + 1 }, (_, c) => c)
  else {
    const used = new Set<number>()
    for (const r of keepRows) rows.get(r)!.forEach((v, c) => { if (v !== "") used.add(c) })
    keepCols = [...used].sort((a, b) => a - b)
  }

  const rowCap = sheetRowCap(keepCols.length)
  if (keepRows.length > rowCap) {
    warnings.push({
      page: sheetIndex + 1,
      message: `시트 "${sheetName}": ${keepRows.length}행 × ${keepCols.length}열 중 앞 ${rowCap}행만 표로 냈습니다 (표 칸 상한 ${MAX_TABLE_CELLS})`,
      code: "TRUNCATED_TABLE",
    })
    keepRows.length = rowCap
  }
  const rowIdx = new Map(keepRows.map((r, i) => [r, i]))
  const colIdx = new Map(keepCols.map((c, i) => [c, i]))

  // 병합 — 남은 행·열로 줄인다. 머리가 빈 행·열(빠진 줄)에 있으면 병합 안 첫 남은 칸이 머리가 되고, 남은 칸이 없으면 병합을 버린다
  // (시트 전체를 덮는 병합 하나가 칸 수만큼 키를 만들지 않게 남은 행·열만 돈다)
  const mergeMap = new Map<string, { colSpan: number; rowSpan: number; text: string }>()
  const mergeSkip = new Set<string>()
  for (const m of merges) {
    if (m.r2 < m.r1 || m.c2 < m.c1) continue // 거꾸로 적힌 병합(손상 파일) — span 0 이하 칸은 builder 에서 글이 사라진다
    const rr = keepRows.filter(r => r >= m.r1 && r <= m.r2)
    const cc = keepCols.filter(c => c >= m.c1 && c <= m.c2)
    if (!rr.length || !cc.length) continue
    // 병합 글은 원래 머리 칸의 글 — 머리 행·열이 빠졌으면 병합 안 첫 글
    let text = rows.get(m.r1)?.[m.c1] ?? ""
    for (let k = 0; !text && k < rr.length; k++) for (const c of cc) { text = rows.get(rr[k])?.[c] ?? ""; if (text) break }
    mergeMap.set(`${rowIdx.get(rr[0])},${colIdx.get(cc[0])}`, { colSpan: cc.length, rowSpan: rr.length, text })
    for (const r of rr) for (const c of cc) if (r !== rr[0] || c !== cc[0]) mergeSkip.add(`${rowIdx.get(r)},${colIdx.get(c)}`)
  }

  // CellContext[][] → buildTable (2-pass)
  const cellRows: CellContext[][] = []
  for (let ri = 0; ri < keepRows.length; ri++) {
    const cells = rows.get(keepRows[ri])
    const row: CellContext[] = []
    for (let ci = 0; ci < keepCols.length; ci++) {
      const key = `${ri},${ci}`
      if (mergeSkip.has(key)) continue
      const merge = mergeMap.get(key)
      row.push({ text: merge ? merge.text : cells?.[keepCols[ci]] ?? "", colSpan: merge?.colSpan ?? 1, rowSpan: merge?.rowSpan ?? 1 })
    }
    cellRows.push(row)
  }

  const table = buildTable(cellRows, { keepAnchoredEmptyCols, maxRows: rowCap, maxCols: keepCols.length })
  if (table.rows > 0) blocks.push({ type: "table", table, pageNumber: sheetIndex + 1 })
  return blocks
}
