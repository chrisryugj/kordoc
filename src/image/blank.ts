/**
 * 빈 그림 판정 (`dropBlankImages`) — 흰 바탕에 합성했을 때 거의 한 색인 그림(빈 판·단색 띠·옅은 그러데이션 배경).
 *
 * 채널마다 최댓값과 최솟값 차가 BLANK_TOLERANCE 이하면 빈 그림이다. 투명도는 흰 바탕에 합성해 본다 — 한 색에 투명도로
 * 모양을 낸 아이콘은 모양이 남아 빈 그림이 아니다.
 */

import { bmpToRgba } from "./transcode.js"
import { loadSharp, toBuffer } from "./webp.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"

/** 채널별 허용 차 — 표본 그림 3,260개에서 이 안의 그림 184개를 눈으로 보니 모두 빈 판·단색 띠·옅은 그러데이션이었다 */
const BLANK_TOLERANCE = 24

/** 8bit RGBA 가 흰 바탕 합성 뒤 거의 한 색인가 */
export function isBlankRgba(rgba: Uint8Array): boolean {
  let r0 = 255, r1 = 0, g0 = 255, g1 = 0, b0 = 255, b1 = 0
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3], w = 255 - a
    const r = (rgba[i] * a + 255 * w) / 255, g = (rgba[i + 1] * a + 255 * w) / 255, b = (rgba[i + 2] * a + 255 * w) / 255
    if (r < r0) r0 = r; if (r > r1) r1 = r
    if (g < g0) g0 = g; if (g > g1) g1 = g
    if (b < b0) b0 = b; if (b > b1) b1 = b
    if (r1 - r0 > BLANK_TOLERANCE || g1 - g0 > BLANK_TOLERANCE || b1 - b0 > BLANK_TOLERANCE) return false
  }
  return true
}

/**
 * 원본 그림 파일(HWP·HWPX·HWP3·DOCX·PPTX)에서 빈 그림을 뺀다 — `images`, 그 이름을 쓴 그림 블록, 글에 박힌 참조("![image](이름)").
 * BMP 는 kordoc 디코더, 그 밖은 sharp 로 푼다. 풀지 못한 그림(WMF·EMF·손상)은 남긴다. 하나라도 뺐으면 true
 */
export async function dropBlankImages(blocks: IRBlock[], images: ExtractedImage[], warnings: ParseWarning[]): Promise<boolean> {
  const sharp = await loadSharp()
  const blank = new Set<string>()
  let undecided = 0
  for (const img of images) {
    let rgba: Uint8Array | null = null
    if (img.data[0] === 0x42 && img.data[1] === 0x4d) rgba = bmpToRgba(img.data)?.data ?? null
    else if (sharp && /^image\/(?:png|jpeg|gif|tiff|webp)$/.test(img.mimeType)) {
      rgba = await sharp(toBuffer(img.data), { limitInputPixels: 36_000_000 }).ensureAlpha().raw().toBuffer().then((b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength), () => null)
    } else if (!sharp && /^image\/(?:png|jpeg|gif|tiff|webp)$/.test(img.mimeType)) undecided++
    if (rgba && isBlankRgba(rgba)) blank.add(img.filename)
  }
  if (undecided) warnings.push({ code: "PARTIAL_PARSE", message: `빈 그림 판정에 optional dependency 'sharp' 가 필요합니다 — 그림 ${undecided}개는 판정하지 않고 남겼습니다` })
  if (!blank.size) return false
  for (let i = images.length - 1; i >= 0; i--) if (blank.has(images[i].filename)) images.splice(i, 1)
  const fix = (s: string): string => s.includes("![image](") ? s.replace(/!\[image\]\(([^()\s]+)\)/g, (m, name: string) => (blank.has(name) ? "" : m)) : s
  const walk = (list: IRBlock[] | undefined, depth: number): IRBlock[] | undefined => {
    if (!list || depth > 64) return list
    const kept = list.filter(b => !(b.type === "image" && b.text && blank.has(b.text)))
    for (const b of kept) {
      if (b.type !== "image" && b.text) b.text = fix(b.text)
      if (b.footnoteText) b.footnoteText = fix(b.footnoteText)
      if (b.children) b.children = walk(b.children, depth + 1)
      if (b.footnoteBlocks) b.footnoteBlocks = walk(b.footnoteBlocks, depth + 1)
      if (b.table) {
        if (b.table.caption) b.table.caption = fix(b.table.caption)
        for (const row of b.table.cells) for (const cell of row) { cell.text = fix(cell.text); if (cell.blocks) cell.blocks = walk(cell.blocks, depth + 1) }
        if (b.table.captionBlocks) b.table.captionBlocks = walk(b.table.captionBlocks, depth + 1)
      }
    }
    return kept
  }
  const kept = walk(blocks, 0)!
  blocks.length = 0
  for (const b of kept) blocks.push(b)
  return true
}
