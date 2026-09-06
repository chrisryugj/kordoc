/**
 * HWP5 렌더 어댑터 (#75 Task 7) — BodyText 레코드(PARA_LINE_SEG·CTRL_HEADER/TABLE/LIST_HEADER·SHAPE_COMPONENT(_PICTURE))를
 * HWPX 조판 캐시와 같은 뜻의 section DOM 으로 합성해 공용 SVG 렌더러(svg-render)에 넘긴다.
 *
 * 근거: 같은 문서를 한컴이 HWPX 로 저장하면 lineseg(textpos/vertpos/horzpos/horzsize)·cellAddr/cellSz·pos/sz/outMargin 이
 * HWP5 레코드 값과 1:1 이다(bench/corpus/pairs hwp↔hwpx 실측, 2026-09-06). 그리기(페이지 분할·표 격자·이미지·region)는
 * svg-render 하나가 맡고, 이 모듈은 레코드 → 속성 번역만 한다. 목표는 픽셀 파리티가 아니라 **결정적·페이지 로컬 region**.
 *
 * 레코드 레이아웃(pairs 실측 · 스펙 5.0 rev1.3):
 *  - PARA_LINE_SEG 36B: textpos u32 | vertpos i32 | lineHeight | textHeight | baseline | spacing | horzpos | horzsize | flags
 *  - CTRL_HEADER 개체 공통 attr u32@4: bit0 treatAsChar · bit3-4 vertRelTo(0 PAPER/1 PAGE/2 PARA) · bit5-7 vertAlign ·
 *    bit8-9 horzRelTo(0 PAPER/1 PAGE/2 COLUMN/3 PARA) · bit10-12 horzAlign · bit21-23 textWrap(0 SQUARE/1 TOP_AND_BOTTOM/2 BEHIND/3 FRONT);
 *    vertOffset i32@8 · horzOffset@12 · width u32@16 · height@20 · outMargin u16×4@28(l r t b)
 *  - TABLE: rows u16@4 · cols@6 · inMargin u16×4@10. LIST_HEADER(셀): attr u32@2(bit5-6 vertAlign) · col u16@8 row@10 cs@12 rs@14 ·
 *    w u32@16 h@20 · margin u16×4@24 · borderFillId u16@32 (parser.ts parseCell 과 동일)
 *  - SHAPE_COMPONENT(gso 직속): "gso "@0 · chid@4 · offset i32@8/@12 · orgSz u32@20/@24 · curSz@28/@32. 묶음($con) 안 자식은 4바이트
 *    접두가 없어 chid@0 · offset@4/@8 · orgSz@16/@20 · curSz@24/@28 (licbyl 18018145 실측, 중첩 묶음도 같은 꼴). PICTURE: crop i32×4@44 · binDataId u16@71
 *  - DocInfo BORDER_FILL: 속성 u16@0 · 변 4개(왼/오/위/아래) = @2+6k (type u8 · width u8 · COLORREF) · 대각선 @26 · 채우기 type u32@32 ·
 *    배경 COLORREF@36 (pairs header.xml 대조: type 1=SOLID·8=DOUBLE_SLIM, width 1=0.12mm·6=0.4mm·7=0.5mm, 배경 0xFFFFFFFF=없음).
 *    CHAR_SHAPE: faceId u16@0 · ratio u8@14 · spacing i8@21 · relSize u8@28 · baseSize@42(1/100pt) · attr@46(bit0 italic·bit1 bold·bit2-3 underline) · color@52
 *
 * 한계(HWPX 경로와 동일): 머리말·꼬리말·각주 미렌더, 수식·OLE 경고, 조판 캐시(LINE_SEG) 없는 비한컴 저장본 문단은 reflow 폴백.
 * 한컴 접힘 PUA-A(결재란 "(인)" 등)는 글리프 복원을 우선해 그 문단 안에서만 슬롯이 어긋날 수 있다.
 */

import {
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE, TAG_PARA_LINE_SEG, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  TAG_SHAPE_COMPONENT, TAG_SHAPE_COMPONENT_PICTURE, TAG_ID_MAPPINGS, TAG_FACE_NAME, TAG_DOC_CHAR_SHAPE, TAG_DOC_PARA_SHAPE,
  isExtendedOnlyCtrlChar, parseDocInfo, type HwpRecord, type HwpDocInfo,
} from "../hwp5/record.js"
import { openHwp5Container, readHwp5DocInfoRecords, readHwp5SectionStreams, readHwp5SectionRecords, readHwp5BinData } from "../hwp5/parser.js"
import { indexHwp5Tables } from "../hwp5/table-ids.js"
import { detectImageMime } from "../hwp5/images.js"
import { mapPuaText } from "../shared/pua.js"
import { createXmlParser } from "../hwpx/parser-shared.js"
import { hwpFaceToCssStack, DEFAULT_PARA_GEOM, type RenderStyles, type RenderBorderEdge, type RenderBorderFill, type ParaAlign } from "./head-styles.js"
import { renderSectionRoots, assemblePageSvgs, escapeXml, type RenderSvgOptions, type HwpxPagesResult, type SectionRoot, type RenderImages } from "./svg-render.js"
import { KordocError } from "../utils.js"
import type { ParseWarning } from "../types.js"

// record.ts 미정의 태그 (HWPTAG_BEGIN = 0x10)
const TAG_BORDER_FILL = 0x0014            // +4
const TAG_PAGE_DEF = 0x0049               // +57
const TAG_SHAPE_COMPONENT_LINE = 0x004e   // +62
const TAG_SHAPE_COMPONENT_POLYGON = 0x0052 // +66
const TAG_SHAPE_COMPONENT_CURVE = 0x0053  // +67

/** 4바이트 ASCII → u32 (LE 저장을 readUInt32LE 로 읽은 값과 비교) */
function cid(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0
}
function swap32(id: number): number {
  return (((id & 0xff) << 24) | (((id >>> 8) & 0xff) << 16) | (((id >>> 16) & 0xff) << 8) | ((id >>> 24) & 0xff)) >>> 0
}
const CTRL_TBL = cid("tbl "), CTRL_GSO = cid("gso "), CTRL_SECD = cid("secd"), CTRL_COLD = cid("cold"), CTRL_EQED = cid("eqed")
const CHID_PIC = cid("$pic"), CHID_REC = cid("$rec"), CHID_LIN = cid("$lin"), CHID_ELL = cid("$ell"), CHID_POL = cid("$pol"),
  CHID_CUR = cid("$cur"), CHID_ARC = cid("$arc"), CHID_CON = cid("$con")
const KNOWN = new Set([CTRL_TBL, CTRL_GSO, CTRL_SECD, CTRL_COLD, CTRL_EQED, CHID_PIC, CHID_REC, CHID_LIN, CHID_ELL, CHID_POL, CHID_CUR, CHID_ARC, CHID_CON])
/** 비표준 작성기의 BE 저장 id 방어 — 알려진 id 로 스왑 일치할 때만 */
function normId(raw: number): number {
  if (KNOWN.has(raw)) return raw
  const sw = swap32(raw)
  return KNOWN.has(sw) ? sw : raw
}

/** COLORREF(0x00BBGGRR) → #RRGGBB. 상위 바이트가 있으면(0xFFFFFFFF 등 "없음") null */
function colorHex(c: number): string | null {
  if ((c >>> 24) !== 0) return null
  const h = (v: number) => v.toString(16).padStart(2, "0").toUpperCase()
  return `#${h(c & 0xff)}${h((c >>> 8) & 0xff)}${h((c >>> 16) & 0xff)}`
}

// ─── DocInfo → RenderStyles ────────────────────────

/** 테두리선 굵기 코드(u8) → mm (스펙 표 26) */
const BORDER_WIDTH_MM = [0.1, 0.12, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 1.0, 1.5, 2.0, 3.0, 4.0, 5.0]
/** 테두리선 종류 코드(u8) → HWPX type 명 (0 없음 · 1 실선 · 8 이중선, pairs 실측) */
const BORDER_TYPE = ["NONE", "SOLID", "DASH", "DOT", "DASH_DOT", "DASH_DOT_DOT", "LONG_DASH", "CIRCLE", "DOUBLE_SLIM", "SLIM_THICK", "THICK_SLIM", "SLIM_THICK_SLIM", "WAVE", "DOUBLE_WAVE", "THICK_3D", "THICK_3D_LIFTED", "3D", "3D_LIFTED"]
const MM_TO_PT = 2.834645

function borderEdge(d: Buffer, o: number): RenderBorderEdge | undefined {
  const type = d[o]
  if (type === 0) return undefined
  const mm = BORDER_WIDTH_MM[d[o + 1]] ?? 0.12
  return { type: BORDER_TYPE[type] ?? "SOLID", widthPt: mm * MM_TO_PT, color: colorHex(d.readUInt32LE(o + 2)) ?? "#000000" }
}

function borderFillOf(d: Buffer): RenderBorderFill {
  const bf: RenderBorderFill = {}
  if (d.length < 26) return bf
  const l = borderEdge(d, 2), r = borderEdge(d, 8), t = borderEdge(d, 14), b = borderEdge(d, 20)
  if (l) bf.left = l
  if (r) bf.right = r
  if (t) bf.top = t
  if (b) bf.bottom = b
  if (d.length >= 40) {
    const fillType = d.readUInt32LE(32)
    if (fillType & 1) { const bg = colorHex(d.readUInt32LE(36)); if (bg) bf.fill = bg }
  }
  return bf
}

/** FACE_NAME: attr u8@0 · 이름(len u16 + WCHAR)@1 */
function readFaceName(d: Buffer): string {
  if (d.length < 3) return ""
  const len = d.readUInt16LE(1)
  const end = 3 + len * 2
  return end <= d.length ? d.subarray(3, end).toString("utf16le") : ""
}

const PARA_ALIGNS: ParaAlign[] = ["JUSTIFY", "LEFT", "RIGHT", "CENTER", "DISTRIBUTE", "DISTRIBUTE_SPACE"]
const LINE_SPACING_TYPES = ["PERCENT", "FIXED", "BETWEEN_LINES", "AT_LEAST"]

/** DocInfo 레코드 → 렌더 스타일 테이블. id 는 HWPX 와 같은 규약(charPr/paraPr 0-based · borderFill 1-based) */
export function buildHwp5RenderStyles(records: HwpRecord[]): RenderStyles {
  const idm = records.find(r => r.tagId === TAG_ID_MAPPINGS)
  const hangulCount = idm && idm.data.length >= 8 ? idm.data.readUInt32LE(4) : Number.POSITIVE_INFINITY
  const faces: string[] = []
  for (const r of records) {
    if (r.tagId !== TAG_FACE_NAME) continue
    if (faces.length >= hangulCount) break
    faces.push(readFaceName(r.data))
  }
  const charPr: RenderStyles["charPr"] = new Map()
  let ci = 0
  for (const r of records) {
    if (r.tagId !== TAG_DOC_CHAR_SHAPE) continue
    const d = r.data
    const id = String(ci++)
    if (d.length < 50) { charPr.set(id, { height: 1000, bold: false, italic: false, underline: false, ratio: 100, spacing: 0 }); continue }
    const face = faces[d.readUInt16LE(0)]
    const rel = d[28] || 100
    const attr = d.readUInt32LE(46)
    const color = d.length >= 56 ? colorHex(d.readUInt32LE(52)) : null
    charPr.set(id, {
      height: Math.max(100, Math.round(d.readInt32LE(42) * rel / 100)),
      bold: (attr & 2) !== 0, italic: (attr & 1) !== 0, underline: ((attr >>> 2) & 3) !== 0,
      ratio: d[14] || 100, spacing: d.readInt8(21),
      ...(color && color !== "#000000" ? { color } : {}),
      ...(face ? { fontFamily: hwpFaceToCssStack(face), face } : {}),
    })
  }
  const paraAlign: RenderStyles["paraAlign"] = new Map()
  const paraGeom: RenderStyles["paraGeom"] = new Map()
  let pi = 0
  for (const r of records) {
    if (r.tagId !== TAG_DOC_PARA_SHAPE) continue
    const d = r.data
    const id = String(pi++)
    if (d.length < 28) { paraAlign.set(id, "JUSTIFY"); paraGeom.set(id, { ...DEFAULT_PARA_GEOM }); continue }
    const attr1 = d.readUInt32LE(0)
    paraAlign.set(id, PARA_ALIGNS[(attr1 >>> 2) & 7] ?? "JUSTIFY")
    paraGeom.set(id, {
      lineSpacingType: LINE_SPACING_TYPES[attr1 & 3] ?? "PERCENT",
      lineSpacingValue: d.length >= 54 ? d.readUInt32LE(50) : d.readInt32LE(24),
      marginLeft: d.readInt32LE(4), marginRight: d.readInt32LE(8), marginIntent: d.readInt32LE(12),
      spaceBefore: d.readInt32LE(16), spaceAfter: d.readInt32LE(20),
    })
  }
  const borderFill: RenderStyles["borderFill"] = new Map()
  let bi = 0
  for (const r of records) if (r.tagId === TAG_BORDER_FILL) borderFill.set(String(++bi), borderFillOf(r.data))
  return { charPr, paraAlign, paraGeom, borderFill }
}

// ─── BodyText → section DOM(XML) ───────────────────

export interface Hwp5SectionXmlContext {
  /** CTRL_HEADER 레코드 인덱스 → 표 sourceId (table-ids.ts) */
  tableIds: Map<number, string>
  /** binDataId(DocInfo 1-based) → 이미지 참조(binaryItemIDRef). null 이면 외부 연결 등 미참조 */
  imageRef: (binDataId: number) => string | null
  warnings: string[]
}

interface CtrlRef { idx: number; id: number; start: number; end: number; used?: boolean }

const VREL = ["PAPER", "PAGE", "PARA", "PARA"], HREL = ["PAPER", "PAGE", "COLUMN", "PARA"]
const VALIGN = ["TOP", "CENTER", "BOTTOM", "TOP", "BOTTOM"], HALIGN = ["LEFT", "CENTER", "RIGHT", "LEFT", "RIGHT"]
const WRAP = ["SQUARE", "TOP_AND_BOTTOM", "BEHIND_TEXT", "IN_FRONT_OF_TEXT"]

interface ObjCommon { tac: boolean; wrap: string; w: number; h: number; posXml: string }

/** 개체 공통 속성(CTRL_HEADER) → hp:sz/pos/outMargin */
function objCommon(d: Buffer): ObjCommon {
  if (d.length < 36) return { tac: true, wrap: "SQUARE", w: 0, h: 0, posXml: `<hp:sz width="0" height="0"/><hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` }
  const a = d.readUInt32LE(4)
  const tac = (a & 1) !== 0
  const w = d.readUInt32LE(16), h = d.readUInt32LE(20)
  const posXml = `<hp:sz width="${w}" height="${h}"/>` +
    `<hp:pos treatAsChar="${tac ? 1 : 0}" vertRelTo="${VREL[(a >>> 3) & 3]}" horzRelTo="${HREL[(a >>> 8) & 3]}" vertAlign="${VALIGN[(a >>> 5) & 7] ?? "TOP"}" horzAlign="${HALIGN[(a >>> 10) & 7] ?? "LEFT"}" vertOffset="${d.readInt32LE(8)}" horzOffset="${d.readInt32LE(12)}"/>` +
    `<hp:outMargin left="${d.readUInt16LE(28)}" right="${d.readUInt16LE(30)}" top="${d.readUInt16LE(32)}" bottom="${d.readUInt16LE(34)}"/>`
  return { tac, wrap: WRAP[(a >>> 21) & 7] ?? "SQUARE", w, h, posXml }
}

/** 한컴 PUA-A 접힘 영역 (record.ts 와 동일 범위) */
const FOLD_START = 0xa000, FOLD_END = 0xa48c, FOLD_SHIFT = 0xf0000 - 0xa000

/** 텍스트 1글자 (제어문자 아님). XML 에 못 들어가는 코드는 U+FFFD */
function textChar(ch: number): string {
  if (ch >= FOLD_START && ch <= FOLD_END) {
    const mapped = mapPuaText(String.fromCodePoint(ch + FOLD_SHIFT))
    // 매핑 없으면 PUA 그대로 돌아온다 — 글리프가 없으니 비운다
    return /[\u{F0000}-\u{FFFFF}]/u.test(mapped) ? "" : mapped
  }
  if (ch === 0xfffe || ch === 0xffff || (ch >= 0xd800 && ch <= 0xdfff)) return "�"
  return String.fromCharCode(ch)
}

/** [start,end) 안의 `level` 문단 전부 → hp:p 나열 */
function paragraphsXml(records: HwpRecord[], start: number, end: number, level: number, ctx: Hwp5SectionXmlContext, depth: number): string {
  if (depth > 16) return ""
  let out = ""
  let i = start
  while (i < end) {
    const r = records[i]
    if (r.tagId === TAG_PARA_HEADER && r.level === level) {
      let j = i + 1
      while (j < end && records[j].level > level) j++
      out += paragraphXml(records, i, j, level, ctx, depth)
      i = j
    } else i++
  }
  return out
}

function paragraphXml(records: HwpRecord[], i: number, j: number, level: number, ctx: Hwp5SectionXmlContext, depth: number): string {
  const hdr = records[i]
  const paraShapeId = hdr.data.length >= 10 ? hdr.data.readUInt16LE(8) : 0
  const texts: Buffer[] = []
  const shapes: Array<[number, number]> = []
  const segs: Buffer[] = []
  const ctrls: CtrlRef[] = []
  let k = i + 1
  while (k < j) {
    const r = records[k]
    if (r.level === level + 1) {
      if (r.tagId === TAG_PARA_TEXT) texts.push(r.data)
      else if (r.tagId === TAG_CHAR_SHAPE) { for (let o = 0; o + 8 <= r.data.length; o += 8) shapes.push([r.data.readUInt32LE(o), r.data.readUInt32LE(o + 4)]) }
      else if (r.tagId === TAG_PARA_LINE_SEG) segs.push(r.data)
      else if (r.tagId === TAG_CTRL_HEADER && r.data.length >= 4) {
        let e = k + 1
        while (e < j && records[e].level > level + 1) e++
        ctrls.push({ idx: k, id: normId(r.data.readUInt32LE(0)), start: k + 1, end: e })
        k = e
        continue
      }
    }
    k++
  }
  const text = texts.length === 1 ? texts[0] : Buffer.concat(texts)

  // 확장 컨트롤 문자(ctrlIdx 순) ↔ CTRL_HEADER 순서 매핑 — record.ts 의 resolver 규약, 어긋나면 같은 id 의 미사용 컨트롤
  const ctrlElement = (ctrlIdx: number, rawId: number): string => {
    const id = normId(rawId)
    let c: CtrlRef | undefined = ctrls[ctrlIdx]
    if (!c || c.used || c.id !== id) c = ctrls.find(x => !x.used && x.id === id)
    if (!c) return "<hp:ctrl/>"
    c.used = true
    switch (c.id) {
      case CTRL_TBL: return tableXml(records, c, level, ctx, depth)
      case CTRL_GSO: return gsoXml(records, c, level, ctx, depth)
      case CTRL_SECD: return secPrXml(records, c)
      case CTRL_COLD: { const a = records[c.idx].data.length >= 8 ? records[c.idx].data.readUInt32LE(4) : 0; return `<hp:colPr colCount="${Math.max(1, (a >>> 2) & 0xff)}"/>` }
      case CTRL_EQED: { const oc = objCommon(records[c.idx].data); return `<hp:equation textWrap="${oc.wrap}">${oc.posXml}</hp:equation>` }
      default: return "<hp:ctrl/>"
    }
  }

  // 슬롯 모델(record.ts appendParaText 와 동일): 문자 1 · 문자형 제어 1 · 인라인/확장 제어 8. charShape 경계에서 run 교체
  let out = `<hp:p paraPrIDRef="${paraShapeId}" styleIDRef="0">`
  let shapeIdx = 0
  let run: string[] = []
  let textBuf = ""
  const flushText = () => { if (textBuf) { run.push(`<hp:t>${escapeXml(textBuf)}</hp:t>`); textBuf = "" } }
  const openRun = (id: number) => { out += `<hp:run charPrIDRef="${id}">` }
  const closeRun = () => { flushText(); out += run.join("") + "</hp:run>"; run = [] }
  openRun(shapes[0]?.[1] ?? 0)
  let pos = 0, ctrlIdx = 0, o = 0
  const switchShape = () => {
    while (shapeIdx + 1 < shapes.length && pos >= shapes[shapeIdx + 1][0]) { shapeIdx++; closeRun(); openRun(shapes[shapeIdx][1]) }
  }
  while (o + 1 < text.length) {
    switchShape()
    const ch = text.readUInt16LE(o)
    o += 2
    if (ch === 0x0d) break
    if (ch >= 0x20) {
      if (ch >= 0xd800 && ch <= 0xdbff && o + 1 < text.length) {
        const lo = text.readUInt16LE(o)
        if (lo >= 0xdc00 && lo <= 0xdfff) { textBuf += String.fromCharCode(ch, lo); o += 2; pos += 2; continue }
      }
      textBuf += textChar(ch)
      pos++
      continue
    }
    switch (ch) {
      case 0x09: flushText(); run.push("<hp:tab/>"); o += 14; pos += 8; break
      case 0x0a: {
        flushText(); run.push("<hp:lineBreak/>"); pos++
        // 수식 placeholder 0x0a+0x0b (record.ts 와 동일 특례)
        if (o + 16 <= text.length && text.readUInt16LE(o) === 0x000b) { run.push(ctrlElement(ctrlIdx++, text.readUInt32LE(o + 2))); o += 16; pos += 8 }
        break
      }
      case 0x00: flushText(); run.push("<hp:lineBreak/>"); pos++; break
      case 0x1e: flushText(); run.push("<hp:nbSpace/>"); pos++; break
      case 0x1f: flushText(); run.push("<hp:fwSpace/>"); pos++; break
      case 0x18: case 0x19: case 0x1a: case 0x1b: case 0x1c: case 0x1d: flushText(); run.push("<hp:hyphen/>"); pos++; break
      default: {
        const isInline = (ch >= 4 && ch <= 9) || ch === 19 || ch === 20
        if ((isExtendedOnlyCtrlChar(ch) || isInline) && o + 14 <= text.length) {
          flushText()
          if (isExtendedOnlyCtrlChar(ch)) run.push(ctrlElement(ctrlIdx++, text.readUInt32LE(o)))
          else run.push("<hp:ctrl/>")
          o += 14
          pos += 8
        } else pos++
      }
    }
  }
  closeRun()
  // 텍스트가 비어 있어도 컨트롤(secd 등)은 문자 스트림에 있다 — 문자 스트림에 없는 잔여 컨트롤은 문단 끝에 붙인다
  const rest = ctrls.filter(c => !c.used && (c.id === CTRL_TBL || c.id === CTRL_GSO || c.id === CTRL_SECD || c.id === CTRL_COLD))
  if (rest.length > 0) {
    openRun(shapes[0]?.[1] ?? 0)
    for (const c of rest) { const el = ctrlElement(ctrls.indexOf(c), c.id); run.push(el) }
    closeRun()
  }
  if (segs.length > 0) {
    out += "<hp:linesegarray>"
    for (const s of segs) {
      for (let off = 0; off + 36 <= s.length; off += 36) {
        out += `<hp:lineseg textpos="${s.readUInt32LE(off)}" vertpos="${s.readInt32LE(off + 4)}" vertsize="${s.readInt32LE(off + 8)}" textheight="${s.readInt32LE(off + 12)}" baseline="${s.readInt32LE(off + 16)}" spacing="${s.readInt32LE(off + 20)}" horzpos="${s.readInt32LE(off + 24)}" horzsize="${s.readInt32LE(off + 28)}" flags="${s.readUInt32LE(off + 32)}"/>`
      }
    }
    out += "</hp:linesegarray>"
  }
  return out + "</hp:p>"
}

/** 구역 정의(secd) → hp:secPr/pagePr (PAGE_DEF: width u32@0 height@4 left@8 right@12 top@16 bottom@20 header@24 footer@28 gutter@32 attr@36) */
function secPrXml(records: HwpRecord[], c: CtrlRef): string {
  for (let k = c.start; k < c.end; k++) {
    const r = records[k]
    if (r.tagId !== TAG_PAGE_DEF || r.data.length < 36) continue
    const d = r.data
    const u = (o: number) => d.readUInt32LE(o)
    const landscape = d.length >= 40 && (u(36) & 1) === 1 ? "NARROWLY" : "WIDELY"
    return `<hp:secPr><hp:pagePr landscape="${landscape}" width="${u(0)}" height="${u(4)}"><hp:margin left="${u(8)}" right="${u(12)}" top="${u(16)}" bottom="${u(20)}" header="${u(24)}" footer="${u(28)}" gutter="${u(32)}"/></hp:pagePr></hp:secPr>`
  }
  return "<hp:secPr/>"
}

const CELL_VALIGN = ["TOP", "CENTER", "BOTTOM", "TOP"]

/** 표 컨트롤 → hp:tbl (셀 = TABLE 레코드 뒤 LIST_HEADER + 같은 level 의 문단들, parser.ts parseTableControl 과 같은 분할) */
function tableXml(records: HwpRecord[], c: CtrlRef, level: number, ctx: Hwp5SectionXmlContext, depth: number): string {
  const common = objCommon(records[c.idx].data)
  let tableIdx = -1
  for (let k = c.start; k < c.end; k++) if (records[k].tagId === TAG_TABLE && records[k].data.length >= 18) { tableIdx = k; break }
  if (tableIdx < 0) return "<hp:ctrl/>"
  const t = records[tableIdx].data
  const rows = t.readUInt16LE(4), cols = t.readUInt16LE(6)
  const inMargin = `<hp:inMargin left="${t.readUInt16LE(10)}" right="${t.readUInt16LE(12)}" top="${t.readUInt16LE(14)}" bottom="${t.readUInt16LE(16)}"/>`
  const cellLevel = level + 2
  let cells = ""
  let k = tableIdx + 1
  while (k < c.end) {
    const r = records[k]
    if (r.tagId === TAG_LIST_HEADER && r.level === cellLevel) {
      let e = k + 1
      while (e < c.end) {
        const x = records[e]
        if (x.level < cellLevel) break
        if (x.level === cellLevel && (x.tagId === TAG_LIST_HEADER || x.tagId === TAG_TABLE)) break
        e++
      }
      cells += cellXml(records, k, e, cellLevel, ctx, depth)
      k = e
      continue
    }
    k++
  }
  if (!cells) return "<hp:ctrl/>"
  const id = ctx.tableIds.get(c.idx)
  return `<hp:tbl${id ? ` id="${id}"` : ""} textWrap="${common.wrap}" rowCnt="${rows}" colCnt="${cols}" cellSpacing="0">${common.posXml}${inMargin}<hp:tr>${cells}</hp:tr></hp:tbl>`
}

function cellXml(records: HwpRecord[], lh: number, end: number, cellLevel: number, ctx: Hwp5SectionXmlContext, depth: number): string {
  const d = records[lh].data
  if (d.length < 34) return ""
  const attr = d.readUInt32LE(2)
  const vAlign = CELL_VALIGN[(attr >>> 5) & 3]
  const paras = paragraphsXml(records, lh + 1, end, cellLevel, ctx, depth + 1)
  return `<hp:tc borderFillIDRef="${d.readUInt16LE(32)}"><hp:subList vertAlign="${vAlign}">${paras}</hp:subList>` +
    `<hp:cellAddr colAddr="${d.readUInt16LE(8)}" rowAddr="${d.readUInt16LE(10)}"/><hp:cellSpan colSpan="${Math.max(1, d.readUInt16LE(12))}" rowSpan="${Math.max(1, d.readUInt16LE(14))}"/>` +
    `<hp:cellSz width="${d.readUInt32LE(16)}" height="${d.readUInt32LE(20)}"/><hp:cellMargin left="${d.readUInt16LE(24)}" right="${d.readUInt16LE(26)}" top="${d.readUInt16LE(28)}" bottom="${d.readUInt16LE(30)}"/></hp:tc>`
}

interface ShapeComp { idx: number; chid: number; xoff: number; yoff: number; orgW: number; orgH: number; curW: number; curH: number }

/** nested=묶음 안 자식(4바이트 접두 없음) */
function readShapeComp(records: HwpRecord[], idx: number, nested = false): ShapeComp | null {
  const d = records[idx].data
  const b = nested ? 0 : 4
  if (d.length < b + 32) return null
  return { idx, chid: normId(d.readUInt32LE(b)), xoff: d.readInt32LE(b + 4), yoff: d.readInt32LE(b + 8), orgW: d.readUInt32LE(b + 16), orgH: d.readUInt32LE(b + 20), curW: d.readUInt32LE(b + 24), curH: d.readUInt32LE(b + 28) }
}

/** 묶음 자식들 — 컨테이너 SHAPE_COMPONENT 바로 아래 level 의 SHAPE_COMPONENT 만, 각 자식 범위는 다음 형제 전까지(중첩 묶음 재귀) */
function containerChildrenXml(records: HwpRecord[], scIdx: number, end: number, ctx: Hwp5SectionXmlContext): string {
  const childLevel = records[scIdx].level + 1
  let out = ""
  for (let k = scIdx + 1; k < end; k++) {
    if (records[k].tagId !== TAG_SHAPE_COMPONENT || records[k].level !== childLevel) continue
    const child = readShapeComp(records, k, true)
    if (!child) continue
    let e = k + 1
    while (e < end && !(records[e].tagId === TAG_SHAPE_COMPONENT && records[e].level <= childLevel)) e++
    const sizeXml = `<hp:sz width="${child.curW}" height="${child.curH}"/><hp:offset x="${child.xoff}" y="${child.yoff}"/>`
    out += child.chid === CHID_CON
      ? `<hp:container>${sizeXml}${containerChildrenXml(records, k, e, ctx)}</hp:container>`
      : shapeElement(records, child, k, e, sizeXml, "", ctx)
    k = e - 1
  }
  return out
}

/** 그리기 개체(gso) → hp:pic / rect / ellipse / line / polygon / curv / arc / container / ole */
function gsoXml(records: HwpRecord[], c: CtrlRef, level: number, ctx: Hwp5SectionXmlContext, depth: number): string {
  const common = objCommon(records[c.idx].data)
  let scIdx = -1
  for (let k = c.start; k < c.end; k++) if (records[k].tagId === TAG_SHAPE_COMPONENT) { scIdx = k; break }
  const sc = scIdx >= 0 ? readShapeComp(records, scIdx) : null
  if (!sc) return `<hp:ole textWrap="${common.wrap}">${common.posXml}</hp:ole>`
  // 글상자 문단 리스트: SHAPE_COMPONENT 뒤 첫 LIST_HEADER(같은 level+2)
  let textList = -1
  for (let k = scIdx + 1; k < c.end; k++) if (records[k].tagId === TAG_LIST_HEADER && records[k].level === level + 2) { textList = k; break }
  const geomEnd = textList >= 0 ? textList : c.end
  const drawText = textList >= 0 ? `<hp:drawText><hp:subList>${paragraphsXml(records, textList + 1, c.end, level + 2, ctx, depth + 1)}</hp:subList></hp:drawText>` : ""
  if (sc.chid === CHID_CON) return `<hp:container textWrap="${common.wrap}">${common.posXml}${containerChildrenXml(records, scIdx, geomEnd, ctx)}</hp:container>`
  return shapeElement(records, sc, scIdx, geomEnd, common.posXml, drawText, ctx, common.wrap)
}

/** chid 별 개체 요소. geometry 레코드는 [scIdx, end) 에서 찾는다 */
function shapeElement(records: HwpRecord[], sc: ShapeComp, scIdx: number, end: number, posXml: string, drawText: string, ctx: Hwp5SectionXmlContext, wrap?: string): string {
  const sizes = `<hp:orgSz width="${sc.orgW}" height="${sc.orgH}"/><hp:curSz width="${sc.curW}" height="${sc.curH}"/>`
  // 부유 개체의 textWrap — 없으면 렌더러가 TOP_AND_BOTTOM(밀어내기 역산)으로 보고 BEHIND/FRONT 개체(직인·워터마크)를 위로 올린다
  const wa = wrap ? ` textWrap="${wrap}"` : ""
  const find = (tag: number): Buffer | null => { for (let k = scIdx + 1; k < end; k++) if (records[k].tagId === tag) return records[k].data; return null }
  if (sc.chid === CHID_PIC) {
    const p = find(TAG_SHAPE_COMPONENT_PICTURE)
    let img = "<hp:img/>", clip = ""
    if (p && p.length >= 73) {
      const ref = ctx.imageRef(p.readUInt16LE(71))
      img = ref ? `<hp:img binaryItemIDRef="${ref}"/>` : "<hp:img/>"
      const cl = p.readInt32LE(44), ct = p.readInt32LE(48), cr = p.readInt32LE(52), cb = p.readInt32LE(56)
      if ((cl > 0 || ct > 0 || cr > 0 || cb > 0) && sc.orgW - cr > cl && sc.orgH - cb > ct) {
        clip = `<hp:imgClip left="${Math.max(0, cl)}" top="${Math.max(0, ct)}" right="${sc.orgW - Math.max(0, cr)}" bottom="${sc.orgH - Math.max(0, cb)}"/>`
      }
    }
    return `<hp:pic${wa}>${posXml}${sizes}<hp:imgDim dimwidth="${sc.orgW}" dimheight="${sc.orgH}"/>${clip}${img}</hp:pic>`
  }
  const line = `<hp:lineShape color="#000000" width="12" style="SOLID"/>`
  if (sc.chid === CHID_LIN) {
    const l = find(TAG_SHAPE_COMPONENT_LINE)
    const pts = l && l.length >= 16
      ? `<hp:startPt x="${l.readInt32LE(0)}" y="${l.readInt32LE(4)}"/><hp:endPt x="${l.readInt32LE(8)}" y="${l.readInt32LE(12)}"/>`
      : `<hp:startPt x="0" y="0"/><hp:endPt x="${sc.orgW}" y="${sc.orgH}"/>`
    return `<hp:line${wa}>${posXml}${sizes}${line}${pts}</hp:line>`
  }
  if (sc.chid === CHID_POL || sc.chid === CHID_CUR) {
    const g = find(sc.chid === CHID_POL ? TAG_SHAPE_COMPONENT_POLYGON : TAG_SHAPE_COMPONENT_CURVE)
    let pts = ""
    if (g && g.length >= 2) {
      const n = Math.min(g.readInt16LE(0), 4096)
      for (let k = 0; k < n && 2 + k * 8 + 8 <= g.length; k++) pts += `<hp:pt x="${g.readInt32LE(2 + k * 8)}" y="${g.readInt32LE(6 + k * 8)}"/>`
    }
    const tag = sc.chid === CHID_POL ? "polygon" : "curv"
    return `<hp:${tag}${wa}>${posXml}${sizes}${line}${pts}${drawText}</hp:${tag}>`
  }
  const tag = sc.chid === CHID_REC ? "rect" : sc.chid === CHID_ELL ? "ellipse" : sc.chid === CHID_ARC ? "arc" : "ole"
  return `<hp:${tag}${wa}>${posXml}${sizes}${line}${drawText}</hp:${tag}>`
}

/** 섹션 레코드 → HWPX 동형 section XML (svg-render 가 읽는 요소·속성만) */
export function hwp5SectionToXml(records: HwpRecord[], ctx: Hwp5SectionXmlContext): string {
  return `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">` +
    paragraphsXml(records, 0, records.length, 0, ctx, 0) + "</hs:sec>"
}

// ─── 엔트리 ───────────────────────────────────────

export interface RenderHwp5Options extends RenderSvgOptions {
  /** 암호 문서 열기 암호 */
  password?: string
}

/**
 * 레코드 단위 렌더 — 컨테이너를 이미 연 호출자(테스트·재사용)용. `secRecords` 의 null 구역은 생략.
 * 이미지는 참조된 BinData 만 dataURI 로 싣는다(HWPX 경로와 같은 장당·누적 한도).
 */
export function renderHwp5Records(
  docInfo: HwpDocInfo | null,
  styles: RenderStyles,
  secRecords: (HwpRecord[] | null)[],
  binData: Map<number, { data: Buffer; name: string }>,
  options?: RenderHwp5Options,
  select?: Set<number> | ((pageCount: number) => Set<number>),
  warnings: string[] = [],
): HwpxPagesResult {
  const maxImg = options?.maxImageBytes ?? 40 * 1024 * 1024
  const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024
  const images: RenderImages = new Map()
  let totalImgBytes = 0
  const imageRef = (binDataId: number): string | null => {
    if (binDataId <= 0) return null
    const item = docInfo?.binData[binDataId - 1]
    if (item?.kind === "link") return null
    const storageId = item && item.storageId > 0 ? item.storageId : binDataId
    const ref = `bin${storageId}`
    if (images.has(ref)) return ref
    const entry = binData.get(storageId)
    if (!entry) return ref // 누락은 렌더러가 placeholder + 경고
    if (entry.data.length > maxImg) { warnings.push(`이미지 ${entry.name} ${(entry.data.length / 1048576).toFixed(1)}MB — 한도 초과로 생략`); return ref }
    if (totalImgBytes + entry.data.length > MAX_TOTAL_IMAGE_BYTES) { warnings.push(`이미지 누적 ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1048576)}MB 한도 초과 — 이후 생략`); return ref }
    totalImgBytes += entry.data.length
    images.set(ref, { dataUri: `data:${detectImageMime(entry.data) ?? "image/jpeg"};base64,${entry.data.toString("base64")}` })
    return ref
  }
  const roots: SectionRoot[] = []
  let base = 0
  for (let si = 0; si < secRecords.length; si++) {
    const recs = secRecords[si]
    if (!recs) continue
    const { ids, count } = indexHwp5Tables(recs, base)
    base += count
    const xml = hwp5SectionToXml(recs, { tableIds: ids, imageRef, warnings })
    const doc = createXmlParser().parseFromString(xml, "text/xml")
    const root = doc.documentElement as unknown as Element
    if (!root) { warnings.push(`구역 ${si} 합성 DOM 생성 실패 — 생략`); continue }
    roots.push({ root, index: si })
  }
  if (roots.length === 0) throw new KordocError("렌더할 구역이 없습니다 — HWP 가 손상되었을 수 있습니다")
  const r = renderSectionRoots(roots, { styles, images, warnings, reflow: !!options?.reflow, reflowMode: options?.reflowMode ?? "keep", highlights: options?.highlights })
  return assemblePageSvgs(r, "hwp", select)
}

/** HWP5(OLE2) → 페이지별 독립 SVG + RenderScene. renderHwpxPages 와 같은 계약 (#75 Task 7) */
export function renderHwp5Pages(
  input: ArrayBuffer | Uint8Array,
  options?: RenderHwp5Options,
  select?: Set<number> | ((pageCount: number) => Set<number>),
): HwpxPagesResult {
  const buf = Buffer.from(input instanceof Uint8Array ? input : new Uint8Array(input))
  const c = openHwp5Container(buf, options)
  const warnings: string[] = c.warnings.map(w => w.message)
  const docInfoRecords = readHwp5DocInfoRecords(c)
  if (!docInfoRecords) warnings.push("DocInfo 없음 — 기본 스타일로 렌더")
  const styles = buildHwp5RenderStyles(docInfoRecords ?? [])
  const docInfo = docInfoRecords ? parseDocInfo(docInfoRecords) : null
  const sections = readHwp5SectionStreams(c)
  if (sections.length === 0) throw new KordocError("섹션 스트림을 찾을 수 없습니다")
  const parseWarnings: ParseWarning[] = []
  const secRecords = readHwp5SectionRecords(c, sections, parseWarnings)
  for (const w of parseWarnings) warnings.push(w.message)
  return renderHwp5Records(docInfo, styles, secRecords, readHwp5BinData(c), options, select, warnings)
}
