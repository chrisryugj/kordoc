/**
 * 페이지 콘텐츠 추출 → IRBlock[] (v2: 바운딩 박스 + 페이지 번호)
 *
 * 선 기반 테이블 감지(line-detector) → 클러스터 감지(cluster-detector) →
 * XY-Cut 읽기 순서의 계층 fallback으로 페이지 텍스트를 블록화하고,
 * 페이지 걸친 표 병합까지 담당한다.
 */

import type { IRBlock, IRTable, BoundingBox } from "../types.js"
import { safeMin, safeMax } from "../utils.js"
import { extractLines, preprocessLines, filterPageBorderLines, closeOpenTableEdges, bridgeSplitColumnVerticals, buildTableGrids, extractCells, mapTextToCells, cellTextToString, normalizeUndersegmentedTable, type TextItem, type TableGrid, type LineSegment } from "./line-detector.js"
import { detectClusterTables, findTwoColumnProseCutX, type ClusterItem } from "./cluster-detector.js"
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
  // 굵은 선 필터 + 음영 스택 제거 + 근접 평행 선 병합
  ;({ horizontals, verticals } = preprocessLines(horizontals, verticals))

  // 1.6단계: 개방 변 표 테두리 합성 — 좌/우 바깥 테두리 생략 스타일(행정문서 관행)의
  // 가장자리 열 소실 방지. 내부 수직선이 실존하는 정렬 괘선 묶음에만 발동.
  verticals = closeOpenTableEdges(horizontals, verticals)

  // 1.65단계: 무괘선 요약행 밴드(예산서 재원구분 시/구 행 등)로 끊긴 동일 열
  // 수직선 브리지 — 표 파편화로 헤더행·부서/정책 요약행이 그리드에서 탈락하는 것 방지
  verticals = bridgeSplitColumnVerticals(horizontals, verticals)

  // 1.7단계: 취소선 감지 — 텍스트 중심을 가로지르는 얇은 수평선 (ODL StrikethroughProcessor)
  markStrikethroughItems(items, horizontals)
  wrapStrikethroughRuns(items)

  // 2단계: 선으로 테이블 그리드 구성
  const grids = buildTableGrids(horizontals, verticals)

  if (grids.length > 0) {
    return extractBlocksWithGrids(items, pageNum, grids, horizontals, verticals)
  }

  // Fallback: 기존 휴리스틱 (선이 없는 PDF)
  return extractPageBlocksFallback(items, pageNum, true)
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

// ─── 프로즈 박스 감지 (라벨탭 위 전폭 프로즈) ──────────
/** 내부 수직 구분선 없는 전폭 행이 표 높이에서 차지해야 할 최소 비율 (기하 신호) */
const PROSEBOX_FULLWIDTH_MIN = 0.6
/** 긴 프로즈 셀 판정 글자수 */
const PROSEBOX_LONG_CELL_CHARS = 80
/** 프로즈 박스 판정 최소 긴 셀 수 */
const PROSEBOX_LONG_CELL_MIN = 3
/** 긴 셀이 채운 셀에서 차지해야 할 최소 비율 (텍스트 신호) */
const PROSEBOX_LONG_CELL_RATIO = 0.4
/** 열 경계 부근 수직선 매칭 tolerance (pt) */
const PROSEBOX_X_TOL = 8

/** 열 경계 x 부근 수직선들이 [yMin,yMax]를 덮는 union 길이 (프로즈 박스 판정용) */
function verticalCoverageAt(verticals: LineSegment[], x: number, yMin: number, yMax: number): number {
  const tol = PROSEBOX_X_TOL
  const spans: Array<[number, number]> = []
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) > tol) continue
    const lo = Math.max(v.y1, yMin), hi = Math.min(v.y2, yMax)
    if (hi > lo) spans.push([lo, hi])
  }
  if (spans.length === 0) return 0
  spans.sort((a, b) => a[0] - b[0])
  let total = 0, s = spans[0][0], e = spans[0][1]
  for (let i = 1; i < spans.length; i++) {
    if (spans[i][0] <= e) { if (spans[i][1] > e) e = spans[i][1] }
    else { total += e - s; s = spans[i][0]; e = spans[i][1] }
  }
  return total + (e - s)
}

/**
 * 프로즈 박스 판정 — 상단 라벨탭(제목 칩)이 박스 테두리에 걸쳐 만든 가짜 열 위로
 * 본문이 전폭 프로즈로 흐르는 표(예: 검정고시 응시자격 박스). 셀 텍스트 조인(demote)은
 * 찢긴 조각을 그대로 이어 스크램블되므로, 이 표는 버리고 아이템을 프로즈 폴백(자연
 * 읽기순)으로 재추출한다. 판정은 두 신호의 교집합 —
 *   (a) 기하: 내부 수직 구분선 없는 전폭 행의 높이 합이 표 높이의 60%+
 *   (b) 텍스트: 80자+ 긴 셀이 3개+ 이고 채운 셀의 40%+
 * 기하만으론 다줄셀 정규표, 텍스트만으론 서술형 2열표(용어설명·Q&A)와 구분되지 않아
 * 둘 다 충족할 때만 발동한다.
 */
function isProseBoxGrid(grid: TableGrid, verticals: LineSegment[], table: IRTable): boolean {
  const numCols = grid.colXs.length - 1
  if (numCols < 2 || grid.rowYs.length < 3) return false

  const gyMax = grid.rowYs[0], gyMin = grid.rowYs[grid.rowYs.length - 1]
  const span = gyMax - gyMin
  if (span <= 0) return false
  const interior = grid.colXs.slice(1, -1)
  let fullWidthHeight = 0
  for (let r = 0; r < grid.rowYs.length - 1; r++) {
    const top = grid.rowYs[r], bot = grid.rowYs[r + 1]
    const h = top - bot
    if (h <= 0) continue
    // 내부 열 경계 어느 하나라도 이 행의 절반 이상을 덮는 수직선이 있으면 구분된 행
    const hasDivider = interior.some(cx => verticalCoverageAt(verticals, cx, bot, top) >= h * 0.5)
    if (!hasDivider) fullWidthHeight += h
  }
  if (fullWidthHeight < span * PROSEBOX_FULLWIDTH_MIN) return false

  const texts = table.cells.flat().map(c => c.text.trim()).filter(Boolean)
  const longCells = texts.filter(s => s.length > PROSEBOX_LONG_CELL_CHARS).length
  if (longCells < PROSEBOX_LONG_CELL_MIN || longCells < texts.length * PROSEBOX_LONG_CELL_RATIO) return false

  return true
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

    // 셀 미배정 아이템 수집 — mapTextToCells는 교차비율 > 0.3만 배정하므로,
    // 그리드 bbox 안에 있지만 어느 셀에도 못 붙은 아이템(세로쓰기 헤더 등)을
    // usedItems에 남겨두면 표에도 프로즈에도 없이 무음 소멸한다.
    const assignedItems = new Set<TextItem>()
    for (const arr of cellTextMap.values()) for (const it of arr) assignedItems.add(it)

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
    let rebuiltUsed = false
    if (numRows <= 2 && numCols >= 3) {
      const rebuilt = normalizeUndersegmentedTable(irGrid, grid.colXs, textItems)
      if (rebuilt) {
        rebuiltUsed = true
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

    // 미배정 아이템을 프로즈 경로로 환원 — 과소분할 재구축(rebuiltUsed)은
    // textItems 전체(미배정 포함)를 셀에 재배치하므로 그때는 환원하지 않는다(중복 방지)
    if (!rebuiltUsed) {
      for (let ti = 0; ti < textItems.length; ti++) {
        if (!assignedItems.has(textItems[ti])) usedItems.delete(tableItems[ti])
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

    // 프로즈 박스: 가짜 열 위로 전폭 프로즈가 흐르는 표 → 표를 버리고 아이템을
    // 프로즈 폴백으로 재추출 (셀 조인 demote는 찢긴 조각을 스크램블하므로 부적합)
    if (isProseBoxGrid(grid, verticals, irTable)) {
      for (const it of tableItems) usedItems.delete(it)
      continue
    }

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
    const groupSizes: number[] = []
    let finalTextBlocks: IRBlock[] = []
    if (remaining.length > 0) {
      const allY = remaining.map(i => i.y)
      const pageH = safeMax(allY) - safeMin(allY)
      const groups = xyCutOrder(remaining, Math.max(15, pageH * 0.03))
      const textBlocks: IRBlock[] = []
      for (const group of groups) {
        if (group.length === 0) continue
        const groupBlocks = extractPageBlocksFallback(group, pageNum)
        for (const b of groupBlocks) textBlocks.push(b)
        groupSizes.push(groupBlocks.length)
      }
      finalTextBlocks = detectListBlocks(textBlocks) // 1:1 변환 — 그룹 경계(groupSizes) 유지
    }

    // 그룹 단위 Y-정렬 — 블록 단위 Y-정렬은 XY-Cut이 정한 컬럼 읽기 순서(좌단
    // 전체 → 우단 전체)를 행 단위로 재인터리브하므로, XY-Cut 그룹을 한 단위로
    // 묶어 그룹 대표 Y(최상단)로만 정렬하고 그룹 내부 순서는 보존한다.
    // 표/demote 블록은 각자 단독 단위 (기존과 동일하게 Y 위치로 끼어듦).
    const units: IRBlock[][] = blocks.map(b => [b])
    let off = 0
    for (const size of groupSizes) {
      const unit = finalTextBlocks.slice(off, off + size)
      off += size
      if (unit.length > 0) units.push(unit)
    }
    const unitTopY = (u: IRBlock[]) => {
      let top = 0
      for (const b of u) {
        if (b.bbox && b.bbox.y + b.bbox.height > top) top = b.bbox.y + b.bbox.height
      }
      return top
    }
    units.sort((a, b) => unitTopY(b) - unitTopY(a)) // PDF는 y가 위가 큼 → 내림차순
    const ordered: IRBlock[] = []
    for (const u of units) for (const b of u) ordered.push(b)
    return mergeAdjacentTableBlocks(ordered)
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
 * 2단 조판 본문을 읽기 순서 그룹으로 분리 — 전폭 줄(제목·목차)의 y를 경계로
 * 세로 밴드를 나누고, 각 밴드에서 좌단 전체 → 우단 전체 순으로 배열한다.
 */
function splitTwoColumnProse(items: NormItem[], cutX: number): NormItem[][] {
  const left: NormItem[] = []
  const right: NormItem[] = []
  const cross: NormItem[] = []
  for (const i of items) {
    if (i.x + i.w <= cutX) left.push(i)
    else if (i.x >= cutX) right.push(i)
    else cross.push(i)
  }
  if (cross.length === 0) {
    return [left, right].filter(g => g.length > 0)
  }

  // 전폭 아이템을 y 근접(3pt)으로 경계 줄 묶음 (y 내림차순 = 위→아래)
  cross.sort((a, b) => b.y - a.y)
  const crossLines: NormItem[][] = []
  for (const c of cross) {
    const last = crossLines[crossLines.length - 1]
    if (last && Math.abs(last[0].y - c.y) <= 3) last.push(c)
    else crossLines.push([c])
  }
  // 경계 줄과 같은 y의 좌/우 아이템은 그 경계 줄에 편입 (목차 줄의 나란한 조각)
  const bandItem = (arr: NormItem[]) => arr.filter(i => {
    for (const cl of crossLines) {
      if (Math.abs(cl[0].y - i.y) <= 3) { cl.push(i); return false }
    }
    return true
  })
  const leftRest = bandItem(left)
  const rightRest = bandItem(right)

  // 밴드 k = 경계줄 k-1 아래 ~ 경계줄 k 위 (PDF y는 위가 큼)
  const boundYs = crossLines.map(cl => cl[0].y)
  const bandOf = (y: number) => {
    let k = 0
    while (k < boundYs.length && y < boundYs[k]) k++
    return k
  }
  const groups: NormItem[][] = []
  for (let k = 0; k <= crossLines.length; k++) {
    const L = leftRest.filter(i => bandOf(i.y) === k)
    const R = rightRest.filter(i => bandOf(i.y) === k)
    if (L.length > 0) groups.push(L)
    if (R.length > 0) groups.push(R)
    if (k < crossLines.length) groups.push(crossLines[k])
  }
  return groups
}

/**
 * 기존 휴리스틱 기반 페이지 블록 추출 (선이 없는 PDF 대비 fallback).
 *
 * fullPage: 페이지 전체 아이템으로 호출됐을 때만 true — 2단 조판 본문 감지는
 * 전체 지면 기준 신호라, XY-Cut 그룹(부분 집합) 재호출에서는 오발화하므로 끈다.
 */
export function extractPageBlocksFallback(items: NormItem[], pageNum: number, fullPage = false): IRBlock[] {
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
    // 2단 조판 본문(속기록류)은 들여쓰기 x-피크가 3+ 열로 오인돼 페이지 전체가
    // 행 인터리브 탭 텍스트로 뭉개진다 → 단 분리 경로에 위임
    const proseCutX = fullPage ? findTwoColumnProseCutX(items) : null
    const allYLines = mergeSuperscriptLines(groupByY(items))
    const columns = proseCutX !== null ? null : detectColumns(allYLines)

    if (columns && columns.length >= 3) {
      const tableText = extractWithColumns(allYLines, columns)
      const bbox = computeBBox(items, pageNum)
      blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(items) })
    } else {
      // 3단계: XY-Cut으로 읽기 순서 결정.
      // 2단 조판 본문은 전폭 제목/목차 줄이 X 프로젝션을 막아 XY-Cut이 단을 못
      // 가르는 경우가 있어(속기록 1면) 검출된 컷으로 직접 분리한다.
      const allY = items.map(i => i.y)
      const pageHeight = safeMax(allY) - safeMin(allY)
      const gapThreshold = Math.max(15, pageHeight * 0.03)

      const orderedGroups = proseCutX !== null
        ? splitTwoColumnProse(items, proseCutX)
        : xyCutOrder(items, gapThreshold)

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
