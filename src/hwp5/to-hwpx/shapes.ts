/**
 * HWP 5.x 그리기 개체('gso ') → hp:pic · hp:rect · hp:ellipse · hp:arc · hp:polygon · hp:curve · hp:line · hp:connectLine · hp:container.
 *
 * CTRL_HEADER(개체 공통 속성) 아래 SHAPE_COMPONENT 가 개체 요소(위치·크기·뒤집기·회전·변환 행렬, 그리기 개체는 선·채우기·그림자)를
 * 담고, 그 자식이 개체별 레코드(PICTURE·RECTANGLE …)와 글상자(LIST_HEADER + 문단)다. 묶음($con) 안 자식은 SHAPE_COMPONENT 가
 * 개체 공통 속성 없이 이어져 id·zOrder 가 0 이고 sz·pos 가 없다. 수는 한글 저장 꼴대로 쓴다 — 좌표·크기는 부호 없는 32비트,
 * 변환 행렬은 단정밀도로 줄여 소수 여섯째 자리까지.
 */

import { Cur, type RecNode, readParamSet, subSet, el, escText, color, pick, bit, bits, BORDER_TYPES } from "./util.js"
import { fillBrushXml } from "./header.js"
import { TAG, paragraphsXml } from "./section.js"
import { type ConvertContext, type ObjCommon, readObjCommon, objHeadAttrs, objPlacementXml, subListAttrs, listGroups, captionXml } from "./controls.js"

const TAG_SHAPE = {
  LINE: 0x4e, RECTANGLE: 0x4f, ELLIPSE: 0x50, ARC: 0x51, POLYGON: 0x52, CURVE: 0x53, OLE: 0x54, PICTURE: 0x55, CONTAINER: 0x56,
} as const

const TAG_CTRL_DATA = 0x57
const u32 = (v: number): number => v >>> 0
/** 배정밀도 값 그대로 소수 여섯째 자리, 끝 0 은 지운다 */
export function num6(v: number): string {
  const s = v.toFixed(6).replace(/\.?0+$/, "")
  return s === "-0" ? "0" : s
}

/** 개체 요소(SHAPE_COMPONENT) 앞부분 */
interface Component {
  kind: string
  offsetX: number; offsetY: number; groupLevel: number
  orgW: number; orgH: number; curW: number; curH: number
  flip: number; angle: number; cx: number; cy: number
  rendering: string
  /** 행렬 뒤 — 그리기 개체의 선·채우기·그림자 */
  rest: Cur
}

function readComponent(node: RecNode): Component {
  const d = node.rec.data
  const two = d.length >= 8 && d.readUInt32LE(0) === d.readUInt32LE(4)
  const kind = d.length >= 4 ? String.fromCharCode(d[3], d[2], d[1], d[0]) : ""
  const c = new Cur(d, two ? 8 : 4)
  const offsetX = c.i32(), offsetY = c.i32(), groupLevel = c.u16()
  c.u16()
  const orgW = c.u32(), orgH = c.u32(), curW = c.u32(), curH = c.u32(), flip = c.u32()
  const angle = c.i16(), cx = c.i32(), cy = c.i32()
  const n = c.u16()
  const matrix = (name: string): string => {
    const v: number[] = []
    for (let i = 0; i < 6; i++) { v.push(c.o + 8 <= d.length ? d.readDoubleLE(c.o) : 0); c.o += 8 }
    return el(name, v.map((x, i) => [`e${i + 1}`, num6(x)]))
  }
  let rendering = matrix("hc:transMatrix")
  for (let i = 0; i < n; i++) rendering += matrix("hc:scaMatrix") + matrix("hc:rotMatrix")
  return { kind, offsetX, offsetY, groupLevel, orgW, orgH, curW, curH, flip, angle, cx, cy, rendering: `<hp:renderingInfo>${rendering}</hp:renderingInfo>`, rest: c }
}

/** offset · orgSz · curSz(원래 크기와 같은 축은 0) · flip · rotationInfo · renderingInfo */
function componentHeadXml(k: Component): string {
  return el("hp:offset", [["x", u32(k.offsetX)], ["y", u32(k.offsetY)]]) + el("hp:orgSz", [["width", k.orgW], ["height", k.orgH]])
    + el("hp:curSz", [["width", k.curW === k.orgW ? 0 : k.curW], ["height", k.curH === k.orgH ? 0 : k.curH]]) + el("hp:flip", [["horizontal", bit(k.flip, 0)], ["vertical", bit(k.flip, 1)]])
    + el("hp:rotationInfo", [["angle", k.angle], ["centerX", k.cx], ["centerY", k.cy], ["rotateimage", bit(k.flip, 19)]]) + k.rendering
}

const ARROW_STYLES = ["NORMAL", "ARROW", "SPEAR", "CONCAVE_ARROW", "EMPTY_DIAMOND", "EMPTY_CIRCLE", "EMPTY_BOX", "FILLED_DIAMOND",
  "FILLED_CIRCLE", "FILLED_BOX"] as const
const ARROW_SIZES = ["SMALL_SMALL", "SMALL_MEDIUM", "SMALL_LARGE", "MEDIUM_SMALL", "MEDIUM_MEDIUM", "MEDIUM_LARGE", "LARGE_SMALL",
  "LARGE_MEDIUM", "LARGE_LARGE"] as const
const OUTLINE_STYLES = ["NORMAL", "OUTER", "INNER"] as const
const END_CAPS = ["ROUND", "FLAT"] as const
const SHADOW_TYPES = ["NONE", "PARELLEL_LEFTTOP", "PARELLEL_RIGHTTOP", "PARELLEL_LEFTBOTTOM", "PARELLEL_RIGHTBOTTOM", "SHEAR_LEFTTOP",
  "SHEAR_RIGHTTOP", "SHEAR_LEFTBOTTOM", "SHEAR_RIGHTBOTTOM", "SHEAR_LEFTTOP", "SHEAR_RIGHTTOP"] as const

/** 선 — 색·굵기·속성(종류·끝 모양·화살표) */
function lineShapeXml(lineColor: number, width: number, a: number, outline: number): string {
  return el("hp:lineShape", [["color", color(lineColor)], ["width", width], ["style", pick(BORDER_TYPES, bits(a, 0, 6))],
    ["endCap", pick(END_CAPS, bits(a, 6, 4))], ["headStyle", pick(ARROW_STYLES, bits(a, 10, 6))], ["tailStyle", pick(ARROW_STYLES, bits(a, 16, 6))],
    ["headfill", bit(a, 30)], ["tailfill", bit(a, 31)], ["headSz", pick(ARROW_SIZES, bits(a, 22, 4))], ["tailSz", pick(ARROW_SIZES, bits(a, 26, 4))],
    ["outlineStyle", pick(OUTLINE_STYLES, outline)], ["alpha", 0]])
}

/** 그리기 개체 공통 — 선(lineShape) · 채우기(fillBrush) · 그림자(shadow), 그 뒤 인스턴스 id */
function drawingStyle(k: Component, ctx: ConvertContext): { xml: string; instId: number } {
  const c = k.rest
  const lineColor = c.u32(), width = c.i32(), a = c.u32(), outline = c.u8()
  const line = lineShapeXml(lineColor, width, a, outline)
  const fill = fillBrushXml(c, ctx.binRef)
  const sType = c.u32(), sColor = c.u32(), sx = c.i32(), sy = c.i32()
  const instId = c.u32()
  c.u8()
  const sAlpha = c.u8()
  const shadow = el("hp:shadow", [["type", pick(SHADOW_TYPES, sType)], ["color", color(sColor)], ["offsetX", sx], ["offsetY", sy], ["alpha", sAlpha]])
  return { xml: line + fill + shadow, instId }
}

/** 글상자 — SHAPE_COMPONENT 자식 LIST_HEADER(목록 머리·글 여백·마지막 줄 폭·이름) 와 뒤따르는 문단 */
function drawTextXml(comp: RecNode, ctx: ConvertContext): string {
  const g = listGroups(comp.kids)[0]
  if (!g) return ""
  const c = new Cur(g.head.rec.data, 8)
  const l = c.i16(), r = c.i16(), t = c.i16(), b = c.i16()
  const lastWidth = c.u32()
  // 글상자 연결(제 목록 id·다음 id) — 사슬의 글은 sectionXml 이 줄 나눔 정보대로 나눠 두었다. 이름 칸은 한글 저장본에서 늘 비어 있다
  const listId = c.u32()
  const paras = (listId && ctx.linkedParas.get(listId)) || g.paras
  return el("hp:drawText", [["lastWidth", lastWidth], ["name", ""], ["editable", 0]],
    el("hp:subList", subListAttrs(g.head.rec.data), paragraphsXml(paras, ctx))
    + el("hp:textMargin", [["left", l], ["right", r], ["top", t], ["bottom", b]]))
}

const ELLIPSE_ARC = ["NORMAL", "PIE", "CHORD"] as const
const pt = (name: string, c: Cur): string => el(name, [["x", c.i32()], ["y", c.i32()]])

/** 개체 하이퍼링크 — 개체 요소 아래 CTRL_DATA 매개변수 묶음(0x26f 안 문자열 0x265) */
function shapeHref(comp: RecNode): string {
  const cd = comp.kids.find(x => x.rec.tagId === TAG_CTRL_DATA)
  const v = cd ? subSet(readParamSet(cd.rec.data, { o: 0 }), 0x26f)?.[0x265] : undefined
  // HWP 하이퍼링크 문자열의 \: 이스케이프는 한글이 HWPX href 에 풀어 쓴다
  return typeof v === "string" ? v.replace(/\\:/g, ":") : ""
}

/** 개체 하나 — 개체 공통 속성(o)이 없으면 묶음 안 자식 */
function shapeXml(comp: RecNode, o: ObjCommon | null, description: string, ctx: ConvertContext, caption: string): string {
  const k = readComponent(comp)
  const sub = (tag: number): Cur => new Cur(comp.kids.find(x => x.rec.tagId === tag)?.rec.data ?? Buffer.alloc(0))
  const head: Array<[string, string | number]> = o ? objHeadAttrs(o)
    : [["id", 0], ["zOrder", 0], ["numberingType", "NONE"], ["textWrap", "TOP_AND_BOTTOM"], ["textFlow", "BOTH_SIDES"], ["lock", 0], ["dropcapstyle", "None"]]
  const comment = o && description ? `<hp:shapeComment>${escText(description)}</hp:shapeComment>` : ""
  // 개체 설명은 캡션 앞에 둔다(한글 순서)
  const tail = o ? objPlacementXml(o) + comment + caption : comment
  const common = componentHeadXml(k)
  const href = shapeHref(comp)

  if (k.kind === "$pic") {
    const p = sub(TAG_SHAPE.PICTURE)
    const borderColor = p.u32(), borderWidth = p.i32(), borderAttr = p.u32()
    // 테두리 선이 있을 때만(선 종류 ≠ 없음) 한글이 lineShape 를 쓴다
    const border = bits(borderAttr, 0, 6) ? lineShapeXml(borderColor, borderWidth, borderAttr, 0) : ""
    const xs: number[] = [], ys: number[] = []
    for (let i = 0; i < 4; i++) { xs.push(p.i32()); ys.push(p.i32()) }
    const cl = p.i32(), ct = p.i32(), cr = p.i32(), cb = p.i32()
    const m = [p.i16(), p.i16(), p.i16(), p.i16()]
    const contrast = p.i8(), bright = p.i8(), effect = p.u8(), binId = p.u16()
    p.u8()
    const instId = p.u32()
    p.skip(4)
    const dimW = p.u32(), dimH = p.u32()
    const alpha = p.rest >= 1 ? p.d[p.d.length - 1] : 0
    const img = el("hc:img", [["binaryItemIDRef", binId ? ctx.binRef(binId) : ""], ["bright", bright], ["contrast", contrast],
      ["effect", pick(["REAL_PIC", "GRAY_SCALE", "BLACK_WHITE", "PATTERN8x8"], effect)], ["alpha", alpha]])
    const rect = `<hp:imgRect>${[0, 1, 2, 3].map(i => el(`hc:pt${i}`, [["x", xs[i]], ["y", ys[i]]])).join("")}</hp:imgRect>`
    return el("hp:pic", [...head, ["href", href], ["groupLevel", k.groupLevel], ["instid", instId], ["reverse", 0]],
      common + img + border + rect + el("hp:imgClip", [["left", cl], ["right", cr], ["top", ct], ["bottom", cb]])
      + el("hp:inMargin", [["left", m[0]], ["right", m[1]], ["top", m[2]], ["bottom", m[3]]]) + el("hp:imgDim", [["dimwidth", dimW], ["dimheight", dimH]])
      + "<hp:effects/>" + tail)
  }

  if (k.kind === "$ole") return oleXml(comp, k, head, common, o, caption, comment, ctx)

  if (k.kind === "$con") {
    const kids = comp.kids.filter(x => x.rec.tagId === TAG.SHAPE_COMPONENT).map(x => shapeXml(x, null, "", ctx, "")).join("")
    // 행렬 뒤 자식 수(WORD)·자식 컨트롤 ID 목록, 그 뒤 인스턴스 id
    k.rest.skip(4 * k.rest.u16())
    const instId = k.rest.rest >= 4 ? k.rest.u32() : 0
    return el("hp:container", [...head, ["href", href], ["groupLevel", k.groupLevel], ["instid", instId]], common + kids + tail)
  }

  const s = drawingStyle(k, ctx)
  const text = drawTextXml(comp, ctx)
  const ref: Array<[string, string | number]> = [["href", href], ["groupLevel", k.groupLevel], ["instid", s.instId]]
  switch (k.kind) {
    case "$rec": {
      const r = sub(TAG_SHAPE.RECTANGLE)
      const ratio = r.u8()
      const pts = [0, 1, 2, 3].map(i => pt(`hc:pt${i}`, r)).join("")
      return el("hp:rect", [...head, ...ref, ["ratio", ratio]], common + s.xml + text + pts + tail)
    }
    case "$ell": {
      const r = sub(TAG_SHAPE.ELLIPSE)
      const a = r.u32()
      const pts = ["hc:center", "hc:ax1", "hc:ax2", "hc:start1", "hc:end1", "hc:start2", "hc:end2"].map(n => pt(n, r)).join("")
      return el("hp:ellipse", [...head, ...ref, ["intervalDirty", bit(a, 0)], ["hasArcPr", bit(a, 1)], ["arcType", pick(ELLIPSE_ARC, bits(a, 2, 8))]],
        common + s.xml + text + pts + tail)
    }
    case "$arc": {
      const r = sub(TAG_SHAPE.ARC)
      const type = r.u8()
      const pts = ["hc:center", "hc:ax1", "hc:ax2"].map(n => pt(n, r)).join("")
      return el("hp:arc", [...head, ...ref, ["type", pick(ELLIPSE_ARC, type)]], common + s.xml + text + pts + tail)
    }
    case "$pol": {
      const r = sub(TAG_SHAPE.POLYGON)
      const n = r.i32()
      let pts = ""
      for (let i = 0; i < n && r.rest >= 8; i++) pts += pt("hc:pt", r)
      return el("hp:polygon", [...head, ...ref], common + s.xml + text + pts + tail)
    }
    case "$cur": {
      const r = sub(TAG_SHAPE.CURVE)
      const n = r.i32()
      const ps: Array<[number, number]> = []
      for (let i = 0; i < n && r.rest >= 8; i++) ps.push([r.i32(), r.i32()])
      const types = ps.slice(1).map(() => r.u8())
      const segs = types.map((t, i) => el("hp:seg", [["type", t ? "CURVE" : "LINE"], ["x1", ps[i][0]], ["y1", ps[i][1]], ["x2", ps[i + 1][0]], ["y2", ps[i + 1][1]]])).join("")
      return el("hp:curve", [...head, ...ref], common + s.xml + text + segs + tail)
    }
    case "$col": {
      // 연결선 — 시작·끝 점, 종류, 이어진 개체(id·연결점 번호), 꺾임 점(x·y·종류 WORD)
      const r = sub(TAG_SHAPE.LINE)
      const sx = r.i32(), sy = r.i32(), ex = r.i32(), ey = r.i32(), type = r.u32()
      const ends = [r.u32(), r.u32(), r.u32(), r.u32()]
      const n = r.u32()
      let cps = ""
      for (let i = 0; i < n && r.rest >= 10; i++) cps += el("hp:point", [["x", r.i32()], ["y", r.i32()], ["type", r.u16()]])
      return el("hp:connectLine", [...head, ...ref, ["type", pick(CONNECT_TYPES, type)]], common + s.xml
        + el("hp:startPt", [["x", sx], ["y", sy], ["subjectIDRef", ends[0]], ["subjectIdx", ends[1]]])
        + el("hp:endPt", [["x", ex], ["y", ey], ["subjectIDRef", ends[2]], ["subjectIdx", ends[3]]])
        + `<hp:controlPoints>${cps}</hp:controlPoints>` + tail)
    }
    case "$lin": {
      const r = sub(TAG_SHAPE.LINE)
      const sp = pt("hc:startPt", r), ep = pt("hc:endPt", r)
      const rev = r.u16()
      return el("hp:line", [...head, ...ref, ["isReverseHV", rev ? 1 : 0]], common + s.xml + sp + ep + tail)
    }
    default:
      return ""
  }
}

const CONNECT_TYPES = ["STRAIGHT_NOARROW", "STRAIGHT_ONEWAY", "STRAIGHT_BOTH", "STROKE_NOARROW", "STROKE_ONEWAY", "STROKE_BOTH",
  "ARC_NOARROW", "ARC_ONEWAY", "ARC_BOTH"] as const

const OLE_ASPECTS: Record<number, string> = { 1: "CONTENT", 2: "THUMBNAIL", 4: "ICON", 8: "DOCPRINT" }
const OLE_TYPES = ["UNKNOWN", "EMBEDDED", "LINK", "STATIC", "EQUATION"] as const
const CHART_NS = "http://www.hancom.co.kr/hwpml/2016/ooxmlchart"

/**
 * OLE 개체 — 속성(그리기 방식·모니커·기준선·개체 종류)·크기·BinData id·테두리. 차트 OLE(스토리지에 OOXML 차트 스트림이 있음)는
 * 한글처럼 hp:switch 의 차트 갈래(Chart/chartN.xml)와 OLE 기본 갈래로 쓴다
 */
function oleXml(comp: RecNode, k: Component, head: Array<[string, string | number]>, common: string, o: ObjCommon | null, caption: string,
  comment: string, ctx: ConvertContext): string {
  const r = new Cur(comp.kids.find(x => x.rec.tagId === TAG_SHAPE.OLE)?.rec.data ?? Buffer.alloc(0))
  const a = r.u32(), ex = r.i32(), ey = r.i32(), binId = r.u16()
  const lineColor = r.u32(), lineWidth = r.i32(), la = r.u32()
  const instId = r.rest >= 4 ? r.u32() : 0
  const line = el("hp:lineShape", [["color", color(lineColor)], ["width", lineWidth], ["style", pick(BORDER_TYPES, bits(la, 0, 6))],
    ["endCap", pick(END_CAPS, bits(la, 6, 4))], ["headStyle", pick(ARROW_STYLES, bits(la, 10, 6))], ["tailStyle", pick(ARROW_STYLES, bits(la, 16, 6))],
    ["headfill", bit(la, 30)], ["tailfill", bit(la, 31)], ["headSz", pick(ARROW_SIZES, bits(la, 22, 4))], ["tailSz", pick(ARROW_SIZES, bits(la, 26, 4))],
    ["outlineStyle", "NORMAL"], ["alpha", 0]])
  const chart = o ? ctx.chartOf(binId) : null
  // 차트의 OLE 기본 갈래는 조판 전 꼴로 쓴다 — 캡션 마지막 줄 폭 0xFFFFFFFF, 줄 나눔 정보 없음. 조판된 캡션은 차트 갈래에 둔다
  const oleCaption = chart ? caption.replace(/ lastWidth="\d+"/, ' lastWidth="4294967295"').replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "") : caption
  const ole = el("hp:ole", [...head, ["href", shapeHref(comp)], ["groupLevel", k.groupLevel], ["instid", instId], ["objectType", pick(OLE_TYPES, bits(a, 16, 6))],
    ["binaryItemIDRef", ctx.oleRef(binId)], ["hasMoniker", bit(a, 8)], ["drawAspect", OLE_ASPECTS[bits(a, 0, 8)] ?? "CONTENT"],
    ["eqBaseLine", bits(a, 9, 7)]],
  common + el("hc:extent", [["x", ex], ["y", ey]]) + line + (o ? objPlacementXml(o) + oleCaption : "") + comment)
  if (!chart) return ole
  const chartEl = el("hp:chart", [...head, ["chartIDRef", chart]], objPlacementXml(o!) + caption)
  return `<hp:switch><hp:case hp:required-namespace="${CHART_NS}">${chartEl}</hp:case><hp:default>${ole}</hp:default></hp:switch>`
}

/** 'gso ' 컨트롤 → 개체 요소 */
export function gsoXml(node: RecNode, ctx: ConvertContext): string {
  const o = readObjCommon(node)
  const c = new Cur(node.rec.data, 4 + 4 * 6 + 2 * 4 + 4)
  c.i32()
  const description = c.rest >= 2 ? c.str() : ""
  const comp = node.kids.find(k => k.rec.tagId === TAG.SHAPE_COMPONENT)
  if (!comp) return ""
  const capIdx = node.kids.indexOf(comp)
  const cap = listGroups(node.kids.slice(0, capIdx))[0]
  return shapeXml(comp, o, description, ctx, cap ? captionXml(cap, ctx) : "")
}
