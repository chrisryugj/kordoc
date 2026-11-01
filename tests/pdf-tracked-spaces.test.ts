/** 자간을 줄인 줄의 공백 — 글자마다 따로 찍힌 한글이 같은 만큼 겹칠 때 그 겹침을 기준으로 낱말 사이 공백을 되살린다 (src/pdf/text-line.ts trackedSpaces) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { mergeLineSimple } from "../src/pdf/text-line.js"

// 청년일자리 회복방안 각주 — 글자 폭 7.97, 글자 간격 6.12(겹침 1.85), "원"·"수" 사이만 7.68
const g = (text: string, fx: number, fw = 7.97) => ({ text, x: Math.round(fx), y: 534, w: Math.round(fw), h: 9, fontSize: 9, fontName: "F", fx, fw })

it("restores the word space hidden by condensed tracking (\"20만원 수준\")", () => {
  const line = [g("20", 348, 7.74), g("만", 354.72), g("원", 360.84), g("수", 368.52), g("준", 374.64), g(")", 380.88, 2.42),
    g("1", 460.2, 4.38), g("만", 463.56), g("원", 469.68), g("수", 477.36), g("준", 483.48)]
  assert.equal(mergeLineSimple(line as never), "20만원 수준)\t1만원 수준")
})

it("adds nothing without consistent overlap, and never after brackets or before digits", () => {
  const plain = [g("만", 100), g("원", 108), g("수", 118), g("준", 126)]
  assert.equal(mergeLineSimple(plain as never), "만원 수준")
  const line = [g("(", 335.52, 3.18), g("일", 337.8, 11.04), g("부", 345.6, 11.04), g("이", 356.16, 11.04), g("상", 363.96, 11.04), g("6", 372, 5)]
  assert.equal(mergeLineSimple(line.map(i => ({ ...i, fontSize: 11 })) as never).startsWith("(일부"), true)
})
