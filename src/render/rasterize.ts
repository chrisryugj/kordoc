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
  metadata(): Promise<{ width?: number; height?: number }>
}

/**
 * pt 단위 SVG 의 density 배율 지수 — libvips/rsvg 조합에 따라 `density: 72×s` 가 s px/pt(선형)를 내기도,
 * s² px/pt 를 내기도 한다(sharp 0.35·vips 8.18·rsvg 2.62: pt 단위는 제곱, px 단위는 선형 — 실측 2026-09-06).
 * 배율을 가정하면 crop 픽셀 사각형이 실제 래스터와 어긋나 표 영역의 좌상단 1/4 만 잘려 나온다(v4.13.0 실사고).
 * 프로세스당 1회 프로브로 지수를 재고, 산출 픽셀 크기는 항상 실제 이미지에서 다시 읽는다.
 */
let densityExponent: number | null = null
const PROBE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100pt" height="100pt"><rect width="100" height="100" fill="#fff"/></svg>`

/** PNG IHDR 폭 (바이트 16~19, BE) — 프로브는 metadata 없이 읽는다 */
function pngWidth(buf: Buffer): number {
  return buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 ? buf.readUInt32BE(16) : 0
}

async function probeDensityExponent(sharp: SharpLike): Promise<number> {
  if (densityExponent !== null) return densityExponent
  try {
    const png = await sharp(Buffer.from(PROBE_SVG), { density: 144 }).png().toBuffer()
    const k = pngWidth(png) / 100
    const e = k > 0 ? Math.log(k) / Math.log(2) : 1
    densityExponent = Number.isFinite(e) && e > 0.5 ? Math.round(e * 4) / 4 : 1
  } catch {
    densityExponent = 1
  }
  return densityExponent
}

/** 요청 배율(px/pt) → sharp density */
function densityFor(scale: number, exponent: number): number {
  return 72 * Math.pow(scale, 1 / exponent)
}

/** 실제 픽셀 크기 — 보고값은 가정이 아니라 산출 이미지에서 읽는다 */
async function actualSize(sharp: SharpLike, data: Buffer, fallbackW: number, fallbackH: number): Promise<{ w: number; h: number }> {
  const w = pngWidth(data)
  if (w > 0 && data.length >= 24) return { w, h: data.readUInt32BE(20) }
  try {
    const m = await sharp(data).metadata()
    if (m.width && m.height) return { w: m.width, h: m.height }
  } catch { /* 폴백 */ }
  return { w: fallbackW, h: fallbackH }
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

  const exponent = await probeDensityExponent(sharp)
  const render = async (scale: number): Promise<RasterizeResult> => {
    // sharp 의 SVG 기본 밀도 72DPI 기준. 배율 지수는 프로브 값, 픽셀 크기·실배율은 산출물에서 읽는다
    const png = await sharp(Buffer.from(svg), { density: densityFor(scale, exponent), limitInputPixels: 268402689 })
      .png()
      .toBuffer()
    const { w, h } = await actualSize(sharp, png, Math.round(widthPt * scale), Math.round(heightPt * scale))
    return { png, widthPx: w, heightPx: h, scale: w / widthPt }
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
 * 픽셀 크기·scale 은 산출 이미지에서 읽은 실제값(crop 은 이 scale 로만 환산).
 */
export async function rasterizePageSvg(svg: string, widthPt: number, heightPt: number, options: PageRasterOptions = {}): Promise<PageRasterResult> {
  const sharp = await loadSharp()
  if (!(widthPt > 0) || !(heightPt > 0)) throw new KordocError(`잘못된 페이지 크기: ${widthPt}x${heightPt}pt`)
  const maxW = options.maxWidthPx ?? 1400
  const maxH = options.maxHeightPx ?? 4000
  const scale = Math.min(maxW / widthPt, maxH / heightPt, 2)
  const format = options.format ?? "png"
  const exponent = await probeDensityExponent(sharp)
  const pipeline = sharp(Buffer.from(svg), { density: densityFor(scale, exponent), limitInputPixels: 268402689 })
  const data = format === "jpeg" ? await pipeline.jpeg({ quality: options.quality ?? 85 }).toBuffer() : await pipeline.png().toBuffer()
  const { w, h } = await actualSize(sharp, data, Math.round(widthPt * scale), Math.round(heightPt * scale))
  return { data, mimeType: format === "jpeg" ? "image/jpeg" : "image/png", widthPx: w, heightPx: h, scale: w / widthPt }
}
