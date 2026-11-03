/** OCR 숫자 자릿수 재인식 — 천 단위 쉼표 자릿수가 어긋난 수만 다시 읽는다 (src/ocr/engine.ts badThousands) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { badThousands } from "../src/ocr/engine.js"

it("flags grouped numbers whose digits do not fall in threes (자간 좁은 숫자의 0 합침, 관보 계속비)", () => {
  for (const t of ["37,369,00", "2,618,631,00,000", "302543,00", "102,260,,00"]) assert.equal(badThousands(t), true, t)
})

it("leaves well-formed amounts and non-grouped numbers alone", () => {
  for (const t of ["1,234", "2,480,734,000", "합계 1,234,567원", "12,345 (2.5%)", "3.141,5", "2024"]) assert.equal(badThousands(t), false, t)
})
