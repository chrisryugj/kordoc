/**
 * HWP 5.x DocInfo → HWPX Contents/header.xml.
 *
 * DocInfo 레코드(글꼴·테두리/배경·글자 모양·탭·번호·글머리표·문단 모양·스타일·메모 모양·호환 설정)를 id 순서 그대로 옮긴다.
 * 한글 2022 이상(xml 1.5) 꼴로 쓴다 — 단위가 바뀐 값(문단 여백·탭 위치)은 hp:switch 의 HwpUnitChar 갈래에 HWPUNIT, 기본 갈래에
 * 레코드 값을 둔다(레코드는 HWPUNIT 의 2배로 적혀 있다).
 */

import { Cur, type Rec, el, escText, color, bit, bits, pick, BORDER_TYPES, BORDER_WIDTHS, LINE_SHAPES, NUM_FORMATS } from "./util.js"

export const NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" '
  + 'xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" '
  + 'xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" '
  + 'xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" '
  + 'xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" '
  + 'xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" '
  + 'xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" '
  + 'xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"'
export const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>'
/** 단위가 바뀐 값의 HWPUNIT 갈래 */
export const UNIT_CASE = "http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"
/** case(HWPUNIT, 레코드 값의 절반)·default(레코드 값) 두 갈래 */
export function unitSwitch(caseXml: string, defaultXml: string): string {
  return `<hp:switch><hp:case hp:required-namespace="${UNIT_CASE}">${caseXml}</hp:case><hp:default>${defaultXml}</hp:default></hp:switch>`
}

const TAG = {
  DOCUMENT_PROPERTIES: 0x10, ID_MAPPINGS: 0x11, BIN_DATA: 0x12, FACE_NAME: 0x13, BORDER_FILL: 0x14, CHAR_SHAPE: 0x15, TAB_DEF: 0x16,
  NUMBERING: 0x17, BULLET: 0x18, PARA_SHAPE: 0x19, STYLE: 0x1a, COMPATIBLE_DOCUMENT: 0x1e, LAYOUT_COMPATIBILITY: 0x1f,
  TRACKCHANGE: 0x20, MEMO_SHAPE: 0x5c, TRACK_CHANGE: 0x60, TRACK_CHANGE_AUTHOR: 0x61,
} as const

const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"] as const
const LANG_ATTRS = ["hangul", "latin", "hanja", "japanese", "other", "symbol", "user"] as const
const FONT_TYPES = ["REP", "TTF", "HFT"] as const
const FONT_FAMILIES = ["FCAT_UNKNOWN", "FCAT_MYUNGJO", "FCAT_GOTHIC", "FCAT_SSERIF", "FCAT_BRUSHSCRIPT", "FCAT_DECORATIVE",
  "FCAT_NONRECTMJ", "FCAT_NONRECTGT"] as const
const SLASH_TYPES = ["NONE", "NONE", "CENTER", "CENTER_BELOW", "NONE", "NONE", "CENTER_ABOVE", "ALL"] as const
const UNDERLINE_TYPES = ["NONE", "BOTTOM", "CENTER", "TOP"] as const
const OUTLINE_TYPES = ["NONE", "SOLID", "DOT", "BOLD", "DASH", "DASH_DOT", "DASH_DOT_DOT"] as const
const SHADOW_TYPES = ["NONE", "DROP", "CONTINUOUS"] as const
const SYM_MARKS = ["NONE", "DOT_ABOVE", "RING_ABOVE", "TILDE", "CARON", "SIDE", "COLON", "GRAVE_ACCENT", "ACUTE_ACCENT", "CIRCUMFLEX",
  "MACRON", "HOOK_ABOVE", "DOT_BELOW"] as const
const TAB_TYPES = ["LEFT", "RIGHT", "CENTER", "DECIMAL"] as const
const HEAD_ALIGNS = ["LEFT", "CENTER", "RIGHT"] as const
const PARA_ALIGNS = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"] as const
const VERT_ALIGNS = ["BASELINE", "TOP", "CENTER", "BOTTOM"] as const
const HEADING_TYPES = ["NONE", "OUTLINE", "NUMBER", "BULLET"] as const
const LATIN_BREAKS = ["KEEP_WORD", "HYPHENATION", "BREAK_WORD"] as const
const LINE_WRAPS = ["BREAK", "SQUEEZE", "KEEP"] as const
const LINE_SPACINGS = ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"] as const
export const GRADATIONS = ["LINEAR", "LINEAR", "RADIAL", "CONICAL", "SQUARE"] as const
const IMG_MODES = ["TILE", "TILE_HORZ_TOP", "TILE_HORZ_BOTTOM", "TILE_VERT_LEFT", "TILE_VERT_RIGHT", "TOTAL", "CENTER", "CENTER_TOP",
  "CENTER_BOTTOM", "LEFT_CENTER", "LEFT_TOP", "LEFT_BOTTOM", "RIGHT_CENTER", "RIGHT_TOP", "RIGHT_BOTTOM", "ZOOM"] as const
const IMG_EFFECTS = ["REAL_PIC", "GRAY_SCALE", "BLACK_WHITE", "PATTERN8x8"] as const
const TARGET_PROGRAMS = ["HWP201X", "HWP200X", "MS_WORD"] as const
const MEMO_TYPES = ["NOMAL", "USER_INSERT", "USER_DELETE", "USER_UPDATE"] as const

/** BinData 순번 → 패키지 항목 id (한글처럼 처음 참조한 차례로 image1, image2 … 를 매긴다) */
export type BinRef = (binId: number) => string

/** 그림 채우기의 그림 — 밝기·명암·효과·BinData id */
export function imgXml(c: Cur, alpha: number, ref: BinRef): string {
  // 그림 개체(SHAPE_COMPONENT_PICTURE)와 같이 명암이 먼저다 — 쪽 배경 워터마크(밝기 50·명암 -15)로 확인
  const contrast = c.i8(), bright = c.i8(), effect = c.u8(), id = c.u16()
  return el("hc:img", [["binaryItemIDRef", id ? ref(id) : ""], ["bright", bright], ["contrast", contrast],
    ["effect", pick(IMG_EFFECTS, effect)], ["alpha", alpha]])
}

/**
 * 채우기 정보(BORDER_FILL·도형 공용) → hc:fillBrush. 레코드: 채우기 종류 u32(1 면색·2 그림·4 그러데이션) 뒤에 종류별 정보,
 * 추가 정보 길이 u32 와 추가 정보(그러데이션 번짐 중심), 끝에 종류별 투명도 바이트
 */
export function fillBrushXml(c: Cur, ref: BinRef): string {
  const type = c.u32()
  // 채우기가 없어도 추가 채우기 속성 길이(DWORD)는 있다 — 그 뒤 그림자·인스턴스 id 가 밀리지 않게 넘긴다
  if (!type) { c.skip(c.u32()); return "" }
  let win = "", grad = "", img = ""
  let winFace = 0, winHatch = 0, hatchStyle = -1
  if (type & 1) { winFace = c.u32(); winHatch = c.u32(); hatchStyle = c.i32() }
  let gradAttrs: Array<[string, string | number]> = [], gradColors: number[] = []
  if (type & 4) {
    // 공개 명세는 INT16 들이라 적었지만 실제 저장은 유형 BYTE, 각도·중심·번짐·색 수 INT32 다
    const gtype = c.u8(), angle = c.i32(), cx = c.i32(), cy = c.i32(), step = c.i32(), num = c.i32()
    const n = Math.max(0, num)
    if (n > 2) c.skip(4 * n)
    for (let i = 0; i < n; i++) gradColors.push(c.u32())
    gradAttrs = [["type", pick(GRADATIONS, gtype)], ["angle", angle], ["centerX", cx], ["centerY", cy], ["step", step], ["colorNum", n]]
  }
  let imgMode = 0, imgStart = -1
  if (type & 2) { imgMode = c.u8(); imgStart = c.o; c.skip(5) }
  const extra = c.u32()
  let stepCenter = 50
  if (extra && type & 4) stepCenter = c.d[c.o] ?? 50
  c.skip(extra)
  const winAlpha = type & 1 ? c.u8() : 0
  const gradAlpha = type & 4 ? c.u8() : 0
  const imgAlpha = type & 2 ? c.u8() : 0
  if (type & 1) {
    win = el("hc:winBrush", [["faceColor", color(winFace)], ["hatchColor", color(winHatch)],
      ...(hatchStyle >= 0 ? [["hatchStyle", pick(HATCHES, hatchStyle)] as [string, string]] : []), ["alpha", winAlpha]])
  }
  if (type & 4) {
    grad = el("hc:gradation", [...gradAttrs, ["stepCenter", stepCenter], ["alpha", gradAlpha]],
      gradColors.map(v => el("hc:color", [["value", color(v)]])).join(""))
  }
  if (type & 2) {
    const ic = new Cur(c.d, imgStart)
    img = el("hc:imgBrush", [["mode", pick(IMG_MODES, imgMode)]], imgXml(ic, imgAlpha, ref))
  }
  return `<hc:fillBrush>${win}${grad}${img}</hc:fillBrush>`
}
const HATCHES = ["HORIZONTAL", "VERTICAL", "BACK_SLASH", "SLASH", "CROSS", "CROSS_DIAGONAL"] as const

function fontFaces(recs: Rec[], counts: number[]): string {
  let k = 0
  let out = ""
  LANGS.forEach((lang, li) => {
    const n = counts[li] ?? 0
    let fonts = ""
    for (let id = 0; id < n; id++) {
      const r = recs[k++]
      if (!r) break
      const c = new Cur(r.data)
      const flags = c.u8()
      const face = c.str()
      let inner = ""
      if (flags & 0x80) {
        const t = c.u8()
        const alt = c.str()
        inner += el("hh:substFont", [["face", alt], ["type", pick(FONT_TYPES, t)], ["isEmbedded", 0], ["binaryItemIDRef", ""]])
      }
      if (flags & 0x40) {
        const p = [...c.d.subarray(c.o, c.o + 10)]
        c.skip(10)
        if (p[0] !== 0xff) {
          // 한글 기본 글꼴은 설치된 글꼴의 굵기로 고쳐 쓴다(옛 판 글꼴로 저장된 8 → 6)
          const weight = face === "함초롬바탕" || face === "함초롬돋움" ? 6 : p[2]
          inner += el("hh:typeInfo", [["familyType", FONT_FAMILIES[p[0]] ?? "FCAT_UNKNOWN"], ["weight", weight], ["proportion", p[3]],
            ["contrast", p[4]], ["strokeVariation", p[5]], ["armStyle", p[6]], ["letterform", p[7]], ["midline", p[8]], ["xHeight", p[9]]])
        }
      }
      fonts += el("hh:font", [["id", id], ["face", face], ["type", pick(FONT_TYPES, flags & 3)], ["isEmbedded", 0]], inner || undefined)
    }
    out += el("hh:fontface", [["lang", lang], ["fontCnt", n]], fonts)
  })
  return el("hh:fontfaces", [["itemCnt", LANGS.length]], out)
}

function borderFill(r: Rec, id: number, ref: BinRef): string {
  const c = new Cur(r.data)
  const a = c.u16()
  const side = (): Array<[string, string | number]> => {
    const type = c.u8(), width = c.u8(), col = c.u32()
    return [["type", pick(BORDER_TYPES, type)], ["width", pick(BORDER_WIDTHS, width)], ["color", color(col)]]
  }
  const left = side(), right = side(), top = side(), bottom = side()
  const dType = c.u8(), dWidth = c.u8(), dColor = c.u32()
  const slash = bits(a, 2, 3), back = bits(a, 5, 3)
  // 꺾은선은 / 대각선만 두 비트 값 그대로 — 비트 10 은 한글이 셀 나눔선(breakCellSeparateLine)으로 쓰고 \ 대각선 꺾은선은 0 으로 적는다
  let inner = el("hh:slash", [["type", pick(SLASH_TYPES, slash)], ["Crooked", bits(a, 8, 2)], ["isCounter", bit(a, 11)]])
    + el("hh:backSlash", [["type", pick(SLASH_TYPES, back)], ["Crooked", 0], ["isCounter", bit(a, 12)]])
    + el("hh:leftBorder", left) + el("hh:rightBorder", right) + el("hh:topBorder", top) + el("hh:bottomBorder", bottom)
  if (dType) inner += el("hh:diagonal", [["type", pick(BORDER_TYPES, dType)], ["width", pick(BORDER_WIDTHS, dWidth)], ["color", color(dColor)]])
  inner += fillBrushXml(c, ref)
  return el("hh:borderFill", [["id", id], ["threeD", bit(a, 0)], ["shadow", bit(a, 1)], ["centerLine", bit(a, 13) ? "VERTICAL" : "NONE"],
    ["breakCellSeparateLine", bit(a, 10)]], inner)
}

function charPr(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const lang = (read: () => number): Array<[string, number]> => LANG_ATTRS.map(k => [k, read()])
  const fontRef = lang(() => c.u16())
  const ratio = lang(() => c.u8())
  const spacing = lang(() => c.i8())
  const relSz = lang(() => c.u8())
  const offset = lang(() => c.i8())
  const height = c.i32()
  const a = c.u32()
  const shadowX = c.i8(), shadowY = c.i8()
  const textColor = c.u32(), underColor = c.u32(), shadeColor = c.u32(), shadowColor = c.u32()
  const borderFillId = r.data.length >= 70 ? c.u16() : 0
  const strikeColor = r.data.length >= 74 ? c.u32() : 0
  // 밑줄 종류 2(가운데)는 한글이 취소선으로 다뤄 밑줄 없음·실선·검정으로 쓴다. 취소선 비트가 서면 저장된 모양을 그대로 쓴다
  const underType = bits(a, 2, 2)
  let inner = el("hh:fontRef", fontRef) + el("hh:ratio", ratio) + el("hh:spacing", spacing) + el("hh:relSz", relSz) + el("hh:offset", offset)
  if (bit(a, 0)) inner += "<hh:italic/>"
  if (bit(a, 1)) inner += "<hh:bold/>"
  inner += el("hh:underline", [["type", underType === 2 ? "NONE" : pick(UNDERLINE_TYPES, underType)],
    ["shape", underType === 2 ? "SOLID" : pick(LINE_SHAPES, bits(a, 4, 4))], ["color", underType === 2 ? "#000000" : color(underColor)]])
  inner += el("hh:strikeout", [["shape", bits(a, 18, 3) ? pick(LINE_SHAPES, bits(a, 26, 4)) : "NONE"], ["color", color(strikeColor)]])
  inner += el("hh:outline", [["type", pick(OUTLINE_TYPES, bits(a, 8, 3))]])
  inner += el("hh:shadow", [["type", pick(SHADOW_TYPES, bits(a, 11, 2))], ["color", color(shadowColor)], ["offsetX", shadowX], ["offsetY", shadowY]])
  if (bit(a, 13)) inner += "<hh:emboss/>"
  if (bit(a, 14)) inner += "<hh:engrave/>"
  if (bit(a, 15)) inner += "<hh:supscript/>"
  if (bit(a, 16)) inner += "<hh:subscript/>"
  return el("hh:charPr", [["id", id], ["height", height], ["textColor", color(textColor)], ["shadeColor", color(shadeColor)],
    ["useFontSpace", bit(a, 25)], ["useKerning", bit(a, 30)], ["symMark", pick(SYM_MARKS, bits(a, 21, 4))], ["borderFillIDRef", borderFillId]], inner)
}

function tabPr(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const a = c.u32()
  const n = c.i32()
  let inner = ""
  for (let i = 0; i < n && c.rest >= 8; i++) {
    const pos = c.i32(), type = c.u8(), leader = c.u8()
    c.skip(2)
    const common: Array<[string, string | number]> = [["type", pick(TAB_TYPES, type)], ["leader", pick(BORDER_TYPES, leader)]]
    inner += unitSwitch(el("hh:tabItem", [["pos", Math.trunc(pos / 2)], ...common, ["unit", pos % 2 ? "CHAR" : "HWPUNIT"]]), el("hh:tabItem", [["pos", pos], ...common]))
  }
  return el("hh:tabPr", [["id", id], ["autoTabLeft", bit(a, 0)], ["autoTabRight", bit(a, 1)]], inner || undefined)
}

/** 문단 머리 정보 12바이트(속성·너비 보정·본문과의 거리·글자 모양) → paraHead 속성 */
function paraHeadAttrs(c: Cur): Array<[string, string | number]> {
  const a = c.u32(), widthAdjust = c.i16(), textOffset = c.i16(), charShape = c.u32()
  return [["align", pick(HEAD_ALIGNS, bits(a, 0, 2))], ["useInstWidth", bit(a, 2)], ["autoIndent", bit(a, 3)], ["widthAdjust", widthAdjust],
    ["textOffsetType", bit(a, 4) ? "HWPUNIT" : "PERCENT"], ["textOffset", textOffset], ["numFormat", pick(NUM_FORMATS, bits(a, 5, 4))],
    ["charPrIDRef", charShape], ["checkable", bit(a, 5)]]
}

function numbering(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const heads: Array<{ attrs: Array<[string, string | number]>; fmt: string }> = []
  for (let lv = 0; lv < 7; lv++) heads.push({ attrs: paraHeadAttrs(c), fmt: c.str() })
  const start = c.u16()
  const starts = heads.map(() => (c.rest >= 4 ? c.u32() : 1))
  // 수준 8~10 (한글 2018 이상) — 머리 정보 셋·형식 문자열 셋·시작 번호 셋. 없는 판은 한글이 빈 기본값(번호 1·DIGIT·글자 모양 0)으로 채운다
  if (c.rest >= 3 * 14 + 12) {
    const ext = [0, 1, 2].map(() => ({ attrs: paraHeadAttrs(c), fmt: c.str() }))
    for (const e of ext) heads.push(e)
    for (let i = 0; i < 3; i++) starts.push(c.u32())
  } else {
    for (let i = 0; i < 3; i++) { heads.push({ attrs: paraHeadAttrs(new Cur(Buffer.alloc(12))), fmt: "" }); starts.push(1) }
  }
  const inner = heads.map((h, i) => el("hh:paraHead", [["start", starts[i] ?? 1], ["level", i + 1], ...h.attrs], h.fmt ? escText(h.fmt) : undefined)).join("")
  return el("hh:numbering", [["id", id], ["start", start]], inner)
}

function bullet(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const head = paraHeadAttrs(c)
  const ch = String.fromCharCode(c.u16())
  const imageId = c.i32()
  // 체크 글자는 기록 끝 두 바이트 — 그림 글머리 정보가 4바이트인 24바이트 기록과 5바이트인 25바이트 기록이 있다
  const checked = r.data.length >= 24 ? r.data.readUInt16LE(r.data.length - 2) : 0
  let inner = el("hh:paraHead", [["level", 0], ...head])
  if (imageId) inner = el("hc:img", []) + inner
  // 체크 글자가 비었거나 공백이면 한글은 checkedChar 를 쓰지 않는다
  return el("hh:bullet", [["id", id], ["char", ch], ...(checked > 0x20 ? [["checkedChar", String.fromCharCode(checked)] as [string, string]] : []),
    ["useImage", imageId ? 1 : 0]], inner)
}

function paraPr(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const a1 = c.u32()
  const left = c.i32(), right = c.i32(), indent = c.i32(), prev = c.i32(), next = c.i32()
  const oldSpacing = c.i32()
  const tabDef = c.u16(), headId = c.u16(), borderFillId = c.u16()
  const off = [c.i16(), c.i16(), c.i16(), c.i16()]
  const a2 = c.u32()
  const hasNew = r.data.length >= 54
  const a3 = hasNew ? c.u32() : 0
  const spacing = hasNew ? c.u32() : oldSpacing
  const spType = hasNew ? bits(a3, 0, 5) : bits(a1, 0, 2)
  // 제목 수준 전체 값(0~9) — 3비트 칸(bits 25-27)은 7 이상을 못 담는다. 8수준 이상은 한글 2016 문단 이름공간 갈래에만 적는다
  const level = r.data.length >= 58 ? c.u32() : bits(a1, 25, 3)
  const headType = pick(HEADING_TYPES, bits(a1, 23, 2))
  const heading = level >= 7
    ? `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/paragraph">${el("hh:heading", [["type", headType], ["idRef", headId], ["level", level]])}</hp:case>`
      + `<hp:default>${el("hh:heading", [["type", "NONE"], ["idRef", 0], ["level", 0]])}</hp:default></hp:switch>`
    : el("hh:heading", [["type", headType], ["idRef", headId], ["level", level]])
  // HwpUnitChar 갈래는 값의 절반 — 반으로 안 나뉘는 홀수 값은 한글이 글자 단위(CHAR)로 적는다
  const margins = (div: number): string => {
    const m = (tag: string, x: number): string => el(tag, [["value", div === 1 ? x : Math.trunc(x / div)], ["unit", div !== 1 && x % 2 ? "CHAR" : "HWPUNIT"]])
    return "<hh:margin>" + m("hc:intent", indent) + m("hc:left", left) + m("hc:right", right) + m("hc:prev", prev) + m("hc:next", next) + "</hh:margin>"
  }
  const lineSpacing = (div: number): string => el("hh:lineSpacing", [["type", pick(LINE_SPACINGS, spType)],
    ["value", spType === 0 || div === 1 ? spacing : Math.trunc(spacing / div)], ["unit", "HWPUNIT"]])
  const inner = el("hh:align", [["horizontal", pick(PARA_ALIGNS, bits(a1, 2, 3))], ["vertical", pick(VERT_ALIGNS, bits(a1, 20, 2))]])
    + heading
    + el("hh:breakSetting", [["breakLatinWord", pick(LATIN_BREAKS, bits(a1, 5, 2))], ["breakNonLatinWord", bit(a1, 7) ? "KEEP_WORD" : "BREAK_WORD"],
      ["widowOrphan", bit(a1, 16)], ["keepWithNext", bit(a1, 17)], ["keepLines", bit(a1, 18)], ["pageBreakBefore", bit(a1, 19)],
      ["lineWrap", pick(LINE_WRAPS, bits(a2, 0, 2))]])
    + el("hh:autoSpacing", [["eAsianEng", bit(a2, 4)], ["eAsianNum", bit(a2, 5)]])
    + unitSwitch(margins(2) + lineSpacing(2), margins(1) + lineSpacing(1))
    + el("hh:border", [["borderFillIDRef", borderFillId], ["offsetLeft", off[0]], ["offsetRight", off[1]], ["offsetTop", off[2]],
      ["offsetBottom", off[3]], ["connect", bit(a1, 28)], ["ignoreMargin", bit(a1, 29)]])
  // 글 방향은 한글 2024 꼴로 적는다 — 속성2 비트 3 이 켜진 문단 모양은 LTR, 나머지는 AUTO(한글 2022 는 이 속성을 쓰지 않는다)
  return el("hh:paraPr", [["id", id], ["tabPrIDRef", tabDef], ["condense", bits(a1, 9, 7)], ["fontLineHeight", bit(a1, 22)],
    ["snapToGrid", bit(a1, 8)], ["suppressLineNumbers", bit(a2, 2)], ["checked", 0], ["textDir", bit(a2, 3) ? "LTR" : "AUTO"]], inner)
}

function style(r: Rec, id: number, paraIds: number[]): string {
  const c = new Cur(r.data)
  const name = c.str(), engName = c.str()
  const a = c.u8(), nextId = c.u8(), langId = c.i16(), paraShape = c.u16(), charShape = c.u16()
  return el("hh:style", [["id", id], ["type", bits(a, 0, 2) === 1 ? "CHAR" : "PARA"], ["name", name], ["engName", engName],
    ["paraPrIDRef", paraIds[paraShape] ?? paraShape], ["charPrIDRef", charShape], ["nextStyleIDRef", nextId], ["langID", langId], ["lockForm", bit(a, 2)]])
}

function memoPr(r: Rec, id: number): string {
  const c = new Cur(r.data)
  const width = c.u32(), lineWidth = c.u8(), lineType = c.u8(), lineColor = c.u32(), fillColor = c.u32(), activeColor = c.u32(), type = c.u16()
  return el("hh:memoPr", [["id", id], ["width", width], ["lineWidth", lineWidth], ["lineType", pick(BORDER_TYPES, lineType)],
    ["lineColor", color(lineColor)], ["fillColor", color(fillColor)], ["activeColor", color(activeColor)], ["memoType", pick(MEMO_TYPES, type)]])
}

/** 문서 속성(구역 수·시작 번호·캐럿 위치) */
export interface DocProps { secCnt: number; begin: number[]; caret: [number, number, number] }

export function docProps(recs: Rec[]): DocProps {
  const r = recs.find(x => x.tagId === TAG.DOCUMENT_PROPERTIES)
  const c = new Cur(r?.data ?? Buffer.alloc(0))
  const secCnt = c.u16()
  const begin = [c.u16(), c.u16(), c.u16(), c.u16(), c.u16(), c.u16()]
  return { secCnt, begin, caret: [c.u32(), c.u32(), c.u32()] }
}

/** ID_MAPPINGS 의 목록별 개수 칸 */
const SLOT: Record<number, number> = { [TAG.BORDER_FILL]: 8, [TAG.CHAR_SHAPE]: 9, [TAG.TAB_DEF]: 10, [TAG.NUMBERING]: 11, [TAG.BULLET]: 12,
  [TAG.PARA_SHAPE]: 13, [TAG.STYLE]: 14, [TAG.MEMO_SHAPE]: 15 }

function idCounts(recs: Rec[]): number[] {
  const idm = new Cur(recs.find(r => r.tagId === TAG.ID_MAPPINGS)?.data ?? Buffer.alloc(0))
  const counts: number[] = []
  while (idm.rest >= 4) counts.push(idm.i32())
  return counts
}

/** DocInfo 목록 하나 — 길이는 ID_MAPPINGS 가 정한다(그 뒤에 남은 레코드는 쓰지 않는다) */
function recordsOf(recs: Rec[], counts: number[], tag: number): Rec[] {
  const all = recs.filter(r => r.tagId === tag)
  const n = counts[SLOT[tag] ?? -1]
  return n !== undefined && n >= 0 ? all.slice(0, n) : all
}

/** 문단 모양 번호 → paraPr id. 기록 바이트가 같은 문단 모양은 한글처럼 처음 것 하나로 합친다(글자 모양·테두리는 합치지 않는다) */
export function paraShapeIds(recs: Rec[]): number[] {
  const seen = new Map<string, number>()
  return recordsOf(recs, idCounts(recs), TAG.PARA_SHAPE).map(r => {
    const k = r.data.toString("hex")
    if (!seen.has(k)) seen.set(k, seen.size)
    return seen.get(k)!
  })
}

/** DocInfo 레코드 → header.xml. secCnt 는 실제로 쓰는 구역 수(다르면 한글이 열기를 거부한다) */
export function headerXml(recs: Rec[], linkInfo: { path: string; pageInherit: number; footnoteInherit: number }, ref: BinRef, secCnt: number): string {
  const props = docProps(recs)
  const counts = idCounts(recs)
  const of = (tag: number): Rec[] => recordsOf(recs, counts, tag)
  const paraIds = paraShapeIds(recs)
  const list = (name: string, items: string[]): string => (items.length ? el(name, [["itemCnt", items.length]], items.join("")) : "")

  const [bPage, bFoot, bEnd, bPic, bTbl, bEq] = props.begin
  let refList = fontFaces(of(TAG.FACE_NAME), counts.slice(1, 8))
  refList += list("hh:borderFills", of(TAG.BORDER_FILL).map((r, i) => borderFill(r, i + 1, ref)))
  refList += list("hh:charProperties", of(TAG.CHAR_SHAPE).map((r, i) => charPr(r, i)))
  refList += list("hh:tabProperties", of(TAG.TAB_DEF).map((r, i) => tabPr(r, i)))
  refList += list("hh:numberings", of(TAG.NUMBERING).map((r, i) => numbering(r, i + 1)))
  refList += list("hh:bullets", of(TAG.BULLET).map((r, i) => bullet(r, i + 1)))
  refList += list("hh:paraProperties", of(TAG.PARA_SHAPE).flatMap((r, i) => (paraIds.indexOf(paraIds[i]) === i ? [paraPr(r, paraIds[i])] : [])))
  refList += list("hh:styles", of(TAG.STYLE).map((r, i) => style(r, i, paraIds)))
  refList += list("hh:memoProperties", of(TAG.MEMO_SHAPE).map((r, i) => memoPr(r, i + 1)))

  const compat = new Cur(recs.find(r => r.tagId === TAG.COMPATIBLE_DOCUMENT)?.data ?? Buffer.alloc(0)).u32()
  const track = new Cur(recs.find(r => r.tagId === TAG.TRACKCHANGE)?.data ?? Buffer.alloc(0)).u32()
  return XML_DECL + `<hh:head ${NS} version="1.5" secCnt="${secCnt}">`
    + el("hh:beginNum", [["page", bPage], ["footnote", bFoot], ["endnote", bEnd], ["pic", bPic], ["tbl", bTbl], ["equation", bEq]])
    + `<hh:refList>${refList}</hh:refList>`
    + el("hh:compatibleDocument", [["targetProgram", pick(TARGET_PROGRAMS, compat)]], "<hh:layoutCompatibility/>")
    + el("hh:docOption", [], el("hh:linkinfo", [["path", linkInfo.path], ["pageInherit", linkInfo.pageInherit], ["footnoteInherit", linkInfo.footnoteInherit]]))
    + el("hh:trackchageConfig", [["flags", track]])
    + "</hh:head>"
}
