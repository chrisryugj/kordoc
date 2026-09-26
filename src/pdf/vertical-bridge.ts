/**
 * 열 수직선 브리지 (line-detector.ts 계열 전처리).
 *
 * 예산서류 대형 표는 요약행 밴드(재원구분 시/구 행 등)에 수직 괘선을 아예
 * 긋지 않는 스타일이 있다. 이 무괘선 밴드에서 동일 열의 수직선이 위/아래로
 * 끊기면 Union-Find 그룹이 파편화되어 표 상단(헤더행·부서/정책 요약행)이
 * 그리드에서 탈락한다 — 세출예산 사업명세서 부서명 유실의 근본원인 (실측:
 * .claude/plans/budget-dept-merge-fix.md).
 *
 * 같은 열 x에서 끊긴 수직선 쌍을, 아래 조건을 모두 만족할 때만 잇는다:
 *  (a) 간격이 CONNECT_TOL 초과(이하면 이미 연결됨) ~ 상한 이내
 *  (b) 간격 내부에 그 x를 가로지르는 수평선이 실존 (내용 행 증거 —
 *      별개 표 사이 빈 공간에는 내부 수평선이 없다)
 *  (c) 같은 y-밴드에서 3열 이상이 동시에 끊김 (한 표의 열 구조 증거)
 *  (d) 밴드 내부 수평선의 끝점이 내부 열 경계와 정합 (셀 단위로 쪼개 그은
 *      행 괘선 증거 — 표 사이 단일 전폭 구분선/제목 밑줄 오탐 방지)
 *
 * 합성 세그먼트는 간격만이 아니라 위/아래 이웃 세그먼트 전체를 덮는다 —
 * cell-extract의 hasVerticalLine이 단일 세그먼트 75% 커버 기준이라, 간격만
 * 이으면 브리지·기존 세그먼트가 각각 병합 행 밴드의 75%에 못 미친다.
 */

import type { LineSegment } from "./line-types.js"
import { chainCollinearRules } from "./line-extract.js"

/** 같은 논리 수직선으로 묶는 x 허용 오차 (pt) — table-grid CUT_VCHAIN_X_TOL과 동일 */
const BRIDGE_X_TOL = 1.5
/** 브리지 최소 간격 (pt) — table-grid CONNECT_TOL 이하는 이미 같은 그룹 */
const BRIDGE_MIN_GAP = 5
/** 브리지 최대 간격 (pt) — 무괘선 밴드 상한 (실측 74.3pt, 여유 포함) */
const BRIDGE_MAX_GAP = 120
/** 후보 간 같은 y-밴드 판정 허용 오차 (pt) */
const BRIDGE_BAND_TOL = 6
/** 같은 밴드에서 동시에 끊긴 최소 열 수 */
const BRIDGE_MIN_COLUMNS = 3
/** 수평선 끝점-열 경계 정합 판정 허용 오차 (pt) */
const BRIDGE_ENDPOINT_TOL = 2
/** 밴드 내부 수평선 판정 여유 (pt) — 밴드 가장자리 선(그리드 경계선) 배제 */
const BRIDGE_EDGE_EPS = 2

interface BridgeCandidate {
  /** 열 x 좌표 (아래/위 세그먼트 x 평균) */
  x: number
  /** 간격 하단 (아래 세그먼트 상단 y) */
  lo: number
  /** 간격 상단 (위 세그먼트 하단 y) */
  hi: number
  /** 합성 범위 하단 (아래 세그먼트 하단 y) */
  spanLo: number
  /** 합성 범위 상단 (위 세그먼트 상단 y) */
  spanHi: number
  lineWidth: number
}

/**
 * 무괘선 밴드로 끊긴 동일 열 수직선을 합성 세그먼트로 잇는다.
 * 조건 미달이면 입력을 그대로 반환한다.
 */
export function bridgeSplitColumnVerticals(
  horizontals: LineSegment[],
  verticals: LineSegment[],
): LineSegment[] {
  if (verticals.length < 4 || horizontals.length === 0) return verticals

  // 1) x-밴드 그룹핑 후 각 밴드의 연속 세그먼트 쌍에서 간격 후보 수집
  const sorted = [...verticals].sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1)
  const candidates: BridgeCandidate[] = []
  let bandStart = 0
  const collectBand = (end: number) => {
    const band = sorted.slice(bandStart, end).sort((a, b) => a.y1 - b.y1)
    for (let i = 1; i < band.length; i++) {
      const lower = band[i - 1], upper = band[i]
      const gap = upper.y1 - lower.y2
      if (gap <= BRIDGE_MIN_GAP || gap > BRIDGE_MAX_GAP) continue
      const x = (lower.x1 + upper.x1) / 2
      // (b) 간격 내부에 이 x를 가로지르는 수평선 실존
      const hasInteriorH = horizontals.some(h =>
        h.y1 > lower.y2 + BRIDGE_EDGE_EPS && h.y1 < upper.y1 - BRIDGE_EDGE_EPS &&
        h.x1 <= x + BRIDGE_ENDPOINT_TOL && h.x2 >= x - BRIDGE_ENDPOINT_TOL)
      if (!hasInteriorH) continue
      candidates.push({
        x, lo: lower.y2, hi: upper.y1,
        spanLo: lower.y1, spanHi: upper.y2,
        lineWidth: Math.min(lower.lineWidth, upper.lineWidth),
      })
    }
  }
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].x1 - sorted[bandStart].x1 > BRIDGE_X_TOL) {
      collectBand(i)
      bandStart = i
    }
  }
  if (candidates.length < BRIDGE_MIN_COLUMNS) return verticals

  // 2) 같은 y-밴드 후보 클러스터링
  const clusters: BridgeCandidate[][] = []
  for (const c of candidates) {
    let placed = false
    for (const cl of clusters) {
      if (Math.abs(cl[0].lo - c.lo) <= BRIDGE_BAND_TOL && Math.abs(cl[0].hi - c.hi) <= BRIDGE_BAND_TOL) {
        cl.push(c)
        placed = true
        break
      }
    }
    if (!placed) clusters.push([c])
  }

  const synthesized: LineSegment[] = []
  for (const cl of clusters) {
    // (c) 3열 이상 동시 단절
    if (cl.length < BRIDGE_MIN_COLUMNS) continue

    // (d) 밴드 내부 수평선 끝점이 내부 열 경계와 정합 — 셀 단위 행 괘선 증거.
    //     최좌/최우 열은 표 외곽이라 단일 전폭 구분선 끝점과도 일치하므로 제외.
    const xs = cl.map(c => c.x).sort((a, b) => a - b)
    const interiorXs = xs.slice(1, -1)
    const bandLo = Math.min(...cl.map(c => c.lo))
    const bandHi = Math.max(...cl.map(c => c.hi))
    const segmented = horizontals.some(h =>
      h.y1 > bandLo + BRIDGE_EDGE_EPS && h.y1 < bandHi - BRIDGE_EDGE_EPS &&
      interiorXs.some(ix =>
        Math.abs(h.x1 - ix) <= BRIDGE_ENDPOINT_TOL || Math.abs(h.x2 - ix) <= BRIDGE_ENDPOINT_TOL))
    if (!segmented) continue

    for (const c of cl) {
      synthesized.push({ x1: c.x, y1: c.spanLo, x2: c.x, y2: c.spanHi, lineWidth: c.lineWidth })
    }
  }

  return synthesized.length ? [...verticals, ...synthesized] : verticals
}

/**
 * 한 행 높이만큼 끊긴 열 수직선 잇기 — 줄무늬 표의 흰 행처럼 세로선을 한 행씩 건너뛰어 그은 표(ODL 078).
 * 같은 높이에서 셋 이상의 열이 함께 끊기고, 그 틈 위·아래에 가로 괘선이 있으며(한 행), 틈 안 글이 끊긴 열 경계를
 * 가로지르지 않을 때만 잇는다. 병합 칸(글이 경계를 넘는 행)은 그대로 둔다.
 */
export function bridgeSkippedRowVerticals(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  items: Array<{ x: number; y: number; w: number; h: number; fontSize: number }>,
): LineSegment[] {
  if (verticals.length < 6 || items.length === 0) return verticals
  const byX = new Map<number, LineSegment[]>()
  for (const v of verticals) {
    const key = [...byX.keys()].find(k => Math.abs(k - v.x1) <= BRIDGE_X_TOL) ?? v.x1
    byX.set(key, [...(byX.get(key) ?? []), v])
  }
  const gaps: Array<{ x: number; lo: number; hi: number; spanLo: number; spanHi: number }> = []
  for (const [x, segs] of byX) {
    const s = [...segs].sort((a, b) => a.y1 - b.y1)
    for (let i = 1; i < s.length; i++) {
      const lo = s[i - 1].y2, hi = s[i].y1
      if (hi - lo > BRIDGE_MIN_GAP && hi - lo <= 40) gaps.push({ x, lo, hi, spanLo: s[i - 1].y1, spanHi: s[i].y2 })
    }
  }
  const rules = chainCollinearRules(horizontals)
  const added: LineSegment[] = []
  const done = new Set<typeof gaps[number]>()
  for (const g of gaps) {
    if (done.has(g)) continue
    const band = gaps.filter(o => Math.abs(o.lo - g.lo) <= BRIDGE_BAND_TOL / 3 && Math.abs(o.hi - g.hi) <= BRIDGE_BAND_TOL / 3)
    for (const o of band) done.add(o)
    if (band.length < BRIDGE_MIN_COLUMNS) continue
    const xs = band.map(o => o.x)
    const x1 = Math.min(...xs), x2 = Math.max(...xs)
    const ruled = (y: number) => rules.some(h => Math.abs(h.y1 - y) <= BRIDGE_ENDPOINT_TOL && h.x1 <= x1 + BRIDGE_ENDPOINT_TOL && h.x2 >= x2 - BRIDGE_ENDPOINT_TOL)
    if (!ruled(g.lo) || !ruled(g.hi)) continue
    const rowItems = items.filter(it => { const cy = it.y + (it.h || it.fontSize) / 2; return cy > g.lo && cy < g.hi })
    if (rowItems.length === 0 || rowItems.some(it => xs.some(x => it.x < x - 1 && it.x + it.w > x + 1))) continue
    for (const o of band) added.push({ x1: o.x, y1: o.spanLo, x2: o.x, y2: o.spanHi, lineWidth: 0.5 })
  }
  return added.length ? [...verticals, ...added] : verticals
}
