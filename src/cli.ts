/** kordoc CLI — 모두 파싱해버리겠다 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, dirname, resolve, extname } from "path"
import { Command } from "commander"
import { parse, detectFormat, detectZipFormat, fillFormFields, extractFormFields, blocksToMarkdown, markdownToHwpx, fillHwpx, PRESET_ALIAS, unknownFontWarnings, lintGongmunText, gongmunLintWarnings } from "./index.js"
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
  .option("--formula-ocr", "PDF 수식 OCR 활성화 (MFD+MFR ONNX, 첫 사용 시 모델 ~155MB 자동 다운로드)")
  .option("--dedupe-headers", "HWP5 레이아웃 표 페이지 반복 러닝 헤더 중복 제거 (기본 off — 붙임별 재번호 오삭제 주의)")
  .option("--inline-images", "이미지를 base64 data URI 로 마크다운에 인라인 (BMP→PNG 압축, HWP5 전용 — 인라인된 경우만 파일 미저장, 그 외 포맷은 저장 유지)")
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

        const parseOptions: ParseOptions = { filePath: absPath }
        if (opts.pages) parseOptions.pages = opts.pages as string
        if (opts.headerFooter === false) parseOptions.removeHeaderFooter = false
        if (opts.formulaOcr) parseOptions.formulaOcr = true
        if (opts.dedupeHeaders) parseOptions.dedupeRunningHeaders = true
        if (opts.inlineImages) parseOptions.inlineImages = true
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
        const output = opts.format === "json"
          ? JSON.stringify(result, (_key, value) =>
              value instanceof Uint8Array ? Buffer.from(value).toString("base64") : value
            , 2)
          : markdown

        // 이미지 저장 (--out-dir 또는 --output 시) — 실제 인라인된 경우(HWP5)에만 미저장, 그 외엔 저장 유지
        const saveImages = (dir: string) => {
          if (!result.images?.length || imagesInlined) return
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
  .action(async (dir: string, opts, command: Command) => {
    // 루트 커맨드의 동명 옵션(-d/--out-dir·-p/--pages·--format·--silent)이 서브커맨드 뒤에서도 루트로 흡수되는 commander 동작 보완
    const rootOpts = program.opts()
    opts.outDir ??= rootOpts.outDir
    opts.pages ??= rootOpts.pages
    opts.silent ??= rootOpts.silent
    if (command.getOptionValueSource("format") === "default" && program.getOptionValueSource("format") === "cli") {
      opts.format = rootOpts.format
    }
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
  .action(async (template: string, opts, command: Command) => {
    try {
      // 루트 커맨드의 동명 옵션(-o/--output·--format·--silent)이 서브커맨드 뒤에서도 루트로 흡수되는 commander 동작 보완
      const rootOpts = program.opts()
      opts.output ??= rootOpts.output
      opts.silent ??= rootOpts.silent
      if (command.getOptionValueSource("format") === "default" && program.getOptionValueSource("format") === "cli") {
        opts.format = rootOpts.format
      }
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
  .command("seal <file>")
  .description('도장/서명 이미지를 앵커 문구 위에 부유 배치 (표/페이지 불확장) — kordoc seal 신청서.hwpx --image 도장.png --anchor "(인)" -o 결과.hwpx')
  .requiredOption("--image <path>", "도장/서명 이미지 (투명 배경 PNG 권장)")
  .option("--anchor <text>", "앵커 문구", "(인)")
  .option("-n, --occurrence <num>", "같은 앵커가 여럿일 때 0-based 선택", "0")
  .option("--size-mm <num>", "도장 한 변 크기 mm (기본: 줄높이×1.6, 7~18 클램프)")
  .option("--mode <mode>", "overlap(문구 위 겹침) | right(오른쪽 옆) | auto", "auto")
  .option("--dx <mm>", "x 미세조정 mm", "0")
  .option("--dy <mm>", "y 미세조정 mm", "0")
  .option("-o, --output <path>", "출력 경로 (기본: <입력>.sealed.hwpx)")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (file: string, opts) => {
    try {
      const { placeSealHwpx, detectFormat } = await import("./index.js")
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const silent: boolean = opts.silent ?? rootOpts.silent
      const mode = String(opts.mode).toLowerCase()
      if (!["overlap", "right", "auto"].includes(mode)) {
        process.stderr.write(`[kordoc] --mode 는 overlap/right/auto 중 하나여야 합니다\n`)
        process.exit(1)
      }
      const buf = new Uint8Array(readFileSync(resolve(file)))
      if (detectFormat(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer) !== "hwpx") {
        process.stderr.write(`[kordoc] seal 은 HWPX 전용입니다 (HWP 5.x 바이너리는 미지원)\n`)
        process.exit(1)
      }
      const imgPath = resolve(opts.image)
      const imgSize = statSync(imgPath).size
      if (imgSize > 500 * 1024 * 1024) {
        process.stderr.write(`[kordoc] 도장 이미지가 너무 큽니다 (${(imgSize / 1024 / 1024).toFixed(0)}MB)\n`)
        process.exit(1)
      }
      const image = new Uint8Array(readFileSync(imgPath))
      const ext = extname(opts.image).slice(1).toLowerCase() || "png"
      // --size-mm 검증 — 비숫자·음수가 NaN/음수로 XML 속성에 그대로 기록되던 것 차단 (MCP zod 동등)
      let sizeMm: number | undefined
      if (opts.sizeMm != null) {
        const n = Number(opts.sizeMm)
        if (!Number.isFinite(n) || n <= 0) {
          process.stderr.write(`[kordoc] --size-mm 은 양수여야 합니다: ${opts.sizeMm}\n`)
          process.exit(1)
        }
        sizeMm = n
      }
      const result = await placeSealHwpx(
        buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        [{
          anchor: opts.anchor,
          occurrence: Number(opts.occurrence) || 0,
          image,
          ext: ext as "png" | "jpg" | "jpeg" | "bmp" | "gif",
          sizeMm,
          mode: mode as "overlap" | "right" | "auto",
          dxMm: Number(opts.dx) || 0,
          dyMm: Number(opts.dy) || 0,
        }],
      )
      const outPath = resolve(output ?? file.replace(/\.hwpx$/i, "") + ".sealed.hwpx")
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, Buffer.from(result.buffer))
      if (!silent) {
        for (const p of result.placed) {
          process.stderr.write(`[kordoc] 도장 배치: "${p.anchor}" #${p.occurrence} → ${p.mode} (${p.posXMm}mm, ${p.posYMm}mm, ${p.sizeMm}mm) [${p.entry}]\n`)
          for (const w of p.warnings ?? []) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
        }
        process.stderr.write(`[kordoc] → ${outPath}\n`)
      }
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("patch <original> <edited>")
  .description("서식 보존 라운드트립 패치 — 편집된 마크다운을 원본 HWPX/HWP에 in-place 반영 (kordoc patch 원본.hwpx 편집.md -o 출력.hwpx)")
  .option("-o, --output <path>", "출력 경로 (기본: <원본>.patched.hwpx|.hwp)")
  .option("--no-verify", "패치 후 재파싱 자동 검증 생략")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (original: string, edited: string, opts) => {
    try {
      const { patchHwpx, patchHwp, detectFormat } = await import("./index.js")
      // 루트 커맨드의 동명 옵션(-o/--silent)이 서브커맨드 옵션을 가로채는 commander 동작 보완
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const silent: boolean = opts.silent ?? rootOpts.silent
      const originalBuf = new Uint8Array(readFileSync(resolve(original)))
      const editedMarkdown = readFileSync(resolve(edited), "utf-8")

      const format = detectFormat(originalBuf.buffer as ArrayBuffer)
      const result = format === "hwp"
        ? await patchHwp(originalBuf, editedMarkdown, { verify: opts.verify !== false })
        : await patchHwpx(originalBuf, editedMarkdown, { verify: opts.verify !== false })
      if (!result.success || !result.data) {
        process.stderr.write(`[kordoc] 패치 실패: ${result.error ?? "알 수 없는 오류"}\n`)
        process.exit(1)
      }

      const ext = format === "hwp" ? ".hwp" : ".hwpx"
      const outPath = resolve(output ?? original.replace(/\.hwpx?$/i, "") + ".patched" + ext)
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, result.data)

      if (!silent) {
        process.stderr.write(`[kordoc] ${result.applied}개 변경 적용 (원본 서식 보존) → ${outPath}\n`)
        for (const s of result.skipped) {
          process.stderr.write(`[kordoc] ⚠️ SKIP: ${s.reason}${s.before ? ` | ${s.before}` : ""}\n`)
        }
        if (result.verification) {
          const v = result.verification.stats
          const residual = v.added + v.removed + v.modified
          process.stderr.write(residual === 0
            ? `[kordoc] ✓ 검증: 편집 마크다운과 재파싱 결과 완전 일치 (${v.unchanged}블록)\n`
            : `[kordoc] ⚠️ 검증 잔차: 수정 ${v.modified}, 추가 ${v.added}, 삭제 ${v.removed} (미지원 변경은 skip 목록 참조)\n`)
        }
      }
      if (result.skipped.length > 0) process.exitCode = 2
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("validate <file>")
  .description("HWPX 구조 검증 — ZIP·mimetype·필수 파일·XML 웰폼드·secCnt·manifest 참조 (한컴독스 거부 요인 사전 차단)")
  .option("--json", "결과를 JSON으로 stdout에 출력")
  .action(async (file: string, opts) => {
    try {
      const { validateHwpx } = await import("./index.js")
      const buf = new Uint8Array(readFileSync(resolve(file)))
      const result = await validateHwpx(buf)
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n")
      } else if (result.ok) {
        process.stderr.write(`[kordoc] ✓ 구조 검증 통과 (엔트리 ${result.entryCount}개): ${file}\n`)
      } else {
        process.stderr.write(`[kordoc] ✗ 구조 문제 ${result.issues.length}건: ${file}\n`)
        for (const i of result.issues) {
          process.stderr.write(`[kordoc]   - ${i.path ? `${i.path}: ` : ""}${i.message}\n`)
        }
      }
      if (!result.ok) process.exit(1)
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

// 공문서 프리셋 별칭(한글/영문) → 내부 preset 키 — gongmun.ts와 공용(PRESET_ALIAS)

program
  .command("generate <markdown>")
  .alias("gen")
  .description("마크다운 → 공문서 HWPX 생성 — kordoc generate 보고서.md -o 보고서.hwpx --preset 보고서 (markdown에 '-' 지정 시 stdin)")
  .option("-o, --output <path>", "출력 HWPX 경로 (기본: <입력>.hwpx)")
  .option("--preset <name>", "공문서 프리셋: 기안문(official)·보고서(report)·계획서(plan)·통지(notice)·회의록(minutes)·개조식(gaejosik — 표지·목차·장헤더 자동)", "기안문")
  .option("--font <type>", "본문 글꼴: myeongjo(함초롬바탕) 또는 gothic(맑은 고딕)")
  .option("--pt <size>", "본문 글자 크기(pt)")
  .option("--line-spacing <percent>", "본문 줄간격(%)")
  .option("--org <name>", "표지 기관명 (개조식 프리셋)")
  .option("--date <date>", "표지 날짜 (개조식 프리셋, 기본 오늘 — 'YYYY. M. D.')")
  .option("--toc", "목차 페이지 강제 켜기 (개조식 외 프리셋에서도 h2 목록으로 생성)")
  .option("--no-toc", "목차 페이지 끄기 (개조식 프리셋 기본 켜짐)")
  .option("--cover", "표지 페이지 강제 켜기 (개조식 외 프리셋에서도 첫 h1을 표지로)")
  .option("--no-cover", "표지 페이지 끄기 (개조식 프리셋 기본 켜짐)")
  .option("--approval <labels>", "결재란 직위 라벨 (쉼표 구분, 예: 담당,팀장,과장) — 문서 최상단 우측")
  .option("--page-numbers", "쪽번호 강제 켜기 (하단 중앙 '- 1 -')")
  .option("--no-page-numbers", "쪽번호 끄기 (개조식·보고서·계획서 기본 켜짐)")
  .option("--end-mark", "본문 끝 '끝.' 표시 강제 켜기")
  .option("--no-end-mark", "'끝.' 표시 끄기 (기안문 기본 켜짐)")
  .option("--no-body-title-box", "본문 첫 페이지 제목 반복 박스 끄기 (개조식+표지 기본 켜짐)")
  .option("--h2-marker <type>", "h2 섹션 제목 말머리: box(□ — 보고서·계획서 기본)·number(1. — 공고문 관행)·none")
  .option("--fonts <spec>", "요소별 글꼴 오버라이드: body=나눔명조,heading=나눔고딕,ref=한양중고딕,table=맑은 고딕")
  .option("--sizes <spec>", "개조식 요소별 크기(pt): dae=16,cham=13,table=12,coverTitle=30 …")
  .option("--plain", "공문서 모드 끄기 (범용 마크다운 변환)")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (markdown: string, opts) => {
    try {
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const silent: boolean = opts.silent ?? rootOpts.silent

      // 입력: '-' 이면 stdin, 아니면 파일
      let md: string
      let baseName = "document"
      if (markdown === "-") {
        md = readFileSync(0, "utf-8")
      } else {
        const inPath = resolve(markdown)
        md = readFileSync(inPath, "utf-8")
        baseName = basename(inPath).replace(/\.(md|markdown|txt)$/i, "")
      }

      // 공문서 옵션 구성
      let gongmun: import("./index.js").GongmunOptions | undefined
      if (!opts.plain) {
        const preset = PRESET_ALIAS[String(opts.preset).trim()]
        if (!preset) {
          process.stderr.write(`[kordoc] 알 수 없는 프리셋: ${opts.preset} (기안문/보고서/계획서/통지/회의록/개조식)\n`)
          process.exit(1)
        }
        gongmun = { preset }
        // 표지: --no-cover가 최우선, org/date 지정 시 객체(=켜짐), --cover는 강제 켜기.
        // 미지정이면 프리셋 기본(개조식만 켜짐 — resolveGongmun)
        if (opts.cover === false) {
          gongmun.cover = false
        } else if (opts.org || opts.date) {
          gongmun.cover = { ...(opts.org ? { org: opts.org } : {}), ...(opts.date ? { date: opts.date } : {}) }
        } else if (opts.cover === true) {
          gongmun.cover = true
        }
        // 목차: --toc/--no-toc 명시 시에만 전달 (미지정이면 프리셋 기본)
        if (opts.toc !== undefined) gongmun.toc = opts.toc
        if (opts.approval) gongmun.approval = String(opts.approval).split(",").map((s: string) => s.trim()).filter(Boolean)
        if (opts.pageNumbers !== undefined) gongmun.pageNumbers = opts.pageNumbers
        if (opts.endMark !== undefined) gongmun.endMark = opts.endMark
        if (opts.bodyTitleBox === false) gongmun.bodyTitleBox = false
        if (opts.h2Marker) {
          if (!["box", "number", "none"].includes(opts.h2Marker)) {
            process.stderr.write(`[kordoc] --h2-marker 는 box/number/none\n`)
            process.exit(1)
          }
          gongmun.h2Marker = opts.h2Marker
        }
        if (opts.font) {
          if (opts.font !== "myeongjo" && opts.font !== "gothic") {
            process.stderr.write(`[kordoc] --font 은 myeongjo 또는 gothic\n`)
            process.exit(1)
          }
          gongmun.bodyFont = opts.font
        }
        if (opts.pt) gongmun.bodyPt = Number(opts.pt)
        if (opts.lineSpacing) gongmun.lineSpacing = Number(opts.lineSpacing)
        // "key=value,key=value" 스펙 파싱 — 값에 쉼표가 없는 폰트명·숫자만 지원
        const parseKv = (spec: string): Record<string, string> =>
          Object.fromEntries(spec.split(",").map((p) => p.split("=").map((s) => s.trim())).filter((kv) => kv.length === 2 && kv[0] && kv[1]))
        if (opts.fonts) gongmun.fonts = parseKv(String(opts.fonts))
        if (opts.sizes) {
          gongmun.sizes = Object.fromEntries(
            Object.entries(parseKv(String(opts.sizes))).map(([k, v]) => [k, Number(v)]).filter(([, v]) => Number.isFinite(v as number)),
          )
        }
      }

      // 폰트 오버라이드 오타·미설치 경고 (A2) — 생성은 진행
      if (gongmun?.fonts && !silent) {
        for (const w of unknownFontWarnings(gongmun.fonts)) process.stderr.write(`[kordoc] ${w}\n`)
      }
      // 공문서 표기법 검수 (편람 기준, 조언용) — 생성은 진행, stderr 경고만
      if (gongmun && !silent) {
        for (const w of gongmunLintWarnings(md, 5)) process.stderr.write(`[kordoc] ⚠ ${w}\n`)
      }

      const buf = await markdownToHwpx(md, gongmun ? { gongmun } : undefined)
      const outPath = resolve(output ?? (markdown === "-" ? `${baseName}.hwpx` : markdown.replace(/\.(md|markdown|txt)$/i, "") + ".hwpx"))
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, Buffer.from(buf))

      if (!silent) {
        const mode = gongmun ? `공문서:${gongmun.preset}` : "범용"
        process.stderr.write(`[kordoc] HWPX 생성 (${mode}) → ${outPath}\n`)
      }
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("lint <file>")
  .description("공문서 표기법 검수 — 날짜·시간·금액·붙임 등 행정업무운영 편람 표기법 (md/txt, '-'=stdin). error 있으면 exit 1")
  .option("--json", "JSON 출력")
  .action((file: string, opts) => {
    try {
      const text = file === "-" ? readFileSync(0, "utf-8") : readFileSync(resolve(file), "utf-8")
      const findings = lintGongmunText(text)
      const errors = findings.filter((f) => f.severity === "error").length
      if (opts.json) {
        process.stdout.write(JSON.stringify({ findings, summary: { total: findings.length, errors, ok: errors === 0 } }, null, 2) + "\n")
      } else {
        process.stdout.write(`[kordoc] 표기법 검수: 위반 ${findings.length}건 (error ${errors}, warning ${findings.length - errors})\n`)
        for (const f of findings) {
          process.stdout.write(`  L${f.line} [${f.severity}] ${f.rule}: "${f.match}" — ${f.message}${f.suggest ? ` → ${f.suggest}` : ""}\n`)
        }
      }
      process.exit(errors > 0 ? 1 : 0)
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("render <file>")
  .description("레이아웃 보존 렌더 — 한컴 저장 HWPX의 조판 캐시를 SVG로 (전체 페이지 세로 스택) — kordoc render 문서.hwpx -o 문서.svg")
  .option("-o, --output <path>", "출력 SVG 경로 (기본: <입력>.svg)")
  .option("--highlight <terms>", "검색어 형광펜 (쉼표 구분)")
  .option("--reflow", "조판 캐시 없는 HWPX도 순수 TS 조판으로 렌더 (markdownToHwpx 산출물·편집본)")
  .option("--reflow-mode <mode>", "reflow 줄바꿈 모드: keep(어절) | charAll(글자)", "keep")
  .option("--silent", "진행 메시지 숨기기")
  .action(async (file: string, opts) => {
    try {
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const silent: boolean = opts.silent ?? rootOpts.silent
      const { renderHwpxToSvg } = await import("./render/index.js")
      const absPath = resolve(file)
      const buffer = readFileSync(absPath)
      const highlights = opts.highlight ? String(opts.highlight).split(",") : undefined
      const result = await renderHwpxToSvg(toArrayBuffer(buffer), { highlights, reflow: opts.reflow, reflowMode: opts.reflowMode })
      const outPath = resolve(output ?? file.replace(/\.hwpx$/i, "") + ".svg")
      mkdirSync(dirname(outPath), { recursive: true })
      writeFileSync(outPath, result.svg, "utf-8")
      if (!silent) {
        process.stderr.write(`[kordoc] 렌더 (${result.pageCount}페이지, ${result.width}x${result.height}pt, 텍스트 ${result.stats.texts}·이미지 ${result.stats.images}·표 ${result.stats.tables}) → ${outPath}\n`)
        for (const w of result.warnings) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
      }
    } catch (err) {
      process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program
  .command("render-worker")
  .description("persistent 렌더 워커 — stdin NDJSON 요청 → 조판 SVG 파일 출력 (프로세스 유지, 콜드스타트 제거)")
  .action(async () => {
    // 프로토콜(NDJSON, 한 줄=한 요청/응답):
    //  요청 {"id":1,"file":"a.hwpx","out":"a.svg","reflow":true,"highlight":["term"]}
    //  응답 {"id":1,"ok":true,"out":"a.svg","width":..,"height":..,"pageCount":..,"stats":{..},"warnings":[..]}
    //  {"cmd":"quit"} 로 종료. 모듈은 최초 1회만 로드 → 이후 요청은 콜드스타트 없음.
    const { createInterface } = await import("node:readline")
    const { renderHwpxToSvg } = await import("./render/index.js")
    const rl = createInterface({ input: process.stdin })
    const write = (o: unknown): void => void process.stdout.write(JSON.stringify(o) + "\n")
    write({ ready: true, version: VERSION })
    for await (const line of rl) {
      const t = line.trim()
      if (!t) continue
      let req: { id?: number; cmd?: string; file?: string; out?: string; reflow?: boolean; reflowMode?: string; highlight?: string[] }
      // 비JSON 라인도 응답은 낸다 — 무음 삼킴이면 id 대기 클라이언트가 영구 행
      try { req = JSON.parse(t) } catch { write({ ok: false, error: "잘못된 JSON 라인" }); continue }
      if (req === null || typeof req !== "object") { write({ ok: false, error: "JSON 객체가 아닙니다" }); continue }
      if (req.cmd === "quit") { rl.close(); break }
      const id = req.id
      try {
        if (!req.file || !req.out) throw new Error("file·out 필수")
        const buffer = readFileSync(resolve(req.file))
        const result = await renderHwpxToSvg(toArrayBuffer(buffer), {
          highlights: req.highlight, reflow: req.reflow, reflowMode: req.reflowMode as "keep" | "charAll" | undefined,
        })
        const outPath = resolve(req.out)
        mkdirSync(dirname(outPath), { recursive: true })
        writeFileSync(outPath, result.svg, "utf-8")
        write({ id, ok: true, out: outPath, width: result.width, height: result.height, pageCount: result.pageCount, stats: result.stats, warnings: result.warnings })
      } catch (err) {
        write({ id, ok: false, error: sanitizeError(err) })
      }
    }
  })

program
  .command("mcp")
  .description("MCP 서버 실행 (Claude / Cursor / Windsurf 연동)")
  .action(async () => {
    await import("./mcp.js")
  })

program
  .command("setup")
  .description("대화형 설치 마법사 — AI 클라이언트 자동 등록 (Mac/Win/Linux)")
  .action(async () => {
    const { runSetup } = await import("./setup.js")
    await runSetup()
  })

program
  .command("check-formula-models")
  .description("PDF 수식 OCR 모델(MFD + MFR + tokenizer, ~155MB) 상태 확인 — 없거나 SHA 불일치면 다운로드")
  .option("--status-only", "상태만 JSON 으로 출력 (다운로드 안 함)")
  .action(async (opts) => {
    try {
      const { getFormulaModelStatus, ensureFormulaModels, getFormulaModelsDir } = await import(
        "./pdf/formula/index.js"
      )
      const dir = getFormulaModelsDir()
      if (opts.statusOnly) {
        const status = await getFormulaModelStatus()
        process.stdout.write(
          JSON.stringify(
            {
              modelsDir: dir,
              allReady: status.every((s) => s.verified),
              models: status.map((s) => ({
                name: s.spec.name,
                filename: s.spec.filename,
                sizeMb: s.spec.sizeMb,
                exists: s.exists,
                verified: s.verified,
                invalidReason: s.invalidReason,
                path: s.localPath,
              })),
            },
            null,
            2,
          ) + "\n",
        )
        return
      }
      process.stderr.write(`[kordoc-formula] 캐시 디렉토리: ${dir}\n`)
      await ensureFormulaModels((p) => {
        if (p.phase === "download" && p.total) {
          const pct = Math.floor((p.downloaded / p.total) * 100)
          process.stderr.write(
            `\r[kordoc-formula] ${p.spec.name} ${pct}% (${(p.downloaded / 1024 / 1024).toFixed(1)}/${(p.total / 1024 / 1024).toFixed(1)}MB)`,
          )
          if (p.downloaded >= p.total) process.stderr.write("\n")
        } else if (p.phase === "verify") {
          process.stderr.write(`[kordoc-formula] ${p.spec.name} SHA-256 검증 중...\n`)
        } else if (p.phase === "done") {
          process.stderr.write(`[kordoc-formula] ${p.spec.name} 준비 완료\n`)
        } else if (p.phase === "skip") {
          process.stderr.write(`[kordoc-formula] ${p.spec.name} 이미 존재 (skip)\n`)
        }
      })
      process.stdout.write("ok\n")
    } catch (err) {
      process.stderr.write(`[kordoc] 수식 모델 준비 실패: ${sanitizeError(err)}\n`)
      process.exit(1)
    }
  })

program.parse()
