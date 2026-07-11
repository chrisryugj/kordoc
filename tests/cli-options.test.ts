/** CLI 루트 옵션 가로채기 보완 회귀 — plugin-1(fill -o), plugin-5(watch -d)
 *
 * commander 는 루트 커맨드에 정의된 동명 옵션(-o/-d/--format/--silent)을 서브커맨드
 * 뒤에 와도 루트가 소비한다. fill·watch 액션에 `opts.X ?? program.opts().X` 폴백이
 * 없으면 -o/-d 가 흡수돼 결과가 파일 대신 stdout 으로 새고 exit 0 으로 무증상 실패한다.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const DUMMY = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))

test("plugin-1: fill 서브커맨드 뒤 -o 가 루트에 흡수되지 않고 파일을 쓴다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-fill-"))
  try {
    const out = join(dir, "out.hwpx")
    const vals = join(dir, "vals.json")
    writeFileSync(vals, JSON.stringify({ 성명: "홍길동" }))
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", CLI, "fill", DUMMY, "-j", vals, "-o", out],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 30000 },
    )
    assert.ok(existsSync(out), "fill … -o 결과 파일이 생성되어야 함")
    assert.ok(statSync(out).size > 0, "결과 파일이 비어있지 않아야 함")
    assert.equal(stdout.length, 0, "결과가 stdout(HWPX 바이너리 덤프)으로 새지 않아야 함")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("plugin-5: watch 서브커맨드 뒤 -d 가 루트에 흡수되지 않고 outDir 로 전달된다", async () => {
  const inDir = mkdtempSync(join(tmpdir(), "kordoc-watch-in-"))
  const outDir = mkdtempSync(join(tmpdir(), "kordoc-watch-out-"))
  const child = spawn(
    process.execPath,
    ["--import", "tsx", CLI, "watch", inDir, "-d", outDir],
    { stdio: ["ignore", "ignore", "pipe"] },
  )
  try {
    // outDir 이 watch 로 전달되어야만 '출력:' 로그가 뜬다 (watch.ts:32 `if (outDir)`).
    const sawOutputLog = await new Promise<boolean>((resolve) => {
      let buf = ""
      const timer = setTimeout(() => resolve(false), 20000)
      child.stderr.on("data", (d) => {
        buf += String(d)
        if (buf.includes("[kordoc watch] 출력:")) {
          clearTimeout(timer)
          resolve(true)
        }
      })
      child.on("exit", () => {
        clearTimeout(timer)
        resolve(buf.includes("[kordoc watch] 출력:"))
      })
    })
    assert.ok(sawOutputLog, "watch … -d 가 outDir 로 전달되어 '출력:' 로그가 나와야 함")
  } finally {
    child.kill("SIGKILL")
    rmSync(inDir, { recursive: true, force: true })
    rmSync(outDir, { recursive: true, force: true })
  }
})

test("generate: 잘못된 --pt/--line-spacing은 실패하고 HWPX를 쓰지 않는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-generate-invalid-"))
  try {
    const input = join(dir, "input.md")
    writeFileSync(input, "# 제목\n\n본문")
    for (const [flag, value] of [["--pt", "abc"], ["--line-spacing", "nope"]]) {
      const out = join(dir, `${flag.slice(2)}.hwpx`)
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI, "generate", input, "-o", out, flag, value, "--silent"],
        { encoding: "utf-8", timeout: 30000 },
      )
      assert.notEqual(result.status, 0, `${flag} ${value}는 exit 0이면 안 됨`)
      assert.ok(!existsSync(out), `${flag} ${value} 입력으로 결과 파일을 쓰면 안 됨`)
      assert.match(result.stderr, new RegExp(flag.slice(2).replace("-", ""), "i"))
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
