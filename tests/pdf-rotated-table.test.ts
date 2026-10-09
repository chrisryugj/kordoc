/**
 * 90° 돌려 찍은 표 — 가로 표를 세로 쪽에 반시계로 돌려 넣은 쪽(예산서 계속비 연도별 표)은 격자의 행·열이 읽는 표의 열·행이다.
 * 칸 글이 거의 다 위로 진행하면 읽는 방향으로 돌려 표를 세운다 (page-blocks rotatedGridBlocks).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { normalizeItems, type PdfTextItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const W = 595
// 읽는 방향 좌표 (x′, y′) 의 글을 쪽에 반시계로 돌려 찍는다: 쪽 x = W − y′, 쪽 y = x′
const turned = (str: string, x: number, y: number, width: number, size = 9): PdfTextItem =>
  ({ str, transform: [0, size, -size, 0, W - y, x], width, height: size })
const line = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ x1, y1, x2, y2, lineWidth: 0.5 })

describe("90° 돌려 찍은 표", () => {
  it("칸 글이 위로 진행하는 격자는 읽는 방향으로 세운다 (khs 2014 계속비 연도별 표)", () => {
    const colsX = [100, 200, 300, 400], rowsY = [520, 500, 480, 460]
    const text = [["구분", "2013", "2014"], ["사업가", "100", "200"], ["사업나", "300", "400"]]
    const raw: PdfTextItem[] = []
    text.forEach((row, r) => row.forEach((t, c) => raw.push(turned(t, colsX[c] + 5, rowsY[r + 1] + 5, t.length * 8))))
    // 읽는 방향 세로 괘선 x′ = c → 쪽 가로 괘선 y = c, 읽는 방향 가로 괘선 y′ = c → 쪽 세로 괘선 x = W − c
    const horizontals = colsX.map(c => line(W - 520, c, W - 460, c))
    const verticals = rowsY.map(c => line(W - c, 100, W - c, 400))
    const blocks = extractPageBlocksWithLines(normalizeItems(raw), 1, { fnArray: [], argsArray: [] }, W, 842, { horizontals, verticals })
    const table = blocks.find(b => b.type === "table")?.table
    assert.ok(table, JSON.stringify(blocks.map(b => b.type)))
    assert.deepEqual(table.cells.map(row => row.map(c => c.text)), text)
  })
})
