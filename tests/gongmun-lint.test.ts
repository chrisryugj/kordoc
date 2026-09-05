/** 공문서 표기법 검수기 테스트 — 편람 표기법 13룰 (v4.0.1, hwpx-skill gonmun_lint 이식) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintGongmunText, gongmunLintWarnings } from "../src/hwpx/gongmun-lint.js"

const rulesOf = (text: string) => lintGongmunText(text).map((f) => f.rule)

describe("공문서 표기법 검수", () => {
  it("날짜 — 온점 뒤 공백·0 패딩·2자리 연도·끝 마침표", () => {
    assert.ok(rulesOf("2025.1.6 회의").includes("DATE_NO_SPACE"))
    assert.ok(rulesOf("2025. 01. 06. 개최").includes("DATE_ZERO_PAD"))
    assert.ok(rulesOf("'24. 1. 6. 시행").includes("DATE_2DIGIT_YR"))
    assert.ok(rulesOf("2025. 1. 6 개최").includes("DATE_NO_END_DOT"))
    assert.equal(rulesOf("2025. 1. 6. 개최").length, 0, "올바른 날짜는 무위반")
  })

  it("시간 — 오전/오후 금지·24시 지양·쌍점 붙여쓰기", () => {
    assert.ok(rulesOf("오후 3시 회의").includes("TIME_AMPM"))
    assert.ok(rulesOf("24시까지 제출").includes("TIME_24H"))
    assert.ok(rulesOf("13 : 20 시작").includes("TIME_COLON_SP"))
    assert.equal(rulesOf("15:30 개최").length, 0)
  })

  it("금액 — 천원 금지·금+숫자 붙여쓰기", () => {
    assert.ok(rulesOf("예산 345천원").includes("MONEY_CHEONWON"))
    assert.ok(rulesOf("금 113,560원").includes("MONEY_GEUM_SP"))
    assert.deepEqual(rulesOf("금113,560원"), ["MONEY_NO_HANGUL"], "붙여 쓴 금액은 한글 병기 권고만 남는다 (v4.12.1)")
    assert.equal(rulesOf("금113,560원(금일십일만삼천오백육십원)").length, 0, "한글 병기까지 갖춘 금액은 무위반")
  })

  it("붙임·물결표·외국어 우선·쌍점", () => {
    assert.ok(rulesOf("붙임: 계획서 1부.").includes("BUNIM_COLON"))
    assert.ok(rulesOf("2. 20.∼2. 24.까지 운영").includes("KKAJI_DUP"))
    assert.ok(rulesOf("MOU(업무협약) 체결").includes("FOREIGN_FIRST"))
    assert.ok(rulesOf("원장 :김갑동").includes("COLON_SPACE"))
  })

  it("오탐 가드 — URL 쌍점·코드펜스 내부 제외", () => {
    assert.equal(rulesOf("참조: https://example.com").filter((r) => r === "COLON_SPACE").length, 0, "URL :// 제외")
    assert.equal(rulesOf("```\n2025.1.6\n```").length, 0, "펜스 내부 스킵")
  })

  it("경고 채널 — 상한 초과 시 요약 1줄", () => {
    const noisy = Array.from({ length: 8 }, (_, i) => `2025.1.${i + 1} 회의`).join("\n")
    const warns = gongmunLintWarnings(noisy, 5)
    assert.equal(warns.length, 6, "5건 + 요약 1건")
    assert.ok(warns[5].includes("더 있음"))
  })

  it("v4.0.4 회귀 — 펜스 비대칭·DATE_ZERO_PAD 앵커·양쪽 공백 쌍점", () => {
    // 코드펜스는 같은 마커로만 닫힘 — ```블록 안 ~~~ 줄이 조기 종료시키지 않음
    assert.equal(rulesOf("```\n2025.1.6\n~~~\n붙임: 계획서\n").filter((r) => r === "DATE_NO_SPACE").length, 0, "``` 안 날짜 스킵")
    // DATE_ZERO_PAD 둘째 대안 연도 앵커 — 하위조항 번호 오탐 방지
    assert.equal(rulesOf("제3.01.호에 따라").filter((r) => r === "DATE_ZERO_PAD").length, 0, "'제3.01.호' 오탐 금지")
    assert.equal(rulesOf("v2.05.1 배포").filter((r) => r === "DATE_ZERO_PAD").length, 0, "버전 번호 오탐 금지")
    // COLON_SPACE 양쪽 공백 케이스도 검출
    assert.ok(rulesOf("원장 : 김갑동").includes("COLON_SPACE"), "양쪽 공백 쌍점 검출")
  })

  it("v4.9.0 — AI 문체 흔적(줄표·강조 남발)", () => {
    // 줄표 3종(em·en·horizontal bar) 검출, 하이픈·표 구분선은 무위반
    assert.ok(rulesOf("병목은 구축이 아니라 정착 — 활용부터").includes("AI_EM_DASH"), "em dash 검출")
    assert.ok(rulesOf("100–200만 원").includes("AI_EM_DASH"), "en dash 검출")
    assert.ok(rulesOf("결론 ― 타당함").includes("AI_EM_DASH"), "horizontal bar 검출")
    assert.equal(rulesOf("| --- | --- |\n하이픈-연결어").filter((r) => r === "AI_EM_DASH").length, 0, "하이픈·표 구분선 오탐 금지")
    // 강조 남발 — 한 줄 3회 이상만 경고, 2회 이하·리드어 1회는 정상 관행
    assert.ok(rulesOf("**현황** 및 **문제** 및 **대안** 제시").includes("AI_BOLD_OVERUSE"), "볼드 3회 검출")
    assert.equal(rulesOf("**검토 대상**: 계획안 2건과 **예산**").filter((r) => r === "AI_BOLD_OVERUSE").length, 0, "볼드 2회는 무위반")
    // 펜스 내부는 다른 룰과 동일하게 스킵
    assert.equal(rulesOf("```\na — b\n```").filter((r) => r === "AI_EM_DASH").length, 0, "펜스 내부 스킵")
  })
})
