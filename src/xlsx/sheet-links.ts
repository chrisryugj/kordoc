/**
 * XLSX 칸 하이퍼링크(시트 <hyperlinks><hyperlink ref r:id>) → 칸 글을 "[글](주소)" 로. DOCX 링크와 같은 꼴이고 주소는 sanitizeHref 로
 * 거른다(허용 스킴이 아니면 평문). 같은 문서 안 위치(location 만 있는 링크)는 바깥 주소가 없어 그대로 둔다.
 */
import type JSZip from "jszip"
import { readRels } from "./sheet-charts.js"
import { sanitizeHref } from "../utils.js"

const cellAt = (ref: string): [number, number] | null => {
  const m = /^([A-Z]{1,3})(\d+)/.exec(ref.toUpperCase())
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return [Number(m[2]) - 1, col - 1]
}

/** 시트 XML 의 하이퍼링크를 rows(행 → 열별 글)에 입힌다. 입힌 칸 수 */
export async function applySheetLinks(zip: JSZip, sheetPath: string, sheetXml: string, rows: Map<number, string[]>): Promise<number> {
  const tail = sheetXml.slice(Math.max(0, sheetXml.lastIndexOf("</sheetData>")))
  const links = [...tail.matchAll(/<(?:\w+:)?hyperlink\b([^>]*)\/?>/g)]
  if (!links.length) return 0
  const rels = new Map((await readRels(zip, sheetPath)).map(r => [r.id, r]))
  let n = 0
  for (const m of links) {
    const ref = /\bref="([^"]+)"/.exec(m[1])?.[1]
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] ?? /\b\w+:id="([^"]+)"/.exec(m[1])?.[1]
    const target = rid ? rels.get(rid)?.target : undefined
    const href = target ? sanitizeHref(target.replace(/&amp;/g, "&")) : null
    const at = ref ? cellAt(ref) : null
    if (!href || !at) continue
    const row = rows.get(at[0]), text = row?.[at[1]]
    if (!row || !text || text.startsWith("[")) continue
    row[at[1]] = `[${text}](${href})`
    n++
  }
  return n
}
