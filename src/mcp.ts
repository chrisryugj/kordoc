/** kordoc MCP 서버 — Claude/Cursor에서 문서 파싱 도구로 사용 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, statSync, mkdirSync } from "fs"
import { resolve, isAbsolute, extname, dirname } from "path"
import { parse, detectFormat, detectZipFormat, blocksToMarkdown, compare, extractFormFields, fillFormFields, markdownToHwpx, fillHwpx } from "./index.js"
import { VERSION, toArrayBuffer, sanitizeError, KordocError } from "./utils.js"
import { extractHwp5MetadataOnly } from "./hwp5/parser.js"
import { extractHwpxMetadataOnly } from "./hwpx/parser.js"
// pdfjs-dist는 optional — dynamic import로 지연 로드
// import { extractPdfMetadataOnly } from "./pdf/parser.js"

/** 허용 파일 확장자 */
const ALLOWED_EXTENSIONS = new Set([".hwp", ".hwpx", ".pdf", ".xlsx", ".docx"])
/** 최대 파일 크기 (500MB) */
const MAX_FILE_SIZE = 500 * 1024 * 1024

/** 경로 정규화 및 보안 검증 */
function safePath(filePath: string): string {
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
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new KordocError(`지원하지 않는 확장자입니다: ${ext} (허용: ${[...ALLOWED_EXTENSIONS].join(", ")})`)
  return real
}

/** 최대 파일 크기 — metadata 전용 (50MB, 전체 파싱보다 보수적) */
const MAX_METADATA_FILE_SIZE = 50 * 1024 * 1024

/** 파일 읽기 + 크기 검증 공통 로직 */
function readValidatedFile(filePath: string, maxSize = MAX_FILE_SIZE): { buffer: ArrayBuffer; resolved: string } {
  const resolved = safePath(filePath)
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

/** 파일 헤더(16바이트)만 읽어 포맷 감지 — 전체 파일 로드 불필요 */
function detectFormatFromHeader(resolved: string): ReturnType<typeof detectFormat> {
  const fd = openSync(resolved, "r")
  try {
    const headerBuf = Buffer.alloc(16)
    readSync(fd, headerBuf, 0, 16, 0)
    return detectFormat(toArrayBuffer(headerBuf))
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

      parts.push(`\n\n${result.markdown}`)

      return {
        content: [{ type: "text", text: parts.join("") }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: detect_format ─────────────────────────────

server.tool(
  "detect_format",
  "파일의 포맷을 매직 바이트로 감지합니다 (hwpx, hwp, pdf, unknown).",
  {
    file_path: z.string().min(1).describe("감지할 파일의 절대 경로"),
  },
  async ({ file_path }) => {
    try {
      const resolved = safePath(file_path)
      const format = detectFormatFromHeader(resolved)
      return {
        content: [{ type: "text", text: `${file_path}: ${format}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
        case "xlsx":
        case "docx": {
          // XLSX/DOCX는 전용 metadata 추출기가 없으므로 전체 파싱 후 metadata 반환
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: fill_form ───────────────────────────────

server.tool(
  "fill_form",
  "한국 서식 문서의 빈칸을 채워서 새 문서로 출력합니다. hwpx-preserve를 사용하면 원본 서식(테두리, 폰트, 병합 등)을 100% 유지합니다.",
  {
    file_path: z.string().min(1).describe("서식 템플릿 문서의 절대 경로 (HWP, HWPX, PDF, XLSX, DOCX)"),
    fields: z.record(z.string(), z.string()).describe("채울 필드 맵 (라벨 → 값). 예: {\"성명\": \"홍길동\", \"전화번호\": \"010-1234-5678\"}"),
    output_format: z.enum(["markdown", "hwpx", "hwpx-preserve"]).default("hwpx-preserve").describe("출력 포맷: hwpx-preserve (원본 스타일 보존, HWPX 전용), hwpx (새 HWPX 생성), markdown"),
    output_path: z.string().optional().describe("출력 파일 저장 경로 (선택). 지정 시 파일로 저장, 미지정 시 텍스트로 반환"),
  },
  async ({ file_path, fields, output_format, output_path }) => {
    try {
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

        const hwpxResult = await fillHwpx(buffer, fields)
        const summary = [
          `채워진 필드: ${hwpxResult.filled.length}개 (원본 스타일 보존)`,
          hwpxResult.unmatched.length > 0 ? `매칭 실패: ${hwpxResult.unmatched.join(", ")}` : null,
        ].filter(Boolean).join(" | ")

        const filledList = hwpxResult.filled.map(f => `  - ${f.label}: ${f.value}`).join("\n")

        if (output_path) {
          mkdirSync(dirname(resolve(output_path)), { recursive: true })
          writeFileSync(resolve(output_path), Buffer.from(hwpxResult.buffer))
          return {
            content: [{ type: "text", text: `[${summary}]\n\n채워진 필드:\n${filledList}\n\nHWPX 파일 저장 (원본 서식 유지): ${resolve(output_path)}` }],
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
      const fillResult = fillFormFields(result.blocks, fields)

      if (fillResult.filled.length === 0 && formInfo.fields.length === 0) {
        return {
          content: [{ type: "text", text: `서식 필드를 찾을 수 없습니다. 일반 문서이거나 서식 패턴이 감지되지 않았습니다.` }],
          isError: true,
        }
      }

      const markdown = blocksToMarkdown(fillResult.blocks)
      const summary = [
        `채워진 필드: ${fillResult.filled.length}개`,
        fillResult.unmatched.length > 0 ? `매칭 실패: ${fillResult.unmatched.join(", ")}` : null,
        formInfo.fields.length > 0 ? `서식 필드: ${formInfo.fields.length}개 (확신도 ${(formInfo.confidence * 100).toFixed(0)}%)` : null,
      ].filter(Boolean).join(" | ")

      if (output_format === "hwpx") {
        const hwpxBuffer = await markdownToHwpx(markdown)
        if (output_path) {
          mkdirSync(dirname(resolve(output_path)), { recursive: true })
          writeFileSync(resolve(output_path), Buffer.from(hwpxBuffer))
          return {
            content: [{ type: "text", text: `[${summary}]\n\nHWPX 파일 저장: ${resolve(output_path)}` }],
          }
        }
        return {
          content: [{ type: "text", text: `[${summary}]\n\n⚠️ output_path를 지정하면 HWPX 파일로 저장됩니다. 미리보기:\n\n${markdown}` }],
        }
      }

      // markdown
      if (output_path) {
        mkdirSync(dirname(resolve(output_path)), { recursive: true })
        writeFileSync(resolve(output_path), markdown, "utf-8")
        return {
          content: [{ type: "text", text: `[${summary}]\n\n마크다운 파일 저장: ${resolve(output_path)}\n\n${markdown}` }],
        }
      }
      return {
        content: [{ type: "text", text: `[${summary}]\n\n${markdown}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 서버 시작 ───────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => { console.error(err); process.exit(1) })
