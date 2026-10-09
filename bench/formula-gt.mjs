// 수식 OCR 정답지 벤치 — arXiv 논문 LaTeX 원본에서 뽑은 display 수식을 정답으로 kordoc PDF 수식 OCR(formulaOcr)의 검출·인식을 잰다 (보고 전용, 게이트 아님).
//
// 모수: --dir(기본 bench/corpus-formula, gitignore)의 manifest.json · pdf/<id>.pdf · gt/<id>.json. gt 는 같은 판(version) PDF 의 원본에서 뽑은
//   {macros: {"\이름": 본문}, macro_args: {"\이름": {nargs, default?}}, equations: [{n, env, latex}]} — equations 는 display 수식 몸통, 문서 순서
//   (환경 목록·제거 규칙은 manifest.json conventions). manifest 기준 20편 621쪽 2,314식, CC-BY·CC0
// 예측: parse(pdf, { formulaOcr: true, ocr: false, pages }) 의 쪽별 마크다운(result.pages). 수식 OCR(MFD 검출 + MFR 인식, 모델은
//   ~/.cache/kordoc/models/pix2text — 없으면 첫 parse 가 받는다)은 검출 영역마다 문단을 하나씩 끼운다 — display 로 검출한 것은 "$$latex$$" 한 줄,
//   inline 으로 검출한 것도 문장 안이 아니라 따로 선 "$latex$" 문단이다. 채점은 $$…$$ 만 하고 $…$ 는 개수와 missAsInline 진단에만 쓴다
//
// 정규화 (양쪽 같음, 매크로 펼침만 정답 쪽) 뒤 토큰(\명령·\한 글자·{ }·그 밖 한 글자 — 숫자도 한 자리씩, 공백 무시)으로 비교한다
//   매크로: 0인자 매크로는 정답 latex 에 이미 펼쳐져 있다. 인자 매크로(macro_args)는 #1.. 을 치환해 펼친다(본문 안 매크로까지 6회)
//   버림: 간격(\, \; \: \! \␣ ~ \quad \qquad \hspace{} \kern…), 크기(\left \right \big… \middle 과 뒤 빈 구분자 "."), \displaystyle 류,
//         \limits, \nonumber \notag \label{} \tag{}, 정렬 기호 & 와 줄바꿈 \\(\\[2pt] 간격째), 글 상자 안 $ (\text{of $S_n$ is})
//   묶음: 인자가 아닌 { } 는 벗긴다(바깥 괄호 포함). 인자는 늘 { } 로 — \frac12 → \frac{1}{2}, x^\prime·x' → x^{\prime}, {\bf x} → \mathbf{x}.
//         첨자는 아래첨자 먼저(x^{a}_{b} → x_{b}^{a})
//   같은 글자 다른 표기(SYN·MULTI 표): \le→\leq \ne→\neq \to→\rightarrow \dots→\ldots \lVert·\Vert→\| \vert·\mid→| \lbrace→\{ \dfrac·\tfrac→\frac
//         \stackrel→\overset \widehat→\hat \widetilde→\tilde \coloneqq→:= \dd→d, 굵게 \bm·\boldsymbol·\pmb·\textbf→\mathbf,
//         로만 \text·\textrm·\mbox·\operatorname→\mathrm
//   글꼴: 로만·기울임(\mathrm·\mathit, {\rm …}) 감싸개는 버리고 글자만 남긴다 — 바로 섬·기울임은 채점하지 않는다(미분 \mathrm{d}x = dx,
//         전치 \mathrm{T} = T, 정답 \text{of $S_n$ is} = OCR \mathrm{of~S_n~is}). 함수 이름이면 명령으로(\mathrm{log} = \log). 굵게·\mathcal·\mathbb 는 남긴다
//   환경: pmatrix→( ) bmatrix→[ ] vmatrix→| | cases→\{ , aligned·split·array·gathered 류는 감싸개만 버린다(세로 자리 [t]·열 지정 {cc} 도)
//   이 규칙은 2609.14753·2609.14430 앞 3쪽의 OCR 출력을 보며 정했다 — 두 편의 수치는 채점기를 맞춘 표본이다
// 정렬: 예측 display 식열(쪽 순 → 쪽 안 블록 순)과 정답 식열(문서 순)을 단조 DP 로 맞춘다 — 양쪽 건너뛰기 허용, 짝 점수 (0.6 − NED) 합 최대.
//   NED > 0.6(MAX_NED)인 짝과 정답 식의 쪽(아래)에서 2쪽 이상 떨어진 예측과의 짝은 맺지 않는다. MFD 가 여러 줄 식을 줄마다 상자로 쪼개면
//   정답 토큰의 40% 에 못 미치는 조각은 NED 가 0.6 을 넘어 짝이 될 수 없다 — 그런 식은 못 찾은 식, 조각은 짝 없는 예측으로 남는다. 2단 조판은
//   쪽 안 열 순서가 섞여 단조 정렬이 짝을 놓칠 수 있다 — 이 20편은 모두 1단(scripts/layout.py)
// 정답 식의 쪽: 예측과 무관하게 pdftotext 텍스트층으로만 정한다 — 정규화 토큰의 영숫자(함수 이름 글자 포함) 3-gram 을 쪽마다 IDF 가중
//   적중률로 매기고, 식 순서 = 쪽 순서인 단조 경로 중 합이 가장 큰 것(쪽을 옮길 때마다 건너뛴 쪽 수와 무관하게 0.02 벌점 — 근거 없는 짧은
//   식은 앞 식 쪽에 남는다). --pages=N 이면 1..N 쪽으로 찾은 정답 식만 모수다. 경계에서는 한 쪽 밀릴 수 있다(분수가 텍스트층에 흩어진 식 —
//   2609.14430 (2.1)식은 3쪽인데 4쪽으로 찾는다). 그래서 N+1 쪽으로 찾은 식도 정렬에는 넣되 그 짝은 precision 에만 센다(boundaryMatches —
//   짝 여부로 모수를 고르면 OCR 출력이 자기 채점 모수를 정한다). 반대로 N+1 쪽 식을 N 쪽으로 찾으면 못 찾은 식이 돼 재현율이 조금 박하다.
//   pdftotext 가 없으면 쪽을 모른다(row.pageMapped false) — 쪽 제약 없이 정렬하고(missAsInline 의 이웃 쪽 검사도 없음), --pages 면 모수를
//   정렬 구간(마지막으로 짝 지은 정답 식까지)으로 줄여 scope 를 "aligned-span" 으로 남긴다. 이 모수는 구간 끝 뒤에서 놓친 식이 빠져 대개
//   후하고, 늦게 맺힌 잘못된 짝은 구간을 늘려 박하게 만들며, 짝이 하나도 없는 논문은 모수 0 이라 요약에서 빠진다
//
// 지표 (논문별 rows, 전체 summary 는 합산 micro)
//   gt / predDisplay / predInline / matched : 모수 정답 식 / 예측 $$…$$ / 예측 $…$ / 모수 안 짝
//   recall    : matched / gt          recall03 : NED ≤ 0.3 짝 / gt        exactRate : 정규화 토큰열이 같은 짝 / gt
//   meanNED   : 짝 평균 토큰 NED(편집 거리 / 긴 쪽 토큰 수) — 검출된 식의 인식 품질. 짝만의 평균이라 인식이 나빠져 짝이 빠지면 오히려 좋아진다
//   nedAll    : 못 찾은 정답 식을 NED 1 로 넣은 평균 — 검출·인식을 한 수로
//   bleu4     : 짝 말뭉치 BLEU-4 (토큰, 평활 없음 — 4-gram 적중이 하나도 없으면 0)
//   precision : (matched + boundaryMatches) / predDisplay — 정답 display 식이 아닌 $$…$$(그림·표, inline 식을 display 로 검출)가 섞이면 깎인다
//   missAsInline : 못 찾은 정답 식 중 같은·이웃 쪽 inline 예측과 NED ≤ 0.6 인 것 — display 식을 inline 으로 검출한 경우. inline 예측 하나를
//                  여러 식이 함께 쓸 수 있어 상한이다
//   scope     : all(전 쪽) · pages(--pages, 쪽 번호로 모수) · aligned-span(위)        gtEmpty : 정규화 뒤 토큰이 없어 뺀 정답 식
//   sec / secPerPage : parse 벽시계 시간(논문마다 수식 모델 적재 포함) / 쪽당 — 다른 벤치와 동시에 돌면 늘어난다
// 사용법: node bench/formula-gt.mjs [--dir=수식 정답 폴더] [--doc=id 부분문자열[,…]] [--pages=N(논문마다 앞 N쪽, 기본 전 쪽)] [--verbose]
// 산출: bench/out/formula-gt.json {generatedAt, summary, rows}. --verbose 는 짝·놓친 식(가장 닮은 inline 예측 포함)·짝 없는 예측의 latex 를 rows 에 싣는다

import { readFile, readdir, writeFile, mkdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { pdftotextText } from "./lib/pdf-layer.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const verbose = args.includes("--verbose")
const flagValue = (k, d) => args.find(a => a.startsWith(`--${k}=`))?.slice(k.length + 3) || d
const setDir = resolve(flagValue("dir", join(root, "corpus-formula")))
const docList = flagValue("doc", "").split(",").filter(Boolean)
const docFilter = docList.length ? docList : null
const pageLimit = flagValue("pages", null) ? Number(flagValue("pages")) : null
if (pageLimit !== null && !(Number.isInteger(pageLimit) && pageLimit > 0)) { console.error(`--pages 는 1 이상 정수: ${flagValue("pages")}`); process.exit(2) }
const MAX_NED = 0.6
const round = (x, d = 4) => (x === null || x === undefined || Number.isNaN(x) ? null : +x.toFixed(d))

// ── LaTeX 정규화 → 토큰 ──
// 같은 글자·같은 뜻인 다른 표기
const SYN = {
  "\\le": "\\leq", "\\ge": "\\geq", "\\leqslant": "\\leq", "\\geqslant": "\\geq", "\\ne": "\\neq", "\\to": "\\rightarrow", "\\gets": "\\leftarrow",
  "\\implies": "\\Longrightarrow", "\\iff": "\\Longleftrightarrow", "\\dots": "\\ldots", "\\dotsc": "\\ldots", "\\dotsb": "\\cdots", "\\cdotp": "\\cdot",
  "\\lbrace": "\\{", "\\rbrace": "\\}", "\\lVert": "\\|", "\\rVert": "\\|", "\\Vert": "\\|", "\\lvert": "|", "\\rvert": "|", "\\vert": "|", "\\mid": "|",
  "\\colon": ":", "\\land": "\\wedge", "\\lor": "\\vee", "\\lnot": "\\neg", "\\ast": "*", "\\owns": "\\ni",
  "\\dfrac": "\\frac", "\\tfrac": "\\frac", "\\cfrac": "\\frac", "\\dbinom": "\\binom", "\\tbinom": "\\binom", "\\stackrel": "\\overset",
  "\\widehat": "\\hat", "\\widetilde": "\\tilde", "\\Bbb": "\\mathbb", "\\mathbbm": "\\mathbb",
  "\\bm": "\\mathbf", "\\boldsymbol": "\\mathbf", "\\pmb": "\\mathbf", "\\textbf": "\\mathbf",
  "\\text": "\\mathrm", "\\textrm": "\\mathrm", "\\textnormal": "\\mathrm", "\\textup": "\\mathrm", "\\mbox": "\\mathrm", "\\hbox": "\\mathrm",
  "\\operatorname": "\\mathrm", "\\operatorname*": "\\mathrm", "\\textit": "\\mathit", "\\emph": "\\mathit", "\\textsf": "\\mathsf", "\\texttt": "\\mathtt",
}
// 여러 토큰으로 펴는 표기 — \coloneqq 는 ":=" 글자, \dd(physics 패키지 미분)는 d
const MULTI = { "\\coloneqq": [":", "="], "\\eqqcolon": ["=", ":"], "\\dd": ["d"] }
// 묶음 안 글꼴 전환 — 남은 묶음 글이 인자 ({\rm d} → \mathrm{d})
const FONT_SWITCH = { "\\rm": "\\mathrm", "\\bf": "\\mathbf", "\\it": "\\mathit", "\\cal": "\\mathcal", "\\sf": "\\mathsf", "\\tt": "\\mathtt", "\\mit": "\\mathit" }
// 글자에 영향 없는 조판 명령 — 간격·크기·글자 크기·정렬 기호·줄바꿈·식 번호 끄기
const DROP = new Set([
  "\\,", "\\;", "\\:", "\\!", "\\ ", "\\>", "\\/", "~", "$", "\\quad", "\\qquad", "\\enspace", "\\thinspace", "\\medspace", "\\thickspace",
  "\\negthinspace", "\\negmedspace", "\\negthickspace", "\\left", "\\right", "\\middle", "\\big", "\\Big", "\\bigg", "\\Bigg", "\\bigl", "\\bigr",
  "\\Bigl", "\\Bigr", "\\biggl", "\\biggr", "\\Biggl", "\\Biggr", "\\bigm", "\\Bigm", "\\biggm", "\\Biggm", "\\displaystyle", "\\textstyle",
  "\\scriptstyle", "\\scriptscriptstyle", "\\limits", "\\nolimits", "\\nonumber", "\\notag", "\\qedhere", "\\hline", "\\cr", "\\allowbreak",
  "\\nobreak", "\\relax", "\\protect", "\\tiny", "\\scriptsize", "\\footnotesize", "\\small", "\\normalsize", "\\large", "\\Large", "\\LARGE",
  "\\huge", "\\Huge", "&", "\\\\", "\\newline", "\\offinterlineskip", "\\vcenter",
])
const SIZED = new Set(["\\left", "\\right", "\\middle", "\\big", "\\Big", "\\bigg", "\\Bigg", "\\bigl", "\\bigr", "\\Bigl", "\\Bigr", "\\biggl", "\\biggr", "\\Biggl", "\\Biggr"])
// 인자째 버리는 명령
const DROP_ARG = new Set(["\\label", "\\tag", "\\tag*", "\\hspace", "\\hspace*", "\\vspace", "\\vspace*", "\\phantom", "\\hphantom", "\\vphantom", "\\color", "\\mspace"])
// 인자 수 (SYN 뒤 이름)
const ARITY = {
  "\\frac": 2, "\\binom": 2, "\\overset": 2, "\\underset": 2, "\\sqrt": 1, "\\hat": 1, "\\tilde": 1, "\\bar": 1, "\\overline": 1, "\\underline": 1,
  "\\vec": 1, "\\dot": 1, "\\ddot": 1, "\\dddot": 1, "\\check": 1, "\\breve": 1, "\\acute": 1, "\\grave": 1, "\\mathring": 1,
  "\\mathrm": 1, "\\mathbf": 1, "\\mathit": 1, "\\mathsf": 1, "\\mathtt": 1, "\\mathcal": 1, "\\mathbb": 1, "\\mathfrak": 1, "\\mathscr": 1,
  "\\overbrace": 1, "\\underbrace": 1, "\\overrightarrow": 1, "\\overleftarrow": 1, "\\xrightarrow": 1, "\\xleftarrow": 1, "\\substack": 1,
  "\\pmod": 1, "\\boxed": 1, "\\cancel": 1,
}
// 수식 분류 감싸개 — 인자만 남긴다
const UNWRAP = new Set(["\\mathop", "\\mathbin", "\\mathrel", "\\mathord", "\\mathopen", "\\mathclose", "\\mathpunct", "\\mathinner"])
// 로만체 함수 이름 — \mathrm{log} = \log. 텍스트층 쪽 찾기에서도 글자로 센다
const FUNCS = new Set(["sin", "cos", "tan", "sec", "csc", "cot", "arcsin", "arccos", "arctan", "sinh", "cosh", "tanh", "coth", "log", "ln", "lg", "exp",
  "lim", "liminf", "limsup", "sup", "inf", "max", "min", "arg", "det", "dim", "gcd", "deg", "hom", "ker", "Pr"])
// 행렬·정렬 환경 → 보이는 괄호만
const ENV_OPEN = { pmatrix: "(", bmatrix: "[", Bmatrix: "\\{", vmatrix: "|", Vmatrix: "\\|", cases: "\\{", dcases: "\\{" }
const ENV_CLOSE = { pmatrix: ")", bmatrix: "]", Bmatrix: "\\}", vmatrix: "|", Vmatrix: "\\|" }
// 치수를 받는 간격 명령 (\kern-0.25ex, \mskip 3mu)
const KERN_RE = /\\(?:m?kern|[hvm]skip)\s*-?\s*\d*\.?\d+\s*(?:ex|em|pt|mu|mm|cm|in|bp|sp|pc)?/g

function tokenize(s) {
  s = s.replace(KERN_RE, " ")
  const out = []
  for (let i = 0; i < s.length;) {
    const c = s[i]
    if (/\s/.test(c)) { i++; continue }
    if (c !== "\\") { out.push(c); i++; continue }
    const env = /^\\(begin|end)\s*\{([^{}]*)\}/.exec(s.slice(i, i + 64))
    if (env) { out.push(`\\${env[1]}{${env[2].trim()}}`); i += env[0].length; continue }
    let t = (/^\\(?:[A-Za-z]+|[\s\S])/.exec(s.slice(i, i + 64)) ?? ["\\"])[0] // 끝에 홀로 선 \ (깨진 OCR 식)
    i += t.length
    if (/^\\\s$/.test(t)) t = "\\ "
    if (s[i] === "*" && /^\\(?:operatorname|tag|hspace|vspace)$/.test(t)) { t += "*"; i++ }
    out.push(t)
  }
  return out
}

/** 정답 매크로 펼치기 — 0인자는 latex 에 이미 펼쳐져 있어 인자 매크로 본문 안의 것만 남는다. 인자 매크로는 #1.. 치환 */
function expandMacros(toks, macros, macroArgs) {
  if (!macros || !Object.keys(macros).length) return toks
  for (let round = 0; round < 6; round++) {
    const out = []
    let changed = false
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i]
      if (!Object.hasOwn(macros, t)) { out.push(t); continue }
      const spec = macroArgs?.[t]
      const nargs = spec?.nargs ?? 0
      const got = []
      let j = i + 1
      if (nargs && spec.default != null) {
        const k = toks[j] === "[" ? toks.indexOf("]", j) : -1
        if (k > 0) { got.push(toks.slice(j + 1, k).join(" ")); j = k + 1 } else got.push(String(spec.default))
      }
      while (got.length < nargs && j < toks.length) {
        if (toks[j] !== "{") { got.push(toks[j++]); continue }
        let depth = 0, k = j
        for (; k < toks.length; k++) { if (toks[k] === "{") depth++; else if (toks[k] === "}" && --depth === 0) break }
        got.push(toks.slice(j + 1, k).join(" "))
        j = k + 1
      }
      out.push(...tokenize(macros[t].replace(/#(\d)/g, (_, k) => ` ${got[k - 1] ?? ""} `)))
      i = j - 1
      changed = true
    }
    toks = out
    if (!changed || toks.length > 20000) break
  }
  return toks
}

/** 글꼴 인자 — 로만·기울임(\mathrm·\mathit, \text·\operatorname 포함)은 감싸개를 버리고 글자만(함수 이름이면 \log 처럼 명령), 빈 인자는 버림 */
function font(cmd, inner) {
  if (!inner.length) return []
  if (cmd !== "\\mathrm" && cmd !== "\\mathit") return [cmd, "{", ...inner, "}"]
  return inner.every(t => /^[A-Za-z]$/.test(t)) && FUNCS.has(inner.join("")) ? ["\\" + inner.join("")] : inner
}

/** 토큰 → 정규 토큰열 (머리 주석의 정규화 — 표기 통일·조판 명령 제거·인자는 늘 { }·인자 아닌 { } 벗김·환경은 보이는 괄호만) */
function canon(toks0) {
  const toks = toks0.map(t => SYN[t] ?? t)
  let i = 0
  const ARG = Symbol("arg") // 한 토큰 인자 자리 (x^\prime)
  const until = close => { const out = []; while (i < toks.length && toks[i] !== close) step(out, close); return out }
  const group = close => { const out = until(close); if (toks[i] === close) i++; return out }
  const arg = () => {
    while (i < toks.length && DROP.has(toks[i])) i++
    if (toks[i] === "{") { i++; return group("}") }
    if (toks[i] === "}") return [] // 인자 없이 닫힘 (깨진 OCR 식)
    const out = []
    while (i < toks.length && !out.length) step(out, ARG)
    return out
  }
  const step = (out, close) => {
    const t = toks[i++]
    if (t === "{") { out.push(...group("}")); return }
    if (t === "}") return // 짝 없는 닫기
    if (t === "_" || t === "^") { out.push(t, "{", ...arg(), "}"); return }
    if (t === "'") { let n = 1; while (toks[i] === "'") { n++; i++ } out.push("^", "{", ...Array(n).fill("\\prime"), "}"); return }
    if (DROP_ARG.has(t)) { arg(); return }
    if (DROP.has(t)) {
      if (SIZED.has(t) && toks[i] === ".") i++ // \right. 빈 구분자
      else if (t === "\\\\" && toks[i] === "[") group("]") // \\[2pt] 줄 간격
      return
    }
    if (FONT_SWITCH[t]) { out.push(...font(FONT_SWITCH[t], close === ARG ? arg() : until(close))); return }
    if (UNWRAP.has(t)) { out.push(...arg()); return }
    if (MULTI[t]) { out.push(...MULTI[t]); return }
    if (t === "\\textcolor" || t === "\\colorbox") { arg(); out.push(...arg()); return }
    if (t === "\\not" && (toks[i] === "=" || toks[i] === "\\in")) { out.push(toks[i++] === "=" ? "\\neq" : "\\notin"); return }
    const env = /^\\(begin|end)\{(.*)\}$/.exec(t)
    if (env) {
      const name = env[2].replace(/\*$/, "")
      if (env[1] === "begin") {
        if (toks[i] === "[") group("]") // 세로 자리 [t]
        if (/^(?:array|subarray|alignedat|alignat)$/.test(name)) arg() // 열 지정 {cc}·열 수 {2}
        if (ENV_OPEN[name]) out.push(ENV_OPEN[name])
      } else if (ENV_CLOSE[name]) out.push(ENV_CLOSE[name])
      return
    }
    if (ARITY[t]) {
      const opt = t === "\\sqrt" && toks[i] === "[" ? (i++, group("]")) : null
      const got = Array.from({ length: ARITY[t] }, () => arg())
      if (/^\\math(?:rm|bf|it|sf|tt|cal|bb|frak|scr)$/.test(t)) { out.push(...font(t, got[0])); return }
      out.push(t, ...(opt ? ["[", ...opt, "]"] : []))
      for (const a of got) out.push("{", ...a, "}")
      return
    }
    out.push(t)
  }
  const out = []
  while (i < toks.length) step(out, null)
  return out
}

/** 아래·위 첨자 순서 통일 — x^{a}_{b} → x_{b}^{a} */
function scriptOrder(t) {
  const end = k => { let d = 0; for (; k < t.length; k++) { if (t[k] === "{") d++; else if (t[k] === "}" && --d === 0) return k + 1 } return t.length }
  for (let k = 0; k < t.length; k++) {
    if (t[k] !== "^" || t[k + 1] !== "{") continue
    const supEnd = end(k + 1)
    if (t[supEnd] !== "_" || t[supEnd + 1] !== "{") continue
    const subEnd = end(supEnd + 1)
    t.splice(k, subEnd - k, ...t.slice(supEnd, subEnd), ...t.slice(k, supEnd))
  }
  return t
}

const normTokens = (latex, macros, macroArgs) => scriptOrder(canon(expandMacros(tokenize(latex), macros, macroArgs)))

// ── 토큰 편집 거리 ──
const tokenIds = new Map()
const toIds = toks => Int32Array.from(toks, t => { let v = tokenIds.get(t); if (v === undefined) tokenIds.set(t, v = tokenIds.size); return v })
function editDistance(a, b) {
  if (a.length < b.length) [a, b] = [b, a]
  let prev = Int32Array.from({ length: b.length + 1 }, (_, k) => k)
  let cur = new Int32Array(b.length + 1)
  for (let x = 1; x <= a.length; x++) {
    cur[0] = x
    for (let y = 1; y <= b.length; y++) cur[y] = Math.min(prev[y] + 1, cur[y - 1] + 1, prev[y - 1] + (a[x - 1] === b[y - 1] ? 0 : 1))
    ;[prev, cur] = [cur, prev]
  }
  return prev[b.length]
}
const ned = (a, b) => (a.length || b.length ? editDistance(a, b) / Math.max(a.length, b.length) : 0)
/** NED ≤ max 일 때만 값, 아니면 null — 길이 차만으로 넘는 짝은 거리를 재지 않는다 */
const nedWithin = (a, b, max) => {
  if (Math.abs(a.length - b.length) / Math.max(a.length, b.length, 1) > max) return null
  const d = ned(a, b)
  return d <= max ? d : null
}

// ── 정답 식 → 쪽 (pdftotext 텍스트층) ──
const layerSig = toks => toks.map(t => (/^[A-Za-z0-9]$/.test(t) ? t : FUNCS.has(t.slice(1)) ? t.slice(1) : "")).join("")
const trigrams = s => { const g = new Set(); for (let k = 0; k + 3 <= s.length; k++) g.add(s.slice(k, k + 3)); return g }

/** 정답 식마다 쪽 번호(1-based) — 머리 주석 "정답 식의 쪽" */
function mapGtPages(gtToks, pageTexts) {
  const P = pageTexts.length
  const pageGrams = pageTexts.map(t => trigrams(t.normalize("NFKC").replace(/[^A-Za-z0-9]/g, "")))
  const df = new Map()
  for (const pg of pageGrams) for (const g of pg) df.set(g, (df.get(g) ?? 0) + 1)
  const JUMP = 0.02
  const best = [], from = []
  for (const toks of gtToks) {
    const grams = [...trigrams(layerSig(toks))].filter(g => df.has(g))
    const w = grams.map(g => Math.log((P + 1) / df.get(g)))
    const total = w.reduce((a, b) => a + b, 0)
    const prevRow = best.at(-1)
    const b = new Float64Array(P), f = new Int32Array(P)
    let runMax = -Infinity, runArg = 0
    for (let p = 0; p < P; p++) {
      const score = total ? grams.reduce((a, g, k) => a + (pageGrams[p].has(g) ? w[k] : 0), 0) / total : 0
      let prev = p === 0 ? 0 : -JUMP, arg = p
      if (prevRow) {
        prev = prevRow[p]
        if (runMax - JUMP > prev) { prev = runMax - JUMP; arg = runArg }
        if (prevRow[p] > runMax) { runMax = prevRow[p]; runArg = p }
      }
      b[p] = score + prev
      f[p] = arg
    }
    best.push(b); from.push(f)
  }
  const pages = new Array(gtToks.length)
  let p = 0
  if (best.length) for (let q = 1; q < P; q++) if (best.at(-1)[q] > best.at(-1)[p]) p = q
  for (let j = gtToks.length - 1; j >= 0; j--) { pages[j] = p + 1; p = from[j][p] }
  return pages
}

// ── 단조 정렬 ──
/** 예측 식열 ↔ 정답 식열 — 양쪽 건너뛰기 허용, 짝 점수 (MAX_NED − NED) 합 최대. allowed(i, j) 가 거짓인 짝은 맺지 않는다 */
function alignSeq(pred, gt, allowed) {
  const n = pred.length, m = gt.length
  const D = Array.from({ length: n + 1 }, () => new Float64Array(m + 1))
  const B = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1)) // 0 예측 건너뜀 · 1 정답 건너뜀 · 2 짝
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
    let v = D[i - 1][j], b = 0
    if (D[i][j - 1] > v) { v = D[i][j - 1]; b = 1 }
    const d = allowed(i - 1, j - 1) ? nedWithin(pred[i - 1], gt[j - 1], MAX_NED) : null
    if (d !== null && D[i - 1][j - 1] + (MAX_NED - d) + 1e-9 > v) { v = D[i - 1][j - 1] + (MAX_NED - d) + 1e-9; b = 2 }
    D[i][j] = v; B[i][j] = b
  }
  const pairs = []
  for (let i = n, j = m; i > 0 && j > 0;) {
    if (B[i][j] === 2) { pairs.push({ i: i - 1, j: j - 1, ned: ned(pred[i - 1], gt[j - 1]) }); i--; j-- }
    else if (B[i][j] === 1) j--
    else i--
  }
  return pairs.reverse()
}

// ── BLEU-4 (말뭉치·토큰·평활 없음) ──
function corpusBleu(pairs) {
  const hit = [0, 0, 0, 0], tot = [0, 0, 0, 0]
  let c = 0, r = 0
  for (const { hyp, ref } of pairs) {
    c += hyp.length; r += ref.length
    for (let n = 1; n <= 4; n++) {
      const left = new Map()
      for (let k = 0; k + n <= ref.length; k++) { const key = ref.slice(k, k + n).join(","); left.set(key, (left.get(key) ?? 0) + 1) }
      for (let k = 0; k + n <= hyp.length; k++) {
        tot[n - 1]++
        const key = hyp.slice(k, k + n).join(","), l = left.get(key) ?? 0
        if (l > 0) { hit[n - 1]++; left.set(key, l - 1) }
      }
    }
  }
  if (!c) return null
  if (hit.some(h => h === 0)) return 0
  return (c > r ? 1 : Math.exp(1 - r / c)) * Math.exp(hit.reduce((a, h, k) => a + Math.log(h / tot[k]), 0) / 4)
}

// ── 예측 수식 (쪽별 마크다운) — 수식 스팬 정규식은 마크다운 이스케이프가 보호하는 스팬(table/builder.ts escapeGfm)과 같은 모양 ──
const DISPLAY_RE = /(?<!\\)\$\$((?:\\[\s\S]|[^\\$])*)\$\$/g
const INLINE_RE = /(?<![\\$])\$((?:\\[^\n]|[^\\$\n])+)\$(?!\$)/g
function predictions(result) {
  const pages = result.pages?.length ? result.pages : [{ pageNumber: null, markdown: result.markdown }]
  const display = [], inline = []
  for (const { pageNumber, markdown } of pages) {
    for (const m of markdown.matchAll(DISPLAY_RE)) display.push({ page: pageNumber, latex: m[1] })
    for (const m of markdown.replace(DISPLAY_RE, " ").matchAll(INLINE_RE)) inline.push({ page: pageNumber, latex: m[1] })
  }
  for (const p of [...display, ...inline]) p.ids = toIds(normTokens(p.latex))
  return { display, inline }
}

// ── 실행 ──
const manifest = JSON.parse(await readFile(join(setDir, "manifest.json"), "utf8").catch(() => "null"))
const ids = manifest?.papers?.map(p => p.id) ?? (await readdir(join(setDir, "gt"))).filter(f => f.endsWith(".json")).map(f => f.slice(0, -5)).sort()
const meta = new Map((manifest?.papers ?? []).map(p => [p.id, p]))
const t0 = performance.now()
const rows = []
const allPairs = []
const agg = { papers: 0, pages: 0, gt: 0, gtEmpty: 0, boundaryMatches: 0, predDisplay: 0, predInline: 0, matched: 0, r03: 0, exact: 0, nedSum: 0, missAsInline: 0, sec: 0 }
let parseErrors = 0

for (const id of ids) {
  if (docFilter && !docFilter.some(d => id.includes(d))) continue
  const row = { id, field: meta.get(id)?.field ?? null }
  try {
    const gtDoc = JSON.parse(await readFile(join(setDir, "gt", `${id}.json`), "utf8"))
    const pdfFile = join(setDir, "pdf", `${id}.pdf`)
    const tp = performance.now()
    const result = await parse(await readFile(pdfFile), { formulaOcr: true, ocr: false, ...(pageLimit ? { pages: `1-${pageLimit}` } : {}) })
    const sec = (performance.now() - tp) / 1000
    if (!result.success) throw new Error(`parse 실패: ${result.error}`)
    // 수식 OCR 이 통째로 실패하면(모델·optional 의존성 없음) parse 는 성공하고 경고만 남긴다 (pdf/parser.ts) — 0점이 아니라 실패로
    const ocrFail = result.warnings?.find(w => w.code === "PARTIAL_PARSE" && w.message.startsWith("수식 OCR 실패"))
    if (ocrFail) throw new Error(ocrFail.message)
    const pdfPages = meta.get(id)?.pdf_pages ?? gtDoc.pdf_pages ?? result.metadata?.pageCount ?? null
    const parsedPages = pageLimit && pdfPages ? Math.min(pageLimit, pdfPages) : pageLimit ?? pdfPages

    const gtAll = gtDoc.equations.map(q => {
      const toks = normTokens(q.latex, gtDoc.macros, gtDoc.macro_args)
      return { n: q.n, latex: q.latex, toks, ids: toIds(toks), page: null }
    })
    const layer = await pdftotextText(pdfFile)
    const layerPages = layer?.split("\f") ?? null
    if (layerPages && layerPages.length > 1 && !layerPages.at(-1).trim()) layerPages.pop()
    const pageOf = layerPages ? mapGtPages(gtAll.map(g => g.toks), layerPages) : null
    gtAll.forEach((g, j) => { g.page = pageOf?.[j] ?? null })
    const gtEmpty = gtAll.filter(g => !g.ids.length).length
    // 앞 N쪽만 읽으면 N+1쪽으로 찾은 식까지 정렬에 넣는다(쪽 찾기가 경계에서 한 쪽 밀린 식의 짝) — 모수는 아니고 precision 에만 센다
    const gt = gtAll.filter(g => g.ids.length && (!pageLimit || !pageOf || g.page <= pageLimit + 1))
    const { display, inline } = predictions(result)
    const near = (a, b) => a == null || b == null || Math.abs(a - b) <= 1
    const pairs = alignSeq(display.map(p => p.ids), gt.map(g => g.ids), (i, j) => near(display[i].page, gt[j].page))
    const matchedJ = new Set(pairs.map(p => p.j))
    const scope = !pageLimit ? "all" : pageOf ? "pages" : "aligned-span"
    const lastJ = pairs.length ? pairs.at(-1).j : -1
    // 모수는 텍스트층 쪽 번호로만 정한다 — 예측(짝 여부)이 모수를 고르면 OCR 이 자기 채점표를 고치는 꼴. aligned-span 만 예외(쪽을 모름, 후한 쪽으로 표시)
    const inScope = gt.map((g, j) => scope === "all" || (scope === "pages" ? g.page <= pageLimit : j <= lastJ))
    const nGt = inScope.filter(Boolean).length
    const scored = pairs.filter(p => inScope[p.j])
    const boundaryMatches = pairs.length - scored.length
    const misses = gt.filter((g, j) => inScope[j] && !matchedJ.has(j))
    let missAsInline = 0
    const missInfo = misses.map(g => {
      let bestD = null, best = null
      for (const p of inline) {
        if (!near(p.page, g.page)) continue
        const d = nedWithin(p.ids, g.ids, MAX_NED)
        if (d !== null && (bestD === null || d < bestD)) { bestD = d; best = p }
      }
      if (best) missAsInline++
      return { n: g.n, page: g.page, latex: g.latex, inline: best ? { page: best.page, ned: round(bestD), latex: best.latex } : null }
    })
    const nedSum = scored.reduce((a, p) => a + p.ned, 0)
    const r03 = scored.filter(p => p.ned <= 0.3).length
    const exact = scored.filter(p => p.ned === 0).length
    const bleuPairs = scored.map(p => ({ hyp: display[p.i].ids, ref: gt[p.j].ids }))
    allPairs.push(...bleuPairs)
    Object.assign(row, {
      ok: true, scope, pageMapped: !!pageOf, pdfPages, parsedPages, gtTotal: gtAll.length, gtEmpty, gt: nGt,
      predDisplay: display.length, predInline: inline.length, matched: scored.length, boundaryMatches,
      recall: round(nGt ? scored.length / nGt : null), recall03: round(nGt ? r03 / nGt : null),
      exactRate: round(nGt ? exact / nGt : null), meanNED: round(scored.length ? nedSum / scored.length : null),
      nedAll: round(nGt ? (nedSum + misses.length) / nGt : null), bleu4: round(corpusBleu(bleuPairs)),
      precision: round(display.length ? pairs.length / display.length : null), missAsInline,
      sec: round(sec, 1), secPerPage: round(parsedPages ? sec / parsedPages : null, 1),
    })
    if (verbose) {
      row.pairs = pairs.map(p => ({ n: gt[p.j].n, page: gt[p.j].page, predPage: display[p.i].page, inScope: inScope[p.j], ned: round(p.ned), gt: gt[p.j].latex, pred: display[p.i].latex }))
      row.misses = missInfo
      const used = new Set(pairs.map(p => p.i))
      row.unmatchedPred = display.filter((_, i) => !used.has(i)).map(p => ({ page: p.page, latex: p.latex }))
    }
    agg.papers++; agg.pages += parsedPages ?? 0; agg.gt += nGt; agg.gtEmpty += gtEmpty; agg.boundaryMatches += boundaryMatches
    agg.predDisplay += display.length; agg.predInline += inline.length; agg.matched += scored.length
    agg.r03 += r03; agg.exact += exact; agg.nedSum += nedSum; agg.missAsInline += missAsInline; agg.sec += sec
  } catch (err) {
    parseErrors++
    row.ok = false
    row.error = String(err?.message ?? err).slice(0, 200)
  }
  rows.push(row)
  if (row.ok) console.log(`  ${id} [${row.field}] ${row.parsedPages}쪽 ${row.sec}s(${row.secPerPage}s/쪽) | 정답 ${row.gt} display ${row.predDisplay} inline ${row.predInline} 짝 ${row.matched} | recall ${row.recall} r@.3 ${row.recall03} exact ${row.exactRate} meanNED ${row.meanNED} nedAll ${row.nedAll} BLEU ${row.bleu4} prec ${row.precision} missAsInline ${row.missAsInline}${row.scope === "aligned-span" ? " (정렬 구간 모수)" : ""}`)
  else console.log(`  ❌ ${id}: ${row.error}`)
}

const summary = {
  papers: agg.papers, pages: agg.pages, pageLimit, gt: agg.gt, gtEmpty: agg.gtEmpty, predDisplay: agg.predDisplay, predInline: agg.predInline, matched: agg.matched,
  boundaryMatches: agg.boundaryMatches,
  recall: round(agg.gt ? agg.matched / agg.gt : null), recall03: round(agg.gt ? agg.r03 / agg.gt : null), exactRate: round(agg.gt ? agg.exact / agg.gt : null),
  meanNED: round(agg.matched ? agg.nedSum / agg.matched : null), nedAll: round(agg.gt ? (agg.nedSum + agg.gt - agg.matched) / agg.gt : null),
  bleu4: round(corpusBleu(allPairs)), precision: round(agg.predDisplay ? (agg.matched + agg.boundaryMatches) / agg.predDisplay : null), missAsInline: agg.missAsInline,
  sec: round(agg.sec, 1), secPerPage: round(agg.pages ? agg.sec / agg.pages : null, 1), parseErrors, maxNed: MAX_NED, dir: setDir, doc: docFilter,
}
const elapsed = ((performance.now() - t0) / 1000).toFixed(0)
console.log(`\n══ 수식 OCR 정답지 — ${summary.papers}편 ${summary.pages}쪽${pageLimit ? ` (논문마다 앞 ${pageLimit}쪽)` : ""} (${elapsed}s) ══`)
console.log(`  정답 display ${summary.gt} | 예측 display ${summary.predDisplay} inline ${summary.predInline} | 짝 ${summary.matched}`)
console.log(`  recall ${summary.recall} | recall@NED≤.3 ${summary.recall03} | exact ${summary.exactRate} | meanNED ${summary.meanNED} | nedAll ${summary.nedAll} | BLEU-4 ${summary.bleu4} | precision ${summary.precision} | missAsInline ${summary.missAsInline}`)
console.log(`  ${summary.secPerPage}s/쪽 (parse 합 ${summary.sec}s)${parseErrors ? ` | 실패 ${parseErrors}` : ""}`)

await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "formula-gt.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 1))
console.log("report → bench/out/formula-gt.json (보고 전용 — 게이트 아님)")
