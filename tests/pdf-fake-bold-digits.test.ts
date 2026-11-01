/** 가짜 볼드 덧찍기 제거 — 자간을 줄인 수치의 같은 숫자 둘은 지우지 않는다 (src/pdf/text-line.ts normalizeItems) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { normalizeItems } from "../src/pdf/text-line.js"

const raw = (str: string, x: number, width: number) => ({ str, transform: [12, 0, 0, 12, x, 531.76], width, height: 12, fontName: "F" })

it("keeps both nines of a condensed '129.9' (해외직접투자 보도자료 표)", () => {
  const items = normalizeItems([raw("1", 378.96, 6.6), raw("2", 382.8, 6.6), raw("9", 386.64, 6.6), raw(".", 390.48, 2.62), raw("9", 390.36, 6.6)] as never)
  assert.equal(items.filter(i => i.text === "9").length, 2)
})

it("still drops a fake-bold digit redrawn under a point away, and shadowed labels", () => {
  assert.equal(normalizeItems([raw("9", 386.64, 6.6), raw("9", 387.1, 6.6)] as never).length, 1)
  assert.equal(normalizeItems([raw("마", 104.1, 8.55), raw("마", 107.4, 8.55)] as never).length, 1)
})
