/**
 * 한글 조판 텍스트 폭 계산 — 함초롬바탕(HCR Batang) 실측 advance 테이블
 *
 * 공문서 표준 본문 글꼴인 함초롬바탕 정품 TTF(한컴 공개 배포)의 hmtx advance를
 * upem=1000 기준으로 추출한 값이다. Bold도 advance가 Regular와 완전히 동일함을
 * 전수 확인했다(한컴이 굵기 간 폭을 통일해 제작). 한글 음절 11,172자 전수 = 970,
 * 한자 = 1000, 전각형·원문자·도형·화살표·단위기호 = 970으로 균일하다.
 *
 * 단위: em×1000. 실제 폭(HWPUNIT) = w/1000 × charPr.height × ratio(장평)/100.
 * (1em = 글자크기 = charPr.height HWPUNIT — 1pt = 100 HWPUNIT이므로)
 *
 * 공백: HWP는 charPr useFontSpace=0(기본)일 때 글꼴의 space advance(0.30em) 대신
 * 반각 고정폭(0.50em)을 쓴다 — kordoc 생성 문서는 모두 useFontSpace=0이므로
 * 기본 SPACE_EM=500. (글꼴값을 쓰려면 measure 옵션 fontSpace로 300 지정)
 *
 * 다른 글꼴(맑은 고딕 등)도 한글=전각 균일·숫자≈0.55em의 동일 부류 구조라
 * 이 테이블로 근사한다(오차 수 % 이내 — 공문서 본문은 어차피 함초롬바탕 관행).
 */

import { fontWidthFn, hasFontMetrics, isHalfwidthForm } from "./font-metrics.js"

/** ASCII 0x20~0x7E advance (em×1000). 0x20은 useFontSpace=1일 때의 글꼴값(300) */
const ASCII_W = [
  300, 320, 320, 610, 610, 830, 724, 320, 320, 320, 550, 550, 320, 550, 320, 550, // 0x20-0x2F
  550, 550, 550, 550, 550, 550, 550, 550, 550, 550, 320, 320, 550, 550, 550, 550, // 0x30-0x3F
  830, 706, 605, 685, 719, 627, 617, 683, 734, 305, 315, 660, 605, 839, 734, 732, // 0x40-0x4F
  603, 705, 660, 627, 664, 731, 706, 910, 705, 705, 626, 320, 550, 320, 550, 550, // 0x50-0x5F
  320, 569, 597, 552, 597, 536, 356, 562, 635, 287, 288, 582, 287, 907, 635, 588, // 0x60-0x6F
  597, 579, 478, 496, 356, 635, 563, 720, 542, 543, 486, 320, 320, 320, 550, 0,   // 0x70-0x7E(+DEL)
]

/** 개별 실측 예외 기호 (em×1000) */
const SYM_W: Record<number, number> = {
  0xa0: 300, 0xa3: 568, 0xa5: 707, 0xa7: 498, 0xab: 440, 0xac: 564, 0xb0: 291,
  0xb1: 798, 0xb6: 606, 0xb7: 320, 0xbb: 440, 0xd7: 617, 0xf7: 678,
  0x2013: 625, 0x2014: 875, 0x2015: 875, 0x2018: 320, 0x2019: 320, 0x201c: 480, 0x201d: 480,
  0x2020: 558, 0x2021: 438, 0x2025: 640, 0x2026: 960, 0x2030: 988, 0x2032: 335, 0x2033: 474,
  0x203b: 770, 0x20ac: 656, 0x261c: 1012, 0x261e: 1012,
  0x274d: 970, // ❍ 2단계 부호(일부 중앙부처) — 미실측, ○ 와 같은 전각으로 둔다
  // 한컴 PDF 임베드 HCRBatang /W 실측 — 종전 기본값 550 으로 떨어지던 기호
  0x2bc: 164, 0x2022: 399, 0x2023: 369, 0x2024: 289, 0x2027: 289,
}

/** 코드포인트의 advance(em×1000). 미상 문자는 CJK권 970 / 라틴권 550 폴백 */
export function charWidthEm1000(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return ASCII_W[cp - 0x20]
  const sym = SYM_W[cp]
  if (sym !== undefined) return sym
  if (isHalfwidthForm(cp)) return 500 // 반각 형태 ｢ ｣ ･
  if (cp >= 0xac00 && cp <= 0xd7a3) return 970 // 한글 음절 (전수 균일 확인)
  if (cp >= 0x1100 && cp <= 0x11ff) return 970 // 옛한글 자모
  if (cp >= 0x3131 && cp <= 0x318e) return 970 // 호환 자모 (ㆍ 포함)
  if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xf900 && cp <= 0xfaff)) return 1000 // 한자
  if ((cp >= 0x3008 && cp <= 0x3011) || (cp >= 0x3014 && cp <= 0x301b)) return 500 // 「」『』〈〉《》〔〕【】
  if (cp === 0x3000) return 970 // 전각 공백
  if (cp >= 0x2160 && cp <= 0x2183) return 970 // 로마숫자 Ⅰ~Ⅻ (한글 글꼴 전각)
  if (cp >= 0x2190 && cp <= 0x22ff) return 970 // 화살표·수학 기호
  if (cp >= 0x2460 && cp <= 0x24ff) return 970 // 원문자 ①⑴
  if (cp >= 0x25a0 && cp <= 0x26ff) return 970 // 도형 □○◆★
  if (cp >= 0x3200 && cp <= 0x33ff) return 970 // 괄호한글 ㉮·단위 ㎡㎏
  if (cp >= 0xff01 && cp <= 0xff60) return 970 // 전각형 ！～
  // 기술 기호 ⌜⌟·상자 선 ━│┌·딩뱃 ❶➊➀ 는 전각(한컴 PDF HCRBatang 실측 970), 한컴 사용자 기호(보충 사용 영역)는 반각 몫 485
  if ((cp >= 0x2300 && cp <= 0x23ff) || (cp >= 0x2500 && cp <= 0x259f) || (cp >= 0x2700 && cp <= 0x27bf)) return 970
  if (cp >= 0xf0000) return 485
  return cp >= 0x2e80 ? 970 : 550
}

/** 폭 없는 문자 — 폭 없는 공백·연결자(U+200B~200D·2060·FEFF)와 결합 부호(U+0300~036F). 어느 글꼴로 재든 0(한컴 PDF 실측 0) */
function isZeroWidthCp(cp: number): boolean {
  return (cp >= 0x200b && cp <= 0x200d) || cp === 0x2060 || cp === 0xfeff || (cp >= 0x300 && cp <= 0x36f)
}

/** HWP 공백 폭(em×1000) — useFontSpace=0(기본): 반각 고정 500 / =1: 글꼴값 300 */
export const SPACE_EM_FIXED = 500
export const SPACE_EM_FONT = 300

/**
 * 폭 테이블 클래스 — 'hcr'(함초롬 실측, 기본) / 'fixedPitch'(고정폭 글꼴:
 * ASCII 0.5em·그 외 1.0em). 굴림체·돋움체·바탕체·궁서체('체' 접미 = 고정폭)와 옛 HFT 기본 글꼴 명조·고딕이
 * 대상 — 전자결재 변환기 산출물의 지배 본문 글꼴. 한글이 HCR(0.97em)보다 3%
 * 넓어 함초롬 테이블로 재면 줄당 1~2자 과대적재로 wrap 지점이 어긋난다
 * (bench/verify-linebreak.mjs seoul 코퍼스 실측: fixedPitch 테이블로 74/75 일치. 한컴 저장본 HFT 명조 문단 1,782개 중 1,776개·고딕 89개 중 83개 일치).
 */
const FIXED_PITCH_FACES = /^(굴림체|돋움체|바탕체|궁서체|명조|고딕)$/
export type FaceClass = "hcr" | "fixedPitch" | "gothic" | "cjk" | `font:${string}`

/**
 * HWP 글꼴명 → 폭 테이블 클래스. 미상/미지정은 hcr (기존 동작 불변).
 * 'gothic'(v5): 한컴돋움·맑은 고딕·HY견고딕·HY헤드라인M 등 굵은 고딕 — 한글 1.0em·ASCII 0.6em으로
 * 함초롬(0.97/0.55)보다 넉넉히 잡는다. 표 열폭·□ 한 줄 맞춤이 실렌더보다 좁게 재어 꺾이던 것 방지.
 */
export function faceClassOf(face: string | null | undefined): FaceClass {
  if (face && hasFontMetrics(face)) return `font:${face.trim()}`
  return face && FIXED_PITCH_FACES.test(face.trim()) ? "fixedPitch" : "hcr"
}

/**
 * reflow(조판 캐시 없는 문단) 폭 클래스 — 실측 폭표·고정폭은 faceClassOf 와 같고, 폭표 없는 한글 글꼴은 'cjk'(한글 1em).
 * 함초롬만 함초롬 폭으로 둔다. 한컴 저장본 두 줄 이상 문단 22,577개 대조: 줄 시작 전부 일치 39.4% → 49.8%(이 클래스만)
 */
export function faceClassForReflow(face: string | null | undefined): FaceClass {
  const c = faceClassOf(face)
  if (c !== "hcr" || !face || /^함초롬/.test(face.trim())) return c
  return "cjk"
}

/**
 * 생성(v5) 전용 폭 클래스 — 렌더(reflow)는 faceClassOf 그대로(게이트 baseline 불변).
 * 실측 폭표(font-metrics.ts)가 있는 글꼴은 그 표(`font:이름`), 없으면 근사 클래스 — 굵은 고딕 계열은
 * 'gothic'으로 넉넉히 재어 표 열폭·□ 한 줄 맞춤이 실렌더에서 꺾이지 않게 한다.
 * 폭표 없는 그 밖의 글꼴(바탕·한양신명조 …)도 'gothic'(한글 1em) — 함초롬 계열만 한글 0.97em 이고 실측한 다른 한글 글꼴 7종은
 * 전부 1em 이라, 함초롬 폭으로 재면 □ 한 줄 맞춤이 실렌더에서 넘친다(기관 서식 국세청 □ 바탕 14pt, 조판 예측기와 같은 가정).
 */
export function faceClassForGen(face: string | null | undefined): FaceClass {
  if (!face) return "hcr"
  const f = face.trim()
  if (hasFontMetrics(f)) return `font:${f}`
  if (FIXED_PITCH_FACES.test(f)) return "fixedPitch"
  if (/^함초롬/.test(f)) return "hcr"
  return "gothic"
}

/**
 * 고딕 근사 advance(em×1000) — 한컴돋움·맑은 고딕 계열 실렌더 대비 보수적으로:
 * 대문자 0.72 · 소문자 0.56 · 숫자 0.58 · 괄호 0.35 · 마침표류 0.28 · 그 외 ASCII 0.5 · 전각 1.0
 * (실측: "DT_1YL21161" 한컴돋움 12pt 셀이 함초롬 테이블(0.55)로는 25% 좁게 재어져 글자 분해)
 */
function gothicWidthEm1000(cp: number): number {
  if (cp >= 0x80) return 1000
  if (cp >= 0x41 && cp <= 0x5a) return 720
  if (cp >= 0x61 && cp <= 0x7a) return 560
  if (cp >= 0x30 && cp <= 0x39) return 580
  if (cp === 0x28 || cp === 0x29 || cp === 0x5b || cp === 0x5d) return 350
  if (cp === 0x2e || cp === 0x2c || cp === 0x3a || cp === 0x3b || cp === 0x27) return 280
  return 500
}

/** 폭표 없는 한글 글꼴 advance(em×1000) — 자모·한글·한자·전각 기호(U+1100 이후)는 1em, 그 아래(ASCII·라틴)는 함초롬 폭.
 *  실측 한글 글꼴(바탕·돋움·한양신명조·HY신명조·한컴바탕 …)의 음절 폭은 1em 이고 함초롬 계열만 0.97em 이다 */
function cjkWidthEm1000(cp: number): number {
  return isHalfwidthForm(cp) ? 500 : cp >= 0x1100 ? 1000 : charWidthEm1000(cp)
}

/** 고정폭 글꼴 advance(em×1000) — ASCII 반각 500, 그 외 전각 1000 */
function fixedPitchWidthEm1000(cp: number): number {
  return cp < 0x80 || isHalfwidthForm(cp) ? 500 : 1000
}

/** 폭 클래스 → advance 함수. `font:이름` 은 실측 폭표(없는 글꼴명이면 gothic 근사) */
function widthFnOf(faceClass: FaceClass | undefined): (cp: number) => number {
  const f = baseWidthFnOf(faceClass)
  return cp => (isZeroWidthCp(cp) ? 0 : f(cp))
}

function baseWidthFnOf(faceClass: FaceClass | undefined): (cp: number) => number {
  if (faceClass === "fixedPitch") return fixedPitchWidthEm1000
  if (faceClass === "gothic") return cp => (isHalfwidthForm(cp) ? 500 : gothicWidthEm1000(cp))
  if (faceClass === "cjk") return cjkWidthEm1000
  if (faceClass?.startsWith("font:")) {
    const face = faceClass.slice(5)
    return fontWidthFn(face) ?? gothicWidthEm1000
  }
  return charWidthEm1000
}

/** 공백류 — 일반 공백과 묶음 빈칸(U+00A0 → hp:nbSpace)은 한컴 고정 반각 공백 폭 */
function isSpaceCp(cp: number): boolean {
  return cp === 0x20 || cp === 0xa0
}

export interface MeasureOptions {
  /** 공백 폭(em×1000). 기본 SPACE_EM_FIXED(500) = useFontSpace 0 */
  spaceEm?: number
  /** 자간(charPr spacing %) — 글자폭의 %가 문자마다 추가 */
  spacingPct?: number
  /** 폭 테이블 클래스 — 기본 'hcr' (함초롬 실측 테이블) */
  faceClass?: FaceClass
}

/**
 * 텍스트 폭(HWPUNIT). height=charPr height(pt×100), ratioPct=장평 %.
 * 결과는 float — 호출부에서 비교 시 ±0.5 HWPUNIT 오차 허용 권장.
 */
export function measureTextWidth(
  text: string,
  height: number,
  ratioPct: number,
  opts?: MeasureOptions,
): number {
  const spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED
  const spacing = opts?.spacingPct ?? 0
  const widthEm = widthFnOf(opts?.faceClass)
  let em = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const w = isSpaceCp(cp) ? spaceEm : widthEm(cp)
    em += w * (1 + spacing / 100)
  }
  return (em / 1000) * height * (ratioPct / 100)
}

/** MulDiv — 반올림(0 에서 멀어지는 쪽) */
export function mulDiv(a: number, b: number, c: number): number {
  const e = a * b
  return Math.trunc(e < 0 ? (e - c / 2) / c : (e + c / 2) / c)
}

/**
 * 한컴 조판의 글자 폭(HWPUNIT) — 글자마다 4 단위로 양자화한다(한컴독스 웹 한글 조판 엔진의 산식).
 * 글자: 장평 100 이면 4·MulDiv(폭, ⌊크기/4⌋, 1000), 아니면 4·⌊폭·⌊크기/4⌋·장평/(100·1000)⌋.
 * 공백(useFontSpace 0): 4·⌊크기/8⌋ (장평 ≠ 100 이면 4·MulDiv(⌊크기/8⌋, 장평, 100)). 자간: + 4·MulDiv(⌊폭/4⌋, 자간, 100)
 */
export function hancomCharWidth(ch: string, height: number, ratioPct: number, spacingPct: number, faceClass?: FaceClass): number {
  const cp = ch.codePointAt(0)!
  let w: number
  if (isSpaceCp(cp)) {
    const s = Math.trunc(height / 8)
    w = 4 * (ratioPct === 100 ? s : mulDiv(s, ratioPct, 100))
  } else {
    const em = widthFnOf(faceClass)(cp), q = Math.trunc(height / 4)
    w = ratioPct === 100 ? 4 * mulDiv(em, q, 1000) : 4 * Math.trunc(em * q * ratioPct / 100000)
  }
  if (spacingPct) w += 4 * mulDiv(Math.trunc(w / 4), spacingPct, 100)
  return w
}

// ─── 줄바꿈 시뮬레이션 (한컴 조판 모델 — 실측 linesegarray 98% 일치 검증) ───
//
// 검증: bench/verify-linebreak.mjs — 서울 정보소통광장 실제 결재문서의 linesegarray
// (한컴 계열 조판기가 계산한 줄 시작 오프셋)와 대조. 고정폭 글꼴 버킷에서 98%
// (56/57 줄바꿈점, 미스는 코퍼스 좌표계 노이즈) 일치. 이 과정에서 확정된 규칙:
//  - 공백 폭 = 0.5em 고정(useFontSpace=0), 장평·자간 모두 공백에도 적용
//  - 자간 = 글자폭 × (1+spacing/100)
//  - 줄 끝 공백은 hang (줄바꿈을 유발하지 않음)
//  - 금칙: 시작금칙(닫는 부호 줄머리 금지)은 직전 글자 1개를 동반해 다음 줄로
//    (밀어내기), 끝금칙(여는 괄호 줄끝 금지)은 그 글자를 다음 줄로 내림

/** 줄머리 금지(시작금칙) 문자 — 한컴 기본 */
const FORBID_START = new Set([..."!%),.:;?]}¢°′″℃〉》」』】〕!%),.:;?]}₩~…·、。〃"])
/** 줄끝 금지(끝금칙) 문자 — 한컴 기본 */
const FORBID_END = new Set([..."$([{£¥〈《「『【〔$([{₩"])

/** 한컴 기본 금칙 집합(한컴독스 웹 한글 조판 엔진의 기본값) — 줄머리 금지 */
const HANCOM_FORBID_START = new Set([..."!%),.:;>?]^`}~°·〉》」』】〕〗〙〛・！％），．：；＞？］＾｀｝～･ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ、。〃々ー゛゜ゝゞヽヾ’”․‥…‰‱′″‴‵‶‷℃℉"])
/** 한컴 기본 금칙 집합 — 줄끝 금지(통화 기호 U+20A0~20AC 포함) */
const HANCOM_FORBID_END = new Set([..."(<[\\{§‘“〈《「『【〔〖〘〚＄（＜［＼｛￠￡￥￦$¢£¤¥৲৳฿", ...Array.from({ length: 13 }, (_, i) => String.fromCharCode(0x20a0 + i))])

export type WrapMode = "keep" | "charAll"

interface PreparedWrap { units: string[]; advances: number[]; steps: number[] }

/** 한 문단의 장평·자간 후보 사이에서 문자 해독과 글꼴 폭표 조회만 재사용한다. */
export function prepareWrap(text: string, mode: WrapMode, opts?: MeasureOptions): PreparedWrap {
  const widthEm = widthFnOf(opts?.faceClass), spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED
  const advances: number[] = [], steps: number[] = []
  let i = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    advances[i] = isSpaceCp(cp) ? spaceEm : widthEm(cp)
    steps[i] = ch.length
    i += ch.length
  }
  return { units: splitWrapUnits(text, mode), advances, steps }
}

function splitWrapUnits(text: string, mode: WrapMode, latinBreak = false): string[] {
  // 영문 단어 끊기(breakLatinWord="BREAK_WORD" — 영문은 이름 그대로): 영문 글자도 한 글자씩 끊는다
  if (latinBreak) return text.match(mode === "keep" ? / +|[\x21-\x7e]|[^ \x21-\x7e]+/gu : / +|[^ ](?:\u00a0[^ \u00a0]?)*/gu) ?? []
  return text.match(mode === "keep" ? / +|[^ ]+/gu : / +|(?:[\x21-\x7e]+|[^ ])(?:\u00a0(?:[\x21-\x7e]+|[^ \u00a0])?)*/gu) ?? []
}

export interface WrapOptions extends MeasureOptions {
  /** UTF-16 단위별 실폭(HWPUNIT) — 주면 height·장평·폭 클래스 대신 쓴다(여러 run 문단, 탭 전진폭) */
  widths?: number[]
  /** 같은 text·mode·글꼴·공백 폭으로 준비한 원 폭 — 한 문단 압축 후보에만 재사용 */
  prepared?: PreparedWrap
  /** 공백 최소값(paraPr condense, %) — 줄 가용폭에 그 줄 공백 폭 합 × condense% 를 더한다 */
  condensePct?: number
  /** 금칙 집합 — 'hancom' 이면 한컴 기본 집합(reflow), 아니면 생성기 실측 집합 */
  kinsoku?: "hancom"
  /** widths 중 자간 몫(UTF-16 단위별) — 한컴은 넘침 판정에 마지막 글자의 자간을 넣지 않는다(판정 뒤 x 에 더한다) */
  spacings?: number[]
  /** 줄 번호(0부터)별 가용 폭 — 주면 firstWidth·contWidth 대신 쓴다(떠 있는 개체 둘레로 줄이 좁아질 때) */
  lineWidth?: (line: number) => number
  /** 영문 단어도 글자 단위로 끊는다(breakLatinWord="BREAK_WORD") */
  latinBreak?: boolean
}

export interface WrapResult {
  /** 줄 수 */
  lines: number
  /** 각 줄의 시작 오프셋(UTF-16) — [0, …] */
  starts: number[]
  /** 마지막 줄 텍스트 폭(HWPUNIT) */
  lastLineWidth: number
}

/**
 * 문단 줄바꿈 시뮬레이션.
 * mode 'keep' = 어절 단위(공문서 모드 — 저장 속성 breakNonLatinWord="BREAK_WORD", 이름 역전 주의),
 * mode 'charAll' = 글자 단위(breakNonLatinWord="KEEP_WORD" — 한글 기본값·전자결재 변환기).
 * 한 어절이 줄보다 길면 keep에서도 글자 단위로 강제 분해 — 한컴처럼 다음 줄로 넘긴 뒤 쪼갠다(앞 줄은 벌어진다).
 *
 * @param text        문단 전체 텍스트(항목 부호 포함)
 * @param firstWidth  첫 줄 가용 폭(HWPUNIT)
 * @param contWidth   둘째 줄부터 가용 폭(HWPUNIT) — 내어쓰기 반영
 * @param height      charPr height (pt×100)
 * @param ratioPct    장평 %
 */
export function simulateWrap(
  text: string,
  firstWidth: number,
  contWidth: number,
  height: number,
  ratioPct: number,
  mode: WrapMode = "keep",
  opts?: WrapOptions,
): WrapResult {
  // 강제 줄바꿈(\n — hp:lineBreak): 그 뒤는 새 줄이다. 조각마다 따로 채우고 \n(폭 0)은 앞 줄 끝에 남긴다
  if (!opts?.prepared && text.includes("\n")) {
    const starts: number[] = []
    let off = 0, lastLineWidth = 0
    for (;;) {
      const end = text.indexOf("\n", off), stop = end < 0 ? text.length : end, li = starts.length
      const lw = opts?.lineWidth
      const sub = simulateWrap(text.slice(off, stop), li === 0 ? firstWidth : contWidth, contWidth, height, ratioPct, mode, {
        ...opts,
        widths: opts?.widths?.slice(off, stop),
        spacings: opts?.spacings?.slice(off, stop),
        lineWidth: lw ? (i: number) => lw(li + i) : undefined,
      })
      for (const st of sub.starts) starts.push(off + st)
      lastLineWidth = sub.lastLineWidth
      if (end < 0) break
      off = end + 1
    }
    return { lines: starts.length, starts, lastLineWidth }
  }
  const EPS = 0.5
  const spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED
  const spacing = opts?.spacingPct ?? 0
  const prepared = opts?.prepared
  const widthEm = prepared ? null : widthFnOf(opts?.faceClass)
  const k = (height * ratioPct) / 100 / 1000
  const unitW = opts?.widths
  const forbidStart = opts?.kinsoku === "hancom" ? HANCOM_FORBID_START : FORBID_START
  const forbidEnd = opts?.kinsoku === "hancom" ? HANCOM_FORBID_END : FORBID_END
  const condense = opts?.condensePct ?? 0
  /** 한컴 조판 모드(reflow) — 한컴 금칙 집합과 공백에서 줄 끝내기 규칙 */
  const hancom = opts?.kinsoku === "hancom"
  const spAt = opts?.spacings
  /** [from, to) 마지막 글자의 자간 몫 — 넘침 판정에서 뺀다 */
  const lastSp = (from: number, to: number): number => {
    if (!spAt || to <= from) return 0
    let i = to - 1
    if (i > from && /[\uDC00-\uDFFF]/.test(text[i])) i--
    return spAt[i] ?? 0
  }
  /** i 위치(UTF-16) 글자 ch 의 폭 — widths 가 있으면 그 값(서로게이트 쌍은 두 칸 합) */
  const charWAt = (i: number, ch: string): number => {
    if (unitW) return (unitW[i] ?? 0) + (ch.length === 2 ? unitW[i + 1] ?? 0 : 0)
    if (prepared) return prepared.advances[i] * (1 + spacing / 100) * k
    const cp = ch.codePointAt(0)!
    return (isSpaceCp(cp) ? spaceEm : widthEm!(cp)) * (1 + spacing / 100) * k
  }
  const rangeW = (from: number, to: number): number => {
    let w = 0
    if (prepared && !unitW) {
      for (let i = from; i < to; i += prepared.steps[i]) w += prepared.advances[i] * (1 + spacing / 100) * k
      return w
    }
    for (let i = from; i < to;) {
      const ch = String.fromCodePoint(text.codePointAt(i)!)
      w += charWAt(i, ch)
      i += ch.length
    }
    return w
  }

  // u 플래그 필수 — 없으면 astral 문자(𝐀·이모지 등)가 서로게이트 반쪽 2개로 쪼개져 폭이 2배로 계산된다.
  // 글자 단위에서도 ASCII 연속열("1.):", "LLM),")은 한 단어 — breakLatinWord=KEEP_WORD(한글 2024 실렌더 PDF 대조).
  // 묶음 빈칸(U+00A0)은 어느 모드에서도 끊지 않는다 — 글자 단위에선 앞뒤 단위를 하나로 묶는다
  const units = prepared?.units ?? splitWrapUnits(text, mode, opts?.latinBreak)

  const starts = [0]
  let lineW = 0
  const lineWidth = opts?.lineWidth
  let avail = lineWidth ? lineWidth(0) : firstWidth
  let pos = 0
  /** 지금 줄의 공백 폭 합 — 공백 최소값(condense)만큼 공백이 줄어 가용폭이 늘어난다 */
  let spaceW = 0
  /** 이 줄에 공백 아닌 글자가 나왔는가 — 한컴은 줄 첫머리 공백을 공백 최소값 합에 넣지 않는다 */
  let realSeen = false
  /** 한컴: 공백에 닿았을 때 이미 줄 폭에 닿아 이 줄이 끝남 — 다음 낱말은 공백 최소값으로 남는 폭이 있어도 다음 줄로 */
  let lineEnded = false
  /** 이 줄에 놓인 공백 아닌 단위 수 — 한컴은 폭 0 컨트롤도 줄의 내용으로 쳐서, 그 뒤에서 넘치는 단위는 다음 줄로 보낸다 */
  let placed = 0
  const empty = (): boolean => lineW === 0 && (!hancom || placed === 0)
  const cap = (): number => avail + (condense > 0 ? Math.trunc(spaceW * condense / 100) : 0) + EPS
  const lineStart = (): number => starts[starts.length - 1]

  /** 유닛(시작 unitPos, 폭 w)이 안 들어갈 때 줄바꿈 + 금칙 보정 */
  const breakBefore = (unitPos: number, w: number): void => {
    let bp = unitPos
    const u = text[unitPos]
    const prevStart = (end: number): number => end - (end >= 2 && /[\uDC00-\uDFFF]/.test(text[end - 1]) && /[\uD800-\uDBFF]/.test(text[end - 2]) ? 2 : 1)
    // 시작금칙: 줄머리 금지 문자면 직전 글자 1개를 함께 내린다 (밀어내기)
    if (u !== undefined && forbidStart.has(u) && prevStart(bp) > lineStart() && text[bp - 1] !== " ") bp = prevStart(bp)
    // 끝금칙: 남는 줄 끝이 여는 괄호류면 그 글자(들)도 함께 내린다
    while (bp - 1 > lineStart() && forbidEnd.has(text[bp - 1])) bp--
    if (bp <= lineStart()) bp = unitPos
    starts.push(bp)
    avail = lineWidth ? lineWidth(starts.length - 1) : contWidth
    spaceW = 0
    realSeen = w > 0
    lineEnded = false
    placed = unitPos > bp ? 1 : 0
    for (let i = bp; i < unitPos; i++) {
      if (text[i] !== " ") realSeen = true
      else if (condense > 0 && (realSeen || !hancom)) spaceW += rangeW(i, i + 1)
    }
    lineW = rangeW(bp, unitPos) + w
  }
  /** 금칙 보정 없이 at 에서 새 줄 — 한컴이 공백에서 줄을 끝낼 때(금칙은 낱말이 넘칠 때만 본다) */
  const breakAt = (at: number, leadW: number): void => {
    starts.push(at)
    avail = lineWidth ? lineWidth(starts.length - 1) : contWidth
    spaceW = 0
    realSeen = false
    lineEnded = false
    placed = 0
    lineW = leadW
  }

  for (const u of units) {
    if (u[0] === " ") {
      if (hancom) {
        // 한컴: 공백마다 x 가 이미 줄 폭(공백 최소값 전)에 닿았으면 이 줄은 끝난다. 그 공백 덩어리는 앞 두 칸까지만
        // 이 줄에 남고 셋째 칸부터 다음 줄로 간다(굴림체 "같이  |    알려"). 닿지 않은 공백은 줄 끝에 걸린다(hang)
        let k = 0
        for (; k < u.length; k++) {
          if (!lineEnded && lineW >= avail) lineEnded = true
          if (lineEnded && k >= 2 && pos + k > lineStart()) break
          if (!lineEnded) {
            const sw = rangeW(pos + k, pos + k + 1)
            lineW += sw
            if (realSeen) spaceW += sw
          }
        }
        if (k < u.length) breakAt(pos + k, rangeW(pos + k, pos + u.length))
        pos += u.length
        continue
      }
      const sw = rangeW(pos, pos + u.length)
      lineW += sw // 줄 끝 공백은 hang
      spaceW += sw
      pos += u.length
      continue
    }
    if (lineEnded) breakAt(pos, 0)
    const w = rangeW(pos, pos + u.length)
    if (lineW + w - lastSp(pos, pos + u.length) <= cap()) {
      lineW += w
      realSeen = true
      placed++
      pos += u.length
      continue
    }
    if (empty() || w > (lineWidth ? lineWidth(starts.length) : contWidth) + EPS) {
      // 빈 줄이거나 다음 줄에도 안 들어가는 초장 유닛 — 글자 단위 강제 분해. 어절 단위에서는 한컴이 먼저 다음 줄로
      // 넘긴 뒤 쪼갠다(코퍼스 어절 단위 문단 400개: 넘긴 뒤 347·제자리 340 일치, 갈리는 13건은 넘긴 뒤가 맞음)
      if (mode === "keep" && !empty()) breakBefore(pos, 0)
      let sub = 0
      for (const ch of u) {
        const c = charWAt(pos + sub, ch)
        if (lineW + c - lastSp(pos + sub, pos + sub + ch.length) > cap() && !empty()) breakBefore(pos + sub, 0)
        lineW += c
        realSeen = true
        placed++
        sub += ch.length
      }
      pos += u.length
      continue
    }
    breakBefore(pos, w)
    placed++
    pos += u.length
  }
  return { lines: starts.length, starts, lastLineWidth: lineW }
}

/** @deprecated simulateWrap(text, …, 'keep') 별칭 — 하위 호환 */
export function simulateWrapKeepWord(
  text: string,
  firstWidth: number,
  contWidth: number,
  height: number,
  ratioPct: number,
  opts?: MeasureOptions,
): WrapResult {
  return simulateWrap(text, firstWidth, contWidth, height, ratioPct, "keep", opts)
}

/**
 * 한두 글자(짧은 꼬리)가 다음 줄로 넘어간 문단을 장평 축소로 한 줄 줄일 수 있는지
 * 탐색. baseRatio에서 줄 수 N≥2일 때 r=baseRatio-1…minRatio를 내려가며 처음으로
 * 줄 수가 줄어드는(가장 큰) r을 반환. 불가능하면 null.
 * (실무 관행: 공무원이 문단 장평을 95→92 등으로 줄여 orphan을 위로 당기는 조작의 자동화.
 * keep 모드로 판정 — 글자 단위 조판은 항상 keep 이하의 줄 수라 함께 만족된다.)
 */
export function fitRatioForFewerLines(
  text: string,
  firstWidth: number,
  contWidth: number,
  height: number,
  baseRatio: number,
  minRatio: number,
  opts?: MeasureOptions,
): number | null {
  const base = simulateWrap(text, firstWidth, contWidth, height, baseRatio, "keep", opts)
  if (base.lines < 2) return null
  for (let r = baseRatio - 1; r >= minRatio; r--) {
    const sim = simulateWrap(text, firstWidth, contWidth, height, r, "keep", opts)
    if (sim.lines < base.lines) return r
  }
  return null
}
