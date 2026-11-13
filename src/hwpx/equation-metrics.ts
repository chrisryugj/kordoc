/**
 * 생성 수식 상자 크기 어림 — 한글 수식 스크립트를 묶음{}·over·위/아래 첨자·sqrt/root·행(#) 구조로 재어 em 단위 폭·위·아래를 낸다.
 * 한글은 문서를 열 때 수식을 다시 조판하지만, 저장된 상자 크기(hp:sz)를 그대로 쓰는 미리보기(kordoc 렌더)·다른 뷰어는 이 값으로 줄을 배치한다.
 * 종전 어림(글자 수 × 700 + 2000, 최소 5,500)은 "a" 한 글자를 19mm 로 잡아 미리보기에 큰 빈칸을 냈다.
 *
 * 상수 근거 — 코퍼스 한글 저장 수식 22,130개(HYhwpEQ, sz 폭·높이 ÷ baseUnit):
 * 한 글자 0.5~0.58em, 단순 식 높이 1.0em·기준선 86%, 위첨자 식 1.167em·88%, 분수 2.3em·66%.
 * 폭 상대오차 중앙값 2.235 → 0.078(p90 8.17 → 0.32), 높이·기준선 오차 중앙값 0
 */

const GREEK = new Set("alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega".split(" "))
const FUNCS = new Set(["sin", "cos", "tan", "cot", "sec", "csc", "log", "ln", "exp", "lim", "max", "min", "det"])
const BIG_OPS = new Set(["sum", "int", "prod", "SMALLSUM", "dint", "oint", "inter", "union"])
/** 폭 없는 서식·괄호 크기 지시 */
const ZERO_WIDTH = new Set(["rm", "it", "bold", "LEFT", "RIGHT", "left", "right"])
const SYMBOLS = new Set(["times", "TIMES", "cdot", "CDOT", "le", "ge", "leq", "geq", "LEQ", "GEQ", "rarrow", "therefore", "THEREFORE",
  "because", "BECAUSE", "IN", "SUBSET", "CUP", "CAP", "SIM", "APPROX", "INF", "DEG", "prime", "ANGLE", "angle", "TRIANGLE", "triangle",
  "bot", "BOT", "CDOTS", "cdots", "LDOTS"])
const ACCENTS = /^(?:bar|vec|hat|dot|ddot|tilde|acute|grave|check|dyad|under|arch)$/
const STACKS = /^(?:matrix|pmatrix|bmatrix|dmatrix|cases|eqalign|pile|lpile|rpile)$/

/** em 폭 — 숫자 0.5·소문자 0.55·대문자 0.68·그리스 0.62·함수 글자 0.48·더하기 0.85·관계 0.95·문장부호 0.32·괄호 0.38·한글 1 */
function charWidth(c: string): number {
  if (/[0-9]/.test(c)) return 0.5
  if (/[a-z]/.test(c)) return 0.55
  if (/[A-Z]/.test(c)) return 0.68
  if (/[가-힣]/.test(c)) return 1
  if (/[+-]/.test(c)) return 0.85
  if (/[=<>]/.test(c)) return 0.95
  if (/[()[\]|]/.test(c)) return 0.38
  if (/[,.:;']/.test(c)) return 0.32
  if (c === "`") return 0.25
  if (c === "~") return 0.5
  return 0.8
}

function wordWidth(x: string): number {
  if (x[0] === '"') return [...x.slice(1, -1)].reduce((s, c) => s + charWidth(c), 0)
  if (GREEK.has(x.toLowerCase())) return 0.62
  if (FUNCS.has(x)) return x.length * 0.48 + 0.15
  if (BIG_OPS.has(x)) return 1.2
  if (SYMBOLS.has(x)) return 0.95
  return [...x].reduce((s, c) => s + charWidth(c), 0)
}

interface Box { w: number; a: number; d: number }
const ATOM = (w: number): Box => ({ w, a: 0.86, d: 0.14 })
const SCRIPT_SCALE = 0.62

/** 스크립트 → em 상자 (폭·기준선 위·아래) */
export function measureEquation(script: string): Box {
  // 중괄호 폭탄 같은 기형 입력은 구조를 재지 않고 글자 폭 합으로 (재귀 깊이 상한)
  let depth = 0, deepest = 0
  for (const c of script) if (c === "{") deepest = Math.max(deepest, ++depth); else if (c === "}") depth--
  if (deepest > 64) return ATOM([...script.replace(/[{}\s]/g, "")].reduce((s, c) => s + charWidth(c), 0))
  const t = [...script.matchAll(/"[^"]*"|[A-Za-z]+|\d+(?:\.\d+)?|->|<=|>=|!=|\+-|[{}^_#&`~]|[가-힣]+|\S/gu)].map(m => m[0])
  let i = 0
  const combine = (items: Array<Box | null>): Box => {
    if (items.includes(null)) {
      // 행(#)으로 쌓은 묶음 — 행마다 높이에 간격 0.2em
      const rows: Box[][] = [[]]
      for (const x of items) x ? rows[rows.length - 1].push(x) : rows.push([])
      const rs = rows.map(r => combine(r)), H = rs.reduce((s, r) => s + r.a + r.d + 0.2, 0)
      return { w: Math.max(...rs.map(r => r.w)), a: H / 2 + 0.25, d: H / 2 - 0.25 }
    }
    const bs = items as Box[]
    return bs.length ? { w: bs.reduce((s, x) => s + x.w, 0), a: Math.max(...bs.map(x => x.a)), d: Math.max(...bs.map(x => x.d)) } : ATOM(0)
  }
  const seq = (stop?: string): Box => {
    const items: Array<Box | null> = []
    while (i < t.length && t[i] !== stop) {
      if (t[i] === "over") {
        i++
        const num = combine(items.splice(0)), den = elem() ?? ATOM(0.5)
        // 분자 위·분모 아래 — 수식 축(분수선)이 기준선 위 0.22em
        items.push({ w: Math.max(num.w, den.w) + 0.25, a: num.a + num.d + 0.52, d: den.a + den.d - 0.22 })
      } else if (t[i] === "#") { i++; items.push(null) }
      else if (t[i] === "&") { i++; items.push(ATOM(0.6)) }
      else { const e = elem(); if (e) items.push(e) }
    }
    return combine(items)
  }
  const base = (): Box | null => {
    const x = t[i]
    if (x === undefined) return null
    i++
    if (x === "{") { const g = seq("}"); if (t[i] === "}") i++; return g }
    if (x === "}") return null
    if (ZERO_WIDTH.has(x)) return ATOM(0)
    if (x === "sqrt") { const arg = base() ?? ATOM(0.5); return { w: arg.w + 0.9, a: arg.a + 0.15, d: arg.d } }
    if (x === "root") {
      const n = base()
      if (t[i] !== "of") return { w: (n?.w ?? 0.5) + 0.9, a: (n?.a ?? 0.86) + 0.15, d: n?.d ?? 0.14 }
      i++
      const arg = base() ?? ATOM(0.5)
      return { w: arg.w + 0.9 + (n ? n.w * 0.5 : 0), a: arg.a + 0.15, d: arg.d }
    }
    if (ACCENTS.test(x)) { const arg = base() ?? ATOM(0.5); return { w: arg.w, a: arg.a + 0.2, d: arg.d } }
    if (STACKS.test(x)) {
      const arg = base() ?? ATOM(1)
      return { w: arg.w + (x === "cases" ? 0.6 : /^[pbd]matrix$/.test(x) ? 0.8 : 0), a: arg.a, d: arg.d }
    }
    if (BIG_OPS.has(x)) return { w: 1.2, a: 1, d: 0.45 }
    return ATOM(wordWidth(x))
  }
  // 원자 + 위·아래 첨자 사슬 (첨자는 0.62 배)
  const elem = (): Box | null => {
    let b = base()
    if (!b) return null
    while (t[i] === "^" || t[i] === "_") {
      const sup = t[i] === "^"
      i++
      const s = base() ?? { w: 0, a: 0, d: 0 }, h = (s.a + s.d) * SCRIPT_SCALE
      b = sup ? { w: b.w + s.w * SCRIPT_SCALE, a: Math.max(b.a, b.a * 0.45 + h), d: b.d } : { w: b.w + s.w * SCRIPT_SCALE, a: b.a, d: Math.max(b.d, b.d * 0.4 + h) }
    }
    return b
  }
  return seq()
}
