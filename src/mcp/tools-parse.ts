/** kordoc MCP 도구 — 문서 읽기 — parse_document·detect_format·parse_metadata·parse_pages·parse_table·compare_documents·parse_chunks */

import { z } from "zod"
import { parse, detectFormat, detectZipFormat, detectOle2Format, blocksToMarkdown, compare } from "../index.js"
import { KordocError } from "../utils.js"
import { extractHwp5MetadataOnly } from "../hwp5/parser.js"
import { extractHwpxMetadataOnly } from "../hwpx/parser.js"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { PARSE_EXTENSIONS, MAX_FILE_SIZE, safePath, describeError, capResponseText, MAX_METADATA_FILE_SIZE, readValidatedFile, detectFormatFromHeader } from "./shared.js"

export function registerParseTools(server: McpServer): void {
  // ─── 도구: parse_document ────────────────────────────

  server.tool(
    "parse_document",
    "한국 문서 파일(HWP, HWPX, PDF, XLSX, DOCX)과 이미지(PNG/JPG/WebP)를 마크다운으로 변환합니다. 파일 경로를 입력하면 포맷을 자동 감지하여 텍스트를 추출합니다. 이미지는 OCR(내장 PP-OCRv5)이 자동 적용되고 표 괘선도 복원됩니다.",
    {
      file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로 (HWP, HWPX, PDF, XLSX, DOCX, PNG/JPG/WebP)"),
      ocr: z.union([z.boolean(), z.literal("force")]).optional()
        .describe("스캔/이미지 PDF 텍스트 OCR (내장 PP-OCRv5 korean, 첫 사용 시 ~18MB 자동 다운로드). true=텍스트층이 없거나 깨진 페이지만 인식하고 정상 페이지는 그대로 둡니다. \"force\"=텍스트층이 있어도 무시하고 전 페이지 강제 재인식. parse 결과에 NEEDS_OCR 경고가 있으면 이 옵션으로 재시도하세요"),
      remove_header_footer: z.boolean().optional()
        .describe("PDF 머리글/바닥글 자동 제거 (기본 true — false로 끄기, CLI --no-header-footer 대응)"),
      formula_ocr: z.boolean().optional()
        .describe("PDF 수식 OCR 활성화 (MFD+MFR ONNX, 첫 사용 시 모델 ~155MB 자동 다운로드, CLI --formula-ocr 대응)"),
      dedupe_running_headers: z.boolean().optional()
        .describe("HWP5 레이아웃 표 페이지 반복 러닝 헤더 중복 제거 (기본 off — 붙임별 재번호 오삭제 주의, CLI --dedupe-headers 대응)"),
      keep_trailing_empty_cols: z.boolean().optional()
        .describe("표 오른쪽 끝 빈 열(서식 입력란) 보존 (#47, 기본 off: 후행 빈 열 트림, CLI --keep-empty-cols 대응)"),
      keep_empty_paragraphs: z.boolean().optional()
        .describe("빈 문단 보존 — 본문은 빈 paragraph 블록, 표 셀은 빈 줄 (#57, 기본 off, CLI --keep-empty-paragraphs 대응)"),
      password: z.string().optional()
        .describe("암호로 보호된 문서의 열기 암호 (#59, HWPX·HWP3·HWP5 지원. 파싱이 ENCRYPTED로 실패하면 이 옵션으로 재시도하세요. 한컴 DRM 보호 문서는 해당 없음)"),
      tables: z.boolean().optional()
        .describe("PDF 표 감지 (기본 true — false로 끄기, CLI --no-tables 대응). 테두리 박스를 표로 오인해 읽기 순서가 뒤집히는 문서(2단 시험지 등)에서 자연 읽기순 텍스트만 뽑습니다 (#64)"),
    },
    async ({ file_path, ocr, remove_header_footer, formula_ocr, dedupe_running_headers, keep_trailing_empty_cols, keep_empty_paragraphs, password, tables }) => {
      try {
        const { buffer, resolved } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
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
        const result = await parse(buffer, {
          filePath: resolved,
          ...(ocr !== undefined ? { ocr } : {}),
          ...(remove_header_footer !== undefined ? { removeHeaderFooter: remove_header_footer } : {}),
          ...(formula_ocr ? { formulaOcr: true } : {}),
          ...(dedupe_running_headers ? { dedupeRunningHeaders: true } : {}),
          ...(keep_trailing_empty_cols ? { keepTrailingEmptyCols: true } : {}),
          ...(keep_empty_paragraphs ? { keepEmptyParagraphs: true } : {}),
          ...(password ? { password } : {}),
          ...(tables === false ? { tables: false } : {}),
        })

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
          result.isImageBased
            ? (result.warnings?.some(w => w.code === "OCR_APPLIED") ? "이미지 기반 PDF (OCR 적용)" : "이미지 기반 PDF (텍스트 추출 불가 — ocr: true 로 재시도 가능)")
            : null,
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
    "파일의 포맷을 매직 바이트와 컨테이너 내부 구조로 감지합니다 (hwpx, hwp, hwp3, hwpml, pdf, xls, xlsx, docx, pptx, image, unknown). PPTX는 감지만 지원합니다.",
    {
      file_path: z.string().min(1).describe("감지할 파일의 절대 경로"),
    },
    async ({ file_path }) => {
      try {
        const resolved = safePath(file_path, PARSE_EXTENSIONS)
        let format: string = detectFormatFromHeader(resolved)
        // 16바이트 헤더로는 모든 ZIP이 'hwpx'로 나온다 — 파일을 읽어 내부 구조로
        // hwpx/xlsx/docx/pptx 세분화 (parse_metadata와 판정 일치)
        // 크기 상한은 parse_document와 동일(500MB) — 50MB 초과 ZIP 감지 실패 방지
        if (format === "hwpx") {
          const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
          format = await detectZipFormat(buffer)
        } else if (format === "hwp") {
          // OLE2 도 동일하게 세분화 — .xls(Excel 97-2003)를 'hwp'로 보고하던 누락 (parse()와 판정 일치)
          const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
          const ole2Format = detectOle2Format(buffer)
          if (ole2Format !== "unknown") format = ole2Format
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
        const resolved = safePath(file_path, PARSE_EXTENSIONS)
        const format = detectFormatFromHeader(resolved)

        if (format === "unknown") {
          return {
            content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
            isError: true,
          }
        }

        // metadata 전용 크기 제한 (50MB)
        const { buffer } = await readValidatedFile(file_path, MAX_METADATA_FILE_SIZE, PARSE_EXTENSIONS)

        let metadata
        // ZIP(hwpx→xlsx/docx/pptx)·OLE2(hwp→xls) 모두 내부 구조로 세분화 — parse()와 판정 일치
        let effectiveFormat: ReturnType<typeof detectFormat> = format
        if (format === "hwpx") {
          const zipFormat = await detectZipFormat(buffer)
          if (zipFormat !== "unknown") effectiveFormat = zipFormat
        } else if (format === "hwp") {
          if (detectOle2Format(buffer) === "xls") effectiveFormat = "xls"
        }
        switch (effectiveFormat) {
          case "pptx":
            throw new KordocError("PPTX 파일은 지원하지 않는 파일 형식입니다.")
          case "hwp":
            metadata = extractHwp5MetadataOnly(Buffer.from(buffer))
            break
          case "hwpx":
            metadata = await extractHwpxMetadataOnly(buffer)
            break
          case "pdf":
            try {
              const { extractPdfMetadataOnly } = await import("../pdf/parser.js")
              metadata = await extractPdfMetadataOnly(buffer)
            } catch {
              metadata = undefined // pdfjs-dist 미설치 시 metadata 생략
            }
            break
          case "hwp3":
          case "hwpml":
          case "xls":
          case "xlsx":
          case "docx": {
            // 전용 metadata 추출기가 없는 포맷은 전체 파싱 후 metadata 반환
            const result = await parse(buffer)
            metadata = result.success ? result.metadata : undefined
            break
          }
          default:
            // image 등 — 헤더성 메타데이터 없음. 무음 undefined 대신 포맷만 정직하게 반환.
            metadata = undefined
            break
        }

        return {
          content: [{ type: "text", text: JSON.stringify({ format: effectiveFormat, ...metadata }, null, 2) }],
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
    "문서의 특정 페이지 범위만 파싱합니다. PDF와 한컴 저장본 HWP/HWPX는 실제 페이지 기준(metadata.pageMode=layout), 조판 캐시가 없는 생성 파일은 섹션 단위 근사(pageMode=section)입니다.",
    {
      file_path: z.string().min(1).describe("파싱할 문서 파일의 절대 경로"),
      pages: z.string().min(1).describe("페이지 범위 (예: '1-3', '1,3,5-7')"),
    },
    async ({ file_path, pages }) => {
      try {
        const resolved = safePath(file_path, PARSE_EXTENSIONS)
        const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
        const format = detectFormat(buffer)

        if (format === "unknown") {
          return {
            content: [{ type: "text", text: `지원하지 않는 파일 형식입니다: ${file_path}` }],
            isError: true,
          }
        }

        // filePath 전달 — 배포용 HWP의 COM fallback에 필요 (parse_document·parse_chunks와 동일)
        const result = await parse(buffer, { pages, filePath: resolved })

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
          result.metadata?.pageMode === "section" ? "기준: 섹션 근사" : null,
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
        const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
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
        const { buffer: bufA } = await readValidatedFile(file_path_a)
        const { buffer: bufB } = await readValidatedFile(file_path_b)

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
        const { buffer } = await readValidatedFile(file_path, MAX_FILE_SIZE, PARSE_EXTENSIONS)
        const parsed = await parse(buffer, { filePath: file_path })
        if (!parsed.success) {
          return { content: [{ type: "text", text: `파싱 실패: ${parsed.error}` }], isError: true }
        }
        const { blocksToChunks } = await import("../chunks.js")
        const chunks = blocksToChunks(parsed.blocks, { granularity, includeTableCells: include_table_cells })
        return { content: [{ type: "text", text: capResponseText(JSON.stringify(chunks, null, 2)) }] }
      } catch (err) {
        return { content: [{ type: "text", text: `청크 파싱 실패: ${describeError(err)}` }], isError: true }
      }
    },
  )
}
