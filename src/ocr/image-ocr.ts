/**
 * 이미지 직접 입력 OCR — PNG/JPEG/WebP 를 PDF 래핑 없이 바로 파싱한다.
 *
 * 이미지는 텍스트층이 없으므로 OCR 이 항상 필요하다 — `--ocr` 플래그 없이도
 * 내장 엔진(PP-OCRv5 korean)을 기본 적용하고, OcrProvider 가 주어지면 위임한다.
 * 좌표는 이미지 해상도(imageScale — 메타데이터 DPI, 없으면 A4·Letter 판형 추정, 그것도
 * 아니면 216dpi)로 PDF pt 공간에 환산해 기존 블록 파이프라인
 * (괘선 감지 → 선 기반 표 → 클러스터 → xy-cut)을 그대로 태운다.
 *
 * 디코딩은 optional dependency `sharp` — 미설치면 MISSING_DEPENDENCY 안내.
 */

import type { IRBlock, OcrPageLines, ParseOptions, ParseWarning } from "../types.js"
import { KordocError, OPTIONAL_DEP_INSTALL_HINT } from "../utils.js"
import { getOcrEngine, type OcrPageStats } from "./engine.js"
import { ensureOcrModelsFor } from "./models.js"
import { applyImageFormulas } from "./image-formula.js"
import { detectRulingLines, rulingToPdfLines } from "./ruling-lines.js"
import { MAX_OCR_PIXELS, builtinOcrConfig, cellEdgeHorizontals, cellEdgeVerticals, ocrItemsToBlocks, pageLines, recognizeOcrPage, reportModelDownload } from "./pdf-ocr.js"
import { deskewPage } from "./deskew.js"

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
  /** ocrLines 옵션일 때 이미지(1쪽)의 OCR 줄 */
  lines?: OcrPageLines
}

/** 이미지 버퍼 → OCR → IRBlock[] (표 괘선 감지 포함) */
export async function parseImageDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
): Promise<ImageOcrResult> {
  const warnings: ParseWarning[] = []

  // 사용자 OcrProvider — 원본 바이트 그대로 위임 (종전 PDF 경로와 같은 계약)
  if (typeof options?.ocr === "function") {
    const text = await options.ocr(new Uint8Array(buffer), 1, detectImageMime(buffer))
    if (!text.trim()) {
      warnings.push({ page: 1, message: "OCR 결과 없음", code: "OCR_FAILED" })
      return { blocks: [], warnings }
    }
    return { blocks: [{ type: "paragraph", text: text.trim(), pageNumber: 1 }], warnings }
  }

  const { data: decoded, width, height, density, shrink } = await decodeToRgba(buffer)
  if (shrink < 1) warnings.push({ page: 1, code: "PARTIAL_PARSE", message: "OCR 래스터 픽셀 상한으로 이미지 해상도를 축소했습니다 (작은 글자 인식 결손 가능)" })
  // 픽셀 상한으로 줄인 이미지는 같은 지면을 낮은 해상도로 본 것 — px/pt 도 같은 비율로
  const scale = imageScale(width / shrink, height / shrink, density) * shrink
  // 스캔·사진 기울기 보정 — 인식과 괘선 감지가 같은(바로 선) 래스터를 본다
  const { rgba: data, angle } = deskewPage(decoded, width, height)

  const config = builtinOcrConfig(options)
  await ensureOcrModelsFor(config.models, reportModelDownload)
  if (config.handwriting) await ensureOcrModelsFor(config.handwriting, reportModelDownload)
  const engine = await getOcrEngine(config.models)
  const stats: OcrPageStats = { droppedLowConf: 0, ...(config.lines === "all" ? { dropped: [] } : {}) }
  // 괘선을 먼저 찾아 검출 상자를 표 칸·행 경계에서 가른다 — PDF OCR(ocrOnePage)과 같은 순서. 인식 뒤에 찾으면 이웃 칸 글이 한 상자로
  // 묶여 인식됐다(통계 보도자료 표 "2023 2024p ’23년대비" → "20232024p’23")
  const ruling = detectRulingLines(data, width, height, scale)
  let items = await recognizeOcrPage(engine, config, config.tuning, data, width, height, stats,
    [...(ruling.cellDividers ?? []), ...cellEdgeVerticals(ruling)], cellEdgeHorizontals(ruling))
  // 수식 OCR(선택) — 수식 자리 글상자를 $LaTeX$ 로 (image-formula)
  if (options?.formulaOcr) items = await applyImageFormulas(items, data, width, height, warnings)
  const lines = config.lines ? pageLines(1, width, height, scale, angle, items, stats.dropped) : undefined
  if (stats.droppedLowConf > 0) {
    warnings.push({
      page: 1,
      message: `저신뢰 OCR 라인 ${stats.droppedLowConf}개 폐기 (인식 결손 가능)`,
      code: "OCR_LOW_CONF",
    })
  }
  if (stats.truncatedBoxes) {
    warnings.push({ page: 1, message: `OCR 검출 상자가 너무 많아 ${stats.truncatedBoxes}개는 인식하지 않음 (일부 글 결손)`, code: "PARTIAL_PARSE" })
  }
  if (items.length === 0) {
    warnings.push({ page: 1, message: "이미지에서 텍스트를 인식하지 못했습니다", code: "OCR_FAILED" })
    return { blocks: [], warnings, lines }
  }

  const pdfW = width / scale
  const pdfH = height / scale
  const extraLines = rulingToPdfLines(ruling, scale, pdfH)
  return { blocks: ocrItemsToBlocks(items, 1, pdfW, pdfH, scale, extraLines, options?.tables !== false), warnings, lines }
}

/**
 * sharp 로 RGBA 디코딩 — 미설치는 MISSING_DEPENDENCY 로 분류되도록 안내 메시지 throw.
 * EXIF 방향대로 세운다(`rotate()`): 폰으로 세로 촬영한 JPEG 은 픽셀을 눕혀 저장하고 Orientation 6 으로 표시 방향만 적는다 —
 * 무시하면 누운 글을 읽어 한글 131자 쪽이 쓰레기 57자가 됐다. 픽셀이 MAX_OCR_PIXELS 를 넘으면 그 안으로 줄인다(shrink = 줄인 배율).
 * (테스트용 export)
 */
export async function decodeToRgba(
  buffer: ArrayBuffer,
): Promise<{ data: Uint8Array; width: number; height: number; density?: number; shrink: number }> {
  type Chain = {
    rotate(): Chain
    resize(w: number, h: number, opts: { fit: "fill" }): Chain
    ensureAlpha(): { raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } }
    metadata(): Promise<{ density?: number; width?: number; height?: number; orientation?: number }>
  }
  type SharpFactory = (input: Buffer) => Chain
  let sharp: SharpFactory
  try {
    const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
    sharp = typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
  } catch (e) {
    // KordocError + "optional dependency" 문구 → sanitizeError 메시지 보존 + MISSING_DEPENDENCY 분류
    throw new KordocError(
      "이미지 파싱에는 optional dependency 'sharp' 가 필요합니다. " +
        `\`npm install sharp\` 후 다시 실행하세요.${OPTIONAL_DEP_INSTALL_HINT} 원인: ${(e as Error).message}`,
    )
  }
  const input = Buffer.from(buffer)
  const meta: { density?: number; width?: number; height?: number; orientation?: number } = await sharp(input).metadata().catch(() => ({}))
  // 5~8 은 90° 돌린 방향 — 세운 뒤 가로·세로가 바뀐다
  const [w0, h0] = (meta.orientation ?? 1) >= 5 ? [meta.height ?? 0, meta.width ?? 0] : [meta.width ?? 0, meta.height ?? 0]
  const shrink = w0 * h0 > MAX_OCR_PIXELS ? Math.sqrt(MAX_OCR_PIXELS / (w0 * h0)) : 1
  let chain = sharp(input).rotate()
  if (shrink < 1) chain = chain.resize(Math.max(1, Math.floor(w0 * shrink)), Math.max(1, Math.floor(h0 * shrink)), { fit: "fill" })
  const { data, info } = await chain.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
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
