/**
 * 원본 그림 파일(HWP·HWPX·HWP3·DOCX·PPTX·이미지 파일)을 LLM 이 읽는 형식으로 정규화한다 (#188).
 *
 * `imageFormat` 을 명시하면 모든 그림이 그 형식이다 — 뒤 단계가 파일명·MIME 을 믿고 돌기 때문이다. 명시하지 않으면
 * 주요 LLM API(Claude·OpenAI·Gemini)가 공통으로 받는 PNG·JPEG·WebP 는 그대로 두고, 나머지(BMP·GIF·TIFF·AVIF·HEIC·PCX·SVG, 비트맵 하나만 그리는 WMF)만 PNG 로 변환한다.
 * PNG 는 PNG, WebP 는 무손실 WebP. 보이는 그림을 맞춘다: EXIF 회전을 적용하고, ICC 프로필·CMYK 는 sRGB 로,
 * 움직이는 GIF 는 첫 장, SVG 는 그린 그림이다. 바꿀 수 없는 그림(WMF·EMF, kordoc·sharp 가 못 읽는 BMP 변형, 손상)은
 * 원본 그대로 두고 경고한다. 이미 그 형식인 그림은 바이트를 그대로 두고 이름·MIME 만 맞춘다.
 */

import { imageFormat } from "../detect.js"
import { hasLibheif, heicToRgba } from "./heic.js"
import { dcxPages, pcxToRgba } from "./pcx.js"
import { bmpToRgba, encodePng, MAX_PIXELS } from "./transcode.js"
import { flushHeifCache, loadSharp, toBuffer, WEBP_OPTIONS, type SharpFactory } from "./webp.js"
import { wmfBitmap } from "./wmf.js"
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

/** 그 형식 바이트 — 못 바꾸면 null. sharp 는 필요할 때만 읽는다(PNG·JPEG·WebP 만 든 문서는 sharp 를 띄우지 않는다) */
async function convert(sharp: () => Promise<SharpFactory | null>, img: ExtractedImage, format: ImageFormat): Promise<Uint8Array | null> {
  if (isFormat(img.data, format)) return img.data
  const kind = imageFormat(img.data.slice(0, 128).buffer)
  // sharp 가 못 읽는 BMP·PCX·DCX·HEIC·WMF 내 비트맵은 kordoc 디코더·libheif-js 로 RGBA 디코딩
  const wmf = kind ? null : wmfBitmap(img.data)
  if (wmf || kind === "bmp" || kind === "heic" || kind === "pcx" || kind === "dcx") {
    const px = kind === "heic" ? await heicToRgba(img.data, MAX_PIXELS).catch(() => null)
      : kind === "pcx" ? pcxToRgba(img.data) : kind === "dcx" ? pcxToRgba(dcxPages(img.data)[0] ?? new Uint8Array(0)) : bmpToRgba(wmf ?? img.data)
    if (!px) return null
    if (format === "png") return encodePng(px.width, px.height, px.data)
    const s = await sharp()
    if (!s) return null
    return plain(await s(toBuffer(px.data), { raw: { width: px.width, height: px.height, channels: 4 } }).webp(WEBP_OPTIONS).toBuffer().catch(() => null))
  }
  const s = await sharp()
  if (!s) return null
  // 경고는 무시한다 — 한글이 저장한 TIFF 는 ImageDescription 이 null 로 끝나지 않아 libtiff 경고가 뜨고, sharp 기본값(failOn "warning")은 이를 실패로 처리한다
  const out = s(toBuffer(img.data), { limitInputPixels: MAX_PIXELS, failOn: "error" }).rotate()
  const data = plain(await (format === "png" ? out.png() : out.webp(WEBP_OPTIONS)).toBuffer().catch(() => null))
  if (kind === "avif") flushHeifCache(s)
  return data
}

/** 주요 LLM API 가 모두 받는 형식(PNG·JPEG·WebP)인가 */
const llmReadable = (b: Uint8Array) => isFormat(b, "png") || isFormat(b, "webp") || (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)

/**
 * `images` 를 모두 `format` 으로 바꾼다. `format` 이 없으면 PNG·JPEG·WebP 가 아닌 그림만 PNG 로. 바꾼 그림은 파일명(`.png`·`.webp`)·바이트·MIME 과 그 이름을 쓴 그림 블록의
 * `text`·`imageData`, 글에 박힌 참조(표 칸 글·머리말·각주·캡션의 "![image](이름)")를 함께 바꾼다. 이름을 바꿨으면 true
 */
export async function convertImages(blocks: IRBlock[], images: ExtractedImage[], format: ImageFormat | undefined, warnings: ParseWarning[]): Promise<boolean> {
  const sharp = loadSharp
  const names = new Set(images.map(i => i.filename))
  const renamed = new Map<string, ExtractedImage>()
  const kept: ExtractedImage[] = []
  for (const img of images) {
    const target = format ?? (llmReadable(img.data) ? null : "png")
    if (!target) continue
    const name = img.filename.replace(/\.[^./]*$/, "") + "." + target
    const data = await convert(sharp, img, target)
    if (!data || (name !== img.filename && names.has(name))) { kept.push(img); continue }
    if (name !== img.filename) { renamed.set(img.filename, img); names.add(name) }
    Object.assign(img, { filename: name, data, mimeType: MIME[target] })
  }
  if (kept.length) {
    const mimes = kept.map(i => i.mimeType)
    const byMime = [...new Set(mimes)].map(m => `${m} ${mimes.filter(k => k === m).length}`).join(", ")
    const heic = kept.some(i => imageFormat(i.data.slice(0, 128).buffer) === "heic") && !(await hasLibheif())
    const why = !(await sharp()) ? " — optional dependency 'sharp' 가 없습니다" : heic ? " — HEIC 는 optional dependency 'libheif-js' 가 필요합니다" : ""
    warnings.push({ code: "SKIPPED_IMAGE", message: `그림 ${kept.length}개는 ${(format ?? "png").toUpperCase()} 로 바꾸지 못해 원본 형식으로 냈습니다 (${byMime})${why}` })
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
