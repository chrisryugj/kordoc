/**
 * 기관 서식(`agency`) — 중앙행정기관 보도자료 2,670건 실측값(agency-styles.ts)을 공문서 옵션의 기본값으로 깐다.
 *
 * 기관값은 빈자리만 채운다. 명시 옵션(levels 의 그 단계·bullet2·fonts 의 그 역할·띠 색·본문 크기)이 늘 이긴다.
 *   - 보고서 계열(report·plan·ministry — v5 엔진): 참고·붙임 구간(보고서형) 실측 □·ㅇ·- 글꼴·크기, ※ 글꼴·크기, 표 머리
 *     글꼴·크기·음영, 2단계 부호, 장 띠 번호칸 색(참고·붙임 머리 표 라벨 칸 실측 색을 쓴다 — 장 띠 자체의 실측은 아니다)
 *   - 개조식(gaejosik — 표지·목차 엔진): 같은 보고서형 값을 단계 글꼴·크기와 ※·표 글꼴로
 *   - 보도자료(press): 본문 실측 문단 글꼴·크기, □·ㅇ·* 단계, 2단계 부호
 * 그 기관에 보고서형 규칙이 없으면(표본 3건 미만, 10곳) 기관 간 공통값을 쓰고 경고한다. "공통" 은 기관 간 공통값.
 * 기안문·통지·회의록(법정 8단계)과 서울 방침서는 받지 않는다 — 실측이 중앙부처 보도자료라 맞지 않는다.
 */

import { AGENCY_COMMON, AGENCY_STYLES, type AgencyFont, type AgencyPressStyle, type AgencyStyle } from "./agency-styles.js"
import type { GongmunLevelStyle, GongmunOptions, GongmunPreset } from "./gongmun.js"
import { KordocError } from "../utils.js"

export const AGENCY_COMMON_NAME = "공통"

const AGENCY_PRESETS = new Set<GongmunPreset>(["report", "plan", "ministry", "gaejosik", "press"])
const V5_AGENCY_PRESETS = new Set<GongmunPreset>(["report", "plan", "ministry"])
/** 개조식 본문(○·-) 기본 크기 — gaejosik 프리셋 bodyPt */
const GAEJOSIK_BODY_PT = 15

/** v5 스킴·생성기에 넘기는 기관값 (옵션으로 표현할 수 없는 크기·음영) */
export interface ResolvedAgency {
  name: string
  refPt: number | null
  /** pt null = 명시 bodyPt 라 스킴 비례 크기 유지 */
  table: { pt: number | null; headerFill: string } | null
  /** 보도자료 본문 방식 — 문단식 기관의 □ 원고 경고용 */
  pressStyle: AgencyPressStyle["style"] | null
}

/** 지원 기관 이름 (가나다순, "공통" 제외) */
export function agencyNames(): string[] {
  return Object.keys(AGENCY_STYLES)
}

function findAgency(name: string): AgencyStyle | undefined {
  const n = name.trim()
  return n === AGENCY_COMMON_NAME ? AGENCY_COMMON : AGENCY_STYLES[n]
}

/** 기관 실측 서식 — 없는 이름은 오류(지원 기관 목록을 붙인다) */
export function agencyStyle(name: string): AgencyStyle {
  const s = findAgency(name)
  if (!s) throw new KordocError(`agency: 실측 서식이 없는 기관입니다 "${name}" — ${AGENCY_COMMON_NAME} 또는 ${agencyNames().join("·")}`)
  return s
}

/** 기관값을 깐 옵션과 v5 전용 기관값. agency 가 없거나 받지 않는 프리셋이면 옵션 그대로 */
export function applyAgency(opts: GongmunOptions, preset: GongmunPreset): { opts: GongmunOptions; agency: ResolvedAgency | null } {
  if (!opts.agency?.trim()) return { opts, agency: null }
  agencyStyle(opts.agency) // 받지 않는 프리셋이어도 오타는 오류로 — 조용히 무시하지 않는다
  if (!AGENCY_PRESETS.has(preset)) return { opts, agency: null }
  const name = opts.agency.trim()
  const st = agencyStyle(name)
  // 명시 옵션 — 글꼴 역할(fonts.heading·body, bodyFont)과 본문 크기(bodyPt)를 준 자리는 기관 단계값도 그쪽을 따른다
  const userBody = opts.fonts?.body ?? (opts.bodyFont ? (opts.bodyFont === "gothic" ? "맑은 고딕" : "함초롬바탕") : undefined)
  const userHeading = opts.fonts?.heading
  const ptFree = opts.bodyPt === undefined
  const fonts = { ...opts.fonts }
  const setFont = (role: keyof NonNullable<GongmunOptions["fonts"]>, font: string) => {
    if (role === "body" && userBody) return
    fonts[role] ??= font
  }
  /** 단계값 — heading(□)·body(ㅇ·-) 역할은 명시 글꼴이 이기고, 명시 bodyPt 면 크기는 프리셋 비례에 맡긴다(각주 * 는 절대 크기라 유지) */
  const lvl = (f: AgencyFont, role: "heading" | "body" | "note"): GongmunLevelStyle => ({
    font: role === "heading" ? userHeading ?? f.font : role === "body" ? userBody ?? f.font : f.font,
    ...(ptFree || role === "note" ? { pt: f.pt } : {}),
    bold: false,
  })
  /** 본문 charPr 계열 단계가 본문과 같은지 — 명시 bodyPt 면 글꼴만 본다 */
  const sameAsBody = (f: AgencyFont, role: "heading" | "body", body: { font: string; pt: number }) =>
    lvl(f, role).font === body.font && (!ptFree || f.pt === body.pt)
  let levels: Record<number, GongmunLevelStyle> = {}
  let bullet2: GongmunOptions["bullet2"]
  let bodyPt = opts.bodyPt
  let agency: ResolvedAgency = { name, refPt: null, table: null, pressStyle: null }

  if (preset === "press") {
    const ps = st.press ?? AGENCY_COMMON.press!
    setFont("body", ps.p.font)
    bodyPt ??= ps.p.pt
    // □·ㅇ 는 본문 charPr 계열이라 본문과 같으면 단계 지정을 하지 않는다 — 지정한 단계는 장평 맞춤(autoFit) 대상에서 빠진다.
    // 3단계 * 는 본문이 아니라 각주 크기라 늘 지정
    const body = { font: fonts.body ?? userBody!, pt: bodyPt }
    if (!sameAsBody(ps.levels[0], "heading", body)) levels[0] = lvl(ps.levels[0], "heading")
    if (!sameAsBody(ps.levels[1], "body", body)) levels[1] = lvl(ps.levels[1], "body")
    levels[2] = lvl(ps.note, "note")
    bullet2 = ps.bullet2
    agency = { ...agency, pressStyle: ps.style }
  } else {
    const rs = st.report ?? AGENCY_COMMON.report!
    setFont("ref", rs.ref.font)
    setFont("table", rs.table.font)
    bullet2 = rs.bullet2
    if (V5_AGENCY_PRESETS.has(preset)) {
      setFont("body", rs.p.font)
      levels = { 0: lvl(rs.levels[0], "heading"), 1: lvl(rs.levels[1], "body"), 2: lvl(rs.levels[2], "body") }
      // ※·표 크기는 명시 bodyPt 면 스킴 비례에 맡긴다
      agency = { ...agency, refPt: ptFree ? rs.ref.pt : null, table: { pt: ptFree ? rs.table.pt : null, headerFill: rs.table.fill } }
    } else {
      // 개조식: ○·- 는 본문 charPr(fonts.body·bodyPt) — 본문과 다를 때만 단계 지정(장평 맞춤 유지), □ 는 전용 charPr 이라 늘 지정
      setFont("body", rs.levels[1].font)
      const body = { font: fonts.body ?? userBody!, pt: bodyPt ?? GAEJOSIK_BODY_PT }
      levels[0] = lvl(rs.levels[0], "heading")
      if (!sameAsBody(rs.levels[1], "body", body)) levels[1] = lvl(rs.levels[1], "body")
      if (!sameAsBody(rs.levels[2], "body", body)) levels[2] = lvl(rs.levels[2], "body")
    }
  }
  // 명시 levels 는 단계 안에서 속성별로 덮는다 — {0:{bold:true}} 가 기관 □ 글꼴·크기를 지우지 않게
  for (const [k, v] of Object.entries(opts.levels ?? {})) levels[Number(k)] = { ...levels[Number(k)], ...v }
  const band = st.band ?? AGENCY_COMMON.band!
  const merged: GongmunOptions = {
    ...opts,
    fonts,
    bodyPt,
    levels,
    bullet2: opts.bullet2 ?? bullet2,
    ...(preset !== "press" ? {
      bandColor: opts.bandColor ?? band.fill ?? "#FFFFFF",
      bandTextColor: opts.bandTextColor ?? band.text,
    } : {}),
  }
  return { opts: merged, agency }
}

/** 기관 옵션 경고 — 받지 않는 프리셋, 보고서형 규칙이 없어 공통값을 쓰는 기관. 없는 이름은 resolveGongmun 이 던진다 */
export function agencyWarnings(opts: GongmunOptions, preset: GongmunPreset): string[] {
  const name = opts.agency?.trim()
  if (!name) return []
  if (!AGENCY_PRESETS.has(preset)) return [`agency(기관 서식)는 보고서·계획서·업무보고·개조식·보도자료 전용 — '${preset}' 프리셋에서 무시됨`]
  const st = findAgency(name)
  if (st && preset !== "press" && !st.report) return [`agency: ${name} 은 보고서형 실측 표본이 모자라 기관 간 공통 서식을 씀`]
  return []
}
