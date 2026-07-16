/**
 * 항목부호 자동번호 포맷 해석 (parser.ts에서 분리).
 * 한글 음절/자모·로마자·원숫자 시퀀스와 numbering 카운터로 문단머리 문자열 생성.
 */

import type { WalkCtx } from "./parser-shared.js"
import { hangulOrdinal, circledNumber, circledHangul } from "./gongmun.js"

// ─── 자동번호 포맷 ───────────────────────────────────

const HANGUL_JAMO_SEQ = "ㄱㄴㄷㄹㅁㅂㅅㅇㅈㅊㅋㅌㅍㅎ"

/** 1-based 숫자 → 로마 숫자 (대문자) */
function toRoman(n: number): string {
  if (n <= 0 || n >= 4000) return String(n)
  const table: [number, string][] = [
    [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"],
    [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
  ]
  let out = ""
  for (const [v, s] of table) { while (n >= v) { out += s; n -= v } }
  return out
}

/** 자동번호 카운터 값 → numFormat에 따른 표시 문자열 */
function formatHeadNumber(n: number, numFormat: string): string {
  if (n === 0 && numFormat === "DIGIT") return "0" // start="0"은 유효값 — 시퀀스 포맷은 1-based라 아래 클램프 유지
  if (n <= 0) n = 1
  switch (numFormat) {
    case "DIGIT": return String(n)
    // 서수 시퀀스는 생성기(gongmun.ts)와 단일 소스 (v4.0.5) — 종전 mod-14 순환은
    // 15번째 형제를 다시 '가'로 만들어 한글 실렌더(가→하→거→너 단모음 연속)와 어긋났다
    case "CIRCLED_DIGIT": return n <= 50 ? circledNumber(n - 1) : `(${n})`
    case "HANGUL_SYLLABLE": return hangulOrdinal(n - 1)
    case "CIRCLED_HANGUL_SYLLABLE": return n <= 14 ? circledHangul(n - 1) : hangulOrdinal(n - 1)
    case "HANGUL_JAMO": return HANGUL_JAMO_SEQ[(n - 1) % HANGUL_JAMO_SEQ.length]
    case "CIRCLED_HANGUL_JAMO": return n <= 14 ? String.fromCodePoint(0x3260 + n - 1) : HANGUL_JAMO_SEQ[(n - 1) % 14]
    case "LATIN_CAPITAL": return String.fromCharCode(0x41 + ((n - 1) % 26))
    case "LATIN_SMALL": return String.fromCharCode(0x61 + ((n - 1) % 26))
    case "CIRCLED_LATIN_CAPITAL": return n <= 26 ? String.fromCodePoint(0x24b6 + n - 1) : String.fromCharCode(0x41 + ((n - 1) % 26))
    case "CIRCLED_LATIN_SMALL": return n <= 26 ? String.fromCodePoint(0x24d0 + n - 1) : String.fromCharCode(0x61 + ((n - 1) % 26))
    case "ROMAN_CAPITAL": return toRoman(n)
    case "ROMAN_SMALL": return toRoman(n).toLowerCase()
    default: return String(n)
  }
}

/** 문단의 자동번호/글머리표/개요 해석 결과 */
export interface ResolvedParaHeading {
  /** 문단 텍스트 앞에 붙일 접두 ("1.", "가.", "①", "-" 등) */
  prefix?: string
  /** OUTLINE 문단의 헤딩 레벨 (1-6) */
  headingLevel?: number
}

/**
 * hp:p paraPrIDRef → paraPr heading(NUMBER/BULLET/OUTLINE) 해석.
 * NUMBER/OUTLINE은 7수준 카운터 상태기계 사용 — 같은 numbering id에서
 * 레벨별 카운터 증가, 상위 레벨 증가 시 하위 리셋. 한글은 빈 번호 문단도
 * 번호를 소비하므로 텍스트 없는 문단에서도 호출해 카운터를 진행시킨다
 * (v4.0.5 — 접두는 호출부가 텍스트 있을 때만 사용).
 */
export function resolveParaHeading(paraEl: Element, ctx: WalkCtx): ResolvedParaHeading | null {
  const sm = ctx.styleMap
  if (!sm) return null
  // 명명 스타일 기반 헤딩 — "개요 N" 스타일 참조 문단은 OUTLINE 없이도 헤딩.
  // (공문서 생성기가 개요 번호 렌더 결함을 피해 OUTLINE 대신 스타일명으로 의미 보존)
  const styleId = paraEl.getAttribute("styleIDRef")
  let styleHeading: number | undefined
  if (styleId && styleId !== "0") {
    const st = sm.styles.get(styleId)
    const m = st && /^개요\s*([1-6])$/.exec(st.name)
    if (m) styleHeading = Math.min(parseInt(m[1], 10), 6)
  }
  const prId = paraEl.getAttribute("paraPrIDRef")
  if (!prId) return styleHeading ? { headingLevel: styleHeading } : null
  const ref = sm.paraHeadings.get(prId)
  if (!ref) return styleHeading ? { headingLevel: styleHeading } : null

  if (ref.type === "BULLET") {
    const char = sm.bullets.get(ref.idRef)
    return char ? { prefix: char } : null
  }

  // NUMBER는 idRef가 numbering id, OUTLINE은 secPr outlineShapeIDRef가 numbering id
  const numId = ref.type === "OUTLINE" ? (ctx.outlineNumId || "1") : ref.idRef
  const level = Math.min(ref.level + 1, 10)  // 0-based 속성 → 1-based paraHead 레벨
  const headingLevel = ref.type === "OUTLINE" ? Math.min(ref.level + 1, 6) : undefined
  const numDef = sm.numberings.get(numId)
  if (!numDef) return headingLevel ? { headingLevel } : null

  let counters = ctx.shared.numState.get(numId)
  // 미사용 센티널은 -1 — 0을 쓰면 start="0" numbering이 매번 미사용으로 오판돼 증가하지 않는다
  if (!counters) { counters = new Array(11).fill(-1); ctx.shared.numState.set(numId, counters) }
  const head = numDef.heads.get(level)
  counters[level] = counters[level] < 0 ? (head?.start ?? 1) : counters[level] + 1
  for (let l = level + 1; l <= 10; l++) counters[l] = -1

  // ^N 치환 — 참조 레벨의 카운터를 그 레벨의 numFormat으로 변환 (예: "^1." → "1.")
  // 서식 텍스트가 명시적으로 빈 paraHead(한컴 "번호 없음" 개요, 생성기 왕복 포함)는
  // 접두를 발명하지 않는다 — 폴백 "^N."은 해당 레벨 정의 자체가 없을 때만.
  const fmtText = head ? head.text.trim() : `^${level}.`
  const prefix = fmtText.replace(/\^(10|[1-9])/g, (_, d) => {
    const lv = parseInt(d, 10)
    const refHead = numDef.heads.get(lv)
    // 카운터 0은 유효값(start="0") — 미사용(-1)일 때만 start 폴백
    const n = counters![lv] >= 0 ? counters![lv] : (refHead?.start ?? 1)
    return formatHeadNumber(n, refHead?.numFormat || "DIGIT")
  })
  return { prefix: prefix || undefined, headingLevel }
}

