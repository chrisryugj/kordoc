/**
 * 글리프 이름으로 글자 복원 — ToUnicode 없이 Custom 인코딩 /Differences 에 글리프 이름만 둔 글꼴.
 *
 * 조판 프로그램(InDesign 등)은 옛 숫자·작은 대문자·합자를 "seven.oldstyle"·"c.sc"·"f_l" 같은 이름으로 싣는다.
 * pdfjs 는 이런 이름을 표준 글리프 목록에서 못 찾아 코드값을 그대로(제어 문자) 돌려주고, 제어 문자는 뒤에서 지워져
 * 숫자가 통째로 사라진다("May 1965" → "May ."). Adobe 글리프 목록 규칙대로 첫 "." 뒤 접미를 떼고 "_" 합자를 나눠
 * 이름을 글자로 바꾼다. 작은 대문자(.sc·.smcp·.c2sc)는 지면에 대문자로 보이므로 대문자로 낸다.
 */

import type { NormItem } from "./text-line.js"

const NAMED: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
  period: ".", comma: ",", colon: ":", semicolon: ";", hyphen: "-", endash: "–", emdash: "—", space: " ",
  parenleft: "(", parenright: ")", bracketleft: "[", bracketright: "]", slash: "/", ampersand: "&",
  quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”", quotesingle: "'", quotedbl: "\"",
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
    const ch = /^[A-Za-z]$/.test(part) ? part : NAMED[part] ?? (uni ? String.fromCodePoint(parseInt(uni[1], 16)) : undefined)
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
