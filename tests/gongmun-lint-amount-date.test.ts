/** v4.13.0 — 금액 한글 병기값 계산(hangulAmount)·하이픈 날짜 룰(DATE_HYPHEN)·실제 변환값 제안 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintGongmunText } from "../src/hwpx/gongmun-lint.js"
import { hangulAmount } from "../src/shared/numbering.js"

const findings = (text: string) => lintGongmunText(text)
const rulesOf = (text: string) => findings(text).map((f) => f.rule)
const suggestOf = (text: string, rule: string) => findings(text).find((f) => f.rule === rule)?.suggest

describe("hangulAmount — 규정 시행규칙 제2조 금액 한글 병기", () => {
  it("자릿수·단위·일십 유지", () => {
    assert.equal(hangulAmount(0), "영")
    assert.equal(hangulAmount(10), "일십")
    assert.equal(hangulAmount(100), "일백")
    assert.equal(hangulAmount(1000), "일천")
    assert.equal(hangulAmount(10000), "일만")
    assert.equal(hangulAmount(123000), "일십이만삼천")
    assert.equal(hangulAmount(113560), "일십일만삼천오백육십")
    assert.equal(hangulAmount(100000000), "일억")
    assert.equal(hangulAmount(1234567890123), "일조이천삼백사십오억육천칠백팔십구만일백이십삼")
  })
  it("0 그룹 단위 생략·쉼표 문자열 입력·선행 0", () => {
    assert.equal(hangulAmount(100000001), "일억일")
    assert.equal(hangulAmount("5,000,000"), "오백만")
    assert.equal(hangulAmount("금113,560원"), "일십일만삼천오백육십")
    assert.equal(hangulAmount("007"), "칠")
  })
})

describe("MONEY_NO_HANGUL — 실제 변환값 제안", () => {
  it("걸린 금액을 괄호 한글 병기 형태로 제안", () => {
    assert.equal(suggestOf("계약금 금113,560원 지급", "MONEY_NO_HANGUL"), "금113,560원 → 금113,560원(금일십일만삼천오백육십원)")
    assert.equal(suggestOf("금5,000,000원 지급", "MONEY_NO_HANGUL"), "금5,000,000원 → 금5,000,000원(금오백만원)")
    assert.ok(!rulesOf("금5,000,000원(금오백만원) 지급").includes("MONEY_NO_HANGUL"), "기존 예시 회귀 — 병기 있으면 무위반")
  })
})

describe("DATE_HYPHEN — 하이픈·ISO 날짜", () => {
  it("검출 + 온점 변환값(0 패딩 제거) 제안", () => {
    assert.ok(rulesOf("회의 2026-07-18 개최").includes("DATE_HYPHEN"))
    assert.equal(suggestOf("회의 2026-07-18 개최", "DATE_HYPHEN"), "2026-07-18 → 2026. 7. 18.")
    assert.equal(suggestOf("2026-7-8 시행", "DATE_HYPHEN"), "2026-7-8 → 2026. 7. 8.")
    assert.equal(findings("기간 2026-07-18 ~ 2026-08-18").filter((f) => f.rule === "DATE_HYPHEN").length, 2, "기간 양쪽 모두")
    assert.equal(findings("2026-07-18 개최").find((f) => f.rule === "DATE_HYPHEN")?.severity, "warning")
  })
  it("URL·파일명·코드·표 셀·펜스는 제외", () => {
    assert.ok(!rulesOf("https://www.gwangjin.go.kr/news/2026-07-18/notice").includes("DATE_HYPHEN"), "URL 경로")
    assert.ok(!rulesOf("배포본 2026-07-18-보고서.hwpx").includes("DATE_HYPHEN"), "파일명 뒤 하이픈")
    assert.ok(!rulesOf("문서번호 v2026-07-18 참조").includes("DATE_HYPHEN"), "영숫자 접두")
    assert.ok(!rulesOf("| 일자 | 2026-07-18 |").includes("DATE_HYPHEN"), "GFM 표 셀")
    assert.ok(!rulesOf("<td>2026-07-18</td>").includes("DATE_HYPHEN"), "HTML 표 셀")
    assert.ok(!rulesOf("```\n2026-07-18\n```").includes("DATE_HYPHEN"), "펜스 코드")
    assert.ok(!rulesOf("2026. 7. 18. 개최").includes("DATE_HYPHEN"), "온점형은 대상 아님")
  })
})
