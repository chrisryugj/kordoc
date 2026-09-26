/**
 * 열린 위·아래 변 표 닫기 (line-detector.ts 계열 전처리, closeOpenTableEdges 의 짝).
 *
 * 서구 보고서 표는 머리행 위 테두리와 합계행 아래 테두리를 긋지 않고, 열 구분 수직선만
 * 그 행까지 내려 긋는 스타일이 있다(ODL 047: 수평선이 데이터 행만 감싸고 머리 두 줄과
 * `Total` 행은 격자 밖). 격자가 데이터 행에서 끝나면 머리행과 합계행이 따로 가짜 표가 된다.
 *
 * 같은 끝점에 이른 수직선이 그 증거다. 끝점 정렬 괘선 묶음(표 몸통)의 맨 위·아래 괘선을
 * 지나 같은 y 까지 뻗은 내부 수직선이 둘 이상이면, 그 y 에 몸통 폭의 가상 괘선을 합성한다.
 * 선이 증거이므로 글 배치로 행을 흡수하지 않는다. 클립 격자는 이 경로를 거치지 않는다(clip-cells).
 */

import type { LineSegment } from "./line-types.js"
import { chainCollinearRules } from "./line-extract.js"

/** 끝점 정렬 괘선 묶음 허용 오차 (pt) — closeOpenTableEdges EDGE_ALIGN_TOL 과 같다 */
const ALIGN_TOL = 3
/** 몸통 최소 괘선 수 (2행 이상) */
const MIN_RULES = 3
/** 같은 논리 수직선으로 잇는 끊김 허용 (pt) — 셀마다 끊어 그은 세로 획 */
const V_CHAIN_GAP = 1.5
/** 같은 열 x 판정 (pt) */
const V_X_TOL = 1.5
/** 괘선에 닿음 판정 (pt) */
const TOUCH_TOL = 2
/** 몸통 밖으로 뻗은 최소 길이 (pt) — 괘선 교차 삐침 배제, 한 글줄 이상 */
const MIN_REACH = 8
/** 같은 끝점 판정 (pt) */
const END_TOL = 1.5
/** 같은 끝점에 이른 최소 내부 수직선 수 */
const MIN_REACHING = 2
/** 내부 수직선: 몸통 좌우 변에서 이만큼 안쪽 (table-grid MIN_COL_WIDTH) */
const INSET = 15

/** 같은 x 에서 끊어 그은 수직 획을 논리 수직선으로 잇는다 (입력 불변) */
function chainVerticals(verticals: LineSegment[]): LineSegment[] {
  const sorted = [...verticals].sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1)
  const out: LineSegment[] = []
  for (const v of sorted) {
    const prev = [...out].reverse().find(o => Math.abs(o.x1 - v.x1) <= V_X_TOL && v.y1 - o.y2 <= V_CHAIN_GAP && v.y2 >= o.y1)
    if (prev) { if (v.y2 > prev.y2) prev.y2 = v.y2; if (v.y1 < prev.y1) prev.y1 = v.y1 }
    else out.push({ ...v })
  }
  return out
}

/** 몸통 밖 끝점들 가운데 내부 수직선이 가장 많이 모인 끝점 (MIN_REACHING 미만이면 null) */
function commonEnd(ends: number[]): number | null {
  let best: number | null = null, bestN = 0
  for (const e of ends) {
    const n = ends.filter(o => Math.abs(o - e) <= END_TOL).length
    if (n > bestN || (n === bestN && best !== null && Math.abs(e) > Math.abs(best))) { best = e; bestN = n }
  }
  return bestN >= MIN_REACHING ? best : null
}

/**
 * 몸통 괘선 묶음의 위·아래로 같은 끝점까지 뻗은 내부 수직선이 둘 이상이면 그 끝점에 가상 수평 괘선을 더한다.
 * 조건 미달이면 입력을 그대로 반환한다.
 */
export function closeOpenTableEnds(horizontals: LineSegment[], verticals: LineSegment[]): LineSegment[] {
  if (horizontals.length < MIN_RULES || verticals.length < MIN_REACHING) return horizontals
  const groups: LineSegment[][] = []
  for (const rule of chainCollinearRules(horizontals)) {
    const g = groups.find(gr => Math.abs(gr[0].x1 - rule.x1) <= ALIGN_TOL && Math.abs(gr[0].x2 - rule.x2) <= ALIGN_TOL)
    if (g) g.push(rule)
    else groups.push([rule])
  }
  const chained = chainVerticals(verticals)
  const added: LineSegment[] = []
  for (const g of groups) {
    if (g.length < MIN_RULES) continue
    const x1 = Math.min(...g.map(r => r.x1)), x2 = Math.max(...g.map(r => r.x2))
    const yLo = Math.min(...g.map(r => r.y1)), yHi = Math.max(...g.map(r => r.y1))
    const interior = chained.filter(v => v.x1 > x1 + INSET && v.x1 < x2 - INSET && v.y1 <= yHi + TOUCH_TOL && v.y2 >= yLo - TOUCH_TOL)
    // 위: 맨 위 괘선에 닿아 위로 뻗은 수직선의 윗끝 / 아래: 맨 아래 괘선에 닿아 아래로 뻗은 수직선의 아랫끝
    const top = commonEnd(interior.filter(v => v.y1 <= yHi + TOUCH_TOL && v.y2 >= yHi + MIN_REACH).map(v => v.y2))
    const bottom = commonEnd(interior.filter(v => v.y2 >= yLo - TOUCH_TOL && v.y1 <= yLo - MIN_REACH).map(v => v.y1))
    for (const y of [top, bottom]) {
      if (y === null) continue
      // 그 높이에 이미 몸통 폭을 덮는 괘선이 있으면 닫힌 변이다
      if (horizontals.some(h => Math.abs(h.y1 - y) <= TOUCH_TOL && h.x1 <= x1 + INSET && h.x2 >= x2 - INSET)) continue
      added.push({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
    }
  }
  return added.length ? [...horizontals, ...added] : horizontals
}
