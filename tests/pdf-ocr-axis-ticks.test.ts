/**
 * 그림 영역 OCR 의 한 자리 눈금 — 같은 행이나 오른끝을 맞춘 열에 숫자 라벨이 둘 이상 더 있는 한 자리 숫자는 눈금으로 받고(ODL 027),
 * 같은 줄 조각은 왼→오로 넣는다(ODL 128). 범례 라벨과 먼 축 눈금은 위→아래 그대로(ODL 057).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mergeOcrImageRegions } from "../src/pdf/ocr-region-merge.js"
import type { IRBlock } from "../src/types.js"

const paragraph = (text: string, x: number, y: number, width: number, height: number): IRBlock =>
  ({ type: "paragraph", text, pageNumber: 1, bbox: { page: 1, x, y, width, height }, style: { fontName: "ocr", fontSize: height } })

describe("그림 영역 OCR 의 한 자리 눈금", () => {
  it("같은 행이나 오른끝 열에 숫자 라벨이 둘 이상 더 있는 한 자리 숫자는 눈금으로 받는다 (ODL 027)", () => {
    // 027 그림 7 기하: 세로 축 0,3~0,05 와 맨 아래 "0", 가로 축 1~6 중 OCR 이 따로 읽은 2·5·6, 회전 축 이름 조각 "년"·"A"
    const ocr = [
      paragraph("0,3", 127, 657, 9, 6), paragraph("0,25", 123, 638, 12, 6), paragraph("0,05", 123, 561, 12, 5), paragraph("0", 132, 542, 4, 5),
      paragraph("2", 205, 531, 3, 5), paragraph("3\t4", 247, 531, 46, 5), paragraph("5", 331, 531, 3, 5), paragraph("6", 373, 531, 4, 5),
      paragraph("Number of impellers", 235, 518, 69, 7), paragraph("년", 114, 411, 4, 5), paragraph("A", 114, 608, 4, 4),
    ]
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [{ x1: 100, y1: 400, x2: 420, y2: 700 }], ocr)
    const texts = blocks.map(b => b.text)
    for (const tick of ["0", "2", "5", "6"]) assert.ok(texts.includes(tick), JSON.stringify(texts))
    assert.ok(!texts.includes("년") && !texts.includes("A"), JSON.stringify(texts))
  })

  it("같은 줄 조각은 처리 순서와 무관하게 왼→오 (ODL 128 \"5 6 7 8 9 / 0 / 1 …\")", () => {
    const ocr = [
      paragraph("10", 58, 217, 8, 6), paragraph("5", 62, 196, 4, 6), paragraph("0", 62, 176, 4, 6),
      paragraph("5 6 7 8 9", 239, 165, 125, 6), paragraph("0", 88, 165, 4, 6), paragraph("1", 118, 165, 3, 6), paragraph("2", 148, 165, 4, 6),
      paragraph("10", 388, 165, 8, 6),
    ]
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [{ x1: 50, y1: 150, x2: 420, y2: 240 }], ocr)
    assert.deepEqual(blocks.map(b => b.text), ["10", "5", "0", "0", "1", "2", "5 6 7 8 9", "10"])
  })

  it("범례 라벨과 먼 축 눈금(중심 어긋남 0.33)은 같은 줄이 아니다 — 위→아래 (ODL 057)", () => {
    const blocks: IRBlock[] = []
    mergeOcrImageRegions(blocks, 1, [{ x1: 80, y1: 600, x2: 480, y2: 720 }], [paragraph("300", 93, 693, 15, 6), paragraph("Biogas", 372, 694, 26, 8)])
    assert.deepEqual(blocks.map(b => b.text), ["Biogas", "300"])
  })
})
