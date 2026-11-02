/** 이미지 OCR 수식 — 수식 영역 자리 글상자를 $LaTeX$ 상자로 (src/ocr/image-formula.ts replaceFormulaItems) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { replaceFormulaItems } from "../src/ocr/image-formula.js"
import type { OcrItem } from "../src/ocr/engine.js"

const box = (text: string, x: number, w: number, y = 100): OcrItem => ({ text, x, y, w, h: 20, confidence: 0.9 })
const region = (x1: number, x2: number, latex: string, kind = "inline") => ({ bbox: { x1, y1: 98, x2, y2: 122 }, latex, kind })

it("replaces a garbled formula box and trims an inline formula out of a text line (수능 수학)", () => {
  const out = replaceFormulaItems([box("y =$x{+3", 300, 100), box("함수 fx=x2+3 에 대하여", 0, 220)],
    [region(300, 400, "y=x^{2}+3"), region(40, 120, "f(x)=x^{2}+3")])
  const texts = out.map(o => o.text)
  assert.ok(!texts.includes("y =$x{+3"))
  assert.ok(texts.includes("$y=x^{2}+3$") && texts.includes("$f(x)=x^{2}+3$"))
  // 글줄 앞뒤 글은 남는다
  assert.ok(texts.some(t => t.startsWith("함수")) && texts.some(t => t.endsWith("에 대하여")))
})

it("keeps text under number boxes, noise and Hangul-heavy regions (국어·영어·한국사 쪽)", () => {
  const items = [box("17", 0, 30), box("고려를 건국하였다", 100, 200)]
  const out = replaceFormulaItems(items, [region(0, 30, "\\fbox{17}"), region(100, 300, "x=1"), region(400, 500, "\\mathrm{nd~in~1893.}")])
  assert.deepEqual(out.map(o => o.text), ["17", "고려를 건국하였다"])
})
