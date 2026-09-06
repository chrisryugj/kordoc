/**
 * 통합 문서 렌더 API (#75 Task 3·8) — 입력(경로/버퍼) → 포맷 감지 → 어댑터 → RenderScene + 페이지 SVG
 * → SVG/HTML/PNG/JPEG/PDF 자산. 다운스트림은 RenderScene 만 알면 된다.
 *
 *   hwpx → HWPX 어댑터(svg-render, 조판 캐시 재생·reflow 폴백)
 *   hwp  → HWP5 어댑터(hwp5-scene: 레코드 → 동형 section DOM → 같은 렌더러)
 *   기타 → 미지원
 */

import { readFile } from "node:fs/promises"
import { detectFormat, detectZipFormat } from "../detect.js"
import { KordocError, toArrayBuffer } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { renderHwpxPages } from "./svg-render.js"
import { renderHwp5Pages } from "./hwp5-scene.js"
import type { WrapMode } from "../hwpx/text-metrics.js"
import type { RenderScene, RenderSourceFormat } from "./scene.js"
import { renderSceneToHtml } from "./html.js"
import { rasterizePageSvg } from "./rasterize.js"
import { renderHtmlToPdf } from "./pdf.js"

export type RenderFormat = "svg" | "html" | "png" | "jpeg" | "pdf"

export interface SceneRenderOptions {
  /** 1-based 페이지 선택 — [2,3] 또는 "1-3,7". 미지정이면 전 페이지 */
  pages?: number[] | string
  /** 조판 캐시 없는 HWPX 를 순수 TS 조판으로 렌더 (기본 true — 캐시가 있으면 무시) */
  reflow?: boolean
  /** 암호 HWP5 열기 암호 */
  password?: string
  reflowMode?: WrapMode
  highlights?: string[]
  maxImageBytes?: number
}

export interface SceneRenderResult {
  scene: RenderScene
  /** 선택된 페이지의 standalone SVG (페이지 로컬 좌표) */
  pageSvgs: Map<number, string>
}

export interface RenderDocumentOptions extends SceneRenderOptions {
  format: RenderFormat
  /** 래스터 출력 최대 폭 px */
  maxWidthPx?: number
  /** JPEG 품질 */
  quality?: number
  /** PDF 용 Chromium 실행 파일 */
  browserExecutablePath?: string
  /** HTML/PDF 문서 제목 */
  title?: string
}

export interface RenderAsset {
  format: RenderFormat
  /** 페이지 단위 산출은 page, 문서 단위(HTML/PDF)는 없음 */
  page?: number
  data: string | Buffer
  /** 픽셀(래스터) 또는 pt(SVG) */
  width?: number
  height?: number
  /** 래스터 pt→px 실배율 */
  scale?: number
  mimeType?: string
}

export interface RenderDocumentResult {
  scene: RenderScene
  assets: RenderAsset[]
}

export type RenderInput = string | ArrayBuffer | Buffer | Uint8Array

async function loadBuffer(input: RenderInput): Promise<ArrayBuffer> {
  if (typeof input === "string") {
    try {
      return toArrayBuffer(await readFile(input))
    } catch (err) {
      const code = err instanceof Error && "code" in err ? (err as NodeJS.ErrnoException).code : undefined
      throw new KordocError(code === "ENOENT" ? `파일을 찾을 수 없습니다: ${input}` : `파일 읽기 실패: ${input}`)
    }
  }
  if (Buffer.isBuffer(input)) return toArrayBuffer(input)
  if (input instanceof Uint8Array) return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
  return input
}

/** 입력 포맷 → 렌더 어댑터 종류 (hwpx | hwp). OLE2 는 HWP5 로 본다 — 세부 판정(HWP3·암호)은 어댑터가 */
async function sourceFormatOf(buffer: ArrayBuffer): Promise<RenderSourceFormat> {
  const format = detectFormat(buffer)
  if (format === "hwpx") {
    const zip = await detectZipFormat(buffer)
    if (zip === "hwpx" || zip === "unknown") return "hwpx"
    throw new KordocError(`렌더 미지원 형식(${zip}) — 레이아웃 렌더는 HWPX·HWP 만 지원합니다`)
  }
  if (format === "hwp") return "hwp"
  throw new KordocError(`렌더 미지원 형식(${format}) — 레이아웃 렌더는 HWPX·HWP 만 지원합니다`)
}

/**
 * 문서 → RenderScene + 선택 페이지 SVG. 페이지 선택은 조립 단계에서 걸러 비선택 페이지의 SVG 문자열을 만들지 않는다.
 * 선택 결과가 비면(범위 밖) KordocError.
 */
export async function renderDocumentToScene(input: RenderInput, options: SceneRenderOptions = {}): Promise<SceneRenderResult> {
  const buffer = await loadBuffer(input)
  const source = await sourceFormatOf(buffer)
  const select = options.pages !== undefined
    ? (pageCount: number) => {
      const set = parsePageRange(options.pages!, pageCount)
      if (set.size === 0) throw new KordocError(`선택한 페이지가 없습니다 — 문서는 ${pageCount}쪽 (pages: ${JSON.stringify(options.pages)})`)
      return set
    }
    : undefined
  const renderOptions = { reflow: options.reflow ?? true, reflowMode: options.reflowMode, highlights: options.highlights, maxImageBytes: options.maxImageBytes }
  const { scene, pageSvgs } = source === "hwp"
    ? renderHwp5Pages(buffer, { ...renderOptions, password: options.password }, select)
    : await renderHwpxPages(buffer, renderOptions, select)
  return { scene, pageSvgs }
}

/** 통합 렌더 — 포맷별 자산. 래스터·PDF 는 선택 페이지만 처리한다 */
export async function renderDocument(input: RenderInput, options: RenderDocumentOptions): Promise<RenderDocumentResult> {
  const { scene, pageSvgs } = await renderDocumentToScene(input, options)
  const pageNos = [...pageSvgs.keys()].sort((a, b) => a - b)
  const sizeOf = (n: number) => scene.pages.find(p => p.page === n)!
  const assets: RenderAsset[] = []
  switch (options.format) {
    case "svg":
      for (const n of pageNos) { const p = sizeOf(n); assets.push({ format: "svg", page: n, data: pageSvgs.get(n)!, width: p.width, height: p.height, mimeType: "image/svg+xml" }) }
      break
    case "html":
      assets.push({ format: "html", data: renderSceneToHtml(scene, pageSvgs, { title: options.title }), mimeType: "text/html" })
      break
    case "png":
    case "jpeg":
      for (const n of pageNos) {
        const p = sizeOf(n)
        const r = await rasterizePageSvg(pageSvgs.get(n)!, p.width, p.height, { format: options.format, maxWidthPx: options.maxWidthPx, quality: options.quality })
        assets.push({ format: options.format, page: n, data: r.data, width: r.widthPx, height: r.heightPx, scale: r.scale, mimeType: r.mimeType })
      }
      break
    case "pdf": {
      const html = renderSceneToHtml(scene, pageSvgs, { title: options.title })
      assets.push({ format: "pdf", data: await renderHtmlToPdf(html, { browserExecutablePath: options.browserExecutablePath }), mimeType: "application/pdf" })
      break
    }
    default:
      throw new KordocError(`알 수 없는 렌더 포맷: ${String(options.format)} (svg|html|png|jpeg|pdf)`)
  }
  return { scene, assets }
}
