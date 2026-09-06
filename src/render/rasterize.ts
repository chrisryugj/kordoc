/** SVG → PNG/JPEG 래스터 — sharp optional 의존 (미설치 시 KordocError, SVG 경로는 sharp 불필요) */

import { KordocError } from "../utils.js"

export interface RasterizeOptions {
  /** 출력 최대 폭 px (기본 1400) */
  maxWidthPx?: number
  /** 출력 최대 높이 px (기본 8000 — 멀티페이지 세로 스택 대비) */
  maxHeightPx?: number
  /** PNG 바이트 상한 (기본 4MB) — 초과 시 절반 스케일로 1회 재시도 */
  maxBytes?: number
}

export interface RasterizeResult {
  png: Buffer
  widthPx: number
  heightPx: number
  /** pt → px 배율 */
  scale: number
}

/** sharp 최소 타입 — optional 의존이라 정적 import 없이 동적 로드 */
export type SharpLike = (input: Buffer, opts?: { density?: number; limitInputPixels?: number }) => {
  png(): { toBuffer(): Promise<Buffer> }
  jpeg(opts?: { quality?: number }): { toBuffer(): Promise<Buffer> }
  extract(region: { left: number; top: number; width: number; height: number }): ReturnType<SharpLike>
  toBuffer(): Promise<Buffer>
}

export async function loadSharp(): Promise<SharpLike> {
  try {
    const mod: any = await import("sharp")
    return mod.default ?? mod
  } catch {
    throw new KordocError(
      'PNG 래스터에는 sharp가 필요합니다 (npm install sharp). sharp 없이 쓰려면 format: "svg" + output_path로 SVG 파일 저장을 사용하세요',
    )
  }
}

/** SVG 문자열을 PNG로 래스터. widthPt/heightPt는 SVG 캔버스 크기(pt). */
export async function rasterizeSvg(
  svg: string,
  widthPt: number,
  heightPt: number,
  options?: RasterizeOptions,
): Promise<RasterizeResult> {
  const sharp = await loadSharp()
  if (!(widthPt > 0) || !(heightPt > 0)) throw new KordocError(`잘못된 SVG 크기: ${widthPt}x${heightPt}pt`)
  const maxW = options?.maxWidthPx ?? 1400
  const maxH = options?.maxHeightPx ?? 8000
  const maxBytes = options?.maxBytes ?? 4 * 1024 * 1024

  const render = async (scale: number): Promise<RasterizeResult> => {
    // sharp의 SVG 기본 밀도 72DPI 기준 — density를 올리면 pt×scale 픽셀로 래스터된다
    const png = await sharp(Buffer.from(svg), { density: 72 * scale, limitInputPixels: 268402689 })
      .png()
      .toBuffer()
    return { png, widthPx: Math.round(widthPt * scale), heightPx: Math.round(heightPt * scale), scale }
  }

  const scale = Math.min(maxW / widthPt, maxH / heightPt, 2)
  let result = await render(scale)
  if (result.png.length > maxBytes && scale > 0.25) {
    result = await render(scale / 2)
  }
  if (result.png.length > maxBytes) {
    throw new KordocError(
      `PNG가 상한(${(maxBytes / 1024 / 1024).toFixed(0)}MB)을 초과합니다 (${(result.png.length / 1024 / 1024).toFixed(1)}MB) — format: "svg" + output_path로 파일 저장을 사용하세요`,
    )
  }
  return result
}

// ─── 페이지 단위 래스터 (#75 Task 5) ────────────────────

export type RasterFormat = "png" | "jpeg"

export interface PageRasterOptions {
  format?: RasterFormat
  /** 출력 최대 폭 px (기본 1400) */
  maxWidthPx?: number
  /** 출력 최대 높이 px (기본 4000 — 페이지 1장) */
  maxHeightPx?: number
  /** JPEG 품질 (기본 85) */
  quality?: number
}

export interface PageRasterResult {
  data: Buffer
  mimeType: "image/png" | "image/jpeg"
  widthPx: number
  heightPx: number
  /** pt → px 실배율 — crop 픽셀 좌표는 이 값으로만 환산한다 (DPI 재추정 금지) */
  scale: number
}

/**
 * 페이지 standalone SVG 1장 → PNG/JPEG. 두 포맷은 같은 SVG·같은 배율을 쓴다.
 * 픽셀 크기 = round(pt × scale) — sharp 가 density 로 만드는 실제 픽셀과 일치.
 */
export async function rasterizePageSvg(svg: string, widthPt: number, heightPt: number, options: PageRasterOptions = {}): Promise<PageRasterResult> {
  const sharp = await loadSharp()
  if (!(widthPt > 0) || !(heightPt > 0)) throw new KordocError(`잘못된 페이지 크기: ${widthPt}x${heightPt}pt`)
  const maxW = options.maxWidthPx ?? 1400
  const maxH = options.maxHeightPx ?? 4000
  const scale = Math.min(maxW / widthPt, maxH / heightPt, 2)
  const format = options.format ?? "png"
  const pipeline = sharp(Buffer.from(svg), { density: 72 * scale, limitInputPixels: 268402689 })
  const data = format === "jpeg" ? await pipeline.jpeg({ quality: options.quality ?? 85 }).toBuffer() : await pipeline.png().toBuffer()
  return { data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png", widthPx: Math.round(widthPt * scale), heightPx: Math.round(heightPt * scale), scale }
}
