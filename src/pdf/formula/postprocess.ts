/**
 * LaTeX 후처리 — Pix2Text `latex_ocr.py` 의 post_process 간소화 + 자체 필터
 *
 * 1) 후행 whitespace command 제거 (\, \: \; \! \quad \qquad \enspace \thinspace \ )
 * 2) 연속 공백 → 1개
 * 3) 빈 그룹 반복 제거 (^{} _{} \hat{} \bar{} \vec{} 등)
 * 4) \cmd 뒤 영문자 공백 분리 (\cdotd → \cdot d, \timesd → \times d)
 * 5) isTrivialFormula — 다이어그램 단일 글자/반복/장식 오탐 제거
 * 6) 짝 없는 \left·\right 제거 (Pix2Text fix_latex) — 남으면 KaTeX 등이 수식 전체를 못 그린다
 * 7) 막대 둘 노름 ||x|| → \|x\|
 */

const TRAILING_WHITESPACE_CMDS = [
  "\\,",
  "\\:",
  "\\;",
  "\\!",
  "\\ ",
  "\\quad",
  "\\qquad",
  "\\enspace",
  "\\thinspace",
] as const

export function postProcessLatex(latex: string): string {
  let s = stripTrailingWhitespace(latex)
  s = collapseSpaces(s)
  for (let i = 0; i < 10; i++) {
    const next = stripEmptyGroups(s)
    if (next === s) break
    s = next
  }
  s = stripUnpairedLeftRight(s)
  s = fixLatexSpacing(s)
  s = normalizeFormulaSpacing(s)
  // 디코더 원문은 토큰 사이가 띄어져 있다("| | a | |") — 공백을 정리한 뒤에
  s = doubleBarNorms(s)
  s = s.trim()
  // 길이 한도에서 잘린 인식 결과는 홑 역슬래시로 끝나기도 한다(…\tau} 뒤에 \ 하나) — 감싼 "$$" 의 "$" 를 이스케이프해 수식 스팬이
  // 닫히지 않고 식 전체가 마크다운 이스케이프됐다(U_{h} 가 U\_{h}). 짝 없는 끝 역슬래시는 LaTeX 로도 무효라 뗀다
  if ((s.match(/\\+$/)?.[0].length ?? 0) % 2) s = s.slice(0, -1).trimEnd()
  // trivial 이면 빈 문자열 반환 — 상위(pipeline/parser) 에서 latex.trim() 비었을 때 skip.
  if (isTrivialFormula(s)) return ""
  return s
}

/**
 * 노름 이중 막대 — 인식기는 `\|x\|` 를 막대 둘 `||x||` 로도 낸다(수식 정답지 30번). 안에 막대가 없는 `||…||` 짝만 `\|…\|` 로 —
 * 절댓값 곱 `|a||b|` 는 `||` 가 하나뿐이라 그대로
 */
export function doubleBarNorms(s: string): string {
  return s.replace(/(?<![\\|])\|\|([^|]+?)(?<!\\)\|\|(?!\|)/g, "\\|$1\\|")
}

/**
 * 짝 없는 `\left`·`\right` 를 떼고 구분자만 남긴다 — `\left( a + b` → `( a + b`. 짝은 중첩 순서(스택)로 찾는다.
 * `\leftarrow`·`\rightarrow` 는 명령이 다르므로 건드리지 않는다
 */
export function stripUnpairedLeftRight(s: string): string {
  const open: number[] = []
  const drop = new Set<number>()
  for (const m of s.matchAll(/\\(left|right)(?![A-Za-z])/g)) {
    if (m[1] === "left") open.push(m.index)
    else if (open.length) open.pop()
    else drop.add(m.index)
  }
  for (const i of open) drop.add(i)
  if (drop.size === 0) return s
  let out = ""
  let at = 0
  for (const i of [...drop].sort((a, b) => a - b)) {
    out += s.slice(at, i)
    at = i + (s.startsWith("\\left", i) ? 5 : 6)
  }
  return out + s.slice(at)
}

export function stripTrailingWhitespace(s: string): string {
  let t = s
  // 바깥 loop: 한 번 제거 후 다시 체크 (중첩 "\\, \\quad" 같은 경우)
  for (;;) {
    const trimmed = t.replace(/[\s]+$/, "")
    let changed = false
    for (const p of TRAILING_WHITESPACE_CMDS) {
      if (trimmed.endsWith(p)) {
        t = trimmed.slice(0, trimmed.length - p.length)
        changed = true
        break
      }
    }
    if (!changed) return trimmed
  }
}

export function collapseSpaces(s: string): string {
  let out = ""
  let prevSpace = false
  for (const c of s) {
    if (/\s/.test(c)) {
      if (!prevSpace) {
        out += " "
        prevSpace = true
      }
    } else {
      out += c
      prevSpace = false
    }
  }
  return out
}

/**
 * 빈 그룹 `{}` 또는 `{\s+}` 를 찾아 선행하는 `^`, `_`, 또는 `\cmd` 와 함께 제거.
 */
export function stripEmptyGroups(s: string): string {
  let out = ""
  let i = 0
  const bytes = s
  while (i < bytes.length) {
    const ch = bytes[i]
    if (ch === "{") {
      // 빈 { \s* } 스캔
      let j = i + 1
      while (j < bytes.length && /\s/.test(bytes[j])) j++
      if (j < bytes.length && bytes[j] === "}") {
        // 앞쪽 공백 제거
        while (out.endsWith(" ") || out.endsWith("\t")) {
          out = out.slice(0, -1)
        }
        if (out.endsWith("^") || out.endsWith("_")) {
          out = out.slice(0, -1)
        } else {
          // \cmd 형태인지 탐색
          let k = out.length
          while (k > 0 && /[A-Za-z]/.test(out[k - 1])) k--
          if (k > 0 && out[k - 1] === "\\" && k < out.length) {
            out = out.slice(0, k - 1)
          }
          // 아니면 아무것도 안 함 — 빈 {} 만 제거
        }
        i = j + 1
        continue
      }
    }
    out += ch
    i++
  }
  return out
}

/**
 * LaTeX 명령어 화이트리스트 — 공백 누락 감지에 사용.
 * MFR 이 `\cdot d` 를 `\cdotd` 로 합쳐 출력할 때, 어느 지점에서 명령어가 끝나는지
 * 알려진 커맨드명으로 판단한다. 완전한 리스트는 아니며 OCR 에서 실제 관찰된 케이스 중심.
 */
const KNOWN_LATEX_CMDS: ReadonlySet<string> = new Set([
  // 연산자
  "cdot", "cdots", "ldots", "dots", "vdots", "ddots",
  "times", "div", "pm", "mp", "ast", "star", "circ", "bullet",
  "oplus", "ominus", "otimes", "odot",
  // 관계
  "approx", "equiv", "neq", "ne", "sim", "simeq", "cong",
  "leq", "geq", "le", "ge", "ll", "gg", "prec", "succ", "preceq", "succeq",
  "propto", "parallel", "perp",
  // 집합/논리
  "in", "notin", "ni", "subset", "supset", "subseteq", "supseteq",
  "cap", "cup", "bigcap", "bigcup", "emptyset", "varnothing",
  "forall", "exists", "nexists", "neg", "lnot", "land", "lor", "vee", "wedge",
  // 그리스 소문자
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon",
  "zeta", "eta", "theta", "vartheta", "iota", "kappa", "lambda",
  "mu", "nu", "xi", "omicron", "pi", "varpi", "rho", "varrho",
  "sigma", "varsigma", "tau", "upsilon", "phi", "varphi",
  "chi", "psi", "omega",
  // 그리스 대문자
  "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma",
  "Upsilon", "Phi", "Psi", "Omega",
  // 화살표
  "to", "gets", "mapsto", "rightarrow", "leftarrow", "leftrightarrow",
  "Rightarrow", "Leftarrow", "Leftrightarrow", "uparrow", "downarrow",
  "longrightarrow", "longleftarrow", "longmapsto",
  // 큰 연산자
  "sum", "prod", "coprod", "int", "iint", "iiint", "oint", "bigoplus", "bigotimes",
  // 함수명
  "sin", "cos", "tan", "sec", "csc", "cot",
  "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh",
  "log", "ln", "lg", "exp", "lim", "liminf", "limsup",
  "sup", "inf", "max", "min", "arg", "det", "dim", "gcd", "deg", "hom", "ker", "mod",
  // 특수 기호/수식
  "infty", "partial", "nabla", "prime", "aleph", "ell", "hbar", "Re", "Im",
  "top", "bot", "angle", "vdash", "dashv",
  // 기타
  "left", "right", "big", "Big", "bigg", "Bigg",
  // 크기 붙은 괄호·나머지 — 아는 접두(\Big·\pm) 뒤 한두 글자라 아래 분리 규칙에 걸린다
  "bigl", "bigr", "Bigl", "Bigr", "biggl", "biggr", "Biggl", "Biggr", "pmod", "bmod",
])

/**
 * `\cmd` 뒤에 영문자가 바로 붙으면 공백 분리 (e.g. `\cdotd` → `\cdot d`, `\timesd_{k}` → `\times d_{k}`).
 *
 * MFR 이 좁은 영역에서 가끔 `\cdot` 과 다음 변수 사이 공백을 누락. 그대로 두면 LaTeX 파서가
 * `\cdotd` 를 undefined command 로 처리 (KaTeX: 에러 / TeX: 정의되지 않은 제어 시퀀스).
 * 알려진 LaTeX 명령어 prefix 중 가장 긴 것을 찾아 분할하면 렌더 안정성 확보.
 *
 * `\cmd{..}` (영문자 뒤 `{`) 는 인자 포함 형태로 간주해 분리하지 않음.
 */
export function fixLatexSpacing(s: string): string {
  let out = ""
  let i = 0
  while (i < s.length) {
    if (s[i] === "\\" && i + 1 < s.length && /[A-Za-z]/.test(s[i + 1])) {
      // \cmd 최장일치
      let j = i + 1
      while (j < s.length && /[A-Za-z]/.test(s[j])) j++
      const full = s.slice(i + 1, j) // 명령어 이름 (앞 \ 제거)
      const nextChar = j < s.length ? s[j] : ""

      // \cmd{..} 형태 — 인자로 이어지므로 분리하지 않음
      if (nextChar === "{") {
        out += "\\" + full
        i = j
        continue
      }

      // 자체가 알려진 명령어이거나, 긴 prefix 가 없으면 그대로
      let splitAt = full.length
      if (!KNOWN_LATEX_CMDS.has(full) && full.length >= 3) {
        // 뒤에서부터 prefix 길이를 줄이며 가장 긴 known cmd 찾기
        for (let len = full.length - 1; len >= 2; len--) {
          if (KNOWN_LATEX_CMDS.has(full.slice(0, len))) {
            splitAt = len
            break
          }
        }
      }

      // 붙은 꼬리가 두 글자 넘으면 목록에 없는 정식 명령이다(\lesssim → \le sssim, \leqslant → \leq slant 가 되던 것 — arXiv 수식 정답 대조).
      // MFR 이 공백을 빠뜨리는 자리는 변수 한두 글자다(\cdotd·\timesdx)
      if (full.length - splitAt > 2) splitAt = full.length
      out += "\\" + full.slice(0, splitAt)
      if (splitAt < full.length) {
        out += " " + full.slice(splitAt)
      }
      i = j
    } else {
      out += s[i]
      i++
    }
  }
  return out
}

/**
 * trivial(noise) 수식 판정.
 *
 * true 인 케이스 (MFD 오탐 주범):
 *   1) 공백/중괄호 제거 후 2자 이하 (e.g. `O`, `a`, `.`, `n`)
 *   2) 단일 `\cmd` (e.g. `\imath`, `\pi`, `\eta`, `\sigma`, `\theta`, `\emptyset`, `\varPi`)
 *   3) 단일 `\mathrm{..}` / `\textrm{..}` / `\operatorname{..}` 류 + 짧은 내용 (e.g. `\mathrm{fcloc}`)
 *   4) 동일 토큰이 3회 이상 + 전체의 50% 이상 (e.g. `\pm \pm \pm \pm`, `\cap \exists \exists \rceil`)
 *
 * false 유지 (의미 있는 수식):
 *   `O(1)`, `d_{k}=64`, `\sqrt{d_{k}}`, `PE_{pos+k}`, 등
 */
export function isTrivialFormula(s: string): boolean {
  const t = s.trim()
  if (t.length === 0) return true

  // 1) 공백/중괄호 제거 후 길이 ≤ 2
  const stripped = t.replace(/[\s{}]/g, "")
  if (stripped.length <= 2) return true

  // 2) 단일 \cmd (e.g. \imath, \varPi, \pi)
  if (/^\\[A-Za-z]+$/.test(t)) return true

  // 3) 단일 \mathrm{..} / \textrm{..} / \operatorname{..} / \mathit{..} / \mathbf{..} / \mathcal{..} + 짧은 내용
  if (
    /^\\(?:mathrm|textrm|text|operatorname|mathit|mathbf|mathcal|mathsf|mathtt)\{[A-Za-z]{1,6}\}$/.test(
      t,
    )
  )
    return true

  const tokens = tokenizeLatex(t)

  // 4) 반복 토큰 dominant (e.g. "\\pm \\pm \\pm \\pm")
  if (tokens.length >= 3) {
    const freq = new Map<string, number>()
    for (const tok of tokens) freq.set(tok, (freq.get(tok) ?? 0) + 1)
    let maxCount = 0
    for (const c of freq.values()) if (c > maxCount) maxCount = c
    if (maxCount >= 3 && maxCount / tokens.length >= 0.5) return true
  }

  // 5) 심볼만 구성된 짧은 식 — 토큰 2~4개이고 연산자/숫자 없음 (e.g. "\\cap \\exists \\exists \\rceil")
  //    의미 있는 수식은 대개 `=` 또는 숫자가 포함됨. 허용되는 연산자: = + - / * < > 숫자
  if (tokens.length >= 2 && tokens.length <= 4) {
    const hasOpOrNum = tokens.some((tok) =>
      /^[=+\-/*<>]$/.test(tok) || /^[0-9]$/.test(tok),
    )
    if (!hasOpOrNum) return true
  }

  // 6) substring 반복 패턴 — 동일 5~15자 substring 이 3회 이상 + 커버리지 60%+
  //    (e.g. "\\alpha_{1}=\\alpha_{2}=\\alpha_{3}=..." 의 `\\alpha_{` 반복,
  //           "c_{c}^{\\prime}\\phi_{c}^{\\prime}=c_{c}^{\\prime}..." 의 `c_{c}^{\\prime}` 반복)
  //    첨자를 지운 뒤에도 되풀이가 남아야 한다 — 같은 첨자를 단 정상 식(`S=\sum_{\ell,m}S_{\ell,m}Y_{\ell,m}`)이 `_{\ell,m}`
  //    되풀이로 버려졌다. 고리 쓰레기(`\alpha_{4}=\alpha_{4}=…`)는 첨자 밖 글까지 되풀이한다
  if (hasHighRepetition(t) && hasHighRepetition(t.replace(/([_^])\{[^{}]*\}/g, "$1"))) return true

  // 7) MFR placeholder 인 `\square` 포함 — 인식 실패 영역을 `\square` 로 대체하는 특성
  //    정당한 수식에 `\square` 가 나오는 경우는 거의 없음 (대부분 `\Box`, `\blacksquare` 등 사용)
  if (t.includes("\\square")) return true

  // 8) 단독 숫자/실수 (e.g. "$1.0$", "$42$", "$-3.14$")
  //    공백/중괄호/백슬래시 제거 후 순수 숫자/부호/소수점만 남으면 trivial
  if (/^[-+]?\d+\.?\d*$/.test(t.replace(/[\s{}\\]/g, ""))) return true

  // 9) `(X)(X)` 또는 `{X}{X}` 연속 중복 — 동일 그룹 반복 (e.g. "$C(T_{2})(T_{2})$")
  //    한 단계 중첩 허용: `{k_{c}}` 같이 내부에 `{...}` 하나 포함 가능.
  if (/(\([^()]{2,15}\))\s*\1/.test(t)) return true
  if (/(\{(?:[^{}]|\{[^{}]*\})+\})\s*\1/.test(t)) return true

  // 10) 동일 인자 반복 — 괄호 인자 중 쉼표 구분 3개 중 2개 이상 동일 (e.g. `C(\tau_{2},\mu^{\prime},\mu^{\prime})`)
  //     완전 일치 인자가 2회+ 반복이면 OCR 반복 오류로 간주
  const argMatch = t.match(/^[A-Za-z\\][A-Za-z]*\(([^()]+)\)$/)
  if (argMatch) {
    const args = argMatch[1].split(",").map((a) => a.trim())
    if (args.length >= 2) {
      const freq = new Map<string, number>()
      for (const a of args) if (a) freq.set(a, (freq.get(a) ?? 0) + 1)
      for (const [, c] of freq) {
        if (c >= 2 && c / args.length >= 0.5) return true
      }
    }
  }

  // 11) X/X 또는 \frac{X}{X} — 분자=분모 = 1, 의미 없는 수식
  //     수식 **어디에나** 나타나면 trivial (e.g. "$k<\\frac{\\eta}{\\eta}$" 도 포함)
  //     정당한 수식에서 $\\frac{a}{a}$ 를 쓰는 경우는 거의 없음 (대수적으로 1).
  if (/\\frac\{([^{}]+)\}\{\1\}/.test(t)) return true
  // X/X 꼴 (단일 변수 또는 \cmd)
  if (/(\\[A-Za-z]+|\b[A-Za-z])\s*\/\s*\1\b/.test(t)) return true

  // 12) `\begin{matrix}` 내부 `\cdots` 여러 번 — MFR 이 다이어그램/표를 matrix 로 오인식
  //     본문 수식의 matrix 는 구체적 원소가 있어 `\cdots` 가 2회 이상 나오는 경우 거의 없음
  if (/\\begin\{(?:matrix|pmatrix|bmatrix|vmatrix)\}/.test(t)) {
    const cdotsCount = (t.match(/\\cdots/g) ?? []).length
    if (cdotsCount >= 2) return true
  }

  // 13) 다이어그램 텍스트 레이블 — `\mathrm{word}` 가 2회+ 포함된 짧은 식 (토큰 수 ≤ 12)
  //     또는 `[a-z]{1,3}_\{\mathrm{word}\}` 꼴의 비정상 변수명 (e.g. `cl_{\mathrm{model}}`)
  if (tokens.length <= 12) {
    const mathrmCount = (t.match(/\\mathrm\{/g) ?? []).length
    if (mathrmCount >= 2) {
      // 연산자/등호/숫자가 거의 없어 "단순 레이블" 로 보이는지 추가 확인
      const hasRealMath = /[=+\-*/<>^]/.test(t) && /\d/.test(t)
      if (!hasRealMath) return true
    }
  }
  // 비정상 변수명: 2-3자 영문 접두 + _{\mathrm{긴단어}} 단독 (e.g. `cl_{\mathrm{model}}`, `to_{\mathrm{max}}`)
  // 정상 변수명은 보통 단일 문자 (`d_{\mathrm{model}}`, `W_{i}`) — 2자 이상이면 다이어그램 오인식
  if (/^[a-zA-Z]{2,3}_\{\\mathrm\{[a-zA-Z]{3,}\}\}$/.test(t)) return true

  // 14) `\mathrm{word}` + 이항 연산자 + single 요소 꼴 — 다이어그램 "word → value" 레이블
  //     (e.g. `\mathrm{to}-\infty`, `\mathrm{to}+\infty`)
  if (/^\\mathrm\{[a-z]{2,}\}[-+][-+]?(?:\\[a-zA-Z]+|[a-zA-Z0-9])$/.test(t)) return true

  // 15) `\mathsf`, `\mathtt`, `\texttt` 는 본문 수식에 거의 쓰이지 않고 다이어그램 타이포그래피 오인식이 대부분
  //     — 포함만으로 trivial (e.g. `\mathtt{Welgnt}`, `\mathsf{Tr}_{s}`, `\texttt{wg}`)
  if (/\\(?:mathsf|mathtt|texttt)\{/.test(t)) return true

  // 16) `\begin{aligned}` 이지만 관계 기호 없음 — 정당한 aligned 는 줄마다 관계(=·≤·≲·≈ …)로 이어진다 (여러 줄 equation)
  //     관계 기호가 없으면 OCR garbage 조합. 등호만 보면 부등식 유도(`\leq`·`\lesssim` 로만 잇는 여러 줄 평가식)를 통째로 버렸다
  if (/\\begin\{aligned\}/.test(t) && !/[=<>]|\\(?:leq?|geq?|leqslant|geqslant|lesssim|gtrsim|ll|gg|approx|sim|simeq|cong|equiv|neq?|propto|triangleq|implies|iff|Longleftrightarrow)(?![A-Za-z])/.test(t)) return true

  // 17) `\begin{matrix}` + `\downarrow` 2회+ — 네트워크 architecture 다이어그램 오인식
  if (/\\begin\{matrix\}/.test(t) && (t.match(/\\downarrow/g) ?? []).length >= 2) return true

  return false
}

/**
 * substring 반복 탐지 — 동일한 N자 substring 이 3회 이상 나타나고
 * 그 반복 총 길이가 전체의 60% 이상이면 true.
 *
 * 5~15자 범위만 검사 (짧으면 정상 수식의 `^{2}` 같은 패턴도 걸림, 길면 노이즈 거의 없음).
 * 영문자 포함 substring 만 검사 (구두점만 반복은 정상 수식에도 많음).
 *
 * 정당한 수식은 다양한 구조로 거의 겹치지 않아 false-positive 낮음.
 */
export function hasHighRepetition(s: string): boolean {
  if (s.length < 15) return false

  for (let len = 5; len <= 15; len++) {
    // substring 길이 × 3회가 전체보다 길면 의미 없음
    if (len * 3 > s.length) break
    const seen = new Map<string, number>()
    for (let i = 0; i <= s.length - len; i++) {
      const sub = s.slice(i, i + len)
      if (!/[a-zA-Z]/.test(sub)) continue
      seen.set(sub, (seen.get(sub) ?? 0) + 1)
    }
    for (const [, count] of seen) {
      if (count < 3) continue
      // 겹치지 않는 점유율 추정: count*len (overlapping 포함이라 약간 과대)
      // 보수적 판정 위해 최소 3회 + 60% 커버리지
      if ((count * len) / s.length >= 0.6) return true
    }
  }
  return false
}

/**
 * LaTeX 를 단순 토큰 배열로 분할 — `\cmd` 는 하나의 토큰, 그 외는 non-space 단일 문자.
 * isTrivialFormula 의 반복 감지용.
 */
function tokenizeLatex(s: string): string[] {
  const result: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      let j = i + 1
      while (j < s.length && /[A-Za-z]/.test(s[j])) j++
      if (j === i + 1 && j < s.length) j++ // `\\` 또는 `\{` 같은 단일 escape
      result.push(s.slice(i, j))
      i = j
    } else if (/\s/.test(c)) {
      i++
    } else {
      result.push(c)
      i++
    }
  }
  return result
}

/**
 * MFR tokenizer 가 LaTeX 토큰 사이에 삽입하는 과도한 공백을 정리.
 *
 * 예: `\mathrm { m o d d }` → `\mathrm{modd}`, `6 4` → `64`, `( Q, K, V )` → `(Q,K,V)`
 *
 * 규칙: 공백을 앞뒤 토큰 기준으로 유지/제거 결정.
 *   - 직전이 `\cmd` 이고 직후가 영문자 → **유지** (e.g. `\cdot d`, `\alpha b` — 공백 없으면 greedy 로 `\cdotd` 가 명령어로 해석될 수 있음)
 *   - 그 외 → **제거** (숫자/괄호/중괄호/첨자/구두점 주변 공백은 LaTeX 의미를 바꾸지 않음)
 *
 * `fixLatexSpacing` 이후에 호출되는 것을 전제 — 먼저 공백 누락을 복원한 뒤 과도한 공백을 걷어냄.
 */
export function normalizeFormulaSpacing(s: string): string {
  // `\cmd`, 단일 escape, 공백, 일반 문자 단위로 토큰화 (공백도 토큰으로 유지)
  const tokens: string[] = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c === "\\") {
      let j = i + 1
      while (j < s.length && /[A-Za-z]/.test(s[j])) j++
      if (j === i + 1 && j < s.length) j++ // 단일 escape (`\\`, `\{` 등)
      tokens.push(s.slice(i, j))
      i = j
    } else if (/\s/.test(c)) {
      tokens.push(" ")
      i++
    } else {
      tokens.push(c)
      i++
    }
  }

  const out: string[] = []
  for (let k = 0; k < tokens.length; k++) {
    if (tokens[k] !== " ") {
      out.push(tokens[k])
      continue
    }
    // 공백 토큰 — 유지 여부 결정
    // 연속 공백은 나중에 병합 (아래 로직은 앞뒤 non-space 토큰 기준)
    let prev = ""
    for (let p = k - 1; p >= 0; p--) {
      if (tokens[p] !== " ") {
        prev = tokens[p]
        break
      }
    }
    let next = ""
    for (let q = k + 1; q < tokens.length; q++) {
      if (tokens[q] !== " ") {
        next = tokens[q]
        break
      }
    }
    const prevIsCmd = /^\\[A-Za-z]+$/.test(prev)
    const nextIsAlpha = /^[A-Za-z]$/.test(next)
    if (prevIsCmd && nextIsAlpha) {
      // 앞 cmd 와 뒤 변수 분리용 공백 (연속 공백이더라도 하나만 남김)
      if (out.length === 0 || out[out.length - 1] !== " ") {
        out.push(" ")
      }
    }
    // 그 외 공백은 drop
  }

  // 앞/뒤 공백 제거
  while (out.length > 0 && out[0] === " ") out.shift()
  while (out.length > 0 && out[out.length - 1] === " ") out.pop()

  return out.join("")
}

/**
 * 여러 줄 display 상자 안에 든 낮은 display 상자 — 검출기가 정렬식 전체와 그 안의 한 줄을 따로 잡으면(IoU 가 작아 NMS 를 지난다) 같은 줄이
 * 큰 식 안에 한 번, 짝 없는 조각으로 또 한 번 나왔다(arXiv 2609.15723 p31 "+\frac{4L_f^2…}" 줄). 면적 85% 이상이 다른 display 상자 안이고
 * 그 상자가 1.5 배 이상 높으면(여러 줄) 뺀다. 인식이 비어 버려진 상자 안의 것은 남긴다
 */
export function dropNestedDisplays<T extends { bbox: { x1: number; y1: number; x2: number; y2: number }; kind: string; latex: string }>(regions: T[]): T[] {
  const display = regions.filter(r => r.kind === "display" && r.latex.trim())
  const nested = (r: T) => display.some(o => {
    if (o === r || o.bbox.y2 - o.bbox.y1 < (r.bbox.y2 - r.bbox.y1) * 1.5) return false
    const w = Math.min(r.bbox.x2, o.bbox.x2) - Math.max(r.bbox.x1, o.bbox.x1)
    const h = Math.min(r.bbox.y2, o.bbox.y2) - Math.max(r.bbox.y1, o.bbox.y1)
    return w > 0 && h > 0 && w * h >= (r.bbox.x2 - r.bbox.x1) * (r.bbox.y2 - r.bbox.y1) * 0.85
  })
  return regions.filter(r => !(r.kind === "display" && r.latex.trim() && nested(r)))
}

/**
 * 여러 줄 display 식의 이어지는 줄 — 검출기가 정렬식("A = …" 다음 줄 "≤ …", "+ …")을 줄마다 상자로 잡으면 줄마다 따로 인식돼
 * 한 식이 조각으로 흩어졌다(arXiv 2609.15723: 놓친 식 48 중 47 이 여러 줄 식, 짝 없는 조각 90). 바로 위 display 상자와 세로로
 * 붙고(틈이 두 상자 중 낮은 높이 이하) 가로로 겹치며(좁은 쪽 폭의 절반 이상) 관계·연산 기호로 시작하는 조각은 위 식의 다음 줄로
 * 잇는다(aligned 줄바꿈). 기호로 시작하지 않는 줄과 "−" 로 시작하는 줄("−Ct² ≤ …" 따로 선 식, 2609.14837)은 그대로 둔다
 */
/** 바깥 \begin{aligned}…\end{aligned} 한 겹을 벗긴 식 (여러 줄 상자를 읽은 조각을 다른 식의 줄로 이을 때) */
function unwrapAligned(latex: string): string {
  const t = latex.trim()
  const m = /^\\begin\{aligned\}([\s\S]*)\\end\{aligned\}$/.exec(t)
  return m ? m[1].trim() : t
}

export function mergeContinuationLines<T extends { bbox: { x1: number; y1: number; x2: number; y2: number }; kind: string; latex: string }>(regions: T[]): T[] {
  const CONT = /^\s*(?:=|<|>|\+|\\(?:leq?|geq?|leqslant|geqslant|approx|sim|simeq|equiv|cdot|times|neq?|lesssim|gtrsim|propto|qquad|quad)(?![A-Za-z]))/
  const display = regions.filter(r => r.kind === "display" && r.latex.trim()).sort((a, b) => a.bbox.y1 - b.bbox.y1)
  const drop = new Set<T>()
  const merged = new Map<T, { bbox: T["bbox"]; lines: string[] }>()
  let head: T | null = null
  for (const r of display) {
    const h = head ? merged.get(head)! : null
    if (head && h) {
      const gap = r.bbox.y1 - h.bbox.y2
      const minH = Math.min(r.bbox.y2 - r.bbox.y1, head.bbox.y2 - head.bbox.y1)
      const overlap = Math.min(r.bbox.x2, h.bbox.x2) - Math.max(r.bbox.x1, h.bbox.x1)
      const narrow = Math.min(r.bbox.x2 - r.bbox.x1, h.bbox.x2 - h.bbox.x1)
      if (gap >= -minH * 0.3 && gap <= minH && overlap >= narrow * 0.5 && CONT.test(unwrapAligned(r.latex).replace(/^[\s{&]+/, ""))) {
        h.lines.push(unwrapAligned(r.latex))
        h.bbox = { x1: Math.min(h.bbox.x1, r.bbox.x1), y1: h.bbox.y1, x2: Math.max(h.bbox.x2, r.bbox.x2), y2: Math.max(h.bbox.y2, r.bbox.y2) }
        drop.add(r)
        continue
      }
    }
    head = r
    merged.set(r, { bbox: { ...r.bbox }, lines: [unwrapAligned(r.latex)] })
  }
  if (!drop.size) return regions
  return regions.filter(r => !drop.has(r)).map(r => {
    const m = merged.get(r)
    if (!m || m.lines.length < 2) return r
    return { ...r, bbox: m.bbox, latex: `\\begin{aligned}${m.lines.join(" \\\\ ")}\\end{aligned}` }
  })
}

