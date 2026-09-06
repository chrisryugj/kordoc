/** #76 Task 8 — kordoc tables CLI: JSON 분류 출력, --visual 은 -d 필수, crop 파일 */

import { describe, it, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { buildRenderFixture } from "./fixtures/render-fixture.js"

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url))
let dir: string, doc: string
const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", CLI, ...args], { encoding: "utf8", timeout: 120000 })
const ORG: string[][] = [["", "", "기관장", "", ""], ["", "", "", "", ""], ["", "기획본부", "", "사업본부", ""], ["", "", "", "", ""], ["기획팀", "", "총무팀", "", "사업팀"], ["", "", "", "", ""], ["", "", "", "", ""]]

describe("tables CLI", () => {
  before(async () => { dir = mkdtempSync(join(tmpdir(), "kordoc-tables-cli-")); doc = join(dir, "doc.hwpx"); writeFileSync(doc, await buildRenderFixture({ extraTables: [["802", ORG]] })) })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it("기본: 분류 JSON 을 stdout 으로, 래스터 없음", () => {
    const r = run(["tables", doc, "--silent"])
    assert.equal(r.status, 0, r.stderr)
    const json = JSON.parse(r.stdout)
    assert.equal(json.length, 2)
    const org = json.find((t: { sourceId: string }) => t.sourceId === "802")
    assert.equal(org.classification.kind, "non-tabular-layout")
    assert.equal(org.crops.length, 0)
    assert.equal(org.regions.length, 1)
    assert.ok(!("cells" in org.table))
  })
  it("--visual non-tabular -d → 조직도 crop 파일 + tables.json, --cells 로 셀 격자", () => {
    const out = join(dir, "tables")
    const r = run(["tables", doc, "--visual", "non-tabular", "-d", out, "--cells", "--silent"])
    assert.equal(r.status, 0, r.stderr)
    const files = readdirSync(out).sort()
    assert.ok(files.includes("802_page_001.png") && files.includes("tables.json"), files.join(","))
    const json = JSON.parse(readFileSync(join(out, "tables.json"), "utf8"))
    const org = json.find((t: { sourceId: string }) => t.sourceId === "802")
    assert.equal(org.crops[0].file, "802_page_001.png")
    assert.equal(org.table.cells[0][2], "기관장")
  })
  it("--visual 지정에 -d 없으면 exit 1", () => {
    const r = run(["tables", doc, "--visual", "all", "--silent"])
    assert.equal(r.status, 1)
    assert.match(r.stderr, /--out-dir/)
  })
})
