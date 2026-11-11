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

  it("판 바로 밑 위험 인원 표(Number at Risk)와 큰 상자로 읽은 맨 위 눈금도 뺀다 — 다음 그림 설명은 둔다", () => {
    const items = survivalChart()
    items.push(box("100", 400, 610, 48, 30))
    items.push(box("Number at Risk", 149, 1375, 116), box("KEYTRUDA + Chemo/KEYTRUDA", 149, 1395, 252), box("784 769 728 702 581", 444, 1395, 600),
      box("Placebo + Chemo/Placebo", 149, 1415, 230), box("390 382 358 330 312", 444, 1415, 600))
    items.push(box("그림 47. 전체 생존 Kaplan-Meier 곡선", 160, 1440, 1000))
    const kept = items.filter((_, i) => !chartPlotItems(items).has(i)).map(it => it.text)
    assert.deepEqual(kept, ["그림 46. 무사건생존 Kaplan-Meier 곡선", "이 연구는 사전 지정된 분석에서 개선을 입증하였다.", "그림 47. 전체 생존 Kaplan-Meier 곡선"])
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

  it("막대 차트 — 시간 눈금(1:00·0:30·0:00) 아래 범주 이름 줄(평일·토요일·일요일)이 감싼 판 안 글을 뺀다", () => {
    const items = [box("<교제 및 참여활동 시간>", 298, 1177, 379, 29)]
    items.push(box("1:00", 190, 1309, 35, 13), box("0:30", 189, 1387, 36, 13), box("0:00", 189, 1465, 36, 13))
    items.push(box("1:20 1:19", 637, 1232, 108, 20), box("1:05 1:06", 459, 1268, 108, 20), box("ㅍ", 300, 1350, 18, 16))
    items.push(box("평일", 312, 1498, 43, 22), box("토요일", 477, 1498, 68, 22), box("일요일", 657, 1498, 66, 22))
    items.push(box("□ 교제활동을 한 사람의 비율은 일요일에 가장 높았다", 120, 1600, 900, 30))
    const kept = items.filter((_, i) => !chartPlotItems(items).has(i)).map(it => it.text)
    assert.deepEqual(kept, ["<교제 및 참여활동 시간>", "□ 교제활동을 한 사람의 비율은 일요일에 가장 높았다"])
  })

  it("0 에서 끝나지 않는 세 칸 숫자 열 아래 글줄은 차트가 아니다", () => {
    const items = [box("30", 190, 1309, 35, 13), box("20", 190, 1387, 35, 13), box("10", 190, 1465, 35, 13),
      box("합계", 312, 1498, 43, 22), box("비고", 477, 1498, 68, 22)]
    assert.equal(chartPlotItems(items).size, 0)
  })
})

/** 숲 그림 — 하위군 이름·HR(95% CI)·n(%) 줄 아래 가로 눈금, 그 밑 "Favours …" 이름표, 그 아래 약어 풀이와 그림 설명·본문 */
function forestPlot(): OcrItem[] {
  const items = [box("본문 첫 문단입니다.", 100, 40, 900)]
  const rows = [["Hazard Ratio", "Dulaglutide,", "Placebo,"], ["Primary CV Endpoints", "0.88", "594"], ["Nonfatal Stroke", "0.76", "135"], ["CV Death", "0.91", "317"], ["All Death", "0.90", "536"]]
  rows.forEach((r, k) => { items.push(box(r[0], 100, 100 + k * 30, 200), box(r[1], 580, 100 + k * 30, 60), box(r[2], 700, 100 + k * 30, 40)) })
  ;["0.6", "0.7", "0.8", "0.9", "1.0", "1.1"].forEach((t, k) => items.push(box(t, 290 + k * 30, 250, 20)))
  items.push(box("Favours Dulaglutide", 300, 275, 120), box("Favours Placebo", 440, 275, 100))
  items.push(box("CI - confidence interval", 100, 300, 160))
  items.push(box("그림 7: 하위군 분석의 Forest plot", 100, 380, 600), box("표준 치료에 추가로 투여하였을 때 감소하였다.", 100, 420, 900))
  return items
}

describe("OCR 쪽 숲 그림 글 (chartPlotItems)", () => {
  it("가로 눈금 + Favours 이름표면 그림 판 글을 빼고 그림 설명·본문은 둔다", () => {
    const items = forestPlot()
    const kept = items.filter((_, i) => !chartPlotItems(items).has(i)).map(it => it.text)
    assert.deepEqual(kept, ["본문 첫 문단입니다.", "그림 7: 하위군 분석의 Forest plot", "표준 치료에 추가로 투여하였을 때 감소하였다."])
  })

  it("눈금 하나를 놓쳐 간격이 고르지 않아도(-0.25 · 0.25 · 0.5) 값에 비례하면 눈금, 이름표가 위에 있어도 숲 그림", () => {
    const items = [box("본문입니다.", 100, 40, 900), box("Overall", 100, 100, 80), box("0.13 (0.08, 0.18)", 600, 100, 120), box("≥500", 100, 130, 60), box("0.30 (0.19, 0.42)", 600, 130, 120),
      box("← Placebo better", 300, 160, 120), box("DUPIXENT better →", 460, 160, 120),
      box("-0.25", 300, 185, 40), box("0.25", 500, 185, 30), box("0.5", 600, 185, 25), box("그림 7. 천식 시험 2", 100, 260, 500)]
    const kept = items.filter((_, i) => !chartPlotItems(items).has(i)).map(it => it.text)
    assert.deepEqual(kept, ["본문입니다.", "그림 7. 천식 시험 2"])
  })

  it("비교 이름표가 없으면 숫자 줄만으로는 숲 그림이 아니다", () => {
    const items = forestPlot().filter(it => !/^Favours/.test(it.text))
    assert.equal(chartPlotItems(items).size, 0)
  })
})
