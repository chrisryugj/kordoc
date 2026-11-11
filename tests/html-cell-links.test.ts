/** htmlCellLinks 옵션 — HTML 표 셀의 [텍스트](URL)·URL 을 <a href> 로 (기본 꺼짐) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blocksToMarkdown, escapeHtmlCellText } from "../src/table/builder.js"
import { htmlCellLinks } from "../src/html-cell-links.js"
import { htmlCellInnerToLines } from "../src/roundtrip/markdown-units.js"
import { renderHtml } from "../src/print/renderer.js"
import { markdownToHwpx, parse } from "../src/index.js"
import { toParseOptions } from "../src/cli/parse-worker-v2.js"
import type { IRBlock } from "../src/types.js"

const URL_ = "https://m.site.kr/~user/_next_/v?id=1|2&x=*y*"
const row = (cell: string) => `<table>\n<tr><th colspan="2">병합</th></tr>\n<tr><td>칸</td><td>${cell}</td></tr>\n</table>`

describe("htmlCellLinks", () => {
  it("HTML 표 셀의 [텍스트](URL)·URL·www. 은 <a href>, 링크가 아닌 주소·위험 스킴·꺾쇠 안 주소는 텍스트", () => {
    const t = `[링크](https://a.kr/~in) 와 ${URL_}. (www.a.kr) https://a_b.kr/~x [x](javascript:alert(1)) <출처: https://a.kr/y>`
    const out = htmlCellLinks(row(escapeHtmlCellText(t)))
    assert.ok(out.includes(`<a href="https://a.kr/~in">링크</a> 와 <a href="https://m.site.kr/~user/_next_/v?id=1|2&amp;x=*y">https://m.site.kr/~user/_next_/v?id=1|2&amp;x=*y</a>*. (<a href="http://www.a.kr">www.a.kr</a>) https://a_b.kr/~x [x](javascript:alert(1)) &lt;출처: https://a.kr/y&gt;`), out)
    // 라운드트립이 읽는 셀 텍스트는 원래 셀 텍스트
    const cell = out.match(/<td>칸<\/td><td>([\s\S]*)<\/td><\/tr>/)![1]
    assert.deepEqual(htmlCellInnerToLines(cell).lines, [t])
    // 원문 링크 텍스트가 URL 끝 문자로 끝나면(GFM 이 링크 밖으로 빼는 ")") URL 이 아니라 원래 [텍스트](URL) 이다
    assert.deepEqual(htmlCellInnerToLines(`<a href="http://www.iris.go.kr%29">www.iris.go.kr)</a>`).lines, ["[www.iris.go.kr)](http://www.iris.go.kr%29)"])
  })

  it("가장 안쪽 [텍스트](URL) 만 링크 — 바깥 [ 는 텍스트 (CommonMark 와 같다)", () => {
    const t = "온라인접수 [LH청약플러스 홈페이지([https://a.kr](https://a.kr/)) 또는 앱]"
    assert.ok(htmlCellLinks(row(escapeHtmlCellText(t))).includes(`온라인접수 [LH청약플러스 홈페이지(<a href="https://a.kr/">https://a.kr</a>) 또는 앱]`))
  })

  it("HTML 표 밖(본문·GFM 표·이스케이프된 \\<table> 글)은 그대로", () => {
    const md = `본문 https://a.kr/x\n\n| a | b |\n| --- | --- |\n| [t](https://a.kr/y) | https://a.kr/z |\n\n\\<table> https://a.kr/w`
    assert.equal(htmlCellLinks(md), md)
  })

  it("QR 값 URL 도 HTML 셀에서 <a href>", () => {
    const image: IRBlock = { type: "image", text: "image_001.png", qr: ["https://example.com/kordoc"] }
    const table: IRBlock = { type: "table", table: { rows: 2, cols: 2, hasHeader: false, cells: [
      [{ text: "병합", colSpan: 2, rowSpan: 1 }, { text: "", colSpan: 0, rowSpan: 0 }],
      [{ text: "칸", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1, blocks: [image] }],
    ] } }
    assert.ok(htmlCellLinks(blocksToMarkdown([table])).includes(`<img src="image_001.png" alt="image"><br><a href="https://example.com/kordoc">https://example.com/kordoc</a>`))
  })

  it("parse() 는 켰을 때만 — 마크다운→HWPX 는 셀 링크를 하이퍼링크로, 나머지 셀 텍스트는 서식 없이", async () => {
    const md = row(escapeHtmlCellText("신청 [안내](https://a.kr/x) *별표* 그대로"))
    const hwpx = new Uint8Array(await markdownToHwpx(htmlCellLinks(md)))
    assert.ok((await parse(hwpx, { htmlCellLinks: true })).markdown.includes(`신청 <a href="https://a.kr/x">안내</a> *별표* 그대로`))
    assert.ok(!(await parse(hwpx)).markdown.includes("<a href"))
    assert.deepEqual(toParseOptions({ htmlCellLinks: true }, "/x"), { filePath: "/x", htmlCellLinks: true })
  })

  it("인쇄 렌더러는 kordoc 이 낸 안전 스킴 <a href> 만 태그로 둔다", () => {
    const html = renderHtml(htmlCellLinks(row(escapeHtmlCellText("[링크](https://a.kr/in)"))) + "\n\n<a href=\"javascript:alert(1)\">x</a>")
    assert.ok(html.includes(`<a href="https://a.kr/in">링크</a>`), html)
    assert.ok(!html.includes(`<a href="javascript:`), html)
  })
})
