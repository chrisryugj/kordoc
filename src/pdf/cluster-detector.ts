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
 * 1. 텍스트 아이템을 baseline(Y좌표)으로 그룹핑하여 행(row) 구성
 * 2. 각 행의 아이템 X좌표를 수집, 행 간 공통 X좌표 클러스터(열) 감지
 * 3. 2+ 열이 3+ 행에 걸쳐 일관되면 테이블로 판정
 * 4. 기존 detectColumns(min 3열)보다 느슨한 기준(min 2열)으로
 *    2열 테이블(key-value 등)도 감지
 */

import type { IRBlock, IRTable, IRCell, BoundingBox } from "../types.js"

/** parser.ts의 NormItem과 동일한 인터페이스 */
export interface ClusterItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  fontSize: number
  fontName: string
}

// ─── 상수 ──────────────────────────────────────────────
/** baseline 그룹핑 허용 오차 (pt) */
const Y_TOL = 3
/** 열 클러스터링 허용 오차 (pt) — detectColumns의 CLUSTER_TOL=22보다 엄격 */
const COL_CLUSTER_TOL = 15
/** 테이블로 인정하기 위한 최소 행 수 */
const MIN_ROWS = 3
/** 테이블로 인정하기 위한 최소 열 수 */
const MIN_COLS = 2
/** 같은 행 내 아이템 간 최소 갭 (테이블 컬럼 구분) — fontSize 배수 */
const MIN_GAP_FACTOR = 1.5
/** 열에 값이 있는 행의 비율 최소 기준 */
const MIN_COL_FILL_RATIO = 0.3

interface RowGroup {
  y: number       // 대표 Y좌표 (평균 baseline)
  items: ClusterItem[]
}

interface ColCluster {
  x: number       // 열 X좌표 (왼쪽 경계)
  count: number   // 이 열에 속한 아이템 수
}

export interface ClusterTableResult {
  table: IRTable
  bbox: BoundingBox
  usedItems: Set<ClusterItem>
}

/**
 * 클러스터 기반 테이블 감지. 선이 없는 PDF의 fallback 경로에서 호출.
 *
 * @param items 페이지의 텍스트 아이템 (Y 내림차순 정렬)
 * @param pageNum 페이지 번호
 * @returns 감지된 테이블들 (없으면 빈 배열)
 */
export function detectClusterTables(items: ClusterItem[], pageNum: number): ClusterTableResult[] {
  if (items.length < MIN_ROWS * MIN_COLS) return []

  // 1. Y좌표로 행 그룹핑
  const rows = groupByBaseline(items)
  if (rows.length < MIN_ROWS) return []

  // 2. "의심스러운" 행 식별 — 아이템 간 큰 갭이 있는 행
  const suspiciousRows = rows.filter(row => hasSuspiciousGaps(row))
  if (suspiciousRows.length < MIN_ROWS) return []

  // 3. 의심스러운 행들의 X좌표에서 열 클러스터 추출
  const columns = extractColumnClusters(suspiciousRows)
  if (columns.length < MIN_COLS) return []

  // 4. 연속된 의심스러운 행들을 테이블 영역으로 그룹화
  const tableRegions = findTableRegions(rows, columns)
  const results: ClusterTableResult[] = []

  for (const region of tableRegions) {
    const table = buildClusterTable(region.rows, columns, pageNum)
    if (table) results.push(table)
  }

  return results
}

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
  const avgFontSize = sorted.reduce((s, i) => s + i.fontSize, 0) / sorted.length
  const minGap = avgFontSize * MIN_GAP_FACTOR

  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
    if (gap >= minGap) return true
  }
  return false
}

/** 의심스러운 행들의 X좌표에서 열 클러스터 추출 (sort-and-split 방식, 순서 무관) */
function extractColumnClusters(rows: RowGroup[]): ColCluster[] {
  // 모든 X좌표 수집
  const allX: number[] = []
  for (const row of rows) {
    for (const item of row.items) allX.push(item.x)
  }
  if (allX.length === 0) return []

  // 정렬 후 갭 기반 분할
  allX.sort((a, b) => a - b)

  const clusters: ColCluster[] = []
  let clusterStart = 0

  for (let i = 1; i <= allX.length; i++) {
    if (i === allX.length || allX[i] - allX[i - 1] > COL_CLUSTER_TOL) {
      // 클러스터 완성: [clusterStart, i)
      const slice = allX.slice(clusterStart, i)
      const avg = Math.round(slice.reduce((s, v) => s + v, 0) / slice.length)
      clusters.push({ x: avg, count: slice.length })
      clusterStart = i
    }
  }

  // 최소 빈도 필터 — 행 수의 30% 이상 등장해야 유효한 열
  const minCount = Math.max(2, Math.floor(rows.length * MIN_COL_FILL_RATIO))
  return clusters
    .filter(c => c.count >= minCount)
    .sort((a, b) => a.x - b.x)
}

/** 연속된 테이블 행 영역 찾기 */
function findTableRegions(allRows: RowGroup[], columns: ColCluster[]): { rows: RowGroup[] }[] {
  const regions: { rows: RowGroup[] }[] = []
  let currentRegion: RowGroup[] = []

  for (const row of allRows) {
    // 이 행이 열 구조에 맞는지 확인
    const matchedCols = countMatchedColumns(row, columns)
    if (matchedCols >= MIN_COLS) {
      currentRegion.push(row)
    } else if (row.items.length === 1) {
      // 단일 아이템 행 — 병합 셀이거나 헤더일 수 있음
      if (currentRegion.length > 0) {
        currentRegion.push(row)
      }
    } else {
      // 비테이블 행 → 현재 영역 종료
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

/** 행의 아이템이 몇 개의 열에 매칭되는지 */
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

/** 아이템을 열에 배정. 거리 제한 초과 시 -1 반환. */
function assignToColumn(item: ClusterItem, columns: ColCluster[]): number {
  const MAX_DIST = COL_CLUSTER_TOL * 3
  let bestCol = -1
  let bestDist = Infinity
  for (let ci = 0; ci < columns.length; ci++) {
    const dist = Math.abs(item.x - columns[ci].x)
    if (dist < bestDist) {
      bestDist = dist
      bestCol = ci
    }
  }
  return bestDist <= MAX_DIST ? bestCol : -1
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

  // 셀 그리드 구성
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

    for (const item of row.items) {
      const col = assignToColumn(item, columns)
      if (col < 0) continue // 열에 매칭 안 되는 아이템은 무시
      const existing = cells[r][col].text
      cells[r][col].text = existing ? existing + " " + item.text : item.text
      usedItems.add(item)
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

  const irTable: IRTable = {
    rows: numRows,
    cols: numCols,
    cells,
    hasHeader: numRows > 1,
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
