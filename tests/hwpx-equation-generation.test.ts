import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx } from "../src/index.js"
import {
  COMMAND_MAP, ACCENT_COMMANDS,
  generateEquationXml, latexLikeToEqEdit, quoteReservedKeywords,
} from "../src/hwpx/equation-generate.js"
import { hmlToLatex } from "../src/hwpx/equation.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"

const compact = (value: string) => value.replace(/\s+/g, " ").trim()
const noSpace = (value: string) => value.replace(/\s+/g, "")

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

  it("pmatrix/bmatrix는 EqEdit 네이티브 토큰으로 낸다 (LEFT/RIGHT 합성 금지 — 리뷰 ·4)", () => {
    assert.equal(
      latexLikeToEqEdit("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}"),
      "{pmatrix{a & b # c & d}}",
    )
    assert.equal(latexLikeToEqEdit("\\begin{bmatrix} 1 \\\\ 2 \\end{bmatrix}"), "{bmatrix{1 # 2}}")
  })
})

describe("전 토큰 왕복 정합 (리뷰 ·3) — 쓰기 토큰은 읽기(hmlToLatex)로 같은 명령에 되돌아와야 한다", () => {
  it("COMMAND_MAP 전 항목이 고정점", () => {
    for (const [cmd, tok] of Object.entries(COMMAND_MAP)) {
      const latex = hmlToLatex(tok).trim()
      assert.match(latex, /^\\[A-Za-z]+$/, `\\${cmd} → "${tok}" → "${latex}" — 읽기 미인식`)
      assert.equal(
        COMMAND_MAP[latex.slice(1)], tok,
        `\\${cmd} → "${tok}" → "${latex}" — 재작성 시 다른 토큰`,
      )
    }
  })

  it("ACCENT_COMMANDS 전 항목이 고정점", () => {
    for (const [cmd, tok] of Object.entries(ACCENT_COMMANDS)) {
      const latex = hmlToLatex(`${tok} {x}`).trim()
      const m = /^\\([A-Za-z]+)/.exec(latex)
      assert.ok(m, `\\${cmd} → "${tok}{x}" → "${latex}" — 읽기 미인식`)
      assert.equal(
        ACCENT_COMMANDS[m![1]], tok,
        `\\${cmd} → "${tok}" → "\\${m![1]}" — 재작성 시 다른 토큰`,
      )
    }
  })

  it("\\pm·\\cdot·\\ast·\\leftarrow 왕복 (리뷰 ·3 실측 케이스)", () => {
    const script = latexLikeToEqEdit("a \\pm b \\cdot c \\ast d \\leftarrow e")
    assert.equal(script, "a +- b cdot c AST d larrow e")
    assert.equal(noSpace(hmlToLatex(script)), "a\\pmb\\cdotc\\astd\\leftarrowe")
  })
})

describe("괄호 구분자 왕복 (리뷰 ·4/·7)", () => {
  it("\\left( \\right)는 공백 분리 토큰으로 나가 왕복이 닫힌다", () => {
    const script = latexLikeToEqEdit("\\left( x \\right)")
    assert.equal(script, "LEFT ( x RIGHT )")
    assert.equal(noSpace(hmlToLatex(script)), "\\left(x\\right)")
  })

  it("\\left\\{ \\right\\}는 백슬래시 잔재 없이 균형 잡힌다", () => {
    const script = latexLikeToEqEdit("\\left\\{ x + y \\right\\}")
    assert.equal(script, "LEFT { x + y RIGHT }")
    assert.equal(noSpace(hmlToLatex(script)), "\\left\\{x+y\\right\\}")
  })

  it("pmatrix 왕복이 환경을 보존한다", () => {
    const script = latexLikeToEqEdit("\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}")
    assert.equal(noSpace(hmlToLatex(script)), "\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}")
  })
})

describe("첨자 예약어 보호 (리뷰 ·8)", () => {
  it("EqEdit 어휘와 충돌하는 리터럴 첨자만 따옴표로 보호한다", () => {
    assert.equal(quoteReservedKeywords("T_{int} + x_{rel}"), 'T_{"int"} + x_{rel}')
    assert.equal(latexLikeToEqEdit("T_{int}"), 'T _{"int"}')
    assert.equal(latexLikeToEqEdit("x_{rel}"), "x _{rel}")
  })

  it("변환 산출물(\\pi→pi)은 재따옴표하지 않는다", () => {
    assert.equal(latexLikeToEqEdit("x_{\\pi}"), "x _{pi}")
  })

  it("\\text/\\mathrm 리터럴은 따옴표로 나가고 \\text로 되돌아온다", () => {
    assert.equal(latexLikeToEqEdit("\\text{int}"), '"int"')
    assert.equal(noSpace(hmlToLatex('T _{"int"}')), "T_{\\text{int}}")
  })

  it("따옴표가 재파싱 LaTeX로 누수되지 않는다 (실측 재현)", async () => {
    const buf = await markdownToHwpx("$$T_{int}$$")
    const parsed = await parseHwpx(buf)
    assert.equal(parsed.success, true)
    if (parsed.success) {
      assert.ok(!parsed.markdown.includes('"'), parsed.markdown)
      assert.ok(noSpace(parsed.markdown).includes("\\text{int}"), parsed.markdown)
    }
  })
})

describe("악성/기형 입력 가드 (리뷰 ·2)", () => {
  it("중괄호 폭탄에 스택 오버플로 없이 리터럴 폴백한다", () => {
    const out = latexLikeToEqEdit("{".repeat(5000))
    assert.equal(typeof out, "string")
  })

  it("수식 소스 길이 상한 초과는 변환 없이 통과한다", () => {
    const long = "x + ".repeat(4000)
    const out = latexLikeToEqEdit(long)
    assert.equal(typeof out, "string")
  })

  it("markdownToHwpx 경유 중괄호 폭탄도 크래시 없다 (실측 재현)", async () => {
    const buf = await markdownToHwpx("$$" + "{".repeat(30000))
    assert.ok(buf.byteLength > 0)
    const closed = await markdownToHwpx("$$\n" + "{".repeat(30000) + "\n$$")
    assert.ok(closed.byteLength > 0)
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

  it("닫히지 않은 $$는 문서를 삼키지 않고 일반 문단으로 폴백한다 (리뷰 ·1 실측 재현)", () => {
    const blocks = parseMarkdownToBlocks("$$100만원 예산 내역\n\n항목1\n\n항목2")
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "paragraph", "paragraph"])
    assert.ok(blocks[0].text!.includes("100만원"))
  })

  it("같은 줄 닫는 $$ 뒤 텍스트를 문단으로 보존한다 (리뷰 ·1)", () => {
    const blocks = parseMarkdownToBlocks("$$a+b$$ 이다.")
    assert.deepEqual(blocks, [
      { type: "equation", text: "a+b" },
      { type: "paragraph", text: "이다." },
    ])
  })

  it("닫는 줄의 $$ 뒤 텍스트를 무음 소실하지 않는다 (리뷰 ·6 실측 재현)", () => {
    const blocks = parseMarkdownToBlocks("$$\nx = 1\n$$ 따라서 성립한다.")
    assert.deepEqual(blocks, [
      { type: "equation", text: "x = 1" },
      { type: "paragraph", text: "따라서 성립한다." },
    ])
  })

  it("빈 줄/코드펜스 경계에서 멀티라인 수집을 멈춘다", () => {
    const blocks = parseMarkdownToBlocks("$$\na+b\n\n문단입니다\n\n$$x$$")
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "paragraph", "paragraph", "equation"])
    const fenced = parseMarkdownToBlocks("$$\n```\ncode\n```")
    assert.equal(fenced.some(b => b.type === "equation"), false)
  })

  it("이스케이프된 \\$$ 는 수식 여닫이로 세지 않는다 (escapeGfm 접점)", () => {
    const blocks = parseMarkdownToBlocks("\\$\\$a+b\\$\\$")
    assert.deepEqual(blocks.map(b => b.type), ["paragraph"])
  })
})

describe("generateEquationXml", () => {
  it("<hp:equation>과 <hp:script>를 생성한다", () => {
    const xml = generateEquationXml("{a} over {b}", 3)
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

  it("수식 문단은 다른 생성 문단과 같은 최소 셸 — lineseg/고정 id 없음", async () => {
    const buf = await markdownToHwpx("$$a+b$$")
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(!section.includes("<hp:linesegarray"), "lineseg는 한컴 재계산에 맡긴다")
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
      const mathCompact = noSpace(parsed.markdown)
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

  it("공문 모드에서 수식이 항목 번호 run을 끊지 않는다 (리뷰 ·5 실측 재현)", async () => {
    const md = "1. 첫째 항목\n\n$$a+b$$\n\n2. 둘째 항목\n\n3. 셋째 항목"
    const buf = await markdownToHwpx(md, { gongmun: { preset: "기안문" } })
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")

    assert.ok(section.includes("1. 첫째 항목"), "1번 유지 (단일형제 생략 미발동)")
    assert.ok(section.includes("2. 둘째 항목"), "수식 뒤 번호 연속")
    assert.ok(section.includes("3. 셋째 항목"), "run 전체 연속")
    assert.ok(section.includes("<hp:equation"), "수식도 생성됨")
  })
})
