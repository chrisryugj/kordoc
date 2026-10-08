/**
 * 새 검수·정리 정규식의 폭주 백트래킹 회귀 (v4.20.0) — 고치기 전에는 아래 입력 한 줄에 수 초~수 분 멈췄다.
 * 금액 한글 대조: "금1원(" + 공백 160 (9.8초), 인용 표시: "【†" 4천 쌍 (24초), 붙임 2타·천원 표기: "붙임 " + 숫자 5만 (5.9초),
 * 날짜 띄어쓰기(종전 규칙): 공백 2만 칸 (0.7초 — 뒤쪽 검사를 모든 자리에서 먼저 했다)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintGongmunText } from "../src/hwpx/gongmun-lint.js"
import { cleanPastedMarkdown } from "../src/hwpx/paste-clean.js"

const fast = (label: string, fn: () => unknown): void => {
  const t = performance.now()
  fn()
  const ms = performance.now() - t
  assert.ok(ms < 1000, `${label} ${ms.toFixed(0)}ms`)
}

describe("정규식 폭주 회귀", () => {
  it("금액 한글 대조 — 닫는 괄호 없는 긴 공백·한글 금액 줄", () => {
    fast("공백", () => lintGongmunText("금1원(" + " ".repeat(20000), { document: true }))
    fast("표 칸", () => lintGongmunText("| 계약금 | 금1,000,000원(" + " ".repeat(5000) + "|", { document: true }))
    fast("한글", () => lintGongmunText("금1원(" + "일 ".repeat(10000), { document: true }))
  })
  it("붙여넣기 인용 표시 — 닫는 】 없는 † 런", () => {
    fast("† 런", () => cleanPastedMarkdown("【" + "†".repeat(50000)))
    fast("【† 반복", () => cleanPastedMarkdown("【†".repeat(25000)))
  })
  it("날짜 띄어쓰기 — 긴 공백·탭 줄", () => {
    fast("공백", () => lintGongmunText(" ".repeat(50000) + "x", { document: true }))
    fast("탭", () => lintGongmunText("\t".repeat(50000), { document: true }))
  })
  it("붙임 2타 — 긴 숫자 줄", () => {
    fast("숫자", () => lintGongmunText("붙임 " + "1".repeat(50000), { document: true }))
  })
  it("고친 정규식도 같은 것을 잡는다", () => {
    assert.ok(lintGongmunText("금113,560원(금일십일만삼천오백원)").some(f => f.rule === "MONEY_HANGUL_MISMATCH"))
    assert.ok(lintGongmunText("금113,560원(금 일십일만 삼천오백원)").some(f => f.rule === "MONEY_HANGUL_MISMATCH"))
    assert.ok(!lintGongmunText("금113,560원(금일십일만삼천오백육십원)").some(f => f.rule === "MONEY_HANGUL_MISMATCH"))
    assert.equal(cleanPastedMarkdown("a【4:0†source】b").md, "ab")
    assert.ok(lintGongmunText("붙임 계획서 1부.  끝.", { document: true }).some(f => f.rule === "BUNIM_SPACE"))
  })
})
