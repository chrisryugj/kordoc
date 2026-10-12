/**
 * reflow 한컴 조판 규칙 — 한컴독스 웹 한글 조판 엔진에서 읽어 낸 규칙을 kordoc 코드로 다시 쓴 것.
 *  1. 글자 폭은 글자마다 4 HWPUNIT 단위(hancomCharWidth) — 공백은 4·⌊크기/8⌋, 자간은 ⌊폭/4⌋ 의 %를 4 단위로
 *  2. 폭표 없는 한글 글꼴은 한글 1em(faceClassForReflow) — 함초롬·명조만 함초롬 폭
 *  3. KoPub 바탕·돋움 실측 폭표(한글 0.936em·0.872em, 굵기끼리 같음)
 *  4. 공백 최소값(condense): 줄 가용폭 + 그 줄 공백 폭 합 × condense%
 *  5. 한컴 기본 금칙 집합 — 닫는 작은따옴표(’)는 줄머리 금지
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hancomCharWidth, faceClassForReflow, simulateWrap } from "../src/hwpx/text-metrics.js"
import { fontAdvanceEm1000 } from "../src/hwpx/font-metrics.js"

describe("reflow 한컴 조판 규칙", () => {
  it("글자 폭은 글자마다 4 단위로 양자화한다", () => {
    assert.equal(hancomCharWidth("가", 1000, 100, 0, "hcr"), 972) // 4·MulDiv(970, 250, 1000) — 실수 폭 970
    assert.equal(hancomCharWidth(" ", 1100, 100, 0, "hcr"), 548) // 4·⌊1100/8⌋ — 0.5em(550) 이 아니다
    assert.equal(hancomCharWidth("가", 1300, 98, -2, "fixedPitch"), 1248) // 4·⌊1000·325·98/10⁵⌋ = 1272, 자간 4·MulDiv(318, −2, 100) = −24
    for (const [ch, h] of [["가", 1000], ["A", 1100], [" ", 1300]] as const) assert.equal(hancomCharWidth(ch, h, 100, 0, "hcr") % 4, 0)
  })

  it("폭표 없는 한글 글꼴은 한글 1em, 함초롬·명조는 함초롬 폭", () => {
    assert.equal(faceClassForReflow("바탕"), "cjk")
    assert.equal(faceClassForReflow("한양신명조"), "cjk")
    assert.equal(faceClassForReflow("명조"), "hcr")
    assert.equal(faceClassForReflow("함초롬바탕"), "hcr")
    assert.equal(faceClassForReflow("돋움체"), "fixedPitch")
    assert.equal(faceClassForReflow("KoPub바탕체 Light"), "font:KoPub바탕체 Light")
    assert.equal(hancomCharWidth("가", 1000, 100, 0, "cjk"), 1000)
    assert.equal(hancomCharWidth("A", 1000, 100, 0, "cjk"), hancomCharWidth("A", 1000, 100, 0, "hcr"))
  })

  it("KoPub 실측 폭표 — 굵기끼리 같은 표", () => {
    const ga = "가".codePointAt(0)!
    for (const w of ["Light", "Medium", "Bold"]) {
      assert.equal(fontAdvanceEm1000(`KoPub바탕체 ${w}`, ga), 936)
      assert.equal(fontAdvanceEm1000(`KoPub돋움체 ${w}`, ga), 872)
    }
    assert.equal(fontAdvanceEm1000("KoPubWorld돋움체_Pro Light", ga), 872)
  })

  it("공백 최소값만큼 줄에 더 들어간다", () => {
    const text = "가가 가가 가가"
    const widths = [...text].map(c => (c === " " ? 50 : 100)) // 700
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths }).starts, [0, 6])
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths, condensePct: 50 }).starts, [0]) // 680 + 100·50% ≥ 700
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths, condensePct: 10 }).starts, [0, 6]) // 680 + 10 < 700
  })

  it("한컴 금칙 — 닫는 작은따옴표는 줄머리에 오지 않는다", () => {
    const text = "가가가’"
    const widths = [100, 100, 100, 100]
    assert.deepEqual(simulateWrap(text, 300, 300, 1000, 100, "charAll", { widths }).starts, [0, 3])
    assert.deepEqual(simulateWrap(text, 300, 300, 1000, 100, "charAll", { widths, kinsoku: "hancom" }).starts, [0, 2])
  })
})
