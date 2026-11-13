/**
 * 무손실 WebP (#188, `imageFormat: "webp"` 일 때만).
 *
 * optional dependency sharp(libwebp)는 켰을 때만 동적 import 로 불러온다. 네이티브라 네트워크 접근이 없다.
 * `exact` 로 완전 투명 화소의 RGB 도 지킨다. effort 1·quality 1 은 압축률보다 인코딩 비용을 줄인 값이다.
 * PDF 그림은 kordoc 이 픽셀에서 바로 인코딩한다(pdf/image-extract.ts). 다른 형식의 원본 그림 파일은 image/format.ts.
 */

import type { ParseWarning } from "../types.js"

/** RGBA → WebP 바이트 */
export type WebpEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>

interface SharpImage {
  rotate(): SharpImage
  ensureAlpha(): SharpImage
  raw(): { toBuffer(): Promise<Buffer> }
  png(): { toBuffer(): Promise<Buffer> }
  webp(opts: { lossless: true; exact: true; effort: number; quality: number }): { toBuffer(): Promise<Buffer> }
}
type CacheLimits = { memory: { max: number }; files: { max: number }; items: { max: number } }
export type SharpCache = { cache(opts?: boolean | { memory: number; files: number; items: number }): CacheLimits }
export type SharpFactory = ((input: Buffer, opts?: { raw?: { width: number; height: number; channels: 4 }; limitInputPixels?: number; failOn?: "error" }) => SharpImage) & SharpCache

/** libvips 의 heif 로더(AVIF)는 디코딩한 픽셀을 operation cache 에 남기는데, 이 메모리는 캐시 한도에 포함되지 않는다 — AVIF 12MP
 *  한 장마다 +37MB, 25장쯤에서 +880MB 까지 쌓였다. 캐시를 비운 뒤 호스트가 설정한 캐시 한도를 다시 적용한다 */
export function flushHeifCache(sharp: SharpCache): void {
  const c = sharp.cache()
  sharp.cache(false)
  sharp.cache({ memory: c.memory.max, files: c.files.max, items: c.items.max })
}

let loading: Promise<SharpFactory | null> | undefined

/** sharp 가 없거나 못 열면 null */
export function loadSharp(): Promise<SharpFactory | null> {
  return loading ??= (async () => {
    try {
      const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
      return typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
    } catch {
      return null
    }
  })()
}

export const toBuffer = (b: Uint8Array) => Buffer.from(b.buffer, b.byteOffset, b.byteLength)
export const WEBP_OPTIONS = { lossless: true, exact: true, effort: 1, quality: 1 } as const

function encoder(sharp: SharpFactory): WebpEncoder {
  return async (rgba, width, height) => {
    const out = await sharp(toBuffer(rgba), { raw: { width, height, channels: 4 } })
      .webp(WEBP_OPTIONS).toBuffer()
    return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
  }
}

/** sharp 가 없거나 못 열면 null */
export async function loadWebpEncoder(): Promise<WebpEncoder | null> {
  const sharp = await loadSharp()
  return sharp && encoder(sharp)
}

export const WEBP_UNAVAILABLE: ParseWarning = {
  code: "PARTIAL_PARSE",
  message: "WebP 로 내려면 optional dependency 'sharp' 가 필요합니다 — PDF 그림은 PNG, 다른 형식은 원본 그림 그대로 냈습니다. `npm install sharp` 후 다시 실행하세요",
}
