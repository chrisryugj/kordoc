/**
 * 공문서 위계 스킴 SSOT (v5, 2026-09-06) — 항목 단계별 부호·글꼴·크기·굵기·선행 타·줄간격.
 *
 * 실측 근거: 서울 정보소통광장 결재문서본문 코퍼스(bench/corpus seoul·seoul2·seoul-old·
 * gate-fill·gate-fill3·review + corpus-gen/opengov-2609, 629건 분류) 전수 디코드 — docs/gongmunseo-reference.md 2.8.
 *
 *   법정형(기안문 본문, 484건): 굴림체 12pt 160% / 1. 0타 · 가. 2타(70%) · 1) 4타 …(2타 계단)
 *   개조식형(보고서·계획서·개조식 기안문, 145건):
 *     □ HY견고딕 17 bold 0타 (한 줄 95%)  · ㅇ 한컴돋움 15 bold 1타(66%) · - 휴먼명조 14 3타(53%)
 *     ㆍ 휴먼명조 14 4타 · ※ 한컴돋움 14 · 소제목(가.) 한컴돋움 13 · 표 한컴돋움 12 헤더 #DFE6F7
 *
 * "타" = 반각 1자 = 그 단계 글자 크기의 절반(HWPUNIT = pt×50). 내어쓰기(둘째 줄 정렬)는
 * 부호 실폭 + 1타 — 편람 규정. 실결재는 선행 공백으로 들여쓰지만 시각 결과는 동일하다.
 *
 * 이 모듈은 순수 값/함수만 담는다. XML 조립은 gen-gongmun.ts.
 */

import type { Bullet2, GongmunOptions, ResolvedGongmun } from "./gongmun.js"
import { markerWidth, standardMarker } from "./gongmun.js"

export type SchemeKind = "legal" | "gaejosik"

/** 한 단계(또는 역할)의 타이포 */
export interface LevelStyle {
  font: string
  pt: number
  bold: boolean
  /** 선행 들여쓰기(타) — 부호가 시작하는 위치. 1타 = pt×50 HWPUNIT */
  leadTa: number
  /** 줄간격(%) — 미지정이면 문서 기본 */
  lineSp?: number
  /** 한 줄 강제(□·제목류) — 넘치면 장평→자간→pt 축소 */
  oneLine?: boolean
  /** 다음 문단과 같은 쪽 (쪽 하단 고아 표제 방지) */
  keepWithNext?: boolean
  /** 앞에 빈 줄 한 줄(실결재 □ 74%) */
  blankBefore?: boolean
  /** 문단 정렬 — 미지정이면 양쪽 */
  align?: "LEFT" | "JUSTIFY"
}

export interface TableStyleSpec {
  font: string
  pt: number
  headerFill: string
  labelFill: string
}

export interface FrameSpec {
  /** 두문·결문·결재선·제목표 공통 글꼴 */
  font: string
  /** 보고서 제목표 제목 글꼴/크기 */
  titleFont: string
  titlePt: number
  /** 보고서 담당자 연락처 행 */
  contactFont: string
  contactPt: number
  /** 요약 박스 */
  summaryFont: string
  summaryPt: number
  summaryFill: string
  /** 간이기안 표지 — 없으면 서울 보고서 기본(문서정보 한컴돋움 12·단색 파랑 띠·날짜 22b·기관 24b·부서 한컴돋움 22b) */
  cover?: CoverSpec
}

export interface CoverSpec {
  /** 문서정보표·결재선표 글꼴과 크기(이름칸·값칸·결재선) */
  infoFont: string
  infoLabelPt: number
  infoValuePt: number
  approvalPt: number
  /** 제목 위아래 띠 — 2색 세로 그라데이션, 높이(HWPUNIT) */
  bar: { gradient: [string, string]; h: number }
  date: { font: string; pt: number; bold: boolean }
  org: { font: string; pt: number; bold: boolean }
  dept: { font: string; pt: number; bold: boolean }
  /** 문단 줄간격(%) — 문서정보·결재선·제목·날짜·기관·부서 */
  lineSp: { info: number; approval: number; title: number; date: number; org: number; dept: number }
}

export interface Scheme {
  kind: SchemeKind
  /** 본문(서술 문단) 기본 */
  body: LevelStyle
  /** 항목 단계 0~7 */
  levels: LevelStyle[]
  /** ※ 참고 */
  ref: LevelStyle
  /** 개조식 문서 안의 법정 부호 소제목(가. 기술인력) — legal 스킴은 levels가 담당 */
  sub: LevelStyle
  /** 붙임 */
  attach: LevelStyle
  /** 장 제목(h2) — "Ⅰ. 제목" */
  chapter: LevelStyle
  /** 문서 기본 줄간격(%) */
  lineSp: number
  /** 마커 문자열 (depth, 형제순번) */
  marker: (depth: number, n: number) => string
  table: TableStyleSpec
  frame: FrameSpec
  /** 최상위 항목(1.) 사이 빈 줄 — 법정형 실측 27%라 기본 false */
  blankBetweenTop: boolean
}

export const SEOUL_FRAME: FrameSpec = {
  font: "굴림체",
  titleFont: "HY헤드라인M", titlePt: 25,
  contactFont: "휴먼명조", contactPt: 12,
  summaryFont: "한컴돋움", summaryPt: 15, summaryFill: "#DFE6F7",
}

export const SEOUL_TABLE: TableStyleSpec = { font: "한컴돋움", pt: 12, headerFill: "#DFE6F7", labelFill: "#F2F2F2" }

/** 개조식 부호 — bullet2로 2단계 ㅇ/○ 전환 */
export function gaejosikMarkerOf(bullet2: Bullet2): Scheme["marker"] {
  return (depth) => (depth === 0 ? "□" : depth === 1 ? bullet2 : depth === 2 ? "-" : "ㆍ")
}

/**
 * 서울 실측 개조식 스킴. bodyPt는 ㅇ(중항목) 크기 기준(실측 15) — 다른 단계는 실측 차이만큼 이동.
 */
export function seoulGaejosikScheme(bodyPt = 15, lineSp = 180, bullet2: Bullet2 = "ㅇ"): Scheme {
  const d = bodyPt - 15
  const lv = (font: string, pt: number, bold: boolean, leadTa: number, extra: Partial<LevelStyle> = {}): LevelStyle =>
    ({ font, pt: pt + d, bold, leadTa, ...extra })
  return {
    kind: "gaejosik",
    lineSp,
    body: lv("한컴돋움", 15, false, 0),
    levels: [
      lv("HY견고딕", 17, true, 0, { oneLine: true, keepWithNext: true, blankBefore: true }),
      lv("한컴돋움", 15, true, 1),
      lv("휴먼명조", 14, false, 3),
      lv("휴먼명조", 14, false, 4),
      lv("휴먼명조", 14, false, 5),
      lv("휴먼명조", 14, false, 6),
      lv("휴먼명조", 14, false, 7),
      lv("휴먼명조", 14, false, 8),
    ],
    // ※·출처는 본문보다 작게(실측 14~15 혼재, 실무자 요청으로 13 — 한 단계 아래로 확실히 구분)
    ref: lv("한컴돋움", 13, false, 0),
    sub: lv("한컴돋움", 13, false, 2),
    attach: lv("한컴돋움", 15, false, 0),
    chapter: lv("HY헤드라인M", 20, false, 0, { oneLine: true, keepWithNext: true }),
    marker: gaejosikMarkerOf(bullet2),
    table: { ...SEOUL_TABLE, pt: SEOUL_TABLE.pt + d },
    frame: SEOUL_FRAME,
    blankBetweenTop: false,
  }
}

/**
 * 중앙부처 업무보고 스킴 — 재경부 「2차 업무보고 서면보고자료」(2026-07-15, 17쪽) PDF 전수 실측
 * (docs/gongmunseo-engine-spec.md (j)장):
 *   □·ㅇ·- 함초롬바탕 15 regular(강조만 bold, □ 뒤 괄호 키워드 bold #0000FF) · 줄피치 21.7pt ≈ 145%
 *   ㅇ 1타(둘째 줄 x86.6 = 30pt) · - 3타(둘째 줄 x95.5) · * 각주 맑은 고딕 12 · 표 맑은 고딕 12/11.5 헤더 #DFE6F7
 *   장 띠 HY헤드라인M 16 · 절 숫자칸/소제목 박스 HY헤드라인M 15 · ① 항목 띠 HY중고딕 15(원본 HaanYGodic24)
 *   요약박스 #FFF7CC 함초롬바탕 13 · 표지 HY헤드라인M 32 / 날짜 24
 * 서울 개조식(HY견고딕 17 bold □)과 달리 부호 단계의 글꼴·크기가 전부 같고 색으로 위계를 낸다.
 */
export const MINISTRY_FRAME: FrameSpec = {
  font: "함초롬바탕",
  titleFont: "HY헤드라인M", titlePt: 32,
  contactFont: "함초롬바탕", contactPt: 12,
  summaryFont: "함초롬바탕", summaryPt: 13, summaryFill: "#FFF7CC",
}

export function ministryScheme(bodyPt = 15, lineSp = 145): Scheme {
  const d = bodyPt - 15
  const lv = (font: string, pt: number, bold: boolean, leadTa: number, extra: Partial<LevelStyle> = {}): LevelStyle =>
    ({ font, pt: pt + d, bold, leadTa, ...extra })
  return {
    kind: "gaejosik",
    lineSp,
    body: lv("함초롬바탕", 15, false, 0),
    levels: [
      // □ 는 한 줄 강제 안 함 — 실측 □ 문장의 절반이 두 줄(pg3·pg6). 앞 빈 줄은 스킴 공통 로직(BOX_BLANK_HU)
      lv("함초롬바탕", 15, false, 0, { keepWithNext: true, blankBefore: true }),
      lv("함초롬바탕", 15, false, 1),
      lv("함초롬바탕", 15, false, 3),
      lv("함초롬바탕", 15, false, 4),
      lv("함초롬바탕", 15, false, 5),
      lv("함초롬바탕", 15, false, 6),
      lv("함초롬바탕", 15, false, 7),
      lv("함초롬바탕", 15, false, 8),
    ],
    // * 각주 — 맑은 고딕 12(n=124), 선두 4칸 공백 ≈ ㅇ 본문 시작(x80)에 맞춘다
    ref: lv("맑은 고딕", 12, false, 3),
    sub: lv("함초롬바탕", 15, false, 2),
    attach: lv("함초롬바탕", 15, false, 0),
    chapter: lv("HY헤드라인M", 16, false, 0, { oneLine: true, keepWithNext: true }),
    marker: (depth) => (depth === 0 ? "□" : depth === 1 ? "ㅇ" : depth === 2 ? "-" : "ㆍ"),
    table: { font: "맑은 고딕", pt: 12 + d, headerFill: "#DFE6F7", labelFill: "#F2F2F2" },
    frame: MINISTRY_FRAME,
    blankBetweenTop: false,
  }
}

/**
 * 서울 방침서 스킴 — 시장방침 편집형 계획서 정답지 5건(정보소통광장, bench/corpus-gen/seoul-bangchim) 실측, 정본
 * 「청년취업사관학교 2.0」 추진계획(서울특별시장 제81호) 역할별 최빈값:
 *   □ HY견고딕 17 보통 · 양쪽 / ㅇ 한컴돋움 15 굵게 · 양쪽 / - 휴먼명조 14 · 양쪽 /
 *   ▸ 한컴돋움 13 · 왼쪽 180% / ※ 한컴돋움 13 · 왼쪽 / 서술 문단 HY견고딕 16 굵게.
 * 글꼴·크기는 같은 폴더 방침서 16건의 문서별 최빈값과도 같다(□ 15건 중 14·ㅇ 14건 중 13·- 14건 중 11·※ 12건 중 7).
 * 줄간격·정렬은 쪽 맞춤 손조정이라 문서 안에서도 20~70% 만 최빈값이고 문서마다 다르다 — 16건 문서별 최빈값 표로
 * 정했다: 줄간격 190%(□ 5·ㅇ 4·- 3건, 정본의 200% 는 □ 1건), ㅇ 양쪽(15건 중 11, 정본은 왼쪽).
 */
export const BANGCHIM_FRAME: FrameSpec = {
  font: "한컴돋움",
  titleFont: "HY헤드라인M", titlePt: 26,
  contactFont: "휴먼명조", contactPt: 12,
  summaryFont: "한컴돋움", summaryPt: 15, summaryFill: "#DFE6F7",
  // 간이기안 표지 — 방침서 16건: 문서정보 굴림체(16건) 이름칸 10 굵게(11건)·값칸 9, 결재선 굴림체 9(15건 중 11)·8,
  // 제목 띠 그라데이션 #3057B9→#A0B4E6(15건) 높이 663(11건), 날짜 HY견명조 21b(13건), 기관 HY헤드라인M 26b(11건), 부서 HY견명조 22(14건 중 12)
  cover: {
    infoFont: "굴림체", infoLabelPt: 10, infoValuePt: 9, approvalPt: 9,
    bar: { gradient: ["#3057B9", "#A0B4E6"], h: 663 },
    date: { font: "HY견명조", pt: 21, bold: true },
    org: { font: "HY헤드라인M", pt: 26, bold: true },
    dept: { font: "HY견명조", pt: 22, bold: false },
    // 줄간격 — 문서정보 160(16건)·결재선 130(16건)·제목 120(최다 5건)·날짜 170(11)·기관 170(12)·부서 190(11)
    lineSp: { info: 160, approval: 130, title: 120, date: 170, org: 170, dept: 190 },
  },
}

export function seoulBangchimScheme(bodyPt = 15, lineSp = 190): Scheme {
  const d = bodyPt - 15
  const lv = (font: string, pt: number, bold: boolean, leadTa: number, extra: Partial<LevelStyle> = {}): LevelStyle =>
    ({ font, pt: pt + d, bold, leadTa, ...extra })
  return {
    kind: "gaejosik",
    lineSp,
    body: lv("HY견고딕", 16, true, 0),
    levels: [
      lv("HY견고딕", 17, false, 0, { oneLine: true, keepWithNext: true, blankBefore: true }),
      lv("한컴돋움", 15, true, 1),
      lv("휴먼명조", 14, false, 3),
      lv("한컴돋움", 13, false, 4, { align: "LEFT", lineSp: 180 }),
      lv("한컴돋움", 13, false, 5, { align: "LEFT", lineSp: 180 }),
      lv("한컴돋움", 13, false, 6, { align: "LEFT", lineSp: 180 }),
      lv("한컴돋움", 13, false, 7, { align: "LEFT", lineSp: 180 }),
      lv("한컴돋움", 13, false, 8, { align: "LEFT", lineSp: 180 }),
    ],
    ref: lv("한컴돋움", 13, false, 0, { align: "LEFT" }),
    sub: lv("한컴돋움", 13, false, 2),
    attach: lv("한컴돋움", 15, true, 0),
    chapter: lv("HY견고딕", 20, false, 0, { oneLine: true, keepWithNext: true }),
    marker: (depth) => (depth === 0 ? "□" : depth === 1 ? "ㅇ" : depth === 2 ? "-" : "▸"),
    table: { ...SEOUL_TABLE, pt: SEOUL_TABLE.pt + d },
    frame: BANGCHIM_FRAME,
    blankBetweenTop: false,
  }
}

/**
 * 방침서 숫자 위계 — 「제3차 서울 청년정책 기본계획」(35530133) 실측: 1. HY견고딕 17(50건 중 38)·1) 한컴돋움 15 굵게(123건 중 112)·
 * ① 휴먼명조 14(94건 중 76)·① 아래 - 휴먼명조 14(25건 모두). □ㅇ- 단계와 글꼴·크기가 같고 부호만 다르며, 넷째 단계는 ▸ 한컴돋움 13 이
 * 아니라 - 휴먼명조 14 다. 선두 공백 0·1·2·4칸 → 들여쓰기 0·1·2·4타.
 */
export function bangchimNumbered(s: Scheme): Scheme {
  const levels = s.levels.map((l) => ({ ...l }))
  levels[2] = { ...levels[2], leadTa: 2 }
  levels[3] = { ...levels[2], leadTa: 4 }
  return { ...s, levels, marker: (depth, n) => (depth >= 2 ? "-" : s.marker(depth, n)) }
}

/** 서울 실측 법정형(기안문 본문) 스킴 — 전 단계 본문 글꼴·크기 동일, 2타 계단 */
export function seoulLegalScheme(bodyFont = "굴림체", bodyPt = 12, lineSp = 160): Scheme {
  const lv = (leadTa: number, extra: Partial<LevelStyle> = {}): LevelStyle => ({ font: bodyFont, pt: bodyPt, bold: false, leadTa, ...extra })
  return {
    kind: "legal",
    lineSp,
    body: lv(0),
    levels: [0, 2, 4, 6, 8, 10, 12, 14].map((t) => lv(t)),
    ref: lv(0),
    sub: lv(2),
    attach: lv(0),
    chapter: { font: bodyFont, pt: bodyPt + 2, bold: true, leadTa: 0, keepWithNext: true },
    marker: (depth, n) => standardMarker(depth, n),
    table: { ...SEOUL_TABLE, pt: Math.min(SEOUL_TABLE.pt, bodyPt) },
    frame: SEOUL_FRAME,
    blankBetweenTop: false,
  }
}

/** 옵션(levels·fonts) 오버레이 — 지정한 단계·역할만 바꾼다 */
export function applySchemeOverrides(s: Scheme, g: ResolvedGongmun): Scheme {
  const out: Scheme = { ...s, levels: s.levels.map((l) => ({ ...l })), body: { ...s.body }, ref: { ...s.ref }, table: { ...s.table } }
  // 기관 서식의 ※·표 크기와 표 머리 음영 (글꼴·단계는 옵션으로 이미 깔렸다 — agency.ts)
  if (g.agency?.refPt) out.ref.pt = g.agency.refPt
  if (g.agency?.table) { if (g.agency.table.pt) out.table.pt = g.agency.table.pt; out.table.headerFill = g.agency.table.headerFill }
  if (g.fonts.heading) { out.levels[0].font = g.fonts.heading; out.chapter = { ...out.chapter, font: g.fonts.heading } }
  if (g.fonts.body) { out.body.font = g.fonts.body; if (s.kind === "legal") for (const l of out.levels) l.font = g.fonts.body; else out.levels[1].font = g.fonts.body }
  if (g.fonts.ref) out.ref.font = g.fonts.ref
  if (g.fonts.table) out.table.font = g.fonts.table
  if (g.levels) {
    for (const [k, st] of Object.entries(g.levels)) {
      const l = out.levels[Number(k)]
      if (!l) continue
      if (st.font) l.font = st.font
      // pt 미지정(resolveLevels 가 프리셋 bodyHeight 로 채움)이면 스킴 단계 크기 유지 — 프리셋 bodyPt(통지 15)와
      // v5 스킴 기본(법정 12)이 다를 때 15pt 로 튀지 않게
      if (st.height !== g.bodyHeight) l.pt = st.height / 100
      l.bold = st.bold
    }
  }
  return out
}

/** 1타(HWPUNIT) — 그 글자 크기의 반각 */
export function taHu(pt: number): number { return Math.round(pt * 50) }

/** 단계 들여쓰기 — left(부호 시작), indent(음수 내어쓰기 = 부호폭+1타) */
export function levelGeometry(style: LevelStyle, marker: string): { left: number; indent: number } {
  const left = style.leadTa * taHu(style.pt)
  const indent = marker ? -markerWidth(marker, style.pt * 100) : 0
  return { left, indent }
}

/** 스킴 선택 — 옵션·프리셋·본문 부호 자동감지 */
export function pickScheme(g: ResolvedGongmun, bodyHasBoxMarkers: boolean, numbered = false): Scheme {
  if (g.preset === "bangchim") {
    const s = seoulBangchimScheme(g.bodyPtExplicit ? g.bodyHeight / 100 : 15, g.lineSpacingExplicit ? g.lineSpacing : 190)
    return applySchemeOverrides(numbered ? bangchimNumbered(s) : s, g)
  }
  if (g.preset === "ministry") {
    return applySchemeOverrides(ministryScheme(g.bodyPtExplicit ? g.bodyHeight / 100 : 15, g.lineSpacingExplicit ? g.lineSpacing : 145), g)
  }
  const gaejosik = g.numbering !== "standard" || bodyHasBoxMarkers
  const base = gaejosik
    ? seoulGaejosikScheme(g.bodyPtExplicit ? g.bodyHeight / 100 : 15, g.lineSpacingExplicit ? g.lineSpacing : 180, g.bullet2)
    : seoulLegalScheme(g.fonts.body ?? (g.bodyFontExplicit ? (g.bodyFont === "gothic" ? "맑은 고딕" : "함초롬바탕") : "굴림체"), g.bodyPtExplicit ? g.bodyHeight / 100 : 12, g.lineSpacingExplicit ? g.lineSpacing : 160)
  return applySchemeOverrides(base, g)
}

/** 옵션 타입 재수출(순환 import 회피용 얇은 별칭) */
export type { GongmunOptions }
