/** Keep connected closed boxes together when sorting a horizontal procedure band. */
import type { IRBlock } from "../types.js"
import type { TableGrid, LineSegment } from "./line-types.js"
import type { ImageRegion } from "./image-regions.js"
import { ImageKind } from "./ops.js"
import { smallVisibleImagePaints, resolveImagePixels, type PageObjects, type Pixels } from "./image-bullets.js"

const contains = (outer: ImageRegion, inner: ImageRegion, tolerance = 1) =>
  inner.x1 >= outer.x1 - tolerance && inner.x2 <= outer.x2 + tolerance &&
  inner.y1 >= outer.y1 - tolerance && inner.y2 <= outer.y2 + tolerance

function closed(grid: TableGrid, hs: LineSegment[], vs: LineSegment[]): boolean {
  const b = grid.bbox
  return [b.y1, b.y2].every(y => hs.some(h => Math.abs(h.y1 - y) <= 1 && h.x1 <= b.x1 + 1 && h.x2 >= b.x2 - 1)) &&
    [b.x1, b.x2].every(x => vs.some(v => Math.abs(v.x1 - x) <= 1 && v.y1 <= b.y1 + 1 && v.y2 >= b.y2 - 1))
}

/** Only four or more closed, equal-height boxes connected by matching small central images.
 * Each connector must already have verified right-pointing pixel evidence.
 * Inner table shapes and every source block are retained without text changes. */
export function groupFlowBoxUnits(
  blocks: IRBlock[], grids: TableGrid[], hs: LineSegment[], vs: LineSegment[], images: ImageRegion[],
): IRBlock[][] {
  const candidates = grids.filter(g => g.bbox.y2 - g.bbox.y1 >= 30 && closed(g, hs, vs) &&
    !grids.some(other => other !== g && contains(other.bbox, g.bbox, 0) &&
      (other.bbox.x2 - other.bbox.x1) * (other.bbox.y2 - other.bbox.y1) >
      (g.bbox.x2 - g.bbox.x1) * (g.bbox.y2 - g.bbox.y1) + 1))
  const bands: TableGrid[][] = [], visited = new Set<TableGrid>()
  for (const first of candidates) {
    if (visited.has(first)) continue
    const row = candidates.filter(g => Math.abs(g.bbox.y1 - first.bbox.y1) <= 1 && Math.abs(g.bbox.y2 - first.bbox.y2) <= 1)
      .sort((a, b) => a.bbox.x1 - b.bbox.x1)
    row.forEach(g => visited.add(g))
    if (row.length < 4 || row.filter(g => g.rowYs.length === 2 && g.colXs.length === 2).length < 3) continue
    const connectors: ImageRegion[] = []
    for (let i = 1; i < row.length; i++) {
      const left = row[i - 1].bbox, right = row[i].bbox, gap = right.x1 - left.x2
      if (gap < 4 || gap > Math.min(left.x2 - left.x1, right.x2 - right.x1) * 0.6) break
      const centerX = (left.x2 + right.x1) / 2, centerY = (left.y1 + left.y2) / 2
      const connector = images.find(p => {
        const w = p.x2 - p.x1, h = p.y2 - p.y1
        return p.x1 >= left.x2 && p.x2 <= right.x1 && w >= gap * 0.4 && w <= gap * 0.9 &&
          h >= 3 && h <= (left.y2 - left.y1) * 0.2 && w / h >= 0.8 && w / h <= 1.6 &&
          Math.abs((p.x1 + p.x2) / 2 - centerX) <= gap * 0.15 &&
          Math.abs((p.y1 + p.y2) / 2 - centerY) <= (left.y2 - left.y1) * 0.1
      })
      if (!connector) break
      connectors.push(connector)
    }
    if (connectors.length !== row.length - 1 || connectors.some(p =>
      Math.abs((p.x2 - p.x1) - (connectors[0].x2 - connectors[0].x1)) > (connectors[0].x2 - connectors[0].x1) * 0.2 ||
      Math.abs((p.y2 - p.y1) - (connectors[0].y2 - connectors[0].y1)) > (connectors[0].y2 - connectors[0].y1) * 0.2)) continue
    bands.push(row)
  }
  const members = new Map<IRBlock, IRBlock[]>()
  for (const band of bands) {
    const columns = band.map(g => blocks.filter(b => b.bbox && contains(g.bbox, {
      x1: b.bbox.x, y1: b.bbox.y, x2: b.bbox.x + b.bbox.width, y2: b.bbox.y + b.bbox.height,
    })).sort((a, b) => b.bbox!.y + b.bbox!.height - a.bbox!.y - a.bbox!.height || a.bbox!.x - b.bbox!.x))
    if (columns.some(column => !column.length)) continue
    const unit = columns.flat()
    for (const block of unit) members.set(block, unit)
  }
  const units: IRBlock[][] = [], emitted = new Set<IRBlock[]>()
  for (const block of blocks) {
    const unit = members.get(block)
    if (!unit) units.push([block])
    else if (!emitted.has(unit)) { units.push(unit); emitted.add(unit) }
  }
  return units
}

/** White-backed raster arrow: thin central tail, broad head and a central tip. */
function arrowDirection(image: Pixels | null): -1 | 0 | 1 {
  if (!image?.data || image.width < 16 || image.width > 128 || image.height < 16 || image.height > 128) return 0
  const { width, height, data } = image
  const stride = image.kind === ImageKind.RGB_24BPP ? 3 : image.kind === ImageKind.RGBA_32BPP ? 4 : 0
  if (!stride || data.length < width * height * stride) return 0
  const ink: { x: number; y: number }[] = []; let white = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * stride
    if (stride === 4 && data[offset + 3] < 240) return 0
    const min = Math.min(data[offset], data[offset + 1], data[offset + 2])
    if (min >= 235) white++
    if (min < 230) ink.push({ x, y })
  }
  if (white < width * height * 0.55 || !ink.length) return 0
  const x0 = Math.min(...ink.map(p => p.x)), x1 = Math.max(...ink.map(p => p.x))
  const y0 = Math.min(...ink.map(p => p.y)), y1 = Math.max(...ink.map(p => p.y))
  const w = x1 - x0 + 1, h = y1 - y0 + 1, centerY = (y0 + y1) / 2
  if (w < width * 0.5 || h < height * 0.5 || x0 < width * 0.04 || y0 < height * 0.04 ||
      x1 >= width * 0.96 || y1 >= height * 0.96) return 0
  const pointsRight = (mirror: boolean) => {
    const points = ink.map(p => ({ x: mirror ? x0 + x1 - p.x : p.x, y: p.y }))
    const tail = points.filter(p => p.x <= x0 + w * 0.25), tip = points.filter(p => p.x >= x1 - w * 0.1)
    if (!tail.length || !tip.length) return false
    const span = (points: { y: number }[]) => Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)) + 1
    if (span(tail) > h * 0.4 || span(tip) > h * 0.45 ||
        Math.abs((Math.max(...tail.map(p => p.y)) + Math.min(...tail.map(p => p.y))) / 2 - centerY) > h * 0.1 ||
        Math.abs((Math.max(...tip.map(p => p.y)) + Math.min(...tip.map(p => p.y))) / 2 - centerY) > h * 0.1) return false
    // A broad arrowhead sits beyond the tail and converges to the tip.
    let head = 0
    for (let x = Math.ceil(x0 + w * 0.45); x <= x0 + w * 0.75; x++) {
      const column = points.filter(p => p.x === x)
      if (column.length) head = Math.max(head, span(column))
    }
    const middle = new Set(points.filter(p => Math.abs(p.y - centerY) <= 1).map(p => p.x))
    return head >= h * 0.8 && middle.size >= w * 0.9
  }
  return pointsRight(false) ? 1 : pointsRight(true) ? -1 : 0
}

export async function detectRightArrowRegions(
  page: PageObjects, fnArray: ArrayLike<number>, argsArray: unknown[][],
  directions = new Map<string, -1 | 0 | 1>(),
): Promise<ImageRegion[]> {
  const regions: ImageRegion[] = []
  const paints = smallVisibleImagePaints(fnArray, argsArray)
  for (const paint of paints) {
    // No decode for isolated icons or vertical bullet runs: a four-box band
    // needs at least three repeated, horizontally separated connectors.
    const row = paints.filter(other => other.id === paint.id &&
      Math.abs(other.box.y1 - paint.box.y1) <= 1 && Math.abs(other.box.y2 - paint.box.y2) <= 1 &&
      Math.abs((other.box.x2 - other.box.x1) - (paint.box.x2 - paint.box.x1)) <= 1)
    const positions = new Set(row.map(other => Math.round(other.box.x1)))
    if (positions.size < 3) continue
    if (!directions.has(paint.id)) directions.set(paint.id, arrowDirection(await resolveImagePixels(page, paint.id)))
    const direction = directions.get(paint.id) ?? 0
    if (direction && (paint.mirrored ? -direction : direction) === 1) regions.push(paint.box)
  }
  return regions
}
