/** `kordoc lint` 입력 회귀
 *
 * lint 는 텍스트를 UTF-8 로 읽는다. hwpx(ZIP)를 그대로 읽으면 압축 바이트가 본문으로 둔갑해 위반이
 * 수백~수천 건 나왔다(README 예제 실측 1,193건). 문서 포맷은 파싱한 본문 마크다운을 검사한다(v4.20.0 —
 * 종전에는 거절했다. 외부 도구가 parse → lint 로 두 번 띄우던 것).
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

test("hwpx 는 파싱한 본문을 검수한다 — 압축 바이트를 글로 읽지 않는다", () => {
  const r = runLint([DUMMY, "--json"])
  assert.ok(r.status === 0 || r.status === 1, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.ok(Array.isArray(out.findings))
  assert.ok(out.findings.length < 50, `위반 ${out.findings.length}건 — 압축 바이트를 글로 읽은 것`)
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
