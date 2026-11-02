/** OCR 열린 표의 바깥 이름표 열 — 위·아래 가로 괘선이 첫 세로선 바깥까지 뻗으면 그 끝을 표 변으로 (src/pdf/page-blocks.ts openSideColumns) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { openSideColumns } from "../src/pdf/page-blocks.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"
import type { NormItem } from "../src/pdf/text-line.js"

// 표 격자는 첫 세로선 140 ~ 끝 550, 위아래 600·400. 이름표 열(40~140)엔 세로 테두리가 없다 (혼인 통계 연령별 표)
const h = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const grid = (): TableGrid => ({ colXs: [140, 300, 420, 550], rowYs: [600, 570, 400], bbox: { x1: 140, y1: 400, x2: 550, y2: 600 }, vertexRadius: 1 })
const item = (text: string, x: number, y: number): NormItem => ({ text, x, y, w: 50, h: 10, fontSize: 10, fontName: "ocr", isHidden: false })
const values = [item("322.8", 180, 540), item("305.5", 330, 540), item("0.9", 180, 500), item("1.0", 330, 500)]
const labels = [item("계", 70, 540), item("19세 이하", 60, 500), ...values]

it("adds the label column when the top and bottom rules reach past the first vertical", () => {
  const verticals: LineSegment[] = []
  const g = openSideColumns(grid(), [h(40, 550, 600), h(40, 550, 400)], verticals, labels)
  assert.deepEqual(g.colXs, [40, 140, 300, 420, 550])
  assert.equal(g.bbox.x1, 40)
  // 가상 세로선을 세워 칸 추출이 왼변을 찾는다
  assert.deepEqual(verticals.map(v => v.x1), [40])
})

it("leaves the grid when only one rule reaches out or no text stands outside", () => {
  assert.equal(openSideColumns(grid(), [h(40, 550, 600), h(140, 550, 400)], [], labels).colXs.length, 4)
  assert.equal(openSideColumns(grid(), [h(40, 550, 600), h(40, 550, 400)], [], values).colXs.length, 4)
})

it("leaves forms alone: Hangul cells inside, or a neighbouring grid on that side (신청서 서식)", () => {
  const words = [item("계", 70, 540), item("신청인 성명", 180, 540), item("주소", 330, 540), item("생년월일", 180, 500)]
  assert.equal(openSideColumns(grid(), [h(40, 550, 600), h(40, 550, 400)], [], words).colXs.length, 4)
  const neighbour: TableGrid = { colXs: [40, 135], rowYs: [600, 400], bbox: { x1: 40, y1: 400, x2: 135, y2: 600 }, vertexRadius: 1 }
  const g = grid()
  assert.equal(openSideColumns(g, [h(40, 550, 600), h(40, 550, 400)], [], labels, [g, neighbour]).colXs.length, 4)
})
