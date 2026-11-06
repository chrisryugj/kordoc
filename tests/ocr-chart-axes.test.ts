import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { chartPlotItems } from "../src/ocr/ocr-chart-axes.js"
import type { OcrItem } from "../src/ocr/engine.js"

const box = (text: string, x: number, y: number, w: number, h = 14): OcrItem => ({ text, x, y, w, h, confidence: 0.95 })

/** 생존 곡선 — 세로 눈금 90…0(오른쪽 끝 448), 가로 눈금 0…84 는 "0"·"6"·"18 24 30 …"·"60 66" 으로 나뉘어 읽힘, 판 안에 곡선 표지 조각 */
function survivalChart(): OcrItem[] {
  const items = [box("그림 46. 무사건생존 Kaplan-Meier 곡선", 160, 540, 1000)]
  for (let k = 0; k <= 9; k++) items.push(box(String(90 - k * 10), 415, 679 + k * 65, 33))
  items.push(box("H", 595, 690, 31), box("+H #√ #", 900, 740, 160), box("S", 380, 900, 10))
  items.push(box("0", 444, 1320, 11), box("6", 488, 1320, 9), box("12", 528, 1320, 17), box("18  24  30  36  42  48", 571, 1320, 233),
    box("54", 827, 1320, 20), box("60  66", 870, 1320, 63), box("72  78 84", 958, 1316, 104))
  items.push(box("Time in Months", 700, 1350, 160))
  items.push(box("이 연구는 사전 지정된 분석에서 개선을 입증하였다.", 160, 1500, 1000))
  return items
}

describe("OCR 쪽 차트 판 글 (chartPlotItems)", () => {
  it("세로 눈금과 그 아래 가로 눈금이 감싼 판 안 글을 뺀다 — 제목·본문은 둔다", () => {
    const items = survivalChart()
    const kept = items.filter((_, i) => !chartPlotItems(items).has(i)).map(it => it.text)
    assert.deepEqual(kept, ["그림 46. 무사건생존 Kaplan-Meier 곡선", "이 연구는 사전 지정된 분석에서 개선을 입증하였다."])
  })

  it("가로 눈금이 없으면(숫자 열만 있는 표) 차트가 아니다", () => {
    const items = survivalChart().filter(it => !/^(0|6|12|54|18  24 .*|60  66|72  78 84)$/.test(it.text))
    assert.equal(chartPlotItems(items).size, 0)
  })

  it("값이 들쭉날쭉한 숫자 열과 행은 눈금이 아니다", () => {
    const items: OcrItem[] = []
    const col = [784, 769, 728, 702, 581, 665]
    col.forEach((v, k) => items.push(box(String(v), 415, 679 + k * 65, 33)))
    items.push(box("784 769 728 702 581", 444, 1100, 300))
    assert.equal(chartPlotItems(items).size, 0)
  })
})
