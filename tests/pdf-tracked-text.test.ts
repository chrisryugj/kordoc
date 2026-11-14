/** 자간 벌린 글 — 글리프 흐름의 진짜 공백으로 낱말 경계 (ODL 103) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { restoreTrackedSpacing, markSyntheticSpaces, joinTrackedHangul, markTrailingSpaceGlyphs, softHyphenHeads } from "../src/pdf/tracked-text.js"
import type { PdfTextItem } from "../src/pdf/text-line.js"

const raw = (str: string, fontName = "F1"): PdfTextItem => ({ str, transform: [11, 0, 0, 11, 100, 40], width: 100, height: 11, fontName })
const glyphs = (s: string) => [...s].map(unicode => ({ unicode }))

describe("restoreTrackedSpacing", () => {
  it("rebuilds letter-spaced words from the real space glyphs", () => {
    const items = [raw("E M A I L"), raw("F O R M O R E I N F O")]
    restoreTrackedSpacing(items, [OPS.setFont, OPS.showText], [["F1", 11], [glyphs("EMAIL FOR MORE INFO")]])
    assert.deepEqual(items.map(i => i.str), ["EMAIL", "FOR MORE INFO"])
  })

  it("leaves Hangul even spacing and unaligned fonts alone", () => {
    const items = [raw("홍 보 지 원 반"), raw("A B C D", "F2")]
    restoreTrackedSpacing(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 11], [glyphs("홍보지원반")], ["F2", 11], [glyphs("XYZW")]])
    assert.deepEqual(items.map(i => i.str), ["홍 보 지 원 반", "A B C D"])
  })
})

describe("띄운 숫자 아이템 — 글리프 흐름에 공백 글리프가 있으면 친 공백", () => {
  it("공백 글리프가 있는 \"4 2\" 는 자간 정규화로 붙이지 않고, 없는 \"45 0 -7\" 은 종전대로 붙인다", async () => {
    const { normalizeItems } = await import("../src/pdf/text-line.js")
    // LibreOffice PDF "A|4 2|페이지" — 라틴·한글 갈래마다 아이템이 갈리고 가운데 아이템이 공백 글리프를 품는다(web065 "A4 2페이지")
    const real = [raw("4 2")]
    restoreTrackedSpacing(real, [OPS.setFont, OPS.showText], [["F1", 11], [glyphs("4 2")]])
    assert.deepEqual(normalizeItems(real).map(i => i.text), ["4 2"])
    // 자간을 벌린 번호 — pdfjs 가 글자 틈마다 넣은 공백(흐름에 공백 글리프 없음)
    const tracked = [raw("45 0 -7 3 40 )")]
    restoreTrackedSpacing(tracked, [OPS.setFont, OPS.showText], [["F1", 11], [glyphs("450-7340)")]])
    assert.deepEqual(normalizeItems(tracked).map(i => i.text), ["450-7340)"])
  })
})

describe("joinTrackedHangul — 자간 넓힌 한글 줄의 pdfjs 가짜 공백", () => {
  it("공백 글리프 없는 한글 사이 공백만 지운다(\"한 국 정부 가\" → \"한국 정부가\")", () => {
    // 156782429: "한{970}[-106.9]국{970}[-106.9] {300}" — 0.107em 자간 이동마다 pdfjs 가 공백을 넣는다
    const items = [raw("한 국 정부 가")]
    joinTrackedHangul(items, [OPS.setFont, OPS.showText], [["F1", 13], [[{ unicode: "한" }, -106.9, { unicode: "국" }, -106.9, { unicode: " " }, { unicode: "정" }, { unicode: "부" }, { unicode: " " }, { unicode: "가" }]]])
    assert.deepEqual(items.map(i => i.str), ["한국 정부 가"])
  })
  it("친 공백(\"박 재 경\")·라틴 사이·흐름이 어긋난 글꼴은 그대로", () => {
    const items = [raw("박 재 경"), raw("A B", "F2"), raw("목 적", "F3")]
    joinTrackedHangul(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 11], [glyphs("박 재 경")], ["F2", 11], [glyphs("AB")], ["F3", 11], [glyphs("목저")]])
    assert.deepEqual(items.map(i => i.str), ["박 재 경", "A B", "목 적"])
  })
  it("세 글자 넘게 한 글자씩 띄운 아이템은 균등배분 판정에 맡긴다(\"증 감 률\")", () => {
    const items = [raw("증 감 률"), raw("목 적", "F2")]
    joinTrackedHangul(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText], [["F1", 11], [glyphs("증감률")], ["F2", 11], [glyphs("목적")]])
    assert.deepEqual(items.map(i => i.str), ["증 감 률", "목적"])
  })
  it("균등배분 칸만큼 벌어진 자리(TJ 0.15em 넘게)·연산 경계는 그대로", () => {
    const items = [raw("감 률"), raw("한 국", "F2")]
    joinTrackedHangul(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText, OPS.showText],
      [["F1", 12], [[{ unicode: "감" }, -590, { unicode: "률" }]], ["F2", 12], [glyphs("한")], [glyphs("국")]])
    assert.deepEqual(items.map(i => i.str), ["감 률", "한 국"])
  })
})

describe("markSyntheticSpaces — pdfjs 가 글자 틈에 만든 공백과 진짜 공백 글리프를 가른다", () => {
  const flag = (items: PdfTextItem[]) => items.map(i => !!(i as { synthetic?: boolean }).synthetic)
  it("TJ 자간 이동만 있는 배분 칸(\"보 험 업\")의 공백 아이템은 합성", () => {
    // 해외직접투자 보도자료 표 칸: "보 [-777.8] 험 [-777.8] 업" — 공백 글리프 없이 pdfjs 가 틈마다 " " 아이템을 만든다
    const items = [raw("보"), raw(" "), raw("험"), raw(" "), raw("업")]
    markSyntheticSpaces(items, [OPS.setFont, OPS.showText], [["F1", 13], [[{ unicode: "보" }, -777.8, { unicode: "험" }, -777.8, { unicode: "업" }]]])
    assert.deepEqual(flag(items), [false, true, false, true, false])
  })
  it("글리프 흐름에 공백이 있으면(다른 글꼴의 공백 포함) 진짜 공백", () => {
    const items = [raw("아침"), raw(" ", "F2"), raw("브리핑")]
    markSyntheticSpaces(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 9], [glyphs("아침")], ["F2", 9], [glyphs(" ")], ["F1", 9], [glyphs("브리핑")]])
    assert.deepEqual(flag(items), [false, false, false])
  })
  it("흐름이 어긋나는 글꼴은 손대지 않는다", () => {
    const items = [raw("가"), raw(" "), raw("나")]
    markSyntheticSpaces(items, [OPS.setFont, OPS.showText], [["F1", 9], [glyphs("다라")]])
    assert.deepEqual(flag(items), [false, false, false])
  })
})

describe("markTrailingSpaceGlyphs — 줄 끝 아이템 뒤 공백 글리프(어절 경계 꺾임)", () => {
  const at = (str: string, y: number, fontName = "F1"): PdfTextItem => ({ str, transform: [11, 0, 0, 11, 100, y], width: 30, height: 11, fontName })
  const flag = (items: PdfTextItem[]) => items.map(i => !!(i as { spaceAfter?: boolean }).spaceAfter)
  it("한컴 PDF 는 어절마다 뒤 공백까지 찍는다 — 어절 가운데서 꺾인 줄 끝(\"업무⏎수행에\")에는 공백 글리프가 없다", () => {
    // 행정업무운영 편람 실측 흐름: "원활한␣" ¦ "업무" ¦ "수행에" (pdfjs 아이템 글에는 줄 끝 공백이 없다)
    const items = [at("원활한", 60), at("업무", 40), at("수행에", 20)]
    markTrailingSpaceGlyphs(items, [OPS.setFont, OPS.showText, OPS.showText, OPS.showText], [["F1", 11], [glyphs("원활한 ")], [glyphs("업무")], [glyphs("수행에")]])
    assert.deepEqual(flag(items), [true, false, false])
  })
  it("다른 글꼴로 찍힌 공백 글리프도 본다", () => {
    const items = [at("권리와", 40), at("동일한", 20)]
    markTrailingSpaceGlyphs(items, [OPS.setFont, OPS.showText, OPS.setFont, OPS.showText, OPS.setFont, OPS.showText],
      [["F1", 11], [glyphs("권리와")], ["F2", 11], [glyphs(" ")], ["F1", 11], [glyphs("동일한")]])
    assert.deepEqual(flag(items), [true, false])
  })
  it("같은 줄에서 이어지는 아이템 앞 공백은 줄 끝이 아니다", () => {
    const items = [at("국외", 40), at("이전", 40)]
    markTrailingSpaceGlyphs(items, [OPS.setFont, OPS.showText], [["F1", 11], [glyphs("국외 이전")]])
    assert.deepEqual(flag(items), [false, false])
  })
  it("흐름이 아이템 글과 어긋나면 그 뒤는 손대지 않는다", () => {
    const items = [at("가", 40), at("나", 20)]
    markTrailingSpaceGlyphs(items, [OPS.setFont, OPS.showText], [["F1", 11], [glyphs("다 라")]])
    assert.deepEqual(flag(items), [false, false])
  })
})

describe("markTrailingSpaceGlyphs — 줄 끝 공백을 찍는 쪽이면 공백 없음(false)도 단다", () => {
  const at = (str: string, y: number): PdfTextItem => ({ str, transform: [11, 0, 0, 11, 100, y], width: 30, height: 11, fontName: "F1" })
  const lines = ["가나다", "라마바", "사아자", "차카타", "파하가"]
  it("줄 끝 다섯 곳 가운데 둘에 공백 글리프가 있으면 나머지는 false", () => {
    const items = lines.map((s, k) => at(s, 100 - k * 15))
    const flow = ["가나다 ", "라마바", "사아자 ", "차카타", "파하가"]
    markTrailingSpaceGlyphs(items, [OPS.setFont, ...flow.map(() => OPS.showText)], [["F1", 11], ...flow.map(s => [glyphs(s)])])
    assert.deepEqual(items.map(i => (i as { spaceAfter?: boolean }).spaceAfter), [true, false, true, false, false])
  })
  it("줄 끝 공백 글리프를 찍지 않는 쪽은 false 를 달지 않는다 (공백 없음이 정보가 아님)", () => {
    const items = lines.map((s, k) => at(s, 100 - k * 15))
    markTrailingSpaceGlyphs(items, [OPS.setFont, ...lines.map(() => OPS.showText)], [["F1", 11], ...lines.map(s => [glyphs(s)])])
    assert.deepEqual(items.map(i => (i as { spaceAfter?: boolean }).spaceAfter), [undefined, undefined, undefined, undefined, undefined])
  })
})

describe("softHyphenHeads", () => {
  const at = (str: string, y: number): PdfTextItem => ({ str, transform: [11, 0, 0, 11, 100, y], width: 100, height: 11, fontName: "F1" })
  const run = (s: string) => [...s].map(unicode => ({ unicode, width: unicode === " " ? 250 : 900 }))
  it("증감 칸·글머리의 보이는 U+00AD 를 붙임표로 되살린다", () => {
    const items = [at("670,069", 40), at("7,445", 40), at("분석", 60), at("42개 기관", 40), at("3D 프린터", 20)]
    softHyphenHeads(items, [OPS.showText], [[run("670,069\u00ad7,445분석\u00ad 42개 기관\u00ad3D 프린터")]])()
    assert.deepEqual(items.map(i => i.str), ["670,069", "-7,445", "분석", "- 42개 기관", "- 3D 프린터"])
  })
  it("앞 줄 끝 라틴 글자에 붙은 낱말 꺾임 표시는 둔다", () => {
    const items = [at("infor", 60), at("mation is", 40)]
    softHyphenHeads(items, [OPS.showText], [[run("infor\u00admation is")]])()
    assert.deepEqual(items.map(i => i.str), ["infor", "mation is"])
  })
})
