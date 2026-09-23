/**
 * 한 줄 강제·문단 압축 (v5) — 한컴 조판을 재현(실글꼴 폭·어절 줄바꿈)해 판정한다.
 *
 * 실측(서울 결재문서 □ 150건): 한 줄 95%, 장평 96/95·자간 -4/-5로 줄여 넣는 관행.
 * 폭은 font-metrics.ts 실측표(한글 2024 실렌더 본문 154줄 줄바꿈 전부 재현) — 표가 없는 글꼴만
 * 근사 클래스라 여유를 더 둔다.
 */

import { measureTextWidth, faceClassForGen, simulateWrap, type FaceClass } from "./text-metrics.js"

export interface FitResult {
  pt: number
  ratio: number
  spacing: number
  /** 마지막 조합으로도 한 줄에 못 담음 */
  overflow: boolean
}

const RATIOS = [100, 97, 95, 92, 90, 87, 85]
const SPACINGS = [0, -3, -5]

/** 가용폭 안전계수 — 실측 폭표면 반올림 여유만, 근사 클래스면 2~5% (종전 관측 오차) */
function safety(faceClass: FaceClass, approx: number): number {
  return faceClass.startsWith("font:") ? 0.995 : approx
}

/**
 * @param minPt    글자 크기 하한 — pt 와 같으면 크기는 줄이지 않는다(□ 항목: 형제끼리 크기가 달라 들쭉날쭉해 보이는 것 방지)
 * @param minRatio 장평 하한(기본 85) — □ 는 90 (실측 96/95 관행, 85 는 눈에 띄게 납작함)
 */
export function fitOneLine(text: string, font: string, pt: number, availHu: number, minPt: number = Math.max(pt - 3, 10), minRatio = 85): FitResult {
  const faceClass = faceClassForGen(font)
  const avail = availHu * safety(faceClass, 0.98)
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

/** 고아 줄·한 줄 근접용 압축 사다리 — 자간 -1…-12(실무 Shift+Alt+N 반복) → 장평 97~88 조합 */
const SQUEEZE: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = []
  for (let sp = -1; sp >= -12; sp--) out.push([100, sp])
  for (const r of [97, 95, 92, 90, 88]) for (let sp = 0; sp >= -12; sp--) out.push([r, sp])
  return out
})()

/** 양쪽 정렬 공백 한 칸이 원래 폭의 몇 배 넘게 늘어나면 "벌어진 줄"인가 (1.0 = 두 배) */
const LOOSE_LIMIT = 1.0

/**
 * 고아 줄 — 마지막 줄이 가용폭의 이 비율 이하. 종전 "한 줄 근접 122%"(글자 단위에선 둘째 줄 = 넘친 양)를
 * 어절 단위 조판에 맞춰 마지막 줄 길이로 판정한다(긴 어절이 통째로 넘어가 둘째 줄이 넉넉하면 고아가 아니다).
 */
const ORPHAN_RATIO = 0.22

/**
 * 조판 비용 — 벌어짐(두 배 초과분) + 고아 줄 + 압축량. 고아 줄 하나 = 압축 15%(실무 요청 관행: 고아 줄은
 * 자간·장평을 꽤 줄여서라도 올린다), 공백이 세 배로 벌어진 줄 하나 = 압축 10%.
 */
const ORPHAN_COST = 1.5
const COMPRESS_COST = 10

/**
 * 줄마다 양쪽 정렬로 공백이 늘어나는 정도 — (가용폭 − 자연폭) / (공백 수 × 공백폭), 마지막 줄 제외.
 * 공백 없는 줄은 글자 사이로 벌어지므로 여유를 반각 공백 1칸 기준으로 본다.
 */
function worstLooseness(text: string, starts: number[], firstW: number, contW: number, h: number, ratio: number, spacing: number, faceClass: FaceClass): number {
  const spaceW = 0.5 * h * (ratio / 100) * (1 + spacing / 100)
  let worst = 0
  for (let i = 0; i + 1 < starts.length; i++) {
    const seg = text.slice(starts[i], starts[i + 1]).replace(/ +$/, "")
    const slack = (i === 0 ? firstW : contW) - measureTextWidth(seg, h, ratio, { faceClass, spacingPct: spacing })
    const spaces = (seg.match(/ /g) ?? []).length
    worst = Math.max(worst, slack / (Math.max(spaces, 1) * spaceW))
  }
  return worst
}

/**
 * 문단 압축 결정 (본문·항목 문단) — 어절 줄바꿈(BREAK_WORD)으로 조판을 재현하고, 무압축과 압축 사다리
 * (자간 -1…-12 → 장평 97~88, 실무 Shift+Alt+N 관행) 가운데 조판 비용이 가장 낮은 조합을 고른다.
 * 비용 = 벌어진 줄(양쪽 정렬로 공백이 두 배 넘게 늘어나는 줄 — 긴 어절이 통째로 넘어간 자리)의 초과분
 *      + 고아 줄(마지막 줄 ≤ 가용폭 22%) + 압축량. 줄 수는 늘리지 않는다. 무압축이 최선이면 null.
 * @param minRatio 장평 하한 — 공문서 `autoFit.minRatio`(기본 90). 사다리에서 이보다 납작한 장평은 쓰지 않는다
 */
export function fitParagraph(text: string, font: string, pt: number, firstW: number, contW: number, minRatio = 88, orphanRatio = ORPHAN_RATIO): { ratio: number; spacing: number } | null {
  const faceClass = faceClassForGen(font)
  const h = pt * 100
  const k = safety(faceClass, 0.95)
  const f = firstW * k, c = contW * k
  let baseLines = 0
  let best: { r: number; sp: number; cost: number } | null = null
  for (const [r, sp] of [[100, 0] as [number, number], ...SQUEEZE.filter(([r]) => r >= minRatio)]) {
    const w = simulateWrap(text, f, c, h, r, "keep", { faceClass, spacingPct: sp })
    if (!best) { if (w.lines < 2) return null; baseLines = w.lines }
    if (w.lines > baseLines) continue
    const orphan = w.lines > 1 && w.lastLineWidth <= contW * orphanRatio
    const loose = worstLooseness(text, w.starts, f, c, h, r, sp, faceClass)
    const cost = Math.max(0, loose - LOOSE_LIMIT) + (orphan ? ORPHAN_COST : 0) + (1 - (r / 100) * (1 + sp / 100)) * COMPRESS_COST
    if (!best || cost < best.cost - 1e-9) best = { r, sp, cost }
  }
  return best && (best.r !== 100 || best.sp !== 0) ? { ratio: best.r, spacing: best.sp } : null
}
