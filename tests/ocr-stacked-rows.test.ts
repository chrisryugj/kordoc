/** OCR 표 쌓인 행 가르기 — 행 사이 괘선 없는 통계표에서 한 칸에 줄바꿈으로 쌓인 여러 행 숫자를 행으로 나눈다 (src/ocr/ocr-stacked-rows.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { splitStackedOcrRows } from "../src/ocr/ocr-stacked-rows.js"
import type { IRBlock, IRCell } from "../src/types.js"

const c = (text: string, colSpan = 1, rowSpan = 1): IRCell => ({ text, colSpan, rowSpan })
const table = (cells: IRCell[][]): IRBlock => ({ type: "table", table: { rows: cells.length, cols: cells[0].length, cells, hasHeader: true } })

it("splits a row whose numeric cells are stacked into k lines (통계 보도자료 성·연령별 사망률)", () => {
  const b = table([[c("2014"), c("2023"), c("2024p")], [c("3.1\n0.1\n0.2\n0.4\n0.8"), c("2.4\n0.1\n0.2\n0.4\n0.7"), c("2.5\n0.1\n0.2\n0.4")]])
  splitStackedOcrRows([b])
  assert.equal(b.table!.rows, 6)
  assert.deepEqual(b.table!.cells.map(r => r.map(x => x.text)).slice(1, 3), [["3.1", "2.4", "2.5"], ["0.1", "0.1", "0.1"]])
  // 한 줄 모자란 칸은 아래를 비운다
  assert.deepEqual(b.table!.cells[5].map(x => x.text), ["0.8", "0.7", ""])
})

it("leaves wrapped prose cells and single stacked cells alone", () => {
  const prose = table([[c("기관명"), c("지원 내용")], [c("한국\n고용정보원"), c("청년 일자리\n상담 지원")]])
  splitStackedOcrRows([prose])
  assert.equal(prose.table!.rows, 2)
  const one = table([[c("구분"), c("값")], [c("가"), c("1.0\n2.0")]])
  splitStackedOcrRows([one])
  assert.equal(one.table!.rows, 2)
})
