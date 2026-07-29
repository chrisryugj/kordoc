/**
 * HWP5 문단번호/글머리표 — 7수준 카운터 상태기계 + ^N 형식 치환 + 번호 포맷터.
 *
 * 출처: rhwp (MIT) renderer/layout.rs NumberingState::advance,
 * renderer/layout/utils.rs expand_numbering_format, renderer/mod.rs format_number.
 */

import type { HwpNumbering } from "./record.js"
import { hangulOrdinal, circledNumber, circledHangul, romanNumeral } from "../shared/numbering.js"

// ─── 7수준 카운터 상태기계 ───────────────────────────

/**
 * 문단 번호 카운터 (수준별 1-7).
 * HWP 동작:
 *  - 같은 numberingId 연속 = "앞 번호 이어" (카운터 유지)
 *  - 다른 id (히스토리 있음) = "이전 번호 이어" (히스토리 복원)
 *  - 다른 id (히스토리 없음) = 상위 수준 상속 + 현재 수준 이하 리셋
 */
export class NumberingState {
  private currentId = 0
  private counters: number[] = [0, 0, 0, 0, 0, 0, 0]
  private history = new Map<number, number[]>()

  /** 번호 문단 처리: 카운터 갱신 후 수준별 카운터 스냅샷 반환 */
  advance(numberingId: number, level: number): number[] {
    const lv = Math.min(Math.max(level, 0), 6)

    if (this.currentId !== numberingId) {
      if (this.currentId !== 0) this.history.set(this.currentId, [...this.counters])
      const saved = this.history.get(numberingId)
      if (saved) {
        this.counters = [...saved]
      } else {
        const prev = this.counters
        this.counters = [0, 0, 0, 0, 0, 0, 0]
        for (let i = 0; i < lv; i++) this.counters[i] = prev[i]
      }
      this.currentId = numberingId
    }

    this.counters[lv]++
    for (let i = lv + 1; i < 7; i++) this.counters[i] = 0
    return [...this.counters]
  }
}

// ─── 번호 포맷터 ─────────────────────────────────────

export type NumFmt =
  | "digit" | "circled" | "romanUpper" | "romanLower" | "latinUpper" | "latinLower"
  | "ganada" | "circledGanada" | "jamo" | "circledJamo" | "hangulNum" | "hanjaNum"

/** HWP 표 43 (문단 머리 번호 형식 코드) → NumFmt */
function headFormatToNumFmt(code: number): NumFmt {
  switch (code) {
    case 1: return "circled"
    case 2: return "romanUpper"
    case 3: return "romanLower"
    case 4: return "latinUpper"
    case 5: return "latinLower"
    case 8: return "ganada"
    case 9: return "circledGanada"
    case 10: return "jamo"
    case 11: return "circledJamo"
    case 12: return "hangulNum"
    case 13: return "hanjaNum"
    default: return "digit"
  }
}

/** HWP 표 134 (자동번호/쪽번호 모양 코드) → NumFmt */
export function shapeFormatToNumFmt(code: number): NumFmt {
  switch (code) {
    case 1: return "circled"
    case 2: return "romanUpper"
    case 3: return "romanLower"
    case 4: return "latinUpper"
    case 5: return "latinLower"
    case 6: return "ganada"
    case 7: return "hangulNum"
    case 8: return "hanjaNum"
    default: return "digit"
  }
}

const JAMO = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"
const CIRCLED_JAMO = "㉠㉡㉢㉣㉤㉥㉦㉧㉨㉩㉪㉫㉬㉭"

function fromTable(n: number, table: string): string {
  return n >= 1 && n <= table.length ? table[n - 1] : String(n)
}

function formatLatin(n: number, upper: boolean): string {
  if (n <= 0) return ""
  let result = ""
  let num = n
  while (num > 0) {
    num--
    result = String.fromCharCode((upper ? 65 : 97) + (num % 26)) + result
    num = Math.floor(num / 26)
  }
  return result
}

/** 한글/한자 숫자 (일이삼 / 一二三) — 만 단위까지 */
function formatEastAsianNumber(n: number, digits: string[], units: string[], zero: string): string {
  if (n === 0) return zero
  if (n < 0 || n > 99999) return String(n)
  let result = ""
  let num = n
  let unit = 0
  while (num > 0) {
    const d = num % 10
    if (d > 0) {
      const digitStr = d === 1 && unit > 0 ? "" : digits[d]
      result = digitStr + units[unit] + result
    }
    num = Math.floor(num / 10)
    unit++
  }
  return result
}

const HANGUL_DIGITS = ["", "일", "이", "삼", "사", "오", "육", "칠", "팔", "구"]
const HANGUL_UNITS = ["", "십", "백", "천", "만"]
const HANJA_DIGITS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"]
const HANJA_UNITS = ["", "十", "百", "千", "萬"]

/** 번호 → 문자열 (rhwp format_number 포팅 — 시퀀스 폴백은 shared/numbering 정본 규칙) */
export function formatNumber(n: number, fmt: NumFmt): string {
  switch (fmt) {
    case "circled": return n >= 1 ? circledNumber(n - 1) : String(n)
    case "romanUpper": return romanNumeral(n, true)
    case "romanLower": return romanNumeral(n, false)
    case "latinUpper": return formatLatin(n, true) || String(n)
    case "latinLower": return formatLatin(n, false) || String(n)
    case "ganada": return n >= 1 ? hangulOrdinal(n - 1) : String(n)
    case "circledGanada": return n >= 1 ? circledHangul(n - 1) : String(n)
    case "jamo": return fromTable(n, JAMO)
    case "circledJamo": return fromTable(n, CIRCLED_JAMO)
    case "hangulNum": return formatEastAsianNumber(n, HANGUL_DIGITS, HANGUL_UNITS, "영")
    case "hanjaNum": return formatEastAsianNumber(n, HANJA_DIGITS, HANJA_UNITS, "零")
    default: return String(n)
  }
}

// ─── ^N 형식 치환 ────────────────────────────────────

/**
 * 번호 형식 문자열의 `^1`~`^7` 제어코드를 실제 번호로 치환.
 * (rhwp expand_numbering_format 포팅 — 시작번호 보정: counter>0이면 (start-1)+counter)
 */
export function expandNumberingFormat(formatStr: string, counters: number[], numbering: HwpNumbering): string {
  let result = ""
  let i = 0
  while (i < formatStr.length) {
    const ch = formatStr[i]
    if (ch === "^" && i + 1 < formatStr.length && formatStr[i + 1] >= "1" && formatStr[i + 1] <= "7") {
      const levelRef = formatStr.charCodeAt(i + 1) - 48 // '1'..'7' → 1..7
      const idx = levelRef - 1
      const counterVal = counters[idx] ?? 0
      const start = numbering.startNumbers[idx] ?? 1
      const num = counterVal > 0 ? start - 1 + counterVal : start
      result += formatNumber(num, headFormatToNumFmt(numbering.numberFormats[idx] ?? 0))
      i += 2
      continue
    }
    result += ch
    i++
  }
  return result
}
