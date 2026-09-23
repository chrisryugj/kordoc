/** kordoc CLI 명령 — 문서 처리 — watch·fill·seal·patch·validate */

import { readFileSync, writeFileSync, mkdirSync, statSync } from "fs"
import { basename, dirname, resolve, extname } from "path"
import { Command } from "commander"
import { parse, detectFormat, detectZipFormat, fillFormFields, extractFormFields, blocksToMarkdown, markdownToHwpx, fillHwpx, fillWithUniqueGuard, PRESET_ALIAS, extractClickHereFields, BUILTIN_TEMPLATES, resolveBuiltinTemplate, readBuiltinTemplate } from "../index.js"
import type { FillInput } from "../index.js"
import { toArrayBuffer, sanitizeError } from "../utils.js"

export function registerDocCommands(program: Command): void {
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
      const { watchDirectory } = await import("../watch.js")
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
    .command("fill [file]")
    .description("서식 문서의 빈칸을 채워서 출력 — kordoc fill 신청서.hwpx -f '성명=홍길동,전화=010-1234-5678' -o 결과.hwpx / 내장 기안문 서식은 kordoc fill --template gian")
    .option("-f, --fields <pairs>", "채울 필드 (key=value 쉼표 구분 또는 JSON)")
    .option("-j, --json <path>", "채울 필드 JSON 파일 경로")
    .option("-o, --output <path>", "출력 파일 경로 (확장자로 포맷 결정: .md, .hwpx)")
    .option("--format <type>", "출력 포맷: hwpx-preserve (기본, 원본 스타일 보존), hwpx, markdown", "hwpx-preserve")
    .option("--formats <json>", "필드별 값 서식 JSON (라벨→포맷) — 예: '{\"날짜\":\"yy.mm.dd\",\"주민등록번호\":\"rrn:masked\"}'")
    .option("--template <name>", "내장 표준 서식 사용 (파일 경로 불필요): gian(일반기안문) | gian-simple(간이기안문). 위치 인자 'templates:일반기안문' 표기도 동일")
    .option("--list-templates", "내장 표준 서식 목록 + 누름틀 필드 나열")
    .option("--require-unique", "한 키가 서식의 2곳 이상에 매칭되면 채우지 않고 거부 (반복 라벨 양식 오염 방지)")
    .option("--mask", "채운 값 미노출 — 출력 파일 없이 markdown을 stdout으로 낼 때 본문 대신 안내만 표시")
    .option("--dry-run", "채우지 않고 서식 필드 목록만 출력")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (file: string | undefined, opts, command: Command) => {
      try {
        // 루트 커맨드의 동명 옵션(-o/--output·--format·--silent)이 서브커맨드 뒤에서도 루트로 흡수되는 commander 동작 보완
        const rootOpts = program.opts()
        opts.output ??= rootOpts.output
        opts.silent ??= rootOpts.silent
        if (command.getOptionValueSource("format") === "default" && program.getOptionValueSource("format") === "cli") {
          opts.format = rootOpts.format
        }

        // --list-templates: 내장 서식 목록 + 누름틀 필드
        if (opts.listTemplates) {
          const list = []
          for (const t of BUILTIN_TEMPLATES) {
            const fields = await extractClickHereFields(readBuiltinTemplate(t))
            list.push({ id: t.id, aliases: t.aliases, title: t.title, fields: fields.map(f => f.name) })
          }
          process.stdout.write(JSON.stringify(list, null, 2) + "\n")
          return
        }

        // 입력 소스 결정 — 내장 템플릿(--template 또는 'templates:이름' 위치 인자) 우선
        const templateName = opts.template ?? (file && /^templates?:/i.test(file) ? file : undefined)
        let arrayBuffer: ArrayBuffer
        let inputName: string
        if (templateName) {
          const t = resolveBuiltinTemplate(templateName)
          if (!t) {
            process.stderr.write(`[kordoc] 알 수 없는 내장 템플릿: ${templateName} (사용 가능: ${BUILTIN_TEMPLATES.map(x => `${x.id}(${x.aliases[0]})`).join(", ")})\n`)
            process.exit(1)
          }
          arrayBuffer = readBuiltinTemplate(t)
          inputName = t.file
        } else if (file) {
          const absPath = resolve(file)
          const fileSize = statSync(absPath).size
          if (fileSize > 500 * 1024 * 1024) {
            process.stderr.write(`[kordoc] 파일이 너무 큽니다 (${(fileSize / 1024 / 1024).toFixed(1)}MB)\n`)
            process.exit(1)
          }
          arrayBuffer = toArrayBuffer(readFileSync(absPath))
          inputName = basename(absPath)
        } else {
          process.stderr.write(`[kordoc] 서식 파일 경로 또는 --template 을 지정해주세요 (목록: kordoc fill --list-templates)\n`)
          process.exit(1)
          return
        }

        if (!opts.silent) process.stderr.write(`[kordoc] ${inputName} 파싱 중...\n`)

        // --dry-run: 필드 목록만 출력 — 서식 입력란(빈 후행 열)이 목록에 나오도록 보존 (#47)
        if (opts.dryRun) {
          const result = await parse(arrayBuffer, { keepTrailingEmptyCols: true })
          if (!result.success) {
            process.stderr.write(`[kordoc] 파싱 실패: ${result.error}\n`)
            process.exit(1)
          }
          const formInfo = extractFormFields(result.blocks)
          // 누름틀(CLICK_HERE) 필드도 함께 나열 — 표준 서식은 라벨 표 없이 누름틀만 있을 수 있다
          const clickHereFields = detectFormat(arrayBuffer) === "hwpx"
            ? await extractClickHereFields(arrayBuffer)
            : []
          if (formInfo.fields.length === 0 && clickHereFields.length === 0) {
            process.stderr.write(`[kordoc] 서식 필드를 찾을 수 없습니다.\n`)
            process.exit(1)
          }
          process.stdout.write(JSON.stringify(
            clickHereFields.length > 0 ? { ...formInfo, clickHereFields } : formInfo,
            null, 2,
          ) + "\n")
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

        // 필드별 값 서식 결합 — MCP fill_form(formats)과 동일 의미론 (form/match.js FillInput)
        let inputs: Record<string, FillInput> = values
        if (opts.formats) {
          let formatMap: Record<string, string>
          try {
            formatMap = JSON.parse(String(opts.formats))
          } catch {
            process.stderr.write(`[kordoc] --formats 는 JSON 객체여야 합니다 (라벨→포맷)\n`)
            process.exit(1)
          }
          inputs = Object.fromEntries(Object.entries(values).map(([k, v]) => {
            const format = formatMap[k]
            return [k, format ? { value: v, format } : v]
          }))
        }

        // 출력 포맷 결정 — 확장자 오버라이드가 명시 --format 과 충돌하면 경고 후 확장자 우선
        let outputFormat = opts.format as string
        if (opts.output) {
          const ext = extname(opts.output).toLowerCase()
          const explicitFormat = command.getOptionValueSource("format") === "cli" || program.getOptionValueSource("format") === "cli"
          const before = outputFormat
          if (ext === ".hwpx") outputFormat = outputFormat === "markdown" ? "hwpx-preserve" : outputFormat
          else if (ext === ".md") outputFormat = "markdown"
          if (explicitFormat && before !== outputFormat) {
            process.stderr.write(`[kordoc] ⚠️ --format ${before} 가 출력 확장자(${ext})와 충돌합니다 — 확장자 기준 ${outputFormat} 로 진행\n`)
          }
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
            const hwpxResult = opts.requireUnique
              ? await fillWithUniqueGuard(inputs, (vals, blocked) => fillHwpx(arrayBuffer, vals, blocked))
              : { ...(await fillHwpx(arrayBuffer, inputs)), rejected: [] as string[] }
            if (!opts.silent) {
              process.stderr.write(`[kordoc] ${hwpxResult.filled.length}개 필드 채움 (원본 스타일 보존)\n`)
              if (hwpxResult.rejected.length > 0) {
                process.stderr.write(`[kordoc] ⚠️ 모호 라벨 거부(2곳+ 매칭): ${hwpxResult.rejected.join(", ")}\n`)
              }
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

        // ─── 일반 경로: parse → fill → output ─── (양식 입력란 보존, #47)
        const result = await parse(arrayBuffer, { keepTrailingEmptyCols: true })
        if (!result.success) {
          process.stderr.write(`[kordoc] 파싱 실패: ${result.error}\n`)
          process.exit(1)
        }

        const formInfo = extractFormFields(result.blocks)
        if (!opts.silent) {
          process.stderr.write(`[kordoc] 서식 필드 ${formInfo.fields.length}개 감지 (확신도 ${(formInfo.confidence * 100).toFixed(0)}%)\n`)
        }

        const fillResult = opts.requireUnique
          ? await fillWithUniqueGuard(inputs, (vals, blocked) => fillFormFields(result.blocks, vals, blocked))
          : { ...fillFormFields(result.blocks, inputs), rejected: [] as string[] }
        if (!opts.silent) {
          process.stderr.write(`[kordoc] ${fillResult.filled.length}개 필드 채움\n`)
          if (fillResult.rejected.length > 0) {
            process.stderr.write(`[kordoc] ⚠️ 모호 라벨 거부(2곳+ 매칭): ${fillResult.rejected.join(", ")}\n`)
          }
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
          } else if (opts.mask) {
            // 채운 값(주민번호·연락처 등)이 터미널 로그에 남지 않게 본문 대신 안내 (MCP mask_values와 동일 취지)
            process.stdout.write(`⚠️ --mask 활성 — 개인정보 노출 방지를 위해 본문을 출력하지 않습니다. -o 로 파일 저장 후 확인하세요.\n`)
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
        const { placeSealHwpx, detectFormat } = await import("../index.js")
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
        // 숫자 플래그 엄격 검증 — 비숫자가 NaN→0 무증상 강제, 음수 occurrence가 truthy로
        // 통과하던 것 차단 (MCP zod와 동등, v4.0.6: --size-mm만 검증하던 것을 전 숫자 플래그로)
        const parseNum = (flag: string, raw: unknown, { min, allowNeg = false }: { min?: number; allowNeg?: boolean } = {}): number => {
          const n = Number(raw)
          if (!Number.isFinite(n) || (!allowNeg && n < 0) || (min !== undefined && n < min)) {
            process.stderr.write(`[kordoc] ${flag} 값이 잘못됐습니다: ${raw}${allowNeg ? "" : " (0 이상 숫자)"}\n`)
            process.exit(1)
          }
          return n
        }
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
            occurrence: parseNum("--occurrence", opts.occurrence),
            image,
            ext: ext as "png" | "jpg" | "jpeg" | "bmp" | "gif",
            sizeMm,
            mode: mode as "overlap" | "right" | "auto",
            dxMm: parseNum("--dx", opts.dx, { allowNeg: true }),
            dyMm: parseNum("--dy", opts.dy, { allowNeg: true }),
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
    .description("서식 보존 라운드트립 패치 — 편집된 마크다운을 원본 HWPX/HWP에 in-place 반영 (kordoc patch 원본.hwpx 편집.md -o 출력.hwpx). 미적용(skip) 편집이 있으면 exit 2")
    .option("-o, --output <path>", "출력 경로 (기본: <원본>.patched.hwpx|.hwp)")
    .option("--no-verify", "패치 후 재파싱 자동 검증 생략")
    .option("--silent", "진행 메시지 숨기기")
    .action(async (original: string, edited: string, opts) => {
      try {
        const { patchHwpx, patchHwp, detectFormat } = await import("../index.js")
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
        const { validateHwpx } = await import("../index.js")
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
}
