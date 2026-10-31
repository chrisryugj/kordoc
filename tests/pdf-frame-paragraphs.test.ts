import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { splitSingleCellTables } from "../src/pdf/text-clean.js"
import { buildFrameCellBlocks } from "../src/pdf/frame-cell-blocks.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { IRBlock } from "../src/types.js"

const item = (text: string, y: number, w = 300, x = 60, fontSize = 10): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "F", isHidden: false })
const rect = (x: number, y: number, w: number, h: number, clip = false) => ({
  fn: clip ? [OPS.constructPath, OPS.eoClip, OPS.endPath] : [OPS.constructPath, OPS.stroke],
  args: clip ? [[[OPS.rectangle], [x, y, w, h]], [], []] : [[[OPS.rectangle], [x, y, w, h]], []],
})
function frame(items: NormItem[]) {
  const ops = [rect(50, 400, 330, 320, true), rect(50, 400, 330, 320)]
  return extractPageBlocksWithLines(items, 3, { fnArray: ops.flatMap(o => o.fn), argsArray: ops.flatMap(o => o.args) }, 595, 842)
}

describe("PDF frame paragraph IR", () => {
  for (const count of [2, 3]) it(`${count} visual lines become one paragraph with the real union bbox`, () => {
    const source = [item("상자 안 문장은 다음 줄에서", 690), item("계속되는 긴 본문을 유지하며", 674), item("마지막 문장으로 이어진다.", 658, 180)].slice(0, count)
    const built = buildFrameCellBlocks(source, [], 3)
    assert.ok(built.blocks.length, "raw IR stores source paragraphs before Markdown rendering")
    const raw: IRBlock = { type: "table", table: { rows: 1, cols: 1, hasHeader: false,
      cells: [[{ text: source.map(i => i.text).join("\n"), rowSpan: 1, colSpan: 1, blocks: built.blocks }]] } }
    const out = splitSingleCellTables([raw])
    assert.equal(out.length, 1)
    assert.equal(out[0].type, "paragraph")
    assert.equal(out[0].text, source.map(i => i.text).join(" "))
    assert.deepEqual(out[0].bbox, { page: 3, x: 60, y: source.at(-1)!.y, width: 300, height: 700 - source.at(-1)!.y })
    assert.ok(blocksToMarkdown(out).includes(source.map(i => i.text).join(" ")))
    assert.equal(raw.type, "table", "raw table remains available for keep layout")
    assert.deepEqual(splitSingleCellTables(frame(source)).map(b => b.text), out.map(b => b.text), "line-grid demotion also retains paragraph IR")
  })

  it("keeps clauses, list items and an oath title apart while joining their wrapped body", () => {
    const raw = frame([item("선 서", 700, 40, 180, 14), item("① 첫째 항목은 여러 줄에 걸쳐", 650),
      item("온전한 문장으로 계속된다.", 634, 200), item("② 둘째 항목은 따로 남는다.", 602, 200),
      item("제27조(의료인)", 560, 120)])
    const out = splitSingleCellTables(raw)
    assert.deepEqual(out.map(b => b.text), ["선 서", "① 첫째 항목은 여러 줄에 걸쳐 온전한 문장으로 계속된다.", "② 둘째 항목은 따로 남는다.", "제27조(의료인)"])
    assert.ok(out.every(b => b.bbox && b.bbox.height < 60))
  })

  it("unwraps paragraph/table/paragraph blocks in source order without duplicating flattened cell text", () => {
    const before: IRBlock = { type: "paragraph", text: "앞 문단", pageNumber: 2, bbox: { page: 2, x: 60, y: 500, width: 80, height: 10 } }
    const nested: IRBlock = { type: "table", table: { rows: 1, cols: 2, hasHeader: false, cells: [[{ text: "안쪽", rowSpan: 1, colSpan: 1 }, { text: "표", rowSpan: 1, colSpan: 1 }]] } }
    const after: IRBlock = { ...before, text: "뒤 문단", bbox: { ...before.bbox!, y: 400 } }
    const box: IRBlock = { type: "table", table: { rows: 1, cols: 1, hasHeader: false, caption: "표 설명", cells: [[{ text: "앞 문단\n안쪽\n표\n뒤 문단", rowSpan: 1, colSpan: 1, blocks: [before, nested, after] }]] } }
    const out = splitSingleCellTables([box])
    assert.deepEqual(out.map(b => b.type === "table" ? "table" : b.text), ["표 설명", "앞 문단", "table", "뒤 문단"])
    assert.equal(out[1], before)
    assert.equal(out[2], nested)
    assert.equal(out[3], after)
    assert.equal(blocksToMarkdown(out).match(/앞 문단/g)?.length, 1)
  })

  it("builds paragraphs around an actual nested table from raw items with independent bboxes", () => {
    const nested: IRBlock = { type: "table", pageNumber: 3,
      bbox: { page: 3, x: 60, y: 580, width: 300, height: 40 },
      table: { rows: 1, cols: 2, hasHeader: false, cells: [[{ text: "안쪽", rowSpan: 1, colSpan: 1 }, { text: "표", rowSpan: 1, colSpan: 1 }]] } }
    const built = buildFrameCellBlocks([item("앞 문단은 다음 줄에", 690), item("온전히 이어진다.", 674, 140),
      item("뒤 문단도 이어지는", 550), item("마지막 줄이 남는다.", 534, 150)], [nested], 3)
    assert.deepEqual(built.blocks.map(b => b.type === "table" ? "table" : b.text), ["앞 문단은 다음 줄에 온전히 이어진다.", "table", "뒤 문단도 이어지는 마지막 줄이 남는다."])
    assert.equal(built.blocks[1], nested)
    assert.deepEqual(built.blocks[0].bbox, { page: 3, x: 60, y: 674, width: 300, height: 26 })
    assert.deepEqual(built.blocks[2].bbox, { page: 3, x: 60, y: 534, width: 300, height: 26 })
    assert.equal(built.text.match(/안쪽/g)?.length, 1)
  })

  it("retains the existing empty-box policy and legacy text-only line boundaries", () => {
    const box = (text: string): IRBlock => ({ type: "table", table: { rows: 1, cols: 1, hasHeader: false, cells: [[{ text, rowSpan: 1, colSpan: 1 }]] } })
    const empty = box("")
    assert.deepEqual(splitSingleCellTables([empty]), [])
    assert.deepEqual(splitSingleCellTables([box("선 서\n나는 헌법을 준수한다.")]).map(b => b.text), ["선 서", "나는 헌법을 준수한다."])
  })
})

describe("buildFrameCellBlocks — 나란한 안쪽 표", () => {
  const table = (text: string, x: number, y: number, width: number, height: number): IRBlock => ({
    type: "table", pageNumber: 1, bbox: { page: 1, x, y, width, height },
    table: { rows: 1, cols: 1, cells: [[{ text, colSpan: 1, rowSpan: 1 }]] },
  })
  const names = (blocks: IRBlock[]) => blocks.map(b => b.table!.cells[0][0].text)

  it("윗변이 조금 높은 오른쪽 결재 칸보다 왼쪽 문서번호 표를 먼저 둔다", () => {
    // 결재문서 머리 — 문서번호 표 54~223 × 647~725, 결재 칸 280~505 × 640~765
    const built = buildFrameCellBlocks([], [table("결재", 280, 640, 225, 125), table("문서번호", 54, 647, 169, 78)], 1)
    assert.deepEqual(names(built.blocks), ["문서번호", "결재"])
  })

  it("세로로 거의 안 겹치는 표는 위→아래 그대로", () => {
    const built = buildFrameCellBlocks([], [table("위 오른쪽", 280, 700, 225, 60), table("아래 왼쪽", 54, 600, 169, 70)], 1)
    assert.deepEqual(names(built.blocks), ["위 오른쪽", "아래 왼쪽"])
  })
})
