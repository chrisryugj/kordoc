/**
 * HWPX 생성 공유 상수·테마·XML 원자 (generator.ts에서 분리).
 * 네임스페이스, charPr/paraPr id 상수, 테마 해석, escapeXml, charPr/paraPr 조각.
 */

export const NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section"
export const NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph"
export const NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head"
export const NS_CORE = "http://www.hancom.co.kr/hwpml/2011/core"
export const NS_OPF = "http://www.idpf.org/2007/opf/"
export const NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf"
export const NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container"

// ─── 스타일 ID 매핑 ─────────────────────────────────
// charPr: 0=본문, 1=볼드, 2=이탤릭, 3=볼드이탤릭, 4=인라인코드, 5=h1, 6=h2, 7=h3, 8=h4~h6, 9=표 헤더 셀, 10=인용문
// paraPr: 0=본문, 1=h1, 2=h2, 3=h3, 4=h4~h6, 5=코드블록, 6=인용문, 7=리스트

export const CHAR_NORMAL = 0
export const CHAR_BOLD = 1
export const CHAR_ITALIC = 2
export const CHAR_BOLD_ITALIC = 3
export const CHAR_CODE = 4
export const CHAR_H1 = 5
export const CHAR_H2 = 6
export const CHAR_H3 = 7
export const CHAR_H4 = 8
export const CHAR_TABLE_HEADER = 9
export const CHAR_QUOTE = 10

export const PARA_NORMAL = 0
export const PARA_H1 = 1
export const PARA_H2 = 2
export const PARA_H3 = 3
export const PARA_H4 = 4
export const PARA_CODE = 5
export const PARA_QUOTE = 6
export const PARA_LIST = 7

/** HWPX 생성 시 적용할 시각 테마 (모두 선택) */
export interface HwpxTheme {
  /**
   * 헤딩 레벨별 텍스트 색상. 미지정 시 검정.
   * 현재 charPr 매핑은 h1/h2/h3/h4 4단계 (h5, h6은 h4와 같은 charPr 공유)이므로
   * 키는 1~4만 받는다.
   */
  headingColors?: Partial<Record<1 | 2 | 3 | 4, string>>
  /** 본문 단락 텍스트 색상. 미지정 시 검정 */
  bodyColor?: string
  /**
   * 인용문 텍스트 색상. 미지정 시 검정.
   *
   * 주의: 이 옵션을 지정하면 인용문이 별도 charPr(이탤릭)로 렌더링된다.
   * 미지정 시 기존 동작 그대로 본문 charPr로 렌더링 (이탤릭 아님).
   */
  quoteColor?: string
  /** 표 첫 행 텍스트 색상. 미지정 시 본문과 동일 */
  tableHeaderColor?: string
  /** 표 첫 행 텍스트를 굵게 표시 (기본 false) */
  tableHeaderBold?: boolean
}

const DEFAULT_TEXT_COLOR = "#000000"

export function resolveTheme(theme?: HwpxTheme) {
  return {
    h1: theme?.headingColors?.[1] ?? DEFAULT_TEXT_COLOR,
    h2: theme?.headingColors?.[2] ?? DEFAULT_TEXT_COLOR,
    h3: theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    h4: theme?.headingColors?.[4] ?? theme?.headingColors?.[3] ?? DEFAULT_TEXT_COLOR,
    body: theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    quote: theme?.quoteColor ?? DEFAULT_TEXT_COLOR,
    /** quoteColor가 명시되었는지 — blockquote charPr 분기에 사용 (baseline 호환) */
    hasQuoteOption: theme?.quoteColor !== undefined,
    tableHeader: theme?.tableHeaderColor ?? theme?.bodyColor ?? DEFAULT_TEXT_COLOR,
    tableHeaderBold: !!theme?.tableHeaderBold,
  }
}

export type ResolvedTheme = ReturnType<typeof resolveTheme>

// ─── XML 생성 헬퍼 ───────────────────────────────────

export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

export function headingParaPrId(level: number): number {
  if (level === 1) return PARA_H1
  if (level === 2) return PARA_H2
  if (level === 3) return PARA_H3
  return PARA_H4
}

export function headingCharPrId(level: number): number {
  if (level === 1) return CHAR_H1
  if (level === 2) return CHAR_H2
  if (level === 3) return CHAR_H3
  return CHAR_H4
}


export function charPr(
  id: number,
  height: number,
  bold: boolean,
  italic: boolean,
  fontId: number = 0,
  textColor: string = DEFAULT_TEXT_COLOR,
  ratioPct: number = 100,
): string {
  const boldAttr = bold ? ` bold="1"` : ""
  const italicAttr = italic ? ` italic="1"` : ""
  // 볼드여도 폰트는 치환하지 않는다 — 종전의 bold variant(HY견고딕/Arial Black) 자동
  // 참조는 v4.0.1 QA에서 "정체모를 폰트"로 확정된 결함 (실측 양식들도 원 폰트에
  // bold 요소만 얹는다). 굵기는 아래 <hh:bold/> 정본 요소가 담당.
  const effFont = fontId
  // 볼드 정본은 <hh:bold/> 자식 요소 — 실측 한컴 파일은 속성 없이 요소만 쓴다.
  // 속성(bold="1")은 하위 호환으로 병기 (Windows 한컴 구버전이 속성을 읽던 경로 유지).
  const boldEl = bold ? `<hh:bold/>` : ""
  // 장평(ratio): 공문서 본문은 95%로 가로 압축 — 한두 글자만 다음 줄로 넘어가는
  // orphan을 줄여 한 줄에 담는다(실제 공문서 관행). 한글·라틴만, 나머지는 100.
  return `      <hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="1"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="${ratioPct}" latin="${ratioPct}" hanja="${ratioPct}" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>${boldEl}
      </hh:charPr>`
}

// ─── paraPr 생성 헬퍼 ───────────────────────────────

export function paraPr(id: number, opts: { align?: string; spaceBefore?: number; spaceAfter?: number; lineSpacing?: number; indent?: number; left?: number; keepWord?: boolean; keepWithNext?: boolean; outlineLevel?: number } = {}): string {
  const { align = "JUSTIFY", spaceBefore = 0, spaceAfter = 0, lineSpacing = 160, indent = 0, left = 0, keepWord = false, keepWithNext = false, outlineLevel } = opts
  // keepWord=true면 한글도 어절(단어) 단위로만 줄바꿈 — 단어 중간에서 끊기지 않음.
  // 주의: breakNonLatinWord의 한컴 실구현 의미는 이름과 반대다 —
  //   "BREAK_WORD"=어절 유지, "KEEP_WORD"=글자 단위 (2026-07 한글 COM 실렌더 A/B 실측.
  //   한글 기본값 '글자'가 KEEP_WORD로 저장되는 정본 양식과도 일치).
  //   breakLatinWord는 이름대로 KEEP_WORD=단어 유지.
  //   snapToGrid는 줄나눔과 무관함이 같은 실측에서 확인됨(섹션 격자 자체가 꺼져 있음).
  const breakNonLatin = keepWord ? "BREAK_WORD" : "KEEP_WORD"
  const snapGrid = keepWord ? "0" : "1"
  // outlineLevel(0-based) 지정 시 개요 문단 — 재파싱 헤딩 감지·한컴 문서 찾아가기의
  // 권위 정보. 번호 서식은 numbering id=1(빈 서식)이라 화면에 번호가 붙지 않는다.
  const heading = outlineLevel !== undefined
    ? `<hh:heading type="OUTLINE" idRef="0" level="${outlineLevel}"/>`
    : `<hh:heading type="NONE" idRef="0" level="0"/>`
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="${snapGrid}" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        ${heading}
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${breakNonLatin}" widowOrphan="0" keepWithNext="${keepWithNext ? 1 : 0}" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${spaceBefore}" unit="HWPUNIT"/><hc:next value="${spaceAfter}" unit="HWPUNIT"/></hh:margin>
        <hh:lineSpacing type="PERCENT" value="${lineSpacing}"/>
        <hh:border borderFillIDRef="1" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`
}

// ─── 공문서 모드 paraPr ID 매핑 ──────────────────────
// 공문서 모드에서는 기존 0~7 paraPr 뒤에 항목 단계별(8단계) paraPr를 추가한다.
// 단계 d(0~7) → paraPrIDRef = GONGMUN_LIST_BASE + d
export const GONGMUN_LIST_BASE = 8
export const GONGMUN_LIST_LEVELS = 8
// 본문 크기 가운데정렬 단락(발신명의 등) — 항목단계 paraPr 다음 id
export const GONGMUN_CENTER = GONGMUN_LIST_BASE + GONGMUN_LIST_LEVELS
// 오른쪽정렬 단락(데이터 표 호스트·출처행 — 실측: GT6/GT7/GT11 표 우측 배치 관행) — CENTER 다음 id
export const GONGMUN_RIGHT = GONGMUN_CENTER + 1
// 표 셀 전용 문단 — 실측(GT1 표⑪): 헤더 CENTER 130%·데이터 CENTER 120% 셀 압축 줄간격,
// 장문 열은 LEFT(JUSTIFY 아님). 표 셀 CENTER 문단은 정답지 전반이 어절유지(BREAK_WORD)
export const GONGMUN_TBL_CENTER = GONGMUN_RIGHT + 1
export const GONGMUN_TBL_LEFT = GONGMUN_TBL_CENTER + 1

// ─── 실측 폰트 프리셋(개조식·보고서·계획서) 전용 charPr id — 기본 11종(0~10) 뒤 11~25 ──
// 부호·요소별 폰트/크기 분리 (실측: docs/gongmunseo-engine-spec.md, gaejosik.ts).
// 보고서·계획서는 이 중 ※(13·14)·표 셀(22·23)·제목박스(25)를 사용 (id 공간은 통일 등록)
export const GJ_CHAR_DAE = 11          // □ 대항목 — HY헤드라인M 16pt
export const GJ_CHAR_DAE_BOLD = 12     // □ 안 강조 — HY헤드라인M 16pt bold
export const GJ_CHAR_CHAM = 13         // ※ 참고 — 한양중고딕 13pt
export const GJ_CHAR_CHAM_BOLD = 14    // ※ 안 강조 — 한양중고딕 13pt bold
export const GJ_CHAR_CHAPTER_NUM = 15  // 장 헤더 로마숫자 — 휴먼명조 17pt bold 흰색
export const GJ_CHAR_CHAPTER_TITLE = 16 // 장 헤더 제목 — HY헤드라인M 17pt
export const GJ_CHAR_COVER_TITLE = 17  // 표지 제목 — HY헤드라인M 30pt
export const GJ_CHAR_COVER_SUB = 18    // 표지 날짜·기관명 — HY헤드라인M 25pt
export const GJ_CHAR_TOC_LABEL = 19    // "목  차" — HY헤드라인M 28pt bold
export const GJ_CHAR_TOC_ROMAN = 20    // 목차 로마숫자 — 한양신명조 21pt bold
export const GJ_CHAR_TOC_ITEM = 21     // 목차 항목 — HY헤드라인M 18pt
export const GJ_CHAR_TABLE = 22        // 표 셀 본문 — 맑은 고딕 12pt (실측: 정부 양식 표)
export const GJ_CHAR_TABLE_BOLD = 23   // 표 셀 강조 — 맑은 고딕 12pt bold
export const GJ_CHAR_BAR = 24          // 표지 장식 바 셀 빈 문단 — 6pt (실측: 셀 높이 818 수납용)
export const GJ_CHAR_BODY_TITLE = 25   // 본문 첫 페이지 제목 박스 — HY헤드라인M 22pt (실측: GT3 표④)
const GJ_CHAR_COUNT = 15

// ─── 개조식 전용 paraPr id — 공통(0~7)+단계(8~15)+CENTER(16)+RIGHT(17)+표셀(18·19) 뒤 20~24 ──
export const GJ_PARA_CHAM = 20     // ※ 참고 문단 (들여쓰기 + 문단 위 3pt)
export const GJ_PARA_COVER = 21    // 표지 제목·날짜·기관명 (CENTER, 줄간격 130)
export const GJ_PARA_TOC_ITEM = 22 // 목차 항목
export const GJ_PARA_CHAPTER = 23  // 장 헤더 표 호스트 문단 (문단 위 간격)
export const GJ_PARA_BAR = 24      // 표지 장식 바 셀 빈 문단 (줄간격 70% — 실측 71%)
export const GJ_PARA_COUNT = 5

// ─── 개조식 전용 borderFill id — 기본 2종(1·2) 뒤 3~9 ──
export const GJ_BF_CHAPTER_NUM = 3   // 장헤더 로마숫자 셀 — #193AAA 음영 + #006699 테두리
export const GJ_BF_CHAPTER_GAP = 4   // 장헤더 간격 셀 — #006699 좌선만
export const GJ_BF_CHAPTER_TITLE = 5 // 장헤더 제목 셀 — #F2F2F2 음영 + 회색 상하선
export const GJ_BF_BAR_DARK = 6      // 표지 진한 바 — #193AAA
export const GJ_BF_BAR_LIGHT = 7     // 표지 연한 바 — #A0B4E6
export const GJ_BF_TOC_BOX = 8       // 목차 박스 — 0.4mm #514BAC
export const GJ_BF_TOC_STRIPE = 9    // 목차 배너 라벤더 스트라이프 — #E0E5FA (실측: GT3 표②)

// ─── 공문서 표 헤더행 음영 borderFill (실측: 정부 양식 표 헤더 #E6E6E6) ──
// 개조식은 전용 3~9 뒤 10, 그 외 공문서 프리셋은 기본 1·2 뒤 3
export function gongmunTableHeaderBf(gaejosik: boolean): number {
  return gaejosik ? 10 : 3
}

// ─── borderFill XML 원자 ─────────────────────────────

/** 테두리 변 스펙 — [굵기, 색] 또는 [굵기, 색, 선종류(SOLID·DOUBLE_SLIM·DASH)] */
export type BorderSide = [string, string] | [string, string, string]

/**
 * borderFill 한 항목 — 네 변 지정 + 선택적 채움(단색 또는 gradient).
 * gradient는 실측 정부 문서 제목박스 하단 바(RADIAL #0080C0→#3CBFFF, GT6 원문) 스펙.
 */
export function borderFillEntry(
  id: number,
  b: { l?: BorderSide; r?: BorderSide; t?: BorderSide; b?: BorderSide },
  fill?: string | { gradient: [string, string] },
): string {
  const side = (name: string, v?: BorderSide) =>
    v
      ? `        <hh:${name} type="${v[2] ?? "SOLID"}" width="${v[0]}" color="${v[1]}"/>`
      : `        <hh:${name} type="NONE" width="0.1 mm" color="#000000"/>`
  let brush = ""
  if (typeof fill === "string") {
    brush = `\n        <hc:fillBrush><hc:winBrush faceColor="${fill}" hatchColor="#000000" alpha="0"/></hc:fillBrush>`
  } else if (fill) {
    brush = `\n        <hc:fillBrush><hc:gradation type="RADIAL" angle="0" centerX="0" centerY="0" step="50" colorNum="2" stepCenter="50" alpha="0"><hc:color value="${fill.gradient[0]}"/><hc:color value="${fill.gradient[1]}"/></hc:gradation></hc:fillBrush>`
  }
  return `      <hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
${side("leftBorder", b.l)}
${side("rightBorder", b.r)}
${side("topBorder", b.t)}
${side("bottomBorder", b.b)}${brush}
      </hh:borderFill>`
}

// ─── 쪽번호·쪽번호 리셋 ctrl (실측: GT3 「2_보고서 양식」 원문) ──

/** 쪽번호 매기기 ctrl — 하단 중앙 "- 1 -" 형식. run 안 secPr 뒤에 배치 */
export function pageNumCtrl(): string {
  return `<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>`
}

/** 새 쪽번호 시작 ctrl — 표지·목차를 카운트에서 제외하고 본문을 1쪽으로 */
export function newPageNumCtrl(num: number = 1): string {
  return `<hp:ctrl><hp:newNum num="${num}" numType="PAGE"/></hp:ctrl>`
}

/** 쪽번호 숨김 ctrl — 표지·목차 페이지 전용 (실측: GT3 pageHiding ×2) */
export function pageHidingCtrl(hideHeader: boolean = false): string {
  return `<hp:ctrl><hp:pageHiding hideHeader="${hideHeader ? 1 : 0}" hideFooter="0" hideMasterPage="0" hideBorder="0" hideFill="0" hidePageNum="1"/></hp:ctrl>`
}

// ─── 공문서 자동 장평(orphan 축소) ───────────────────
// 기본 charPr 11종(0~10) 뒤에, 자동 장평이 필요한 문단용 변형 charPr를 붙인다.
// 실측 폰트 프리셋(개조식·보고서·계획서)은 전용 charPr 15종(11~25)이 먼저 오므로 변형은 26부터.
// 변형 vi번째 장평 r → charPr id = charVariantBase + vi×4 + (0 본문|1 볼드|2 이탤릭|3 볼드이탤릭)
export const CHAR_VARIANT_BASE = 11
export function charVariantBase(measured: boolean): number {
  return measured ? CHAR_VARIANT_BASE + GJ_CHAR_COUNT : CHAR_VARIANT_BASE
}
/** 공문서 본문 기본 장평(%) — 실제 공문서 관행 (v3.5.3) */
export const GONGMUN_BODY_RATIO = 95

