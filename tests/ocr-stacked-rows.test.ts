/** OCR 표 쌓인 행 가르기 — 행 사이 괘선 없는 통계표에서 한 칸에 줄바꿈으로 쌓인 여러 행 숫자를 행으로 나눈다 (src/ocr/ocr-stacked-rows.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { splitStackedOcrRows, unframeOcrLayoutTables } from "../src/ocr/ocr-stacked-rows.js"
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

it("splits rows covered by a row span from above and grows that span (주택 소유 통계 연도 열)", () => {
  const year = c("2023", 1, 3)
  const b = table([
    [year, c("구분"), c("합계"), c("비중")],
    [c(""), c("연제구\n수영구"), c("74,454\n68,769"), c("(71.1)\n(66.1)")],
    [c(""), c("대구"), c("785,607"), c("(78.2)")],
  ])
  splitStackedOcrRows([b])
  assert.equal(b.table!.rows, 4)
  assert.equal(b.table!.cells[0][0].rowSpan, 4)
  assert.deepEqual(b.table!.cells.slice(1).map(r => r.slice(1).map(x => x.text)), [["연제구", "74,454", "(71.1)"], ["수영구", "68,769", "(66.1)"], ["대구", "785,607", "(78.2)"]])
})

const box = (b: IRBlock, height: number): IRBlock => ({ ...b, pageNumber: 1, bbox: { page: 1, x: 80, y: 120, width: 660, height } })

it("unframes a page-tall exam layout grid column by column (수능 한국사 문항 상자)", () => {
  const exam = box(table([
    [c("1. (가) 시대에 대한 설명으로 옳은 것은?"), c("3. 밑줄 친 왕에 대한 설명으로 옳은 것은?")],
    [c("①비파형 동검을 제작하였다. ②석굴암을 만들었다."), c("①고려를 건국하였다. ②대가야를 정복하였다.")],
  ]), 900)
  const out = unframeOcrLayoutTables([exam], 1100)
  assert.deepEqual(out.map(b => b.type), ["paragraph", "paragraph", "paragraph", "paragraph"])
  // 왼쪽 단 위→아래 다음 오른쪽 단
  assert.match(out[1].text!, /^①비파형/)
  assert.match(out[2].text!, /^3\./)
})

it("keeps forms, short tables and number grids framed", () => {
  // 선택지 부호 없는 긴 글 칸 서식(신청서 안내문)
  const form = box(table([[c("신청인"), c("성명 및 주소를 적고 대리인 선임 사유를 구체적으로 기재합니다")], [c("유의사항"), c("허가 신청은 처분청에 제출하며 처리기간은 7일입니다")]]), 900)
  // 쪽 높이 절반 못 미치는 문항 표
  const small = box(table([[c("①비파형 동검을 제작하였다. 다음 중 옳은 것은"), c("②석굴암 본존불상을 만들었다. 다음 중 옳은 것은")]]), 300)
  for (const b of [form, small]) assert.equal(unframeOcrLayoutTables([b], 1100)[0].type, "table")
})
