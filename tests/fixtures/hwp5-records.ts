/**
 * HWP5 합성 레코드 빌더 — hwp5-scene(렌더 어댑터) 단위 테스트용. CFB 컨테이너 없이 DocInfo·BodyText 레코드만 만든다.
 * 오프셋은 src/render/hwp5-scene.ts 헤더 주석(pairs 실측)과 같다.
 */

import type { HwpRecord } from "../../src/hwp5/record.js"

export function rec(tagId: number, level: number, data: Buffer): HwpRecord {
  return { tagId, level, size: data.length, data }
}

/** 4바이트 ASCII 컨트롤 id → 파일 저장 순서(LE) 바이트 */
export function ctrlIdBytes(s: string): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE((((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0), 0)
  return b
}

// ─── DocInfo ─────────────────────────────────────

export function idMappings(counts: number[]): HwpRecord {
  const b = Buffer.alloc(counts.length * 4)
  counts.forEach((c, i) => b.writeUInt32LE(c, i * 4))
  return rec(0x11, 0, b)
}

export function faceName(name: string): HwpRecord {
  const n = Buffer.from(name, "utf16le")
  const b = Buffer.alloc(3 + n.length)
  b[0] = 0x61
  b.writeUInt16LE(name.length, 1)
  n.copy(b, 3)
  return rec(0x13, 0, b)
}

/** CHAR_SHAPE 74B — baseSize 1/100pt, attr bit0 italic·bit1 bold·bit2-3 underline, color COLORREF */
export function docCharShape(o: { baseSize?: number; bold?: boolean; italic?: boolean; underline?: boolean; faceId?: number; ratio?: number; spacing?: number; relSize?: number; color?: number } = {}): HwpRecord {
  const b = Buffer.alloc(74)
  for (let i = 0; i < 7; i++) { b.writeUInt16LE(o.faceId ?? 0, i * 2); b[14 + i] = o.ratio ?? 100; b.writeInt8(o.spacing ?? 0, 21 + i); b[28 + i] = o.relSize ?? 100 }
  b.writeInt32LE(o.baseSize ?? 1000, 42)
  b.writeUInt32LE((o.italic ? 1 : 0) | (o.bold ? 2 : 0) | (o.underline ? 4 : 0), 46)
  b.writeUInt32LE(o.color ?? 0, 52)
  return rec(0x15, 0, b)
}

/** PARA_SHAPE 54B — align: 0 justify 1 left 2 right 3 center */
export function docParaShape(o: { align?: number; lineSpacing?: number; marginLeft?: number; indent?: number; before?: number } = {}): HwpRecord {
  const b = Buffer.alloc(54)
  b.writeUInt32LE(((o.align ?? 0) & 7) << 2, 0)
  b.writeInt32LE(o.marginLeft ?? 0, 4)
  b.writeInt32LE(o.indent ?? 0, 12)
  b.writeInt32LE(o.before ?? 0, 16)
  b.writeInt32LE(o.lineSpacing ?? 160, 24)
  b.writeUInt32LE(o.lineSpacing ?? 160, 50)
  return rec(0x19, 0, b)
}

/** BORDER_FILL — edges [왼, 오, 위, 아래] 각 [type, width, color]; fill 은 배경 COLORREF(없으면 채우기 없음) */
export function docBorderFill(edges: Array<[number, number, number?]>, fill?: number): HwpRecord {
  const b = Buffer.alloc(fill !== undefined ? 52 : 40)
  for (let i = 0; i < 4; i++) { const e = edges[i] ?? [0, 0, 0]; b[2 + i * 6] = e[0]; b[3 + i * 6] = e[1]; b.writeUInt32LE(e[2] ?? 0, 4 + i * 6) }
  if (fill !== undefined) { b.writeUInt32LE(1, 32); b.writeUInt32LE(fill, 36); b.writeUInt32LE(0, 40); b.writeInt32LE(-1, 44) }
  else b.writeUInt32LE(0, 32)
  return rec(0x14, 0, b)
}

// ─── BodyText ────────────────────────────────────

export function paraHeader(level: number, paraShapeId = 0, divideSort = 3): HwpRecord {
  const b = Buffer.alloc(24)
  b.writeUInt16LE(paraShapeId, 8)
  b[11] = divideSort
  return rec(0x42, level, b)
}

export type TextPart = string | { ctrl: string; ch?: number }

/** PARA_TEXT — 문자열 + 확장 컨트롤(16B: ch·ctrlId·8B·ch). 마지막에 문단 끝(0x0d) */
export function paraText(level: number, parts: TextPart[]): HwpRecord {
  const bufs: Buffer[] = []
  for (const p of parts) {
    if (typeof p === "string") bufs.push(Buffer.from(p, "utf16le"))
    else {
      const ch = p.ch ?? (p.ctrl === "secd" || p.ctrl === "cold" ? 0x02 : 0x0b)
      const b = Buffer.alloc(16)
      b.writeUInt16LE(ch, 0)
      ctrlIdBytes(p.ctrl).copy(b, 2)
      b.writeUInt16LE(ch, 14)
      bufs.push(b)
    }
  }
  bufs.push(Buffer.from([0x0d, 0x00]))
  return rec(0x43, level, Buffer.concat(bufs))
}

export function charShape(level: number, pairs: Array<[number, number]>): HwpRecord {
  const b = Buffer.alloc(pairs.length * 8)
  pairs.forEach(([pos, id], i) => { b.writeUInt32LE(pos, i * 8); b.writeUInt32LE(id, i * 8 + 4) })
  return rec(0x44, level, b)
}

export interface Seg { textpos?: number; vertpos: number; height?: number; horzpos?: number; horzsize: number }

export function lineSeg(level: number, segs: Seg[]): HwpRecord {
  const b = Buffer.alloc(segs.length * 36)
  segs.forEach((s, i) => {
    const o = i * 36
    const h = s.height ?? 1000
    b.writeUInt32LE(s.textpos ?? 0, o)
    b.writeInt32LE(s.vertpos, o + 4)
    b.writeInt32LE(h, o + 8)
    b.writeInt32LE(h, o + 12)
    b.writeInt32LE(Math.round(h * 0.85), o + 16)
    b.writeInt32LE(600, o + 20)
    b.writeInt32LE(s.horzpos ?? 0, o + 24)
    b.writeInt32LE(s.horzsize, o + 28)
    b.writeUInt32LE(393216, o + 32)
  })
  return rec(0x45, level, b)
}

export interface ObjOpts { tac?: boolean; w?: number; h?: number; wrap?: number; vrel?: number; hrel?: number; valign?: number; halign?: number; vo?: number; ho?: number; om?: number }

/** CTRL_HEADER 46B (개체 공통 속성) */
export function ctrlHeader(level: number, id: string, o: ObjOpts = {}): HwpRecord {
  const b = Buffer.alloc(46)
  ctrlIdBytes(id).copy(b, 0)
  // 단 정의(cold)는 개체 공통 속성이 아니라 bit2-9 = 단 수 (실측 0x1004 = 1단). 구역 정의(secd)는 속성 0
  const attr = id === "cold" ? 0x1004 : id === "secd" ? 0
    : (o.tac ? 1 : 0) | ((o.vrel ?? 2) << 3) | ((o.valign ?? 0) << 5) | ((o.hrel ?? 3) << 8) | ((o.halign ?? 0) << 10) | ((o.wrap ?? 0) << 21)
  b.writeUInt32LE(attr >>> 0, 4)
  b.writeInt32LE(o.vo ?? 0, 8)
  b.writeInt32LE(o.ho ?? 0, 12)
  b.writeUInt32LE(o.w ?? 0, 16)
  b.writeUInt32LE(o.h ?? 0, 20)
  for (let i = 0; i < 4; i++) b.writeUInt16LE(o.om ?? 0, 28 + i * 2)
  return rec(0x47, level, b)
}

export function tableRec(level: number, rows: number, cols: number, inMargin = 141): HwpRecord {
  const b = Buffer.alloc(18 + rows * 2 + 2)
  b.writeUInt16LE(rows, 4)
  b.writeUInt16LE(cols, 6)
  for (let i = 0; i < 4; i++) b.writeUInt16LE(inMargin, 10 + i * 2)
  return rec(0x4d, level, b)
}

/** LIST_HEADER(셀) 47B */
export function listHeader(level: number, o: { col: number; row: number; cs?: number; rs?: number; w: number; h: number; margin?: number; bf?: number; vAlign?: number }): HwpRecord {
  const b = Buffer.alloc(47)
  b.writeUInt16LE(1, 0)
  b.writeUInt32LE(((o.vAlign ?? 0) & 3) << 5, 2)
  b.writeUInt16LE(o.col, 8)
  b.writeUInt16LE(o.row, 10)
  b.writeUInt16LE(o.cs ?? 1, 12)
  b.writeUInt16LE(o.rs ?? 1, 14)
  b.writeUInt32LE(o.w, 16)
  b.writeUInt32LE(o.h, 20)
  for (let i = 0; i < 4; i++) b.writeUInt16LE(o.margin ?? 141, 24 + i * 2)
  b.writeUInt16LE(o.bf ?? 1, 32)
  b.writeUInt32LE(o.w, 34)
  return rec(0x48, level, b)
}

/** PAGE_DEF 40B — 기본 A4 세로, 여백 20/20/15/15 */
export function pageDef(level: number, o: { w?: number; h?: number; l?: number; r?: number; t?: number; b?: number; header?: number; footer?: number; landscape?: boolean } = {}): HwpRecord {
  const b = Buffer.alloc(40)
  const v = [o.w ?? 59528, o.h ?? 84188, o.l ?? 5669, o.r ?? 5669, o.t ?? 4252, o.b ?? 4252, o.header ?? 0, o.footer ?? 0, 0, o.landscape ? 1 : 0]
  v.forEach((x, i) => b.writeUInt32LE(x, i * 4))
  return rec(0x49, level, b)
}

/** SHAPE_COMPONENT 100B 최소형 — chid·orgSz·curSz. nested=묶음 안 자식(4바이트 "gso " 접두 없음, 실측) */
export function shapeComponent(level: number, chid: string, o: { orgW: number; orgH: number; curW?: number; curH?: number; xoff?: number; yoff?: number; nested?: boolean }): HwpRecord {
  const b = Buffer.alloc(100)
  const base = o.nested ? 0 : 4
  if (!o.nested) ctrlIdBytes("gso ").copy(b, 0)
  ctrlIdBytes(chid).copy(b, base)
  b.writeInt32LE(o.xoff ?? 0, base + 4)
  b.writeInt32LE(o.yoff ?? 0, base + 8)
  b.writeUInt32LE(o.orgW, base + 16)
  b.writeUInt32LE(o.orgH, base + 20)
  b.writeUInt32LE(o.curW ?? o.orgW, base + 24)
  b.writeUInt32LE(o.curH ?? o.orgH, base + 28)
  return rec(0x4c, level, b)
}

/** SHAPE_COMPONENT_PICTURE 73B — binDataId u16@71 */
export function shapePicture(level: number, binDataId: number, crop: [number, number, number, number] = [0, 0, 0, 0]): HwpRecord {
  const b = Buffer.alloc(73)
  crop.forEach((c, i) => b.writeInt32LE(c, 44 + i * 4))
  b.writeUInt16LE(binDataId, 71)
  return rec(0x55, level, b)
}

/** DocInfo BIN_DATA — embed, storageId, 확장자 */
export function binDataItem(storageId: number, ext = "png"): HwpRecord {
  const e = Buffer.from(ext, "utf16le")
  const b = Buffer.alloc(6 + e.length)
  b.writeUInt16LE(1, 0)
  b.writeUInt16LE(storageId, 2)
  b.writeUInt16LE(ext.length, 4)
  e.copy(b, 6)
  return rec(0x12, 0, b)
}

// ─── 조립 도우미 ─────────────────────────────────

/** 최상위 문단: 텍스트 + lineseg (+ 컨트롤 서브트리) */
export function simplePara(text: string, segs: Seg[], o: { paraShapeId?: number; charShapeId?: number; level?: number; ctrls?: HwpRecord[]; parts?: TextPart[] } = {}): HwpRecord[] {
  const L = o.level ?? 0
  return [
    paraHeader(L, o.paraShapeId ?? 0),
    paraText(L + 1, o.parts ?? [text]),
    charShape(L + 1, [[0, o.charShapeId ?? 0]]),
    lineSeg(L + 1, segs),
    ...(o.ctrls ?? []),
  ]
}

/** 1행 N열 TAC 표 컨트롤 서브트리 — 호스트 문단 level L 기준(ctrl L+1, TABLE/LIST_HEADER L+2, 셀 문단 L+2) */
export function tableCtrl(L: number, cells: Array<{ text: string; w: number; h: number; bf?: number }>, o: ObjOpts = {}): HwpRecord[] {
  const w = cells.reduce((s, c) => s + c.w, 0), h = Math.max(...cells.map(c => c.h))
  const out: HwpRecord[] = [ctrlHeader(L + 1, "tbl ", { tac: true, w, h, ...o }), tableRec(L + 2, 1, cells.length)]
  cells.forEach((c, i) => {
    out.push(listHeader(L + 2, { col: i, row: 0, w: c.w, h: c.h, bf: c.bf ?? 2 }))
    out.push(...simplePara(c.text, [{ vertpos: 0, horzsize: c.w - 282 }], { level: L + 2 }))
  })
  return out
}
