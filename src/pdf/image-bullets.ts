/** Repeated hollow-circle raster markers are list text, not a trailing image placeholder. */
import { OPS, ImageKind } from "./ops.js"
import type { NormItem } from "./text-line.js"
import { extractImageRegions, type ImageRegion } from "./image-regions.js"

export interface Pixels { width: number; height: number; kind?: number; data?: Uint8Array | Uint8ClampedArray }
export interface PageObjects {
  objs: { get(id: string, callback?: (value: unknown) => void): unknown }
  commonObjs: { get(id: string, callback?: (value: unknown) => void): unknown }
}
interface Candidate { id: string; x: number; width: number; line: NormItem }
const multiply = (m: number[], t: number[]) => [
  m[0] * t[0] + m[2] * t[1], m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3], m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4], m[1] * t[4] + m[3] * t[5] + m[5],
]

function hollowCircle(image: Pixels | null): boolean {
  if (!image?.data || image.width < 16 || image.width > 128 || image.height < 16 || image.height > 128 ||
      Math.abs(image.width - image.height) > Math.min(image.width, image.height) * 0.1) return false
  const stride = image.kind === ImageKind.RGB_24BPP ? 3 : image.kind === ImageKind.RGBA_32BPP ? 4 : 0
  const { width, height, data } = image
  if (!stride || data.length < width * height * stride) return false
  const dark: { x: number; y: number }[] = []
  let white = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * stride
    if (stride === 4 && data[i + 3] < 240) return false
    const min = Math.min(data[i], data[i + 1], data[i + 2]), max = Math.max(data[i], data[i + 1], data[i + 2])
    if (max - min > 15) return false
    if (min >= 235) white++
    if (max < 180) dark.push({ x, y })
  }
  if (white < width * height * 0.65 || dark.length < width * height * 0.025 || dark.length > width * height * 0.3) return false
  const x0 = Math.min(...dark.map(p => p.x)), x1 = Math.max(...dark.map(p => p.x))
  const y0 = Math.min(...dark.map(p => p.y)), y1 = Math.max(...dark.map(p => p.y))
  const w = x1 - x0 + 1, h = y1 - y0 + 1, radius = (w + h) / 4
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
  if (Math.abs(w - h) > Math.min(w, h) * 0.15 || w < width * 0.4 || w > width * 0.85 ||
      h < height * 0.4 || h > height * 0.85 ||
      x0 < width * 0.04 || y0 < height * 0.04 || x1 >= width * 0.96 || y1 >= height * 0.96 ||
      Math.abs(cx - width / 2) > width * 0.15 || Math.abs(cy - height / 2) > height * 0.15) return false
  const sectors = new Set<number>()
  for (const point of dark) {
    const r = Math.hypot(point.x - cx, point.y - cy) / radius
    if (r < 0.65 || r > 1.15) return false
    sectors.add(Math.floor((Math.atan2(point.y - cy, point.x - cx) + Math.PI) / (Math.PI * 2) * 8) % 8)
  }
  return sectors.size === 8
}

export async function resolveImagePixels(page: PageObjects, id: string): Promise<Pixels | null> {
  const objects = id.startsWith("g_") ? page.commonObjs : page.objs
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 5000)
    try { objects.get(id, value => { clearTimeout(timer); resolve((value ?? null) as Pixels | null) }) }
    catch { clearTimeout(timer); resolve(null) }
  })
}

/** Visible small image paints; unknown clips and transparency never supply semantic evidence. */
export function smallVisibleImagePaints(fnArray: ArrayLike<number>, argsArray: unknown[][]): { id: string; box: ImageRegion; mirrored: boolean }[] {
  const paints: { id: string; box: ImageRegion; mirrored: boolean }[] = []
  let ctm = [1, 0, 0, 1, 0, 0]
  let alpha = 1, clip: ImageRegion | null = null, unknownClip = false
  const stack: { ctm: number[]; alpha: number; clip: ImageRegion | null; unknownClip: boolean }[] = []
  let pathRect: ImageRegion | null | undefined, pendingClip = false
  const intersectClip = (box: ImageRegion) => { clip = clip ? {
    x1: Math.max(clip.x1, box.x1), y1: Math.max(clip.y1, box.y1),
    x2: Math.min(clip.x2, box.x2), y2: Math.min(clip.y2, box.y2),
  } : box }
  const rectangle = (x: number, y: number, w: number, h: number) => extractImageRegions(
    [OPS.transform, OPS.transform, OPS.paintImageXObject], [ctm, [w, 0, 0, h, x, y], ["bounds"]],
  )[0]
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i], args = argsArray[i]
    if (op === OPS.save || op === OPS.paintFormXObjectBegin) {
      stack.push({ ctm, alpha, clip, unknownClip })
      const matrix = op === OPS.paintFormXObjectBegin ? args?.[0] : undefined
      if (Array.isArray(matrix) && matrix.length >= 6) ctm = multiply(ctm, matrix as number[])
      const bounds = op === OPS.paintFormXObjectBegin ? args?.[1] : undefined
      if (Array.isArray(bounds) && bounds.length === 4) {
        const box = rectangle(bounds[0], bounds[1], bounds[2] - bounds[0], bounds[3] - bounds[1])
        if (box && ctm[1] === 0 && ctm[2] === 0) intersectClip(box)
        else unknownClip = true
      }
    } else if (op === OPS.restore || op === OPS.paintFormXObjectEnd) {
      const state = stack.pop()
      ctm = state?.ctm ?? [1, 0, 0, 1, 0, 0]
      alpha = state?.alpha ?? 1; clip = state?.clip ?? null; unknownClip = state?.unknownClip ?? false
    } else if (op === OPS.setGState) {
      for (const [key, value] of (args?.[0] ?? []) as [string, unknown][]) {
        if (key === "ca") alpha = typeof value === "number" ? value : 0
      }
    } else if (op === OPS.constructPath) {
      const [operations, coordinates] = args as number[][]
      pathRect = pathRect === undefined && operations?.length === 1 && operations[0] === OPS.rectangle &&
        coordinates?.length >= 4 && ctm[1] === 0 && ctm[2] === 0
        ? rectangle(coordinates[0], coordinates[1], coordinates[2], coordinates[3]) : null
    } else if (op === OPS.clip || op === OPS.eoClip) pendingClip = true
    else if ([OPS.endPath, OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
      OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke].includes(op)) {
      if (pendingClip) { if (pathRect) intersectClip(pathRect); else unknownClip = true }
      pendingClip = false; pathRect = undefined
    } else if (op === OPS.transform && Array.isArray(args) && args.length >= 6) ctm = multiply(ctm, args as number[])
    else if (op === OPS.paintImageXObject && typeof args?.[0] === "string") {
      if (typeof args[1] !== "number" || typeof args[2] !== "number" ||
          args[1] < 16 || args[1] > 128 || args[2] < 16 || args[2] > 128) continue
      const box = extractImageRegions([OPS.transform, OPS.paintImageXObject], [ctm, args])[0]
      // PDF producers can clip a pixel of the white image margin; classified ink
      // stays at least 4% from every edge, so a 3% crop cannot hide the circle.
      if (!box || ctm[1] !== 0 || ctm[2] !== 0 || alpha < 0.99 || unknownClip ||
          clip && (box.x1 + (box.x2 - box.x1) * 0.03 < clip.x1 ||
            box.y1 + (box.y2 - box.y1) * 0.03 < clip.y1 ||
            box.x2 - (box.x2 - box.x1) * 0.03 > clip.x2 ||
            box.y2 - (box.y2 - box.y1) * 0.03 > clip.y2)) continue
      const width = box.x2 - box.x1, height = box.y2 - box.y1
      if (width < 3 || width > 24 || height < 3 || height > 24 || width / height < 0.5 || width / height > 2) continue
      paints.push({ id: args[0], box, mirrored: ctm[0] < 0 })
    }
  }
  return paints
}

/** Require repeated markers or an explicit numbered list, aligned prose, and a visible white hollow ring. */
export async function restoreImageBullets(
  items: NormItem[], page: PageObjects, fnArray: ArrayLike<number>, argsArray: unknown[][],
  shapes = new Map<string, boolean>(),
): Promise<number> {
  const candidates: Candidate[] = []
  for (const { id, box } of smallVisibleImagePaints(fnArray, argsArray)) {
    const width = box.x2 - box.x1, height = box.y2 - box.y1
    if (Math.abs(width - height) > Math.min(width, height) * 0.1) continue
    const line = items.filter(item => !item.isHidden && item.fontSize > 0 &&
      item.x >= box.x2 && item.x - box.x2 <= item.fontSize * 0.7 &&
      Math.abs(item.y + item.h / 2 - (box.y1 + box.y2) / 2) <= item.fontSize * 0.4 &&
      height >= item.fontSize * 0.5 && height <= item.fontSize * 1.2)
      .sort((a, b) => a.x - b.x)[0]
    if (!line || /^[○●•◦□■∙]/.test(line.text.trim()) || !/\p{L}/u.test(line.text)) continue
    const row = items.filter(item => Math.abs(item.y - line.y) <= 2 && item.x >= line.x)
    if (row.reduce((n, item) => n + (item.text.match(/\p{L}/gu)?.length ?? 0), 0) < 12 ||
        items.some(item => item !== line && Math.abs(item.y - line.y) <= 2 && item.x < line.x)) continue
    candidates.push({ id, x: box.x1, width, line })
}
  let restored = 0
  const used = new Set<NormItem>()
  for (const candidate of candidates) {
    const same = candidates.filter(other => other.id === candidate.id && other.line !== candidate.line &&
      Math.abs(other.line.x - candidate.line.x) <= 1 && Math.abs(other.x - candidate.x) <= 1 &&
      Math.abs(other.width - candidate.width) <= 1 && other.line.fontSize === candidate.line.fontSize &&
      Math.abs(other.line.y - candidate.line.y) >= candidate.line.fontSize * 2)
    const numbered = items.filter(item => !item.isHidden && /^[①-⑮]\s*/.test(item.text.trim()) &&
      item.fontName === candidate.line.fontName && item.fontSize === candidate.line.fontSize &&
      Math.abs(item.x - candidate.x) <= 1 && (item.text.match(/\p{L}/gu)?.length ?? 0) >= 12)
      .sort((a, b) => b.y - a.y)
    const numberedList = numbered.some((item, index) => index > 0 &&
      item.text.trim().charCodeAt(0) === numbered[index - 1].text.trim().charCodeAt(0) + 1)
    if ((!same.length && !numberedList) || used.has(candidate.line)) continue
    if (!shapes.has(candidate.id)) shapes.set(candidate.id, hollowCircle(await resolveImagePixels(page, candidate.id)))
    if (!shapes.get(candidate.id)) continue
    used.add(candidate.line)
    items.push({ ...candidate.line, text: "○", x: candidate.x, w: candidate.width, strike: false, underline: false, hasSpaceBefore: false, syntheticSpace: false })
    restored++
  }
  return restored
}
