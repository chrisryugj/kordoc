/**
 * XLSX 칸 메모(xl/commentsN.xml, 시트 관계 type .../comments) → MemoNote. HWP·HWPX 메모(#180)와 같은 꼴이라 결과 `memos` 와
 * `memos` 옵션의 끝 "메모" 절을 같이 쓴다. 붙은 글은 그 칸 글(없으면 칸 주소), 문단도 칸 글.
 */
import type JSZip from "jszip"
import { DOMParser } from "../xml/dom.js"
import { localName } from "../shared/xml.js"
import { readZipEntry } from "../hwpx/parser-shared.js"
import { stripDtd } from "../utils.js"
import { readRels, resolvePart } from "./sheet-charts.js"
import type { MemoNote } from "../types.js"

/** "B12" → [행, 열] (0부터) */
function cellRef(ref: string): [number, number] | null {
  const m = /^([A-Z]{1,3})(\d+)$/.exec(ref.toUpperCase())
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return [Number(m[2]) - 1, col - 1]
}

const textOf = (el: Element): string => {
  // 메모 글 = 모든 t 이음(r 마다 서식만 다른 조각). rPh(읽기 표기)는 뺀다
  let out = ""
  const walk = (e: Element) => {
    for (const c of Array.from(e.childNodes)) {
      if (c.nodeType !== 1) continue
      const n = localName(c as Element)
      if (n === "rPh") continue
      if (n === "t") out += (c as Element).textContent ?? ""
      else walk(c as Element)
    }
  }
  walk(el)
  return out.replace(/\r\n?/g, "\n").trim()
}

export async function sheetComments(zip: JSZip, sheetPath: string, rows: Map<number, string[]>): Promise<MemoNote[]> {
  const out: MemoNote[] = []
  for (const rel of (await readRels(zip, sheetPath)).filter(r => /\/comments$/.test(r.type))) {
    const file = zip.file(resolvePart(sheetPath, rel.target))
    if (!file) continue
    const doc = new DOMParser().parseFromString(stripDtd(await readZipEntry(file, "text")), "text/xml")
    const authors = [...doc.getElementsByTagName("*")].filter(e => localName(e) === "author").map(e => (e.textContent ?? "").trim())
    for (const c of [...doc.getElementsByTagName("*")].filter(e => localName(e) === "comment")) {
      const ref = c.getAttribute("ref") ?? ""
      const body = [...c.childNodes].find(n => n.nodeType === 1 && localName(n as Element) === "text") as Element | undefined
      const text = body ? textOf(body) : ""
      if (!text) continue
      const at = cellRef(ref)
      const cell = at ? (rows.get(at[0])?.[at[1]] ?? "").trim() : ""
      const author = authors[Number(c.getAttribute("authorId") ?? -1)]
      // 엑셀 옛 메모는 글 첫 줄에 작성자 이름("작성자:")을 굵게 넣는다 — 작성자는 따로 있으니 뗀다
      const body2 = author && text.startsWith(author + ":") ? text.slice(author.length + 1).trim() : text
      if (!body2) continue
      out.push({ text: body2, anchor: cell || ref, paragraph: cell, offset: 0, ...(author ? { author } : {}) })
    }
  }
  return out
}
