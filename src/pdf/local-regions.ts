import { groupByY, type NormItem } from "./text-line.js"

/** Attach an oversized initial to the first body line it visually starts. */
export function attachDropCaps(lines: NormItem[][]): NormItem[][] {
  const result = lines.map(line => [...line])
  const sizes = result.flat().map(item => item.fontSize).filter(size => size > 0).sort((a, b) => a - b)
  const bodySize = sizes[Math.floor(sizes.length / 2)] ?? 0
  if (!bodySize) return result
  for (let source = 0; source < result.length; source++) {
    const cap = result[source].find(item => /^[A-Z]$/.test(item.text) && item.fontSize >= bodySize * 2.5 &&
      item.h >= bodySize * 2.5)
    if (!cap) continue
    const target = result.findIndex((line, index) => index < source && line.some(item =>
      item !== cap && /^[a-z]/.test(item.text) &&
      item.x >= cap.x + cap.w && item.x - (cap.x + cap.w) <= bodySize &&
      item.y > cap.y && item.y < cap.y + cap.h))
    if (target < 0) continue
    result[source].splice(result[source].indexOf(cap), 1)
    result[target].push(cap)
  }
  return result.filter(line => line.length > 0)
}

/** A large title in the left margin can precede a long, independent prose region. */
export function splitSidebarTitleRegion(items: NormItem[]): NormItem[][] | null {
  if (items.length < 30) return null
  const sizes = items.map(item => item.fontSize).filter(size => size > 0).sort((a, b) => a - b)
  const bodySize = sizes[Math.floor(sizes.length / 2)]
  const minX = Math.min(...items.map(item => item.x))
  const maxX = Math.max(...items.map(item => item.x + item.w))
  const minY = Math.min(...items.map(item => item.y))
  const maxY = Math.max(...items.map(item => item.y))
  const spanX = maxX - minX
  const spanY = maxY - minY
  if (spanX < 300 || spanY < 300) return null
  const titles = items.filter(item => item.fontSize >= bodySize * 2.2 &&
    item.x < minX + spanX * 0.4 && item.y > minY + spanY * 0.55 &&
    item.text.trim().length >= 2)
  if (titles.length < 2 || titles.length > 4) return null
  const titleLeft = Math.min(...titles.map(item => item.x))
  const titleRight = Math.max(...titles.map(item => item.x + item.w))
  const titleTop = Math.max(...titles.map(item => item.y))
  if (Math.max(...titles.map(item => Math.abs(item.x - titleLeft))) > bodySize * 2 ||
    titleRight > minX + spanX * 0.55) return null
  const prose = items.filter(item => item.x >= titleRight + 20 && item.fontSize < bodySize * 2.2 &&
    item.y <= titleTop + bodySize && item.y >= minY + spanY * 0.08)
  if (prose.length < 20 || prose.reduce((n, item) => n + item.text.length, 0) < 500) return null
  const proseLeft = Math.min(...prose.map(item => item.x))
  const bodyBottom = Math.min(...prose.map(item => item.y))
  const bodyTop = Math.max(...prose.map(item => item.y))
  if (bodyTop < titleTop - bodySize * 3 || bodyBottom > minY + spanY * 0.4) return null
  const titleSet = new Set(titles)
  const upper: NormItem[] = [], sidebar: NormItem[] = [], body: NormItem[] = [], footer: NormItem[] = []
  for (const item of items) {
    if (titleSet.has(item)) sidebar.push(item)
    else if (item.y > titleTop + bodySize * 3) upper.push(item)
    else if (item.y < bodyBottom - bodySize * 3) footer.push(item)
    else if (item.x >= proseLeft - bodySize) body.push(item)
    else return null
  }
  return [upper, sidebar, body, footer]
}

/** A short column pair below a separate full-width region. Keep source items intact. */
export function splitTrailingColumnRegion(items: NormItem[]): NormItem[][] | null {
  if (items.length < 16) return null
  const lines = groupByY(items)
  if (lines.length < 9) return null
  const ys = lines.map(line => line.reduce((sum, item) => sum + item.y, 0) / line.length)
  const gaps = ys.slice(0, -1).map((y, index) => y - ys[index + 1])
  const regular = gaps.filter(gap => gap > 2 && gap < 24).sort((a, b) => a - b)
  if (regular.length < 4) return null
  const leading = regular[Math.floor(regular.length / 2)]
  let start = -1
  for (let i = 0; i < gaps.length; i++) {
    if (gaps[i] > Math.max(22, leading * 1.8) && lines.length - i - 1 >= 5) start = i + 1
  }
  if (start < 2) return null
  const upper = lines.slice(0, start).flat()
  const lowerLines = lines.slice(start)
  const lower = lowerLines.flat()
  const fontSizes = lower.map(item => item.fontSize).filter(size => size > 0).sort((a, b) => a - b)
  const bodySize = fontSizes[Math.floor(fontSizes.length / 2)] ?? 0
  const minX = Math.min(...lower.map(item => item.x))
  const maxX = Math.max(...lower.map(item => item.x + item.w))
  if (maxX - minX < 300) return null

  let best: { x: number; paired: number; balance: number } | null = null
  for (let x = minX + (maxX - minX) * 0.35; x <= minX + (maxX - minX) * 0.65; x += 2) {
    let paired = 0, crossed = 0, leftRows = 0, rightRows = 0
    let leftChars = 0, rightChars = 0
    for (const line of lowerLines) {
      const left = line.filter(item => item.x + item.w <= x)
      const right = line.filter(item => item.x >= x)
      if (line.length !== left.length + right.length) { crossed++; continue }
      if (left.length) leftRows++
      if (right.length) rightRows++
      if (!left.length || !right.length) continue
      const gap = Math.min(...right.map(item => item.x)) - Math.max(...left.map(item => item.x + item.w))
      const lChars = left.reduce((n, item) => n + item.text.length, 0)
      const rChars = right.reduce((n, item) => n + item.text.length, 0)
      if (gap < Math.max(10, bodySize * 1.25) || lChars < 28 || rChars < 28) continue
      paired++
      leftChars += lChars
      rightChars += rChars
    }
    if (paired < 4 || leftRows < 4 || rightRows < 4 || crossed > 1) continue
    const balance = Math.min(leftChars, rightChars) / Math.max(leftChars, rightChars)
    if (balance < 0.55) continue
    if (!best || paired > best.paired || (paired === best.paired && balance > best.balance)) best = { x, paired, balance }
  }
  if (!best) return null
  const left = lower.filter(item => item.x + item.w <= best.x)
  const right = lower.filter(item => item.x >= best.x)
  if (upper.length + left.length + right.length !== items.length) return null
  return [upper, left, right]
}
