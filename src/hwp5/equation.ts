/**
 * HWP5 수식 레코드(EQEDIT) 스크립트 → LaTeX.
 *
 * HWP5의 EQEDIT 레코드도 HWPX <hp:script>와 같은 한컴 EqEdit 언어라
 * 구조 변환(분수·근호·행렬·액센트·토큰 매핑)은 hwpx/equation.ts(hmlToLatex)를
 * 정본으로 재사용한다. 이 모듈은 HWP5 실문서에서 관측되는 표기 편차
 * (소문자 예약어·붙여쓴 첨자·유니코드 연산자·글꼴 지시자)를 정본 토크나이저가
 * 인식할 수 있는 형태로 정규화하는 호환 프리패스만 담당한다.
 */

import { CONVERT_MAP, MIDDLE_CONVERT_MAP, hmlToLatex } from "../hwpx/equation.js"

/**
 * 정본 CONVERT_MAP에 (해당 표기로는) 없는 hwp5 지원 어휘 → LaTeX 직접 치환.
 * 키는 소문자 — 대소문자 무관 매칭(구 hwp5 동작 보존). 정본에 정확히 있는
 * 토큰(IN, GEQ, ALPHA 등)이 우선이라 여기까지 오지 않는다.
 */
const WORD_ALIASES: Record<string, string> = {
  // 삼각/로그 함수 — 정본 맵 부재
  sin: "\\sin", cos: "\\cos", tan: "\\tan", sec: "\\sec", csc: "\\csc", cot: "\\cot",
  log: "\\log", ln: "\\ln",
  // 연산자·관계 기호 (정본은 대문자 키만 보유)
  divide: "\\div", div: "\\div",
  le: "\\leq", ge: "\\geq", geq: "\\geq", deg: "^\\circ",
  rarrow: "\\rightarrow", lrarrow: "\\leftrightarrow",
  rightarrow: "\\rightarrow", leftarrow: "\\leftarrow",
  in: "\\in", notin: "\\notin", emptyset: "\\emptyset",
  subset: "\\subset", nsubset: "\\nsubseteq",
  cup: "\\cup", cap: "\\cap", smallinter: "\\cap", smallsum: "\\sum",
  sim: "\\sim", circ: "\\circ", bot: "\\perp",
  partial: "\\partial", nabla: "\\nabla",
  angle: "\\angle", triangle: "\\triangle",
  inf: "\\infty",
  left: "\\left", right: "\\right",
  // 글꼴 지시자 — 제거
  rm: "", it: "",
}

/** 구조 예약어 — hmlToLatex가 소문자만 인식하므로 대소문자 무관 입력을 접는다 */
const STRUCTURAL_FOLD = new Set(["over", "root", "of"])

/** 어절 단위 사전 정규화 — 정본 키 우선, 없으면 소문자 별칭/정본 키로 폴드 */
function normalizeWords(input: string): string {
  return input.replace(/(?<![\\A-Za-z0-9])([A-Za-z][A-Za-z0-9]*)(?![A-Za-z0-9])/g, word => {
    if (word in CONVERT_MAP || word in MIDDLE_CONVERT_MAP) return word
    const lower = word.toLowerCase()
    if (STRUCTURAL_FOLD.has(lower)) return lower
    if (lower in WORD_ALIASES) return WORD_ALIASES[lower]
    if (lower !== word && (lower in CONVERT_MAP || lower in MIDDLE_CONVERT_MAP)) return lower
    return word
  })
}

/** 첨자 정규화 — 공백 제거 후 미괄호 인자를 중괄호로 감싸고, 정본 토큰화용으로 분리 */
function normalizeScripts(input: string): string {
  return input
    .replace(/\s*\^\s*/g, "^")
    .replace(/\s*_\s*/g, "_")
    .replace(/\^(?!\{)([^\s{}_^]+)/g, "^{$1}")
    .replace(/_(?!\{)([^\s{}_^]+)/g, "_{$1}")
    // "sum_{k}"가 통짜 토큰으로 남지 않게 ^/_를 독립 토큰으로 분리 (LaTeX 의미 동일)
    .replace(/([_^])/g, " $1 ")
}

/** 붙여쓴/유니코드 연산자 → LaTeX (정본 토큰 맵은 공백 분리 토큰만 인식) */
function normalizeOperators(input: string): string {
  return input
    .replace(/\+-/g, " \\pm ")
    .replace(/-\+/g, " \\mp ")
    .replace(/\/\//g, " \\parallel ")
    .replace(/!=/g, " \\neq ")
    .replace(/<=/g, " \\leq ")
    .replace(/>=/g, " \\geq ")
    .replace(/==/g, " \\equiv ")
    .replace(/△/g, " \\triangle ")
    .replace(/□/g, " \\square ")
    .replace(/‧/g, " \\cdot ")
}

export function hwpEquationToLatex(equation: string): string {
  let s = equation.replace(/\0/g, "").replace(/\s+/g, " ").trim()
  if (!s) return ""

  s = normalizeScripts(s)
  s = normalizeOperators(s)
  s = normalizeWords(s)
  // 미괄호 근호 지수("root n of {x}") — 정본 replaceRootOf는 중괄호 그룹만 인식
  s = s.replace(/\broot\s+(?!\{)(\S+)\s+of(?![A-Za-z0-9])/gi, "root { $1 } of")

  return hmlToLatex(s).replace(/\s+/g, " ").trim()
}
