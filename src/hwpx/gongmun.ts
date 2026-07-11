/**
 * 공문서(公文書) 모드 — 한국 행정 공문서 표준 서식 렌더링 로직
 *
 * 근거: 「행정업무의 운영 및 혁신에 관한 규정」 및 동 시행규칙(제2조 항목 표시),
 *       행정안전부 「2020 행정업무운영 편람」.
 * 자세한 표준은 docs/gongmunseo-reference.md, 구현 매핑은 docs/gongmunseo-engine-spec.md 참조.
 *
 * 이 모듈은 **순수 로직**만 담는다(항목부호 시퀀스 생성, 단계별 들여쓰기 계산,
 * 프리셋 해석). 실제 XML 조립은 generator.ts가 한다.
 */

import { charWidthEm1000, SPACE_EM_FIXED } from "./text-metrics.js"
import { gaejosikMarker, gaejosikLevelIndent, type GaejosikSizeOverrides } from "./gaejosik.js"

// ─── 옵션 타입 ──────────────────────────────────────

export type GongmunPreset = "official" | "report" | "plan" | "notice" | "minutes" | "gaejosik" | "press"
export type GongmunNumbering = "standard" | "report" | "gaejosik"
export type GongmunFont = "myeongjo" | "gothic"

/** 프리셋 입력값 — 영문 키 또는 한글 별칭(기안문·보고서·계획서·통지·회의록 등) */
export type GongmunPresetInput =
  | GongmunPreset
  | "기안문" | "시행문" | "공문" | "공문서"
  | "보고서"
  | "계획서" | "계획"
  | "통지" | "알림" | "안내"
  | "회의록"
  | "개조식" | "개조식보고서" | "정부보고서" | "정부표준개조식보고서"
  | "보도자료"

/** 공문서 모드 옵션 (전부 선택 — 프리셋 기본값을 개별 override) */
export interface GongmunOptions {
  /** 문서 종류 프리셋(영문 키 또는 한글 별칭). 기본 'official'(일반 기안문) */
  preset?: GongmunPresetInput
  /** 본문 글꼴. 'myeongjo'=함초롬바탕(명조, 보고서·대외공문 관행) / 'gothic'=맑은 고딕(전자결재 기본) */
  bodyFont?: GongmunFont
  /** 본문 글자 크기(pt). 기본 15 */
  bodyPt?: number
  /** 본문 줄간격(%). 기본 160 (회의록 130) */
  lineSpacing?: number
  /** 항목부호 체계. 'standard'=법정 8단계(1. 가. 1) …) / 'report'=보고서 불릿(□ ○ - ㆍ) / 'gaejosik'=개조식(□ ○ - ㆍ + 부호별 폰트) */
  numbering?: GongmunNumbering
  /**
   * 표지 페이지(개조식 프리셋 기본 켜짐) — 첫 h1을 제목으로, 파랑 장식 바 + 날짜 + 기관명.
   * false로 끄거나 {date, org}로 날짜(기본 오늘, 'YYYY. M. D.')·기관명(기본 생략) 지정.
   */
  cover?: boolean | { date?: string; org?: string }
  /** 목차 페이지(개조식 프리셋 기본 켜짐) — h2 목록을 Ⅰ Ⅱ Ⅲ…로 자동 생성. false로 끔 */
  toc?: boolean
  /** 용지 여백(mm). 기본 공식값 위20/아래10/좌20/우20 */
  margins?: { top: number; bottom: number; left: number; right: number }
  /** 문서 제목(첫 h1)을 가운데 정렬. 기본 true (행정기관명·보고서 제목) */
  centerTitle?: boolean
  /**
   * 문단별 자동 장평 — 한두 글자(짧은 꼬리)만 다음 줄로 넘어가는 문단의 장평을
   * 95→90%까지 자동 축소해 한 줄에 담는다(공무원 실무 관행의 자동화).
   * false로 끄거나 minRatio(기본 90)로 하한 조정. 기본 켜짐.
   */
  autoFit?: boolean | { minRatio?: number }
  /**
   * 요소별 글꼴 오버라이드 — 기관 표준 폰트 적용이나 미설치 폰트 대체용.
   * body=본문(개조식 ○·-) / heading=제목 계열(□·장헤더·표지·목차) / ref=※ 참고 / table=표 셀.
   * 실측 폰트 프리셋(개조식·보고서·계획서)은 네 역할 전부, 그 외 프리셋은 body만
   * 적용된다 (bodyFont보다 우선).
   */
  fonts?: { body?: string; heading?: string; ref?: string; table?: string }
  /** 개조식 요소별 글자 크기(pt) 오버라이드 — 미지정 요소는 bodyPt 비례 기본값 */
  sizes?: GaejosikSizeOverrides
  /** 쪽번호(하단 중앙 "- 1 -", 표지·목차는 카운트 제외). 기본: 개조식·보고서·계획서 켜짐 */
  pageNumbers?: boolean
  /** 본문 끝 2타+"끝." 표시(행정업무규정). 기본: 기안문(official)만 켜짐 */
  endMark?: boolean
  /** 결재란 — 직위 라벨 배열(예: ["담당","팀장","과장"]). 문서 최상단 우측 배치 */
  approval?: string[]
  /** 본문 첫 페이지 제목 박스(개조식) — 목차 뒤 본문 시작에 제목 반복(실측 관행). 기본: 표지 있으면 켜짐 */
  bodyTitleBox?: boolean
  /**
   * h2 섹션 제목 말머리 (비개조식 — 개조식 h2는 로마숫자 장 헤더가 대체).
   * 'box'=□ 대항목(실측 보고서 양식 관행) / 'number'=아라비아 번호(1. 2. — 공고문 관행)
   * / 'none'=말머리 없음. 기본: 보고서·계획서 'box', 공고문 'number', 그 외 'none'.
   */
  h2Marker?: "box" | "number" | "none"
  /**
   * 2단계 항목부호 — 'ㅇ'(이응, 전자결재 기안문·공고문 실측 지배) / '○'(원, 보고서
   * 양식 계열 실측). 기본: notice·press 'ㅇ', 그 외 '○' (v4.1.0 실결재 60건 분포).
   */
  bullet2?: "ㅇ" | "○"
  /**
   * 단일 형제 항목 부호 생략(편람 규정: 항목이 하나면 부호 미부여). 기본 false —
   * 부호 없는 계단 들여쓰기가 실무 눈에 더 어색하다(실무자 QA, v4.0.2).
   * 규정 엄수가 필요하면 true.
   */
  suppressSingle?: boolean
  /** 기안문 두문 — 행정기관명·수신·경유·제목 (별지 제1호서식, official 전용) */
  docHead?: { org?: string; to?: string; via?: string; title?: string }
  /** 기안문 결문 — 발신명의·기안/검토/결재·시행/접수·주소·연락처·공개구분 (official 전용) */
  docFoot?: {
    sender?: string; drafter?: string; reviewer?: string; approver?: string
    cooperator?: string; docNum?: string; receive?: string
    address?: string; site?: string; phone?: string; fax?: string; email?: string; disclosure?: string
  }
  /** 업무보고 우상단 보고정보 행 — "(보고일시, 보고자, 연락처)" (실측 t3: 휴먼명조 12pt RIGHT) */
  reportInfo?: string
  /** 공고문 두문·결문 — 공고번호(본문 위)·날짜·발신명의(본문 아래 우측, 실측 바이오헬스 공고) */
  noticeHead?: { no?: string; date?: string; sender?: string }
  /** 보도자료(press) 머리·담당 — 보도시점/배포 행·부제·담당 부서 표 */
  press?: { release?: string; distribute?: string; sub?: string[]; contact?: { dept?: string; manager?: string; phone?: string } }
}

export interface ResolvedGongmun {
  preset: GongmunPreset
  bodyFont: GongmunFont
  bodyHeight: number // charPr height = pt × 100
  lineSpacing: number
  numbering: GongmunNumbering
  margins: { top: number; bottom: number; left: number; right: number }
  centerTitle: boolean
  /** 자동 장평 하한(%) — null이면 끔 */
  autoFitMinRatio: number | null
  /** 표지 설정 — null이면 표지 없음 (개조식 외 프리셋 기본) */
  cover: { date: string | null; org: string } | null
  /** 목차 자동 생성 여부 (개조식 프리셋 기본 true) */
  toc: boolean
  /** 요소별 글꼴 오버라이드 (GongmunOptions.fonts) */
  fonts: { body?: string; heading?: string; ref?: string; table?: string }
  /** 개조식 요소별 크기(pt) 오버라이드 (GongmunOptions.sizes) */
  sizes: GaejosikSizeOverrides
  /** 쪽번호(하단 중앙 "- 1 -") — 개조식·보고서·계획서 기본 켜짐 */
  pageNumbers: boolean
  /** 머리말·꼬리말 영역(HWPUNIT) — 개조식 4251(15mm, 실측), 그 외 0(편람) */
  headerFooter: number
  /** 본문 끝 "끝." 표시 — 기안문(official) 기본 켜짐 (규정) */
  endMark: boolean
  /** 결재란 직위 라벨(좌→우) — null이면 결재란 없음 */
  approval: string[] | null
  /** 본문 첫 페이지 제목 박스(개조식, 실측 GT3 표④) — 표지 있을 때 기본 켜짐 */
  bodyTitleBox: boolean
  /** h2 섹션 제목 말머리 — 보고서·계획서 기본 '□'(실측), 'number'=아라비아, 'none'=없음 */
  h2Marker: "box" | "number" | "none"
  /** 2단계 항목부호 — notice·press 기본 'ㅇ', 그 외 '○' (실결재 60건 분포, v4.1.0) */
  bullet2: "ㅇ" | "○"
  /** 단일 형제 부호 생략(규정) — 기본 false (실무 관행: 하나여도 부호, v4.0.2) */
  suppressSingle: boolean
  /** 기안문 두문 — null이면 없음 */
  docHead: { org?: string; to?: string; via?: string; title?: string } | null
  /** 기안문 결문 — null이면 없음 */
  docFoot: NonNullable<GongmunOptions["docFoot"]> | null
  /** 보고정보 행 — null이면 없음 */
  reportInfo: string | null
  /** 공고문 두문·결문 — null이면 없음 */
  noticeHead: { no?: string; date?: string; sender?: string } | null
  /** 보도자료 머리·담당 — press 프리셋이면 옵션 미지정이어도 빈 객체(머리박스는 항상) */
  press: NonNullable<GongmunOptions["press"]> | null
}

/**
 * 기안문 여백(mm) — 실결재 지배값 t20/b15/l20/r15 (서울 정보소통광장 60건 중 41건,
 * v4.1.0 실측). 편람 공식값(위20/아래10/좌우20)보다 실무 관행 우선 — margins로 조정 가능.
 */
const OFFICIAL_MARGINS = { top: 20, bottom: 15, left: 20, right: 15 }

/** 보고서 계열 여백(mm) — 실측: 「2_보고서 양식」·샘플양식1·공고문·보도자료 공통 상하 15mm */
const GAEJOSIK_MARGINS = { top: 15, bottom: 15, left: 20, right: 20 }

/** 개조식 머리말·꼬리말 영역(HWPUNIT) — 실측 4251(15mm). 쪽번호가 이 영역에 렌더 */
const GAEJOSIK_HEADER_FOOTER = 4251

const PRESET_DEFAULTS: Record<
  GongmunPreset,
  { bodyPt: number; lineSpacing: number; numbering: GongmunNumbering }
> = {
  official: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  report: { bodyPt: 15, lineSpacing: 160, numbering: "report" },
  plan: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  notice: { bodyPt: 15, lineSpacing: 160, numbering: "standard" },
  minutes: { bodyPt: 14, lineSpacing: 130, numbering: "standard" },
  gaejosik: { bodyPt: 15, lineSpacing: 160, numbering: "gaejosik" },
  // 보도자료 — 실측(국토부 실물): 본문 바탕 14pt 160%, □→ㅇ→*(각주) 부호
  press: { bodyPt: 14, lineSpacing: 160, numbering: "report" },
}

/** 프리셋 별칭(한글/영문) → 내부 preset 키. CLI·라이브러리 공용 */
export const PRESET_ALIAS: Record<string, GongmunPreset> = {
  official: "official", 기안문: "official", 시행문: "official", 공문: "official", 공문서: "official",
  report: "report", 보고서: "report",
  plan: "plan", 계획서: "plan", 계획: "plan",
  notice: "notice", 통지: "notice", 알림: "notice", 안내: "notice",
  minutes: "minutes", 회의록: "minutes",
  gaejosik: "gaejosik", 개조식: "gaejosik", 개조식보고서: "gaejosik", 정부보고서: "gaejosik", 정부표준개조식보고서: "gaejosik",
  press: "press", 보도자료: "press",
}

/** 프리셋 입력(영문 키 또는 한글 별칭)을 내부 GongmunPreset로 정규화. 미상은 'official' */
export function normalizeGongmunPreset(preset?: string): GongmunPreset {
  if (!preset) return "official"
  return PRESET_ALIAS[preset.trim()] ?? "official"
}

/**
 * 실측 보고서 폰트 세트(제목 HY헤드라인M·본문 휴먼명조·※ 한양중고딕·표 맑은 고딕)를
 * 쓰는 프리셋 — 부처별 실측 양식 3종(업무보고·보고서×2) 공통 스펙 (v4.0.1 QA-1).
 * 개조식만 받던 실측 폰트를 보고서·계획서로 확장. 기안문·통지·회의록은 함초롬 유지
 * (전자결재·일반 공문 관행).
 */
export function usesReportFonts(preset: GongmunPreset): boolean {
  return preset === "gaejosik" || preset === "report" || preset === "plan"
}

export function resolveGongmun(opts: GongmunOptions): ResolvedGongmun {
  const preset = normalizeGongmunPreset(opts.preset)
  const d = PRESET_DEFAULTS[preset]
  const bodyPt = opts.bodyPt ?? d.bodyPt
  const autoFitMinRatio =
    opts.autoFit === false ? null
    : typeof opts.autoFit === "object" ? Math.min(Math.max(opts.autoFit.minRatio ?? 90, 50), 99)
    : 90
  // 표지·목차 — 개조식 프리셋만 기본 켜짐. cover.date null이면 렌더 시점의 오늘 날짜
  const coverOn = opts.cover !== undefined ? opts.cover !== false : preset === "gaejosik"
  const coverOpts = typeof opts.cover === "object" ? opts.cover : {}
  const gaejosik = preset === "gaejosik"
  // 여백 — 보고서 계열(개조식·보고서·계획서·공고문·보도자료)은 실측 상하 15mm,
  // 기안문·회의록은 실결재 지배값(20/15/20/15)
  const reportFamily = gaejosik || preset === "report" || preset === "plan" || preset === "notice" || preset === "press"
  return {
    preset,
    bodyFont: opts.bodyFont ?? "myeongjo",
    bodyHeight: Math.round(bodyPt * 100),
    lineSpacing: opts.lineSpacing ?? d.lineSpacing,
    numbering: opts.numbering ?? d.numbering,
    margins: opts.margins ?? (reportFamily ? GAEJOSIK_MARGINS : OFFICIAL_MARGINS),
    centerTitle: opts.centerTitle ?? true,
    autoFitMinRatio,
    cover: coverOn ? { date: coverOpts.date ?? null, org: coverOpts.org ?? "" } : null,
    toc: opts.toc ?? gaejosik,
    fonts: opts.fonts ?? {},
    sizes: opts.sizes ?? {},
    // 쪽번호 — 보고서 계열 관행(실측: 2_보고서 양식·추진계획·공고문 전부 하단 중앙)
    pageNumbers: opts.pageNumbers ?? (gaejosik || preset === "report" || preset === "plan"),
    // 머리말·꼬리말 — 실측: 보고서 계열 15mm(GT3·t2·춘천·브라더), 공고·보도 10mm,
    // 기안문 0(실결재 41/60건 h0/f0)
    headerFooter: usesReportFonts(preset) ? GAEJOSIK_HEADER_FOOTER
      : preset === "notice" || preset === "press" ? 2835 : 0,
    // "끝." — 기안문 규정(본문 끝 2타+"끝."). 그 외는 opt-in
    endMark: opts.endMark ?? preset === "official",
    approval: opts.approval && opts.approval.length > 0 ? opts.approval : null,
    // 본문 제목박스 — 실측(GT3·GT12): 목차 뒤 본문 시작에 제목 반복. 표지 켜진 개조식 기본
    bodyTitleBox: opts.bodyTitleBox ?? (gaejosik && coverOn),
    // h2 말머리 — 실측: 보고서 양식 □ 대항목(QA-2), 공고문 아라비아("1. 사업개요", 바이오헬스 실측)
    h2Marker: opts.h2Marker ?? (preset === "report" || preset === "plan" ? "box" : preset === "notice" ? "number" : "none"),
    // 2단계 부호 — 실결재 기안문·공고문 ㅇ 지배(60건 중 ㅇ134:○5), 보고서 양식 계열 ○
    bullet2: opts.bullet2 ?? (preset === "notice" || preset === "press" ? "ㅇ" : "○"),
    // 단일 형제 부호 생략 — 규정이지만 부호 없는 계단이 실무 눈에 어색 (실무자 QA)
    suppressSingle: opts.suppressSingle ?? false,
    docHead: preset === "official" && opts.docHead ? opts.docHead : null,
    docFoot: preset === "official" && opts.docFoot ? opts.docFoot : null,
    reportInfo: opts.reportInfo?.trim() || null,
    noticeHead: preset === "notice" && opts.noticeHead ? opts.noticeHead : null,
    // 보도자료 머리박스는 프리셋 자체가 요구 — 옵션 미지정이어도 빈 객체
    press: preset === "press" ? (opts.press ?? {}) : null,
  }
}

// ─── 항목부호 시퀀스 생성 ────────────────────────────

// 가나다 초성 14자(쌍자음 제외) — 0xAC00 음절 조합용 초성 인덱스
const HANGUL_INITIALS = [0, 2, 3, 5, 6, 7, 9, 11, 12, 14, 15, 16, 17, 18]
// 단모음 순 중성 인덱스: ㅏ ㅓ ㅗ ㅜ ㅡ ㅣ (편람: 가→…→하→거→…→허→고→…)
const HANGUL_MEDIALS = [0, 4, 8, 13, 18, 20]

/** 0-based n → 가, 나, 다, … 하, 거, 너, … (단모음 연속) */
export function hangulOrdinal(n: number): string {
  const cols = HANGUL_INITIALS.length // 14
  const vowel = HANGUL_MEDIALS[Math.min(Math.floor(n / cols), HANGUL_MEDIALS.length - 1)]
  const init = HANGUL_INITIALS[n % cols]
  return String.fromCodePoint(0xac00 + init * 588 + vowel * 28)
}

/** 0-based n → ① ② ③ … (U+2460~). 20 초과 시 순환(실무상 도달 불가) */
export function circledNumber(n: number): string {
  return String.fromCodePoint(0x2460 + (n % 20))
}

/** 0-based n → ㉮ ㉯ ㉰ … ㉻ (U+326E~, 14자). 초과 시 순환 */
export function circledHangul(n: number): string {
  return String.fromCodePoint(0x326e + (n % 14))
}

/** 보고서 모드 단계별 불릿(정부 보고서 관행: □ 대 / ○·ㅇ 중 / - 소 / ㆍ 세) */
const REPORT_BULLETS = ["□", "○", "-", "ㆍ"]
/** 보도자료 불릿 — 실측(국토부 실물): □ → ㅇ → *(각주 12pt) */
const PRESS_BULLETS = ["□", "ㅇ", "*", "ㆍ"]

/**
 * 'standard'(법정 8단계) 마커. depth 0~7, n은 해당 단계 형제 중 0-based 순번.
 * 5·6단계는 반드시 괄호 3글자 조합, 7·8단계는 단일 유니코드 문자.
 */
export function standardMarker(depth: number, n: number): string {
  switch (depth) {
    case 0: return `${n + 1}.`
    case 1: return `${hangulOrdinal(n)}.`
    case 2: return `${n + 1})`
    case 3: return `${hangulOrdinal(n)})`
    case 4: return `(${n + 1})`
    case 5: return `(${hangulOrdinal(n)})`
    case 6: return circledNumber(n)
    case 7: return circledHangul(n)
    default: return circledHangul(n) // 8단계 초과(실무상 없음)
  }
}

/** 'report' 모드 마커(불릿, 순번 무관). bullet2로 2단계 ㅇ/○ 전환, press는 보도자료 체계 */
export function reportMarker(depth: number, bullet2: "ㅇ" | "○" = "○", press = false): string {
  const bullets = press ? PRESS_BULLETS : REPORT_BULLETS
  const m = bullets[Math.min(depth, bullets.length - 1)]
  return depth === 1 && !press ? bullet2 : m
}

/**
 * 항목부호 문자열의 실제 렌더 폭(HWPUNIT) + 부호와 내용 사이 1타(공백 0.5em).
 * 내어쓰기(둘째 줄 정렬)의 기준값이다 — 실제 한컴 공문서를 디코드해 보면 |intent|가
 * 부호의 실제 폭과 같아야 둘째 줄이 첫 줄 내용 첫 글자에 맞는다. 부호마다 폭이 달라
 * (예: '1.'은 좁고 '가.'는 넓음) 고정값으로는 정렬을 맞출 수 없다.
 * 폭은 함초롬바탕 실측 advance 테이블(text-metrics)로 계산한다 — 한글·원문자 0.97em,
 * 숫자 0.55em, 온점 0.32em, 괄호 0.32em (기존 근사치는 괄호를 0.45em으로 과대평가).
 */
export function markerWidth(marker: string, bodyHeight: number): number {
  let em = SPACE_EM_FIXED // 1타(부호와 내용 사이 공백, 0.5em)
  for (const c of marker) em += charWidthEm1000(c.codePointAt(0)!)
  return Math.round((em / 1000) * bodyHeight)
}

// ─── 단계별 들여쓰기(left/내어쓰기 indent) 계산 ──────

export interface LevelIndent {
  /** 문단 왼쪽 여백(HWPUNIT) — 단계별 누적 들여쓰기. 첫 줄 부호가 여기서 시작 */
  left: number
  /**
   * 첫 줄 들여쓰기(HWPUNIT, hc:intent). **음수 = 내어쓰기**: 첫 줄은 left에서 시작하고
   * 둘째 줄부터 |intent| 만큼 오른쪽으로 들여쓴다(= 내용 첫 글자에 정렬). 한컴 실측 의미.
   */
  indent: number
}

/**
 * depth(0~)별 들여쓰기 계산. (한컴 OWPML 실측 모델)
 * - left = depth × bodyHeight (단계마다 한글 1자=2타씩 누적 — 첫 줄 부호 위치)
 * - intent = -(단계 대표 부호의 실제 렌더폭) (음수 내어쓰기 → 둘째 줄이
 *   left+|intent| = 첫 줄 내용 첫 글자에 정렬). 부호폭은 markerWidth로 산출하므로
 *   '1.'(좁음)·'가.'(넓음)이 각각 자기 폭만큼만 내어써진다(실측 한컴 공문서와 동일).
 */
export function levelIndent(
  depth: number,
  bodyHeight: number,
  numbering: GongmunNumbering,
  sizes: GaejosikSizeOverrides = {},
  bullet2: "ㅇ" | "○" = "○",
  press = false,
): LevelIndent {
  // 개조식은 실측 양식의 들여쓰기 체계(□ 0 / ○ 1자 / - 1.5자 …)를 따른다.
  if (numbering === "gaejosik") return gaejosikLevelIndent(depth, bodyHeight, sizes, bullet2)
  // 같은 단계는 부호 종류가 일정하므로 대표 부호(순번 0)의 폭으로 내어쓰기를 정한다.
  const marker = numbering === "report" ? reportMarker(depth, bullet2, press) : standardMarker(depth, 0)
  return { left: Math.round(depth * bodyHeight), indent: -markerWidth(marker, bodyHeight) }
}

// ─── 단일 형제 부호 생략(2-pass) ─────────────────────

/**
 * 리스트 항목들의 (depth) 시퀀스를 받아, 각 항목의 '형제 수'를 계산.
 * 규정: 항목이 하나만 있으면 부호를 부여하지 않는다.
 * 같은 부모 아래 같은 depth 형제가 1개뿐이면 true(=부호 생략) 반환 배열.
 * (불릿 'report' 모드에는 적용하지 않는다 — 호출 측에서 분기.)
 *
 * 입력은 하나의 연속된 리스트(run)의 depth 배열.
 */
export function computeSuppression(depths: number[]): boolean[] {
  // groupKey(부모 경로) → 형제 수
  const counts = new Map<string, number>()
  const keys: string[] = []
  const path: number[] = [] // path[d] = depth d에서 현재까지 등장한 형제 순번
  for (const depth of depths) {
    path.length = depth + 1
    path[depth] = (path[depth] ?? 0) + 1
    const parentKey = path.slice(0, depth).join(".") + "|" + depth
    keys.push(parentKey)
    counts.set(parentKey, (counts.get(parentKey) ?? 0) + 1)
  }
  return keys.map((k) => (counts.get(k) ?? 0) <= 1)
}

// ─── 마커 카운터(렌더 시 형제 순번 추적) ──────────────

/**
 * 리스트 run을 순회하며 depth별 카운터를 유지, 각 항목의 마커 문자열을 산출.
 * 상위 depth가 진행되면 하위 카운터는 리셋된다.
 */
export class GongmunNumberer {
  private counts: number[] = []
  constructor(
    private numbering: GongmunNumbering,
    private bullet2: "ㅇ" | "○" = "○",
    private press = false,
  ) {}

  /** depth 항목 하나에 대한 마커. suppress=true면 빈 문자열(부호 없음) */
  next(depth: number, suppress: boolean): string {
    // 하위 depth 카운터 리셋
    this.counts.length = depth + 1
    const n = (this.counts[depth] ?? 0)
    this.counts[depth] = n + 1
    if (suppress) return ""
    if (this.numbering === "gaejosik") return gaejosikMarker(depth, this.bullet2)
    return this.numbering === "report"
      ? reportMarker(depth, this.bullet2, this.press)
      : standardMarker(depth, n)
  }

  reset(): void {
    this.counts = []
  }
}

// ─── HWPUNIT 환산 ───────────────────────────────────

/** 1mm → HWPUNIT (7200/25.4) */
export function mmToHwpunit(mm: number): number {
  return Math.round((mm * 7200) / 25.4)
}
