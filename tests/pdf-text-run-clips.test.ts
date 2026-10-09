/**
 * 글 조각마다 깐 클립 — ezPDF Builder·MS Print To PDF 는 글 조각을 그 시작에서 다음 조각 시작까지 한 글줄 높이로 클립한다.
 * 맞댄 클립이 한 행 클립 격자가 되어 라벨 "배경 및 필요성" 이 "| 배경 | 및 |" 표와 "필요성" 문단으로 찢겼다(고흥 2026 계획서).
 * 한컴 칸 클립은 안 여백만큼 글이 칸 왼변에서 떨어지고 칸이 글줄보다 높다 — 그런 한 행 표는 그대로.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"

type Rect = { x1: number; y1: number; x2: number; y2: number }
const clipOps = (rects: Rect[]) => ({
  fnArray: rects.flatMap(() => [OPS.constructPath, OPS.eoClip, OPS.endPath]),
  argsArray: rects.flatMap(r => [[[OPS.rectangle], [r.x1, r.y1, r.x2 - r.x1, r.y2 - r.y1]], [], []] as unknown[][]),
})
const item = (text: string, x: number, y: number, w: number, fontSize = 13.9): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "F", isHidden: false })

describe("글 조각 클립은 표가 아니다", () => {
  it("글 조각마다 맞댄 한 줄 높이 클립 셋은 한 줄 글 (고흥 2026 계획서 \"배경 및 필요성\")", () => {
    const blocks = extractPageBlocksWithLines(
      [item("배경", 110.1, 717.2, 27.8), item("및", 144.9, 717.2, 13.9), item("필요성", 166, 717.2, 42),
        item("지적재조사 사업완료 후 변경된 자료제공", 88.7, 688.9, 300)], 1,
      clipOps([{ x1: 110.1, y1: 713.4, x2: 144.9, y2: 730.9 }, { x1: 144.9, y1: 713.4, x2: 166, y2: 730.9 }, { x1: 166, y1: 713.4, x2: 208, y2: 730.9 }]),
      612, 859)
    assert.ok(!blocks.some(b => b.type === "table"), JSON.stringify(blocks.map(b => b.type)))
    assert.ok(blocks.some(b => b.text === "배경 및 필요성"), JSON.stringify(blocks.map(b => b.text)))
  })

  it("칸 안 여백을 둔 한 행 클립 표는 그대로 표 (한컴 칸 클립)", () => {
    const blocks = extractPageBlocksWithLines(
      [item("구분", 115, 717, 20, 10), item("내용", 175, 717, 20, 10), item("비고", 235, 717, 20, 10)], 1,
      clipOps([{ x1: 110, y1: 710, x2: 170, y2: 732 }, { x1: 170, y1: 710, x2: 230, y2: 732 }, { x1: 230, y1: 710, x2: 290, y2: 732 }]),
      612, 859)
    const table = blocks.find(b => b.type === "table")?.table
    assert.ok(table, JSON.stringify(blocks.map(b => b.type)))
    assert.deepEqual(table.cells[0].map(c => c.text), ["구분", "내용", "비고"])
  })
})
