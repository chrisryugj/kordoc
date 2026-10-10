/** 한컴 탭 채움 리더 — 점마다 따로 찍은 가운뎃점 아이템 (src/pdf/tab-leaders.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { dropTabLeaderDots } from "../src/pdf/tab-leaders.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y = 700, w = 5): NormItem => ({ text, x, y, w, h: 10, fontSize: 10, fontName: "F", isHidden: false })

describe("dropTabLeaderDots", () => {
  it("drops an evenly spaced run of single middle-dot items (Hancom tab leader)", () => {
    const items = [item("I.소설의 이해", 90, 700, 55), ...Array.from({ length: 8 }, (_, k) => item("·", 149 + 5 * k)), item("3", 200)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["I.소설의 이해", "\t", "3"])
  })

  it("strips a middle-dot leader drawn as one text run (한컴 판에 따라 한 아이템)", () => {
    const items = [item("Ⅰ. 공문서 작성", 90, 700, 60), item("··············································", 160, 700, 140), item("12", 305), item("가·········3", 90, 600, 60)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["Ⅰ. 공문서 작성", "\t", "12", "가\t3"])
  })

  it("joins leader pieces of two or three dots into one fill (PDF 제작기마다 조각 길이가 다르다)", () => {
    const items = [item("제1장 개요", 60, 600, 120), item("··", 251, 600, 8), item("···", 260, 600, 12), item("···", 272, 600, 12), item("··", 285, 600, 8), item("5", 300, 600)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["제1장 개요", "\t", "5"])
  })

  it("takes a fill whose last dot shares a run with the page number and whose first dot sticks to the title (벼·고추 재배면적조사 목차)", () => {
    const items = [item("□ 2026년 벼, 고추 재배면적조사 결과(요약) ·", 77, 700, 346), ...Array.from({ length: 6 }, (_, k) => item("·", 424 + 4 * k, 700, 16)), item("·1", 449, 700, 24)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["□ 2026년 벼, 고추 재배면적조사 결과(요약)", "\t", "1"])
  })

  it("strips the first dot from a title run that overlaps the fill (고흥 업무계획 목차 \"1. 기 획 실 ·\" 폭이 첫 점보다 11pt 뒤까지)", () => {
    const items = [item("1. 기 획 실 ·", 105.7, 700, 102), ...Array.from({ length: 10 }, (_, k) => item("·", 196.5 + 3.8 * k, 700, 15)), item("·1", 234.5, 700, 20)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["1. 기 획 실", "\t", "1"])
  })

  it("takes a fill followed by a bracketed page note instead of a number (과제 계획서 양식 \"(페이지 표기)\")", () => {
    // 점 조각 폭(13)이 점 간격(3.2)보다 넓어 "(" 가 마지막 점 오른끝 앞에서 시작한다
    const items = [item("1-1. 개발 대상 기술·제품의 개요", 70, 700, 207), ...Array.from({ length: 8 }, (_, k) => item("·", 281 + 3.2 * k, 700, 13)),
      item("(", 309, 700, 6.5), item("페이지", 315.5, 700, 39), item("표기", 361, 700, 26), item(")", 387, 700, 6.5)]
    assert.deepEqual(dropTabLeaderDots(items).map(i => i.text), ["1-1. 개발 대상 기술·제품의 개요", "\t", "(", "페이지", "표기", ")"])
  })

  it("keeps a typed dotted separator line with no page number after it (DOCX 서식 구분선)", () => {
    const items = [item("·".repeat(120), 60, 300, 480), item("신청일", 60, 280, 30), ...Array.from({ length: 8 }, (_, k) => item("·", 100 + 3 * k, 250))]
    assert.equal(dropTabLeaderDots(items).length, items.length)
  })

  it("keeps a typed middle dot, short runs, widely spaced dots and period leaders", () => {
    const items = [item("가", 50), item("·", 60), item("나", 70),
      item("·", 100, 600), item("·", 105, 600), item("·", 110, 600),
      item("·", 100, 500), item("·", 106, 500), item("·", 115, 500), item("·", 121, 500),
      ...Array.from({ length: 6 }, (_, k) => item(".", 100 + 4 * k, 400))]
    assert.equal(dropTabLeaderDots(items).length, items.length)
  })
})
