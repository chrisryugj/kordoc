/**
 * OCR 머리 칸의 L자 영역 — 오른쪽 머리 묶음 아래 가로선이 세로선 하나에서 시작하고 그 세로선이 그 가로선 아래로만 내려가면
 * (통계표 "2023 | 전년대비 / 구성비 | 증감 | 증감률"), 왼쪽 칸("2023")과 묶음 위 빈 자리가 한 L자 영역이 된다. 격자는 이를 직사각형으로
 * 쪼개며 왼쪽 칸을 두 행으로 갈랐다(1행은 두 열 걸친 빈 칸, "2023" 은 2행). 칸 경계를 글이 가로지를 수는 없으니, 가로선의 왼쪽
 * 연장선에 왼쪽 칸 글이 위아래로 걸쳐 있으면 세로선을 위 가로선까지 늘려 왼쪽 칸을 두 행에 걸친 한 칸으로 둔다(OCR 전용)
 */
import type { LineSegment } from "./line-types.js"

const TOL = 2

export function extendStraddledVerticals(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  items: Array<{ x: number; y: number; w: number; h: number }>,
): LineSegment[] {
  const lo = (l: LineSegment, k: "x" | "y") => Math.min(l[`${k}1`], l[`${k}2`]), hi = (l: LineSegment, k: "x" | "y") => Math.max(l[`${k}1`], l[`${k}2`])
  const out = verticals.slice()
  for (let i = 0; i < verticals.length; i++) {
    const v = verticals[i], top = hi(v, "y")
    // 세로선 위끝에서 오른쪽으로 뻗는 가로선
    const h = horizontals.find(o => Math.abs(o.y1 - top) <= TOL && Math.abs(lo(o, "x") - v.x1) <= TOL && hi(o, "x") > v.x1 + 10)
    if (!h) continue
    // 표 열 경계는 아래로 행 괘선 여럿을 가로지른다 — 조직도 연결선(web068)은 아니다
    if (horizontals.filter(o => o.y1 < top - TOL && o.y1 > lo(v, "y") - TOL && lo(o, "x") < v.x1 - TOL && hi(o, "x") > v.x1 + TOL).length < 2) continue
    const left = verticals.filter(o => o.x1 < v.x1 - TOL && lo(o, "y") <= top - TOL && hi(o, "y") >= top + TOL).sort((a, b) => b.x1 - a.x1)[0]
    if (!left || horizontals.some(o => Math.abs(o.y1 - top) <= TOL && lo(o, "x") <= left.x1 + TOL && hi(o, "x") >= v.x1 - TOL)) continue
    const above = horizontals.filter(o => o.y1 > top + TOL && lo(o, "x") <= left.x1 + TOL && hi(o, "x") >= hi(h, "x") - TOL).sort((a, b) => a.y1 - b.y1)[0]
    if (!above) continue
    // NormItem.y 는 아래 끝(쪽 아래가 0) — 글 키의 15% 넘게 위아래로 걸치고, 가로로는 왼쪽 칸 안에 다 들어야 한다
    // (세로선 위를 가로지르는 묶음 머리 "출생아 수" 는 두 열에 걸친 칸이다)
    const straddle = items.some(it =>
      it.x >= left.x1 - TOL && it.x + it.w <= v.x1 + TOL && it.y < top - it.h * 0.15 && it.y + it.h > top + it.h * 0.15)
    // 늘린 구간에 세로선 자리를 가로지르는 글(위 묶음 머리 "’23년 2/4분기")이 있으면 그 칸을 가르게 되니 늘리지 않는다
    const crossed = items.some(it => it.x < v.x1 - TOL && it.x + it.w > v.x1 + TOL && it.y + it.h > top + TOL && it.y < above.y1 - TOL)
    if (straddle && !crossed) out[i] = { ...v, y1: lo(v, "y"), y2: above.y1 }
  }
  return out
}
