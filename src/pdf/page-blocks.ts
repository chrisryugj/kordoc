/**
 * 페이지 콘텐츠 추출 → IRBlock[] (v2: 바운딩 박스 + 페이지 번호)
 *
 * 선 기반 테이블 감지(line-detector) → 클러스터 감지(cluster-detector) →
 * XY-Cut 읽기 순서의 계층 fallback으로 페이지 텍스트를 블록화하고,
 * 페이지 걸친 표 병합까지 담당한다.
 */

import type { IRBlock, IRTable, BoundingBox } from "../types.js"
import { safeMin, safeMax } from "../utils.js"
import { extractLines, preprocessLines, filterPageBorderLines, buildTableGrids, extractCells, mapTextToCells, cellTextToString, normalizeUndersegmentedTable, type TextItem, type TableGrid, type LineSegment } from "./line-detector.js"
import { detectClusterTables, type ClusterItem } from "./cluster-detector.js"
import { type NormItem, collapseEvenSpacing, computeBBox, dominantStyle, groupByY, mergeSuperscriptLines, mergeLineSimple } from "./text-line.js"
import { xyCutOrder } from "./xy-cut.js"
import { detectColumns, extractWithColumns } from "./columns.js"
import { shouldDemoteTable, demoteTableToText, detectListBlocks, detectSpecialKoreanTables } from "./block-detect.js"

/**
 * 선 기반 테이블 감지를 우선 시도, 실패 시 기존 휴리스틱 fallback.
 */
export function extractPageBlocksWithLines(
  items: NormItem[],
  pageNum: number,
  opList: { fnArray: Uint32Array | number[]; argsArray: unknown[][] },
  pageWidth: number,
  pageHeight: number,
): IRBlock[] {
  if (items.length === 0) return []

  // 1단계: PDF 그래픽 명령에서 선 추출
  let { horizontals, verticals } = extractLines(opList.fnArray, opList.argsArray)
  ;({ horizontals, verticals } = filterPageBorderLines(horizontals, verticals, pageWidth, pageHeight))

  // 1.5단계: 선 전처리 (ODL LinesPreprocessingConsumer 포팅)
  // 굵은 선 필터 + 근접 평행 선 병합
  ;({ horizontals, verticals } = preprocessLines(horizontals, verticals))

  // 1.7단계: 취소선 감지 — 텍스트 중심을 가로지르는 얇은 수평선 (ODL StrikethroughProcessor)
  markStrikethroughItems(items, horizontals)
  wrapStrikethroughRuns(items)

  // 2단계: 선으로 테이블 그리드 구성
  const grids = buildTableGrids(horizontals, verticals)

  if (grids.length > 0) {
    return extractBlocksWithGrids(items, pageNum, grids, horizontals, verticals)
  }

  // Fallback: 기존 휴리스틱 (선이 없는 PDF)
  return extractPageBlocksFallback(items, pageNum)
}

// ─── 취소선 감지 (ODL StrikethroughProcessor 포팅) ─────
// Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
// https://github.com/opendataloader-project/opendataloader-pdf

/** 취소선 최대 두께 (pt) — 굵은 선은 배경 채움/테두리 */
const STRIKE_MAX_THICKNESS = 2.0
/** 취소선 두께 / 텍스트 높이 최대 비율 */
const STRIKE_MAX_THICKNESS_RATIO = 0.25
/** 선 Y와 텍스트 중심 Y의 허용 오차 (텍스트 높이 비율) */
const STRIKE_CENTER_TOLERANCE = 0.25
/** 선이 텍스트를 덮어야 하는 최소 수평 비율 */
const STRIKE_MIN_OVERLAP_RATIO = 0.8
/** 선 폭 / 매칭 텍스트 총폭 최대 비율 — 표 구분선/배경선 오탐 방지 */
const STRIKE_MAX_LINE_TO_TEXT_RATIO = 1.5

/**
 * 텍스트 중심을 가로지르는 얇은 수평선을 찾아 해당 아이템에 strike 마킹.
 * 법령 개정문(신구조문대비표)의 삭제 표시 텍스트 보존용.
 */
function markStrikethroughItems(items: NormItem[], horizontals: LineSegment[]): void {
  if (items.length === 0 || horizontals.length === 0) return

  for (const line of horizontals) {
    if (line.lineWidth > STRIKE_MAX_THICKNESS) continue
    const matches: NormItem[] = []
    for (const item of items) {
      const h = item.h > 0 ? item.h : item.fontSize
      if (h <= 0 || item.w <= 0) continue
      if (line.lineWidth > h * STRIKE_MAX_THICKNESS_RATIO) continue
      // 글자 중심 근사: baseline(y) + 높이의 40% (한글 x-height 중앙)
      const centerY = item.y + h * 0.4
      if (Math.abs(line.y1 - centerY) > h * STRIKE_CENTER_TOLERANCE) continue
      const overlap = Math.min(line.x2, item.x + item.w) - Math.max(line.x1, item.x)
      if (overlap / item.w < STRIKE_MIN_OVERLAP_RATIO) continue
      matches.push(item)
    }
    if (matches.length === 0) continue
    // 선 폭이 매칭 텍스트 총폭의 1.5배 이내여야 취소선 (표 괘선 오탐 방지)
    let totalW = 0
    for (const m of matches) totalW += m.w
    if (totalW <= 0 || (line.x2 - line.x1) / totalW > STRIKE_MAX_LINE_TO_TEXT_RATIO) continue
    for (const m of matches) m.strike = true
  }
}

/**
 * strike 마킹된 연속 아이템 run을 ~~...~~ 마크다운으로 감싼다.
 * (같은 시각적 줄에서 인접한 마킹 아이템들을 하나의 run으로 묶음)
 */
function wrapStrikethroughRuns(items: NormItem[]): void {
  const struck = items.filter(i => i.strike)
  if (struck.length === 0) return

  // 줄 단위 그룹핑 (y ±3) 후 x 순 정렬
  const lines = new Map<number, NormItem[]>()
  for (const item of struck) {
    const key = Math.round(item.y / 3)
    const arr = lines.get(key) || []
    arr.push(item)
    lines.set(key, arr)
  }
  for (const arr of lines.values()) {
    arr.sort((a, b) => a.x - b.x)
    arr[0].text = "~~" + arr[0].text
    arr[arr.length - 1].text = arr[arr.length - 1].text + "~~"
  }
}

/**
 * 선 기반 그리드가 감지된 경우: 테이블 영역의 텍스트는 셀에 매핑,
 * 나머지는 일반 텍스트 블록으로 처리.
 */
function extractBlocksWithGrids(
  items: NormItem[],
  pageNum: number,
  grids: TableGrid[],
  horizontals: LineSegment[],
  verticals: LineSegment[],
): IRBlock[] {
  const blocks: IRBlock[] = []
  const usedItems = new Set<NormItem>()

  // 그리드를 Y좌표 내림차순 정렬 (위→아래)
  const sortedGrids = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)

  for (const grid of sortedGrids) {
    // 1행 다열 그리드는 테이블 헤더일 가능성 높음 → 스킵하여 클러스터 감지에 위임
    const numGridRows = grid.rowYs.length - 1
    const numGridCols = grid.colXs.length - 1
    if (numGridRows === 1 && numGridCols >= 2) continue
    // 1열 다행 그리드 (세로선 없는 표) → 스킵하여 클러스터 감지로 열 추론 위임
    // Why: 행 구분선만 있는 표는 builder.ts 의 1-col branch 에서 세로 일렬로 플래튼되어
    //      테이블 구조가 무너짐. 클러스터 기반 X좌표 정렬로 열을 복원할 기회 제공.
    if (numGridCols === 1 && numGridRows >= 2) continue

    // 그리드 영역 내 텍스트 아이템 수집
    const tableItems: NormItem[] = []
    const pad = 3
    const gridW = grid.bbox.x2 - grid.bbox.x1
    for (const item of items) {
      if (usedItems.has(item)) continue
      // Y 범위 체크
      if (item.y < grid.bbox.y1 - pad || item.y > grid.bbox.y2 + pad) continue
      // X 범위 체크 — 아이템의 시작과 끝이 모두 그리드 안에 있어야 함
      if (item.x < grid.bbox.x1 - pad || item.x + item.w > grid.bbox.x2 + pad) continue
      // 좁은 그리드(120px 미만)에서 큰 아이템이 경계에 걸치면 제외
      // 제목 텍스트가 인접 그리드에 잡히는 것을 방지
      if (gridW < 120 && item.x + item.w > grid.bbox.x2 - 2) continue
      tableItems.push(item)
      usedItems.add(item)
    }

    // 셀 추출
    const cells = extractCells(grid, horizontals, verticals)
    if (cells.length === 0) continue

    // 텍스트→셀 매핑 (hasSpaceBefore 전파 — 셀 텍스트 단어 공백 복원)
    const textItems: TextItem[] = tableItems.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
    }))
    const cellTextMap = mapTextToCells(textItems, cells)

    // IRTable 구성
    const numRows = grid.rowYs.length - 1
    const numCols = grid.colXs.length - 1
    const irGrid: import("../types.js").IRCell[][] = Array.from(
      { length: numRows },
      () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })),
    )

    for (const cell of cells) {
      const cellItems = cellTextMap.get(cell) || []
      let text = cellTextToString(cellItems)
      // 셀 안의 페이지 번호 표시 제거 ("- 2 -" 등)
      text = text.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim()
      // 셀 텍스트 균등배분 공백 제거 ("경 제 총 괄 반" → "경제총괄반")
      text = text.split("\n").map(line => collapseEvenSpacing(line)).join("\n")
      irGrid[cell.row][cell.col] = {
        text,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      }
    }

    // 과소분할 표 재구성 (ODL TableStructureNormalizer):
    // 행≤2 + 열≥3 + 셀 안에 텍스트 줄이 뭉친 표는 줄 centerY 기반 row band로 행 복원
    let finalGrid = irGrid
    let finalRows = numRows
    if (numRows <= 2 && numCols >= 3) {
      const rebuilt = normalizeUndersegmentedTable(irGrid, grid.colXs, textItems)
      if (rebuilt) {
        finalGrid = rebuilt.map(row => row.map(rawText => {
          const cleaned = rawText.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim()
          return {
            text: cleaned.split("\n").map(line => collapseEvenSpacing(line)).join("\n"),
            colSpan: 1,
            rowSpan: 1,
          }
        }))
        finalRows = finalGrid.length
      }
    }

    const irTable: IRTable = {
      rows: finalRows,
      cols: numCols,
      cells: finalGrid,
      hasHeader: finalRows > 1,
    }

    // 빈 테이블(모든 셀이 빈 문자열) 스킵
    const hasContent = finalGrid.some(row => row.some(cell => cell.text.trim() !== ""))
    if (!hasContent) continue

    const tableBbox: BoundingBox = {
      page: pageNum,
      x: grid.bbox.x1, y: grid.bbox.y1,
      width: grid.bbox.x2 - grid.bbox.x1, height: grid.bbox.y2 - grid.bbox.y1,
    }

    // 의사 테이블 필터: 텍스트성 내용 → paragraph로 복원 (구조 보존)
    if (shouldDemoteTable(irTable)) {
      const demoted = demoteTableToText(irTable)
      if (demoted) {
        // 텍스트 박스(1x1 또는 1행 그리드) demote 시 앞뒤 줄바꿈으로 본문과 분리
        const text = numGridRows === 1 ? "\n" + demoted + "\n" : demoted
        blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox: tableBbox, style: dominantStyle(tableItems) })
      }
      continue
    }

    blocks.push({ type: "table", table: irTable, pageNumber: pageNum, bbox: tableBbox })
  }

  // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
  let remaining = items.filter(i => !usedItems.has(i))
  if (remaining.length > 0) {
    remaining.sort((a, b) => b.y - a.y || a.x - b.x)

    // 클러스터 기반 테이블 감지 (XY-Cut 전에 실행 — 테이블이 쪼개지지 않도록)
    const clusterItems: ClusterItem[] = remaining.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
    }))
    const clusterResults = detectClusterTables(clusterItems, pageNum)
    if (clusterResults.length > 0) {
      const ciToIdx = new Map<ClusterItem, number>()
      for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci)
      const usedClusterIndices = new Set<number>()
      for (const cr of clusterResults) {
        for (const ci of cr.usedItems) {
          const idx = ciToIdx.get(ci)
          if (idx !== undefined) usedClusterIndices.add(idx)
        }
        blocks.push({ type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox })
      }
      remaining = remaining.filter((_, idx) => !usedClusterIndices.has(idx))
    }

    // XY-Cut으로 왼쪽 본문과 오른쪽 부서명 등을 분리 후 개별 처리
    if (remaining.length > 0) {
      const allY = remaining.map(i => i.y)
      const pageH = safeMax(allY) - safeMin(allY)
      const groups = xyCutOrder(remaining, Math.max(15, pageH * 0.03))
      const textBlocks: IRBlock[] = []
      for (const group of groups) {
        if (group.length === 0) continue
        const groupBlocks = extractPageBlocksFallback(group, pageNum)
        for (const b of groupBlocks) textBlocks.push(b)
      }
      const finalTextBlocks = detectListBlocks(textBlocks)
      for (const b of finalTextBlocks) blocks.push(b)
    }

    // Y좌표 기반 정렬
    blocks.sort((a, b) => {
      const ay = a.bbox ? (a.bbox.y + a.bbox.height) : 0
      const by = b.bbox ? (b.bbox.y + b.bbox.height) : 0
      return by - ay // PDF는 y가 위가 큼 → 내림차순
    })
    return mergeAdjacentTableBlocks(blocks)
  }

  return mergeAdjacentTableBlocks(blocks)
}

/**
 * 페이지 걸친 표 병합 — ODL TableBorderProcessor.checkNeighborTables 포팅.
 * Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
 *
 * 페이지 N의 마지막 표와 페이지 N+1의 첫 표가:
 *  - 블록 배열에서 인접 (사이에 본문 블록 없음 — 머리글/바닥글 제거 후 기준)
 *  - 열 수 동일
 *  - 좌우 경계 근접 (폭 대비 0.2 비율 이내, ODL NEIGHBOUR_TABLE_EPSILON)
 * 이면 한 표로 병합. 반복 헤더 행(첫 행 텍스트 동일)은 제거.
 */
const NEIGHBOR_TABLE_EPSILON = 0.2

export function mergeCrossPageTables(blocks: IRBlock[]): void {
  for (let i = blocks.length - 2; i >= 0; i--) {
    const prev = blocks[i]
    const curr = blocks[i + 1]
    if (prev.type !== "table" || curr.type !== "table" || !prev.table || !curr.table) continue
    if (!prev.pageNumber || !curr.pageNumber || curr.pageNumber !== prev.pageNumber + 1) continue
    if (prev.table.cols !== curr.table.cols) continue
    if (!prev.bbox || !curr.bbox) continue

    // 좌우 경계 근접 검증 (폭 대비 비율)
    const width = Math.max(prev.bbox.width, curr.bbox.width, 1)
    const leftDiff = Math.abs(prev.bbox.x - curr.bbox.x)
    const rightDiff = Math.abs((prev.bbox.x + prev.bbox.width) - (curr.bbox.x + curr.bbox.width))
    if (leftDiff > width * NEIGHBOR_TABLE_EPSILON || rightDiff > width * NEIGHBOR_TABLE_EPSILON) continue

    // 반복 헤더 행 제거: 다음 표 첫 행이 이전 표 첫 행과 동일하면 중복 헤더
    let currCells = curr.table.cells
    if (currCells.length > 1 && prev.table.cells.length > 0 &&
        rowTextsEqual(prev.table.cells[0], currCells[0])) {
      currCells = currCells.slice(1)
    }
    if (currCells.length === 0) {
      blocks.splice(i + 1, 1)
      continue
    }

    const merged: IRTable = {
      rows: prev.table.rows + currCells.length,
      cols: prev.table.cols,
      cells: [...prev.table.cells, ...currCells],
      hasHeader: prev.table.hasHeader,
      caption: prev.table.caption,
    }
    blocks[i] = { ...prev, table: merged }
    blocks.splice(i + 1, 1)
  }
}

/** 두 행의 셀 텍스트가 모두 동일한지 (공백 정규화 후 비교) */
function rowTextsEqual(a: import("../types.js").IRCell[], b: import("../types.js").IRCell[]): boolean {
  if (a.length !== b.length) return false
  const norm = (t: string) => t.replace(/\s+/g, "")
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i].text) !== norm(b[i].text)) return false
  }
  // 빈 행끼리의 비교는 의미 없음
  return a.some(c => c.text.trim() !== "")
}

/** 같은 열 수의 연속 테이블 블록을 하나로 합침 */
function mergeAdjacentTableBlocks(blocks: IRBlock[]): IRBlock[] {
  if (blocks.length <= 1) return blocks
  const result: IRBlock[] = [blocks[0]]
  for (let i = 1; i < blocks.length; i++) {
    const prev = result[result.length - 1]
    const curr = blocks[i]
    if (prev.type === "table" && curr.type === "table" && prev.table && curr.table &&
        prev.table.cols === curr.table.cols) {
      // 합치기: prev의 cells에 curr의 cells 추가
      const merged: IRTable = {
        rows: prev.table.rows + curr.table.rows,
        cols: prev.table.cols,
        cells: [...prev.table.cells, ...curr.table.cells],
        hasHeader: prev.table.hasHeader,
      }
      result[result.length - 1] = { ...prev, table: merged }
    } else {
      result.push(curr)
    }
  }
  return result
}

/**
 * 기존 휴리스틱 기반 페이지 블록 추출 (선이 없는 PDF 대비 fallback).
 */
export function extractPageBlocksFallback(items: NormItem[], pageNum: number): IRBlock[] {
  if (items.length === 0) return []

  const blocks: IRBlock[] = []

  // 1단계: 클러스터 기반 테이블 감지 우선 (헤더 감지 시 정확도 높음)
  const clusterItems: ClusterItem[] = items.map(i => ({
    text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
    fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
  }))
  const clusterResults = detectClusterTables(clusterItems, pageNum)

  if (clusterResults.length > 0) {
    const ciToIdx = new Map<ClusterItem, number>()
    for (let ci = 0; ci < clusterItems.length; ci++) ciToIdx.set(clusterItems[ci], ci)
    const usedIndices = new Set<number>()
    for (const cr of clusterResults) {
      for (const ci of cr.usedItems) {
        const idx = ciToIdx.get(ci)
        if (idx !== undefined) usedIndices.add(idx)
      }
      blocks.push({ type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox })
    }

    // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
    const remaining = items.filter((_, idx) => !usedIndices.has(idx))
    if (remaining.length > 0) {
      const yLines = mergeSuperscriptLines(groupByY(remaining))
      for (const line of yLines) {
        const text = mergeLineSimple(line)
        if (!text.trim()) continue
        const bbox = computeBBox(line, pageNum)
        blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) })
      }
    }

    blocks.sort((a, b) => {
      const ay = a.bbox ? (a.bbox.y + a.bbox.height) : 0
      const by = b.bbox ? (b.bbox.y + b.bbox.height) : 0
      return by - ay
    })
  } else {
    // 2단계: 레거시 컬럼 감지 (3+ 열)
    const allYLines = mergeSuperscriptLines(groupByY(items))
    const columns = detectColumns(allYLines)

    if (columns && columns.length >= 3) {
      const tableText = extractWithColumns(allYLines, columns)
      const bbox = computeBBox(items, pageNum)
      blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(items) })
    } else {
      // 3단계: XY-Cut으로 읽기 순서 결정
      const allY = items.map(i => i.y)
      const pageHeight = safeMax(allY) - safeMin(allY)
      const gapThreshold = Math.max(15, pageHeight * 0.03)

      const orderedGroups = xyCutOrder(items, gapThreshold)

      for (const group of orderedGroups) {
        if (group.length === 0) continue
        const yLines = mergeSuperscriptLines(groupByY(group))

        const groupColumns = detectColumns(yLines)
        if (groupColumns && groupColumns.length >= 3) {
          const tableText = extractWithColumns(yLines, groupColumns)
          const bbox = computeBBox(group, pageNum)
          blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(group) })
        } else {
          for (const line of yLines) {
            const text = mergeLineSimple(line)
            if (!text.trim()) continue
            const bbox = computeBBox(line, pageNum)
            blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) })
          }
        }
      }
    }
  }

  // 한국어 특수 테이블 감지 (구분/항목/종류 패턴)
  return detectSpecialKoreanTables(blocks)
}
