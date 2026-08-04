/**
 * 이미지 직접 입력 OCR — PNG/JPEG/WebP 를 PDF 래핑 없이 바로 파싱한다.
 *
 * 이미지는 텍스트층이 없으므로 OCR 이 항상 필요하다 — `--ocr` 플래그 없이도
 * 내장 엔진(PP-OCRv5 korean)을 기본 적용하고, OcrProvider 가 주어지면 위임한다.
 * 좌표는 216dpi(스케일 3) 가정으로 PDF pt 공간에 환산해 기존 블록 파이프라인
 * (괘선 감지 → 선 기반 표 → 클러스터 → xy-cut)을 그대로 태운다.
 *
 * 디코딩은 optional dependency `sharp` — 미설치면 MISSING_DEPENDENCY 안내.
 */

import type { IRBlock, ParseOptions, ParseWarning } from "../types.js"
import { KordocError } from "../utils.js"
import { getOcrEngine } from "./engine.js"
import { ensureOcrModels } from "./models.js"
import { detectRulingLines, rulingToPdfLines } from "./ruling-lines.js"
import { ocrItemsToBlocks } from "./pdf-ocr.js"

/** 좌표 환산 스케일 (px/pt) — PDF OCR 렌더(216dpi)와 동일 기준 */
const IMAGE_SCALE = 3

export interface ImageOcrResult {
  blocks: IRBlock[]
  warnings: ParseWarning[]
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

  const { data, width, height } = await decodeToRgba(buffer)

  await ensureOcrModels(p => {
    if (p.phase === "download" && p.downloaded === 0) {
      process.stderr.write(`[kordoc-ocr] ${p.spec.name} 다운로드 중 (~${p.spec.sizeMb}MB)...\n`)
    }
  })
  const engine = await getOcrEngine()
  const stats = { droppedLowConf: 0 }
  const items = await engine.recognizePage(data, width, height, stats)
  if (stats.droppedLowConf > 0) {
    warnings.push({
      page: 1,
      message: `저신뢰 OCR 라인 ${stats.droppedLowConf}개 폐기 (인식 결손 가능)`,
      code: "OCR_LOW_CONF",
    })
  }
  if (items.length === 0) {
    warnings.push({ page: 1, message: "이미지에서 텍스트를 인식하지 못했습니다", code: "OCR_FAILED" })
    return { blocks: [], warnings }
  }

  const pdfW = width / IMAGE_SCALE
  const pdfH = height / IMAGE_SCALE
  const ruling = detectRulingLines(data, width, height, IMAGE_SCALE)
  const extraLines = rulingToPdfLines(ruling, IMAGE_SCALE, pdfH)
  return { blocks: ocrItemsToBlocks(items, 1, pdfW, pdfH, IMAGE_SCALE, extraLines, options?.tables !== false), warnings }
}

/** sharp 로 RGBA 디코딩 — 미설치는 MISSING_DEPENDENCY 로 분류되도록 안내 메시지 throw */
async function decodeToRgba(
  buffer: ArrayBuffer,
): Promise<{ data: Uint8Array; width: number; height: number }> {
  type SharpFactory = (input: Buffer) => {
    ensureAlpha(): { raw(): { toBuffer(opts: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number } }> } }
  }
  let sharp: SharpFactory
  try {
    const mod = (await import("sharp")) as unknown as SharpFactory | { default?: SharpFactory }
    sharp = typeof mod === "function" ? mod : (mod.default ?? (mod as unknown as SharpFactory))
  } catch (e) {
    // KordocError + "optional dependency" 문구 → sanitizeError 메시지 보존 + MISSING_DEPENDENCY 분류
    throw new KordocError(
      "이미지 파싱에는 optional dependency 'sharp' 가 필요합니다. " +
        `\`npm install sharp\` 후 다시 실행하세요. 원인: ${(e as Error).message}`,
    )
  }
  const { data, info } = await sharp(Buffer.from(buffer)).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength), width: info.width, height: info.height }
}

/** OcrProvider 계약용 mime 판별 */
function detectImageMime(buffer: ArrayBuffer): "image/png" | "image/jpeg" | "image/webp" {
  const b = new Uint8Array(buffer, 0, Math.min(12, buffer.byteLength))
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp"
  return "image/png"
}
