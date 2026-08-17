/** `kordoc lint` 입력 가드 회귀
 *
 * lint 는 파일을 UTF-8 텍스트로 읽는다. hwpx(ZIP)를 그대로 넘기면 압축 바이트가 본문으로
 * 둔갑해 위반이 수백~수천 건 나온다(README 예제가 실제로 그랬고 실측 1,193건). 검수
 * 결과처럼 보이는 쓰레기가 "검사 못 함"보다 나쁘므로, 문서 포맷은 받기 전에 거절한다.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const DUMMY = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))

const runLint = (args: string[], input?: string) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, "lint", ...args], {
    encoding: "utf-8",
    input,
    timeout: 30000,
  })

test("hwpx 를 넘기면 검수 결과 대신 안내를 내고 실패한다", () => {
  const r = runLint([DUMMY])
  assert.equal(r.status, 1, "exit 1 이어야 함")
  assert.match(r.stderr, /텍스트\(마크다운\/txt\)를 검사합니다/)
  assert.match(r.stderr, /hwpx 문서는 받지 않습니다/)
  assert.doesNotMatch(r.stderr, /표기법 검수: 위반/, "위반 건수를 세지 않아야 함")
})

test("마크다운은 종전대로 검수한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-lint-"))
  try {
    const md = join(dir, "a.md")
    writeFileSync(md, "1. 개요\n  가. 목적\n")
    const r = runLint([md])
    assert.equal(r.status, 0)
    assert.match(r.stderr, /표기법 검수: 위반/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("stdin 파이프('-')는 가드에 걸리지 않는다", () => {
  const r = runLint(["-"], "1. 개요\n  가. 목적\n")
  assert.equal(r.status, 0)
  assert.match(r.stderr, /표기법 검수: 위반/)
})
