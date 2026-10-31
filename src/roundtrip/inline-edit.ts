/**
 * 문단 글 편집의 최소 범위 계산: 패치가 문단을 통째로 다시 쓰지 않고 바뀐 자리만 고치게 한다.
 *
 * 1. parseEmphasis: 편집 마크다운의 강조 표지(** · * · ~~ · <u> · `)를 걷어 평문과 서식 조각으로 나눈다.
 *    파서가 굵게·밑줄 run 을 표지로 옮기므로(builder spansToMarkdown) 걷지 않으면 표지가 글자로 찍힌다.
 * 2. alignedTextEdits: 원문 글(hp:t 이음·PARA_TEXT 코어)과 IR 평문을 맞대어, 평문 diff 를 원문 좌표의 편집으로 옮긴다.
 *    IR 은 공백을 접어 보이므로("기   간" → "기 간") 원문 쪽 여분 공백은 건너뛰며 맞댄다: 고치지 않은 자리의
 *    균등 띄어쓰기·run 경계·글자 모양은 그대로 남는다.
 */

import { paraTText, buildRangeSplices, paraTCharMap, buildMappedRangeSplices, hasPua, puaShownMap, escapeXmlText, type ScanParagraph, type SpliceEdit } from "./source-map.js"

interface Tok {
  kind: "text" | "u-open" | "u-close" | "strike" | "star"
  text: string
  /** star 표지 길이 (1 이탤릭·2 굵게·3 굵은 이탤릭) */
  n?: number
  /** 짝을 찾은 표지 */
  paired?: boolean
  /** 짝의 여는 쪽 */
  opener?: boolean
  code?: boolean
}

const ESCAPABLE = new Set(["~", "*", "_", "`", "|", "#", "<", "$", "\\"])
const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)

/** 서식 비트 — 강조 표지(parseEmphasis kinds)와 첨자 태그(styledInline) */
export const EMPH_BOLD = 1, EMPH_ITALIC = 2, EMPH_STRIKE = 4, EMPH_UNDERLINE = 8, EMPH_SUP = 16, EMPH_SUB = 32

/**
 * 마크다운 인라인 글 → { plain, segs, marks, kinds }: plain 은 표지를 걷고 역이스케이프한 글, segs 는 서식이 같은 조각의 글(이으면
 * plain), marks 는 조각마다 강조 표지(** · * · ~~ · <u>) 안인지, kinds 는 그 강조 비트(EMPH_*). 표지는 짝이 맞고 글자에 붙은 것만
 * 인정한다(여는 쪽 뒤·닫는 쪽 앞이 공백이 아님). 짝 없는 표지는 글자로 둔다("3 * 4").
 */
export function parseEmphasis(text: string): { plain: string; segs: string[]; marks: boolean[]; kinds: number[] } {
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
      top!.opener = true
      t.paired = true
      stack.pop()
      continue
    }
    const canOpen = t.kind === "u-open" || ((t.kind === "star" || t.kind === "strike") && charAfter(k) !== undefined && !isWs(charAfter(k)))
    if (canOpen) stack.push(k)
  }

  // 조각: 짝 맞은 표지가 서식 경계, 짝 없는 표지는 글자
  const segs: string[] = [], marks: boolean[] = [], kinds: number[] = []
  let cur = ""
  const open: number[] = [] // 열린 표지마다 강조 비트
  const kindOf = (t: Tok): number => t.kind === "u-open" || t.kind === "u-close" ? EMPH_UNDERLINE : t.kind === "strike" ? EMPH_STRIKE
    : ((t.n ?? 0) & 2 ? EMPH_BOLD : 0) | ((t.n ?? 0) & 1 ? EMPH_ITALIC : 0)
  const push = (s: string): void => { segs.push(s); marks.push(open.length > 0); kinds.push(open.reduce((a, b) => a | b, 0)) }
  const cut = (): void => { if (cur) push(cur); cur = "" }
  for (const t of toks) {
    if (t.kind !== "text" && t.paired) { cut(); if (t.opener) open.push(kindOf(t)); else open.pop(); continue }
    if (t.code) { cut(); push(t.text); continue }
    cur += t.text
  }
  cut()
  return { plain: segs.join(""), segs, marks, kinds }
}

const SUP_OPEN = "\uFDD0", SUP_CLOSE = "\uFDD1", SUB_OPEN = "\uFDD2", SUB_CLOSE = "\uFDD3"

/**
 * parseEmphasis 에 첨자 태그(<sup>·<sub>, 이스케이프 안 된 것)까지 걷은 평문 — 조각은 강조·첨자 비트(flags)가 같은 글. 첨자는 글자
 * 모양이라 원문 글에 태그가 없다(파서가 IR 글에 넣는 표기)
 */
export function styledInline(text: string): { plain: string; segs: string[]; flags: number[] } {
  const marked = text.replace(/(\\*)<(\/?)(sup|sub)>/g, (m, bs: string, close: string, tag: string) =>
    bs.length % 2 ? m : bs + (tag === "sup" ? (close ? SUP_CLOSE : SUP_OPEN) : (close ? SUB_CLOSE : SUB_OPEN)))
  const em = parseEmphasis(marked)
  const segs: string[] = [], flags: number[] = []
  let script = 0
  em.segs.forEach((seg, k) => {
    let cur = ""
    const cut = (): void => {
      if (!cur) return
      const f = em.kinds[k] | script
      if (segs.length && flags[flags.length - 1] === f) segs[segs.length - 1] += cur
      else { segs.push(cur); flags.push(f) }
      cur = ""
    }
    for (const c of seg) {
      if (c === SUP_OPEN || c === SUB_OPEN) { cut(); script = c === SUP_OPEN ? EMPH_SUP : EMPH_SUB }
      else if (c === SUP_CLOSE || c === SUB_CLOSE) { cut(); script = 0 }
      else cur += c
    }
    cut()
  })
  return { plain: segs.join(""), segs, flags }
}

/** 원문 글 raw 와 IR 평문 norm 맞대기: norm[i] 의 raw 위치. raw 의 여분 공백은 건너뛴다. 못 맞추면 null */
export function alignToRaw(raw: string, norm: string): number[] | null {
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
export function commonEnds(a: string, b: string): { p: number; s: number } {
  let p = 0
  while (p < a.length && p < b.length && a[p] === b[p]) p++
  let s = 0
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++
  return { p, s }
}

/** 원문 좌표 편집 — at 은 새 글(newNorm)에서 text 가 시작하는 자리 (alignedTextEdits 만 단다) */
export interface RawEdit { start: number; end: number; text: string; at?: number }

/**
 * IR 평문 편집(origNorm → newNorm)을 원문 글 raw 의 최소 편집들로 옮긴다. 조각(서식 run 경계)이 양쪽에 같은 수로 있으면
 * 조각마다 따로 diff 해 각 run 이 제 글을 받는다. raw 와 origNorm 을 못 맞추면 null (호출자가 문단 통째 쓰기로).
 */
export function alignedTextEdits(raw: string, origNorm: string, newNorm: string, origSegs?: string[], newSegs?: string[]): RawEdit[] | null {
  // 한컴 PUA 기호가 든 원문(HWP PARA_TEXT)은 IR 처럼 표시값으로 펴서 맞대고 좌표만 원문으로 되돌린다. 번호 조각 둘을 합친
  // 표시 글자 가운데서 끊기는 편집은 못 옮긴다
  const shown = hasPua(raw) ? puaShownMap(raw) : null
  if (!shown || shown.text === raw) return alignedShownEdits(raw, origNorm, newNorm, origSegs, newSegs)
  const edits = alignedShownEdits(shown.text, origNorm, newNorm, origSegs, newSegs)
  if (!edits) return null
  const n = shown.text.length
  const inside = (s: number): boolean => s > 0 && s < n && shown.from[s] === shown.from[s - 1]
  if (edits.some(e => inside(e.start) || inside(e.end))) return null
  const at = (s: number): number => (s < n ? shown.from[s] : n ? shown.to[n - 1] : raw.length)
  return edits.map(e => ({ ...e, start: at(e.start), end: e.end > e.start ? shown.to[e.end - 1] : at(e.start) }))
}

function alignedShownEdits(raw: string, origNorm: string, newNorm: string, origSegs?: string[], newSegs?: string[]): RawEdit[] | null {
  if (!origNorm) return null
  const pos = alignToRaw(raw, origNorm)
  if (!pos) return null
  const ranges: Array<{ a: number; b: number; text: string; at: number }> = []
  const diffInto = (o: string, n: string, base: number, nbase: number): void => {
    if (o === n) return
    const { p, s } = commonEnds(o, n)
    ranges.push({ a: base + p, b: base + o.length - s, text: n.slice(p, n.length - s), at: nbase + p })
  }
  if (origSegs && newSegs && origSegs.length === newSegs.length && origSegs.length > 1
    && origSegs.join("") === origNorm && newSegs.join("") === newNorm) {
    let base = 0, nbase = 0
    for (let k = 0; k < origSegs.length; k++) {
      diffInto(origSegs[k], newSegs[k], base, nbase)
      base += origSegs[k].length
      nbase += newSegs[k].length
    }
  } else {
    diffInto(origNorm, newNorm, 0, 0)
  }
  const at = (a: number): number => (a < pos.length ? pos[a] : pos[pos.length - 1] + 1)
  // 편집이 IR 공백 하나로 끝나면 그 공백이 접어 보인 원문 공백 줄 전체를 바꾼다. 종전엔 첫 칸만 바꿔
  // "년   월" → "2월" 이 "2  월" 로 남았다 (#151)
  const endOf = (r: { a: number; b: number }): number => {
    if (r.b <= r.a) return at(r.a)
    let e = pos[r.b - 1] + 1
    if (isWs(origNorm[r.b - 1])) while (e < raw.length && isWs(raw[e]) && (r.b >= pos.length || e < pos[r.b])) e++
    return e
  }
  return ranges.map(r => ({ start: at(r.a), end: endOf(r), text: r.text, at: r.at }))
}

/**
 * 새 글을 마크다운 서식대로 넣기 (minimalTextSplices) — 바뀐 자리의 새 글 조각이 들어갈 run 과 서식 비트가 다르면 서식만 다른
 * 글자 모양 run 으로 가른다. 굵은 글·위첨자 끝에 붙인 글이 그 run 서식을 물려받던 것("**제목** 수정" → 굵게 "수정")
 */
export interface InsertStyle {
  /** 새 평문 글자마다 서식 비트 (styledInline flags 를 글자마다 편 것) */
  flags: number[]
  /** 원본 마크다운에 보이던 서식 비트 — 이 비트만 맞춘다(마크다운에 안 보이는 구조 서식은 run 그대로) */
  known: number
  /** 글자 모양 id → 서식 비트 / 서식 비트만 다른 글자 모양 id (header charPr — char-pr.ts) */
  flagsOf(charPr: string): number | undefined
  variant(charPr: string, flags: number): string | undefined
  /** 맞는 글자 모양을 못 구해 run 서식 그대로 둔 조각 수 (호출자가 부분 적용으로 알린다) */
  missed?: number
}

/** 조각(segs)·서식 비트(flags)를 글자마다 편다 — InsertStyle.flags */
export function flagsPerChar(segs: string[], flags: number[]): number[] {
  const out: number[] = []
  segs.forEach((seg, k) => { for (let i = 0; i < seg.length; i++) out.push(flags[k]) })
  return out
}

/** 원문 위치 pos 를 감싸는 run 여는 태그 — 문단 시작부터 run 여닫음을 세어 가장 안쪽 (못 찾으면 undefined) */
function runOpenAt(xml: string, from: number, pos: number): { start: number; tag: string; prefix: string } | undefined {
  const stack: Array<{ start: number; tag: string; prefix: string }> = []
  for (const m of xml.slice(from, pos).matchAll(/<(\/?)(?:(\w+):)?run\b[^>]*?(\/?)>/g)) {
    if (m[3]) continue
    if (m[1]) stack.pop()
    else stack.push({ start: from + m.index!, tag: m[0], prefix: m[2] ?? "" })
  }
  return stack[stack.length - 1]
}

/**
 * 글을 싣는 splice 하나를 서식대로 가른다 — 새 글 조각마다 바라는 비트((run 비트 − 보이는 비트) + 조각의 보이는 비트)가 run 과 다르면
 * 그 비트의 글자 모양 run 으로. 다를 게 없으면 null (원래 splice 그대로)
 */
function styleSplice(sp: SpliceEdit, text: string, at: number, para: ScanParagraph, xml: string, style: InsertStyle): SpliceEdit[] | null {
  const run = runOpenAt(xml, para.start, sp.start)
  const charPr: string | undefined = run ? /\bcharPrIDRef="(\d{1,10})"/.exec(run.tag)?.[1] : undefined
  const runFlags: number | undefined = charPr !== undefined ? style.flagsOf(charPr) : undefined
  if (!run || charPr === undefined || runFlags === undefined) return null
  // 조각: 같은 바라는 글자 모양끼리
  const pieces: Array<{ text: string; charPr: string }> = []
  for (let k = 0; k < text.length; k++) {
    const f = style.flags[at + k] ?? 0
    const want: number = (runFlags & ~style.known) | (f & style.known)
    let id = charPr
    if (want !== runFlags) {
      const v = style.variant(charPr, want)
      if (v === undefined) style.missed = (style.missed ?? 0) + 1
      else id = v
    }
    const last = pieces[pieces.length - 1]
    if (last && last.charPr === id) last.text += text[k]
    else pieces.push({ text: text[k], charPr: id })
  }
  if (pieces.every(p => p.charPr === charPr)) return null
  const P = run.prefix ? `${run.prefix}:` : ""
  const t = para.tRanges.find(r => !r.selfClosing && r.contentStart <= sp.start && sp.start <= r.contentEnd)
  if (!t) return null
  const tOpen = xml.slice(xml.lastIndexOf("<", t.contentStart - 1), t.contentStart)
  const runWith = (id: string, body: string): string =>
    `${run.tag.replace(/\bcharPrIDRef="\d{1,10}"/, `charPrIDRef="${id}"`)}<${P}t>${escapeXmlText(body)}</${P}t></${P}run>`
  // 새 글 끝이 run 끝(hp:t 끝 바로 뒤 run 닫힘)이면 다른 서식 꼬리 조각은 run 뒤에 새 run 으로 — 빈 run 을 남기지 않게
  const tail = `</${P}t></${P}run>`
  let k = pieces.length
  while (k > 0 && pieces[k - 1].charPr !== charPr) k--
  if (k < pieces.length && sp.end === t.contentEnd && xml.startsWith(tail, sp.end)) {
    const head = pieces.slice(0, k)
    const out: SpliceEdit[] = [{ start: sp.start, end: sp.end, replacement: inline(head) }]
    out.push({ start: sp.end + tail.length, end: sp.end + tail.length, replacement: pieces.slice(k).map(p => runWith(p.charPr, p.text)).join("") })
    return out
  }
  return [{ start: sp.start, end: sp.end, replacement: inline(pieces) }]
  /** run 안 자리의 글 — 다른 서식 조각은 run 을 닫고 새 run 으로 넣은 뒤 원래 run·hp:t 를 다시 연다 */
  function inline(list: typeof pieces): string {
    return list.map(p => p.charPr === charPr ? escapeXmlText(p.text) : `</${P}t></${P}run>${runWith(p.charPr, p.text)}${run!.tag}${tOpen}`).join("")
  }
}

/**
 * HWPX 문단의 바뀐 자리만 고치는 splice: hp:t 이음 글과 IR 평문을 맞대어 diff 범위를 원문 좌표로 옮긴다. 고치지 않은
 * run(굵게·색)·균등 띄어쓰기는 그대로, 서식 조각이 같은 수면 조각마다 제 run 에 쓴다. hp:t 안에 엔티티·탭 요소나 PUA 기호가 있으면
 * 글자별 원문 범위 좌표계(paraTCharMap)로. 맞대지 못하면 null (호출자가 문단 통째 쓰기 buildParagraphSplices 로)
 */
export function minimalTextSplices(
  para: ScanParagraph, xml: string, origPlain: string, newPlain: string, origSegs?: string[], newSegs?: string[], style?: InsertStyle,
): SpliceEdit[] | null {
  const raw = paraTText(para, xml)
  const map = raw === null || hasPua(raw) ? paraTCharMap(para, xml) : null
  const edits = alignedTextEdits(map ? map.text : raw!, origPlain, newPlain, origSegs, newSegs)
  if (!edits || edits.length === 0) return null
  const out: SpliceEdit[] = []
  for (const e of edits) {
    const sp = map ? buildMappedRangeSplices(map, e.start, e.end, e.text) : buildRangeSplices(para, xml, e.start, e.end, e.text)
    if (!sp) return null
    // 글을 싣는 첫 splice 만 서식대로 가른다 (나머지는 지우기)
    const styled = style && e.text && e.at !== undefined ? styleSplice(sp[0], e.text, e.at, para, xml, style) : null
    out.push(...(styled ?? [sp[0]]), ...sp.slice(1))
  }
  return out
}
