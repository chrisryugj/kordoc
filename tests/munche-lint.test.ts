/** 개조식 문체 검수기 테스트 — 실측 통계 기반 룰 (jkf87/hwpx-skill v1.17.0 수치 근거) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintMuncheText, muncheLintWarnings, usesGaejosikMunche } from "../src/hwpx/munche-lint.js"

const rulesOf = (text: string) => lintMuncheText(text).map((f) => f.rule)

describe("개조식 문체 검수 — 종결", () => {
  it("'~다' 서술형 종결을 잡는다", () => {
    assert.ok(rulesOf("○ 빈집 정비가 시급하다").includes("DA_ENDING"))
    assert.ok(rulesOf("⇒ 지역 여건에 맞는 기술을 보급한다").includes("DA_ENDING"))
    assert.equal(rulesOf("○ 지역맞춤형 스마트팜 보급 필요").length, 0, "명사 종결은 무위반")
    assert.equal(rulesOf("○ 관내 시설원예 농가 중 여건을 갖춘 농가는 소수").length, 0)
  })

  it("'~함/있음' 명사형 종결은 통과시킨다", () => {
    assert.equal(rulesOf("  - 사업이 종료되었음").length, 0)
    assert.equal(rulesOf("  - 지역 여건에 맞는 기술을 보급하고 있음").length, 0)
    assert.equal(rulesOf("○ 전국 평균의 약 1.6배 수준임").length, 0)
  })

  it("'~해야 한다' 당위 종결을 잡는다", () => {
    assert.ok(rulesOf("⇒ 학교 단위로 설계해야 한다").includes("DEONTIC"))
    assert.ok(rulesOf("○ 실태조사를 우선 실시하여야 함").includes("DEONTIC"))
  })

  it("'~것이다'는 경고한다", () => {
    assert.ok(rulesOf("○ 정비사업이 확대될 것이다").includes("GEOSIDA"))
  })
})

describe("개조식 문체 검수 — 수사", () => {
  it("'A가 아니라 B'의 B가 추상어면 수사로 본다", () => {
    assert.ok(rulesOf("⇒ 부족한 것은 도구가 아니라 사람").includes("RHETORIC_CONTRAST"))
    assert.ok(rulesOf("○ 연수가 아니라 전환이 필요").includes("RHETORIC_CONTRAST"))
  })

  it("두 구체 선택지를 가르면 확인 경고만 낸다", () => {
    const r = rulesOf("○ BIE 공인박람회가 아닌, 정부승인 국제행사 개최")
    assert.ok(r.includes("CONTRAST_CHECK"), `구체 선택지: ${r}`)
    assert.ok(!r.includes("RHETORIC_CONTRAST"))
  })

  it("물음표·느낌표는 본문에서 잡고 인용 안에서는 넘긴다", () => {
    assert.ok(rulesOf("○ 무엇을 먼저 할 것인가?").includes("QUESTION_EXCLAIM"))
    assert.ok(!rulesOf("○ 주민 의견은 “왜 이제야 하나?” 로 요약").includes("QUESTION_EXCLAIM"))
  })

  it("대구 슬로건을 경고한다", () => {
    assert.ok(rulesOf("○ 가르치는 일은 사람이, 반복되는 일은 기계가 담당").includes("COUPLET"))
  })
})

describe("개조식 문체 검수 — 길이·리드문", () => {
  it("항목이 길면 세부로 내리라고 경고한다", () => {
    const long = "○ " + "가".repeat(80)
    assert.ok(rulesOf(long).includes("ITEM_LONG"))
    assert.ok(!rulesOf("○ " + "가".repeat(30)).includes("ITEM_LONG"))
  })

  it("결론 줄이 길면 경고한다", () => {
    assert.ok(rulesOf("⇒ " + "가".repeat(70)).includes("CONCL_LONG"))
  })

  it("리드문은 '~하고자 함.' 한 문장", () => {
    const bad = "> 빈집 문제를 해결하기 위한 종합적인 대책을 마련하고 추진 방향을 정리한 보고서다."
    assert.ok(rulesOf(bad).includes("LEAD_ENDING"))
    const good = "> 종량제봉투 디자인을 개선하고, 특색 있는 디자인으로 리뉴얼하여 분리배출 의식을 제고하고자 함."
    assert.ok(!rulesOf(good).includes("LEAD_ENDING"))
  })
})

describe("개조식 문체 검수 — 적용 범위·오탐 가드", () => {
  it("개조식 문체를 쓰는 프리셋만 대상", () => {
    for (const p of ["gaejosik", "report", "plan", "개조식", "보고서", "계획서"]) {
      assert.equal(usesGaejosikMunche(p), true, p)
    }
    // 기안문·시행문은 경어 종결, 통지·회의록·보도자료는 문체 관행이 다르다
    for (const p of ["official", "notice", "minutes", "press", "기안문", "보도자료", undefined]) {
      assert.equal(usesGaejosikMunche(p), false, String(p))
    }
  })

  it("코드펜스·표·헤딩은 검사하지 않는다", () => {
    assert.equal(rulesOf("```\nconst x = 1\n// 이것은 예시다\n```").length, 0)
    assert.equal(rulesOf("| 구분 | 값 |\n| --- | --- |").length, 0)
    assert.equal(rulesOf("# 이것은 제목이다").length, 0)
  })

  it("경고 문자열은 개수 제한과 안내를 붙인다", () => {
    const many = Array.from({ length: 8 }, (_, i) => `○ 항목 ${i} 가 중요하다`).join("\n")
    const w = muncheLintWarnings(many, 3)
    assert.equal(w.length, 4, w.join("\n"))
    assert.match(w[3], /5건 더 있음/)
  })
})
