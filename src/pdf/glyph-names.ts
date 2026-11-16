/**
 * 글리프 이름으로 글자 복원 — ToUnicode 없이 Custom 인코딩 /Differences 에 글리프 이름만 둔 글꼴.
 *
 * 조판 프로그램(InDesign 등)은 옛 숫자·작은 대문자·합자를 "seven.oldstyle"·"c.sc"·"f_l" 같은 이름으로 싣는다.
 * pdfjs 는 이런 이름을 표준 글리프 목록에서 못 찾아 코드값을 그대로(제어 문자) 돌려주고, 제어 문자는 뒤에서 지워져
 * 숫자가 통째로 사라진다("May 1965" → "May ."). Adobe 글리프 목록 규칙대로 첫 "." 뒤 접미를 떼고 "_" 합자를 나눠
 * 이름을 글자로 바꾼다. 작은 대문자(.sc·.smcp·.c2sc)는 지면에 대문자로 보이므로 대문자로 낸다.
 */

import { OPS, normalizeUnicode } from "./ops.js"
import type { NormItem, PdfTextItem } from "./text-line.js"

const NAMED: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  period: ".", comma: ",", colon: ":", semicolon: ";", hyphen: "-", endash: "–", emdash: "—", space: " ",
  parenleft: "(", parenright: ")", bracketleft: "[", bracketright: "]", slash: "/", ampersand: "&",
  quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”", quotesingle: "'", quotedbl: "\"",
  bullet: "•", openbullet: "◦", whitebullet: "◦",
  question: "?", exclam: "!", percent: "%", dollar: "$", numbersign: "#", asterisk: "*", plus: "+", equal: "=",
}

/** 글리프 이름 → 글자 (모르는 이름은 undefined) */
export function glyphNameText(name: string): string | undefined {
  const dot = name.indexOf(".")
  const base = dot > 0 ? name.slice(0, dot) : name
  const smallCaps = dot > 0 && /^(?:sc|smcp|c2sc)$/.test(name.slice(dot + 1))
  let out = ""
  for (const part of base.split("_")) {
    const uni = /^uni([0-9A-F]{4})$/.exec(part) ?? /^u([0-9A-F]{4,6})$/.exec(part)
    const code = uni ? parseInt(uni[1], 16) : undefined
    if (code !== undefined && (code > 0x10ffff || code >= 0xd800 && code <= 0xdfff)) return undefined
    const ch = /^[A-Za-z]$/.test(part) ? part : NAMED[part] ?? (code !== undefined ? String.fromCodePoint(code) : undefined)
    if (ch === undefined) return undefined
    out += ch
  }
  return smallCaps ? out.toUpperCase() : out
}

/** 제어 문자로 남은 코드(탭·줄바꿈 제외)를 글꼴 /Differences 의 글리프 이름으로 되살린다 (제자리). 바뀐 아이템 수 */
export function remapControlGlyphs(items: NormItem[], differencesOf: (loadedName: string) => ArrayLike<string | undefined> | undefined): number {
  let changed = 0
  for (const it of items) {
    if (!it.fontName || !/[\u0001-\u0008\u000B\u000C\u000E-\u001F]/.test(it.text)) continue
    const diffs = differencesOf(it.fontName)
    if (!diffs) continue
    let out = ""
    for (const ch of it.text) {
      const code = ch.charCodeAt(0)
      const name = code < 0x20 && code !== 9 && code !== 10 && code !== 13 ? diffs[code] : undefined
      out += (name && glyphNameText(name)) ?? ch
    }
    if (out !== it.text) { it.text = out; changed++ }
  }
  return changed
}

const isSmallCapName = (name: string) => /^[^.]+\.(?:sc|smcp|c2sc)$/.test(name)
/** 글자 대신 공백·빈 글·제어 문자로 나오는 코드 — 탭·줄바꿈(9·10·13)과 C1(0x80~0x9F)도 여기 든다 */
const isRestorableCode = (code: number) => code < 0x20 || (code >= 0x80 && code <= 0x9f)

interface OpGlyph { originalCharCode?: number; unicode?: string; width?: number }

/**
 * TeX CM 수식 글꼴을 다시 매긴 하위 글꼴(Springer 계열 조판, ODL 028~031) — 이름·코드가 가리키는 글자가 아니라 원래 기호다.
 * Symbols 는 라틴-1 이름에 기호를 얹었고(thorn "+", onequarter "=", eth "(", Thorn ")", onehalf "[", C138 "]" — 정답 문맥 대조)
 * "C숫자" 이름은 TeX cmsy 원래 코드(0 −, 1 ·, 2 ×, 6 ±, 24 ∼). Italic 은 cmmi 인코딩이라 0x3A 가 ".", 0x3D 가 "/".
 */
const TEX_CM_SYMBOL_NAMES: Record<string, string> = {
  thorn: "+", onequarter: "=", eth: "(", Thorn: ")", onehalf: "[", C138: "]", C0: "−", C1: "·", C2: "×", C6: "±", C24: "∼",
}
const TEX_CM_ITALIC_CODES: Record<number, string> = { 58: ".", 61: "/" }
const texCmGlyph = (face: string | undefined, code: number, name: string | undefined): string | undefined =>
  !face ? undefined
    : /TeXCMMathsSymbols/.test(face) ? (name ? TEX_CM_SYMBOL_NAMES[name] : undefined)
      : /TeXCMMathsItalic/.test(face) ? TEX_CM_ITALIC_CODES[code] : undefined

/**
 * 글리프 이름으로만 알 수 있는 글자를 pdfjs 텍스트 아이템에 되살린다 (normalizeItems 전, 제자리). 바뀐 아이템 수.
 *
 * pdfjs 텍스트 아이템에는 유니코드 글만 남아 글리프 이름이 사라진다. 두 경우가 그 이름을 봐야 풀린다:
 *  - 작은 대문자: Brill-Roman 은 /h.smcp·/B.c2sc 를 ToUnicode 로 소문자에 매겨 지면의 "H. HUMPHREY" 가
 *    "h. humphrey" 로 나온다(ODL 010·013). 소문자 글리프와 글이 같아 아이템만으로는 못 가른다.
 *  - 공백·빈 글로 사라지는 코드: GaramondPremrPro(ToUnicode 없음)는 `9 /nine.oldstyle`·`129 /F.a` 라 pdfjs 가
 *    9 를 탭(→ 공백), 129 를 빈 글로 돌려 "May 1965" → "May 1 65", "FIGURE" → "IGURE" (ODL 005·006).
 *    remapControlGlyphs 는 공백 정리 뒤의 제어 문자만 보므로 여기서 먼저 푼다.
 * 연산자 목록의 showText 글리프(originalCharCode)를 글꼴마다 콘텐츠 순서로 텍스트 아이템 글자에 맞춰 짚는다.
 * pdfjs 가 틈에 넣은 공백은 건너뛰고, 한 글꼴이라도 맞춤이 어긋나면 그 글꼴은 손대지 않는다.
 * 작은 대문자·되살릴 코드 이름이 /Differences 에 있는 글꼴만 — 한컴 PDF(CID 글꼴)는 대상이 없다.
 */
export function restoreNamedGlyphs(
  items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>,
  differencesOf: (loadedName: string) => ArrayLike<string | undefined> | undefined,
  faceOf: (loadedName: string) => string | undefined = () => undefined,
): number {
  const targets = new Map<string, ArrayLike<string | undefined> | null>()
  for (const it of items) {
    if (!it.fontName || targets.has(it.fontName)) continue
    const diffs = differencesOf(it.fontName)
    if (/TeXCMMaths(?:Symbols|Italic)/.test(faceOf(it.fontName) ?? "")) { targets.set(it.fontName, diffs ?? []); continue }
    let hit = false
    if (diffs) for (let c = 0; c < diffs.length && !hit; c++) {
      const name = diffs[c]
      hit = !!name && (isSmallCapName(name) || (isRestorableCode(c) && glyphNameText(name) !== undefined))
    }
    targets.set(it.fontName, hit ? diffs! : null)
  }
  if (![...targets.values()].some(Boolean)) return 0

  // 글꼴별 글리프 흐름 — 폼 XObject·q/Q 가 글꼴을 되돌리므로 저장 스택을 따른다
  const streams = new Map<string, OpGlyph[]>()
  const saved: string[] = []
  let font = ""
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = (argsArray as unknown[][])[i]
    if (fn === OPS.setFont) font = String(args[0])
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(font)
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) font = saved.pop() ?? font
    else if (fn === OPS.showText && targets.get(font)) {
      let list = streams.get(font)
      if (!list) streams.set(font, list = [])
      for (const g of args[0] as unknown[]) if (g && typeof g === "object") list.push(g as OpGlyph)
    }
  }

  const failed = new Set<string>()
  const outs = new Map<string, { item: PdfTextItem; out: string }[]>()
  const cursor = new Map<string, number>()
  for (const it of items) {
    const fontName = it.fontName ?? ""
    const diffs = targets.get(fontName)
    if (!diffs || failed.has(fontName) || typeof it.str !== "string") continue
    const glyphs = streams.get(fontName) ?? []
    const done = outs.get(fontName) ?? []
    outs.set(fontName, done)
    const s = it.str
    let gi = cursor.get(fontName) ?? 0, k = 0, out = ""
    while (k < s.length) {
      const g = glyphs[gi]
      // 글리프가 다 떨어진 뒤 pdfjs 가 틈에 넣은 공백 아이템(" ")은 짝이 없어도 된다(ODL 031 수식 글꼴)
      if (!g) { if (/^\s*$/.test(s.slice(k))) { out += s.slice(k); break } failed.add(fontName); break }
      const code = g.originalCharCode ?? -1
      const name = diffs[code]
      const raw = g.unicode ?? ""
      const exp = /^\p{Cf}$/u.test(raw) ? "" : normalizeUnicode(raw)
      // 되살릴 코드: 글꼴이 이름을 붙였는데 pdfjs 가 공백·빈 글·제어 문자로 돌려준 것
      // ToUnicode 가 대체 문자(U+FFFD)로 매긴 코드도 이름으로 되살린다 — "one.SP"·"two.SP" 쪽번호·그림 번호 숫자(ODL 001·015)
      const tex = texCmGlyph(faceOf(fontName), code, name)
      if (tex !== undefined && (exp === "" || s.startsWith(exp, k))) { out += tex; k += exp.length; gi++; continue }
      const named = name && isRestorableCode(code) && (exp === "" || /^[\s\u0000-\u001f\u0080-\u009f\ufffd]$/.test(exp)) ? glyphNameText(name) : undefined
      if (/^\s/.test(exp)) {
        // 공백 글리프는 다음 글자 앞 " " 로 나오거나 아무것도 안 남긴다. 아이템 첫머리에서 짝이 없으면 앞 아이템 끝에 그린 글자
        // (ODL 006 쪽번호 "19": "1" 아이템 뒤 9 가 아무것도 안 남기고 다음 줄 아이템이 이어진다)
        if (s[k] === " ") { out += named ?? " "; k++ }
        else if (named) {
          const prev = k === 0 ? [...done].reverse().find(d => d.out !== "") : undefined
          if (prev) prev.out += named
          else out += named
        }
        gi++
        continue
      }
      if (exp === "") { out += named ?? ""; gi++; continue }
      if (s.startsWith(exp, k)) {
        out += named ?? (name && isSmallCapName(name) ? exp.toUpperCase() : exp)
        k += exp.length; gi++
        continue
      }
      if (s[k] === " ") { out += " "; k++; continue } // pdfjs 가 글자 틈에 넣은 공백
      // 쪽 밖이라 pdfjs 가 버린 글리프 — 조금 앞에서 맞으면 건너뛴다
      let j = gi + 1
      while (j < glyphs.length && j <= gi + 8 && !s.startsWith(normalizeUnicode(glyphs[j].unicode ?? "") || "\u0000", k)) j++
      if (j < glyphs.length && j <= gi + 8) { gi = j; continue }
      failed.add(fontName)
      break
    }
    cursor.set(fontName, gi)
    done.push({ item: it, out })
  }

  let changed = 0
  for (const [fontName, done] of outs) {
    if (failed.has(fontName)) continue
    for (const { item, out } of done) if (out !== item.str) { item.str = out; changed++ }
  }
  return changed
}

/** CID 글꼴 — commonObjs 의 글꼴 객체(fontExtraProperties)에서 쓰는 필드만 */
export interface CidFontInfo { composite?: boolean; toUnicode?: { _map?: ArrayLike<string | undefined> } | null }

/**
 * ToUnicode 에 없는 CID 글꼴 코드 중 공백 폭인 것을 공백으로 되돌린다 (normalizeItems 전, 제자리). 바뀐 아이템 수.
 *
 * pdfjs 는 ToUnicode 에 없는 코드를 코드값 그대로 글자로 낸다 — Identity-H 의 코드는 글리프 번호라 엉뚱한 한자가 된다.
 * Microsoft Print To PDF 는 OpenType 조판이 낱말 사이 공백을 바꿔 넣은 대체 공백 글리프(Noto Sans KR GID 22586, 폭 280)를
 * ToUnicode 에 싣지 않아 공백마다 "堺"(U+583A) 가 찍혔다. pdfium·poppler 는 이 코드를 글자로 내지 않는다.
 * 같은 글꼴에서 ToUnicode 가 공백으로 매긴 글리프 폭의 1.5배 이하인 코드만 공백으로 — 공백 폭을 모르는 글꼴,
 * 넓은 글리프, ToUnicode 의 다른 코드가 같은 글자를 내는 경우는 손대지 않는다.
 */
export function restoreUnmappedCidSpaces(
  items: PdfTextItem[], fnArray: ArrayLike<number>, argsArray: ArrayLike<unknown>,
  fontOf: (loadedName: string) => CidFontInfo | null | undefined,
): number {
  const maps = new Map<string, ArrayLike<string | undefined> | null>()
  const mapOf = (font: string) => {
    if (!maps.has(font)) {
      const f = fontOf(font)
      const m = f?.composite ? f.toUnicode?._map : undefined
      maps.set(font, m && m.length > 0 ? m : null)
    }
    return maps.get(font)!
  }
  const spaceWidth = new Map<string, number>()
  const unmapped = new Map<string, Map<number, { width: number; glyphs: OpGlyph[] }>>()
  const saved: string[] = []
  let font = ""
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i]
    const args = (argsArray as unknown[][])[i]
    if (fn === OPS.setFont) font = String(args[0])
    else if (fn === OPS.save || fn === OPS.paintFormXObjectBegin) saved.push(font)
    else if (fn === OPS.restore || fn === OPS.paintFormXObjectEnd) font = saved.pop() ?? font
    else if (fn === OPS.showText) {
      const map = mapOf(font)
      if (!map) continue
      for (const raw of args[0] as unknown[]) {
        if (!raw || typeof raw !== "object") continue
        const g = raw as OpGlyph
        const code = g.originalCharCode
        if (code === undefined || typeof g.width !== "number") continue
        if (map[code] === " ") spaceWidth.set(font, Math.max(spaceWidth.get(font) ?? 0, g.width))
        else if (map[code] === undefined && g.unicode === String.fromCharCode(code)) {
          let codes = unmapped.get(font)
          if (!codes) unmapped.set(font, codes = new Map())
          const seen = codes.get(code)
          if (seen) seen.glyphs.push(g)
          else codes.set(code, { width: g.width, glyphs: [g] })
        }
      }
    }
  }

  const spaceChars = new Map<string, Set<string>>()
  for (const [fontName, codes] of unmapped) {
    const sw = spaceWidth.get(fontName)
    if (!sw) continue
    const mapped = new Set(Array.from(mapOf(fontName) ?? [], v => v))
    const chars = new Set<string>()
    for (const [code, { width, glyphs }] of codes) {
      const ch = String.fromCharCode(code)
      if (width > sw * 1.5 || mapped.has(ch)) continue
      chars.add(ch)
      for (const g of glyphs) g.unicode = " " // 뒤의 글리프 흐름 대조(markSyntheticSpaces 등)가 같은 글을 보게
    }
    if (chars.size) spaceChars.set(fontName, chars)
  }
  if (!spaceChars.size) return 0

  let changed = 0
  for (const it of items) {
    const chars = it.fontName ? spaceChars.get(it.fontName) : undefined
    if (!chars || typeof it.str !== "string") continue
    let out = ""
    for (const ch of it.str) out += chars.has(ch) ? " " : ch
    if (out !== it.str) { it.str = out; changed++ }
  }
  return changed
}

