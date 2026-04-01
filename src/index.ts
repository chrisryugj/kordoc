/**
 * kordoc — 모두 파싱해버리겠다
 *
 * HWP, HWPX, PDF → Markdown 변환 통합 라이브러리
 */

import { detectFormat, isHwpxFile, isOldHwpFile, isPdfFile } from "./detect.js"
import { parseHwpxDocument } from "./hwpx/parser.js"
import { parseHwp5Document } from "./hwp5/parser.js"
import type { ParseResult, ParseOptions } from "./types.js"
import { classifyError } from "./utils.js"

// ─── 메인 API ────────────────────────────────────────

/**
 * 파일 버퍼를 자동 감지하여 Markdown으로 변환
 *
 * @example
 * ```ts
 * import { parse } from "kordoc"
 * const result = await parse(buffer)
 * if (result.success) {
 *   console.log(result.markdown)     // 마크다운 텍스트
 *   console.log(result.blocks)       // IRBlock[] 구조화 데이터
 *   console.log(result.metadata)     // 문서 메타데이터
 * }
 * ```
 */
export async function parse(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  if (!buffer || buffer.byteLength === 0) {
    return { success: false, fileType: "unknown", error: "빈 버퍼이거나 유효하지 않은 입력입니다.", code: "EMPTY_INPUT" }
  }
  const format = detectFormat(buffer)

  switch (format) {
    case "hwpx":
      return parseHwpx(buffer, options)
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
    const { markdown, blocks, metadata, outline, warnings } = await parseHwpxDocument(buffer, options)
    return { success: true, fileType: "hwpx", markdown, blocks, metadata, outline, warnings }
  } catch (err) {
    return { success: false, fileType: "hwpx", error: err instanceof Error ? err.message : "HWPX 파싱 실패", code: classifyError(err) }
  }
}

/** HWP 5.x 바이너리 파일을 Markdown으로 변환 */
export async function parseHwp(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings } = parseHwp5Document(Buffer.from(buffer), options)
    return { success: true, fileType: "hwp", markdown, blocks, metadata, outline, warnings }
  } catch (err) {
    return { success: false, fileType: "hwp", error: err instanceof Error ? err.message : "HWP 파싱 실패", code: classifyError(err) }
  }
}

/** PDF 파일에서 텍스트를 추출하여 Markdown으로 변환 */
export async function parsePdf(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { parsePdfDocument } = await import("./pdf/parser.js")
    return await parsePdfDocument(buffer, options)
  } catch (err) {
    if (err instanceof Error && (err.message.includes("Cannot find") || err.message.includes("pdfjs-dist"))) {
      return { success: false, fileType: "pdf", error: "PDF 파싱을 위해 pdfjs-dist를 설치하세요: npm install pdfjs-dist", code: "MISSING_DEPENDENCY" }
    }
    return { success: false, fileType: "pdf", error: err instanceof Error ? err.message : "PDF 파싱 실패", code: classifyError(err) }
  }
}

// ─── 게임체인저 API ─────────────────────────────────

export { compare, diffBlocks } from "./diff/compare.js"
export { extractFormFields } from "./form/recognize.js"
export { markdownToHwpx } from "./hwpx/generator.js"

// ─── Re-exports ──────────────────────────────────────

export { detectFormat, isHwpxFile, isOldHwpFile, isPdfFile } from "./detect.js"
export type {
  ParseResult, ParseSuccess, ParseFailure, FileType,
  IRBlock, IRBlockType, IRTable, IRCell, CellContext,
  BoundingBox, InlineStyle,
  DocumentMetadata, ParseOptions, ErrorCode,
  ParseWarning, WarningCode, OutlineItem,
  DiffResult, BlockDiff, CellDiff, DiffChangeType,
  FormField, FormResult,
  OcrProvider, WatchOptions,
} from "./types.js"
export { blocksToMarkdown } from "./table/builder.js"
export { VERSION } from "./utils.js"
