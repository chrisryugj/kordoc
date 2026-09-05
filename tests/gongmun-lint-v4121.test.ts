/**
 * 공문서 표기법 검수 보강 6룰 (v4.12.1) — pyhwpxlib Gongmun 검사·hwpx-skill gonmun_lint 대조로
 * 비어 있던 축(금액 한글 병기·물결표·두음법칙·외래어·차별 표현·"끝." 누락)을 채운 것.
 * 내부결재 문서의 발신명의 생략(행정업무규정 시행규칙)도 여기서 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintGongmunText, gongmunLintWarnings, LOANWORD_FIXES, DISCRIM_FIXES } from "../src/hwpx/gongmun-lint.js"
import { isInternalApproval } from "../src/hwpx/gen-docframe.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import JSZip from "jszip"

const rulesOf = (text: string, opts?: { document?: boolean }) => lintGongmunText(text, opts).map((f) => f.rule)

describe("표기법 보강 6룰", () => {
  it("MONEY_NO_HANGUL — 금+숫자 뒤 괄호 한글 병기가 없으면 경고, 있으면 무위반", () => {
    assert.ok(rulesOf("계약금 금5,000,000원 지급").includes("MONEY_NO_HANGUL"))
    assert.ok(!rulesOf("금5,000,000원(금오백만원) 지급").includes("MONEY_NO_HANGUL"))
    assert.ok(!rulesOf("예산 345,000원").includes("MONEY_NO_HANGUL"), "'금' 접두 없는 금액은 대상 아님")
  })

  it("TILDE_SPACE — 물결표 앞뒤 공백", () => {
    assert.ok(rulesOf("2. 20. ∼ 2. 24.").includes("TILDE_SPACE"))
    assert.ok(rulesOf("09:00 ~18:00").includes("TILDE_SPACE"))
    assert.ok(!rulesOf("2. 20.∼2. 24.").includes("TILDE_SPACE"))
    assert.ok(!rulesOf("09:00∼18:00").includes("TILDE_SPACE"))
  })

  it("DUEUM_ERROR — 어두 '년도·년간'만 잡고 '2026년도'·'매년'은 통과", () => {
    assert.ok(rulesOf("년도별 실적").includes("DUEUM_ERROR"))
    assert.ok(rulesOf("년간 계획 수립").includes("DUEUM_ERROR"))
    assert.ok(!rulesOf("2026년도 예산").includes("DUEUM_ERROR"))
    assert.ok(!rulesOf("매년 말 정산").includes("DUEUM_ERROR"))
    assert.ok(!rulesOf("연도별 실적").includes("DUEUM_ERROR"))
  })

  it("LOANWORD_ERROR — 사전 매칭 + 표준 표기를 suggest 로 제시", () => {
    const f = lintGongmunText("컨텐츠 워크샵 스케쥴 안내")
    const hits = f.filter((x) => x.rule === "LOANWORD_ERROR")
    assert.equal(hits.length, 3)
    assert.equal(hits[0].suggest, "컨텐츠 → 콘텐츠")
    assert.ok(!rulesOf("콘텐츠 워크숍 스케줄 안내").includes("LOANWORD_ERROR"))
    assert.ok(LOANWORD_FIXES.length >= 30)
  })

  it("DISCRIMINATORY_TERM — 순화어 제안", () => {
    const f = lintGongmunText("장애자 주차구역, 학부형 안내")
    const hits = f.filter((x) => x.rule === "DISCRIMINATORY_TERM")
    assert.deepEqual(hits.map((h) => h.suggest), ["장애자 → 장애인", "학부형 → 학부모"])
    assert.ok(!rulesOf("장애인 주차구역, 학부모 안내").includes("DISCRIMINATORY_TERM"))
    assert.ok(DISCRIM_FIXES.length >= 20)
  })

  it("END_MARK_MISSING — 문서 검사(document)에서만, 붙임 있고 '끝.' 없을 때", () => {
    const doc = "제목  협조 요청\n\n본문입니다.\n\n붙임  계획서 1부."
    assert.ok(rulesOf(doc, { document: true }).includes("END_MARK_MISSING"))
    assert.ok(!rulesOf(doc).includes("END_MARK_MISSING"), "generate 경고(기본)는 official 프리셋이 끝.을 자동 방출하므로 끔")
    assert.ok(!rulesOf(doc + "  끝.", { document: true }).includes("END_MARK_MISSING"))
    assert.ok(!rulesOf("본문만 있는 문서", { document: true }).includes("END_MARK_MISSING"))
  })

  it("generate 경고 채널(gongmunLintWarnings)에 새 룰이 흐른다", () => {
    const w = gongmunLintWarnings("컨텐츠 년도별 금5,000원")
    assert.ok(w.some((x) => x.includes("LOANWORD_ERROR")))
    assert.ok(w.some((x) => x.includes("DUEUM_ERROR")))
    assert.ok(w.some((x) => x.includes("MONEY_NO_HANGUL")))
  })
})

describe("내부결재 문서 — 발신명의 생략", () => {
  it("isInternalApproval — '내부결재'·'내 부 결 재' 인식, 외부 수신은 아님", () => {
    assert.ok(isInternalApproval("내부결재"))
    assert.ok(isInternalApproval(" 내 부 결 재 "))
    assert.ok(!isInternalApproval("수신자 제위"))
    assert.ok(!isInternalApproval(undefined))
  })

  it("수신이 내부결재면 결문에 발신명의 문단이 없고, 외부 수신이면 있다", async () => {
    const md = "제목  협조 요청\n\n1. 본문입니다."
    const sec = async (to: string) => {
      const buf = await markdownToHwpx(md, {
        gongmun: {
          preset: "official",
          docHead: { org: "행정안전부", to, title: "협조 요청" },
          docFoot: { sender: "행정안전부장관", drafter: "홍길동", approver: "김과장" },
        },
      })
      const zip = await JSZip.loadAsync(buf)
      return await zip.file("Contents/section0.xml")!.async("text")
    }
    const internal = await sec("내부결재")
    const external = await sec("수신자 제위")
    assert.ok(!internal.includes("행정안전부장관"), "내부결재: 발신명의 생략")
    assert.ok(internal.includes("홍길동"), "결문의 기안자 등 나머지는 유지")
    assert.ok(external.includes("행정안전부장관"), "외부 수신: 발신명의 방출")
  })
})

describe("v4.12.2 — 실결재 기안문·별지서식 실측으로 좁힌 패턴", () => {
  const rules = (t: string, code: string) => lintGongmunText(t).filter(f => f.rule === code)
  it("TILDE_SPACE 는 숫자·날짜·시각 범위에만 — 기입란 '( 부터 ~ 까지)'·'공사기간: ~'·'3인 ~ 최대' 는 범위 표기가 아니다", () => {
    assert.equal(rules("기간( 부터 ~ 까지)", "TILDE_SPACE").length, 0)
    // 앞이 날짜면 뒤에 낱말이 와도 범위 시작이라 종전대로 건다 ("6. 23.~" 붙여 씀)
    assert.equal(rules("3구간: 6. 23. ~ ※ 현재 공사 중", "TILDE_SPACE").length, 1)
    assert.equal(rules("7. 31.(금) ~ 수리완료시까지", "TILDE_SPACE").length, 1)
    assert.equal(rules("(최소 3인 ~ 최대 4인)", "TILDE_SPACE").length, 0)
    assert.equal(rules("공사기간: ~", "TILDE_SPACE").length, 0)
    assert.equal(rules("8. 1.(토) ~ 8. 31.(월)", "TILDE_SPACE").length, 1)
    assert.equal(rules("09:00 ~ 18:00", "TILDE_SPACE").length, 1)
    assert.equal(rules("’26 ~ ’27년", "TILDE_SPACE").length, 1)
    assert.equal(rules("2. 20.∼2. 24.", "TILDE_SPACE").length, 0)
  })
  it("DUEUM_ERROR 는 서식 기입란·표 머리글의 '년도' 를 건드리지 않는다", () => {
    assert.equal(rules("결과보고( 년도)", "DUEUM_ERROR").length, 0)
    assert.equal(rules("   . . . 까지 (  년간)", "DUEUM_ERROR").length, 0)
    assert.equal(rules("2026 년도 사업계획", "DUEUM_ERROR").length, 0)
    assert.equal(rules("<tr><td>년도</td><td></td></tr>", "DUEUM_ERROR").length, 0)
    assert.equal(rules("| 년도 | 실적 |", "DUEUM_ERROR").length, 0)
    assert.equal(rules("□ 년도별 추진계획", "DUEUM_ERROR").length, 1)
    assert.equal(rules("년간 실적을 보고함", "DUEUM_ERROR").length, 1)
    assert.equal(rules("2026년도 예산", "DUEUM_ERROR").length, 0)
  })
})
