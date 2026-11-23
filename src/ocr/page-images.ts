/**
 * 페이지 래스터 내보내기(`pageImages`) — OCR 경로가 읽은 페이지를 PNG·무손실 WebP 로 모은다.
 * 상한은 둘: 인코딩한 바이트 합계와 래스터 픽셀 합계(잘 눌리는 빈 페이지 수천 장이 바이트 상한 아래에서 끝없이 렌더링되지 않게
 * 렌더링·인코딩 전에 잡는다). 어느 쪽이든 닿은 뒤의 페이지는 담지 않고 경고한다.
 */

import type { PageImage, ParseOptions, ParseWarning } from "../types.js"
import { encodePng } from "../image/transcode.js"
import { loadWebpEncoder, type WebpEncoder } from "../image/webp.js"
import { KordocError } from "../utils.js"
import { validateOcrOptions } from "./options.js"

/** 인코딩한 바이트 합계 상한 — 이미지 입력의 페이지 이미지(index.ts MAX_PAGE_IMAGE_BYTES)와 같은 128MB */
const MAX_BYTES = 128 * 1024 * 1024
/** 래스터 픽셀 합계 상한 — 멀티페이지 이미지 디코딩(index.ts MAX_MULTIPAGE_PIXELS)과 같은 10억. 페이지마다 최소 100만으로 세서 1,000페이지 이하 */
const MAX_PIXELS = 1_000_000_000
const MIN_PAGE_PIXELS = 1_000_000
/** WebP 한 변 한도 (pdf/image-extract.ts WEBP_MAX_DIM 과 같다) */
const WEBP_MAX_DIM = 16_383

/** OCR 이 읽은(또는 OCR 없이 디코딩·렌더링한) 페이지 래스터 (RGBA) */
export interface PageRaster { data: Uint8Array; width: number; height: number }

export class PageImageSink {
  private readonly images: PageImage[] = []
  /** 다룬 페이지 — 담은 것과 상한으로 뺀 것 (뺀 페이지를 다시 렌더링하려다 두 번 세지 않게) */
  private readonly seen = new Set<number>()
  private bytes = 0
  private pixels = 0
  private skipped = 0
  /** WebP 를 청했는데 PNG 로 낸 페이지 수 */
  private asPng = 0
  private webp: WebpEncoder | null | undefined

  /** format 은 `pageImages` 옵션 값(켜진 것) — 모르는 값은 throw (parse() 는 먼저 걸러 실패 결과로 낸다) */
  constructor(private readonly format: ParseOptions["pageImages"], private readonly maxBytes = MAX_BYTES, private readonly maxPixels = MAX_PIXELS) {
    const bad = validateOcrOptions({ pageImages: format })
    if (bad) throw new KordocError(bad)
  }

  /** 이미 다룬 페이지인가 (담았거나 상한으로 뺐다) */
  has(pageNumber: number): boolean {
    return this.seen.has(pageNumber)
  }

  /** 상한에 닿았다 — 이 뒤로는 디코딩·렌더링하지 않고 skip 으로 세기만 한다 */
  get full(): boolean {
    return this.bytes > this.maxBytes || this.pixels > this.maxPixels
  }

  skip(pageNumber: number): void {
    this.seen.add(pageNumber)
    this.skipped++
  }

  /** 페이지 하나의 래스터 픽셀을 예산에서 잡는다 — 렌더링·인코딩 전에 부른다. 상한을 넘었으면 false (뺀 페이지로 센다) */
  reserve(pixels: number): boolean {
    if (this.bytes <= this.maxBytes && (this.pixels += Math.max(MIN_PAGE_PIXELS, pixels)) <= this.maxPixels) return true
    this.skipped++
    return false
  }

  /** 래스터 → 페이지 이미지 (담지는 않는다) */
  async encode(pageNumber: number, { data, width, height }: PageRaster): Promise<PageImage> {
    let webp: Uint8Array | undefined
    if (this.format === "webp") {
      if (this.webp === undefined) this.webp = await loadWebpEncoder()
      if (this.webp && width <= WEBP_MAX_DIM && height <= WEBP_MAX_DIM) webp = await this.webp(data, width, height).catch(() => undefined)
    }
    const ext = webp ? "webp" : "png"
    return { pageNumber, filename: `page_${String(pageNumber).padStart(3, "0")}.${ext}`, width, height, mimeType: `image/${ext}`, data: webp ?? encodePng(width, height, data) }
  }

  /** 인코딩한 페이지 이미지를 담는다 — 바이트 상한을 넘긴 페이지부터는 담지 않는다 (이미지 입력의 페이지 이미지와 같은 규칙) */
  push(image: PageImage): void {
    this.seen.add(image.pageNumber)
    if ((this.bytes += image.data.length) > this.maxBytes) { this.skipped++; return }
    if (this.format === "webp" && image.mimeType !== "image/webp") this.asPng++
    this.images.push(image)
  }

  /** 이미 있는 래스터(OCR 이 읽은 것·디코딩한 이미지)를 예산을 잡고 인코딩해 담는다 */
  async add(pageNumber: number, raster: PageRaster): Promise<void> {
    this.seen.add(pageNumber)
    if (this.reserve(raster.width * raster.height)) this.push(await this.encode(pageNumber, raster))
  }

  /** 쪽 번호 순 목록. 뺀 페이지·PNG 로 바꿔 낸 페이지는 경고로 알린다 */
  finish(warnings: ParseWarning[]): PageImage[] {
    if (this.skipped) warnings.push({ message: `pageImages ${this.skipped}페이지 생략 — 상한(누적 ${Math.round(this.maxBytes / 1048576)}MB·래스터 픽셀 합계 ${this.maxPixels / 100_000_000}억) 도달. pages 로 나눠서 읽으세요`, code: "SKIPPED_IMAGE" })
    if (this.asPng && !this.webp) warnings.push({ message: "pageImages 를 WebP 로 내려면 optional dependency 'sharp' 가 필요합니다 — PNG 로 냈습니다. `npm install sharp` 후 다시 실행하세요", code: "PARTIAL_PARSE" })
    else if (this.asPng) warnings.push({ message: `pageImages ${this.asPng}페이지는 WebP 로 내지 못해 PNG 로 냈습니다 (가로·세로 16,383px 한도 초과 또는 인코딩 실패)`, code: "SKIPPED_IMAGE" })
    return this.images.sort((a, b) => a.pageNumber - b.pageNumber)
  }
}
