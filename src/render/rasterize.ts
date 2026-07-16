/** SVG → PNG 래스터 — sharp optional 의존 (미설치 시 KordocError, SVG 경로는 sharp 불필요) */

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

/** SVG 문자열을 PNG로 래스터. widthPt/heightPt는 SVG 캔버스 크기(pt). */
export async function rasterizeSvg(
  svg: string,
  widthPt: number,
  heightPt: number,
  options?: RasterizeOptions,
): Promise<RasterizeResult> {
  let sharp: (input: Buffer, opts: { density: number; limitInputPixels: number }) => { png(): { toBuffer(): Promise<Buffer> } }
  try {
    const mod: any = await import("sharp")
    sharp = mod.default ?? mod
  } catch {
    throw new KordocError(
      'PNG 래스터에는 sharp가 필요합니다 (npm install sharp). sharp 없이 쓰려면 format: "svg" + output_path로 SVG 파일 저장을 사용하세요',
    )
  }
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
