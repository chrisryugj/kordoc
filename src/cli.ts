/** kordoc CLI — 모두 파싱해버리겠다 (하위 명령은 cli/ 아래 명령군 모듈) */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, resolve } from "path"
import { Command } from "commander"
import { parse, detectFormat } from "./index.js"
import type { ParseOptions } from "./types.js"
import { VERSION, toArrayBuffer, sanitizeError, classifyError } from "./utils.js"
import { detectImageMime } from "./hwp5/images.js"
import { registerDocCommands } from "./cli/commands-docs.js"
import { registerGenerateCommands } from "./cli/commands-generate.js"
import { registerRenderCommands } from "./cli/commands-render.js"
import { registerSystemCommands } from "./cli/commands-system.js"

const program = new Command()

program
  .name("kordoc")
  .description("모두 파싱해버리겠다 — HWP, HWPX, PDF, XLSX, DOCX, 이미지(PNG/JPG/WebP) → Markdown")
  .version(VERSION)
  .argument("<files...>", "변환할 파일 경로 (HWP, HWPX, PDF, XLSX, DOCX, PNG/JPG/WebP — 이미지는 OCR 자동 적용)")
  .option("-o, --output <path>", "출력 파일 경로 (단일 파일 시)")
  .option("-d, --out-dir <dir>", "출력 디렉토리 (다중 파일 시)")
  .option("-p, --pages <range>", "페이지 범위 (예: 1-3, 1,3,5) — 한컴 저장본은 실제 페이지, 조판 캐시 없으면 섹션 근사")
  .option("--format <type>", "출력 형식: markdown (기본), json, chunks (RAG용 구조 청크 JSON — 헤딩·개조식 위계 breadcrumb + 표 독립 청크)", "markdown")
  .option("--no-header-footer", "PDF 머리글/바닥글 자동 제거 끄기 (기본: 제거함)")
  .option("--no-tables", "PDF 표 감지 끄기 — 테두리 박스를 표로 오인해 읽기 순서가 뒤집히는 문서(2단 시험지 등)에서 자연 읽기순 텍스트만 뽑는다 (#64)")
  .option("--formula-ocr", "PDF 수식 OCR 활성화 (MFD+MFR ONNX, 첫 사용 시 모델 ~155MB 자동 다운로드)")
  .option("--ocr", "스캔/이미지 PDF 텍스트 OCR (내장 PP-OCRv5 korean, 첫 사용 시 모델 ~18MB 자동 다운로드 — OCR 필요 페이지만 인식)")
  .option("--ocr-force", "전 페이지 강제 OCR (텍스트층이 있어도 무시하고 재인식)")
  .option("--dedupe-headers", "HWP5 레이아웃 표 페이지 반복 러닝 헤더 중복 제거 (기본 off — 붙임별 재번호 오삭제 주의)")
  .option("--keep-empty-cols", "표 오른쪽 끝 빈 열(서식 입력란) 보존 (#47, 기본 off: 후행 빈 열 트림)")
  .option("--keep-empty-paragraphs", "빈 문단 보존 — 본문은 빈 paragraph 블록, 표 셀은 빈 줄로 (#57, 기본 off: 빈 문단 제거)")
  .option("--inline-images", "이미지를 base64 data URI 로 마크다운에 인라인 (BMP→PNG 압축, HWP5 전용 — 인라인된 경우만 파일 미저장, 그 외 포맷은 저장 유지)")
  .option("--image-refs", "--format json 에서 이미지 바이트를 인라인하지 않고 파일 참조(images/<파일명>)만 남김 (#65 — 이미지가 수백 장인 문서의 직렬화 한계 회피, -o/-d 와 함께 사용)")
  .option("--password <pw>", "암호로 보호된 문서의 열기 암호 (#59, HWPX·HWP3·HWP5. 한컴 DRM 문서는 해당 없음)")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (files: string[], opts) => {
    const validFormats = ["markdown", "json", "chunks"]
    if (!validFormats.includes(opts.format)) {
      process.stderr.write(`[kordoc] 지원하지 않는 형식: ${opts.format} (markdown, json, chunks)\n`)
      process.exit(1)
    }
    // -o는 단일 파일 전용 — 다중 파일에서 무음 무시되지 않게 경고
    if (opts.output && files.length > 1) {
      process.stderr.write(`[kordoc] ⚠️ -o/--output 은 단일 파일 전용이라 무시됩니다 — 다중 파일은 -d/--out-dir 를 사용하세요\n`)
    }
    for (let fi = 0; fi < files.length; fi++) {
      const filePath = files[fi]
      const absPath = resolve(filePath)
      const fileName = basename(absPath)
      const filePrefix = files.length > 1 ? `[${fi + 1}/${files.length}] ` : ""
      let detectedFormat: ReturnType<typeof detectFormat> = "unknown"

      try {
        const fileSize = statSync(absPath).size
        if (fileSize > 500 * 1024 * 1024) {
          process.stderr.write(`\n[kordoc] SKIP: ${fileName} — 파일이 너무 큽니다 (${(fileSize / 1024 / 1024).toFixed(1)}MB)\n`)
          process.exitCode = 1
          continue
        }
        const buffer = readFileSync(absPath)
        const arrayBuffer = toArrayBuffer(buffer)
        const format = detectFormat(arrayBuffer)
        detectedFormat = format

        if (!opts.silent) {
          process.stderr.write(`[kordoc] ${filePrefix}${fileName} (${format}) ...`)
        }

        const parseOptions: ParseOptions = { filePath: absPath }
        if (opts.pages) parseOptions.pages = opts.pages as string
        if (opts.headerFooter === false) parseOptions.removeHeaderFooter = false
        if (opts.tables === false) parseOptions.tables = false
        if (opts.formulaOcr) parseOptions.formulaOcr = true
        if (opts.ocrForce) parseOptions.ocr = "force"
        else if (opts.ocr) parseOptions.ocr = true
        if (opts.dedupeHeaders) parseOptions.dedupeRunningHeaders = true
        if (opts.keepEmptyCols) parseOptions.keepTrailingEmptyCols = true
        if (opts.keepEmptyParagraphs) parseOptions.keepEmptyParagraphs = true
        if (opts.inlineImages) parseOptions.inlineImages = true
        if (opts.password) parseOptions.password = opts.password as string
        if (!opts.silent) {
          parseOptions.onProgress = (current: number, total: number) => {
            process.stderr.write(`\r[kordoc] ${filePrefix}${fileName} (${format}) [${current}/${total}]`)
          }
        }
        const result = await parse(arrayBuffer, parseOptions)
        detectedFormat = result.fileType  // ZIP 세분화(xlsx·docx) 반영 — 실패 JSON 의 fileType

        if (!result.success) {
          process.stderr.write(` FAIL\n`)
          process.stderr.write(`  → ${result.error}\n`)
          // 실패는 모든 --format 에서 stdout 에 동일한 실패 JSON(success:false + code)을 낸다(#69)
          // — 호출자가 원인 코드(ENCRYPTED 등)로 분기할 수 있는 기계 계약. 성공 출력과 충돌하지
          // 않는다: markdown 성공은 마크다운, chunks 성공은 JSON 배열이고 실패는 객체 + exit 1.
          // stderr 의 FAIL 문구는 사람용으로 그대로 둔다.
          process.stdout.write(JSON.stringify(result, null, 2) + "\n")
          process.exitCode = 1
          continue
        }

        if (!opts.silent) process.stderr.write(` OK\n`)

        let markdown = result.markdown
        // 이미지 인라인은 HWP5 경로에서만 실제로 일어난다(parser.ts). 그 외 포맷(HWPX/DOCX 등)은
        // --inline-images 를 줘도 인라인되지 않으므로, 이미지 저장/경로접두사를 생략하면 참조가
        // 깨지고(dangling) 바이트가 유실된다 → 실제 인라인된 경우에만 생략한다.
        const imagesInlined = opts.inlineImages && result.fileType === "hwp"
        // --out-dir 시 이미지 참조 경로에 images/ 접두사 추가 (인라인 모드에선 이미지가 마크다운에 임베드되므로 건너뜀)
        // <img src> 는 병합/중첩 표 셀 경로(table/builder.ts) — 마크다운 문법과 함께 둘 다 바꿔야 참조가 안 깨진다
        if (opts.outDir && result.images?.length && !imagesInlined) {
          markdown = markdown
            .replace(/!\[image\]\(image_/g, "![image](images/image_")
            .replace(/(<img\b[^>]*\bsrc=")image_/g, "$1images/image_")
        }
        // json 직렬화 — refsOnly면 이미지 바이트를 빼고 저장 경로만 남긴다.
        // 이미지가 수백 장인 문서는 base64 총량이 V8 문자열 한계를 넘어 RangeError 로
        // 터졌고, 그 예외가 성공 로그 뒤 비-JSON 출력이 되어 파이프라인이 깨졌다 (#65).
        const serializeJson = (refsOnly: boolean): string => {
          const payload = refsOnly && result.images?.length
            ? { ...result, images: result.images.map(img => ({ filename: img.filename, mimeType: img.mimeType, path: `images/${img.filename}` })) }
            : result
          return JSON.stringify(payload, (_key, value) =>
            value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value
          , 2)
        }
        let output: string
        if (opts.format === "json") {
          const savesImages = Boolean((opts.output && files.length === 1) || opts.outDir) && !imagesInlined
          try {
            output = serializeJson(Boolean(opts.imageRefs) && savesImages)
          } catch (err) {
            // 한계 초과 — 이미지를 어차피 파일로 저장하는 실행이면 참조 모드로 자동 강등한다.
            // 저장 위치가 없으면(stdout) 구제할 방법이 없으므로 실패 JSON 계약으로 넘긴다.
            if (!savesImages || !result.images?.length) throw err
            output = serializeJson(true)
            process.stderr.write(`  ⚠️ 이미지 base64 인라인이 직렬화 한계를 넘어 파일 참조로 대체했습니다 (${result.images.length}개 → images/)\n`)
          }
        } else if (opts.format === "chunks") {
          const { blocksToChunks } = await import("./chunks.js")
          output = JSON.stringify(blocksToChunks(result.blocks), null, 2)
        } else {
          output = markdown
        }

        // 이미지 저장 (--out-dir 또는 --output 시) — 실제 인라인된 경우(HWP5)에만 미저장, 그 외엔 저장 유지
        const saveImages = (dir: string) => {
          if (!result.images?.length || imagesInlined) return
          const imgDir = resolve(dir, "images")
          mkdirSync(imgDir, { recursive: true })
          for (const img of result.images) {
            writeFileSync(resolve(imgDir, img.filename), img.data)
          }
          // images/manifest.json — 소비자가 확장자·매직바이트 추측 없이 형식 분기(#70).
          // mimeType 은 매직바이트 실측 우선 — 확장자 유래 선언값은 실데이터와 어긋날 수 있다.
          const manifest = result.images.map(img => ({
            name: img.filename,
            mimeType: detectImageMime(img.data) ?? img.mimeType,
            bytes: img.data.length,
            ...(img.source ? { source: img.source } : {}),
          }))
          writeFileSync(resolve(imgDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${result.images.length}개 이미지 → ${imgDir} (manifest.json 포함)\n`)
        }

        if (opts.output && files.length === 1) {
          writeFileSync(opts.output, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${opts.output}\n`)
          saveImages(resolve(opts.output, ".."))
        } else if (opts.outDir) {
          mkdirSync(opts.outDir, { recursive: true })
          const outExt = opts.format === "json" ? ".json" : opts.format === "chunks" ? ".chunks.json" : ".md"
          const outPath = resolve(opts.outDir, fileName.replace(/\.[^.]+$/, outExt))
          writeFileSync(outPath, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${outPath}\n`)
          saveImages(opts.outDir)
        } else {
          process.stdout.write(output + "\n")
        }
      } catch (err) {
        process.stderr.write(`\n[kordoc] ERROR: ${fileName} — ${sanitizeError(err)}\n`)
        // 파싱 이후(출력·직렬화) 단계에서 터져도 실패 JSON 을 내야 호출자가 원인 코드로
        // 분기할 수 있다 — 종전엔 성공 로그 뒤 비-JSON 이었다 (#65). json 외 포맷에도
        // 동일 계약을 적용한다 (#69).
        process.stdout.write(JSON.stringify({
          success: false,
          fileType: detectedFormat,
          error: sanitizeError(err),
          code: classifyError(err),
        }, null, 2) + "\n")
        process.exitCode = 1
      }
    }
  })

registerDocCommands(program)
registerGenerateCommands(program)
registerRenderCommands(program)
registerSystemCommands(program)

program.parse()
