/**
 * 의사 표 강등(shouldDemoteTable)의 라벨 머리 행 가드. 머리 행이 두 칸씩 합친 칸이면 가려진 자리(기본값 빈 칸)를 빼고 본다.
 * 관보 자금 표("자금조달 | 자금운용" 머리, ○ 항목 본문 한 행)가 가려진 빈 자리 탓에 글 상자로 강등됐다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { shouldDemoteTable } from "../src/pdf/block-detect.js"
import type { IRCell, IRTable } from "../src/types.js"

const cell = (text: string, colSpan = 1): IRCell => ({ text, colSpan, rowSpan: 1 })

describe("shouldDemoteTable: 합친 칸 머리 행", () => {
  it("두 칸씩 합친 라벨 머리 행 + ○ 항목 본문은 표로 둔다", () => {
    const table: IRTable = {
      rows: 2, cols: 4,
      cells: [
        [cell("자금조달", 2), cell(""), cell("자금운용", 2), cell("")],
        [cell("○ 자체수입\n○ 차입금"), cell("23,943,000,000 원\n- 원"), cell("○ 사업비\n○ 기금운영비"), cell("20,940,000,000 원\n- 원")],
      ],
    }
    assert.equal(shouldDemoteTable(table), false)
  })

  it("합치지 않은 빈 머리 칸은 종전대로 가드를 타지 않는다", () => {
    const table: IRTable = {
      rows: 2, cols: 4,
      cells: [
        [cell("자금조달"), cell(""), cell("자금운용"), cell("")],
        [cell("○ 자체수입"), cell("23,943,000,000 원"), cell("○ 사업비"), cell("20,940,000,000 원")],
      ],
    }
    assert.equal(shouldDemoteTable(table), true)
  })
})
