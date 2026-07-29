import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hwpEquationToLatex } from "../src/hwp5/equation.js"

// hwp5 수식 변환은 hwpx hmlToLatex(정본)에 위임 — 기대값은 정본 출력 기준.
// (공백/괄호 스타일은 정본 서식을 따르고, 수학적 의미는 종전과 동일해야 한다)
describe("hwpEquationToLatex", () => {
  it("기호와 예약어를 LaTeX 명령어로 변환", () => {
    assert.equal(hwpEquationToLatex("times div != le GEQ pi sin` A"), "\\times \\div \\neq \\leq \\geq \\pi \\sin A")
  })

  it("첨자가 붙은 대형 연산자와 좌우 괄호 명령을 변환", () => {
    assert.equal(hwpEquationToLatex("sum_{k=1}^{n} a_{k}"), "\\sum _ { k=1 } ^ { n } a _ { k }")
    assert.equal(hwpEquationToLatex("SMALLSUM_{k=1}^{n} a_{k}"), "\\sum _ { k=1 } ^ { n } a _ { k }")
    assert.equal(hwpEquationToLatex("LEFT {a_{n} RIGHT}"), "\\left \\{ a _ { n } \\right \\}")
    assert.equal(hwpEquationToLatex("left[ a,`b right]"), "\\left[ a, b \\right]")
  })

  it("분수 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("{1} over {2}"), "\\frac{ 1 } { 2 }")
    assert.equal(hwpEquationToLatex("y= {ax+b} over {cx+d}"), "y= \\frac{ ax+b } { cx+d }")
  })

  it("제곱근과 n제곱근 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("sqrt {ax+b}"), "\\sqrt { ax+b }")
    assert.equal(hwpEquationToLatex("root n of {x+1}"), "\\sqrt[ n ]{ x+1 }")
  })

  it("첨자와 행렬/경우의 수 구조를 변환", () => {
    assert.equal(hwpEquationToLatex("x ^ 2 + a_b"), "x ^ { 2 } + a _ { b }")
    // EqEdit의 #는 행 구분자(정본 hmlToLatex 규칙) — 종전 hwp5 독자 구현의 &(열) 처리는 오역
    assert.equal(hwpEquationToLatex("matrix {A # B # C}"), "\\begin{matrix} A \\\\ B \\\\ C \\end{matrix}")
    assert.equal(hwpEquationToLatex("cases {A # B}"), "\\begin{cases} A \\\\ B \\end{cases}")
  })

  it("HWP 글꼴 지시자와 추가 도형 기호를 정리", () => {
    assert.equal(hwpEquationToLatex("rm vec{AB}"), "\\overrightarrow{ AB }")
    assert.equal(hwpEquationToLatex("bar{AB}"), "\\overline{ AB }")
    assert.equal(hwpEquationToLatex("rm P it (A)"), "P (A)")
    assert.equal(hwpEquationToLatex("// △ABC"), "\\parallel \\triangle ABC")
  })

  it("근의 공식 전체 변환 (정본 hmlToLatex 위임 확인)", () => {
    assert.equal(
      hwpEquationToLatex("x = { -b +- sqrt { b^2 -4ac } } over {2a}"),
      "x = \\frac{ -b \\pm \\sqrt { b ^ { 2 } -4ac } } { 2a }",
    )
  })
})
