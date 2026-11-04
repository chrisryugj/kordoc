/** 특허 명세서 문단 번호 — 왼쪽 여백 "[0230]" 을 같은 줄 문단 첫 줄에 붙인다 (src/pdf/page-blocks.ts attachParagraphNumbers) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { attachParagraphNumbers } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y: number, w: number): NormItem => ({ text, x, y, w, h: 9, fontSize: 9, fontName: "ocr", isHidden: false })

it("prefixes a margin paragraph number to the first line beside it", () => {
  const out = attachParagraphNumbers([item("[0230]", 10, 751, 23), item("상술한 바와 같이 제조된", 65, 751, 300), item("레이터(폴리에틸렌)", 66, 738, 200)])
  assert.deepEqual(out.map(it => it.text), ["[0230] 상술한 바와 같이 제조된", "레이터(폴리에틸렌)"])
  assert.equal(out[0].x, 10)
})

it("leaves a number with nothing beside it on its line, and ordinary text alone", () => {
  const lone = [item("[0231]", 10, 600, 23), item("다음 줄 글", 65, 580, 200), item("본문 [12] 참조", 10, 500, 200)]
  assert.deepEqual(attachParagraphNumbers(lone).map(it => it.text), lone.map(it => it.text))
})
