import type { IRBlock } from "../types.js"
import { attachDropCaps } from "./local-regions.js"
import { WrapLexicon, bodyLineJoins, PARA_LAST_LINE } from "./line-wrap.js"
import { computeBBox, dominantStyle, mergeLineSimple, type NormItem } from "./text-line.js"

/** A numbered title and its differently styled subtitle precede body prose. */
function hasNumberedStyledTitle(lines: NormItem[][]): boolean {
  if (lines.length < 4) return false
  const [title, subtitle, body] = lines
  const face = (line: NormItem[]) => line.every(i => i.fontName === line[0].fontName) ? line[0].fontName : null
  const a = face(title), b = face(subtitle), c = face(body)
  if (!a || !b || !c || a === b || b === c || a === c ||
      !/^\d+(?:\.\d+)*\.\s+/.test(mergeLineSimple(title)) ||
      mergeLineSimple(title).length + mergeLineSimple(subtitle).length > 140 ||
      Math.abs(title[0].x - subtitle[0].x) > 30 ||
      title[0].y - subtitle[0].y > 30 || subtitle[0].y - body[0].y > 30) return false
  return true
}

/** Join wrapped source lines inside one reading region without changing item coordinates. */
export function pushLineParagraphs(out: IRBlock[], yLines: NormItem[][], pageNum: number, lex?: WrapLexicon): void {
  const lines = attachDropCaps(yLines).map(items => ({ items, text: mergeLineSimple(items) })).filter(l => l.text.trim())
  const geo = lines.map(l => {
    const b = computeBBox(l.items, pageNum)
    return { text: l.text, left: b.x, right: b.x + b.width, y: l.items.reduce((s, i) => s + i.y, 0) / l.items.length, fontSize: dominantStyle(l.items)?.fontSize ?? 0 }
  })
  const joins = bodyLineJoins(geo, lex)
  if (hasNumberedStyledTitle(lines.map(line => line.items))) {
    joins[0] = "\n"
    joins[1] = "\n"
  }
  for (let i = 0; i < lines.length;) {
    let text = lines[i].text
    const items = [...lines[i].items]
    for (; i + 1 < lines.length && joins[i] !== "\n"; i++) {
      text += joins[i] + lines[i + 1].text
      items.push(...lines[i + 1].items)
    }
    const block: IRBlock = { type: "paragraph", text, pageNumber: pageNum, bbox: computeBBox(items, pageNum), style: dominantStyle(items) }
    // 끝줄 기하 — 쪽 넘김 꺾임 잇기(joinPageBreakWraps) 재료
    PARA_LAST_LINE.set(block.bbox!, { right: geo[i].right, width: geo[i].right - geo[i].left, fontSize: geo[i].fontSize })
    out.push(block)
    i++
  }
}
