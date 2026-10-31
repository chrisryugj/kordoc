/**
 * HWP 5.x 확장 컨트롤(CTRL_HEADER) → HWPX 요소. 구역·단 정의, 표, 개체 공통 위치·크기, 그리고 컨트롤별 모듈로 나눈다.
 */

import { Cur, type RecNode, el, pick, bit, bits, readParamSet, subSet } from "./util.js"
import { TAG, ctrlId, paragraphsXml, secPrXml, colPrXml } from "./section.js"
import { fieldBeginXml, type FieldState } from "./fields.js"
import { gsoXml } from "./shapes.js"
import { otherControlXml } from "./notes.js"

/** 변환 중 문서 전체가 함께 쓰는 상태 */
export interface ConvertContext {
  /** DocInfo 메모 모양 수 — 구역 정의 memoShapeIDRef */
  memoShapes: number
  /** 문단 모양 번호 → paraPr id(같은 문단 모양을 합친 번호) */
  paraIds: number[]
  /** 열린 필드 — 필드 끝 컨트롤이 짝을 찾는다 */
  fields: FieldState
  /** 바탕쪽 파트(masterpageN.xml 내용) — 구역 정의를 만나는 차례로 쌓는다 */
  masterPages: string[]
  /** 지금 구역의 확장 바탕쪽(구역 끝 LIST_HEADER 묶음) — 구역 정의가 기본 바탕쪽 뒤에 쓴다 */
  tailMasters: Array<{ head: RecNode; paras: RecNode[] }>
  /** 연결된 글상자의 제 몫 문단(목록 id → 문단) — 사슬 머리에 모인 글을 줄 나눔 정보대로 나눈 것 */
  linkedParas: Map<number, RecNode[]>
  /** 지금 구역의 메모 글(구역 끝 MEMO_LIST 번호 → LIST_HEADER 묶음) — 메모 필드가 제 번호 글을 subList 로 쓴다 */
  memos: Map<number, { head: RecNode; paras: RecNode[] }>
  /** 차트 OLE(BIN_DATA 순번) → 차트 파트 경로, 차트가 아니면 null */
  chartOf(binId: number): string | null
  /** 그림 BinData 참조 이름 */
  binRef(binId: number): string
  /** OLE BinData 참조 이름(oleN) */
  oleRef(binId: number): string
}

/** obj: run 안에서 뒤에 글 자리(hp:t)를 여는 개체, def: 구역·단 정의(뒤 내용은 새 run) */
export interface CtrlXml { xml: string; obj: boolean; def?: boolean }

/** 확장 컨트롤 하나 → 요소. obj 는 run 안에서 뒤에 글 자리(hp:t)를 여는 개체(표·그림·도형·수식) */
export function controlXml(node: RecNode, ctx: ConvertContext): CtrlXml | null {
  const id = ctrlId(node)
  if (id.startsWith("%")) return { xml: fieldBeginXml(node, id, ctx), obj: false }
  switch (id) {
    case "secd": return { xml: secPrXml(node, ctx), obj: false, def: true }
    case "cold": return { xml: colPrXml(node), obj: false, def: true }
    case "tbl ": return { xml: tableXml(node, ctx), obj: true }
    case "gso ": return { xml: gsoXml(node, ctx), obj: true }
    default: return otherControlXml(id, node, ctx)
  }
}

// ─── 개체 공통 ───────────────────────────────────────

const VERT_RELS = ["PAPER", "PAGE", "PARA"] as const
const HORZ_RELS = ["PAPER", "PAGE", "COLUMN", "PARA"] as const
const VERT_ALIGNS = ["TOP", "CENTER", "BOTTOM", "INSIDE", "OUTSIDE"] as const
const HORZ_ALIGNS = ["LEFT", "CENTER", "RIGHT", "INSIDE", "OUTSIDE"] as const
const WIDTH_RELS = ["PAPER", "PAGE", "COLUMN", "PARA", "ABSOLUTE"] as const
const HEIGHT_RELS = ["PAPER", "PAGE", "ABSOLUTE"] as const
const TEXT_WRAPS = ["SQUARE", "TOP_AND_BOTTOM", "BEHIND_TEXT", "IN_FRONT_OF_TEXT"] as const
const TEXT_FLOWS = ["BOTH_SIDES", "LEFT_ONLY", "RIGHT_ONLY", "LARGEST_ONLY"] as const
const NUMBERING_TYPES = ["NONE", "PICTURE", "TABLE", "EQUATION"] as const

/** 개체 공통 속성(CTRL_HEADER 의 컨트롤 id 뒤) */
export interface ObjCommon {
  attr: number; vertOffset: number; horzOffset: number; width: number; height: number; zOrder: number
  margin: [number, number, number, number]; instanceId: number
  /** 쪽 나눔 방지 — 개체와 조판 부호를 같은 쪽에 둔다(holdAnchorAndSO) */
  keepWithAnchor: number
}

export function readObjCommon(node: RecNode): ObjCommon {
  const c = new Cur(node.rec.data, 4)
  const attr = c.u32(), vertOffset = c.i32(), horzOffset = c.i32(), width = c.u32(), height = c.u32(), zOrder = c.i32()
  const margin: [number, number, number, number] = [c.i16(), c.i16(), c.i16(), c.i16()]
  const instanceId = c.u32()
  return { attr, vertOffset, horzOffset, width, height, zOrder, margin, instanceId, keepWithAnchor: c.i32() & 1 }
}

/** 개체 요소의 앞 속성 — id·zOrder·번호 종류·배치 */
export function objHeadAttrs(o: ObjCommon): Array<[string, string | number]> {
  return [["id", o.instanceId], ["zOrder", o.zOrder], ["numberingType", pick(NUMBERING_TYPES, bits(o.attr, 26, 2))],
    ["textWrap", pick(TEXT_WRAPS, bits(o.attr, 21, 3))], ["textFlow", pick(TEXT_FLOWS, bits(o.attr, 24, 2))], ["lock", bit(o.attr, 30)], ["dropcapstyle", "None"]]
}

/** hp:sz · hp:pos · hp:outMargin */
export function objPlacementXml(o: ObjCommon): string {
  const a = o.attr
  return el("hp:sz", [["width", o.width], ["widthRelTo", pick(WIDTH_RELS, bits(a, 15, 3))], ["height", o.height],
    ["heightRelTo", pick(HEIGHT_RELS, bits(a, 18, 2))], ["protect", bit(a, 20)]])
    + el("hp:pos", [["treatAsChar", bit(a, 0)], ["affectLSpacing", bit(a, 2)], ["flowWithText", bit(a, 13)], ["allowOverlap", bit(a, 14)],
      ["holdAnchorAndSO", o.keepWithAnchor], ["vertRelTo", pick(VERT_RELS, bits(a, 3, 2))], ["horzRelTo", pick(HORZ_RELS, bits(a, 8, 2))],
      ["vertAlign", pick(VERT_ALIGNS, bits(a, 5, 3))], ["horzAlign", pick(HORZ_ALIGNS, bits(a, 10, 3))], ["vertOffset", o.vertOffset >>> 0],
      ["horzOffset", o.horzOffset >>> 0]])
    + el("hp:outMargin", [["left", o.margin[0]], ["right", o.margin[1]], ["top", o.margin[2]], ["bottom", o.margin[3]]])
}

/** 라벨 용지(표 매개변수 묶음 0x242) — 위·왼쪽 여백, 칸 폭·높이·간격, 칸 수, 용지 방향·크기 */
function labelXml(data: RecNode | undefined): string {
  const s = data ? subSet(readParamSet(data.rec.data, { o: 0 }), 0x242) : null
  if (!s) return ""
  const v = (id: number): number => (typeof s[id] === "number" ? (s[id] as number) : 0)
  return el("hp:label", [["topmargin", v(0x4000)], ["leftmargin", v(0x4001)], ["boxwidth", v(0x4002)], ["boxlength", v(0x4003)],
    ["boxmarginhor", v(0x4004)], ["boxmarginver", v(0x4005)], ["labelcols", v(0x4006)], ["labelrows", v(0x4007)],
    ["landscape", v(0x4008) ? "NARROWLY" : "WIDELY"], ["pagewidth", v(0x4009)], ["pageheight", v(0x400a)]])
}

// ─── 문단 목록 머리(LIST_HEADER) ───────────────────

const TEXT_DIRS = ["HORIZONTAL", "VERTICAL", "VERTICALALL"] as const
const LINE_WRAPS = ["BREAK", "SQUEEZE", "KEEP"] as const
const LIST_VALIGNS = ["TOP", "CENTER", "BOTTOM"] as const

/** LIST_HEADER 의 공통 속성 → hp:subList 속성 (속성 비트는 u32 의 위쪽 16비트에 있다) */
export function subListAttrs(data: Buffer, extra: Array<[string, string | number]> = []): Array<[string, string | number]> {
  const a = data.length >= 6 ? data.readUInt32LE(2) >>> 16 : 0
  return [["id", ""], ["textDirection", pick(TEXT_DIRS, bits(a, 0, 3))], ["lineWrap", pick(LINE_WRAPS, bits(a, 3, 2))],
    ["vertAlign", pick(LIST_VALIGNS, bits(a, 5, 2))], ["linkListIDRef", 0], ["linkListNextIDRef", 0], ["textWidth", 0], ["textHeight", 0],
    ["hasTextRef", 0], ["hasNumRef", 0], ...extra]
}

/** LIST_HEADER 와 뒤따르는 형제 문단 묶음으로 가른다 (칸·캡션은 문단이 LIST_HEADER 의 형제다) */
export function listGroups(kids: RecNode[]): Array<{ head: RecNode; paras: RecNode[] }> {
  const out: Array<{ head: RecNode; paras: RecNode[] }> = []
  for (const k of kids) {
    if (k.rec.tagId === TAG.LIST_HEADER) out.push({ head: k, paras: [] })
    else if (k.rec.tagId === TAG.PARA_HEADER && out.length) out[out.length - 1].paras.push(k)
  }
  return out
}

// ─── 표 ──────────────────────────────────────────────

const PAGE_BREAKS = ["NONE", "TABLE", "CELL"] as const
const CAPTION_SIDES = ["LEFT", "RIGHT", "TOP", "BOTTOM"] as const

/** 캡션 LIST_HEADER(목록 머리 뒤 캡션 속성·폭·간격·마지막 줄 폭) → hp:caption */
export function captionXml(g: { head: RecNode; paras: RecNode[] }, ctx: ConvertContext): string {
  const c = new Cur(g.head.rec.data, 8)
  const a = c.u32(), width = c.u32(), gap = c.i16(), lastWidth = c.u32()
  return el("hp:caption", [["side", pick(CAPTION_SIDES, bits(a, 0, 2))], ["fullSz", bit(a, 2)], ["width", width], ["gap", gap], ["lastWidth", lastWidth]],
    el("hp:subList", subListAttrs(g.head.rec.data), paragraphsXml(g.paras, ctx)))
}

function tableXml(node: RecNode, ctx: ConvertContext): string {
  const o = readObjCommon(node)
  const tIdx = node.kids.findIndex(k => k.rec.tagId === TAG.TABLE)
  const t = new Cur(tIdx >= 0 ? node.kids[tIdx].rec.data : Buffer.alloc(0))
  const ta = t.u32(), rows = t.u16(), cols = t.u16(), spacing = t.i16()
  const inMargin = [t.i16(), t.i16(), t.i16(), t.i16()]
  t.skip(2 * rows)
  const borderFill = t.u16()
  const zones = t.u16()
  let zoneXml = ""
  for (let i = 0; i < zones && t.rest >= 10; i++) {
    const sr = t.u16(), sc = t.u16(), er = t.u16(), ec = t.u16(), bf = t.u16()
    zoneXml += el("hp:cellzone", [["startRowAddr", sr], ["startColAddr", sc], ["endRowAddr", er], ["endColAddr", ec], ["borderFillIDRef", bf]])
  }
  const before = tIdx >= 0 ? node.kids.slice(0, tIdx) : []
  const caption = listGroups(before)[0]
  const cells = listGroups(tIdx >= 0 ? node.kids.slice(tIdx + 1) : node.kids)
  const rowsXml: string[] = []
  for (const g of cells) {
    const d = g.head.rec.data
    const c = new Cur(d, 6)
    const flags = c.u16()
    const col = c.u16(), row = c.u16(), cs = c.u16(), rs = c.u16(), w = c.u32(), hgt = c.u32()
    const m = [c.i16(), c.i16(), c.i16(), c.i16()]
    const bf = c.u16()
    let name = ""
    if (d.length >= 34 + 17) {
      const n = d.readUInt16LE(34 + 15)
      if (n && d.length >= 34 + 17 + n * 2) name = d.toString("utf16le", 34 + 17, 34 + 17 + n * 2)
    }
    const tc = el("hp:tc", [["name", name], ["header", bit(flags, 2)], ["hasMargin", bit(flags, 0)], ["protect", bit(flags, 1)],
      ["editable", bit(flags, 3)], ["dirty", 0], ["borderFillIDRef", bf]],
      el("hp:subList", subListAttrs(d), paragraphsXml(g.paras, ctx))
      + el("hp:cellAddr", [["colAddr", col], ["rowAddr", row]]) + el("hp:cellSpan", [["colSpan", cs], ["rowSpan", rs]])
      + el("hp:cellSz", [["width", w], ["height", hgt]]) + el("hp:cellMargin", [["left", m[0] >>> 0], ["right", m[1] >>> 0], ["top", m[2] >>> 0], ["bottom", m[3] >>> 0]]))
    while (rowsXml.length <= row) rowsXml.push("")
    rowsXml[row] += tc
  }
  const inner = objPlacementXml(o) + (caption ? captionXml(caption, ctx) : "")
    + el("hp:inMargin", [["left", inMargin[0]], ["right", inMargin[1]], ["top", inMargin[2]], ["bottom", inMargin[3]]])
    + (zoneXml ? `<hp:cellzoneList>${zoneXml}</hp:cellzoneList>` : "")
    + rowsXml.filter(Boolean).map(r => `<hp:tr>${r}</hp:tr>`).join("")
    + labelXml(node.kids.find(k => k.rec.tagId === TAG.CTRL_DATA))
  return el("hp:tbl", [...objHeadAttrs(o), ["pageBreak", pick(PAGE_BREAKS, bits(ta, 0, 2))], ["repeatHeader", bit(ta, 2)],
    ["rowCnt", rows], ["colCnt", cols], ["cellSpacing", spacing], ["borderFillIDRef", borderFill], ["noAdjust", bit(ta, 3)]], inner)
}
