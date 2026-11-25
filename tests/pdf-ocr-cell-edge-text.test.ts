/**
 * OCR 글의 표 칸 배정. 세 열 이상 표에서 글 상자의 세로 가운데가 표 위아래 바깥이면(표 바로 아래 출처 줄이 끝 행 칸에 30% 넘게 걸침)
 * 칸 글로 넣지 않는다. 두 열 이하 상자·텍스트층 글은 종전대로 넣는다 (cell-text mapTextToCells).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapTextToCells } from "../src/pdf/cell-text.js"
import type { ExtractedCell, TextItem } from "../src/pdf/line-types.js"

const grid = (cols: number): ExtractedCell[] => Array.from({ length: cols * 2 }, (_, i) => {
  const row = Math.floor(i / cols), col = i % cols
  return { row, col, rowSpan: 1, colSpan: 1, bbox: { x1: col * 100, y1: row * 30, x2: (col + 1) * 100, y2: (row + 1) * 30 } }
})
// 끝 행(30~60) 아래로 걸친 줄. 위 절반만 칸 안, 가운데(62)는 표 바깥
const below = (fontName: string): TextItem => ({ text: "자료: 국가데이터처", x: 5, y: 52, w: 90, h: 20, fontSize: 20, fontName, hasSpaceBefore: false })
const assigned = (cells: ExtractedCell[], item: TextItem) => [...mapTextToCells([item], cells).values()].some(list => list.includes(item))

describe("mapTextToCells: 표 바깥에 걸친 OCR 글", () => {
  it("세 열 이상 표 아래에 걸친 OCR 줄은 칸 글이 아니다", () => {
    assert.equal(assigned(grid(3), below("ocr")), false)
  })
  it("두 열 상자는 종전대로 칸에 넣는다 (선택지 줄을 빼면 글 상자가 표가 됐다)", () => {
    assert.equal(assigned(grid(2), below("ocr")), true)
  })
  it("텍스트층 글은 종전대로 칸에 넣는다", () => {
    assert.equal(assigned(grid(3), below("Batang")), true)
  })
})
