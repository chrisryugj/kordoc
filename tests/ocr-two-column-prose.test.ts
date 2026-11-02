/** OCR 두 단 본문 군집 — 두 실질 열이 긴 글줄이면 표가 아니라 두 단이고, 그 경계로 단마다 다시 읽는다 (cluster-detector isTwoColumnProse) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"

// 두 단 강의 자료 한 쪽의 OCR 상자 기하(글자는 같은 종류의 다른 글자로 바꿨다)와 래스터 괘선. 오른쪽 단에 그림 글이 끼어
// 글 판정으로는 단 틈을 못 찾아, "왼쪽 글 | 빈칸 | 빈칸 | 오른쪽 글" 군집 표(11×4·19×4)가 됐다
const d = JSON.parse(readFileSync(new URL("./fixtures/ocr-two-column-notes.json", import.meta.url), "utf8"))
const items = (d.items as Array<[string, number, number, number, number]>).map(([text, x, y, w, h]) => ({ text, x, y, w, h, confidence: 0.95 }))

it("does not turn two prose columns into one tall table", () => {
  const blocks = ocrItemsToBlocks(items, 1, d.pdfW, d.pdfH, d.scale, d.lines)
  const tall = blocks.filter(b => b.type === "table" && b.table!.rows >= 10)
  assert.equal(tall.length, 0, blocks.map(b => b.type + (b.table ? `${b.table.rows}x${b.table.cols}` : "")).join(" "))
})
