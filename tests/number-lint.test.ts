/**
 * 본문 수치 ↔ 표 수치 대조 (checkTableNumbers, `kordoc lint --numbers`)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { checkTableNumbers, type NumberCheckBlock } from "../src/hwpx/number-lint.js"

const table: NumberCheckBlock = { type: "table", rows: [["구분", "2025", "2026"], ["예산(억원)", "218", "240"], ["차량", "4대", "6대"], ["인원", "12명", "15명"], ["순번", "11", "12"]] }
const review = (text: string, blocks: NumberCheckBlock[] = [table]) => checkTableNumbers([{ type: "text", text }, ...blocks]).review.map(r => r.match)

describe("checkTableNumbers", () => {
  it("표 가까이 본문 수치 가운데 표에 없는 것만 확인 목록에", () => {
    assert.deepEqual(review("예산은 218억원에서 250억원으로, 차량은 4대에서 11대로"), ["250억원", "11대"])
  })
  it("행 번호처럼 흔한 수는 단위가 맞아야 — '11대'가 순번 칸 11 로 통과하지 않는다", () => {
    assert.deepEqual(review("차량 11대"), ["11대"])
  })
  it("표에 그 단위가 없거나 단어의 일부면 대조하지 않는다 ('3건씩', '대부분')", () => {
    assert.deepEqual(review("3건씩 처리하고 대부분 교체"), [])
  })
  it("기준값 표현은 대조하지 않는다", () => {
    assert.deepEqual(review("인원 목표 20명, 30명 이상 확보"), [])
  })
  it("소수·세 자리 이상 수는 단위 없는 칸('(25.7)' 비중 열)과도 같은 수", () => {
    const ratio: NumberCheckBlock = { type: "table", rows: [["권역", "건수(비중)"], ["충청", "9건 (25.7)"], ["영남", "8건 (22.3)"], ["호남", "5건 (14.3)"], ["합계", "35건 (100)"]] }
    assert.deepEqual(review("충청권 9건(25.7%), 영남권 8건(22.3%)", [ratio, { type: "table", rows: [["비중", "44.7%", "40%"], ["a", "1", "2"], ["b", "3", "4"]] }]), [])
  })
  it("표에서 먼 본문은 보지 않는다", () => {
    const far = Array.from({ length: 5 }, (): NumberCheckBlock => ({ type: "text", text: "사이 문단" }))
    assert.deepEqual(checkTableNumbers([{ type: "text", text: "예산 999억원" }, ...far, table]).review, [])
  })
})
