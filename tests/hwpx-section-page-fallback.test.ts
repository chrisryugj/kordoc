import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import type { IRBlock } from "../src/types.js"

const para = (text: string, y?: number, content = "") => `<hp:p paraPrIDRef="0">${y === undefined ? "" : `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${y}" horzpos="0" vertsize="1000" horzsize="42520"/></hp:linesegarray>`}<hp:run charPrIDRef="0"><hp:t>${text}</hp:t>${content}</hp:run></hp:p>`
const table = (content: string) => `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:subList>${content}</hp:subList></hp:tc></hp:tr></hp:tbl>`
const nested = table(para("outer cell", undefined, table(para("inner cell", undefined, table(para("leaf"))))))
const laidOut = para("first", 0) + para("second", 3000) + para("", 0, nested)

async function document(sections: string[]): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  sections.forEach((body, i) => zip.file(`Contents/section${i}.xml`, `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">${body}</hs:sec>`))
  return zip.generateAsync({ type: "arraybuffer" })
}

function descendants(block: IRBlock): IRBlock[] {
  return [block, ...(block.children ?? []).flatMap(descendants), ...(block.table?.captionBlocks ?? []).flatMap(descendants), ...(block.table?.cells ?? []).flatMap(row => row.flatMap(cell => (cell.blocks ?? []).flatMap(descendants)))]
}

function assertTreePage(block: IRBlock, page: number) {
  const tree = descendants(block)
  assert.ok(tree.length >= 3, "fixture must preserve nested table blocks")
  for (const child of tree) assert.equal(child.pageNumber, page)
}

describe("HWPX section fallback reconciles nested page numbers", () => {
  it("resets deeply nested layout pages in a single section", async () => {
    const result = await parseHwpxDocument(await document([laidOut + para("no layout")]))
    assert.equal(result.metadata?.pageMode, "section")
    assert.equal(result.metadata?.pageCount, 1)
    const host = result.blocks!.find(b => b.type === "table")!
    assertTreePage(host, 1)
    assert.match(result.markdown, /leaf/)
  })

  it("uses each owning section after a later section forces fallback", async () => {
    const input = await document([laidOut, laidOut + para("no layout")])
    const result = await parseHwpxDocument(input)
    assert.equal(result.metadata?.pageMode, "section")
    assert.equal(result.metadata?.pageCount, 2)
    const hosts = result.blocks!.filter(b => b.type === "table")
    assert.equal(hosts.length, 2)
    hosts.forEach((host, i) => assertTreePage(host, i + 1))
    const filtered = await parseHwpxDocument(input, { pages: "2" })
    assert.deepEqual(filtered.blocks, result.blocks!.filter(b => b.pageNumber === 2))
  })

  it("preserves actual layout pages when fallback is unnecessary", async () => {
    const result = await parseHwpxDocument(await document([laidOut]))
    assert.equal(result.metadata?.pageMode, "layout")
    assert.equal(result.metadata?.pageCount, 2)
    assertTreePage(result.blocks!.find(b => b.type === "table")!, 2)
  })
})
