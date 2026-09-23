/**
 * HWPX 각주·미주·대체표현·심볼 PUA 회귀 테스트 (v4.14.3, rhwp 코퍼스 편입).
 *
 * 한컴 실렌더(footnote-01.pdf "플라스틱 액체1)와 …" / 주석 "1) 플라스틱 액체란",
 * 3-09월_교육_통합 본문 "문1）" / 미주 "문1） ④") 대로 본문 참조 부호와 주석 머리 번호를
 * 재구성하고, 주석 본문은 문단 모델(수식 LaTeX·필드 매개변수 제외·표 구분)로 모은다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { hmlToLatex } from "../src/hwpx/equation.js"
import { noteRefMark, noteAutoNumText } from "../src/hwpx/notes.js"
import type { IRBlock } from "../src/types.js"

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

/** secPr 각주/미주 번호 모양 — 실파일 구조 (footNotePr DIGIT ")" / endNotePr 문…）) */
function secPr(fn = `type="DIGIT" userChar="" prefixChar="" suffixChar=")"`, en = `type="DIGIT" userChar="" prefixChar="문" suffixChar="）"`): string {
  return `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr id=""><hp:footNotePr><hp:autoNumFormat ${fn} supscript="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat ${en} supscript="0"/></hp:endNotePr></hp:secPr></hp:run></hp:p>`
}

function sec(body: string, pr = secPr()): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${pr}${body}</hs:sec>`
}

function autoNum(kind: "FOOTNOTE" | "ENDNOTE", num: number, prefix = "", suffix = ")"): string {
  return `<hp:ctrl><hp:autoNum num="${num}" numType="${kind}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="${prefix}" suffixChar="${suffix}" supscript="0"/></hp:autoNum></hp:ctrl>`
}

function footNote(num: number, inner: string, attrs = `suffixChar="41"`): string {
  return `<hp:ctrl><hp:footNote number="${num}" ${attrs} instId="${num}"><hp:subList>${inner}</hp:subList></hp:footNote></hp:ctrl>`
}

async function makeHwpx(sectionXml: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", sectionXml)
  return await zip.generateAsync({ type: "arraybuffer" })
}

const textBlocks = (blocks: IRBlock[]) => blocks.filter(b => b.type === "paragraph" && b.text)

describe("HWPX 각주·미주 — 참조 부호와 주석 본문", () => {
  it("본문 개체 자리에 참조 부호, 주석 본문 머리엔 autoNum 번호 (한컴 실렌더 표기)", async () => {
    const note = footNote(1, `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("FOOTNOTE", 1)}<hp:t> 플라스틱 액체란</hp:t></hp:run></hp:p>`)
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>플라스틱 액체</hp:t>${note}<hp:t>와 같은 원료</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    const [p] = textBlocks(r.blocks)
    assert.equal(p.text, "플라스틱 액체1)와 같은 원료")
    assert.equal(p.footnoteText, "1) 플라스틱 액체란")
    assert.ok(r.markdown.includes("플라스틱 액체1)와 같은 원료 (주: 1) 플라스틱 액체란)"), r.markdown)
  })

  it("미주 사용자 장식 문자(문…）)와 주석 안 수식은 LaTeX — HULK 스크립트 원문 누출 금지", async () => {
    const eq = `<hp:equation id="1" baseUnit="900"><hp:script>{1} over {2}</hp:script></hp:equation>`
    const note = `<hp:ctrl><hp:endNote number="3" prefixChar="47928" suffixChar="65289" instId="9"><hp:subList>` +
      `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("ENDNOTE", 3, "문", "）")}<hp:t> ④</hp:t></hp:run></hp:p>` +
      `<hp:p id="0"><hp:run charPrIDRef="0">${eq}<hp:t/></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl>`
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${note}<hp:t>의 값은?</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    const [p] = textBlocks(r.blocks)
    assert.equal(p.text, "문3）의 값은?")
    assert.ok(p.footnoteText?.startsWith("문3） ④"), p.footnoteText)
    assert.ok(p.footnoteText?.includes("\\frac"), `수식 LaTeX: ${p.footnoteText}`)
    assert.ok(!/\bover\b/.test(p.footnoteText ?? ""), `HULK 원문 누출: ${p.footnoteText}`)
  })

  it("주석 안 하이퍼링크 필드 매개변수(Command·HWPHYPERLINK_*)는 글로 새지 않는다", async () => {
    const field = `<hp:ctrl><hp:fieldBegin id="7" type="HYPERLINK"><hp:parameters cnt="2"><hp:stringParam name="Command">http\\://example.org/;1;0;0;</hp:stringParam>` +
      `<hp:stringParam name="Path">http://example.org/</hp:stringParam><hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl>`
    const note = footNote(2, `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("FOOTNOTE", 2)}${field}<hp:t>http://example.org/</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="7"/></hp:ctrl><hp:t> 참조</hp:t></hp:run></hp:p>`)
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>그림 2.</hp:t>${note}</hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    const [p] = textBlocks(r.blocks)
    assert.ok(!/HWPHYPERLINK|;1;0;0;/.test(p.footnoteText ?? ""), `매개변수 누출: ${p.footnoteText}`)
    assert.ok(p.footnoteText?.startsWith("2)"), p.footnoteText)
    assert.ok(p.footnoteText?.includes("example.org"), p.footnoteText)
  })

  it("USER_CHAR 각주는 사용자 문자만 — 장식 속성이 없으면 구역 번호 모양(suffixChar=\"\")을 따른다", async () => {
    const pr = secPr(`type="USER_CHAR" userChar="*" prefixChar="" suffixChar=""`)
    const note = `<hp:ctrl><hp:footNote flag="385" number="1" userChar="42"><hp:subList><hp:p id="0"><hp:run charPrIDRef="0">` +
      `<hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"><hp:autoNumFormat type="USER_CHAR" userChar="*" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl>` +
      `<hp:t> 표시는 전년동기대비 증감</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl>`
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>(증가</hp:t>${note}<hp:t>) 제조업</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body, pr)))
    const [p] = textBlocks(r.blocks)
    assert.equal(p.text, "(증가*) 제조업")
    assert.equal(p.footnoteText, "* 표시는 전년동기대비 증감")
  })

  it("빈 주석은 본문 부호만 남고 \"(주: …)\" 는 없다, 한 문단 주석 여럿은 \"; \" 로 한 표기", async () => {
    const empty = footNote(40, `<hp:p id="0"><hp:run charPrIDRef="0"/></hp:p>`)
    const a = footNote(3, `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("FOOTNOTE", 3)}<hp:t> 가</hp:t></hp:run></hp:p>`)
    const b = footNote(4, `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("FOOTNOTE", 4)}<hp:t> 나</hp:t></hp:run></hp:p>`)
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>빈 주석</hp:t>${empty}</hp:run></hp:p>` +
      `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>12국가</hp:t>${a}<hp:t>이며 19개 국가</hp:t>${b}<hp:t>로 집계</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    const [p1, p2] = textBlocks(r.blocks)
    assert.equal(p1.text, "빈 주석40)")
    assert.equal(p1.footnoteText, undefined)
    assert.equal(p2.text, "12국가3)이며 19개 국가4)로 집계")
    assert.equal(p2.footnoteText, "3) 가; 4) 나")
  })

  it("표 셀 각주 — 셀 문단 블록은 footnoteText 슬롯, 평탄화 text 와 HTML 셀엔 \"(주: …)\"", async () => {
    const note = footNote(1, `<hp:p id="0"><hp:run charPrIDRef="0">${autoNum("FOOTNOTE", 1)}<hp:t> 표안의 각주</hp:t></hp:run></hp:p>`)
    const cell = (inner: string, c: number, r: number, cs = 1) =>
      `<hp:tc><hp:subList>${inner}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="1"/></hp:tc>`
    const p = (t: string) => `<hp:p id="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`
    const tbl = `<hp:tbl id="1" rowCnt="2" colCnt="2"><hp:tr>${cell(`<hp:p id="0"><hp:run charPrIDRef="0"><hp:t>변화</hp:t>${note}<hp:t>와 문제점</hp:t></hp:run></hp:p>`, 0, 0, 2)}</hp:tr>` +
      `<hp:tr>${cell(p("가"), 0, 1)}${cell(p("나"), 1, 1)}</hp:tr></hp:tbl>`
    const r = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`)))
    const t = r.blocks.find(b => b.type === "table")!.table!
    const c0 = t.cells[0][0]
    assert.equal(c0.text, "변화1)와 문제점 (주: 1) 표안의 각주)")
    const blk = c0.blocks?.find(b => b.type === "paragraph")
    assert.equal(blk?.text, "변화1)와 문제점")
    assert.equal(blk?.footnoteText, "1) 표안의 각주")
    assert.ok(r.markdown.includes("변화1)와 문제점 (주: 1) 표안의 각주)"), r.markdown)
  })

  it("주석 안 표는 셀 글이 \" / \" 로 구분된다 (종전 extractTextFromNode 는 붙여 썼다)", async () => {
    const cell = (t: string, c: number) => `<hp:tc><hp:subList><hp:p id="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${c}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`
    const tbl = `<hp:tbl id="2" rowCnt="1" colCnt="2"><hp:tr>${cell("극대", 0)}${cell("극소", 1)}</hp:tr></hp:tbl>`
    const note = `<hp:ctrl><hp:endNote number="1" prefixChar="47928" suffixChar="65289"><hp:subList><hp:p id="0"><hp:run charPrIDRef="0">${autoNum("ENDNOTE", 1, "문", "）")}<hp:t> ③</hp:t></hp:run></hp:p>` +
      `<hp:p id="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl>`
    const r = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${note}<hp:t>문항</hp:t></hp:run></hp:p>`)))
    const [p] = textBlocks(r.blocks)
    assert.equal(p.footnoteText, "문1） ③ 극대 / 극소")
  })

  it("notes.ts 표기 함수 — 속성 없으면 구역 모양, 둘 다 없으면 한컴 기본 \"N)\"", () => {
    assert.equal(noteRefMark({ number: "7", suffixChar: "41" }), "7)")
    assert.equal(noteRefMark({ number: "2", prefixChar: "47928", suffixChar: "65289" }), "문2）")
    assert.equal(noteRefMark({ number: "5" }, { type: "DIGIT", userChar: "", prefixChar: "[", suffixChar: "]" }), "[5]")
    assert.equal(noteRefMark({ number: "3" }, { type: "CIRCLED_DIGIT", userChar: "", prefixChar: "", suffixChar: "" }), "③")
    assert.equal(noteAutoNumText("12", { type: "DIGIT", userChar: "", prefixChar: "문", suffixChar: "）" }), "문12）")
  })
})

describe("HWPX 대체 표현(hp:switch)·수식 줄바꿈·심볼 PUA", () => {
  it("hp:switch 는 hp:case 한 갈래만 — 차트·OLE 대체 캡션이 두 번 나오지 않는다", async () => {
    const cap = `<hp:caption side="BOTTOM"><hp:subList><hp:p id="0"><hp:run charPrIDRef="0"><hp:t>[그림 5] 성생활 비율</hp:t></hp:run></hp:p></hp:subList></hp:caption>`
    const sw = `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/ooxmlchart"><hp:chart id="1" chartIDRef="Chart/chart1.xml">${cap}</hp:chart></hp:case>` +
      `<hp:default><hp:ole id="1" binaryItemIDRef="ole9">${cap}</hp:ole></hp:default></hp:switch>`
    const r = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${sw}<hp:t/></hp:run></hp:p>`)))
    assert.equal(r.markdown.split("[그림 5] 성생활 비율").length - 1, 1, r.markdown)
  })

  it("수식 스크립트 안 줄바꿈은 공백 — LaTeX 가 줄을 넘지 않는다 (math-001 cases)", () => {
    const latex = hmlToLatex("f LEFT ( x RIGHT ) = {cases{eqalign{``5x+a#\n}&amp;&amp;eqalign{~ LEFT ( x&lt;`-2 RIGHT )#\n}#``x ^{2} -a}}")
    assert.ok(!latex.includes("\n"), JSON.stringify(latex))
    assert.ok(latex.includes("\\begin{cases}"), latex)
  })

  it("심볼 PUA U+F021~F0FF — 검증 표에 없는 코드는 Wingdings 글리프 (한컴 PDF ❶❷), 검증 표가 우선", async () => {
    const body = `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t> 일시  참석  다음</hp:t></hp:run></hp:p>`
    const r = await parseHwpxDocument(await makeHwpx(sec(body)))
    assert.ok(r.markdown.includes("❶ 일시 ❷ 참석 ➔ 다음"), r.markdown)
  })

  it("머리말 문단의 글상자 글도 모은다 (extractParagraphInfo 는 글상자를 건너뛴다)", async () => {
    const rect = `<hp:rect id="1"><hp:drawText><hp:subList><hp:p id="0"><hp:run charPrIDRef="0"><hp:t>(사회·문화)</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:rect>`
    const header = `<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList><hp:p id="0"><hp:run charPrIDRef="0">${rect}<hp:t>사회탐구 영역</hp:t></hp:run></hp:p></hp:subList></hp:header></hp:ctrl>`
    const r = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${header}<hp:t>본문</hp:t></hp:run></hp:p>`)))
    assert.ok(/사회탐구 영역\n\(사회·문화\)/.test(r.blocks[0].text ?? ""), JSON.stringify(r.blocks[0]))
  })
})
