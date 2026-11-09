import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractLines, preprocessLines } from "../src/pdf/line-extract.js"
import { markUnderlineItems } from "../src/pdf/underline.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"

const items = (): NormItem[] => [74, 85.5].map(y => ({
  text: "A URL line with a white background", x: 118, y, w: 149, h: 10,
  fontSize: 10, fontName: "F", isHidden: false,
}))
function operators(color: number[], ink = false, thin = false) {
  const fnArray: number[] = [OPS.setFillRGBColor, OPS.constructPath, OPS.eoFill]
  const argsArray: unknown[][] = [color, [[OPS.rectangle], [117.5, 71.88, 149.06, thin ? 0.8 : 11.52]], []]
  if (ink) {
    fnArray.push(OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.constructPath, OPS.stroke)
    argsArray.push([0, 0, 180], [0.8], [[OPS.moveTo, OPS.lineTo], [118, 71.88, 267, 71.88]], [])
  }
  return { fnArray, argsArray }
}

describe("filled backgrounds are not text underlines", () => {
  it("rejects white and colored area-fill outlines using their extracted role", () => {
    for (const color of [[255, 255, 255], [220, 220, 240]]) {
      const op = operators(color), raw = extractLines(op.fnArray, op.argsArray)
      const h = preprocessLines(raw.horizontals, raw.verticals, raw.nonRules)
      const text = items()
      assert.deepEqual(markUnderlineItems(text, h.horizontals, h.verticals, raw.nonRules), [])
      assert.ok(text.every(i => !i.underline))
      assert.equal(raw.fillRects.length, 1)
    }
  })
  it("preserves visible strokes merged with a white background edge", () => {
    const op = operators([255, 255, 255], true), raw = extractLines(op.fnArray, op.argsArray)
    const h = preprocessLines(raw.horizontals, raw.verticals, raw.nonRules)
    const text = items()
    assert.equal(markUnderlineItems(text, h.horizontals, h.verticals, raw.nonRules).length, 1)
    assert.equal(text[0].underline, true)
    assert.ok(!text[1].underline)
  })
  it("keeps real thin colored filled underline strips", () => {
    const op = operators([0, 0, 180], false, true), raw = extractLines(op.fnArray, op.argsArray)
    const h = preprocessLines(raw.horizontals, raw.verticals, raw.nonRules)
    const text = items()
    assert.equal(markUnderlineItems(text, h.horizontals, h.verticals, raw.nonRules).length, 1)
    assert.equal(text[0].underline, true)
  })
  it("does not emit underline tags for a filled text background in the page pipeline", () => {
    const blocks = extractPageBlocksWithLines(items(), 1, operators([255, 255, 255]), 595, 842)
    assert.ok(!JSON.stringify(blocks).includes("<u>"))
    assert.ok(JSON.stringify(blocks).includes("A URL line"))
  })
})

describe("white row backgrounds wider than the visible rule", () => {
  // 흰 행 배경(x40~560) 아래 변에 보이는 괘선이 일부(x80~300)만 겹친 예산서 표
  function table(ruleX: [number, number], cols: number[]) {
    const fnArray: number[] = [OPS.setFillRGBColor, OPS.constructPath, OPS.fill, OPS.setStrokeRGBColor, OPS.setLineWidth, OPS.constructPath, OPS.stroke]
    const ops: number[] = [OPS.moveTo, OPS.lineTo], pts: number[] = [ruleX[0], 500, ruleX[1], 500]
    for (const x of cols) { ops.push(OPS.moveTo, OPS.lineTo); pts.push(x, 450, x, 560) }
    const argsArray: unknown[][] = [[255, 255, 255], [[OPS.rectangle], [cols[0], 500, cols[cols.length - 1] - cols[0], 17]], [], [0, 0, 0], [0.5], [ops, pts], []]
    return { fnArray, argsArray }
  }
  const rulesAt = (y: number, hs: { x1: number; x2: number; y1: number }[]) => hs.filter(l => Math.abs(l.y1 - y) < 3).map(l => [Math.round(l.x1), Math.round(l.x2)])

  it("keeps only the visible span when the background crosses visible column rules beyond it", () => {
    const op = table([80, 300], [40, 80, 300, 400, 500, 560]), raw = extractLines(op.fnArray, op.argsArray)
    const y = raw.horizontals.find(l => Math.round(l.x1) === 80)!.y1
    const { horizontals } = preprocessLines(raw.horizontals, raw.verticals, raw.nonRules)
    assert.deepEqual(rulesAt(y, horizontals), [[80, 300]])
    // 보이는 획과 합쳐지지 않은 맞은편 배경 변도 괘선이 아니다
    assert.equal(horizontals.filter(l => !raw.nonRules.has(l) && Math.abs(l.y1 - y) > 3).length, 0)
  })
  it("still merges an underline inside one cell with the background edge", () => {
    const op = table([260, 530], [74, 532]), raw = extractLines(op.fnArray, op.argsArray)
    const y = raw.horizontals.find(l => Math.round(l.x1) === 260)!.y1
    const { horizontals } = preprocessLines(raw.horizontals, raw.verticals, raw.nonRules)
    assert.deepEqual(rulesAt(y, horizontals), [[74, 532]])
  })
})
