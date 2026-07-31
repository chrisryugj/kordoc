/**
 * HWP 3.0 상용 조합형 → 유니코드 디코더.
 *
 * 한국어 한글은 cho/jung/jong 비트 분해로 0xAC00 한글 음절 영역에 직접 매핑되고,
 * 한자/기호 등 그 외 영역은 johab-symbols.ts 의 lookup table 로 처리한다.
 * 매핑되지 않는 코드는 '?' 로 fallback 한다.
 *
 * 출처: rhwp/src/parser/hwp3/johab.rs (MIT). 알고리즘 동일.
 */

import { JOHAB_SYMBOLS } from "./johab-symbols.js"

// 인덱스 → 자모 위치. -1 은 invalid (KS X 1001 johab 정의).
const CHO_MAP: ReadonlyArray<number> = Object.freeze([
  -1, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18,
  -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
])
const JUNG_MAP: ReadonlyArray<number> = Object.freeze([
  -1, -1, -1, 0, 1, 2, 3, 4, -1, -1, 5, 6, 7, 8, 9, 10, -1, -1, 11, 12, 13, 14,
  15, 16, -1, -1, 17, 18, 19, 20, -1, -1,
])
const JONG_MAP: ReadonlyArray<number> = Object.freeze([
  -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, -1, 17, 18, 19,
  20, 21, 22, 23, 24, 25, 26, 27, -1, -1,
])

/** JOHAB_SYMBOLS flat array (key,val,key,val…) 에서 key 이진 탐색. */
function lookupSymbol(ch: number): number | null {
  let lo = 0
  let hi = JOHAB_SYMBOLS.length / 2 - 1
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    const k = JOHAB_SYMBOLS[mid * 2]
    if (k === ch) return JOHAB_SYMBOLS[mid * 2 + 1]
    if (k < ch) lo = mid + 1
    else hi = mid - 1
  }
  return null
}

/** 매핑 실패를 명확히 알리기 위한 sentinel. 호출자가 string 에 추가하지 않도록 skip. */
export const JOHAB_UNMAPPED = -1

/** 옛한글 아래아 중성 인덱스 (KSSM 조합형) */
const JUNG_ARAEA = 30
/** HANGUL JUNGSEONG ARAEA (U+119E) */
const ARAEA_JAMO = 0x119e

/**
 * 아래아(ㆍ) 음절을 초성·아래아·종성 자모열로 푼다. 아래아가 아니면 null.
 *
 * HWP3 은 'ᄒᆞᆫ'(한글 97 안내문의 'ᄒᆞᆫ글') 같은 음절을 hchar 하나로 저장하지만,
 * 완성형 영역에는 대응 음절이 없어 `decodeJohab` 은 UNMAPPED 를 반환한다 — 그러면
 * 파서가 조용히 건너뛰어 글자가 사라진다. 한컴의 HWP5/HWPX 변환본도 자모열로
 * 보존하므로 같은 표현을 쓴다 (rhwp decode_johab_araea_jamo 포팅).
 */
function decodeAraeaSyllable(ch: number): string | null {
  if (ch < 0x8000) return null
  if (((ch >> 5) & 0x1f) !== JUNG_ARAEA) return null

  const cho = CHO_MAP[(ch >> 10) & 0x1f]
  const jong = JONG_MAP[ch & 0x1f]
  if (cho === -1 || jong === -1) return null

  // 초성은 U+1100 계열, 종성은 U+11A7 기준 (jong 0 = 받침 없음)
  const out = String.fromCodePoint(0x1100 + cho) + String.fromCodePoint(ARAEA_JAMO)
  return jong === 0 ? out : out + String.fromCodePoint(0x11a7 + jong)
}

/**
 * HWP3 hchar (u16) → 텍스트. 매핑 실패면 null (호출자가 건너뛴다).
 *
 * 대부분 한 글자지만 아래아 음절은 자모 2~3개가 되므로 문자열을 반환한다.
 * 단일 코드포인트가 필요한 곳은 `decodeJohab` 을 그대로 쓴다.
 */
export function decodeJohabText(ch: number): string | null {
  const araea = decodeAraeaSyllable(ch)
  if (araea) return araea
  const cp = decodeJohab(ch)
  return cp === JOHAB_UNMAPPED ? null : String.fromCodePoint(cp)
}

/**
 * HWP3 hchar (u16) → 유니코드 코드포인트. 매핑 실패 시 JOHAB_UNMAPPED.
 *
 * 매핑 실패 케이스를 '?' 로 fallback 시키면 검색 인덱스에 noise 가 누적된다 (특히
 * 메타 컨트롤이 가득한 paragraph 가 ??? 시퀀스를 생산). 호출자가 unmapped 를
 * 식별해서 silently skip 할 수 있도록 sentinel 을 반환한다.
 */
export function decodeJohab(ch: number): number {
  // ASCII 영역 — 1바이트 직접 사용
  if (ch < 0x80) return ch

  // 조합형 한글 (상위 비트 1): cho 5b | jung 5b | jong 5b
  if (ch >= 0x8000) {
    const choIdx = (ch >> 10) & 0x1f
    const jungIdx = (ch >> 5) & 0x1f
    const jongIdx = ch & 0x1f

    const cho = CHO_MAP[choIdx]
    const jung = JUNG_MAP[jungIdx]
    const jong = JONG_MAP[jongIdx]

    // jong === -1 은 예약/무효 종성 인덱스(0·18·30·31) — '받침 없음'(인덱스 1 → 값 0) 과
    // 구분해야 한다. 종전엔 -1 을 0 으로 치환해 원문에 없던 완성형 음절을 조용히 합성했다
    // (rhwp #2924 정합). 무효면 아래 한자/기호 lookup → JOHAB_UNMAPPED 경로로 넘긴다.
    if (cho !== -1 && jung !== -1 && jong !== -1) {
      // 0xAC00 + (cho * 21 * 28) + (jung * 28) + jong
      return 0xac00 + cho * 588 + jung * 28 + jong
    }

    // 한자/기호: lookup table
    const hit = lookupSymbol(ch)
    if (hit !== null) return hit
    return JOHAB_UNMAPPED
  }

  // 사적 graphic char 영역 (0x0080~0x7FFF) — rhwp decode_hwp3_extra 포팅
  // (HWP3↔한컴 HWP5 변환본 cross-ref로 도출된 매핑, rhwp e184718~aa8b47c).
  return decodeHwp3Extra(ch)
}

/**
 * HWP3 사적 graphic char (0x0080~0x7FFF) → 유니코드. 매핑 없으면 JOHAB_UNMAPPED.
 *
 * rhwp 는 한컴 PUA(U+F03C5 등)를 보존하고 렌더러가 표시값으로 확장하지만,
 * kordoc 은 렌더러 없이 markdown 으로 직행하므로 한컴오피스 표시값을 직접
 * 방출한다 (미매핑 Supplementary PUA 는 builder.sanitizeText 가 제거하므로
 * PUA 방출은 글자 증발로 이어짐). 관계도 선문자(0x301E/0x3024/0x3027)는
 * 표준 근사가 없어 미매핑 유지.
 */
function decodeHwp3Extra(ch: number): number {
  // 로마숫자 대문자 Ⅰ~Ⅹ ("Ⅰ. 사업개요" 류 장 제목)
  if (ch >= 0x3590 && ch <= 0x3599) return 0x2160 + (ch - 0x3590)
  // 원문자 ①~⑩
  if (ch >= 0x36e7 && ch <= 0x36f0) return 0x2460 + (ch - 0x36e7)
  // 머리말 회사명 그래픽 글자 "한글과컴퓨터" 6자 (rhwp 44cabad9 — HWP3 원본 0x37C0~0x37C5,
  // 같은 문서의 HWPX 변환본 U+F03EF~F03F4, 한컴 PDF 표시값 3자 대조로 확정).
  // rhwp 는 PUA 를 보존하고 렌더러가 표시값으로 펼치지만, kordoc 은 표시값 직행 정책.
  if (ch >= 0x37c0 && ch <= 0x37c5) return "한글과컴퓨터".codePointAt(ch - 0x37c0)!
  switch (ch) {
    case 0x0081: return 0x201c // 왼쪽 큰따옴표
    case 0x0082: return 0x201d // 오른쪽 큰따옴표
    case 0x301c: return 0x2501 // ━ 굵은 가로선 (rhwp: U+F080F, 표시값 직행)
    case 0x303d: return 0x25a0 // ■ (rhwp: U+F0827, 표시값 직행)
    case 0x3366: return 0x25a1 // □ 글머리 (rhwp: U+F03C5, 한컴 표시값 직행)
    case 0x3404: return 0x2024 // 한 점 리더
    case 0x3441: return 0x25a0 // ■
    case 0x3446: return 0x2192 // → 오른쪽 화살표
    case 0x35e1: return 0x2500 // ─ 상자 그리기 가로선
    case 0x3479: return 0x25b7 // ▷
    case 0x347a: return 0x25b6 // ▶
    case 0x2f67: return 0x25b8 // ▸ 표 셀 글머리표 (rhwp 16db8260 — HWP5 변환본·한컴 PDF 대조)
    default: return JOHAB_UNMAPPED
  }
}

/**
 * HWP3 hchar stream (u16 LE 순서) 를 string 으로 디코딩.
 *
 * DocSummary 의 56 hchar (112 byte) 영역에 사용. 본문 char stream 과 같은 단위인데
 * 그 영역은 ASCII 도 high byte 0 으로 padding 되어 있다 ("C\x00r\x00..."). byte 단위
 * 디코딩으로 처리하면 NUL 에서 break 되어 첫 글자만 남으므로, hchar 단위 LE u16 로
 * 읽고 그 값이 0 이면 종료한다.
 */
export function decodeHcharString(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  while (i + 1 < bytes.length) {
    const ch = bytes[i] | (bytes[i + 1] << 8) // LE u16
    if (ch === 0) break
    out += decodeJohabText(ch) ?? ""
    i += 2
  }
  return out
}

/**
 * HWP3 byte sequence (1바이트 ASCII < 0x80, 2바이트 johab >= 0x80) 를 string 으로 디코딩.
 * NUL byte 만나면 종료. link_print_file/description 같은 짧은 byte string 영역에 사용.
 */
function decodeHwp3String(bytes: Uint8Array): string {
  let out = ""
  let i = 0
  while (i < bytes.length) {
    const b1 = bytes[i]
    if (b1 === 0) break
    if (b1 < 0x80) {
      out += String.fromCharCode(b1)
      i += 1
    } else if (i + 1 < bytes.length) {
      const ch = (b1 << 8) | bytes[i + 1]
      out += decodeJohabText(ch) ?? ""
      i += 2
    } else {
      i += 1
    }
  }
  return out
}
