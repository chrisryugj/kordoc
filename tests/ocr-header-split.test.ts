import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { splitOcrJoinedHeaders } from "../src/ocr/ocr-header-split.js"
import type { IRBlock, IRCell } from "../src/types.js"

const c = (text: string, colSpan = 1, rowSpan = 1): IRCell => ({ text, colSpan, rowSpan })
const table = (cells: IRCell[][]): IRBlock => ({ type: "table", table: { rows: cells.length, cols: cells[0].length, cells } })

describe("OCR 마지막 머리 행의 붙은 열 머리 (splitOcrJoinedHeaders)", () => {
  it("두 열에 걸친 \"도심 도시클러스터\" 를 열마다 한 칸으로 — 아래가 숫자 값일 때", () => {
    const b = table([
      [c("구분"), c("도시"), c("도심 도시클러스터", 2), c("")],
      [c("’00-’10년"), c("1.1"), c("1.3"), c("-1.0")],
      [c("’10-’21년"), c("0.7"), c("0.7"), c("-0.1")],
    ])
    splitOcrJoinedHeaders([b])
    assert.deepEqual(b.table!.cells[0].map(x => [x.text, x.colSpan]), [["구분", 1], ["도시", 1], ["도심", 1], ["도시클러스터", 1]])
  })

  it("아래에 하위 머리 행이 있는 묶음 머리는 그대로", () => {
    const b = table([
      [c("구분"), c("전년 대비", 2), c("")],
      [c(""), c("증감"), c("증감률")],
      [c("계"), c("2.0"), c("1.0")],
      [c("남"), c("1.5"), c("1.0")],
    ])
    splitOcrJoinedHeaders([b])
    assert.equal(b.table!.cells[0][1].colSpan, 2)
  })
})
