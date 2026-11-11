/**
 * `htmlTables` 옵션 — 모든 표를 HTML 로, 태그마다 한 줄씩 들여써 낸다(BeautifulSoup prettify 와 같은 모양).
 * 파이프 표는 칸 글의 Markdown 이스케이프를 풀고 HTML 로 이스케이프해 옮기고(첫 행은 머리 칸 `<th>`), kordoc 이 이미 낸 HTML 표
 * (병합·중첩)는 모양만 정렬한다. 칸 안의 `<br>`·`<u>`·`<sup>`·`<sub>`·`<img>` 는 그대로. HTML 블록 안에 빈 줄을 만들지 않는다.
 */

const TABLE_TAG = /(<\/?(?:table|tr|th|td)\b[^>]*>)/i
/** kordoc 이 칸에 넣는 그림 태그의 정확한 꼴(print/renderer SAFE_RAW_TAG 와 같다) — 문서 글의 `\<img onerror=…>` 는 여기 안 걸려 이스케이프된다 */
const KORDOC_IMG = String.raw`<img src="(?:images\/(?:[^"'<>\/\s]+\/)?)?image_\d+\.(?:png|jpe?g|gif|webp|bmp)" alt="image">`
const KEEP_TAG = new RegExp(String.raw`((?<!\\)<br>|(?<!\\)<\/?(?:u|sup|sub)>|(?<!\\)${KORDOC_IMG})`, "i")

const escapeText = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

/**
 * 파이프 칸 글 → HTML 칸 글: Markdown 이스케이프를 풀고 &·<·> 를 이스케이프하되 kordoc 이 칸에 넣는 태그는 둔다.
 * 자동 링크 <주소>(QR 값)는 꺾쇠를 걷어 주소 글로 — 자동 링크 안은 이스케이프가 없고, 칸 구분자 \| 만 GFM 이 칸을 나눌 때 푼다
 */
function pipeCellToHtml(cell: string): string {
  return cell
    .split(KEEP_TAG)
    .map((part, i) => i % 2 ? part : part
      .split(/(?<!\\)<(https?:\/\/[^\s<>]*)>/i)
      .map((seg, k) => escapeText(k % 2 ? seg.replace(/\\\|/g, "|") : seg.replace(/\\([\\`*_{}[\]()#+\-.!|~<>$])/g, "$1")))
      .join(""))
    .join("")
}

function splitPipeRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "")
  return t.split(/(?<!\\)\|/).map(c => c.trim())
}

/** 줄 목록에서 파이프 표(머리 행 + 구분 행 + 몸통)를 HTML 표 한 줄로 바꾼다 */
function pipeTablesToHtml(lines: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i], sep = lines[i + 1]
    if (!/^\s*\|.*\|\s*$/.test(head) || !sep || !/^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(sep)) { out.push(head); continue }
    const rows = [splitPipeRow(head)]
    let j = i + 2
    for (; j < lines.length && /^\s*\|.*\|\s*$/.test(lines[j]); j++) rows.push(splitPipeRow(lines[j]))
    const html = rows.map((r, k) => `<tr>${r.map(c => `<${k === 0 ? "th" : "td"}>${pipeCellToHtml(c)}</${k === 0 ? "th" : "td"}>`).join("")}</tr>`).join("")
    out.push(`<table>${html}</table>`)
    i = j - 1
  }
  return out
}

/** HTML 표 한 덩어리 → 태그마다 한 줄, 깊이마다 한 칸 들여쓰기 */
function prettyTable(html: string): string {
  const out: string[] = []
  let depth = 0
  for (const tok of html.split(TABLE_TAG)) {
    if (!tok) continue
    if (TABLE_TAG.test(tok)) {
      const closing = tok.startsWith("</")
      if (closing) depth = Math.max(0, depth - 1)
      out.push(" ".repeat(depth) + tok)
      if (!closing) depth++
    } else {
      const text = tok.replace(/\s*\n\s*/g, " ").trim()
      if (text) out.push(" ".repeat(depth) + text)
    }
  }
  return out.join("\n")
}

export function toHtmlTables(md: string): string {
  const lines = pipeTablesToHtml(md.split("\n"))
  // 여러 줄에 걸친 HTML 표(<table> … </table>, 중첩 포함)를 한 덩어리로 모아 정렬
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*<table\b/i.test(lines[i])) { out.push(lines[i]); continue }
    let depth = 0, j = i, buf = ""
    for (; j < lines.length; j++) {
      buf += lines[j] + "\n"
      depth += (lines[j].match(/<table\b/gi) ?? []).length - (lines[j].match(/<\/table>/gi) ?? []).length
      if (depth <= 0) break
    }
    out.push(prettyTable(buf))
    i = j
  }
  return out.join("\n")
}
