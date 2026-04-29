/**
 * kordoc — 모두 파싱해버리겠다
 *
 * HWP, HWPX, PDF → Markdown 변환 통합 라이브러리
 */

import { readFile } from "fs/promises"
import { detectFormat, detectOle2Format, detectZipFormat, isHwpxFile, isOldHwpFile, isPdfFile, isZipFile } from "./detect.js"
import { parseHwpxDocument } from "./hwpx/parser.js"
import { parseHwp5Document } from "./hwp5/parser.js"
import { isComFallbackAvailable, extractTextViaCom, comResultToParseResult } from "./hwpx/com-fallback.js"
import { isDistributionSentinel } from "./hwp5/sentinel.js"
// pdfjs-dist는 optional peer dep (37MB) — PDF 안 쓰는 사용자를 위해 dynamic import
// import { parsePdfDocument } from "./pdf/parser.js"
import { parseXlsxDocument } from "./xlsx/parser.js"
import { parseXlsDocument } from "./xls/parser.js"
import { parseDocxDocument } from "./docx/parser.js"
import { parseHwpmlDocument } from "./hwpml/parser.js"
import type { ParseResult, ParseOptions } from "./types.js"
import { classifyError, toArrayBuffer } from "./utils.js"
import { fillFormFields } from "./form/filler.js"
import type { FillResult } from "./form/filler.js"
import { fillHwpx } from "./form/filler-hwpx.js"
import type { HwpxFillResult } from "./form/filler-hwpx.js"
import { blocksToMarkdown } from "./table/builder.js"
import { markdownToHwpx } from "./hwpx/generator.js"

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
  // 파일 경로 입력 시 filePath를 options에 자동 설정 (DRM COM fallback에 필요)
  const opts = typeof input === "string" && !options?.filePath
    ? { ...options, filePath: input }
    : options
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
      if (zipFormat === "xlsx") return parseXlsx(buffer, opts)
      if (zipFormat === "docx") return parseDocx(buffer, opts)
      return parseHwpx(buffer, opts)
    }
    case "hwp": {
      // OLE2 기반 포맷 세분화: HWP 5.x vs XLS (Excel 97-2003)
      const ole2Format = detectOle2Format(buffer)
      if (ole2Format === "xls") return parseXls(buffer, opts)
      return parseHwp(buffer, opts)
    }
    case "hwpml":
      return parseHwpml(buffer, opts)
    case "pdf":
      return parsePdf(buffer, opts)
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

    // 배포용 HWP 5.x 감지 — 본문이 "상위 버전의 배포용 문서입니다..." 플레이스홀더뿐이면
    // COM fallback으로 재시도 (Windows + 한컴오피스 환경에서만). 이슈 #25 대응.
    if (isDistributionSentinel(markdown) && isComFallbackAvailable() && options?.filePath) {
      try {
        const { pages, pageCount, warnings: comWarns } = extractTextViaCom(options.filePath)
        if (pages.some(p => p && p.trim().length > 0)) {
          const com = comResultToParseResult(pages, pageCount, comWarns)
          return {
            success: true,
            fileType: "hwp",
            markdown: com.markdown,
            blocks: com.blocks,
            metadata: com.metadata,
            warnings: com.warnings,
          }
        }
      } catch {
        // COM 실패 시 기존 결과(경고 문자열 포함) 그대로 반환
      }
    }

    return { success: true, fileType: "hwp", markdown, blocks, metadata, outline, warnings, images: images?.length ? images : undefined }
  } catch (err) {
    return { success: false, fileType: "hwp", error: err instanceof Error ? err.message : "HWP 파싱 실패", code: classifyError(err) }
  }
}

/** PDF 파일에서 텍스트를 추출하여 Markdown으로 변환 */
export async function parsePdf(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  let parsePdfDocument: typeof import("./pdf/parser.js").parsePdfDocument
  try {
    const mod = await import("./pdf/parser.js")
    parsePdfDocument = mod.parsePdfDocument
  } catch {
    return {
      success: false, fileType: "pdf",
      error: "PDF 파싱에 pdfjs-dist가 필요합니다. 설치: npm install pdfjs-dist",
      code: "MISSING_DEPENDENCY",
    }
  }
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

/** XLS (Excel 97-2003) 파일을 Markdown으로 변환 */
export async function parseXls(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, warnings } = await parseXlsDocument(buffer, options)
    return { success: true, fileType: "xls", markdown, blocks, metadata, warnings }
  } catch (err) {
    return { success: false, fileType: "xls", error: err instanceof Error ? err.message : "XLS 파싱 실패", code: classifyError(err) }
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

/** HWPML (XML 기반 한컴 문서) 파일을 Markdown으로 변환 */
export async function parseHwpml(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  try {
    const { markdown, blocks, metadata, outline, warnings } = parseHwpmlDocument(buffer, options)
    return { success: true, fileType: "hwpml", markdown, blocks, metadata, outline, warnings }
  } catch (err) {
    return { success: false, fileType: "hwpml", error: err instanceof Error ? err.message : "HWPML 파싱 실패", code: classifyError(err) }
  }
}

// ─── 서식 채우기 API ────────────────────────────────

/**
 * 서식 채우기 출력 포맷
 * - "markdown": 마크다운 텍스트
 * - "hwpx": 새로 생성한 HWPX (스타일 초기화)
 * - "hwpx-preserve": 원본 HWPX ZIP 직접 수정 (스타일 100% 보존, HWPX 입력만 가능)
 */
export type FillOutputFormat = "markdown" | "hwpx" | "hwpx-preserve"

/** 서식 채우기 결과 */
export interface FillFormOutput {
  /** 채워진 문서 (markdown: string, hwpx/hwpx-preserve: ArrayBuffer) */
  output: string | ArrayBuffer
  /** 출력 포맷 */
  format: FillOutputFormat
  /** 채우기 상세 — filled 필드 목록 + unmatched 라벨 */
  fill: { filled: import("./types.js").FormField[]; unmatched: string[] }
}

/**
 * 서식 문서를 파싱하여 필드를 채우고, 원하는 포맷으로 출력.
 *
 * - "hwpx-preserve": HWPX 입력 → 원본 ZIP XML 직접 수정 (테두리/폰트/병합 등 100% 보존)
 * - "hwpx": 아무 포맷 → IRBlock → Markdown → HWPX 생성 (스타일 초기화됨)
 * - "markdown": 아무 포맷 → IRBlock → Markdown
 *
 * @example
 * ```ts
 * // HWPX 원본 스타일 보존 채우기
 * const result = await fillForm("신청서.hwpx", { "성명": "홍길동" }, "hwpx-preserve")
 * writeFileSync("결과.hwpx", Buffer.from(result.output as ArrayBuffer))
 *
 * // 아무 포맷 → 마크다운 채우기
 * const result = await fillForm("신청서.hwp", { "성명": "홍길동" })
 * console.log(result.output)  // 채워진 마크다운
 * ```
 */
export async function fillForm(
  input: string | ArrayBuffer | Buffer,
  values: Record<string, string>,
  outputFormat: FillOutputFormat = "markdown",
): Promise<FillFormOutput> {
  // 입력 버퍼 준비
  let buffer: ArrayBuffer
  if (typeof input === "string") {
    const buf = await readFile(input)
    buffer = toArrayBuffer(buf)
  } else if (Buffer.isBuffer(input)) {
    buffer = toArrayBuffer(input)
  } else {
    buffer = input
  }

  // hwpx-preserve: 원본 HWPX ZIP 직접 수정 (스타일 보존)
  if (outputFormat === "hwpx-preserve") {
    const format = detectFormat(buffer)
    // detectFormat은 ZIP이면 "hwpx" 반환 (XLSX/DOCX 포함), 세분화 필요
    if (format === "hwpx") {
      const zipFormat = await detectZipFormat(buffer)
      if (zipFormat !== "hwpx") {
        throw new Error(`hwpx-preserve 포맷은 HWPX 입력만 지원합니다 (감지된 포맷: ${zipFormat})`)
      }
    } else {
      throw new Error(`hwpx-preserve 포맷은 HWPX 입력만 지원합니다 (감지된 포맷: ${format})`)
    }
    const hwpxResult = await fillHwpx(buffer, values)
    return {
      output: hwpxResult.buffer,
      format: "hwpx-preserve",
      fill: { filled: hwpxResult.filled, unmatched: hwpxResult.unmatched },
    }
  }

  // 일반 경로: parse → IRBlock → fill → output
  const parsed = await parse(buffer)
  if (!parsed.success) {
    throw new Error(`서식 파싱 실패: ${parsed.error}`)
  }

  const fill = fillFormFields(parsed.blocks, values)
  const markdown = blocksToMarkdown(fill.blocks)

  if (outputFormat === "hwpx") {
    const hwpxBuffer = await markdownToHwpx(markdown)
    return { output: hwpxBuffer, format: "hwpx", fill }
  }

  return { output: markdown, format: "markdown", fill }
}

// ─── 게임체인저 API ─────────────────────────────────

export { compare, diffBlocks } from "./diff/compare.js"
export { extractFormFields, isLabelCell } from "./form/recognize.js"
export { fillFormFields } from "./form/filler.js"
export type { FillResult } from "./form/filler.js"
export { fillHwpx } from "./form/filler-hwpx.js"
export type { HwpxFillResult } from "./form/filler-hwpx.js"
export { markdownToHwpx } from "./hwpx/generator.js"
export { renderHtml, markdownToPdf, blocksToPdf } from "./print/renderer.js"
export type { PrintPreset, PrintOptions, PageMargin } from "./print/renderer.js"

// ─── Re-exports ──────────────────────────────────────

export { detectFormat, detectOle2Format, detectZipFormat, isHwpxFile, isOldHwpFile, isPdfFile, isZipFile } from "./detect.js"
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
