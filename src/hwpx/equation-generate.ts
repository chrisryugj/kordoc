import { CHAR_NORMAL, PARA_NORMAL, escapeXml } from "./gen-ids.js"

const COMMAND_MAP: Record<string, string> = {
  alpha: "alpha",
  beta: "beta",
  gamma: "gamma",
  delta: "delta",
  epsilon: "epsilon",
  zeta: "zeta",
  eta: "eta",
  theta: "theta",
  iota: "iota",
  kappa: "kappa",
  lambda: "lambda",
  mu: "mu",
  nu: "nu",
  xi: "xi",
  pi: "pi",
  rho: "rho",
  sigma: "sigma",
  tau: "tau",
  upsilon: "upsilon",
  phi: "phi",
  chi: "chi",
  psi: "psi",
  omega: "omega",
  Gamma: "GAMMA",
  Delta: "DELTA",
  Theta: "THETA",
  Lambda: "LAMBDA",
  Xi: "XI",
  Pi: "PI",
  Sigma: "SIGMA",
  Upsilon: "UPSILON",
  Phi: "PHI",
  Psi: "PSI",
  Omega: "OMEGA",
  le: "LEQ",
  leq: "LEQ",
  ge: "GEQ",
  geq: "GEQ",
  ne: "!=",
  neq: "!=",
  pm: "+-",
  mp: "-+",
  times: "TIMES",
  cdot: "cdot",
  ast: "ast",
  circ: "CIRC",
  bullet: "BULLET",
  in: "IN",
  notin: "NOTIN",
  subset: "SUBSET",
  subseteq: "SUBSETEQ",
  supset: "SUPERSET",
  supseteq: "SUPSETEQ",
  cup: "CUP",
  cap: "SMALLINTER",
  emptyset: "EMPTYSET",
  forall: "FORALL",
  exists: "EXIST",
  infinity: "INF",
  infty: "INF",
  partial: "Partial",
  nabla: "NABLA",
  int: "int",
  iint: "dint",
  iiint: "tint",
  oint: "oint",
  sum: "sum",
  prod: "prod",
  lim: "lim",
  to: "->",
  rightarrow: "->",
  leftarrow: "<-",
  leftrightarrow: "<->",
  Rightarrow: "RARROW",
  Leftarrow: "LARROW",
  Leftrightarrow: "LRARROW",
  cdots: "CDOTS",
  ldots: "LDOTS",
  vdots: "VDOTS",
  ddots: "DDOTS",
}

const ACCENT_COMMANDS: Record<string, string> = {
  bar: "bar",
  overline: "bar",
  vec: "vec",
  hat: "hat",
  widehat: "hat",
  tilde: "tilde",
  widetilde: "tilde",
  dot: "dot",
  ddot: "ddot",
  underline: "under",
}

const RESERVED_SUBSCRIPT_WORDS = new Set([
  "rel", "eq", "ne", "le", "ge", "lt", "gt", "equiv", "sim", "approx", "cong", "propto", "parallel", "perp",
  "and", "or", "not", "in", "notin", "subset", "supset", "sub", "sup", "cup", "cap", "emptyset", "forall", "exists",
])

interface ReadResult {
  value: string
  next: number
}

interface EquationMetrics {
  width: number
  height: number
  baseline: number
}

interface EquationXmlOptions {
  id?: number
  zOrder?: number
  width?: number
  height?: number
  baseline?: number
  font?: string
  autoQuote?: boolean
}

function skipSpaces(input: string, idx: number): number {
  while (idx < input.length && /\s/.test(input[idx])) idx++
  return idx
}

function normalizeEqEdit(input: string): string {
  return input
    .replace(/[ \t\r\n]+/g, " ")
    .replace(/\s+([,;:)])/g, "$1")
    .replace(/([([{])\s+/g, "$1")
    .trim()
}

function stripMathDelimiters(input: string): string {
  let s = input.trim()
  if (s.startsWith("$$") && s.endsWith("$$")) s = s.slice(2, -2).trim()
  if (s.startsWith("\\[") && s.endsWith("\\]")) s = s.slice(2, -2).trim()
  return s
}

function readBalanced(input: string, idx: number, open: string, close: string): ReadResult {
  let depth = 1
  let cursor = idx + 1
  while (cursor < input.length) {
    const ch = input[cursor]
    if (ch === "\\") {
      cursor += 2
      continue
    }
    if (ch === open) depth++
    else if (ch === close) depth--
    if (depth === 0) {
      return { value: input.slice(idx + 1, cursor), next: cursor + 1 }
    }
    cursor++
  }
  return { value: input.slice(idx + 1), next: input.length }
}

function readGroupOrToken(input: string, idx: number): ReadResult {
  const start = skipSpaces(input, idx)
  if (input[start] === "{") {
    const group = readBalanced(input, start, "{", "}")
    return { value: convertLatexFragment(group.value), next: group.next }
  }
  if (input[start] === "\\") {
    const cmd = readCommand(input, start)
    return { value: cmd.value, next: cmd.next }
  }
  return { value: input[start] ?? "", next: Math.min(start + 1, input.length) }
}

function readCommandName(input: string, idx: number): ReadResult {
  if (input[idx + 1] === "\\") return { value: "\\", next: idx + 2 }
  const match = /^[A-Za-z]+/.exec(input.slice(idx + 1))
  if (match) return { value: match[0], next: idx + 1 + match[0].length }
  return { value: input[idx + 1] ?? "", next: Math.min(idx + 2, input.length) }
}

function readCommand(input: string, idx: number): ReadResult {
  const name = readCommandName(input, idx)
  const command = name.value

  if (command === "\\") return { value: "#", next: name.next }

  if (command === "frac") {
    const num = readGroupOrToken(input, name.next)
    const den = readGroupOrToken(input, num.next)
    return { value: `{${num.value}} over {${den.value}}`, next: den.next }
  }

  if (command === "sqrt") {
    let cursor = skipSpaces(input, name.next)
    let root: ReadResult | null = null
    if (input[cursor] === "[") {
      const opt = readBalanced(input, cursor, "[", "]")
      root = { value: convertLatexFragment(opt.value), next: opt.next }
      cursor = opt.next
    }
    const body = readGroupOrToken(input, cursor)
    if (root) return { value: `root {${root.value}} of {${body.value}}`, next: body.next }
    return { value: `sqrt{${body.value}}`, next: body.next }
  }

  if (command === "begin") {
    const env = readGroupOrToken(input, name.next)
    const endTag = `\\end{${env.value}}`
    const endIdx = input.indexOf(endTag, env.next)
    if (endIdx === -1) return { value: env.value, next: env.next }
    const body = convertLatexFragment(input.slice(env.next, endIdx))
    const matrix = `{matrix{${body}}}`
    if (env.value === "pmatrix") return { value: `LEFT ( ${matrix} RIGHT )`, next: endIdx + endTag.length }
    if (env.value === "bmatrix") return { value: `LEFT [ ${matrix} RIGHT ]`, next: endIdx + endTag.length }
    if (env.value === "matrix") return { value: matrix, next: endIdx + endTag.length }
    return { value: body, next: endIdx + endTag.length }
  }

  if (command === "left" || command === "right") {
    const cursor = skipSpaces(input, name.next)
    const delimiter = input[cursor] ?? ""
    return { value: `${command === "left" ? "LEFT" : "RIGHT"} ${delimiter}`, next: delimiter ? cursor + 1 : cursor }
  }

  if (command in ACCENT_COMMANDS) {
    const body = readGroupOrToken(input, name.next)
    return { value: `${ACCENT_COMMANDS[command]}{${body.value}}`, next: body.next }
  }

  if (command === "mathrm" || command === "text") {
    return readGroupOrToken(input, name.next)
  }

  return { value: COMMAND_MAP[command] ?? command, next: name.next }
}

function convertLatexFragment(input: string): string {
  let out = ""
  let idx = 0

  while (idx < input.length) {
    const ch = input[idx]
    if (ch === "\\") {
      const cmd = readCommand(input, idx)
      out += ` ${cmd.value} `
      idx = cmd.next
      continue
    }
    if (ch === "{") {
      const group = readBalanced(input, idx, "{", "}")
      out += `{${convertLatexFragment(group.value)}}`
      idx = group.next
      continue
    }
    if (ch === "_" || ch === "^") {
      const script = readGroupOrToken(input, idx + 1)
      out += ` ${ch}{${script.value}}`
      idx = script.next
      continue
    }
    if (ch === "&") {
      out += " & "
      idx++
      continue
    }
    out += ch
    idx++
  }

  return normalizeEqEdit(out)
}

export function quoteReservedKeywords(script: string): string {
  return script.replace(/([_^])\s*\{([^{}]+)\}/g, (match, op: string, inner: string) => {
    const value = inner.trim()
    if (/^".*"$/.test(value)) return match
    if (!/^[A-Za-z]+$/.test(value)) return match
    return RESERVED_SUBSCRIPT_WORDS.has(value) ? `${op}{"${value}"}` : match
  })
}

export function latexLikeToEqEdit(input: string): string {
  return quoteReservedKeywords(convertLatexFragment(stripMathDelimiters(input)))
}

function estimateEquationMetrics(script: string): EquationMetrics {
  const cleaned = script.replace(/[{}\\^_]/g, "").replace(/\s+/g, " ").trim()
  const width = Math.min(Math.max(cleaned.length, 5) * 700 + 2000, 40000)
  const rowCount = Math.max(1, (script.match(/#/g) ?? []).length + 1)

  if (/\bmatrix\b|#/.test(script)) {
    if (rowCount >= 4) return { width, height: 5500, baseline: 55 }
    if (rowCount === 3) return { width, height: 4500, baseline: 60 }
    return { width, height: 3260, baseline: 63 }
  }
  if (/\bover\b|\broot\b|\bsqrt\b/.test(script)) return { width, height: 3010, baseline: 69 }
  return { width, height: 1450, baseline: 71 }
}

export function generateEquationXml(script: string, options: EquationXmlOptions = {}): string {
  const zOrder = options.zOrder ?? 0
  const metrics = estimateEquationMetrics(script)
  const width = options.width ?? metrics.width
  const height = options.height ?? metrics.height
  const baseline = options.baseline ?? metrics.baseline
  const eqId = options.id ?? 2_000_000_001 + zOrder
  const font = options.font ?? "HYhwpEQ"
  const safeScript = options.autoQuote === false ? script : quoteReservedKeywords(script)

  return `<hp:equation id="${eqId}" zOrder="${zOrder}" numberingType="EQUATION" ` +
    `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
    `version="Equation Version 60" baseLine="${baseline}" textColor="#000000" ` +
    `baseUnit="1200" lineMode="CHAR" font="${font}">` +
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" ` +
    `vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="56" right="56" top="0" bottom="0"/>` +
    `<hp:shapeComment>수식입니다.</hp:shapeComment>` +
    `<hp:script>${escapeXml(safeScript)}</hp:script>` +
    `</hp:equation>`
}

export function generateEquationParagraph(input: string, zOrder: number = 0): string {
  const script = latexLikeToEqEdit(input)
  const metrics = estimateEquationMetrics(script)
  const equation = generateEquationXml(script, { zOrder, ...metrics })
  return `<hp:p id="${2_147_483_648 + zOrder}" paraPrIDRef="${PARA_NORMAL}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">` +
    `<hp:run charPrIDRef="${CHAR_NORMAL}">${equation}<hp:t/></hp:run>` +
    `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="${metrics.height}" textheight="${metrics.height}" ` +
    `baseline="${Math.max(metrics.height - 938, 200)}" spacing="600" horzpos="0" horzsize="42520" flags="393216"/>` +
    `</hp:linesegarray></hp:p>`
}
