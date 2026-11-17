/** CLI 입출력 경계 — 잘못된 fill 포맷은 원본을 보존하고 generate --plain은 범용 생성으로 전달한다. */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const DUMMY = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))

for (const format of ["typo", "json"]) {
  test(`fill --format ${format}는 실패하고 같은 -o 경로의 원본 ZIP 바이트를 보존한다`, () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-fill-invalid-format-"))
    try {
      const original = join(dir, "form.hwpx")
      const values = join(dir, "values.json")
      copyFileSync(DUMMY, original)
      const before = readFileSync(original)
      assert.equal(before.subarray(0, 2).toString("ascii"), "PK")
      writeFileSync(values, JSON.stringify({ 성명: "홍길동" }))

      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI, "fill", original, "-j", values, "--format", format, "-o", original],
        { encoding: "utf-8", timeout: 30000 },
      )
      assert.equal(r.error, undefined)
      assert.notEqual(r.status, null, r.stderr)
      assert.ok(readFileSync(original).equals(before), "잘못된 포맷으로 원본 HWPX를 덮어쓰면 안 됨")
      assert.notEqual(r.status, 0, `잘못된 --format을 거부해야 함 — stderr: ${r.stderr}`)
      assert.match(r.stderr, /--format/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const position of ["before", "after"] as const) {
  test(`generate 앞·뒤 --plain 전달: ${position} 위치도 실제 HWPX에 공문서 번호·끝표시를 넣지 않는다`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-generate-plain-"))
    try {
      const input = join(dir, "input.md")
      const output = join(dir, "plain.hwpx")
      writeFileSync(input, "# 제목\n\n## 개요\n\n본문입니다.")
      const args = position === "before"
        ? ["--plain", "generate", input, "-o", output]
        : ["generate", input, "--plain", "-o", output]
      const r = spawnSync(
        process.execPath,
        ["--import", "tsx", CLI, ...args],
        { encoding: "utf-8", timeout: 30000 },
      )
      assert.equal(r.error, undefined)
      assert.equal(r.status, 0, r.stderr)
      const zip = await JSZip.loadAsync(readFileSync(output))
      const section = await zip.file("Contents/section0.xml")!.async("text")
      assert.match(section, /<hp:t>개요<\/hp:t>/, "범용 생성의 헤딩 원문을 유지해야 함")
      assert.doesNotMatch(section, /<hp:t>1\./, "기안문 항목 번호를 붙이면 안 됨")
      assert.doesNotMatch(section, /끝\./, "기안문 자동 끝표시를 넣으면 안 됨")
      assert.ok(!r.stderr.includes("공문서:"), r.stderr)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

test("--password 대신 환경 변수 KORDOC_PASSWORD 로 암호 문서를 연다 (명령줄 인자는 프로세스 목록에 보인다)", () => {
  const fixture = fileURLToPath(new URL("./fixtures/password/HWP5-password-123456.hwpx", import.meta.url))
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, ["--import", "tsx", CLI, fixture, "--silent"], {
    encoding: "utf-8", timeout: 60000, env: { ...process.env, ...env },
  })
  const locked = run({ KORDOC_PASSWORD: "" })
  assert.notEqual(locked.status, 0, "암호 없이는 열리지 않아야 시험이 뜻이 있다")
  const opened = run({ KORDOC_PASSWORD: "123456" })
  assert.equal(opened.status, 0, opened.stderr)
  assert.ok(opened.stdout.trim().length > 0)
})
