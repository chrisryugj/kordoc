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

const AMOUNT_DIGITS = "영일이삼사오육칠팔구"
const AMOUNT_SMALL = ["", "십", "백", "천"]
const AMOUNT_BIG = ["", "만", "억", "조", "경", "해"]

/**
 * 금액 숫자 → 한글 병기값 (규정 시행규칙 제2조: 아라비아 숫자 다음 괄호 안에 한글).
 * 4자리 그룹 × 만·억·조·경·해, 그룹 안 천·백·십, 숫자 영일이삼사오육칠팔구.
 * 공문 관행대로 `일십`·`일백`·`일천`·`일만`의 "일"을 생략하지 않는다 — 금113,560원(금일십일만삼천오백육십원).
 * 값이 0인 그룹은 단위까지 생략, 0은 "영". 쉼표·공백 등 숫자 아닌 문자는 무시.
 * 반환은 순수 한글 — 접두·접미(금·원·원정)는 호출자가 붙인다.
 */
export function hangulAmount(n: number | string): string {
  const digits = String(n).replace(/\D/g, "").replace(/^0+(?=\d)/, "")
  if (!digits || digits === "0") return "영"
  const groups: string[] = []
  for (let end = digits.length; end > 0; end -= 4) groups.unshift(digits.slice(Math.max(0, end - 4), end))
  let out = ""
  groups.forEach((g, i) => {
    let part = ""
    const padded = g.padStart(4, "0")
    for (let k = 0; k < 4; k++) {
      const d = Number(padded[k])
      if (d) part += AMOUNT_DIGITS[d] + AMOUNT_SMALL[3 - k]
    }
    if (part) out += part + (AMOUNT_BIG[groups.length - 1 - i] ?? "")
  })
  return out
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
