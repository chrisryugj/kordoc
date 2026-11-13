/**
 * 한컴 수식 읽기 — 붙여 쓴 명령·중괄호 없는 항목. 기대값 근거는 같은 시험지의 한컴 PDF(3-09월·3-11월 교육 통합):
 * "12 over13" → 12/13, "costheta" → cos θ, "3 root5" → 3√5, "=2^3-1" → 2^{3-1}(= 2² = 4 로 이어짐).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { hmlToLatex } from "../src/hwpx/equation.js"
import { hwpEquationToLatex } from "../src/hwp5/equation.js"
import { parseHwpxDocument } from "../src/hwpx/parser.js"

const tex = (s: string) => hmlToLatex(s).replace(/\s+/g, " ").trim()

describe("한컴 수식 — 붙여 쓴 명령", () => {
  it("숫자·괄호·등호에 붙은 명령을 떼어 읽는다", () => {
    assert.equal(tex("= - 12 over13"), "= - \\frac{ 12 } { 13 }")
    assert.equal(tex("=4times2"), "=4 \\times 2")
    assert.equal(tex("f prime(x)"), "f ' (x)")
    assert.equal(tex("=2 ^{(sqrt {3} -1){(sqrt {3} +1)}}"), "=2 ^ { ( \\sqrt { 3 } -1) { ( \\sqrt { 3 } +1) } }")
    assert.equal(tex("=LEFT ( x RIGHT )"), "= \\left ( x \\right )")
  })

  it("명령들로만 쪼개지는 덩어리와 명령 뒤 대문자 점 이름", () => {
    assert.equal(hwpEquationToLatex("costheta"), "\\cos \\theta")
    assert.equal(hwpEquationToLatex("sin(pi-theta)"), "\\sin ( \\pi - \\theta )")
    assert.equal(tex("timesrmbar{PD}"), "\\times \\overline{ PD }")
    assert.equal(tex("rmAB"), "AB")
    assert.equal(tex("barAR"), "\\overline{ AR }")
  })

  it("옮기지 않는 예약어(pile)는 쪼개지 않는다 — pi·le(π ≤) 가 아니다", () => {
    assert.equal(tex("LEFT [ pile{#} x RIGHT ]"), "\\left [ pile { # } x \\right ]")
  })
})

describe("한컴 수식 — 중괄호 없는 항목", () => {
  it("over 앞뒤 맨 항목은 분자·분모 한 항목 — 분모가 LaTeX 에서 첫 글자만 잡히지 않게 감싼다", () => {
    assert.equal(tex("= 5 over 13"), "= \\frac{ 5 } { 13 }")
    assert.equal(hwpEquationToLatex("x^2 over a^2"), "\\frac{ x ^ { 2 } } { a ^ { 2 } }")
    assert.equal(tex("2 over root5"), "\\frac{ 2 } { \\sqrt{ 5 } }")
  })

  it("막대·근호의 맨 인자, of 없는 root 는 제곱근", () => {
    assert.equal(tex("rm bar AB"), "\\overline{ AB }")
    assert.equal(hwpEquationToLatex("= 70- 30 root5 cos theta"), "= 70- 30 \\sqrt{ 5 } \\cos \\theta")
  })

  it("분자 막대 묶음을 벗기지 않는다 — \\frac\\overline 이 되거나 묶음 안 다른 항이 사라지지 않게", () => {
    assert.equal(tex("{bar{AB}} over {t}"), "\\frac{ \\overline{ AB } } { t }")
    assert.equal(tex("{bar{AH} - bar{CH}} over {t}"), "\\frac{ \\overline{ AH } - \\overline{ CH } } { t }")
  })
})

describe("HWPX 수식은 HWP5 와 같은 변환", () => {
  it("맨 첨자는 공백 전까지(2^3-1 = 2^{3-1}), 소문자 le 는 ≤", async () => {
    const eq = (s: string) => `<hp:equation id="1" baseUnit="900"><hp:script>${s}</hp:script></hp:equation>`
    const sec = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">` +
      `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${eq("=2^3-1")}<hp:t>이고 </hp:t>${eq("1 le x le 5")}</hp:run></hp:p></hs:sec>`
    const zip = new JSZip()
    zip.file("mimetype", "application/hwp+zip")
    zip.file("Contents/section0.xml", sec)
    const r = await parseHwpxDocument(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(r.markdown.includes("$=2 ^ { 3-1 }$"), r.markdown)
    assert.ok(r.markdown.includes("$1 \\leq x \\leq 5$"), r.markdown)
  })
})
