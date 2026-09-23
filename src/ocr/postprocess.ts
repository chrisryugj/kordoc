/**
 * OCR 인식 문자열 후처리 — 한국 공문서 표기 관행 복원.
 *
 * PP-OCRv5 korean 인식기의 사전(11,945자)에는 공문서 글머리·표기 기호 일부가 없다
 * (○ U+25CB·△ U+25B3·◎·■·「」·【】 — 사전 실측). 모델은 사전 안의 닮은 글자로
 * 읽는다: ○ → 라틴 O(코퍼스 박스 단위 실측 145회)·o, △ → 증가 기호 ∆(29회).
 * 공문서에서 쓰이지 않는 쪽만 되돌린다 — 모호한 것(ㅇ 글머리는 실제 자모, 0 은
 * "0원" 같은 숫자)은 건드리지 않는다.
 *
 * 따옴표: 모델은 ‘ ’ 를 곧은 ' 로 읽는다(114회). 공문서 텍스트층은 둥근 따옴표가 압도적
 * (코퍼스 GT ‘’ 129 : ' 7 — 한컴 자동 고침) → 여닫음 문맥으로 둥근 따옴표를 복원한다.
 */

const HANGUL_START = /^[\uac00-\ud7a3]/

/** 박스 텍스트 한 줄 후처리 (위치 독립 규칙) */
export function restoreSymbols(text: string): string {
  let s = text
  // ○ 글머리: 줄 머리 O/o + (공백) + 한글
  s = s.replace(/^([Oo])(\s?)(?=[\uac00-\ud7a3])/, "\u25cb$2")
  // ○○ 자리표시(○○시·○○○ 과장): 라틴 글자와 붙지 않은 O 2개 이상이 한글과 (공백 하나 사이로) 이웃
  s = s.replace(/(?<![A-Za-z])O{2,}(?![A-Za-z])/g, (m, i: number) =>
    /[\uac00-\ud7a3]$/.test(s.slice(Math.max(0, i - 2), i).trimEnd()) || /^\s?[\uac00-\ud7a3]/.test(s.slice(i + m.length))
      ? "\u25cb".repeat(m.length) : m)
  // △ 감액 표시: 사전 밖 → ∆(U+2206)·그리스 Δ(U+0394) 로 읽힘
  s = s.replace(/[\u2206\u0394]/g, "\u25b3")
  return smartQuotes(joinDigitGroups(s))
}

/**
 * 천 단위 숫자 안의 끼어든 공백 제거 — 모델이 쉼표 뒤에 공백을 넣는다("385, 426"·"4,802, 164",
 * 예산서 표에서 수십 회 실측). 쉼표 앞이 1~3자리, 뒤가 정확히 3자리인 무리만 잇는다
 * ("1, 2, 3" 같은 목록·"10, 20명"은 뒤가 3자리가 아니라 그대로).
 */
export function joinDigitGroups(s: string): string {
  return s.replace(/(?<![\d,])\d{1,3}(?:, ?\d{3})+(?![\d])/g, m => m.replace(/, /g, ","))
}

/**
 * 곧은 따옴표 → 둥근 따옴표. 한 줄 안의 따옴표를 짝으로 보고 여닫음을 번갈아 준다 —
 * OCR 띄어쓰기가 불안정해("내에서'기록관리시스템'") 앞 글자가 공백인지로는 여는 자리를
 * 가를 수 없다. 개수가 홀수면(줄바꿈에 걸친 인용) 첫 따옴표가 여는 자리(줄 머리·공백·
 * 여는 괄호 뒤)가 아닐 때 닫는 것부터. 연도 생략 '24 는 짝에서 빼고 ’.
 */
export function smartQuotes(s: string): string {
  if (!/['"]/.test(s)) return s
  const chars = [...s]
  for (const q of ["'", '"']) {
    const [open, close] = q === "'" ? ["\u2018", "\u2019"] : ["\u201c", "\u201d"]
    const pos: number[] = []
    for (let i = 0; i < chars.length; i++) {
      if (chars[i] !== q) continue
      const prev = i > 0 ? chars[i - 1] : ""
      if (q === "'" && !/[\p{L}\p{N}]/u.test(prev) && /^\d{2}(?!\d)/.test(chars.slice(i + 1, i + 4).join(""))) {
        chars[i] = close // 연도 생략
        continue
      }
      pos.push(i)
    }
    if (pos.length === 0) continue
    const first = pos[0]
    const prev = first > 0 ? chars[first - 1] : ""
    const atOpen = prev === "" || /[\s(\[{<\u300c\u300e\u3010\u3008\u300a\u2018\u201c·,:]/.test(prev)
    let isOpen = pos.length % 2 === 0 || atOpen
    for (const i of pos) { chars[i] = isOpen ? open : close; isOpen = !isOpen }
  }
  return chars.join("")
}

/** 점류만으로 된 조각 — 목차 리더·잡티(".", "..", "…", "·"). 단독으로는 뜻이 없다 */
export function isDotFragment(text: string): boolean {
  return /^[\s.\u00b7\u2024\u2025\u2026\u2027\u2219\u22c5\u318d]+$/.test(text)
}

/**
 * 이웃 인지 ○ 복원 — 글머리 ○ 가 제 박스로 떨어져 "O" 한 글자로 읽힌 경우,
 * 같은 줄(세로 중심 차 < 높이 절반) 바로 오른쪽(글자 높이 3배 이내) 박스가 한글로 시작하면 ○.
 */
export function restoreBulletItems<T extends { text: string; x: number; y: number; w: number; h: number }>(items: T[]): void {
  for (const it of items) {
    if (it.text !== "O" && it.text !== "o") continue
    const cy = it.y + it.h / 2
    let next: T | null = null
    for (const o of items) {
      if (o === it || o.x < it.x + it.w * 0.5) continue
      if (Math.abs(o.y + o.h / 2 - cy) > Math.max(it.h, o.h) / 2) continue
      if (o.x - (it.x + it.w) > it.h * 3) continue
      if (!next || o.x < next.x) next = o
    }
    if (next && HANGUL_START.test(next.text.trimStart())) it.text = "\u25cb"
  }
}
