/**
 * OCR 줄 맞춤 (#141) — 같은 줄 조각의 박스 아래 끝이 글자 크기·숫자 하강부로 몇 pt 씩 어긋나도 한 줄로 묶는다.
 * 고정 데이터: 감열지 영수증 사진(796×1238, 2px/pt)을 내장 PP-OCRv5 로 인식한 박스 그대로.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { ocrItemsToBlocks, groupOcrLines } from "../src/ocr/pdf-ocr.js"
import { blocksToMarkdown } from "../src/table/builder.js"

const RECEIPT: Array<[string, number, number, number, number]> = [
  ["-MART", 43, 23, 365, 100],
  ["대 한 민 국", 425, 33, 331, 40],
  ["등할인점", 480, 71, 273, 56],
  ["탄현점", 121, 160, 126, 60],
  ["이마트", 25, 161, 128, 68],
  ["128-85-48537 대표: 최병렬", 275, 163, 455, 78],
  ["일산구", 149, 219, 103, 48],
  ["덕이 203-1 (031)927-1234", 275, 222, 458, 57],
  ["고양시", 26, 225, 100, 42],
  ["http://www.emartaal1.com", 22, 266, 426, 46],
  ["영수증을 지참하시면", 24, 363, 331, 38],
  ["교환/환불시더욱 편리합니다.", 23, 399, 489, 47],
  ["(등 록】 2010-03-24 21:17 P0S 번호: 1016", 23, 496, 706, 40],
  ["상품코드", 20, 583, 193, 37],
  ["단 가수량", 360, 586, 193, 38],
  ["금액", 626, 588, 102, 37],
  ["001 _A3리필속지(20매)", 17, 673, 387, 45],
  ["1,300  2", 375, 711, 156, 45],
  ["*8809074396277", 17, 717, 247, 34],
  ["2,600", 638, 723, 89, 36],
  ["002 합지D링3공바인다(70m)", 16, 750, 508, 58],
  ["*8809074397502", 16, 807, 247, 33],
  ["2,500  10", 372, 809, 157, 35],
  ["25,000", 619, 811, 107, 36],
  ["부가세과세 물품가액", 19, 894, 350, 37],
  ["25,091", 619, 899, 102, 36],
  ["상품가격에 이미 포함된", 17, 937, 386, 39],
  ["부가세(", 426, 941, 117, 36],
  ["2,509)", 618, 943, 104, 36],
  ["합", 20, 973, 65, 46],
  ["계", 303, 983, 58, 37],
  ["27,600", 512, 986, 208, 35],
  ["상품코드앞* 표시가 되어 있는 품목은", 15, 1070, 654, 50],
  ["부가세 과세 품목입니다.", 15, 1114, 400, 39],
]
const items = RECEIPT.map(([text, x, y, w, h]) => ({ text, x, y, w, h, confidence: 0.95 }))

describe("OCR 줄 맞춤 (#141)", () => {
  const blocks = ocrItemsToBlocks(items, 1, 796 / 2, 1238 / 2, 2)
  const md = blocksToMarkdown(blocks)

  it("한 줄 조각을 왼쪽부터 한 문단으로 — 위쪽 y 순으로 뒤집히지 않는다", () => {
    assert.match(md, /이마트\s+탄현점\s+128-85-48537 대표: 최병렬/, md)
    assert.match(md, /고양시\s+일산구\s+덕이 203-1/, md)
  })

  it("품목 두 줄 묶음이 표 행에서 섞이지 않는다 — 바코드·단가·금액이 한 행", () => {
    const table = blocks.find(b => b.type === "table")?.table
    assert.ok(table, md)
    const rows = table.cells.map(r => r.map(c => c?.text ?? "").join(" | "))
    const barcode1 = rows.find(r => r.includes("*8809074396277"))
    assert.ok(barcode1 && barcode1.includes("1,300") && barcode1.includes("2,600"), rows.join("\n"))
    assert.ok(!barcode1.includes("002"), rows.join("\n"))
    const item2 = rows.find(r => r.includes("002"))
    assert.ok(item2 && !item2.includes("880907439"), rows.join("\n"))
    const total = rows.find(r => r.includes("27,600"))
    assert.ok(total && /합/.test(total), rows.join("\n"))
  })
})

describe("OCR 줄 맞춤 — 두 단 글은 좌우 줄을 묶지 않는다 (ODL 141)", () => {
  // 두 단 카드 인포그래픽: 왼쪽·오른쪽 카드의 글줄이 높이 차 0.3줄 안으로 엇비슷하게 놓였다(틈 7.1배·20배)
  const card = [
    { text: "each of us decide what happens to our own creations", x: 612, y: 3720, w: 1190, h: 46, confidence: 0.95 },
    { text: "a presentation in class—that's a fair use situation.", x: 2129, y: 3712, w: 1150, h: 44, confidence: 0.95 },
    { text: "We're all both consumers and creators of creative", x: 640, y: 2230, w: 1120, h: 45, confidence: 0.95 },
    { text: "Copyright gives a lot of protection, but it also has", x: 2460, y: 2221, w: 1180, h: 44, confidence: 0.95 },
    // 오른쪽 카드 번호 — 짧은 상자가 두 단 사이에 놓여도 다리가 되지 않는다
    { text: "6", x: 2200, y: 2215, w: 40, h: 60, confidence: 0.95 },
  ]
  it("긴 글줄끼리 멀리 떨어지면 다른 줄", () => {
    const lines = groupOcrLines(card).map(l => l.map(j => card[j].text))
    assert.ok(!lines.some(l => l.some(t => t.startsWith("We’re") || t.startsWith("We're")) && l.some(t => t.startsWith("Copyright"))), JSON.stringify(lines))
    assert.ok(!lines.some(l => l.some(t => t.startsWith("each")) && l.some(t => t.startsWith("a presentation"))), JSON.stringify(lines))
  })
  it("높이가 두 배 넘게 다른 상자(아이콘·QR 잡음)와는 묶지 않는다", () => {
    const junk = [
      { text: "다", x: 3518, y: 5760, w: 41, h: 36, confidence: 0.5 },
      { text: "i", x: 3546, y: 5765, w: 27, h: 14, confidence: 0.5 },
      { text: "!’", x: 317, y: 5198, w: 135, h: 172, confidence: 0.5 },
      { text: "permission.", x: 711, y: 5266, w: 250, h: 62, confidence: 0.95 },
    ]
    assert.deepEqual(groupOcrLines(junk).map(l => l.length), [1, 1, 1, 1])
  })
  it("범례 한 줄의 긴 라벨은 먼저 만난 줄 순서와 무관하게 한 줄 (ODL 059 원그래프 범례)", () => {
    const legend = [
      { text: "Waste materials", x: 1146, y: 652.5, w: 161.5, h: 17.5, confidence: 0.95 },
      { text: "Unutilised wood General wood", x: 630, y: 652.5, w: 321.5, h: 17.5, confidence: 0.95 },
      { text: "Construction", x: 991, y: 653.5, w: 158, h: 16.5, confidence: 0.95 },
      { text: "Biogas", x: 508, y: 653.5, w: 63, h: 21, confidence: 0.95 },
    ]
    assert.deepEqual(groupOcrLines(legend).map(l => l.length), [4])
  })
  it("영수증 품목 행(짧은 숫자 칸과 6.9배 틈)은 그대로 한 줄", () => {
    const lines = groupOcrLines(items).map(l => l.map(j => items[j].text))
    assert.ok(lines.some(l => l.includes("부가세과세 물품가액") && l.includes("25,091")), JSON.stringify(lines))
    assert.ok(lines.some(l => l.includes("합") && l.includes("계") && l.includes("27,600")), JSON.stringify(lines))
  })
})
