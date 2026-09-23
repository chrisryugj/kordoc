/**
 * 중앙부처 업무보고 골격(v5, preset `ministry`) — 표지·목차·장 띠·절 띠·소제목 박스·항목 띠·요약박스·별첨 띠.
 *
 * 실측 근거: 재정경제부 「2차 업무보고 서면보고자료」(2026-07-15, A4 17쪽) PDF 를 PyMuPDF 로 글꼴·크기·색·
 * 도형(채움·선·좌표) 전수 덤프 — docs/gongmunseo-engine-spec.md (j)장. 1pt = 100 HWPUNIT.
 *
 *   표지   대외주의 빨강 박스(0.36pt, 74.7×22.4pt) 우상단 / 파란 바 #0C3DCA·#0A33A9 5.9pt 두 줄 사이 HY헤드라인M 32 / 날짜 24pt
 *   장 띠  본문폭×26.5pt, 세로 그라데이션 #D6EAFE→#FFF(원본은 →#D6EAFE 3색), 상·하 이중선 #0000FF, "Ⅰ. 제목" HY헤드라인M 16
 *   절 띠  [29.7×23.4pt #3057B9 0.4mm 검정 테두리 흰 숫자] [제목 하변 0.5mm, 폭=글폭] HY헤드라인M 15
 *   소제목 #203A7B 24.1pt 높이·폭=글폭, HY헤드라인M 15 흰 글자 ("1. 민생경제 안정화")
 *   항목 띠 본문폭×23.5pt #E8F7FC 상·하 0.4mm #00ACFF, "① (키워드) 제목" HY중고딕 15 — 키워드·강조 파랑
 *   요약박스 #FFF7CC 0.12mm 검정, ▪ 함초롬바탕 13(키워드 파랑 bold) / * 맑은 고딕 11
 *   별첨 띠 [61.3×26.3pt #0066FF "별 첨" HY헤드라인M 16 흰] [5.9pt] [제목 HY헤드라인M 16, 상·좌 0.12 / 하·우 0.4mm]
 *
 * 열폭·높이는 실측 pt 그대로(HWPUNIT ×100), 본문폭에 걸리는 것만 폭을 W 에 맞춘다.
 */

import { tc, para } from "./gen-gongmun-extra.js"
import { ftbl, host, type FrameCtx } from "./gen-frame-seoul.js"
import { generateRuns } from "./md-runs.js"
import { escapeXml, escapeTextXml, type BorderSide } from "./gen-ids.js"
import { fitOneLine } from "./fit-line.js"
import { markerLayout, markerRunXml } from "./gen-marker.js"
import { measureTextWidth, faceClassForGen, simulateWrap } from "./text-metrics.js"
import { inlineMapper } from "./style-registry.js"
import { circledNumber } from "../shared/numbering.js"

/** 실측 색·기하 (재경부 2차 업무보고) */
export const MINISTRY = {
  blue: "#0000FF",
  headFont: "HY헤드라인M",
  bandFont: "HY중고딕",
  bodyFont: "함초롬바탕",
  refFont: "맑은 고딕",
  cover: { barDark: "#0C3DCA", barLight: "#0A33A9", barH: 590, titleH: 9500, titlePt: 32, datePt: 24, labelW: 7470, labelH: 2240, labelPt: 14 },
  toc: { labelPt: 24, labelColor: "#000080", chapterPt: 17, subPt: 15, border: ["0.7 mm", "#999999"] as BorderSide },
  // 원본은 위·아래 #D6EAFE·가운데 흰 3색 그라데이션 — 한글 gradation 은 2색만 안전(gen-ids)해서 위→아래 2색으로
  chapter: { h: 2650, pt: 16, fill: ["#D6EAFE", "#FFFFFF"], line: ["0.5 mm", "#0000FF", "DOUBLE_SLIM"] as BorderSide },
  section: { numW: 2970, h: 2340, pt: 15, fill: "#3057B9", border: ["0.4 mm", "#000000"] as BorderSide, underline: ["0.5 mm", "#000000"] as BorderSide },
  subhead: { h: 2410, pt: 15, fill: "#203A7B" },
  item: { h: 2350, pt: 15, fill: "#E8F7FC", line: ["0.4 mm", "#00ACFF"] as BorderSide },
  summary: { fill: "#FFF7CC", pt: 13, refPt: 11 },
  attach: { labelW: 6130, gap: 590, h: 2630, pt: 16, fill: "#0066FF", thick: ["0.4 mm", "#000000"] as BorderSide },
} as const

const NONE = "none" as const

/** 선두 (키워드)·[키워드] — 실측: □ 뒤 파랑 bold, ㅇ 뒤 검정 bold, 9대 과제 [ ] 파랑 bold. 20자 이내 */
const KEYWORD_RE = /^(\([^()\n]{1,24}\)|\[[^[\]\n]{1,24}\])\s*/u

export interface KeywordRunStyle {
  font: string
  pt: number
  bold: boolean
  ratio?: number
  spacing?: number
  color?: string
}

/**
 * 부호 + (키워드) + 나머지 인라인 마크다운 → run XML.
 * keywordColor null 이면 키워드는 굵게만(ㅇ 단계), 문자열이면 그 색 굵게(□·띠·요약).
 * emphasisColor 는 **굵게** 의 색(항목 띠: 파랑).
 */
export function ministryRuns(marker: string, text: string, ctx: FrameCtx, base: KeywordRunStyle, keywordColor: string | null, emphasisColor?: string): string {
  const { reg } = ctx
  const baseId = reg.char(base)
  const mapper = inlineMapper(reg, base, emphasisColor)
  let out = marker ? `<hp:run charPrIDRef="${baseId}"><hp:t>${escapeTextXml(marker + " ")}</hp:t></hp:run>` : ""
  const m = KEYWORD_RE.exec(text)
  if (m) {
    const kw = reg.char({ ...base, bold: true, color: keywordColor ?? base.color })
    out += `<hp:run charPrIDRef="${kw}"><hp:t>${escapeTextXml(m[1] + " ")}</hp:t></hp:run>`
    text = text.slice(m[0].length)
  }
  return out + generateRuns(text, baseId, mapper)
}

/** 렌더 텍스트(강조 문법 제거) — 폭 계산용 */
function plain(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1").replace(/`([^`]+)`/g, "$1")
}

function textW(text: string, font: string, pt: number): number {
  return measureTextWidth(text, pt * 100, 100, { faceClass: faceClassForGen(font) })
}

// ─── 표지 ───────────────────────────────────────────

export interface MinistryCoverInput { title: string; date: string; org?: string; label?: string }

/**
 * 표지 — [대외주의 박스 우상단] → 빈 줄 → [파란 바 / 제목 HY헤드라인M 32 / 파란 바] → 빈 줄 → 날짜 24 → 기관명.
 * 실측 세로 배치: 라벨 y59.5, 바 y228.5·329.5, 날짜 y651 (본문 상단 y56.7 기준).
 */
export function buildMinistryCover(inp: MinistryCoverInput, ctx: FrameCtx): string[] {
  const { reg, bf } = ctx
  const c = MINISTRY.cover
  const out: string[] = []
  const blank = (pt = 15) => para("", reg.para({ align: "LEFT", lineSp: 145 }), reg.char({ font: MINISTRY.bodyFont, pt }))
  const center = reg.para({ align: "CENTER", lineSp: 130 })
  if (inp.label) {
    const red: BorderSide = ["0.12 mm", "#FF0000"]
    const box = bf.get({ t: red, b: red, l: red, r: red })
    const cL = reg.char({ font: MINISTRY.bodyFont, pt: c.labelPt, color: "#FF0000" })
    const cell = tc({ bf: box, row: 0, col: 0, w: c.labelW, h: c.labelH, paras: para(inp.label, center, cL) })
    out.push(host(ftbl([cell], c.labelW, c.labelH, 1), reg.para({ align: "RIGHT", lineSp: 100 }), cL))
  } else {
    out.push(blank())
  }
  for (let i = 0; i < 6; i++) out.push(blank())
  // 제목 표 — 바 두 줄은 본문폭(실측 476pt ≈ W−566), 제목칸 95pt
  const w = ctx.W - 566
  const barTop = bf.get({ t: NONE, b: NONE, l: NONE, r: NONE, fill: c.barDark })
  const barBot = bf.get({ t: NONE, b: NONE, l: NONE, r: NONE, fill: c.barLight })
  const fit = fitOneLine(inp.title, MINISTRY.headFont, c.titlePt, w - 800, 24)
  const cT = reg.char({ font: MINISTRY.headFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
  const c1 = reg.char({ font: MINISTRY.bodyFont, pt: 1 })
  const barP = reg.para({ align: "CENTER", lineSp: 70 })
  const rows = [
    tc({ bf: barTop, row: 0, col: 0, w, h: c.barH, paras: para("", barP, c1) }),
    tc({ bf: 1, row: 1, col: 0, w, h: c.titleH, paras: para(inp.title, center, cT), name: "__kordoc_h1" }),
    tc({ bf: barBot, row: 2, col: 0, w, h: c.barH, paras: para("", barP, c1) }),
  ]
  out.push(host(ftbl(rows, w, c.barH * 2 + c.titleH, 1), reg.para({ align: "CENTER", lineSp: 100 }), cT))
  for (let i = 0; i < 13; i++) out.push(blank())
  out.push(para(inp.date, center, reg.char({ font: MINISTRY.bodyFont, pt: c.datePt })))
  if (inp.org) {
    for (let i = 0; i < 3; i++) out.push(blank())
    out.push(para(inp.org, center, reg.char({ font: MINISTRY.headFont, pt: c.datePt })))
  }
  return out
}

// ─── 목차 ───────────────────────────────────────────

export interface MinistryTocChapter { title: string; subs: string[]; attach?: boolean }

/**
 * 목차 — 회색 테두리 박스 안에 "목  차"(HY헤드라인M 24 #000080) + "Ⅰ. 제목"(17) + "1. 절"(15) + "[별첨] 제목".
 * 원본 박스(둥근 모서리·탭)는 그림이라 테두리 표로 대신한다. 쪽번호는 조판 전에 알 수 없어 넣지 않는다.
 */
export function buildMinistryToc(chapters: MinistryTocChapter[], ctx: FrameCtx): string[] {
  const { reg, bf } = ctx
  const t = MINISTRY.toc
  const w = ctx.W - 1200
  const pad = 2000
  const cLabel = reg.char({ font: MINISTRY.headFont, pt: t.labelPt, color: t.labelColor })
  const cCh = reg.char({ font: MINISTRY.headFont, pt: t.chapterPt })
  const cSub = reg.char({ font: MINISTRY.headFont, pt: t.subPt })
  const pLabel = reg.para({ align: "LEFT", lineSp: 130, left: pad, before: 1200, after: 2400 })
  const pCh = reg.para({ align: "LEFT", lineSp: 130, left: pad, before: 2000 })
  const pSub = reg.para({ align: "LEFT", lineSp: 130, left: pad + 1400, before: 1200 })
  const paras: string[] = [para("목  차", pLabel, cLabel)]
  let h = 1200 + Math.round(t.labelPt * 130) + 2400
  let roman = 0
  for (const ch of chapters) {
    if (ch.attach) {
      paras.push(para(`[별첨] ${stripAttachPrefix(ch.title)}`, pCh, cCh))
    } else {
      roman++
      paras.push(para(`${romanOf(roman)}. ${ch.title}`, pCh, cCh))
    }
    h += 2000 + Math.round(t.chapterPt * 130)
    for (let i = 0; i < ch.subs.length; i++) {
      paras.push(para(`${i + 1}. ${ch.subs[i]}`, pSub, cSub))
      h += 1200 + Math.round(t.subPt * 130)
    }
  }
  // 실측 목차 박스는 쪽 높이의 82% — 항목이 적어도 박스는 쪽을 채운다(A4 본문 257mm 기준 220mm)
  h = Math.max(h + 3000, TOC_MIN_H)
  const box = bf.get({ t: t.border, b: t.border, l: t.border, r: t.border })
  const cell = tc({ bf: box, row: 0, col: 0, w, h, paras: paras.join(""), vAlign: "TOP", name: "__kordoc_toc" })
  const hostP = reg.para({ align: "CENTER", lineSp: 100 })
  return [host(ftbl([cell], w, h, 1), hostP, cCh, ` pageBreak="1"`)]
}

const TOC_MIN_H = 62000

/** "별첨"·"[별첨]"·"별 첨 :" 선두 표시 제거 */
export function stripAttachPrefix(title: string): string {
  return title.replace(/^\[?\s*별\s*첨\s*\]?\s*[:：]?\s*/u, "")
}

/** 로마숫자 Ⅰ~Ⅻ 단일 문자, 초과는 조합 */
export function romanOf(n: number): string {
  if (n >= 1 && n <= 12) return String.fromCodePoint(0x215f + n)
  const t: [number, string][] = [[10, "Ⅹ"], [9, "Ⅸ"], [5, "Ⅴ"], [4, "Ⅳ"], [1, "Ⅰ"]]
  let s = ""
  for (const [v, r] of t) while (n >= v) { s += r; n -= v }
  return s
}

// ─── 장 띠 (h2) ─────────────────────────────────────

export function buildMinistryChapterBand(roman: string, title: string, ctx: FrameCtx, before: number): { xml: string; overflow: boolean } {
  const { reg, bf } = ctx
  const c = MINISTRY.chapter
  const w = ctx.W
  const text = `${roman}. ${plain(title)}`
  const fit = fitOneLine(text, MINISTRY.headFont, c.pt, w - 1400, c.pt - 2)
  const band = bf.get({ t: c.line, b: c.line, l: NONE, r: NONE, fill: { gradient: [...c.fill], type: "LINEAR", angle: 90 } })
  const cT = reg.char({ font: MINISTRY.headFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
  const p = reg.para({ align: "LEFT", lineSp: 130, left: 500 })
  const cell = tc({ bf: band, row: 0, col: 0, w, h: c.h, paras: para(text, p, cT), name: "__kordoc_h2" })
  return { xml: host(ftbl([cell], w, c.h, 1, { bottomGap: 800 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cT), overflow: fit.overflow }
}

// ─── 절 띠 (h3) — 파란 숫자칸 + 밑줄 제목 ───────────

export function buildMinistrySectionBand(n: number, title: string, ctx: FrameCtx, before: number): string {
  const { reg, bf } = ctx
  const s = MINISTRY.section
  const t = plain(title)
  const titleW = Math.min(ctx.W - s.numW, Math.max(6000, textW(t, MINISTRY.headFont, s.pt) + 1600))
  const numBf = bf.get({ t: s.border, b: s.border, l: s.border, r: s.border, fill: s.fill })
  const titleBf = bf.get({ t: NONE, b: s.underline, l: NONE, r: NONE })
  const cNum = reg.char({ font: MINISTRY.headFont, pt: s.pt, color: "#FFFFFF" })
  const cT = reg.char({ font: MINISTRY.headFont, pt: s.pt })
  const center = reg.para({ align: "CENTER", lineSp: 130 })
  const left = reg.para({ align: "LEFT", lineSp: 130, left: 300 })
  const row = tc({ bf: numBf, row: 0, col: 0, w: s.numW, h: s.h, paras: para(String(n), center, cNum) })
    + tc({ bf: titleBf, row: 0, col: 1, w: titleW, h: s.h, paras: para(t, left, cT), name: "__kordoc_h3" })
  return host(ftbl([row], s.numW + titleW, s.h, 2, { bottomGap: 900 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cT)
}

// ─── 소제목 박스 (h4) — 남색 채움 흰 글자 ─────────────

export function buildMinistrySubheadBox(n: number, title: string, ctx: FrameCtx, before: number): string {
  const { reg, bf } = ctx
  const s = MINISTRY.subhead
  const text = `${n}. ${plain(title)}`
  const w = Math.min(ctx.W, textW(text, MINISTRY.headFont, s.pt) + 1400)
  const box = bf.get({ t: NONE, b: NONE, l: NONE, r: NONE, fill: s.fill })
  const cT = reg.char({ font: MINISTRY.headFont, pt: s.pt, color: "#FFFFFF" })
  const p = reg.para({ align: "LEFT", lineSp: 130, left: 400 })
  const cell = tc({ bf: box, row: 0, col: 0, w, h: s.h, paras: para(text, p, cT), name: "__kordoc_h4" })
  return host(ftbl([cell], w, s.h, 1, { bottomGap: 900 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cT)
}

// ─── 항목 띠 (h5) — 하늘색 띠 + ① ─────────────────────

export function buildMinistryItemBand(n: number, text: string, ctx: FrameCtx, before: number): string {
  const { reg, bf } = ctx
  const s = MINISTRY.item
  const w = ctx.W
  const band = bf.get({ t: s.line, b: s.line, l: NONE, r: NONE, fill: s.fill })
  const base: KeywordRunStyle = { font: MINISTRY.bandFont, pt: s.pt, bold: false }
  // 한 줄 초과 방어 — 원본 띠 글은 전부 한 줄. 넘치면 장평·자간만 줄인다(글꼴 크기 유지)
  const f = fitOneLine(plain(text), MINISTRY.bandFont, s.pt, w - 1800, s.pt)
  const styled = f.overflow || (f.ratio === 100 && f.spacing === 0) ? base : { ...base, ratio: f.ratio, spacing: f.spacing }
  const runs = ministryRuns(circledNumber(n - 1), text, ctx, styled, MINISTRY.blue, MINISTRY.blue)
  const p = reg.para({ align: "LEFT", lineSp: 130, left: 300 })
  const cell = tc({ bf: band, row: 0, col: 0, w, h: s.h, paras: `<hp:p paraPrIDRef="${p}" styleIDRef="0">${runs}</hp:p>`, name: "__kordoc_h5" })
  return host(ftbl([cell], w, s.h, 1, { bottomGap: 700 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), reg.char(base))
}

// ─── 요약박스 (인용문) ──────────────────────────────

/**
 * 연노랑 요약박스 — 줄마다 ▪ 함초롬바탕 13(선두 키워드 파랑 bold, **굵게** 검정 bold), `*`·※ 줄은 맑은 고딕 11 각주.
 * 실측: 박스 476×89.5pt(3줄 + 각주 1줄), 문단 좌우 여백 ≈ 3pt.
 */
export function buildMinistrySummaryBox(text: string, ctx: FrameCtx): string {
  const { reg, bf } = ctx
  const s = MINISTRY.summary
  const w = ctx.W - 600
  const avail = w - 280 - 600
  // ▪ 부호 + 탭(내어쓰기용 자동 탭) — 둘째 줄이 첫 줄 내용과 같은 x 에서 시작
  const lay = markerLayout(MINISTRY.bodyFont, s.pt, 0, "▪")
  const pItem = reg.para({ align: "LEFT", lineSp: 140, left: 300, right: 300, indent: -lay.hang, autoTab: true })
  const pRef = reg.para({ align: "LEFT", lineSp: 130, left: 300 + lay.hang, right: 300 })
  const baseItem: KeywordRunStyle = { font: MINISTRY.bodyFont, pt: s.pt, bold: false }
  const cRef = reg.char({ font: MINISTRY.refFont, pt: s.refPt })
  let h = 0
  const paras = text.split("\n").map((raw) => raw.trim()).filter(Boolean).map((line) => {
    const isRef = /^(\*|※)/.test(line)
    if (isRef) {
      h += Math.round(s.refPt * 100 * 1.3) * simulateWrap(line, avail - lay.hang, avail - lay.hang, s.refPt * 100, 100, "keep", { faceClass: faceClassForGen(MINISTRY.refFont) }).lines
      return `<hp:p paraPrIDRef="${pRef}" styleIDRef="0">${generateRuns(line, cRef, inlineMapper(reg, { font: MINISTRY.refFont, pt: s.refPt, bold: false }))}</hp:p>`
    }
    const body = line.replace(/^[▪■□○ㅇ●\-–ㆍ·•]\s*/u, "")
    h += Math.round(s.pt * 100 * 1.4) * simulateWrap(plain(body), avail - lay.hang, avail - lay.hang, s.pt * 100, 100, "keep", { faceClass: faceClassForGen(MINISTRY.bodyFont) }).lines
    return `<hp:p paraPrIDRef="${pItem}" styleIDRef="0">${markerRunXml("▪", reg.char(baseItem), lay)}${ministryRuns("", body, ctx, baseItem, MINISTRY.blue)}</hp:p>`
  })
  h += 280 + 600
  const box = bf.get({ t: "thin", b: "thin", l: "thin", r: "thin", fill: s.fill })
  const cell = tc({ bf: box, row: 0, col: 0, w, h, paras: paras.join(""), vAlign: "TOP", name: "__kordoc_summary" })
  return host(ftbl([cell], w, h, 1, { bottomGap: 900 }), reg.para({ align: "CENTER", lineSp: 100, before: 400 }), reg.char(baseItem))
}

// ─── 별첨 띠 (h2 "별첨 …") ──────────────────────────

export function buildMinistryAttachBand(title: string, ctx: FrameCtx, before: number): string {
  const { reg, bf } = ctx
  const a = MINISTRY.attach
  const w = ctx.W
  const titleW = w - a.labelW - a.gap
  const labelBf = bf.get({ t: "thin", b: a.thick, l: "thin", r: a.thick, fill: a.fill })
  const gapBf = bf.get({ t: NONE, b: NONE, l: NONE, r: NONE })
  const titleBf = bf.get({ t: "thin", b: a.thick, l: "thin", r: a.thick })
  const t = stripAttachPrefix(plain(title))
  const fit = fitOneLine(t, MINISTRY.headFont, a.pt, titleW - 800, a.pt - 3)
  const cLabel = reg.char({ font: MINISTRY.headFont, pt: a.pt, color: "#FFFFFF" })
  const cT = reg.char({ font: MINISTRY.headFont, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
  const center = reg.para({ align: "CENTER", lineSp: 130 })
  const row = tc({ bf: labelBf, row: 0, col: 0, w: a.labelW, h: a.h, paras: para("별 첨", center, cLabel) })
    + tc({ bf: gapBf, row: 0, col: 1, w: a.gap, h: a.h, paras: para("", center, cT) })
    + tc({ bf: titleBf, row: 0, col: 2, w: titleW, h: a.h, paras: para(t, center, cT), name: "__kordoc_h2" })
  return host(ftbl([row], w, a.h, 3, { bottomGap: 900 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cT)
}

/** h2 텍스트가 별첨 띠인지 — "별첨", "[별첨]", "별 첨 : …" */
export function isAttachHeading(text: string): boolean {
  return /^\[?\s*별\s*첨\s*\]?/u.test(text.trim())
}
