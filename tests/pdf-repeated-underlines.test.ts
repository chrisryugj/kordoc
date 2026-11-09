import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { markUnderlineItems } from "../src/pdf/underline.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const item = (x: number, y: number, w: number): NormItem => ({ text: "개정된 문장이 계속됩니다", x, y, w, h: 10, fontSize: 10, fontName: "Test", isHidden: false })
const hline = (x1: number, x2: number, y: number): LineSegment => ({ x1, x2, y1: y, y2: y, lineWidth: 0.5 })
const vline = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, x2: x, y1, y2, lineWidth: 0.5 })

describe("repeated underlined paragraph outside a table", () => {
  it("each tightly owned line remains an underline despite repeated spans and degenerate end fragments", () => {
    const ys = [130, 117, 92, 79, 66]
    const items = ys.map(y => item(100, y + 1, 300))
    const rules = ys.map(y => hline(100, 400, y))
    const found = markUnderlineItems(items, rules, ys.map(y => vline(400, y, y)))
    assert.equal(found.length, 5)
    assert.ok(items.every(i => i.underline))
  })

  it("repeated underlines own separate text even without vertical fragments", () => {
    const items = [130, 117, 104].map(y => item(100, y + 1, 300))
    assert.equal(markUnderlineItems(items, [130, 117, 104].map(y => hline(100, 400, y)), []).length, 3)
  })

  it("keeps variable-width note underlines whose single run starts with an un-underlined marker", () => {
    const items = [item(80,164,184),item(97,153,205),item(97,140,314),item(108,128,303),item(108,115,138),item(97,102,314),item(108,89,297),item(97,76,308)]
    const lines = [hline(97,264,163),hline(97,302,152),hline(97,411,139),hline(108,411,127),hline(108,246,114),hline(108,411,101),hline(108,405,88),hline(97,405,75)]
    assert.equal(markUnderlineItems(items,lines,[]).length,8)
    assert.ok(items.every(i=>i.underline))
  })

  it("a line extending past the right of a marker run remains a form rule", () => {
    const items=[item(80,131,180),item(80,118,180),item(80,105,180)]
    assert.deepEqual(markUnderlineItems(items,[130,117,104].map(y=>hline(100,280,y)),[]),[])
  })

  it("real vertical cell boundaries continue to protect table rules", () => {
    const items = [130, 117, 104].map(y => item(100, y + 1, 300))
    assert.deepEqual(markUnderlineItems(items, [130, 117, 104].map(y => hline(100, 400, y)), [vline(100, 90, 145), vline(400, 90, 145)]), [])
  })

  it("one tight row does not turn the remaining padded form rules into underlines", () => {
    const items = [item(100, 131, 300), item(110, 118, 280), item(110, 105, 280)]
    assert.deepEqual(markUnderlineItems(items, [130, 117, 104].map(y => hline(100, 400, y)), []), [])
  })
})

it("removes paragraph underlines before open-edge synthesis can extend the preceding table", () => {
  const fnArray:number[]=[OPS.setLineWidth],argsArray:unknown[][]=[[.36]]
  const segs=[[80,200,410,200],[80,250,410,250],[80,300,410,300],[80,350,410,350],
    [80,200,80,350],[190,200,190,350],[300,200,300,350],[410,200,410,350],
    [100,186.5,410,186.5],[100,173.5,410,173.5],[100,160.5,410,160.5]]
  for(const seg of segs){fnArray.push(OPS.constructPath,OPS.stroke);argsArray.push([[OPS.moveTo,OPS.lineTo],seg],[])}
  const item=(text:string,x:number,y:number,w:number):NormItem=>({text,x,y,w,h:8,fontSize:8,fontName:"F",isHidden:false})
  const items=[item("Type",100,330,40),item("A",210,330,20),item("B",320,330,20),
    item("Fee",100,280,40),item("100",210,280,20),item("200",320,280,20),
    item("Wait",100,230,40),item("300",210,230,20),item("400",320,230,20),
    item("Note one is separate from the fee table.",100,188,310),item("Note two is a separate paragraph.",100,175,310),item("Note three remains outside the table.",100,162,310)]
  const blocks=extractPageBlocksWithLines(items,1,{fnArray,argsArray},595,842),table=blocks.find(b=>b.table)?.table
  assert.ok(table);assert.equal(table.rows,3);assert.ok(!table.cells.flat().some(c=>c.text.includes("Note")))
  for(const text of ["Note one","Note two","Note three"])assert.ok(blocks.some(b=>!b.table&&b.text?.includes(text)))
})
