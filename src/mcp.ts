/** kordoc MCP 서버 — Claude/Cursor에서 문서 파싱 도구로 사용 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { readFileSync, writeFileSync, realpathSync, openSync, readSync, closeSync, statSync, mkdirSync } from "fs"
import { resolve, isAbsolute, extname, dirname } from "path"
import { parse, detectFormat, detectZipFormat, blocksToMarkdown, compare, extractFormFields, fillFormFields, markdownToHwpx, fillHwpx, patchHwpx, patchHwp } from "./index.js"
import { fillWithUniqueGuard, type FillInput } from "./form/match.js"
import type { GongmunOptions } from "./index.js"
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

      // 이미지는 파일 참조(image_NNN)로 둔다 — MCP 텍스트 응답에 base64 를 인라인해도
      // 모델은 data URI 를 이미지로 해석하지 못하고, 사진 한 장(≈100KB → base64 133KB)
      // 만으로 클라이언트 도구 응답 한도(Claude Code 기본 25k 토큰)를 넘겨 호출 자체가
      // 깨진다(v3.18.0 회귀). 자체 완결형 마크다운이 필요하면 CLI `--inline-images`.
      const result = await parse(buffer)

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

/** fields + formats 를 FillInput 맵으로 결합 (formats의 라벨은 fields와 동일 표기 기준) */
function buildFillInputs(fields: Record<string, string>, formats?: Record<string, string>): Record<string, FillInput> {
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
        if (output_path) {
          mkdirSync(dirname(resolve(output_path)), { recursive: true })
          writeFileSync(resolve(output_path), Buffer.from(hwpxBuffer))
          return {
            content: [{ type: "text", text: `[${summary}]\n\nHWPX 파일 저장: ${resolve(output_path)}` }],
          }
        }
        return {
          content: [{ type: "text", text: `[${summary}]\n\n⚠️ output_path를 지정하면 HWPX 파일로 저장됩니다. 미리보기:\n\n${previewMd}` }],
        }
      }

      // markdown
      if (output_path) {
        mkdirSync(dirname(resolve(output_path)), { recursive: true })
        writeFileSync(resolve(output_path), markdown, "utf-8")
        return {
          content: [{ type: "text", text: `[${summary}]\n\n마크다운 파일 저장: ${resolve(output_path)}\n\n${previewMd}` }],
        }
      }
      return {
        content: [{ type: "text", text: `[${summary}]\n\n${previewMd}` }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
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
      const { buffer } = readValidatedFile(file_path)
      const format = detectFormat(buffer)
      if (format !== "hwpx") {
        return {
          content: [{ type: "text", text: `place_seal 은 HWPX 파일만 지원합니다 (감지된 포맷: ${format}).` }],
          isError: true,
        }
      }
      const imgResolved = resolve(image_path)
      if (statSync(imgResolved).size > 500 * 1024 * 1024) {
        return { content: [{ type: "text", text: `도장 이미지가 너무 큽니다 (${(statSync(imgResolved).size / 1024 / 1024).toFixed(0)}MB) — 500MB 이하여야 합니다.` }], isError: true }
      }
      const image = new Uint8Array(readFileSync(imgResolved))
      const ext = (extname(image_path).slice(1).toLowerCase() || "png") as "png" | "jpg" | "jpeg" | "bmp" | "gif"
      const { placeSealHwpx } = await import("./form/seal.js")
      const result = await placeSealHwpx(buffer, [{
        anchor, occurrence, image, ext,
        sizeMm: size_mm, mode, dxMm: dx_mm, dyMm: dy_mm,
      }])
      mkdirSync(dirname(resolve(output_path)), { recursive: true })
      writeFileSync(resolve(output_path), Buffer.from(result.buffer))
      const p0 = result.placed[0]
      const warnLines = (p0.warnings ?? []).map(w => `\n⚠️ ${w}`).join("")
      return {
        content: [{
          type: "text",
          text: `도장 배치 완료: "${p0.anchor}" #${p0.occurrence} → ${p0.mode} (x ${p0.posXMm}mm, y ${p0.posYMm}mm, ${p0.sizeMm}mm각, ${p0.entry})\n저장: ${resolve(output_path)}${warnLines}\n표/페이지 불확장(글 앞 부유) — 한컴에서 위치 확인 후 dx_mm/dy_mm 로 미세조정 가능합니다.`,
        }],
      }
    } catch (err) {
      return {
        content: [{ type: "text", text: `도장 배치 실패: ${sanitizeError(err)}` }],
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

      const out = resolve(output_path)
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
        content: [{ type: "text", text: `오류: ${sanitizeError(err)}` }],
        isError: true,
      }
    }
  }
)

// ─── 도구: generate_document ─────────────────────────

server.tool(
  "generate_document",
  "마크다운을 HWPX 한글 문서로 생성합니다. GFM 표(| 헤더 | … |)·헤딩·리스트·볼드를 한글 문서 요소로 변환하며, 공문서 프리셋 지정 시 행정 표준 서식(항목부호 8단계·공식 여백·명조 15pt)으로 렌더링합니다. 활용: 평문 문장을 표로 구조화해 새 한글파일로 만들거나, parse_document로 읽은 내용을 편집해 다시 HWPX로 출력. (원본 서식을 보존하며 일부 텍스트/표만 제자리 수정하려면 patch_document 사용)",
  {
    markdown: z.string().min(1).describe("HWPX로 변환할 마크다운 전문. 표는 GFM 문법 사용 (예: '| 이름 | 부서 |\\n| --- | --- |\\n| 홍길동 | 기획팀 |')"),
    output_path: z.string().min(1).describe("출력 HWPX 파일의 절대 경로 (.hwpx 권장)"),
    preset: z.enum(["기안문", "보고서", "계획서", "통지", "회의록", "official", "report", "plan", "notice", "minutes"]).optional()
      .describe("공문서 프리셋 — 지정 시 한국 행정 공문서 표준 서식 적용. 미지정 시 범용 마크다운 변환"),
    font: z.enum(["myeongjo", "gothic"]).optional().describe("본문 글꼴(공문서 모드): myeongjo=함초롬바탕(명조), gothic=맑은 고딕"),
    body_pt: z.number().int().min(6).max(40).optional().describe("본문 글자 크기(pt, 공문서 모드). 기본 15"),
  },
  async ({ markdown, output_path, preset, font, body_pt }) => {
    try {
      let gongmun: GongmunOptions | undefined
      if (preset) {
        gongmun = { preset }
        if (font) gongmun.bodyFont = font
        if (body_pt) gongmun.bodyPt = body_pt
      }
      const buf = await markdownToHwpx(markdown, gongmun ? { gongmun } : undefined)
      const out = resolve(output_path)
      mkdirSync(dirname(out), { recursive: true })
      writeFileSync(out, Buffer.from(buf))

      const mode = gongmun ? `공문서:${gongmun.preset}` : "범용"
      const tableCount = (markdown.match(/^\s*\|.*\|\s*$/gm) || []).length > 0
        ? `, 표 포함` : ""
      return {
        content: [{ type: "text", text: `✓ HWPX 생성 (${mode}${tableCount}) → ${out}\n크기: ${(buf.byteLength / 1024).toFixed(1)}KB` }],
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
