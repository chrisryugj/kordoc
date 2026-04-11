/** kordoc CLI — 모두 파싱해버리겠다 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, dirname, resolve, extname } from "path"
import { Command } from "commander"
import { parse, detectFormat, detectZipFormat, fillFormFields, extractFormFields, blocksToMarkdown, markdownToHwpx, fillHwpx } from "./index.js"
import type { ParseOptions } from "./types.js"
import { VERSION, toArrayBuffer, sanitizeError } from "./utils.js"

const program = new Command()

program
  .name("kordoc")
  .description("모두 파싱해버리겠다 — HWP, HWPX, PDF, XLSX, DOCX → Markdown")
  .version(VERSION)
  .argument("<files...>", "변환할 파일 경로 (HWP, HWPX, PDF, XLSX, DOCX)")
  .option("-o, --output <path>", "출력 파일 경로 (단일 파일 시)")
  .option("-d, --out-dir <dir>", "출력 디렉토리 (다중 파일 시)")
  .option("-p, --pages <range>", "페이지/섹션 범위 (예: 1-3, 1,3,5)")
  .option("--format <type>", "출력 형식: markdown (기본) 또는 json", "markdown")
  .option("--no-header-footer", "PDF 머리글/바닥글 자동 제거")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (files: string[], opts) => {
    const validFormats = ["markdown", "json"]
    if (!validFormats.includes(opts.format)) {
      process.stderr.write(`[kordoc] 지원하지 않는 형식: ${opts.format} (markdown 또는 json)\n`)
      process.exit(1)
    }
    for (let fi = 0; fi < files.length; fi++) {
      const filePath = files[fi]
      const absPath = resolve(filePath)
      const fileName = basename(absPath)
      const filePrefix = files.length > 1 ? `[${fi + 1}/${files.length}] ` : ""

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

        if (!opts.silent) {
          process.stderr.write(`[kordoc] ${filePrefix}${fileName} (${format}) ...`)
        }

        const parseOptions: ParseOptions = {}
        if (opts.pages) parseOptions.pages = opts.pages as string
        if (opts.headerFooter === false) parseOptions.removeHeaderFooter = false
        if (!opts.silent) {
          parseOptions.onProgress = (current: number, total: number) => {
            process.stderr.write(`\r[kordoc] ${filePrefix}${fileName} (${format}) [${current}/${total}]`)
          }
        }
        const result = await parse(arrayBuffer, parseOptions)

        if (!result.success) {
          process.stderr.write(` FAIL\n`)
          process.stderr.write(`  → ${result.error}\n`)
          process.exitCode = 1
          continue
        }

        if (!opts.silent) process.stderr.write(` OK\n`)

        let markdown = result.markdown
        // --out-dir 시 이미지 참조 경로에 images/ 접두사 추가
        if (opts.outDir && result.images?.length) {
          markdown = markdown.replace(/!\[image\]\(image_/g, "![image](images/image_")
        }
        const output = opts.format === "json"
          ? JSON.stringify(result, (_key, value) =>
              value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value
            , 2)
          : markdown

        // 이미지 저장 (--out-dir 또는 --output 시)
        const saveImages = (dir: string) => {
          if (!result.images?.length) return
          const imgDir = resolve(dir, "images")
          mkdirSync(imgDir, { recursive: true })
          for (const img of result.images) {
            writeFileSync(resolve(imgDir, img.filename), img.data)
          }
          if (!opts.silent) process.stderr.write(`  → ${result.images.length}개 이미지 → ${imgDir}\n`)
        }

        if (opts.output && files.length === 1) {
          writeFileSync(opts.output, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${opts.output}\n`)
          saveImages(resolve(opts.output, ".."))
        } else if (opts.outDir) {
          mkdirSync(opts.outDir, { recursive: true })
          const outExt = opts.format === "json" ? ".json" : ".md"
          const outPath = resolve(opts.outDir, fileName.replace(/\.[^.]+$/, outExt))
          writeFileSync(outPath, output, "utf-8")
          if (!opts.silent) process.stderr.write(`  → ${outPath}\n`)
          saveImages(opts.outDir)
        } else {
          process.stdout.write(output + "\n")
        }
      } catch (err) {
        process.stderr.write(`\n[kordoc] ERROR: ${fileName} — ${sanitizeError(err)}\n`)
        process.exitCode = 1
      }
    }
  })

program
  .command("watch <dir>")
  .description("디렉토리 감시 — 새 문서 자동 변환")
  .option("--webhook <url>", "결과 전송 웹훅 URL")
  .option("-d, --out-dir <dir>", "변환 결과 출력 디렉토리")
  .option("-p, --pages <range>", "페이지/섹션 범위")
  .option("--format <type>", "출력 형식: markdown 또는 json", "markdown")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (dir: string, opts) => {
    const { watchDirectory } = await import("./watch.js")
    await watchDirectory({
      dir,
      outDir: opts.outDir,
      webhook: opts.webhook,
      format: opts.format,
      pages: opts.pages,
      silent: opts.silent,
    })
  })

program
  .command("fill <template>")
  .description("서식 문서의 빈칸을 채워서 출력 — kordoc fill 신청서.hwpx -f '성명=홍길동,전화=010-1234-5678' -o 결과.hwpx")
  .option("-f, --fields <pairs>", "채울 필드 (key=value 쉼표 구분 또는 JSON)")
  .option("-j, --json <path>", "채울 필드 JSON 파일 경로")
  .option("-o, --output <path>", "출력 파일 경로 (확장자로 포맷 결정: .md, .hwpx)")
  .option("--format <type>", "출력 포맷: hwpx-preserve (기본, 원본 스타일 보존), hwpx, markdown", "hwpx-preserve")
  .option("--dry-run", "채우지 않고 서식 필드 목록만 출력")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (template: string, opts) => {
    try {
      const absPath = resolve(template)
      const fileSize = statSync(absPath).size
      if (fileSize > 500 * 1024 * 1024) {
        process.stderr.write(`[kordoc] 파일이 너무 큽니다 (${(fileSize / 1024 / 1024).toFixed(1)}MB)\n`)
        process.exit(1)
      }

      const buffer = readFileSync(absPath)
      const arrayBuffer = toArrayBuffer(buffer)

      if (!opts.silent) process.stderr.write(`[kordoc] ${basename(absPath)} 파싱 중...\n`)

      // --dry-run: 필드 목록만 출력
      if (opts.dryRun) {
        const result = await parse(arrayBuffer)
        if (!result.success) {
          process.stderr.write(`[kordoc] 파싱 실패: ${result.error}\n`)
          process.exit(1)
        }
        const formInfo = extractFormFields(result.blocks)
        if (formInfo.fields.length === 0) {
          process.stderr.write(`[kordoc] 서식 필드를 찾을 수 없습니다.\n`)
          process.exit(1)
        }
        process.stdout.write(JSON.stringify(formInfo, null, 2) + "\n")
        return
      }

      // 필드 값 파싱
      let values: Record<string, string> = {}
      if (opts.json) {
        const jsonPath = resolve(opts.json)
        const jsonContent = readFileSync(jsonPath, "utf-8")
        values = JSON.parse(jsonContent)
      } else if (opts.fields) {
        const fieldsStr: string = opts.fields
        if (fieldsStr.startsWith("{")) {
          values = JSON.parse(fieldsStr)
        } else {
          // "key1=value1,key2=value2" 파싱 — 값에 쉼표가 있을 수 있으므로
          // '=' 앞의 키를 기준으로 분리 (쉼표+한글/영문+= 패턴)
          const pairs = fieldsStr.split(/,(?=[가-힣A-Za-z][가-힣A-Za-z\s]*=)/)
          for (const pair of pairs) {
            const eqIdx = pair.indexOf("=")
            if (eqIdx > 0) {
              const key = pair.slice(0, eqIdx).trim()
              const val = pair.slice(eqIdx + 1).trim()
              values[key] = val
            }
          }
        }
      } else {
        process.stderr.write(`[kordoc] 채울 필드를 지정해주세요 (-f 또는 -j 옵션)\n`)
        process.exit(1)
      }

      // 출력 포맷 결정
      let outputFormat = opts.format as string
      if (opts.output) {
        const ext = extname(opts.output).toLowerCase()
        if (ext === ".hwpx") outputFormat = outputFormat === "markdown" ? "hwpx-preserve" : outputFormat
        else if (ext === ".md") outputFormat = "markdown"
      }

      // ─── hwpx-preserve: 원본 ZIP 직접 수정 ───
      if (outputFormat === "hwpx-preserve") {
        const format = detectFormat(arrayBuffer)
        let isHwpx = format === "hwpx"
        if (isHwpx) {
          const zipFormat = await detectZipFormat(arrayBuffer)
          isHwpx = zipFormat === "hwpx"
        }
        if (!isHwpx) {
          if (!opts.silent) process.stderr.write(`[kordoc] HWPX가 아니므로 hwpx 모드로 전환합니다\n`)
          outputFormat = "hwpx"
        } else {
          const hwpxResult = await fillHwpx(arrayBuffer, values)
          if (!opts.silent) {
            process.stderr.write(`[kordoc] ${hwpxResult.filled.length}개 필드 채움 (원본 스타일 보존)\n`)
            if (hwpxResult.unmatched.length > 0) {
              process.stderr.write(`[kordoc] ⚠️ 매칭 실패: ${hwpxResult.unmatched.join(", ")}\n`)
            }
          }
          if (opts.output) {
            mkdirSync(dirname(resolve(opts.output)), { recursive: true })
            writeFileSync(resolve(opts.output), Buffer.from(hwpxResult.buffer))
            if (!opts.silent) process.stderr.write(`[kordoc] → ${resolve(opts.output)}\n`)
          } else {
            process.stdout.write(Buffer.from(hwpxResult.buffer))
          }
          return
        }
      }

      // ─── 일반 경로: parse → fill → output ───
      const result = await parse(arrayBuffer)
      if (!result.success) {
        process.stderr.write(`[kordoc] 파싱 실패: ${result.error}\n`)
        process.exit(1)
      }

      const formInfo = extractFormFields(result.blocks)
      if (!opts.silent) {
        process.stderr.write(`[kordoc] 서식 필드 ${formInfo.fields.length}개 감지 (확신도 ${(formInfo.confidence * 100).toFixed(0)}%)\n`)
      }

      const fillResult = fillFormFields(result.blocks, values)
      if (!opts.silent) {
        process.stderr.write(`[kordoc] ${fillResult.filled.length}개 필드 채움\n`)
        if (fillResult.unmatched.length > 0) {
          process.stderr.write(`[kordoc] ⚠️ 매칭 실패: ${fillResult.unmatched.join(", ")}\n`)
        }
      }

      const markdown = blocksToMarkdown(fillResult.blocks)

      if (outputFormat === "hwpx") {
        const hwpxBuffer = await markdownToHwpx(markdown)
        if (opts.output) {
          mkdirSync(dirname(resolve(opts.output)), { recursive: true })
          writeFileSync(resolve(opts.output), Buffer.from(hwpxBuffer))
          if (!opts.silent) process.stderr.write(`[kordoc] → ${resolve(opts.output)}\n`)
        } else {
          process.stdout.write(Buffer.from(hwpxBuffer))
        }
      } else {
        if (opts.output) {
          mkdirSync(dirname(resolve(opts.output)), { recursive: true })
          writeFileSync(resolve(opts.output), markdown, "utf-8")
          if (!opts.silent) process.stderr.write(`[kordoc] → ${resolve(opts.output)}\n`)
        } else {
          process.stdout.write(markdown + "\n")
        }
      }
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("mcp")
  .description("MCP 서버 실행 (Claude / Cursor / Windsurf 연동)")
  .action(async () => {
    await import("./mcp.js")
  })

program.parse()
