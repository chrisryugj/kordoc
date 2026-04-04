/**
 * kordoc — 모두 파싱해버리겠다
 *
 * HWP, HWPX, PDF → Markdown 변환 통합 라이브러리
 */

import { readFile } from "fs/promises"
import { detectFormat, detectZipFormat, isHwpxFile, isOldHwpFile, isPdfFile, isZipFile } from "./detect.js"
import { parseHwpxDocument } from "./hwpx/parser.js"
import { parseHwp5Document } from "./hwp5/parser.js"
import { parsePdfDocument } from "./pdf/parser.js"
import { parseXlsxDocument } from "./xlsx/parser.js"
import { parseDocxDocument } from "./docx/parser.js"
import type { ParseResult, ParseOptions } from "./types.js"
import { classifyError, toArrayBuffer } from "./utils.js"

// ─── 메인 API ────────────────────────────────────────

/**
 * 파일 버퍼를 자동 감지하여 Markdown으로 변환
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 * // 파일 경로로 파싱
 * const result = await parse("document.hwp")
 * // 또는 Buffer로 파싱
 * const result = await parse(buffer)
 * ```
 */
export async function parse(input: string | ArrayBuffer | Buffer, options?: ParseOptions): Promise<ParseResult> {
  let buffer: ArrayBuffer
  if (typeof input === "string") {
    try {
      const buf = await readFile(input)
      buffer = toArrayBuffer(buf)
    } catch (err) {
      const msg = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT"
        ? `파일을 찾을 수 없습니다: ${input}`
        : `파일 읽기 실패: ${input}`
      return { success: false, fileType: "unknown", error: msg, code: "PARSE_ERROR" }
    }
  } else if (Buffer.isBuffer(input)) {
    buffer = toArrayBuffer(input)
  } else {
    buffer = input
  }

  if (!buffer || buffer.byteLength === 0) {
    return { success: false, fileType: "unknown", error: "빈 버퍼이거나 유효하지 않은 입력입니다.", code: "EMPTY_INPUT" }
  }
  const format = detectFormat(buffer)

  switch (format) {
    case "hwpx": {
      // ZIP 기반 포맷 세분화: HWPX, XLSX, DOCX 구분
      const zipFormat = await detectZipFormat(buffer)
      if (zipFormat === "xlsx") return parseXlsx(buffer, options)
      if (zipFormat === "docx") return parseDocx(buffer, options)
      return parseHwpx(buffer, options)
    }
    case "hwp":
      return parseHwp(buffer, options)
    case "pdf":
      return parsePdf(buffer, options)
    default:
      return { success: false, fileType: "unknown", error: "지원하지 않는 파일 형식입니다.", code: "UNSUPPORTED_FORMAT" }
  }
}

// ─── 포맷별 API ──────────────────────────────────────

/** HWPX 파일을 Markdown으로 변환 */
export async function parseHwpx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = await parseHwpxDocument(buffer, options)
    return { success: true, fileType: "hwpx", markdown, blocks, metadata, outline, warnings, images: images?.length ? images : undefined }
  } catch (err) {
    return { success: false, fileType: "hwpx", error: err instanceof Error ? err.message : "HWPX 파싱 실패", code: classifyError(err) }
  }
}

/** HWP 5.x 바이너리 파일을 Markdown으로 변환 */
export async function parseHwp(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = parseHwp5Document(Buffer.from(buffer), options)
    return { success: true, fileType: "hwp", markdown, blocks, metadata, outline, warnings, images: images?.length ? images : undefined }
  } catch (err) {
    return { success: false, fileType: "hwp", error: err instanceof Error ? err.message : "HWP 파싱 실패", code: classifyError(err) }
  }
}

/** PDF 파일에서 텍스트를 추출하여 Markdown으로 변환 */
export async function parsePdf(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings, isImageBased } = await parsePdfDocument(buffer, options)
    return { success: true, fileType: "pdf", markdown, blocks, metadata, outline, warnings, isImageBased }
  } catch (err) {
    const isImageBased = err instanceof Error && "isImageBased" in err ? true : undefined
    return { success: false, fileType: "pdf", error: err instanceof Error ? err.message : "PDF 파싱 실패", code: classifyError(err), isImageBased }
  }
}

/** XLSX 파일을 Markdown으로 변환 */
export async function parseXlsx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, warnings } = await parseXlsxDocument(buffer, options)
    return { success: true, fileType: "xlsx", markdown, blocks, metadata, warnings }
  } catch (err) {
    return { success: false, fileType: "xlsx", error: err instanceof Error ? err.message : "XLSX 파싱 실패", code: classifyError(err) }
  }
}

/** DOCX 파일을 Markdown으로 변환 */
export async function parseDocx(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings, images } = await parseDocxDocument(buffer, options)
    return { success: true, fileType: "docx", markdown, blocks, metadata, outline, warnings, images: images?.length ? images : undefined }
  } catch (err) {
    return { success: false, fileType: "docx", error: err instanceof Error ? err.message : "DOCX 파싱 실패", code: classifyError(err) }
  }
}

// ─── 게임체인저 API ─────────────────────────────────

export { compare, diffBlocks } from "./diff/compare.js"
export { extractFormFields } from "./form/recognize.js"
export { markdownToHwpx } from "./hwpx/generator.js"

// ─── Re-exports ──────────────────────────────────────

export { detectFormat, detectZipFormat, isHwpxFile, isOldHwpFile, isPdfFile, isZipFile } from "./detect.js"
export type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  BoundingBox, InlineStyle, ImageData, ExtractedImage,
  DocumentMetadata, ParseOptions, ErrorCode,
  ParseWarning, WarningCode, OutlineItem,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult,
  OcrProvider, WatchOptions,
} from "./types.js"
export { blocksToMarkdown } from "./table/builder.js"
export { VERSION } from "./utils.js"
