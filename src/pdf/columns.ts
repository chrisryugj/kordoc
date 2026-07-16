/**
 * 열 경계 감지 + 열 기반 텍스트/테이블 추출 (선 없는 PDF fallback 경로).
 *
 * x-히스토그램 클러스터링으로 열 경계를 찾고(detectColumns),
 * y-라인을 열에 배치해 마크다운 표를 조립한다(extractWithColumns → buildGridTable).
 */

import { safeMin, safeMax } from "../utils.js"
import { type NormItem, mergeLineSimple, collapseEvenSpacing } from "./text-line.js"

// ═══════════════════════════════════════════════════════
// 열 경계 감지 — 빈도 기반 x-히스토그램 클러스터링
// ═══════════════════════════════════════════════════════

/** prose 라인 판별: 아이템 간 gap이 모두 작으면 문장 (단어 나열) */
function isProseSpread(items: NormItem[]): boolean {
  if (items.length < 4) return false
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w))
  }
  // gap의 최대값이 작고 평균 단어 길이가 짧으면 prose
  const maxGap = safeMax(gaps)
  const avgLen = items.reduce((s, i) => s + i.text.length, 0) / items.length
  // 짧은 단어들이 좁은 간격으로 나열 = prose (예: "위 표 제3호나목에서 남은 유효기간...")
  return maxGap < 40 && avgLen < 5
}

export function detectColumns(yLines: NormItem[][]): number[] | null {
  const allItems = yLines.flat()
  if (allItems.length === 0) return null
  const pageWidth = safeMax(allItems.map(i => i.x + i.w)) - safeMin(allItems.map(i => i.x))
  if (pageWidth < 100) return null

  // "비고" 이전 아이템만 사용 (비고 이후는 prose)
  let bigoLineIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoLineIdx = i
      break
    }
  }
  const tableYLines = bigoLineIdx >= 0 ? yLines.slice(0, bigoLineIdx) : yLines

  // Step 1: 모든 아이템의 x를 수집 (prose 라인 제외)
  // CLUSTER_TOL 22px — 한국 공문서 PDF 열 간격에 최적화, 별표 표 열 감지 핵심값
  const CLUSTER_TOL = 22
  const xClusters: { center: number; count: number; minX: number }[] = []

  for (const line of tableYLines) {
    if (isProseSpread(line)) continue
    for (const item of line) {
      let found = false
      for (const c of xClusters) {
        if (Math.abs(item.x - c.center) <= CLUSTER_TOL) {
          c.center = Math.round((c.center * c.count + item.x) / (c.count + 1))
          c.minX = Math.min(c.minX, item.x)
          c.count++
          found = true
          break
        }
      }
      if (!found) {
        xClusters.push({ center: item.x, count: 1, minX: item.x })
      }
    }
  }

  // Step 2: 빈도 피크 — 최소 3회 이상 등장 (단발성 텍스트 노이즈 제거)
  const peaks = xClusters
    .filter(c => c.count >= 3)
    .sort((a, b) => a.minX - b.minX)

  // 최소 3개 열이 있어야 테이블로 판별 — 2열은 일반 2단 레이아웃과 구분 불가
  if (peaks.length < 3) return null

  // Step 3: 가까운 피크 병합 — MERGE_TOL 40px (같은 논리 열의 미세 위치 차이 흡수)
  const MERGE_TOL = 40
  const merged: { center: number; count: number; minX: number }[] = [peaks[0]]
  for (let i = 1; i < peaks.length; i++) {
    const prev = merged[merged.length - 1]
    if (peaks[i].minX - prev.minX < MERGE_TOL) {
      // 빈도 높은 쪽 유지, 최소 x는 작은 값
      if (peaks[i].count > prev.count) {
        prev.center = peaks[i].center
      }
      prev.count += peaks[i].count
      prev.minX = Math.min(prev.minX, peaks[i].minX)
    } else {
      merged.push({ ...peaks[i] })
    }
  }

  // 열 경계 = 각 클러스터의 minX (왼쪽 정렬 기준), 병합 후 재검증
  const rawColumns = merged.filter(c => c.count >= 3).map(c => c.minX)
  if (rawColumns.length < 3) return null

  // 최소 열 폭 검증: 30px 미만인 열은 인접 열과 병합 (한 글자 열 방지)
  const MIN_DETECT_COL_WIDTH = 30
  const columns: number[] = [rawColumns[0]]
  for (let i = 1; i < rawColumns.length; i++) {
    if (rawColumns[i] - columns[columns.length - 1] < MIN_DETECT_COL_WIDTH) continue
    columns.push(rawColumns[i])
  }
  return columns.length >= 3 ? columns : null
}

function findColumn(x: number, columns: number[]): number {
  for (let i = columns.length - 1; i >= 0; i--) {
    // 10px 왼쪽 허용 오차 — 셀 내 텍스트 미세 좌측 이탈 보정
    if (x >= columns[i] - 10) return i
  }
  return 0
}

// ═══════════════════════════════════════════════════════
// 열 기반 추출 — 테이블/텍스트 영역 분리
// ═══════════════════════════════════════════════════════

export function extractWithColumns(yLines: NormItem[][], columns: number[]): string {
  const result: string[] = []
  const colMin = columns[0]
  const colMax = columns[columns.length - 1]

  // "비고" 라인 감지 — 이후는 텍스트로 처리
  let bigoIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoIdx = i
      break
    }
  }

  // 테이블 시작: 첫 번째 다열(3+ 열 사용) 라인
  let tableStart = -1
  for (let i = 0; i < (bigoIdx >= 0 ? bigoIdx : yLines.length); i++) {
    const usedCols = new Set(yLines[i].map(item => findColumn(item.x, columns)))
    if (usedCols.size >= 3) {
      tableStart = i
      break
    }
  }

  const tableEnd = bigoIdx >= 0 ? bigoIdx : yLines.length

  // 테이블 시작 이전 = 텍스트
  for (let i = 0; i < (tableStart >= 0 ? tableStart : tableEnd); i++) {
    result.push(mergeLineSimple(yLines[i]))
  }

  // 테이블 영역: 모든 라인을 그리드에 포함 (단일 아이템 라인도)
  if (tableStart >= 0) {
    const tableLines = yLines.slice(tableStart, tableEnd)
    // 테이블 x범위 밖의 라인만 텍스트로 분리
    // 좌측 20px, 우측 200px 허용 — 비고/주석 열이 오른쪽에 넓게 위치하는 공문서 특성 반영
    const gridLines: NormItem[][] = []
    for (const line of tableLines) {
      const inRange = line.some(item =>
        item.x >= colMin - 20 && item.x <= colMax + 200
      )
      if (inRange && !isProseSpread(line)) {
        gridLines.push(line)
      } else {
        // 그리드 밖 라인은 현재까지 축적된 그리드 출력 후 텍스트로
        if (gridLines.length > 0) {
          result.push(buildGridTable(gridLines.splice(0), columns))
        }
        result.push(mergeLineSimple(line))
      }
    }
    if (gridLines.length > 0) {
      result.push(buildGridTable(gridLines, columns))
    }
  }

  // 비고 영역
  if (bigoIdx >= 0) {
    result.push("")
    for (let i = bigoIdx; i < yLines.length; i++) {
      result.push(mergeLineSimple(yLines[i]))
    }
  }

  return result.join("\n")
}

// ═══════════════════════════════════════════════════════
// 그리드 테이블 빌더 — y-라인을 열에 배치 후 행 병합
// ═══════════════════════════════════════════════════════

function buildGridTable(lines: NormItem[][], columns: number[]): string {
  const numCols = columns.length

  // Step 1: 각 y-라인을 열에 배치
  const yRows: string[][] = lines.map(items => {
    const row = Array(numCols).fill("")
    for (const item of items) {
      const col = findColumn(item.x, columns)
      row[col] = row[col] ? row[col] + " " + item.text : item.text
    }
    return row
  })

  // Step 2: 행 병합 — 새 논리적 행 판별
  // 데이터 열 기준점 (가격 등이 들어가는 오른쪽 열들)
  const dataColStart = Math.max(2, Math.floor(numCols / 2))
  const merged: string[][] = []

  for (const row of yRows) {
    if (row.every(c => c === "")) continue

    if (merged.length === 0) {
      merged.push([...row])
      continue
    }

    const prev = merged[merged.length - 1]
    const filledCols = row.map((c, i) => c ? i : -1).filter(i => i >= 0)
    const filledCount = filledCols.length

    let isNewRow = false

    // Rule 1: col 0에 텍스트 (3글자 이상) → 새 행 (단, "권"처럼 짧은 건 continuation)
    if (row[0] && row[0].length >= 3) {
      isNewRow = true
    }

    // Rule 2: col 1에 텍스트 → 항상 새 행 (새 항목 시작)
    if (!isNewRow && numCols > 1 && row[1]) {
      isNewRow = true
    }

    // Rule 3: 데이터 열(3+)에 새 값이 있고 이전 행 데이터 열에도 이미 값 있음 → 새 가격 행
    if (!isNewRow) {
      const hasData = row.slice(dataColStart).some(c => c !== "")
      const prevHasData = prev.slice(dataColStart).some(c => c !== "")
      if (hasData && prevHasData) {
        isNewRow = true
      }
    }

    // Exception: filledCount=1이고 col 0에 짧은 텍스트(≤2자) → word continuation (예: "권", "여권")
    if (isNewRow && filledCount === 1 && row[0] && row[0].length <= 2) {
      isNewRow = false
    }

    if (isNewRow) {
      merged.push([...row])
    } else {
      for (let c = 0; c < numCols; c++) {
        if (row[c]) {
          prev[c] = prev[c] ? prev[c] + " " + row[c] : row[c]
        }
      }
    }
  }

  if (merged.length < 2) {
    return merged.map(r => r.filter(c => c).join(" ")).join("\n")
  }

  // Step 3: 헤더 행 병합 — 첫 N행이 모두 데이터열(dataColStart+)에 값이 없으면 헤더
  let headerEnd = 0
  for (let r = 0; r < merged.length; r++) {
    const hasDataValues = merged[r].slice(dataColStart).some(c => c && /\d/.test(c))
    if (hasDataValues) break
    headerEnd = r + 1
  }

  if (headerEnd > 1) {
    // 헤더 행들을 하나로 합침
    const headerRow = Array(numCols).fill("")
    for (let r = 0; r < headerEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (merged[r][c]) {
          headerRow[c] = headerRow[c] ? headerRow[c] + " " + merged[r][c] : merged[r][c]
        }
      }
    }
    merged.splice(0, headerEnd, headerRow)
  }

  // Step 3.5: 셀 텍스트 균등배분 공백 제거 ("경 제 총 괄 반" → "경제총괄반")
  for (const row of merged) {
    for (let c = 0; c < row.length; c++) {
      if (row[c]) row[c] = collapseEvenSpacing(row[c])
    }
  }

  // Step 3.6: 테이블 품질 검증 — 선 없는 fallback 경로에서는 보수적으로
  const totalCells = merged.length * numCols
  const filledCells = merged.reduce((s, row) => s + row.filter(c => c).length, 0)
  // 빈 셀 과반, 행이 2 미만, 또는 3행 이하+7열 이상 → 텍스트로 복원
  if (filledCells < totalCells * 0.35 || merged.length < 2 ||
      (merged.length <= 3 && numCols >= 7)) {
    return merged.map(r => r.filter(c => c).join("\t")).join("\n")
  }

  // Step 4: 마크다운 테이블 — 셀 텍스트의 `|`는 열 구분자를 깨뜨리므로 이스케이프,
  // `\t`는 공백으로 (그리드 경로 builder.ts 셀 조립과 정합)
  const escCell = (c: string) => c.replace(/\t/g, " ").replace(/\|/g, "\\|")
  const md: string[] = []
  md.push("| " + merged[0].map(escCell).join(" | ") + " |")
  md.push("| " + merged[0].map(() => "---").join(" | ") + " |")
  for (let r = 1; r < merged.length; r++) {
    md.push("| " + merged[r].map(escCell).join(" | ") + " |")
  }
  return md.join("\n")
}
