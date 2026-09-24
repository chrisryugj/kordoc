/**
 * 시트 → heading(시트명) + IRTable 블록 — XLSX·XLS 공용.
 *
 * 칸 글은 희소하게 받는다(행 번호 → 그 행의 열별 글). 셀 레코드 하나가 먼 좌표를 주장해도 그 사이 빈 칸을 미리
 * 깔지 않는다 — 종전 XLS 는 (maxRow+1)×(maxCol+1) 밀집 격자를 선할당해 셀 하나(65535행·999열)로 6,553만 칸·
 * 약 500MB 를 잡았다.
 *
 * 표로 펼치는 범위는 글 있는 첫 행 ~ 끝 행 × 0 ~ maxCol 이다. 행 상한은 열 수에 맞춘 칸 예산(`sheetRowCap`) —
 * 종전엔 열 수와 무관하게 1만 행에서 경고 없이 잘렸다(4열 사업체 명단 15,212행·59열 개표 결과 22,692행이 1만 행으로,
 * 칸 수로는 예산의 3%·29%). 예산을 넘는 시트는 뒤 행을 자르고 TRUNCATED_TABLE 경고를 낸다.
 */

import type { CellContext, IRBlock, ParseWarning } from "../types.js"
import { buildTable, MAX_ROWS, MAX_TABLE_CELLS } from "../table/builder.js"

/** 병합 범위 (0부터, 양끝 포함) */
export interface SheetMerge {
  r1: number
  c1: number
  r2: number
  c2: number
}

/** 열 수 cols 인 표가 칸 예산(MAX_TABLE_CELLS) 안에서 가질 수 있는 행 수 — 열이 200개면 종전 1만 행 그대로 */
export function sheetRowCap(cols: number): number {
  return Math.max(MAX_ROWS, Math.floor(MAX_TABLE_CELLS / Math.max(1, cols)))
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

  const rowCap = sheetRowCap(maxCol + 1)
  if (lastRow - firstRow + 1 > rowCap) {
    warnings.push({
      page: sheetIndex + 1,
      message: `시트 "${sheetName}": ${lastRow - firstRow + 1}행 × ${maxCol + 1}열 중 앞 ${rowCap}행만 표로 냈습니다 (표 칸 상한 ${MAX_TABLE_CELLS})`,
      code: "TRUNCATED_TABLE",
    })
    lastRow = firstRow + rowCap - 1
  }

  // 병합 맵 — 펼칠 행 범위로 자른다. 덮인 칸 표시도 범위 안만(시트 전체를 덮는 병합 하나가 칸 수만큼 키를 만들던 것).
  // 행 범위 밖으로 뻗은 rowSpan 은 표 밖을 가리키는 IR 이 되고(끝 빈 행으로 이어진 병합 — xls web035 마지막 행 rowspan 2),
  // 머리가 범위 위(글 없는 행)에 있는 병합은 덮인 칸만 빠져 그 행 칸들이 왼쪽으로 밀린다 — 머리를 범위 첫 행으로 옮긴다
  const mergeMap = new Map<string, { colSpan: number; rowSpan: number }>()
  const mergeSkip = new Set<string>()
  for (const m of merges) {
    const r1 = Math.max(m.r1, firstRow)
    const r2 = Math.min(m.r2, lastRow)
    if (r1 > r2 || m.c2 < m.c1) continue // 범위 밖·거꾸로 적힌 병합(손상 파일) — span 0 이하 칸은 builder 에서 글이 사라진다
    mergeMap.set(`${r1},${m.c1}`, { colSpan: m.c2 - m.c1 + 1, rowSpan: r2 - r1 + 1 })
    for (let r = r1; r <= r2; r++) {
      for (let c = m.c1; c <= Math.min(m.c2, maxCol); c++) {
        if (r !== r1 || c !== m.c1) mergeSkip.add(`${r},${c}`)
      }
    }
  }

  // CellContext[][] → buildTable (2-pass)
  const cellRows: CellContext[][] = []
  for (let r = firstRow; r <= lastRow; r++) {
    const cells = rows.get(r)
    const row: CellContext[] = []
    for (let c = 0; c <= maxCol; c++) {
      const key = `${r},${c}`
      if (mergeSkip.has(key)) continue
      const merge = mergeMap.get(key)
      row.push({ text: cells?.[c] ?? "", colSpan: merge?.colSpan ?? 1, rowSpan: merge?.rowSpan ?? 1 })
    }
    cellRows.push(row)
  }

  const table = buildTable(cellRows, { keepAnchoredEmptyCols, maxRows: rowCap })
  if (table.rows > 0) blocks.push({ type: "table", table, pageNumber: sheetIndex + 1 })
  return blocks
}
