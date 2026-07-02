/**
 * XY-Cut++ 읽기 순서 알고리즘 (arXiv:2504.10258)
 *
 * OpenDataLoader PDF의 XYCutPlusPlusSorter를 TypeScript로 포팅.
 * Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 *
 * 기존 XY-Cut 대비 개선 3종:
 *  ① cross-layout 전폭 요소(제목 등) 마스크 후 Y 위치로 재삽입
 *  ② 좁은 요소(쪽번호류) 아웃라이어 필터 후 수직 컷 재시도
 *  ③ 양방향(수평/수직) 컷을 모두 계산해 더 큰 갭 선택 + 최소 갭 5pt
 */

import type { NormItem } from "./text-line.js"

/** 재귀 깊이 제한 — 수천 아이템의 pathological 레이아웃에서 스택 오버플로 방지 */
const MAX_XYCUT_DEPTH = 50
/** 분할 최소 갭 (pt) — 미세 갭(1px급) 분할 방지 (ODL MIN_GAP_THRESHOLD) */
const XYCUT_MIN_GAP = 5
/** cross-layout 판정: 최대폭 대비 비율 (ODL beta) — ODL 기본값 2.0 (사실상 비활성) */
const CROSS_LAYOUT_BETA = 2.0
/** cross-layout 판정: 수평 겹침 비율 최소값 */
const CROSS_OVERLAP_RATIO = 0.1
/** cross-layout 판정: 최소 겹침 요소 수 */
const CROSS_MIN_OVERLAPS = 2
/** cross-layout 마스크 상한 — 전체의 20% 초과 마스크 시 비활성 (단일 컬럼 문서 보호) */
const CROSS_MAX_MASK_RATIO = 0.2
/** 좁은 요소 아웃라이어 필터: 영역 폭 대비 비율 (쪽번호·각주 마커) */
const NARROW_ELEMENT_WIDTH_RATIO = 0.1

interface CutInfo {
  position: number
  gap: number
}

export function xyCutOrder(items: NormItem[], gapThreshold: number, depth = 0): NormItem[][] {
  if (items.length === 0) return []
  if (items.length <= 2 || depth >= MAX_XYCUT_DEPTH) return [items]

  // Phase 1 (최상위에서만): cross-layout 전폭 요소 마스크
  if (depth === 0 && items.length >= 3) {
    const cross = identifyCrossLayoutItems(items)
    if (cross.size > 0 && cross.size <= items.length * CROSS_MAX_MASK_RATIO) {
      const rest = items.filter(i => !cross.has(i))
      if (rest.length > 0) {
        const groups = xyCutOrder(rest, gapThreshold, 1)
        return mergeCrossLayoutGroups(groups, [...cross])
      }
    }
  }

  // Phase 3: 양방향 컷 계산 → 더 큰 갭 선택 (기존: Y 무조건 우선 → 2단 인터리브)
  const minGap = Math.max(XYCUT_MIN_GAP, gapThreshold)
  const hCut = findHorizontalCut(items)
  const vCut = findVerticalCutWithOutlierFilter(items, minGap)

  const hValid = hCut.gap >= minGap
  const vValid = vCut.gap >= minGap

  // 축 선택: 기본 Y 우선 (한국 공문서는 단일 컬럼 위주 — 코퍼스 검증 결과 Y 우선이 안정적).
  // 단, 수직 갭이 수평 갭보다 명백히 크면(1.5×) 컬럼 분리로 보고 X 우선
  // → 2단 레이아웃에서 문단 간 수평 갭이 단 사이 수직 갭보다 먼저 잡혀 행 단위로
  //   인터리브되는 문제 방지 (XY-Cut++ 양방향 컷의 보수적 적용)
  let useHorizontal: boolean
  if (hValid && vValid) useHorizontal = vCut.gap <= hCut.gap * 1.5
  else if (hValid) useHorizontal = true
  else if (vValid) useHorizontal = false
  else return [items] // 분할 불가 → 리프 노드

  if (useHorizontal) {
    const upper = items.filter(i => i.y > hCut.position)
    const lower = items.filter(i => i.y <= hCut.position)
    if (upper.length > 0 && lower.length > 0 && upper.length < items.length) {
      return [...xyCutOrder(upper, gapThreshold, depth + 1), ...xyCutOrder(lower, gapThreshold, depth + 1)]
    }
  } else {
    const left = items.filter(i => i.x + i.w / 2 < vCut.position)
    const right = items.filter(i => i.x + i.w / 2 >= vCut.position)
    if (left.length > 0 && right.length > 0 && left.length < items.length) {
      return [...xyCutOrder(left, gapThreshold, depth + 1), ...xyCutOrder(right, gapThreshold, depth + 1)]
    }
  }

  return [items]
}

/**
 * cross-layout 요소 식별: 폭 ≥ beta×최대폭 + 다른 요소 2개 이상과 수평 겹침.
 * 전폭 제목/헤더가 컬럼 분할을 가로막는 것을 방지.
 */
function identifyCrossLayoutItems(items: NormItem[]): Set<NormItem> {
  const cross = new Set<NormItem>()
  if (items.length < 3) return cross

  let maxWidth = 0
  for (const i of items) { if (i.w > maxWidth) maxWidth = i.w }
  const threshold = CROSS_LAYOUT_BETA * maxWidth

  for (const item of items) {
    if (item.w < threshold) continue
    let overlaps = 0
    for (const other of items) {
      if (other === item) continue
      const left = Math.max(item.x, other.x)
      const right = Math.min(item.x + item.w, other.x + other.w)
      const overlapW = right - left
      if (overlapW <= 0) continue
      const smaller = Math.min(item.w, other.w)
      if (smaller > 0 && overlapW / smaller >= CROSS_OVERLAP_RATIO) {
        overlaps++
        if (overlaps >= CROSS_MIN_OVERLAPS) break
      }
    }
    if (overlaps >= CROSS_MIN_OVERLAPS) cross.add(item)
  }
  return cross
}

/** cross-layout 요소를 Y 위치 기준으로 그룹 시퀀스에 재삽입 (각자 단독 그룹) */
function mergeCrossLayoutGroups(groups: NormItem[][], cross: NormItem[]): NormItem[][] {
  if (cross.length === 0) return groups
  const sortedCross = [...cross].sort((a, b) => (b.y + b.h) - (a.y + a.h) || a.x - b.x)
  const groupTop = (g: NormItem[]) => {
    let top = -Infinity
    for (const i of g) { const t = i.y + i.h; if (t > top) top = t }
    return top
  }

  const result: NormItem[][] = []
  let gi = 0, ci = 0
  while (gi < groups.length || ci < sortedCross.length) {
    if (ci >= sortedCross.length) { result.push(groups[gi++]); continue }
    if (gi >= groups.length) { result.push([sortedCross[ci++]]); continue }
    const crossTop = sortedCross[ci].y + sortedCross[ci].h
    if (crossTop >= groupTop(groups[gi])) result.push([sortedCross[ci++]])
    else result.push(groups[gi++])
  }
  return result
}

/**
 * 수평 컷(Y축 분할) — Y 프로젝션에서 가장 넓은 갭.
 * 갭/분할점 계산은 기존 findYSplit과 동일 (y-h를 하단으로 보는 bbox 모델 유지 —
 * 코퍼스 검증 결과 모델 변경 시 행 분할점이 이동해 회귀 발생).
 */
function findHorizontalCut(items: NormItem[]): CutInfo {
  if (items.length < 2) return { position: 0, gap: 0 }
  const sorted = [...items].sort((a, b) => b.y - a.y)
  let largestGap = 0
  let position = 0

  for (let i = 1; i < sorted.length; i++) {
    const prevBottom = sorted[i - 1].y - sorted[i - 1].h
    const currTop = sorted[i].y
    const gap = prevBottom - currTop
    if (gap > largestGap) {
      largestGap = gap
      position = (prevBottom + currTop) / 2
    }
  }
  return { position, gap: largestGap }
}

/**
 * 수직 컷(X축 분할) — 갭이 안 나오면 좁은 요소(쪽번호류) 제외 후 재시도.
 * 쪽번호가 2단 컬럼 사이 갭을 가로막는 경우 복구 (ODL ②).
 */
function findVerticalCutWithOutlierFilter(items: NormItem[], minGap: number): CutInfo {
  const edgeCut = findVerticalCut(items)
  if (edgeCut.gap >= minGap) return edgeCut

  if (items.length >= 3) {
    let minX = Infinity, maxX = -Infinity
    for (const i of items) {
      if (i.x < minX) minX = i.x
      const r = i.x + i.w
      if (r > maxX) maxX = r
    }
    const narrowThreshold = (maxX - minX) * NARROW_ELEMENT_WIDTH_RATIO
    const filtered = items.filter(i => i.w >= narrowThreshold)
    // 아웃라이어는 소수여야 함 (쪽번호 1~2개) — 단어 단위 아이템이 대량 필터되면
    // 본문에서 가짜 컬럼 갭이 만들어지므로 70% 이상 유지될 때만 재시도
    if (filtered.length >= 2 && filtered.length < items.length && filtered.length >= items.length * 0.7) {
      const filteredCut = findVerticalCut(filtered)
      if (filteredCut.gap > edgeCut.gap && filteredCut.gap >= minGap) {
        return filteredCut
      }
    }
  }
  return edgeCut
}

/** 수직 컷 — X 프로젝션에서 가장 넓은 갭 */
function findVerticalCut(items: NormItem[]): CutInfo {
  if (items.length < 2) return { position: 0, gap: 0 }
  const sorted = [...items].sort((a, b) => a.x - b.x || (a.x + a.w) - (b.x + b.w))
  let largestGap = 0
  let position = 0
  let prevRight: number | null = null

  for (const it of sorted) {
    const left = it.x
    const right = it.x + it.w
    if (prevRight !== null && left > prevRight) {
      const gap = left - prevRight
      if (gap > largestGap) {
        largestGap = gap
        position = (prevRight + left) / 2
      }
    }
    prevRight = prevRight === null ? right : Math.max(prevRight, right)
  }
  return { position, gap: largestGap }
}
