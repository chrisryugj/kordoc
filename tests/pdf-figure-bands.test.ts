/**
 * 그림 옆 단 가르기(page-regions figureColumnBands) — 그림·캡션이 한쪽 단에 서고 다른 단에 본문이 흐르는 쪽.
 * 한 단 끝줄이 옆 단 맨 아래보다 아래면 꼬리(쪽 꼬리말)로 두 단 뒤에 읽는다. 같은 단 줄 간격으로 이어진 줄은 꼬리가 아니다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { figureColumnBands } from "../src/pdf/page-regions.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y: number, w: number, fontSize = 9): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "f", isHidden: false })

describe("figureColumnBands — 단 끝줄과 쪽 꼬리말", () => {
  it("옆 단 캡션보다 아래로 내려온 문단 끝 두 줄은 그 단과 함께 읽는다 (ODL 133)", () => {
    // 왼 단 본문 14pt 간격, 오른 단 그림 + 캡션 세 줄(212~232), 아래 전폭 문단
    const left = Array.from({ length: 18 }, (_, k) => item(`body line ${k}`, 56.69, 446.77 - k * 14, 273.61))
    const items = [
      item("Sportfishing. Among those who fish for sport, only 27% of U.S. anglers are female", 56.69, 470, 462.61),
      ...left,
      item("respond, “Whatever I’m fishing for,” and her favorite place to fish", 56.69, 194.77, 273.61),
      item("was “Wherever I am.”", 56.69, 180.77, 88.16),
      item("Figure 7.5: Georgina Ballantine holds the British", 339.31, 231.64, 173.34, 8),
      item("record for a 64-pound rod-caught salmon from", 339.31, 222.04, 170.05, 8),
      item("River Tay, Scotland in 1922.", 339.31, 212.44, 99.09, 8),
      item("Most avid bass anglers can identify Roland Martin, Bill Dance, and Jimmy Houston, who dominated competitive", 56.69, 157.77, 462.61),
    ]
    const bands = figureColumnBands(items, [{ x: 339.31, y: 245, w: 180, h: 190 }])
    assert.ok(bands)
    const texts = bands.map(g => g.map(i => i.text))
    const column = texts.findIndex(g => g.includes("body line 17"))
    assert.ok(texts[column].includes("was “Wherever I am.”"), JSON.stringify(texts))
    assert.ok(texts.findIndex(g => g.some(t => t.startsWith("Figure 7.5"))) > column)
  })

  it("큰 틈 뒤 쪽 꼬리말은 두 단 뒤로 (ODL 140 \"312 | Grouper …\")", () => {
    const items = [
      ...Array.from({ length: 22 }, (_, k) => item(`left ${k}`, 56.69, 400 - k * 14, 220)),
      ...Array.from({ length: 24 }, (_, k) => item(`right ${k}`, 280.94, 400 - k * 14, 238.36)),
      item("312 | Grouper and Spawning Aggregations", 56.69, 39.82, 158.28, 8),
    ]
    const bands = figureColumnBands(items, [])
    assert.ok(bands)
    const texts = bands.map(g => g.map(i => i.text))
    assert.deepEqual(texts.at(-1), ["312 | Grouper and Spawning Aggregations"])
    assert.ok(texts[0].includes("left 21") && texts[1].includes("right 23"), JSON.stringify(texts.map(g => g.slice(-1))))
  })
})
