/** OCR 두 행 글 표 — 머리 행 + 본문 한 행에 칸마다 여러 줄 글이 든 표는 줄마다 행으로 펼치지 않는다 (src/pdf/page-blocks.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"
import type { OcrItem } from "../src/ocr/engine.js"
import type { LineSegment } from "../src/pdf/line-types.js"

// 관보 민원사무 개정 표 "분류번호 | 민원사무명 | 구분 | 당 초 | 변 경" — 당초·변경 칸에 구비서류 글이 여러 줄
const H = 800
const seg = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ x1, y1: H - Math.max(y1, y2), x2, y2: H - Math.min(y1, y2), lineWidth: 1 })
const cols = [50, 150, 250, 300, 425, 550]
const lines = {
  horizontals: [100, 140, 500].map(y => seg(50, y, 550, y)),
  verticals: cols.map(x => seg(x, 100, x, 500)),
}
const box = (text: string, x: number, y: number, w: number): OcrItem => ({ text, x, y, w, h: 14, confidence: 0.95 })
const head = ["분류번호", "민원사무명", "구분", "당 초", "변 경"].map((t, c) => box(t, cols[c] + 5, 112, 60))
const left = ["<신청서>", "진단용 방사선 발생장치의 신", "고사항변경신고서", "1.진단용 방사선 발생장치의", "신고사항변경신고", "<민원인 제출서류>", "(1) 별지 제3호서식에 따른", "신고증명서원본"]
const body = [
  box("14700-0609", 55, 150, 90), box("진단용방사선", 155, 150, 90), box("발생장치의", 155, 170, 90),
  ...["구", "비", "서", "류"].map((t, i) => box(t, 268, 150 + i * 20, 14)),
  ...left.map((t, i) => box(t, 305, 150 + i * 20, 115)), ...left.map((t, i) => box(t, 430, 150 + i * 20, 115)),
]

it("keeps a header + one-row OCR table whose cells hold several text lines as one body row (관보 당초·변경 구비서류)", () => {
  const tables = ocrItemsToBlocks([...head, ...body], 1, 600, H, 1, lines).filter(b => b.type === "table")
  assert.equal(tables.length, 1)
  const t = tables[0].table!
  assert.equal(t.rows, 2, JSON.stringify(t.cells.map(r => r.map(c => c.text))))
  assert.ok(t.cells[1][3].text.includes("<민원인 제출서류>") && t.cells[1][3].text.includes("신고증명서원본"))
})
