/**
 * PDF 그래픽 명령에서 수평/수직 선을 추출하고,
 * 선 교차점 기반으로 테이블 그리드를 구성하는 모듈.
 *
 * 이 파일의 테이블 감지 알고리즘은 OpenDataLoader PDF의
 * TableBorderBuilder를 참고하여 TypeScript로 재구현한 것입니다.
 *
 * Original work: Copyright 2025-2026 Hancom, Inc.
 * Licensed under the Apache License, Version 2.0
 * https://github.com/opendataloader-project/opendataloader-pdf
 *
 * Modifications: TypeScript 포팅, pdfjs-dist v4/v5 호환,
 * 한국어 PDF 특화 최적화 (문자 간격, 셀 텍스트 병합)
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"

// ─── pdfjs-dist v5 DrawOPS (v5에서 constructPath 형식 변경) ──
// v4: args = [subOps: number[], coords: number[], minMax]
//     subOps uses OPS.moveTo(13), OPS.lineTo(14), OPS.rectangle(19)
// v5: args = [afterOp: number, [pathData: object], minMax]
//     pathData is flat array using DrawOPS: moveTo=0, lineTo=1, curveTo=2, closePath=4
const enum DrawOPS {
  moveTo = 0,
  lineTo = 1,
  curveTo = 2,
  quadraticCurveTo = 3,
  closePath = 4,
}

// ─── 타입 ─────────────────────────────────────────────

export interface LineSegment {
  x1: number; y1: number
  x2: number; y2: number
  lineWidth: number
}

export interface TableGrid {
  /** 행 Y 좌표 경계 (위→아래 내림차순) */
  rowYs: number[]
  /** 열 X 좌표 경계 (좌→우 오름차순) */
  colXs: number[]
  /** 테이블 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

export interface ExtractedCell {
  row: number; col: number
  rowSpan: number; colSpan: number
  /** 셀 바운딩 박스 */
  bbox: { x1: number; y1: number; x2: number; y2: number }
}

// ─── 상수 ─────────────────────────────────────────────

/** 수평/수직 판별 허용 오차 (pt) */
const ORIENTATION_TOL = 2
/** 최소 선 길이 (너무 짧은 장식선 무시) */
const MIN_LINE_LENGTH = 10
/** 좌표 병합 tolerance — ODL: 4 * vertexRadius, 여기선 고정 3pt */
const COORD_MERGE_TOL = 3
/** 두 선이 같은 테이블에 속하는지 판별하는 거리 */
const CONNECT_TOL = 5
/** 셀 경계 내부 판별 여유 (텍스트 매핑용) */
const CELL_PADDING = 2
/** 최대 선 폭 — ODL MAX_LINE_WIDTH=5, 이보다 두꺼우면 장식/배경선으로 무시 */
const MAX_LINE_WIDTH = 5

// ─── CTM (Current Transformation Matrix) ─────────────
// 6요소 어파인 행렬 [a, b, c, d, e, f]
// | a c e |   x' = a*x + c*y + e
// | b d f |   y' = b*x + d*y + f
// | 0 0 1 |
type Matrix6 = [number, number, number, number, number, number]

const IDENTITY: Matrix6 = [1, 0, 0, 1, 0, 0]

function matMultiply(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ]
}

function matTransformPoint(m: Matrix6, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function matScale(m: Matrix6): number {
  // ODL: max(sqrt(b²+d²), sqrt(a²+c²))
  return Math.max(
    Math.sqrt(m[1] * m[1] + m[3] * m[3]),
    Math.sqrt(m[0] * m[0] + m[2] * m[2]),
  )
}

// ─── 선 추출 ──────────────────────────────────────────

/**
 * pdfjs operatorList에서 수평/수직 선을 추출.
 * CTM(Current Transformation Matrix) 추적, filled rectangle→선 변환,
 * lineTo 4개 시퀀스 사각형 감지를 포함.
 *
 * ODL/veraPDF의 ChunkParser.java 참고:
 * - CTM: save/restore 스택 + transform 연산
 * - 선 좌표를 CTM으로 변환하여 페이지 좌표계로 통일
 * - lineWidth도 CTM 스케일 적용
 */
export function extractLines(
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = []
  const verticals: LineSegment[] = []

  // ── Graphics State (CTM 포함) ──
  let ctm: Matrix6 = [...IDENTITY] as Matrix6
  let lineWidth = 1
  const stateStack: Array<{ ctm: Matrix6; lineWidth: number }> = []

  // 현재 path의 세그먼트를 수집 (user-space 좌표)
  let currentPath: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  let pathStartX = 0, pathStartY = 0
  let curX = 0, curY = 0

  /** 사각형을 선으로 변환 — 얇으면 단일 선, 두꺼우면 4변 */
  function pushRectangle(
    path: Array<{ x1: number; y1: number; x2: number; y2: number }>,
    rx: number, ry: number, rw: number, rh: number,
  ) {
    if (Math.abs(rh) < ORIENTATION_TOL * 2) {
      path.push({ x1: rx, y1: ry + rh / 2, x2: rx + rw, y2: ry + rh / 2 })
    } else if (Math.abs(rw) < ORIENTATION_TOL * 2) {
      path.push({ x1: rx + rw / 2, y1: ry, x2: rx + rw / 2, y2: ry + rh })
    } else {
      path.push(
        { x1: rx, y1: ry, x2: rx + rw, y2: ry },
        { x1: rx + rw, y1: ry, x2: rx + rw, y2: ry + rh },
        { x1: rx + rw, y1: ry + rh, x2: rx, y2: ry + rh },
        { x1: rx, y1: ry + rh, x2: rx, y2: ry },
      )
    }
  }

  /**
   * ODL parsingRectangleFromLines 포팅:
   * fill 시 4개 lineTo 시퀀스가 닫힌 사각형을 형성하면
   * 얇은 사각형 → 단일 선으로 변환
   */
  function tryConvertLinesToRectangle(
    path: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  ): boolean {
    if (path.length < 3 || path.length > 5) return false
    // 닫힌 사각형: 첫 세그먼트 시작 == 마지막 세그먼트 끝
    const first = path[0], last = path[path.length - 1]
    const closed = Math.abs(first.x1 - last.x2) < 1 && Math.abs(first.y1 - last.y2) < 1
    if (!closed) return false

    // 바운딩 박스 계산
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const seg of path) {
      minX = Math.min(minX, seg.x1, seg.x2)
      minY = Math.min(minY, seg.y1, seg.y2)
      maxX = Math.max(maxX, seg.x1, seg.x2)
      maxY = Math.max(maxY, seg.y1, seg.y2)
    }
    const w = maxX - minX, h = maxY - minY
    if (w < MIN_LINE_LENGTH && h < MIN_LINE_LENGTH) return false

    // 얇은 사각형 → 선으로 변환 (원본 path를 대체)
    path.length = 0
    if (h < ORIENTATION_TOL * 2 || (w > MIN_LINE_LENGTH && h <= MAX_LINE_WIDTH)) {
      path.push({ x1: minX, y1: (minY + maxY) / 2, x2: maxX, y2: (minY + maxY) / 2 })
    } else if (w < ORIENTATION_TOL * 2 || (h > MIN_LINE_LENGTH && w <= MAX_LINE_WIDTH)) {
      path.push({ x1: (minX + maxX) / 2, y1: minY, x2: (minX + maxX) / 2, y2: maxY })
    } else {
      // 두꺼운 사각형 → 4변 복원
      pushRectangle(path, minX, minY, w, h)
    }
    return true
  }

  /** path를 CTM 변환 후 선으로 분류 */
  function flushPath(isStroke: boolean, isFill: boolean) {
    if (!isStroke && !isFill) { currentPath = []; return }

    // fill 시 lineTo 시퀀스가 사각형을 형성하면 선으로 변환
    if (isFill && !isStroke && currentPath.length >= 3) {
      tryConvertLinesToRectangle(currentPath)
    }

    const scale = matScale(ctm)
    const effectiveLW = lineWidth * scale
    // MAX_LINE_WIDTH 필터: 장식/배경선 무시
    if (effectiveLW > MAX_LINE_WIDTH && isStroke && !isFill) {
      currentPath = []
      return
    }

    for (const seg of currentPath) {
      // CTM 적용: user-space → page-space
      const [px1, py1] = matTransformPoint(ctm, seg.x1, seg.y1)
      const [px2, py2] = matTransformPoint(ctm, seg.x2, seg.y2)
      classifyAndAdd(
        { x1: px1, y1: py1, x2: px2, y2: py2 },
        effectiveLW,
        horizontals,
        verticals,
      )
    }
    currentPath = []
  }

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    const args = argsArray[i]

    switch (op) {
      // ── Graphics State ──
      case OPS.save:
        stateStack.push({ ctm: [...ctm] as Matrix6, lineWidth })
        break

      case OPS.restore:
        if (stateStack.length > 0) {
          const state = stateStack.pop()!
          ctm = state.ctm
          lineWidth = state.lineWidth
        }
        break

      case OPS.transform: {
        const m = args as number[]
        if (m.length >= 6) {
          ctm = matMultiply(ctm, [m[0], m[1], m[2], m[3], m[4], m[5]])
        }
        break
      }

      case OPS.setLineWidth:
        lineWidth = (args as number[])[0] || 1
        break

      // ── Path Construction ──
      case OPS.constructPath: {
        const arg0 = args[0]

        if (Array.isArray(arg0)) {
          // ── pdfjs-dist v4 형식 ──
          const subOps = arg0 as number[]
          const coords = (args as [number[], number[]])[1]
          let ci = 0

          for (const subOp of subOps) {
            if (subOp === OPS.moveTo) {
              curX = coords[ci++]; curY = coords[ci++]
              pathStartX = curX; pathStartY = curY
            } else if (subOp === OPS.lineTo) {
              const x2 = coords[ci++], y2 = coords[ci++]
              currentPath.push({ x1: curX, y1: curY, x2, y2 })
              curX = x2; curY = y2
            } else if (subOp === OPS.rectangle) {
              const rx = coords[ci++], ry = coords[ci++]
              const rw = coords[ci++], rh = coords[ci++]
              pushRectangle(currentPath, rx, ry, rw, rh)
            } else if (subOp === OPS.closePath) {
              if (curX !== pathStartX || curY !== pathStartY) {
                currentPath.push({ x1: curX, y1: curY, x2: pathStartX, y2: pathStartY })
              }
              curX = pathStartX; curY = pathStartY
            } else if (subOp === OPS.curveTo) {
              ci += 6
            } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
              ci += 4
            }
          }
        } else {
          // ── pdfjs-dist v5 형식 ──
          const afterOp = arg0 as number
          const dataArr = args[1] as unknown[]
          const pathData = dataArr?.[0] as Record<number, number> | undefined
          if (pathData && typeof pathData === "object") {
            const len = Object.keys(pathData).length
            let di = 0
            while (di < len) {
              const drawOp = pathData[di++]
              if (drawOp === DrawOPS.moveTo) {
                curX = pathData[di++]; curY = pathData[di++]
                pathStartX = curX; pathStartY = curY
              } else if (drawOp === DrawOPS.lineTo) {
                const x2 = pathData[di++], y2 = pathData[di++]
                currentPath.push({ x1: curX, y1: curY, x2, y2 })
                curX = x2; curY = y2
              } else if (drawOp === DrawOPS.curveTo) {
                di += 6
              } else if (drawOp === DrawOPS.quadraticCurveTo) {
                di += 4
              } else if (drawOp === DrawOPS.closePath) {
                if (curX !== pathStartX || curY !== pathStartY) {
                  currentPath.push({ x1: curX, y1: curY, x2: pathStartX, y2: pathStartY })
                }
                curX = pathStartX; curY = pathStartY
              } else {
                break // unknown op
              }
            }
          }

          // v5: afterOp이 stroke/fill이면 즉시 flush
          const isStroke5 = afterOp === OPS.stroke || afterOp === OPS.closeStroke
          const isFill5 = afterOp === OPS.fill || afterOp === OPS.eoFill
          const isBoth5 = afterOp === OPS.fillStroke || afterOp === OPS.eoFillStroke ||
                          afterOp === OPS.closeFillStroke || afterOp === OPS.closeEOFillStroke
          if (isStroke5 || isFill5 || isBoth5) {
            flushPath(isStroke5 || isBoth5, isFill5 || isBoth5)
          } else if (afterOp === OPS.endPath) {
            flushPath(false, false)
          }
        }
        break
      }

      // ── Paint Operations ──
      case OPS.stroke:
      case OPS.closeStroke:
        flushPath(true, false)
        break

      case OPS.fill:
      case OPS.eoFill:
        flushPath(false, true)
        break

      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        flushPath(true, true)
        break

      case OPS.endPath:
        flushPath(false, false)
        break
    }
  }

  // 중복 선 제거: CTM 적용 후 동일 위치에 중복된 선 병합
  return {
    horizontals: deduplicateLines(horizontals),
    verticals: deduplicateLines(verticals),
  }
}

/** 동일 위치의 중복 선 제거 (CTM 적용 후 fill/stroke 중복 방지) */
function deduplicateLines(lines: LineSegment[]): LineSegment[] {
  if (lines.length <= 1) return lines
  const result: LineSegment[] = []
  const tol = COORD_MERGE_TOL

  for (const line of lines) {
    let isDuplicate = false
    for (const existing of result) {
      if (Math.abs(line.y1 - existing.y1) <= tol &&
          Math.abs(line.y2 - existing.y2) <= tol &&
          Math.abs(line.x1 - existing.x1) <= tol &&
          Math.abs(line.x2 - existing.x2) <= tol) {
        // 더 두꺼운 선 유지
        if (line.lineWidth > existing.lineWidth) {
          existing.lineWidth = line.lineWidth
        }
        isDuplicate = true
        break
      }
    }
    if (!isDuplicate) result.push(line)
  }
  return result
}

function classifyAndAdd(
  seg: { x1: number; y1: number; x2: number; y2: number },
  lineWidth: number,
  horizontals: LineSegment[],
  verticals: LineSegment[],
) {
  const dx = Math.abs(seg.x2 - seg.x1)
  const dy = Math.abs(seg.y2 - seg.y1)
  const length = Math.sqrt(dx * dx + dy * dy)

  if (length < MIN_LINE_LENGTH) return

  if (dy <= ORIENTATION_TOL) {
    // 수평선
    const y = (seg.y1 + seg.y2) / 2
    const x1 = Math.min(seg.x1, seg.x2)
    const x2 = Math.max(seg.x1, seg.x2)
    horizontals.push({ x1, y1: y, x2, y2: y, lineWidth })
  } else if (dx <= ORIENTATION_TOL) {
    // 수직선
    const x = (seg.x1 + seg.x2) / 2
    const y1 = Math.min(seg.y1, seg.y2)
    const y2 = Math.max(seg.y1, seg.y2)
    verticals.push({ x1: x, y1, x2: x, y2, lineWidth })
  }
  // 대각선은 무시 (테이블 경계가 아님)
}

// ─── 페이지 경계(클립) 선 필터링 ──────────────────────

/** 페이지 전체를 감싸는 클립 경계 선 제거 */
export function filterPageBorderLines(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  pageWidth: number,
  pageHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const margin = 5
  return {
    horizontals: horizontals.filter(l =>
      !(Math.abs(l.y1) < margin || Math.abs(l.y1 - pageHeight) < margin) ||
      (l.x2 - l.x1) < pageWidth * 0.9
    ),
    verticals: verticals.filter(l =>
      !(Math.abs(l.x1) < margin || Math.abs(l.x1 - pageWidth) < margin) ||
      (l.y2 - l.y1) < pageHeight * 0.9
    ),
  }
}

// ─── 테이블 그리드 구성 ────────────────────────────────

/**
 * 수평/수직 선에서 테이블 그리드를 추출.
 * 1. 교차하는 선들을 그룹화 (연결 컴포넌트)
 * 2. 각 그룹에서 X/Y 좌표를 클러스터링하여 그리드 구성
 */
export function buildTableGrids(
  horizontals: LineSegment[],
  verticals: LineSegment[],
): TableGrid[] {
  if (horizontals.length < 2 || verticals.length < 2) return []

  // 1. 선들을 교차 관계로 그룹화
  const allLines = [
    ...horizontals.map((l, i) => ({ ...l, type: "h" as const, id: i })),
    ...verticals.map((l, i) => ({ ...l, type: "v" as const, id: i + horizontals.length })),
  ]

  const groups = groupConnectedLines(allLines)

  const grids: TableGrid[] = []

  for (const group of groups) {
    const hLines = group.filter(l => l.type === "h")
    const vLines = group.filter(l => l.type === "v")

    // 최소 2개 수평 + 2개 수직 선이 있어야 테이블
    if (hLines.length < 2 || vLines.length < 2) continue

    // 2. Y 좌표 클러스터링 (수평선의 y 값)
    const rawYs = hLines.map(l => l.y1)
    const rowYs = clusterCoordinates(rawYs).sort((a, b) => b - a) // 위→아래 (PDF는 y가 위가 큼)

    // 3. X 좌표 클러스터링 (수직선의 x 값)
    const rawXs = vLines.map(l => l.x1)
    const colXs = clusterCoordinates(rawXs).sort((a, b) => a - b)

    // 최소 2행 2열
    if (rowYs.length < 2 || colXs.length < 2) continue

    // 그리드에 실제로 셀이 형성되는지 검증
    const bbox = {
      x1: colXs[0], y1: rowYs[rowYs.length - 1],
      x2: colXs[colXs.length - 1], y2: rowYs[0],
    }

    grids.push({ rowYs, colXs, bbox })
  }

  // 인접 그리드 병합: 같은 열 구조 + 수직으로 가까운 그리드 합치기
  return mergeAdjacentGrids(grids)
}

/** 같은 열 구조를 가진 인접 그리드를 병합 (테이블 분리 방지) */
function mergeAdjacentGrids(grids: TableGrid[]): TableGrid[] {
  if (grids.length <= 1) return grids
  // Y 좌표 기준 정렬 (위→아래 = y2 내림차순)
  const sorted = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)
  const merged: TableGrid[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = sorted[i]

    // 같은 열 수 + 열 위치가 비슷한지 확인
    if (prev.colXs.length === curr.colXs.length) {
      const colMatch = prev.colXs.every((x, ci) => Math.abs(x - curr.colXs[ci]) <= COORD_MERGE_TOL * 3)
      // 수직으로 인접 (갭 < 20pt ≈ 7mm)
      const verticalGap = prev.bbox.y1 - curr.bbox.y2
      if (colMatch && verticalGap >= -COORD_MERGE_TOL && verticalGap <= 20) {
        // 병합: rowYs 합치기 (중복 제거), bbox 확장
        const allRowYs = [...new Set([...prev.rowYs, ...curr.rowYs])].sort((a, b) => b - a)
        merged[merged.length - 1] = {
          rowYs: allRowYs,
          colXs: prev.colXs,
          bbox: {
            x1: Math.min(prev.bbox.x1, curr.bbox.x1),
            y1: Math.min(prev.bbox.y1, curr.bbox.y1),
            x2: Math.max(prev.bbox.x2, curr.bbox.x2),
            y2: Math.max(prev.bbox.y2, curr.bbox.y2),
          },
        }
        continue
      }
    }
    merged.push(curr)
  }
  return merged
}

/** 좌표값 클러스터링 — 가까운 값끼리 병합 */
function clusterCoordinates(values: number[]): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: { sum: number; count: number }[] = [{ sum: sorted[0], count: 1 }]

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1]
    const avg = last.sum / last.count
    if (Math.abs(sorted[i] - avg) <= COORD_MERGE_TOL) {
      last.sum += sorted[i]
      last.count++
    } else {
      clusters.push({ sum: sorted[i], count: 1 })
    }
  }

  return clusters.map(c => c.sum / c.count)
}

type TypedLine = LineSegment & { type: "h" | "v"; id: number }

/** 교차하는 선들을 Union-Find로 그룹화 */
function groupConnectedLines(lines: TypedLine[]): TypedLine[][] {
  const parent = lines.map((_, i) => i)

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // O(n²) 교차 검사 — 선 수가 수백 수준이므로 충분
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      if (linesIntersect(lines[i], lines[j])) {
        union(i, j)
      }
    }
  }

  const groups = new Map<number, TypedLine[]>()
  for (let i = 0; i < lines.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(lines[i])
  }

  return [...groups.values()]
}

/** 수평선과 수직선의 교차 판정 (tolerance 포함) */
function linesIntersect(a: TypedLine, b: TypedLine): boolean {
  // 같은 방향이면 교차 안 함 (평행)
  if (a.type === b.type) {
    // 같은 방향이라도 연결된 선일 수 있음 (끝점이 가까운 경우)
    if (a.type === "h") {
      if (Math.abs(a.y1 - b.y1) > CONNECT_TOL) return false
      // X 범위 겹침
      return Math.min(a.x2, b.x2) >= Math.max(a.x1, b.x1) - CONNECT_TOL
    } else {
      if (Math.abs(a.x1 - b.x1) > CONNECT_TOL) return false
      return Math.min(a.y2, b.y2) >= Math.max(a.y1, b.y1) - CONNECT_TOL
    }
  }

  // 수평 + 수직 교차
  const h = a.type === "h" ? a : b
  const v = a.type === "h" ? b : a
  const tol = CONNECT_TOL

  return (
    v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol &&
    h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol
  )
}

// ─── 셀 구조 추출 (colspan/rowspan 감지) ──────────────

/**
 * 테이블 그리드에서 셀 목록을 추출.
 * 수평/수직 선의 존재 여부로 셀 병합(colspan/rowspan)을 감지.
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

  // 셀이 이미 병합된 셀에 포함되는지 추적
  const occupied = Array.from({ length: numRows }, () => Array(numCols).fill(false))
  const cells: ExtractedCell[] = []

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (occupied[r][c]) continue

      // 이 셀에서 오른쪽/아래로 병합 가능한 범위 찾기
      let colSpan = 1
      let rowSpan = 1

      // colSpan: 오른쪽 경계에 수직선이 없으면 병합
      while (c + colSpan < numCols) {
        const borderX = colXs[c + colSpan]
        const topY = rowYs[r]
        const botY = rowYs[r + 1]
        if (hasVerticalLine(verticals, borderX, topY, botY)) break
        colSpan++
      }

      // rowSpan: 아래쪽 경계에 수평선이 없으면 병합
      while (r + rowSpan < numRows) {
        const borderY = rowYs[r + rowSpan]
        const leftX = colXs[c]
        const rightX = colXs[c + colSpan]
        if (hasHorizontalLine(horizontals, borderY, leftX, rightX)) break
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

/** 특정 X 위치에 수직선이 Y 범위를 커버하는지 확인 */
function hasVerticalLine(verticals: LineSegment[], x: number, topY: number, botY: number): boolean {
  const tol = COORD_MERGE_TOL + 1
  for (const v of verticals) {
    if (Math.abs(v.x1 - x) <= tol) {
      // 선의 Y 범위가 셀 경계의 상당 부분(50%)을 커버하는지
      const cellH = Math.abs(topY - botY)
      const overlapTop = Math.min(v.y2, topY)
      const overlapBot = Math.max(v.y1, botY)
      const overlap = overlapTop - overlapBot
      if (overlap >= cellH * 0.5) return true
    }
  }
  return false
}

/** 특정 Y 위치에 수평선이 X 범위를 커버하는지 확인 */
function hasHorizontalLine(horizontals: LineSegment[], y: number, leftX: number, rightX: number): boolean {
  const tol = COORD_MERGE_TOL + 1
  for (const h of horizontals) {
    if (Math.abs(h.y1 - y) <= tol) {
      const cellW = Math.abs(rightX - leftX)
      const overlapLeft = Math.max(h.x1, leftX)
      const overlapRight = Math.min(h.x2, rightX)
      const overlap = overlapRight - overlapLeft
      if (overlap >= cellW * 0.5) return true
    }
  }
  return false
}

// ─── 텍스트→셀 매핑 ──────────────────────────────────

export interface TextItem {
  text: string
  x: number; y: number; w: number; h: number
  fontSize: number; fontName: string
}

/**
 * 텍스트 아이템을 셀에 매핑.
 * 각 텍스트의 중심점이 어떤 셀의 bbox 안에 있는지로 판별.
 */
export function mapTextToCells(
  items: TextItem[],
  cells: ExtractedCell[],
): Map<ExtractedCell, TextItem[]> {
  const result = new Map<ExtractedCell, TextItem[]>()
  for (const cell of cells) {
    result.set(cell, [])
  }

  for (const item of items) {
    const cx = item.x + item.w / 2
    const cy = item.y
    const pad = CELL_PADDING

    let bestCell: ExtractedCell | null = null
    let bestDist = Infinity

    for (const cell of cells) {
      // 중심점이 셀 bbox 안에 있는지 (패딩 포함)
      if (cx >= cell.bbox.x1 - pad && cx <= cell.bbox.x2 + pad &&
          cy >= cell.bbox.y1 - pad && cy <= cell.bbox.y2 + pad) {
        // 여러 셀에 해당하면 가장 가까운 셀 중심에 배정
        const cellCx = (cell.bbox.x1 + cell.bbox.x2) / 2
        const cellCy = (cell.bbox.y1 + cell.bbox.y2) / 2
        const dist = Math.abs(cx - cellCx) + Math.abs(cy - cellCy)
        if (dist < bestDist) {
          bestDist = dist
          bestCell = cell
        }
      }
    }

    if (bestCell) {
      result.get(bestCell)!.push(item)
    }
  }

  return result
}

/**
 * 셀 내 텍스트 아이템을 읽기 순서로 정렬 후 합치기.
 * Y 내림차순 (위→아래) → X 오름차순 (좌→우)
 */
export function cellTextToString(items: TextItem[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0].text

  // Y좌표로 행 그룹핑 (tolerance: max(3, fontSize*0.6))
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: TextItem[][] = []
  let curLine: TextItem[] = [sorted[0]]
  let curY = sorted[0].y

  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, curLine[0].fontSize) * 0.6)
    if (Math.abs(sorted[i].y - curY) <= tol) {
      curLine.push(sorted[i])
    } else {
      lines.push(curLine)
      curLine = [sorted[i]]
      curY = sorted[i].y
    }
  }
  lines.push(curLine)

  // 각 행을 텍스트로 변환 — 한글 간 작은 갭은 공백 없이 붙임
  const textLines = lines.map(line => {
    const s = line.sort((a, b) => a.x - b.x)
    if (s.length === 1) return s[0].text
    let result = s[0].text
    for (let j = 1; j < s.length; j++) {
      const gap = s[j].x - (s[j - 1].x + s[j - 1].w)
      const avgFs = (s[j].fontSize + s[j - 1].fontSize) / 2
      // 한글 관련 문자 전환 시 작은 갭 → 공백 없이 붙임
      // (한글-한글, ASCII→한글, 한글→ASCII 모두 포함)
      const prevIsKorean = /[가-힣]$/.test(result)
      const currIsKorean = /^[가-힣]/.test(s[j].text)
      if (gap < avgFs * 0.15) {
        // 매우 작은 갭 — 모든 문자 타입에서 공백 없이 붙임
        result += s[j].text
      } else if (gap < avgFs * 0.35 && (prevIsKorean || currIsKorean)) {
        // 한글 관련 작은 갭 — PDF 문자 개별 배치 잔재
        result += s[j].text
      } else {
        result += " " + s[j].text
      }
    }
    return result
  })

  // 셀 내 줄바꿈 병합 — 잘린 단어/숫자 조각 복구
  if (textLines.length <= 1) return textLines[0] || ""
  const merged: string[] = [textLines[0]]
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = textLines[i]
    // 짧은 순수 한글 (8자 이하) = 잘린 단어 조각
    if (/[가-힣]$/.test(prev) && /^[가-힣]+$/.test(curr) && curr.length <= 8 && !curr.includes(" ")) {
      merged[merged.length - 1] = prev + curr
    }
    // 닫는 괄호/기호 포함 짧은 줄 (3자 이하) = 이전 줄에 붙임 (예: ")", "%)", "%) 별도")
    else if (curr.trim().length <= 3 && /^[)\]%}]/.test(curr.trim())) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    // 이전 줄이 여는 괄호나 쉼표로 끝남 = 다음 줄 붙임 (예: "(x15,232,700," + "000)")
    else if (/[,(]$/.test(prev.trim()) && curr.trim().length <= 15) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    // 숫자 줄바꿈 복구: 이전 줄이 숫자/쉼표로 끝나고 다음 줄이 숫자로 시작하는 짧은 조각
    else if (/[\d,]$/.test(prev) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else {
      merged.push(curr)
    }
  }
  return merged.join("\n")
}
