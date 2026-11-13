/**
 * 분수가 든 수식의 쌓은 배치 — 맨 바깥 `\frac{a}{b}` 를 분자·가로선·분모로 놓고, 그 앞뒤 글과 분자·분모 안쪽은 한 줄 유니코드 글(latexToPlain)로 둔다.
 * 종전엔 수식 전체를 한 줄 글("9/2")로 상자 폭에 맞춰 눌러 그려 분수가 작은 빗금 글이 됐다.
 * 높이는 한글 저장 수식 실측과 같다(equation-metrics: 분자 위 1.52em, 분모 아래 0.78em, 단순 식 0.86/0.14em).
 * 행(#·행렬·경우)이 든 수식은 null — 호출 측이 종전 한 줄 글로 그린다.
 */

import { latexToPlain } from "./equation-text.js"

/** 그릴 조각 — 글(text)은 기준선 기준 높이 y(위가 +), 가로선(rule)은 폭. 단위 em */
export interface EquationOp { x: number; y: number; text?: string; rule?: number }
export interface EquationLayout { w: number; a: number; d: number; ops: EquationOp[] }

/** em 폭 — equation-metrics 의 글자 폭과 같은 표 */
function textWidth(s: string): number {
  let w = 0
  for (const c of s) {
    if (/[0-9]/.test(c)) w += 0.5
    else if (/[a-z]/.test(c)) w += 0.55
    else if (/[A-Z]/.test(c)) w += 0.68
    else if (/[가-힣]/.test(c)) w += 1
    else if (/[+\-−]/.test(c)) w += 0.85
    else if (/[=<>≤≥≠]/.test(c)) w += 0.95
    else if (/[()[\]|]/.test(c)) w += 0.38
    else if (/[,.:;'′]/.test(c)) w += 0.32
    else if (c === " ") w += 0.25
    else if (/[̀-ͯ⃐-⃿]/.test(c)) w += 0
    else w += 0.8
  }
  return w
}

/** i 에서 시작하는 인자(중괄호 묶음 또는 명령·글자 하나)의 [안쪽, 끝] */
function argAt(s: string, i: number): [string, number] {
  while (s[i] === " ") i++
  if (s[i] === "{") {
    for (let d = 0, k = i; k < s.length; k++) {
      if (s[k] === "\\") { k++; continue }
      if (s[k] === "{") d++
      else if (s[k] === "}" && --d === 0) return [s.slice(i + 1, k), k + 1]
    }
    return [s.slice(i + 1), s.length]
  }
  if (s[i] === "\\") { let k = i + 1; while (/[A-Za-z]/.test(s[k] ?? "")) k++; return [s.slice(i, Math.max(k, i + 2)), Math.max(k, i + 2)] }
  return [s[i] ?? "", i + 1]
}

export function layoutFractions(latex: string): EquationLayout | null {
  if (/\\\\|\\begin\{/.test(latex)) return null
  const ops: EquationOp[] = []
  let x = 0, a = 0.86, d = 0.14, depth = 0, plain = "", found = false
  const flush = () => {
    const t = latexToPlain(plain)
    plain = ""
    if (!t) return
    ops.push({ x, y: 0, text: t })
    x += textWidth(t)
  }
  for (let i = 0; i < latex.length;) {
    if (depth === 0 && latex.startsWith("\\frac", i) && !/[A-Za-z]/.test(latex[i + 5] ?? "")) {
      flush()
      const [num, j] = argAt(latex, i + 5), [den, k] = argAt(latex, j)
      const n = latexToPlain(num), m = latexToPlain(den), nw = textWidth(n), mw = textWidth(m), w = Math.max(nw, mw) + 0.25
      // 분자 기준선 0.66em·분모 기준선 −0.64em, 가로선은 그 사이 0.37em
      ops.push({ x: x + (w - nw) / 2, y: 0.66, text: n }, { x: x + (w - mw) / 2, y: -0.64, text: m }, { x: x + 0.06, y: 0.37, rule: w - 0.12 })
      x += w
      a = Math.max(a, 1.52)
      d = Math.max(d, 0.78)
      found = true
      i = k
      continue
    }
    const c = latex[i]
    if (c === "\\") { plain += latex.slice(i, i + 2); i += 2; continue }
    if (c === "{") depth++
    else if (c === "}") depth--
    plain += c
    i++
  }
  flush()
  return found ? { w: x, a, d, ops } : null
}
