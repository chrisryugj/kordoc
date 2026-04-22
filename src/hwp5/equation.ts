const WORD_COMMANDS = new Map<string, string>([
  ["alpha", "\\alpha"],
  ["beta", "\\beta"],
  ["gamma", "\\gamma"],
  ["delta", "\\delta"],
  ["epsilon", "\\epsilon"],
  ["theta", "\\theta"],
  ["lambda", "\\lambda"],
  ["mu", "\\mu"],
  ["pi", "\\pi"],
  ["sigma", "\\sigma"],
  ["tau", "\\tau"],
  ["phi", "\\phi"],
  ["omega", "\\omega"],
  ["sin", "\\sin"],
  ["cos", "\\cos"],
  ["tan", "\\tan"],
  ["sec", "\\sec"],
  ["csc", "\\csc"],
  ["cot", "\\cot"],
  ["log", "\\log"],
  ["ln", "\\ln"],
  ["lim", "\\lim"],
  ["inf", "\\infty"],
  ["sum", "\\sum"],
  ["smallsum", "\\sum"],
  ["prod", "\\prod"],
  ["int", "\\int"],
  ["oint", "\\oint"],
  ["rightarrow", "\\rightarrow"],
  ["leftarrow", "\\leftarrow"],
  ["partial", "\\partial"],
  ["nabla", "\\nabla"],
  ["angle", "\\angle"],
  ["triangle", "\\triangle"],
  ["vec", "\\vec"],
  ["bar", "\\overline"],
  ["dot", "\\dot"],
  ["hat", "\\hat"],
  ["left", "\\left"],
  ["right", "\\right"],
])

const SYMBOL_WORDS = new Map<string, string>([
  ["times", "\\times"],
  ["divide", "\\div"],
  ["div", "\\div"],
  ["le", "\\leq"],
  ["ge", "\\geq"],
  ["geq", "\\geq"],
  ["deg", "^\\circ"],
  ["rarrow", "\\rightarrow"],
  ["larrow", "\\leftarrow"],
  ["lrarrow", "\\leftrightarrow"],
  ["in", "\\in"],
  ["notin", "\\notin"],
  ["emptyset", "\\emptyset"],
  ["subset", "\\subset"],
  ["nsubset", "\\nsubseteq"],
  ["cup", "\\cup"],
  ["cap", "\\cap"],
  ["smallinter", "\\cap"],
  ["sim", "\\sim"],
  ["circ", "\\circ"],
  ["bot", "\\perp"],
  ["dyad", "\\overleftrightarrow"],
  ["arch", "\\overset{\\frown}"],
])

export function hwpEquationToLatex(equation: string): string {
  return convertEquation(equation.replace(/\0/g, "").trim(), 0)
}

function convertEquation(equation: string, depth: number): string {
  if (!equation || depth > 12) return equation

  let result = equation
    .replace(/\s+/g, " ")
    .replace(/`+/g, "\\,")
    .replace(/~+/g, "\\,")
    .trim()

  result = convertMatrixLike(result)
  result = convertRoots(result, depth)
  result = convertOver(result, depth)
  result = convertSqrt(result, depth)
  result = convertScripts(result)
  result = convertOperators(result)
  result = removeFontDirectives(result)
  result = convertWords(result)
  result = cleanupLatexSpacing(result)

  return result
}

function convertMatrixLike(input: string): string {
  return input
    .replace(/\bmatrix\s*\{([^{}]*)\}/gi, (_match, body: string) =>
      `\\begin{matrix} ${body.split("#").map(part => part.trim()).join(" & ")} \\end{matrix}`
    )
    .replace(/\bcases\s*\{([^{}]*)\}/gi, (_match, body: string) =>
      `\\begin{cases} ${body.split("#").map(part => part.trim()).join(" \\\\ ")} \\end{cases}`
    )
}

function convertRoots(input: string, depth: number): string {
  return input.replace(/(?<!\\)\broot\s+({[^{}]*}|\S+)\s+of\s+({[^{}]*}|\S+)/gi, (_match, degree: string, radicand: string) => {
    return `\\sqrt[${convertEquation(unwrapGroup(degree), depth + 1)}]{${convertEquation(unwrapGroup(radicand), depth + 1)}}`
  })
}

function convertSqrt(input: string, depth: number): string {
  return input.replace(/(?<!\\)\bsqrt\s*({[^{}]*}|\S+)/gi, (_match, radicand: string) => {
    return `\\sqrt{${convertEquation(unwrapGroup(radicand), depth + 1)}}`
  })
}

function convertOver(input: string, depth: number): string {
  let result = input
  for (let guard = 0; guard < 50; guard++) {
    const over = findTopLevelWord(result, "over")
    if (over < 0) break

    const left = readLeftAtom(result, over)
    const right = readRightAtom(result, over + "over".length)
    if (!left || !right) break

    const numerator = convertEquation(unwrapGroup(left.atom), depth + 1)
    const denominator = convertEquation(unwrapGroup(right.atom), depth + 1)
    result =
      result.slice(0, left.start) +
      `\\frac{${numerator}}{${denominator}}` +
      result.slice(right.end)
  }
  return result
}

function convertScripts(input: string): string {
  return input
    .replace(/\s*\^\s*/g, "^")
    .replace(/\s*_\s*/g, "_")
    .replace(/\^(?!\{)([^\s{}_^]+)/g, "^{$1}")
    .replace(/_(?!\{)([^\s{}_^]+)/g, "_{$1}")
}

function convertOperators(input: string): string {
  return input
    .replace(/\+-/g, "\\pm")
    .replace(/-\+/g, "\\mp")
    .replace(/\/\//g, "\\parallel")
    .replace(/△/g, "\\triangle ")
    .replace(/□/g, "\\square ")
    .replace(/‧/g, "\\cdot ")
    .replace(/!=/g, "\\neq")
    .replace(/<=/g, "\\leq")
    .replace(/>=/g, "\\geq")
    .replace(/==/g, "\\equiv")
}

function removeFontDirectives(input: string): string {
  return input.replace(/(?<!\\)\b(?:rm|it)\b\s*/gi, "")
}

function convertWords(input: string): string {
  return input.replace(/(?<![\\A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g, word => {
    const exact = SYMBOL_WORDS.get(word)
    if (exact) return exact
    const lower = word.toLowerCase()
    return SYMBOL_WORDS.get(lower) ?? WORD_COMMANDS.get(lower) ?? word
  })
}

function cleanupLatexSpacing(input: string): string {
  return input
    .replace(/\\left\s*\{/g, "\\left\\{")
    .replace(/\\right\s*\}/g, "\\right\\}")
    .replace(/\\left\s*([\[\]\(\)\|])/g, "\\left$1")
    .replace(/\\right\s*([\[\]\(\)\|])/g, "\\right$1")
    .replace(/\s*\\,\s*/g, "\\,")
    .replace(/\s+/g, " ")
    .replace(/\{\s+/g, "{")
    .replace(/\s+\}/g, "}")
    .trim()
}

function findTopLevelWord(input: string, word: string): number {
  let curly = 0
  let paren = 0
  for (let i = 0; i <= input.length - word.length; i++) {
    const ch = input[i]
    if (ch === "{") curly++
    else if (ch === "}") curly = Math.max(0, curly - 1)
    else if (ch === "(") paren++
    else if (ch === ")") paren = Math.max(0, paren - 1)

    if (curly !== 0 || paren !== 0) continue
    if (input.slice(i, i + word.length).toLowerCase() !== word) continue
    if (isWordChar(input[i - 1]) || isWordChar(input[i + word.length])) continue
    return i
  }
  return -1
}

function readLeftAtom(input: string, end: number): { start: number; atom: string } | null {
  let pos = end - 1
  while (pos >= 0 && /\s/.test(input[pos])) pos--
  if (pos < 0) return null

  if (input[pos] === "}") {
    const start = findMatchingLeft(input, pos, "{", "}")
    if (start >= 0) return { start, atom: input.slice(start, pos + 1) }
  }
  if (input[pos] === ")") {
    const start = findMatchingLeft(input, pos, "(", ")")
    if (start >= 0) return { start, atom: input.slice(start, pos + 1) }
  }

  let start = pos
  while (start >= 0 && !/\s/.test(input[start]) && !/[+\-=<>]/.test(input[start])) start--
  return { start: start + 1, atom: input.slice(start + 1, pos + 1) }
}

function readRightAtom(input: string, start: number): { end: number; atom: string } | null {
  let pos = start
  while (pos < input.length && /\s/.test(input[pos])) pos++
  if (pos >= input.length) return null

  if (input[pos] === "{") {
    const end = findMatchingRight(input, pos, "{", "}")
    if (end >= 0) return { end: end + 1, atom: input.slice(pos, end + 1) }
  }
  if (input[pos] === "(") {
    const end = findMatchingRight(input, pos, "(", ")")
    if (end >= 0) return { end: end + 1, atom: input.slice(pos, end + 1) }
  }

  let end = pos
  while (end < input.length && !/\s/.test(input[end]) && !/[+\-=<>]/.test(input[end])) end++
  return { end, atom: input.slice(pos, end) }
}

function findMatchingLeft(input: string, closeIndex: number, open: string, close: string): number {
  let depth = 0
  for (let i = closeIndex; i >= 0; i--) {
    if (input[i] === close) depth++
    else if (input[i] === open) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function findMatchingRight(input: string, openIndex: number, open: string, close: string): number {
  let depth = 0
  for (let i = openIndex; i < input.length; i++) {
    if (input[i] === open) depth++
    else if (input[i] === close) {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function unwrapGroup(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed.slice(1, -1)
  return trimmed
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[A-Za-z0-9_]/.test(ch)
}
