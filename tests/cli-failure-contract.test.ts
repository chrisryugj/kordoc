/** CLI 실패 계약 (#69) + images/manifest.json (#70)
 *
 * #69: 실패 JSON(success:false + code)은 --format json 전용이 아니라 markdown·chunks 에서도
 * stdout 으로 나와야 한다 — 호출자가 stderr 한국어 문구 대신 원인 코드로 분기하는 기계 계약.
 * #70: 이미지 저장 시 images/manifest.json 에 name/mimeType/bytes/source 를 방출해
 * 소비자가 확장자·매직바이트 추측 없이 형식 분기한다.
 */

import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const DUMMY = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))

function runCli(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf-8", timeout: 60000,
  })
}

/** 지원하지 않는 바이트열 파일 생성 */
function makeUnsupported(dir: string): string {
  const p = join(dir, "notadoc.bin")
  writeFileSync(p, Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01, 0x02, 0x03]))
  return p
}

test("#69 markdown 모드 실패 — stdout 에 실패 JSON + exit 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-fail-"))
  try {
    const r = runCli([makeUnsupported(dir)])
    assert.equal(r.status, 1)
    const j = JSON.parse(r.stdout)
    assert.equal(j.success, false)
    assert.equal(j.code, "UNSUPPORTED_FORMAT")
    assert.ok(typeof j.error === "string" && j.error.length > 0)
    assert.ok(typeof j.fileType === "string")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("#69 chunks 모드 실패 — 동일 실패 JSON, 성공(배열)과 객체로 구분", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-fail-"))
  try {
    const fail = runCli(["--format", "chunks", makeUnsupported(dir)])
    assert.equal(fail.status, 1)
    const j = JSON.parse(fail.stdout)
    assert.equal(Array.isArray(j), false, "실패는 객체")
    assert.equal(j.success, false)
    assert.equal(j.code, "UNSUPPORTED_FORMAT")

    const ok = runCli(["--format", "chunks", DUMMY])
    assert.equal(ok.status, 0)
    assert.ok(Array.isArray(JSON.parse(ok.stdout)), "성공 페이로드는 JSON 배열")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("#69 markdown --output 실패 — 출력 파일 미생성 + stdout 실패 JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-fail-"))
  try {
    const out = join(dir, "out.md")
    const r = runCli(["-o", out, makeUnsupported(dir)])
    assert.equal(r.status, 1)
    assert.equal(existsSync(out), false, "실패 시 출력 파일이 생기면 안 됨")
    assert.equal(JSON.parse(r.stdout).success, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("#70 이미지 저장 시 images/manifest.json — name/mimeType/bytes/source", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kordoc-manifest-"))
  try {
    // dummy.hwpx 에 미참조 BinData PNG 주입 → 스윕(v4.0.8)이 추출
    const JSZip = require("jszip")
    const zip = await JSZip.loadAsync(readFileSync(DUMMY))
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      "base64",
    )
    zip.file("BinData/extra.png", png)
    const src = join(dir, "withimg.hwpx")
    writeFileSync(src, await zip.generateAsync({ type: "nodebuffer" }))

    const outDir = join(dir, "out")
    const r = runCli(["-d", outDir, src])
    assert.equal(r.status, 0, `CLI 실패: ${r.stderr}`)

    const manifestPath = join(outDir, "images", "manifest.json")
    assert.ok(existsSync(manifestPath), "images/manifest.json 이 생성되어야 함")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"))
    assert.ok(Array.isArray(manifest))
    const entry = manifest.find((m: { source?: string }) => m.source === "BinData/extra.png")
    assert.ok(entry, "주입한 이미지의 manifest 항목")
    assert.equal(entry.mimeType, "image/png")
    assert.equal(entry.bytes, png.length)
    assert.ok(existsSync(join(outDir, "images", entry.name)), "manifest name 이 실제 파일을 가리킴")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
