import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { semanticHtmlToMarkdown, withSemanticHtmlStyles, htmlToHwpx } from "../src/hwpx/semantic-html.js"
import { parse } from "../src/index.js"

describe("보고서 의미 HTML → HWPX", () => {
  const html = `<!doctype html><html lang="ko"><head><style>h1{color:red}</style></head><body>
    <main><h1>지원 사업 검토 보고</h1>
    <blockquote><p>지원 현황을 검토하고 개선 방향을 보고하고자 함</p></blockquote>
    <section><h2>추진 배경</h2><ul><li>신청 절차 간소화<ul><li>접수 창구 통합</li></ul></li></ul>
    <table><thead><tr><th>구분</th><th colspan="2">실적</th></tr></thead>
    <tbody><tr><td>시범</td><td>접수</td><td>완료</td></tr></tbody></table></section></main>
    </body></html>`

  it("제목·요약·목록 깊이·병합표를 문서 순서대로 보존한다", () => {
    const md = semanticHtmlToMarkdown(html)
    assert.match(md, /^# 지원 사업 검토 보고/m)
    assert.match(md, /^> 지원 현황을 검토하고 개선 방향을 보고하고자 함/m)
    assert.match(md, /^## 추진 배경/m)
    assert.match(md, /^- 신청 절차 간소화/m)
    assert.match(md, /^  - 접수 창구 통합/m)
    assert.match(md, /<th colspan="2">실적<\/th>/)
    assert.ok(md.indexOf("## 추진 배경") < md.indexOf("<table>"))
    assert.ok(!md.includes("color:red"))
  })

  it("보고서 HWPX 재파싱에도 제목·본문·병합표가 남는다", async () => {
    const warnings: string[] = []
    const result = await parse(await htmlToHwpx(html, { gongmun: { preset: "보고서" }, warnings }))
    assert.equal(result.success, true)
    assert.ok(!warnings.some(w => w.includes("요약박스")))
    if (!result.success) return
    assert.ok(result.markdown.includes("지원 사업 검토 보고"))
    assert.ok(result.markdown.includes("접수 창구 통합"))
    assert.ok(result.blocks.some(b => b.type === "table" && b.table?.cells.some(row => row.some(cell => cell.colSpan === 2))))
  })

  it("일반 HTML의 번호 목록과 인라인 div 문장을 분리하지 않는다", () => {
    const md = semanticHtmlToMarkdown('<div>검토 <strong>결과</strong></div><ol start="3"><li>첫 항목</li><li>둘째 항목</li></ol>')
    assert.match(md, /^검토 \*\*결과\*\*$/m)
    assert.match(md, /^3\. 첫 항목$/m)
    assert.match(md, /^4\. 둘째 항목$/m)
  })

  it("HTML 보고서의 글자 크기와 강조색을 HWPX 서식에 반영한다", async () => {
    const styled = `<style>
      p, li { font-size: 11pt; line-height: 1.7 }
      h1 { font-size: 24pt }
      h2 { font-size: 14pt; background: #003d75; color: white }
      blockquote { background: #edf4fa }
      table { font-size: 10pt }
      th { background: #dce9f4 }
    </style>${html}`
    const inferred = withSemanticHtmlStyles(styled, { preset: "보고서", bodyPt: 12 })
    assert.equal(inferred.bodyPt, 12) // 명시 옵션 우선
    assert.equal(inferred.reportTitlePt, 24)
    assert.equal(inferred.sizes?.chapter, 14)
    assert.equal(inferred.sizes?.table, 10)
    assert.equal(inferred.reportSummaryFill, "#EDF4FA")
    assert.equal(inferred.tableHeaderFill, "#DCE9F4")
    const zip = await JSZip.loadAsync(await htmlToHwpx(styled, { gongmun: { preset: "보고서" } }))
    const header = await zip.file("Contents/header.xml")!.async("string")
    for (const expected of ["#EDF4FA", "#DCE9F4", "#003D75", 'height="2400"', 'height="1000"']) {
      assert.ok(header.includes(expected), `${expected} HWPX 서식 누락`)
    }
  })
})
