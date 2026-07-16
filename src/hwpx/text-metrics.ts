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
}

/** 코드포인트의 advance(em×1000). 미상 문자는 CJK권 970 / 라틴권 550 폴백 */
export function charWidthEm1000(cp: number): number {
  if (cp >= 0x20 && cp <= 0x7e) return ASCII_W[cp - 0x20]
  const sym = SYM_W[cp]
  if (sym !== undefined) return sym
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
  return cp >= 0x2e80 ? 970 : 550
}

/** HWP 공백 폭(em×1000) — useFontSpace=0(기본): 반각 고정 500 / =1: 글꼴값 300 */
export const SPACE_EM_FIXED = 500
export const SPACE_EM_FONT = 300

/**
 * 폭 테이블 클래스 — 'hcr'(함초롬 실측, 기본) / 'fixedPitch'(고정폭 글꼴:
 * ASCII 0.5em·그 외 1.0em). 굴림체·돋움체·바탕체·궁서체('체' 접미 = 고정폭)가
 * 대상 — 전자결재 변환기 산출물의 지배 본문 글꼴. 한글이 HCR(0.97em)보다 3%
 * 넓어 함초롬 테이블로 재면 줄당 1~2자 과대적재로 wrap 지점이 어긋난다
 * (bench/verify-linebreak.mjs seoul 코퍼스 실측: fixedPitch 테이블로 74/75 일치).
 */
export type FaceClass = "hcr" | "fixedPitch"

/** HWP 글꼴명 → 폭 테이블 클래스. 미상/미지정은 hcr (기존 동작 불변) */
export function faceClassOf(face: string | null | undefined): FaceClass {
  return face && /^(굴림체|돋움체|바탕체|궁서체)$/.test(face.trim()) ? "fixedPitch" : "hcr"
}

/** 고정폭 글꼴 advance(em×1000) — ASCII 반각 500, 그 외 전각 1000 */
function fixedPitchWidthEm1000(cp: number): number {
  return cp < 0x80 ? 500 : 1000
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
  const widthEm = opts?.faceClass === "fixedPitch" ? fixedPitchWidthEm1000 : charWidthEm1000
  let em = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const w = cp === 0x20 ? spaceEm : widthEm(cp)
    em += w * (1 + spacing / 100)
  }
  return (em / 1000) * height * (ratioPct / 100)
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

export type WrapMode = "keep" | "charAll"

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
 * 한 어절이 줄보다 길면 keep에서도 글자 단위로 강제 분해(한컴 동일).
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
  opts?: MeasureOptions,
): WrapResult {
  const EPS = 0.5
  const spaceEm = opts?.spaceEm ?? SPACE_EM_FIXED
  const spacing = opts?.spacingPct ?? 0
  const widthEm = opts?.faceClass === "fixedPitch" ? fixedPitchWidthEm1000 : charWidthEm1000
  const k = (height * ratioPct) / 100 / 1000
  const cwCp = (cp: number): number =>
    (cp === 0x20 ? spaceEm : widthEm(cp)) * (1 + spacing / 100) * k
  const charW = (ch: string): number => cwCp(ch.codePointAt(0)!)
  const rangeW = (from: number, to: number): number => {
    let w = 0
    for (const ch of text.slice(from, to)) w += charW(ch)
    return w
  }

  // u 플래그 필수 — 없으면 astral 문자(𝐀·이모지 등)가 서로게이트 반쪽 2개로 쪼개져 폭이 2배로 계산된다
  const units = text.match(mode === "keep" ? / +|[^ ]+/gu : / +|[^ ]/gu) ?? []

  const starts = [0]
  let lineW = 0
  let avail = firstWidth
  let pos = 0
  const lineStart = (): number => starts[starts.length - 1]

  /** 유닛(시작 unitPos, 폭 w)이 안 들어갈 때 줄바꿈 + 금칙 보정 */
  const breakBefore = (unitPos: number, w: number): void => {
    let bp = unitPos
    const u = text[unitPos]
    // 시작금칙: 줄머리 금지 문자면 직전 글자 1개를 함께 내린다 (밀어내기)
    if (u !== undefined && FORBID_START.has(u) && bp - 1 > lineStart() && text[bp - 1] !== " ") bp--
    // 끝금칙: 남는 줄 끝이 여는 괄호류면 그 글자(들)도 함께 내린다
    while (bp - 1 > lineStart() && FORBID_END.has(text[bp - 1])) bp--
    if (bp <= lineStart()) bp = unitPos
    starts.push(bp)
    avail = contWidth
    lineW = rangeW(bp, unitPos) + w
  }

  for (const u of units) {
    if (u[0] === " ") {
      lineW += charW(" ") * u.length // 줄 끝 공백은 hang
      pos += u.length
      continue
    }
    const w = rangeW(pos, pos + u.length)
    if (lineW + w <= avail + EPS) {
      lineW += w
      pos += u.length
      continue
    }
    if (lineW === 0 || w > contWidth + EPS) {
      // 빈 줄이거나 다음 줄에도 안 들어가는 초장 유닛 — 글자 단위 강제 분해
      let sub = 0
      for (const ch of u) {
        const c = charW(ch)
        if (lineW + c > avail + EPS && lineW > 0) breakBefore(pos + sub, 0)
        lineW += c
        sub += ch.length
      }
      pos += u.length
      continue
    }
    breakBefore(pos, w)
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
