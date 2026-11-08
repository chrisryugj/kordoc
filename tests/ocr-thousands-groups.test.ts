/** OCR 숫자 자릿수 재인식 — 천 단위 쉼표 자릿수가 어긋난 수만 다시 읽는다 (src/ocr/engine.ts badThousands) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { badThousands, rereadDecimalPair, rereadNumberText, singleNumberText } from "../src/ocr/engine.js"

it("flags grouped numbers whose digits do not fall in threes (자간 좁은 숫자의 0 합침, 관보 계속비)", () => {
  for (const t of ["37,369,00", "2,618,631,00,000", "302543,00", "102,260,,00"]) assert.equal(badThousands(t), true, t)
})

it("leaves well-formed amounts and non-grouped numbers alone", () => {
  for (const t of ["1,234", "2,480,734,000", "합계 1,234,567원", "12,345 (2.5%)", "3.141,5", "2024"]) assert.equal(badThousands(t), false, t)
})

it("treats a number with a unit tail as a single number to re-read (기금운용계획 \"67,05,00,000원\")", () => {
  for (const t of ["67,05,00,000원", "1,234명", "(1,234)", "-5,000", "12%", "2,51.8"]) assert.equal(singleNumberText(t), true, t)
  for (const t of ["6,177,000,000원 67,055,000,000원", "자체수입 23,943", "1,234 5,678"]) assert.equal(singleNumberText(t), false, t)
})

it("keeps the non-digit text of the original when the stretched re-read adds a border or drops a sign (관보 기금 금액)", () => {
  assert.equal(rereadNumberText("2,618,631,00,000원", "2,618,631,000,000원|"), "2,618,631,000,000원")
  assert.equal(rereadNumberText("△19,454,00,000원", "19,454,000,000원"), "△19,454,000,000원")
  assert.equal(rereadNumberText("37,369,00", "37,369,000"), "37,369,000")
  assert.equal(rereadNumberText("2,51.8", "2,251.8"), "2,251.8")
  // 수가 둘 이상이면 어느 수인지 모른다
  assert.equal(rereadNumberText("1,23,000원", "1,230|00원"), null)
  // 자릿수가 줄거나 원래 숫자를 품지 않으면 오독이다
  assert.equal(rereadNumberText("0,05", "|5"), null)
})

it("rereadDecimalPair: 점이 빠진 기온 짝(최저/최고)은 양쪽 소수로 다시 읽혔고 원래 숫자를 품을 때만 받는다", () => {
  assert.equal(rereadDecimalPair("121/18.1", "12.1/18.1"), "12.1/18.1")
  assert.equal(rereadDecimalPair("124/188", "12.4/18.8"), "12.4/18.8")
  // 늘려 읽어 숫자 하나가 되살아난 것("1.8" → "11.8")까지
  assert.equal(rereadDecimalPair("31/1.8", "3.1/11.8"), "3.1/11.8")
  // 한쪽만 소수거나, 숫자가 바뀌거나 둘 이상 늘면 오독이다
  assert.equal(rereadDecimalPair("121/18.1", "121/18.1"), null)
  assert.equal(rereadDecimalPair("121/18.1", "13.1/18.1"), null)
  assert.equal(rereadDecimalPair("31/1.8", "3.1/111.8"), null)
})
