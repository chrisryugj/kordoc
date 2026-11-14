import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { markdownToHwpx, hwpxToHwp, parse } from "../src/index.js"
import { buildGongmunOptions } from "../src/hwpx/gongmun-surface.js"
import { registerGenerateTools } from "../src/mcp/tools-generate.js"

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c90000000049454e44ae426082", "hex")
const MD = "# 2027년 업무 계획\n\n## 1. 추진배경\n\n- 대상 1,234건 처리\n  - 세부 항목 정리\n\n| 구분 | 내용 |\n| --- | --- |\n| 1단계 | 조사 |\n\n수식 $\\frac{a}{b}+x^2$ 있음.\n\n![그림](p.png)\n"
const isHwp = (b: Uint8Array) => Buffer.from(b.subarray(0, 4)).toString("hex") === "d0cf11e0"
// 생성본 HWPX 파서는 kordoc 이 만든 장 띠·인용 상자를 제목·인용으로 되읽는다 — 글자만 맞춘다
const letters = (s: string | undefined) => (s ?? "").replace(/[^\p{L}\p{N}]/gu, "")

test("hwpxToHwp: 생성한 HWPX 를 HWP 5.0 으로 — 쪽 설정·수식·그림·공문서 프리셋 글이 그대로 되읽힌다", async () => {
  const cases = [
    undefined,
    { page: { columns: 2, columnLine: true }, inlineMath: true },
    { gongmun: buildGongmunOptions({ preset: "official" }) },
  ]
  for (const opts of cases) {
    const hwpx = await markdownToHwpx(MD, { ...opts, images: { "p.png": PNG } })
    const warnings: string[] = []
    const hwp = await hwpxToHwp(hwpx, { warnings })
    assert.ok(isHwp(hwp))
    assert.deepEqual(warnings, [])
    const [a, b] = [await parse(Buffer.from(hwpx)), await parse(Buffer.from(hwp))]
    assert.equal(b.fileType, "hwp")
    assert.equal(letters(b.markdown), letters(a.markdown))
    assert.match(b.markdown ?? "", /!\[image\]/)
  }
})

test("CLI generate -o x.hwp 는 HWP 로, --json bytes 는 쓴 파일 크기", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-to-hwp-"))
  try {
    await writeFile(join(dir, "a.md"), "# 제목\n\n본문 문단.\n")
    const out = join(dir, "a.hwp")
    const r = spawnSync(process.execPath, ["--import", "tsx", cli, "generate", join(dir, "a.md"), "-o", out, "--json"], { encoding: "utf8", timeout: 60000 })
    assert.equal(r.status, 0, r.stderr)
    const bytes = await readFile(out)
    assert.ok(isHwp(bytes))
    assert.equal(JSON.parse(r.stdout).bytes, bytes.byteLength)
    assert.match(r.stderr, /HWP 생성/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("MCP generate_document output_path .hwp 는 HWP 로", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kordoc-to-hwp-mcp-"))
  const previousRoot = process.env.KORDOC_ROOT
  try {
    process.env.KORDOC_ROOT = dir
    let callback: any
    registerGenerateTools({ tool(name: string, ...args: any[]) {
      if (name === "generate_document") callback = args.at(-1)
    } } as any)
    const out = join(dir, "보고서.hwp")
    const result = await callback({ markdown: "# 제목\n\n본문 문단.\n", output_path: out, preset: "보고서" })
    assert.ok(!result.isError, JSON.stringify(result))
    assert.match(result.content[0].text, /✓ HWP 생성/)
    assert.ok(isHwp(await readFile(out)))
  } finally {
    if (previousRoot === undefined) delete process.env.KORDOC_ROOT
    else process.env.KORDOC_ROOT = previousRoot
    await rm(dir, { recursive: true, force: true })
  }
})
