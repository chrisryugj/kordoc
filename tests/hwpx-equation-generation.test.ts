import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx } from "../src/index.js"
import { generateEquationXml, latexLikeToEqEdit, quoteReservedKeywords } from "../src/hwpx/equation-generate.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"

const compact = (value: string) => value.replace(/\s+/g, " ").trim()

describe("latexLikeToEqEdit", () => {
  it("분수, 제곱근, n제곱근을 EqEdit script로 바꾼다", () => {
    assert.equal(latexLikeToEqEdit("\\frac{a}{b}"), "{a} over {b}")
    assert.equal(latexLikeToEqEdit("\\sqrt{x}"), "sqrt{x}")
    assert.equal(latexLikeToEqEdit("\\sqrt[n]{x}"), "root {n} of {x}")
  })

  it("그리스 문자, 적분, 극한, 화살표, 관계 연산자를 제한된 subset으로 바꾼다", () => {
    assert.equal(latexLikeToEqEdit("\\alpha + \\beta = \\gamma"), "alpha + beta = gamma")
    assert.equal(latexLikeToEqEdit("\\int_a^b f(x) dx"), "int _{a} ^{b} f(x) dx")
    assert.equal(latexLikeToEqEdit("\\lim_{x \\to 0} f(x)"), "lim _{x -> 0} f(x)")
    assert.equal(latexLikeToEqEdit("A \\rightarrow B"), "A -> B")
    assert.equal(latexLikeToEqEdit("x \\le y \\ne z \\ge w"), "x LEQ y != z GEQ w")
  })

  it("matrix 환경을 HWP 행렬 구분자로 바꾼다", () => {
    const out = latexLikeToEqEdit("\\begin{matrix} a & b \\\\ c & d \\end{matrix}")
    assert.equal(out, "{matrix{a & b # c & d}}")
  })

  it("첨자/위첨자 안 짧은 예약어는 따옴표로 보호한다", () => {
    assert.equal(quoteReservedKeywords("electrode _{rel} ^{infty}"), 'electrode _{"rel"} ^{infty}')
  })
})

describe("parseMarkdownToBlocks — display math", () => {
  it("single-line display math를 equation block으로 파싱한다", () => {
    const blocks = parseMarkdownToBlocks("$$a+b$$")
    assert.deepEqual(blocks, [{ type: "equation", text: "a+b" }])
  })

  it("multi-line display math를 equation block으로 파싱한다", () => {
    const blocks = parseMarkdownToBlocks("앞\n\n$$\na+b\n$$\n\n뒤")
    assert.equal(blocks[0].type, "paragraph")
    assert.equal(blocks[1].type, "equation")
    assert.equal(blocks[1].text, "a+b")
    assert.equal(blocks[2].type, "paragraph")
  })
})

describe("generateEquationXml", () => {
  it("<hp:equation>과 <hp:script>를 생성한다", () => {
    const xml = generateEquationXml("{a} over {b}", { zOrder: 3 })
    assert.ok(xml.includes('<hp:equation id="2000000004" zOrder="3" numberingType="EQUATION"'))
    assert.ok(xml.includes('version="Equation Version 60"'))
    assert.ok(xml.includes('font="HYhwpEQ"'))
    assert.ok(xml.includes("<hp:shapeComment>수식입니다.</hp:shapeComment>"))
    assert.ok(xml.includes("<hp:script>{a} over {b}</hp:script>"))
  })

  it("<hp:script> 내용을 XML-safe하게 escape한다", () => {
    const xml = generateEquationXml("x < y & z > w")
    assert.ok(xml.includes("<hp:script>x &lt; y &amp; z &gt; w</hp:script>"))
  })
})

describe("markdownToHwpx equation generation", () => {
  it("display math block을 section0.xml의 native equation으로 렌더링한다", async () => {
    const buf = await markdownToHwpx("피타고라스\n\n$$\na^2 + b^2 = c^2\n$$")
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")

    assert.ok(section.includes("<hp:equation"), "equation 요소 생성")
    assert.ok(section.includes("<hp:script>a ^{2} + b ^{2} = c ^{2}</hp:script>"), "script 생성")
    assert.equal((section.match(/<hp:secPr/g) ?? []).length, 1, "secPr는 1회만 생성")
  })

  it("수식이 첫 블록이면 secPr 전용 더미 문단 뒤에 equation 문단을 둔다", async () => {
    const buf = await markdownToHwpx("$$\\frac{a}{b}$$")
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    const secPrIdx = section.indexOf("<hp:secPr")
    const equationIdx = section.indexOf("<hp:equation")

    assert.ok(secPrIdx >= 0)
    assert.ok(equationIdx > secPrIdx, "equation은 secPr 뒤에 위치")
    assert.ok(section.includes("<hp:script>{a} over {b}</hp:script>"))
  })

  it("생성된 HWPX를 다시 파싱하면 수식이 Markdown math로 돌아온다", async () => {
    const buf = await markdownToHwpx("식:\n\n$$\\frac{a}{b}$$\n\n끝")
    const parsed = await parseHwpx(buf)

    assert.equal(parsed.success, true)
    if (parsed.success) {
      const markdown = compact(parsed.markdown)
      const mathCompact = parsed.markdown.replace(/\s+/g, "")
      assert.ok(markdown.includes("식:"), markdown)
      assert.ok(mathCompact.includes("$\\frac{a}{b}$"), parsed.markdown)
      assert.ok(markdown.includes("끝"), markdown)
    }
  })

  it("여러 수식 block은 서로 다른 equation id를 가진다", async () => {
    const buf = await markdownToHwpx("$$x$$\n\n본문\n\n$$y$$")
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    const ids = [...section.matchAll(/<hp:equation id="(\d+)"/g)].map(m => m[1])

    assert.deepEqual(ids, ["2000000001", "2000000003"])
  })
})
