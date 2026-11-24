/** OCR 표 칸의 자리 — 괘선으로 찾은 칸마다 IRCell.bbox 를 싣는다 (src/pdf/page-blocks.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"
import type { OcrItem } from "../src/ocr/engine.js"
import type { LineSegment } from "../src/pdf/line-types.js"

// 임대차계약서 당사자 표 — 왼쪽 "임차인" 칸이 아래 두 행(주소·성명)을 묶는다
const H = 800
const seg = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ x1, y1: H - Math.max(y1, y2), x2, y2: H - Math.min(y1, y2), lineWidth: 1 })
const lines = {
  horizontals: [seg(50, 100, 400, 100), seg(50, 140, 400, 140), seg(150, 180, 400, 180), seg(50, 220, 400, 220)],
  verticals: [seg(50, 100, 50, 220), seg(150, 100, 150, 220), seg(400, 100, 400, 220)],
}
const box = (text: string, x: number, y: number, w: number): OcrItem => ({ text, x, y, w, h: 14, confidence: 0.95 })
const items = [box("구분", 60, 112, 40), box("내용", 160, 112, 40), box("임차인", 60, 172, 50), box("서울시 중구 세종대로 110", 160, 152, 200), box("홍길동", 160, 192, 50)]

it("puts each ruled cell's box (PDF pt, bottom-up) on IRCell.bbox, the merged cell covering both rows", () => {
  const tables = ocrItemsToBlocks(items, 1, 600, H, 1, lines).filter(b => b.type === "table")
  assert.equal(tables.length, 1)
  const t = tables[0].table!
  assert.deepEqual(t.cells.map(r => r.map(c => c.text)), [["구분", "내용"], ["임차인", "서울시 중구 세종대로 110"], ["", "홍길동"]])
  const box = (r: number, c: number) => { const b = t.cells[r][c].bbox!; return [b.page, b.x, b.y, b.width, b.height] }
  assert.deepEqual(box(0, 0), [1, 50, H - 140, 100, 40])
  assert.deepEqual(box(1, 0), [1, 50, H - 220, 100, 80])
  assert.equal(t.cells[1][0].rowSpan, 2)
  assert.deepEqual(box(1, 1), [1, 150, H - 180, 250, 40])
  assert.deepEqual(box(2, 1), [1, 150, H - 220, 250, 40])
})
