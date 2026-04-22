import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hwpEquationToLatex } from "../src/hwp5/equation.js"

describe("hwpEquationToLatex", () => {
  it("기호와 예약어를 LaTeX 명령어로 변환", () => {
    assert.equal(hwpEquationToLatex("times div != le GEQ pi sin` A"), "\\times \\div \\neq \\leq \\geq \\pi \\sin\\,A")
  })

  it("첨자가 붙은 대형 연산자와 좌우 괄호 명령을 변환", () => {
    assert.equal(hwpEquationToLatex("sum_{k=1}^{n} a_{k}"), "\\sum_{k=1}^{n} a_{k}")
    assert.equal(hwpEquationToLatex("SMALLSUM_{k=1}^{n} a_{k}"), "\\sum_{k=1}^{n} a_{k}")
    assert.equal(hwpEquationToLatex("LEFT {a_{n} RIGHT}"), "\\left\\{a_{n} \\right\\}")
    assert.equal(hwpEquationToLatex("left[ a,`b right]"), "\\left[ a,\\,b \\right]")
  })

  it("분수 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("{1} over {2}"), "\\frac{1}{2}")
    assert.equal(hwpEquationToLatex("y= {ax+b} over {cx+d}"), "y= \\frac{ax+b}{cx+d}")
  })

  it("제곱근과 n제곱근 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("sqrt {ax+b}"), "\\sqrt{ax+b}")
    assert.equal(hwpEquationToLatex("root n of {x+1}"), "\\sqrt[n]{x+1}")
  })

  it("첨자와 행렬/경우의 수 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("x ^ 2 + a_b"), "x^{2} + a_{b}")
    assert.equal(hwpEquationToLatex("matrix {A # B # C}"), "\\begin{matrix} A & B & C \\end{matrix}")
    assert.equal(hwpEquationToLatex("cases {A # B}"), "\\begin{cases} A \\\\ B \\end{cases}")
  })

  it("HWP 글꼴 지시자와 추가 도형 기호를 정리", () => {
    assert.equal(hwpEquationToLatex("rm vec{AB}"), "\\vec{AB}")
    assert.equal(hwpEquationToLatex("bar{AB}"), "\\overline{AB}")
    assert.equal(hwpEquationToLatex("rm P it (A)"), "P (A)")
    assert.equal(hwpEquationToLatex("// △ABC"), "\\parallel \\triangle ABC")
  })
})
