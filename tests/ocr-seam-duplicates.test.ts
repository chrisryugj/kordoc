/** 겹친 검출 상자의 이음매 글자 두 번 읽기 — "너와조금" + "금은" → "조금금은" (src/ocr/pdf-ocr.ts ocrItemsToBlocks) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { ocrItemsToBlocks } from "../src/ocr/pdf-ocr.js"

const box = (text: string, x: number, w: number, y = 92, h = 16) => ({ text, x, y, w, h, confidence: 0.9 })

it("drops seam characters read twice by overlapping boxes (손글씨 편지)", () => {
  const blocks = ocrItemsToBlocks([box("너와조금", 216, 60), box("금은", 268, 24), box("다른", 300, 30)], 1, 600, 800, 1, undefined, false)
  const text = blocks.map(b => b.text ?? "").join(" ").replace(/\s+/g, "")
  assert.equal(text, "너와조금은다른")
})

it("keeps genuinely repeated syllables in separate, non-overlapping boxes", () => {
  const blocks = ocrItemsToBlocks([box("하하", 0, 30), box("하하", 40, 30)], 1, 600, 800, 1, undefined, false)
  assert.equal(blocks.map(b => b.text ?? "").join("").replace(/\s+/g, ""), "하하하하")
})
