/**
 * 쪽 지면 영역 분리 (page-blocks.ts에서 분리) — 두 단 본문 밴드, 두 단 위 표 밴드, 3단 머리 표,
 * 겹쳐 쌓인 캡션 표 밴드, 카드·인포그래픽 3열 영역. 표 감지 전에 읽기 영역을 먼저 나눈다.
 */

import type { IRBlock, IRCell } from "../types.js"
import { detectClusterTables } from "./cluster-detector.js"
import { type NormItem, computeBBox, groupByY, mergeLineSimple } from "./text-line.js"
import { type ColRect } from "./two-column.js"

/**
 * 2단 조판 본문을 읽기 순서 그룹으로 분리 — 전폭 줄(제목·목차)의 y를 경계로
 * 세로 밴드를 나누고, 각 밴드에서 좌단 전체 → 우단 전체 순으로 배열한다.
 */
export function splitTwoColumnProse(items: NormItem[], cutX: number): NormItem[][] {
  const left: NormItem[] = []
  const right: NormItem[] = []
  const cross: NormItem[] = []
  for (const i of items) {
    if (i.x + i.w <= cutX) left.push(i)
    else if (i.x >= cutX) right.push(i)
    else cross.push(i)
  }
  if (cross.length === 0) return columnPair(left, right)

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
    groups.push(...columnPair(L, R))
    if (k < crossLines.length) groups.push(crossLines[k])
  }
  return groups
}

/** 각주 번호로 시작하는 줄 — "34 Richard…"·"* …". "1. Lee…" 같은 목록 번호(참고문헌)는 흐름 안의 글이다 */
const NOTE_START = /^\s*(?:\d{1,3}\s|[*†‡§¹²³⁴⁵⁶⁷⁸⁹])/

function medianOf(values: number[]): number {
  const s = values.filter(v => v > 0).sort((a, b) => a - b)
  return s.length ? s[s.length >> 1] : 0
}

/**
 * 한 밴드의 좌·우 단 읽기 순서. 기본은 좌단 전체 → 우단 전체이되,
 * - 두 단 맨 위 같은 높이의 짧은 줄(쪽번호·머리말)은 먼저,
 * - 한 단에만 있고 다른 단 첫 줄보다 위에 큰 틈으로 떨어진 짧은 줄(그림 옆 캡션)은 두 단보다 먼저,
 * - 단 아래쪽 본문보다 작은 글자로 이어지는 각주(번호 줄 포함)는 두 단 본문 뒤에 좌 → 우로 낸다.
 */
function columnPair(left: NormItem[], right: NormItem[]): NormItem[][] {
  if (left.length === 0 || right.length === 0) return [left, right].filter(g => g.length > 0)
  const byLine = (side: NormItem[]) => groupByY([...side].sort((a, b) => b.y - a.y || a.x - b.x))
  let L = byLine(left), R = byLine(right)
  const out: NormItem[][] = []
  const pitch = (lines: NormItem[][]) => medianOf(lines.slice(1).map((l, i) => lines[i][0].y - l[0].y))
  const fs = medianOf([...left, ...right].map(i => i.fontSize)) || 10
  // 두 단 맨 위 같은 높이 줄 — 아래로 큰 틈이 있으면 쪽 머리
  if (L.length > 1 && R.length > 1 && Math.abs(L[0][0].y - R[0][0].y) <= 2 &&
      L[0][0].y - L[1][0].y >= fs * 2 && R[0][0].y - R[1][0].y >= fs * 2) {
    out.push([...L[0], ...R[0]])
    L = L.slice(1); R = R.slice(1)
  }
  // 다른 단보다 위에 떨어진 머리 띠
  const lift = (A: NormItem[][], B: NormItem[][]): number => {
    if (A.length < 2 || B.length === 0) return 0
    let n = 0
    while (n < A.length && A[n][0].y > B[0][0].y + 2) n++
    // 캡션급 짧은 띠만 — 단 본문 전체가 각주 위에 떨어져 있는 경우(ODL 013)는 머리 띠가 아니다
    if (n === 0 || n >= A.length || n > 6 || n * 2 >= A.length) return 0
    return A[n - 1][0].y - A[n][0].y >= Math.max(pitch(A.slice(n)) * 1.8, fs * 2) ? n : 0
  }
  const nR = lift(R, L), nL = nR ? 0 : lift(L, R)
  if (nR) { out.push(R.slice(0, nR).flat()); R = R.slice(nR) }
  if (nL) { out.push(L.slice(0, nL).flat()); L = L.slice(nL) }
  // 각주 띠 — 아래에서부터 본문보다 작은 글자 줄
  const notes = (lines: NormItem[][]): number => {
    // 본문 크기는 줄의 25% 이상을 차지하는 가장 큰 글자 크기 — 각주 줄이 본문보다 많은 단은 중앙값이 각주 크기가 되고,
    // 단 맨 위가 작은 캡션인 단(ODL 008 우단)은 첫 줄이 본문이 아니다
    const sizes = lines.map(l => Math.max(...l.map(i => i.fontSize)))
    const body = Math.max(0, ...sizes.filter(s => sizes.filter(o => Math.abs(o - s) < 0.5).length >= lines.length * 0.25))
    let n = 0
    while (n < lines.length && Math.max(...lines[lines.length - 1 - n].map(i => i.fontSize)) <= body * 0.9) n++
    if (n === 0 || lines.length - n < 3) return 0
    const tail = lines.slice(lines.length - n)
    return tail.some(l => NOTE_START.test(mergeLineSimple(l))) ? n : 0
  }
  const kL = notes(L), kR = notes(R)
  if (kL === 0 && kR === 0) return [...out, L.flat(), R.flat()].filter(g => g.length > 0)
  return [...out, L.slice(0, L.length - kL).flat(), R.slice(0, R.length - kR).flat(),
    L.slice(L.length - kL).flat(), R.slice(R.length - kR).flat()].filter(g => g.length > 0)
}

/** Keep a compact multi-column table above two-column prose in its own band. */
export function topTableBand(items: NormItem[]): { top: NormItem[]; rest: NormItem[] } | null {
  const lines = groupByY(items)
  if (lines.length < 12) return null
  for (let n = 4; n < Math.min(lines.length - 5, 16); n++) {
    const upper = lines.slice(0, n)
    if (upper.filter(line => line.length >= 3).length < 3) continue
    const gap = upper[n - 1][0].y - lines[n][0].y
    const sizes = upper.flat().map(i => i.fontSize).filter(size => size > 0).sort((a, b) => a - b)
    if (gap < Math.max(18, (sizes[Math.floor(sizes.length / 2)] ?? 10) * 1.8)) continue
    const top = upper.flat()
    const candidate = detectClusterTables(top.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName, hasSpaceBefore: i.hasSpaceBefore,
    })), 1)
    if (!candidate.some(t => t.table.cols >= 3 && t.table.rows >= 3 && t.usedItems.size >= top.length * 0.75)) continue
    return { top, rest: lines.slice(n).flat() }
  }
  return null
}

/** Rebuild a three-tier header whose grouped labels sit above repeated data columns. */
export function tieredHeaderTable(items: NormItem[], pageNum: number): IRBlock | null {
  const lines = groupByY(items).map(line => [...line].sort((a, b) => a.x - b.x))
  if (lines.length < 5) return null
  const cols = lines[3].length
  if (cols < 5 || (cols - 1) % 2 !== 0 || lines[0].length !== 1 ||
      lines[1].length !== 3 || lines[2].length !== cols - 1 ||
      !lines.slice(3).every(line => line.length === cols) ||
      Math.abs(lines[1][0].x - lines[3][0].x) > 30) return null
  const splitX = (lines[1][1].x + lines[1][2].x) / 2
  const half = (cols - 1) / 2
  if (lines[2].slice(0, half).some(i => i.x >= splitX) ||
      lines[2].slice(half).some(i => i.x < splitX)) return null
  const cell = (text: string, colSpan = 1, rowSpan = 1, isHeader = false): IRCell =>
    ({ text, colSpan, rowSpan, ...(isHeader ? { isHeader: true } : {}) })
  const empty = () => cell("")
  const grid: IRCell[][] = [
    [cell(lines[1][0].text, 1, 3, true), cell(lines[0][0].text, cols - 1, 1, true), ...Array.from({ length: cols - 2 }, empty)],
    [empty(), cell(lines[1][1].text, half, 1, true), ...Array.from({ length: half - 1 }, empty),
      cell(lines[1][2].text, half, 1, true), ...Array.from({ length: half - 1 }, empty)],
    [empty(), ...lines[2].map(i => cell(i.text, 1, 1, true))],
    ...lines.slice(3).map(line => line.map(i => cell(i.text))),
  ]
  return {
    type: "table", pageNumber: pageNum, bbox: computeBBox(items, pageNum),
    table: { rows: grid.length, cols, cells: grid, hasHeader: true },
  }
}

/** Separate stacked, captioned tables before a two-column body is examined. */
export function stackedTableBands(items: NormItem[]): { tables: NormItem[][]; between: NormItem[][]; caption: NormItem[]; body: NormItem[] } | null {
  const lines = groupByY(items)
  if (lines.length < 16) return null
  const dense = lines.map(line => line.length >= 6 &&
    Math.max(...line.map(i => i.x + i.w)) - Math.min(...line.map(i => i.x)) >= 300)
  const runs: Array<{ start: number; end: number }> = []
  for (let i = 0; i < dense.length;) {
    if (!dense[i]) { i++; continue }
    const start = i
    while (i < dense.length && dense[i]) i++
    if (i - start >= 2) runs.push({ start, end: i })
  }
  if (runs.length < 2 || runs[0].start > 2) return null
  const caption = (start: number, end: number) =>
    lines.slice(start, end).some(line => /^Table\s+\d+\s*[:.]/i.test(mergeLineSimple(line).trim()))
  while (runs.length > 0 && !caption(runs[runs.length - 1].end, lines.length)) runs.pop()
  if (runs.length < 2) return null
  if (runs.some((run, i) => !caption(run.end, runs[i + 1]?.start ?? lines.length))) return null
  const tables = runs.map(run => lines.slice(run.start, run.end).flat())
  const between = runs.slice(0, -1).map((run, i) => lines.slice(run.end, runs[i + 1].start).flat())
  const tail = lines.slice(runs[runs.length - 1].end)
  let bodyStart = tail.length
  for (let i = 1; i < Math.min(tail.length, 10); i++) {
    if (tail[i - 1][0].y - tail[i][0].y >= 24) { bodyStart = i; break }
  }
  return { tables, between, caption: tail.slice(0, bodyStart).flat(), body: tail.slice(bodyStart).flat() }
}

/** Three sparse title cards are independent reading regions, not table columns. */
export function threeColumnCards(items: NormItem[]): NormItem[][] | null {
  const lines = groupByY(items)
  if (lines.length < 5) return null
  for (let n = 1; n < lines.length - 2; n++) {
    const labels = [...lines[n]].sort((a, b) => a.x - b.x)
    if (labels.length !== 3 || labels.some(i => i.text.trim().length < 3 || i.text.length > 40)) continue
    if (labels[1].x - (labels[0].x + labels[0].w) < 70 ||
        labels[2].x - (labels[1].x + labels[1].w) < 70) continue
    if (!labels.every(i => i.fontName === labels[0].fontName && Math.abs(i.fontSize - labels[0].fontSize) < 1)) continue
    // A title separated from the cards, followed by three aligned value regions.
    if (lines[n - 1][0].y - labels[0].y < labels[0].fontSize * 2) continue
    const below = lines.slice(n + 1)
    const firstContent = below[0]
    if (labels[0].y - firstContent[0].y < labels[0].fontSize * 2) continue
    const boundaries = [
      (labels[0].x + labels[0].w + labels[1].x) / 2,
      (labels[1].x + labels[1].w + labels[2].x) / 2,
    ]
    if (!boundaries.every((x, i) => x > labels[i].x + labels[i].w && x < labels[i + 1].x)) continue
    let end = below.length
    for (let j = 1; j < below.length; j++) {
      if (below[j - 1][0].y - below[j][0].y > labels[0].fontSize * 5) { end = j; break }
    }
    const region = [labels, ...below.slice(0, end)].flat()
    const cards = [0, 1, 2].map(c => region.filter(i => c === 0 ? i.x < boundaries[0] : c === 1 ? i.x >= boundaries[0] && i.x < boundaries[1] : i.x >= boundaries[1]))
    if (cards.some(c => c.length < 2 || !c.some(i => i.y < labels[0].y))) continue
    const upper = lines.slice(0, n).flat()
    const lower = below.slice(end).flat()
    return [upper, ...cards, lower].filter(g => g.length > 0)
  }
  return null
}

/** A wide infographic may place three card titles at different heights above aligned body columns. */
export function threeColumnInfographic(items: NormItem[]): NormItem[][] | null {
  const lines = groupByY(items)
  if (lines.length < 12) return null
  for (let n = 4; n < lines.length - 6; n++) {
    if (lines[n - 1][0].y - lines[n][0].y < 35) continue
    const lower = lines.slice(n)
    const counts = new Map<number, number>()
    for (const item of lower.flat()) {
      if (item.text.trim().length < 12) continue
      const x = Math.round(item.x / 5) * 5
      counts.set(x, (counts.get(x) ?? 0) + 1)
    }
    const anchors = [...counts].filter(([, count]) => count >= 2).map(([x]) => x).sort((a, b) => a - b)
    if (anchors.length !== 3 || anchors[1] - anchors[0] < 120 || anchors[2] - anchors[1] < 120) continue
    const cuts = [(anchors[0] + anchors[1]) / 2, (anchors[1] + anchors[2]) / 2]
    let footerStart = lower.length
    for (let j = 1; j < lower.length; j++) {
      if (lower[j - 1][0].y - lower[j][0].y >= 70) { footerStart = j; break }
    }
    const region = lower.slice(0, footerStart).flat()
    const cards = [
      region.filter(i => i.x < cuts[0]),
      region.filter(i => i.x >= cuts[0] && i.x < cuts[1]),
      region.filter(i => i.x >= cuts[1]),
    ]
    if (cards.some(card => card.length < 4 || !card.some(i => i.text.length >= 50))) continue
    return [lines.slice(0, n).flat(), ...cards, lower.slice(footerStart).flat()].filter(group => group.length > 0)
  }
  return null
}

/**
 * 그림이 단마다 엇갈려 놓인 쪽 — 본문 단 옆에 그림·캡션 단이 나란한 띠와 전폭 본문 띠가 번갈아 온다(ODL 140). 쪽 전체로는
 * 전폭 줄이 거터를 가려 두 단이 안 보이므로, 전폭으로 이어진 본문 줄을 경계로 띠를 나누고 띠마다 글과 그 높이의 그림이
 * 하나도 걸치지 않는 세로 빈 띠(8pt 이상, 가운데 30~70%)를 찾는다. 두 단으로 갈린 띠가 하나라도 있으면 띠 순서대로
 * [좌 단, 우 단] 또는 [띠] 로 낸다.
 */
export function figureColumnBands(items: NormItem[], figures: ColRect[]): NormItem[][] | null {
  const lines = groupByY([...items].sort((a, b) => b.y - a.y || a.x - b.x))
  if (lines.length < 10) return null
  const minX = Math.min(...items.map(i => i.x)), maxX = Math.max(...items.map(i => i.x + i.w))
  const span = maxX - minX
  if (span < 200) return null
  const full = (line: NormItem[]) => {
    const s = [...line].sort((a, b) => a.x - b.x)
    const fs = Math.max(...s.map(i => i.fontSize))
    if (s[s.length - 1].x + s[s.length - 1].w - s[0].x < span * 0.75) return false
    return s.slice(1).every((it, k) => it.x - (s[k].x + s[k].w) < fs * 2)
  }
  const segs: { full: boolean; lines: NormItem[][] }[] = []
  for (const line of lines) {
    const f = full(line), last = segs[segs.length - 1]
    if (last && last.full === f) last.lines.push(line)
    else segs.push({ full: f, lines: [line] })
  }
  let split = false
  const out: NormItem[][] = []
  for (const seg of segs) {
    const flat = seg.lines.flat()
    if (seg.full || seg.lines.length < 3) { out.push(flat); continue }
    const top = Math.max(...flat.map(i => i.y + (i.h || i.fontSize))), bottom = Math.min(...flat.map(i => i.y))
    const rects: ColRect[] = [...flat.map(i => ({ x: i.x, y: i.y, w: i.w, h: i.h || i.fontSize })),
      ...figures.filter(f => f.y < top && f.y + f.h > bottom)]
    let best: { x: number; w: number } | null = null, run: number | null = null
    for (let x = minX + span * 0.3; x <= minX + span * 0.7; x += 2) {
      const empty = !rects.some(r => r.x < x && r.x + r.w > x)
      if (empty && run === null) run = x
      if ((!empty || x + 2 > minX + span * 0.7) && run !== null) {
        if (x - run >= 8 && (!best || x - run > best.w)) best = { x: (run + x) / 2, w: x - run }
        run = null
      }
    }
    if (!best) { out.push(flat); continue }
    const left = flat.filter(i => i.x + i.w <= best!.x), right = flat.filter(i => i.x >= best!.x)
    // 단 안 줄에 큰 틈이 있으면(표 행) 가르지 않는다 — 그림 옆 표가 반으로 갈린다(ODL 116)
    const gapped = (side: NormItem[]) => groupByY([...side].sort((a, b) => b.y - a.y || a.x - b.x)).some(l => {
      const s = [...l].sort((a, b) => a.x - b.x)
      return s.slice(1).some((it, k) => it.x - (s[k].x + s[k].w) >= Math.max(it.fontSize, s[k].fontSize) * 2)
    })
    if (left.length === 0 || right.length === 0 || gapped(left) || gapped(right)) { out.push(flat); continue }
    split = true
    out.push(left, right)
  }
  return split ? out.filter(g => g.length > 0) : null
}
