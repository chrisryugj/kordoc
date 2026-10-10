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
