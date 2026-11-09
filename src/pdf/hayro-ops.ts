/**
 * hayro 쪽 사건열로 그리기 연산자 목록(fnArray·argsArray)을 만든다 — 판정 모듈(선·클립·그림·글꼴 복원)이 읽는 모양.
 *
 * 경로는 save·transform(절대 행렬)·색·굵기·불투명도·constructPath·칠하기·restore 로, 클립은 장치 공간 경로로 W n 처럼
 * (constructPath·clip·endPath) 낸다. q/Q 는 save/restore, BT/Tf/Tm 은 beginText/setFont/setTextMatrix, 글 묶음은 showText.
 * cm 은 내지 않는다 — 경로·글자 행렬이 이미 절대 좌표라 소비 쪽 CTM 은 늘 항등이다. 폼은 항등 행렬과 쪽 좌표 bbox 로 감싼다.
 */

import { OPS } from "./ops.js"
import { EV, eventLength } from "./hayro-text.js"

export interface OpList { fnArray: number[]; argsArray: unknown[][] }

const UNITS_PER_EM = 1000

/** 경로 조각 → pdfjs constructPath 인자 [ops, coords]. at 은 조각 수(−1 이면 사각형) 자리 */
function pathArgs(ev: ArrayLike<number>, at: number): [number[], number[]] {
  const n = ev[at]!
  if (n === -1) return [[OPS.rectangle], [ev[at + 1]!, ev[at + 2]!, ev[at + 3]!, ev[at + 4]!]]
  const ops: number[] = [], coords: number[] = []
  let k = at + 1
  for (let s = 0; s < n; s++) {
    const op = ev[k++]!
    // `re` 로 그린 하위 경로(5)는 hayro 에서 M L L L Z 가 된다 — 연산자 목록은 rectangle 로 둔다(채움 사각형·얇은 괘선 판정).
    // m·l 로 그린 같은 모양의 경로는 경로 그대로다
    if (op === 5 && s + 4 < n) {
      ops.push(OPS.rectangle); coords.push(ev[k]!, ev[k + 1]!, ev[k + 3]! - ev[k]!, ev[k + 7]! - ev[k + 1]!)
      k += 12; s += 4
      continue
    }
    if (op === 0 || op === 5) { ops.push(OPS.moveTo); coords.push(ev[k++]!, ev[k++]!) }
    else if (op === 1) { ops.push(OPS.lineTo); coords.push(ev[k++]!, ev[k++]!) }
    else if (op === 2) {
      // 2차 곡선은 같은 3차 곡선으로 — pdfjs 연산자 목록에 2차 곡선 연산이 없다
      const cx = ev[k++]!, cy = ev[k++]!, x = ev[k++]!, y = ev[k++]!
      const px = coords.length >= 2 ? coords[coords.length - 2]! : x, py = coords.length >= 2 ? coords[coords.length - 1]! : y
      ops.push(OPS.curveTo); coords.push(px + 2 / 3 * (cx - px), py + 2 / 3 * (cy - py), x + 2 / 3 * (cx - x), y + 2 / 3 * (cy - y), x, y)
    }
    else if (op === 3) { ops.push(OPS.curveTo); coords.push(ev[k++]!, ev[k++]!, ev[k++]!, ev[k++]!, ev[k++]!, ev[k++]!) }
    else ops.push(OPS.closePath)
  }
  return [ops, coords]
}

const PAINT: Record<number, number> = { 1: OPS.fill, 2: OPS.eoFill, 3: OPS.stroke, 4: OPS.fillStroke, 5: OPS.eoFillStroke }

export function hayroOps(ev: ArrayLike<number>, strs: string[]): OpList {
  const fnArray: number[] = [], argsArray: unknown[][] = []
  const push = (fn: number, args: unknown[]) => { fnArray.push(fn); argsArray.push(args) }
  let font = "", size = 0
  const stack: Array<[string, number]> = []
  let pendingTm = false
  let run: Array<Record<string, unknown>> = []
  let runTm: number[] | null = null

  for (let i = 0; i < ev.length; i += eventLength(ev, i)) {
    const t = ev[i]!
    switch (t) {
      case EV.SAVE: stack.push([font, size]); push(OPS.save, []); break
      case EV.RESTORE: { const s = stack.pop(); if (s) [font, size] = s; push(OPS.restore, []); break }
      case EV.BEGIN_TEXT: push(OPS.beginText, []); break
      case EV.END_TEXT: push(OPS.endText, []); break
      case EV.FONT: font = `hy_${strs[ev[i + 1]!] ?? ""}`; size = ev[i + 2]!; push(OPS.setFont, [font, size]); break
      case EV.FONT_KEY: { const key = strs[ev[i + 1]!] ?? ""; if (key && fnArray[fnArray.length - 1] === OPS.setFont) { argsArray[argsArray.length - 1]![0] = key; font = key } break }
      case EV.TEXT_MATRIX: pendingTm = true; break
      case EV.GLYPH: {
        const cp = ev[i + 1]!, code = ev[i + 2]!
        const unicode = cp === 0x110000 ? "\u0000" : cp > 0 ? String.fromCodePoint(cp) : cp < 0 ? strs[-cp - 1] ?? "" : ""
        if (!run.length && pendingTm) {
          // 글 행렬 = 첫 글자 행렬 ÷ 글자 크기 — 소비 쪽은 size × hypot(m[2], m[3]) 로 em 을 다시 구한다
          const k = size ? UNITS_PER_EM / size : UNITS_PER_EM
          runTm = [ev[i + 3]! * k, ev[i + 4]! * k, ev[i + 5]! * k, ev[i + 6]! * k, ev[i + 7]!, ev[i + 8]!]
        }
        // fontChar 는 U+E000 + 글리프 번호 — 글꼴 객체의 합성 cmap(hayroFontData)이 같은 규칙으로 글리프를 찾는다. 폭은 /Widths 값 그대로
        const gid = ev[i + 14]!
        run.push({ unicode, originalCharCode: code, fontChar: String.fromCodePoint(0xe000 + gid), width: ev[i + 15]!, isSpace: unicode === " " })
        break
      }
      case EV.RUN_END:
        if (runTm) push(OPS.setTextMatrix, runTm)
        if (run.length) push(OPS.showText, [run])
        run = []; runTm = null; pendingTm = false
        break
      case EV.PATH: {
        const code = ev[i + 1]!, lw = ev[i + 6]!
        push(OPS.save, [])
        push(OPS.transform, [ev[i + 7]!, ev[i + 8]!, ev[i + 9]!, ev[i + 10]!, ev[i + 11]!, ev[i + 12]!])
        if (lw >= 0) push(OPS.setLineWidth, [lw])
        const r = ev[i + 2]!, g = ev[i + 3]!, b = ev[i + 4]!, a = ev[i + 5]! / 255
        const fills = code !== 3, strokes = code >= 3
        if (r >= 0) {
          if (fills) push(OPS.setFillRGBColor, [r, g, b])
          if (strokes) push(OPS.setStrokeRGBColor, [r, g, b])
        }
        if (a < 1) push(OPS.setGState, [[...(fills ? [["ca", a]] : []), ...(strokes ? [["CA", a]] : [])]])
        push(OPS.constructPath, [...pathArgs(ev, i + 13), null])
        push(PAINT[code] ?? OPS.endPath, [])
        push(OPS.restore, [])
        break
      }
      case EV.CLIP_PUSH:
        push(OPS.constructPath, [...pathArgs(ev, i + 2), null])
        push(ev[i + 1] === 1 ? OPS.eoClip : OPS.clip, [])
        push(OPS.endPath, [])
        break
      case EV.IMAGE: {
        // hayro 는 그림 화소 좌표(y 아래로)를 쪽으로 옮기는 행렬, pdfjs 는 단위 정사각형(y 위로)을 옮기는 행렬을 준다
        const w = ev[i + 1]!, h = ev[i + 2]!, a = ev[i + 3]!, b = ev[i + 4]!, c = ev[i + 5]!, d = ev[i + 6]!
        push(OPS.save, [])
        push(OPS.transform, [a * w, b * w, -c * h, -d * h, ev[i + 7]! + c * h, ev[i + 8]! + d * h])
        // 그림 id — 간접 객체는 g_hy_번호_세대(문서 공용, pdfjs g_ 와 같은 뜻), 인라인 그림은 쪽 안 번호
        push(ev[i + 9] === 1 ? OPS.paintImageMaskXObject : OPS.paintImageXObject, [strs[ev[i + 10]!] || null, ev[i + 1]!, ev[i + 2]!])
        push(OPS.restore, [])
        break
      }
      case EV.FORM_BEGIN: {
        const m = [ev[i + 1]!, ev[i + 2]!, ev[i + 3]!, ev[i + 4]!, ev[i + 5]!, ev[i + 6]!]
        const [x0, y0, x1, y1] = [ev[i + 7]!, ev[i + 8]!, ev[i + 9]!, ev[i + 10]!]
        const xs: number[] = [], ys: number[] = []
        for (const [px, py] of [[x0, y0], [x1, y0], [x0, y1], [x1, y1]] as const) { xs.push(m[0]! * px + m[2]! * py + m[4]!); ys.push(m[1]! * px + m[3]! * py + m[5]!) }
        push(OPS.paintFormXObjectBegin, [[1, 0, 0, 1, 0, 0], [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)]])
        break
      }
      case EV.FORM_END: push(OPS.paintFormXObjectEnd, []); break
    }
  }
  return { fnArray, argsArray }
}

/**
 * TrueType 글꼴 파일에서 head·loca·glyf 를 그대로 두고 cmap 만 "U+E000 + 글리프 번호 → 글리프 번호" 하나로 바꾼 합성 글꼴.
 * pdfjs 가 변환한 글꼴(fontExtraProperties data)을 대신한다 — 윤곽 판정(symbol-glyphs readOutline)이 글리프 번호로 같은 윤곽을 읽는다
 */
export function hayroFontData(file: Uint8Array): Uint8Array | undefined {
  if (file.length < 12) return undefined
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength)
  const n = dv.getUint16(4)
  const tables = new Map<string, [number, number]>()
  for (let i = 0; i < n && 12 + 16 * i + 16 <= file.length; i++) {
    const r = 12 + 16 * i
    tables.set(String.fromCharCode(file[r]!, file[r + 1]!, file[r + 2]!, file[r + 3]!), [dv.getUint32(r + 8), dv.getUint32(r + 12)])
  }
  const keep = ["head", "loca", "glyf", "maxp"].filter(t => tables.has(t))
  if (!["head", "loca", "glyf"].every(t => tables.has(t))) return undefined
  const maxp = tables.get("maxp"), numGlyphs = maxp ? dv.getUint16(maxp[0] + 4) : 0xffff
  // cmap: 버전 0, 서브테이블 1개(3,10) format 12, 묶음 1개
  const cmap = new Uint8Array(12 + 16 + 12)
  const cv = new DataView(cmap.buffer)
  cv.setUint16(2, 1); cv.setUint16(4, 3); cv.setUint16(6, 10); cv.setUint32(8, 12)
  cv.setUint16(12, 12); cv.setUint32(16, 16 + 12); cv.setUint32(24, 1)
  cv.setUint32(28, 0xe000); cv.setUint32(32, 0xe000 + Math.max(0, numGlyphs - 1)); cv.setUint32(36, 0)
  const names = ["cmap", ...keep]
  const blobs = [cmap, ...keep.map(t => { const [o, l] = tables.get(t)!; return file.subarray(o, o + l) })]
  let off = 12 + 16 * names.length
  const offsets = blobs.map(b => { const o = off; off += (b.length + 3) & ~3; return o })
  const out = new Uint8Array(off), ov = new DataView(out.buffer)
  ov.setUint32(0, 0x00010000); ov.setUint16(4, names.length)
  names.forEach((t, k) => {
    const r = 12 + 16 * k
    for (let c = 0; c < 4; c++) out[r + c] = t.charCodeAt(c)
    ov.setUint32(r + 8, offsets[k]!); ov.setUint32(r + 12, blobs[k]!.length)
    out.set(blobs[k]!, offsets[k]!)
  })
  return out
}
