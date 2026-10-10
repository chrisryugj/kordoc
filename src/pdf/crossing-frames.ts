/**
 * 걸쳐 겹친 글상자 — 잡지식 쪽은 글상자 테두리를 서로 걸쳐 겹쳐 그린다(책 소개 쪽: 상자 다섯이 엇갈려 겹침). 선 격자 감지는 맞닿은 선을
 * 한 격자로 묶어 겹친 상자들을 9×4 표로 짰고, 줄 끝 낱말이 따로 열이 됐다(BookReview "정년은 | 짧아지고,"). 한 상자의 꼭짓점이 다른 상자
 * 안쪽에 들어가 있고 그 꼭짓점에서 두 변이 끝나면(선이 꼭짓점 밖으로 이어지지 않음) 걸친 상자다. 표 격자는 행 띠·열 띠가 겹쳐도 안쪽
 * 꼭짓점마다 선이 십자·T 로 지나가 끝나는 꼭짓점이 없다(ODL 078 행 띠 × 열 띠)
 */

import type { LineSegment, TableGrid } from "./line-types.js"

const TOL = 2

interface Rect { x1: number; x2: number; y1: number; y2: number }

const near = (a: number, b: number): boolean => Math.abs(a - b) <= TOL
const span = (a: number, b: number): [number, number] => (a <= b ? [a, b] : [b, a])

/** 위·아래 가로선이 같은 x 범위이고 그 양 끝을 세로선이 덮는 닫힌 사각형들 */
function closedRects(hs: LineSegment[], vs: LineSegment[]): Rect[] {
  const covers = (v: LineSegment, x: number, y1: number, y2: number): boolean => {
    const [lo, hi] = span(v.y1, v.y2)
    return near(v.x1, x) && lo <= y1 + TOL && hi >= y2 - TOL
  }
  const out: Rect[] = []
  for (let i = 0; i < hs.length; i++) {
    const [ax1, ax2] = span(hs[i].x1, hs[i].x2)
    for (let j = i + 1; j < hs.length; j++) {
      const [bx1, bx2] = span(hs[j].x1, hs[j].x2)
      if (!near(ax1, bx1) || !near(ax2, bx2) || near(hs[i].y1, hs[j].y1)) continue
      const y1 = Math.min(hs[i].y1, hs[j].y1), y2 = Math.max(hs[i].y1, hs[j].y1)
      if (!vs.some(v => covers(v, ax1, y1, y2)) || !vs.some(v => covers(v, ax2, y1, y2))) continue
      if (!out.some(o => near(o.x1, ax1) && near(o.x2, ax2) && near(o.y1, y1) && near(o.y2, y2))) out.push({ x1: ax1, x2: ax2, y1, y2 })
    }
  }
  return out
}

/** 꼭짓점 (x, y) 에서 두 변이 끝나나 — 사각형 밖 쪽(dx, dy 방향)으로 그 꼭짓점을 지나 이어지는 가로·세로선이 없다 */
function freeCorner(x: number, y: number, dx: number, dy: number, hs: LineSegment[], vs: LineSegment[]): boolean {
  const beyondX = x + dx * 3 * TOL, beyondY = y + dy * 3 * TOL
  const h = hs.some(l => { const [lo, hi] = span(l.x1, l.x2); return near(l.y1, y) && lo <= beyondX && hi >= beyondX })
  const v = vs.some(l => { const [lo, hi] = span(l.y1, l.y2); return near(l.x1, x) && lo <= beyondY && hi >= beyondY })
  return !h && !v
}

const strictlyInside = (x: number, y: number, r: Rect): boolean => x > r.x1 + TOL && x < r.x2 - TOL && y > r.y1 + TOL && y < r.y2 - TOL
const contains = (a: Rect, b: Rect): boolean => a.x1 <= b.x1 + TOL && a.x2 >= b.x2 - TOL && a.y1 <= b.y1 + TOL && a.y2 >= b.y2 - TOL

/** a 의 꼭짓점 가운데 b 안쪽에 들어가 두 변이 끝나는 것이 있나 */
function cornerIn(a: Rect, b: Rect, hs: LineSegment[], vs: LineSegment[]): boolean {
  for (const [x, dx] of [[a.x1, -1], [a.x2, 1]] as const) for (const [y, dy] of [[a.y1, -1], [a.y2, 1]] as const) {
    if (strictlyInside(x, y, b) && freeCorner(x, y, dx, dy, hs, vs)) return true
  }
  return false
}

/** 격자 선 가운데 서로 걸쳐 겹친 닫힌 사각형 쌍이 있나 */
export function hasCrossingFrames(grid: TableGrid, horizontals: LineSegment[], verticals: LineSegment[]): boolean {
  const b = grid.bbox
  const inside = (l: LineSegment): boolean => Math.min(l.x1, l.x2) >= b.x1 - TOL && Math.max(l.x1, l.x2) <= b.x2 + TOL &&
    Math.min(l.y1, l.y2) >= b.y1 - TOL && Math.max(l.y1, l.y2) <= b.y2 + TOL
  const hs = horizontals.filter(inside), vs = verticals.filter(inside)
  const rects = closedRects(hs, vs)
  for (let i = 0; i < rects.length; i++) for (let j = i + 1; j < rects.length; j++) {
    const a = rects[i], c = rects[j]
    // 한쪽이 다른 쪽을 통째로 품으면 중첩 상자다
    if (contains(a, c) || contains(c, a)) continue
    if (cornerIn(a, c, hs, vs) || cornerIn(c, a, hs, vs)) return true
  }
  return false
}
