/**
 * 벡터 글머리 점 — 글머리를 글자가 아니라 채운 작은 원 경로로 그린 쪽(ODL 163: 지름 3pt 회색 원 + 줄 머리 글).
 * 텍스트층에 점이 없어 항목 줄이 꺾인 줄처럼 이어 붙는다("Check tidal … beforehand Stay within …").
 *
 * 원은 닫힌 부분 경로 하나(moveTo + 곡선 4개 이상 + closePath)를 채운 것, 지름 1.2~6pt·가로세로 차 15% 안. 색은 보지 않는다(어두운 바탕 흰 글 묶음은 점도 흰색이다).
 * 점 오른쪽 1.2em 안에 줄 머리 글(그 줄에서 점 바로 왼쪽 2em 안에 글이 없다)이 있고, 같은 x·같은 크기 점이 두 줄 이상일 때만
 * 그 줄 머리 글 앞에 "• " 를 붙인다 — 한 번 나온 점(장식·지도 표시)은 글머리 증거가 아니다.
 */

import { OPS } from "./ops.js"
import type { NormItem } from "./text-line.js"

interface Dot { x1: number; y1: number; x2: number; y2: number }

const mul = (m: number[], t: number[]) => [
  m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
]

/** 채운 작은 원 경로 (쪽 좌표) */
export function filledDots(fnArray: ArrayLike<number>, argsArray: unknown[][]): Dot[] {
  const dots: Dot[] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  const stack: number[][] = []
  let path: Dot | null = null
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i], args = argsArray[i]
    if (op === OPS.save) stack.push(ctm)
    else if (op === OPS.restore) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (op === OPS.paintFormXObjectBegin) {
      stack.push(ctm)
      const m = args?.[0]
      if (Array.isArray(m) && m.length >= 6) ctm = mul(ctm, m as number[])
    } else if (op === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0]
    else if (op === OPS.transform && Array.isArray(args) && args.length >= 6) ctm = mul(ctm, args as number[])
    else if (op === OPS.constructPath) {
      const [subOps, coords] = args as [number[], number[]]
      path = null
      if (!Array.isArray(subOps) || subOps.length < 6 || subOps[0] !== OPS.moveTo || subOps[subOps.length - 1] !== OPS.closePath ||
          subOps.slice(1, -1).some(s => s !== OPS.curveTo)) continue
      let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
      for (let k = 0; k + 1 < coords.length; k += 2) {
        const x = ctm[0] * coords[k] + ctm[2] * coords[k + 1] + ctm[4], y = ctm[1] * coords[k] + ctm[3] * coords[k + 1] + ctm[5]
        x1 = Math.min(x1, x); x2 = Math.max(x2, x); y1 = Math.min(y1, y); y2 = Math.max(y2, y)
      }
      path = { x1, y1, x2, y2 }
    } else if (op === OPS.fill || op === OPS.eoFill) {
      if (path) {
        const w = path.x2 - path.x1, h = path.y2 - path.y1
        if (w >= 1.2 && w <= 6 && h >= 1.2 && h <= 6 && Math.abs(w - h) <= Math.max(w, h) * 0.15) dots.push(path)
      }
      path = null
    }
  }
  return dots
}

/** 점이 있는 줄 머리 글에 "• " 를 붙인다. 붙인 수를 돌려준다 */
export function restoreVectorBullets(items: NormItem[], fnArray: ArrayLike<number>, argsArray: unknown[][]): number {
  const found: { dot: Dot; line: NormItem; lx: number }[] = []
  for (const dot of filledDots(fnArray, argsArray)) {
    const cy = (dot.y1 + dot.y2) / 2
    const line = items.filter(it => !it.isHidden && it.fontSize > 0 && it.text.trim() &&
      it.x >= dot.x2 && it.x - dot.x2 <= it.fontSize * 1.2 &&
      cy >= it.y - it.fontSize * 0.1 && cy <= it.y + it.fontSize * 0.7 &&
      dot.y2 - dot.y1 <= it.fontSize * 0.6)
      .sort((a, b) => a.x - b.x)[0]
    if (!line || !/^\p{L}/u.test(line.text.trim())) continue
    // 점 바로 왼쪽(2em 안)에 같은 줄 글이 있으면 줄 머리가 아니다 — 멀리 떨어진 왼쪽 단 글은 괜찮다
    if (items.some(it => it !== line && !it.isHidden && it.text.trim() && Math.abs(it.y - line.y) <= line.fontSize * 0.3 &&
        it.x < dot.x2 && it.x + it.w > dot.x1 - line.fontSize * 2)) continue
    found.push({ dot, line, lx: line.x })
  }
  let restored = 0
  const used = new Set<NormItem>()
  // 줄 x 는 붙이면서 바뀌니 처음 x(lx)로 견준다
  for (const f of found) {
    const w = f.dot.x2 - f.dot.x1
    const repeated = found.some(o => o !== f && o.line !== f.line && Math.abs(o.dot.x1 - f.dot.x1) <= 1 &&
      Math.abs(o.dot.x2 - o.dot.x1 - w) <= 0.5 && Math.abs(o.lx - f.lx) <= 1)
    if (!repeated || used.has(f.line)) continue
    used.add(f.line)
    // 따로 아이템으로 두면 점 열(8pt 틈)이 본문과 다른 단으로 갈린다 — 줄 머리 글 앞에 붙이고 상자를 점까지 넓힌다
    const line = f.line
    line.w += line.x - f.dot.x1
    line.x = f.dot.x1
    line.text = "• " + line.text
    line.fx = undefined; line.fw = undefined
    restored++
  }
  return restored
}
