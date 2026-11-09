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

it("세로로 쌓은 이름표 글자(\"저/위\" → \"z / 위\")가 값 줄보다 적으면 한 덩이로 걸친다 (시도별 합계출산율)", () => {
  const b = table([
    [c("구분"), c("연도"), c("전국"), c("서울")],
    [c("z\n위"), c("2020\n2035\n2050"), c("0.84\n0.94\n1.02"), c("0.64\n0.71\n0.79")],
  ])
  splitStackedOcrRows([b])
  assert.equal(b.table!.rows, 4)
  assert.equal(b.table!.cells[1][0].rowSpan, 3)
  assert.deepEqual(b.table!.cells.slice(1).map(r => r.slice(1).map(x => x.text)), [["2020", "0.84", "0.64"], ["2035", "0.94", "0.71"], ["2050", "1.02", "0.79"]])
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

it("splits a value over its bracketed share into two rows, even when few columns carry shares (구성비 \"539,940 / (17.3)\")", () => {
  const pct = table([[c("연도"), c("전체"), c("확보")], [c("2018년"), c("1,315\n(100.0%)"), c("241\n(18.3%)")]])
  splitStackedOcrRows([pct])
  assert.deepEqual(pct.table!.cells.slice(1).map(r => r.map(x => x.text)), [["2018년", "1,315", "241"], ["", "(100.0%)", "(18.3%)"]])
  // 구성비 없는 열이 더 많아도 — 그 칸은 한 줄로 두 행에 걸친다
  const few = table([[c("구분"), c("2023"), c("2024"), c("2025"), c("인원"), c("세액")], [c("합계"), c("412,316"), c("408,276"), c("460,277"), c("539,940\n(17.3)"), c("17,134\n(6.3)")]])
  splitStackedOcrRows([few])
  assert.deepEqual(few.table!.cells.slice(1).map(r => r.map(x => x.text)), [["합계", "412,316", "408,276", "460,277", "539,940", "17,134"], ["", "", "", "", "(17.3)", "(6.3)"]])
  assert.equal(few.table!.cells[1][1].rowSpan, 2)
})

it("keeps a spanning text label whole and grows its span (2024년 / (구성비) 6행 걸침, 값 아래 구성비)", () => {
  const label = c("2024년\n(구성비)", 1, 2)
  const b = table([[label, c("▪ 정부기관"), c("218.7\n(100.0)"), c("30.1\n(100.0)")], [c(""), c("공무원"), c("147.1"), c("23.6")]])
  splitStackedOcrRows([b])
  assert.equal(b.table!.rows, 3)
  assert.equal(label.text, "2024년\n(구성비)")
  assert.equal(label.rowSpan, 3)
  assert.deepEqual(b.table!.cells.map(r => r.slice(2).map(x => x.text)), [["218.7", "30.1"], ["(100.0)", "(100.0)"], ["147.1", "23.6"]])
})

it("splits \"○ 항목 | 금액\" pairs stacked in one row, the shorter side leaving its last row blank (관보 자금조달·운용)", () => {
  const b = table([
    [c("자금조달", 2), c(""), c("자금운용", 2), c("")],
    [c("○자체수입\n○ 정부내부수입\n○차입금\n○ 여유자금회수등"), c("3,819,793,000,000원\n2,618,631,000,000원\n-원\n-원"),
      c("○사업비\n기금운영비\n○ 정부내부지출\n○ 차입금원리금상환\n여유자금운용등"), c("-원\n57,000,000원\n6,436,021,000,000원\n-원\n2,346,000,000원")],
  ])
  splitStackedOcrRows([b])
  assert.equal(b.table!.rows, 6)
  assert.deepEqual(b.table!.cells[2].map(x => x.text), ["○ 정부내부수입", "2,618,631,000,000원", "기금운영비", "57,000,000원"])
  assert.deepEqual(b.table!.cells[5].map(x => x.text), ["", "", "여유자금운용등", "2,346,000,000원"])
  // 금액 칸 없이 글만 쌓인 목록은 그대로
  const list = table([[c("구분"), c("내용")], [c("○ 가\n○ 나\n○ 다"), c("첫째 설명\n둘째 설명\n셋째 설명")]])
  splitStackedOcrRows([list])
  assert.equal(list.table!.rows, 2)
})

it("keeps a budget item with its amount breakdown (or fund-source lines) in one cell, but splits bare category lines (예산서 산출 내역·관보 기금 운용)", () => {
  const budget = table([
    [c("02 공공운영비"), c("14,944"), c("17,894")],
    [c("○센터 공공요금\n전기요금 5,600,000원\n—상하수도요금 250,000원"), c("6,770\n5,600\n250"), c("9,720\n6,600\n1,200")],
    [c("사회적기업육성"), c("526,657\n균 395,010"), c("771,250\n578,450")],
  ])
  splitStackedOcrRows([budget])
  assert.equal(budget.table!.rows, 3)
  const gazette = table([[c("○사업비\n-사회보험성\n-사업성"), c("1,991,955\n1,058,576\n780,325"), c("19.5\n10.3\n7.6")]])
  splitStackedOcrRows([gazette])
  assert.equal(gazette.table!.rows, 3)
  assert.deepEqual(gazette.table!.cells[1].map(x => x.text), ["-사회보험성", "1,058,576", "10.3"])
})
