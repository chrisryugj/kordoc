/**
 * 클러스터 기반 테이블 감지 — 선이 없는 PDF에서 텍스트 정렬 패턴으로 테이블 구조 추론.
 *
 * Original work: Copyright 2025-2026 Hancom, Inc.
 * Licensed under the Apache License, Version 2.0
 * https://github.com/opendataloader-project/opendataloader-pdf
 *
 * ODL의 ClusterTableConsumer를 kordoc 컨텍스트에 맞게 단순화한 구현.
 * Modifications: TypeScript 재구현, 최소 2열 감지, 한국어 PDF 특화 최적화.
 *
 * 핵심 아이디어:
 * 1. 균등배분(개별 글자) 아이템을 사전 병합하여 노이즈 제거
 * 2. 헤더 행(짧은 라벨 + 넓은 갭) 감지 → 열 앵커로 사용
 * 3. 헤더 없으면 기존 X좌표 클러스터링으로 열 감지
 * 4. 다중행 셀(같은 논리 행이 여러 Y에 걸침) 병합
 */

import type { IRTable, IRCell, BoundingBox } from "../types.js"
import { spaceGapThreshold } from "./cell-text.js"

/** parser.ts의 NormItem과 동일한 인터페이스 */
export interface ClusterItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  fontName: string
  /** pdfjs 공백 아이템이 직전에 있었음 — 단어 경계 힌트 */
  hasSpaceBefore?: boolean
}

// ─── 상수 ──────────────────────────────────────────────
/** baseline 그룹핑 허용 오차 (pt) */
const Y_TOL = 3
/** 열 클러스터링 허용 오차 (pt) */
const COL_CLUSTER_TOL = 15
/** 테이블로 인정하기 위한 최소 행 수 */
const MIN_ROWS = 3
/** 테이블로 인정하기 위한 최소 열 수 */
const MIN_COLS = 2
/** 같은 행 내 아이템 간 최소 갭 (테이블 컬럼 구분) — fontSize 배수 */
const MIN_GAP_FACTOR = 2.0
/** 같은 행 내 아이템 간 최소 갭 절대값 (pt) */
const MIN_GAP_ABSOLUTE = 20
/** 열에 값이 있는 행의 비율 최소 기준 */
const MIN_COL_FILL_RATIO = 0.4

interface RowGroup {
  y: number       // 대표 Y좌표 (평균 baseline)
  items: ClusterItem[]
}

interface ColCluster {
  x: number       // 열 X좌표 (왼쪽 경계)
  count: number   // 이 열에 속한 아이템 수
}

/** 헤더 감지 결과: 열 앵커 + 헤더 행 인덱스 */
interface HeaderResult {
  columns: ColCluster[]
  headerIdx: number
}

export interface ClusterTableResult {
  table: IRTable
  bbox: BoundingBox
  usedItems: Set<ClusterItem>
}

/**
 * 클러스터 기반 테이블 감지. 선이 없는 PDF의 fallback 경로에서 호출.
 */
export function detectClusterTables(items: ClusterItem[], pageNum: number): ClusterTableResult[] {
  if (items.length < MIN_ROWS * MIN_COLS) return []

  // 0. 균등배분 아이템 사전 병합 (개별 글자 → 단어)
  const { merged, originMap } = mergeEvenSpacedClusters(items)

  // 1. Y좌표로 행 그룹핑 + 첨자 행 복원
  // 본문 줄에서 살짝 올라간 각주 마커(*)·덧말은 baseline 그룹핑(Y_TOL)에서 별도 행으로
  // 떨어진다. 이런 조각 행이 표 헤더/열 앵커로 오인되면 본문 문단이 통째로 표에 흡수되므로
  // 수직으로 겹치는 행은 같은 시각적 줄로 병합한다.
  const rows = mergeOverlappingRows(groupByBaseline(merged))
  if (rows.length < MIN_ROWS) return []

  const results: ClusterTableResult[] = []

  // 2. 헤더 행 기반 열 감지 시도
  const headerResult = detectHeaderRow(rows)

  if (headerResult) {
    // 헤더 기반: 헤더 이후 행에서 boundary 기반 열 구조 매칭
    const { columns, headerIdx } = headerResult
    const headerRow = rows[headerIdx]
    const headerItems = [...headerRow.items].sort((a, b) => a.x - b.x)
    const headerAndBelow = rows.slice(headerIdx)
    // 다중행 셀 병합
    const mergedRows = mergeMultiLineRows(headerAndBelow, columns)
    // boundary 기반 region 탐색 (proximity 대신 headerItems 범위 사용)
    const tableRegions = findTableRegionsByHeader(mergedRows, columns, headerItems)
    for (const region of tableRegions) {
      const table = buildClusterTable(region.rows, columns, pageNum)
      if (table) {
        expandUsedItems(table.usedItems, originMap)
        results.push(table)
      }
    }
  }

  if (results.length === 0) {
    // 3. 기존 방식: suspicious gaps + column clustering
    const suspiciousRows = rows.filter(row => hasSuspiciousGaps(row))
    if (suspiciousRows.length >= MIN_ROWS) {
      const columns = extractColumnClusters(suspiciousRows)
      if (columns.length >= MIN_COLS) {
        const tableRegions = findTableRegions(rows, columns)
        for (const region of tableRegions) {
          const mergedRows = mergeMultiLineRows(region.rows, columns)
          const table = buildClusterTable(mergedRows, columns, pageNum)
          if (table) {
            expandUsedItems(table.usedItems, originMap)
            results.push(table)
          }
        }
      }
    }
  }

  // 4. 2단 조판 본문 오인 강등 — 걸러진 아이템은 usedItems에서 빠져
  //    XY-Cut(단 분리) 경로로 흘러가 올바른 읽기 순서로 복원된다.
  return results.filter(r => !isTwoColumnProse(r))
}

// ─── 2단 조판 본문 판별 ─────────────────────────────────

/**
 * 감지된 "표"가 실은 2단 조판 본문(국회 속기록·고전 관보류)인지 판별.
 *
 * 2단 본문에서는 문단 끝의 짧은 줄 쌍("한 것이올시다." | "다.")이 헤더 조건을
 * 우연히 만족해 페이지 본문 전체가 2열 표로 흡수된다. 진짜 표와 가르는 신호:
 * 양쪽 "열" 모두 긴 문장 조각(라벨 열 부재) + 숫자 희박 + 마커 희박 +
 * 좌우 단 폭 대칭 + 각 단의 오른쪽 끝이 justify로 정렬.
 * (코퍼스 42건 전수 시뮬레이션에서 속기록 4페이지만 발화, 오발화 0 검증)
 */
function isTwoColumnProse(r: ClusterTableResult): boolean {
  const t = r.table
  if (t.rows < 8) return false

  // 실질 열: 채움률 30%+ 인 열이 정확히 2개 (유령 열은 무시)
  const dense: number[] = []
  for (let c = 0; c < t.cols; c++) {
    const filled = t.cells.filter(row => row[c]?.text.trim()).length
    if (filled / t.rows >= 0.3) dense.push(c)
  }
  if (dense.length !== 2) return false

  // 두 실질 열 모두 평균 셀 길이가 길어야 함 (진짜 표엔 짧은 라벨/숫자 열 존재)
  for (const c of dense) {
    const lens = t.cells.map(row => row[c]?.text.replace(/\s+/g, "").length ?? 0).filter(n => n > 0)
    const avg = lens.reduce((s, v) => s + v, 0) / (lens.length || 1)
    if (avg < 12) return false
  }

  return findTwoColumnProseCutX([...r.usedItems]) !== null
}

/**
 * 아이템 집합이 좌우 2단 조판 본문인지 — 줄-투표로 중앙 빈 띠를 찾고
 * 양쪽이 모두 prose(긴 줄 + 숫자·마커 희박 + justify 정렬 + 폭 대칭)인지 검사.
 * 2단 본문이면 단 사이 컷 x좌표를, 아니면 null을 반환.
 * page-blocks에서 레거시 컬럼 감지 가드 + 강제 단 분리에 쓰인다.
 */
export function findTwoColumnProseCutX(items: ClusterItem[]): number | null {
  const lines = groupByBaseline(items)
  if (lines.length < 8) return null

  let minX = Infinity
  let maxX = -Infinity
  for (const i of items) {
    if (i.x < minX) minX = i.x
    if (i.x + i.w > maxX) maxX = i.x + i.w
  }
  // 비유한/과대 span 가드 — 손상 PDF의 오염된 좌표(±Infinity, 1e9 등)가 스캔 루프를
  // 폭주시키는 것 차단 (fuzz: bflip에서 페이지당 수십억 회 반복 실측)
  if (!Number.isFinite(maxX - minX)) return null
  if (maxX - minX < 100) return null

  // 중앙부(30~70%)를 2pt 격자로 스캔: 각 x를 덮는 줄 수가 최소인 지점 = 단 사이 빈 띠.
  // 프로젝션 최대 갭 방식과 달리 전폭 제목 몇 줄이 있어도 빈 띠를 찾는다.
  // 후보 수 상한 400 — 정상 판형(span<2000pt)은 2pt 그대로, 오염 좌표만 성긴 샘플링
  const lo = minX + (maxX - minX) * 0.3
  const hi = minX + (maxX - minX) * 0.7
  const step = Math.max(2, (hi - lo) / 400)
  let cutX = 0
  let bestCover = Infinity
  for (let x = lo; x <= hi; x += step) {
    let cover = 0
    for (const line of lines) {
      if (line.items.some(i => i.x < x && i.x + i.w > x)) cover++
    }
    if (cover < bestCover) { bestCover = cover; cutX = x }
  }
  // 빈 띠를 15% 넘는 줄이 가로지르면 2단 아님
  if (bestCover / lines.length > 0.15) return null

  // 줄 다수(55%+)가 컷 양쪽에 모두 텍스트를 가져야 함 (한쪽 들여쓰기 문서 배제).
  // 55%: 상단 1/3이 전폭 목차인 속기록 1면(57%)까지 포함하는 값 — 코퍼스 전수에서
  // 타 문서 오발화 0 확인
  // 단별 통계는 양쪽에 글이 있는 줄로만 — 한쪽에만 글이 있는 줄(2단 위 목차·제목 띠)이 섞이면 왼 단 양쪽 정렬 비율이
  // 기준 아래로 떨어져 줄 단위로 섞여 읽힌다 (국회 회의록 OCR 실측)
  const left: ClusterItem[] = []
  const right: ClusterItem[] = []
  let twoSide = 0
  for (const line of lines) {
    const L: ClusterItem[] = [], R: ClusterItem[] = []
    for (const i of line.items) {
      if (i.x + i.w <= cutX) L.push(i)
      else if (i.x >= cutX) R.push(i)
    }
    if (L.length && R.length) { twoSide++; left.push(...L); right.push(...R) }
  }
  if (twoSide / lines.length < 0.55) return null
  if (left.length < 5 || right.length < 5) return null

  // 숫자·기호 위주(예산/통계표) 제외
  const allText = items.map(i => i.text).join("").replace(/\s+/g, "")
  const digits = (allText.match(/[\d,.%△—-]/g) || []).length
  if (allText.length === 0 || digits / allText.length > 0.15) return null

  // 각 단: 줄 텍스트 길이 + 마커 밀도 + 폭 + 오른쪽 끝 justify 비율
  const stats = [left, right].map(side => {
    let sMinX = Infinity
    let sMaxR = -Infinity
    let fsSum = 0
    const rowEnds = new Map<number, number>()
    const rowLens = new Map<number, number>()
    const rowFirst = new Map<number, ClusterItem>()
    for (const i of side) {
      if (i.x < sMinX) sMinX = i.x
      const rgt = i.x + i.w
      if (rgt > sMaxR) sMaxR = rgt
      fsSum += i.fontSize
      const key = Math.round(i.y / 4)
      rowEnds.set(key, Math.max(rowEnds.get(key) ?? -Infinity, rgt))
      rowLens.set(key, (rowLens.get(key) ?? 0) + i.text.replace(/\s+/g, "").length)
      const f = rowFirst.get(key)
      if (!f || i.x < f.x) rowFirst.set(key, i)
    }
    const ends = [...rowEnds.values()].sort((a, b) => a - b)
    const p85 = ends[Math.floor(ends.length * 0.85)] ?? sMaxR
    const fs = fsSum / side.length
    const justified = ends.filter(e => Math.abs(e - p85) <= fs).length / ends.length
    const lens = [...rowLens.values()]
    const avgLen = lens.reduce((s, v) => s + v, 0) / (lens.length || 1)
    const markers = [...rowFirst.values()].filter(i => /^[•▪◦‣∙·\-–—□■◇◆▶※*]/.test(i.text)).length
    return { width: sMaxR - sMinX, justified, avgLen, markerRatio: markers / (rowFirst.size || 1) }
  })

  // 양쪽 모두 긴 문장 줄 (진짜 표엔 짧은 라벨/숫자 열 존재)
  if (stats.some(s => s.avgLen < 12)) return null
  // 불릿/마커 구조(SWOT 4분면·불릿 리스트) 제외
  if (stats.some(s => s.markerRatio > 0.1)) return null
  const widthSym = Math.min(stats[0].width, stats[1].width) / Math.max(stats[0].width, stats[1].width)
  if (widthSym < 0.6) return null
  // 본문 단은 마지막 문단 줄을 제외한 대부분 행이 오른쪽 끝까지 채워진다
  if (Math.min(stats[0].justified, stats[1].justified) < 0.55) return null
  return cutX
}

// ─── 균등배분 사전 병합 ──────────────────────────────────

/** 균등배분(1글자+균일간격) 아이템을 단어 단위로 병합. 원본→병합 매핑도 반환. */
function mergeEvenSpacedClusters(
  items: ClusterItem[],
): { merged: ClusterItem[]; originMap: Map<ClusterItem, ClusterItem[]> } {
  const originMap = new Map<ClusterItem, ClusterItem[]>()
  const rows = groupByBaseline(items)
  const merged: ClusterItem[] = []

  for (const row of rows) {
    const sorted = [...row.items].sort((a, b) => a.x - b.x)
    let i = 0
    while (i < sorted.length) {
      if (/^[가-힣\d]$/.test(sorted[i].text)) {
        let runEnd = i + 1
        while (runEnd < sorted.length && /^[가-힣\d]$/.test(sorted[runEnd].text)) {
          // 명시적 공백 글리프 = 단어 경계 → run 분리 (Type3 글자 분리 배치 오판 방지)
          if (sorted[runEnd].hasSpaceBefore) break
          const gap = sorted[runEnd].x - (sorted[runEnd - 1].x + sorted[runEnd - 1].w)
          const fs = sorted[runEnd].fontSize
          if (gap < fs * 0.1 || gap > fs * 3) break
          runEnd++
        }
        if (runEnd - i >= 3) {
          const gaps: number[] = []
          for (let g = i + 1; g < runEnd; g++) {
            gaps.push(sorted[g].x - (sorted[g - 1].x + sorted[g - 1].w))
          }
          let minG = Infinity, maxG = -Infinity
          for (const g of gaps) { if (g < minG) minG = g; if (g > maxG) maxG = g }
          if (minG > 0 && maxG / minG <= 3) {
            const run = sorted.slice(i, runEnd)
            const text = run.map(r => r.text).join("")
            const first = run[0], last = run[runEnd - i - 1]
            const item: ClusterItem = {
              text, x: first.x, y: first.y,
              w: (last.x + last.w) - first.x, h: first.h,
              fontSize: first.fontSize, fontName: first.fontName,
            }
            originMap.set(item, run)
            merged.push(item)
            i = runEnd
            continue
          }
        }
      }
      merged.push(sorted[i])
      i++
    }
  }
  return { merged, originMap }
}

/** 병합된 ClusterItem의 usedItems를 원본 아이템으로 확장 */
function expandUsedItems(usedItems: Set<ClusterItem>, originMap: Map<ClusterItem, ClusterItem[]>): void {
  const toAdd: ClusterItem[] = []
  for (const item of usedItems) {
    const origins = originMap.get(item)
    if (origins) for (const o of origins) toAdd.push(o)
  }
  for (const a of toAdd) usedItems.add(a)
}

// ─── 헤더 행 기반 열 감지 ───────────────────────────────

/**
 * 상위 행에서 테이블 헤더 후보를 탐색.
 * 조건: 2~6개 짧은 아이템, 최소 1개 큰 갭(>2.5x fontSize), 넓은 X 범위,
 * 한글 포함, 후속 행에서 최소 MIN_ROWS개가 헤더 열에 매칭
 */
function detectHeaderRow(rows: RowGroup[]): HeaderResult | null {
  const allItems = rows.flatMap(r => r.items)
  if (allItems.length === 0) return null
  let allMinX = Infinity, allMaxX = -Infinity
  for (const i of allItems) { if (i.x < allMinX) allMinX = i.x; const r = i.x + i.w; if (r > allMaxX) allMaxX = r }
  const pageSpan = allMaxX - allMinX
  if (pageSpan <= 0) return null

  // 전체 행에서 헤더 후보 탐색 — 가드가 충분히 엄격하므로 범위 제한 불필요
  for (let ri = 0; ri < rows.length; ri++) {
    const row = rows[ri]
    // 2~6 아이템
    if (row.items.length < MIN_COLS || row.items.length > 6) continue
    // 모든 아이템 짧아야 함 (각 8자 이내)
    if (row.items.some(i => i.text.length > 8)) continue
    // 한글 포함 아이템이 최소 1개
    if (!row.items.some(i => /[가-힣]/.test(i.text))) continue
    // 마커(□○●·※▶-) 시작 아이템 제외
    if (row.items.some(i => /^[□■○●·※▶▷◆◇\-]/.test(i.text))) continue

    const sorted = [...row.items].sort((a, b) => a.x - b.x)
    const xSpan = (sorted[sorted.length - 1].x + sorted[sorted.length - 1].w) - sorted[0].x

    // X 범위가 전체의 40%+ 차지
    if (xSpan / pageSpan < 0.4) continue

    // 최소 1개 갭이 avgFontSize의 2.5배 이상
    const avgFs = sorted.reduce((s, i) => s + i.fontSize, 0) / sorted.length
    let hasLargeGap = false
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
      if (gap >= avgFs * 2.5) { hasLargeGap = true; break }
    }
    if (!hasLargeGap) continue

    // 열 앵커 생성
    const columns: ColCluster[] = sorted.map(item => ({ x: item.x, count: 0 }))

    // 후속 행 검증: 헤더 이후 MIN_ROWS+ 행이 2+ 열에 매칭
    let matchCount = 0
    for (let j = ri + 1; j < rows.length && matchCount < MIN_ROWS + 2; j++) {
      const matched = countMatchedColumnsRange(rows[j], columns, sorted)
      if (matched >= MIN_COLS) matchCount++
    }
    if (matchCount < MIN_ROWS) continue

    return { columns, headerIdx: ri }
  }
  return null
}

/**
 * 수직으로 겹치는 인접 행 병합 — 첨자(각주 마커/덧말)가 별도 행으로 분리된 것 복원.
 * 첨자 조각 행: 아이템이 적고(≤3) 짧으며(≤8자), 겹치는 행보다 글자 박스가 확실히
 * 작은 행(높이 ≤0.8배). 이런 행만 본문 줄에 흡수한다.
 * (rowspan 라벨처럼 키가 큰 셀이 이웃 행을 덮는 경우는 병합하지 않음 — 정상 표 구조)
 */
function mergeOverlappingRows(rows: RowGroup[]): RowGroup[] {
  if (rows.length <= 1) return rows
  const result: RowGroup[] = [rows[0]]
  for (let i = 1; i < rows.length; i++) {
    const prev = result[result.length - 1]
    const curr = rows[i]
    const a = rowBand(prev)
    const b = rowBand(curr)
    const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom)
    const prevIsFrag = isFragmentRow(prev) && a.height <= b.height * 0.8 && overlap >= a.height * 0.5
    const currIsFrag = isFragmentRow(curr) && b.height <= a.height * 0.8 && overlap >= b.height * 0.5
    if (prevIsFrag || currIsFrag) {
      // 본문 줄(흡수하는 쪽)의 y를 대표값으로 유지
      const baseY = prevIsFrag ? curr.y : prev.y
      result[result.length - 1] = { y: baseY, items: [...prev.items, ...curr.items] }
    } else {
      result.push(curr)
    }
  }
  return result
}

/** 첨자 후보 행: 아이템 ≤3개, 모두 짧은 텍스트(≤8자) */
function isFragmentRow(row: RowGroup): boolean {
  return row.items.length <= 3 && row.items.every(i => i.text.length <= 8)
}

/** 행 아이템들의 수직 범위 (bottom=min y, top=max y+h) */
function rowBand(row: RowGroup): { bottom: number; top: number; height: number } {
  let bottom = Infinity, top = -Infinity
  for (const i of row.items) {
    const h = i.h > 0 ? i.h : i.fontSize
    if (i.y < bottom) bottom = i.y
    if (i.y + h > top) top = i.y + h
  }
  return { bottom, top, height: top - bottom }
}

// ─── 다중행 셀 병합 ────────────────────────────────────

/** 연속 행에서 MIN_COLS 미만 열만 사용하고 Y갭이 작으면 이전 행에 병합 */
function mergeMultiLineRows(rows: RowGroup[], columns: ColCluster[]): RowGroup[] {
  if (rows.length <= 1) return rows
  const result: RowGroup[] = [rows[0]]
  const allFontSizes = rows.flatMap(r => r.items).map(i => i.fontSize)
  const avgFontSize = allFontSizes.length > 0
    ? allFontSizes.reduce((s, v) => s + v, 0) / allFontSizes.length : 12

  for (let i = 1; i < rows.length; i++) {
    const prev = result[result.length - 1]
    const curr = rows[i]
    const yGap = Math.abs(prev.y - curr.y)
    const matchedCols = countMatchedColumns(curr, columns)

    // 병합 조건: Y갭이 작고 + 아이템 수가 적음 (연속 행 = 1~2개 아이템)
    // 아이템이 많은 행(3+)은 독립적인 데이터 행 → 병합하지 않음
    if (yGap < avgFontSize * 1.8 && curr.items.length <= 2 && (matchedCols < MIN_COLS || curr.items.length === 1)) {
      result[result.length - 1] = {
        y: prev.y,
        items: [...prev.items, ...curr.items],
      }
    } else {
      result.push(curr)
    }
  }
  return result
}

// ─── 기본 유틸 ──────────────────────────────────────────

/** 아이템을 baseline(Y좌표)으로 그룹핑 */
function groupByBaseline(items: ClusterItem[]): RowGroup[] {
  if (items.length === 0) return []

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const rows: RowGroup[] = []
  let curItems: ClusterItem[] = [sorted[0]]
  let curY = sorted[0].y

  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - curY) <= Y_TOL) {
      curItems.push(sorted[i])
    } else {
      rows.push({ y: curY, items: curItems })
      curItems = [sorted[i]]
      curY = sorted[i].y
    }
  }
  if (curItems.length > 0) rows.push({ y: curY, items: curItems })

  return rows
}

/** 행 내 아이템 간 "의심스러운" 갭 존재 여부 (테이블 열 구분 후보) */
function hasSuspiciousGaps(row: RowGroup): boolean {
  if (row.items.length < 2) return false

  const sorted = [...row.items].sort((a, b) => a.x - b.x)
  // 가드: 2아이템 행에서 두 번째 아이템이 긴 텍스트면 들여쓰기 단락
  if (sorted.length === 2 && sorted[1].text.length > 20) return false

  const avgFontSize = sorted.reduce((s, i) => s + i.fontSize, 0) / sorted.length
  const minGap = Math.max(avgFontSize * MIN_GAP_FACTOR, MIN_GAP_ABSOLUTE)

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
    if (gap >= minGap) return true
  }
  return false
}

/** 의심스러운 행들의 X좌표에서 열 클러스터 추출 */
function extractColumnClusters(rows: RowGroup[]): ColCluster[] {
  const allX: number[] = []
  for (const row of rows) {
    for (const item of row.items) allX.push(item.x)
  }
  if (allX.length === 0) return []

  allX.sort((a, b) => a - b)

  const clusters: ColCluster[] = []
  let clusterStart = 0

  for (let i = 1; i <= allX.length; i++) {
    if (i === allX.length || allX[i] - allX[i - 1] > COL_CLUSTER_TOL) {
      const slice = allX.slice(clusterStart, i)
      const avg = Math.round(slice.reduce((s, v) => s + v, 0) / slice.length)
      clusters.push({ x: avg, count: slice.length })
      clusterStart = i
    }
  }

  const minCount = Math.max(2, Math.floor(rows.length * MIN_COL_FILL_RATIO))
  return clusters
    .filter(c => c.count >= minCount)
    .sort((a, b) => a.x - b.x)
}

/** 헤더 기반 테이블 영역 찾기 — boundary 기반 열 매칭, 관대한 종료 조건 */
function findTableRegionsByHeader(
  allRows: RowGroup[], columns: ColCluster[], headerItems: ClusterItem[],
): { rows: RowGroup[] }[] {
  const regions: { rows: RowGroup[] }[] = []
  let currentRegion: RowGroup[] = []
  let missStreak = 0 // 연속 비매칭 행 수

  for (const row of allRows) {
    const matchedCols = countMatchedColumnsRange(row, columns, headerItems)
    if (matchedCols >= MIN_COLS) {
      currentRegion.push(row)
      missStreak = 0
    } else if (currentRegion.length > 0 && (row.items.length <= 2 || missStreak === 0)) {
      // 단일 비매칭은 허용 (multi-line 셀 or 단일 아이템)
      currentRegion.push(row)
      missStreak++
    } else {
      // 연속 2+ 비매칭 → 테이블 종료
      // 끝에 붙은 비매칭 행 제거
      while (currentRegion.length > 0) {
        const last = currentRegion[currentRegion.length - 1]
        if (countMatchedColumnsRange(last, columns, headerItems) >= MIN_COLS) break
        currentRegion.pop()
      }
      if (currentRegion.length >= MIN_ROWS) {
        regions.push({ rows: [...currentRegion] })
      }
      currentRegion = []
      missStreak = 0
    }
  }

  // 끝에 붙은 비매칭 행 정리
  while (currentRegion.length > 0) {
    const last = currentRegion[currentRegion.length - 1]
    if (countMatchedColumnsRange(last, columns, headerItems) >= MIN_COLS) break
    currentRegion.pop()
  }
  if (currentRegion.length >= MIN_ROWS) {
    regions.push({ rows: currentRegion })
  }

  return regions
}

/** 연속된 테이블 행 영역 찾기 */
function findTableRegions(allRows: RowGroup[], columns: ColCluster[]): { rows: RowGroup[] }[] {
  const regions: { rows: RowGroup[] }[] = []
  let currentRegion: RowGroup[] = []

  for (const row of allRows) {
    const matchedCols = countMatchedColumns(row, columns)
    if (matchedCols >= MIN_COLS) {
      currentRegion.push(row)
    } else if (row.items.length === 1) {
      if (currentRegion.length > 0) {
        currentRegion.push(row)
      }
    } else {
      if (currentRegion.length >= MIN_ROWS) {
        regions.push({ rows: [...currentRegion] })
      }
      currentRegion = []
    }
  }

  if (currentRegion.length >= MIN_ROWS) {
    regions.push({ rows: currentRegion })
  }

  return regions
}

/** 행의 아이템이 몇 개의 열에 매칭되는지 (X좌표 근접) */
function countMatchedColumns(row: RowGroup, columns: ColCluster[]): number {
  const matched = new Set<number>()
  for (const item of row.items) {
    for (let ci = 0; ci < columns.length; ci++) {
      if (Math.abs(item.x - columns[ci].x) <= COL_CLUSTER_TOL * 2) {
        matched.add(ci)
        break
      }
    }
  }
  return matched.size
}

/**
 * 범위 기반 열 매칭 — 헤더 아이템의 x~x+w 범위 내에 있는지 확인.
 * 헤더 열 간 중간점을 경계로 사용하여 넓은 범위 매칭.
 */
function countMatchedColumnsRange(
  row: RowGroup, columns: ColCluster[], headerItems: ClusterItem[],
): number {
  // 열 경계 계산: 헤더 아이템 사이 중간점
  const boundaries: { left: number; right: number }[] = []
  for (let ci = 0; ci < headerItems.length; ci++) {
    const left = ci === 0 ? 0 : (headerItems[ci - 1].x + headerItems[ci - 1].w + headerItems[ci].x) / 2
    const right = ci === headerItems.length - 1
      ? Infinity
      : (headerItems[ci].x + headerItems[ci].w + headerItems[ci + 1].x) / 2
    boundaries.push({ left, right })
  }

  const matched = new Set<number>()
  for (const item of row.items) {
    for (let ci = 0; ci < boundaries.length; ci++) {
      if (item.x >= boundaries[ci].left && item.x < boundaries[ci].right) {
        matched.add(ci)
        break
      }
    }
  }
  return matched.size
}

/**
 * 행별 갭 분석으로 아이템을 열에 배정.
 *
 * 전역 경계선 대신 각 행을 개별 분석:
 * 1) 행 내 N-1개의 가장 큰 갭으로 N개 그룹 분할
 * 2) 각 그룹의 중심 X를 헤더 열 중심과 비교하여 최적 열 배정
 * 3) 갭이 불충분한 행(아이템 적음)은 헤더 중간점 기반 fallback
 *
 * 이 방식은 열 폭이 행마다 달라도 정확하게 분리.
 */
function assignRowItems(
  items: ClusterItem[], columns: ColCluster[], numCols: number,
): { col: number; items: ClusterItem[] }[] {
  if (items.length === 0) return []
  const sorted = [...items].sort((a, b) => a.x - b.x)

  // 헤더 열 중심 좌표
  const colCenters = columns.map(c => c.x)

  // 행 내 갭 계산
  const gaps: { idx: number; size: number }[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push({ idx: i, size: sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w) })
  }

  // N-1개의 가장 큰 갭 선택 — 적응형 임계값
  // 아이템이 적은 행(헤더, 라벨 행): 낮은 절대 임계값 (모든 갭이 유의미할 가능성 높음)
  // 아이템이 많은 행(본문 데이터): 상대적 임계값 (워드 갭 vs 컬럼 갭 구분)
  const gapSizes = gaps.map(g => g.size).sort((a, b) => a - b)
  const medianGap = gapSizes.length > 0 ? gapSizes[Math.floor(gapSizes.length / 2)] : 0
  const gapThreshold = sorted.length <= numCols + 1
    ? 12  // 희소 행: 낮은 절대 임계값
    : Math.max(medianGap * 2.5, 12) // 밀집 행: 상대적 임계값
  const significantGaps = gaps
    .filter(g => g.size >= gapThreshold)
    .sort((a, b) => b.size - a.size)
    .slice(0, numCols - 1)
    .sort((a, b) => a.idx - b.idx) // 위치 순 복원

  // 가용 갭으로 그룹 분할 (갭이 부족해도 있는 만큼 분할)
  const groups: ClusterItem[][] = []
  let start = 0
  for (const gap of significantGaps) {
    groups.push(sorted.slice(start, gap.idx))
    start = gap.idx
  }
  groups.push(sorted.slice(start))

  // 각 그룹 → 가장 가까운 헤더 열에 배정
  const result: { col: number; items: ClusterItem[] }[] = []
  const usedCols = new Set<number>()
  // 그룹별 중심 X 계산
  const groupCenters = groups.map(g => {
    let minX = Infinity, maxX = -Infinity
    for (const i of g) { if (i.x < minX) minX = i.x; const r = i.x + i.w; if (r > maxX) maxX = r }
    return (minX + maxX) / 2
  })

  // 탐욕적 배정: 각 그룹을 가장 가까운 미사용 열에 배정
  const assignments: { gi: number; ci: number; dist: number }[] = []
  for (let gi = 0; gi < groups.length; gi++) {
    for (let ci = 0; ci < numCols; ci++) {
      assignments.push({ gi, ci, dist: Math.abs(groupCenters[gi] - colCenters[ci]) })
    }
  }
  assignments.sort((a, b) => a.dist - b.dist)

  const assignedGroups = new Set<number>()
  for (const { gi, ci } of assignments) {
    if (assignedGroups.has(gi) || usedCols.has(ci)) continue
    result.push({ col: ci, items: groups[gi] })
    assignedGroups.add(gi)
    usedCols.add(ci)
  }
  // 남은 그룹 (numGroups > numCols인 경우 — 가장 가까운 열에 추가)
  for (let gi = 0; gi < groups.length; gi++) {
    if (assignedGroups.has(gi)) continue
    let bestCol = 0, bestDist = Infinity
    for (let ci = 0; ci < numCols; ci++) {
      const d = Math.abs(groupCenters[gi] - colCenters[ci])
      if (d < bestDist) { bestDist = d; bestCol = ci }
    }
    result.push({ col: bestCol, items: groups[gi] })
  }

  return result
}

/** 클러스터 테이블을 IRTable로 구성 */
function buildClusterTable(
  rows: RowGroup[],
  columns: ColCluster[],
  pageNum: number,
): ClusterTableResult | null {
  const numCols = columns.length
  const numRows = rows.length

  if (numRows < MIN_ROWS || numCols < MIN_COLS) return null

  const cells: IRCell[][] = Array.from(
    { length: numRows },
    () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })),
  )

  const usedItems = new Set<ClusterItem>()

  for (let r = 0; r < numRows; r++) {
    const row = rows[r]
    // 단일 아이템 행 → 전체 행 병합 (colSpan)
    if (row.items.length === 1 && numCols > 1) {
      cells[r][0] = { text: row.items[0].text, colSpan: numCols, rowSpan: 1 }
      usedItems.add(row.items[0])
      continue
    }

    // 행별 갭 분석 기반 열 배정
    const assignments = assignRowItems(row.items, columns, numCols)
    for (const { col, items } of assignments) {
      const text = joinCellItems(items)
      const existing = cells[r][col].text
      cells[r][col].text = existing ? existing + " " + text : text
      for (const item of items) usedItems.add(item)
    }
  }

  // 검증: 빈 행이 너무 많으면 테이블 아님
  let emptyRows = 0
  for (const row of cells) {
    if (row.every(c => c.text === "")) emptyRows++
  }
  if (emptyRows > numRows * 0.5) return null

  // 검증: 모든 열에 최소 1개 값이 있어야 함
  for (let c = 0; c < numCols; c++) {
    const hasValue = cells.some(row => row[c].text !== "")
    if (!hasValue) return null
  }

  // 후처리 1: 단일 열 연속 행 → 이전 행에 역방향 병합 (multi-line 셀)
  // 조건: 1개 열만 내용 + col0 비어있음 + 리스트 마커(○-·)로 시작하지 않음
  for (let r = numRows - 1; r >= 1; r--) {
    const nonEmptyCols = cells[r].filter(c => c.text.trim()).length
    if (nonEmptyCols !== 1) continue
    if (cells[r][0].text.trim() !== "") continue
    const contentText = cells[r].find(c => c.text.trim())?.text.trim() || ""
    // 리스트 마커로 시작하면 새 항목 → 병합하지 않음
    if (/^[○●▶\-·]/.test(contentText)) continue
    for (let pr = r - 1; pr >= 0; pr--) {
      if (cells[pr].some(c => c.text.trim())) {
        // 전폭 병합 행(한 아이템 행)의 가려진 칸에 쓰면 렌더에서 글이 사라진다 — 제 행으로 둔다
        // ("없음" 행 뒤 "3) 행정규제 : …"·"일부개정령안" 뒤 본문 첫 줄이 마크다운에서 빠지던 것, 제약산업 시행규칙 개정령안)
        if (cells[pr][0].colSpan > 1) break
        for (let c = 0; c < numCols; c++) {
          const prev = cells[pr][c].text.trim()
          const curr = cells[r][c].text.trim()
          if (curr) cells[pr][c].text = prev ? prev + " " + curr : curr
        }
        for (let c = 0; c < numCols; c++) cells[r][c].text = ""
        break
      }
    }
  }

  // 후처리 2: 번호만 있는 행(col0+마지막열만 값) → 다음 내용 행과 순방향 병합
  // 예: 목차 "|3|||3|" + "|청사 내 에너지...|행정지원과||" → "|3|청사...|행정지원과|3|"
  for (let r = 0; r < cells.length - 1; r++) {
    const row = cells[r]
    const hasCol0 = row[0].text.trim() !== ""
    const hasColLast = numCols > 1 && row[numCols - 1].text.trim() !== ""
    const midEmpty = row.slice(1, numCols - 1).every(c => c.text.trim() === "")
    if (hasCol0 && hasColLast && midEmpty) {
      // 다음 행에 col0이 비어있으면 병합
      const next = cells[r + 1]
      if (next[0].text.trim() === "" && next.some(c => c.text.trim())) {
        for (let c = 1; c < numCols; c++) {
          const curr = next[c].text.trim()
          if (curr) row[c].text = row[c].text.trim() ? row[c].text.trim() + " " + curr : curr
        }
        for (let c = 0; c < numCols; c++) next[c].text = ""
      }
    }
  }

  // 빈 행 제거
  const filteredCells = cells.filter(row => row.some(c => c.text.trim()))
  const finalRowCount = filteredCells.length

  // 검증
  if (finalRowCount < MIN_ROWS) return null

  const irTable: IRTable = {
    rows: finalRowCount,
    cols: numCols,
    cells: filteredCells,
    hasHeader: finalRowCount > 1,
  }

  // BBox 계산
  const allItems = rows.flatMap(r => r.items)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of allItems) {
    if (i.x < minX) minX = i.x
    if (i.y < minY) minY = i.y
    if (i.x + i.w > maxX) maxX = i.x + i.w
    const h = i.h > 0 ? i.h : i.fontSize
    if (i.y + h > maxY) maxY = i.y + h
  }

  return {
    table: irTable,
    bbox: { page: pageNum, x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    usedItems,
  }
}

/**
 * 칸 아이템 → 칸 글. 글자를 한 자씩 따로 긋는 제작기(지자체 예산 시스템 — 부천 세출예산사업명세서 굴림체, 글자마다
 * 0~1pt 간격)는 칸 아이템이 글자 하나씩이라 종전처럼 공백으로 이으면 "2 0 , 7 7 5 , 6 6 1"·"활 성 화" 가 된다.
 * 선 표 칸(cellTextToString)과 같게 간격이 낱말 공백 임계(spaceGapThreshold)를 넘거나 pdfjs 공백 힌트가 있을 때만 띄운다.
 * 한 행에 합쳐진 여러 줄(mergeMultiLineRows)은 세로로 겹치는 아이템끼리 한 줄로 묶어 위→아래로 잇는다 — x 로만
 * 세우면 글자 단위 칸에서 두 줄의 글자가 번갈아 섞인다. 첨자(각주 부호·원문자)는 본문 줄과 세로로 겹쳐 같은 줄에 든다
 */
function joinCellItems(items: ClusterItem[]): string {
  const hOf = (i: ClusterItem) => (i.h > 0 ? i.h : i.fontSize)
  const lines: { bottom: number; top: number; items: ClusterItem[] }[] = []
  for (const it of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const bottom = it.y, top = it.y + hOf(it)
    const line = lines.find(l => Math.min(l.top, top) - Math.max(l.bottom, bottom) >= Math.min(l.top - l.bottom, top - bottom) * 0.5)
    if (line) { line.items.push(it); line.bottom = Math.min(line.bottom, bottom); line.top = Math.max(line.top, top) }
    else lines.push({ bottom, top, items: [it] })
  }
  return lines.sort((a, b) => b.top - a.top).map(({ items: line }) => {
    line.sort((a, b) => a.x - b.x)
    let s = line[0].text
    for (let i = 1; i < line.length; i++) {
      const gap = line[i].x - (line[i - 1].x + line[i - 1].w)
      const fs = (line[i].fontSize + line[i - 1].fontSize) / 2
      s += ((line[i].hasSpaceBefore && gap >= fs * 0.05) || gap > spaceGapThreshold(fs) ? " " : "") + line[i].text
    }
    return s
  }).join(" ")
}
