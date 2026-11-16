/**
 * 선으로 그은 분수 막대 → `$\frac{…}{…}$`.
 *
 * 한컴 수식 글꼴(HyhwpEQ)이 아닌 옛 PDF 는 수식 글을 본문 글꼴·Type3 글꼴로 찍고 분수 막대를 얇은 수평 획으로 긋는다
 * (물환경보전법 시행규칙 [별표 8] "배출량 = 할당 오염부하량 / 기준배출수질 × 10⁶": 막대 229.2~321.1 @626.4, 분자 기준선 1.6pt 위,
 * 분모 기준선 10.4pt 아래, 둘 다 막대 가운데 ±1.4pt). 종전엔 막대를 분자의 밑줄로 읽고 분모를 다음 문단으로 냈다.
 * 막대 바로 위(기준선 0.45em 안)와 바로 아래(기준선 0.6~1.05em 아래 — 글 위가 막대에 붙는다)에 막대 가운데로 놓인 글이 둘 다
 * 있으면 분수다. 밑줄 아래 다음 줄은 기준선이 1.3em 넘게 아래라 걸리지 않는다. 분자·분모 아이템을 막대 자리 한 아이템으로
 * 접는다(기준선 = 막대 − 0.3em — 수식 앞뒤 "배출량 =" "× 10" 과 한 줄). 리터럴 `$` 이스케이프 뒤라 스팬 기호가 살아남는다.
 */

import type { LineSegment } from "./line-types.js"
import { sortLineByX, type NormItem } from "./text-line.js"
import { spaceGapThreshold } from "./cell-text.js"
import { toTex } from "../table/layout-frames.js"

/** 막대 최대 굵기 (pt) */
const BAR_MAX_WIDTH = 1
/** 분자 기준선이 막대 위로 떨어질 수 있는 거리 (글자 크기 배수) */
const NUM_ABOVE_EM = 0.45
/** 분모 기준선이 막대 아래로 떨어진 거리 범위 (글자 크기 배수) — 글 위(≈ 기준선 + 0.8em)가 막대 바로 아래 */
const DEN_BELOW_MIN_EM = 0.6
const DEN_BELOW_MAX_EM = 1.05
/** 분자·분모 가운데가 막대 가운데에서 벗어날 수 있는 거리 — 막대 길이 비율·최소 pt */
const CENTER_TOL_RATIO = 0.1
const CENTER_TOL_MIN = 2
/** 첨자 — 바탕 글보다 이만큼 작고 기준선이 위 */
const SCRIPT_SIZE_RATIO = 0.8
const SCRIPT_RISE_EM = 0.2
/** 막대가 분자·분모 양끝 밖으로 나가는 최소 길이 (pt) */
const BAR_PAD = 1
/** 분자·분모 글 상한 (공백 뺀 자) */
const PART_MAX_CHARS = 40
/** 분자·분모 한글 낱말 상한 */
const PART_MAX_WORDS = 3
/** 분자·분모 안 이웃 글 사이 틈 상한 (em) — 식 조각은 붙어 있고, 넓게 떨어진 글은 표 칸들이다. 연산자 글리프가 빠진 식 "기말자산가치 [−] 기초자산가치" 가 4.8em, 표 칸은 7.8em 부터 */
const PART_MAX_GAP_EM = 6
/** 괘선 판정 오차 (pt) */
const RULE_EPS = 2

/** 분자·분모 아이템을 x 순으로 이은 LaTeX — 틈이 공백 임계보다 크면 띄우고, 작고 올라간 조각은 ^{} */
function partTex(group: NormItem[]): string {
  const g = sortLineByX([...group])
  const size = Math.max(...g.map(i => i.fontSize))
  const base = Math.min(...g.filter(i => i.fontSize >= size * SCRIPT_SIZE_RATIO).map(i => i.y))
  let s = "", run = ""
  const flush = () => { if (run) s += toTex(run); run = "" }
  g.forEach((it, k) => {
    if (it.fontSize < size * SCRIPT_SIZE_RATIO && it.y - base >= size * SCRIPT_RISE_EM) { flush(); s += `^{${toTex(it.text)}}`; return }
    if (k && it.x - (g[k - 1].x + g[k - 1].w) > spaceGapThreshold(it.fontSize)) run += " "
    run += it.text
  })
  flush()
  return s
}

/**
 * 분수 막대를 찾아 분자·분모 아이템을 `$\frac{…}{…}$` 한 아이템으로 접는다.
 * @returns 접은 뒤 아이템 목록(제자리 아님)과 분수 막대로 쓴 선(밑줄·표 괘선 판정에서 뺀다)
 */
export function foldFractionBars(items: NormItem[], horizontals: LineSegment[], verticals: LineSegment[] = []): { items: NormItem[]; bars: Set<LineSegment> } {
  const bars = new Set<LineSegment>()
  const gone = new Set<NormItem>()
  const added: NormItem[] = []
  for (const bar of horizontals) {
    if (bar.lineWidth > BAR_MAX_WIDTH || Math.abs(bar.y2 - bar.y1) > BAR_MAX_WIDTH) continue
    const x1 = Math.min(bar.x1, bar.x2), x2 = Math.max(bar.x1, bar.x2), len = x2 - x1
    // 표 괘선이 아니다 — 세로선에 닿거나 가로지르는 선, 끝에서 다른 가로선이 이어지는 선(옆 칸 변), 같은 폭 선이 위아래에 또 있는 선(행 괘선)
    const y = bar.y1
    if (verticals.some(v => { const vx = v.x1, lo = Math.min(v.y1, v.y2) - RULE_EPS, hi = Math.max(v.y1, v.y2) + RULE_EPS; return vx >= x1 - RULE_EPS && vx <= x2 + RULE_EPS && y >= lo && y <= hi })) continue
    if (horizontals.some(h => h !== bar && Math.abs(h.y1 - y) <= RULE_EPS && (Math.abs(Math.min(h.x1, h.x2) - x2) <= RULE_EPS || Math.abs(Math.max(h.x1, h.x2) - x1) <= RULE_EPS))) continue
    if (horizontals.some(h => h !== bar && Math.abs(h.y1 - y) > RULE_EPS && Math.abs(h.y1 - y) < 60 && Math.abs(Math.min(h.x1, h.x2) - x1) <= RULE_EPS && Math.abs(Math.max(h.x1, h.x2) - x2) <= RULE_EPS)) continue
    const num: NormItem[] = [], den: NormItem[] = []
    for (const it of items) {
      if (gone.has(it) || it.isHidden || !it.text.trim() || it.x < x1 - CENTER_TOL_MIN || it.x + it.w > x2 + CENTER_TOL_MIN) continue
      const fs = it.fontSize || it.h
      const d = it.y - bar.y1
      if (d > 0 && d <= fs * NUM_ABOVE_EM) num.push(it)
      else if (-d >= fs * DEN_BELOW_MIN_EM && -d <= fs * DEN_BELOW_MAX_EM) den.push(it)
    }
    if (!num.length || !den.length) continue
    const fs = Math.max(...num.map(i => i.fontSize), ...den.map(i => i.fontSize))
    if (len < fs) continue
    // 분자 위첨자 — 작은 글자라 제 크기로 잰 창(0.45em)을 넘어 올라가 있다 ("｛(ln(배출수수질) − 변환평균｝²")
    for (const it of items) {
      if (gone.has(it) || num.includes(it) || den.includes(it) || !it.text.trim() || it.fontSize >= fs * SCRIPT_SIZE_RATIO) continue
      if (it.x >= x1 - CENTER_TOL_MIN && it.x + it.w <= x2 + CENTER_TOL_MIN && it.y - bar.y1 > 0 && it.y - bar.y1 <= fs * 0.9) num.push(it)
    }
    const lo = (g: NormItem[]) => Math.min(...g.map(i => i.x)), hi = (g: NormItem[]) => Math.max(...g.map(i => i.x + i.w))
    const c = (x1 + x2) / 2, tol = Math.max(CENTER_TOL_MIN, len * CENTER_TOL_RATIO)
    if (Math.abs((lo(num) + hi(num)) / 2 - c) > tol || Math.abs((lo(den) + hi(den)) / 2 - c) > tol) continue
    // 막대는 넓은 쪽 글을 덮는 길이다 — 글 몇 자 아래 그은 긴 선(서명란·빈칸 밑줄)은 분수가 아니다
    // 분자·분모는 식 조각이다 — 문장이 든 칸을 가로선이 가른 것과 가른다(보이지 않는 틀 표 분수와 같은 40자)
    const chars = (g: NormItem[]) => g.reduce((n, i) => n + i.text.replace(/\s+/g, "").length, 0)
    // 한글 낱말이 여럿 든 줄은 문장이다 — 식 안 한글은 이름 한두 낱말("할당 오염부하량"). 칸 안 가로선 위아래 두 문장(검정고시
    // 면제 과목 "장관이 정하는 바에 따라 …" / "1) ∙ 3년제 …")이 분수로 읽혔다
    const words = (g: NormItem[]) => {
      const o = sortLineByX([...g])
      const t = o.map((it, k) => (k && it.x - (o[k - 1].x + o[k - 1].w) > spaceGapThreshold(it.fontSize) ? " " : "") + it.text).join("")
      return t.split(/\s+/).filter(w => /[가-힣]/.test(w)).length
    }
    if (chars(num) > PART_MAX_CHARS || chars(den) > PART_MAX_CHARS || words(num) > PART_MAX_WORDS || words(den) > PART_MAX_WORDS) continue
    // 칸마다 떨어진 글(체크 상자 "[]" 여럿)을 한 식으로 묶지 않는다 — 세로 괘선 없는 표의 행 괘선이 분수 막대로 읽혔다(OCR 벤치 web051)
    const gapped = (g: NormItem[]) => { const o = sortLineByX([...g]); return o.some((it, k) => k > 0 && it.x - (o[k - 1].x + o[k - 1].w) > fs * PART_MAX_GAP_EM) }
    if (gapped(num) || gapped(den)) continue
    if (Math.max(hi(num) - lo(num), hi(den) - lo(den)) < len * 0.6) continue
    // 막대는 분자·분모 양끝 밖으로 조금 더 나간다(실측 왼쪽 4~6pt·오른쪽 2pt) — 글 끝에 딱 맞는 선은 밑줄이다(칸 안 개정 밑줄
    // "공공기록"이 다음 줄 "법령 및" 위 분수로 읽혔다)
    if (Math.min(lo(num), lo(den)) < x1 + BAR_PAD || Math.max(hi(num), hi(den)) > x2 - BAR_PAD) continue
    for (const it of [...num, ...den]) gone.add(it)
    const left = Math.min(x1, lo(num), lo(den)), right = Math.max(x2, hi(num), hi(den))
    const first = sortLineByX([...num])[0]
    added.push({ ...first, text: `$\\frac{${partTex(num)}}{${partTex(den)}}$`, x: left, w: right - left, y: Math.round(bar.y1 - fs * 0.3), h: fs, fontSize: fs, underline: false, strike: false })
    bars.add(bar)
  }
  return bars.size ? { items: items.filter(it => !gone.has(it)).concat(added), bars } : { items, bars }
}
