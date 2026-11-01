/** 공백 글리프를 U+0000 으로 매긴 글꼴 — 낱말 끝 NUL 은 공백이다 (src/pdf/text-line.ts normalizeItems) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { normalizeItems } from "../src/pdf/text-line.js"

it("a trailing NUL glyph separates words (온새미로 교재 '다음 글을 읽고')", () => {
  const raw = (str: string, x: number, width: number) => ({ str, transform: [10, 0, 0, 10, x, 500], width, height: 10, fontName: "F" })
  const items = normalizeItems([raw("다음\u0000", 100, 21.4), raw("글을\u0000", 121.4, 21.4), raw("읽고", 142.8, 18)] as never)
  assert.deepEqual(items.map(i => [i.text, !!i.hasSpaceBefore]), [["다음\u0000", false], ["글을\u0000", true], ["읽고", true]])
  assert.ok(items[0].x + items[0].w < items[1].x, "공백 몫만큼 폭을 던다")
})

it("maps Kangxi radical code points to unified ideographs (\u2F83 → 自)", () => {
  const items = normalizeItems([{ str: "자성(\u2F83性)", transform: [10, 0, 0, 10, 100, 500], width: 60, height: 10, fontName: "F" }] as never)
  assert.equal(items[0].text, "자성(自性)")
})

it("keeps the spaces of a dotted date but still joins spaced phone digits (보도자료 머리 \"2026. 8. 28.(\")", () => {
  const one = (str: string) => normalizeItems([{ str, transform: [10, 0, 0, 10, 100, 500], width: 60, height: 10, fontName: "F" }] as never)[0].text
  assert.equal(one("2026. 8. 28.("), "2026. 8. 28.(")
  assert.equal(one("8. 31.("), "8. 31.(")
  assert.equal(one("02 123 4567"), "021234567")
})
