/** kordoc CLI 명령 — 서버·설정·모델 — mcp·setup·check-formula-models·check-ocr-models·models */

import { sanitizeError } from "../utils.js"
import type { Command } from "commander"

export function registerSystemCommands(program: Command): void {
  program
    .command("mcp")
    .description("MCP 서버 실행 (Claude / Cursor / Windsurf 연동)")
    .action(async () => {
      const { startMcpServer } = await import("../mcp.js")
      await startMcpServer()
    })

  program
    .command("setup")
    .description("대화형 설치 마법사 — AI 클라이언트 자동 등록 (Mac/Win/Linux)")
    .action(async () => {
      const { runSetup } = await import("../setup.js")
      await runSetup()
    })

  program
    .command("check-formula-models")
    .description("PDF 수식 OCR 모델(MFD + MFR + tokenizer, ~155MB) 상태 확인 — 없거나 SHA 불일치면 다운로드")
    .option("--status-only", "상태만 JSON 으로 출력 (다운로드 안 함)")
    .action(async (opts) => {
      try {
        const { getFormulaModelStatus, ensureFormulaModels, getFormulaModelsDir } = await import(
          "../pdf/formula/index.js"
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

  program
    .command("check-ocr-models")
    .description("텍스트 OCR 모델(PP-OCRv5 korean det+rec, ~18MB) 상태 확인 — 없거나 SHA 불일치면 다운로드")
    .option("--status-only", "상태만 JSON 으로 출력 (다운로드 안 함)")
    .action(async (opts) => {
      try {
        const { getOcrModelStatus, ensureOcrModels, getOcrModelsDir } = await import("../ocr/models.js")
        const dir = getOcrModelsDir()
        if (opts.statusOnly) {
          const status = await getOcrModelStatus()
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
        process.stderr.write(`[kordoc-ocr] 캐시 디렉토리: ${dir}\n`)
        await ensureOcrModels((p) => {
          if (p.phase === "download" && p.total) {
            const pct = Math.floor((p.downloaded / p.total) * 100)
            process.stderr.write(
              `\r[kordoc-ocr] ${p.spec.name} ${pct}% (${(p.downloaded / 1024 / 1024).toFixed(1)}/${(p.total / 1024 / 1024).toFixed(1)}MB)`,
            )
            if (p.downloaded >= p.total) process.stderr.write("\n")
          } else if (p.phase === "verify") {
            process.stderr.write(`[kordoc-ocr] ${p.spec.name} SHA-256 검증 중...\n`)
          } else if (p.phase === "done") {
            process.stderr.write(`[kordoc-ocr] ${p.spec.name} 준비 완료\n`)
          } else if (p.phase === "skip") {
            process.stderr.write(`[kordoc-ocr] ${p.spec.name} 이미 존재 (skip)\n`)
          }
        })
        process.stdout.write("ok\n")
      } catch (err) {
        process.stderr.write(`[kordoc] OCR 모델 준비 실패: ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })

  program
    .command("models")
    .description("OCR/수식 모델 오프라인 사이드로드 — 폐쇄망 반입용 내보내기/가져오기 (SHA-256 검증)")
    .option("--status", "캐시에 설치된 모델 상태를 JSON 으로 출력")
    .option("--export <dir>", "로컬 캐시 → 번들 디렉토리로 내보내기 (온라인 PC에서 실행)")
    .option("--import <dir>", "번들 디렉토리 → 로컬 캐시로 설치 (내부망 PC에서 실행)")
    .action(async (opts) => {
      try {
        const { exportModels, importModels, modelCacheStatus } = await import("../shared/model-bundle.js")
        if (opts.status) {
          process.stdout.write(JSON.stringify(await modelCacheStatus(), null, 2) + "\n")
          return
        }
        const dir = opts.export ?? opts.import
        if (!dir) {
          process.stderr.write("[kordoc] --status / --export <dir> / --import <dir> 중 하나가 필요합니다\n")
          process.exit(1)
        }
        if (opts.export && opts.import) {
          process.stderr.write("[kordoc] --export 와 --import 는 함께 쓸 수 없습니다\n")
          process.exit(1)
        }
        const result = opts.export ? await exportModels(dir) : await importModels(dir)
        for (const f of result.files) {
          const mark = f.status === "copied" ? "+" : f.status === "invalid" ? "!" : "-"
          process.stderr.write(`  ${mark} ${f.group}/${f.filename}${f.reason ? ` — ${f.reason}` : ""}\n`)
        }
        const verb = opts.export ? "내보내기" : "설치"
        const copied = result.files.filter((f) => f.status === "copied").length
        process.stderr.write(
          `[kordoc-models] ${verb} ${result.ok ? `완료 (${copied}개)` : "실패 — 위 ! / - 항목 확인"}: ${dir}\n`,
        )
        if (!result.ok) process.exit(1)
        process.stdout.write("ok\n")
      } catch (err) {
        process.stderr.write(`[kordoc] 모델 사이드로드 실패: ${sanitizeError(err)}\n`)
        process.exit(1)
      }
    })
}
