/** Shared sequential conversion path for the CLI and batch workers. */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, resolve } from "path"
import type { OptionValues } from "commander"
import { parse, detectFormat } from "../index.js"
import type { ParseOptions } from "../types.js"
import { toArrayBuffer, sanitizeError, classifyError } from "../utils.js"
import { detectImageMime } from "../hwp5/images.js"
import { toPlainMarkdown } from "../plain-markdown.js"
import { toHtmlTables } from "../html-tables.js"
import { createOutputGuard } from "./output-path.js"

export async function convertFiles(files: string[], opts: OptionValues, writeOutput: (text: string) => void = text => { process.stdout.write(text) }, assertSafeOutputs = createOutputGuard(files)): Promise<boolean> {
  let failed = false
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
        failed = true
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
      if (opts.includeFieldPlaceholders) parseOptions.includeFieldPlaceholders = true
      if (opts.inlineImages) parseOptions.inlineImages = true
      if (opts.password) parseOptions.password = opts.password as string
      if (opts.images === false) parseOptions.images = false
      if (opts.plain) parseOptions.plain = true
      if (opts.scriptTags !== undefined) parseOptions.scriptTags = opts.scriptTags as boolean
      if (opts.htmlTables) parseOptions.htmlTables = true
      if (opts.tableFormat === "gfm") parseOptions.tableFormat = "gfm"
      if (opts.keepLayoutTables) parseOptions.layoutTables = "keep"
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
        writeOutput(JSON.stringify({ ...result, file: fileName }, null, 2) + "\n")
        failed = true
        continue
      }

      if (!opts.silent) process.stderr.write(` OK\n`)

      let markdown = result.markdown
      // 이미지 인라인은 HWP5 경로에서만 실제로 일어난다(parser.ts). 그 외 포맷(HWPX/DOCX 등)은
      // --inline-images 를 줘도 인라인되지 않으므로, 이미지 저장/경로접두사를 생략하면 참조가
      // 깨지고(dangling) 바이트가 유실된다 → 실제 인라인된 경우에만 생략한다.
      const imagesInlined = opts.inlineImages && result.fileType === "hwp"
      // 그림을 파일로 저장하는 실행(--out-dir 또는 단일 파일 --output, 아래 saveImages)이면 이미지 참조 경로에 images/ 접두사 추가
      // (인라인 모드에선 이미지가 마크다운에 임베드되므로 건너뜀). 종전엔 --out-dir 만 봐서 -o 결과의 그림 링크가 전부 깨졌다(#94).
      // <img src> 는 병합/중첩 표 셀 경로(table/builder.ts) — 마크다운 문법과 함께 둘 다 바꿔야 참조가 안 깨진다
      const savesImageFiles = Boolean(opts.outDir || (opts.output && files.length === 1))
      // 그림은 문서마다 images/<문서 이름>/ 에 — 같은 폴더로 여러 문서를 변환하면 image_001.png 가 서로 덮어써졌다(#98).
      // 문서 이름은 출력 파일 이름(-o) 또는 입력 파일 이름(-d)에서 확장자를 뺀 것. 링크에서는 공백·괄호만 퍼센트 인코딩한다
      const docStem = (opts.output && files.length === 1 ? basename(opts.output) : fileName).replace(/\.[^.]+$/, "")
      const imgLink = `images/${docStem.replace(/[ ()]/g, ch => encodeURIComponent(ch))}/`
      const linkImages = (text: string): string => savesImageFiles && result.images?.length && !imagesInlined
        ? text.replace(/!\[image\]\(image_/g, `![image](${imgLink}image_`).replace(/(<img\b[^>]*\bsrc=")image_/g, `$1${imgLink}image_`)
        : text
      markdown = linkImages(markdown)
      // json 직렬화 — refsOnly면 이미지 바이트를 빼고 저장 경로만 남긴다.
      // 이미지가 수백 장인 문서는 base64 총량이 V8 문자열 한계를 넘어 RangeError 로
      // 터졌고, 그 예외가 성공 로그 뒤 비-JSON 출력이 되어 파이프라인이 깨졌다 (#65).
      const serializeJson = (refsOnly: boolean): string => {
        const payload = refsOnly && result.images?.length
          ? { ...result, images: result.images.map(img => ({ filename: img.filename, mimeType: img.mimeType, path: `images/${docStem}/${img.filename}` })) }
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
          process.stderr.write(`  ⚠️ 이미지 base64 인라인이 직렬화 한계를 넘어 파일 참조로 대체했습니다 (${result.images.length}개 → images/${docStem}/)\n`)
        }
      } else if (opts.format === "chunks") {
        // 청크 글에도 본문 마크다운과 같은 후처리(평문·HTML 표·그림 경로) — 종전엔 IR 에서 바로 만들어 --plain·--html-tables 를 무시했다
        const { blocksToChunks } = await import("../chunks.js")
        const chunks = blocksToChunks(result.blocks, { tableFormat: parseOptions.tableFormat }).map(c => {
          let text = c.text
          if (opts.plain) text = toPlainMarkdown(text)
          if (opts.htmlTables) text = toHtmlTables(text)
          return { ...c, text: linkImages(text) }
        })
        output = JSON.stringify(chunks, null, 2)
      } else {
        output = markdown
      }

      // 이미지 저장 (--out-dir 또는 --output 시) — 실제 인라인된 경우(HWP5)에만 미저장, 그 외엔 저장 유지
      const saveImages = (dir: string) => {
        if (!result.images?.length || imagesInlined) return
        const imgDir = resolve(dir, "images", docStem)
        mkdirSync(imgDir, { recursive: true })
        for (const img of result.images) {
          writeFileSync(resolve(imgDir, img.filename), img.data)
        }
        // images/<문서 이름>/manifest.json — 소비자가 확장자·매직바이트 추측 없이 형식 분기(#70).
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

      // Validate the document and all image destinations together, before any file is written.
      const assertSafeDestination = (output: string, dir: string) => {
        const imageOutputs = result.images?.length && !imagesInlined
          ? [...result.images.map(img => resolve(dir, "images", docStem, img.filename)), resolve(dir, "images", docStem, "manifest.json")]
          : []
        assertSafeOutputs([output, ...imageOutputs])
      }

      if (opts.output && files.length === 1) {
        assertSafeDestination(opts.output, resolve(opts.output, ".."))
        writeFileSync(opts.output, output, "utf-8")
        if (!opts.silent) process.stderr.write(`  → ${opts.output}\n`)
        saveImages(resolve(opts.output, ".."))
      } else if (opts.outDir) {
        mkdirSync(opts.outDir, { recursive: true })
        const outExt = opts.format === "json" ? ".json" : opts.format === "chunks" ? ".chunks.json" : ".md"
        // 확장자 없는 입력("slides")도 이름 뒤에 붙인다 — 종전 replace 는 그대로 두어 -d 가 입력 폴더면 입력 파일을 덮어썼다
        const outPath = resolve(opts.outDir, fileName.replace(/\.[^.]+$/, "") + outExt)
        assertSafeDestination(outPath, opts.outDir)
        writeFileSync(outPath, output, "utf-8")
        if (!opts.silent) process.stderr.write(`  → ${outPath}\n`)
        saveImages(opts.outDir)
      } else {
        writeOutput(output + "\n")
      }
    } catch (err) {
      process.stderr.write(`\n[kordoc] ERROR: ${fileName} — ${sanitizeError(err)}\n`)
      // 파싱 이후(출력·직렬화) 단계에서 터져도 실패 JSON 을 내야 호출자가 원인 코드로
      // 분기할 수 있다 — 종전엔 성공 로그 뒤 비-JSON 이었다 (#65). json 외 포맷에도
      // 동일 계약을 적용한다 (#69).
      writeOutput(JSON.stringify({
        success: false,
        fileType: detectedFormat,
        // 다중 입력에서 어느 파일이 실패했는지 호출자가 기계적으로 특정할 수 있게 한다 (#69).
        // basename 만 노출 — 전체 경로는 내부 정보로 보아 넣지 않는다.
        file: fileName,
        error: sanitizeError(err),
        code: classifyError(err),
      }, null, 2) + "\n")
      failed = true
    }
  }
  return !failed
}
