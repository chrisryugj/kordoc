import type { IRBlock } from "../types.js"
import { attachDropCaps } from "./local-regions.js"
import { WrapLexicon, bodyLineJoins, wrapJoiner, startsNewItem, PARA_LAST_LINE, PARA_FIRST_LEFT } from "./line-wrap.js"
import { computeBBox, dominantStyle, mergeLineSimple, sortLineByX, type NormItem } from "./text-line.js"
import { tagScripts } from "./script-items.js"
import { XY_WRAP_BANDS, tocRecordBoundaries } from "./xy-cut.js"

/** 문단 블록의 서체별 글자 수 — 앞머리만 굵은 문장("Definition 1. A universe…")은 서체 차이로 제목이 아니다 */
export const FACE_CHARS = new WeakMap<IRBlock, Map<string, number>>()

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
  // A two-line leaf can lose the other line-pitch samples from its parent region.
  // Restore only those exact boundaries already confirmed before XY-cut.
  const first = lines[0]?.items[0]
  const bands = first ? XY_WRAP_BANDS.get(first) ?? [] : []
  const hasBand = (top: number, bottom: number) => {
    let lo = 0, hi = bands.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (bands[mid].top > top + 3) lo = mid + 1
      else hi = mid
    }
    for (; lo < bands.length && bands[lo].top >= top - 3; lo++) {
      if (Math.abs(bands[lo].bottom - bottom) <= 3) return true
    }
    return false
  }
  for (let i = 0; i + 1 < geo.length; i++) {
    if (joins[i] === "\n" && Math.abs(geo[i + 1].fontSize - geo[i].fontSize) <= 0.15 * geo[i].fontSize &&
        !startsNewItem(geo[i].text, geo[i + 1].text) &&
        hasBand(geo[i].y, geo[i + 1].y)) {
      joins[i] = wrapJoiner(geo[i].text, geo[i + 1].text, lex)
    }
  }
  // 줄 끝 아이템 뒤에 공백 글리프가 찍힌 꺾임은 어절 경계다 — 어휘 증거·형태 규칙이 붙인 것도 띄운다 (markTrailingSpaceGlyphs)
  for (let i = 0; i + 1 < lines.length; i++) {
    if (joins[i] === "" && lines[i].items.reduce((a, b) => (b.x + b.w > a.x + a.w ? b : a)).spaceAfter) joins[i] = " "
  }
  // Completed TOC entries remain independent even inside a short-pitch leaf.
  for (const i of tocRecordBoundaries(lines.map(line => line.items))) joins[i] = "\n"
  // 큰 글자로 따로 선 장 번호("2")는 아래 제목 줄과 다른 문단이다 (ODL 021)
  for (let i = 0; i + 1 < geo.length; i++) {
    if (/^\d{1,2}$/.test(geo[i].text.trim()) && geo[i].fontSize >= geo[i + 1].fontSize * 1.2) joins[i] = "\n"
  }
  if (hasNumberedStyledTitle(lines.map(line => line.items))) {
    joins[0] = "\n"
    joins[1] = "\n"
  }
  for (let i = 0; i < lines.length;) {
    const first = i
    let text = lines[i].text
    const items = [...lines[i].items]
    const srcLines = [lines[i].items]
    for (; i + 1 < lines.length && joins[i] !== "\n"; i++) {
      text += joins[i] + lines[i + 1].text
      items.push(...lines[i + 1].items)
      srcLines.push(lines[i + 1].items)
    }
    // 첨자 태그 — 줄 이음 판정(평문)을 다 한 뒤에
    text = tagScripts(text, srcLines.map(l => sortLineByX([...l])))
    const block: IRBlock = { type: "paragraph", text, pageNumber: pageNum, bbox: computeBBox(items, pageNum), style: dominantStyle(items) }
    const faces = new Map<string, number>()
    for (const it of items) faces.set(it.fontName, (faces.get(it.fontName) ?? 0) + it.text.length)
    FACE_CHARS.set(block, faces)
    // 끝줄 기하 — 쪽 넘김 꺾임 잇기(joinPageBreakWraps) 재료
    PARA_LAST_LINE.set(block.bbox!, { right: geo[i].right, width: geo[i].right - geo[i].left, fontSize: geo[i].fontSize })
    PARA_FIRST_LEFT.set(block.bbox!, geo[first].left)
    out.push(block)
    i++
  }
}
