import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { splitOcrContactColumns } from "../src/ocr/ocr-contact-columns.js"
import type { IRBlock, IRCell } from "../src/types.js"

const c = (text: string, rowSpan = 1, colSpan = 1): IRCell => ({ text, rowSpan, colSpan })
const table = (cells: IRCell[][]): IRBlock => ({ type: "table", table: { rows: cells.length, cols: cells[0].length, cells } })

describe("OCR 연락처 열 가르기 (splitOcrContactColumns)", () => {
  it("직급·이름·전화(메일) 칸 열을 세 열로 — 걸친 칸은 두 열 더 걸친다", () => {
    const b = table([
      [c("담당 부서", 4), c("재정경제부\n민생경제총괄과", 2), c("책임자"), c("과장 임혜영 (044-215-2810)")],
      [c(""), c(""), c("담당자"), c("주무관 송유찬 6chan@korea.kr")],
      [c(""), c("재정경제부\n물가정책과", 2), c("책임자"), c("과  장 양윤영(044-215-2820)")],
      [c(""), c(""), c("담당자"), c("사무관 박창규 ckpar k0916@korea.kr")],
    ])
    splitOcrContactColumns([b])
    const t = b.table!
    assert.equal(t.cols, 6)
    assert.deepEqual(t.cells[0].slice(3).map(x => x.text), ["과장", "임혜영", "(044-215-2810)"])
    assert.deepEqual(t.cells[2].slice(3).map(x => x.text), ["과  장", "양윤영", "(044-215-2820)"])
    assert.deepEqual(t.cells[3].slice(3).map(x => x.text), ["사무관", "박창규", "ckpark0916@korea.kr"])
    assert.ok(t.cells.every(row => row.length === 6))
  })

  it("꼴이 아닌 칸이 많으면 그대로", () => {
    const b = table([
      [c("구분"), c("내용")],
      [c("1"), c("과장 임혜영 (044-215-2810)")],
      [c("2"), c("주무관 송유찬 6chan@korea.kr")],
      [c("3"), c("세부 내용은 붙임 참조")],
    ])
    splitOcrContactColumns([b])
    assert.equal(b.table!.cols, 2)
  })
})
