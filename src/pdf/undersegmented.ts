/**
 * 과소분할 표 재구성 (line-detector.ts에서 분리).
 *
 * OpenDataLoader PDF의 TableStructureNormalizer를 참고하여 TypeScript로
 * clean-room 재구현한 것입니다.
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 */

import type { TextItem } from "./line-types.js"
import { cellTextToString } from "./cell-text.js"

// ─── 과소분할 표 재구성 (ODL TableStructureNormalizer 포팅) ──
//
// 행 구분선이 생략된 표(헤더 아래만 선이 있는 한국 공문서 표)는 본문 전체가
// 소수의 긴 행으로 합쳐진다. 셀 안에 텍스트 줄이 8개+ 뭉친 경우 줄의 centerY로
// row band를 재유도해 행을 복원한다. 품질이 개선될 때만 교체.
//
// Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
// https://github.com/opendataloader-project/opendataloader-pdf

const MAX_UNDERSEGMENTED_ROWS = 5
const MIN_UNDERSEGMENTED_COLUMNS = 3
const MIN_UNDERSEGMENTED_TEXT_LINES = 8
const MIN_ROW_BAND_MISMATCH = 2
const MIN_ROW_BAND_EPSILON = 3.0
const ROW_BAND_EPSILON_RATIO = 0.6

interface RowBand {
  centerY: number
  avgHeight: number
  topY: number
  bottomY: number
  lineCount: number
  /** 컬럼별 아이템 */
  itemsByCol: TextItem[][]
}

/** 아이템 중심 Y (h가 0이면 fontSize 대용) */
function itemCenterY(item: TextItem): number {
  return item.y + (item.h > 0 ? item.h : item.fontSize) / 2
}

function itemHeight(item: TextItem): number {
  return item.h > 0 ? item.h : item.fontSize
}

/** 아이템을 colXs 경계 기준 컬럼에 배정 (중심 X 기준, 범위 밖이면 최근접) */
function findColumnIndex(item: TextItem, colXs: number[]): number {
  const cx = item.x + item.w / 2
  for (let c = 0; c < colXs.length - 1; c++) {
    if (cx >= colXs[c] && cx <= colXs[c + 1]) return c
  }
  let best = 0
  let bestDist = Infinity
  for (let c = 0; c < colXs.length - 1; c++) {
    const center = (colXs[c] + colXs[c + 1]) / 2
    const d = Math.abs(cx - center)
    if (d < bestDist) { bestDist = d; best = c }
  }
  return best
}

/** 아이템들을 Y 기준 시각적 줄로 그룹핑 */
function groupItemsToVisualLines(items: TextItem[]): TextItem[][] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: TextItem[][] = []
  let cur: TextItem[] = [sorted[0]]
  let curY = sorted[0].y
  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, cur[0].fontSize) * 0.6)
    if (Math.abs(sorted[i].y - curY) <= tol) {
      cur.push(sorted[i])
    } else {
      lines.push(cur)
      cur = [sorted[i]]
      curY = sorted[i].y
    }
  }
  lines.push(cur)
  return lines
}

/** 줄 맞춘 하위 행 판정 — 글 든 열 수 하한 · 줄 수 하한 · 같은 줄로 볼 높이 차(글자 크기 배수) */
const MIN_ALIGNED_COLUMNS = 3
const MIN_ALIGNED_LINES = 3
const ALIGNED_LINE_TOL = 0.5 // 줄 높이 가운데값 배수 — OCR 숫자 상자 높이가 7~18 로 흔들린다

/**
 * 가로선 없이 쌓은 하위 행 — 글 든 열이 셋 이상이고 모두 같은 줄 수(셋 이상)이며 k 번째 줄끼리 높이가 맞으면 한 행에 뭉친 하위 행들이다
 * (예산표 "예산지출(a) / ⋅일반회계 / ⋅특별회계" 와 금액 열마다 세 줄, OCR 은 래스터 괘선만 보아 한 행으로 묶었다). 긴 글이 한 칸에서
 * 꺾인 행은 다른 열 줄 수·높이가 맞지 않아 걸리지 않는다
 */
function alignedSubRows(itemsByCol: TextItem[][], minLines = MIN_ALIGNED_LINES): string[][] | null {
  const byCol = itemsByCol.map(groupItemsToVisualLines)
  const cols = byCol.filter(lines => lines.length)
  if (cols.length < MIN_ALIGNED_COLUMNS) return anchoredSubRows(byCol, minLines)
  const k = cols[0].length
  if (k < minLines || cols.some(lines => lines.length !== k)) return anchoredSubRows(byCol, minLines)
  const cy = (line: TextItem[]) => line.reduce((s, it) => s + itemCenterY(it), 0) / line.length
  for (let i = 0; i < k; i++) {
    const ys = cols.map(lines => cy(lines[i]))
    const hs = cols.map(lines => itemHeight(lines[i][0])).sort((a, b) => a - b), h = hs[hs.length >> 1]
    if (Math.max(...ys) - Math.min(...ys) > h * ALIGNED_LINE_TOL) return null
  }
  // 줄 상자가 줄 간격보다 커(OCR) 띠 묶기는 겹친 줄을 한 띠로 합친다 — 맞춘 k 번째 줄끼리 바로 행으로
  return Array.from({ length: k }, (_, i) => byCol.map(lines => lines.length ? cellTextToString(lines[i]) : ""))
}

/**
 * 줄 수가 다른 열의 하위 행 (OCR) — 대차대조표처럼 이름표 열은 줄마다 항목이 있고 금액 열은 일부 줄에만 값이 있다("Ⅱ.비유동자산 /
 * 1.투자자산 / …" | "9,174,154 / 445,324 / …"). 줄이 가장 많은 열(셋 이상)을 기준으로, 다른 열의 줄마다 높이가 맞는(줄 높이 0.5배 안)
 * 기준 줄이 하나씩 따로 있으면 그 줄의 행에 넣는다. 맞는 기준 줄이 없거나 두 줄이 한 기준 줄에 몰리면 펼치지 않는다
 */
function anchoredSubRows(byCol: TextItem[][][], minLines: number): string[][] | null {
  if (!byCol.every(lines => lines.every(line => line.every(it => it.fontName === "ocr")))) return null
  const a = byCol.reduce((best, lines, c) => lines.length > byCol[best].length ? c : best, 0)
  const anchor = byCol[a], k = anchor.length
  // 다른 열에도 두 줄 이상 — 다른 열이 한 줄뿐이면 한 칸에서 꺾인 긴 글이다
  // 기준 줄 셋 이상 — 두 줄 묶음은 가운데 놓인 걸친 이름표("본부" | "정원 / 현원")를 한 행에 붙인다
  if (k < Math.max(3, minLines) || !byCol.some((lines, c) => c !== a && lines.length >= 2)) return null
  const cy = (line: TextItem[]) => line.reduce((s, it) => s + itemCenterY(it), 0) / line.length
  const ys = anchor.map(cy)
  const hs = anchor.map(line => itemHeight(line[0])).sort((x, y) => x - y), h = hs[hs.length >> 1]
  const rows = Array.from({ length: k }, () => byCol.map(() => ""))
  for (let c = 0; c < byCol.length; c++) {
    const used = new Set<number>()
    for (const line of byCol[c]) {
      const y = cy(line)
      let j = 0
      for (let i = 1; i < k; i++) if (Math.abs(ys[i] - y) < Math.abs(ys[j] - y)) j = i
      if (Math.abs(ys[j] - y) > h * ALIGNED_LINE_TOL || used.has(j)) return null
      used.add(j)
      rows[j][c] = cellTextToString(line)
      // 두 줄이 한 줄로 묶인 것(기울어진 스캔 "765 / 2,191")은 어느 기준 줄 것인지 모른다
      if (rows[j][c].includes("\n")) return null
    }
  }
  return rows
}

/**
 * 과소분할 표 재구성. 조건(행≤5 + 열≥3 + dense 컬럼 2개+)을 만족하고
 * row band 재유도가 품질을 개선할 때만 새 셀 행렬을 반환, 아니면 null.
 *
 * @param originalCells 기존 셀 행렬 (품질 비교용)
 * @param colXs 그리드 열 경계
 * @param items 표 영역 내 텍스트 아이템
 * @param maxRows 다룰 격자 행 수 상한 (기본 5 — OCR 숫자 표는 묶음마다 격자 행이 있어 더 받는다)
 * @param kept 행 3개 이상 표에서 펼치지 않고 그대로 둔 행 — 새 행 번호 → 원래 행 번호 (호출측이 그 행의 칸 합침을 잇는다)
 */
export function normalizeUndersegmentedTable(
  originalCells: { text: string; rowSpan?: number }[][],
  colXs: number[],
  items: TextItem[],
  rowYs?: number[],
  kept?: Map<number, number>,
  maxRows = MAX_UNDERSEGMENTED_ROWS,
  /** 줄 맞춘 하위 행 최소 줄 수 — 유령 경계로 갈린 묶음(행 합침 칸이 덮은 빈 행)은 그 경계가 행 증거라 두 줄도 가른다 */
  minAlignedLines = MIN_ALIGNED_LINES,
): string[][] | null {
  const numRows = originalCells.length
  const numCols = colXs.length - 1
  if (numRows > maxRows || numCols < MIN_UNDERSEGMENTED_COLUMNS) return null
  if (items.length === 0) return null
  if (numRows >= 3) {
    if (rowYs?.length !== numRows + 1) return null
    const rebuilt: string[][] = []
    let expanded = 0
    for (let r = 0; r < numRows; r++) {
      const row = originalCells[r].map(cell => cell.text)
      if (r === 0 || (numRows === 3 && r === 1)) { kept?.set(rebuilt.length, r); rebuilt.push(row); continue }
      // 행 합침 칸이 아래 빈 행들을 덮는 묶음(유령 경계로 갈린 한 행)은 묶음 높이 전체의 글로 펼친다 — 첫 하위 행 글만 보면
      // "2020 예산 / 2021 예산" 두 줄이 한 칸에 남았다(관보 계속비)
      const span = Math.min(numRows - r, Math.max(1, ...originalCells[r].map(cell => cell.rowSpan ?? 1)))
      const band = span > 1 && originalCells.slice(r + 1, r + span).every(cells => cells.every(cell => !cell.text.trim())) ? span : 1
      const rowItems = items.filter(item => itemCenterY(item) <= rowYs[r] + 1 && itemCenterY(item) >= rowYs[r + band] - 1)
      const body = normalizeUndersegmentedTable([originalCells[r]], colXs, rowItems, undefined, undefined, undefined, band > 1 ? 2 : MIN_ALIGNED_LINES)
      if (body) { rebuilt.push(...body); expanded++; r += band - 1 }
      else { kept?.set(rebuilt.length, r); rebuilt.push(row) }
    }
    return expanded ? rebuilt : null
  }

  // 1) 컬럼별 의미있는 줄 수 — dense 컬럼(8줄+) 2개 이상이어야 과소분할로 판정
  const itemsByCol: TextItem[][] = Array.from({ length: numCols }, () => [])
  for (const item of items) {
    if (!item.text.trim()) continue
    itemsByCol[findColumnIndex(item, colXs)].push(item)
  }
  let denseColumns = 0
  for (const colItems of itemsByCol) {
    if (groupItemsToVisualLines(colItems).length >= MIN_UNDERSEGMENTED_TEXT_LINES) denseColumns++
  }
  if (denseColumns < 2) return numRows === 1 ? alignedSubRows(itemsByCol, minAlignedLines) : null

  // 2) 전체 줄에서 row band 유도 — centerY 근접(epsilon) 또는 수직 겹침이면 같은 band
  const allLines = groupItemsToVisualLines(items.filter(i => i.text.trim()))
  const bands: RowBand[] = []
  for (const line of allLines) {
    let cy = 0, h = 0
    for (const it of line) { cy += itemCenterY(it); h += itemHeight(it) }
    cy /= line.length
    h /= line.length
    const top = cy + h / 2
    const bottom = cy - h / 2

    let matched: RowBand | null = null
    for (const band of bands) {
      const epsilon = Math.max(MIN_ROW_BAND_EPSILON, Math.min(band.avgHeight, h) * ROW_BAND_EPSILON_RATIO)
      if (Math.abs(band.centerY - cy) <= epsilon ||
          (bottom <= band.topY && top >= band.bottomY)) {
        matched = band
        break
      }
    }
    if (!matched) {
      matched = { centerY: 0, avgHeight: 0, topY: -Infinity, bottomY: Infinity, lineCount: 0, itemsByCol: Array.from({ length: numCols }, () => []) }
      bands.push(matched)
    }
    matched.centerY = (matched.centerY * matched.lineCount + cy) / (matched.lineCount + 1)
    matched.avgHeight = (matched.avgHeight * matched.lineCount + h) / (matched.lineCount + 1)
    matched.topY = Math.max(matched.topY, top)
    matched.bottomY = Math.min(matched.bottomY, bottom)
    matched.lineCount++
    for (const it of line) {
      matched.itemsByCol[findColumnIndex(it, colXs)].push(it)
    }
  }

  // 3) band 수가 기존 행 수 + 2 이상이어야 재구축 의미 있음
  if (bands.length < numRows + MIN_ROW_BAND_MISMATCH) return null

  bands.sort((a, b) => b.centerY - a.centerY)

  // 4) 셀 행렬 재구축
  const rebuilt: string[][] = bands.map(band =>
    band.itemsByCol.map(colItems => colItems.length > 0 ? cellTextToString(colItems) : ""),
  )

  // 5) 품질 검증: 비어있지 않은 행 수가 늘고, 비어있지 않은 열 수가 줄지 않아야 교체
  const countNonEmptyRows = (cells: { text: string }[][] | string[][]) =>
    cells.filter(row => row.some(c => (typeof c === "string" ? c : c.text).trim() !== "")).length
  const countNonEmptyCols = (cells: { text: string }[][] | string[][], cols: number) => {
    let n = 0
    for (let c = 0; c < cols; c++) {
      if (cells.some(row => row[c] != null && (typeof row[c] === "string" ? row[c] as string : (row[c] as { text: string }).text).trim() !== "")) n++
    }
    return n
  }

  if (countNonEmptyRows(rebuilt) <= countNonEmptyRows(originalCells)) return null
  // 열 비교는 본문 행만 — 머리 행 병합 칸("부서·장·관·항·목", 0~2열)은 앵커 열 하나로 세지만 재구성은 글자 중심 x 로
  // 다시 나눠, 제대로 된 재구성을 열이 줄었다고 버리던 것 (괴산 예산서 OCR 실측)
  const origBody = numRows > 1 ? originalCells.slice(1) : originalCells
  if (countNonEmptyCols(rebuilt, numCols) < countNonEmptyCols(origBody, numCols)) return null

  return rebuilt
}
