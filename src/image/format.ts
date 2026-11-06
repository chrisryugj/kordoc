/**
 * 원본 그림 파일(HWP·HWPX·HWP3·DOCX·PPTX)을 `imageFormat` 으로 명시한 형식으로 바꾼다 (#188).
 *
 * 명시하면 모든 그림이 그 형식이다 — 뒤 단계가 파일명·MIME 을 믿고 돌기 때문이다. 명시하지 않으면 원본 그대로다.
 * PNG 는 PNG, WebP 는 무손실 WebP. 보이는 그림을 맞춘다: EXIF 회전을 적용하고, ICC 프로필·CMYK 는 sRGB 로,
 * 움직이는 GIF 는 첫 장, SVG 는 그린 그림이다. 바꿀 수 없는 그림(WMF·EMF, kordoc·sharp 가 못 읽는 BMP 변형, 손상)은
 * 원본 그대로 두고 경고한다. 이미 그 형식인 그림은 바이트를 그대로 두고 이름·MIME 만 맞춘다.
 */

import { bmpToPng, bmpToRgba, MAX_PIXELS } from "./transcode.js"
import { loadSharp, toBuffer, WEBP_OPTIONS, type SharpFactory } from "./webp.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"

export type ImageFormat = "png" | "webp"

const MIME: Record<ImageFormat, string> = { png: "image/png", webp: "image/webp" }

/** 바이트가 이미 그 형식인가 (확장자·MIME 이 아니라 내용으로) */
function isFormat(b: Uint8Array, format: ImageFormat): boolean {
  if (format === "png") return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
  return b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
}

/** sharp 는 Buffer 를 돌려준다 — 결과 JSON(워커 protocol)에서 Buffer 는 {type, data} 로 바뀌어 순수 Uint8Array 로 */
const plain = (b: Buffer | null) => b && new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

/** 그 형식 바이트 — 못 바꾸면 null */
async function convert(sharp: SharpFactory | null, img: ExtractedImage, format: ImageFormat): Promise<Uint8Array | null> {
  if (isFormat(img.data, format)) return img.data
  // BMP 는 sharp 가 읽지 못한다 — kordoc 디코더(24/32bpp BI_RGB)
  if (img.data[0] === 0x42 && img.data[1] === 0x4d) {
    if (format === "png") return bmpToPng(img.data)
    const px = bmpToRgba(img.data)
    if (!px || !sharp) return null
    return plain(await sharp(toBuffer(px.data), { raw: { width: px.width, height: px.height, channels: 4 } }).webp(WEBP_OPTIONS).toBuffer().catch(() => null))
  }
  if (!sharp) return null
  const out = sharp(toBuffer(img.data), { limitInputPixels: MAX_PIXELS }).rotate()
  return plain(await (format === "png" ? out.png() : out.webp(WEBP_OPTIONS)).toBuffer().catch(() => null))
}

/**
 * `images` 를 모두 `format` 으로 바꾼다. 바꾼 그림은 파일명(`.png`·`.webp`)·바이트·MIME 과 그 이름을 쓴 그림 블록의
 * `text`·`imageData`, 글에 박힌 참조(표 칸 글·머리말·각주·캡션의 "![image](이름)")를 함께 바꾼다. 이름을 바꿨으면 true
 */
export async function convertImages(blocks: IRBlock[], images: ExtractedImage[], format: ImageFormat, warnings: ParseWarning[]): Promise<boolean> {
  const sharp = await loadSharp()
  const names = new Set(images.map(i => i.filename))
  const renamed = new Map<string, ExtractedImage>()
  const kept: string[] = []
  for (const img of images) {
    const name = img.filename.replace(/\.[^./]*$/, "") + "." + format
    const data = await convert(sharp, img, format)
    if (!data || (name !== img.filename && names.has(name))) { kept.push(img.mimeType); continue }
    if (name !== img.filename) { renamed.set(img.filename, img); names.add(name) }
    Object.assign(img, { filename: name, data, mimeType: MIME[format] })
  }
  if (kept.length) {
    const byMime = [...new Set(kept)].map(m => `${m} ${kept.filter(k => k === m).length}`).join(", ")
    warnings.push({ code: "SKIPPED_IMAGE", message: `그림 ${kept.length}개는 ${format.toUpperCase()} 로 바꾸지 못해 원본 형식으로 냈습니다 (${byMime})${sharp ? "" : " — optional dependency 'sharp' 가 없습니다"}` })
  }
  // 바이트만 바꾼 그림(이름 그대로)도 블록 imageData 는 맞춘다
  const byName = new Map(images.map(i => [i.filename, i]))
  // 표 칸 글·머리말·각주·캡션에 박힌 참조 — hwp5/images.ts 의 sentinel 치환과 같은 범위
  const fix = (s: string): string => s.includes("![image](") ? s.replace(/!\[image\]\(([^()\s]+)\)/g, (m, name: string) => {
    const img = renamed.get(name)
    return img ? `![image](${img.filename})` : m
  }) : s
  const walk = (list: IRBlock[] | undefined, depth: number) => {
    if (!list || depth > 64) return
    for (const b of list) {
      if (b.type === "image" && b.text) {
        const img = renamed.get(b.text) ?? byName.get(b.text)
        if (img) {
          b.text = img.filename
          if (b.imageData) b.imageData = { ...b.imageData, data: img.data, mimeType: img.mimeType }
        }
      } else if (b.text) b.text = fix(b.text)
      if (b.footnoteText) b.footnoteText = fix(b.footnoteText)
      walk(b.children, depth + 1)
      walk(b.footnoteBlocks, depth + 1)
      if (b.table) {
        if (b.table.caption) b.table.caption = fix(b.table.caption)
        for (const row of b.table.cells) for (const cell of row) { cell.text = fix(cell.text); walk(cell.blocks, depth + 1) }
        walk(b.table.captionBlocks, depth + 1)
      }
    }
  }
  walk(blocks, 0)
  return renamed.size > 0
}
