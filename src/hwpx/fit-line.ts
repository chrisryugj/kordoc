/**
 * 한 줄 강제 맞춤 (v5) — □ 대항목·제목·장 제목은 두 줄로 꺾이지 않는다.
 *
 * 실측(서울 결재문서 □ 150건): 한 줄 95%, 장평 96/95·자간 -4/-5로 줄여 넣는 관행.
 * 순서: 장평 100→95→90→85 (각 자간 0→-3→-5) → pt를 1씩 내리며 반복(하한 minPt) →
 * 그래도 넘치면 마지막 조합으로 두고 warning (호출부가 노출).
 */

import { measureTextWidth, faceClassForGen, simulateWrap } from "./text-metrics.js"

export interface FitResult {
  pt: number
  ratio: number
  spacing: number
  /** 마지막 조합으로도 한 줄에 못 담음 */
  overflow: boolean
}

const RATIOS = [100, 97, 95, 92, 90, 87, 85]
const SPACINGS = [0, -3, -5]

/**
 * @param minPt    글자 크기 하한 — pt 와 같으면 크기는 줄이지 않는다(□ 항목: 형제끼리 크기가 달라 들쭉날쭉해 보이는 것 방지)
 * @param minRatio 장평 하한(기본 85) — □ 는 90 (실측 96/95 관행, 85 는 눈에 띄게 납작함)
 */
export function fitOneLine(text: string, font: string, pt: number, availHu: number, minPt: number = Math.max(pt - 3, 10), minRatio = 85): FitResult {
  const faceClass = faceClassForGen(font)
  // 실측 폭 테이블은 함초롬 기준 — 굵은 견고딕 계열 실폭 여유 2%
  const avail = availHu * 0.98
  const fits = (p: number, r: number, s: number) => measureTextWidth(text, p * 100, r, { spacingPct: s, faceClass }) <= avail
  if (fits(pt, 100, 0)) return { pt, ratio: 100, spacing: 0, overflow: false }
  const ratios = RATIOS.filter((r) => r >= minRatio)
  for (let p = pt; p >= minPt; p--) {
    for (const r of ratios) for (const s of SPACINGS) {
      if (fits(p, r, s)) return { pt: p, ratio: r, spacing: s, overflow: false }
    }
  }
  return { pt: minPt, ratio: ratios[ratios.length - 1], spacing: SPACINGS[SPACINGS.length - 1], overflow: true }
}

/**
 * 고아 줄 축소 — 실무 관행(한글 Shift+Alt+N 자간 줄이기)의 자동화.
 *
 * 폭 테이블은 실렌더보다 2~4% 좁게 재므로("(서울 40.5%)" 꼬리가 실제론 둘째 줄로 넘어가는데 추정은
 * 한 줄) 목표 폭에 안전 여유를 둔다: 한 줄 추정폭이 가용폭의 90%를 넘고 122% 이하면(한두 어절 넘침)
 * 자간 -1%씩 → -12, 그래도 안 되면 장평 97~88 과 조합해 90% 이하로 만든다. 그 이상 긴 문단은
 * 글자 단위 시뮬레이션(가용폭 95% — v5 본문은 KEEP_WORD 글자 단위 조판)에서 둘째 줄이 orphanRatio(20%) 이내일 때만
 * 같은 방법으로 한 줄 줄인다.
 * 못 담으면 null(자연 줄바꿈).
 */
export function fitOrphanLine(text: string, font: string, pt: number, firstW: number, contW: number, orphanRatio = 0.2): { ratio: number; spacing: number } | null {
  const faceClass = faceClassForGen(font)
  const h = pt * 100
  // 폭 추정이 실렌더보다 2~5% 좁다 — 90% 넘으면 이미 실물에선 꼬리가 넘칠 수 있어 문턱·목표 모두 90%
  const SAFE = 0.9
  const width = (r: number, sp: number) => measureTextWidth(text, h, r, { faceClass, spacingPct: sp })
  const est = width(100, 0)
  if (est <= firstW * SAFE) return null
  // 자간 -1…-12(실무 Shift+Alt+N 반복 관행) → 장평 97~88 조합. 최대 0.88×0.88 ≈ 0.77 → 122% 넘침까지 커버
  const combos: Array<[number, number]> = []
  for (let sp = -1; sp >= -12; sp--) combos.push([100, sp])
  for (const r of [97, 95, 92, 90, 88]) for (let sp = 0; sp >= -12; sp--) combos.push([r, sp])
  if (est <= firstW * 1.22) {
    for (const [r, sp] of combos) if (width(r, sp) <= firstW * SAFE) return { ratio: r, spacing: sp }
    return null
  }
  const f = firstW * 0.95, c = contW * 0.95
  const base = simulateWrap(text, f, c, h, 100, "charAll", { faceClass })
  if (base.lines < 2 || base.lastLineWidth > c * orphanRatio) return null
  for (const [r, sp] of combos) {
    if (simulateWrap(text, f, c, h, r, "charAll", { faceClass, spacingPct: sp }).lines < base.lines) return { ratio: r, spacing: sp }
  }
  return null
}
