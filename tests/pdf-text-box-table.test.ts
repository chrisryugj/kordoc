/**
 * 보이지 않는 글상자 틀 — 불투명도 0 채움은 괘선이 아니고, 같은 폭 틀 열이 행마다 윗변을 맞추면 표다 (ODL 199·200 슬라이드)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { extractLines } from "../src/pdf/line-extract.js"
import { detectTextBoxTables } from "../src/pdf/text-box-table.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { ClipRect } from "../src/pdf/line-extract.js"

describe("extractLines — 불투명도 0 채움", () => {
  const rectFill = (alpha?: number, restore = false) => {
    const fnArray: number[] = []
    const argsArray: unknown[][] = []
    if (restore) { fnArray.push(OPS.save); argsArray.push([]) }
    if (alpha !== undefined) { fnArray.push(OPS.setGState); argsArray.push([[["CA", alpha], ["ca", alpha]]]) }
    if (restore) { fnArray.push(OPS.restore); argsArray.push([]) }
    fnArray.push(OPS.constructPath, OPS.fill)
    argsArray.push([[OPS.rectangle], [100, 100, 200, 40]], [])
    return extractLines(fnArray, argsArray)
  }

  it("보이는 채움 사각형의 변은 선이다", () => {
    const r = rectFill()
    assert.equal(r.horizontals.length, 2)
    assert.equal(r.verticals.length, 2)
    assert.equal(r.hiddenBoxes.length, 0)
  })

  it("ca=0 채움은 선·채움 칸이 아니라 글상자 틀로만 모은다", () => {
    const r = rectFill(0)
    assert.equal(r.horizontals.length + r.verticals.length, 0)
    assert.equal(r.fillRects.length, 0)
    assert.deepEqual(r.hiddenBoxes, [{ x1: 100, y1: 100, x2: 300, y2: 140 }])
  })

  it("restore 뒤에는 불투명도가 되돌아온다", () => {
    const r = rectFill(0, true)
    assert.equal(r.horizontals.length, 2)
    assert.equal(r.hiddenBoxes.length, 0)
  })
})

describe("detectTextBoxTables — 글상자 틀 격자", () => {
  let seq = 0
  const item = (text: string, x: number, top: number, fontSize = 6): NormItem =>
    ({ text, x, y: top - fontSize, w: text.length * fontSize * 0.5, h: fontSize, fontSize, fontName: "F", isHidden: false, seq: seq++ })
  const cols = [[40, 130], [145, 235], [250, 460]]
  const tops = [300, 270, 230]

  it("같은 폭 틀 열 셋이 행마다 윗변을 맞추면 표 — 틀 밖으로 넘친 줄도 그 행 칸", () => {
    const boxes: ClipRect[] = []
    const items: NormItem[] = []
    tops.forEach((top, r) => cols.forEach(([x1, x2], c) => {
      boxes.push({ x1, y1: top - 12 - r, x2, y2: top - (c === 2 ? 2 : 0) })
      items.push(item(`r${r}c${c}`, x1, top - 1))
    }))
    // 둘째 행 셋째 칸의 둘째 줄은 틀 아래로 넘친다
    items.push(item("wrapped", 250, 257))
    items.push(item("Title", 40, 360, 17))
    const found = detectTextBoxTables(boxes, items, 1)
    assert.equal(found.length, 1)
    const t = found[0].block.table!
    assert.equal(t.rows, 3)
    assert.equal(t.cols, 3)
    assert.deepEqual(t.cells.map(row => row.map(c => c.text)), [
      ["r0c0", "r0c1", "r0c2"],
      ["r1c0", "r1c1", "r1c2\nwrapped"],
      ["r2c0", "r2c1", "r2c2"],
    ])
    assert.ok(!found[0].items.some(it => it.text === "Title"))
  })

  it("차트 축 눈금 틀(한 열)·범례는 표가 아니다", () => {
    const boxes: ClipRect[] = []
    const items: NormItem[] = []
    for (let k = 0; k < 8; k++) {
      boxes.push({ x1: 49.5, y1: 100 + k * 18, x2: 60.8, y2: 105 + k * 18 })
      items.push(item(String(65 + k * 5), 52, 105 + k * 18, 5))
      boxes.push({ x1: 418 + k * 29, y1: 76, x2: 429 + k * 29, y2: 81 })
      items.push(item(String(65 + k * 5), 420 + k * 29, 81, 5))
    }
    assert.deepEqual(detectTextBoxTables(boxes, items, 1), [])
  })
})
