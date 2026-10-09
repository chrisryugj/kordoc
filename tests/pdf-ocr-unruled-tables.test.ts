/**
 * 그림 영역 OCR 표 — 영역 안 세로 괘선이 없는 표(원그래프 범례·차트 눈금을 글 정렬로 묶은 것)는 표로 받지 않고 행 문단으로 (ODL 124·140).
 * pdf-ocr 가 괘선 수를 세어 UNRULED_REGION_TABLES 에 적고, 그림 영역 병합이 그 표를 거른다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mergeOcrImageRegions, UNRULED_REGION_TABLES } from "../src/pdf/ocr-region-merge.js"
import type { IRBlock } from "../src/types.js"

const region = { x1: 100, y1: 100, x2: 400, y2: 400 }
const legend = (): IRBlock => ({
  type: "table", pageNumber: 1, bbox: { page: 1, x: 120, y: 150, width: 260, height: 60 },
  table: {
    rows: 3, cols: 2, hasHeader: true,
    cells: [["Waste materials", "Unutilised wood"], ["11.4%", "34.7%"], ["General wood", "Construction"]]
      .map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
  },
})

describe("그림 영역 OCR 표 — 세로 괘선 없는 표는 행 문단으로", () => {
  it("괘선 있는 그림 속 표는 표 그대로", () => {
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [region], [legend()])
    assert.deepEqual(blocks.map(b => b.type), ["table"])
  })

  it("괘선 없는 영역의 표는 글을 버리지 않고 행마다 문단으로", () => {
    const blocks: IRBlock[] = [], table = legend()
    UNRULED_REGION_TABLES.add(table)
    mergeOcrImageRegions(blocks, 1, [region], [table])
    assert.ok(blocks.every(b => b.type === "paragraph"), JSON.stringify(blocks.map(b => b.type)))
    const text = blocks.map(b => b.text).join(" ")
    for (const word of ["Waste materials", "34.7%", "Construction"]) assert.ok(text.includes(word), text)
  })
})
