/**
 * 서울 실결재 골격 표(v5) — 기안문 두문표·결문표, 보고서 제목표·요약박스·결재선표·표지.
 *
 * 실측 근거(정보소통광장 결재문서본문, docs/gongmunseo-reference.md 2.8):
 *   두문표 6행×3열 w 49240: 슬로건(굴림 10) / [로고 6949 | 기관명 굴림 20b 자간띄움 | 7223] h5608 /
 *     간격 h1563 / 수신·(경유)·제목 라벨 굴림 14 + 값 14 (라벨열 6949), 제목행 하변 0.12mm만 테두리.
 *   결문표 w 49520: 발신명의 18b 행 / 수신자 / 회색 띠 #CCCCCC h1146 / 결재선(직위 10·성명 11b·일자 9b) /
 *     협조자 / 시행·접수 / 우·주소·홈페이지 / 전화·전송·이메일·공개구분 — 전부 굴림 10, 테두리 없음.
 *   보고서 제목표 w 48758: 제목 HY헤드라인M 25~27b(상 0.4mm·하 0.15mm) + 담당자 행 휴먼명조 12(하 0.4mm).
 *   요약박스 1×1 #DFE6F7 0.4mm, 한컴돋움 15b.  결재선표: 직위행 + 서명행(외곽 0.4·내부 0.12).
 * 열폭은 실측 비율을 본문폭에 맞춰 스케일한다(hwpx-skill 원칙: 좌표를 베끼지 말고 계산).
 */

import { tc, para } from "./gen-gongmun-extra.js"
import { TableBfRegistry } from "./gen-table-bf.js"
import { escapeXml, type BorderSide } from "./gen-ids.js"
import { StyleRegistry } from "./style-registry.js"
import { fitOneLine, fitParagraph } from "./fit-line.js"
import { simulateWrap, measureTextWidth, faceClassForGen } from "./text-metrics.js"
import { EXTRA_TABLE_ID_BASE } from "./geometry.js"
import type { FrameSpec } from "./gongmun-scheme.js"
import type { ResolvedGongmun } from "./gongmun.js"

let frameTableId = EXTRA_TABLE_ID_BASE + 500
export function resetFrameTableIds(): void { frameTableId = EXTRA_TABLE_ID_BASE + 500 }

const BF_NONE = 1

interface FrameCtx {
  reg: StyleRegistry
  bf: TableBfRegistry
  frame: FrameSpec
  /** 본문 폭 (HWPUNIT) */
  W: number
}

/** 골격표 — treatAsChar, 셀 여백 실측(140), outMargin 좌우 0 (gen-frame-ministry 도 같은 골격을 쓴다) */
export function ftbl(rows: string[], w: number, h: number, cols: number, opts: { bottomGap?: number; bf?: number } = {}): string {
  return `<hp:tbl id="${++frameTableId}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rows.length}" colCnt="${cols}" cellSpacing="0" borderFillIDRef="${opts.bf ?? BF_NONE}" noAdjust="1">`
    + `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="${opts.bottomGap ?? 0}"/>`
    + `<hp:inMargin left="140" right="140" top="140" bottom="140"/>`
    + rows.map((r) => `<hp:tr>${r}</hp:tr>`).join("")
    + `</hp:tbl>`
}

export function host(tableXml: string, paraPrId: number, charPrId: number, extra = ""): string {
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"${extra}><hp:run charPrIDRef="${charPrId}">${tableXml}</hp:run></hp:p>`
}

/** 실측 열폭 배열을 목표 폭으로 비례 스케일(합 = w, 마지막 열이 잔여 흡수) */
function scale(cols: number[], w: number): number[] {
  const sum = cols.reduce((a, b) => a + b, 0)
  const out = cols.map((c) => Math.round((c / sum) * w))
  out[out.length - 1] += w - out.reduce((a, b) => a + b, 0)
  return out
}

/** 기관명 자간 띄움 — 실결재 "종  로  소  방  서"(6자 이하, 공백 없는 기관명) */
export function spacedOrgName(org: string): string {
  const t = org.trim()
  if (/\s/.test(t) || [...t].length > 6) return t
  return [...t].join("  ")
}

// ─── 기안문 두문표 ─────────────────────────────────

export interface DocHeadInput { org?: string; slogan?: string; to?: string; via?: string; title?: string }

export function buildDocHeadTable(h: DocHeadInput, ctx: FrameCtx): string {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 366
  const [cLabel, cValue, cPad] = scale([6949, 35068, 7223], w)
  const center = reg.para({ align: "CENTER", lineSp: 160 })
  const left = reg.para({ align: "LEFT", lineSp: 160 })
  const c10 = reg.char({ font: frame.font, pt: 10 })
  const c10b = reg.char({ font: frame.font, pt: 10, bold: true })
  const c20b = reg.char({ font: frame.font, pt: 20, bold: true })
  const c14 = reg.char({ font: frame.font, pt: 14 })
  const bottomLine = bf.get({ t: "none", b: "thin", l: "none", r: "none" })
  const rows: string[] = []
  let r = 0
  if (h.slogan) {
    rows.push(tc({ bf: BF_NONE, row: r++, col: 0, w, h: 2416, colSpan: 3, paras: para(h.slogan, center, c10) }))
  }
  rows.push(
    tc({ bf: BF_NONE, row: r, col: 0, w: cLabel, h: 5608, paras: para("", center, c10) })
    + tc({ bf: BF_NONE, row: r, col: 1, w: cValue, h: 5608, paras: para(spacedOrgName(h.org ?? ""), center, c20b) })
    + tc({ bf: BF_NONE, row: r, col: 2, w: cPad, h: 5608, paras: para("", center, c10) }),
  )
  r++
  rows.push(tc({ bf: BF_NONE, row: r++, col: 0, w, h: 1563, colSpan: 3, paras: para("", left, c10b) }))
  const labeled = (label: string, value: string, height: number, bfId: number) =>
    tc({ bf: bfId, row: r, col: 0, w: cLabel, h: height, paras: para(label, left, c14) })
    + tc({ bf: bfId, row: r, col: 1, w: cValue + cPad, h: height, colSpan: 2, paras: para(value, left, c14) })
  rows.push(labeled(" 수신 ", h.to ?? "", 2097, BF_NONE)); r++
  rows.push(labeled("(경유)", h.via ?? "", 2380, BF_NONE)); r++
  rows.push(labeled(" 제목 ", h.title ?? "", 2248, bottomLine)); r++
  const height = rows.length === 6 ? 16312 : 13896
  return host(ftbl(rows, w, height, 3, { bottomGap: 852 }), reg.para({ align: "LEFT", lineSp: 100 }), c10)
}

// ─── 기안문 결문표 ─────────────────────────────────

export interface Approver { title: string; name: string; date?: string }
export interface DocFootInput {
  sender?: string
  approvers: Approver[]
  cooperators: Approver[]
  recipients?: string
  docNum?: string; receive?: string
  zip?: string; address?: string; site?: string
  phone?: string; fax?: string; email?: string; disclosure?: string
}

/** "주무관 홍길동" → {title, name} (마지막 어절이 성명) */
export function splitTitleName(s: string): Approver {
  const t = s.trim()
  const i = t.lastIndexOf(" ")
  return i > 0 ? { title: t.slice(0, i).trim(), name: t.slice(i + 1).trim() } : { title: "", name: t }
}

export function buildDocFootTable(f: DocFootInput, ctx: FrameCtx, internal: boolean): string {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 86
  // 공통 격자 — 실결재 결문표는 41열 미세 격자 위에 colSpan으로 행마다 다른 칸을 얹는다.
  // 행별로 임의 폭을 주면 한컴이 열 경계를 맞추다 표가 뒤틀린다(실렌더 확인) → 48열 격자.
  const GRID = 48
  const unit = Math.floor(w / GRID)
  const c10 = reg.char({ font: frame.font, pt: 10 })
  const c11b = reg.char({ font: frame.font, pt: 11, bold: true })
  const c9b = reg.char({ font: frame.font, pt: 9, bold: true })
  const c18b = reg.char({ font: frame.font, pt: 18, bold: true })
  const c3 = reg.char({ font: frame.font, pt: 3 })
  const center = reg.para({ align: "CENTER", lineSp: 100 })
  const left = reg.para({ align: "LEFT", lineSp: 100 })
  const gray = bf.get({ t: "none", b: "none", l: "none", r: "none", fill: "#CCCCCC" })
  /** 실측 폭 배열 → 격자 span 배열(합 GRID) */
  const spans = (widths: number[]): number[] => {
    const sum = widths.reduce((a, b) => a + b, 0)
    const out = widths.map((x) => Math.max(1, Math.round((x / sum) * GRID)))
    let diff = GRID - out.reduce((a, b) => a + b, 0)
    for (let i = out.length - 1; diff !== 0 && i >= 0; i = (i - 1 + out.length) % out.length) {
      if (diff > 0) { out[i]++; diff-- } else if (out[i] > 1) { out[i]--; diff++ }
    }
    return out
  }
  interface Spec { span: number; text: string; cp?: number; pp?: number; rowSpan?: number; bf?: number; vAlign?: "TOP" | "CENTER" | "BOTTOM" }
  const rows: string[] = []
  let r = 0
  /** 한 행 — span 합이 GRID가 되도록 마지막 칸이 잔여 흡수, 폭은 격자 단위×span(마지막은 w 잔여) */
  const row = (h: number, specs: Spec[]) => {
    let col = 0
    let xml = ""
    specs.forEach((sp, i) => {
      const last = i === specs.length - 1
      const span = last ? GRID - col : sp.span
      const cw = last ? w - col * unit : span * unit
      xml += tc({ bf: sp.bf ?? BF_NONE, row: r, col, w: cw, h, colSpan: span, rowSpan: sp.rowSpan, vAlign: sp.vAlign, paras: para(sp.text, sp.pp ?? left, sp.cp ?? c10) })
      col += span
    })
    rows.push(xml)
    r++
  }
  // 발신명의 (대외) — 내부결재는 빈 행 유지(실측 기하)
  {
    const [a, b, c] = spans([7981, 32099, 9440])
    row(4042, [{ span: a, text: "" }, { span: b, text: internal ? "" : (f.sender ?? ""), cp: c18b, pp: center }, { span: c, text: "" }])
  }
  if (f.recipients) {
    const [a] = spans([4843, 44677])
    row(2880, [{ span: a, text: "수신자", vAlign: "TOP" }, { span: GRID - a, text: f.recipients, vAlign: "TOP" }])
  } else {
    row(1280, [{ span: GRID, text: "" }])
  }
  row(1146, [{ span: GRID, text: "", cp: c3, pp: center, bf: gray }])
  // 결재선 — 직위(2행 병합) | 일자/성명, 실측 폭 6909/4625 + 칸 사이 983
  {
    const n = Math.max(f.approvers.length, 1)
    const unitW = [6909, 4625, 983]
    // 직위칸은 내용 폭으로 — 실측 6909(6자)는 최소값, 「스마트도시과장」(7자)은 넘친다 (hwpx-skill 원칙)
    // 격자 양자화(48열, 1칸≈1030)로 한 칸 깎일 수 있어 여백을 격자 한 칸 이상 준다 (「스마트도시과장」 7자 실렌더 꺾임)
    const titleW = (t: string) => Math.max(unitW[0], Math.round(measureTextWidth(t, 1000, 100, { faceClass: "fixedPitch" })) + 280 + unit + 300)
    const widths: number[] = []
    for (let i = 0; i < n; i++) { widths.push(titleW(f.approvers[i]?.title ?? ""), unitW[1]); if (i < n - 1) widths.push(unitW[2]) }
    const used = widths.reduce((a, b) => a + b, 0)
    if (used < w) widths.push(w - used)
    const sp = spans(widths)
    const top: Spec[] = [], bottom: Spec[] = []
    let k = 0
    for (let i = 0; i < n; i++) {
      const ap = f.approvers[i] ?? { title: "", name: "" }
      top.push({ span: sp[k++], text: ap.title, pp: center, rowSpan: 2 })
      const signSpan = sp[k++]
      top.push({ span: signSpan, text: ap.date ?? "", cp: c9b, pp: center })
      bottom.push({ span: signSpan, text: ap.name, cp: c11b, pp: center })
      if (i < n - 1) top.push({ span: sp[k++], text: "", rowSpan: 2 })
    }
    if (k < sp.length) top.push({ span: sp[k], text: "", rowSpan: 2 })
    // 두 행을 직접 조립 — 병합 셀은 위 행에만, 아래 행은 서명 칸만 (열 위치는 위 행과 동일)
    let col = 0, xmlTop = "", xmlBottom = ""
    let bi = 0
    top.forEach((s, i) => {
      const last = i === top.length - 1
      const span = last ? GRID - col : s.span
      const cw = last ? w - col * unit : span * unit
      xmlTop += tc({ bf: BF_NONE, row: r, col, w: cw, h: s.rowSpan ? 2198 : 1100, colSpan: span, rowSpan: s.rowSpan, paras: para(s.text, s.pp ?? left, s.cp ?? c10) })
      if (!s.rowSpan) { const b = bottom[bi++]; xmlBottom += tc({ bf: BF_NONE, row: r + 1, col, w: cw, h: 1098, colSpan: span, paras: para(b.text, b.pp ?? center, b.cp ?? c11b) }) }
      col += span
    })
    rows.push(xmlTop, xmlBottom); r += 2
  }
  // 협조자
  {
    const [a] = spans([4455, 45065])
    const coop = f.cooperators.map((c) => `${c.title} ${c.name}`.trim()).join("      ")
    row(2700, [{ span: a, text: "협조자" }, { span: GRID - a, text: coop }])
  }
  row(1400, [{ span: GRID, text: "" }])
  // 시행 / 접수
  {
    const [a, b, c] = spans([3340, 21532, 3301, 21347])
    row(2280, [{ span: a, text: "시행" }, { span: b, text: f.docNum ?? "" }, { span: c, text: "접수" }, { span: 0, text: f.receive ?? "" }])
  }
  // 우 우편번호 주소 / 홈페이지
  {
    const [a, b, c, d] = spans([1597, 3902, 21934, 761, 21326])
    row(1280, [{ span: a, text: "우" }, { span: b, text: f.zip ?? "" }, { span: c, text: f.address ?? "" }, { span: d, text: "/" }, { span: 0, text: f.site ?? "" }])
  }
  // 전화 / 전송 / 이메일 / 공개구분
  {
    const sp = spans([2750, 8006, 3196, 8311, 899, 14327, 792, 11239])
    const vals = ["전화", f.phone ?? "", "/전송", f.fax ?? "", "/", f.email ?? "", "/", f.disclosure ?? ""]
    row(2000, vals.map((v, i) => ({ span: sp[i], text: v })))
  }
  row(1000, [{ span: GRID, text: "" }])
  const height = rows.length * 1500
  return host(ftbl(rows, w, height, GRID), reg.para({ align: "LEFT", lineSp: 100 }), c10)
}

// ─── 보고서 제목표 ────────────────────────────────

export function buildReportTitleTable(title: string, contact: string | null, ctx: FrameCtx): { xml: string; overflow: boolean } {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 566
  const fit = fitOneLine(title, frame.titleFont, frame.titlePt, w - 2 * 140 - 400, 20)
  const cTitle = reg.char({ font: frame.titleFont, pt: fit.pt, bold: true, ratio: fit.ratio, spacing: fit.spacing })
  const center = reg.para({ align: "CENTER", lineSp: 130 })
  const rows: string[] = []
  const titleBf = bf.get({ t: "thick", b: contact ? "mid" : "thick", l: "none", r: "none" })
  rows.push(tc({ bf: titleBf, row: 0, col: 0, w, h: 4084, paras: para(title, center, cTitle), name: "__kordoc_h1" }))
  let h = 4084
  if (contact) {
    const cContact = reg.char({ font: frame.contactFont, pt: frame.contactPt })
    rows.push(tc({ bf: bf.get({ t: "mid", b: "thick", l: "none", r: "none" }), row: 1, col: 0, w, h: 1943, paras: para(contact, center, cContact) }))
    h += 1943
  }
  return { xml: host(ftbl(rows, w, h, 1, { bottomGap: 600 }), reg.para({ align: "CENTER", lineSp: 100 }), cTitle), overflow: fit.overflow }
}

// ─── 장 제목 띠 표 (h2Marker "band") ─────────────────
// 실측(2026-09-06): 계획서 장르에서 장 제목을 "1행 ≤3열 표, 첫 셀 채움 + 로마자 흰 글자" 로 쓰는 문서가
// 서울 plan 36.8%(7/19)·교육청 38.9%(7/18). 번호칸 폭 2,500~3,700 HU, 채움 짙은 파랑(#003366 최다),
// HY견고딕/HY헤드라인M 15~20 bold 흰색. 제목칸은 하변 룰. (docs/gongmunseo-reference.md 2.9)

export interface ChapterBandSpec {
  color: string
  textColor: string
  numFont: string
  numPt: number
  titleFont: string
  titlePt: number
}

export const CHAPTER_BAND_DEFAULT: Pick<ChapterBandSpec, "color" | "textColor" | "numFont" | "numPt"> = { color: "#003366", textColor: "#FFFFFF", numFont: "HY헤드라인M", numPt: 17 }

/** 번호칸 | 간격 | 제목칸(하변 0.4mm, `__kordoc_h2` 왕복 채널 — 파서가 heading 2로 복원) */
export function buildChapterBand(roman: string, title: string, ctx: FrameCtx, spec: ChapterBandSpec, before: number): { xml: string; overflow: boolean } {
  const { reg, bf } = ctx
  const w = ctx.W
  const numW = 3100, gap = 400, h = 2600
  const titleW = w - numW - gap
  const fit = fitOneLine(title, spec.titleFont, spec.titlePt, titleW - 700, spec.titlePt - 3)
  const numBf = bf.get({ t: "none", b: "none", l: "none", r: "none", fill: spec.color })
  const gapBf = bf.get({ t: "none", b: "none", l: "none", r: "none" })
  const titleBf = bf.get({ t: "none", b: "thick", l: "none", r: "none" })
  const cNum = reg.char({ font: spec.numFont, pt: spec.numPt, bold: true, color: spec.textColor })
  const cTitle = reg.char({ font: spec.titleFont, pt: fit.pt, bold: true, ratio: fit.ratio, spacing: fit.spacing })
  const center = reg.para({ align: "CENTER", lineSp: 130 })
  const left = reg.para({ align: "LEFT", lineSp: 130, left: 300 })
  const row = tc({ bf: numBf, row: 0, col: 0, w: numW, h, paras: para(roman, center, cNum), vAlign: "CENTER" })
    + tc({ bf: gapBf, row: 0, col: 1, w: gap, h, paras: para("", center, cNum), vAlign: "CENTER" })
    + tc({ bf: titleBf, row: 0, col: 2, w: titleW, h, paras: para(title, left, cTitle), name: "__kordoc_h2", vAlign: "CENTER" })
  return { xml: host(ftbl([row], w, h, 3, { bottomGap: 1000 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cTitle), overflow: fit.overflow }
}

// ─── 서울 방침서 골격 (bangchim) ───────────────────
// 정본 「청년취업사관학교 2.0」 추진계획(시장방침 제81호) 실측 — 제목표 2×1 w48758(제목칸 상 0.4·하 0.15mm / 담당칸 상 0.15·하 0.4mm),
// 제목 HY헤드라인M 26 굵게 가운데 100% + 부제 HY헤드라인M 18 굵게 파랑(#0000FF), 담당 휴먼명조 12 균등배분(왼쪽 300) 160%.
// 요약박스 1×1 w48758 셀 여백 566, 0.4mm #DFE6F7, 한컴돋움 15 굵게 균등배분(왼쪽 500) 140%.
// 장 상자 1×3 h3014: [번호 3223 — 0.5mm 네 변, HY견명조 19 굵게] [간격 1414 — 왼쪽 0.5mm] [제목 — 위아래 0.5mm, HY견고딕 20, 폭 = 글폭 + 여유]

const MM05: BorderSide = ["0.5 mm", "#000000"]
const BANGCHIM_BLUE = "#0000FF"

export function buildBangchimTitleTable(title: string, subtitle: string | null, contact: string | null, ctx: FrameCtx): { xml: string; overflow: boolean } {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 566
  const fit = fitOneLine(title, frame.titleFont, frame.titlePt, w - 2 * 141 - 400, 20)
  const cTitle = reg.char({ font: frame.titleFont, pt: fit.pt, bold: true, ratio: fit.ratio, spacing: fit.spacing })
  const center = reg.para({ align: "CENTER", lineSp: 100 })
  let paras = para(title, center, cTitle)
  let h = Math.round(fit.pt * 100) + 1400
  if (subtitle) {
    paras += para(subtitle, center, reg.char({ font: frame.titleFont, pt: 18, bold: true, color: BANGCHIM_BLUE }))
    h += 1800
  }
  const rows = [tc({ bf: bf.get({ t: "thick", b: contact ? "mid" : "thick", l: "none", r: "none" }), row: 0, col: 0, w, h, paras, name: "__kordoc_h1" })]
  if (contact) {
    const p = reg.para({ align: "DISTRIBUTE", lineSp: 160, left: 300 })
    rows.push(tc({ bf: bf.get({ t: "mid", b: "thick", l: "none", r: "none" }), row: 1, col: 0, w, h: 1482, paras: para(contact, p, reg.char({ font: frame.contactFont, pt: frame.contactPt })) }))
    h += 1482
  }
  return { xml: host(ftbl(rows, w, h, 1, { bottomGap: 600 }), reg.para({ align: "CENTER", lineSp: 100 }), cTitle), overflow: fit.overflow }
}

export function buildBangchimSummary(text: string, ctx: FrameCtx): { xml: string; lines: number } {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 566
  const pad = 566, left = 500
  const avail = w - 2 * pad - left
  const p = reg.para({ align: "DISTRIBUTE", lineSp: 140, left })
  const c = reg.char({ font: frame.summaryFont, pt: frame.summaryPt, bold: true })
  const bodies = text.split("\n").map((l) => l.trim().replace(/^[□■○ㅇ◦●\-–ㆍ·•]\s*/u, "")).filter(Boolean)
  let lines = 0
  for (const b of bodies) lines += simulateWrap(b, avail, avail, frame.summaryPt * 100, 100, "keep", { faceClass: faceClassForGen(frame.summaryFont) }).lines
  const h = lines * Math.round(frame.summaryPt * 100 * 1.4) + 2 * pad
  const row = tc({ bf: bf.get({ t: "thick", b: "thick", l: "thick", r: "thick", fill: frame.summaryFill }), row: 0, col: 0, w, h, paras: bodies.map((b) => para(b, p, c)).join(""), name: "__kordoc_summary" })
    .replace('<hp:cellMargin left="141" right="141" top="141" bottom="141"/>', `<hp:cellMargin left="${pad}" right="${pad}" top="${pad}" bottom="${pad}"/>`)
  return { xml: host(ftbl([row], w, h, 1, { bottomGap: 600 }), reg.para({ align: "CENTER", lineSp: 100 }), c), lines }
}

export function buildSquareChapter(label: string, title: string, ctx: FrameCtx, st: { font: string; pt: number }, before: number): { xml: string; overflow: boolean } {
  const { reg, bf } = ctx
  const numW = 3223, gapW = 1414, h = 3014
  const maxTitle = ctx.W - numW - gapW
  const fit = fitOneLine(title, st.font, st.pt, maxTitle - 1200, st.pt - 3)
  const textW = measureTextWidth(title, Math.round(fit.pt * 100), fit.ratio, { faceClass: faceClassForGen(st.font), spacingPct: fit.spacing })
  const titleW = Math.min(maxTitle, Math.max(14000, Math.round(textW) + 1200))
  // 번호칸 — 로마 숫자는 HY견명조 굵게(로마 8건 중 7), 아라비아 숫자·가나다는 제목칸과 같은 글꼴·크기(7건 중 6)
  const cNum = /^[Ⅰ-Ⅻ]+$/u.test(label) ? reg.char({ font: "HY견명조", pt: 19, bold: true }) : reg.char({ font: st.font, pt: st.pt })
  const cTitle = reg.char({ font: st.font, pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
  const center = reg.para({ align: "CENTER", lineSp: 150, left: 300 })
  const row = tc({ bf: bf.get({ t: MM05, b: MM05, l: MM05, r: MM05 }), row: 0, col: 0, w: numW, h, paras: para(label, center, cNum) })
    + tc({ bf: bf.get({ t: "none", b: "none", l: MM05, r: "none" }), row: 0, col: 1, w: gapW, h, paras: para("", reg.para({ align: "JUSTIFY", lineSp: 160 }), cTitle) })
    + tc({ bf: bf.get({ t: MM05, b: MM05, l: "none", r: "none" }), row: 0, col: 2, w: titleW, h, paras: para(title, center, cTitle), name: "__kordoc_h2" })
  const w = numW + gapW + titleW
  return { xml: host(ftbl([row], w, h, 3, { bottomGap: 600 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cTitle), overflow: fit.overflow }
}

/** 절 띠(h3) — [숫자칸 3400 #437FC1 아래 0.1mm #CCCCCC, HY견고딕 16 흰 글자] [간격 565] [제목칸 #E5E5E5, HY견고딕 17] h2551 */
export function buildBangchimSectionBand(n: number, title: string, ctx: FrameCtx, before: number): { xml: string; overflow: boolean } {
  const { reg, bf } = ctx
  const w = ctx.W - 720, numW = 3400, gapW = 565, h = 2551
  const titleW = w - numW - gapW
  const fit = fitOneLine(title, "HY견고딕", 17, titleW - 700, 14)
  const cNum = reg.char({ font: "HY견고딕", pt: 16, color: "#FFFFFF" })
  const cTitle = reg.char({ font: "HY견고딕", pt: fit.pt, ratio: fit.ratio, spacing: fit.spacing })
  const row = tc({ bf: bf.get({ t: "none", b: ["0.1 mm", "#CCCCCC"], l: "none", r: "none", fill: "#437FC1" }), row: 0, col: 0, w: numW, h, paras: para(String(n), reg.para({ align: "CENTER", lineSp: 160 }), cNum) })
    + tc({ bf: bf.get({ t: "none", b: "none", l: "none", r: "none" }), row: 0, col: 1, w: gapW, h, paras: para("", reg.para({ align: "CENTER", lineSp: 160 }), cNum) })
    + tc({ bf: bf.get({ t: "none", b: "none", l: "none", r: "none", fill: "#E5E5E5" }), row: 0, col: 2, w: titleW, h, paras: para(` ${title}`, reg.para({ align: "JUSTIFY", lineSp: 190 }), cTitle), name: "__kordoc_h3" })
  return { xml: host(ftbl([row], w, h, 3, { bottomGap: 600 }), reg.para({ align: "LEFT", lineSp: 100, before, keepWithNext: true }), cTitle), overflow: fit.overflow }
}

/** 과제 소제목(h4) — 원문자(❶, 원본은 한컴 PUA 원문자) 굵게 + 제목, HY견고딕 16 양쪽 200%. 번호는 장 안에서 이어진다 */
export function buildBangchimSubhead(n: number, title: string, ctx: FrameCtx, before: number): string {
  const { reg } = ctx
  const mark = n >= 1 && n <= 10 ? String.fromCodePoint(0x2775 + n) : `${n}.`
  const p = reg.para({ align: "JUSTIFY", lineSp: 200, before, keepWithNext: true })
  return `<hp:p paraPrIDRef="${p}" styleIDRef="0"><hp:run charPrIDRef="${reg.char({ font: "HY견고딕", pt: 16, bold: true })}"><hp:t>${escapeXml(mark)} </hp:t></hp:run>`
    + `<hp:run charPrIDRef="${reg.char({ font: "HY견고딕", pt: 16 })}"><hp:t>${escapeXml(title)}</hp:t></hp:run></hp:p>`
}

// ─── 요약 박스 ─────────────────────────────────────

/** 요약 문장 경계 — 한글·닫는 괄호 뒤 마침표·물음표·느낌표 다음에 글이 더 오면 (날짜 "9. 23." 은 숫자 뒤라 아님) */
const SENTENCE_END = /[가-힣)\]'’"”」』][.?!](?=\s+\S)/g
/** 목록 부호 "가. 나." — 문두·공백·쉼표 뒤 가나다 한 글자 + 마침표는 문장 끝이 아니다 */
const LIST_MARK = /(?:^|[\s,])[가나다라마바사아자차카타파하]$/

/**
 * 요약 상자 검사 — 보고 목적 한 문장(쉼표 허용) 3줄 이내. 실측(서울 실결재 제목 아래 요약 상자 53개): 3줄 이하 98%·
 * 2줄 75%, 한 문단 84%. 줄 수는 실글꼴 폭표 조판(호출부), 문장 수는 줄을 이은 글의 문장 경계 + 1
 */
export function summaryWarnings(text: string, lines: number): string[] {
  const out: string[] = []
  if (lines > 3) out.push(`요약박스가 ${lines}줄입니다 — 보고 목적을 한 문장(쉼표 허용) 3줄 이내 "…하고자 함"으로 줄이세요`)
  // 줄을 이어 센다 — 한 문장을 인용문 두 줄로 나눠 쓴 요약은 한 문장이다
  const flat = text.split("\n").map((l) => l.trim()).filter(Boolean).join(" ")
  const sentences = 1 + [...flat.matchAll(SENTENCE_END)].filter((m) => !LIST_MARK.test(flat.slice(0, m.index + 1))).length
  if (sentences > 1) out.push(`요약박스가 ${sentences}문장입니다 — 보고 목적을 한 문장(쉼표 허용) 3줄 이내 "…하고자 함"으로 묶으세요`)
  return out
}

/** 요약박스 문단 좌우 여백(HWPUNIT) — 실측 1000/1000 55% */
const SUMMARY_PAD = 1000

export function buildSummaryBox(text: string, ctx: FrameCtx): { xml: string; lines: number } {
  const { reg, bf, frame } = ctx
  const w = ctx.W - 566
  // 실측(요약박스 133건): 셀 여백은 141 이지만 문단 좌우 여백 1000/1000 이 55%(0/0 35%·2000 7%) — 글자가 테두리에
  // 붙지 않게 문단 여백으로 띄운다(선두 공백 0 이 53%라 종전 2칸 선두 공백은 뺀다). 줄바꿈은 본문과 같은 어절 단위.
  const avail = w - 280 - SUMMARY_PAD * 2
  const p = reg.para({ align: "JUSTIFY", lineSp: 160, left: SUMMARY_PAD, right: SUMMARY_PAD })
  // 요약은 한 문장(쉼표 허용) 3줄 이내 "…하고자 함" — 선두 □·ㅇ·- 부호는 벗긴다. 줄이 넘어오면 호출부가 경고.
  // 문장 꼬리 고아 줄("함" 한 글자)은 자간 축소로 끌어올린다
  const bodies = text.split("\n").map((l) => l.trim().replace(/^[□■○ㅇ◦●\-–ㆍ·•]\s*/u, "")).filter(Boolean)
  let lines = 0
  const paras = bodies.map((b) => {
    const f = fitParagraph(b, frame.summaryFont, frame.summaryPt, avail, avail)
    const c = reg.char({ font: frame.summaryFont, pt: frame.summaryPt, bold: true, ratio: f?.ratio ?? 100, spacing: f?.spacing ?? 0 })
    lines += simulateWrap(b, avail * 0.995, avail * 0.995, frame.summaryPt * 100, f?.ratio ?? 100, "keep", { faceClass: faceClassForGen(frame.summaryFont), spacingPct: f?.spacing ?? 0 }).lines
    return para(b, p, c)
  })
  const h = lines * Math.round(frame.summaryPt * 100 * 1.6) + 280 + 600
  const box = bf.get({ t: "thick", b: "thick", l: "thick", r: "thick", fill: frame.summaryFill })
  const row = tc({ bf: box, row: 0, col: 0, w, h, paras: paras.join(""), name: "__kordoc_summary" })
  return { xml: host(ftbl([row], w, h, 1, { bottomGap: 600 }), reg.para({ align: "CENTER", lineSp: 100 }), reg.char({ font: frame.summaryFont, pt: frame.summaryPt, bold: true })), lines }
}

// ─── 결재선표 (보고서 우상단) ─────────────────────

export function buildApprovalSeoul(labels: string[], names: string[] | null, ctx: FrameCtx): string {
  const { reg, bf } = ctx
  const n = labels.length
  const colW = Math.min(8600, Math.floor((ctx.W * 0.55) / n))
  const w = colW * n
  const c12 = reg.char({ font: "한컴돋움", pt: 12 })
  const c12b = reg.char({ font: "한컴돋움", pt: 12, bold: true })
  const center = reg.para({ align: "CENTER", lineSp: 100 })
  const edge = (row: number, col: number) => bf.get({
    t: row === 0 ? "thick" : "thin", b: row === 1 ? "thick" : "thin",
    l: col === 0 ? "thick" : "thin", r: col === n - 1 ? "thick" : "thin",
  })
  const top = labels.map((l, c) => tc({ bf: edge(0, c), row: 0, col: c, w: colW, h: 1765, paras: para(l, center, c12) })).join("")
  const sign = labels.map((_, c) => tc({ bf: edge(1, c), row: 1, col: c, w: colW, h: 4200, paras: para(names?.[c] ?? "", center, c12b) })).join("")
  return host(ftbl([top, sign], w, 5965, n, { bottomGap: 600 }), reg.para({ align: "RIGHT", lineSp: 100 }), c12)
}

// ─── 보고서 표지 (서울형) ──────────────────────────

export interface ReportCoverInput {
  title: string
  date: string
  org?: string
  dept?: string
  docInfo?: { docNum?: string; date?: string; disclosure?: string; policyNo?: string }
  approval?: string[]
}

/** 표지 — 좌 문서정보표·우 결재선표(양끝 배치) → 파랑 띠 제목 → 날짜 → 기관·부서명 */
export function buildReportCover(inp: ReportCoverInput, ctx: FrameCtx): string[] {
  const { reg, bf, frame } = ctx
  const out: string[] = []
  const cv = frame.cover
  const c12 = reg.char({ font: cv?.infoFont ?? "한컴돋움", pt: cv?.infoValuePt ?? 12 })
  const c12b = reg.char({ font: cv?.infoFont ?? "한컴돋움", pt: cv?.infoLabelPt ?? 12, bold: true })
  const cAppr = cv ? reg.char({ font: cv.infoFont, pt: cv.approvalPt }) : c12
  const center = reg.para({ align: "CENTER", lineSp: 100 })
  const centerAt = (k: keyof NonNullable<typeof cv>["lineSp"]) => (cv ? reg.para({ align: "CENTER", lineSp: cv.lineSp[k] }) : center)
  const blank = (pt = 15) => para("", reg.para({ align: "LEFT", lineSp: 160 }), reg.char({ font: "한컴돋움", pt }))
  // 문서정보표 (4×2)
  const infoRows = [["문서번호", inp.docInfo?.docNum ?? ""], ["결재일자", inp.docInfo?.date ?? ""], ["공개여부", inp.docInfo?.disclosure ?? ""], ["방침번호", inp.docInfo?.policyNo ?? ""]]
  const infoW = Math.round(ctx.W * 0.36)
  const [lw, vw] = scale([4200, 12800], infoW)
  const infoXml = ftbl(infoRows.map(([l, v], r) =>
    tc({ bf: bf.get({ t: r === 0 ? "thick" : "thin", b: r === 3 ? "thick" : "thin", l: "thick", r: "thin" }), row: r, col: 0, w: lw, h: 1850, paras: para(l, centerAt("info"), c12b) })
    + tc({ bf: bf.get({ t: r === 0 ? "thick" : "thin", b: r === 3 ? "thick" : "thin", l: "thin", r: "thick" }), row: r, col: 1, w: vw, h: 1850, paras: para(v, centerAt("info"), c12) }),
  ), infoW, 1850 * 4, 2)
  let line = infoXml
  if (inp.approval && inp.approval.length) {
    const n = inp.approval.length
    const colW = Math.min(7600, Math.floor((ctx.W * 0.5) / n))
    const edge = (row: number, col: number) => bf.get({ t: row === 0 ? "thick" : "thin", b: row === 1 ? "thick" : "thin", l: col === 0 ? "thick" : "thin", r: col === n - 1 ? "thick" : "thin" })
    const top = inp.approval.map((l, c) => tc({ bf: edge(0, c), row: 0, col: c, w: colW, h: 1765, paras: para(l, centerAt("approval"), cAppr) })).join("")
    const sign = inp.approval.map((_, c) => tc({ bf: edge(1, c), row: 1, col: c, w: colW, h: 3600, paras: para("", center, c12b) })).join("")
    line += `</hp:run><hp:run charPrIDRef="${c12}"><hp:t> </hp:t></hp:run><hp:run charPrIDRef="${c12}">` + ftbl([top, sign], colW * n, 5365, n)
  }
  out.push(`<hp:p paraPrIDRef="${reg.para({ align: "DISTRIBUTE", lineSp: 100 })}" styleIDRef="0"><hp:run charPrIDRef="${c12}">${line}</hp:run></hp:p>`)
  for (let i = 0; i < 4; i++) out.push(blank(20))
  // 파랑 띠 제목
  const w = ctx.W - 1200
  const bar = bf.get({ t: "none", b: "none", l: "none", r: "none", fill: cv ? { gradient: [...cv.bar.gradient], type: "LINEAR", angle: 90 } : "#1F2FD6" })
  const barH = cv?.bar.h ?? 200
  const fit = fitOneLine(inp.title, frame.titleFont, 27, w - 800, 22)
  const cT = reg.char({ font: frame.titleFont, pt: fit.pt, bold: true, ratio: fit.ratio, spacing: fit.spacing })
  const c1 = reg.char({ font: "한컴돋움", pt: 1 })
  const barP = reg.para({ align: "CENTER", lineSp: 70 })
  const rows = [
    tc({ bf: bar, row: 0, col: 0, w, h: barH, paras: para("", barP, c1) }),
    tc({ bf: BF_NONE, row: 1, col: 0, w, h: 6000, paras: para(inp.title, centerAt("title"), cT), name: "__kordoc_skip" }),
    tc({ bf: bar, row: 2, col: 0, w, h: barH, paras: para("", barP, c1) }),
  ]
  out.push(host(ftbl(rows, w, 6000 + 2 * barH, 1), reg.para({ align: "CENTER", lineSp: 100 }), cT))
  for (let i = 0; i < 2; i++) out.push(blank(20))
  out.push(para(inp.date, centerAt("date"), reg.char(cv ? cv.date : { font: frame.titleFont, pt: 22, bold: true })))
  for (let i = 0; i < 8; i++) out.push(blank(20))
  if (inp.org) out.push(para(spacedOrgName(inp.org), centerAt("org"), reg.char(cv ? cv.org : { font: frame.titleFont, pt: 24, bold: true })))
  if (inp.dept) out.push(para(`(${inp.dept.replace(/^\(|\)$/g, "")})`, centerAt("dept"), reg.char(cv ? cv.dept : { font: "한컴돋움", pt: 22, bold: true })))
  return out
}

export type { FrameCtx }
export { escapeXml }
