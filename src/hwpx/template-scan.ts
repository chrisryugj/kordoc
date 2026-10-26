/**
 * 부서 서식 견본 HWPX 해부 (generate --template).
 *
 * section0 최상위 문단을 내용으로 역할을 나누고, 역할마다 처음 나온 문단을 "원형"으로 남긴다:
 *   제목표(title)·부제(subtitle, - … -)·담당 줄(contact)·요약 상자(summary)·장 띠(chapter, Ⅰ|제목)·참고 띠(band, 참고N|제목)
 *   ·데이터 표(table)·항목 L0~L3(□ ○ - ·)·참고(ref, ※)·기호 소제목(sym:▶ sym:【 …)·본문(body, 부호 없는 문단).
 * 구역 정의(secPr)와 쪽 단위 컨트롤(단 정의·머리말·꼬리말·쪽 번호)은 원형에서 걷어 head 로 모은다 — 생성 문서 첫 문단에
 * 한 번만 다시 심는다(원형을 여러 번 복제해도 구역 정의가 하나뿐이게). 줄 배치 캐시(linesegarray)와 복제하면 안 되는
 * 필드(누름틀·하이퍼링크)·책갈피·각주·미주도 걷는다 — 문단마다 복제되면 짝이 깨지거나 개체 id 가 겹친다.
 *
 * 문자열 기반(정규식 + findElementEnd) — DOM 직렬화는 접두사·속성 순서를 바꾸어 원형을 그대로 복제하려는 목적과 맞지 않는다.
 * 견본은 신뢰할 수 없는 입력이라 호출부(gen-from-template)가 DOM 으로 먼저 정형성을 확인하고, 여기 정규식은 모두
 * 겹침 없는 문자 부류·길이 상한으로 역추적이 선형이게 쓴다.
 */

import { findElementEnd, applySplices, type SpliceEdit } from "../roundtrip/source-map.js"
import { topLevelParagraphs, markerClass } from "../roundtrip/structure-edit.js"
import { mapPuaText } from "../shared/pua.js"
import { escapeTextXml } from "./gen-ids.js"

// ─── XML 원자 ─────────────────────────────────────────

/** 요소 범위 — start: '<' 위치, openEnd: 여는 태그 끝, end: 요소 끝 */
export interface El { name: string; start: number; openEnd: number; end: number; selfClosing: boolean }

const local = (name: string): string => name.replace(/^[^:]+:/, "")
/** 여는 태그 — 이름은 XML 이름 꼴, 속성 구간은 겹침 없는 부류(따옴표 값 | 그 밖 글자 | "/>" 아닌 '/') */
const OPEN_TAG = /<([\w.-]+(?::[\w.-]+)?)(?:"[^"]*"|'[^']*'|[^>"'/]|\/(?!>))*(\/?)>/y

/** lt 위치의 요소 하나 (자기 닫힘 포함). 못 읽으면 null */
export function elementAt(xml: string, lt: number): El | null {
  OPEN_TAG.lastIndex = lt
  const m = OPEN_TAG.exec(xml)
  if (!m) return null
  const openEnd = lt + m[0].length
  if (m[2] === "/") return { name: m[1], start: lt, openEnd, end: openEnd, selfClosing: true }
  const end = findElementEnd(xml, lt)
  return end < 0 ? null : { name: m[1], start: lt, openEnd, end, selfClosing: false }
}

/** 직계 자식 요소 (텍스트·주석 건너뜀) */
export function childElements(xml: string, el: El): El[] {
  if (el.selfClosing) return []
  const out: El[] = []
  const closeAt = el.end - `</${el.name}>`.length
  let pos = el.openEnd
  while (pos < closeAt) {
    const lt = xml.indexOf("<", pos)
    if (lt < 0 || lt >= closeAt || xml.startsWith("</", lt)) break
    if (xml.startsWith("<!--", lt) || xml.startsWith("<?", lt)) { const gt = xml.indexOf(">", lt); if (gt < 0) break; pos = gt + 1; continue }
    const ch = elementAt(xml, lt)
    if (!ch) break
    out.push(ch)
    pos = ch.end
  }
  return out
}

const childBy = (xml: string, el: El, name: string): El[] => childElements(xml, el).filter((c) => local(c.name) === name)

/** 이름(로컬명)이 names 인 요소를 모두 걷는다 — 정규식 대신 indexOf + 요소 끝 찾기로 선형 */
export function removeElements(xml: string, names: string[]): string {
  const splices: SpliceEdit[] = []
  const re = new RegExp(`<(?:\\w+:)?(?:${names.join("|")})(?=[\\s/>])`, "g")
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) {
    const el = elementAt(xml, m.index)
    if (!el) break
    splices.push({ start: el.start, end: el.end, replacement: "" })
    re.lastIndex = el.end
  }
  return splices.length ? applySplices(xml, splices) : xml
}

const ENTITY: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" }
function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,8}|#\d{1,10}|\w{1,10});/gi, (m, e: string) => {
    if (e[0] !== "#") return ENTITY[e] ?? m
    const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
    return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "�"
  })
}

const maxOf = (xs: number[]): number => xs.reduce((a, b) => (b > a ? b : a), 0)

// ─── 문단 run 모형 ────────────────────────────────────

/** <hp:t> 안 조각 — xml 이 null 이면 글자, 아니면 인라인 요소(탭·전각 빈칸 …)와 그 표시 글자 */
interface Tok { s: string; xml: string | null }
interface RunPart { name: string; el: El; toks: Tok[] }
interface Run { charPr: string; el: El; parts: RunPart[] }
export interface ParaModel { el: El; runs: Run[] }

const INLINE_CH: Record<string, string> = { tab: "\t", fwSpace: " ", nbSpace: " ", lineBreak: "\n", hyphen: "-" }

export function parsePara(xml: string, p: El): ParaModel {
  const runs: Run[] = []
  for (const r of childBy(xml, p, "run")) {
    const charPr = /\bcharPrIDRef="(\d+)"/.exec(xml.slice(r.start, r.openEnd))?.[1] ?? "0"
    const parts: RunPart[] = []
    for (const c of childElements(xml, r)) {
      const name = local(c.name)
      const toks: Tok[] = []
      if (name === "t" && !c.selfClosing) {
        for (const piece of xml.slice(c.openEnd, c.end - `</${c.name}>`.length).split(/(<[^>]{1,4096}>)/)) {
          if (!piece) continue
          if (piece[0] === "<") toks.push({ s: INLINE_CH[local(/^<\/?([^\s/>]+)/.exec(piece)?.[1] ?? "")] ?? "", xml: piece })
          else toks.push({ s: decodeXml(piece), xml: null })
        }
      }
      parts.push({ name, el: c, toks })
    }
    runs.push({ charPr, el: r, parts })
  }
  return { el: p, runs }
}

/** 문단 최상위 run 의 글 (표 칸 글은 빼고) */
export function paraPlain(m: ParaModel): string {
  return m.runs.map((r) => r.parts.map((p) => p.toks.map((t) => t.s).join("")).join("")).join("")
}

// ─── 항목 부호 ─────────────────────────────────────────

/**
 * 부호 부류 → 역할. 부류는 패치의 같은 부호 문단 복제(structure-edit markerClass)와 같은 갈래를 쓴다 —
 * 견본 고쳐 쓰기(patch)와 견본으로 새로 쓰기(generate --template)가 같은 문단을 같은 부호로 본다.
 */
const FAMILY_ROLE: Record<string, RoleKey> = {
  "□": "L0", "■": "L0", "○": "L1", "●": "L1", "-": "L2", "▪": "L2", "ㆍ": "L3", "▸": "L3", "※": "ref",
}
/** markerClass 갈래 밖의 소제목 부호 — 기호(\p{S})와 여는 괄호 【〔〈《. ( [ 「 “ 는 본문 첫 글자로 흔해 뺀다 */
const SYM_EXTRA = /^(?:\p{S}|[【〔〈《])$/u
/** 제목 밑 부제 "- … -" — 줄표 항목이 아니다 */
export const SUBTITLE_RE = /^-\s.*\s-$/u

export type RoleKey = "title" | "subtitle" | "contact" | "summary" | "chapter" | "band" | "table" | "body" | "ref" | "L0" | "L1" | "L2" | "L3" | `sym:${string}`

/** 문단 글 첫 부호의 역할 — 부호가 없으면 null. 한컴 PUA 글머리(󰏚 등)는 표준 글자로 바꿔 본다 */
export function lineRole(plain: string): RoleKey | null {
  const t = mapPuaText(plain.replace(/^[\s　]+/, ""))
  if (!t || SUBTITLE_RE.test(t.trim())) return null
  const cls = markerClass(t)
  if (FAMILY_ROLE[cls]) return FAMILY_ROLE[cls]
  if (cls && !/^[(]?[NK][.)]$|^[①❶㉮]$|^Ⅰ\.$|^붙임$/.test(cls)) return `sym:${cls}`
  const ch = String.fromCodePoint(t.codePointAt(0)!)
  return SYM_EXTRA.test(ch) && !/^[□■○●※]$/.test(ch) ? `sym:${ch}` : null
}

/** 부호로 보는 글자 — 원형의 부호 run 을 찾을 때 */
export function isMarkerChar(ch: string): boolean {
  return markerClass(`${ch} `) !== "" || SYM_EXTRA.test(ch)
}

// ─── 문단 채우기 ───────────────────────────────────────

export interface FillOptions {
  /** 원형 첫 부호(앞 빈칸 뒤)를 부호로 남긴다 — 부호 run 서식 그대로 */
  marker?: boolean
  /** 부호 글자를 바꾼다(가까운 단계 원형을 빌릴 때). 원형에 부호가 없으면 글 앞에 붙인다 */
  glyph?: string
  /** 쪽·단 나눔을 원형대로 둔다 (참고 띠 — 새 쪽에서 시작) */
  keepBreak?: boolean
}

/** XML 1.0 이 허용하지 않는 비문자(U+FFFE·U+FFFF)와 짝 없는 대리 문자 — 한글이 파일을 못 연다 */
export function dropNonChars(text: string): string {
  return text.replace(/[￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
}

/** 본문 run 글 이스케이프 — 줄바꿈은 <hp:lineBreak/>, 묶음 빈칸은 <hp:nbSpace/> */
export function bodyText(text: string): string {
  return escapeTextXml(dropNonChars(text).replace(/\t/g, " ")).replace(/\n/g, "<hp:lineBreak/>")
}

/** 쪽·단 나눔 끄기 (원형이 쪽 첫 문단이어도 복제본이 쪽을 넘기지 않게) */
export function resetBreaks(pXml: string): string {
  const end = pXml.indexOf(">") + 1
  return pXml.slice(0, end).replace(/\b(pageBreak|columnBreak)="1"/g, "$1=\"0\"") + pXml.slice(end)
}

/** 복제해도 되는 run 안 개체 — 단 정의(colPr)뿐. 필드·책갈피·각주·그림은 복제하면 짝·id 가 깨진다 */
function isSafePart(xml: string, part: RunPart): boolean {
  if (part.name !== "ctrl") return false
  const kids = childElements(xml, part.el)
  return kids.length === 1 && local(kids[0].name) === "colPr"
}

/**
 * 원형 문단을 복제해 글만 바꾼다. 앞 빈칸(+부호+빈칸)은 원형 run 그대로 두고, 나머지 글은 원형에서 글이 가장 많은 run
 * 의 글자 모양 한 run 으로 넣는다(견본 본문 글자 모양). 개체는 첫 글자(부호) 앞의 단 정의만 두고 나머지는 버린다.
 */
export function fillParagraph(pXml: string, text: string, opts: FillOptions = {}): string {
  const p = elementAt(pXml, 0)
  if (!p) return pXml
  const m = parsePara(pXml, p)
  const plain = paraPlain(m)
  const ws = /^[\s　]*/.exec(plain)![0].length
  let prefixLen = ws, mStart = -1, mLen = 0
  if (opts.marker && ws < plain.length) {
    const cp = String.fromCodePoint(plain.codePointAt(ws)!)
    if (isMarkerChar(mapPuaText(cp))) {
      mStart = ws; mLen = cp.length
      prefixLen = ws + mLen + /^[\s　]*/.exec(plain.slice(ws + mLen))![0].length
    }
  }
  if (opts.glyph && mStart < 0) text = `${opts.glyph} ${text}`
  const objLimit = mStart >= 0 ? mStart : ws

  // 본문 글자 모양 — 부호 뒤 글이 가장 많은 run (없으면 부호 run, 그것도 없으면 마지막 run)
  let bodyCharPr = "", bestN = 0, markerCharPr = "", pos = 0
  for (const run of m.runs) {
    let n = 0
    for (const part of run.parts) for (const tok of part.toks) {
      for (let i = 0; i < tok.s.length; i++, pos++) {
        if (pos === mStart) markerCharPr = run.charPr
        if (pos >= prefixLen && tok.xml === null && /\S/.test(tok.s[i])) n++
      }
    }
    if (n > bestN) { bestN = n; bodyCharPr = run.charPr }
  }
  if (!bodyCharPr) bodyCharPr = markerCharPr || m.runs.at(-1)?.charPr || "0"
  const bodyRun = text ? `<hp:run charPrIDRef="${bodyCharPr}"><hp:t>${bodyText(text)}</hp:t></hp:run>` : `<hp:run charPrIDRef="${bodyCharPr}"/>`

  let out = ""
  let inserted = false
  pos = 0
  for (const run of m.runs) {
    if (inserted) break
    let inner = ""
    for (const part of run.parts) {
      if (part.name !== "t") { if (pos <= objLimit && isSafePart(pXml, part)) inner += pXml.slice(part.el.start, part.el.end); continue }
      let t = ""
      for (const tok of part.toks) {
        if (pos >= prefixLen) break
        if (tok.xml !== null) {
          // 글자 폭이 있는 인라인(탭·전각 빈칸)만 — 형광펜·변경 추적 표지는 짝이 깨지므로 버린다
          if (tok.s) { t += tok.xml; pos += tok.s.length }
          continue
        }
        let take = tok.s.slice(0, prefixLen - pos)
        if (opts.glyph && mStart >= pos && mStart < pos + take.length) {
          take = take.slice(0, mStart - pos) + opts.glyph + take.slice(mStart - pos + mLen)
        }
        pos += Math.min(tok.s.length, prefixLen - pos)
        t += escapeTextXml(take)
      }
      if (t) inner += `<hp:t>${t}</hp:t>`
    }
    if (inner) out += `<hp:run charPrIDRef="${run.charPr}">${inner}</hp:run>`
    if (pos >= prefixLen) { out += bodyRun; inserted = true }
  }
  if (!inserted) out += bodyRun
  const open = pXml.slice(0, p.openEnd)
  return (opts.keepBreak ? open : resetBreaks(open)) + out + `</${p.name}>`
}

// ─── 표 ────────────────────────────────────────────────

export interface CellInfo {
  el: El
  row: number; col: number; rowSpan: number; colSpan: number
  width: number; height: number
  /** 칸 문단 범위 (subList 직계) */
  paras: El[]
  text: string
  /** 칸 글 최대 글자 크기 (HWPUNIT) */
  maxH: number
  /** 칸 첫 문단의 paraPrIDRef */
  paraPr: string
}
export interface TableInfo { el: El; rowCnt: number; colCnt: number; width: number; cells: CellInfo[]; trs: El[] }

const attrNum = (tag: string, name: string): number => Number(new RegExp(`\\b${name}="(-?\\d{1,10})"`).exec(tag)?.[1] ?? 0)

/** run 글자 크기 최댓값 (글 있는 run 만) */
function paraMaxH(m: ParaModel, heights: Map<string, number>): number {
  let max = 0
  for (const r of m.runs) {
    if (r.parts.some((p) => p.toks.some((t) => t.xml === null && /\S/.test(t.s)))) max = Math.max(max, heights.get(r.charPr) ?? 0)
  }
  return max
}

export function tableInfo(xml: string, tbl: El, heights: Map<string, number>): TableInfo {
  const open = xml.slice(tbl.start, tbl.openEnd)
  const trs = childBy(xml, tbl, "tr")
  const cells: CellInfo[] = []
  for (const tr of trs) {
    for (const tc of childBy(xml, tr, "tc")) {
      const kids = childElements(xml, tc)
      const tag = (n: string) => { const k = kids.find((c) => local(c.name) === n); return k ? xml.slice(k.start, k.openEnd) : "" }
      const sub = kids.find((c) => local(c.name) === "subList")
      const paras = sub ? childBy(xml, sub, "p") : []
      const models = paras.map((p) => parsePara(xml, p))
      const addr = tag("cellAddr"), span = tag("cellSpan"), sz = tag("cellSz")
      cells.push({
        el: tc, paras,
        row: attrNum(addr, "rowAddr"), col: attrNum(addr, "colAddr"),
        rowSpan: Math.max(1, attrNum(span, "rowSpan")), colSpan: Math.max(1, attrNum(span, "colSpan")),
        width: attrNum(sz, "width"), height: attrNum(sz, "height"),
        text: models.map(paraPlain).join("\n").trim(),
        maxH: maxOf(models.map((mm) => paraMaxH(mm, heights))),
        paraPr: paras[0] ? /\bparaPrIDRef="(\d+)"/.exec(xml.slice(paras[0].start, paras[0].openEnd))?.[1] ?? "0" : "0",
      })
    }
  }
  const sz = childElements(xml, tbl).find((c) => local(c.name) === "sz")
  return {
    el: tbl, trs, cells,
    rowCnt: attrNum(open, "rowCnt"), colCnt: attrNum(open, "colCnt"),
    width: sz ? attrNum(xml.slice(sz.start, sz.openEnd), "width") : cells.filter((c) => c.row === 0).reduce((a, c) => a + c.width, 0),
  }
}

/** 문단 안 최상위 표 하나 (run 직계) */
export function hostTable(xml: string): El | null {
  const p = elementAt(xml, 0)
  if (!p) return null
  for (const r of childBy(xml, p, "run")) for (const c of childElements(xml, r)) if (local(c.name) === "tbl") return c
  return null
}

// ─── 역할 판정 ─────────────────────────────────────────

/** 참고 띠 첫 칸 — "참고1" "<참고 2>" "별첨" "붙임" */
export const BAND_LABEL_RE = /^[<＜\[［]?(참고|별첨|붙임)\d*[>＞\]］]?$/u
/** 장 띠 첫 칸 — "Ⅰ" "[Ⅱ]" "1." "가." */
const CHAPTER_LABEL_RE = /^[\[［]?([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|\d{1,2}|[가-하])[.)\]］]?$/u
/** 담당 줄 — 전화 기호·담당·작성 일자 (견본 칸 판정용) */
export const CONTACT_RE = /☎|담당자?\s*[:：]|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\./u

const squash = (s: string) => s.replace(/\s+/g, "")

export function isBandTable(t: TableInfo): boolean {
  const first = t.cells.find((c) => c.row === 0 && c.col === 0)
  return t.rowCnt === 1 && t.colCnt >= 2 && t.colCnt <= 4 && !!first && BAND_LABEL_RE.test(squash(first.text))
}
function isChapterTable(t: TableInfo): boolean {
  const first = t.cells.find((c) => c.row === 0 && c.col === 0)
  return t.rowCnt === 1 && t.colCnt >= 2 && t.colCnt <= 4 && !!first && CHAPTER_LABEL_RE.test(squash(first.text))
    && t.cells.some((c) => c !== first && c.text.trim() !== "")
}

/** 쪽 단위 컨트롤 — 첫 문단으로 옮긴다(중복 제거). 자리 의존(쪽 번호 새로·감추기)은 첫 문단 것만 */
const PAGE_CTRLS = new Set(["colPr", "header", "footer", "pageNum"])
const FIRST_PAGE_CTRLS = new Set(["pageHiding", "newNum", "pageNumCtrl"])
/** 복제하면 안 되는 컨트롤 — 필드(누름틀·하이퍼링크) 짝, 책갈피, 각주·미주(개체 번호·instId) */
const UNSAFE_CTRLS = new Set(["fieldBegin", "fieldEnd", "bookmark", "footNote", "endNote"])
const DEFAULT_COLPR = `<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>`
/** 원형 크기 상한 — 문단 원형은 복제 횟수만큼 커지므로 작게, 표 원형은 칸만 복제하므로 넉넉히 */
const PROTO_MAX = 64 * 1024
const TABLE_PROTO_MAX = 1024 * 1024

export interface TemplateScan {
  /** 역할 → 원형 최상위 문단 XML (구역 정의·쪽 컨트롤·필드·줄 배치 캐시를 걷은 것) */
  protos: Map<RoleKey, string>
  /** 구역 정의 + 쪽 단위 컨트롤 — 생성 문서 첫 문단 첫 run 에 심는다 */
  head: string
  headCharPr: string
  /** 제목표 안에 담당 줄 칸이 있다 */
  contactInTitle: boolean
  /** 참고 띠 아래 첫 항목 문단의 역할 (견본 참고 쪽 항목 서식 — ▶ 등) */
  bandItem: RoleKey | null
  /** charPr id → 글자 크기 (HWPUNIT) */
  heights: Map<string, number>
  /** paraPr id → 가로 정렬 (LEFT·CENTER·DISTRIBUTE …) */
  aligns: Map<string, string>
}

export function charHeights(headerXml: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of headerXml.matchAll(/<hh:charPr\b[^>]{0,4096}>/g)) {
    const id = /\bid="(\d{1,10})"/.exec(m[0])?.[1], h = /\bheight="(\d{1,10})"/.exec(m[0])?.[1]
    if (id && h) out.set(id, Number(h))
  }
  return out
}

/** paraPr id → 가로 정렬 */
export function paraAligns(headerXml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of headerXml.matchAll(/<hh:paraPr\b[^>]{0,4096}>/g)) {
    const id = /\bid="(\d{1,10})"/.exec(m[0])?.[1]
    if (!id) continue
    const close = headerXml.indexOf("</hh:paraPr>", m.index!)
    const body = headerXml.slice(m.index!, close < 0 ? m.index! + m[0].length : close)
    out.set(id, /<hh:align\b[^>]{0,512}\bhorizontal="(\w{1,20})"/.exec(body)?.[1] ?? "JUSTIFY")
  }
  return out
}

interface ParaInfo { xml: string; tbl: TableInfo | null; plain: string; role: RoleKey | null; maxH: number; drawing: boolean; objs: number }

/** 그림·도형 개체 (표 아닌 것) — 이런 문단은 원형으로 쓰지 않는다 */
const DRAWING = new Set(["pic", "rect", "ellipse", "arc", "polygon", "curve", "line", "connectLine", "container", "textart", "ole", "equation", "chart", "video"])

const TOC_HEAD = /^(목차|차례|contents)$/i
const CHAPTER_LINE = /^(?:[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]|(?:I{1,3}|IV|VI{0,3}|IX|X)\s*[.．]|제\s*\d+\s*장)/

/**
 * 목차 상자 (1×1) — 첫 줄이 "목 차"이거나, 바로 앞 문단이 "목 차" 제목이거나, 장 번호(Ⅰ.·제1장)로 시작하는 줄이 둘 이상.
 * 표지·목차 쪽이 앞에 있는 견본(개조식 계획서)에서 쪽 높이 목차 상자를 요약 상자로 쓰지 않게
 */
function isTocBox(infos: ParaInfo[], i: number): boolean {
  const lines = (infos[i].tbl?.cells[0]?.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
  if (lines[0] && TOC_HEAD.test(lines[0].replace(/\s+/g, ""))) return true
  const prev = infos[i - 1]
  if (prev && TOC_HEAD.test((prev.tbl ? prev.tbl.cells.map((c) => c.text).join("") : prev.plain).replace(/\s+/g, ""))) return true
  return lines.filter((l) => CHAPTER_LINE.test(l)).length >= 2
}

export function scanTemplate(sectionXml: string, headerXml: string): TemplateScan {
  const heights = charHeights(headerXml)
  let secPr = "", headCharPr = "0"
  const ctrls: string[] = []
  const seen = new Set<string>()

  const infos: ParaInfo[] = topLevelParagraphs(sectionXml).map(({ start, end }, idx) => {
    const frag = sectionXml.slice(start, end)
    const p = elementAt(frag, 0)
    if (!p) return { xml: "", tbl: null, plain: "", role: null, maxH: 0, drawing: true, objs: 1 }
    const cut: SpliceEdit[] = []
    for (const r of childBy(frag, p, "run")) {
      for (const c of childElements(frag, r)) {
        const nm = local(c.name)
        if (nm === "secPr") {
          if (!secPr) { secPr = frag.slice(c.start, c.end); headCharPr = /\bcharPrIDRef="(\d+)"/.exec(frag.slice(r.start, r.openEnd))?.[1] ?? "0" }
          cut.push({ start: c.start, end: c.end, replacement: "" })
        } else if (UNSAFE_CTRLS.has(nm)) {
          cut.push({ start: c.start, end: c.end, replacement: "" })
        } else if (nm === "ctrl") {
          const k = childElements(frag, c)[0]
          const kind = k ? local(k.name) : ""
          if (UNSAFE_CTRLS.has(kind)) { cut.push({ start: c.start, end: c.end, replacement: "" }); continue }
          if (!PAGE_CTRLS.has(kind) && !FIRST_PAGE_CTRLS.has(kind)) continue
          const key = kind + (/\bapplyPageType="(\w{1,20})"/.exec(frag.slice(k.start, k.openEnd))?.[1] ?? "")
          if ((PAGE_CTRLS.has(kind) || idx === 0) && !seen.has(key)) { seen.add(key); ctrls.push(frag.slice(c.start, c.end)) }
          cut.push({ start: c.start, end: c.end, replacement: "" })
        }
      }
    }
    const xml = removeElements(cut.length ? applySplices(frag, cut) : frag, ["linesegarray"])
    const pEl = elementAt(xml, 0)!
    const model = parsePara(xml, pEl)
    const objs = model.runs.flatMap((r) => r.parts.filter((pt) => pt.name !== "t" && !(pt.name === "ctrl" && isSafePart(xml, pt))))
    const plain = paraPlain(model)
    const tbls = objs.filter((o) => o.name === "tbl")
    const tbl = tbls.length === 1 && !plain.trim() && objs.length === 1 ? tableInfo(xml, tbls[0].el, heights) : null
    return {
      xml, tbl, plain, objs: objs.length,
      role: objs.length ? null : lineRole(plain),
      maxH: tbl ? maxOf(tbl.cells.filter((c) => !CONTACT_RE.test(c.text)).map((c) => c.maxH)) : paraMaxH(model, heights),
      drawing: objs.some((o) => DRAWING.has(o.name)) || tbls.length > 1,
    }
  })
  if (!secPr) throw new Error("견본 section0 에 구역 정의(secPr)가 없습니다 — 한글에서 저장한 HWPX 인지 확인하세요")
  if (!seen.has("colPr")) ctrls.unshift(DEFAULT_COLPR)

  const protos = new Map<RoleKey, string>()
  const set = (k: RoleKey, i: number) => {
    if (protos.has(k) || infos[i].xml.length > (k === "table" ? TABLE_PROTO_MAX : PROTO_MAX)) return
    protos.set(k, infos[i].xml)
  }

  // 본문 시작 = 첫 항목 부호 문단 또는 장·참고 띠. 그 앞(머리)에서 제목·부제·요약·담당 줄을 고른다
  let bodyStart = infos.findIndex((x) => (x.role !== null && !x.role.startsWith("sym:")) || (x.tbl !== null && (isBandTable(x.tbl) || isChapterTable(x.tbl))))
  if (bodyStart < 0) bodyStart = infos.length
  const head = infos.slice(0, bodyStart).map((x, i) => ({ x, i })).filter(({ x }) => !x.drawing && (x.tbl ? x.tbl.cells.some((c) => c.text) : x.plain.trim()))
  let titleIdx = -1
  for (const { x, i } of head) if (x.maxH > 0 && (titleIdx < 0 || x.maxH > infos[titleIdx].maxH)) titleIdx = i
  let contactInTitle = false
  if (titleIdx >= 0) {
    set("title", titleIdx)
    const t = infos[titleIdx].tbl
    contactInTitle = !!t && t.cells.some((c) => CONTACT_RE.test(c.text))
  }
  const subIdx = head.find(({ x, i }) => i !== titleIdx && !x.tbl && x.objs === 0 && SUBTITLE_RE.test(mapPuaText(x.plain.trim())))?.i ?? -1
  if (subIdx >= 0) set("subtitle", subIdx)
  const summaryIdx = head.find(({ x, i }) => i > titleIdx && x.tbl?.rowCnt === 1 && x.tbl.colCnt === 1 && !CONTACT_RE.test(x.tbl.cells[0]?.text ?? "") && !isTocBox(infos, i))?.i ?? -1
  if (summaryIdx >= 0) set("summary", summaryIdx)
  const contactIdx = contactInTitle ? -1
    : head.find(({ x, i }) => i !== titleIdx && i !== summaryIdx && i !== subIdx && CONTACT_RE.test(x.tbl ? x.tbl.cells.map((c) => c.text).join(" ") : x.plain))?.i ?? -1
  if (contactIdx >= 0) set("contact", contactIdx)

  const dataTables: number[] = []
  let firstBand = -1
  let bandItem: RoleKey | null = null
  infos.forEach((x, i) => {
    if (i === titleIdx || i === summaryIdx || i === contactIdx || i === subIdx || x.drawing) return
    if (x.tbl) {
      if (isBandTable(x.tbl)) { set("band", i); if (firstBand < 0) firstBand = i }
      else if (isChapterTable(x.tbl)) set("chapter", i)
      else if (x.tbl.rowCnt >= 2 && x.tbl.colCnt >= 2) dataTables.push(i)
      return
    }
    if (x.objs) return
    if (x.role) {
      set(x.role, i)
      if (firstBand >= 0 && !bandItem) bandItem = x.role
    } else if (x.plain.trim() && i >= bodyStart) set("body", i)
  })
  // 데이터 표 원형 — 머리행이 병합 없이 꽉 찬 3행 이상 표를 먼저 (상자형 2×2 안내 틀을 피한다)
  const clean = dataTables.find((i) => {
    const t = infos[i].tbl!
    const head0 = t.cells.filter((c) => c.row === 0)
    return t.rowCnt >= 3 && head0.length === t.colCnt && head0.every((c) => c.text && c.rowSpan === 1)
  })
  if (clean !== undefined) set("table", clean)
  if (!protos.has("table")) for (const i of dataTables) set("table", i)

  return { protos, head: secPr + ctrls.join(""), headCharPr, contactInTitle, bandItem, heights, aligns: paraAligns(headerXml) }
}
