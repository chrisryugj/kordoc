/** OCR 쪽 제목 — 글자 크기 빈도가 없는 스캔·이미지 쪽에서 큰 한 줄 짧은 글을 제목으로 (src/ocr/pdf-ocr.ts markOcrHeadings) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { markOcrHeadings } from "../src/ocr/pdf-ocr.js"
import type { IRBlock } from "../src/types.js"

const p = (text: string, fontSize: number, y: number, height = fontSize, x = 70): IRBlock =>
  ({ type: "paragraph", text, pageNumber: 1, style: { fontSize }, bbox: { page: 1, x, y, width: 300, height } })
const body = "보육비용 감소가 여성의 시간배분에 미치는 영향을 살펴보기 위해 2009년부터 2012년까지의 자료를 이용하였다"

it("marks a large single-line short text as a heading (보고서 장·절 제목)", () => {
  const blocks = [p("제4장 실증분석", 20, 700), p("제1절 분석방법", 17, 660), p(body, 12, 500, 120), p(body, 13, 300, 120)]
  markOcrHeadings(blocks)
  assert.deepEqual(blocks.filter(b => b.type === "heading").map(b => [b.text, b.level]), [["제4장 실증분석", 1], ["제1절 분석방법", 2]])
})

it("keeps sentences, numbers, multi-line blocks and too-small sizes as paragraphs", () => {
  const blocks = [p("결과는 다음과 같다.", 20, 700), p("2,345", 20, 680), p("세 줄로 꺾인 큰 글", 20, 650, 70), p("조금 큰 글", 14, 600), p(body, 12, 500, 120), p(body, 12, 300, 120)]
  markOcrHeadings(blocks)
  assert.equal(blocks.filter(b => b.type === "heading").length, 0)
})

it("joins a chapter marker line with the title stacked below, and a two-line title (KDI 장 제목)", () => {
  const blocks = [p("제4장", 18, 660, 16, 239), p("실증분석", 21, 604, 19, 224), p("제1절 분석방법", 17, 449, 15, 207), p(body, 12, 300, 120), p(body, 12, 100, 120)]
  markOcrHeadings(blocks)
  assert.deepEqual(blocks.filter(b => b.type === "heading").map(b => [b.text, b.level]), [["제4장 실증분석", 1], ["제1절 분석방법", 2]])
})

it("keeps same-line pieces apart (로고 글 순서)", () => {
  const blocks = [p("동행매력", 20, 700, 20, 70), p("서울관광재단", 20, 700, 20, 300), p(body, 12, 300, 120), p(body, 12, 100, 120)]
  markOcrHeadings(blocks)
  assert.equal(blocks.filter(b => b.type === "heading").length, 2)
})

it("keeps stacked headings of very different sizes apart (인포그래픽 ODL 141)", () => {
  const blocks = [p("10 THINGS YOU SHOULD KNOW ABOUT", 66, 2444, 66), p("COPYRIGHT", 190, 2184, 190), p(body, 20, 1600, 200), p(body, 20, 1200, 200)]
  markOcrHeadings(blocks)
  assert.deepEqual(blocks.filter(b => b.type === "heading").map(b => b.text), ["10 THINGS YOU SHOULD KNOW ABOUT", "COPYRIGHT"])
})
