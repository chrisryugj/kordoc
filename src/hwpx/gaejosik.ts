/**
 * 개조식(정부 표준 개조식 보고서) 프리셋 — 순수 로직 + 실측 스타일 상수
 *
 * 근거: 실제 정부 보고서 양식 hwpx(「2_보고서 양식」)를 디코드해 실측한 값.
 *   부호: □ HY헤드라인M 16pt(문단 위 15) / ○ 휴먼명조 15pt(10) / - 휴먼명조 15pt(6)
 *         / ※ 한양중고딕 13pt(3)   ※ 문단 위 간격 저장값 = UI(pt) × 200
 *   (소분류 부호만 양식 저장값 ―(U+2015) 대신 실무 관행 하이픈 - 채택 — GAEJOSIK_BULLETS 주석)
 *   장 헤더: 1×3 표 — 로마숫자 셀(흰 글자 17pt·#193AAA 음영·#006699 테두리) +
 *           간격 셀(#006699 좌선) + 제목 셀(HY헤드라인M 17pt·#F2F2F2 음영·회색 상하선)
 *   표지: 파랑 장식 바(#193AAA/#A0B4E6) 사이 제목 30pt, 날짜·기관명 25pt
 *   목차: "목  차" 28pt bold + 0.4mm #514BAC 테두리 박스(로마 21pt 한양신명조 bold)
 *
 * 이 모듈은 순수 값/로직만 담는다. XML 조립은 gen-gaejosik.ts.
 */

import { markerWidth } from "./gongmun.js"

// ─── 부호 ───────────────────────────────────────────

/**
 * 개조식 단계별 부호: □(대) ○(중) -(소, 하이픈) ㆍ(세) — 3단계 초과는 ㆍ 고정.
 * 소분류는 실무 관행이 하이픈이다 — GT3 양식 저장값은 ―(U+2015)지만 실무자 확인
 * (2026-07-11 QA) + 부처별 양식 3종 중 2종(업무보고·보고서3)이 하이픈으로 실측됨.
 * 양식 파일 하나의 저장값보다 실무 관행 우선.
 */
const GAEJOSIK_BULLETS = ["□", "○", "-", "ㆍ"]

export function gaejosikMarker(depth: number): string {
  return GAEJOSIK_BULLETS[Math.min(depth, GAEJOSIK_BULLETS.length - 1)]
}

// ─── 크기 체계 (본문 15pt 기준 실측값 → bodyHeight 비례 스케일) ──

/** 요소별 글자 크기(pt) 오버라이드 — 미지정 요소는 bodyHeight 비례 기본값 */
export type GaejosikSizeOverrides = Partial<{
  dae: number; cham: number; chapter: number; coverTitle: number; coverSub: number
  tocLabel: number; tocRoman: number; tocItem: number; table: number; bodyTitle: number
}>

/** bodyHeight(=bodyPt×100) 기준 각 요소의 charPr height. 실측은 body 1500 기준. ov는 pt 절대값 우선 */
export function gaejosikSizes(bodyHeight: number, ov: GaejosikSizeOverrides = {}) {
  const s = bodyHeight / 1500
  const r = (v: number, pt?: number) => (pt ? Math.round(pt * 100) : Math.round(v * s))
  return {
    /** □ 대항목 — HY헤드라인M 16pt */
    dae: r(1600, ov.dae),
    /** ※ 참고 — 한양중고딕 13pt */
    cham: r(1300, ov.cham),
    /** 장 헤더(로마숫자·제목) 17pt */
    chapter: r(1700, ov.chapter),
    /** 표지 제목 30pt */
    coverTitle: r(3000, ov.coverTitle),
    /** 표지 날짜·기관명 25pt */
    coverSub: r(2500, ov.coverSub),
    /** 목차 라벨 "목  차" 28pt */
    tocLabel: r(2800, ov.tocLabel),
    /** 목차 로마숫자 21pt(한양신명조) */
    tocRoman: r(2100, ov.tocRoman),
    /** 목차 항목 18pt */
    tocItem: r(1800, ov.tocItem),
    /** 표 셀 — 맑은 고딕 12pt (실측: 정부 양식 표) */
    table: r(1200, ov.table),
    /** 표지 장식 바 셀 빈 문단 — 6pt (실측: 바 높이 818 안에 줄높이 수납) */
    bar: r(600),
    /** 본문 첫 페이지 제목 박스 — HY헤드라인M 22pt (실측: GT3 표④) */
    bodyTitle: r(2200, ov.bodyTitle),
  }
}

/** 단계별 문단 위 간격(HWPUNIT) — 양식 텍스트 스펙 15/10/6/3 × 200 */
export function gaejosikSpaceBefore(depth: number, bodyHeight: number): number {
  const s = bodyHeight / 1500
  const ui = [3000, 2000, 1200, 600][Math.min(depth, 3)]
  return Math.round(ui * s)
}

/**
 * 단계별 들여쓰기 — 실측: 선행 공백 □=1 ○=2 -=3 (0.5em씩) ≈
 * □ left 0 / ○ 1자 / - 1.5자 / ㆍ 2자(+0.5자씩 누적). 내어쓰기는 부호 실폭.
 */
export function gaejosikLevelIndent(depth: number, bodyHeight: number, sizes: GaejosikSizeOverrides = {}): { left: number; indent: number } {
  const lefts = [0, 1.0, 1.5, 2.0]
  const left = depth <= 3
    ? Math.round(lefts[depth] * bodyHeight)
    : Math.round((2.0 + (depth - 3) * 0.5) * bodyHeight)
  // □는 자기 크기(16pt 상당)로 부호폭 계산 — 둘째 줄이 내용 첫 글자에 정렬
  const h = depth === 0 ? gaejosikSizes(bodyHeight, sizes).dae : bodyHeight
  return { left, indent: -markerWidth(gaejosikMarker(depth), h) }
}

/** ※ 참고 문단 들여쓰기 — 실측: 선행 공백 5칸(13pt) ≈ 2.5×cham폭 */
export function gaejosikChamIndent(bodyHeight: number, sizes: GaejosikSizeOverrides = {}): { left: number; indent: number } {
  const cham = gaejosikSizes(bodyHeight, sizes).cham
  return { left: Math.round(2.5 * cham), indent: -markerWidth("※", cham) }
}

/**
 * 목차 항목 내어쓰기 — 제목이 길어 줄바꿈될 때 둘째 줄이 로마숫자 밑으로
 * 감기지 않고 제목 첫 글자에 정렬되도록. 내어쓰기 폭 = "Ⅷ." 실폭(로마 크기 기준).
 */
export function gaejosikTocItemIndent(bodyHeight: number, sizes: GaejosikSizeOverrides = {}): { left: number; indent: number } {
  const sz = gaejosikSizes(bodyHeight, sizes)
  const hang = markerWidth("Ⅷ.", sz.tocRoman)
  return { left: 2000 + hang, indent: -hang }
}

// ─── 표지 날짜 ──────────────────────────────────────

/** 공문서 날짜 표기: `YYYY. M. D.` (월·일 앞자리 0 제거, 끝점 필수) */
export function formatGaejosikDate(d: Date): string {
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`
}

// ─── 장 제목 정리 ────────────────────────────────────

/**
 * h2 제목의 선행 번호("1. "·"0. "·"Ⅱ. " 등) 제거 — 장 헤더 표가 로마숫자를
 * 자체 부여하므로 이중 번호 방지 (헤딩 자동번호 함정의 개조식 해법).
 */
export function stripChapterNumber(title: string): string {
  return title.replace(/^\s*(?:\d+|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+)\s*[.)]\s*/u, "").trim()
}

// ─── 실측 색상/기하 상수 (gen-gaejosik XML 조립용) ────

export const GAEJOSIK_COLORS = {
  /** 장헤더 로마숫자 셀·표지 진한 바 음영 */
  primary: "#193AAA",
  /** 장헤더 셀 테두리 */
  border: "#006699",
  /** 표지 연한 바 */
  accent: "#A0B4E6",
  /** 장헤더 제목 셀 음영 */
  titleFill: "#F2F2F2",
  /** 장헤더 제목 셀 상하선 */
  titleLine: "#A6A6A6",
  /** 목차 박스 테두리 */
  tocBorder: "#514BAC",
  /** 목차 배너 라벤더 스트라이프 (실측: GT3 표②) */
  tocStripe: "#E0E5FA",
} as const

/** 장헤더 표 기하(HWPUNIT, 여백 20mm A4 본문폭 48188 기준 실측) */
export const CHAPTER_GEOM = { numW: 3327, gapW: 848, titleW: 43513, rowH: 2832 } as const

/** 표지 장식 바 기하 — 상단(긴 진파랑+짧은 연파랑), 제목 칸, 하단(짧은 진파랑+긴 연파랑) */
export const COVER_GEOM = {
  totalW: 48180,
  topDarkW: 38219, topLightW: 9961, barH: 818,
  titleH: 11060,
  botDarkW: 10466, botLightW: 37714, botBarH: 812,
} as const

/** 목차 박스 기하 */
export const TOC_GEOM = { boxW: 46492, boxH: 57840 } as const

// ─── 기하 크기연동 (A3) — sizes 오버라이드에 비례 스케일 ──
// 실측 기준: 장헤더 rowH 2832@17pt, 표지 제목칸 11060@30pt, 본문 제목박스 3566@22pt,
// 목차 배너 3931@28pt. 폭은 본문폭 고정(스케일 제외), 높이만 요소 크기에 비례.

/** 장헤더 기하 — rowH를 chapter 크기(기본 17pt)에 비례 */
export function chapterGeom(bodyHeight: number, ov: GaejosikSizeOverrides = {}) {
  const s = gaejosikSizes(bodyHeight, ov).chapter / 1700
  return { ...CHAPTER_GEOM, rowH: Math.round(CHAPTER_GEOM.rowH * s) }
}

/** 표지 기하 — 제목칸 높이를 coverTitle 크기(기본 30pt)에 비례. 장식 바 높이는 고정 */
export function coverGeom(bodyHeight: number, ov: GaejosikSizeOverrides = {}) {
  const s = gaejosikSizes(bodyHeight, ov).coverTitle / 3000
  return { ...COVER_GEOM, titleH: Math.round(COVER_GEOM.titleH * s) }
}

// ─── 목차 장식 배너 (B7) — 실측: GT3 「2_보고서 양식」 표② 1×7 스트라이프 ──
// 열폭 [565,565,1414,13191,1414,565,565] 좌우 대칭, h 3931@28pt.
// 셀 채움: 네이비(#193AAA) | 무 | 라벤더(#E0E5FA) | 라벨 | 라벤더 | 무 | 네이비
export const TOC_BANNER_GEOM = {
  colWs: [565, 565, 1414, 13191, 1414, 565, 565] as readonly number[],
  h: 3931,
} as const

/** 목차 배너 기하 — 높이를 tocLabel 크기(기본 28pt)에 비례 */
export function tocBannerGeom(bodyHeight: number, ov: GaejosikSizeOverrides = {}) {
  const s = gaejosikSizes(bodyHeight, ov).tocLabel / 2800
  return { colWs: TOC_BANNER_GEOM.colWs, h: Math.round(TOC_BANNER_GEOM.h * s) }
}

// ─── 본문 첫 페이지 제목 박스 (B6) — 실측: GT3 표④ 3×3 투톤 바 샌드위치 ──
// 표지 표①과 동일 그리드, 행높이 600/3566/600, 제목 HY헤드라인M 22pt
export const BODY_TITLE_GEOM = { barH: 600, titleH: 3566 } as const

/** 본문 제목박스 기하 — 제목칸 높이를 bodyTitle 크기(기본 22pt)에 비례 */
export function bodyTitleGeom(bodyHeight: number, ov: GaejosikSizeOverrides = {}) {
  const s = gaejosikSizes(bodyHeight, ov).bodyTitle / 2200
  return { barH: BODY_TITLE_GEOM.barH, titleH: Math.round(BODY_TITLE_GEOM.titleH * s) }
}
