/**
 * HWP 5.x BodyText 섹션 → HWPX Contents/sectionN.xml.
 *
 * 문단(PARA_HEADER)마다 글(PARA_TEXT)을 글자 모양 구간(PARA_CHAR_SHAPE)으로 run 에 나누고, 확장 컨트롤 글자(8 WCHAR)는 순서대로 자식
 * CTRL_HEADER 를 하나씩 받아 그 자리에 요소로 쓴다. 인라인 컨트롤(탭·필드 끝·제목 차례)과 글자 컨트롤(줄바꿈·묶음/고정폭 빈칸·
 * 하이픈)은 hp:t 안 요소, 개체(표·그림·도형·수식)는 hp:t 와 같은 run 의 형제다. 줄 나눔 정보(PARA_LINE_SEG)는 hp:linesegarray.
 */

import { Cur, type RecNode, el, escText, color, bit, bits, pick, readParamSet, subSet, type Param, BORDER_TYPES, BORDER_WIDTHS, NUM_FORMATS } from "./util.js"
import { XML_DECL, NS, GRADATIONS } from "./header.js"
import { controlXml, listGroups, subListAttrs, type ConvertContext } from "./controls.js"
import { fieldEndXml } from "./fields.js"

export const TAG = {
  PARA_HEADER: 0x42, PARA_TEXT: 0x43, PARA_CHAR_SHAPE: 0x44, PARA_LINE_SEG: 0x45, PARA_RANGE_TAG: 0x46, CTRL_HEADER: 0x47,
  LIST_HEADER: 0x48, PAGE_DEF: 0x49, FOOTNOTE_SHAPE: 0x4a, PAGE_BORDER_FILL: 0x4b, SHAPE_COMPONENT: 0x4c, TABLE: 0x4d,
  CTRL_DATA: 0x57, MEMO_LIST: 0x5d,
} as const

/** 1 WCHAR 글자 컨트롤 */
const CHAR_CTRL = new Set([0, 10, 13, 24, 25, 26, 27, 28, 29, 30, 31])
/** 8 WCHAR 인라인 컨트롤 (자식 레코드 없음) */
const INLINE_CTRL = new Set([4, 5, 6, 7, 8, 9, 19, 20])

export function ctrlId(node: RecNode): string {
  const d = node.rec.data
  return d.length >= 4 ? String.fromCharCode(d[3], d[2], d[1], d[0]) : ""
}

/** 문단 목록(섹션 최상위·칸·글상자·머리말 등) */
export function paragraphsXml(nodes: RecNode[], ctx: ConvertContext): string {
  let out = ""
  for (const n of nodes) if (n.rec.tagId === TAG.PARA_HEADER) out += paragraphXml(n, ctx)
  return out
}

/** 글 토큰 — 글자, 인라인 요소(hp:t 안), 개체·컨트롤 요소(run 형제). cs 는 글자 스타일(영역 태그 종류 1) — 같은 run 안에서도 hp:t 를 따로 연다 */
type Tok = { pos: number; t: "text"; s: string; cs?: number } | { pos: number; t: "inline"; xml: string; mark?: boolean; cs?: number }
  | { pos: number; t: "ctrl"; xml: string; obj: boolean; def?: boolean }

function paragraphXml(p: RecNode, ctx: ConvertContext): string {
  const h = new Cur(p.rec.data)
  const nChars = h.u32() & 0x7fffffff
  h.u32() // 컨트롤 마스크
  const paraShape = h.u16(), styleId = h.u8(), breaks = h.u8()
  h.skip(6)
  const instanceId = p.rec.data.length >= 22 ? h.u32() : 0
  const merged = p.rec.data.length >= 24 ? h.u16() : 0

  const texts = p.kids.filter(k => k.rec.tagId === TAG.PARA_TEXT)
  const text = texts.length ? Buffer.concat(texts.map(k => k.rec.data)) : Buffer.alloc(0)
  const csNode = p.kids.find(k => k.rec.tagId === TAG.PARA_CHAR_SHAPE)
  const runs: Array<[number, number]> = []
  // 같은 글자 모양이 잇달아 오는 경계는 한글이 run 하나로 합쳐 저장한다 — 문단 끝(CR) 자리에서 시작하는 구간은 빈 run 으로 남긴다
  const crPos = text.length / 2 - 1
  if (csNode) for (const c = new Cur(csNode.rec.data); c.rest >= 8;) {
    const pos = c.u32(), id = c.u32()
    if (!runs.length || runs[runs.length - 1][1] !== id || pos >= crPos) runs.push([pos, id])
  }
  if (!runs.length) runs.push([0, 0])
  const ctrls = p.kids.filter(k => k.rec.tagId === TAG.CTRL_HEADER)
  const ranges = rangeTags(p.kids.find(k => k.rec.tagId === TAG.PARA_RANGE_TAG))
  const toks = tokenize(text, ctrls, ctx, new Set([...runs.map(r => r[0]), ...ranges.styles.flatMap(r => [r[0], r[1]])]), ranges.marks)
  for (const k of toks) if (k.t !== "ctrl") k.cs = ranges.styles.find(r => k.pos >= r[0] && k.pos < r[1])?.[2]

  const units = text.length / 2
  const hasCtrl = toks.some(t => t.t === "ctrl")
  let body = ""
  for (let i = 0; i < runs.length; i++) {
    const from = runs[i][0], to = i + 1 < runs.length ? runs[i + 1][0] : Math.max(units, nChars)
    let seg = toks.filter(t => t.pos >= from && t.pos < to)
    // 문단 끝(CR)만 담은 run — 문단에 개체·컨트롤이 있으면 빈 글 마디를 둔다(없으면 빈 run)
    if (!seg.length && i > 0 && from >= crPos && hasCtrl) seg = [{ pos: from, t: "text", s: "" }]
    body += runXml(runs[i][1], seg)
  }

  const ls = p.kids.find(k => k.rec.tagId === TAG.PARA_LINE_SEG)
  if (ls) {
    let segs = ""
    for (const c = new Cur(ls.rec.data); c.rest >= 36;) {
      segs += el("hp:lineseg", [["textpos", c.u32()], ["vertpos", c.i32()], ["vertsize", c.i32()], ["textheight", c.i32()],
        ["baseline", c.i32()], ["spacing", c.i32()], ["horzpos", c.i32()], ["horzsize", c.i32()], ["flags", c.u32()]])
    }
    body += `<hp:linesegarray>${segs}</hp:linesegarray>`
  }
  return el("hp:p", [["id", instanceId], ["paraPrIDRef", ctx.paraIds[paraShape] ?? paraShape], ["styleIDRef", styleId], ["pageBreak", bit(breaks, 2)],
    ["columnBreak", bit(breaks, 3)], ["merged", merged]], body)
}

/**
 * 영역 태그(PARA_RANGE_TAG: 시작·끝 위치, 종류 상위 8비트·데이터 하위 24비트) — 형광펜(종류 2, 데이터는 색)은 글자 위치마다 그 글자
 * 앞에 둘 인라인 요소로, 글자 스타일(종류 1, 데이터는 스타일 번호)은 [시작, 끝, 번호] 로
 */
function rangeTags(node: RecNode | undefined): { marks: Map<number, string[]>; styles: Array<[number, number, number]> } {
  const marks = new Map<number, string[]>(), styles: Array<[number, number, number]> = []
  if (!node) return { marks, styles }
  const add = (pos: number, xml: string, first: boolean): void => {
    const list = marks.get(pos) ?? []
    if (first) list.unshift(xml); else list.push(xml)
    marks.set(pos, list)
  }
  for (const c = new Cur(node.rec.data); c.rest >= 12;) {
    const start = c.u32(), end = c.u32(), tag = c.u32()
    if (end <= start) continue
    if (tag >>> 24 === 1) styles.push([start, end, tag & 0xffffff])
    if (tag >>> 24 !== 2) continue
    add(start, el("hp:markpenBegin", [["color", color(tag & 0xffffff)]]), false)
    add(end, "<hp:markpenEnd/>", true) // 같은 자리에서는 앞 영역을 닫고 연다
  }
  return { marks, styles }
}

/** 글 → 토큰. 글은 글자 모양 구간 경계(cuts)에서 끊는다 */
function tokenize(text: Buffer, ctrls: RecNode[], ctx: ConvertContext, cuts: Set<number>, marks: Map<number, string[]>): Tok[] {
  const toks: Tok[] = []
  const n = text.length / 2
  let ci = 0
  let buf = "", bufPos = 0
  const flush = (): void => { if (buf) toks.push({ pos: bufPos, t: "text", s: buf }); buf = "" }
  for (let i = 0; i < n;) {
    const c = text.readUInt16LE(i * 2)
    if (cuts.has(i)) flush()
    const mk = marks.get(i)
    if (mk) { flush(); for (const xml of mk) toks.push({ pos: i, t: "inline", xml, mark: true }) }
    if (c >= 32) {
      if (!buf) bufPos = i
      buf += String.fromCharCode(c)
      i++
      continue
    }
    flush()
    if (CHAR_CTRL.has(c)) {
      if (c === 10) toks.push({ pos: i, t: "inline", xml: "<hp:lineBreak/>" })
      else if (c === 24) toks.push({ pos: i, t: "inline", xml: "<hp:hypen/>" }) // 한글 저장 이름 그대로(hypen)
      else if (c === 30) toks.push({ pos: i, t: "inline", xml: "<hp:nbSpace/>" })
      else if (c === 31) toks.push({ pos: i, t: "inline", xml: "<hp:fwSpace/>" })
      i++
      continue
    }
    const data = text.subarray(i * 2 + 2, i * 2 + 14)
    if (INLINE_CTRL.has(c)) {
      if (c === 9) {
        const d = new Cur(data)
        const width = d.u32(), leader = d.u8(), type = d.u8()
        toks.push({ pos: i, t: "inline", xml: el("hp:tab", [["width", width], ["leader", leader], ["type", type]]) })
      } else if (c === 4) {
        toks.push({ pos: i, t: "ctrl", obj: false, xml: fieldEndXml(ctx.fields) })
      } else if (c === 8) {
        toks.push({ pos: i, t: "inline", xml: el("hp:titleMark", [["ignore", 1]]) })
      }
      i += 8
      continue
    }
    // 확장 컨트롤 — 자식 CTRL_HEADER 를 순서대로 하나
    const node = ctrls[ci++]
    if (node) {
      const r = controlXml(node, ctx)
      if (r) toks.push({ pos: i, t: "ctrl", obj: r.obj, xml: r.xml, def: r.def })
    }
    i += 8
  }
  flush()
  // 글 끝 너머에서 닫히는 영역은 마지막 글자 자리에서 닫는다(짝이 깨지지 않게)
  for (const [pos, list] of marks) if (pos >= n) for (const xml of list) toks.push({ pos: Math.max(0, n - 1), t: "inline", xml, mark: true })
  // 컨트롤 뒤 글 자리 — 바로 뒤(8 WCHAR 다음)에 아무것도 없으면(문단 끝) 빈 글을 둔다. 그 자리가 다음 글자 모양 구간이면 빈 hp:t 도
  // 다음 run 에 든다. 개체가 잇달아 오면(수식 둘) 사이에 빈 글이 없다
  for (let k = toks.length - 1; k >= 0; k--) {
    const o = toks[k]
    if (o.t === "ctrl" && toks[k + 1]?.pos !== o.pos + 8) toks.splice(k + 1, 0, { pos: o.pos + 8, t: "text", s: "" })
  }
  return toks
}

/**
 * run 하나 — 글·인라인 요소는 hp:t 로 묶는다(개체 뒤 빈 글은 tokenize 가 넣는다). 구역·단 정의는 제 run 에 두고
 * 뒤따르는 내용은 같은 글자 모양의 새 run 에서 시작한다(한글 2022 이상 저장 꼴)
 */
function runXml(charShape: number, toks: Tok[]): string {
  const open = `<hp:run charPrIDRef="${charShape}">`
  if (!toks.length) return el("hp:run", [["charPrIDRef", charShape]])
  let out = "", t: string | null = null, tcs: number | undefined
  const closeT = (): void => {
    if (t !== null) { const a = tcs === undefined ? "" : ` charStyleIDRef="${tcs}"`; out += t ? `<hp:t${a}>${t}</hp:t>` : `<hp:t${a}/>` }
    t = null
  }
  toks.forEach((k, i) => {
    if (k.t !== "ctrl" && t !== null && k.cs !== tcs) closeT()
    if (k.t !== "ctrl" && t === null) tcs = k.cs
    if (k.t === "text") t = (t ?? "") + escText(k.s)
    // 영역 표시(형광펜) 바로 뒤가 개체면 글 마디 밖, run 바로 아래에 둔다
    else if (k.t === "inline" && k.mark && toks[i + 1]?.t === "ctrl") { closeT(); out += k.xml }
    else if (k.t === "inline") t = (t ?? "") + k.xml
    else {
      closeT()
      out += k.xml
      const next = toks[i + 1]
      if (k.def && !(next?.t === "ctrl" && next.def)) out += "</hp:run>" + open
    }
  })
  closeT()
  // 정의 뒤 내용이 없으면 같은 글자 모양의 빈 run 이 남는다
  return (open + out + "</hp:run>").replace(`${open}</hp:run>`, el("hp:run", [["charPrIDRef", charShape]]))
}

/** 섹션 레코드 트리 → sectionN.xml */
export function sectionXml(top: RecNode[], ctx: ConvertContext): string {
  // 확장 바탕쪽(마지막 쪽·임의 쪽)은 구역 끝 — 마지막 문단 뒤 수준 1 LIST_HEADER 와 문단(트리에선 그 문단의 자식)이다. 글 폭·높이가
  // 0 인 묶음은 바탕쪽이 아니다(메모 글)
  const last = top.filter(n => n.rec.tagId === TAG.PARA_HEADER).at(-1)
  ctx.tailMasters = last ? listGroups(last.kids).filter(g => g.head.rec.data.length >= 20 && (g.head.rec.data.readUInt32LE(8) || g.head.rec.data.readUInt32LE(12))) : []
  ctx.linkedParas = splitLinkedBoxes(top)
  // 메모 글 — 구역 끝 MEMO_LIST(번호 DWORD) 뒤 LIST_HEADER(크기 정보 없음) 와 문단
  ctx.memos = new Map()
  let memo = -1
  for (const k of last?.kids ?? []) {
    if (k.rec.tagId === TAG.MEMO_LIST) memo = k.rec.data.length >= 4 ? k.rec.data.readUInt32LE(0) : -1
    else if (k.rec.tagId === TAG.LIST_HEADER) { if (memo >= 0 && k.rec.data.length < 20) ctx.memos.set(memo, { head: k, paras: [] }); else memo = -1 }
    else if (k.rec.tagId === TAG.PARA_HEADER && memo >= 0) ctx.memos.get(memo)?.paras.push(k)
  }
  return XML_DECL + `<hs:sec ${NS}>` + paragraphsXml(top, ctx) + "</hs:sec>"
}

// ─── 구역·단 정의 ────────────────────────────────────

const NOTE_PLACES = ["EACH_COLUMN", "MERGED_COLUMN", "RIGHT_MOST_COLUMN"] as const
const END_PLACES = ["END_OF_DOCUMENT", "END_OF_SECTION"] as const
const NOTE_NUMBERING = ["CONTINUOUS", "ON_SECTION", "ON_PAGE"] as const
const PAGE_STARTS = ["BOTH", "EVEN", "ODD"] as const
const GUTTERS = ["LEFT_ONLY", "LEFT_RIGHT", "TOP_BOTTOM"] as const
const FILL_AREAS = ["PAPER", "PAGE", "BORDER"] as const
const PAGE_BORDER_TYPES = ["BOTH", "EVEN", "ODD"] as const
const COL_TYPES = ["NEWSPAPER", "BALANCED_NEWSPAPER", "PARALLEL"] as const
const COL_LAYOUTS = ["LEFT", "RIGHT", "MIRROR"] as const

const ch = (code: number): string => (code ? String.fromCharCode(code) : "")

function notePrXml(name: string, data: Buffer, endNote: boolean): string {
  const c = new Cur(data)
  const a = c.u32()
  const user = c.u16(), prefix = c.u16(), suffix = c.u16(), start = c.u16()
  const length = c.i32()
  const above = c.i16(), below = c.i16(), between = c.i16()
  const lineType = c.u8(), lineWidth = c.u8(), lineColor = c.u32()
  return el(name, [], el("hp:autoNumFormat", [["type", pick(NUM_FORMATS, bits(a, 0, 8))], ["userChar", ch(user)], ["prefixChar", ch(prefix)],
    ["suffixChar", ch(suffix)], ["supscript", bit(a, 12)]])
    + el("hp:noteLine", [["length", length], ["type", pick(BORDER_TYPES, lineType)], ["width", pick(BORDER_WIDTHS, lineWidth)], ["color", color(lineColor)]])
    + el("hp:noteSpacing", [["betweenNotes", between], ["belowLine", below], ["aboveLine", above]])
    + el("hp:numbering", [["type", pick(NOTE_NUMBERING, bits(a, 10, 2))], ["newNum", start]])
    + el("hp:placement", [["place", endNote ? pick(END_PLACES, bits(a, 8, 2)) : pick(NOTE_PLACES, bits(a, 8, 2))], ["beneathText", bit(a, 13)]]))
}

/** 'secd' 구역 정의 → hp:secPr */
export function secPrXml(node: RecNode, ctx: ConvertContext): string {
  const c = new Cur(node.rec.data, 4)
  const a = c.u32()
  const spaceColumns = c.i16(), lineGrid = c.i16(), charGrid = c.i16()
  const tabStop = c.u32()
  const outline = c.u16(), page = c.u16(), pic = c.u16(), tbl = c.u16(), eq = c.u16()
  let inner = el("hp:grid", [["lineGrid", lineGrid], ["charGrid", charGrid], ["wonggojiFormat", bit(a, 22)]])
    + el("hp:startNum", [["pageStartsOn", pick(PAGE_STARTS, bits(a, 20, 2))], ["page", page], ["pic", pic], ["tbl", tbl], ["equation", eq]])
    + el("hp:visibility", [["hideFirstHeader", bit(a, 0)], ["hideFirstFooter", bit(a, 1)], ["hideFirstMasterPage", bit(a, 2)],
      ["border", bit(a, 3) ? "HIDE_FIRST" : bit(a, 8) ? "SHOW_FIRST" : "SHOW_ALL"], ["fill", bit(a, 4) ? "HIDE_FIRST" : bit(a, 9) ? "SHOW_FIRST" : "SHOW_ALL"],
      ["hideFirstPageNum", bit(a, 5)], ["hideFirstEmptyLine", bit(a, 19)], ["showLineNumber", bit(a, 6)]])
    + el("hp:lineNumberShape", [["restartType", 0], ["countBy", 0], ["distance", 0], ["startNumber", 0]])
  let notes = 0, borders = 0
  // 바탕쪽 — 구역 정의 자식 LIST_HEADER 와 뒤따르는 문단. 종류는 구역 속성 비트 29(양쪽)·30(짝수)·31(홀수) 중 선 것의 차례로 놓인다
  const kinds = MASTER_KINDS.filter((_, i) => bit(a, 29 + i))
  const masters = listGroups(node.kids).map((g, i) => masterPageRef(g, kinds[i] ?? "BOTH", 0, ctx))
  // 확장 바탕쪽 — 확장 값이 3 이면 마지막 쪽, 그보다 크면 (값 − 3) 쪽 임의 쪽 (한글 저장 짝·한글 PDF 로 확인)
  for (const g of ctx.tailMasters) {
    const ext = g.head.rec.data.readUInt16LE(18)
    masters.push(ext > 3 ? masterPageRef(g, "OPTIONAL_PAGE", ext - 3, ctx) : masterPageRef(g, "LAST_PAGE", 0, ctx))
  }
  ctx.tailMasters = []
  for (const k of node.kids) {
    const d = k.rec.data
    if (k.rec.tagId === TAG.PAGE_DEF) {
      const p = new Cur(d)
      const w = p.u32(), hgt = p.u32(), l = p.u32(), r = p.u32(), t = p.u32(), b = p.u32(), hd = p.u32(), ft = p.u32(), g = p.u32(), pa = p.u32()
      inner += el("hp:pagePr", [["landscape", bit(pa, 0) ? "NARROWLY" : "WIDELY"], ["width", w], ["height", hgt], ["gutterType", pick(GUTTERS, bits(pa, 1, 2))]],
        el("hp:margin", [["header", hd], ["footer", ft], ["gutter", g], ["left", l], ["right", r], ["top", t], ["bottom", b]]))
    } else if (k.rec.tagId === TAG.FOOTNOTE_SHAPE) {
      inner += notePrXml(notes ? "hp:endNotePr" : "hp:footNotePr", d, notes > 0)
      notes++
    } else if (k.rec.tagId === TAG.PAGE_BORDER_FILL) {
      const p = new Cur(d)
      const pa = p.u32(), l = p.i16(), r = p.i16(), t = p.i16(), b = p.i16(), id = p.u16()
      inner += el("hp:pageBorderFill", [["type", pick(PAGE_BORDER_TYPES, borders)], ["borderFillIDRef", id], ["textBorder", bit(pa, 0) ? "PAPER" : "CONTENT"],
        ["headerInside", bit(pa, 1)], ["footerInside", bit(pa, 2)], ["fillArea", pick(FILL_AREAS, bits(pa, 3, 2))]],
        el("hp:offset", [["left", l], ["right", r], ["top", t], ["bottom", b]]))
      borders++
    }
  }
  const data = node.kids.find(k => k.rec.tagId === TAG.CTRL_DATA)
  // 메모 모양 번호는 구역 정의 34바이트 자리(u32). 그보다 짧은 옛 판은 메모 모양이 있으면 1
  const memoShape = node.rec.data.length >= 38 ? node.rec.data.readUInt32LE(34) : ctx.memoShapes ? 1 : 0
  return el("hp:secPr", [["id", ""], ["textDirection", bits(a, 16, 3) ? "VERTICAL" : "HORIZONTAL"], ["spaceColumns", spaceColumns],
    ["tabStop", tabStop], ["tabStopVal", Math.trunc(tabStop / 2)], ["tabStopUnit", tabStop % 2 ? "CHAR" : "HWPUNIT"], ["outlineShapeIDRef", outline],
    ["memoShapeIDRef", memoShape], ["textVerticalWidthHead", 0], ["masterPageCnt", masters.length]],
    inner + masters.join("") + (data ? presentationXml(data.rec.data) : ""))
}

/**
 * 구역 정의 매개변수 묶음의 프레젠테이션(쪽 전환) 설정 → hp:presentation. 한글이 이 묶음을 두는 문서는 기본값(효과 없음·문서 전체·
 * 그러데이션 배경)이다 — 그 밖의 효과·적용 범위·채우기는 이름 대응을 모르므로 쓰지 않는다
 */
function presentationXml(data: Buffer): string {
  const p = subSet(readParamSet(data, { o: 0 }), 0x219)
  const fill = subSet(p ?? undefined, 0x266)
  if (!p || !fill || p[0x4000] || p[0x4005] || fill[0x4001] !== 4) return ""
  const num = (v: Param | undefined): number => (typeof v === "number" ? v : 0)
  const colors = Array.isArray(fill[0x4008]) ? fill[0x4008].slice(0, num(fill[0x4007])) : []
  return el("hp:presentation", [["effect", "none"], ["soundIDRef", ""], ["invertText", num(p[0x4002])], ["autoshow", num(p[0x4003])],
    ["showtime", num(p[0x4004])], ["applyto", "WholeDoc"]],
    `<hc:fillBrush>${el("hc:gradation", [["type", pick(GRADATIONS, num(fill[0x4002]))], ["angle", num(fill[0x4003])], ["centerX", num(fill[0x4004])],
      ["centerY", num(fill[0x4005])], ["step", num(fill[0x4006])], ["colorNum", colors.length], ["stepCenter", num(fill[0x400a])], ["alpha", 0]],
    colors.map(v => el("hc:color", [["value", color(v)]])).join(""))}</hc:fillBrush>`)
}

const MASTER_KINDS = ["BOTH", "EVEN", "ODD"] as const

/**
 * 연결된 글상자 — HWP 는 사슬의 글을 첫 글상자(목록 머리 @20 제 id·@24 다음 id)에 모두 두고 줄 나눔 정보로 다음 글상자에 흘린다.
 * 한글은 HWPX 의 연결 글상자에서 이 흐름을 다시 짜지 않아 다음 글상자가 비어 보인다(한글 화면 대조) — 문단을 줄 위치가 처음으로
 * 되돌아가는 곳에서 끊어 사슬 차례대로 제 글상자에 나눠 담는다. 연결 표시는 쓰지 않는다
 */
function splitLinkedBoxes(top: RecNode[]): Map<number, RecNode[]> {
  const boxes = new Map<number, { next: number; paras: RecNode[] }>()
  const walk = (nodes: RecNode[]): void => {
    for (const n of nodes) {
      if (n.rec.tagId === TAG.SHAPE_COMPONENT) {
        const g = listGroups(n.kids)[0]
        const d = g?.head.rec.data
        if (g && d && d.length >= 28 && d.readUInt32LE(20)) boxes.set(d.readUInt32LE(20), { next: d.readUInt32LE(24), paras: g.paras })
      }
      walk(n.kids)
    }
  }
  walk(top)
  const out = new Map<number, RecNode[]>()
  const nexts = new Set([...boxes.values()].map(b => b.next))
  const vpos = (p: RecNode, last: boolean): number => {
    const ls = p.kids.find(k => k.rec.tagId === TAG.PARA_LINE_SEG)?.rec.data
    if (!ls || ls.length < 36) return -1
    return ls.readInt32LE((last ? Math.floor(ls.length / 36) - 1 : 0) * 36 + 4)
  }
  for (const [id, head] of boxes) {
    if (nexts.has(id) || !head.next) continue
    const chain = [id]
    for (let n = head.next; n && boxes.has(n) && !chain.includes(n); n = boxes.get(n)!.next) chain.push(n)
    let k = 0
    const parts: RecNode[][] = [[]]
    head.paras.forEach((p, i) => {
      if (i > 0 && k + 1 < chain.length && vpos(p, false) >= 0 && vpos(p, false) < vpos(head.paras[i - 1], true)) { k++; parts.push([]) }
      parts[k].push(p)
    })
    if (parts.length < 2) continue
    chain.forEach((cid, i) => { if (parts[i]?.length) out.set(cid, parts[i]) })
  }
  return out
}

/** 바탕쪽 하나 → masterpageN.xml(ctx.masterPages 에 쌓음), 구역 정의에 둘 참조. LIST_HEADER 목록 머리 뒤 글 폭·높이·글/번호 참조 */
function masterPageRef(g: { head: RecNode; paras: RecNode[] }, kind: string, pageNumber: number, ctx: ConvertContext): string {
  const d = g.head.rec.data
  const c = new Cur(d, 8)
  const size: Record<string, number> = { textWidth: c.u32(), textHeight: c.u32(), hasTextRef: c.u8(), hasNumRef: c.u8() }
  const id = `masterpage${ctx.masterPages.length}`
  // 겹치기(pageDuplicate)는 확장 값 비트로 알 수 없다 — 한글 저장본은 확장 값 3·7 에서도 0 이다
  ctx.masterPages.push(XML_DECL + `<masterPage ${NS} id="${id}" type="${kind}" pageNumber="${pageNumber}" pageDuplicate="0" pageFront="0">`
    + el("hp:subList", subListAttrs(d).map(([k, v]) => [k, size[k] ?? v]), paragraphsXml(g.paras, ctx)) + "</masterPage>")
  return el("hp:masterPage", [["idRef", id]])
}

/** 'cold' 단 정의 → hp:ctrl/hp:colPr */
export function colPrXml(node: RecNode): string {
  const c = new Cur(node.rec.data, 4)
  const a = c.u16()
  const count = bits(a, 2, 8), same = bit(a, 12)
  let gap = 0
  const sizes: Array<[number, number]> = []
  if (!same && count > 1) {
    c.u16()
    for (let i = 0; i < count; i++) sizes.push([c.i16(), c.i16()])
  } else {
    gap = c.i16()
    c.u16()
  }
  const lineType = c.u8(), lineWidth = c.u8(), lineColor = c.u32()
  let inner = ""
  if (lineType) inner += el("hp:colLine", [["type", pick(BORDER_TYPES, lineType)], ["width", pick(BORDER_WIDTHS, lineWidth)], ["color", color(lineColor)]])
  for (const [w, g] of sizes) inner += el("hp:colSz", [["width", w], ["gap", g]])
  return "<hp:ctrl>" + el("hp:colPr", [["id", ""], ["type", pick(COL_TYPES, bits(a, 0, 2))], ["layout", pick(COL_LAYOUTS, bits(a, 10, 2))],
    ["colCount", count], ["sameSz", same], ["sameGap", gap]], inner || undefined) + "</hp:ctrl>"
}

