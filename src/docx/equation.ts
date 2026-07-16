/**
 * DOCX OMML (Office Math ML) → LaTeX
 *
 * OMML 루트 엘리먼트(`<m:oMath>`, `<m:oMathPara>`) 를 재귀적으로 훑어 LaTeX
 * 문자열을 생성한다. `<m:r>/<m:t>` 텍스트, 분수/근호/첨자/행렬/괄호/함수
 * /적분 등 실무에서 가장 흔한 OMML 18종 태그를 지원.
 *
 * 레퍼런스:
 *   - Microsoft OMML2MML.xsl (Office 공식 XSLT 매핑)
 *   - Pandoc texmath (Text.TeXMath.Readers.OMML)
 * 매핑 테이블은 CLAUDE plan `.claude/plans/auto-update-and-math.md` 참조.
 *
 * Entry points:
 *   - ommlElementToLatex(el)  — 하나의 <m:oMath> 또는 <m:oMathPara> 엘리먼트를
 *     LaTeX 로 변환 (delim 은 호출자가 씌움).
 *   - isOmmlRoot(el)         — 엘리먼트가 OMML 최상위인지 판별.
 */

/** localName 비교 — 네임스페이스 prefix 제거 */
function lname(el: Element): string {
  return el.localName || el.tagName?.replace(/^[^:]+:/, "") || ""
}

/** 자식 중 localName 매칭 엘리먼트들 (직계만) */
function kids(parent: Element, name: string): Element[] {
  const out: Element[] = []
  const nodes = parent.childNodes
  if (!nodes) return out
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (n.nodeType !== 1) continue
    const el = n as Element
    if (lname(el) === name) out.push(el)
  }
  return out
}

/** 직계 자식 첫 매칭 또는 null */
function firstKid(parent: Element, name: string): Element | null {
  const list = kids(parent, name)
  return list[0] ?? null
}

/** 자식 엘리먼트 순회 (직계만, Element only) */
function eachChild(parent: Element): Element[] {
  const out: Element[] = []
  const nodes = parent.childNodes
  if (!nodes) return out
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].nodeType === 1) out.push(nodes[i] as Element)
  }
  return out
}

/** <m:r> 내부 <m:t> 텍스트 집계. 특수 연산자에 백슬래시 매핑. */
function runToLatex(r: Element): string {
  let out = ""
  for (const t of kids(r, "t")) out += t.textContent ?? ""
  return out
}

/** 함수 이름(sin/cos/log/ln/exp/tan/…) → `\sin` 식 매핑 */
const FUNC_NAMES = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "sinh", "cosh", "tanh", "coth",
  "arcsin", "arccos", "arctan",
  "log", "ln", "lg", "exp",
  "det", "dim", "gcd", "inf", "sup", "lim", "max", "min",
  "Pr", "arg",
])

/** acc/char → LaTeX accent */
const ACCENT_MAP: Record<string, string> = {
  "̂": "\\hat",           // U+0302 COMBINING CIRCUMFLEX
  "̃": "\\tilde",         // U+0303
  "̄": "\\bar",           // U+0304
  "̇": "\\dot",           // U+0307
  "̈": "\\ddot",          // U+0308
  "́": "\\acute",         // U+0301
  "̀": "\\grave",         // U+0300
  "̆": "\\breve",         // U+0306
  "̌": "\\check",         // U+030C
  "⃗": "\\vec",           // U+20D7 COMBINING RIGHT ARROW ABOVE
  "→": "\\vec",
}

/** n-ary 연산자 (m:nary) chr → LaTeX */
const NARY_MAP: Record<string, string> = {
  "∑": "\\sum",
  "∏": "\\prod",
  "∐": "\\coprod",
  "∫": "\\int",
  "∬": "\\iint",
  "∭": "\\iiint",
  "∮": "\\oint",
  "∯": "\\oiint",
  "∰": "\\oiiint",
  "⋃": "\\bigcup",
  "⋂": "\\bigcap",
  "⨁": "\\bigoplus",
  "⨂": "\\bigotimes",
  "⨀": "\\bigodot",
}

/** OOXML on/off 값 — "0"/"false"/"off"는 false, 그 외(속성 생략 포함)는 true */
function onOffVal(v: string | null): boolean {
  return v !== "0" && v !== "false" && v !== "off"
}

/** 괄호 문자 → LaTeX (좌/우) */
function mapDelim(ch: string, isLeft: boolean): string {
  const l: Record<string, string> = {
    "(": "(", "[": "[", "{": "\\{", "⟨": "\\langle",
    "|": "|", "‖": "\\|", "⌊": "\\lfloor", "⌈": "\\lceil",
    "": ".",
  }
  const r: Record<string, string> = {
    ")": ")", "]": "]", "}": "\\}", "⟩": "\\rangle",
    "|": "|", "‖": "\\|", "⌋": "\\rfloor", "⌉": "\\rceil",
    "": ".",
  }
  const map = isLeft ? l : r
  return map[ch] ?? ch
}

/** 첫 `{`가 마지막 `}`와 밸런스 짝인지 — `{x}^{2}` 같은 다중 그룹 오판 방지 */
function isBalancedWrap(s: string): boolean {
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === "{" && s[i - 1] !== "\\") depth++
    else if (ch === "}" && s[i - 1] !== "\\") {
      depth--
      if (depth === 0) return i === s.length - 1
      if (depth < 0) return false
    }
  }
  return false
}

/** 내용이 단일 문자거나 단순 원자면 `{}` 없이, 아니면 감싸서 반환 */
function grp(body: string): string {
  const s = body.trim()
  if (s.length === 0) return "{}"
  // 이미 `{...}` 로 통짜 감싸진 경우만 그대로 (첫 `{`와 마지막 `}`가 짝일 때)
  if (s.startsWith("{") && s.endsWith("}") && isBalancedWrap(s)) return s
  return "{" + s + "}"
}

/** 엘리먼트 리스트를 연결한 LaTeX 문자열로 변환 */
function childrenToLatex(parent: Element): string {
  let out = ""
  for (const ch of eachChild(parent)) {
    out += nodeToLatex(ch)
  }
  return out
}

/** 노드(Element) 하나 → LaTeX */
function nodeToLatex(el: Element): string {
  const tag = lname(el)
  switch (tag) {
    case "r": return runToLatex(el)

    case "e":  // generic container (인자로 쓰임) — 자식 연결
    case "num":
    case "den":
    case "sub":
    case "sup":
    case "deg":
    case "lim":
    case "fName":
      return childrenToLatex(el)

    // 분수
    case "f": {
      const n = firstKid(el, "num")
      const d = firstKid(el, "den")
      const num = n ? childrenToLatex(n) : ""
      const den = d ? childrenToLatex(d) : ""
      return "\\frac" + grp(num) + grp(den)
    }

    // 첨자
    case "sSup": {
      const e = firstKid(el, "e")
      const sup = firstKid(el, "sup")
      return grp(e ? childrenToLatex(e) : "") + "^" + grp(sup ? childrenToLatex(sup) : "")
    }
    case "sSub": {
      const e = firstKid(el, "e")
      const sub = firstKid(el, "sub")
      return grp(e ? childrenToLatex(e) : "") + "_" + grp(sub ? childrenToLatex(sub) : "")
    }
    case "sSubSup": {
      const e = firstKid(el, "e")
      const sub = firstKid(el, "sub")
      const sup = firstKid(el, "sup")
      return grp(e ? childrenToLatex(e) : "") +
        "_" + grp(sub ? childrenToLatex(sub) : "") +
        "^" + grp(sup ? childrenToLatex(sup) : "")
    }
    case "sPre": {
      // pre-superscript/subscript
      const sub = firstKid(el, "sub")
      const sup = firstKid(el, "sup")
      const e = firstKid(el, "e")
      const preSub = sub ? grp(childrenToLatex(sub)) : "{}"
      const preSup = sup ? grp(childrenToLatex(sup)) : "{}"
      const body = e ? childrenToLatex(e) : ""
      return "{}_" + preSub + "^" + preSup + grp(body)
    }

    // 근호
    case "rad": {
      const deg = firstKid(el, "deg")
      const e = firstKid(el, "e")
      const body = e ? childrenToLatex(e) : ""
      // degHide 속성이 있으면 degree 생략
      const radPr = firstKid(el, "radPr")
      let hide = false
      if (radPr) {
        const degHide = firstKid(radPr, "degHide")
        if (degHide) {
          const val = degHide.getAttribute("m:val") ?? degHide.getAttribute("val")
          hide = val === "1" || val === "on" || val === "true"
        }
      }
      const degStr = (!hide && deg) ? childrenToLatex(deg).trim() : ""
      return degStr ? "\\sqrt[" + degStr + "]" + grp(body) : "\\sqrt" + grp(body)
    }

    // n-ary 연산자 (sum, prod, int, …)
    case "nary": {
      const naryPr = firstKid(el, "naryPr")
      let op = "\\int"
      let subHide = false
      let supHide = false
      let limLoc = ""
      if (naryPr) {
        const chr = firstKid(naryPr, "chr")
        if (chr) {
          const v = chr.getAttribute("m:val") ?? chr.getAttribute("val") ?? ""
          if (v && NARY_MAP[v]) op = NARY_MAP[v]
          else if (v) op = v
        } else {
          // chr 생략 시 기본값은 integral (OMML 스펙)
          op = "\\int"
        }
        const sh = firstKid(naryPr, "subHide")
        const ph = firstKid(naryPr, "supHide")
        if (sh) subHide = onOffVal(sh.getAttribute("m:val") ?? sh.getAttribute("val"))
        if (ph) supHide = onOffVal(ph.getAttribute("m:val") ?? ph.getAttribute("val"))
        const ll = firstKid(naryPr, "limLoc")
        if (ll) limLoc = ll.getAttribute("m:val") ?? ll.getAttribute("val") ?? ""
      }
      const sub = firstKid(el, "sub")
      const sup = firstKid(el, "sup")
      const e = firstKid(el, "e")
      const subStr = (!subHide && sub) ? childrenToLatex(sub) : ""
      const supStr = (!supHide && sup) ? childrenToLatex(sup) : ""
      const body = e ? childrenToLatex(e) : ""

      let head = op
      if (limLoc === "undOvr") {
        // limit 위치를 연산자 아래/위 (sum/prod 기본)
        if (subStr) head += "_" + grp(subStr)
        if (supStr) head += "^" + grp(supStr)
      } else {
        if (subStr) head += "_" + grp(subStr)
        if (supStr) head += "^" + grp(supStr)
      }
      return head + " " + body
    }

    // 괄호 (delimiter)
    case "d": {
      const dPr = firstKid(el, "dPr")
      let beg = "("
      let end = ")"
      let sep = ","
      if (dPr) {
        const begChr = firstKid(dPr, "begChr")
        const endChr = firstKid(dPr, "endChr")
        const sepChr = firstKid(dPr, "sepChr")
        if (begChr) beg = begChr.getAttribute("m:val") ?? begChr.getAttribute("val") ?? beg
        if (endChr) end = endChr.getAttribute("m:val") ?? endChr.getAttribute("val") ?? end
        if (sepChr) sep = sepChr.getAttribute("m:val") ?? sepChr.getAttribute("val") ?? sep
      }
      const items = kids(el, "e").map(childrenToLatex)
      const body = items.join(sep)
      return "\\left" + mapDelim(beg, true) + body + "\\right" + mapDelim(end, false)
    }

    // 행렬
    case "m": {
      const rows: string[] = []
      for (const mr of kids(el, "mr")) {
        const cells = kids(mr, "e").map(childrenToLatex)
        rows.push(cells.join(" & "))
      }
      return "\\begin{matrix}" + rows.join(" \\\\ ") + "\\end{matrix}"
    }

    // 상자/박스 (acc 와 유사하지만 bar 가 아닌 box)
    case "box":
      return childrenToLatex(el)

    // 함수 적용 (sin, cos, log …)
    case "func": {
      const fn = firstKid(el, "fName")
      const e = firstKid(el, "e")
      const fnStr = fn ? childrenToLatex(fn).trim() : ""
      const body = e ? childrenToLatex(e) : ""
      const fnLatex = FUNC_NAMES.has(fnStr) ? "\\" + fnStr : fnStr
      return fnLatex + grp(body)
    }

    // 악센트 (hat/bar/vec/…)
    case "acc": {
      const accPr = firstKid(el, "accPr")
      let chr = ""
      if (accPr) {
        const chrEl = firstKid(accPr, "chr")
        if (chrEl) chr = chrEl.getAttribute("m:val") ?? chrEl.getAttribute("val") ?? ""
      }
      // default accent = U+0302 (circumflex)
      if (!chr) chr = "̂"
      const e = firstKid(el, "e")
      const body = e ? childrenToLatex(e) : ""
      const cmd = ACCENT_MAP[chr] ?? "\\hat"
      return cmd + grp(body)
    }

    // bar (위/아래 줄)
    case "bar": {
      const barPr = firstKid(el, "barPr")
      let pos = "top"
      if (barPr) {
        const posEl = firstKid(barPr, "pos")
        if (posEl) pos = posEl.getAttribute("m:val") ?? posEl.getAttribute("val") ?? pos
      }
      const e = firstKid(el, "e")
      const body = e ? childrenToLatex(e) : ""
      return (pos === "bot" ? "\\underline" : "\\overline") + grp(body)
    }

    // lim 위/아래
    case "limLow": {
      const e = firstKid(el, "e")
      const lim = firstKid(el, "lim")
      const base = e ? childrenToLatex(e).trim() : ""
      const below = lim ? childrenToLatex(lim) : ""
      // 만약 base 가 "lim"/"max"/"min" 이면 \lim_{...} 식으로
      if (FUNC_NAMES.has(base)) return "\\" + base + "_" + grp(below)
      return base + "_" + grp(below)
    }
    case "limUpp": {
      const e = firstKid(el, "e")
      const lim = firstKid(el, "lim")
      const base = e ? childrenToLatex(e).trim() : ""
      const above = lim ? childrenToLatex(lim) : ""
      if (FUNC_NAMES.has(base)) return "\\" + base + "^" + grp(above)
      return base + "^" + grp(above)
    }

    // group character (over/underset 비슷)
    case "groupChr":
      return childrenToLatex(firstKid(el, "e") ?? el)

    // box/borderBox/phantom/eqArr/… 는 자식 본문만 유지
    case "borderBox":
    case "phant":
    case "eqArr":
      return childrenToLatex(el)

    // 최상위 컨테이너
    case "oMath":
    case "oMathPara":
      return childrenToLatex(el)

    // 메타 — 속성만 들어있으므로 출력 제외
    case "rPr":
    case "fPr":
    case "sSubPr":
    case "sSupPr":
    case "sSubSupPr":
    case "radPr":
    case "naryPr":
    case "dPr":
    case "accPr":
    case "barPr":
    case "funcPr":
    case "mPr":
    case "ctrlPr":
      return ""

    default:
      // 자식 연결로 폴백 (모르면 재귀)
      return childrenToLatex(el)
  }
}

/** 최상위 OMML 엘리먼트인지 */
export function isOmmlRoot(el: Element): boolean {
  const t = lname(el)
  return t === "oMath" || t === "oMathPara"
}

/**
 * OMML 엘리먼트(`<m:oMath>` 또는 `<m:oMathPara>`) 를 LaTeX 로 변환.
 * 공백은 정규화(중복 제거 + trim)만 하고 delim($/$$)은 호출자가 추가.
 */
export function ommlElementToLatex(el: Element): string {
  if (!isOmmlRoot(el)) return ""
  const raw = childrenToLatex(el)
  return raw.replace(/\s+/g, " ").trim()
}

/** `<m:oMathPara>` 는 display mode */
export function isDisplayMath(el: Element): boolean {
  return lname(el) === "oMathPara"
}
