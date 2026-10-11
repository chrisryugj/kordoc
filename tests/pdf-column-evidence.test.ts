import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { detectColumns } from "../src/pdf/columns.js"
import type { NormItem } from "../src/pdf/text-line.js"

const part = (text: string, x: number, y: number, w: number): NormItem => ({
  text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false,
})

describe("PDF column evidence", () => {
  it("does not treat repeated formula and prose starts as a data table", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) lines.push([
      part("The full paragraph describes an equation and continues over this line", 90, 700 - r * 16, 150),
      part("with more explanatory prose", 258, 700 - r * 16, 85),
      part("that reaches the right margin.", 351, 700 - r * 16, 150),
    ])
    assert.equal(detectColumns(lines), null)
  })

  it("retains repeated short data rows across three columns", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) lines.push([
      part(`Item ${r}`, 90, 700 - r * 16, 36),
      part(String(r + 10), 200, 700 - r * 16, 20),
      part(String(r + 20), 310, 700 - r * 16, 20),
    ])
    assert.deepEqual(detectColumns(lines), [90, 200, 310])
  })

  it("does not treat justified word-per-item prose as columns (ODL 043)", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) {
      const g = 10 + r // 줄마다 틈은 다르지만 줄 안에서는 같다
      const y = 700 - r * 15
      const xs = [90, 90 + 50 + g, 90 + 90 + 2 * g, 90 + 140 + 3 * g]
      lines.push([part("interesting", xs[0], y, 50), part("things", xs[1], y, 40), part("has", xs[2], y, 50), part("been", xs[3], y, 30)])
    }
    assert.equal(detectColumns(lines), null)
  })

  it("does not treat justified title-case reference lines as columns (web052)", () => {
    // 낱말마다 대문자로 여는 참고문헌 제목 줄 — 소문자 낱말이 절반에 못 미쳐도 낱말 끝 문장 부호("Angles,\"")로 문장이다
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) {
      const g = 9 + r
      const y = 700 - r * 12
      const xs = [298, 298 + 55 + g, 298 + 115 + 2 * g, 298 + 180 + 3 * g]
      lines.push([part("Mechanisms", xs[0], y, 55), part("Considering", xs[1], y, 60), part("Transmission", xs[2], y, 65), part("Angles,\"", xs[3], y, 30)])
    }
    assert.equal(detectColumns(lines), null)
  })

  it("keeps equal-gap rows whose cells are not lowercase words", () => {
    const lines: NormItem[][] = []
    for (let r = 0; r < 5; r++) lines.push([
      part(`Item ${r}`, 90, 700 - r * 16, 40),
      part(String(r + 10), 150, 700 - r * 16, 20),
      part(String(r + 20), 190, 700 - r * 16, 20),
    ])
    assert.deepEqual(detectColumns(lines), [90, 150, 190])
  })
})
