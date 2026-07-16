/** kordoc MCP 서버 — Claude/Cursor에서 문서 파싱 도구로 사용 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, statSync, mkdirSync, existsSync } from "fs"
import { pathToFileURL } from "url"
import { resolve, isAbsolute, extname, dirname, basename } from "path"
import { parse, detectFormat, detectZipFormat, blocksToMarkdown, compare, extractFormFields, fillFormFields, markdownToHwpx, fillHwpx, patchHwpx, patchHwp, unknownFontWarnings, incompatibleGongmunWarnings, gongmunLintWarnings, PRESET_ALIAS } from "./index.js"
import { fillWithUniqueGuard, type FillInput } from "./form/match.js"
import type { GongmunOptions } from "./index.js"
import {
  buildGongmunOptions, BODY_FONTS, H2_MARKERS, BULLET2_CHARS,
  FONT_ROLE_KEYS, SIZE_KEYS, DOC_HEAD_KEYS, DOC_FOOT_KEYS, NOTICE_HEAD_KEYS, PRESS_CONTACT_KEYS,
  BODY_PT_RANGE, LINE_SPACING_RANGE, SIZE_PT_RANGE, APPROVAL_MAX,
} from "./hwpx/gongmun-surface.js"
import { VERSION, toArrayBuffer, sanitizeError, classifyError, KordocError } from "./utils.js"
import { extractHwp5MetadataOnly } from "./hwp5/parser.js"
import { extractHwpxMetadataOnly } from "./hwpx/parser.js"
// pdfjs-dist는 optional — dynamic import로 지연 로드
// import { extractPdfMetadataOnly } from "./pdf/parser.js"

/** 허용 파일 확장자 */
export const ALLOWED_EXTENSIONS = new Set([".hwp", ".hwpx", ".hml", ".pdf", ".xls", ".xlsx", ".docx"])
/** 도장/서명 이미지 허용 확장자 (place_seal image_path) */
export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".bmp"])
/** 서식 프로필 허용 확장자 (generate_document profile_path) */
export const PROFILE_EXTENSIONS = new Set([".json"])
/** 최대 파일 크기 (500MB) */
const MAX_FILE_SIZE = 500 * 1024 * 1024

/** 경로 정규화 및 보안 검증 */
export function safePath(filePath: string, allowedExts: ReadonlySet<string> = ALLOWED_EXTENSIONS): string {
  if (!filePath) throw new KordocError("파일 경로가 비어있습니다")
  const resolved = resolve(filePath)
  let real: string
  try {
    real = realpathSync(resolved)
  } catch (err: any) {
    if (err?.code === "ENOENT") throw new KordocError(`파일을 찾을 수 없습니다: ${resolved}`)
    if (err?.code === "EACCES" || err?.code === "EPERM") throw new KordocError(`파일 접근 권한이 없습니다: ${resolved}`)
    throw new KordocError(`경로 처리 오류 [${err?.code ?? "UNKNOWN"}]`)
  }
  if (!isAbsolute(real)) throw new KordocError("절대 경로만 허용됩니다")
  const ext = extname(real).toLowerCase()
  if (!allowedExts.has(ext)) throw new KordocError(`지원하지 않는 확장자입니다: ${ext} (허용: ${[...allowedExts].join(", ")})`)
  return real
}

/** 출력 경로 정규화 및 검증 — 확장자 allowlist + 부모 디렉토리 realpath (safePath의 쓰기 대응) */
export function safeOutputPath(outputPath: string, allowedExts: ReadonlySet<string>): string {
  if (!outputPath) throw new KordocError("출력 경로가 비어있습니다")
  const resolved = resolve(outputPath)
  const ext = extname(resolved).toLowerCase()
  if (!allowedExts.has(ext)) {
    throw new KordocError(`지원하지 않는 출력 확장자입니다: ${ext || "(없음)"} (허용: ${[...allowedExts].join(", ")})`)
  }
  // 부모 디렉토리가 이미 있으면 심볼릭 링크 해석 후 정규화 (없으면 저장 시 생성)
  const parent = dirname(resolved)
  if (existsSync(parent)) {
    try {
      return resolve(realpathSync(parent), basename(resolved))
    } catch (err: any) {
      throw new KordocError(`출력 경로 처리 오류 [${err?.code ?? "UNKNOWN"}]: ${parent}`)
    }
  }
  return resolved
}

/**
 * MCP 오류 응답 텍스트 — KordocError는 그대로, fs 계열(ENOENT 등)은 경로 노출 없이
 * 코드별 힌트, 그 외는 classifyError 분류를 병기해 일반화 ("문서 처리 중 오류" 뭉개기 방지)
 */
export function describeError(err: unknown): string {
  if (err instanceof KordocError) return err.message
  const code = (err as NodeJS.ErrnoException)?.code
  if (typeof code === "string" && /^E[A-Z]+$/.test(code)) {
    const hints: Record<string, string> = {
      ENOENT: "파일 또는 디렉토리를 찾을 수 없습니다",
      EACCES: "접근 권한이 없습니다",
      EPERM: "작업 권한이 없습니다",
      EISDIR: "파일이 아니라 디렉토리입니다",
      ENOTDIR: "경로 중간이 디렉토리가 아닙니다",
      ENOSPC: "디스크 공간이 부족합니다",
    }
    return `파일 시스템 오류 [${code}]: ${hints[code] ?? "경로와 권한을 확인하세요"}`
  }
  const cls = classifyError(err)
  return cls === "PARSE_ERROR" ? sanitizeError(err) : `문서 처리 중 오류가 발생했습니다 (${cls})`
}

/** MCP 응답 본문 상한 — 사진 몇 장·대형 문서로 클라이언트 도구 응답 한도를 넘기지 않게 */
const MAX_RESPONSE_CHARS = 200_000
export function capResponseText(text: string, maxChars = MAX_RESPONSE_CHARS): string {
  if (text.length <= maxChars) return text
  return text.slice(0, maxChars) +
    `\n\n… [응답이 ${maxChars.toLocaleString()}자 상한을 넘어 절단됨 (전체 ${text.length.toLocaleString()}자) — parse_pages로 페이지 범위를 나눠 읽으세요]`
}

/** 최대 파일 크기 — metadata 전용 (50MB, 전체 파싱보다 보수적) */
const MAX_METADATA_FILE_SIZE = 50 * 1024 * 1024

/** 파일 읽기 + 크기 검증 공통 로직 */
function readValidatedFile(filePath: string, maxSize = MAX_FILE_SIZE, allowedExts: ReadonlySet<string> = ALLOWED_EXTENSIONS): { buffer: ArrayBuffer; resolved: string } {
  const resolved = safePath(filePath, allowedExts)
  let fileSize: number
  try {
    fileSize = statSync(resolved).size
  } catch (err: any) {
    throw new KordocError(`파일 상태 읽기 실패 [${err?.code ?? "UNKNOWN"}]: ${resolved}`)
  }
  if (fileSize > maxSize) {
    throw new KordocError(`파일이 너무 큽니다: ${(fileSize / 1024 / 1024).toFixed(1)}MB (최대 ${maxSize / 1024 / 1024}MB)`)
  }
  let raw: Buffer
  try {
    raw = readFileSync(resolved)
  } catch (err: any) {
    throw new KordocError(`파일 읽기 실패 [${err?.code ?? "UNKNOWN"}]: ${resolved}`)
  }
  return { buffer: toArrayBuffer(raw), resolved }
}

/** 파일 헤더(512바이트)만 읽어 포맷 감지 — 전체 파일 로드 불필요.
 *  16바이트로는 HWP3 매직(30B)·HWPML(<?xml…<HWPML, 최대 512B 윈도)이 안 잡힌다 */
function detectFormatFromHeader(resolved: string): ReturnType<typeof detectFormat> {
  const fd = openSync(resolved, "r")
  try {
    const headerBuf = Buffer.alloc(512)
    const bytesRead = readSync(fd, headerBuf, 0, 512, 0)
    return detectFormat(toArrayBuffer(headerBuf.subarray(0, bytesRead)))
  } finally {
    closeSync(fd)
  }
}

const server = new McpServer({
  name: "kordoc",
  version: VERSION,
})

// ─── 도구: parse_document ────────────────────────────

server.tool(
  "parse_document",
  "한국 문서 파일(HWP, HWPX, PDF, XLSX, DOCX)을 마크다운으로 변환합니다. 파일 경로를 입력하면 포맷을 자동 감지하여 텍스트를 추출합니다.",
  {
    file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로 (HWP, HWPX, PDF, XLSX, DOCX)"),
  },
  async ({ file_path }) => {
    try {
      const { buffer, resolved } = readValidatedFile(file_path)
      const format = detectFormat(buffer)

      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
          isError: true,
        }
      }

      // 이미지는 파일 참조(image_NNN)로 둔다 — MCP 텍스트 응답에 base64 를 인라인해도
      // 모델은 data URI 를 이미지로 해석하지 못하고, 사진 한 장(≈100KB → base64 133KB)
      // 만으로 클라이언트 도구 응답 한도(Claude Code 기본 25k 토큰)를 넘겨 호출 자체가
      // 깨진다(v3.18.0 회귀). 자체 완결형 마크다운이 필요하면 CLI `--inline-images`.
      // filePath 전달 — 배포용 HWP의 COM fallback에 필요 (CLI와 동일)
      const result = await parse(buffer, { filePath: resolved })

      if (!result.success) {
        return {
          content: [{ type: "text", text: `파싱 실패 (${result.fileType}): ${result.error}` }],
          isError: true,
        }
      }

      const markdown = result.markdown

      const meta = [
        `포맷: ${result.fileType.toUpperCase()}`,
        result.pageCount ? `페이지: ${result.pageCount}` : null,
        result.metadata?.title ? `제목: ${result.metadata.title}` : null,
        result.metadata?.author ? `작성자: ${result.metadata.author}` : null,
        result.isImageBased ? "이미지 기반 PDF (텍스트 추출 불가)" : null,
      ].filter(Boolean).join(" | ")

      // outline/warnings 부가 정보 추가
      const parts: string[] = [`[${meta}]`]

      if (result.outline && result.outline.length > 0) {
        const outlineText = result.outline.map(o => `${"  ".repeat(o.level - 1)}- ${o.text}`).join("\n")
        parts.push(`\n📑 문서 구조:\n${outlineText}`)
      }

      if (result.warnings && result.warnings.length > 0) {
        const warnText = result.warnings.map(w => `- [p${w.page || "?"}] ${w.message}`).join("\n")
        parts.push(`\n⚠️ 경고:\n${warnText}`)
      }

      parts.push(`\n\n${markdown}`)

      return {
        content: [{ type: "text", text: capResponseText(parts.join("")) }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: detect_format ─────────────────────────────

server.tool(
  "detect_format",
  "파일의 포맷을 매직 바이트로 감지합니다 (hwpx, hwp, pdf, xlsx, docx, unknown).",
  {
    file_path: z.string().min(1).describe("감지할 파일의 절대 경로"),
  },
  async ({ file_path }) => {
    try {
      const resolved = safePath(file_path)
      let format: string = detectFormatFromHeader(resolved)
      // 16바이트 헤더로는 모든 ZIP이 'hwpx'로 나온다 — 파일을 읽어 내부 구조로
      // hwpx/xlsx/docx 세분화 (parse_metadata와 판정 일치, v4.0.6)
      // 크기 상한은 parse_document와 동일(500MB) — 50MB 초과 ZIP 감지 실패 방지
      if (format === "hwpx") {
        const { buffer } = readValidatedFile(file_path)
        format = await detectZipFormat(buffer)
      }
      return {
        content: [{ type: "text", text: `${file_path}: ${format}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: parse_metadata ────────────────────────────

server.tool(
  "parse_metadata",
  "문서의 메타데이터(제목, 작성자, 날짜 등)만 빠르게 추출합니다. 전체 파싱 없이 헤더/매니페스트만 읽습니다.",
  {
    file_path: z.string().min(1).describe("메타데이터를 추출할 문서 파일의 절대 경로"),
  },
  async ({ file_path }) => {
    try {
      const resolved = safePath(file_path)
      const format = detectFormatFromHeader(resolved)

      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
          isError: true,
        }
      }

      // metadata 전용 크기 제한 (50MB)
      const { buffer } = readValidatedFile(file_path, MAX_METADATA_FILE_SIZE)

      let metadata
      // ZIP 기반 포맷(hwpx)은 내부 구조로 세분화 (XLSX/DOCX 구분)
      let effectiveFormat = format
      if (format === "hwpx") {
        const { detectZipFormat } = await import("./detect.js")
        const zipFormat = await detectZipFormat(buffer)
        if (zipFormat === "xlsx" || zipFormat === "docx") effectiveFormat = zipFormat as any
      }
      switch (effectiveFormat) {
        case "hwp":
          metadata = extractHwp5MetadataOnly(Buffer.from(buffer))
          break
        case "hwpx":
          metadata = await extractHwpxMetadataOnly(buffer)
          break
        case "pdf":
          try {
            const { extractPdfMetadataOnly } = await import("./pdf/parser.js")
            metadata = await extractPdfMetadataOnly(buffer)
          } catch {
            metadata = undefined // pdfjs-dist 미설치 시 metadata 생략
          }
          break
        case "hwp3":
        case "hwpml":
        case "xlsx":
        case "docx": {
          // HWP3/HWPML/XLSX/DOCX는 전용 metadata 추출기가 없으므로 전체 파싱 후 metadata 반환
          const result = await parse(buffer)
          metadata = result.success ? result.metadata : undefined
          break
        }
      }

      return {
        content: [{ type: "text", text: JSON.stringify({ format, ...metadata }, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: parse_pages ──────────────────────────────

server.tool(
  "parse_pages",
  "문서의 특정 페이지/섹션 범위만 파싱합니다. PDF는 정확한 페이지, HWP/HWPX는 섹션 단위 근사치입니다.",
  {
    file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로"),
    pages: z.string().min(1).describe("페이지 범위 (예: '1-3', '1,3,5-7')"),
  },
  async ({ file_path, pages }) => {
    try {
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)

      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
          isError: true,
        }
      }

      const result = await parse(buffer, { pages })

      if (!result.success) {
        return {
          content: [{ type: "text", text: `파싱 실패 (${result.fileType}): ${result.error}` }],
          isError: true,
        }
      }

      const meta = [
        `포맷: ${result.fileType.toUpperCase()}`,
        `범위: ${pages}`,
        result.pageCount ? `페이지: ${result.pageCount}` : null,
      ].filter(Boolean).join(" | ")

      return {
        content: [{ type: "text", text: `[${meta}]\n\n${result.markdown}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: parse_table ──────────────────────────────

server.tool(
  "parse_table",
  "문서에서 N번째 테이블만 추출합니다 (0-based index). 테이블이 없거나 인덱스 범위를 초과하면 오류를 반환합니다.",
  {
    file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로"),
    table_index: z.number().int().min(0).describe("추출할 테이블 인덱스 (0부터 시작)"),
  },
  async ({ file_path, table_index }) => {
    try {
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)

      if (format === "unknown") {
        return {
          content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
          isError: true,
        }
      }

      const result = await parse(buffer)

      if (!result.success) {
        return {
          content: [{ type: "text", text: `파싱 실패 (${result.fileType}): ${result.error}` }],
          isError: true,
        }
      }

      const tableBlocks = result.blocks.filter(b => b.type === "table" && b.table)
      if (tableBlocks.length === 0) {
        return {
          content: [{ type: "text", text: `문서에 테이블이 없습니다.` }],
          isError: true,
        }
      }

      if (table_index >= tableBlocks.length) {
        return {
          content: [{ type: "text", text: `테이블 인덱스 초과: ${table_index} (총 ${tableBlocks.length}개 테이블)` }],
          isError: true,
        }
      }

      const tableBlock = tableBlocks[table_index]
      const tableMarkdown = blocksToMarkdown([tableBlock])

      return {
        content: [{ type: "text", text: `[테이블 #${table_index} / 총 ${tableBlocks.length}개]\n\n${tableMarkdown}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: compare_documents ─────────────────────────

server.tool(
  "compare_documents",
  "두 한국 문서 파일을 비교하여 추가/삭제/변경된 블록을 표시합니다. 신구대조표 생성에 활용됩니다. 크로스 포맷(HWP↔HWPX) 비교 가능.",
  {
    file_path_a: z.string().min(1).describe("비교 원본 문서의 절대 경로"),
    file_path_b: z.string().min(1).describe("비교 대상 문서의 절대 경로"),
  },
  async ({ file_path_a, file_path_b }) => {
    try {
      const { buffer: bufA } = readValidatedFile(file_path_a)
      const { buffer: bufB } = readValidatedFile(file_path_b)

      const result = await compare(bufA, bufB)
      const { stats, diffs } = result

      const lines: string[] = [
        `## 문서 비교 결과`,
        `추가: ${stats.added} | 삭제: ${stats.removed} | 변경: ${stats.modified} | 동일: ${stats.unchanged}`,
        "",
      ]

      for (const d of diffs) {
        const prefix = d.type === "added" ? "+" : d.type === "removed" ? "-" : d.type === "modified" ? "~" : " "
        const text = d.after?.text || d.before?.text || (d.after?.table ? "[테이블]" : d.before?.table ? "[테이블]" : "")
        const sim = d.similarity !== undefined ? ` (${(d.similarity * 100).toFixed(0)}%)` : ""
        lines.push(`${prefix} ${text.substring(0, 200)}${sim}`)
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: parse_form ───────────────────────────────

server.tool(
  "parse_form",
  "한국 서식 문서에서 레이블-값 쌍을 구조화된 JSON으로 추출합니다. 양식/서식 문서에 최적화.",
  {
    file_path: z.string().min(1).describe("서식 문서 파일의 절대 경로"),
  },
  async ({ file_path }) => {
    try {
      const { buffer } = readValidatedFile(file_path)
      const result = await parse(buffer)

      if (!result.success) {
        return {
          content: [{ type: "text", text: `파싱 실패: ${result.error}` }],
          isError: true,
        }
      }

      const form = extractFormFields(result.blocks)
      return {
        content: [{ type: "text", text: JSON.stringify(form, null, 2) }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

/** fields + formats 를 FillInput 맵으로 결합 (formats의 라벨은 fields와 동일 표기 기준) */
export function buildFillInputs(fields: Record<string, string>, formats?: Record<string, string>): Record<string, FillInput> {
  const out: Record<string, FillInput> = {}
  for (const [k, v] of Object.entries(fields)) {
    const format = formats?.[k]
    out[k] = format ? { value: v, format } : v
  }
  return out
}

// ─── 도구: fill_form ───────────────────────────────

server.tool(
  "fill_form",
  "한국 서식 문서의 빈칸을 채워서 새 문서로 출력합니다. hwpx-preserve를 사용하면 원본 서식(테두리, 폰트, 병합 등)을 100% 유지합니다.",
  {
    file_path: z.string().min(1).describe("서식 템플릿 문서의 절대 경로 (HWP, HWPX, PDF, XLSX, DOCX)"),
    fields: z.record(z.string(), z.string()).describe("채울 필드 맵 (라벨 → 값). 예: {\"성명\": \"홍길동\", \"전화번호\": \"010-1234-5678\"}"),
    formats: z.record(z.string(), z.string()).optional().describe("필드별 값 서식 (라벨 → 포맷). 정준값 하나로 서식마다 다른 모양을 채울 때: date:yy.mm.dd / phone:hyphen·dot·digits / rrn:hyphen·masked / mask:###-## / 자유 패턴(yyyy년 m월 d일, ###-####-####)"),
    require_unique: z.boolean().optional().describe("한 키가 서식의 2곳 이상에 매칭되면 채우지 않고 거부 — 반복 라벨 양식에서 남의 블록 오염 방지 (배열 값은 예외)"),
    mask_values: z.boolean().optional().describe("응답에 값 대신 글자수만 표시 — 개인정보 채움 시 값이 대화 로그에 남지 않게"),
    output_format: z.enum(["markdown", "hwpx", "hwpx-preserve"]).default("hwpx-preserve").describe("출력 포맷: hwpx-preserve (원본 스타일 보존, HWPX 전용), hwpx (새 HWPX 생성), markdown"),
    output_path: z.string().optional().describe("출력 파일 저장 경로 (선택). 지정 시 파일로 저장, 미지정 시 텍스트로 반환"),
  },
  async ({ file_path, fields, formats, require_unique, mask_values, output_format, output_path }) => {
    try {
      // 출력 경로 사전 검증 (포맷별 확장자 allowlist) — 채우기 전에 실패시킨다
      const outExts = output_format === "markdown" ? new Set([".md", ".markdown", ".txt"]) : new Set([".hwpx"])
      const outPath = output_path ? safeOutputPath(output_path, outExts) : undefined
      const { buffer } = readValidatedFile(file_path)

      // ─── hwpx-preserve: 원본 ZIP 직접 수정 (스타일 보존) ───
      if (output_format === "hwpx-preserve") {
        const format = detectFormat(buffer)
        let isHwpx = format === "hwpx"
        if (isHwpx) {
          const zipFormat = await detectZipFormat(buffer)
          isHwpx = zipFormat === "hwpx"
        }
        if (!isHwpx) {
          return {
            content: [{ type: "text", text: `hwpx-preserve는 HWPX 파일만 지원합니다 (감지된 포맷: ${format}). hwpx 또는 markdown을 사용하세요.` }],
            isError: true,
          }
        }

        const inputs = buildFillInputs(fields, formats)
        const hwpxResult = require_unique
          ? await fillWithUniqueGuard(inputs, (vals, blocked) => fillHwpx(buffer, vals, blocked))
          : { ...(await fillHwpx(buffer, inputs)), rejected: [] as string[] }
        // 마스킹 verify — 채운 결과를 재파싱해 값이 실제 문서에 있는지만 확인 (값 미노출)
        let verifyLine: string | null = null
        if (mask_values && hwpxResult.filled.length > 0) {
          const reparsed = await parse(Buffer.from(hwpxResult.buffer))
          // 마크다운 이스케이프(\*,\|,\~ 등)·개행/연속공백 정규화 후 비교 — rrn:masked
          // ('900315-1******')의 * 이스케이프로 생기던 결정적 false negative 방지.
          // 빈 값은 includes('')===true 로 항상 통과하던 것을 FILLED 에서 제외한다.
          const norm = (s: string): string => s.replace(/\\([\\`*_{}[\]()#+.!|~>-])/g, "$1").replace(/\s+/g, " ")
          const normMd = reparsed.success ? norm(reparsed.markdown) : ""
          const okCount = reparsed.success
            ? hwpxResult.filled.filter(f => f.value !== "" && normMd.includes(norm(f.value))).length
            : 0
          verifyLine = `검증(마스킹): ${okCount}/${hwpxResult.filled.length} FILLED — 재파싱 대조, 값 미노출`
        }
        const summary = [
          `채워진 필드: ${hwpxResult.filled.length}개 (원본 스타일 보존)`,
          hwpxResult.rejected.length > 0 ? `모호 라벨 거부(2곳+ 매칭): ${hwpxResult.rejected.join(", ")}` : null,
          hwpxResult.unmatched.length > 0 ? `매칭 실패: ${hwpxResult.unmatched.join(", ")}` : null,
          verifyLine,
        ].filter(Boolean).join(" | ")

        const filledList = hwpxResult.filled
          .map(f => `  - ${f.label}: ${mask_values ? `[${[...f.value].length}자]` : f.value}`).join("\n")

        if (outPath) {
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, Buffer.from(hwpxResult.buffer))
          return {
            content: [{ type: "text", text: `[${summary}]\n\n채워진 필드:\n${filledList}\n\nHWPX 파일 저장 (원본 서식 유지): ${outPath}` }],
          }
        }

        return {
          content: [{ type: "text", text: `[${summary}]\n\n채워진 필드:\n${filledList}\n\n⚠️ output_path를 지정하면 원본 서식이 유지된 HWPX 파일로 저장됩니다.` }],
        }
      }

      // ─── 일반 경로: parse → fill → output ───
      const result = await parse(buffer)
      if (!result.success) {
        return {
          content: [{ type: "text", text: `파싱 실패: ${result.error}` }],
          isError: true,
        }
      }

      const formInfo = extractFormFields(result.blocks)
      const irInputs = buildFillInputs(fields, formats)
      const fillResult = require_unique
        ? await fillWithUniqueGuard(irInputs, (vals, blocked) => fillFormFields(result.blocks, vals, blocked))
        : { ...fillFormFields(result.blocks, irInputs), rejected: [] as string[] }

      if (fillResult.filled.length === 0 && formInfo.fields.length === 0) {
        return {
          content: [{ type: "text", text: `서식 필드를 찾을 수 없습니다. 일반 문서이거나 서식 패턴이 감지되지 않았습니다.` }],
          isError: true,
        }
      }

      const markdown = blocksToMarkdown(fillResult.blocks)
      // mask_values 시 채운 값(주민번호·연락처 등)이 응답(대화 로그)에 노출되지 않게
      // 본문 미리보기를 안내 문구로 대체 (sfill-8). 값은 output_path 파일에만 기록된다.
      const previewMd = mask_values
        ? "⚠️ mask_values 활성 — 개인정보 노출 방지를 위해 본문을 응답에 포함하지 않습니다. output_path 로 파일 저장 후 확인하세요."
        : markdown
      const summary = [
        `채워진 필드: ${fillResult.filled.length}개`,
        fillResult.rejected.length > 0 ? `모호 라벨 거부(2곳+ 매칭): ${fillResult.rejected.join(", ")}` : null,
        fillResult.unmatched.length > 0 ? `매칭 실패: ${fillResult.unmatched.join(", ")}` : null,
        formInfo.fields.length > 0 ? `서식 필드: ${formInfo.fields.length}개 (확신도 ${(formInfo.confidence * 100).toFixed(0)}%)` : null,
      ].filter(Boolean).join(" | ")

      if (output_format === "hwpx") {
        const hwpxBuffer = await markdownToHwpx(markdown)
        if (outPath) {
          mkdirSync(dirname(outPath), { recursive: true })
          writeFileSync(outPath, Buffer.from(hwpxBuffer))
          return {
            content: [{ type: "text", text: `[${summary}]\n\nHWPX 파일 저장: ${outPath}` }],
          }
        }
        return {
          content: [{ type: "text", text: `[${summary}]\n\n⚠️ output_path를 지정하면 HWPX 파일로 저장됩니다. 미리보기:\n\n${previewMd}` }],
        }
      }

      // markdown
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, markdown, "utf-8")
        return {
          content: [{ type: "text", text: `[${summary}]\n\n마크다운 파일 저장: ${outPath}\n\n${previewMd}` }],
        }
      }
      return {
        content: [{ type: "text", text: `[${summary}]\n\n${previewMd}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: place_seal ─────────────────────────────

server.tool(
  "place_seal",
  "도장/서명 이미지를 앵커 문구(\"(인)\"·\"서명 또는 인\" 등) 위에 부유(글 앞) 배치합니다. 표/페이지를 키우지 않습니다 (HWPX 전용).",
  {
    file_path: z.string().min(1).describe("대상 HWPX 문서의 절대 경로"),
    image_path: z.string().min(1).describe("도장/서명 이미지 절대 경로 (투명 배경 PNG 권장)"),
    anchor: z.string().default("(인)").describe("앵커 문구 — 이 문구 기준으로 배치"),
    occurrence: z.number().int().min(0).default(0).describe("같은 앵커가 여럿일 때 0-based 선택"),
    size_mm: z.number().positive().optional().describe("도장 한 변 크기 mm (기본: 줄높이×1.6, 7~18 클램프)"),
    mode: z.enum(["overlap", "right", "auto"]).default("auto").describe("overlap=문구 위 겹침, right=문구 오른쪽 옆, auto=공간 있으면 right"),
    dx_mm: z.number().optional().describe("x 미세조정 mm"),
    dy_mm: z.number().optional().describe("y 미세조정 mm"),
    output_path: z.string().min(1).describe("출력 HWPX 저장 경로"),
  },
  async ({ file_path, image_path, anchor, occurrence, size_mm, mode, dx_mm, dy_mm, output_path }) => {
    try {
      const outPath = safeOutputPath(output_path, new Set([".hwpx"]))
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)
      if (format !== "hwpx") {
        return {
          content: [{ type: "text", text: `place_seal 은 HWPX 파일만 지원합니다 (감지된 포맷: ${format}).` }],
          isError: true,
        }
      }
      // 이미지 경로도 문서와 동일하게 검증 (realpath + 확장자 allowlist)
      const imgResolved = safePath(image_path, IMAGE_EXTENSIONS)
      if (statSync(imgResolved).size > 500 * 1024 * 1024) {
        return { content: [{ type: "text", text: `도장 이미지가 너무 큽니다 (${(statSync(imgResolved).size / 1024 / 1024).toFixed(0)}MB) — 500MB 이하여야 합니다.` }], isError: true }
      }
      const image = new Uint8Array(readFileSync(imgResolved))
      const ext = extname(imgResolved).slice(1).toLowerCase() as "png" | "jpg" | "jpeg" | "bmp" | "gif"
      const { placeSealHwpx } = await import("./form/seal.js")
      const result = await placeSealHwpx(buffer, [{
        anchor, occurrence, image, ext,
        sizeMm: size_mm, mode, dxMm: dx_mm, dyMm: dy_mm,
      }])
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, Buffer.from(result.buffer))
      const p0 = result.placed[0]
      const warnLines = (p0.warnings ?? []).map(w => `\n⚠️ ${w}`).join("")
      return {
        content: [{
          type: "text",
          text: `도장 배치 완료: "${p0.anchor}" #${p0.occurrence} → ${p0.mode} (x ${p0.posXMm}mm, y ${p0.posYMm}mm, ${p0.sizeMm}mm각, ${p0.entry})\n저장: ${outPath}${warnLines}\n표/페이지 불확장(글 앞 부유) — 한컴에서 위치 확인 후 dx_mm/dy_mm 로 미세조정 가능합니다.`,
        }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `도장 배치 실패: ${describeError(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── 도구: patch_document ────────────────────────────

server.tool(
  "patch_document",
  "원본 HWPX/HWP의 서식(글꼴·표·도장칸·이미지)을 1바이트도 건드리지 않고, 편집된 마크다운의 바뀐 텍스트만 제자리 치환해 새 문서로 출력합니다. parse_document로 얻은 마크다운을 수정해 넘기세요 — 양식 빈칸 채우기·문구 수정에 적합하며 한컴 한글에서 변조 경고 없이 열립니다. (블록 추가/삭제·표 구조 변경은 미지원, 미적용 항목은 결과에 보고)",
  {
    file_path: z.string().min(1).describe("원본 문서의 절대 경로 (HWPX 또는 HWP 5.x)"),
    edited_markdown: z.string().min(1).describe("parse_document 출력 마크다운을 편집한 전체 마크다운. 바뀐 문단/셀 텍스트만 반영하고 블록 수·순서는 원본과 같게 유지하세요"),
    output_path: z.string().min(1).describe("출력 파일 저장 절대 경로 (원본과 같은 확장자: .hwpx 또는 .hwp)"),
  },
  async ({ file_path, edited_markdown, output_path }) => {
    try {
      const out = safeOutputPath(output_path, new Set([".hwpx", ".hwp"]))
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)
      let isHwpx = format === "hwpx"
      if (isHwpx) {
        const zipFormat = await detectZipFormat(buffer)
        isHwpx = zipFormat === "hwpx"
      }
      if (!isHwpx && format !== "hwp") {
        return {
          content: [{ type: "text", text: `patch_document는 HWPX 또는 HWP 5.x만 지원합니다 (감지된 포맷: ${format}).` }],
          isError: true,
        }
      }

      const original = new Uint8Array(buffer)
      const result = isHwpx
        ? await patchHwpx(original, edited_markdown)
        : await patchHwp(original, edited_markdown)

      if (!result.success || !result.data) {
        return {
          content: [{ type: "text", text: `패치 실패: ${result.error ?? "알 수 없는 오류"}` }],
          isError: true,
        }
      }

      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(result.data))

      const v = result.verification?.stats
      const lossless = v ? (v.modified === 0 && v.added === 0 && v.removed === 0) : undefined
      const lines = [
        `✓ ${result.applied}개 변경 적용 (${isHwpx ? "HWPX" : "HWP"}, 원본 서식 보존) → ${out}`,
        lossless === true ? "검증: 편집 내용과 재파싱 결과 완전 일치" :
          lossless === false ? `검증 잔차: 수정 ${v!.modified} · 추가 ${v!.added} · 삭제 ${v!.removed} (반영 안 된 편집 있음)` : null,
        result.skipped.length > 0
          ? `미적용 ${result.skipped.length}건:\n` + result.skipped.map(s => `  - ${s.reason}`).join("\n")
          : null,
      ].filter(Boolean)

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: render_document ───────────────────────────

server.tool(
  "render_document",
  "HWPX 문서를 실제 조판 그대로 렌더해 PNG 이미지(또는 SVG 파일)로 돌려줍니다. generate_document·fill_form·patch_document·place_seal 결과물을 눈으로 확인하는 용도 — 생성/수정 후 이 도구로 렌더해 깨짐·잘림·배치를 검증하고 다시 고치는 루프를 권장합니다. 한컴 저장본은 조판 캐시로, AI 생성본(캐시 없음)은 순수 조판 엔진(reflow)으로 렌더되며 후자는 한컴 실조판의 근사입니다 (참고용 미리보기).",
  {
    file_path: z.string().min(1).describe("렌더할 HWPX 파일의 절대 경로"),
    format: z.enum(["png", "svg"]).default("png").describe("png=이미지로 응답에 직접 반환 (sharp 필요, 기본 설치됨) / svg=output_path에 파일 저장"),
    output_path: z.string().min(1).optional().describe("결과 저장 경로 (png는 선택, svg는 필수 — 확장자는 format과 일치)"),
    highlights: z.array(z.string().min(1)).optional().describe("형광펜 표시할 검색어 목록 — 채운 값·수정 문구 위치 확인용"),
    reflow_mode: z.enum(["keep", "charAll"]).default("keep").describe("reflow 줄바꿈: keep=어절 단위, charAll=글자 단위"),
  },
  async ({ file_path, format, output_path, highlights, reflow_mode }) => {
    try {
      if (format === "svg" && !output_path) {
        return { content: [{ type: "text", text: 'format: "svg"는 output_path(.svg)가 필수입니다 — SVG 원문은 커서 응답에 직접 담지 않습니다.' }], isError: true }
      }
      const outPath = output_path
        ? safeOutputPath(output_path, new Set([format === "png" ? ".png" : ".svg"]))
        : undefined
      const { buffer } = readValidatedFile(file_path, MAX_FILE_SIZE, new Set([".hwpx"]))
      const { renderHwpxToSvg } = await import("./render/index.js")
      // reflow는 조판 캐시가 있으면 무시되므로 항상 켠다 — 한컴본·생성본 모두 커버
      const result = await renderHwpxToSvg(buffer, { highlights, reflow: true, reflowMode: reflow_mode })
      const summary = [
        `렌더 완료: ${result.pageCount}페이지, ${Math.round(result.width)}x${Math.round(result.height)}pt (텍스트 ${result.stats.texts}·이미지 ${result.stats.images}·표 ${result.stats.tables})`,
        ...result.warnings.map(w => `⚠️ ${w}`),
      ]
      if (format === "svg") {
        mkdirSync(dirname(outPath!), { recursive: true })
        writeFileSync(outPath!, result.svg, "utf-8")
        summary.push(`저장: ${outPath}`)
        return { content: [{ type: "text", text: summary.join("\n") }] }
      }
      const { rasterizeSvg } = await import("./render/rasterize.js")
      const raster = await rasterizeSvg(result.svg, result.width, result.height)
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, raster.png)
        summary.push(`저장: ${outPath}`)
      }
      summary.push(`이미지 ${raster.widthPx}x${raster.heightPx}px — 잘림·겹침·빈칸·페이지 넘침이 보이면 원인 텍스트를 수정해 다시 생성/패치하세요.`)
      return {
        content: [
          { type: "image", data: raster.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text: summary.join("\n") },
        ],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `렌더 실패: ${describeError(err)}` }],
        isError: true,
      }
    }
  },
)

// ─── 도구: redact_document ───────────────────────────

server.tool(
  "redact_document",
  "문서의 개인정보(주민번호·전화·이메일·카드·계좌)를 탐지해 서식 보존 마스킹합니다. HWPX/HWP는 원본 서식 1바이트 그대로 patch, 그 외 포맷은 마스킹된 마크다운으로 출력. 자동 검출 보조 도구 — 결과 리포트를 사람이 최종 확인해야 하며 이미지 안 텍스트는 탐지하지 못합니다. 마스킹 후 render_document로 눈으로 확인하는 것을 권장합니다.",
  {
    file_path: z.string().min(1).describe("대상 문서의 절대 경로"),
    rules: z.array(z.enum(["rrn", "phone", "email", "card", "account", "passport", "driver"])).optional()
      .describe("적용 룰 (기본: rrn·phone·email·card·account — passport·driver는 opt-in)"),
    mask_char: z.string().min(1).max(1).optional().describe("마스크 문자 1글자 (기본: ●)"),
    output_path: z.string().min(1).optional().describe("출력 경로 (HWPX/HWP는 같은 확장자, 그 외는 .md) — dry_run이 아니면 필수"),
    dry_run: z.boolean().default(false).describe("탐지 리포트만 반환, 파일 미생성"),
  },
  async ({ file_path, rules, mask_char, output_path, dry_run }) => {
    try {
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)
      const patchable = format === "hwpx" || format === "hwp"
      if (!dry_run && !output_path) {
        return { content: [{ type: "text", text: "output_path가 필요합니다 (탐지만 원하면 dry_run: true)." }], isError: true }
      }
      const outPath = !dry_run
        ? safeOutputPath(output_path!, new Set(patchable ? [format === "hwp" ? ".hwp" : ".hwpx"] : [".md", ".markdown", ".txt"]))
        : undefined
      const parsed = await parse(buffer, { filePath: file_path })
      if (!parsed.success) {
        return { content: [{ type: "text", text: `파싱 실패: ${parsed.error}` }], isError: true }
      }
      const { redactMarkdown } = await import("./redact.js")
      const r = redactMarkdown(parsed.markdown, { rules, maskChar: mask_char })
      const byRule = new Map<string, number>()
      for (const h of r.hits) byRule.set(h.rule, (byRule.get(h.rule) ?? 0) + 1)
      const lines = [
        `탐지: ${r.hits.length}건 (${[...byRule.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "없음"})`,
        ...r.hits.map(h => `  - [${h.rule}] ${h.masked}`),
      ]
      if (!dry_run && r.hits.length > 0) {
        if (patchable) {
          const original = new Uint8Array(buffer)
          const result = format === "hwp" ? await patchHwp(original, r.text) : await patchHwpx(original, r.text)
          if (!result.success || !result.data) {
            return { content: [{ type: "text", text: `마스킹 패치 실패: ${result.error ?? "알 수 없는 오류"}` }], isError: true }
          }
          mkdirSync(dirname(outPath!), { recursive: true })
          writeFileSync(outPath!, Buffer.from(result.data))
          lines.push(`저장: ${outPath} (원본 서식 보존)`)
          if (result.skipped.length > 0) {
            lines.push(`⚠️ 미적용 ${result.skipped.length}건 — 해당 위치는 원문이 남아 있으니 반드시 수동 확인:`)
            for (const s of result.skipped) lines.push(`  - ${s.reason}`)
          }
          lines.push("render_document로 마스킹 결과를 눈으로 확인하세요.")
        } else {
          mkdirSync(dirname(outPath!), { recursive: true })
          writeFileSync(outPath!, r.text, "utf-8")
          lines.push(`저장: ${outPath} (${format}는 서식 보존 미지원 — 마스킹된 마크다운)`)
        }
      } else if (!dry_run) {
        lines.push("탐지 0건 — 출력 파일을 만들지 않았습니다.")
      }
      lines.push("주의: 자동 검출은 보조 수단입니다. 이미지 속 텍스트·표기 변형은 놓칠 수 있으니 최종 공개 전 사람 검토가 필요합니다.")
      return { content: [{ type: "text", text: capResponseText(lines.join("\n")) }] }
    } catch (err) {
      return { content: [{ type: "text", text: `마스킹 실패: ${describeError(err)}` }], isError: true }
    }
  },
)

// ─── 도구: parse_chunks ──────────────────────────────

server.tool(
  "parse_chunks",
  "문서를 RAG용 구조 청크 JSON으로 파싱합니다. 헤딩·개조식 위계(□○- / 1.·가.·1))가 breadcrumb 경로로 보존되고 표는 독립 청크로 나옵니다 — 임베딩·인덱싱 전처리용. 자르기(토큰 상한·오버랩)는 소비자 몫입니다.",
  {
    file_path: z.string().min(1).describe("대상 문서의 절대 경로 (HWP/HWPX/PDF/XLSX/DOCX)"),
    granularity: z.enum(["section", "block"]).default("section").describe("section=같은 breadcrumb 아래 연속 텍스트 병합(기본), block=IRBlock 1개=청크 1개"),
    include_table_cells: z.boolean().default(false).describe("표 청크에 셀 텍스트 2차원 배열 포함 여부"),
  },
  async ({ file_path, granularity, include_table_cells }) => {
    try {
      const { buffer } = readValidatedFile(file_path)
      const parsed = await parse(buffer, { filePath: file_path })
      if (!parsed.success) {
        return { content: [{ type: "text", text: `파싱 실패: ${parsed.error}` }], isError: true }
      }
      const { blocksToChunks } = await import("./chunks.js")
      const chunks = blocksToChunks(parsed.blocks, { granularity, includeTableCells: include_table_cells })
      return { content: [{ type: "text", text: capResponseText(JSON.stringify(chunks, null, 2)) }] }
    } catch (err) {
      return { content: [{ type: "text", text: `청크 파싱 실패: ${describeError(err)}` }], isError: true }
    }
  },
)

// ─── 도구: generate_document ─────────────────────────

// ─── 도구: extract_profile ───────────────────────────

server.tool(
  "extract_profile",
  "참조 HWPX 문서에서 표 서식 프로필(테두리·음영·열 너비·셀 글꼴)을 JSON으로 추출합니다. 추출한 프로필을 generate_document의 profile_path로 넘기면 원본 문서 없이 같은 표 서식을 재현합니다 — \"이 문서 표 서식 그대로 만들어줘\" 워크플로의 1단계.",
  {
    hwpx_path: z.string().min(1).describe("서식을 추출할 참조 HWPX 파일의 절대 경로"),
    output_path: z.string().min(1).describe("프로필 JSON 출력 절대 경로 (.json 권장)"),
  },
  async ({ hwpx_path, output_path }) => {
    try {
      const out = safeOutputPath(output_path, PROFILE_EXTENSIONS)
      const { buffer } = readValidatedFile(hwpx_path)
      const { hwpxToProfile } = await import("./index.js")
      const profile = await hwpxToProfile(buffer)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, JSON.stringify(profile, null, 2))
      return {
        content: [{ type: "text", text: `서식 프로필 추출 완료: 표 ${profile.tables.length}개 → ${out}\n(generate_document의 profile_path로 사용)` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

server.tool(
  "generate_document",
  "마크다운을 HWPX 한글 문서로 생성합니다. \"보고서로/공문서로/개조식으로/계획서로 뽑아줘·만들어줘\" 요청이 이 도구입니다. 프리셋 매핑: 정부 표준 보고서(표지·목차·로마숫자 장헤더 자동)='개조식', 기안문·시행문·알림공문='기안문', 1페이지 요약보고서='보고서', 추진계획='계획서'. 표는 실측 정부 서식(헤더 음영+이중선·외곽 굵은선·내용 비례 열폭), 쪽번호·결재란·'끝.' 표시 지원. ⚠ 생성 전 확인 권장: 문서종류(보고서/기안문)·제목·기관명(org)·날짜·목차 여부가 불명확하면 사용자에게 물어보세요 — 엉뚱한 프리셋 선택이 가장 흔한 오생성 원인. 마크다운 규칙: #(h1)=문서 제목(표지), ##(h2)=장(Ⅰ Ⅱ Ⅲ 자동), 리스트 깊이=□ ○ - ㆍ 부호, ※시작 문단=참고 스타일, <right>텍스트</right>=우측정렬 출처행. (원본 서식 보존 제자리 수정은 patch_document, 서식 빈칸 채우기는 fill_form)",
  {
    markdown: z.string().min(1).describe("HWPX로 변환할 마크다운 전문. 표는 GFM 문법 사용 (예: '| 이름 | 부서 |\\n| --- | --- |\\n| 홍길동 | 기획팀 |')"),
    output_path: z.string().min(1).describe("출력 HWPX 파일의 절대 경로 (.hwpx 권장)"),
    profile_path: z.string().optional().describe("서식 프로필 JSON 경로 (extract_profile로 추출) — 참조 문서의 표 테두리·음영·열폭·셀 글꼴을 재현. 표 행·열 수와 첫 셀 텍스트가 일치하는 표에만 적용"),
    // 값 집합·범위는 gongmun-surface SSOT에서 파생 (CLI와 드리프트 불가 — v4.0.4 영역1-1)
    preset: z.enum(Object.keys(PRESET_ALIAS) as [string, ...string[]]).optional()
      .describe("공문서 프리셋 — 지정 시 한국 행정 공문서 표준 서식 적용. '개조식'=정부 표준 개조식 보고서(표지·목차·로마숫자 장 헤더 자동 + □○-※ 부호별 폰트), '보도자료'=머리박스+제목 25pt+□→ㅇ→*(각주) 체계. 미지정 시 범용 마크다운 변환"),
    font: z.enum(BODY_FONTS).optional().describe("본문 글꼴(공문서 모드): myeongjo=명조 계열(개조식·보고서·계획서는 실측 휴먼명조, 그 외 함초롬바탕), gothic=맑은 고딕"),
    body_pt: z.number().int().min(BODY_PT_RANGE.min).max(BODY_PT_RANGE.max).optional().describe("본문 글자 크기(pt, 공문서 모드). 기본: 기안문 12, 보고서·계획서·통지 15"),
    line_spacing: z.number().int().min(LINE_SPACING_RANGE.min).max(LINE_SPACING_RANGE.max).optional().describe("본문 줄간격(%, 공문서 모드). 기본: 프리셋별 실측값(기안문 160, 회의록 130 등)"),
    org: z.string().optional().describe("표지 기관명 (표지를 켜는 모든 프리셋에서 사용 가능). 미지정 시 표지에 기관명 생략"),
    date: z.string().optional().describe("표지 날짜 ('YYYY. M. D.' 표기 권장). 미지정 시 오늘 날짜"),
    toc: z.boolean().optional().describe("목차 페이지 생성 여부 — h2 목록을 Ⅰ Ⅱ Ⅲ 장으로 자동 구성. 전 프리셋 사용 가능(보도자료 제외). 미지정 시 개조식 프리셋만 켜짐"),
    cover: z.boolean().optional().describe("표지 페이지 생성 여부 — 첫 h1을 제목으로 파랑 장식 표지. 전 프리셋 사용 가능(보도자료 제외 — 머리박스 서식과 양립 불가). 미지정 시 개조식 프리셋만 켜짐 (org/date 지정 시 자동 켜짐)"),
    approval: z.array(z.string()).max(APPROVAL_MAX).optional().describe("결재란 직위 라벨 (최대 6개, 예: ['담당','팀장','과장']) — 문서 최상단 우측에 서명 공란 결재 표 생성"),
    page_numbers: z.boolean().optional().describe("쪽번호(하단 중앙 '- 1 -', 표지·목차 카운트 제외). 미지정 시 개조식·보고서·계획서 켜짐"),
    end_mark: z.boolean().optional().describe("본문 끝 '끝.' 표시 (행정업무규정). 미지정 시 기안문만 켜짐, 본문이 이미 '끝.'으로 끝나면 중복 생성 안 함"),
    body_title_box: z.boolean().optional().describe("본문 첫 페이지 제목 반복 박스 (개조식 실측 관행). 미지정 시 개조식+표지 조합에서 켜짐"),
    h2_marker: z.enum(H2_MARKERS).optional().describe("h2 섹션 제목 말머리(비개조식): box='□ 제목'(실측 보고서 관행), number='1. 제목'(공고문 관행), none=말머리 없음. 미지정 시 보고서·계획서 box, 그 외 none"),
    fonts: z.object(Object.fromEntries(FONT_ROLE_KEYS.map(k => [k, z.string().optional()])))
      .optional().describe("요소별 글꼴 오버라이드(공문서 모드) — body=본문(○·-)/heading=제목 계열(□·장헤더·표지·목차)/ref=※ 참고/table=표 셀. 개조식·보고서·계획서는 네 역할 전부, 그 외 프리셋은 body만 적용"),
    sizes: z.object(Object.fromEntries(SIZE_KEYS.map(k => [k, z.number().min(SIZE_PT_RANGE.min).max(SIZE_PT_RANGE.max).optional()])))
      .optional().describe("개조식 요소별 글자 크기(pt) 오버라이드 — dae=□/cham=※/chapter=장헤더/coverTitle·coverSub=표지/tocLabel·tocRoman·tocItem=목차/table=표 셀/bodyTitle=본문 첫 페이지 제목 반복 박스. 미지정 요소는 body_pt 비례 기본값"),
    bullet2: z.enum(BULLET2_CHARS).optional().describe("2단계 항목부호 — 'ㅇ'(이응, 전자결재 기안문·공고문 실측 지배) / '○'(원, 보고서 양식). 미지정 시 통지·보도자료 ㅇ, 그 외 ○"),
    suppress_single: z.boolean().optional().describe("단일 형제 항목 부호 생략(편람 규정, 법정 번호 standard 전용 — 불릿 체계인 보고서·계획서·개조식·보도자료엔 무효). 기본 false — 하나뿐인 항목에도 부호(1. 가.)를 부여 (부호 없는 계단 들여쓰기가 실무 눈에 어색)"),
    doc_head: z.object(Object.fromEntries(DOC_HEAD_KEYS.map(k => [k, z.string().optional()])))
      .optional().describe("기안문 두문(별지 제1호서식) — org=행정기관명(18pt bold 중앙)/to=수신/via=경유/title=제목. 기안문 프리셋 전용"),
    doc_foot: z.object(Object.fromEntries(DOC_FOOT_KEYS.map(k => [k, z.string().optional()])))
      .optional().describe("기안문 결문 — sender=발신명의(22pt 중앙)/drafter·reviewer·approver=기안·검토·결재/docNum=시행/receive=접수/disclosure=공개구분 등. 기안문 프리셋 전용"),
    report_info: z.string().optional().describe("업무보고 우상단 보고정보 행 — 예: '(2026. 7. 11., 과장 홍길동, ☎02-120)' (실측: 12pt 우측정렬)"),
    notice_head: z.object(Object.fromEntries(NOTICE_HEAD_KEYS.map(k => [k, z.string().optional()])))
      .optional().describe("공고문 두문·결문 — no=공고번호(본문 위 bold)/date=날짜(본문 아래 우측)/sender=발신명의(우측 bold). 통지 프리셋 전용"),
    press: z.object({
      release: z.string().optional(), distribute: z.string().optional(),
      sub: z.array(z.string()).optional(),
      contact: z.object(Object.fromEntries(PRESS_CONTACT_KEYS.map(k => [k, z.string().optional()]))).optional(),
    }).optional().describe("보도자료 옵션 — release=보도시점/distribute=배포일(머리박스)/sub=부제 배열('- … -')/contact=담당 부서·담당자·연락처 표"),
  },
  async ({ markdown, output_path, profile_path, preset, font, body_pt, line_spacing, org, date, toc, cover, approval, page_numbers, end_mark, body_title_box, h2_marker, fonts, sizes, bullet2, suppress_single, doc_head, doc_foot, report_info, notice_head, press }) => {
    try {
      // 조립은 gongmun-surface SSOT(buildGongmunOptions) — CLI와 의미론 공유 (v4.0.4)
      let gongmun: GongmunOptions | undefined
      if (preset) {
        gongmun = buildGongmunOptions({
          preset: PRESET_ALIAS[preset], font, bodyPt: body_pt, lineSpacing: line_spacing,
          org, date, cover, toc, approval,
          pageNumbers: page_numbers, endMark: end_mark, bodyTitleBox: body_title_box,
          h2Marker: h2_marker, fonts, sizes, bullet2, suppressSingle: suppress_single,
          docHead: doc_head, docFoot: doc_foot, reportInfo: report_info,
          noticeHead: notice_head, press,
        })
      }
      // 서식 프로필 (이슈 #41) — 경로 검증(realpath + .json) 후 경계 zod 검증 (CLI --profile과 공유 스키마)
      let profile: import("./hwpx/gen-profile.js").FormatProfile | undefined
      if (profile_path) {
        const { parseFormatProfileJson } = await import("./hwpx/profile-io.js")
        profile = parseFormatProfileJson(readFileSync(safePath(profile_path, PROFILE_EXTENSIONS), "utf-8"))
      }
      const out = safeOutputPath(output_path, new Set([".hwpx"]))
      const buf = await markdownToHwpx(markdown, gongmun || profile ? { ...(gongmun ? { gongmun } : {}), ...(profile ? { profile } : {}) } : undefined)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(buf))

      const mode = gongmun ? `공문서:${gongmun.preset}` : "범용"
      const tableCount = (markdown.match(/^\s*\|.*\|\s*$/gm) || []).length > 0
        ? `, 표 포함` : ""
      // 폰트 오버라이드 오타·미설치 경고 (A2) — 생성은 진행, 경고만 병기.
      // 프리셋 비호환 옵션(조용한 폐기)·편람 표기법 검수도 같은 채널로 병기
      const fontWarns = gongmun?.fonts ? unknownFontWarnings(gongmun.fonts) : []
      if (gongmun) fontWarns.push(...incompatibleGongmunWarnings(gongmun))
      if (gongmun) fontWarns.push(...gongmunLintWarnings(markdown, 5))
      const warnText = fontWarns.length ? `\n⚠ ${fontWarns.join("\n⚠ ")}` : ""
      return {
        content: [{ type: "text", text: `✓ HWPX 생성 (${mode}${tableCount}) → ${out}\n크기: ${(buf.byteLength / 1024).toFixed(1)}KB${warnText}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${describeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 서버 시작 ───────────────────────────────────────

/** MCP 서버 시작 (중복 호출 무해) — kordoc-mcp bin 직접 실행 시 자동, `kordoc mcp` 서브커맨드에선 CLI가 호출 */
let serverStarted = false
export async function startMcpServer(): Promise<void> {
  if (serverStarted) return
  serverStarted = true
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// 직접 실행(kordoc-mcp bin / node dist·src mcp)이 아닌 import(테스트의 헬퍼 import)에서는
// 자동 시작하지 않는다 — stdio 점유로 테스트 러너가 행. 판정 불가 시엔 기존 동작(자동 시작) 유지.
let autoStart = true
try {
  const entry = process.argv[1]
  if (entry && pathToFileURL(realpathSync(entry)).href !== import.meta.url) autoStart = false
} catch { /* 판정 실패 → 자동 시작 유지 */ }

if (autoStart) startMcpServer().catch((err) => { console.error(err); process.exit(1) })
