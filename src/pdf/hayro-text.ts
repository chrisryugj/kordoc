/**
 * hayro 쪽 사건열로 글 조각(PdfTextItem)을 만든다 — 판정 모듈이 읽는 조각 모양과 끊는 규칙(글꼴·크기 바뀜, Q 로 글꼴이 바뀐 상태 복귀,
 * 태그·Do 에서 끊기, 글자 틈은 앞 글자 폭만큼 나아간 자리(자간 제외)에서 글자 크기로 잰다)은 pdf.js getTextContent 와 같다(Apache-2.0 — NOTICE).
 * 글자 자리는 엔진이 pdf.js 의 글 상태 셈(f64)으로 따로 낸 값을 쓴다 — 틈이 문턱에 딱 걸릴 때도 pdf.js 와 같은 쪽으로 끊는다.
 */

import { normalizeUnicode } from "./ops.js"
import { bidi } from "./bidi.js"
import type { HayroDoc } from "./hayro.js"
import type { PdfTextItem } from "./text-line.js"
import { pdfString } from "./hayro-meta.js"

export const EV = { GLYPH: 1, SAVE: 2, RESTORE: 3, BEGIN_TEXT: 4, END_TEXT: 5, FONT: 6, XOBJECT: 7, MARK_BEGIN: 8, MARK_END: 9,
  CLIP_PUSH: 10, CLIP_POP: 11, RUN_END: 12, TEXT_MATRIX: 13, PATH: 20, IMAGE: 21, FORM_BEGIN: 22, FORM_END: 23, FONT_KEY: 24,
  /** ExtGState /SMask 그룹의 내용 — pdfjs 는 연산자 목록에만 끼워 넣고 글 추출은 들여다보지 않는다 */
  SMASK_BEGIN: 25, SMASK_END: 26,
  /** Tz(가로 비율, 퍼센트) */
  HSCALE: 27,
  /** w(선 굵기) */
  LINE_WIDTH: 28,
  /** 연산자 목록의 CTM 에 곱할 행렬(주석 appearance 앞뒤) */
  CTM: 29 } as const
const { GLYPH, SAVE, RESTORE, FONT, XOBJECT, MARK_BEGIN, MARK_END } = EV
const FIXED: Record<number, number> = { 1: 32, 6: 4, 7: 2, 8: 4, 21: 11, 22: 11, 24: 2, 27: 2, 28: 2, 29: 7 }

/** 경로 조각 수(또는 사각형 표시 −1)부터 쓰는 수의 개수. 조각: 0 MoveTo·1 LineTo·2 2차 곡선·3 3차 곡선·4 닫기·5 `re` 로 시작한 MoveTo */
export function pathLength(ev: ArrayLike<number>, at: number): number {
  const n = ev[at]!
  if (n === -1) return 5
  let k = at + 1
  for (let s = 0; s < n; s++) { const op = ev[k]!; k += op === 0 || op === 1 || op === 5 ? 3 : op === 2 ? 5 : op === 3 ? 7 : 1 }
  return k - at
}

/** 사건 하나의 길이 */
export function eventLength(ev: ArrayLike<number>, i: number): number {
  const t = ev[i]!
  if (t === EV.PATH) return 13 + pathLength(ev, i + 13)
  if (t === EV.CLIP_PUSH) return 2 + pathLength(ev, i + 2)
  return FIXED[t] ?? 1
}
const UNITS_PER_EM = 1000
const TRACKING = 0.102, NOT_A_SPACE = 0.03, NEGATIVE = -0.2, IN_FLOW_MIN = 0.102, IN_FLOW_MAX = 0.6, VERTICAL_SHIFT = 0.25
/** pdfjs getCharUnicodeCategory 의 식 — 1번째 묶음이 공백 글자, 3번째 묶음이 서식 문자 */
const SPECIAL_CHAR = /^(\s)|(\p{Mn})|(\p{Cf})$/u

export interface HayroTextPage {
  items: PdfTextItem[]
  /** 쪽 사건열과 문자열 표 — 그리기 명령 어댑터(hayro-ops)가 같은 것을 쓴다 */
  events: ArrayLike<number>
  strings: string[]
  /** 콘텐츠 순서의 Tf 글꼴 열쇠 — pdfjs setFont 순서와 짝지어 loadedName 으로 바꾼다 */
  fonts: string[]
  /** 글꼴 열쇠 → BaseFont */
  fontNames: Map<string, string>
}

export interface HayroFontInfo { name: string; subtype: string; composite: boolean; differences: Array<[number, string]>; toUnicode: Array<[number, string]> }

/** 사설 영역(U+E000–F8FF) 글자인지 — 사건의 글자 값(유니코드 하나)으로 */
const isPrivateUse = (cp: number) => cp >= 0xe000 && cp <= 0xf8ff

/**
 * /ActualText 가 붙은 묶음(BDC … EMC)의 글자가 모두 사설 영역이면 /ActualText 로 바꾼다 — Chrome 인쇄 PDF 는 Pretendard 고정폭 숫자의
 * ToUnicode 를 사설 영역으로 적고 실제 숫자는 /ActualText 에 둔다(목차 쪽 번호). 다른 글자는 pdf.js 처럼 ToUnicode 그대로 둔다.
 * 글자 수가 같으면 하나씩, 다르면 첫 글자에 통째로 싣고 나머지는 빈 글자로
 */
function applyActualText(ev: ArrayLike<number> & { [i: number]: number }, strs: string[]): void {
  // 글자는 가장 안쪽 /ActualText 묶음에만 적는다(겹친 깊이 × 글자 수로 불어나지 않게). 안에 /ActualText 묶음을 품은 바깥 묶음은 손대지 않는다
  const open: Array<{ text: string; glyphs: number[]; nested: boolean } | null> = []
  const actual: Array<{ text: string; glyphs: number[]; nested: boolean }> = []
  for (let i = 0; i < ev.length; i += eventLength(ev, i)) {
    const t = ev[i]!
    if (t === MARK_BEGIN) {
      const o = ev[i + 3] ? { text: pdfString(strs[ev[i + 3]! - 1] ?? ""), glyphs: [], nested: false } : null
      if (o) { const outer = actual[actual.length - 1]; if (outer) outer.nested = true; actual.push(o) }
      open.push(o)
    } else if (t === GLYPH) actual[actual.length - 1]?.glyphs.push(i)
    else if (t === MARK_END) {
      const o = open.pop()
      if (!o) continue
      actual.pop()
      if (o.nested || !o.text || !o.glyphs.length || !o.glyphs.every(g => isPrivateUse(ev[g + 1]!))) continue
      const chars = [...o.text]
      const whole = chars.length !== o.glyphs.length
      o.glyphs.forEach((g, k) => { const s = whole ? (k ? "" : o.text) : chars[k]!; strs.push(s); ev[g + 1] = -strs.length })
    }
  }
}

/** 쪽(1부터)의 글 조각과 사건열 */
export function hayroTextPage(doc: HayroDoc, pageNumber: number): HayroTextPage {
  const { events, strings } = doc.events(pageNumber - 1)
  applyActualText(events, strings)
  return { ...buildItems(events, strings, doc.pageView(pageNumber - 1)), events, strings }
}

/** 글꼴 열쇠(hy_객체번호_세대)의 사전 정보 */
export function hayroFontInfo(doc: HayroDoc, key: string): HayroFontInfo | null {
  const raw = doc.fontInfo(key)
  return raw ? JSON.parse(raw) as HayroFontInfo : null
}

interface Item { str: string[]; t: number[]; fontName: string }

/**
 * pdfjs textContentItem 의 값 가운데 조각을 끊어도(flush) 다음 조각을 열 때까지 남는 것 — 끝자리·폭·배율·높이·글자 크기·글꼴.
 * width 는 텍스트 공간 폭이고 그 부호(sign)가 틈 문턱의 방향이다(Tm 으로 배율이 바뀌면 0)
 */
interface Tci { prev: number[] | null; width: number; totalWidth: number; scale: number; height: number; fs: number; fontName: string }
const freshTci = (): Tci => ({ prev: null, width: 0, totalWidth: 0, scale: 0, height: 0, fs: 0, fontName: "" })

/**
 * pdfjs compareWithLastPosition 의 회전 풀기 — 지금 글자 행렬 m 이 축에 맞으면(0·90·180·270도) 두 자리를 그 각도로 돌리고,
 * 아니면(기울임·임의 회전) 두 자리를 각자 행렬(m·앞 글자 pm)의 회전으로 푼다. 돌린 x 차이가 진행, y 차이가 줄 바뀜
 */
function unrotate(x: number, y: number, m: number[], lx: number, ly: number, pm: number[]): [number, number, number, number] {
  if (m[0] && m[1] === 0 && m[2] === 0) return m[0] > 0 ? [x, y, lx, ly] : [-x, -y, -lx, -ly]
  if (m[1] && m[0] === 0 && m[3] === 0) return m[1] > 0 ? [y, x, ly, lx] : [-y, -x, -ly, -lx]
  const inv = (u: number, v: number, k: number[]) => { const s = Math.hypot(k[0]!, k[1]!); return [(k[0]! * u + k[1]! * v) / s, (k[2]! * u + k[3]! * v) / s] }
  return [...inv(x, y, m), ...inv(lx, ly, pm)] as [number, number, number, number]
}

/** 글자 사건에서 pdf.js 셈 값이 시작하는 자리 — [시작 행렬 6, 끝자리 2, CTM a·b, Tlm a·b, 글자 크기, 폭, 폭 × Tz] (rust/hayro-pdf Pj::glyph) */
const PJ = 16

/** @param view pdfjs page.view [x0,y0,x1,y1] — 이 상자 밖에 찍히는 글자는 pdfjs 처럼 버린다(자리만 나아가고 조각·끝자리는 그대로) */
function buildItems(ev: ArrayLike<number>, strs: string[], view: number[]): Omit<HayroTextPage, "events" | "strings"> {
  const items: PdfTextItem[] = []
  const fonts: string[] = []
  const fontNames = new Map<string, string>()
  /** font 는 글꼴 열쇠(FONT_KEY 뒤에는 글꼴 사전 객체), res 는 Tf 의 자원 이름 — pdfjs 는 같은 이름·크기의 Tf 에서 조각을 끊지 않는다 */
  let font: string | null = null, res: string | null = null, size = 0
  const stack: Array<[string | null, string | null, number]> = []
  let item: Item | null = null
  let tci = freshTci()
  const last = [" ", " "]; let lastPos = 0
  const saveLastChar = (c: string) => { const next = (lastPos + 1) % 2; const r = last[lastPos] !== " " && last[next] === " "; last[lastPos] = c; lastPos = next; return r }
  const shouldAddWhitespace = () => last[lastPos] !== " " && last[(lastPos + 1) % 2] === " "
  const resetLastChars = () => { last[0] = last[1] = " "; lastPos = 0 }
  const flush = (eol = false) => {
    if (!item) return
    tci.totalWidth += tci.width * tci.scale
    // pdfjs runBidiTransform — normalizeUnicode 로 합자(ﬁ ﬂ)·호환 문자를 풀고, bidi 로 오른쪽에서 왼쪽으로 쓰는 글자를 논리 순서로 되돌린다
    const it: PdfTextItem & { hasEOL?: boolean } = { str: bidi(normalizeUnicode(item.str.join(""))).str, transform: item.t, width: tci.totalWidth, height: tci.height, fontName: item.fontName }
    if (eol) it.hasEOL = true
    items.push(it)
    item = null
  }
  /** pdfjs appendEOL — 조각이 있으면 줄 끝 표시를 달아 끊고, 없으면 지금 글자 자리·배율(getCurrentTextTransform)로 빈 줄 끝 조각을 낸다 */
  const eol = (t: number[]) => {
    resetLastChars()
    if (item) flush(true)
    else items.push({ str: "", transform: t, width: 0, height: 0, fontName: font ?? "", hasEOL: true } as PdfTextItem)
  }
  /** pdfjs pushWhitespace — 자리는 앞 글자 끝(prevTransform), 글꼴은 앞 조각 것, 너비는 텍스트 공간 */
  const pushWhitespace = (width: number) => {
    items.push({ str: " ", transform: tci.prev!, width, height: 0, fontName: tci.fontName })
  }

  /** 조각이 있을 때 Tm 이 왔다 — pdfjs updateAdvanceScale 은 그때 배율을 바꾸고 폭을 0 으로 되돌린다(배율은 다음 글자에서 읽는다) */
  let maskDepth = 0, tmLive = false
  // pdfjs 는 폼 XObject 를 새 getTextContent 호출로 읽는다 — 안에서는 새 textContentItem 이고, 끝나면 바깥 것으로 돌아온다
  const tciStack: Tci[] = []
  for (let i = 0; i < ev.length; i += eventLength(ev, i)) {
    const type = ev[i]!
    if (type === EV.SMASK_BEGIN) { maskDepth++; continue }
    if (type === EV.SMASK_END) { maskDepth--; continue }
    if (maskDepth) continue
    if (type === EV.TEXT_MATRIX) { if (item) tmLive = true }
    else if (type === SAVE) stack.push([font, res, size])
    else if (type === RESTORE) {
      const [f, r, s] = stack.pop() ?? [null, null, 0]
      if (f !== font || s !== size || r !== res) flush()
      font = f; res = r; size = s
    } else if (type === FONT) {
      const name = strs[ev[i + 1]!] ?? "", s = ev[i + 2]!
      const key = `hy_${name}`
      fonts.push(key)
      if (!fontNames.has(key)) fontNames.set(key, strs[ev[i + 3]!] ?? "")
      if (font && res === name && size === s) continue
      flush()
      font = key; res = name; size = s
    } else if (type === EV.FONT_KEY) {
      // Tf 바로 뒤 — 자원 이름 대신 글꼴 사전 객체로 열쇠를 바꾼다(쪽마다 같은 이름이 다른 글꼴일 수 있다)
      const key = strs[ev[i + 1]!] ?? ""
      const prevKey = fonts[fonts.length - 1]
      if (key && prevKey !== undefined) {
        if (!fontNames.has(key)) fontNames.set(key, fontNames.get(prevKey) ?? "")
        fonts[fonts.length - 1] = key
        if (font === prevKey) font = key
        if (item?.fontName === prevKey) { item.fontName = key; tci.fontName = key }
      }
    } else if (type === XOBJECT || type === MARK_BEGIN || type === MARK_END) flush()
    else if (type === EV.FORM_BEGIN) { flush(); resetLastChars(); tciStack.push(tci); tci = freshTci() }
    else if (type === EV.FORM_END) { flush(); resetLastChars(); tci = tciStack.pop() ?? freshTci() }
    else if (type === GLYPH) {
      const cp = ev[i + 1]!
      // 유니코드 없음(cp 0)은 pdf.js 처럼 글자 코드를 글자로(크레이트 shadow.rs 의 폭 셈과 같게). 이 글자로 quality 가 NEEDS_OCR 을 판정한다
      const u = cp === 0x110000 ? "\u0000" : cp > 0 ? String.fromCodePoint(cp) : cp < 0 ? strs[-cp - 1] ?? "" : String.fromCharCode(ev[i + 2]!)
      // 자리·배율은 pdf.js 셈 값(hayro 의 글 상태는 f32 라 끝자리가 다르다)
      const t = [ev[i + PJ]!, ev[i + PJ + 1]!, ev[i + PJ + 2]!, ev[i + PJ + 3]!, ev[i + PJ + 4]!, ev[i + PJ + 5]!]
      const x = t[4]!, y = t[5]!, endX = ev[i + PJ + 6]!, endY = ev[i + PJ + 7]!
      const fs = ev[i + PJ + 12]!, sd = ev[i + PJ + 13]!, sdx = ev[i + PJ + 14]!
      const scale = () => Math.hypot(ev[i + PJ + 8]!, ev[i + PJ + 9]!) * Math.hypot(ev[i + PJ + 10]!, ev[i + PJ + 11]!)
      if (tmLive) {
        const sc = scale()
        if (sc !== tci.scale) { tci.totalWidth += tci.width * tci.scale; tci.width = 0; tci.scale = sc }
        tmLive = false
      }
      // pdfjs getCharUnicodeCategory — 첫 글자가 공백이면 공백 글자, 서식 문자(\p{Cf})는 자리째 건너뛴다.
      // ToUnicode 가 U+0000 으로 매긴 글자(cp 0x110000)는 pdfjs 처럼 글자로 둔다
      const cat = SPECIAL_CHAR.exec(u)
      if (!u || cat?.[1]) { saveLastChar(" "); continue }
      if (cat?.[3]) continue
      // pdfjs isZeroWidthDiacritic — 결합 문자(\p{Mn})는 자리 비교 없이 지금 조각에 붙이고 폭은 0 이다(크레이트 Pj::glyph 도 나아가지 않는다)
      const diacritic = !!cat?.[2]
      // pdfjs compareWithLastPosition 첫 검사 — 글자 폭은 텍스트 공간 값 그대로 더한다(pdfjs 와 같은 셈)
      if (!diacritic && view.length === 4 && (x + sd < view[0]! || x > view[2]! || y < view[1]! || y > view[3]!)) continue
      // pdfjs compareWithLastPosition — 조각을 끊은 뒤에도 마지막 글자 끝자리(prevTransform)와 비교한다
      const prev = tci.prev
      if (!diacritic && prev && (x !== prev[4] || y !== prev[5])) {
        const [px, py, lx, ly] = unrotate(x, y, t, prev[4]!, prev[5]!, prev)
        const advanceX = (px - lx) / tci.scale, advanceY = Math.abs(py - ly)
        const o = Math.sign(tci.width), f = tci.fs
        if (advanceX < o * (f * NEGATIVE)) {
          if (advanceY > 0.5 * tci.height) eol(t)
          else { resetLastChars(); flush() }
        } else if (advanceY > tci.height) eol(t)
        else {
          if (advanceX <= o * (f * NOT_A_SPACE)) resetLastChars()
          if (advanceX <= o * (f * TRACKING)) {
            if (shouldAddWhitespace()) { resetLastChars(); flush(); pushWhitespace(Math.abs(advanceX)) }
            else tci.width += advanceX
          } else if (o * (f * IN_FLOW_MIN) <= advanceX && advanceX <= o * (f * IN_FLOW_MAX)) {
            if (item) { resetLastChars(); item.str.push(" ") }
            if (!item) { resetLastChars(); pushWhitespace(Math.abs(advanceX)) }
            else tci.width += advanceX
          } else {
            flush(); resetLastChars(); pushWhitespace(Math.abs(advanceX))
          }
          if (advanceY > tci.height * VERTICAL_SHIFT) flush()
        }
      }
      // pdfjs ensureTextContentItem — 조각을 열 때 자리·높이·배율·문턱(글자 크기)을 잡는다
      if (!item) {
        item = { str: [], t, fontName: font ?? "" }
        tci.fontName = item.fontName; tci.width = tci.totalWidth = 0; tci.height = Math.hypot(t[2]!, t[3]!); tci.scale = scale(); tci.fs = fs
      }
      tci.width += sdx
      // 폭이 0 인 글자는 끝자리(prevTransform)를 바꾸지 않는다
      if (sdx) tci.prev = [t[0]!, t[1]!, t[2]!, t[3]!, endX, endY]
      if (saveLastChar(u)) item.str.push(" ")
      item.str.push(u)
    }
  }
  flush()
  return { items, fonts, fontNames }
}
