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

it("measures a space hint against exact coordinates — a comma overprinted on the space glyph stays attached (\"55만원,\")", () => {
  const w = (text: string, fx: number, fw: number, hasSpaceBefore = false) => ({ text, x: Math.round(fx), y: 759, w: Math.round(fw), h: 13, fontSize: 13, fontName: "F", fx, fw, ...(hasSpaceBefore ? { hasSpaceBefore } : {}) })
  assert.equal(mergeLineSimple([w("55", 331.25, 14.13), w("만원", 345.44, 25.27), w(",", 370.65, 4.15, true)] as never), "55만원,")
  // 반올림 전 좌표가 없으면 종전대로 반올림 틈(1pt)으로 띄운다
  assert.equal(mergeLineSimple([{ text: "만원", x: 345, y: 759, w: 25, h: 13, fontSize: 13, fontName: "F" }, { text: ",", x: 371, y: 759, w: 4, h: 13, fontSize: 13, fontName: "F", hasSpaceBefore: true }] as never), "만원 ,")
})
