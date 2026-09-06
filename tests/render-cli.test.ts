/** #75 Task 9 — kordoc render(포맷·페이지·out-dir)·crop CLI. 루트 --format/-d 흡수 회귀 포함 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildRenderFixture } from "./fixtures/render-fixture.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
let dir: string, doc: string
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", timeout: 120000 })

const HWP5 = fileURLToPath(new URL("../bench/corpus/hwp5/merging-cell.hwp", import.meta.url))

describe("render CLI", () => {
  it("HWP5 기본 호출(옵션 없음)은 페이지별 통합 렌더러로 간다 (HWPX 전용 세로 스택 경로 금지)", { skip: !existsSync(HWP5) }, () => {
    const out = join(dir, "hwp5.svg")
    const r = run(["render", HWP5, "-o", out, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(readFileSync(out, "utf8").includes('data-kordoc-type="table"'))
  })
  before(async () => { dir = mkdtempSync(join(tmpdir(), "kordoc-render-cli-")); doc = join(dir, "doc.hwpx"); writeFileSync(doc, await buildRenderFixture()) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("기본(svg, -o) 은 종전 세로 스택 SVG", () => {
    const out = join(dir, "stack.svg")
    execFileSync(process.execPath, ["--import", "tsx", CLI, "render", doc, "-o", out, "--silent"], { timeout: 120000 })
    const svg = readFileSync(out, "utf8")
    assert.ok(svg.includes('data-page="1"') && svg.includes('data-page="2"') && svg.includes("translate(0 "))
  })
  it("--format png -d 로 페이지별 파일, --pages 로 한 쪽만", () => {
    const pages = join(dir, "pages")
    const r = run(["render", doc, "--format", "png", "-d", pages, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    assert.deepEqual(readdirSync(pages).sort(), ["page_001.png", "page_002.png"])
    const one = join(dir, "p2.png")
    const r2 = run(["render", doc, "--format", "png", "--pages", "2", "-o", one, "--silent"])
    assert.equal(r2.status, 0, r2.stderr)
    assert.equal(readFileSync(one)[0], 0x89)
  })
  it("여러 쪽 래스터에 -d 없으면 exit 1, 잘못된 --format 도 exit 1", () => {
    const r = run(["render", doc, "--format", "jpeg", "--silent"])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--out-dir/)
    const b = run(["render", doc, "--format", "bmp", "--silent"])
    assert.equal(b.status, 1)
  })
  it("--format html -o 는 자급자족 HTML 한 파일", () => {
    const out = join(dir, "doc.html")
    const r = run(["render", doc, "--format", "html", "-o", out, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    const html = readFileSync(out, "utf8")
    assert.ok(html.startsWith("<!doctype html>") && html.includes('data-page="2"'))
  })
  it("crop --target table -d → table_000001_page_001.png + regions.json, -d 없으면 exit 1", () => {
    const out = join(dir, "regions")
    const r = run(["crop", doc, "--target", "table,image", "-d", out, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    const files = readdirSync(out).sort()
    assert.ok(files.includes("table_000001_page_001.png") && files.includes("image_000001_page_001.png") && files.includes("regions.json"), files.join(","))
    const manifest = JSON.parse(readFileSync(join(out, "regions.json"), "utf8"))
    assert.equal(manifest.find((m: { type: string }) => m.type === "table").sourceId, "777")
    const bad = run(["crop", doc, "--silent"])
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /--out-dir/)
  })
  it("루트 파싱 무회귀 — kordoc <file> 은 여전히 마크다운", () => {
    const r = run([doc, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    assert.ok(r.stdout.includes("첫째쪽 문단입니다"))
    assert.ok(!existsSync(join(dir, "doc.svg")))
  })
})
