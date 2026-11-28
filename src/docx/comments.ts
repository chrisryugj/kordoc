/**
 * DOCX 메모(word/comments.xml) → MemoNote. 붙은 글은 본문 w:commentRangeStart ~ w:commentRangeEnd 사이 글, 문단은 범위가 시작한
 * 문단 글. 범위 표시가 없는 메모(w:commentReference 만)는 붙은 글이 비고 문단만. HWP·HWPX 메모(#180)와 같은 꼴
 */
import { localName } from "../shared/xml.js"
import type { MemoNote } from "../types.js"

const attr = (el: Element, name: string): string | null => {
  for (let i = 0; i < el.attributes.length; i++) if (el.attributes[i].localName === name) return el.attributes[i].value
  return null
}

/** w:p 글(w:t 이음, w:tab 은 공백) */
function paraText(p: Element): string {
  let out = ""
  const walk = (e: Element) => {
    for (const c of Array.from(e.childNodes)) {
      if (c.nodeType !== 1) continue
      const n = localName(c as Element)
      if (n === "t") out += (c as Element).textContent ?? ""
      else if (n === "tab") out += " "
      else if (n !== "delText" && n !== "instrText") walk(c as Element)
    }
  }
  walk(p)
  return out
}

export function docxComments(commentsXml: Document, body: Element): MemoNote[] {
  const meta = new Map<string, { text: string; author?: string; createdAt?: string }>()
  for (const c of [...commentsXml.getElementsByTagName("*")].filter(e => localName(e) === "comment")) {
    const id = attr(c, "id")
    if (id === null) continue
    const text = [...c.getElementsByTagName("*")].filter(e => localName(e) === "p").map(paraText).map(s => s.trim()).filter(Boolean).join("\n")
    if (!text) continue
    const author = attr(c, "author") ?? undefined, date = attr(c, "date") ?? undefined
    meta.set(id, { text, ...(author ? { author } : {}), ...(date ? { createdAt: date } : {}) })
  }
  if (!meta.size) return []
  // 본문을 문서 순서로 걸으며 열린 범위마다 글을 모은다
  const open = new Map<string, { anchor: string; para: Element | null; offset: number }>()
  const found = new Map<string, { anchor: string; paragraph: string; offset: number }>()
  const order: string[] = []
  let para: Element | null = null, paraPos = 0
  const walk = (e: Element) => {
    for (const c of Array.from(e.childNodes)) {
      if (c.nodeType !== 1) continue
      const el = c as Element, n = localName(el)
      if (n === "p") { const prev = para, prevPos = paraPos; para = el; paraPos = 0; walk(el); para = prev; paraPos = prevPos; continue }
      if (n === "commentRangeStart") { const id = attr(el, "id"); if (id !== null && meta.has(id)) open.set(id, { anchor: "", para, offset: paraPos }) }
      else if (n === "commentRangeEnd" || n === "commentReference") {
        const id = attr(el, "id")
        if (id === null || !meta.has(id) || found.has(id)) continue
        const o = open.get(id)
        found.set(id, { anchor: (o?.anchor ?? "").trim(), paragraph: o?.para ? paraText(o.para) : para ? paraText(para) : "", offset: o?.offset ?? 0 })
        order.push(id)
        open.delete(id)
      } else if (n === "t") {
        const t = el.textContent ?? ""
        for (const o of open.values()) o.anchor += t
        paraPos += t.length
      } else if (n !== "delText" && n !== "instrText") walk(el)
    }
  }
  walk(body)
  return order.map(id => ({ ...meta.get(id)!, ...found.get(id)! })).map(m => ({ text: m.text, anchor: m.anchor, paragraph: m.paragraph, offset: m.offset, ...(m.author ? { author: m.author } : {}), ...(m.createdAt ? { createdAt: m.createdAt } : {}) }))
}
