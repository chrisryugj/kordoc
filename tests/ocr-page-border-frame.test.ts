/** OCR 쪽 테두리 1칸 틀 — 안쪽 표를 품은 쪽 넓이 절반 넘는 틀은 표가 아니라 쪽 테두리다 (src/pdf/page-blocks.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"
import type { OcrItem } from "../src/ocr/engine.js"
import type { LineSegment } from "../src/pdf/line-types.js"

// 595×842 쪽(배율 1, 그림 y 는 아래로): 쪽 테두리(38~561) 안에 위쪽 본문 글, 아래쪽 3열 표(40~549).
// 표 왼쪽 세로변은 테두리 세로선(38)에 합쳐져 따로 없고, 표 가로선만 테두리 변(39)까지 뻗는다
const h = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 1 })
const lines = {
  horizontals: [h(36, 562, 794), h(36, 562, 43), h(39, 549, 296), h(39, 549, 230), h(39, 549, 160), h(39, 549, 60)],
  verticals: [v(38, 42, 794), v(561, 42, 794), v(160, 60, 296), v(350, 60, 296), v(549, 60, 296)],
}
const item = (text: string, x: number, pdfY: number, w: number): OcrItem => ({ text, x, y: 842 - pdfY - 12, w, h: 12, confidence: 0.95 })
const items: OcrItem[] = [
  item("질병관리청 공고 제2020-106호", 50, 770, 250),
  ...[740, 710, 680, 650, 620, 590, 560, 530, 500, 470, 440].map((y, i) => item(`본문 글줄 ${i + 1} 위탁 사업의 내용을 다음과 같이 공고합니다`, 50, y, 480)),
  item("검사항목", 60, 270, 80), item("분류번호", 200, 270, 80), item("단가", 420, 270, 60),
  item("설문조사", 60, 200, 80), item("다121가", 200, 200, 70), item("1,550", 430, 200, 50),
  item("검체수거", 60, 120, 80), item("누600다", 200, 120, 70), item("10,390", 425, 120, 55),
]

it("drops a page-border frame that holds a table and gives the table back its first column (관보 공고 쪽)", () => {
  const blocks = ocrItemsToBlocks(items, 1, 595, 842, 1, lines)
  const tables = blocks.filter(b => b.type === "table")
  assert.equal(tables.length, 1)
  const rows = tables[0].table!.cells.map(r => r.map(c => c.text.trim()))
  assert.deepEqual(rows.map(r => r[0]), ["검사항목", "설문조사", "검체수거"])
  assert.ok(blocks.some(b => b.type !== "table" && b.text?.includes("본문 글줄 1")))
})
