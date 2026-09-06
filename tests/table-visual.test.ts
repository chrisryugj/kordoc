/** #76 Task 6·7 — extractTables: 분류 + 렌더 region 조인(sourceId) + 정책별 crop. HWPX·HWP5 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { extractTables } from "../src/table/visual.js"
import { buildRenderFixture } from "./fixtures/render-fixture.js"

const SEMANTIC: string[][] = [["이름", "부서", "인원"], ["홍길동", "개발", "10"], ["김철수", "기획", "7"], ["이영희", "영업", "12"], ["박민수", "총무", "3"]]
const ORG: string[][] = [["", "", "기관장", "", ""], ["", "", "", "", ""], ["", "기획본부", "", "사업본부", ""], ["", "", "", "", ""], ["기획팀", "", "총무팀", "", "사업팀"], ["", "", "", "", ""], ["", "", "", "", ""]]
const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")

describe("extractTables — HWPX", () => {
  it("표 3개 분류·sourceId 로 region 조인·기본 정책은 non-tabular+uncertain 만 crop", async () => {
    const buf = await buildRenderFixture({ extraTables: [["801", SEMANTIC], ["802", ORG]] })
    const out = await extractTables(Buffer.from(buf))
    assert.equal(out.length, 3)
    const by = Object.fromEntries(out.map(t => [t.sourceId, t]))
    assert.equal(by["801"].classification.kind, "semantic-table", JSON.stringify(by["801"].classification))
    assert.equal(by["802"].classification.kind, "non-tabular-layout", JSON.stringify(by["802"].classification))
    assert.equal(by["777"].classification.kind, "uncertain")
    for (const t of out) { assert.equal(t.regions.length, 1, t.id); assert.equal(t.regions[0].page, 1); assert.deepEqual(t.warnings, []); assert.ok(t.table.regions?.length === 1) }
    assert.equal(by["801"].crops.length, 0, "의미표는 crop 없음")
    assert.equal(by["802"].crops.length, 1)
    assert.equal(by["777"].crops.length, 1)
    assert.equal(by["802"].crops[0].mimeType, "image/png")
    assert.ok(by["802"].crops[0].data.length > 0)
    assert.deepEqual(by["802"].crops[0].bbox, by["802"].regions[0])
  })
  it("policy none → crop 0 / all → 전부 / non-tabular → 조직도만, jpeg 지정", async () => {
    const buf = Buffer.from(await buildRenderFixture({ extraTables: [["801", SEMANTIC], ["802", ORG]] }))
    const none = await extractTables(buf, { policy: "none" })
    assert.equal(none.reduce((n, t) => n + t.crops.length, 0), 0)
    assert.ok(none.every(t => t.regions.length === 1), "region 은 정책과 무관하게 조인")
    const all = await extractTables(buf, { policy: "all", format: "jpeg" })
    assert.equal(all.reduce((n, t) => n + t.crops.length, 0), 3)
    assert.ok(all.every(t => t.crops[0].mimeType === "image/jpeg"))
    const nt = await extractTables(buf, { policy: "non-tabular" })
    assert.deepEqual(nt.filter(t => t.crops.length).map(t => t.sourceId), ["802"])
  })
  it("표 없는 문서 → 빈 배열", async () => {
    const out = await extractTables(Buffer.from(await buildRenderFixture({ noTable: true, singlePage: true })))
    assert.deepEqual(out, [])
  })
  it("HWP5 — 분류 + 렌더 region 조인(sourceId t{N}) (corpus 존재 시, #75 Task 7)", { skip: !existsSync(join(CORPUS, "hwp5")) }, async () => {
    const f = readdirSync(join(CORPUS, "hwp5")).find(n => n === "merging-cell.hwp")
    if (!f) return
    const out = await extractTables(join(CORPUS, "hwp5", f))
    assert.ok(out.length >= 1)
    for (const t of out) { assert.ok(t.classification); assert.match(t.sourceId!, /^t\d+$/); assert.equal(t.regions.length, 1); assert.deepEqual(t.warnings, []) }
  })
})
