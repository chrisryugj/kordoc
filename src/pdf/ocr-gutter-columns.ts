/**
 * OCR 괘선 표의 빈칸 열 — 통계표는 열 묶음 경계에만 세로선을 긋고 묶음 안 열(합계출산율·기대수명·국내순이동)은 빈칸으로만 가른다.
 * 격자 칸 하나에 세 열 값이 "0.64 84.8 -107" 로 붙어 열이 모자랐다(시도별 장래인구추계 가정치 22열 → 8열).
 *
 * 격자 열마다 숫자 값이 픽셀 빈 구간(ocrTextGaps)이나 따로 읽힌 상자로 갈린 글줄을 모아, 서로 다른 글줄 둘 이상이 같이 비운 x 를 찾는다.
 * 그 x 를 가로지르는 글(묶음 제목 "중위 추계" 등)이 없는 격자 행 범위에만 가상 세로선을 긋는다 — 묶음 제목은 위 칸에서 칸 합침으로 남는다.
 */

import type { LineSegment, TableGrid } from "./line-types.js"
import type { NormItem } from "./text-line.js"
import { ocrTextGaps } from "../ocr/text-gaps.js"
import { OCR_GROUPED_NUMBER } from "./ocr-column-cuts.js"

/** 값 토큰 — 수(쉼표·소수점·백분율·부호), 괄호 친 수(구성비·증감률 "(1.7)"), 빈 값 표지(-) */
const VALUE_TOKEN = /^(?:\(?[+-]?\d+(?:[,.]\d+)*%?\)?|[-–—])$/

interface Span { left: number; right: number; text: string; estimated?: true }

/** 상자 하나를 픽셀 빈 구간에서 가른 토큰 구간 */
function itemSpans(it: NormItem): Span[] {
  const gaps = ocrTextGaps(it).filter(g => g.left > it.x && g.right < it.x + it.w).sort((a, b) => a.at - b.at)
  const spans: Span[] = []
  let at = 0, left = it.x
  for (const g of gaps) {
    spans.push({ left, right: g.left, text: it.text.slice(at, g.at).trim() })
    at = g.at; left = g.right
  }
  spans.push({ left, right: it.x + it.w, text: it.text.slice(at).trim() })
  return spans
}

/** 격자의 가상 세로선 — 그 격자의 칸 뽑기(칸 합침)에만 쓴다. 쪽 전역 세로선에 넣으면 틀·프로즈 상자 판정이 흔들린다 */
export const GRID_GUTTERS = new WeakMap<TableGrid, LineSegment[]>()

/** 격자마다 그을 가상 세로선 (없는 격자는 빠진다) */
export function ocrGutterVerticals(grids: TableGrid[], items: NormItem[]): Map<TableGrid, LineSegment[]> {
  const out = new Map<TableGrid, LineSegment[]>()
  const inside = (a: TableGrid["bbox"], b: TableGrid["bbox"]) => a !== b && b.x1 >= a.x1 - 1 && b.x2 <= a.x2 + 1 && b.y1 >= a.y1 - 1 && b.y2 <= a.y2 + 1
  for (const grid of grids) {
    // 다른 격자를 품은 틀(쪽 테두리 상자)은 표가 아니다 — 안쪽 격자가 맡는다
    if (grid.cells || grid.rowYs.length < 2 || grids.some(g => inside(grid.bbox, g.bbox))) continue
    for (let c = 0; c + 1 < grid.colXs.length; c++) {
      const x0 = grid.colXs[c], x1 = grid.colXs[c + 1]
      const inCol = items.filter(it => it.fontName === "ocr" && it.x + it.w / 2 > x0 && it.x + it.w / 2 < x1 &&
        it.y + it.h / 2 > grid.bbox.y1 && it.y + it.h / 2 < grid.bbox.y2)
      if (inCol.length < 2) continue
      const size = median(inCol.map(it => it.h))
      // 글줄 — 기준선이 글 높이 절반 안
      // spans: 빈 구간 근거로 가른 토큰(지지에 쓴다), cover: 근거 없는 상자는 어림으로 가른 구간(막힘에만 쓴다)
      const lines: Array<{ y: number; spans: Span[]; cover: Span[] }> = []
      for (const it of [...inCol].sort((a, b) => b.y - a.y)) {
        const line = lines.find(l => Math.abs(l.y - it.y) <= size * 0.5)
        const whole = [{ left: it.x, right: it.x + it.w, text: it.text.trim() }]
        const spans = OCR_GROUPED_NUMBER.test(it.text.trim()) ? whole : itemSpans(it)
        const cover = spans.length > 1 || OCR_GROUPED_NUMBER.test(it.text.trim()) ? spans : estimatedSpans(it, size)
        if (line) { line.spans.push(...spans); line.cover.push(...cover) } else lines.push({ y: it.y, spans, cover })
      }
      // 값 토큰 둘 사이 빈 구간 (글자 높이 0.3 이상)
      const gaps: Array<{ left: number; right: number; line: number }> = []
      // 칸 토큰이 모두 값인 글줄만 — "15 - 29세" 같은 구간 표지는 값 둘이 아니다
      lines.forEach((line, li) => {
        const s = line.spans.filter(sp => sp.text).sort((a, b) => a.left - b.left)
        if (!s.every(sp => VALUE_TOKEN.test(sp.text))) return
        for (let k = 1; k < s.length; k++) {
          // 천 단위 묶음이 틈으로 갈린 것("34,875,1 12,751")은 열 틈이 아니다
          if (s[k].left - s[k - 1].right >= size * 0.3 && VALUE_TOKEN.test(s[k - 1].text) && VALUE_TOKEN.test(s[k].text) && !/,\d{1,2}$/.test(s[k - 1].text)) {
            gaps.push({ left: s[k - 1].right, right: s[k].left, line: li })
          }
        }
      })
      const valueLines = lines.filter(l => l.spans.some(sp => VALUE_TOKEN.test(sp.text))).length
      const margin = size * 0.3
      while (gaps.length >= 2) {
        // 서로 다른 글줄 빈 구간이 가장 많이 겹치는 x
        const events = gaps.flatMap(g => [{ x: g.left, d: 1 }, { x: g.right, d: -1 }]).sort((a, b) => a.x - b.x || a.d - b.d)
        let active = 0, best = 1, cut: number | undefined
        for (let i = 0; i < events.length;) {
          const x = events[i].x
          while (i < events.length && events[i].x === x) active += events[i++].d
          const width = i < events.length ? events[i].x - x : 0
          if (active > best && width > 0) { best = active; cut = x + width / 2 }
        }
        if (cut === undefined) break
        const x = cut
        const support = gaps.filter(g => g.left <= x && g.right >= x)
        for (const g of support) gaps.splice(gaps.indexOf(g), 1)
        if (x - x0 < margin || x1 - x < margin) continue
        const supportLines = new Set(support.map(g => lines[g.line].y))
        // 값 글줄 셋 이상·40% 이상이 같은 틈을 비워야 열이다 — 몇 줄만 우연히 맞은 틈(묶음 숫자 OCR 틈)은 아니다.
        // 본문 두 행뿐인 작은 표(연평균 증감률 "1.3 -1.0" / "0.7 -0.1")는 값 글줄 전부가 같은 틈을 비우면 열이다
        const minSupport = valueLines === 2 && supportLines.size === 2 ? 2 : Math.max(3, valueLines * 0.4)
        if (supportLines.size < minSupport) continue
        // 격자 행마다 x 를 가로지르는 글줄이 그 행 지지 글줄의 1/4 을 넘으면 막힌 행 — 지지 없는 머리 행(묶음 제목)은 한 줄로 막힌다.
        // 본문이 괘선 없이 한 격자 행이면 빈 구간 근거를 못 얻은 상자 한둘이 행 전체를 막지 않게 한다
        const rows = grid.rowYs.length - 1
        const supportIn = (r: number) => [...supportLines].filter(y => y < grid.rowYs[r] && y > grid.rowYs[r + 1]).length
        // 값 아닌 글 둘뿐인 글줄이 틈 양옆에 글자 높이 1.2 배 안으로 붙으면(띄어 쓴 머리 "자기 집"·"전 세") x 를 가로지른다 — 두 열에
        // 걸친 머리 칸이다. 열마다 따로 선 머리 줄("제조업  서비스  건설", "합계 기대 국내")은 셋 이상이거나 멀어 막지 않는다
        const spaced = (l: { spans: Span[] }) => {
          const word = l.spans.filter(sp => sp.text)
          if (word.length !== 2 || word.some(sp => VALUE_TOKEN.test(sp.text))) return false
          const [left, right] = [...word].sort((a, b) => a.left - b.left)
          return left.right <= x && right.left >= x && right.left - left.right <= size * 1.2
        }
        const blocked = Array.from({ length: rows }, (_, r) => lines.filter(l => l.y < grid.rowYs[r] && l.y > grid.rowYs[r + 1] &&
          (l.cover.some(sp => sp.estimated ? x - sp.left > size * 0.6 && sp.right - x > size * 0.6 : sp.left < x - 0.5 && sp.right > x + 0.5) ||
            spaced(l))).length > supportIn(r) * 0.25)
        // 막히지 않은 연속 행 가운데 지지 글줄이 가장 많은 구간
        let bestRun: [number, number] | undefined, bestCount = 0
        for (let r = 0; r < rows;) {
          if (blocked[r]) { r++; continue }
          let e = r, n = 0
          while (e < rows && !blocked[e]) n += supportIn(e++)
          if (n > bestCount) { bestCount = n; bestRun = [r, e] }
          r = e
        }
        if (!bestRun || bestCount < Math.min(3, minSupport)) continue
        const list = out.get(grid) ?? []
        list.push({ x1: x, y1: grid.rowYs[bestRun[1]], x2: x, y2: grid.rowYs[bestRun[0]], lineWidth: 0.5 })
        out.set(grid, list)
      }
    }
  }
  return out
}

/** 가상 세로선이 지나는 상자를 그 빈 틈에서 쪼갠다 — 빈 구간 근거가 있으면 그 자리, 없으면 어림한 공백 자리가 선에서 글자 높이 0.6 안일 때만 */
export function splitItemsAtGutters(items: NormItem[], cuts: LineSegment[]): NormItem[] {
  if (!cuts.length) return items
  return items.flatMap(it => {
    if (it.fontName !== "ocr") return [it]
    const cy = it.y + it.h / 2
    const xs = cuts.filter(l => cy > l.y1 && cy < l.y2 && l.x1 > it.x && l.x1 < it.x + it.w).map(l => l.x1).sort((a, b) => a - b)
    if (!xs.length) return [it]
    const evidence = itemSpans(it)
    const spans = evidence.length > 1 ? evidence : estimatedSpans(it, it.h)
    if (spans.length < 2) return [it]
    // 선마다 그 선을 사이에 둔 이웃 토큰 경계를 찾아 조각 경계로
    const breaks = new Set<number>()
    for (const x of xs) {
      const k = spans.findIndex((sp, i) => i > 0 && spans[i - 1].right <= x + it.h * 0.6 && sp.left >= x - it.h * 0.6)
      if (k > 0) breaks.add(k)
    }
    if (!breaks.size) return [it]
    const parts: NormItem[] = []
    let from = 0
    for (const k of [...breaks].sort((a, b) => a - b).concat(spans.length)) {
      const group = spans.slice(from, k)
      if (!group.length) continue
      const left = group[0].left, right = group[group.length - 1].right
      parts.push({ ...it, text: group.map(g => g.text).join(" "), x: left, w: Math.max(1, right - left), ...(from > 0 ? { hasSpaceBefore: true } : {}) })
      from = k
    }
    return parts
  })
}

/** 빈 구간 증거 없는 상자의 낱말 구간 어림 — 글자 폭(한글 1·숫자·로마자 0.55·기호 0.35·공백 0.3 em) 비례. 막힘 판정에만 쓴다 */
function estimatedSpans(it: NormItem, size: number): Span[] {
  const parts = it.text.split(/(\s+)/)
  const unit = (ch: string) => /[가-힣ㄱ-ㆎ一-鿿]/.test(ch) ? 1 : /[\p{L}\p{N}]/u.test(ch) ? 0.55 : /\s/.test(ch) ? 0.3 : 0.35
  const total = [...it.text].reduce((n, ch) => n + unit(ch), 0)
  if (parts.length < 3 || total <= 0) return [{ left: it.x, right: it.x + it.w, text: it.text.trim() }]
  // 토큰 경계 = 어림한 공백 가운데 (어림 오차는 쓰는 쪽이 글자 높이 0.6 만큼 봐준다)
  const k = it.w / total
  const spans: Span[] = []
  let x = it.x
  for (const p of parts) {
    const w = [...p].reduce((n, ch) => n + unit(ch), 0) * k
    if (p.trim()) spans.push({ left: x, right: x + w, text: p, estimated: true })
    else if (spans.length) spans[spans.length - 1].right = x + w / 2
    x += w
    if (!p.trim() && spans.length) x -= w / 2
  }
  return spans
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/**
 * 격자 열 여럿에 걸친 OCR 상자 쪼개기 — 검출기가 이웃 칸 수를 한 상자로 묶고 인식기가 공백까지 빠뜨려 "0.50.71.0"·"7.4 10.3" 이 한 칸에
 * 들어가고 이웃 칸이 비었다(통계표 성·연령별 비율). 상자가 가로지르는 열 경계 수 + 1 = k 이고 글이 값 k 개로 정확히 갈리면 —
 * 공백으로, 또는 소수 자릿수가 같은 수가 이어 붙은 꼴로 — 값마다 그 열 가운데에 놓는다
 */
export function splitItemsAcrossColumns(items: NormItem[], grids: TableGrid[]): NormItem[] {
  if (!grids.length) return items
  return items.flatMap(it => {
    if (it.fontName !== "ocr") return [it]
    const cx = it.x + it.w / 2, cy = it.y + it.h / 2
    const grid = grids.find(g => !g.cells && cx > g.bbox.x1 && cx < g.bbox.x2 && cy > g.bbox.y1 && cy < g.bbox.y2)
    if (!grid) return [it]
    const tol = Math.max(1, it.h * 0.2)
    const inside = grid.colXs.filter(x => x > it.x + tol && x < it.x + it.w - tol)
    if (!inside.length) return [it]
    const k = inside.length + 1
    const tokens = valueTokens(it.text.trim(), k)
    if (!tokens) return [it]
    const first = grid.colXs.findIndex(x => x === inside[0]) - 1
    return tokens.map((text, i) => {
      const l = grid.colXs[first + i], r = grid.colXs[first + i + 1]
      const w = Math.min(it.w / k, (r - l) * 0.8)
      return { ...it, text, x: (l + r) / 2 - w / 2, w, ...(i > 0 ? { hasSpaceBefore: true } : {}) }
    })
  })
}

/** 글을 값 k 개로 — 공백으로 갈린 값 토큰, 아니면 소수 자릿수 d(1·2) 가 같은 수 k 개가 이어 붙은 꼴, 아니면 천 단위 쉼표 정수 k 개가
 *  이어 붙은 꼴("7,3022,6071,364" — 쉼표 뒤 세 자리가 끝나는 자리가 다음 수의 머리라 한 가지로만 갈린다) */
function valueTokens(text: string, k: number): string[] | null {
  const parts = text.split(/\s+/)
  if (parts.length === k && parts.every(p => VALUE_TOKEN.test(p))) return parts
  const bare = text.replace(/\s+/g, "")
  for (const d of [1, 2]) {
    const one = `[-−]?\\d{1,3}(?:,\\d{3})*\\.\\d{${d}}`
    const m = new RegExp(`^(?:${one}){${k}}$`).test(bare)
    if (m) return bare.match(new RegExp(one, "g"))
  }
  const grouped = /[-−]?\d{1,3}(?:,\d{3})+/g
  // 앞뒤 "|" 는 인식기가 표 테두리를 읽은 것이다
  const body = bare.replace(/^\|+|\|+$/g, "")
  const ints = body.match(grouped)
  return ints && ints.length === k && ints.join("") === body ? ints : null
}

