/** OCR 쪽 테두리 틀 — 안쪽 표 괘선이 테두리에 닿아 한 격자로 이어진 틀도 쪽 테두리다 (src/pdf/page-blocks.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"

// 관보 행정예고 한 쪽의 OCR 상자 기하(글자는 같은 길이의 다른 글자로 바꿨고, 비교표 아래 본문 줄은 "본문NN")와 래스터 괘선.
// 쪽 테두리 안 위쪽에 현행·개정안 비교표, 아래쪽에 본문과 의견 표. 테두리와 안쪽 표 괘선이 한 격자(27×8)로 이어져 본문까지 표 칸이 됐다
const d = JSON.parse(readFileSync(new URL("./fixtures/ocr-page-frame-welded.json", import.meta.url), "utf8"))
const items = (d.items as Array<[string, number, number, number, number]>).map(([text, x, y, w, h]) => ({ text, x, y, w, h, confidence: 0.95 }))

it("drops a page-border frame welded to the tables it holds and keeps the prose out of tables", () => {
  const blocks = ocrItemsToBlocks(items, 1, d.pdfW, d.pdfH, d.scale, d.lines)
  const tables = blocks.filter(b => b.type === "table")
  assert.ok(tables.length >= 1)
  const inTable = tables.flatMap(t => t.table!.cells.flat().map(c => c.text)).join(" ")
  assert.ok(!inTable.includes("본문"), blocks.map(b => b.type + (b.table ? `${b.table.rows}x${b.table.cols}` : "")).join(" "))
  assert.ok(blocks.some(b => b.type !== "table" && b.text?.includes("본문01")))
})
