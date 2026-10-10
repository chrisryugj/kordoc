/**
 * 문단 글 편집의 최소 범위 계산: 패치가 문단을 통째로 다시 쓰지 않고 바뀐 자리만 고치게 한다.
 *
 * 1. parseEmphasis: 편집 마크다운의 강조 표지(** · * · ~~ · <u> · `)를 걷어 평문과 서식 조각으로 나눈다.
 *    파서가 굵게·밑줄 run 을 표지로 옮기므로(builder spansToMarkdown) 걷지 않으면 표지가 글자로 찍힌다.
 * 2. alignedTextEdits: 원문 글(hp:t 이음·PARA_TEXT 코어)과 IR 평문을 맞대어, 평문 diff 를 원문 좌표의 편집으로 옮긴다.
 *    IR 은 공백을 접어 보이므로("기   간" → "기 간") 원문 쪽 여분 공백은 건너뛰며 맞댄다: 고치지 않은 자리의
 *    균등 띄어쓰기·run 경계·글자 모양은 그대로 남는다.
 */

import { paraTText, buildRangeSplices, type ScanParagraph, type SpliceEdit } from "./source-map.js"

interface Tok {
  kind: "text" | "u-open" | "u-close" | "strike" | "star"
  text: string
  /** star 표지 길이 (1 이탤릭·2 굵게·3 굵은 이탤릭) */
  n?: number
  /** 짝을 찾은 표지 */
  paired?: boolean
  code?: boolean
}

const ESCAPABLE = new Set(["~", "*", "_", "`", "|", "#", "<", "$", "\\"])
const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)

/**
 * 마크다운 인라인 글 → { plain, segs }: plain 은 표지를 걷고 역이스케이프한 글, segs 는 서식이 같은 조각의 글(이으면 plain).
 * 표지는 짝이 맞고 글자에 붙은 것만 인정한다(여는 쪽 뒤·닫는 쪽 앞이 공백이 아님). 짝 없는 표지는 글자로 둔다("3 * 4").
 */
export function parseEmphasis(text: string): { plain: string; segs: string[] } {
  const toks: Tok[] = []
  const pushText = (s: string, code = false): void => {
    const last = toks[toks.length - 1]
    if (last && last.kind === "text" && !!last.code === code) last.text += s
    else toks.push({ kind: "text", text: s, code })
  }
  for (let i = 0; i < text.length;) {
    const c = text[i]
    if (c === "\\" && ESCAPABLE.has(text[i + 1])) { pushText(text[i + 1]); i += 2; continue }
    if (c === "`") {
      const close = text.indexOf("`", i + 1)
      if (close > i + 1) { pushText(text.slice(i + 1, close), true); i = close + 1; continue }
    }
    if (text.startsWith("<u>", i)) { toks.push({ kind: "u-open", text: "<u>" }); i += 3; continue }
    if (text.startsWith("</u>", i)) { toks.push({ kind: "u-close", text: "</u>" }); i += 4; continue }
    if (text.startsWith("~~", i)) { toks.push({ kind: "strike", text: "~~" }); i += 2; continue }
    if (c === "*") {
      let j = i
      while (text[j] === "*") j++
      toks.push({ kind: "star", text: text.slice(i, j), n: j - i })
      i = j
      continue
    }
    pushText(c)
    i++
  }

  // 짝 맞추기: 스택 맨 위와만 짝짓는다(표지는 <u>~~**…**~~</u> 처럼 대칭으로 중첩)
  const charBefore = (k: number): string | undefined => {
    const t = toks[k - 1]
    return t?.kind === "text" ? t.text[t.text.length - 1] : t ? "x" : undefined
  }
  const charAfter = (k: number): string | undefined => {
    const t = toks[k + 1]
    return t?.kind === "text" ? t.text[0] : t ? "x" : undefined
  }
  const stack: number[] = []
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.kind === "text") continue
    const top = stack.length ? toks[stack[stack.length - 1]] : undefined
    const canClose = t.kind === "u-close" || ((t.kind === "star" || t.kind === "strike") && charBefore(k) !== undefined && !isWs(charBefore(k)))
    const matches = top && (
      (t.kind === "u-close" && top.kind === "u-open")
      || (t.kind === "strike" && top.kind === "strike")
      || (t.kind === "star" && top.kind === "star" && top.n === t.n))
    if (canClose && matches) {
      top!.paired = true
      t.paired = true
      stack.pop()
      continue
    }
    const canOpen = t.kind === "u-open" || ((t.kind === "star" || t.kind === "strike") && charAfter(k) !== undefined && !isWs(charAfter(k)))
    if (canOpen) stack.push(k)
  }

  // 조각: 짝 맞은 표지가 서식 경계, 짝 없는 표지는 글자
  const segs: string[] = []
  let cur = ""
  const cut = (): void => { if (cur) segs.push(cur); cur = "" }
  for (const t of toks) {
    if (t.kind !== "text" && t.paired) { cut(); continue }
    if (t.code) { cut(); segs.push(t.text); continue }
    cur += t.text
  }
  cut()
  return { plain: segs.join(""), segs }
}

/** 원문 글 raw 와 IR 평문 norm 맞대기: norm[i] 의 raw 위치. raw 의 여분 공백은 건너뛴다. 못 맞추면 null */
function alignToRaw(raw: string, norm: string): number[] | null {
  const pos: number[] = new Array(norm.length)
  let j = 0
  for (let i = 0; i < norm.length; i++) {
    for (;;) {
      if (j >= raw.length) return null
      const a = norm[i], b = raw[j]
      if (a === b || (isWs(a) && isWs(b))) break
      if (isWs(b)) { j++; continue }
      return null
    }
    pos[i] = j++
  }
  if (raw.slice(j).trim() !== "") return null
  return pos
}

/** 두 글의 공통 앞·뒤 길이 */
function commonEnds(a: string, b: string): { p: number; s: number } {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { p, s }
}

export interface RawEdit { start: number; end: number; text: string }

/**
 * IR 평문 편집(origNorm → newNorm)을 원문 글 raw 의 최소 편집들로 옮긴다. 조각(서식 run 경계)이 양쪽에 같은 수로 있으면
 * 조각마다 따로 diff 해 각 run 이 제 글을 받는다. raw 와 origNorm 을 못 맞추면 null (호출자가 문단 통째 쓰기로).
 */
export function alignedTextEdits(raw: string, origNorm: string, newNorm: string, origSegs?: string[], newSegs?: string[]): RawEdit[] | null {
  if (!origNorm) return null
  const pos = alignToRaw(raw, origNorm)
  if (!pos) return null
  const ranges: Array<{ a: number; b: number; text: string }> = []
  const diffInto = (o: string, n: string, base: number): void => {
    if (o === n) return
    const { p, s } = commonEnds(o, n)
    ranges.push({ a: base + p, b: base + o.length - s, text: n.slice(p, n.length - s) })
  }
  if (origSegs && newSegs && origSegs.length === newSegs.length && origSegs.length > 1
    && origSegs.join("") === origNorm && newSegs.join("") === newNorm) {
    let base = 0
    for (let k = 0; k < origSegs.length; k++) {
      diffInto(origSegs[k], newSegs[k], base)
      base += origSegs[k].length
    }
  } else {
    diffInto(origNorm, newNorm, 0)
  }
  const at = (a: number): number => (a < pos.length ? pos[a] : pos[pos.length - 1] + 1)
  return ranges.map(r => ({ start: at(r.a), end: r.b > r.a ? pos[r.b - 1] + 1 : at(r.a), text: r.text }))
}

/**
 * HWPX 문단의 바뀐 자리만 고치는 splice: hp:t 이음 글과 IR 평문을 맞대어 diff 범위를 원문 좌표로 옮긴다. 고치지 않은
 * run(굵게·색)·균등 띄어쓰기는 그대로, 서식 조각이 같은 수면 조각마다 제 run 에 쓴다. 맞대지 못하면(엔티티·탭·PUA 등) null
 * (호출자가 문단 통째 쓰기 buildParagraphSplices 로)
 */
export function minimalTextSplices(
  para: ScanParagraph, xml: string, origPlain: string, newPlain: string, origSegs?: string[], newSegs?: string[],
): SpliceEdit[] | null {
  const raw = paraTText(para, xml)
  if (raw === null) return null
  const edits = alignedTextEdits(raw, origPlain, newPlain, origSegs, newSegs)
  if (!edits || edits.length === 0) return null
  const out: SpliceEdit[] = []
  for (const e of edits) {
    const sp = buildRangeSplices(para, xml, e.start, e.end, e.text)
    if (!sp) return null
    out.push(...sp)
  }
  return out
}
