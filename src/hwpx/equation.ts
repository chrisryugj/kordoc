/**
 * HWPX/HWP equation script → LaTeX
 *
 * Ported from hml-equation-parser (Python, Apache 2.0)
 *   https://github.com/OpenBapul/hml-equation-parser
 *   Copyright 2018 Open Bapul
 *   See THIRD_PARTY/hml-equation-parser.txt for the full license.
 *
 * Entry point: `hmlToLatex(script)`.
 *
 * Notes:
 * - The input is the raw text of <hp:script> inside <hp:equation>, i.e.
 *   Hancom's mini equation language ("HULK-style"). Example:
 *     x = { -b +- SQRT { b^2 -4ac } } over {2a}
 *   is converted to:
 *     x = \frac { -b +- \sqrt { b^2 -4ac } }{2a}
 * - The algorithm is a direct port of hulkEqParser.py / hulkReplaceMethod.py
 *   with the same 5-pass rewrite (frac → rootOf → matrix → bar → brace).
 */

interface MatrixMapping {
  begin: string
  end: string
  removeOutterBrackets: boolean
}

// ─── convertMap (from convertMap.json) ────────────────────────────────────
// Single-token replacements (applied to each whitespace-delimited token).
// Exported for equation-generate.ts: 예약어 도출 + 전 토큰 왕복 테스트 (PR #39).
export const CONVERT_MAP: Record<string, string> = {
  TIMES: "\\times", times: "\\times",
  LEFT: "\\left", RIGHT: "\\right",
  under: "\\underline",
  SMALLSUM: "\\sum", sum: "\\sum",
  SMALLPROD: "\\prod", prod: "\\prod",
  SMALLINTER: "\\cap",
  CUP: "\\cup",
  OPLUS: "\\oplus", OMINUS: "\\ominus", OTIMES: "\\otimes", ODIV: "\\oslash", ODOT: "\\odot",
  LOR: "\\lor", LAND: "\\land",
  SUBSET: "\\subset", SUPERSET: "\\supset", SUBSETEQ: "\\subseteq", SUPSETEQ: "\\supseteq",
  IN: "\\in", OWNS: "\\owns", NOTIN: "\\notin",
  LEQ: "\\leq", GEQ: "\\geq",
  "<<": "\\ll", ">>": "\\gg", "<<<": "\\lll", ">>>": "\\ggg",
  PREC: "\\prec", SUCC: "\\succ",
  UPLUS: "\\uplus",
  "±": "\\pm", "+-": "\\pm", "-+": "\\mp", "÷": "\\div",
  cdot: "\\cdot",
  CIRC: "\\circ", BULLET: "\\bullet", DEG: " ^\\circ",
  AST: "\\ast", STAR: "\\bigstar", BIGCIRC: "\\bigcirc",
  EMPTYSET: "\\emptyset",
  THEREFORE: "\\therefore", BECAUSE: "\\because", EXIST: "\\exists",
  "!=": "\\neq",
  SMCOPROD: "\\coprod", coprod: "\\coprod",
  SQCAP: "\\sqcap", SQCUP: "\\sqcup",
  SQSUBSET: "\\sqsubset", SQSUBSETEQ: "\\sqsubseteq",
  BIGSQCUP: "\\bigsqcup",
  BIGOPLUS: "\\bigoplus", BIGOTIMES: "\\bigotimes", BIGODOT: "\\bigodot", BIGUPLUS: "\\biguplus",
  inter: "\\bigcap", union: "\\bigcup",
  BIGOMINUS: "{\\Large\\ominus}", BIGODIV: "{\\Large\\oslash}",
  UNDEROVER: "",
  SIM: "\\sim", APPROX: "\\approx", SIMEQ: "\\simeq", CONG: "\\cong",
  "==": "\\equiv",
  DIAMOND: "\\diamond", FORALL: "\\forall",
  prime: "'", Partial: "\\partial", INF: "\\infty", PROPTO: "\\propto",
  lim: "\\lim", Lim: "\\lim",
  larrow: "\\leftarrow", "->": "\\rightarrow",
  uparrow: "\\uparrow", downarrow: "\\downarrow",
  LARROW: "\\Leftarrow", RARROW: "\\Rightarrow",
  UPARROW: "\\Uparrow", DOWNARROW: "\\Downarrow",
  udarrow: "\\updownarrow",
  "<->": "\\leftrightarrow",
  UDARROW: "\\Updownarrow", LRARROW: "\\Leftrightarrow",
  NWARROW: "\\nwarrow", SEARROW: "\\searrow", NEARROW: "\\nearrow", SWARROW: "\\swarrow",
  HOOKLEFT: "\\hookleftarrow", HOOKRIGHT: "\\hookrightarrow",
  PVER: "\\|", MAPSTO: "\\mapsto",
  CDOTS: "\\cdots", LDOTS: "\\ldots", VDOTS: "\\vdots", DDOTS: "\\ddots",
  DAGGER: "\\dagger", DDAGGER: "\\ddagger", DOTEQ: "\\doteq",
  image: "\\fallingdotseq", REIMAGE: "\\risingdotseq",
  ASYMP: "\\asymp", ISO: "\\Bumpeq",
  DSUM: "\\dotplus", XOR: "\\veebar",
  TRIANGLE: "\\triangle", NABLA: "\\nabla",
  ANGLE: "\\angle", MSANGLE: "\\measuredangle", SANGLE: "\\sphericalangle",
  VDASH: "\\vdash", DASHV: "\\dashv",
  BOT: "\\bot", TOP: "\\top", MODELS: "\\models",
  LAPLACE: "\\mathcal{L}",
  CENTIGRADE: "^{\\circ}C", FAHRENHEIT: "^{\\circ}F",
  LSLANT: "\\diagup", RSLANT: "\\diagdown",

  sqrt: "\\sqrt",
  int: "\\int", dint: "\\iint", tint: "\\iiint", oint: "\\oint",

  alpha: "\\alpha", beta: "\\beta", gamma: "\\gamma", delta: "\\delta",
  epsilon: "\\epsilon", zeta: "\\zeta", eta: "\\eta", theta: "\\theta",
  iota: "\\iota", kappa: "\\kappa", lambda: "\\lambda", mu: "\\mu",
  nu: "\\nu", xi: "\\xi", omicron: "\\omicron", pi: "\\pi",
  rho: "\\rho", sigma: "\\sigma", tau: "\\tau", upsilon: "\\upsilon",
  phi: "\\phi", chi: "\\chi", psi: "\\psi", omega: "\\omega",
  ALPHA: "A", BETA: "B", GAMMA: "\\Gamma", DELTA: "\\Delta",
  EPSILON: "E", ZETA: "Z", ETA: "H", THETA: "\\Theta",
  IOTA: "I", KAPPA: "K", LAMBDA: "\\Lambda", MU: "M",
  NU: "N", XI: "\\Xi", OMICRON: "O", PI: "\\Pi",
  RHO: "P", SIGMA: "\\Sigma", TAU: "T", UPSILON: "\\Upsilon",
  PHI: "\\Phi", CHI: "X", PSI: "\\Psi", OMEGA: "\\Omega",

  "⌈": "\\lceil", "⌉": "\\rceil",
  "⌊": "\\lfloor", "⌋": "\\rfloor",
  "∥": "\\|",
  "⊐": "\\sqsupset", "⊒": "\\sqsupseteq",

  odint: "\\mathop ∯",
  otint: "\\mathop ∰",
  BIGSQCAP: "\\mathop ⨅",
  ATT: "\\mathop ※",
  HUND: "\\mathop ‰",
  THOU: "\\mathop ‱",
  IDENTICAL: "\\mathop ∷",
  RTANGLE: "\\mathop ⊾",
  BASE: "\\mathop ⌂",
  BENZENE: "\\mathop ⌬",
}

// Tokens rewritten to a HULK-prefixed marker, then expanded in second passes.
export const MIDDLE_CONVERT_MAP: Record<string, string> = {
  matrix: "HULKMATRIX",
  pmatrix: "HULKPMATRIX",
  bmatrix: "HULKBMATRIX",
  dmatrix: "HULKDMATRIX",
  eqalign: "HULKEQALIGN",
  cases: "HULKCASE",
  vec: "HULKVEC",
  dyad: "HULKDYAD",
  acute: "HULKACUTE",
  grave: "HULKGRAVE",
  dot: "HULKDOT",
  ddot: "HULKDDOT",
  bar: "HULKBAR",
  hat: "HULKHAT",
  check: "HULKCHECK",
  arch: "HULKARCH",
  tilde: "HULKTILDE",
  BOX: "HULKBOX",
  OVERBRACE: "HULKOVERBRACE",
  UNDERBRACE: "HULKUNDERBRACE",
}

const BAR_CONVERT_MAP: Record<string, string> = {
  HULKVEC: "\\overrightarrow",
  HULKDYAD: "\\overleftrightarrow",
  HULKACUTE: "\\acute",
  HULKGRAVE: "\\grave",
  HULKDOT: "\\dot",
  HULKDDOT: "\\ddot",
  HULKBAR: "\\overline",
  HULKHAT: "\\widehat",
  HULKCHECK: "\\check",
  HULKARCH: "\\overset{\\frown}",
  HULKTILDE: "\\widetilde",
  HULKBOX: "\\boxed",
}

const MATRIX_CONVERT_MAP: Record<string, MatrixMapping> = {
  HULKMATRIX: { begin: "\\begin{matrix}", end: "\\end{matrix}", removeOutterBrackets: true },
  HULKPMATRIX: { begin: "\\begin{pmatrix}", end: "\\end{pmatrix}", removeOutterBrackets: true },
  HULKBMATRIX: { begin: "\\begin{bmatrix}", end: "\\end{bmatrix}", removeOutterBrackets: true },
  HULKDMATRIX: { begin: "\\begin{vmatrix}", end: "\\end{vmatrix}", removeOutterBrackets: true },
  HULKCASE: { begin: "\\begin{cases}", end: "\\end{cases}", removeOutterBrackets: true },
  HULKEQALIGN: { begin: "\\eqalign{", end: "}", removeOutterBrackets: false },
}

const BRACE_CONVERT_MAP: Record<string, string> = {
  HULKOVERBRACE: "\\overbrace",
  HULKUNDERBRACE: "\\underbrace",
}

// ─── Bracket scanning helpers ─────────────────────────────────────────────

/**
 * Find a matching `{...}` pair at/after `startIdx` (direction=1) or before
 * (direction=0). Returns [start, end) such that eqString.slice(start, end)
 * is the full bracketed substring including the `{` and `}`.
 * Throws when no matching bracket exists.
 */
function findBrackets(eqString: string, startIdx: number, direction: 0 | 1): [number, number] {
  if (direction === 1) {
    const startCur = eqString.indexOf("{", startIdx)
    if (startCur === -1) throw new Error("cannot find bracket")
    let bracketCount = 1
    for (let i = startCur + 1; i < eqString.length; i++) {
      const ch = eqString[i]
      if (ch === "{") bracketCount += 1
      else if (ch === "}") bracketCount -= 1
      if (bracketCount === 0) return [startCur, i + 1]
    }
    throw new Error("cannot find bracket")
  }

  // direction=0: reverse the string (and swap braces) then reuse dir=1 search.
  const reversed = Array.from(eqString).reverse()
  for (let i = 0; i < reversed.length; i++) {
    if (reversed[i] === "{") reversed[i] = "}"
    else if (reversed[i] === "}") reversed[i] = "{"
  }
  const flipped = reversed.join("")
  const newStartIdx = flipped.length - (startIdx + 1)
  const [s, e] = findBrackets(flipped, newStartIdx, 1)
  return [flipped.length - e, flipped.length - s]
}

/**
 * From a cursor inside a bracketed group, walk backward to the enclosing
 * `{` and return the outer `{...}` span.
 */
function findOutterBrackets(eqString: string, startIdx: number): [number, number] {
  const outer = findEnclosingBrackets(eqString, startIdx)
  if (!outer) throw new Error("cannot find bracket")
  return outer
}

/**
 * Find the nearest `{...}` group that actually encloses `startIdx`.
 * A previous closed group such as `_ { x } HULKBAR { y }` must not be
 * treated as the outer wrapper for `HULKBAR`.
 */
function findEnclosingBrackets(eqString: string, startIdx: number): [number, number] | null {
  let depth = 0
  for (let idx = startIdx - 1; idx >= 0; idx--) {
    const ch = eqString[idx]
    if (ch === "}") {
      depth += 1
    } else if (ch === "{") {
      if (depth > 0) {
        depth -= 1
        continue
      }
      try {
        const [start, end] = findBrackets(eqString, idx, 1)
        if (start === idx && end > startIdx) return [start, end]
      } catch {
        return null
      }
      return null
    }
  }
  return null
}

// ─── Rewrite passes ───────────────────────────────────────────────────────

/** `{1} over {2}` → `\frac{1}{2}` */
function replaceFrac(eqString: string): string {
  const hmlFrac = "over"
  while (true) {
    const cursor = eqString.indexOf(hmlFrac)
    if (cursor === -1) break
    try {
      const [numStart, numEnd] = findBrackets(eqString, cursor, 0)
      const numerator = eqString.slice(numStart, numEnd)
      const beforeFrac = eqString.slice(0, numStart)
      const afterFrac = eqString.slice(cursor + hmlFrac.length)
      eqString = beforeFrac + "\\frac" + numerator + afterFrac
    } catch {
      return eqString
    }
  }
  return eqString
}

/** `root {1} of {2}` → `\sqrt[1]{2}` */
function replaceRootOf(eqString: string): string {
  while (true) {
    const rootCursor = eqString.indexOf("root")
    if (rootCursor === -1) break
    try {
      const ofCursor = eqString.indexOf("of")
      if (ofCursor === -1) return eqString
      const elem1 = findBrackets(eqString, rootCursor, 1)
      const elem2 = findBrackets(eqString, ofCursor, 1)
      const e1 = eqString.slice(elem1[0] + 1, elem1[1] - 1)
      const e2 = eqString.slice(elem2[0] + 1, elem2[1] - 1)
      eqString =
        eqString.slice(0, rootCursor) +
        "\\sqrt" +
        "[" + e1 + "]" +
        "{" + e2 + "}" +
        eqString.slice(elem2[1] + 1)
    } catch {
      return eqString
    }
  }
  return eqString
}

/** matrix/pmatrix/bmatrix/dmatrix/cases/eqalign expansion. */
function replaceAllMatrix(eqString: string): string {
  const replaceElements = (bracketStr: string): string => {
    let inner = bracketStr.slice(1, -1) // strip outer `{` `}`
    inner = inner.replace(/#/g, " \\\\ ")
    inner = inner.replace(/&amp;/g, "&")
    return inner
  }

  const replaceMatrix = (input: string, matStr: string, matElem: MatrixMapping): string => {
    while (true) {
      const cursor = input.indexOf(matStr)
      if (cursor === -1) break
      try {
        const [eStart, eEnd] = findBrackets(input, cursor, 1)
        const elem = replaceElements(input.slice(eStart, eEnd))
        let beforeMat: string
        let afterMat: string
        const outer = matElem.removeOutterBrackets ? findEnclosingBrackets(input, cursor) : null
        if (outer && outer[1] >= eEnd) {
          const [bStart, bEnd] = outer
          beforeMat = input.slice(0, bStart)
          afterMat = input.slice(bEnd)
        } else {
          beforeMat = input.slice(0, cursor)
          afterMat = input.slice(eEnd)
        }
        input = beforeMat + matElem.begin + elem + matElem.end + afterMat
      } catch {
        return input
      }
    }
    return input
  }

  for (const [matKey, matElem] of Object.entries(MATRIX_CONVERT_MAP)) {
    eqString = replaceMatrix(eqString, matKey, matElem)
  }
  return eqString
}

/** vec/hat/bar/dot/ddot/tilde/… (HULK-prefixed) → LaTeX accent. */
function replaceAllBar(eqString: string): string {
  const replaceBar = (input: string, barStr: string, barElem: string): string => {
    while (true) {
      const cursor = input.indexOf(barStr)
      if (cursor === -1) break
      try {
        const [eStart, eEnd] = findBrackets(input, cursor, 1)
        const elem = input.slice(eStart, eEnd)
        const outer = findEnclosingBrackets(input, cursor)
        const [replaceStart, replaceEnd] = outer && outer[1] >= eEnd ? outer : [cursor, eEnd]
        const beforeBar = input.slice(0, replaceStart)
        const afterBar = input.slice(replaceEnd)
        input = beforeBar + barElem + elem + afterBar
      } catch {
        return input
      }
    }
    return input
  }

  for (const [barKey, barElem] of Object.entries(BAR_CONVERT_MAP)) {
    eqString = replaceBar(eqString, barKey, barElem)
  }
  return eqString
}

/** overbrace/underbrace: `BRACE {body} {label}` → `\overbrace{body}^{label}` */
function replaceAllBrace(eqString: string): string {
  const replaceBrace = (input: string, braceStr: string, braceElem: string): string => {
    while (true) {
      const cursor = input.indexOf(braceStr)
      if (cursor === -1) break
      try {
        const [eStart1, eEnd1] = findBrackets(input, cursor, 1)
        const [eStart2, eEnd2] = findBrackets(input, eEnd1, 1)
        const elem1 = input.slice(eStart1, eEnd1)
        const elem2 = input.slice(eStart2, eEnd2)
        const beforeBrace = input.slice(0, cursor)
        const afterBrace = input.slice(eEnd2)
        input = beforeBrace + braceElem + elem1 + "^" + elem2 + afterBrace
      } catch {
        return input
      }
    }
    return input
  }

  for (const [braceKey, braceElem] of Object.entries(BRACE_CONVERT_MAP)) {
    eqString = replaceBrace(eqString, braceKey, braceElem)
  }
  return eqString
}

/** After single-token pass, fix `\left {` → `\left \{` and `\right }` → `\right \}`. */
function replaceBracket(strList: string[]): string[] {
  for (let i = 0; i < strList.length; i++) {
    if (strList[i] === "{" && i > 0 && strList[i - 1] === "\\left") strList[i] = "\\{"
    if (strList[i] === "}" && i > 0 && strList[i - 1] === "\\right") strList[i] = "\\}"
  }
  return strList
}

/**
 * Convert an HWPX equation script (mini Hancom equation language) to LaTeX.
 * Returns the converted LaTeX body (without `$` delimiters).
 */
export function hmlToLatex(hmlEqStr: string): string {
  if (!hmlEqStr) return ""

  let s = hmlEqStr.replace(/`/g, " ")
  s = s.replace(/\{/g, " { ").replace(/\}/g, " } ").replace(/&/g, " & ")

  let tokens = s.split(" ")
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t in CONVERT_MAP) tokens[i] = CONVERT_MAP[t]
    else if (t in MIDDLE_CONVERT_MAP) tokens[i] = MIDDLE_CONVERT_MAP[t]
    else {
      // EqEdit 리터럴 따옴표("int" 등 — 명령 해석 차단용) → \text{...}로 복원.
      // 생성기(equation-generate.ts)의 \text→"..." 출력과 고정점을 이룬다.
      // 공백 포함 다중 토큰 인용은 기존대로 통과 (토큰 단위라 식별 불가).
      const quoted = /^"(.+)"$/.exec(t)
      if (quoted) tokens[i] = `\\text{${quoted[1]}}`
    }
  }
  tokens = tokens.filter(tok => tok.length !== 0)
  tokens = replaceBracket(tokens)

  let out = tokens.join(" ")
  out = replaceFrac(out)
  out = replaceRootOf(out)
  out = replaceAllMatrix(out)
  out = replaceAllBar(out)
  out = replaceAllBrace(out)

  return out
}
