/**
 * 통계표 행 머리의 배분 정렬 두 음절 — 값 칸 둘 이상이 숫자인 행에서 크게 벌린 "건  축" 은 붙인다(2025 건설업조사 보도자료). 서식 이름표·
 * 보통 띄어 쓴 두 낱말은 그대로 (spread-labels)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { joinSpreadRowLabels } from "../src/pdf/spread-labels.js"
import { CELL_LINES } from "../src/pdf/table-meta.js"
import { WrapLexicon } from "../src/pdf/line-wrap.js"
import type { IRCell } from "../src/types.js"

const cell = (text: string, l = 0, r = 0, h = 11): IRCell => {
  const c: IRCell = { text, colSpan: 1, rowSpan: 1 }
  if (r > l) CELL_LINES.set(c, [{ y: 400, l, r, h }])
  return c
}
// 행 머리 칸 상자 75~137 (건설업조사 "건  축" 칸)
const box = () => ({ x1: 75, x2: 137 })
const lexOf = (...lines: string[]): WrapLexicon => {
  const lex = new WrapLexicon()
  for (const l of lines) lex.addLine(l)
  return lex
}

describe("joinSpreadRowLabels", () => {
  it("숫자 값 행의 벌어진 두 음절 머리 칸을 붙인다 — 문서에 그 꼴로 시작하는 어절이 있을 때", () => {
    const lex = lexOf("올해 건축공사 실적은 늘었고 토목공사 실적은 줄었다")
    const grid = [[cell("건 축", 81, 135), cell("238,482"), cell("230,553"), cell("-7,929")], [cell("토 목", 81, 135), cell("49,424"), cell("55,871"), cell("3.2")]]
    joinSpreadRowLabels(grid, lex, new Set(), box, () => false)
    assert.deepEqual(grid.map(r => r[0].text), ["건축", "토목"])
  })
  it("값이 숫자가 아닌 행(서식 이름표), 좁게 띄운 두 낱말, 어휘 증거가 없는 꼴은 그대로", () => {
    const lex = lexOf("성명을 적고 서명한다 그리고 건축공사")
    const form = [[cell("성 명", 81, 135), cell("홍길동"), cell("생년월일"), cell("1990.01.01")]]
    joinSpreadRowLabels(form, lex, new Set(), box, () => false)
    assert.equal(form[0][0].text, "성 명")
    const narrow = [[cell("건 축", 81, 106), cell("1"), cell("2")]]
    joinSpreadRowLabels(narrow, lex, new Set(), box, () => false)
    assert.equal(narrow[0][0].text, "건 축")
    const unknown = [[cell("합 계", 81, 135), cell("1"), cell("2")]]
    joinSpreadRowLabels(unknown, lex, new Set(), box, () => false)
    assert.equal(unknown[0][0].text, "합 계")
    // 넓은 칸 가운데 띄어 쓴 시도명(벼·고추 재배면적조사 "충 북" — 원문도 띄움)은 칸을 채우지 않는다
    const centered = [[cell("충 북", 97, 133, 12), cell("72,914"), cell("72,289")]]
    joinSpreadRowLabels(centered, lex, new Set(["충북"]), () => ({ x1: 58, x2: 168 }), () => false)
    assert.equal(centered[0][0].text, "충 북")
    // 두 음절 사이에 진짜 공백 글리프가 있는 칸(제주4·3 보상 신청 표 "인 정")은 원문이 띄웠다
    const real = [[cell("인 정", 94, 133, 13), cell("143,581"), cell("15,286")]]
    joinSpreadRowLabels(real, lexOf("심의 결과 인정된 희생자"), new Set(), () => ({ x1: 90, x2: 138 }), () => true)
    assert.equal(real[0][0].text, "인 정")
  })
})
