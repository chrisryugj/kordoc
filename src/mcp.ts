/** kordoc MCP 서버 — Claude/Cursor에서 문서 파싱 도구로 사용 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, realpathSync, openSync, readSync, closeSync, statSync } from "fs"
import { resolve, isAbsolute, extname } from "path"
import { parse, detectFormat, blocksToMarkdown, compare, extractFormFields } from "./index.js"
import { VERSION, toArrayBuffer, sanitizeError, KordocError } from "./utils.js"
import { extractHwp5MetadataOnly } from "./hwp5/parser.js"
import { extractHwpxMetadataOnly } from "./hwpx/parser.js"

/** 허용 파일 확장자 */
const ALLOWED_EXTENSIONS = new Set([".hwp", ".hwpx", ".pdf"])
/** 최대 파일 크기 (500MB) */
const MAX_FILE_SIZE = 500 * 1024 * 1024

/** 경로 정규화 및 보안 검증 */
function safePath(filePath: string): string {
  if (!filePath) throw new KordocError("파일 경로가 비어있습니다")
  const resolved = resolve(filePath)
  const real = realpathSync(resolved)
  if (!isAbsolute(real)) throw new KordocError("절대 경로만 허용됩니다")
  const ext = extname(real).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(ext)) throw new KordocError(`지원하지 않는 확장자입니다: ${ext} (허용: ${[...ALLOWED_EXTENSIONS].join(", ")})`)
  return real
}

/** 파일 읽기 + 크기 검증 공통 로직 */
function readValidatedFile(filePath: string): { buffer: ArrayBuffer; resolved: string } {
  const resolved = safePath(filePath)
  const fileSize = statSync(resolved).size
  if (fileSize > MAX_FILE_SIZE) {
    throw new KordocError(`파일이 너무 큽니다: ${(fileSize / 1024 / 1024).toFixed(1)}MB (최대 ${MAX_FILE_SIZE / 1024 / 1024}MB)`)
  }
  const raw = readFileSync(resolved)
  return { buffer: toArrayBuffer(raw), resolved }
}

const server = new McpServer({
  name: "kordoc",
  version: VERSION,
})

// ─── 도구: parse_document ────────────────────────────

server.tool(
  "parse_document",
  "한국 문서 파일(HWP, HWPX, PDF)을 마크다운으로 변환합니다. 파일 경로를 입력하면 포맷을 자동 감지하여 텍스트를 추출합니다.",
  {
    file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로 (HWP, HWPX, PDF)"),
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
      // 전체 파일 대신 첫 16바이트만 읽기 — 대용량 파일 OOM 방지
      const fd = openSync(resolved, "r")
      let headerBuf: Buffer
      try {
        headerBuf = Buffer.alloc(16)
        readSync(fd, headerBuf, 0, 16, 0)
      } finally {
        closeSync(fd)
      }
      const header = toArrayBuffer(headerBuf)
      const format = detectFormat(header)
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
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)

      let metadata
      switch (format) {
        case "hwp":
          metadata = extractHwp5MetadataOnly(Buffer.from(buffer))
          break
        case "hwpx":
          metadata = await extractHwpxMetadataOnly(buffer)
          break
        case "pdf": {
          const { extractPdfMetadataOnly } = await import("./pdf/parser.js")
          metadata = await extractPdfMetadataOnly(buffer)
          break
        }
        default:
          return {
            content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
            isError: true,
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

// ─── 서버 시작 ───────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

main().catch((err) => { console.error(err); process.exit(1) })
