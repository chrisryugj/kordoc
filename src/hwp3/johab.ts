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

  const choIdx = (ch >> 10) & 0x1f
  const cho = CHO_MAP[choIdx]
  const jong = JONG_MAP[ch & 0x1f]
  if (jong === -1) return null
  // 초성 인덱스 1 은 '채움'(초성 없음) — 한컴 변환본은 아래아 자모 하나만 남긴다
  // (hwp3-sample16 0x87C1 ↔ 변환본 U+119E 실측). 그 외 무효 초성은 종전대로 미매핑.
  if (cho === -1) {
    if (choIdx !== 1) return null
    const bare = String.fromCodePoint(ARAEA_JAMO)
    return jong === 0 ? bare : bare + String.fromCodePoint(0x11a7 + jong)
  }

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
 * KS X 1001(KS C 5601) 완성형 좌표 한 쌍 → 유니코드 코드포인트. 미배정 자리는 null.
 *
 * row/cell 은 EUC-KR 고위 바이트 표기(0xA1~0xFE). Node 가 small-icu 로 빌드돼
 * 'euc-kr' 을 모르면 디코더가 null 이 되고, 좌표 규칙 전체가 종전처럼 미매핑으로
 * 떨어진다 (xls/encoding.ts 의 CP949 폴백과 같은 계약).
 */
let eucKrDecoder: TextDecoder | null | undefined
function kscChar(row: number, cell: number): number | null {
  if (eucKrDecoder === undefined) {
    try {
      eucKrDecoder = new TextDecoder("euc-kr", { fatal: false })
    } catch {
      eucKrDecoder = null
    }
  }
  if (!eucKrDecoder) return null
  if (row < 0xa1 || row > 0xfe || cell < 0xa1 || cell > 0xfe) return null
  const text = eucKrDecoder.decode(Uint8Array.of(row, cell))
  if (text.length !== 1) return null
  const cp = text.codePointAt(0)!
  if (cp === 0xfffd) return null // 완성형에 배정되지 않은 자리
  return hancomVariant(cp)
}

/**
 * 표준 KS X 1001 매핑과 한컴 관행이 갈리는 자리 보정 (rhwp hancom_variant 포팅).
 * 한컴 변환본 대조에서 실측된 차이만 싣는다.
 */
function hancomVariant(cp: number): number {
  // 0xA1AD: 표준 U+223C(∼) ↔ 한컴 U+FF5E(～). rhwp 실측 80건, kordoc sample11/14 실측 11건.
  if (cp === 0x223c) return 0xff5e
  // 0xA2C1: 표준 U+2299(⊙) ↔ 한컴 U+25C9(◉). sample11 ↔ hwp3-sample11-hwpx 문맥 정렬 2건.
  if (cp === 0x2299) return 0x25c9
  return cp
}

/**
 * HWP3 기호 영역: KS X 1001 기호행(0xA1~0xAC) 좌표를 **행 간격 96** 으로 편 코드.
 *
 * 기존 하드코딩이 이 식에서 그대로 유도된다 — `→`0x3446·`■`0x3441·`▷`0x3479·
 * `▶`0x347A·`─`0x35E1, 로마숫자 0x3590~0x3599, 원문자 0x36E7~0x36F0 전부 일치.
 * (rhwp decode_hwp3_ksc_symbol 포팅.)
 */
function decodeHwp3KscSymbol(ch: number): number | null {
  if (ch < 0x3401) return null
  const idx = ch - 0x3401
  const row = 0xa1 + Math.floor(idx / 96)
  if (row > 0xac) return null
  return kscChar(row, 0xa1 + (idx % 96))
}

/**
 * HWP3 한자 영역: KS X 1001 한자행(0xCA~0xFD) 좌표를 **행 간격 94** 로 편 코드.
 * (rhwp decode_hwp3_ksc_hanja 포팅. 실측: `債`0x4F5D→0xF3F0, `權`0x4222→0xCFED.)
 */
function decodeHwp3KscHanja(ch: number): number | null {
  if (ch < 0x4000) return null
  const idx = ch - 0x4000
  const row = 0xca + Math.floor(idx / 94)
  if (row > 0xfd) return null
  return kscChar(row, 0xa1 + (idx % 94))
}

/**
 * HWP3 사적 graphic char (0x0080~0x7FFF) → 유니코드. 매핑 없으면 JOHAB_UNMAPPED.
 *
 * 하드코딩 표를 **먼저** 보고, 없으면 완성형 좌표 규칙(기호 → 한자)으로 넘어간다.
 * 순서가 중요하다 — 회사명 graphic 0x37C0~0x37C5 는 기호 규칙으로는 가타카나가 된다.
 *
 * rhwp 는 한컴 PUA(U+F03C5 등)를 보존하고 렌더러가 표시값으로 확장하지만,
 * kordoc 은 렌더러 없이 markdown 으로 직행하므로 한컴오피스 표시값을 직접
 * 방출한다 (미매핑 Supplementary PUA 는 builder.sanitizeText 가 제거하므로
 * PUA 방출은 글자 증발로 이어짐). 관계도 선문자(0x301E/0x3024/0x3027)는
 * 표준 근사가 없어 미매핑 유지.
 */
function decodeHwp3Extra(ch: number): number {
  // 라틴 확장(Latin-1 Supplement) — HWP3 은 ü·ö·ä·ß 를 유니코드 값 그대로 hchar 에
  // 담는다. 매핑이 없으면 파서가 조용히 버려 "für"→"fr" 처럼 글자가 삭제된다
  // (rhwp #5555 — 실측 8코드 ü·ö·ä·ß·Ö·Ü·Ä·é 전부 항등). 사적 따옴표(0x0081~0x0084)는
  // 구간 밖이라 아래 하드코딩이 담당한다.
  if (ch >= 0x00a0 && ch <= 0x00ff) return ch
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
    // 텍스트 다이어그램 괘선 조각 — 한컴은 U+F0806~F0810 으로 보존하고 rhwp 검증표가
    // ┌┬┐└┘│ 로 편다. HWP3 코드는 그 PUA 에서 상수 오프셋(0xC07F3)만큼 떨어져 있고
    // (0x301C→F080F 가 이미 그 관계), hwp3-sample11 ↔ 변환본 개수도 그대로 맞는다
    // (0x3013×3↔┌, 0x3014×1↔┬, 0x3015×10↔┐, 0x3019×6↔└, 0x301B×9↔┘, 0x301D×17↔│).
    case 0x3013: return 0x250c // ┌
    case 0x3014: return 0x252c // ┬
    case 0x3015: return 0x2510 // ┐
    case 0x3019: return 0x2514 // └
    case 0x301b: return 0x2518 // ┘
    case 0x301d: return 0x2502 // │
    case 0x303d: return 0x25a0 // ■ (rhwp: U+F0827, 표시값 직행)
    case 0x3366: return 0x25a1 // □ 글머리 (rhwp: U+F03C5, 한컴 표시값 직행)
    case 0x3404: return 0x2024 // 한 점 리더
    case 0x3441: return 0x25a0 // ■
    case 0x3446: return 0x2192 // → 오른쪽 화살표
    case 0x35e1: return 0x2500 // ─ 상자 그리기 가로선
    case 0x3479: return 0x25b7 // ▷
    case 0x347a: return 0x25b6 // ▶
    case 0x2f67: return 0x25b8 // ▸ 표 셀 글머리표 (rhwp 16db8260 — HWP5 변환본·한컴 PDF 대조)
    // 아래 항등 코드들은 rhwp #5860 실측표(한글 2022 오라클 위치 정렬) 이식.
    // 같은 0x20xx 대에 항등과 비항등이 섞여 있어 구간 통과는 하지 않는다.
    case 0x2010: return 0x2010 // ‐
    case 0x2013: return 0x2013 // –
    case 0x2103: return 0x2103 // ℃
    case 0x2113: return 0x2113 // ℓ
    case 0x2190: return 0x2190 // ←
    case 0x2192: return 0x2192 // →
    case 0x2193: return 0x2193 // ↓
    case 0x2219: return 0x2219 // ∙ (sample11 실측 11건)
    case 0x22c5: return 0x22c5 // ⋅
    case 0x203b: return 0x203b // ※ — 한자를 완성형 좌표로 담으면서 ※ 만 유니코드 값으로 담은 문서가 있다
    // 비항등 — 유니코드로 읽으면 ⁚·․·⁘ 같은 다른 글자가 된다 (rhwp #5860)
    case 0x2024: return 0x30fb // ・
    case 0x2058: return 0x25b3 // △
    case 0x205a: return 0x25cb // ○
    case 0x2f08: return 0x25aa // ▪
    case 0x2f11: return 0x25e6 // ◦ (sample16 실측 332건)
    case 0x2f14: return 0x25e6 // ◦
    case 0x3157: return 0x2027 // ‧
    case 0x0480: return 0x02d0 // ː
    case 0x1f2e: return 0x306e // の
    case 0x32b0: return 0xff70 // ｰ (반각)
    case 0x3067: return 0x2018 // ‘
    case 0x3068: return 0x2019 // ’
    case 0x309b: return 0xff62 // ｢
    case 0x309d: return 0xff63 // ｣
    case 0x0083: return 0x2018 // ‘ — 큰따옴표(0x0081/0x0082) 바로 다음 코드 (sample11/14 실측 18건)
    case 0x0084: return 0x2019 // ’
    // 아래 셋은 rhwp 표에 없는 값 — kordoc 이 rhwp 샘플 ↔ 한컴 변환본 문맥 정렬로 실측했다.
    case 0x2022: return 0x2022 // • hwp3-sample 글머리표 4건 (항등)
    case 0x2f17: return 0x2022 // • hwp3-sample10 글머리표 3건
    case 0x2f06: return 0x25a0 // ■ hwp3-sample10 "제목차례" 좌우 장식 2건
    // 관인·서명란 도장 기호. rhwp 는 U+F012B 로 보존하고 렌더러가 `(인)` 으로 편다 —
    // kordoc 도 PUA 를 그대로 내보내면 shared/pua.ts 의 검증표가 같은 문자열로 편다.
    case 0x2bce: return 0xf012b
    // ═ 겹줄. rhwp 는 0x3048 을 U+F0832(렌더 표시값 `═`)로 보존한다. 0x37ED 는 기호
    // 규칙으로는 가타카나 `ネ` 가 되는 사적 graphic 코드로, sample10(42건)·sample11(12건)
    // 두 문서에서 한컴 변환본의 `═` 개수와 정확히 일치해 표시값 직행으로 싣는다.
    case 0x3048: return 0x2550
    case 0x37ed: return 0x2550
    // 사적 원문자·괄호문자 계열. 사적 코드는 일반식이 없어 실측 문서에서 연속으로
    // 확인된 구간만 싣는다 (sample11 ↔ hwp3-sample11-hwpx 문맥 정렬).
    //   0x2E01~0x2E07 → ①~⑦ 7코드 연속 일치, 0x2C21~0x2C26 → ⓐ~ⓕ (ⓒ~ⓕ 개수 일치),
    //   0x2C40~0x2C42 → ㉠~㉢
    default:
      if (ch >= 0x2e01 && ch <= 0x2e07) return 0x2460 + (ch - 0x2e01)
      // 한컴이 PUA(U+F0288~F0291)로 보존하는 별도 원문자 글리프 계열. hwp3-sample11 의
      // NVRAM 라벨 줄에서 코드 개수와 변환본 PUA 개수가 정확히 일치한다
      // (0x2E00×2↔F0288×2, 0x2E0A×3↔F0289×3, 0x2E0B~0x2E12 각 1건↔F028A~F0291 각 1건).
      // kordoc 은 표시값 직행이라 rhwp 검증표의 표시 문자(⓪~⑨)를 바로 낸다.
      if (ch === 0x2e00) return 0x24ea // ⓪
      if (ch >= 0x2e0a && ch <= 0x2e12) return 0x2460 + (ch - 0x2e0a)
      if (ch >= 0x2c21 && ch <= 0x2c26) return 0x24d0 + (ch - 0x2c21)
      if (ch >= 0x2c40 && ch <= 0x2c42) return 0x3260 + (ch - 0x2c40)
      return decodeHwp3KscSymbol(ch) ?? decodeHwp3KscHanja(ch) ?? JOHAB_UNMAPPED
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
