/**
 * Surface-F 회귀 잠금 — CLI/MCP/watch/index 표면 결함 수정 (2026-07)
 *
 *  P1-1  README fillForm 예제 API — fillForm(input, values, outputFormat) 시그니처/반환 형태 잠금
 *  P1-2  watch 동시 폭주 시 대기 큐 drain (무음 유실 방지) — createTaskQueue
 *  P2-3  MCP 쓰기·읽기 경로 검증 — safeOutputPath / safePath(확장자 allowlist)
 *  P2-6  MCP·watch .xls/.hml 확장자 지원
 *  P2-7  CLI 다중 파일 + -o 무음 무시 → 경고
 *  P2-8  MCP parse_document 응답 상한 — capResponseText
 *  P2-9  Linux + Node<19.1 fs.watch recursive 명확한 안내 — assertRecursiveWatchSupport
 *  P3-10 webhook DNS 재검증 — isPrivateIp (IPv4-mapped IPv6 포함)
 *  P3-11 index.ts parse 실패 메시지 정제(sanitizeError) + MCP 분류 힌트(describeError)
 *  P3-14 CLI fill --formats/--require-unique (MCP fill_form 파리티)
 *  P3-15 CLI fill --format vs 출력 확장자 충돌 경고
 *  P3-16 --no-header-footer 도움말 교정 + patch exit 2 문서화
 *  P3-17 lint 사람용 리포트 stderr 채널 통일
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync, rmSync, copyFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createTaskQueue, assertRecursiveWatchSupport, isPrivateIp, SUPPORTED_EXTENSIONS } from "../src/watch.js"
// mcp.ts는 직접 실행이 아니면 서버를 자동 시작하지 않는다 (entry 가드) — 헬퍼만 import
import {
  ALLOWED_EXTENSIONS, IMAGE_EXTENSIONS, safePath, safeOutputPath,
  describeError, capResponseText, buildFillInputs,
} from "../src/mcp.js"
import { KordocError } from "../src/utils.js"
import { parse, fillForm, markdownToHwpx } from "../src/index.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const DUMMY = fileURLToPath(new URL("./fixtures/dummy.hwpx", import.meta.url))

const runCli = (args: string[], timeout = 30000) =>
  spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf-8", timeout })

function toAB(b: ArrayBuffer | Uint8Array): ArrayBuffer {
  return b instanceof ArrayBuffer ? b : (b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
}

// ─── P1-2: watch 동시 폭주 대기 큐 ─────────────────────

describe("P1-2 createTaskQueue — 상한 초과 대기 큐 drain", () => {
  it("상한 초과분은 유실되지 않고 완료 시 순서대로 실행된다", async () => {
    const started: string[] = []
    const resolvers = new Map<string, () => void>()
    const enqueue = createTaskQueue(2, (key) => {
      started.push(key)
      return new Promise<void>((res) => resolvers.set(key, res))
    })
    enqueue("a")
    enqueue("b")
    enqueue("c") // 상한 초과 → 대기
    enqueue("d") // 상한 초과 → 대기
    enqueue("c") // 대기 중 중복 → dedupe
    enqueue("a") // 처리 중 중복 → dedupe
    assert.deepEqual(started, ["a", "b"], "상한(2)까지만 즉시 시작")

    resolvers.get("a")!()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(started, ["a", "b", "c"], "a 완료 시 대기 중이던 c drain")

    resolvers.get("b")!()
    resolvers.get("c")!()
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(started, ["a", "b", "c", "d"], "d까지 전부 처리 — 무음 유실 없음")
  })

  it("완료된 키는 재입장 가능 (동일 파일 재수정 대응)", async () => {
    const started: string[] = []
    const enqueue = createTaskQueue(1, async (key) => { started.push(key) })
    enqueue("a")
    await new Promise((r) => setImmediate(r))
    enqueue("a")
    await new Promise((r) => setImmediate(r))
    assert.deepEqual(started, ["a", "a"])
  })
})

// ─── P2-9: Linux fs.watch recursive 안내 ───────────────

describe("P2-9 assertRecursiveWatchSupport", () => {
  it("linux + Node<19.1 → 명확한 에러 (크립틱 ERR_FEATURE_UNAVAILABLE 대체)", () => {
    assert.throws(() => assertRecursiveWatchSupport("linux", "18.19.0"), /Node 19\.1 이상/)
    assert.throws(() => assertRecursiveWatchSupport("linux", "19.0.1"), /Node 19\.1 이상/)
  })
  it("linux + Node 19.1+/20+ 및 비Linux는 통과", () => {
    assert.doesNotThrow(() => assertRecursiveWatchSupport("linux", "19.1.0"))
    assert.doesNotThrow(() => assertRecursiveWatchSupport("linux", "20.11.0"))
    assert.doesNotThrow(() => assertRecursiveWatchSupport("darwin", "18.0.0"))
    assert.doesNotThrow(() => assertRecursiveWatchSupport("win32", "18.0.0"))
  })
})

// ─── P3-10: webhook 사설 IP 재검증 ─────────────────────

describe("P3-10 isPrivateIp — DNS 해석 결과 재검증", () => {
  it("IPv4 사설/내부 대역", () => {
    for (const ip of ["10.0.0.1", "127.0.0.1", "192.168.0.1", "172.16.5.5", "172.31.255.255", "169.254.1.1", "0.0.0.0", "100.64.0.1"]) {
      assert.equal(isPrivateIp(ip), true, `${ip} 는 사설이어야`)
    }
  })
  it("IPv4-mapped IPv6 우회 차단", () => {
    assert.equal(isPrivateIp("::ffff:10.0.0.1"), true)
    assert.equal(isPrivateIp("::ffff:192.168.1.1"), true)
    assert.equal(isPrivateIp("::ffff:8.8.8.8"), false)
  })
  it("IPv6 사설 대역 (ULA·link-local·loopback)", () => {
    for (const ip of ["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1"]) {
      assert.equal(isPrivateIp(ip), true, `${ip} 는 사설이어야`)
    }
  })
  it("공인 IP는 통과", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "2001:4860:4860::8888"]) {
      assert.equal(isPrivateIp(ip), false, `${ip} 는 공인이어야`)
    }
  })
})

// ─── P2-6: .xls/.hml 확장자 지원 ───────────────────────

describe("P2-6 확장자 allowlist — .xls/.hml", () => {
  it("watch SUPPORTED_EXTENSIONS 에 .xls/.hml 포함", () => {
    assert.ok(SUPPORTED_EXTENSIONS.has(".xls"))
    assert.ok(SUPPORTED_EXTENSIONS.has(".hml"))
  })
  it("MCP ALLOWED_EXTENSIONS 에 .xls/.hml 포함", () => {
    assert.ok(ALLOWED_EXTENSIONS.has(".xls"))
    assert.ok(ALLOWED_EXTENSIONS.has(".hml"))
  })
})

// ─── P2-3: MCP 경로 검증 ───────────────────────────────

describe("P2-3 safeOutputPath / safePath — 쓰기·읽기 경로 검증", () => {
  it("출력 확장자 allowlist 위반 → KordocError", () => {
    assert.throws(() => safeOutputPath("/tmp/out.exe", new Set([".hwpx"])), KordocError)
    assert.throws(() => safeOutputPath("/tmp/out", new Set([".hwpx"])), /지원하지 않는 출력 확장자/)
    assert.throws(() => safeOutputPath("", new Set([".hwpx"])), /비어있습니다/)
  })
  it("허용 확장자는 부모 realpath 로 정규화된 절대 경로 반환", () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-out-"))
    try {
      const p = safeOutputPath(join(dir, "결과.hwpx"), new Set([".hwpx"]))
      assert.ok(p.endsWith("결과.hwpx"))
      // 부모가 아직 없는 경로도 확장자만 맞으면 통과 (저장 시 생성)
      const p2 = safeOutputPath(join(dir, "아직없는폴더", "결과.json"), new Set([".json"]))
      assert.ok(p2.endsWith("결과.json"))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it("place_seal image_path — 이미지 확장자 allowlist + 실존 검증", () => {
    // 문서 확장자를 이미지 자리에 → 거부
    assert.throws(() => safePath(DUMMY, IMAGE_EXTENSIONS), /지원하지 않는 확장자/)
    // 실존하지 않는 이미지 → 명확한 메시지 (기존: raw ENOENT 가 '문서 처리 중 오류'로 뭉개짐)
    assert.throws(() => safePath("/no/such/도장.png", IMAGE_EXTENSIONS), /파일을 찾을 수 없습니다/)
  })
})

// ─── P2-8: MCP 응답 상한 ───────────────────────────────

describe("P2-8 capResponseText — parse_document 응답 상한", () => {
  it("상한 이내는 그대로", () => {
    assert.equal(capResponseText("짧은 응답"), "짧은 응답")
  })
  it("상한 초과는 절단 + parse_pages 안내", () => {
    const long = "가".repeat(250_000)
    const capped = capResponseText(long)
    assert.ok(capped.length < long.length)
    assert.match(capped, /절단됨/)
    assert.match(capped, /parse_pages/)
  })
})

// ─── P3-11: 에러 노출 일관성 ───────────────────────────

describe("P3-11 describeError — MCP 오류 분류 힌트", () => {
  it("KordocError 는 메시지 그대로", () => {
    assert.equal(describeError(new KordocError("파일이 너무 큽니다")), "파일이 너무 큽니다")
  })
  it("fs 계열(ENOENT 등)은 경로 노출 없이 코드 힌트", () => {
    const err = Object.assign(new Error("ENOENT: no such file or directory, open '/secret/path'"), { code: "ENOENT" })
    const msg = describeError(err)
    assert.match(msg, /ENOENT/)
    assert.ok(!msg.includes("/secret/path"), "내부 경로가 노출되면 안 됨")
  })
  it("일반 에러는 일반화, 분류 가능하면 코드 병기", () => {
    assert.equal(describeError(new Error("내부 스택 정보")), "문서 처리 중 오류가 발생했습니다")
    assert.match(describeError(new Error("ZIP 비압축 크기 초과")), /ZIP_BOMB/)
  })
})

describe("P3-11 index.ts parse 실패 메시지 정제", () => {
  it("KordocError(파서 자체 에러)는 메시지 보존 + code 분류", async () => {
    // OLE2 매직 + 쓰레기 → parseHwp5Document 가 KordocError throw
    const buf = new Uint8Array(600)
    buf.set([0xd0, 0xcf, 0x11, 0xe0])
    const res = await parse(toAB(buf))
    assert.equal(res.success, false)
    if (!res.success) {
      assert.notEqual(res.error, "문서 처리 중 오류가 발생했습니다", "KordocError 메시지는 살아있어야")
    }
  })
  it("비KordocError(내부 에러)는 일반화되고 code 는 유지", async () => {
    // HWPML 50MB 상한 위반 → 파서가 plain Error throw → sanitizeError 로 일반화
    const head = '<?xml version="1.0" encoding="UTF-8"?><HWPML>'
    const big = head + " ".repeat(51 * 1024 * 1024)
    const res = await parse(toAB(new TextEncoder().encode(big)))
    assert.equal(res.success, false)
    if (!res.success) {
      assert.equal(res.fileType, "hwpml")
      assert.equal(res.error, "문서 처리 중 오류가 발생했습니다", "plain Error 메시지는 일반화")
      assert.equal(res.code, "DECOMPRESSION_BOMB", "code 분류는 유지 (classifyError 는 원본 기준)")
    }
  })
})

// ─── P1-1: fillForm 시그니처/반환 (README 예제 계약) ────

describe("P1-1 fillForm — README 예제 API 계약", () => {
  it('fillForm(input, values, "hwpx-preserve") → { output, format, fill: { filled, unmatched } }', async () => {
    const tpl = await markdownToHwpx("| 성명 |  |\n|---|---|\n")
    const result = await fillForm(toAB(tpl), { 성명: "홍길동" }, "hwpx-preserve")
    assert.equal(result.format, "hwpx-preserve")
    assert.ok(result.output instanceof ArrayBuffer, "hwpx-preserve 출력은 ArrayBuffer")
    assert.ok(Array.isArray(result.fill.filled))
    assert.ok(Array.isArray(result.fill.unmatched))
    assert.equal(result.fill.filled[0]?.value, "홍길동")
  })
  it("outputFormat 미지정 기본은 markdown 문자열", async () => {
    const tpl = await markdownToHwpx("| 성명 |  |\n|---|---|\n")
    const result = await fillForm(toAB(tpl), { 성명: "홍길동" })
    assert.equal(result.format, "markdown")
    assert.equal(typeof result.output, "string")
  })
})

// ─── MCP fill_form 헬퍼 (P3-14 파리티의 SSOT) ──────────

describe("buildFillInputs — fields+formats 결합", () => {
  it("formats 지정 라벨만 { value, format } 로 승격", () => {
    const inputs = buildFillInputs({ 성명: "홍길동", 생년월일: "19900315" }, { 생년월일: "date:yyyy-mm-dd" })
    assert.equal(inputs["성명"], "홍길동")
    assert.deepEqual(inputs["생년월일"], { value: "19900315", format: "date:yyyy-mm-dd" })
  })
})

// ─── CLI 표면 (spawn) ──────────────────────────────────

describe("P2-7 CLI 다중 파일 + -o", () => {
  it("다중 파일에 -o 지정 시 stderr 경고 + --out-dir 안내", () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-multi-"))
    try {
      const a = join(dir, "a.hwpx")
      const b = join(dir, "b.hwpx")
      copyFileSync(DUMMY, a)
      copyFileSync(DUMMY, b)
      const r = runCli([a, b, "-o", join(dir, "out.md"), "--silent"])
      assert.match(r.stderr, /단일 파일 전용/)
      assert.match(r.stderr, /--out-dir/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("P3-14/15 CLI fill — formats·require-unique·format 충돌", () => {
  it("--require-unique: 2곳+ 매칭 라벨은 거부 보고", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-uniq-"))
    try {
      const tpl = join(dir, "tpl.hwpx")
      const md = "| 성명 |  |\n|---|---|\n\n중간 본문\n\n| 성명 |  |\n|---|---|\n"
      writeFileSync(tpl, Buffer.from(await markdownToHwpx(md)))
      const out = join(dir, "out.hwpx")
      const r = runCli(["fill", tpl, "-f", "성명=홍길동", "--require-unique", "-o", out])
      assert.match(r.stderr, /모호 라벨 거부/)
      assert.match(r.stderr, /성명/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--formats: 값 서식 변환 후 채움 (MCP formats 파리티)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-formats-"))
    try {
      const tpl = join(dir, "tpl.hwpx")
      writeFileSync(tpl, Buffer.from(await markdownToHwpx("| 생년월일 |  |\n|---|---|\n")))
      const out = join(dir, "out.hwpx")
      const r = runCli(["fill", tpl, "-f", "생년월일=19900315", "--formats", '{"생년월일":"date:yyyy년 m월 d일"}', "-o", out])
      assert.equal(r.status, 0, r.stderr)
      assert.ok(existsSync(out))
      const reparsed = await parse(out)
      assert.equal(reparsed.success, true)
      if (reparsed.success) assert.match(reparsed.markdown, /1990년 3월 15일/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("--format 명시가 출력 확장자와 충돌하면 stderr 경고", () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-conflict-"))
    try {
      const out = join(dir, "out.hwpx")
      const r = runCli(["fill", DUMMY, "-f", "항목=값", "--format", "markdown", "-o", out])
      assert.match(r.stderr, /충돌/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("P3-16 도움말 문서화", () => {
  it("--no-header-footer 도움말이 '끄기'로 설명된다 (역설명 교정)", () => {
    const r = runCli(["--help"])
    assert.match(r.stdout, /머리글\/바닥글 자동 제거 끄기/)
  })
  it("patch 도움말에 exit 2 문서화", () => {
    const r = runCli(["patch", "--help"])
    assert.match(r.stdout, /exit 2/)
  })
})

describe("P3-17 lint 출력 채널", () => {
  it("사람용 리포트는 stderr, stdout 은 비어있다 (--json 만 stdout)", () => {
    const dir = mkdtempSync(join(tmpdir(), "kordoc-lint-"))
    try {
      const md = join(dir, "doc.md")
      writeFileSync(md, "본문입니다.\n", "utf-8")
      const r = runCli(["lint", md])
      assert.match(r.stderr, /표기법 검수/)
      assert.equal(r.stdout, "", "비JSON 모드 stdout 은 비어있어야 (스크립트 파이프 보호)")
      const rj = runCli(["lint", md, "--json"])
      assert.ok(rj.stdout.trim().startsWith("{"), "--json 은 stdout 에 JSON")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
