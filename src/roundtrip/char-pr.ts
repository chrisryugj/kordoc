/**
 * patch 가 새 글을 마크다운 서식대로 넣을 때 쓰는 HWPX 글자 모양 책 — header 의 charPr 마다 서식 비트(굵게·기울임·취소선·밑줄·첨자,
 * 파서 styles.ts 와 같은 판정)를 읽고, 서식 비트만 다른 짝을 찾거나 비트를 빼고 더해 만든다. 만든 짝은 header 끝에 덧붙인다.
 */

import { isRealStrikeShape } from "../hwpx/styles.js"
import { EMPH_BOLD, EMPH_ITALIC, EMPH_STRIKE, EMPH_UNDERLINE, EMPH_SUP, EMPH_SUB } from "./inline-edit.js"

const CHAR_PR_RE = /<hh:charPr\b[^>]{0,4096}?(?:\/>|>[\s\S]{0,16384}?<\/hh:charPr>)/g
const ELEM = (tag: string): RegExp => new RegExp(`<hh:${tag}\\b[^>]{0,512}?(?:\\/>|>\\s*<\\/hh:${tag}>)`, "g")

/** charPr XML 의 서식 비트 (styles.ts parseCharProperties 와 같은 판정) */
export function charPrFlags(xml: string): number {
  const open = /^<hh:charPr\b[^>]*>/.exec(xml)?.[0] ?? xml
  let f = 0
  if (/<hh:bold\b/.test(xml) || /\sbold="(?:1|true)"/.test(open)) f |= EMPH_BOLD
  if (/<hh:italic\b/.test(xml) || /\sitalic="(?:1|true)"/.test(open)) f |= EMPH_ITALIC
  const strike = /<hh:strikeout\b[^>]{0,512}?\bshape="([^"]{0,40})"/.exec(xml)?.[1]
  if (strike !== undefined && isRealStrikeShape(strike)) f |= EMPH_STRIKE
  if (/<hh:underline\b[^>]{0,512}?\btype="BOTTOM"/.test(xml)) f |= EMPH_UNDERLINE
  if (/<hh:supscript\b/.test(xml)) f |= EMPH_SUP
  if (/<hh:subscript\b/.test(xml)) f |= EMPH_SUB
  return f
}

/** 서식 비트를 걷은 정의 — 같으면 서식 말고는 같은 글자 모양 */
function keyOf(xml: string): string {
  return xml.replace(/\sid="\d{1,10}"/, "").replace(/\s(?:bold|italic)="[^"]{0,16}"/g, "")
    .replace(ELEM("bold"), "").replace(ELEM("italic"), "").replace(ELEM("supscript"), "").replace(ELEM("subscript"), "")
    .replace(/<hh:underline\b[^>]{0,512}?\/>/g, "").replace(/<hh:strikeout\b[^>]{0,512}?\/>/g, "")
}

/** 서식 비트를 뺀 charPr XML — 밑줄·취소선은 종류만 없음으로 */
function withoutBits(xml: string, bits: number): string {
  let x = xml
  if (bits & EMPH_BOLD) x = x.replace(ELEM("bold"), "").replace(/(<hh:charPr\b[^>]*?)\sbold="(?:1|true)"/, "$1")
  if (bits & EMPH_ITALIC) x = x.replace(ELEM("italic"), "").replace(/(<hh:charPr\b[^>]*?)\sitalic="(?:1|true)"/, "$1")
  if (bits & EMPH_SUP) x = x.replace(ELEM("supscript"), "")
  if (bits & EMPH_SUB) x = x.replace(ELEM("subscript"), "")
  if (bits & EMPH_UNDERLINE) x = x.replace(/(<hh:underline\b[^>]{0,512}?\btype=")BOTTOM"/, '$1NONE"')
  if (bits & EMPH_STRIKE) x = x.replace(/(<hh:strikeout\b[^>]{0,512}?\bshape=")[^"]{0,40}"/, '$1NONE"')
  return x
}

/**
 * 서식 비트를 더한 charPr XML — 요소를 스키마 순서(fontRef·ratio·spacing·relSz·offset·italic·bold·underline·strikeout·outline·shadow·
 * emboss·engrave·supscript·subscript) 자리에 넣는다. 밑줄은 종류 BOTTOM·취소선은 모양 SOLID, 요소가 없으면(kordoc 생성 header) 만든다
 */
function withBits(xml: string, bits: number): string {
  let x = xml
  /** after 중 마지막으로 있는 요소 뒤(하나도 없으면 charPr 닫기 앞)에 el 을 넣는다 */
  const put = (after: string[], el: string): void => {
    let at = -1
    for (const t of after) {
      const m = new RegExp(`<hh:${t}\\b[^>]{0,1024}?(?:/>|>[\\s\\S]{0,4096}?</hh:${t}>)`).exec(x)
      if (m) at = Math.max(at, m.index + m[0].length)
    }
    if (at < 0) at = x.lastIndexOf("</hh:charPr>")
    if (at >= 0) x = x.slice(0, at) + el + x.slice(at)
  }
  const head = ["fontRef", "ratio", "spacing", "relSz", "offset"]
  if (bits & EMPH_ITALIC && !/<hh:italic\b/.test(x)) put(head, "<hh:italic/>")
  if (bits & EMPH_BOLD && !/<hh:bold\b/.test(x)) put([...head, "italic"], "<hh:bold/>")
  if (bits & EMPH_UNDERLINE) {
    if (/<hh:underline\b/.test(x)) x = x.replace(/(<hh:underline\b[^>]{0,512}?\btype=")[^"]{0,16}"/, '$1BOTTOM"')
    else put([...head, "italic", "bold"], `<hh:underline type="BOTTOM" shape="SOLID" color="#000000"/>`)
  }
  if (bits & EMPH_STRIKE) {
    if (/<hh:strikeout\b/.test(x)) x = x.replace(/(<hh:strikeout\b[^>]{0,512}?\bshape=")[^"]{0,40}"/, '$1SOLID"')
    else put([...head, "italic", "bold", "underline"], `<hh:strikeout shape="SOLID" color="#000000"/>`)
  }
  const tail = [...head, "italic", "bold", "underline", "strikeout", "outline", "shadow", "emboss", "engrave"]
  if (bits & EMPH_SUP && !/<hh:supscript\b/.test(x)) put(tail, "<hh:supscript/>")
  if (bits & EMPH_SUB && !/<hh:subscript\b/.test(x)) put(tail, "<hh:subscript/>")
  return x
}

export interface CharPrBook {
  /** 글자 모양의 서식 비트 (header 에 없으면 undefined) */
  flagsOf(id: string): number | undefined
  /** id 와 서식 비트만 다른(flags) 글자 모양 — header 에 있으면 그 id, 없으면 비트를 빼고 더해 만든 새 id. 그렇게 못 만들면 undefined */
  variant(id: string, flags: number): string | undefined
  /** 만든 글자 모양 수 */
  added(): number
  /** 만든 글자 모양을 header 의 charProperties 끝에 덧붙인 판 (만든 게 없으면 그대로) */
  apply(header: string): string
}

export function charPrBook(headerXml: string): CharPrBook {
  const entries = new Map<string, { xml: string; flags: number; key: string }>()
  const byKey = new Map<string, Map<number, string>>()
  const register = (id: string, xml: string): void => {
    const e = { xml, flags: charPrFlags(xml), key: keyOf(xml) }
    entries.set(id, e)
    const m = byKey.get(e.key) ?? new Map<number, string>()
    if (!m.has(e.flags)) m.set(e.flags, id)
    byKey.set(e.key, m)
  }
  for (const m of headerXml.matchAll(CHAR_PR_RE)) {
    const id = /\bid="(\d{1,10})"/.exec(m[0])?.[1]
    if (id !== undefined && !entries.has(id)) register(id, m[0])
  }
  let next = 1 + Math.max(-1, ...[...entries.keys()].map(Number))
  const added: string[] = []
  return {
    flagsOf: id => entries.get(id)?.flags,
    variant(id, flags) {
      const e = entries.get(id)
      if (!e) return undefined
      if (e.flags === flags) return id
      const hit = byKey.get(e.key)?.get(flags)
      if (hit !== undefined) return hit
      const xml = withBits(withoutBits(e.xml, e.flags & ~flags), flags & ~e.flags).replace(/\bid="\d{1,10}"/, `id="${next}"`)
      if (charPrFlags(xml) !== flags) return undefined
      const nid = String(next++)
      register(nid, xml)
      added.push(xml)
      return nid
    },
    added: () => added.length,
    apply(header) {
      if (!added.length) return header
      const end = header.indexOf("</hh:charProperties>")
      if (end < 0) return header
      return (header.slice(0, end) + added.join("") + header.slice(end))
        .replace(/(<hh:charProperties\b[^>]{0,1024}?\bitemCnt=")(\d+)"/, (_, a: string, n: string) => `${a}${Number(n) + added.length}"`)
    },
  }
}
