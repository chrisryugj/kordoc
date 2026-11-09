import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { DOMParser } from "../src/xml/dom.js"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import { parseHtmlTable, replicateTableToHtml } from "../src/roundtrip/markdown-units.js"
import type { IRTable } from "../src/types.js"

async function fixture(kind: "footNote" | "endNote", merged = false): Promise<ArrayBuffer> {
  const zip = await JSZip.loadAsync(await markdownToHwpx("| HOST | OTHER |\n| --- | --- |\n| LEFT | RIGHT |"))
  const noteZip = await JSZip.loadAsync(await markdownToHwpx("| A | B |\n| --- | --- |\n| C | D |"))
  const xml = await zip.file("Contents/section0.xml")!.async("string")
  const noteXml = await noteZip.file("Contents/section0.xml")!.async("string")
  const at = noteXml.indexOf("<hp:tbl"), start = noteXml.lastIndexOf("<hp:p ", at)
  const end = noteXml.indexOf("</hp:p>", noteXml.indexOf("</hp:tbl>", at)) + 7
  const note = '<hp:ctrl><hp:' + kind + ' number="1" instId="100"><hp:subList>' + noteXml.slice(start, end) + '</hp:subList></hp:' + kind + '></hp:ctrl>'
  let result = xml.replace("<hp:t>HOST</hp:t>", "<hp:t>HOST</hp:t>" + note)
  if (merged) {
    const dom = new DOMParser().parseFromString(result, "application/xml")
    const row = dom.getElementsByTagName("hp:tbl")[0].getElementsByTagName("hp:tr")[0]
    const cells = Array.from(row.childNodes).filter(n => n.nodeName === "hp:tc")
    const span = Array.from(cells[0].childNodes).find(n => n.nodeName === "hp:cellSpan") as typeof row
    span.setAttribute("colSpan", "2")
    row.removeChild(cells[1])
    result = String(dom)
  }
  zip.file("Contents/section0.xml", result)
  return zip.generateAsync({ type: "arraybuffer" })
}

const noteTable = (t: IRTable) => t.cells[0][0].blocks?.find(b => b.footnoteBlocks)?.footnoteBlocks?.find(b => b.table)?.table

describe("표 칸의 각주·미주 표 구조 (#149 후속)", () => {
  for (const kind of ["footNote", "endNote"] as const) for (const merged of [false, true]) {
    it(kind + (merged ? " 병합 칸" : " 일반 칸") + " 안의 표를 HTML 격자로 보존한다", async () => {
      const data = await fixture(kind, merged)
      for (const options of [{}, { layoutTables: "keep" as const }]) {
        const r = await parseHwpx(data, options)
        assert.ok(r.success)
        const outer = r.blocks.find(b => b.table)!.table!
        assert.equal(noteTable(outer)?.rows, 2)
        assert.match(r.markdown, /HOST1\) \(주: <table>/)
        assert.match(r.markdown, /<th>A<\/th><th>B<\/th>/)
        assert.match(r.markdown, /<td>C<\/td><td>D<\/td>/)
        assert.equal(r.markdown.trim(), replicateTableToHtml(outer))
        const rows = parseHtmlTable(r.markdown)!
        assert.equal(rows.length, 2)
        assert.equal(rows[0].cells.length, merged ? 1 : 2)
        assert.equal(rows[0].cells[0].colSpan, merged ? 2 : 1)
      }
    })
  }

  it("각주 호스트와 옆 칸의 입력 안내문을 제외한 HTML을 동일하게 재현한다", () => {
    const inner: IRTable = { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "각주 칸", colSpan: 1, rowSpan: 1 }]] }
    const paragraph = { type: "paragraph" as const, text: "안내본문", spans: [{ text: "안내", placeholder: true }, { text: "본문" }] }
    const outer: IRTable = { rows: 1, cols: 3, hasHeader: false, cells: [[
      { text: "안내본문", colSpan: 1, rowSpan: 1, blocks: [{ ...paragraph, footnoteText: "각주 칸", footnoteBlocks: [{ type: "table", table: inner }] }] },
      { text: "안내본문", colSpan: 1, rowSpan: 1, blocks: [paragraph] },
      { text: "", colSpan: 1, rowSpan: 1, blocks: [{ type: "paragraph", text: "", footnoteText: "단독 주석" }] },
    ]] }
    const md = blocksToMarkdown([{ type: "table", table: outer }])
    assert.doesNotMatch(md, /안내/)
    assert.match(md, /주: 단독 주석/)
    assert.equal(md.trim(), replicateTableToHtml(outer))
  })

  it("명시적 GFM 옵션은 HTML 없이 기존 평탄화 글과 IR 구조를 유지한다", async () => {
    const r = await parseHwpx(await fixture("footNote"), { tableFormat: "gfm" })
    assert.ok(r.success)
    assert.doesNotMatch(r.markdown, /<table>/)
    assert.match(r.markdown, /A \/ B<br>C \/ D/)
    assert.equal(noteTable(r.blocks.find(b => b.table)!.table!)?.rows, 2)
  })

  it("다른 칸을 수정해도 각주 XML은 그대로이고 표 좌표 재현이 일치한다", async () => {
    const data = await fixture("footNote")
    const original = await parseHwpx(data, { layoutTables: "keep" })
    assert.ok(original.success)
    const patched = await patchHwpx(new Uint8Array(data), original.markdown.replace("RIGHT", "CHANGED"))
    assert.ok(patched.success, patched.error)
    assert.equal(patched.applied, 1, JSON.stringify(patched.skipped))
    assert.deepEqual(patched.skipped, [])
    const xml = async (v: ArrayBuffer | Uint8Array) => (await JSZip.loadAsync(v)).file("Contents/section0.xml")!.async("string")
    const note = (s: string) => s.match(/<hp:footNote\b[\s\S]*?<\/hp:footNote>/)?.[0]
    assert.equal(note(await xml(patched.data!)), note(await xml(data)))
    const r = await parseHwpx(patched.data!.buffer.slice(patched.data!.byteOffset, patched.data!.byteOffset + patched.data!.byteLength) as ArrayBuffer)
    assert.ok(r.success && r.markdown.includes("CHANGED"))
    assert.match(r.markdown, /HOST1\) \(주: <table>/)
  })

  it("각주 표 편집은 건너뛰고 다른 칸 편집만 적용한다", async () => {
    const data = await fixture("endNote")
    const original = await parseHwpx(data, { layoutTables: "keep" })
    assert.ok(original.success)
    const edited = original.markdown.replace("<td>D</td>", "<td>NEW</td>").replace("RIGHT", "CHANGED")
    const patched = await patchHwpx(new Uint8Array(data), edited)
    assert.ok(patched.success, patched.error)
    assert.equal(patched.applied, 1, JSON.stringify(patched.skipped))
    assert.ok(patched.skipped.length > 0)
    const r = await parseHwpx(patched.data!.buffer.slice(patched.data!.byteOffset, patched.data!.byteOffset + patched.data!.byteLength) as ArrayBuffer)
    assert.ok(r.success)
    assert.match(r.markdown, /<td>D<\/td>/)
    assert.doesNotMatch(r.markdown, /NEW/)
    assert.match(r.markdown, /CHANGED/)
  })

  it("각주 안 일반 글의 HTML·파이프·마크다운 기호를 글자로 보존한다", () => {
    const inner: IRTable = { rows: 1, cols: 2, hasHeader: false, cells: [[{ text: "A & B", colSpan: 1, rowSpan: 1 }, { text: "<tag>", colSpan: 1, rowSpan: 1 }]] }
    const outer: IRTable = { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "본문", colSpan: 1, rowSpan: 1,
      blocks: [{ type: "paragraph", text: "본문", footnoteText: "평탄화", footnoteBlocks: [
        { type: "paragraph", text: "<script> * | &\n둘째 줄" }, { type: "table", table: inner },
      ] }],
    }]] }
    const md = blocksToMarkdown([{ type: "table", table: outer }])
    assert.match(md, /&lt;script&gt; \* \| &amp;<br>둘째 줄/)
    assert.match(md, /<th>A &amp; B<\/th><th>&lt;tag&gt;<\/th>/)
    assert.doesNotMatch(md, /<script>|\\\*|\\\|/)
    assert.equal(md.trim(), replicateTableToHtml(outer))
  })
})
