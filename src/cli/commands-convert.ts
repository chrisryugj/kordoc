/** kordoc CLI 명령 — 변환 — to-hwpx */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync } from "fs"
import { dirname, join, resolve } from "path"
import { Command } from "commander"
import { sanitizeError, KordocError } from "../utils.js"

export function registerConvertCommands(program: Command): void {
  program
    .command("to-hwpx <paths...>")
    .description("HWP 문서를 HWPX 로 변환 — HWP 5.x 는 서식 그대로(글꼴·문단 모양·표·그림·도형·수식·머리말·각주·차트 …), HWP 3.x 는 글·표만. " +
      "폴더를 주면 하위 폴더까지 .hwp·.hml 을 모두 바꿔 각 파일 옆에 둔다")
    .option("-o, --output <path>", "저장 경로 — 파일 하나일 때만 (기본: 입력과 같은 이름의 .hwpx — 그 파일이 이미 있으면 덮어쓰지 않고 멈춘다)")
    .option("--password <pw>", "암호로 보호된 HWP 의 열기 암호")
    .option("--engine <name>", "변환 엔진: kordoc(기본, 어디서나) | hancom(Windows 한/글 자체 저장 — 팝업 없이, HWP 3.x 도 서식 그대로) | auto(한/글 있으면 hancom)", "kordoc")
    .option("--json", "결과 요약을 JSON 으로 stdout 에 출력")
    .action(async (paths: string[], opts) => {
      // 루트 커맨드의 동명 옵션(-o/--password)이 서브커맨드 옵션을 가로채는 commander 동작 보완
      const rootOpts = program.opts()
      const output: string | undefined = opts.output ?? rootOpts.output
      const password: string | undefined = opts.password ?? rootOpts.password
      const files: string[] = []
      let batch = paths.length > 1
      try {
        for (const p of paths.map(x => resolve(x))) {
          if (statSync(p).isDirectory()) { batch = true; files.push(...hwpFilesIn(p)) } else files.push(p)
        }
        if (batch && output) throw new KordocError("-o 는 파일 하나를 바꿀 때만 씁니다 — 여러 파일·폴더는 각 파일 옆에 .hwpx 로 저장합니다")
        if (!["kordoc", "hancom", "auto"].includes(opts.engine)) throw new KordocError(`--engine 은 kordoc·hancom·auto 입니다 (받은 값: ${opts.engine})`)
      } catch (err) {
        process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
        process.exit(2)
      }
      const { convertToHwpx, validateHwpx } = await import("../index.js")
      const results: Array<Record<string, unknown>> = []
      let failed = 0, skipped = 0
      for (const input of files) {
        try {
          const out = resolve(output ?? input.replace(/\.(hwp|hml)$/i, "") + ".hwpx")
          if (out === input) throw new KordocError("출력 경로가 입력 파일과 같습니다 — -o 로 다른 경로를 지정하세요")
          // 같은 이름 .hwpx 는 한글로 따로 저장해 둔 문서일 수 있다 — 기본 경로로는 덮어쓰지 않는다(여럿을 바꿀 때는 건너뛴다)
          if (!output && existsSync(out)) {
            if (!batch) throw new KordocError(`${out} 이(가) 이미 있습니다 — 덮어쓰려면 -o 로 경로를 직접 지정하세요`)
            skipped++
            results.push({ input, output: out, skipped: "이미 있음" })
            if (!opts.json) process.stderr.write(`[kordoc] 건너뜀(이미 있음): ${out}\n`)
            continue
          }
          const result = await convertToHwpx(new Uint8Array(readFileSync(input)), { password, engine: opts.engine })
          const check = await validateHwpx(result.data)
          mkdirSync(dirname(out), { recursive: true })
          writeFileSync(out, result.data)
          results.push({ ...(batch ? { input } : {}), output: out, mode: result.mode, engine: result.engine, bytes: result.data.length, valid: check.ok, warnings: result.warnings })
          if (!opts.json) {
            process.stderr.write(`[kordoc] ${result.mode === "preserve" ? "서식 그대로" : "글·표만"} 변환${result.engine === "hancom" ? "(한/글 저장)" : ""}: ${out} (${result.data.length.toLocaleString()} 바이트)\n`)
            for (const w of result.warnings) process.stderr.write(`[kordoc] ⚠️ ${w}\n`)
            if (!check.ok) for (const i of check.issues) process.stderr.write(`[kordoc] ✗ ${i.path ? `${i.path}: ` : ""}${i.message}\n`)
          }
          if (!check.ok) failed++
        } catch (err) {
          if (!batch) {
            process.stderr.write(`[kordoc] 오류: ${sanitizeError(err)}\n`)
            process.exit(2)
          }
          failed++
          results.push({ input, error: sanitizeError(err) })
          if (!opts.json) process.stderr.write(`[kordoc] 오류: ${input}: ${sanitizeError(err)}\n`)
        }
      }
      if (opts.json) process.stdout.write(JSON.stringify(batch ? { converted: files.length - failed - skipped, skipped, failed, files: results } : results[0], null, 2) + "\n")
      else if (batch) process.stderr.write(`[kordoc] ${files.length}개 중 변환 ${files.length - failed - skipped} · 건너뜀 ${skipped} · 실패 ${failed}\n`)
      if (failed) process.exit(1)
    })
}

/** 폴더 아래(하위 폴더 포함) .hwp·.hml 파일 — 숨김 폴더는 건너뛴다 */
function hwpFilesIn(dir: string): string[] {
  const out: string[] = []
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".")) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...hwpFilesIn(p))
    else if (/\.(hwp|hml)$/i.test(e.name)) out.push(p)
  }
  return out
}
