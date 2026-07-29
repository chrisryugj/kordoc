/**
 * 번호 시퀀스 포맷터 공용 엔진 — hwpx(gongmun/para-heading)와 hwp5(numbering)가 공유.
 *
 * 정본 규칙은 공문서 생성기(구 gongmun.ts) 기준:
 *  - 원숫자는 50까지(① ~ ㊿), 초과는 순환 대신 "(51)" 괄호수
 *  - 원문자 가나다는 14자(㉮~㉻), 초과는 가나다 서수로 폴백
 * 파서 자동번호 폴백과 같은 규칙이라 왕복 시 마커가 어긋나지 않는다 (v4.0.4).
 */

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

/**
 * 0-based n → ① ② … ⑳ ㉑ … ㊿ (U+2460~ / U+3251~ / U+32B1~, 50까지).
 * 초과(실무 도달 불가)는 순환 대신 '(51)' 괄호수 — 파서 자동번호 폴백
 * (para-heading CIRCLED_DIGIT)과 같은 규칙이라 왕복 시 마커가 어긋나지 않는다 (v4.0.4)
 */
export function circledNumber(n: number): string {
  if (n < 20) return String.fromCodePoint(0x2460 + n)        // ①~⑳
  if (n < 35) return String.fromCodePoint(0x3251 + (n - 20)) // ㉑~㉟
  if (n < 50) return String.fromCodePoint(0x32b1 + (n - 35)) // ㊱~㊿
  return `(${n + 1})`
}

/**
 * 0-based n → ㉮ ㉯ ㉰ … ㉻ (U+326E~, 14자). 15번째+는 순환 대신 가나다 서수 —
 * 파서 자동번호 폴백(para-heading CIRCLED_HANGUL_SYLLABLE)과 동일 규칙 (v4.0.4).
 * 순환(mod 14)이면 15번째가 ㉮로 되돌아가 형제 순번 재유도가 모호해진다
 */
export function circledHangul(n: number): string {
  return n < 14 ? String.fromCodePoint(0x326e + n) : hangulOrdinal(n)
}

/** 1-based n → 로마 숫자 (범위 밖은 아라비아 숫자 폴백) */
export function romanNumeral(n: number, upper: boolean): string {
  if (n <= 0 || n > 3999) return String(n)
  const values = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1]
  const symbols = upper
    ? ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"]
    : ["m", "cm", "d", "cd", "c", "xc", "l", "xl", "x", "ix", "v", "iv", "i"]
  let result = ""
  let num = n
  for (let i = 0; i < values.length; i++) {
    while (num >= values[i]) { result += symbols[i]; num -= values[i] }
  }
  return result
}
