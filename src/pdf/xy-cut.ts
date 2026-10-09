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

import { groupByY, mergeLineSimple, dominantStyle, computeBBox, type NormItem } from "./text-line.js"
import { bodyLineJoins } from "./line-wrap.js"

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

/** 산문 두 단 사이 거터 최소 폭 (pt) — 양쪽 정렬 두 단은 줄 끝 공백 폭을 빼면 8pt 안팎까지 좁다(낱말 사이는 3pt 안팎) */
const PROSE_GUTTER_MIN_GAP = 6

interface CutInfo {
  position: number
  gap: number
}

interface WrapBand { top: number; bottom: number; sources: { item: NormItem; state: NormItem }[] }

/** Geometrically confirmed wrap boundaries in the parent reading region. Keys are
 * original items in a leaf; row grouping retains their identity. Metadata expires
 * with the items and never enters the public IR. */
export const XY_WRAP_BANDS = new WeakMap<NormItem, WrapBand[]>()
const XY_WRAP_ITEMS = new WeakMap<NormItem, NormItem[]>()
const leaf = (items: NormItem[], wrapped: WrapBand[]): NormItem[][] => {
  wrapped = validWrapBands(items, wrapped)
  const source = wrapped.length ? [...items] : []
  for (const item of items) {
    if (wrapped.length) { XY_WRAP_BANDS.set(item, wrapped); XY_WRAP_ITEMS.set(item, source) }
    else { XY_WRAP_BANDS.delete(item); XY_WRAP_ITEMS.delete(item) }
  }
  return [items]
}

/** 하위 무리를 다시 자를 때 물려줄 단(세로) 절단 최소 틈 — 벡터 차트 바로 밑의 짧은 띠(네 줄 이하: 축 이름·범례·출처)만 쪽 문턱을 받는다.
 *  띠 높이로 다시 잰 문턱(최소 15pt)은 범례 항목 사이 18pt 틈을 단 경계로 갈랐다(ODL 077). 차트 밑이 아닌 무리는 종전대로 제 높이로 잰다 —
 *  서명란·숫자 행·한 줄 제목은 15~22pt 틈에서 갈라야 글 벤치가 맞고, 줄 많은 무리는 그 문턱으로 좁은 단을 가른다. 가로 절단은 늘 무리 문턱
 *  (쌓인 짧은 줄이 한 줄로 붙었다, 중문 계약서) */
export function chartBandGap(group: NormItem[], gap: number, charts: { x1: number; x2: number; y1: number }[]): number {
  if (charts.length === 0 || groupByY([...group].sort((a, b) => b.y - a.y || a.x - b.x)).length > 4) return 0
  const x1 = Math.min(...group.map(i => i.x)), x2 = Math.max(...group.map(i => i.x + i.w))
  const top = Math.max(...group.map(i => i.y + i.fontSize)), em = Math.max(...group.map(i => i.fontSize))
  return charts.some(c => x1 >= c.x1 - 2 && x2 <= c.x2 + 2 && top <= c.y1 + 2 && c.y1 - top <= 2 * em) ? gap : 0
}

export function xyCutOrder(items: NormItem[], gapThreshold: number, depth = 0, wrapped?: WrapBand[], columnGap = 0): NormItem[][] {
  if (items.length === 0) return []
  const newRegion = wrapped === undefined
  wrapped ??= inheritedWrapBands(items)
  if (items.length <= 2 || depth >= MAX_XYCUT_DEPTH) return leaf(items, wrapped)

  // Phase 1 (최상위에서만): cross-layout 전폭 요소 마스크
  if (depth === 0 && items.length >= 3) {
    const cross = identifyCrossLayoutItems(items)
    if (cross.size > 0 && cross.size <= items.length * CROSS_MAX_MASK_RATIO) {
      const rest = items.filter(i => !cross.has(i))
      if (rest.length > 0) {
        const groups = xyCutOrder(rest, gapThreshold, 1, undefined, columnGap)
        return mergeCrossLayoutGroups(groups, [...cross])
      }
    }
  }

  // Phase 3: 양방향 컷 계산 → 더 큰 갭 선택 (기존: Y 무조건 우선 → 2단 인터리브)
  const minGap = Math.max(XYCUT_MIN_GAP, gapThreshold)
  const sortedY = [...items].sort((a, b) => b.y - a.y)
  let hCut = findHorizontalCut(sortedY, wrapped)
  // Text assembly cannot affect a horizontal cut below its minimum gap.
  // Reuse the sorted projection when a fresh region needs wrap protection.
  if (newRegion && hCut.gap >= minGap) {
    wrapped = wrappedLineBands(items, wrapped)
    hCut = findHorizontalCut(sortedY, wrapped)
  }
  // 단(세로) 절단만 물려받은 최소 틈을 쓴다 — 가로 절단(쌓인 줄 사이)은 이 무리 문턱 그대로 (shortBandGap)
  const vMinGap = Math.max(minGap, columnGap)
  const vCut = findVerticalCutWithOutlierFilter(items, vMinGap)

  const hValid = hCut.gap >= minGap
  const vValid = (vCut.gap >= vMinGap || (vCut.gap >= PROSE_GUTTER_MIN_GAP && isProseGutter(items, vCut.position))) &&
    !splitsSpacedLabel(items, vCut.position)

  // 축 선택: 기본 Y 우선 (한국 공문서는 단일 컬럼 위주 — 코퍼스 검증 결과 Y 우선이 안정적).
  // 단, 수직 갭이 수평 갭보다 명백히 크면(1.5×) 컬럼 분리로 보고 X 우선
  // → 2단 레이아웃에서 문단 간 수평 갭이 단 사이 수직 갭보다 먼저 잡혀 행 단위로
  //   인터리브되는 문제 방지 (XY-Cut++ 양방향 컷의 보수적 적용)
  let useHorizontal: boolean
  if (hValid && vValid) useHorizontal = vCut.gap <= hCut.gap * 1.5 || staggeredSides(items, vCut.position)
  else if (hValid) useHorizontal = true
  else if (vValid) useHorizontal = false
  else return splitEdgeSpannedColumns(items, gapThreshold, depth) ?? leaf(items, wrapped) // 분할 불가 → 리프 노드

  if (useHorizontal) {
    const upper = items.filter(i => i.y > hCut.position)
    const lower = items.filter(i => i.y <= hCut.position)
    if (upper.length > 0 && lower.length > 0 && upper.length < items.length) {
      return [...xyCutOrder(upper, gapThreshold, depth + 1, wrapped, columnGap), ...xyCutOrder(lower, gapThreshold, depth + 1, wrapped, columnGap)]
    }
  } else {
    const left = items.filter(i => i.x + i.w / 2 < vCut.position)
    const right = items.filter(i => i.x + i.w / 2 >= vCut.position)
    if (left.length > 0 && right.length > 0 && left.length < items.length) {
      return [...xyCutOrder(left, gapThreshold, depth + 1, undefined, columnGap), ...xyCutOrder(right, gapThreshold, depth + 1, undefined, columnGap)]
    }
  }

  return leaf(items, wrapped)
}

/**
 * 균등배분 이름표("가. 일       시: …")의 글자 사이 빈틈 — 양쪽이 걸친 줄마다 컷 바로 옆이 홀로 선 한글 한 글자씩이면
 * 단 경계가 아니라 한 낱말 안이다(issue1948). 두 단 본문은 컷 옆이 낱말·문장 조각이다.
 */
function splitsSpacedLabel(items: NormItem[], cutX: number): boolean {
  const lone = (i: NormItem) => /^[가-힣]$/.test(i.text.trim())
  const sameRow = (a: NormItem, b: NormItem) => Math.min(a.y, b.y) > Math.max(a.y - a.h, b.y - b.h)
  const left = items.filter(i => i.x + i.w / 2 < cutX)
  const right = items.filter(i => i.x + i.w / 2 >= cutX)
  let spaced = 0
  for (const r of right) {
    if (right.some(o => o !== r && o.x < r.x && sameRow(o, r))) continue
    const row = left.filter(l => sameRow(l, r))
    if (row.length === 0) continue
    const l = row.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a))
    if (!lone(l) || !lone(r)) return false
    spaced++
  }
  return spaced > 0
}

/**
 * 세로 컷 양쪽이 같은 줄을 한 번도 나누지 않고 위아래로 번갈아(좌·우·좌·우) 놓이면 두 단이 아니라
 * 한 단 안의 들쭉날쭉한 줄이다 — 제목 줄마다 아래 오른쪽 끝에 붙인 "(단위 : …)" 줄(hwpx-02).
 * 두 단 본문은 양쪽 줄이 같은 높이에 나란히 놓인다.
 */
function staggeredSides(items: NormItem[], cutX: number): boolean {
  const left = items.filter(i => i.x + i.w / 2 < cutX)
  const right = items.filter(i => i.x + i.w / 2 >= cutX)
  if (left.length * right.length > 200_000) return false
  const shareRow = (a: NormItem, b: NormItem) => Math.min(a.y, b.y) > Math.max(a.y - a.h, b.y - b.h)
  if (left.some(a => right.some(b => shareRow(a, b)))) return false
  const sides = [...items].sort((a, b) => b.y - a.y).map(i => i.x + i.w / 2 < cutX)
  let switches = 0
  for (let k = 1; k < sides.length; k++) if (sides[k] !== sides[k - 1]) switches++
  return switches >= 3
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

/** Keep parent proof only while both original rows survive unchanged in this leaf. */
function validWrapBands(items: NormItem[], bands: WrapBand[]): WrapBand[] {
  if (!bands.length) return []
  const present = new Set(items)
  return bands.filter(b => b.sources.every(({ item: a, state: s }) => present.has(a) &&
    a.text === s.text && a.x === s.x && a.y === s.y && a.w === s.w && a.h === s.h &&
    a.fontSize === s.fontSize && a.fontName === s.fontName && a.isHidden === s.isHidden &&
    a.hasSpaceBefore === s.hasSpaceBefore && a.syntheticSpace === s.syntheticSpace &&
    a.strike === s.strike && a.underline === s.underline && a.seq === s.seq && a.rotated === s.rotated))
}

/** A second extraction pass may reuse only the same unchanged reading leaf. */
function inheritedWrapBands(items: NormItem[]): WrapBand[] {
  const source = XY_WRAP_ITEMS.get(items[0])
  const present = source?.length === items.length ? new Set(items) : null
  const sameLeaf = present && source!.every(item => present.has(item))
  return sameLeaf ? validWrapBands(items, XY_WRAP_BANDS.get(items[0]) ?? []) : []
}

/** Two completed records with a shared page-number column are independent rows.
 * tab-leaders keeps the leader's geometry as a whitespace item. Require a separate
 * numeric run and a wide label-to-number gap; a bare number at a prose end is not proof. */
export function tocRecordBoundaries(rows: NormItem[][]): Set<number> {
  const out = new Set<number>()
  if (rows.length < 2) return out
  const records = rows.map((row, index) => {
    const visible = row.filter(i => i.text.trim()).sort((a, b) => a.x - b.x)
    let start = visible.length - 1
    if (start < 1 || !/^\d+$/.test(visible[start].text.trim())) return null
    for (; start > 0; start--) {
      const a = visible[start - 1], b = visible[start]
      if (!/^\d+$/.test(a.text.trim()) || b.x - (a.x + a.w) > 0.5 * b.fontSize) break
    }
    const nums = visible.slice(start), label = visible.slice(0, start).filter(i => !/^[·.⋯…]{4,}$/.test(i.text.trim()))
    const fs = nums[0].fontSize
    if (!/^\d{1,4}$/.test(nums.map(i => i.text.trim()).join("")) || fs <= 0 ||
        !label.some(i => /[\p{L}]/u.test(i.text)) ||
        nums[0].x - Math.max(...label.map(i => i.x + i.w)) < Math.max(2 * fs, 30)) return null
    return { right: Math.max(...nums.map(i => i.x + i.w)), fs, index }
  }).filter(record => record !== null).sort((a, b) => a.right - b.right)
  // A wrapped label can intervene between completed entries in the same page column.
  // Protect only boundaries after completed records, leaving its own wrap intact.
  for (let i = 0; i + 1 < records.length; i++) {
    const a = records[i], b = records[i + 1]
    if (Math.abs(a.right - b.right) <= 0.5 * Math.min(a.fs, b.fs) &&
        Math.abs(a.fs - b.fs) <= 0.15 * Math.min(a.fs, b.fs)) {
      if (a.index + 1 < rows.length) out.add(a.index)
      if (b.index + 1 < rows.length) out.add(b.index)
    }
  }
  return out
}

/** Fresh wrap evidence is needed only for a region with a possible horizontal cut. */
function wrappedLineBands(items: NormItem[], inherited: WrapBand[]): WrapBand[] {
  // Reuse the paragraph assembler's width, pitch, font and new-item guards before
  // cutting a wide line-spacing band (e.g. 30pt pitch in a 10pt body).
  const rows = groupByY(items)
  const records = tocRecordBoundaries(rows)
  const lines = rows.map(row => {
    const box = computeBBox(row, 0)
    return { text: mergeLineSimple(row).replace(/<\/?u>|~~/g, ""), left: box.x, right: box.x + box.width,
      y: row.reduce((n, i) => n + i.y, 0) / row.length, fontSize: dominantStyle(row)?.fontSize ?? 0,
      sources: row.map(item => ({ item, state: { ...item } })) }
  })
  const joins = bodyLineJoins(lines)
  const fresh = lines.slice(0, -1).flatMap((line, i) => joins[i] === "\n" || records.has(i) || line.text.trim() === lines[i + 1].text.trim() ? [] :
    [{ top: line.y, bottom: lines[i + 1].y, sources: [...line.sources, ...lines[i + 1].sources] }])
  const freshKeys = new Set(fresh.map(b => `${b.top}:${b.bottom}`))
  return [...inherited.filter(b => !freshKeys.has(`${b.top}:${b.bottom}`)), ...fresh].sort((a, b) => b.top - a.top)
}

/** 수평 컷 — 기존 y-h 프로젝션 모델을 유지하고 확인된 줄 꺾임만 제외한다. */
function findHorizontalCut(sorted: NormItem[], wrapped: WrapBand[]): CutInfo {
  if (sorted.length < 2) return { position: 0, gap: 0 }
  let largestGap = 0
  let position = 0
  let wrapIndex = 0

  for (let i = 1; i < sorted.length; i++) {
    const prevBottom = sorted[i - 1].y - sorted[i - 1].h
    const currTop = sorted[i].y
    const gap = prevBottom - currTop
    if (gap <= 0) continue // Same-row/overlapping glyphs cannot advance the descending cut cursor.
    const at = (prevBottom + currTop) / 2
    while (wrapIndex < wrapped.length && at <= wrapped[wrapIndex].bottom) wrapIndex++
    const band = wrapped[wrapIndex]
    if (gap > largestGap && !(band && at < band.top && at > band.bottom)) {
      largestGap = gap
      position = at
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
      // 뺀 좁은 조각이 컷 자리에 걸쳐 같은 줄 양옆에 글을 두면 쪽번호가 아니라 줄 안 낱말이다 — 한 줄 제목
      // "1-2) 폭력 대비 및 대응의 적절성" 의 "및"(11pt)을 빼고 낸 23pt 틈으로 제목이 두 블록으로 갈렸다
      const sameRow = (a: NormItem, b: NormItem) => Math.abs(a.y - b.y) <= Math.max(a.fontSize, b.fontSize) * 0.5
      const inLine = items.some(r => r.w < narrowThreshold && r.x < filteredCut.position && r.x + r.w > filteredCut.position &&
        filtered.some(o => sameRow(o, r) && o.x + o.w <= r.x + 1) && filtered.some(o => sameRow(o, r) && o.x >= r.x + r.w - 1))
      if (filteredCut.gap > edgeCut.gap && filteredCut.gap >= minGap && !inLine) {
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

/** A narrow vertical gap is a column gutter when both sides hold several full
 * prose lines side by side (not a label column or stacked blocks). */
function isProseGutter(items: NormItem[], x: number): boolean {
  const sideLines = (side: NormItem[]) => {
    const lines: { y: number; chars: number; left: number; right: number }[] = []
    for (const item of [...side].sort((a, b) => b.y - a.y)) {
      const line = lines.find(l => Math.abs(l.y - item.y) <= 2)
      if (line) { line.chars += item.text.length; line.left = Math.min(line.left, item.x); line.right = Math.max(line.right, item.x + item.w) }
      else lines.push({ y: item.y, chars: item.text.length, left: item.x, right: item.x + item.w })
    }
    return lines
  }
  const left = sideLines(items.filter(i => i.x + i.w / 2 < x))
  const right = sideLines(items.filter(i => i.x + i.w / 2 >= x))
  if (left.length < 4 || right.length < 4) return false
  const prose = (lines: typeof left) => {
    const width = Math.max(...lines.map(l => l.right)) - Math.min(...lines.map(l => l.left))
    const full = lines.filter(l => l.chars >= 25 && l.right - l.left >= width * 0.6).length
    return full >= lines.length * 0.6
  }
  if (!prose(left) || !prose(right)) return false
  const span = (lines: typeof left) => [Math.min(...lines.map(l => l.y)), Math.max(...lines.map(l => l.y))]
  const [l0, l1] = span(left), [r0, r1] = span(right)
  return Math.min(l1, r1) - Math.max(l0, r0) >= Math.min(l1 - l0, r1 - r0) * 0.5
}

/** Two prose columns whose band starts or ends with a line crossing the gutter
 * (a caption or title under/over both columns): set that line apart at its edge
 * and read the columns left then right. Lines crossing in the middle keep the leaf. */
function splitEdgeSpannedColumns(items: NormItem[], gapThreshold: number, depth: number): NormItem[][] | null {
  let minX = Infinity, maxX = -Infinity
  for (const i of items) { minX = Math.min(minX, i.x); maxX = Math.max(maxX, i.x + i.w) }
  const narrow = items.filter(i => i.w < (maxX - minX) * 0.5)
  if (narrow.length === items.length || narrow.length < 8) return null
  const cut = findVerticalCut(narrow)
  if (cut.gap < PROSE_GUTTER_MIN_GAP || !isProseGutter(narrow, cut.position)) return null
  const crossing = items.filter(i => i.x < cut.position && i.x + i.w > cut.position)
  const rest = items.filter(i => !crossing.includes(i))
  const restTop = Math.max(...rest.map(i => i.y)), restBottom = Math.min(...rest.map(i => i.y))
  const above = crossing.filter(i => i.y > restTop), below = crossing.filter(i => i.y < restBottom)
  if (above.length + below.length !== crossing.length) return null
  const left = rest.filter(i => i.x + i.w / 2 < cut.position), right = rest.filter(i => i.x + i.w / 2 >= cut.position)
  return [
    ...(above.length ? [above] : []),
    ...xyCutOrder(left, gapThreshold, depth + 1),
    ...xyCutOrder(right, gapThreshold, depth + 1),
    ...(below.length ? [below] : []),
  ]
}
