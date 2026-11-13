/**
 * 수식(hp:equation 스크립트 → LaTeX)을 한 줄 유니코드 글로 — 렌더러가 수식 상자 안에 읽을 수 있는 대체 글을 그릴 때 쓴다.
 * 분수는 a/b, 제곱근은 √, 위·아래 첨자는 첨자 문자(없는 글자는 ^(…)·_(…)), 그리스 문자·연산 기호는 유니코드로 바꾼다.
 */

const SYMBOLS: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω", Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π",
  Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  times: "×", cdot: "·", div: "÷", pm: "±", mp: "∓", le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈",
  equiv: "≡", sim: "∼", infty: "∞", rightarrow: "→", leftarrow: "←", Rightarrow: "⇒", Leftarrow: "⇐", leftrightarrow: "↔",
  Leftrightarrow: "⇔", to: "→", angle: "∠", triangle: "△", perp: "⊥", parallel: "∥", circ: "∘", degree: "°",
  sum: "Σ", prod: "Π", int: "∫", oint: "∮", partial: "∂", nabla: "∇", in: "∈", notin: "∉", subset: "⊂", supset: "⊃",
  subseteq: "⊆", supseteq: "⊇", cup: "∪", cap: "∩", emptyset: "∅", forall: "∀", exists: "∃", therefore: "∴", because: "∵",
  prime: "′", cdots: "⋯", ldots: "…", dots: "…", vdots: "⋮", lim: "lim", log: "log", ln: "ln", sin: "sin", cos: "cos", tan: "tan",
  sec: "sec", csc: "csc", cot: "cot", exp: "exp", max: "max", min: "min", quad: " ", qquad: "  ", ",": " ", ";": " ", "!": "",
  "{": "{", "}": "}", "|": "‖", backslash: "\\", lbrace: "{", rbrace: "}", langle: "⟨", rangle: "⟩",
}
const SUP: Record<string, string> = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", n: "ⁿ", i: "ⁱ", x: "ˣ", "′": "′" }
// 문자 아래 첨자(ₙ·ₖ)는 흔한 글꼴에 없어 빈 상자로 그려진다 — 숫자·기호만 첨자 문자로
const SUB: Record<string, string> = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "=": "₌", "(": "₍", ")": "₎" }

/** LaTeX → 한 줄 유니코드 글 */
export function latexToPlain(latex: string): string {
  let i = 0
  const s = latex
  const skipWs = (): void => { while (i < s.length && s[i] === " ") i++ }
  /** 인자 하나 — {…} 묶음이거나 명령·글자 하나 */
  const arg = (): string => {
    skipWs()
    if (s[i] === "{") { i++; const v = seq("}"); i++; return v }
    return atom()
  }
  const wrap = (v: string): string => (v.length > 1 && !/^[\w.′]+$|^\(.*\)$/u.test(v) ? `(${v})` : v)
  const script = (v: string, map: Record<string, string>, mark: string): string => {
    const t = v.trim()
    return [...t].every(c => map[c]) ? [...t].map(c => map[c]).join("") : `${mark}${wrap(t)}`
  }
  const atom = (): string => {
    const c = s[i]
    if (c === undefined) return ""
    if (c === "\\") {
      i++
      let name = ""
      if (/[A-Za-z]/.test(s[i] ?? "")) while (/[A-Za-z]/.test(s[i] ?? "")) name += s[i++]
      else name = s[i++] ?? ""
      if (name === "frac") { const a = arg(), b = arg(); return `${wrap(a.trim())}/${wrap(b.trim())}` }
      // 행렬·경우 환경 — 행은 "; ", 칸 구분(&)은 빈칸, 경우는 앞에 "{" (종전엔 "begincases…&…\\…endcases" 가 그대로 샜다)
      if (name === "begin") {
        const env = arg().trim(), end = s.indexOf(`\\end{${env}}`, i), body = s.slice(i, end < 0 ? s.length : end)
        i = end < 0 ? s.length : end + env.length + 6
        const rows = body.split(/\\\\/).map(r => latexToPlain(r.replace(/&/g, "\\ "))).filter(Boolean)
        return (env === "cases" ? "{" : "") + rows.join("; ")
      }
      if (name === "sqrt") { skipWs(); let root = ""; if (s[i] === "[") { i++; root = seq("]"); i++ } const a = arg(); return `${root ? script(root, SUP, "") : ""}√${wrap(a.trim())}` }
      if (name === "left" || name === "right" || name === "big" || name === "Big" || name === "bigg" || name === "Bigg") { skipWs(); const d = s[i] === "\\" ? atom() : s[i++] ?? ""; return d === "." ? "" : d }
      if (name === "overline" || name === "bar" || name === "hat" || name === "vec" || name === "dot" || name === "tilde") {
        const a = arg().trim(), mark = { overline: "̅", bar: "̄", hat: "̂", vec: "⃗", dot: "̇", tilde: "̃" }[name]!
        return [...a].map(ch => ch + mark).join("")
      }
      if (name === "mathrm" || name === "text" || name === "rm" || name === "mathbf" || name === "it" || name === "mathit" || name === "operatorname") return name === "rm" || name === "it" ? "" : arg()
      return SYMBOLS[name] ?? name
    }
    i++
    if (c === "{") { const v = seq("}"); i++; return v }
    if (c === "^") return script(arg(), SUP, "^")
    if (c === "_") return script(arg(), SUB, "_")
    if (c === "~" || c === "`") return " "
    return c
  }
  const seq = (end: string): string => {
    let out = ""
    while (i < s.length && s[i] !== end) {
      if (s[i] === " ") { i++; continue }
      out += atom()
    }
    return out
  }
  return seq("\u0000").replace(/\s+/g, " ").trim()
}
