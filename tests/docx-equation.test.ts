import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DOMParser } from "../src/xml/dom.js"
import { ommlElementToLatex, isOmmlRoot, isDisplayMath } from "../src/docx/equation.js"

/** <m:xxx> 래퍼 XML 을 파싱해 최상위 Element 반환 (공백 텍스트 노드 스킵) */
function parse(xml: string): Element {
  const wrapped = `<root xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${xml}</root>`
  const doc = new DOMParser().parseFromString(wrapped, "text/xml")
  const root = doc.documentElement
  for (let i = 0; i < root.childNodes.length; i++) {
    const n = root.childNodes[i]
    if (n.nodeType === 1) return n as Element
  }
  throw new Error("no element child")
}

describe("ommlElementToLatex — basic", () => {
  it("단일 run: <m:r><m:t>x</m:t></m:r>", () => {
    const el = parse(`<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>`)
    assert.equal(ommlElementToLatex(el), "x")
  })

  it("isOmmlRoot / isDisplayMath", () => {
    const inline = parse(`<m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>`)
    const display = parse(`<m:oMathPara><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath></m:oMathPara>`)
    assert.equal(isOmmlRoot(inline), true)
    assert.equal(isOmmlRoot(display), true)
    assert.equal(isDisplayMath(inline), false)
    assert.equal(isDisplayMath(display), true)
  })
})

describe("ommlElementToLatex — frac / sub / sup", () => {
  it("분수 m:f", () => {
    const el = parse(`
      <m:oMath>
        <m:f>
          <m:num><m:r><m:t>a</m:t></m:r></m:num>
          <m:den><m:r><m:t>b</m:t></m:r></m:den>
        </m:f>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\frac{a}{b}")
  })

  it("위첨자 m:sSup", () => {
    const el = parse(`
      <m:oMath>
        <m:sSup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
          <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
        </m:sSup>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "{x}^{2}")
  })

  it("아래첨자 m:sSub", () => {
    const el = parse(`
      <m:oMath>
        <m:sSub>
          <m:e><m:r><m:t>a</m:t></m:r></m:e>
          <m:sub><m:r><m:t>n</m:t></m:r></m:sub>
        </m:sSub>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "{a}_{n}")
  })

  it("아래위첨자 m:sSubSup", () => {
    const el = parse(`
      <m:oMath>
        <m:sSubSup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
          <m:sub><m:r><m:t>i</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
        </m:sSubSup>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "{x}_{i}^{2}")
  })
})

describe("ommlElementToLatex — rad", () => {
  it("\\sqrt{x+1}", () => {
    const el = parse(`
      <m:oMath>
        <m:rad>
          <m:radPr><m:degHide m:val="1"/></m:radPr>
          <m:deg/>
          <m:e><m:r><m:t>x+1</m:t></m:r></m:e>
        </m:rad>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\sqrt{x+1}")
  })

  it("\\sqrt[3]{x}", () => {
    const el = parse(`
      <m:oMath>
        <m:rad>
          <m:deg><m:r><m:t>3</m:t></m:r></m:deg>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:rad>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\sqrt[3]{x}")
  })
})

describe("ommlElementToLatex — nary / delimiter", () => {
  it("\\sum_{i=1}^{n} i", () => {
    const el = parse(`
      <m:oMath>
        <m:nary>
          <m:naryPr><m:chr m:val="∑"/><m:limLoc m:val="undOvr"/></m:naryPr>
          <m:sub><m:r><m:t>i=1</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>n</m:t></m:r></m:sup>
          <m:e><m:r><m:t>i</m:t></m:r></m:e>
        </m:nary>
      </m:oMath>
    `)
    const out = ommlElementToLatex(el)
    assert.ok(out.startsWith("\\sum_{i=1}^{n}"))
    assert.ok(out.endsWith("i"))
  })

  it("n-ary 기본 integral (chr 없음)", () => {
    const el = parse(`
      <m:oMath>
        <m:nary>
          <m:sub><m:r><m:t>0</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>1</m:t></m:r></m:sup>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:nary>
      </m:oMath>
    `)
    const out = ommlElementToLatex(el)
    assert.ok(out.includes("\\int_{0}^{1}"))
  })

  it("delimiter \\left(...\\right)", () => {
    const el = parse(`
      <m:oMath>
        <m:d>
          <m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr>
          <m:e><m:r><m:t>x+y</m:t></m:r></m:e>
        </m:d>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\left(x+y\\right)")
  })
})

describe("ommlElementToLatex — matrix / accent / func", () => {
  it("2x2 matrix", () => {
    const el = parse(`
      <m:oMath>
        <m:m>
          <m:mr>
            <m:e><m:r><m:t>a</m:t></m:r></m:e>
            <m:e><m:r><m:t>b</m:t></m:r></m:e>
          </m:mr>
          <m:mr>
            <m:e><m:r><m:t>c</m:t></m:r></m:e>
            <m:e><m:r><m:t>d</m:t></m:r></m:e>
          </m:mr>
        </m:m>
      </m:oMath>
    `)
    const out = ommlElementToLatex(el)
    assert.ok(out.startsWith("\\begin{matrix}"))
    assert.ok(out.endsWith("\\end{matrix}"))
    assert.ok(out.includes("a & b"))
    assert.ok(out.includes("c & d"))
    assert.ok(out.includes("\\\\"))
  })

  it("acc (hat)", () => {
    const el = parse(`
      <m:oMath>
        <m:acc>
          <m:accPr><m:chr m:val="̂"/></m:accPr>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:acc>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\hat{x}")
  })

  it("func \\sin(x)", () => {
    const el = parse(`
      <m:oMath>
        <m:func>
          <m:fName><m:r><m:t>sin</m:t></m:r></m:fName>
          <m:e><m:r><m:t>x</m:t></m:r></m:e>
        </m:func>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\sin{x}")
  })

  it("bar (overline)", () => {
    const el = parse(`
      <m:oMath>
        <m:bar>
          <m:barPr><m:pos m:val="top"/></m:barPr>
          <m:e><m:r><m:t>AB</m:t></m:r></m:e>
        </m:bar>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\overline{AB}")
  })
})

describe("ommlElementToLatex — limLow / oMathPara", () => {
  it("\\lim_{x \\to 0}", () => {
    const el = parse(`
      <m:oMath>
        <m:limLow>
          <m:e><m:r><m:t>lim</m:t></m:r></m:e>
          <m:lim><m:r><m:t>x→0</m:t></m:r></m:lim>
        </m:limLow>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\lim_{x→0}")
  })

  it("oMathPara 래퍼도 동일 결과", () => {
    const el = parse(`
      <m:oMathPara>
        <m:oMath><m:r><m:t>E=mc</m:t></m:r><m:sSup><m:e><m:r><m:t></m:t></m:r></m:e><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSup></m:oMath>
      </m:oMathPara>
    `)
    const out = ommlElementToLatex(el)
    assert.ok(out.startsWith("E=mc"))
    assert.ok(out.includes("^{2}"))
  })
})

describe("ommlElementToLatex — LaTeX 로 깨지는 것 (#106)", () => {
  const angle = (inner: string) =>
    `<m:d><m:dPr><m:begChr m:val="⟨"/><m:endChr m:val="⟩"/></m:dPr><m:e><m:r><m:t>${inner}</m:t></m:r></m:e></m:d>`

  it("글자로 끝나는 명령 뒤 글자는 띄운다 (\\langlex 는 없는 명령)", () => {
    assert.equal(ommlElementToLatex(parse(`<m:oMath>${angle("x")}</m:oMath>`)), "\\left\\langle x\\right\\rangle")
    assert.equal(ommlElementToLatex(parse(`<m:oMath>${angle("a")}<m:r><m:t>b</m:t></m:r></m:oMath>`)),
      "\\left\\langle a\\right\\rangle b")
    // 숫자·기호 앞은 그대로 (명령 이름은 글자에서만 이어진다)
    assert.equal(ommlElementToLatex(parse(`<m:oMath>${angle("1")}<m:r><m:t>=</m:t></m:r></m:oMath>`)),
      "\\left\\langle1\\right\\rangle=")
  })

  it("수식 배열 한 줄 끝의 번호 #(43) 는 \\tag{43}", () => {
    const el = parse(`<m:oMathPara><m:oMath><m:eqArr><m:e>${angle("au,ν")}<m:r><m:t>=</m:t></m:r>${angle("L,ν")}` +
      `<m:r><m:t>#</m:t></m:r><m:d><m:e><m:r><m:t>43</m:t></m:r></m:e></m:d></m:e></m:eqArr></m:oMath></m:oMathPara>`)
    assert.equal(ommlElementToLatex(el), "\\left\\langle au,ν\\right\\rangle=\\left\\langle L,ν\\right\\rangle \\tag{43}")
    // 번호가 괄호째 한 run 에 든 선형 표기
    const lin = parse(`<m:oMath><m:eqArr><m:e><m:r><m:t>a=b#(S1)</m:t></m:r></m:e></m:eqArr></m:oMath>`)
    assert.equal(ommlElementToLatex(lin), "a=b \\tag{S1}")
  })

  it("번호가 아닌 # · % 는 이스케이프", () => {
    assert.equal(ommlElementToLatex(parse(`<m:oMath><m:r><m:t>#x=50%</m:t></m:r></m:oMath>`)), "\\#x=50\\%")
  })
})
