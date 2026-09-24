/**
 * HTML 표(병합·중첩 — builder tableToHtml) 셀 글 이스케이프와 읽는 쪽 대칭 (v4.15.0).
 * v4.14.4 까지 셀 원문 `<script>`·`<img onerror>` 가 살아있는 태그로, "x<y"·"A & B" 가 태그·엔티티로 나갔다.
 * GFM 경로는 escapeGfm 이 막는다 — HTML 경로도 엔티티로 막고, 왕복·생성기·인쇄가 같은 글로 되읽는지 본다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import type { IRBlock, IRCell } from "../src/types.js"
import { blocksToMarkdown, escapeGfm } from "../src/table/builder.js"
import { sanitizeHref } from "../src/utils.js"
import MarkdownIt from "markdown-it"
import { parseHtmlTable, htmlCellInnerToLines, replicateTableToHtml } from "../src/roundtrip/markdown-units.js"
import { markdownToHwpx, parseHwpx, parseXlsx, patchHwpx } from "../src/index.js"
import { renderHtml } from "../src/print/renderer.js"

const cell = (text: string, extra: Partial<IRCell> = {}): IRCell => ({ text, colSpan: 1, rowSpan: 1, ...extra })

/** 병합 셀이 있어 HTML 경로를 타는 2×2 표 */
function mergedTable(a: string, b: string, c: string): IRBlock {
  return {
    type: "table",
    table: { rows: 2, cols: 2, hasHeader: true, cells: [[cell(a, { colSpan: 2 }), cell("")], [cell(b), cell(c)]] },
  }
}

describe("HTML 표 셀 글 이스케이프 — builder", () => {
  it("<script>·<img onerror>·& < > 는 엔티티로, 셀 줄바꿈 <br> 과 밑줄 마커 <u> 는 태그로", () => {
    const md = blocksToMarkdown([mergedTable("<script>alert(1)</script>", "a < b & c > d", "<img src=x onerror=bad>\n<u>밑줄</u>")])
    assert.ok(md.includes('<th colspan="2">&lt;script&gt;alert(1)&lt;/script&gt;</th>'), md)
    assert.ok(md.includes("<td>a &lt; b &amp; c &gt; d</td>"), md)
    assert.ok(md.includes("<td>&lt;img src=x onerror=bad&gt;<br><u>밑줄</u></td>"), md)
    assert.ok(!/<script|<img src=x/.test(md), "살아있는 태그 없음")
  })

  it("원문 글자 \"<br>\" 은 &lt;br&gt; — 셀 줄바꿈 태그와 갈린다", () => {
    const md = blocksToMarkdown([mergedTable("머리", "글자<br>그대로", "둘째\n줄")])
    assert.ok(md.includes("<td>글자&lt;br&gt;그대로</td>"), md)
    assert.ok(md.includes("<td>둘째<br>줄</td>"), md)
  })

  it("중첩표 셀·캡션·그림 src 속성도 이스케이프", () => {
    const nested: IRBlock = {
      type: "table",
      table: {
        rows: 1, cols: 1, hasHeader: false,
        cells: [[cell("wrap", { blocks: [
          { type: "table", table: { rows: 1, cols: 1, hasHeader: false, caption: "<캡션 & 설명>", cells: [[cell("<b onmouseover=x>")]] } },
          { type: "image", text: 'a"b.png' },
        ] })]],
      },
    }
    const md = blocksToMarkdown([nested])
    assert.ok(md.includes("&lt;캡션 &amp; 설명&gt;<br><table>"), md)
    assert.ok(md.includes("<th>&lt;b onmouseover=x&gt;</th>"), md) // 첫 행은 th
    assert.ok(md.includes('<img src="a&quot;b.png" alt="image">'), md)
  })

  it("XLSX 병합 셀 원문 <script> (리뷰 재현) — 마크다운에 살아있는 태그 없음", async () => {
    const zip = new JSZip()
    zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><si><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></si><si><t>A &amp; B</t></si></sst>`)
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>1</v></c></row></sheetData></worksheet>`)
    const r = await parseXlsx(await zip.generateAsync({ type: "arraybuffer" }))
    assert.ok(r.success)
    assert.ok(r.markdown.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), r.markdown)
    assert.ok(r.markdown.includes("<td>A &amp; B</td>"), r.markdown)
    assert.ok(!r.markdown.includes("<script>"))
  })

  it("인쇄 HTML(markdown-it html:true)에도 셀 글은 글로만 — 살아있는 onerror 없음", () => {
    const html = renderHtml(blocksToMarkdown([mergedTable("머리", "<img src=x onerror=alert(1)>", "b")]))
    assert.ok(!/<img[^>]*onerror/i.test(html), html)
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"))
  })
})

describe("마크다운 글·링크의 날 HTML (PDF 리뷰 r1 재현)", () => {
  const render = (md: string) => new MarkdownIt({ html: true }).render(md)
  const liveTags = (html: string) => [...html.matchAll(/<(script|img|b)\b[^>]*>/gi)].map(m => m[0])

  it("escapeGfm: 링크·그림 목적지 모양 스팬도 공백·<> 가 있으면 보호하지 않는다", () => {
    assert.equal(escapeGfm('Mask ](https://a <img src=x onerror="x">) end'), 'Mask ](https://a \\<img src=x onerror="x">) end')
    assert.equal(escapeGfm("span ![a](b <img src=x onerror=alert(6)>) end"), "span ![a](b \\<img src=x onerror=alert(6)>) end")
    // kordoc 이 내는 모양(공백·<> 없는 목적지)은 종전처럼 통째 보호 — _ 이스케이프로 URL·파일명이 깨지지 않는다
    assert.equal(escapeGfm("[보기](https://a.go.kr/x_y?q=1&r=2) ![image](image_001.png)"), "[보기](https://a.go.kr/x_y?q=1&r=2) ![image](image_001.png)")
  })

  it("sanitizeHref: 공백·<>\"'` 를 percent-encode (괄호는 종전처럼 %28/%29)", () => {
    assert.equal(sanitizeHref('mailto:a <img src=x onerror="alert`5`">'), "mailto:a%20%3Cimg%20src=x%20onerror=%22alert%605%60%22%3E")
    assert.equal(sanitizeHref("https://a.go.kr/p (1)/q's"), "https://a.go.kr/p%20%281%29/q%27s")
    assert.equal(sanitizeHref("https://a.go.kr/ok?x=1&y=2#f"), "https://a.go.kr/ok?x=1&y=2#f")
    assert.equal(sanitizeHref("javascript:alert(1)"), null)
  })

  it("문단 링크·본문 글이 렌더(markdown-it html:true)에서 살아있는 태그가 되지 않는다", () => {
    const md = blocksToMarkdown([
      { type: "paragraph", text: "링크", href: 'https://a <img src=x onerror="alert(1)">' },
      { type: "paragraph", text: "Mask hole ](https://a <img src=x onerror=alert(4)>) end" },
      { type: "paragraph", text: "Image span ![a](b <img src=x onerror=alert(6)>) end" },
    ])
    assert.deepEqual(liveTags(render(md)), [], md)
  })

  it("악의 없는 칸 글 <Table 18-4: 예> 가 <table> 태그가 되어 표를 깨지 않는다", () => {
    const md = blocksToMarkdown([mergedTable("머리", "<Table 18-4: 예>", "값")])
    assert.ok(md.includes("<td>&lt;Table 18-4: 예&gt;</td><td>값</td>"), md)
    const html = render(md)
    assert.equal((html.match(/<table>/g) ?? []).length, 1, html)
    assert.ok(html.includes("&lt;Table 18-4: 예&gt;"))
  })

  it("HWPX 그림 실패 자리 \"[이미지: …]\" 가 <img src> 속성에 들어가도 따옴표가 속성을 못 벗어난다", () => {
    const block: IRBlock = {
      type: "table",
      table: { rows: 1, cols: 1, hasHeader: false, cells: [[cell("x", { blocks: [
        { type: "paragraph", text: "설명" },
        { type: "image", text: '[이미지: x" onerror="alert(1)]' },
        { type: "table", table: { rows: 1, cols: 1, hasHeader: false, cells: [[cell("안")]] } },
      ] })]] },
    }
    const md = blocksToMarkdown([block])
    assert.ok(md.includes('<img src="[이미지: x&quot; onerror=&quot;alert(1)]" alt="image">'), md)
    assert.ok(!md.includes('" onerror="'), md)
  })
})

describe("HTML 표 셀 글 — 읽는 쪽 대칭 (왕복·생성기)", () => {
  it("parseHtmlTable + htmlCellInnerToLines 가 원문 글로 되돌린다 (원문 \"<br>\" 은 한 줄)", () => {
    const block = mergedTable("<머리> & 제목", "x<y", "글자<br>그대로\n둘째 줄")
    const md = blocksToMarkdown([block])
    assert.equal(replicateTableToHtml(block.table!), md, "좌표 재현은 builder 출력과 같다")
    const rows = parseHtmlTable(md)!
    assert.deepEqual(htmlCellInnerToLines(rows[0].cells[0].inner).lines, ["<머리> & 제목"])
    assert.deepEqual(htmlCellInnerToLines(rows[1].cells[0].inner).lines, ["x<y"])
    assert.deepEqual(htmlCellInnerToLines(rows[1].cells[1].inner).lines, ["글자<br>그대로", "둘째 줄"])
  })

  it("생성기: 엔티티 셀 → HWPX 셀 글은 원문 글자, 다시 파싱하면 같은 엔티티 마크다운", async () => {
    const md = blocksToMarkdown([mergedTable("<script>x</script>", "A & B", "&lt;br&gt; 글자")])
    const hwpx = await markdownToHwpx(md)
    const sec = await (await JSZip.loadAsync(hwpx)).file("Contents/section0.xml")!.async("text")
    assert.ok(sec.includes("<hp:t>&lt;script&gt;x&lt;/script&gt;</hp:t>"), "XML 안 글은 원문 <script> 한 벌")
    assert.ok(sec.includes("<hp:t>A &amp; B</hp:t>"))
    const r = await parseHwpx(hwpx)
    assert.ok(r.success)
    const cellTexts = (r.blocks.find(b => b.type === "table")!.table!.cells.flat()).map(c => c.text)
    assert.ok(cellTexts.includes("<script>x</script>") && cellTexts.includes("A & B") && cellTexts.includes("&lt;br&gt; 글자"), JSON.stringify(cellTexts))
    assert.equal(r.markdown, md, "재파싱 마크다운 = 원래 마크다운")
  })

  it("패치: 특수문자 셀이 있는 병합 표 — no-op 바이트 동일, 셀 수정은 원문 글로 기록", async () => {
    const hwpx = new Uint8Array(await markdownToHwpx(blocksToMarkdown([mergedTable("머리 <제목>", "A & B", "x<y")])))
    const parsed = await parseHwpx(hwpx.slice().buffer)
    assert.ok(parsed.success)
    const noop = await patchHwpx(hwpx, parsed.markdown)
    assert.equal(noop.success, true, noop.error)
    assert.deepEqual(Buffer.from(noop.data!), Buffer.from(hwpx))

    const edited = parsed.markdown.replace("<td>x&lt;y</td>", "<td>C &amp; D &lt;E&gt;</td>")
    assert.notEqual(edited, parsed.markdown)
    const r = await patchHwpx(hwpx, edited)
    assert.equal(r.success, true, r.error)
    assert.equal(r.applied, 1, JSON.stringify(r.skipped))
    const re = await parseHwpx(r.data!.slice().buffer)
    assert.ok(re.success)
    const texts = re.blocks.find(b => b.type === "table")!.table!.cells.flat().map(c => c.text)
    assert.ok(texts.includes("C & D <E>") && texts.includes("A & B") && texts.includes("머리 <제목>"), JSON.stringify(texts))
    assert.equal(r.verification?.stats.modified, 0, JSON.stringify(r.verification?.diffs))
  })
})
