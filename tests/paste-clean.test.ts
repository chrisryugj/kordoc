/**
 * 생성형 AI 붙여넣기 흔적 정리 (cleanPastedMarkdown) — 흔적임이 분명한 꼴만 지우고 정상 원고는 그대로.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { cleanPastedMarkdown } from "../src/hwpx/paste-clean.js"
import { markdownToHwpx, parse } from "../src/index.js"

describe("cleanPastedMarkdown", () => {
  it("보이지 않는 글자·† 인용 표시·이스케이프된 굵게를 지운다", () => {
    const r = cleanPastedMarkdown("# 제목\u200b\n출처 【4:0†source】 확인\n\\*\\*핵심\\*\\* 내용")
    assert.equal(r.md, "# 제목\n출처 확인\n**핵심** 내용")
    assert.equal(r.removed, 3)
  })
  it("정상 원고는 그대로 — 숫자 각주 [1]·NBSP·【붙임】·표 칸·각주 [^1]·일부러 쓴 \\*·코드 펜스", () => {
    // [1] 은 실문서 마크다운에 정상 내용으로 흔하고, NBSP 는 묶음 빈칸으로 일부러 쓴 글자다
    const md = "증가했습니다.[1][2]\n2026.\u00a010.\u00a08.\n【붙임】 계획서\n| 구분 | [1] |\n각주 참조[^1]\n별 \\* 하나\n```\n코드 \u200b\n```"
    assert.deepEqual(cleanPastedMarkdown(md), { md, removed: 0 })
  })
  it("generate 결과 본문에 흔적이 남지 않고 경고로 알린다", async () => {
    const warnings: string[] = []
    const hwpx = await markdownToHwpx("# 사업 계획\u200b\n\n추진 현황입니다. 【3:1†보고서】", { warnings })
    const r = await parse(hwpx)
    assert.ok(r.success)
    assert.doesNotMatch(r.markdown, /\u200b|†/)
    assert.ok(warnings.some(w => w.includes("붙여넣기 흔적 2개")), warnings.join(" / "))
  })
})

describe("cleanPastedMarkdown — 마스킹 별표", () => {
  it("이스케이프된 마스킹 별표 런은 굵게 짝이 아니다", () => {
    const md = "성명: 홍\\*\\*\n\n\\*\\*\\*\\*\\*\\*\n\n| 주민번호 | \\*\\*\\*\\*\\*\\* |"
    assert.deepEqual(cleanPastedMarkdown(md), { md, removed: 0 })
  })
})

describe("cleanPastedMarkdown — 칸 안 마스킹", () => {
  it("칸 안 줄바꿈이 낀 마스킹 별표 런도 그대로", () => {
    const md = "| 1 | \\*\\*\\*<br>\\*\\*\\*\\*\\*\\*\\*\\*<br>\\*\\*\\*\\* | \\*\\*\\*\\* |"
    assert.deepEqual(cleanPastedMarkdown(md), { md, removed: 0 })
  })
})
