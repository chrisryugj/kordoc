/**
 * 가려진 글 — 먼저 찍은 글 위에 불투명 사각형을 칠하면 그 글은 보이지 않는다. InDesign 계열 보고서는 쪽 머리글·쪽 번호를
 * 찍고 쪽 전체 배경을 덮어 칠한 뒤 본문을 흰 글씨로 찍는다(ODL 079·080 장 첫 쪽).
 *
 * 연산자 목록에서 불투명 사각형 채움마다 그때까지 찍은 글자 수와 채움 영역을 기록하고, 텍스트 아이템을 같은 글자 흐름으로
 * 짚어 채움보다 먼저 찍혔고 영역 안에 드는 아이템을 고른다. 아이템 글과 연산자 글이 그 지점까지 글자 그대로 같을 때만
 * 짚는다(주석 모양·합자로 흐름이 어긋나면 손대지 않는다). pdfjs v4 사각형 경로만 본다.
 */

import { OPS, normalizeUnicode } from "./ops.js"
import type { PdfTextItem } from "./text-line.js"

interface Rect { x1: number; y1: number; x2: number; y2: number }

const glyphText = (s: string) => normalizeUnicode(s).replace(/\s+/g, "")

export function occludedTextItems(items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>): Set<PdfTextItem> {
  const covers: Array<{ at: number; rect: Rect }> = []
  let drawn = ""
  let ctm = [1, 0, 0, 1, 0, 0]
  let alpha = 1, normalBlend = true
  let clip: Rect | null | undefined = undefined // undefined = 쪽 전체, null = 사각형 아닌 클립(판단 안 함)
  let path: Rect[] = []
  let pathOk = true
  const stack: Array<{ ctm: number[]; alpha: number; normalBlend: boolean; clip: Rect | null | undefined }> = []
  const box = (x: number, y: number, w: number, h: number): Rect => {
    const xs: number[] = [], ys: number[] = []
    for (const [px, py] of [[x, y], [x + w, y], [x, y + h], [x + w, y + h]]) {
      xs.push(ctm[0] * px + ctm[2] * py + ctm[4]); ys.push(ctm[1] * px + ctm[3] * py + ctm[5])
    }
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  const meet = (a: Rect, b: Rect): Rect => ({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) })

  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = (argsArray as unknown[][])[i]
    if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) {
      stack.push({ ctm: ctm.slice(), alpha, normalBlend, clip })
      const m = fn === OPS.paintFormXObjectBegin ? (args as unknown[])[0] : null
      if (Array.isArray(m) && m.length >= 6) ctm = mul(ctm, m as number[])
      const bbox = fn === OPS.paintFormXObjectBegin ? args[1] : null
      if (Array.isArray(bbox) && bbox.length === 4 && clip !== null) {
        // 비스듬한 Form 경계는 축 정렬 사각형으로 넓혀 판정하지 않는다.
        const axisAligned = ctm[1] === 0 && ctm[2] === 0 || ctm[0] === 0 && ctm[3] === 0
        const bounds = box(bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1])
        clip = axisAligned ? (clip ? meet(clip, bounds) : bounds) : null
      }
    } else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) {
      const s = stack.pop()
      if (s) ({ ctm, alpha, normalBlend, clip } = s)
    } else if (fn === OPS.transform) ctm = mul(ctm, args as number[])
    else if (fn === OPS.setGState) {
      const entries = (args as unknown[])[0]
      if (Array.isArray(entries)) for (const e of entries) {
        if (!Array.isArray(e)) continue
        if (e[0] === "ca" && typeof e[1] === "number") alpha = e[1]
        else if (e[0] === "BM") normalBlend = e[1] === "source-over" || e[1] === "Normal"
        else if (e[0] === "SMask" && e[1]) normalBlend = false
      }
    } else if (fn === OPS.showText) {
      for (const g of (args as unknown[])[0] as unknown[]) {
        if (g && typeof g === "object" && typeof (g as { unicode?: unknown }).unicode === "string") drawn += glyphText((g as { unicode: string }).unicode)
      }
    } else if (fn === OPS.constructPath) {
      const sub = (args as unknown[])[0]
      const coords = (args as unknown[])[1] as number[]
      if (!Array.isArray(sub)) { pathOk = false; continue }
      let ci = 0
      for (const op of sub as number[]) {
        if (op === OPS.rectangle) { path.push(box(coords[ci], coords[ci + 1], coords[ci + 2], coords[ci + 3])); ci += 4 }
        else { pathOk = false; ci += op === OPS.curveTo ? 6 : op === OPS.curveTo2 || op === OPS.curveTo3 ? 4 : op === OPS.closePath ? 0 : 2 }
      }
    } else if (fn === OPS.clip || fn === OPS.eoClip) {
      clip = clip === null || !pathOk || path.length !== 1 ? null : clip ? meet(clip, path[0]) : path[0]
    } else if (fn === OPS.fill || fn === OPS.eoFill || fn === OPS.fillStroke || fn === OPS.eoFillStroke || fn === OPS.endPath ||
               fn === OPS.stroke || fn === OPS.closeStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
      const fills = fn !== OPS.endPath && fn !== OPS.stroke && fn !== OPS.closeStroke
      if (fills && pathOk && path.length === 1 && alpha >= 1 && normalBlend && clip !== null && drawn.length > 0) {
        const rect = clip ? meet(path[0], clip) : path[0]
        if (rect.x2 > rect.x1 && rect.y2 > rect.y1) covers.push({ at: drawn.length, rect })
      }
      path = []; pathOk = true
    }
  }

  const hidden = new Set<PdfTextItem>()
  if (covers.length === 0) return hidden
  let pos = 0
  for (const it of items) {
    const t = glyphText(it.str ?? "")
    const start = pos
    pos += t.length
    if (!t) continue
    // 아이템 글이 연산자 글과 이 지점까지 어긋나면 이후는 짚을 수 없다
    if (drawn.slice(start, pos) !== t) break
    const [a, b, , , e, f] = it.transform
    const size = Math.hypot(a, b) || it.height
    const r: Rect = { x1: e, y1: f, x2: e + it.width, y2: f + size }
    if (covers.some(c => c.at >= pos && r.x1 >= c.rect.x1 - 1 && r.x2 <= c.rect.x2 + 1 && r.y1 >= c.rect.y1 - 1 && r.y2 <= c.rect.y2 + 1)) hidden.add(it)
  }
  return hidden
}

function mul(m: number[], t: number[]): number[] {
  return [
    m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
    m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
    m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
  ]
}
