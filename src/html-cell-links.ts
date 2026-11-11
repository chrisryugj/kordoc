/**
 * `htmlCellLinks` 옵션 — HTML 표 셀의 링크를 `<a href>` 로. GFM 은 HTML 블록 안의 마크다운을 해석하지 않아, 병합·중첩 표 셀의
 * `[텍스트](URL)`·URL 은 뷰어에서 눌리지 않는다. 마크다운을 다 만든 뒤 HTML 표 안의 텍스트에만 적용한다(태그와 표 밖은 그대로).
 * 기본 꺼짐 — LLM·RAG 소비자에겐 주소를 두 번 싣는 표기다. 읽는 쪽 역변환은 roundtrip/markdown-units htmlCellInnerToLines
 */

import { BARE_URL, escapeHtml, gfmUrlEnd, gfmUrlHref, isGfmUrl, sanitizeHref, unescapeHtml } from "./utils.js"

/** 셀 텍스트 속 링크 — 파서가 텍스트에 넣는 [링크 텍스트](안전 스킴 URL)와 GFM 이 링크로 인식하는 URL. 링크 텍스트에 [ 는 없다(가장 안쪽 [ 부터) */
const TEXT_LINK = new RegExp(String.raw`\[([^[\]\n]*)\]\(((?:https?:|mailto:|tel:|#)[^)\s<>"'\x60]*)\)|(${BARE_URL})`, "gi")
const TAG = /(<[^>]*>)/

/** 이스케이프된 셀 텍스트 하나 → 링크를 <a href> 로. 링크가 없으면 받은 그대로 */
function linkText(html: string): string {
  const text = unescapeHtml(html)
  let out = "", last = 0
  for (const m of text.matchAll(TEXT_LINK)) {
    const at = m.index!
    let shown = m[1], href = m[2], end = at + m[0].length
    if (m[3]) {
      if (!isGfmUrl(m[3], text, end)) continue
      shown = m[3].slice(0, gfmUrlEnd(m[3]))
      href = gfmUrlHref(shown)
      end = at + shown.length
    }
    out += escapeHtml(text.slice(last, at)) + `<a href="${escapeHtml(sanitizeHref(href) ?? "", true)}">${escapeHtml(shown)}</a>`
    last = end
  }
  return last ? out + escapeHtml(text.slice(last)) : html
}

/** 마크다운의 HTML 표(<table> … </table>, 한 줄이든 태그마다 한 줄이든) 안 텍스트의 링크를 <a href> 로 */
export function htmlCellLinks(markdown: string): string {
  let depth = 0
  return markdown.split("\n").map(line => {
    const opens = (line.match(/(?<!\\)<table\b/gi) ?? []).length
    if (!depth && !opens) return line
    depth = Math.max(0, depth + opens - (line.match(/(?<!\\)<\/table>/gi) ?? []).length)
    return line.split(TAG).map((part, i) => i % 2 ? part : linkText(part)).join("")
  }).join("\n")
}
