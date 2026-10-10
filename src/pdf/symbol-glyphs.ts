/**
 * 유니코드 없는 기호 글리프 되살리기 — 한컴 PDF 는 ToUnicode 를 못 만든 글리프(자동 글머리표·자동 번호·일부 괄호·칸 채움 글자)를
 * 전부 U+F000 으로 내고(text-clean stripNoUnicodeGlyph 가 지운다), 글자는 글꼴 서브셋의 윤곽으로만 남는다. pdf.js 가 변환한 글꼴
 * (fontExtraProperties 로 쥔 OpenType)에서 그 글리프의 TrueType 윤곽을 읽어 모양이 분명한 기호만 글자로 되살린다.
 * 글 벤치 54문서 F000 글리프 157종을 HWPX 원문 글자와 대조한 실측(2026-10-10): 되살린 263곳이 모두 원문과 같다 — 작은 오른쪽 삼각형 "▸" 114·
 * 큰 네모 테두리 "□" 67·겹 테두리 모서리(아래 오른쪽 "》" 58, 위 왼쪽 "《" 9 + 원문에서 문맥을 못 찾은 49 — 한컴 글꼴이 겹화살괄호를 이 꼴로 그린다)·
 * 일곱 점 화살표 "↓" 8·큰 삼각형 "►" 7. 칸 채움 막대(가는 가로 막대 194곳)는 원문에 없는 글자라 되살리지 않고, 원문자 숫자(① … 112곳)는
 * 숫자를 가려 읽지 못해 그대로 둔다
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { PdfTextItem } from "./text-line.js"

export const NO_UNICODE = ""

type Point = [number, number, boolean] // x, y, 곡선 위 점(on-curve)
interface Outline { contours: Point[][]; upm: number }

const u16 = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1]
const i16 = (b: Uint8Array, o: number): number => { const v = u16(b, o); return v & 0x8000 ? v - 0x10000 : v }
const u32 = (b: Uint8Array, o: number): number => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3]

/** OpenType 표 목록 */
function tableDir(b: Uint8Array): Map<string, number> {
  const out = new Map<string, number>()
  if (b.length < 12) return out
  const n = u16(b, 4)
  for (let i = 0; i < n && 12 + 16 * i + 16 <= b.length; i++) {
    const r = 12 + 16 * i
    out.set(String.fromCharCode(b[r], b[r + 1], b[r + 2], b[r + 3]), u32(b, r + 8))
  }
  return out
}

/** cmap(형식 4·12)에서 글자 코드의 글리프 번호 */
function glyphId(b: Uint8Array, cmap: number, code: number): number {
  const n = u16(b, cmap + 2)
  for (let i = 0; i < n; i++) {
    const off = cmap + u32(b, cmap + 4 + 8 * i + 4), fmt = u16(b, off)
    if (fmt === 4) {
      const segX2 = u16(b, off + 6), ends = off + 14, starts = ends + segX2 + 2, deltas = starts + segX2, ranges = deltas + segX2
      for (let s = 0; s < segX2 / 2; s++) {
        const end = u16(b, ends + 2 * s), start = u16(b, starts + 2 * s)
        if (code < start || code > end) continue
        const delta = i16(b, deltas + 2 * s), ro = u16(b, ranges + 2 * s)
        if (!ro) return (code + delta) & 0xffff
        const g = u16(b, ranges + 2 * s + ro + 2 * (code - start))
        return g ? (g + delta) & 0xffff : -1
      }
    } else if (fmt === 12) {
      const groups = u32(b, off + 12)
      for (let g = 0; g < groups; g++) {
        const r = off + 16 + 12 * g, sc = u32(b, r), ec = u32(b, r + 4)
        if (code >= sc && code <= ec) return u32(b, r + 8) + code - sc
      }
    }
  }
  return -1
}

/** TrueType 단순 글리프 윤곽 — 합성 글리프·CFF 글꼴은 읽지 않는다 */
export function readOutline(b: Uint8Array, code: number): Outline | null {
  const t = tableDir(b)
  const cmap = t.get("cmap"), head = t.get("head"), loca = t.get("loca"), glyf = t.get("glyf")
  if (cmap === undefined || head === undefined || loca === undefined || glyf === undefined) return null
  const gid = glyphId(b, cmap, code)
  if (gid < 0) return null
  const longLoca = i16(b, head + 50) === 1
  const a = longLoca ? u32(b, loca + 4 * gid) : 2 * u16(b, loca + 2 * gid)
  const z = longLoca ? u32(b, loca + 4 * gid + 4) : 2 * u16(b, loca + 2 * gid + 2)
  if (z <= a) return null
  const g = glyf + a, nc = i16(b, g)
  if (nc <= 0 || nc > 8) return null
  const ends: number[] = []
  for (let i = 0; i < nc; i++) ends.push(u16(b, g + 10 + 2 * i))
  const np = ends[nc - 1] + 1
  if (np > 400) return null
  let o = g + 10 + 2 * nc
  o += 2 + u16(b, o)
  const flags: number[] = []
  while (flags.length < np) {
    const f = b[o++]
    flags.push(f)
    if (f & 8) for (let r = b[o++]; r > 0; r--) flags.push(f)
  }
  const xs: number[] = [], ys: number[] = []
  let x = 0, y = 0
  for (const f of flags) { if (f & 2) { const d = b[o++]; x += f & 16 ? d : -d } else if (!(f & 16)) { x += i16(b, o); o += 2 } xs.push(x) }
  for (const f of flags) { if (f & 4) { const d = b[o++]; y += f & 32 ? d : -d } else if (!(f & 32)) { y += i16(b, o); o += 2 } ys.push(y) }
  const contours: Point[][] = []
  let s = 0
  for (const e of ends) { contours.push(xs.slice(s, e + 1).map((px, k) => [px, ys[s + k], !!(flags[s + k] & 1)])); s = e + 1 }
  return { contours, upm: u16(b, head + 18) || 1000 }
}

interface Box { x1: number; y1: number; x2: number; y2: number }
const boxOf = (pts: Point[]): Box => {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
  for (const [x, y] of pts) { if (x < x1) x1 = x; if (x > x2) x2 = x; if (y < y1) y1 = y; if (y > y2) y2 = y }
  return { x1, y1, x2, y2 }
}
/** 곡선 위 점에서 겹친 점을 뺀 꼭짓점 */
const corners = (pts: Point[]): Point[] => {
  const out: Point[] = []
  for (const p of pts) if (p[2] && !out.some(q => Math.abs(q[0] - p[0]) < 2 && Math.abs(q[1] - p[1]) < 2)) out.push(p)
  return out
}
const inside = (a: Box, b: Box): boolean => a.x1 >= b.x1 && a.x2 <= b.x2 && a.y1 >= b.y1 && a.y2 <= b.y2

/** 윤곽 모양 → 기호 (모르면 null) */
export function classifyOutline({ contours, upm }: Outline): string | null {
  const boxes = contours.map(boxOf)
  const all = boxOf(contours.flat())
  const w = (all.x2 - all.x1) / upm, h = (all.y2 - all.y1) / upm
  if (w <= 0 || h <= 0) return null
  if (contours.length === 1) {
    const c = corners(contours[0])
    // 삼각형 — 꼭짓점 셋, 한 변이 세로(가로)로 곧고 맞은편 꼭짓점이 가운데 높이(너비)
    if (c.length === 3 && contours[0].every(p => p[2])) {
      const left = c.filter(p => Math.abs(p[0] - all.x1) <= 0.02 * upm), right = c.filter(p => Math.abs(p[0] - all.x2) <= 0.02 * upm)
      const midY = (all.y1 + all.y2) / 2, apexMid = (p: Point) => Math.abs(p[1] - midY) <= 0.15 * (all.y2 - all.y1)
      if (left.length === 2 && right.length === 1 && apexMid(right[0])) return Math.max(w, h) < 0.35 ? "▸" : w > h ? "►" : "▶"
      return null
    }
    // 화살표 — 꼭짓점 일곱(촉 셋 + 대 넷)
    if (c.length === 7 && contours[0].every(p => p[2]) && Math.max(w, h) >= 0.6) {
      const tip = (pick: (p: Point) => number, edge: number) => c.filter(p => Math.abs(pick(p) - edge) <= 0.02 * upm).length === 1
      if (h > w && tip(p => p[1], all.y1)) return "↓"
      if (w > h && tip(p => p[0], all.x2)) return "➡"
    }
    return null
  }
  if (contours.length === 2) {
    const [a, b] = boxes
    const outer = inside(b, a) ? 0 : inside(a, b) ? 1 : -1
    if (outer < 0) return null
    const ob = boxes[outer], ib = boxes[1 - outer]
    const ow = ob.x2 - ob.x1, oh = ob.y2 - ob.y1
    // 네모 테두리 — 바깥·안쪽 모두 정사각에 가깝고 글자 칸만 하다
    if (Math.min(w, h) >= 0.75 && Math.abs(ow - oh) <= 0.08 * upm && Math.abs((ib.x2 - ib.x1) - (ib.y2 - ib.y1)) <= 0.08 * upm) return "□"
    // 겹 테두리 모서리 — 꼭짓점 여섯인 ㄱ자 둘(속 빈 꺾쇠). 위 왼쪽 모서리면 여는 괄호, 아래 오른쪽 모서리면 닫는 괄호
    const oc = corners(contours[outer])
    if (oc.length === 6 && corners(contours[1 - outer]).length === 6 && w <= 0.4 && h >= 0.35) {
      const has = (x: number, y: number) => oc.some(p => Math.abs(p[0] - x) <= 0.02 * upm && Math.abs(p[1] - y) <= 0.02 * upm)
      const topLeft = has(ob.x1, ob.y2), bottomRight = has(ob.x2, ob.y1), topRight = has(ob.x2, ob.y2), bottomLeft = has(ob.x1, ob.y1)
      if (topLeft && !bottomRight && topRight && bottomLeft) return "《"
      if (bottomRight && !topLeft && topRight && bottomLeft) return "》"
    }
  }
  return null
}

interface FontObj { data?: Uint8Array }

/**
 * 쪽 글 아이템의 U+F000 을 그 자리 글리프 모양의 기호로 바꾼다(제자리). 글꼴마다 글리프 흐름(showText)의 F000 글리프를 차례로
 * 아이템 글의 F000 과 짝짓는다 — 두 흐름의 F000 수가 다르면 그 글꼴은 손대지 않는다
 */
export function restoreUnmappedGlyphs(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>,
  fontObj: (loadedName: string) => FontObj | null | undefined): void {
  if (!items.some(it => typeof it.str === "string" && it.str.includes(NO_UNICODE))) return
  const queues = new Map<string, string[]>()
  const cache = new Map<string, string | null>()
  const saved: string[] = []
  let font = ""
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i], args = (argsArray as unknown[][])[i]
    if (fn === OPS.setFont) font = String(args[0])
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(font)
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) font = saved.pop() ?? font
    else if (fn === OPS.showText) {
      for (const g of args[0] as unknown[]) {
        const glyph = g as { unicode?: unknown; fontChar?: unknown } | null
        if (!glyph || glyph.unicode !== NO_UNICODE || typeof glyph.fontChar !== "string") continue
        const key = font + "\u0000" + glyph.fontChar
        if (!cache.has(key)) {
          let sym: string | null = null
          try {
            const data = fontObj(font)?.data
            const code = glyph.fontChar.codePointAt(0)
            const outline = data && code !== undefined ? readOutline(data, code) : null
            if (outline) sym = classifyOutline(outline)
          } catch { /* 깨진 글꼴 — 되살리지 않는다 */ }
          cache.set(key, sym)
        }
        let q = queues.get(font)
        if (!q) queues.set(font, q = [])
        q.push(cache.get(key) ?? NO_UNICODE)
      }
    }
  }
  const byFont = new Map<string, PdfTextItem[]>()
  for (const it of items) {
    if (typeof it.str !== "string" || !it.str.includes(NO_UNICODE)) continue
    const f = it.fontName ?? ""
    let list = byFont.get(f)
    if (!list) byFont.set(f, list = [])
    list.push(it)
  }
  for (const [f, list] of byFont) {
    const q = queues.get(f)
    const want = list.reduce((n, it) => n + (it.str.match(//g)?.length ?? 0), 0)
    if (!q || q.length !== want) continue
    let k = 0
    for (const it of list) it.str = it.str.replace(//g, () => q[k++])
  }
}
