import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { splitOcrProseRows } from "../src/ocr/ocr-prose-rows.js"
import type { IRBlock, IRCell } from "../src/types.js"

const c = (text: string, colSpan = 1, rowSpan = 1): IRCell => ({ text, colSpan, rowSpan })
const table = (cells: IRCell[][]): IRBlock => ({ type: "table", pageNumber: 1, table: { rows: cells.length, cols: 3, cells } })

describe("OCR 표 속 산문 행 (splitOcrProseRows)", () => {
  it("표 폭을 덮는 칸 하나짜리 문장 행 묶음을 문단으로 꺼내고 위·아래는 따로 표로", () => {
    const out = splitOcrProseRows([table([
      [c("능력"), c("높음"), c("낮음")],
      [c("의지"), c("높음"), c("낮음")],
      [c("피들러의 상황이론", 3), c(""), c("")],
      [c("특정상황에 적합한 리더 유형을 결정하기 위해서는 리더가 상황을 얼마나 통제할 수 있는가가 중요하다", 3), c(""), c("")],
      [c("상황"), c("우호적"), c("비우호적")],
      [c("관계"), c("좋음"), c("나쁨")],
    ])])
    assert.deepEqual(out.map(b => b.type), ["table", "paragraph", "paragraph", "table"])
    assert.equal(out[1].text, "피들러의 상황이론")
    assert.equal(out[0].table!.rows, 2)
    assert.equal(out[3].table!.cells[0][0].text, "상황")
  })

  it("짧은 전폭 행(묶음 머리·합계)만 있으면 그대로", () => {
    const b = table([
      [c("구분"), c("2023"), c("2024")],
      [c("【 총계 】", 3), c(""), c("")],
      [c("인구"), c("10"), c("12")],
    ])
    assert.deepEqual(splitOcrProseRows([b]), [b])
  })

  it("표 맨 끝 ※ 안내 행은 표에 둔다", () => {
    const b = table([
      [c("구분"), c("2023"), c("2024")],
      [c("인구"), c("10"), c("12")],
      [c("※본 시험결과는 해당 제품에 한하며, 시험 조건·환경 등에 따라 차이가 있을 수 있음", 3), c(""), c("")],
    ])
    assert.deepEqual(splitOcrProseRows([b]), [b])
  })

  it("표 맨 끝 * 각주 행도 표에 둔다 (신분증 표 \"* 단, 체류자격 변경 …\")", () => {
    const b = table([
      [c("규정 신분증*"), c("일반"), c("초·중·고등학생")],
      [c("한국어능력시험 신원확인증명서"), c("×"), c("○")],
      [c("* 단, 체류자격 변경 및 비자 연장 신청 등을 위하여 출입국·외국인청 등 공공기관에 신분증을 제출한 응시자가", 3), c(""), c("")],
    ])
    assert.deepEqual(splitOcrProseRows([b]), [b])
  })

  it("병합 칸이 끊는 자리를 가로지르면 그대로", () => {
    const b = table([
      [c("가", 1, 2), c("1"), c("2")],
      [c(""), c("특정상황에 적합한 리더 유형을 결정하기 위해서는 리더가 상황을 통제할 수 있어야 한다", 2), c("")],
      [c("나"), c("3"), c("4")],
    ])
    assert.deepEqual(splitOcrProseRows([b]), [b])
  })
})
