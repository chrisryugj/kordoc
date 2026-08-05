import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { applyLinkAnnotations, type PdfAnnotation } from "../src/pdf/links.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y: number, w: number, h = 12): NormItem =>
  ({ text, x, y, w, h, fontSize: h, fontName: "Test", isHidden: false })

const link = (url: string, x1: number, y1: number, x2: number, y2: number): PdfAnnotation =>
  ({ subtype: "Link", url, rect: [x1, y1, x2, y2] })

describe("applyLinkAnnotations — 기본 래핑", () => {
  it("rect 안의 run을 [text](url)로 감싼다", () => {
    const items = [item("누리집", 100, 700, 40)]
    applyLinkAnnotations(items, [link("https://www.korea.kr", 98, 698, 142, 714)])
    assert.equal(items[0].text, "[누리집](https://www.korea.kr)")
  })

  it("여러 아이템 run은 첫/끝만 마킹", () => {
    const items = [item("정부", 100, 700, 24), item("누리집", 126, 700, 36)]
    applyLinkAnnotations(items, [link("https://a.kr", 98, 698, 164, 714)])
    assert.equal(items[0].text, "[정부")
    assert.equal(items[1].text, "누리집](https://a.kr)")
  })

  it("두 줄에 걸친 링크는 줄마다 같은 url로 래핑", () => {
    const items = [item("첫줄", 100, 700, 30), item("둘째줄", 100, 684, 40)]
    applyLinkAnnotations(items, [link("https://a.kr", 98, 682, 142, 714)])
    assert.equal(items[0].text, "[첫줄](https://a.kr)")
    assert.equal(items[1].text, "[둘째줄](https://a.kr)")
  })

  it("rect 밖(수평 겹침 50% 미만) 아이템은 건드리지 않는다", () => {
    const items = [item("링크밖", 300, 700, 60)]
    applyLinkAnnotations(items, [link("https://a.kr", 98, 698, 320, 714)])
    assert.equal(items[0].text, "링크밖")
  })

  it("rect 안에 텍스트 없는 어노테이션은 무시", () => {
    const items = [item("본문", 100, 500, 30)]
    applyLinkAnnotations(items, [link("https://a.kr", 400, 698, 500, 714)])
    assert.equal(items[0].text, "본문")
  })
})

describe("applyLinkAnnotations — 살균·방어", () => {
  it("javascript: 스킴은 차단", () => {
    const items = [item("클릭", 100, 700, 30)]
    applyLinkAnnotations(items, [link("javascript:alert(1)", 98, 698, 132, 714)])
    assert.equal(items[0].text, "클릭")
  })

  it("url의 괄호는 percent-encoding (마크다운 링크 조기 종료 방지)", () => {
    const items = [item("문서", 100, 700, 30)]
    applyLinkAnnotations(items, [link("https://a.kr/x(1)", 98, 698, 132, 714)])
    assert.equal(items[0].text, "[문서](https://a.kr/x%281%29)")
  })

  it("겹치는 어노테이션의 이중 래핑 방지", () => {
    const items = [item("중복", 100, 700, 30)]
    applyLinkAnnotations(items, [
      link("https://a.kr", 98, 698, 132, 714),
      link("https://b.kr", 98, 698, 132, 714),
    ])
    assert.equal(items[0].text, "[중복](https://a.kr)")
  })

  it("Link 아닌 subtype·url 없는 어노테이션은 무시", () => {
    const items = [item("본문", 100, 700, 30)]
    applyLinkAnnotations(items, [
      { subtype: "Widget", url: "https://a.kr", rect: [98, 698, 132, 714] },
      { subtype: "Link", rect: [98, 698, 132, 714] },
    ])
    assert.equal(items[0].text, "본문")
  })
})
