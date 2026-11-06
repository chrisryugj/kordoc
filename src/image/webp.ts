/**
 * RGBA → 무손실 WebP (#188, `imageFormat: "webp"` 일 때만).
 *
 * optional dependency sharp(libwebp)는 켰을 때만 동적 import 로 불러온다. 네이티브라 네트워크 접근이 없다.
 * `exact` 로 완전 투명 화소의 RGB 도 지킨다. effort 1·quality 1 은 압축률보다 인코딩 비용을 줄인 값이다.
 */

import type { ParseWarning } from "../types.js"

/** RGBA → WebP 바이트 */
export type WebpEncoder = (rgba: Uint8Array, width: number, height: number) => Promise<Uint8Array>

type SharpFactory = (input: Buffer, opts: { raw: { width: number; height: number; channels: 4 } }) => {
  webp(opts: { lossless: true; exact: true; effort: number; quality: number }): { toBuffer(): Promise<Buffer> }
}

let loading: Promise<WebpEncoder | null> | undefined

/** sharp 가 없거나 못 열면 null */
export function loadWebpEncoder(): Promise<WebpEncoder | null> {
  return loading ??= (async () => {
    try {
      const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
      const sharp = typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
      return async (rgba, width, height) => {
        const out = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width, height, channels: 4 } })
          .webp({ lossless: true, exact: true, effort: 1, quality: 1 }).toBuffer()
        return new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
      }
    } catch {
      return null
    }
  })()
}

export const WEBP_UNAVAILABLE: ParseWarning = {
  code: "PARTIAL_PARSE",
  message: "WebP 로 내려면 optional dependency 'sharp' 가 필요합니다 — PNG 로 냈습니다. `npm install sharp` 후 다시 실행하세요",
}
