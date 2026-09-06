/**
 * region crop (#75 Task 5) — RenderScene 의 페이지 로컬 bbox 를 래스터 실배율로 픽셀 환산해 잘라낸다.
 * DPI 를 여기서 다시 추정하지 않는다: pixel = pt × rasterize 가 돌려준 scale.
 * 의미 판단(진짜 표인지 조직도인지)은 하지 않는다 — 렌더러가 표라고 아는 개체를 자르는 것뿐.
 */

import { KordocError } from "../utils.js"
import type { PageBBox, RenderObjectType, RenderRegion } from "./scene.js"
import { renderDocumentToScene, type RenderInput, type SceneRenderOptions } from "./document.js"
import { loadSharp, rasterizePageSvg, type RasterFormat } from "./rasterize.js"

export interface ExtractRegionOptions extends Pick<SceneRenderOptions, "pages" | "reflow" | "reflowMode"> {
  /** 기본 전 유형 */
  types?: RenderObjectType[]
  format?: RasterFormat
  /** bbox 둘레 여백(pt) — 페이지 안으로 클램프 */
  paddingPt?: number
  /** 페이지 래스터 최대 폭 px (crop 해상도) */
  maxWidthPx?: number
  quality?: number
  /** region 선별 — sourceId·id 로 특정 개체만 자를 때 (extractTables). types 필터 뒤에 적용 */
  filter?: (region: RenderRegion) => boolean
}

export interface RegionAsset {
  region: RenderRegion
  page: number
  bbox: PageBBox
  mimeType: "image/png" | "image/jpeg"
  data: Buffer
  widthPx: number
  heightPx: number
}

export interface PixelRect { left: number; top: number; width: number; height: number }

/**
 * bbox(pt) → 페이지 픽셀 사각형. 여백 포함 후 페이지 안으로 클램프, 최소 1×1px.
 * 페이지 밖 bbox 는 페이지 가장자리 1px 로 잘려 sharp.extract 에 음수·범위 밖이 절대 가지 않는다.
 */
export function cropRect(bbox: PageBBox, scale: number, pageWidthPx: number, pageHeightPx: number, paddingPt = 0): PixelRect {
  const W = Math.max(1, Math.floor(pageWidthPx)), H = Math.max(1, Math.floor(pageHeightPx))
  const clamp = (v: number, hi: number) => Math.min(Math.max(0, v), hi)
  let left = clamp(Math.floor((bbox.x - paddingPt) * scale), W - 1)
  let top = clamp(Math.floor((bbox.y - paddingPt) * scale), H - 1)
  const right = clamp(Math.ceil((bbox.x + bbox.width + paddingPt) * scale), W)
  const bottom = clamp(Math.ceil((bbox.y + bbox.height + paddingPt) * scale), H)
  const width = Math.max(1, right - left), height = Math.max(1, bottom - top)
  if (left + width > W) left = W - width
  if (top + height > H) top = H - height
  return { left, top, width, height }
}

/** 렌더러가 아는 개체(표·이미지·문단·도형)를 페이지 이미지에서 잘라낸다. 페이지당 래스터 1회 */
export async function extractRenderedRegions(input: RenderInput, options: ExtractRegionOptions = {}): Promise<RegionAsset[]> {
  const { scene, pageSvgs } = await renderDocumentToScene(input, { pages: options.pages, reflow: options.reflow, reflowMode: options.reflowMode })
  const types = options.types ? new Set(options.types) : null
  const format = options.format ?? "png"
  const wanted = scene.regions.filter(r => (!types || types.has(r.type)) && (!options.filter || options.filter(r)))
  const byPage = new Map<number, Array<{ region: RenderRegion; bbox: PageBBox }>>()
  for (const r of wanted) for (const b of r.regions) if (pageSvgs.has(b.page)) (byPage.get(b.page) ?? byPage.set(b.page, []).get(b.page)!).push({ region: r, bbox: b })
  if (byPage.size === 0) return []
  const sharp = await loadSharp()
  const out: RegionAsset[] = []
  for (const [page, items] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const meta = scene.pages.find(p => p.page === page)
    if (!meta) throw new KordocError(`페이지 ${page} 메타 없음`)
    const raster = await rasterizePageSvg(pageSvgs.get(page)!, meta.width, meta.height, { format, maxWidthPx: options.maxWidthPx, quality: options.quality })
    for (const { region, bbox } of items) {
      const rect = cropRect(bbox, raster.scale, raster.widthPx, raster.heightPx, options.paddingPt ?? 0)
      const pipeline = sharp(raster.data).extract(rect)
      const data = format === "jpeg" ? await pipeline.jpeg({ quality: options.quality ?? 85 }).toBuffer() : await pipeline.png().toBuffer()
      out.push({ region, page, bbox, mimeType: raster.mimeType, data, widthPx: rect.width, heightPx: rect.height })
    }
  }
  // 문서(region) 순서 유지 — 페이지 순회로 섞인 것을 region 등장 순으로 되돌린다
  const order = new Map(scene.regions.map((r, i) => [r.id, i]))
  out.sort((a, b) => (order.get(a.region.id)! - order.get(b.region.id)!) || (a.page - b.page))
  return out
}
