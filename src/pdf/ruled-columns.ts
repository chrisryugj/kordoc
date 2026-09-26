import type { ColRect } from './two-column.js'
import type { LineSegment } from './line-types.js'

/** A long physical divider can separate columns whose prose is mostly inside tables. */
export function findRuledColumnDivider(
  regions: ColRect[], horizontals: LineSegment[], verticals: LineSegment[],
  pageWidth: number, pageHeight: number,
): number | null {
  const candidates: number[] = []
  for (const v of verticals) {
    const x = v.x1
    if (x < pageWidth * 0.35 || x > pageWidth * 0.65 || v.y2 - v.y1 < pageHeight * 0.65) continue
    const body = regions.filter(r => r.w >= pageWidth * 0.15 && r.h >= 12 && r.y >= v.y1 && r.y + r.h <= v.y2)
    const left = body.filter(r => r.x + r.w <= x - 5)
    const right = body.filter(r => r.x >= x + 5)
    if (left.length < 2 || right.length < 2) continue
    const bounds = (rs: ColRect[]) => ({ bottom: Math.min(...rs.map(r => r.y)), top: Math.max(...rs.map(r => r.y + r.h)) })
    const a = bounds(left), b = bounds(right)
    const lo = Math.min(a.bottom, b.bottom), hi = Math.max(a.top, b.top)
    if (Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom) < (hi - lo) * 0.6) continue
    if (regions.some(r => r.x < x && r.x + r.w > x && r.y < hi && r.y + r.h > lo)) continue
    // A table's internal ruling joins horizontal borders; a column divider does not.
    if (horizontals.some(h => h.y1 > lo + 2 && h.y1 < hi - 2 && h.x1 < x - 5 && h.x2 > x + 5)) continue
    if (!candidates.some(c => Math.abs(c - x) < 3)) candidates.push(x)
  }
  return candidates.length === 1 ? candidates[0] : null
}
