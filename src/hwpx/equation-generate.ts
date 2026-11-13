/**
 * Markdown display math (LaTeX-like subset) → Hancom EqEdit script + <hp:equation> XML.
 *
 * 읽기 경로(equation.ts hmlToLatex)의 역방향. 어휘는 equation.ts의 토큰 맵과
 * 양방향 정합을 유지한다 — 여기서 뿜는 모든 토큰은 hmlToLatex가 같은 LaTeX로
 * 되읽어야 하며, 전 토큰 왕복 테스트(hwpx-equation-generation.test.ts)가 잠근다.
 */

import { CHAR_NORMAL, PARA_NORMAL, escapeXml } from "./gen-ids.js"
import { CONVERT_MAP, MIDDLE_CONVERT_MAP } from "./equation.js"
import { measureEquation } from "./equation-metrics.js"

// 비신뢰 입력 가드 — markdownToHwpx는 MCP/CLI로 임의 입력을 받는다 (리뷰 #39 ·2).
const MAX_EQUATION_SOURCE = 10_000
const MAX_GROUP_DEPTH = 64

// LaTeX 명령 → EqEdit 토큰. 값은 반드시 읽기 맵(CONVERT_MAP)이 같은 LaTeX로
// 되돌리는 토큰이어야 한다 (왕복 테스트가 전 항목 검증 — 리뷰 #39 ·3).
export const COMMAND_MAP: Record<string, string> = {
  // 읽기 맵의 소문자 별칭(therefore·because, #148)이 역인덱스의 이름 일치로 정준형을 빼앗지 않게 대문자를 명시
  therefore: "THEREFORE",
  because: "BECAUSE",
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
  ast: "AST",
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
  leftarrow: "larrow",
  leftrightarrow: "<->",
  Rightarrow: "RARROW",
  Leftarrow: "LARROW",
  Leftrightarrow: "LRARROW",
  cdots: "CDOTS",
  ldots: "LDOTS",
  vdots: "VDOTS",
  ddots: "DDOTS",
  // 수직 ⊥ 은 BOT(되읽기 \bot — 같은 기호), 네모 □ 는 글자 그대로(HWP5 실문서 스크립트, 되읽기 \square).
  // 없으면 따옴표 폴백 "perp"·"square" 로 글자가 찍혔다(시험지 수식 생성 왕복)
  perp: "BOT",
  square: "□",
}

/**
 * EqEdit 함수 키워드 — 렌더러가 로만체 함수명으로 아는 어휘. 되읽기(hmlToLatex)가
 * 명령이 아닌 평문(sin)이라 COMMAND_MAP 고정점 검증 대상이 아니며, 미지원 명령
 * 따옴표 폴백에서 이들을 "sin" 리터럴로 감싸지 않기 위한 명단이다 (identity 통과).
 */
const EQEDIT_FUNCTIONS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth",
  "log", "ln", "exp", "det", "gcd", "mod",
  "max", "min", "arg", "deg", "hom", "ker", "Pr",
])

// CONVERT_MAP 역인덱스 충전 (v4.0.6) — 읽기맵(~150 연산자)에 있는데 쓰기맵에 없던
// 명령(\div \approx \therefore \because \oplus \uparrow \propto \cong \equiv \sim
// \angle \mapsto \ll \gg \dagger \models \owns 등 ~60개)이 백슬래시만 벗겨진
// '맨 알파벳'으로 EqEdit에 누출되던 것을 봉합. 단일 명령 값(^\[A-Za-z]+$)만
// 역매핑 — 합성 값(\mathop ∯·{\Large\ominus}·^{\circ}C 등 읽기전용)은 제외.
// 명시 항목이 항상 우선(leq→LEQ 등 기존 정준형 유지). 같은 LaTeX의 후보 토큰이
// 여럿이면 이름 일치 > 영문 토큰 > 사전순으로 정준형을 고정한다.
// 왕복은 구성상 보장: 방출 토큰 T의 CONVERT_MAP[T]가 곧 원 명령이다.
{
  const reverse = new Map<string, string>()
  const prefer = (name: string, a: string, b: string): string => {
    if (a === name) return a
    if (b === name) return b
    const aAlpha = /^[A-Za-z]+$/.test(a)
    const bAlpha = /^[A-Za-z]+$/.test(b)
    if (aAlpha !== bAlpha) return aAlpha ? a : b
    return a < b ? a : b
  }
  for (const [token, latex] of Object.entries(CONVERT_MAP)) {
    const m = /^\\([A-Za-z]+)$/.exec(latex)
    if (!m) continue
    const name = m[1]
    if (name in COMMAND_MAP) continue
    const prev = reverse.get(name)
    reverse.set(name, prev === undefined ? token : prefer(name, token, prev))
  }
  for (const [name, token] of reverse) COMMAND_MAP[name] = token
}

// 악센트도 왕복 정합: 값 토큰을 hmlToLatex가 되돌린 명령이 다시 이 맵의 키여야
// 한다 (bar → \overline → bar 고정점. overrightarrow는 vec의 되읽기 별칭).
export const ACCENT_COMMANDS: Record<string, string> = {
  bar: "bar",
  overline: "bar",
  vec: "vec",
  overrightarrow: "vec",
  hat: "hat",
  widehat: "hat",
  tilde: "tilde",
  widetilde: "tilde",
  dot: "dot",
  ddot: "ddot",
  underline: "under",
  // 네모 상자 — 빈칸 문제의 ㈎·㈏ 칸(시험지 해설). 없으면 "boxed" 글자로 찍혔다
  boxed: "BOX",
}

// EqEdit이 명령으로 해석하는 어휘 = 읽기 맵 키 + 구조 키워드. 첨자/위첨자의
// 리터럴 단어가 이와 충돌하면 따옴표 보호 (T_{int}의 int가 ∫로 렌더되는 것 방지).
// 구 하드코딩 18단어는 실제 토큰맵과 무관해 폐기 (리뷰 #39 ·8).
const RESERVED_WORDS = new Set(
  [...Object.keys(CONVERT_MAP), ...Object.keys(MIDDLE_CONVERT_MAP), "over", "root", "of"]
    .filter((w) => /^[A-Za-z]+$/.test(w)),
)

interface ReadResult {
  value: string
  next: number
}

function skipSpaces(input: string, idx: number): number {
  while (idx < input.length && /\s/.test(input[idx])) idx++
  return idx
}

// 공백 정리만 한다. 구두점/괄호 접합은 금지 — "RIGHT )"를 "RIGHT)"로 붙이면
// 공백 토크나이저인 hmlToLatex가 토큰을 못 읽어 왕복이 붕괴한다 (리뷰 #39 ·4).
function normalizeEqEdit(input: string): string {
  return input.replace(/\s+/g, " ").trim()
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

function readGroupOrToken(input: string, idx: number, depth: number): ReadResult {
  const start = skipSpaces(input, idx)
  // 중첩 상한 초과 — 남은 입력을 리터럴로 폴백 (스택 오버플로 가드, 리뷰 #39 ·2)
  if (depth > MAX_GROUP_DEPTH) return { value: input.slice(start), next: input.length }
  if (input[start] === "{") {
    const group = readBalanced(input, start, "{", "}")
    return { value: convertLatexFragment(group.value, depth + 1), next: group.next }
  }
  if (input[start] === "\\") {
    const cmd = readCommand(input, start, depth + 1)
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

function readCommand(input: string, idx: number, depth: number): ReadResult {
  const name = readCommandName(input, idx)
  const command = name.value

  if (command === "\\") return { value: "#", next: name.next }

  if (command === "frac") {
    const num = readGroupOrToken(input, name.next, depth)
    const den = readGroupOrToken(input, num.next, depth)
    return { value: `{${num.value}} over {${den.value}}`, next: den.next }
  }

  if (command === "sqrt") {
    let cursor = skipSpaces(input, name.next)
    let root: ReadResult | null = null
    if (input[cursor] === "[") {
      const opt = readBalanced(input, cursor, "[", "]")
      root = { value: convertLatexFragment(opt.value, depth + 1), next: opt.next }
      cursor = opt.next
    }
    const body = readGroupOrToken(input, cursor, depth)
    if (root) return { value: `root {${root.value}} of {${body.value}}`, next: body.next }
    return { value: `sqrt{${body.value}}`, next: body.next }
  }

  if (command === "begin") {
    const env = readGroupOrToken(input, name.next, depth)
    const endTag = `\\end{${env.value}}`
    const endIdx = input.indexOf(endTag, env.next)
    if (endIdx === -1) return { value: env.value, next: env.next }
    const body = convertLatexFragment(input.slice(env.next, endIdx), depth + 1)
    // 환경 → EqEdit 네이티브 토큰 화이트리스트 — LEFT (/RIGHT ) 합성보다 왕복이 정확.
    // 고정점: matrix/pmatrix/bmatrix 원 환경 복원, cases→HULKCASE→\begin{cases},
    // vmatrix→dmatrix→\begin{vmatrix}. align 계열은 eqalign으로 렌더 보존
    // (되읽기는 \eqalign — plain TeX 어휘라 고정점은 아님, 렌더·내용 무손실).
    const ENV_TOKEN: Record<string, string> = {
      matrix: "matrix", pmatrix: "pmatrix", bmatrix: "bmatrix",
      vmatrix: "dmatrix", cases: "cases",
      align: "eqalign", "align*": "eqalign", aligned: "eqalign",
    }
    const tok = ENV_TOKEN[env.value]
    if (tok) return { value: `{${tok}{${body}}}`, next: endIdx + endTag.length }
    // Bmatrix(중괄호 행렬) — 전용 토큰이 없어 LEFT {/RIGHT } 합성 (되읽기
    // \left\{\begin{matrix}…\end{matrix}\right\} — 렌더·내용 보존)
    if (env.value === "Bmatrix") {
      return { value: `LEFT { {matrix{${body}}} RIGHT }`, next: endIdx + endTag.length }
    }
    // 미지원 환경(vmatrix* 등) — 종전대로 래퍼만 벗기고 본문 보존
    return { value: body, next: endIdx + endTag.length }
  }

  if (command === "left" || command === "right") {
    const kw = command === "left" ? "LEFT" : "RIGHT"
    const cursor = skipSpaces(input, name.next)
    let delimiter = input[cursor] ?? ""
    let next = delimiter ? cursor + 1 : cursor
    if (delimiter === "\\") {
      // \{ \} \| 등 이스케이프 구분자 — 백슬래시 잔재 없이 원 문자만 (리뷰 #39 ·7).
      // "LEFT {"는 hmlToLatex replaceBracket이 \left \{ 로 복원하는 실파일 어휘.
      const escaped = readCommandName(input, cursor)
      delimiter = escaped.value === "\\" ? "\\" : (COMMAND_MAP[escaped.value] ?? escaped.value)
      next = escaped.next
    }
    return { value: delimiter ? `${kw} ${delimiter}` : kw, next }
  }

  if (command in ACCENT_COMMANDS) {
    const body = readGroupOrToken(input, name.next, depth)
    return { value: `${ACCENT_COMMANDS[command]}{${body.value}}`, next: body.next }
  }

  // LaTeX 공백 매크로 → EqEdit 공백 어휘 (리터럴 , ; : ! 로 주입되면 한글에 보이는
  // 구두점으로 렌더된다). `=1/4 공백, ~=공백. \!(음수 공백)는 EqEdit 대응 없어 제거.
  if (command === ",") return { value: "`", next: name.next }
  if (command === ";" || command === ":") return { value: "~", next: name.next }
  if (command === "!") return { value: "", next: name.next }

  if (command === "mathrm" || command === "text") {
    // 리터럴 텍스트 — 변환하지 않고 EqEdit 따옴표로 보호 (int가 ∫로 렌더 방지).
    // hmlToLatex는 단일 토큰 따옴표를 \text{...}로 되읽어 고정점이 된다.
    const start = skipSpaces(input, name.next)
    if (input[start] === "{") {
      const group = readBalanced(input, start, "{", "}")
      return { value: `"${group.value}"`, next: group.next }
    }
    const tok = readGroupOrToken(input, start, depth)
    return { value: `"${tok.value}"`, next: tok.next }
  }

  const mapped = COMMAND_MAP[command]
  if (mapped !== undefined) return { value: mapped, next: name.next }
  if (EQEDIT_FUNCTIONS.has(command)) return { value: command, next: name.next }
  // 미지원 명령 — 백슬래시만 벗긴 '맨 알파벳'은 EqEdit이 변수 나열(이탤릭 d·i·v)로
  // 렌더해 조용한 오염이 된다. 리터럴 따옴표로 보호해 손실을 가시화·안정화한다
  // (hmlToLatex가 "..."를 \text{...}로 되읽는 안정 어휘). 단일 문자(\, 구분자 등)는
  // 종전대로 통과 — 구조 어휘 훼손 방지.
  if (/^[A-Za-z]{2,}$/.test(command)) return { value: `"${command}"`, next: name.next }
  return { value: command, next: name.next }
}

function convertLatexFragment(input: string, depth: number): string {
  // 중괄호 폭탄 등 기형 입력 — 상한 초과 시 리터럴 폴백 (리뷰 #39 ·2)
  if (depth > MAX_GROUP_DEPTH) return normalizeEqEdit(input)

  let out = ""
  let idx = 0

  while (idx < input.length) {
    const ch = input[idx]
    if (ch === "\\") {
      const cmd = readCommand(input, idx, depth + 1)
      out += ` ${cmd.value} `
      idx = cmd.next
      continue
    }
    if (ch === "{") {
      const group = readBalanced(input, idx, "{", "}")
      out += `{${convertLatexFragment(group.value, depth + 1)}}`
      idx = group.next
      continue
    }
    if (ch === "_" || ch === "^") {
      const script = readGroupOrToken(input, idx + 1, depth)
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

/**
 * LaTeX 원문 단계에서 첨자/위첨자의 리터럴 예약어를 따옴표 보호.
 * 변환 전에만 적용 — 변환 산출물(\pi→pi 등)을 재따옴표하지 않기 위함 (리뷰 #39 ·8).
 */
export function quoteReservedKeywords(latex: string): string {
  return latex.replace(/([_^])\s*\{\s*([A-Za-z]+)\s*\}/g, (match, op: string, word: string) =>
    RESERVED_WORDS.has(word) ? `${op}{"${word}"}` : match)
}

export function latexLikeToEqEdit(input: string): string {
  const src = stripMathDelimiters(input)
  if (src.length > MAX_EQUATION_SOURCE) return normalizeEqEdit(src)
  return convertLatexFragment(quoteReservedKeywords(src), 0)
}

const EQ_BASE_UNIT = 1200

interface EquationMetrics {
  width: number
  height: number
  baseline: number
}

/** 상자 크기는 스크립트 구조로 잰다(equation-metrics) — baseUnit 1200 기준 HWPUNIT, 기준선은 높이 % */
function estimateEquationMetrics(script: string): EquationMetrics {
  const { w, a, d } = measureEquation(script)
  return {
    width: Math.min(Math.max(Math.round(w * EQ_BASE_UNIT), 200), 40000),
    height: Math.max(Math.round((a + d) * EQ_BASE_UNIT), 200),
    baseline: Math.round((100 * a) / (a + d)),
  }
}

/** eqId 기본값은 블록 수식(zOrder=블록 순번) 규약 — 인라인 수식(md-runs)은 따로 매긴 id 를 넘긴다 */
export function generateEquationXml(script: string, zOrder: number = 0, eqId: number = 2_000_000_001 + zOrder): string {
  const { width, height, baseline } = estimateEquationMetrics(script)

  return `<hp:equation id="${eqId}" zOrder="${zOrder}" numberingType="EQUATION" ` +
    `textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" ` +
    `version="Equation Version 60" baseLine="${baseline}" textColor="#000000" ` +
    `baseUnit="${EQ_BASE_UNIT}" lineMode="CHAR" font="HYhwpEQ">` +
    `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
    `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" ` +
    `vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
    `<hp:outMargin left="56" right="56" top="0" bottom="0"/>` +
    `<hp:shapeComment>수식입니다.</hp:shapeComment>` +
    `<hp:script>${escapeXml(script)}</hp:script>` +
    `</hp:equation>`
}

export function generateEquationParagraph(input: string, zOrder: number = 0): string {
  const script = latexLikeToEqEdit(input)
  // 다른 생성 문단과 같은 최소 셸 — lineseg/고정 id 없이 한컴 재계산에 맡긴다
  // (gen-table.ts 표 래핑과 동일 규약)
  return `<hp:p paraPrIDRef="${PARA_NORMAL}" styleIDRef="0">` +
    `<hp:run charPrIDRef="${CHAR_NORMAL}">${generateEquationXml(script, zOrder)}</hp:run></hp:p>`
}
