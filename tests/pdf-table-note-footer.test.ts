import { it } from "node:test"
import assert from "node:assert/strict"
import { removeHeaderFooterBlocks } from "../src/pdf/block-detect.js"
import type { IRBlock } from "../src/types.js"

function repeated(text: string, gap = 1, noteX = 50): IRBlock[] {
  return [1, 2, 3].flatMap(page => [
    { type: "table" as const, pageNumber: page, bbox: { page, x: 45, y: 97, width: 504, height: 600 } },
    { type: "paragraph" as const, text, pageNumber: page, bbox: { page, x: noteX, y: 97 - gap - 11, width: 269, height: 11 } },
  ])
}
const heights = new Map([[1, 830], [2, 830], [3, 830]])
it("반복 표 바로 아래 주석은 footer 영역에 들어가도 보존한다", () => {
  for (const label of ["주1) 2019a: 가계동향조사(소득부문)", "주: 통계 범위", "자료: 통계청", "출처: 공공데이터"]) {
    assert.deepEqual(removeHeaderFooterBlocks(repeated(label), heights, []), [])
  }
})
it("표와 떨어진 주석 모양 footer는 종전처럼 제거한다", () => {
  assert.deepEqual(removeHeaderFooterBlocks(repeated("자료: 통계청", 40), heights, []), [1, 3, 5])
})
it("표 옆의 반복 footer와 주석 표지 없는 running footer는 제거한다", () => {
  assert.deepEqual(removeHeaderFooterBlocks(repeated("자료: 통계청", 1, 550), heights, []), [1, 3, 5])
  assert.deepEqual(removeHeaderFooterBlocks(repeated("가계동향조사 보고서"), heights, []), [1, 3, 5])
})
