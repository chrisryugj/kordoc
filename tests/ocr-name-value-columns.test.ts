/** OCR 표 이름·값 열 가르기 — 세로선 없이 빈칸으로 가른 "국적 | 입국자" 가 한 칸에 붙은 순위표 열을 두 열로 나눈다 (src/ocr/ocr-name-value-columns.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { splitOcrNameValueColumns } from "../src/ocr/ocr-name-value-columns.js"
import type { IRBlock, IRCell } from "../src/types.js"

const c = (text: string, colSpan = 1, rowSpan = 1): IRCell => ({ text, colSpan, rowSpan })
const table = (cells: IRCell[][]): IRBlock => ({ type: "table", table: { rows: cells.length, cols: cells[0].length, cells, hasHeader: true } })
const texts = (b: IRBlock) => b.table!.cells.map(r => r.map(x => x.text))

it("splits name+value columns of a rank table and their header cells (국적별 입국자 상위 10개국)", () => {
  const rank = c("순위", 1, 2)
  const b = table([
    [rank, c("2000"), c("2005")],
    [c(""), c("국 적입국자"), c("국적 입국자")],
    [c("1"), c("중국64,822"), c("중 국115,811")],
    [c("2"), c("미 국13,294"), c("베트남18,046")],
    [c("3"), c("필리핀12,745"), c("미 국 813")],
    [c("4"), c("인도네 7,827\n시아"), c("필리핀16,529")],
    [c("5"), c("러시아 6,492\n(연방)"), c("태 국13,671")],
  ])
  splitOcrNameValueColumns([b])
  assert.equal(b.table!.cols, 5)
  assert.deepEqual(texts(b).map(r => r.length), [5, 5, 5, 5, 5, 5, 5])
  // 묶음 머리는 두 열에 걸친다
  assert.deepEqual([b.table!.cells[0][1].colSpan, b.table!.cells[0][3].colSpan], [2, 2])
  // 글자 띄운 머리 "국 적입국자" 는 다른 머리 칸이 보인 갈림을 따른다
  assert.deepEqual(texts(b)[1].slice(1), ["국 적", "입국자", "국적", "입국자"])
  assert.deepEqual(texts(b)[2], ["1", "중국", "64,822", "중 국", "115,811"])
  assert.deepEqual(texts(b)[5].slice(1, 3), ["인도네 시아", "7,827"])
  assert.deepEqual(texts(b)[4].slice(3), ["미 국", "813"])
})

it("leaves numbered labels and ordinary value columns alone", () => {
  const b = table([
    [c("구분"), c("내용")],
    [c("가"), c("제 1")], [c("나"), c("제 2")], [c("다"), c("제 3")], [c("라"), c("제 4")], [c("마"), c("제 5")],
  ])
  splitOcrNameValueColumns([b])
  assert.equal(b.table!.cols, 2)
  const v = table([[c("지역"), c("인구")], ...["서울", "부산", "대구", "인천", "광주"].map(n => [c(n), c("1,234")])])
  splitOcrNameValueColumns([v])
  assert.equal(v.table!.cols, 2)
})
