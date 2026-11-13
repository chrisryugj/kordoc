/**
 * 이미지 직접 입력 OCR — PNG·JPEG·WebP·TIFF·GIF·AVIF·HEIC·BMP·PCX·DCX 를 PDF 래핑 없이 바로 파싱한다. 멀티페이지 TIFF·DCX 는 페이지마다.
 *
 * 이미지는 텍스트층이 없으므로 OCR 이 항상 필요하다 — `--ocr` 플래그 없이도
 * 내장 엔진(PP-OCRv5 korean)을 기본 적용하고, OcrProvider 가 주어지면 위임한다.
 * 좌표는 이미지 해상도(imageScale — 메타데이터 DPI, 없으면 A4·Letter 판형 추정, 그것도
 * 아니면 216dpi)로 PDF pt 공간에 환산해 기존 블록 파이프라인
 * (괘선 감지 → 선 기반 표 → 클러스터 → xy-cut)을 그대로 태운다.
 *
 * 디코딩은 optional dependency `sharp` — 미설치면 MISSING_DEPENDENCY 안내. sharp 가 못 읽는 BMP·PCX·DCX 는 kordoc 디코더(image/transcode·image/pcx),
 * HEIC 는 optional dependency `libheif-js`(image/heic)로 RGBA 로 디코딩해 sharp 에 넘긴다.
 */

import { rescueEmptyCells } from "./empty-cell-rescue.js"
import type { ExtractedImage, IRBlock, OcrPageLines, ParseOptions, ParseWarning } from "../types.js"
import { KordocError, OPTIONAL_DEP_INSTALL_HINT } from "../utils.js"
import { getOcrEngine, type OcrPageStats } from "./engine.js"
import { ensureOcrModelsFor } from "./models.js"
import { applyImageFormulas } from "./image-formula.js"
import { detectRulingLines, rulingToPdfLines } from "./ruling-lines.js"
import { MAX_OCR_PIXELS, builtinOcrConfig, cellEdgeHorizontals, cellEdgeVerticals, ocrItemsToBlocks, pageLines, recognizeOcrPage, reportModelDownload } from "./pdf-ocr.js"
import { deskewPage, rotateQuarter } from "./deskew.js"
import { imageFormat, type ImageKind } from "../detect.js"
import { MAX_PIXELS, bmpToRgba, encodePng } from "../image/transcode.js"
import { heicToRgba } from "../image/heic.js"
import { dcxPages, pcxToRgba } from "../image/pcx.js"
import { flushHeifCache, type SharpCache } from "../image/webp.js"

/** 좌표 환산 기본 스케일 (px/pt) — PDF OCR 렌더(216dpi)와 동일 기준 */
const IMAGE_SCALE = 3

/**
 * 이미지 px/pt 스케일 추정. 블록 파이프라인의 문턱(줄 묶음 3pt·괘선 최소 길이 20pt·표 간격)은
 * pt 기준이라, 150dpi 스캔을 216dpi 로 가정하면 페이지가 0.69배로 쪼그라든 좌표가 된다.
 *  1) 메타데이터 DPI(JFIF·pHYs·EXIF) 100~1200 — 72/96 은 기본값·화면값이라 불신
 *  2) 판형: 긴 변/짧은 변이 √2(A판)·11/8.5(Letter) ±2% 면 전면 스캔 — A4 842pt·Letter 792pt 긴 변
 *  3) 그 밖: 216dpi 가정 (종전 동작)
 */
export function imageScale(width: number, height: number, densityDpi?: number): number {
  if (densityDpi && densityDpi >= 100 && densityDpi <= 1200) return densityDpi / 72
  const long = Math.max(width, height), short = Math.min(width, height)
  if (short > 0) {
    const r = long / short
    if (Math.abs(r / Math.SQRT2 - 1) <= 0.02) return long / 842
    if (Math.abs(r / (11 / 8.5) - 1) <= 0.02) return long / 792
  }
  return IMAGE_SCALE
}

export interface ImageOcrResult {
  blocks: IRBlock[]
  warnings: ParseWarning[]
  /** ocrLines 옵션일 때 해당 페이지의 OCR 줄 */
  lines?: OcrPageLines
}

/** 이미지 버퍼 → OCR → IRBlock[] (표 괘선 감지 포함). page 는 1부터 — 멀티페이지 TIFF 만 2 이상 */
export async function parseImageDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
  page = 1,
): Promise<ImageOcrResult> {
  const warnings: ParseWarning[] = []

  // 사용자 OcrProvider — PNG·JPEG·WebP 는 원본 바이트 그대로, 그 밖은 해당 페이지를 PNG 로 변환해 위임 (종전 PDF 경로와 같은 계약)
  if (typeof options?.ocr === "function") {
    const kind = imageFormat(buffer)
    let bytes: Uint8Array = new Uint8Array(buffer), mime = detectImageMime(buffer)
    if (kind !== "png" && kind !== "jpeg" && kind !== "webp") {
      const px = await decodeToRgba(buffer, page - 1)
      bytes = encodePng(px.width, px.height, px.data)
      mime = "image/png"
    }
    const text = await options.ocr(bytes, page, mime)
    if (!text.trim()) {
      warnings.push({ page, message: "OCR 결과 없음", code: "OCR_FAILED" })
      return { blocks: [], warnings }
    }
    return { blocks: [{ type: "paragraph", text: text.trim(), pageNumber: page }], warnings }
  }

  const { data: decoded, width: decodedW, height: decodedH, density, shrink } = await decodeToRgba(buffer, page - 1)
  let width = decodedW, height = decodedH
  if (shrink < 1) warnings.push({ page, code: "PARTIAL_PARSE", message: "OCR 래스터 픽셀 상한으로 이미지 해상도를 축소했습니다 (작은 글자 인식 결손 가능)" })
  // 픽셀 상한으로 줄인 이미지는 같은 지면을 낮은 해상도로 본 것 — px/pt 도 같은 비율로
  const scale = imageScale(width / shrink, height / shrink, density) * shrink
  // 스캔·사진 기울기 보정 — 인식과 괘선 감지가 같은(바로 선) 래스터를 본다
  const deskewed = deskewPage(decoded, width, height)
  let data = deskewed.rgba
  const angle = deskewed.angle

  const config = builtinOcrConfig(options)
  await ensureOcrModelsFor(config.models, reportModelDownload)
  if (config.handwriting && !config.autoRec?.lazy) await ensureOcrModelsFor(config.handwriting, reportModelDownload)
  const engine = await getOcrEngine(config.models)
  const stats: OcrPageStats = { droppedLowConf: 0, ...(config.lines === "all" ? { dropped: [] } : {}) }
  // 괘선을 먼저 찾아 검출 상자를 표 칸·행 경계에서 가른다 — PDF OCR(ocrOnePage)과 같은 순서. 인식 뒤에 찾으면 이웃 칸 글이 한 상자로
  // 묶여 인식됐다(통계 보도자료 표 "2023 2024p ’23년대비" → "20232024p’23")
  let ruling = detectRulingLines(data, width, height, scale)
  let items = await recognizeOcrPage(engine, config, config.tuning, data, width, height, stats,
    [...(ruling.cellDividers ?? []), ...cellEdgeVerticals(ruling)], cellEdgeHorizontals(ruling))
  // 가로 표를 눕혀 찍은 쪽 — 래스터를 세워 괘선부터 다시 읽는다(좌표·블록 상자는 세운 쪽 기준)
  if (stats.pageRotation) {
    ({ rgba: data, width, height } = rotateQuarter(data, width, height, stats.pageRotation))
    delete stats.pageRotation
    ruling = detectRulingLines(data, width, height, scale)
    items = await recognizeOcrPage(engine, config, { ...config.tuning, orientPage: false }, data, width, height, stats,
      [...(ruling.cellDividers ?? []), ...cellEdgeVerticals(ruling)], cellEdgeHorizontals(ruling))
  }
  // 쪽 검출이 놓친 빈 칸 글 — 괘선 칸만 잘라 다시 읽는다(empty-cell-rescue)
  if (config.tuning.postprocess) items = [...items, ...await rescueEmptyCells(engine, config.tuning, data, width, height, ruling, items)]
  // 수식 OCR(선택) — 수식 자리 글상자를 $LaTeX$ 로 (image-formula)
  if (options?.formulaOcr) items = await applyImageFormulas(items, data, width, height, warnings)
  const lines = config.lines ? pageLines(page, width, height, scale, angle, items, stats.dropped) : undefined
  if (stats.droppedLowConf > 0) {
    warnings.push({
      page,
      message: `저신뢰 OCR 라인 ${stats.droppedLowConf}개 폐기 (인식 결손 가능)`,
      code: "OCR_LOW_CONF",
    })
  }
  if (stats.truncatedBoxes) {
    warnings.push({ page, message: `OCR 검출 상자가 너무 많아 ${stats.truncatedBoxes}개는 인식하지 않음 (일부 글 결손)`, code: "PARTIAL_PARSE" })
  }
  if (items.length === 0) {
    warnings.push({ page, message: "이미지에서 텍스트를 인식하지 못했습니다", code: "OCR_FAILED" })
    return { blocks: [], warnings, lines }
  }

  const pdfW = width / scale
  const pdfH = height / scale
  const extraLines = rulingToPdfLines(ruling, scale, pdfH)
  return { blocks: ocrItemsToBlocks(items, page, pdfW, pdfH, scale, extraLines, options?.tables !== false), warnings, lines }
}

type MetaInfo = { density?: number; width?: number; height?: number; orientation?: number; pages?: number }
type Chain = {
  rotate(): Chain
  png(): { toBuffer(): Promise<Buffer> }
  resize(w: number, h: number, opts: { fit: "fill" }): Chain
  ensureAlpha(): { raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } }
  metadata(): Promise<MetaInfo>
}
type SharpFactory = ((input: Buffer, opts?: { page?: number; raw?: { width: number; height: number; channels: 4 }; failOn?: "error"; limitInputPixels?: number | false }) => Chain) & SharpCache

/** sharp — 미설치는 MISSING_DEPENDENCY 로 분류되도록 안내 메시지 throw */
async function loadSharp(): Promise<SharpFactory> {
  try {
    const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
    return typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
  } catch (e) {
    // KordocError + "optional dependency" 문구 → sanitizeError 메시지 보존 + MISSING_DEPENDENCY 분류
    throw new KordocError(
      "이미지 파싱에는 optional dependency 'sharp' 가 필요합니다. " +
        `\`npm install sharp\` 후 다시 실행하세요.${OPTIONAL_DEP_INSTALL_HINT} 원인: ${(e as Error).message}`,
    )
  }
}

/** 이미지의 페이지 수 — 멀티페이지 TIFF·DCX 만 2 이상. 애니메이션 GIF 는 첫 프레임만 읽으므로 1 */
export async function imagePageCount(buffer: ArrayBuffer): Promise<number> {
  const kind = imageFormat(buffer)
  if (kind === "dcx") return Math.max(1, dcxPages(new Uint8Array(buffer)).length)
  if (kind !== "tiff") return 1
  // 헤더만 읽는다 — 픽셀 상한을 끄지 않으면 큰 크기가 적힌 TIFF 의 페이지 수를 1 로 잘못 읽는다
  const meta: MetaInfo = await (await loadSharp())(Buffer.from(buffer), { limitInputPixels: false }).metadata().catch(() => ({}))
  return Math.max(1, meta.pages ?? 1)
}

/** 멀티페이지 이미지(TIFF·DCX) page 번째(1부터) 페이지의 픽셀 수 — 헤더만 읽는다(디코딩 전 상한 확인용) */
export async function imagePagePixels(buffer: ArrayBuffer, page: number): Promise<number> {
  if (imageFormat(buffer) === "dcx") {
    const p = dcxPages(new Uint8Array(buffer))[page - 1]
    if (!p || p.length < 12) return 0
    const v = new DataView(p.buffer, p.byteOffset, p.byteLength)
    return Math.max(0, v.getUint16(8, true) - v.getUint16(4, true) + 1) * Math.max(0, v.getUint16(10, true) - v.getUint16(6, true) + 1)
  }
  const m: MetaInfo = await (await loadSharp())(Buffer.from(buffer), { page: page - 1, limitInputPixels: false }).metadata().catch(() => ({}))
  return (m.width ?? 0) * (m.height ?? 0)
}

const EXT: Record<ImageKind, string> = { png: "png", jpeg: "jpg", webp: "webp", tiff: "tif", gif: "gif", avif: "avif", heic: "heic", bmp: "bmp", pcx: "pcx", dcx: "dcx" }

/** 이미지 파일의 page 번째(1부터) 페이지 — 멀티페이지 TIFF·DCX 는 그 페이지를 PNG 로(문서 내 이미지와 같은 MAX_PIXELS 상한,
 *  넘거나 손상되면 null), 그 밖은 원본 바이트 그대로(정규화는 convertImages) */
export async function imagePage(buffer: ArrayBuffer, page: number, pageCount: number): Promise<ExtractedImage | null> {
  const name = `image_${String(page).padStart(3, "0")}`
  if (pageCount > 1 && imageFormat(buffer) === "dcx") {
    const px = pcxToRgba(dcxPages(new Uint8Array(buffer))[page - 1])
    return px && { filename: `${name}.png`, data: encodePng(px.width, px.height, px.data), mimeType: "image/png" }
  }
  if (pageCount > 1) {
    const png = await (await loadSharp())(Buffer.from(buffer), { page: page - 1, failOn: "error", limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer().catch(() => null)
    return png && { filename: `${name}.png`, data: new Uint8Array(png.buffer, png.byteOffset, png.byteLength), mimeType: "image/png" }
  }
  const kind = imageFormat(buffer) ?? "png"
  return { filename: `${name}.${EXT[kind]}`, data: new Uint8Array(buffer), mimeType: `image/${kind}` }
}

/**
 * sharp 로 RGBA 디코딩 — page 는 0부터(멀티페이지 TIFF).
 * EXIF 방향대로 세운다(`rotate()`): 폰으로 세로 촬영한 JPEG 은 픽셀을 눕혀 저장하고 Orientation 6 으로 표시 방향만 적는다 —
 * 무시하면 누운 글을 읽어 한글 131자 쪽이 쓰레기 57자가 됐다. 픽셀이 MAX_OCR_PIXELS 를 넘으면 그 안으로 줄인다(shrink = 줄인 배율).
 * sharp 가 못 읽는 BMP·HEIC 는 먼저 RGBA 로 디코딩해 raw 입력으로 넘긴다 — 회전·축소는 다른 형식과 같다.
 * (테스트용 export)
 */
export async function decodeToRgba(
  buffer: ArrayBuffer,
  page = 0,
): Promise<{ data: Uint8Array; width: number; height: number; density?: number; shrink: number }> {
  const sharp = await loadSharp()
  const input = Buffer.from(buffer)
  const kind = imageFormat(buffer)
  const pcx = kind === "pcx" ? pcxToRgba(input) : kind === "dcx" ? pcxToRgba(dcxPages(input)[page] ?? new Uint8Array(0)) : null
  const px = kind === "bmp" ? bmpToRgba(input) : kind === "heic" ? await heicToRgba(input) : pcx
  if (kind === "bmp" && !px) throw new KordocError(`BMP 디코딩 실패: 손상된 파일, 지원하지 않는 압축 방식(BI_JPEG·BI_PNG 등) 또는 ${MAX_PIXELS / 10_000}만 픽셀 초과`)
  if ((kind === "pcx" || kind === "dcx") && !px) throw new KordocError(`${kind.toUpperCase()} 디코딩 실패: 손상된 파일, 지원하지 않는 변형 또는 ${MAX_PIXELS / 10_000}만 픽셀 초과`)
  const open = () => px ? sharp(Buffer.from(px.data.buffer, px.data.byteOffset, px.data.byteLength), { raw: { width: px.width, height: px.height, channels: 4 } })
    : kind === "tiff" ? sharp(input, { page }) : sharp(input)
  // BMP 해상도는 info header 의 가로 pixels per meter(오프셋 38)
  const bmpDpi = kind === "bmp" && input.readUInt32LE(14) >= 40 ? input.readInt32LE(38) * 0.0254 : 0
  const dpi = pcx ? pcx.dpi : bmpDpi
  const meta: MetaInfo = px ? { width: px.width, height: px.height, ...(dpi > 0 ? { density: dpi } : {}) } : await open().metadata().catch(() => ({}))
  // 5~8 은 90° 돌린 방향 — 세운 뒤 가로·세로가 바뀐다
  const [w0, h0] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0]
  const shrink = w0 * h0 > MAX_OCR_PIXELS ? Math.sqrt(MAX_OCR_PIXELS / (w0 * h0)) : 1
  // 이미 RGBA 로 디코딩했고 축소할 필요가 없으면 그대로 반환 — sharp 를 거치면 같은 RGBA 를 한 번 더 복사한다
  if (px && shrink === 1) return { ...px, density: meta.density, shrink }
  let chain = open().rotate()
  if (shrink < 1) chain = chain.resize(Math.max(1, Math.floor(w0 * shrink)), Math.max(1, Math.floor(h0 * shrink)), { fit: "fill" })
  const { data, info } = await chain.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  if (kind === "avif") flushHeifCache(sharp)
  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height, density: meta.density,
    shrink: w0 ? info.width / w0 : 1,
  }
}

/** OcrProvider 계약용 mime 판별 */
function detectImageMime(buffer: ArrayBuffer): "image/png" | "image/jpeg" | "image/webp" {
  const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength))
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp"
  return "image/png"
}
