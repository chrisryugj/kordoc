/**
 * 견본 HWPX 단계별 서식 추출 (extractLevelStyles, `kordoc levels`·`generate --levels-from`·`lint --styles`)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx } from "../src/index.js"
import { extractLevelStyles } from "../src/hwpx/level-styles.js"

// 중첩 목록 깊이 = 단계 (□ → ㅇ/○ → -) — 맨 "- " 는 마크다운 목록이라 0단계가 된다
const MD = ["# 시험 보고", "", ...["첫째", "둘째", "셋째"].flatMap(n => [`- ${n} 대항목`, `  - ${n} 중항목`, `    - ${n} 소항목`])].join("\n")
const LEVELS = { 0: { font: "HY견고딕", pt: 17, bold: true }, 1: { font: "한컴돋움", pt: 15, bold: true }, 2: { font: "휴먼명조", pt: 14, bold: false } }

describe("extractLevelStyles", () => {
  it("단계별 서식을 지정해 만든 문서에서 같은 값을 다시 뽑는다", async () => {
    const hwpx = await markdownToHwpx(MD, { gongmun: { preset: "report", levels: LEVELS } })
    const r = await extractLevelStyles(hwpx)
    assert.equal(r.scheme, "box")
    assert.deepEqual(r.levels, { 0: LEVELS[0], 1: LEVELS[1], 2: LEVELS[2] })
    assert.equal(r.spec, "0=HY견고딕/17/bold,1=한컴돋움/15/bold,2=휴먼명조/14/plain")
    assert.deepEqual(r.deviations, [])
  })
  it("표본이 3개보다 적은 단계는 대표값을 정하지 않는다 (엔진 기본을 따르게)", async () => {
    const hwpx = await markdownToHwpx("# 시험\n\n□ 하나\n\nㅇ 둘\n\n□ 셋", { gongmun: { preset: "report", levels: LEVELS } })
    const r = await extractLevelStyles(hwpx)
    assert.deepEqual(r.levels, {})
    assert.equal(r.spec, "")
  })
})
