/**
 * 테이블 그리드에서 병합 셀 구조 추출 (line-detector.ts에서 분리).
 *
 * OpenDataLoader PDF의 createMatrix() 알고리즘을 참고하여 TypeScript로
 * clean-room 재구현한 것입니다.
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 */

import type { LineSegment, TableGrid, ExtractedCell } from "./line-types.js"
import { VERTEX_MERGE_FACTOR } from "./line-types.js"

// ─── 셀 구조 추출 (Vertex 기반 정밀 병합 셀 감지) ─────

/**
 * 테이블 그리드에서 셀 목록을 추출.
 * ODL의 createMatrix() 알고리즘:
 * - 수직선 존재 여부로 colSpan 감지 (75% 커버 기준)
 * - 수평선 존재 여부로 rowSpan 감지 (75% 커버 기준)
 * - 우하단→좌상단 propagation으로 병합 셀 정리
 * - 중복 행/열 제거
 */
export function extractCells(
  grid: TableGrid,
  horizontals: LineSegment[],
  verticals: LineSegment[],
): ExtractedCell[] {
  const { rowYs, colXs } = grid
  const numRows = rowYs.length - 1
  const numCols = colXs.length - 1
  if (numRows <= 0 || numCols <= 0) return []

  // 경계선 존재 여부를 행렬로 사전 계산
  // vKinds[r][c] = colXs[c]에 row r 구간의 수직선 — 0 없음, SOLID 선 하나가 덮음, PIECED 토막 합집합으로만 덮음
  const vKinds: number[][] = Array.from({ length: numRows },
    (_, r) => Array.from({ length: numCols + 1 },
      (_, c) => verticalLineKind(verticals, colXs[c], rowYs[r], rowYs[r + 1], grid.vertexRadius)))
  const vBorders: boolean[][] = vKinds.map(row => row.map(k => k !== NO_LINE))

  // hBorders[r][c] = rowYs[r]에 col c 구간의 수평선이 있는지
  const hBorders: boolean[][] = Array.from({ length: numRows + 1 },
    (_, r) => Array.from({ length: numCols },
      (_, c) => hasHorizontalLine(horizontals, rowYs[r], colXs[c], colXs[c + 1], grid.vertexRadius)))

  // 셀이 이미 병합된 셀에 포함되는지 추적
  const occupied = Array.from({ length: numRows }, () => Array(numCols).fill(false))
  const cells: ExtractedCell[] = []

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (occupied[r][c]) continue

      let colSpan = 1
      let rowSpan = 1

      // colSpan: 오른쪽 내부 경계에 수직선이 없으면 병합
      while (c + colSpan < numCols && !vBorders[r][c + colSpan]) {
        // 추가 검증: 확장하려는 영역의 모든 행에서 수직선이 없어야 함
        let canExpand = true
        for (let dr = 0; dr < rowSpan; dr++) {
          if (vBorders[r + dr][c + colSpan]) { canExpand = false; break }
        }
        if (!canExpand) break
        colSpan++
      }

      // rowSpan: 아래쪽 내부 경계에 수평선이 없으면 병합
      while (r + rowSpan < numRows) {
        let hasLine = false
        for (let dc = 0; dc < colSpan; dc++) {
          if (hBorders[r + rowSpan][c + dc]) { hasLine = true; break }
        }
        if (hasLine) break
        // 토막 합집합으로만 선 오른쪽 경계는 그 토막이 끊긴 아래 행까지 칸을 늘리지 않는다 — 위계 들여쓰기 선이 부모 행에서만 끊긴
        // 예산서(고흥 세출예산서: 좁은 위계 칸이 부모 행 "고흥역사·문화인물조사" 까지 내려가 글을 갈랐다)
        if (c + colSpan < numCols && vKinds[r][c + colSpan] === PIECED && !vBorders[r + rowSpan][c + colSpan]) break
        rowSpan++
      }

      // 병합 영역 마킹
      for (let dr = 0; dr < rowSpan; dr++) {
        for (let dc = 0; dc < colSpan; dc++) {
          occupied[r + dr][c + dc] = true
        }
      }

      cells.push({
        row: r, col: c, rowSpan, colSpan,
        bbox: {
          x1: colXs[c], y1: rowYs[r + rowSpan],
          x2: colXs[c + colSpan], y2: rowYs[r],
        },
      })
    }
  }

  return cells
}

/**
 * 특정 X 위치에 수직선이 Y 범위를 커버하는지 확인.
 * v2: 75% 커버 기준 + 동적 tolerance (vertex radius 기반)
 */
const NO_LINE = 0, SOLID = 1, PIECED = 2

function verticalLineKind(
  verticals: LineSegment[], x: number, topY: number, botY: number, vertexRadius: number,
): number {
  const tol = Math.max(VERTEX_MERGE_FACTOR * vertexRadius, 4)
  const cellH = Math.abs(topY - botY)
  if (cellH < 0.1) return NO_LINE
  const spans: Array<[number, number]> = []
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) <= tol) {
      const overlapTop = Math.min(v.y2, topY)
      const overlapBot = Math.max(v.y1, botY)
      // 75% 커버 기준 (기존 50% → 병합 셀 내부 단선 오탐 방지)
      if (overlapTop - overlapBot >= cellH * 0.75) return SOLID
      if (overlapTop > overlapBot) spans.push([overlapBot, overlapTop])
    }
  }
  // 줄마다 끊어 그린 괘선은 토막 하나가 75% 를 못 덮는다 — 같은 x 토막들의 합집합으로 잰다(예산서 상세 칸: 19pt 토막 30개, 금액이
  // 이름 칸에 몰려 다섯 칸이 한 칸이 됐다)
  return spans.length > 1 && unionLength(spans) >= cellH * 0.75 ? PIECED : NO_LINE
}

/** 끝이 맞닿아(0.5pt 안) 이어진 토막 줄기 가운데 토막 셋 이상인 가장 긴 것의 길이 — 줄마다 끊어 그은 괘선은 끝 좌표가 같고 토막이
 *  여럿이다. 따로 그린 상자 옆변들은 상자 사이가 떠 있고(벡터 개념도를 표로 읽던 KS X ISO 704), 긴 선을 두 토막으로 나눠 그은 것은 종전
 *  판정 그대로 둔다(성과지표 표의 칸 구조가 바뀌는데 그 표의 정답이 없어 판단을 보류) */
function unionLength(spans: Array<[number, number]>): number {
  spans.sort((a, b) => a[0] - b[0])
  let best = 0, [lo, hi] = spans[0], pieces = 1
  for (const [a, b] of spans.slice(1)) {
    if (a > hi + 0.5) { if (pieces >= 3) best = Math.max(best, hi - lo); lo = a; hi = b; pieces = 1 } else { hi = Math.max(hi, b); pieces++ }
  }
  return pieces >= 3 ? Math.max(best, hi - lo) : best
}

/**
 * 특정 Y 위치에 수평선이 X 범위를 커버하는지 확인.
 * v2: 75% 커버 기준 + 동적 tolerance
 */
function hasHorizontalLine(
  horizontals: LineSegment[], y: number, leftX: number, rightX: number, vertexRadius: number,
): boolean {
  const tol = Math.max(VERTEX_MERGE_FACTOR * vertexRadius, 4)
  for (const h of horizontals) {
    if (Math.abs(h.y1 - y) <= tol) {
      const cellW = Math.abs(rightX - leftX)
      if (cellW < 0.1) continue
      const overlapLeft = Math.max(h.x1, leftX)
      const overlapRight = Math.min(h.x2, rightX)
      const overlap = overlapRight - overlapLeft
      if (overlap >= cellW * 0.75) return true
    }
  }
  return false
}

