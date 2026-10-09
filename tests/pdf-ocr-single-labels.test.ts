import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mergeOcrImageRegions } from "../src/pdf/ocr-region-merge.js"
import type { IRBlock } from "../src/types.js"
const region = { x1: 100, y1: 100, x2: 400, y2: 400 }
const paragraph = (text: string, x: number, y: number, width = 60, height = 10): IRBlock => ({ type: "paragraph", text, pageNumber: 1, bbox: { page: 1, x, y, width, height }, style: { fontName: "ocr", fontSize: height } })
const diagram = () => [paragraph("Nature", 160, 270, 60, 12), paragraph("p", 160, 240, 5, 6), paragraph("1 1", 140, 215, 120, 8), paragraph("2 0,1 2 0,1", 120, 170, 160), paragraph("1,0 -0.2,0.8", 140, 120, 110)]
describe("single-character OCR labels inside a supported diagram", () => {
  it("retains a small label between aligned diagram labels without losing source text", () => {
    const blocks: IRBlock[] = [], ocr = diagram()
    assert.equal(mergeOcrImageRegions(blocks, 1, [region], ocr), 5)
    assert.deepEqual(blocks.map(b => b.text), ocr.map(b => b.text))
    assert.ok(blocks.every(b => b.style === undefined))
  })
  it("retains existing wrapped OCR prose and numeric paragraphs", () => {
    const blocks: IRBlock[] = [], body = paragraph("A wrapped diagram explanation retains all source words.", 120, 200, 200, 45)
    assert.equal(mergeOcrImageRegions(blocks, 1, [region], [body]), 1)
    assert.equal(blocks[0].text, body.text)
  })
  it("does not promote fragments stacked beside a right-aligned numeric axis", () => {
    const axis = (values: Array<[string, number, number, number, number]>) => values.map(v => paragraph(...v))
    const cases = [
      axis([["180", 123, 708, 14, 7], ["160", 123, 687, 13, 7], ["a140", 110, 661, 26, 25], ["t", 110, 656, 7, 5], ["S", 111, 652, 6, 5], ["120", 114, 645, 22, 7], ["2", 114, 634, 5, 7], ["t100-", 110, 614, 26, 19], ["80", 114, 601, 22, 12], ["0", 114, 596, 3, 5], ["560", 114, 579, 22, 9], ["m40--", 111, 555, 25, 18], ["U", 111, 550, 6, 4], ["20", 114, 539, 22, 7]]),
      axis([["14%", 120, 708, 34, 14], ["12%", 120, 676, 34, 14], ["10%", 120, 645, 34, 14], ["O", 101, 635, 10, 11], ["O o", 79, 624, 32, 13], ["9 8%", 101, 613, 53, 15], ["a", 79, 606, 11, 9], ["6%", 129, 582, 25, 14], ["2%", 129, 519, 25, 14], ["0%", 129, 488, 25, 14]]),
      axis([["14%", 120, 423, 34, 14], ["12%", 120, 392, 34, 14], ["10%", 120, 360, 34, 14], ["C O", 79, 351, 32, 12], ["O", 101, 339, 10, 10], ["t 9 8%", 76, 328, 78, 15], ["6%", 129, 295, 25, 14], ["2%", 129, 235, 25, 14], ["0%", 129, 204, 25, 14]]),
      axis([["0 0.8", 145, 638, 27, 11], ["a", 145, 624, 5, 6], ["E", 145, 614, 5, 9], ["S", 145, 605, 5, 5], ["UP 0.6", 145, 585, 27, 13], ["O", 145, 572, 5, 6], ["0.4", 159, 536, 13, 8], ["0.2", 158, 483, 13, 8]]),
      axis([["140,000", 72, 448, 18, 4], ["120,000", 72, 436, 18, 4], ["a", 65, 431, 4, 6], ["100,000", 72, 426, 18, 4], ["E", 65, 422, 4, 5], ["80,000", 73, 414, 16, 4], ["60,000", 73, 403, 16, 4], ["40,000", 73, 392, 16, 4]]),
    ]
    for (const ocr of cases) {
      ocr.push(paragraph("Chart title", 220, 710, 100, 10))
      const blocks: IRBlock[] = []
      mergeOcrImageRegions(blocks, 1, [{ x1: 50, y1: 200, x2: 500, y2: 740 }], ocr)
      assert.ok(!blocks.some(b => /^[\p{L}\p{N}]$/u.test(b.text ?? "")), JSON.stringify(blocks.map(b => b.text)))
      for (const label of ocr.filter(b => (b.text?.match(/[\p{L}\p{N}]/gu)?.length ?? 0) >= 2)) {
        assert.ok(blocks.some(b => b.text === label.text), label.text)
      }
    }
  })
  it("retains a genuine single-digit tick aligned with the numeric axis", () => {
    const ocr = [paragraph("Resource chart", 150, 250, 100), paragraph("12", 123, 220, 7, 5), paragraph("10", 123, 201, 8, 5), paragraph("IE 8", 114, 181, 16, 6), paragraph("6", 126, 162, 4, 6), paragraph("E 4", 114, 142, 16, 6), paragraph("E", 113, 138, 6, 3), paragraph("2", 127, 123, 3, 5)]
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [region], ocr)
    assert.ok(blocks.some(b => b.text === "6"))
  })
  it("retains separate diagram nodes even beside a narrow column of numeric labels", () => {
    const ocr = [paragraph("Diagram nodes", 160, 300), paragraph("10", 190, 260, 10, 6), paragraph("20", 190, 225, 10, 6), paragraph("30", 190, 190, 10, 6), paragraph("A", 180, 245, 5, 6), paragraph("B", 180, 210, 5, 6)]
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [region], ocr)
    assert.ok(blocks.some(b => b.text === "A"))
    assert.ok(blocks.some(b => b.text === "B"))
  })
  it("retains adjacent labels when no numeric axis column is established", () => {
    const ocr = [paragraph("Diagram nodes", 160, 300), paragraph("10", 180, 260, 10, 6), paragraph("20", 180, 220, 10, 6), paragraph("A", 165, 245, 5, 6), paragraph("B", 165, 235, 5, 6)]
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [region], ocr)
    assert.ok(blocks.some(b => b.text === "A"))
    assert.ok(blocks.some(b => b.text === "B"))
  })
  it("retains adjacent diagram labels when a numeric axis is far away", () => {
    const ocr = [paragraph("Diagram nodes", 160, 300, 90), paragraph("10 20", 150, 260, 50, 6), paragraph("30 40", 150, 225, 50, 6), paragraph("A", 160, 245, 5, 6), paragraph("B", 160, 235, 5, 6), paragraph("10", 350, 270, 10, 6), paragraph("20", 350, 230, 10, 6), paragraph("30", 350, 190, 10, 6)]
    for (const scale of [0.75, 1, 2]) {
      const scaled = ocr.map(b => ({ ...b, bbox: { ...b.bbox!, x: b.bbox!.x * scale, y: b.bbox!.y * scale, width: b.bbox!.width * scale, height: b.bbox!.height * scale } }))
      const blocks: IRBlock[] = []
      mergeOcrImageRegions(blocks, 1, [{ x1: region.x1 * scale, y1: region.y1 * scale, x2: region.x2 * scale, y2: region.y2 * scale }], scaled)
      assert.deepEqual(blocks.filter(b => b.text === "A" || b.text === "B").map(b => b.bbox), scaled.slice(3, 5).map(b => b.bbox))
    }
  })
  it("continues to reject isolated OCR noise without diagram evidence", () => {
    for (const ocr of [[paragraph("p", 160, 240, 6)], [paragraph("Title", 160, 270), paragraph("p", 160, 240, 6), paragraph("Body words", 140, 215)]]) {
      const blocks: IRBlock[] = []
      mergeOcrImageRegions(blocks, 1, [region], ocr)
      assert.ok(!blocks.some(b => b.text === "p"))
    }
  })
  it("rejects unanchored, outside-image, oversized and native-text-covered labels", () => {
    for (const mode of ["unanchored", "outside", "oversized", "native"]) {
      const ocr = diagram(), p = ocr[1]
      if (mode === "unanchored") p.bbox!.x = 380
      if (mode === "outside") p.bbox!.y = 405
      if (mode === "oversized") p.bbox!.width = 100
      const blocks: IRBlock[] = mode === "native" ? [paragraph("Native body evidence", 155, 240, 30)] : []
      mergeOcrImageRegions(blocks, 1, [region], ocr)
      assert.ok(!blocks.some(b => b.text === "p"), mode)
    }
  })
})

describe("그림 영역 OCR 문단끼리 겹쳐도 버리지 않는다 (ODL 102 \"342 334\" 유실)", () => {
  it("같은 영역에서 넣은 OCR 줄은 다음 줄의 원문 겹침 검사 대상이 아니다", () => {
    const blocks: IRBlock[] = []
    const upper = paragraph("396 392 400- 369", 120, 300, 240, 14), lower = paragraph("342 334", 300, 290, 60, 14)
    mergeOcrImageRegions(blocks, 1, [region], [upper, lower])
    assert.deepEqual(blocks.map(b => b.text), ["396 392 400- 369", "342 334"])
  })

  it("텍스트층에 이미 있는 글과 겹치는 OCR 문단은 종전대로 건너뛴다", () => {
    const native = paragraph("342 334", 300, 290, 60, 14)
    const blocks: IRBlock[] = [native]
    mergeOcrImageRegions(blocks, 1, [region], [paragraph("342 334", 301, 290, 60, 14)])
    assert.equal(blocks.length, 1)
  })
})
