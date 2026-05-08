/**
 * HWP 3.0 상용 조합형 → 유니코드 디코더.
 *
 * 한국어 한글은 cho/jung/jong 비트 분해로 0xAC00 한글 음절 영역에 직접 매핑되고,
 * 한자/기호 등 그 외 영역은 johab-symbols.ts 의 lookup table 로 처리한다.
 * 매핑되지 않는 코드는 '?' 로 fallback 한다.
 *
 * 출처: rhwp/src/parser/hwp3/johab.rs (Apache-2.0). 알고리즘 동일.
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
    let jong = JONG_MAP[jongIdx]

    if (cho !== -1 && jung !== -1) {
      if (jong === -1) jong = 0
      // 0xAC00 + (cho * 21 * 28) + (jung * 28) + jong
      return 0xac00 + cho * 588 + jung * 28 + jong
    }

    // 한자/기호: lookup table
    const hit = lookupSymbol(ch)
    if (hit !== null) return hit
  }

  return JOHAB_UNMAPPED
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
    const cp = decodeJohab(ch)
    if (cp !== JOHAB_UNMAPPED) out += String.fromCodePoint(cp)
    i += 2
  }
  return out
}

/**
 * HWP3 byte sequence (1바이트 ASCII < 0x80, 2바이트 johab >= 0x80) 를 string 으로 디코딩.
 * NUL byte 만나면 종료. link_print_file/description 같은 짧은 byte string 영역에 사용.
 */
export function decodeHwp3String(bytes: Uint8Array): string {
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
      const cp = decodeJohab(ch)
      if (cp !== JOHAB_UNMAPPED) out += String.fromCodePoint(cp)
      i += 2
    } else {
      i += 1
    }
  }
  return out
}
