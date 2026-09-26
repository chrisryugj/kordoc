/**
 * PDF 헤딩 강등 — 승격 패스들이 끝난 뒤, 제목이 될 수 없는 역할의 줄을 본문으로 되돌린다.
 *
 * 승격 패스는 글꼴 크기·서체 차이만 보므로 쪽 머리말·꼬리말, 캡션, 번호 붙은 수식 줄,
 * 문장 중간에서 끊긴 줄도 올린다. 여기서는 문자열 정답이 아니라 역할 증거(쪽 가장자리 띠와
 * 쪽번호, 캡션 표지, 수식 번호·관계 기호, 소문자로 시작하는 이어진 문장)로만 판단한다.
 */

import type { IRBlock } from "../types.js"
import { TOC_BLOCKS } from "./table-roles.js"

const PAGE_NUMBER = /^(?:\d{1,4}|[ivxlc]{1,7})$/i
const CAPTION = /^(?:Table|Figure|Fig\.?)\s*\d+(?:\.\d+)*\s*[.:]/i
const EQUATION_NUMBER = /\t\(\d{1,3}[a-z]?\)\s*$/
/** 별행 수식 — 관계 기호·근호·큰 연산자가 든 줄은 절 제목이 아니다 (#89 "MultiHead(Q, K, V) = Concat(…)") */
const DISPLAY_MATH = /=|[√∑∏∫∂∇≤≥≈≠∈∀∃]/

/** A running head sits in the outer band of the page with nothing beyond it and
 * spreads its parts to the page edges (tab-separated), usually with a page number. */
function isRunningHead(block: IRBlock, page: IRBlock[], pageHeight: number | undefined): boolean {
  const box = block.bbox, text = block.text?.trim()
  if (!box || !text || !pageHeight) return false
  const top = box.y + box.height >= pageHeight * 0.9
  const bottom = box.y <= pageHeight * 0.1
  if (!top && !bottom) return false
  const others = page.filter(o => o !== block && o.bbox && o.type !== "image" && o.type !== "separator")
  if (top && others.some(o => o.bbox!.y + o.bbox!.height > box.y + box.height)) return false
  if (bottom && others.some(o => o.bbox!.y < box.y)) return false
  // A title always has content after it: a single line closing the page's bottom band is a footer.
  if (bottom && box.height <= (block.style?.fontSize ?? 0) * 1.6) return true
  if (!text.includes("\t")) return false
  const parts = text.split(/\t+/).map(part => part.trim()).filter(Boolean)
  if (parts.length >= 2 && (PAGE_NUMBER.test(parts[0]) || PAGE_NUMBER.test(parts[parts.length - 1]))) return true
  const left = Math.min(...page.filter(o => o.bbox).map(o => o.bbox!.x))
  const right = Math.max(...page.filter(o => o.bbox).map(o => o.bbox!.x + o.bbox!.width))
  return right > left && box.width >= (right - left) * 0.6
}

function unbalancedClose(text: string): boolean {
  return (text.match(/\)/g)?.length ?? 0) > (text.match(/\(/g)?.length ?? 0)
}

export function demoteNonHeadingRoles(blocks: IRBlock[], pageHeights: Map<number, number>): void {
  const byPage = new Map<number, IRBlock[]>()
  for (const block of blocks) {
    const page = byPage.get(block.pageNumber ?? 0) ?? []
    page.push(block)
    byPage.set(block.pageNumber ?? 0, page)
  }
  // The page's prose style (face + size carrying most paragraph text): a sentence-long
  // block set in it has no typographic distinction left to make it a title.
  const bodyStyle = new Map<number, string>()
  for (const [pageNumber, page] of byPage) {
    const chars = new Map<string, number>()
    for (const b of page) {
      if ((b.type !== "paragraph" && b.type !== "heading") || !b.text || !b.style?.fontName || !b.style.fontSize) continue
      const key = `${b.style.fontName}:${b.style.fontSize}`
      chars.set(key, (chars.get(key) ?? 0) + b.text.length)
    }
    const [key, count] = [...chars].sort((a, b) => b[1] - a[1])[0] ?? []
    if (key && count! >= 300) bodyStyle.set(pageNumber, key)
  }
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]
    if (block.type !== "heading" || !block.text) continue
    const text = block.text.replace(/<[^>]+>/g, "").trim()
    // A part title between two runs of contents entries is itself an entry.
    const tocEntry = i > 0 && TOC_BLOCKS.has(blocks[i - 1]) && TOC_BLOCKS.has(blocks[i + 1])
    const page = byPage.get(block.pageNumber ?? 0) ?? []
    const proseStyle = block.style?.fontName && bodyStyle.get(block.pageNumber ?? 0) === `${block.style.fontName}:${block.style.fontSize}` &&
      text.length > 60
    // A bare section number is the first part of the title that follows it.
    const next = blocks[i + 1]
    if (/^\d+(?:\.\d+)*\.?$/.test(text) && next?.type === "heading" && next.text && next.pageNumber === block.pageNumber) {
      next.text = `${block.text.trim()} ${next.text.trim()}`
      blocks.splice(i--, 1)
      continue
    }
    // 쪽 맨 위, 바로 아래 더 큰 제목 위에 붙은 작은 머리표(슬라이드 키커 "Recommendation Pack: Track Record")는 제목이 아니다
    const box = block.bbox, size = block.style?.fontSize ?? 0
    const kicker = !!box && size > 0 && next?.type === "heading" && next.pageNumber === block.pageNumber && !!next.bbox &&
      (next.style?.fontSize ?? 0) >= size * 1.3 && box.y - (next.bbox.y + next.bbox.height) <= size * 3 &&
      Math.min(box.x + box.width, next.bbox.x + next.bbox.width) - Math.max(box.x, next.bbox.x) >= Math.min(box.width, next.bbox.width) * 0.5 &&
      !page.some(o => o !== block && o.bbox && o.bbox.y > box.y + box.height && o.type !== "image")
    if (tocEntry || proseStyle || kicker || !/\p{L}/u.test(text) || /^[a-z]/.test(text) || CAPTION.test(text) || EQUATION_NUMBER.test(block.text) || DISPLAY_MATH.test(text) ||
        // 닫는 괄호가 여는 괄호보다 많으면 앞 줄에서 이어진 문장 조각이다 ("Fact-checking) and is used …") — "1)"·"가)" 앞머리 번호는 빼고 센다
        unbalancedClose(text.replace(/^\s*[\dA-Za-z가-힣ⅰ-ⅹ]{1,3}\)\s*/, "")) ||
        isRunningHead(block, page, pageHeights.get(block.pageNumber ?? 0))) {
      block.type = "paragraph"
      block.level = undefined
    }
  }
}
