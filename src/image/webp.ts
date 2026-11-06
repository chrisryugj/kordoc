/**
 * 무손실 WebP (#188, `imageFormat: "webp"` 일 때만).
 *
 * optional dependency sharp(libwebp)는 켰을 때만 동적 import 로 불러온다. 네이티브라 네트워크 접근이 없다.
 * `exact` 로 완전 투명 화소의 RGB 도 지킨다. effort 1·quality 1 은 압축률보다 인코딩 비용을 줄인 값이다.
 * PDF 그림은 kordoc 이 픽셀에서 바로 인코딩한다(pdf/image-extract.ts). 다른 형식의 원본 그림 파일은
 * 화소를 그대로 풀 수 있고 WebP 가 더 작을 때만 바꾼다(webpSmallerImages).
 */

import { bmpToRgba, MAX_PIXELS } from "./transcode.js"
import type { ExtractedImage, IRBlock, ParseWarning } from "../types.js"

/** RGBA → WebP 바이트 */
export type WebpEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>

interface SharpImage {
  metadata(): Promise<{ pages?: number; depth?: string; space?: string; hasProfile?: boolean; orientation?: number }>
  toColourspace(space: "srgb"): SharpImage
  ensureAlpha(): SharpImage
  raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> }
  webp(opts: { lossless: true; exact: true; effort: number; quality: number }): { toBuffer(): Promise<Buffer> }
}
type SharpFactory = (input: Buffer, opts?: { raw?: { width: number; height: number; channels: 4 }; limitInputPixels?: number }) => SharpImage

let loading: Promise<SharpFactory | null> | undefined

/** sharp 가 없거나 못 열면 null */
function loadSharp(): Promise<SharpFactory | null> {
  return loading ??= (async () => {
    try {
      const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
      return typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
    } catch {
      return null
    }
  })()
}

const toBuffer = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)

function encoder(sharp: SharpFactory): WebpEncoder {
  return async (rgba, width, height) => {
    const out = await sharp(toBuffer(rgba), { raw: { width, height, channels: 4 } })
      .webp({ lossless: true, exact: true, effort: 1, quality: 1 }).toBuffer()
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

/** sharp 가 없거나 못 열면 null */
export async function loadWebpEncoder(): Promise<WebpEncoder | null> {
  const sharp = await loadSharp()
  return sharp && encoder(sharp)
}

/**
 * 그림 파일 → 8bit RGBA. 화소가 원본과 같다고 볼 수 없으면 null — 여러 장(움직이는 GIF·TIFF), 16bit,
 * ICC 프로필(sharp 가 sRGB 로 바꾼다), EXIF 회전(보이는 방향이 달라진다), sRGB·회색 밖 색 공간(CMYK 등).
 * BMP 는 sharp 가 읽지 못해 kordoc 디코더(bmpToRgba)로 푼다
 */
async function decodeLossless(sharp: SharpFactory, data: Uint8Array, mimeType: string): Promise<{ data: Uint8Array; width: number; height: number } | null> {
  if (mimeType === "image/bmp") return bmpToRgba(data)
  if (!/^image\/(?:png|jpeg|gif|tiff)$/.test(mimeType)) return null
  try {
    const img = sharp(toBuffer(data), { limitInputPixels: MAX_PIXELS })
    const m = await img.metadata()
    if ((m.pages ?? 1) > 1 || m.depth !== "uchar" || m.hasProfile || (m.orientation ?? 1) !== 1 || (m.space !== "srgb" && m.space !== "b-w")) return null
    const { data: rgba, info } = await img.toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    return info.channels === 4 ? { data: rgba, width: info.width, height: info.height } : null
  } catch {
    return null
  }
}

/**
 * 원본 그림 파일(HWP·HWPX·HWP3·DOCX·PPTX)을 무손실 WebP 로 바꾼다 — 화소를 그대로 풀 수 있고 WebP 가 원본보다 작을 때만.
 * 바꾼 그림은 `images` 의 파일명(`.webp`)·바이트·MIME 과 그 이름을 쓴 그림 블록의 `text`·`imageData` 를 함께 바꾼다.
 * 하나라도 바꿨으면 true
 */
export async function webpSmallerImages(blocks: IRBlock[], images: ExtractedImage[], warnings: ParseWarning[]): Promise<boolean> {
  const sharp = await loadSharp()
  if (!sharp) { warnings.push(WEBP_UNAVAILABLE); return false }
  const encode = encoder(sharp)
  const names = new Set(images.map(i => i.filename))
  const renamed = new Map<string, ExtractedImage>()
  for (const img of images) {
    const name = img.filename.replace(/\.[^./]*$/, "") + ".webp"
    if (names.has(name)) continue
    const px = await decodeLossless(sharp, img.data, img.mimeType)
    const webp = px && await encode(px.data, px.width, px.height).catch(() => null)
    if (!webp || webp.length >= img.data.length) continue
    renamed.set(img.filename, img)
    names.add(name)
    Object.assign(img, { filename: name, data: webp, mimeType: "image/webp" })
  }
  if (!renamed.size) return false
  // 그림 블록 이름, 그리고 표 칸 글·머리말·각주·캡션처럼 글에 박힌 참조("![image](이름)")까지 — hwp5/images.ts 의 sentinel 치환과 같은 범위
  const fix = (s: string): string => s.includes("![image](") ? s.replace(/!\[image\]\(([^()\s]+)\)/g, (m, name: string) => {
    const img = renamed.get(name)
    return img ? `![image](${img.filename})` : m
  }) : s
  const walk = (list: IRBlock[] | undefined, depth: number) => {
    if (!list || depth > 64) return
    for (const b of list) {
      const img = b.type === "image" && b.text ? renamed.get(b.text) : undefined
      if (img) {
        b.text = img.filename
        if (b.imageData) b.imageData = { ...b.imageData, data: img.data, mimeType: img.mimeType }
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
  return true
}

export const WEBP_UNAVAILABLE: ParseWarning = {
  code: "PARTIAL_PARSE",
  message: "WebP 로 내려면 optional dependency 'sharp' 가 필요합니다 — PDF 그림은 PNG, 다른 형식은 원본 그림 그대로 냈습니다. `npm install sharp` 후 다시 실행하세요",
}
