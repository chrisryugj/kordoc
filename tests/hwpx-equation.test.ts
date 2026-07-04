import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hmlToLatex } from "../src/hwpx/equation.js"

describe("hmlToLatex — single token convert map", () => {
  it("README 예제: LEFT ⌊ a+b RIGHT ⌋", () => {
    const out = hmlToLatex("LEFT ⌊ a+b RIGHT ⌋").replace(/\s+/g, " ").trim()
    assert.equal(out, "\\left \\lfloor a+b \\right \\rfloor")
  })

  it("pm, neq, leq 등 단일 토큰", () => {
    const out = hmlToLatex("a ± b != c LEQ d").replace(/\s+/g, " ").trim()
    assert.equal(out, "a \\pm b \\neq c \\leq d")
  })

  it("그리스 문자 (소문자/대문자)", () => {
    const out = hmlToLatex("alpha + PHI").replace(/\s+/g, " ").trim()
    assert.equal(out, "\\alpha + \\Phi")
  })

  it("\\left {  / \\right } 는 \\{ / \\} 로 바뀜", () => {
    const out = hmlToLatex("LEFT { x RIGHT }").replace(/\s+/g, " ").trim()
    assert.equal(out, "\\left \\{ x \\right \\}")
  })
})

describe("hmlToLatex — frac (over)", () => {
  it("{a} over {b} → \\frac{a}{b}", () => {
    const out = hmlToLatex("{a} over {b}").replace(/\s+/g, "")
    assert.equal(out, "\\frac{a}{b}")
  })

  it("중첩 frac", () => {
    const out = hmlToLatex("{ { 1 } over { x } } over { y }").replace(/\s+/g, "")
    assert.equal(out, "\\frac{\\frac{1}{x}}{y}")
  })
})

describe("hmlToLatex — root of", () => {
  it("root {3} of {x+1} → \\sqrt[3]{x+1}", () => {
    const out = hmlToLatex("root {3} of {x+1}").replace(/\s+/g, "")
    assert.equal(out, "\\sqrt[3]{x+1}")
  })
})

describe("hmlToLatex — 예약어 리터럴 오파싱 방지 (리뷰 #7)", () => {
  it('첨자 따옴표 리터럴 "over"가 frac 트리거가 되지 않는다 (\\frac{a}{b}+x_{over} 왕복)', () => {
    const out = hmlToLatex('{a} over {b} + x _ {"over"}').replace(/\s+/g, "")
    assert.equal(out, "\\frac{a}{b}+x_{\\text{over}}")
  })

  it('다중 단어 인용 "sum over items" 내부의 over를 건드리지 않는다', () => {
    const out = hmlToLatex('{ "sum over items" } + {a} over {b}')
    assert.ok(out.includes('"sum over items"'), out)
    assert.ok(out.replace(/\s+/g, "").includes("\\frac{a}{b}"), out)
  })

  it('선행 리터럴 "profit"의 of 부분문자열이 root의 of로 오인되지 않는다', () => {
    const out = hmlToLatex('"profit" + root {3} of {x}').replace(/\s+/g, "")
    assert.equal(out, "\\text{profit}+\\sqrt[3]{x}")
  })

  it("단어 내부 부분문자열(groot·cover)은 연산자가 아니다", () => {
    const out = hmlToLatex("groot + cover").replace(/\s+/g, " ").trim()
    assert.equal(out, "groot + cover")
  })
})

describe("hmlToLatex — vec / bar", () => {
  it("{ vec {AB} } → \\overrightarrow{AB}", () => {
    const out = hmlToLatex("{ vec {AB} }").replace(/\s+/g, "")
    assert.equal(out, "\\overrightarrow{AB}")
  })

  it("{ hat {x} } → \\widehat{x}", () => {
    const out = hmlToLatex("{ hat {x} }").replace(/\s+/g, "")
    assert.equal(out, "\\widehat{x}")
  })

  it("바깥 중괄호 없는 bar 입력도 멈추지 않고 변환한다", () => {
    const out = hmlToLatex("||bar {v}^{*}(u)-I _{δ} bar {v}^{*}(u)|| _{∞}").replace(/\s+/g, "")
    assert.ok(out.includes("\\overline{v}"), out)
    assert.ok(!out.includes("HULKBAR"), out)
  })
})

describe("hmlToLatex — matrix / cases", () => {
  it("matrix {a & b # c & d} → \\begin{matrix} a & b \\\\ c & d \\end{matrix}", () => {
    // 원본은 outer brackets 제거 → 결과는 matrix 본문만
    const out = hmlToLatex("{ matrix {a & b # c & d} }")
    assert.ok(out.includes("\\begin{matrix}"))
    assert.ok(out.includes("\\end{matrix}"))
    assert.ok(out.includes("\\\\")) // row 구분자
  })

  it("cases 변환", () => {
    const out = hmlToLatex("{ cases { 1 & x>0 # 0 & x<=0 } }")
    assert.ok(out.includes("\\begin{cases}"))
    assert.ok(out.includes("\\end{cases}"))
  })

  it("바깥 중괄호 없는 cases 입력도 토큰을 소비한다", () => {
    const out = hmlToLatex("cases { nI Δ t, λ=1, # I Δ t{1-λ^{n}} over {1-λ}, 0≤λ<1 }")
    assert.ok(out.includes("\\begin{cases}"), out)
    assert.ok(!out.includes("HULKCASE"), out)
  })
})

describe("hmlToLatex — brace (overbrace / underbrace)", () => {
  it("OVERBRACE {x+y} {n} → \\overbrace{x+y}^{n}", () => {
    const out = hmlToLatex("OVERBRACE {x+y} {n}").replace(/\s+/g, "")
    assert.equal(out, "\\overbrace{x+y}^{n}")
  })
})

describe("hmlToLatex — 통합 케이스", () => {
  it("근의 공식", () => {
    const out = hmlToLatex("x = { -b +- SQRT { b ^2 -4ac } } over {2a}")
    // over 변환 후 { -b +- \\sqrt { ... } } 가 분자로, {2a} 가 분모로
    assert.ok(out.includes("\\frac"))
    assert.ok(out.includes("-b"))
    assert.ok(out.includes("2a"))
  })

  it("빈 문자열/공백", () => {
    assert.equal(hmlToLatex(""), "")
    assert.equal(hmlToLatex("   ").trim(), "")
  })

  it("백틱은 공백으로 치환", () => {
    const out = hmlToLatex("a`+`b").replace(/\s+/g, " ").trim()
    assert.equal(out, "a + b")
  })
})
