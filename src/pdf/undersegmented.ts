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
/** 숫자 줄 — 수·부호·괄호·백분율만(이웃 값이 한 줄로 붙은 "1.3 -1.0" 포함) */
const NUMERIC_LINE = /^[-−–+(]?\d[\d.,%()\s+\-−–]*$/
const ALIGNED_LINE_TOL = 0.5 // 줄 높이 가운데값 배수 — OCR 숫자 상자 높이가 7~18 로 흔들린다

/**
 * 가로선 없이 쌓은 하위 행 — 글 든 열이 셋 이상이고 모두 같은 줄 수(셋 이상)이며 k 번째 줄끼리 높이가 맞으면 한 행에 뭉친 하위 행들이다
 * (예산표 "예산지출(a) / ⋅일반회계 / ⋅특별회계" 와 금액 열마다 세 줄, OCR 은 래스터 괘선만 보아 한 행으로 묶었다). 긴 글이 한 칸에서
 * 꺾인 행은 다른 열 줄 수·높이가 맞지 않아 걸리지 않는다
 */
function alignedSubRows(itemsByCol: TextItem[][], minLines = MIN_ALIGNED_LINES, covered: boolean[] = []): string[][] | null {
  const byCol = itemsByCol.map(groupItemsToVisualLines)
  const cols = byCol.filter(lines => lines.length)
  if (cols.length < MIN_ALIGNED_COLUMNS) return anchoredSubRows(byCol, minLines, covered)
  const k = cols[0].length
  // 두 줄 묶음도 이름표 열 뒤 열이 모두 숫자 줄이면 행 둘이다(OCR, "’00-’10년 / ’10-’21년" | "1.1 / 0.7") — 걸친 이름표("본부" | "정원 / 현원")는
  // 이름표가 한 줄이라 줄 수가 갈려 걸리지 않는다
  const numericPair = k === 2 && cols.every(lines => lines.every(line => line.every(it => it.fontName === "ocr"))) &&
    cols.slice(1).every(lines => lines.every(line => NUMERIC_LINE.test(cellTextToString(line).trim())))
  if ((k < minLines && !numericPair) || cols.some(lines => lines.length !== k)) return anchoredSubRows(byCol, minLines, covered)
  const cy = (line: TextItem[]) => line.reduce((s, it) => s + itemCenterY(it), 0) / line.length
  // OCR 숫자 열(이름표 열 하나 빼고 다 숫자 줄)은 허용치에 줄 간격도 본다 — 줄 간격이 글자보다 훨씬 넓은 통계표에서 상자 하나가 글자 높이
  // 반 넘게 비켜 앉아(시도별 전입 "512" 4.5px, 글자 8) 여섯 행 묶음이 통째로 한 행에 남았다 (anchoredSubRows 와 같은 허용치)
  const ocr = cols.every(lines => lines.every(line => line.every(it => it.fontName === "ocr")))
  const numericCols = cols.filter(lines => lines.every(line => NUMERIC_LINE.test(cellTextToString(line).trim()) || /^[-–—]$/.test(cellTextToString(line).trim()))).length
  const centers = cols[0].map(cy), pitches = centers.slice(1).map((y, i) => Math.abs(centers[i] - y)).sort((a, b) => a - b)
  const pitch = ocr && numericCols >= cols.length - 1 ? pitches[pitches.length >> 1] ?? 0 : 0
  for (let i = 0; i < k; i++) {
    const ys = cols.map(lines => cy(lines[i]))
    const hs = cols.map(lines => itemHeight(lines[i][0])).sort((a, b) => a - b), h = hs[hs.length >> 1]
    if (Math.max(...ys) - Math.min(...ys) > Math.max(h * ALIGNED_LINE_TOL, pitch * 0.4)) return null
  }
  // 줄 상자가 줄 간격보다 커(OCR) 띠 묶기는 겹친 줄을 한 띠로 합친다 — 맞춘 k 번째 줄끼리 바로 행으로
  return Array.from({ length: k }, (_, i) => byCol.map(lines => lines.length ? cellTextToString(lines[i]) : ""))
}

/**
 * 줄 수가 다른 열의 하위 행 (OCR) — 대차대조표처럼 이름표 열은 줄마다 항목이 있고 금액 열은 일부 줄에만 값이 있다("Ⅱ.비유동자산 /
 * 1.투자자산 / …" | "9,174,154 / 445,324 / …"). 줄이 가장 많은 열(셋 이상)을 기준으로, 다른 열의 줄마다 높이가 맞는(줄 높이 0.5배 안)
 * 기준 줄이 하나씩 따로 있으면 그 줄의 행에 넣는다. 맞는 기준 줄이 없거나 두 줄이 한 기준 줄에 몰리면 펼치지 않는다
 */
function anchoredSubRows(byCol: TextItem[][][], minLines: number, covered: boolean[]): string[][] | null {
  if (!byCol.every(lines => lines.every(line => line.every(it => it.fontName === "ocr")))) return null
  // 세로쓰기 이름표("산/란/계"·"규/모/별/가/구/수") — 한글 한 글자 줄만 쌓인 열은(한 자리 수 "7/5" 열은 값이다) 줄이 행과 맞지 않는다. 기준·맞추기에서 빼고 첫 하위 행에 잇는다.
  // 원래 칸이 비었으면(위 행 걸친 칸이 덮어 그 글을 이미 가졌다) 다시 넣지 않는다
  const vertical = byCol.map(lines => lines.length >= 1 && lines.every(line => /^[가-힣]$/.test(cellTextToString(line).replace(/\s+/g, ""))))
  const a = byCol.reduce((best, lines, c) => !vertical[c] && (vertical[best] || lines.length > byCol[best].length) ? c : best, 0)
  if (vertical[a]) return null
  const anchor = byCol[a], k = anchor.length
  // 다른 열에도 두 줄 이상 — 다른 열이 한 줄뿐이면 한 칸에서 꺾인 긴 글이다
  // 기준 줄 셋 이상 — 두 줄 묶음은 가운데 놓인 걸친 이름표("본부" | "정원 / 현원")를 한 행에 붙인다
  if (k < Math.max(3, minLines) || !byCol.some((lines, c) => c !== a && lines.length >= 2)) return null
  const cy = (line: TextItem[]) => line.reduce((s, it) => s + itemCenterY(it), 0) / line.length
  const ys = anchor.map(cy)
  const hs = anchor.map(line => itemHeight(line[0])).sort((x, y) => x - y), h = hs[hs.length >> 1]
  // 값 열이 숫자뿐이면 허용치는 기준 줄 간격도 본다 — 줄 간격이 글자보다 훨씬 넓은 표에서 OCR 상자 하나가 글자 높이 반 넘게 비켜 앉는다
  // (구성비 "14.2" 5.5px, 글자 9). 글 머리 행("변동액 / 증가액 / (실거래가격)")은 종전 허용치로 둔다
  const pitches = ys.slice(1).map((y, i) => Math.abs(ys[i] - y)).sort((x, y) => x - y), pitch = pitches[pitches.length >> 1] ?? 0
  const numericCols = byCol.every((lines, c) => c === a || vertical[c] || lines.every(line => NUMERIC_LINE.test(cellTextToString(line).trim()) || /^[-–—]$/.test(cellTextToString(line).trim())))
  const tol = numericCols ? Math.max(h * ALIGNED_LINE_TOL, pitch * 0.4) : h * ALIGNED_LINE_TOL
  const valueColsNumeric = byCol.every((lines, c) => c === 0 || c === a || lines.every(line => NUMERIC_LINE.test(cellTextToString(line).trim()) || /^[-–—]$/.test(cellTextToString(line).trim())))
  const rows = Array.from({ length: k }, () => byCol.map(() => ""))
  for (let c = 0; c < byCol.length; c++) {
    if (vertical[c]) { if (!covered[c]) rows[0][c] = byCol[c].map(line => cellTextToString(line).trim()).join(""); continue }
    // 묶음 첫 열의 글 이름표("일반회계 / (국토해양부)")는 묶음 높이 가운데에 놓여 첫 줄이 기준 줄 위로 벗어난다 — 세로쓰기 이름표처럼
    // 첫 하위 행에 둔다. 숫자 줄이 섞인 열·기준 열보다 줄이 많은 열은 종전대로 맞춘다. 이름표·기준 열 밖이 모두 숫자 값 열일 때만 —
    // 글 칸 안 여러 줄("·시·도지사 … / ·시·도의원 …")은 행이 아니다(선거 일정표)
    if (c === 0 && c !== a && valueColsNumeric && byCol[c].length < k && byCol[c].every(line => !NUMERIC_LINE.test(cellTextToString(line).trim())) &&
        byCol[c].some(line => Math.min(...ys.map(y => Math.abs(y - cy(line)))) > tol)) {
      if (!covered[c]) rows[0][c] = byCol[c].map(line => cellTextToString(line).trim()).join(" ")
      continue
    }
    const used = new Set<number>()
    for (const line of byCol[c]) {
      const y = cy(line)
      let j = 0
      for (let i = 1; i < k; i++) if (Math.abs(ys[i] - y) < Math.abs(ys[j] - y)) j = i
      if (Math.abs(ys[j] - y) > tol || used.has(j)) return null
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
  originalCells: { text: string; rowSpan?: number; colSpan?: number }[][],
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
    const ocr = items.every(it => it.fontName === "ocr")
    for (let r = 0; r < numRows; r++) {
      const row = originalCells[r].map(cell => cell.text)
      if (r === 0 || (numRows === 3 && r === 1)) { kept?.set(rebuilt.length, r); rebuilt.push(row); continue }
      // 행 합침 칸이 아래 빈 행들을 덮는 묶음(유령 경계로 갈린 한 행)은 묶음 높이 전체의 글로 펼친다 — 첫 하위 행 글만 보면
      // "2020 예산 / 2021 예산" 두 줄이 한 칸에 남았다(관보 계속비)
      const span = Math.min(numRows - r, Math.max(1, ...originalCells[r].map(cell => cell.rowSpan ?? 1)))
      // 글 든 칸 대부분이 묶음 끝까지 걸치면, 아래 행 글이 걸치지 않은 열에만 있어도 한 묶음이다 — 한 열에만 낀 가로선 조각이
      // 그 열만 둘로 갈랐다(연령별 혼인건수 2015 열 "0.9/9.6/67.1" | "121.2/…", 나머지 열은 10줄 걸친 칸)
      const filled = originalCells[r].filter(cell => cell.text.trim())
      const spanning = filled.filter(cell => (cell.rowSpan ?? 1) >= span)
      const loose = ocr && filled.length >= MIN_UNDERSEGMENTED_COLUMNS && spanning.length * 2 > filled.length &&
        originalCells.slice(r + 1, r + span).every(cells => cells.every((cell, c) => !cell.text.trim() || (originalCells[r][c]?.rowSpan ?? 1) === 1))
      const band = span > 1 && (loose || originalCells.slice(r + 1, r + span).every(cells => cells.every(cell => !cell.text.trim()))) ? span : 1
      const rowItems = items.filter(item => itemCenterY(item) <= rowYs[r] + 1 && itemCenterY(item) >= rowYs[r + band] - 1)
      const body = normalizeUndersegmentedTable([originalCells[r]], colXs, rowItems, undefined, undefined, undefined, band > 1 ? 2 : MIN_ALIGNED_LINES)
      if (body) {
        // 행 여럿에 걸친 칸 글("2023년", 6행 걸침)은 글 중심이 이 행 띠 밖이라 펼친 행에서 빠진다 — 그 열이 통째로 비면 원래 글을 첫 하위 행에 둔다
        // 옆 열에 걸친 칸("가구당 마릿수(마리) / - 산란계 / - 육용계", 두 열 걸침)은 글이 걸친 다른 열로 펼쳐졌으면 되살리지 않는다
        originalCells[r].forEach((cell, c) => {
          const cols = Array.from({ length: Math.max(1, cell.colSpan ?? 1) }, (_, k) => c + k)
          if (cell.text.trim() && body.every(cells => cols.every(k => !cells[k]?.trim()))) body[0][c] = cell.text
        })
        rebuilt.push(...body); expanded++; r += band - 1
      }
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
  if (denseColumns < 2) return numRows === 1 ? alignedSubRows(itemsByCol, minAlignedLines, originalCells[0].map(cell => !cell.text.trim())) : null

  // 2) 전체 줄에서 row band 유도 — centerY 근접(epsilon) 또는 수직 겹침이면 같은 band
  const allLines = groupItemsToVisualLines(items.filter(i => i.text.trim()))
  const bands: RowBand[] = []
  for (const line of allLines) {
    const ocrLine = line.every(it => it.fontName === "ocr"), lineHasDigit = line.some(it => /\d/.test(it.text))
    let cy = 0, h = 0
    for (const it of line) { cy += itemCenterY(it); h += itemHeight(it) }
    cy /= line.length
    h /= line.length
    const top = cy + h / 2
    const bottom = cy - h / 2

    let matched: RowBand | null = null
    for (const band of bands) {
      const epsilon = Math.max(MIN_ROW_BAND_EPSILON, Math.min(band.avgHeight, h) * ROW_BAND_EPSILON_RATIO)
      // OCR 상자는 잉크 둘레 여백으로 부풀어(글자 26px 에 상자 40~65px) 이웃 행 상자와 겹친다 — 겹침으로 묶으면 행 괘선 없는 지역 열
      // "서울/부산/…/대전" 이 한 띠가 된다. OCR 은 두 줄 다 수가 있고 같은 열에 부딪치면 겹쳐도 다른 행이다(꺾인 이름 "러시아 / (연방) 6,492"·
      // 비켜 앉은 값 하나는 묶는다)
      const rowClash = ocrLine && lineHasDigit && band.itemsByCol.some(col => col.some(it => /\d/.test(it.text))) &&
        line.some(it => band.itemsByCol[findColumnIndex(it, colXs)].length > 0)
      if (Math.abs(band.centerY - cy) <= epsilon ||
          (!rowClash && bottom <= band.topY && top >= band.bottomY)) {
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
