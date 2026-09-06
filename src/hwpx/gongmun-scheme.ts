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

import type { GongmunOptions, ResolvedGongmun } from "./gongmun.js"
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
export function gaejosikMarkerOf(bullet2: "ㅇ" | "○"): Scheme["marker"] {
  return (depth) => (depth === 0 ? "□" : depth === 1 ? bullet2 : depth === 2 ? "-" : "ㆍ")
}

/**
 * 서울 실측 개조식 스킴. bodyPt는 ㅇ(중항목) 크기 기준(실측 15) — 다른 단계는 실측 차이만큼 이동.
 */
export function seoulGaejosikScheme(bodyPt = 15, lineSp = 180, bullet2: "ㅇ" | "○" = "ㅇ"): Scheme {
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
export function pickScheme(g: ResolvedGongmun, bodyHasBoxMarkers: boolean): Scheme {
  const gaejosik = g.numbering !== "standard" || bodyHasBoxMarkers
  const base = gaejosik
    ? seoulGaejosikScheme(g.bodyPtExplicit ? g.bodyHeight / 100 : 15, g.lineSpacingExplicit ? g.lineSpacing : 180, g.bullet2)
    : seoulLegalScheme(g.fonts.body ?? (g.bodyFontExplicit ? (g.bodyFont === "gothic" ? "맑은 고딕" : "함초롬바탕") : "굴림체"), g.bodyPtExplicit ? g.bodyHeight / 100 : 12, g.lineSpacingExplicit ? g.lineSpacing : 160)
  return applySchemeOverrides(base, g)
}

/** 옵션 타입 재수출(순환 import 회피용 얇은 별칭) */
export type { GongmunOptions }
