/** 자간 벌린 글 — 글리프 흐름의 진짜 공백으로 낱말 경계 (ODL 103) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { restoreTrackedSpacing, markSyntheticSpaces, markTrailingSpaceGlyphs } from "../src/pdf/tracked-text.js"
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
