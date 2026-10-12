/**
 * 문단 번호(paraPr heading NUMBER) 머리 글 — reflow(앞머리 폭)와 그리기가 같은 번호를 쓴다.
 * 번호 정의의 수준별 머리(`^1.`·`(^3)`)에서 ^N 자리에 N 수준 번호를 그 수준 형식(numFormat)으로 넣는다.
 * 번호는 문서 순서로 센다 — 어떤 수준이 나오면 그 수준이 하나 늘고 더 깊은 수준은 처음부터 다시 센다.
 */

import type { NumberHead, RenderParaGeom } from "./head-styles.js"

/** 번호 정의 id → 수준별 현재 번호(1부터 수준 인덱스) */
export type NumberCounters = Map<string, number[]>

const HANGUL_SYLLABLE = "가나다라마바사아자차카타파하"
const HANGUL_JAMO = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"
const IDEOGRAPH = "一二三四五六七八九十"

function roman(n: number): string {
  const t: Array<[number, string]> = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]
  let s = ""
  for (const [v, r] of t) while (n >= v) { s += r; n -= v }
  return s
}

/** 번호 n(1부터)을 한컴 번호 형식으로 */
export function formatHeadNumber(n: number, format: string): string {
  const cyc = (set: string): string => set[(n - 1) % set.length]
  switch (format) {
    case "HANGUL_SYLLABLE": return cyc(HANGUL_SYLLABLE)
    case "HANGUL_JAMO": return cyc(HANGUL_JAMO)
    case "CIRCLED_DIGIT": return n >= 1 && n <= 20 ? String.fromCodePoint(0x245f + n) : String(n)
    case "CIRCLED_HANGUL_SYLLABLE": return String.fromCodePoint(0x326e + (n - 1) % 14)
    case "CIRCLED_HANGUL_JAMO": return String.fromCodePoint(0x3260 + (n - 1) % 14)
    case "LATIN_SMALL": return String.fromCharCode(0x61 + (n - 1) % 26)
    case "LATIN_CAPITAL": return String.fromCharCode(0x41 + (n - 1) % 26)
    case "ROMAN_SMALL": return roman(n).toLowerCase()
    case "ROMAN_CAPITAL": return roman(n)
    case "IDEOGRAPH": return n >= 1 && n <= 10 ? IDEOGRAPH[n - 1] : String(n)
    default: return String(n)
  }
}

/** 문단 하나의 번호를 세고 머리 글을 돌려준다. 번호 문단이 아니면 "" */
export function nextParaNumber(counters: NumberCounters, geom: RenderParaGeom | undefined): string {
  const num = geom?.number
  if (!num) return ""
  const cur = counters.get(num.id) ?? []
  const head = num.heads.get(num.level)
  cur[num.level] = (cur[num.level] ?? (head?.start ?? 1) - 1) + 1
  cur.length = num.level + 1 // 더 깊은 수준은 다시 센다
  counters.set(num.id, cur)
  return (head?.text ?? "").replace(/\^(\d)/g, (_m, d: string) => {
    const lv = Number(d), h: NumberHead | undefined = num.heads.get(lv)
    return formatHeadNumber(cur[lv] ?? h?.start ?? 1, h?.format ?? "DIGIT")
  })
}
