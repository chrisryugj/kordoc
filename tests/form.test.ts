/** 양식 필드 인식 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractFormFields, isLabelCell } from "../src/form/recognize.js"
import type { IRBlock, IRTable } from "../src/types.js"

function makeTable(rows: string[][]): IRTable {
  return {
    rows: rows.length,
    cols: rows[0]?.length || 0,
    cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
    hasHeader: rows.length > 1,
  }
}

describe("extractFormFields", () => {
  it("label-value 인접셀 패턴 인식", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: makeTable([
        ["성명", "홍길동"],
        ["소속", "교육부"],
        ["전화번호", "010-1234-5678"],
      ]),
    }]

    const result = extractFormFields(blocks)
    assert.ok(result.fields.length >= 3, `필드 수: ${result.fields.length}`)
    assert.ok(result.fields.some(f => f.label === "성명" && f.value === "홍길동"))
    assert.ok(result.fields.some(f => f.label === "소속" && f.value === "교육부"))
    assert.ok(result.fields.some(f => f.label === "전화번호"))
    assert.ok(result.confidence > 0)
  })

  it("헤더+데이터 행 패턴", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: makeTable([
        ["이름", "직급", "부서"],
        ["홍길동", "과장", "교육부"],
        ["김철수", "대리", "총무부"],
      ]),
    }]

    const result = extractFormFields(blocks)
    assert.ok(result.fields.length >= 4, `필드 수: ${result.fields.length}`)
  })

  it("인라인 '라벨: 값' 패턴", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "성명: 홍길동, 소속: 교육부" },
    ]

    const result = extractFormFields(blocks)
    assert.ok(result.fields.some(f => f.label === "성명" && f.value === "홍길동"))
    assert.ok(result.fields.some(f => f.label === "소속" && f.value === "교육부"))
  })

  it("테이블 없는 문서 → 빈 결과", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "이것은 일반 텍스트입니다." },
    ]
    const result = extractFormFields(blocks)
    assert.equal(result.fields.length, 0)
    assert.equal(result.confidence, 0)
  })

  it("빈 블록 배열", () => {
    const result = extractFormFields([])
    assert.equal(result.fields.length, 0)
  })

  it("4열 양식 테이블 (label-value-label-value)", () => {
    const blocks: IRBlock[] = [{
      type: "table",
      table: makeTable([
        ["성명", "홍길동", "생년월일", "1990-01-01"],
        ["주소", "서울시 강남구", "전화번호", "010-1234-5678"],
      ]),
    }]

    const result = extractFormFields(blocks)
    assert.ok(result.fields.length >= 4, `필드 수: ${result.fields.length}`)
    assert.ok(result.fields.some(f => f.label === "생년월일" && f.value === "1990-01-01"))
  })

  it("병합셀로 행 길이가 cols보다 짧은 표(ragged)에서 크래시하지 않음", () => {
    // DOCX 병합셀(colSpan/vMerge)은 cells[r] 길이 < table.cols 인 ragged 행을 만든다.
    // extractFromTable이 cells[r][c]를 무가드로 인덱싱하면 undefined.text 크래시.
    const table: IRTable = {
      rows: 3,
      cols: 4,
      hasHeader: true,
      cells: [
        [{ text: "제목 한 줄", colSpan: 4, rowSpan: 1 }],        // 1칸이 4열 차지
        [{ text: "성명", colSpan: 1, rowSpan: 1 }, { text: "홍길동", colSpan: 3, rowSpan: 1 }],
        [{ text: "비고", colSpan: 1, rowSpan: 1 }],               // 행 길이 < cols
      ],
    }
    const blocks: IRBlock[] = [{ type: "table", table }]
    const result = extractFormFields(blocks)  // 크래시하지 않아야 함
    assert.ok(result.fields.some(f => f.label === "성명" && f.value === "홍길동"))
  })
})

describe("isLabelCell — 라벨 인식 확장 (v3.7 P3)", () => {
  it("숫자 낀 라벨을 인식한다", () => {
    for (const label of ["연번1", "제1항목", "1차소속", "구조1대장"]) {
      assert.ok(isLabelCell(label), `라벨 인정: ${label}`)
    }
  })

  it("수량/단위 값은 라벨이 아니다", () => {
    for (const value of ["6개월", "1억원", "5백만원", "2026년", "100원", "3명", "제3회"]) {
      assert.ok(!isLabelCell(value), `값 거부: ${value}`)
    }
  })

  it("9자 이상 한글 라벨(직위/기관명)을 인식한다", () => {
    for (const label of ["제1소위원회위원장", "서울특별시은평병원", "정보통신담당관실"]) {
      assert.ok(isLabelCell(label), `라벨 인정: ${label}`)
    }
  })

  it("서술형 문구·법인명·3어절 이상 제목은 라벨이 아니다", () => {
    for (const t of ["해당없음", "제출하시기바랍니다", "(주)원트리즈뮤직", "주식회사한글", "교통영향평가 심의 진행 절차"]) {
      assert.ok(!isLabelCell(t), `거부: ${t}`)
    }
  })

  it("자간 공백 라벨(업 체 명)은 계속 인식한다", () => {
    for (const label of ["업 체 명", "유 효 기 한", "의 약 품 명", "수 신 자"]) {
      assert.ok(isLabelCell(label), `라벨 인정: ${label}`)
    }
  })

  it("콜론 없는 영문 라벨은 관행 단어만 인정한다", () => {
    for (const label of ["Name", "Dept", "Date of Birth", "E-mail", "Tel"]) {
      assert.ok(isLabelCell(label), `라벨 인정: ${label}`)
    }
    for (const t of ["Seoul", "Approved", "Hello World Test"]) {
      assert.ok(!isLabelCell(t), `거부: ${t}`)
    }
  })
})

describe("extractFormFields — 틀 셀 blocks 안 중첩표 (v4.12.2)", () => {
  it("1칸 틀 안에 중첩된 신청인 정보 표의 라벨-값도 필드로 잡는다 (fillHwpx DFS 와 같은 경계)", () => {
    const inner: IRTable = {
      rows: 2, cols: 2, hasHeader: false,
      cells: [
        [{ text: "성명", colSpan: 1, rowSpan: 1 }, { text: "홍길동", colSpan: 1, rowSpan: 1 }],
        [{ text: "연락처", colSpan: 1, rowSpan: 1 }, { text: "02-123-4567", colSpan: 1, rowSpan: 1 }],
      ],
    }
    const frame: IRBlock = {
      type: "table",
      table: {
        rows: 1, cols: 1, hasHeader: false,
        cells: [[{
          text: "신청서\n성명\n홍길동\n연락처\n02-123-4567",
          colSpan: 1, rowSpan: 1,
          blocks: [{ type: "paragraph", text: "신청서" }, { type: "table", table: inner }],
        }]],
      },
    }
    const r = extractFormFields([frame])
    assert.deepEqual(r.fields.map(f => [f.label, f.value]), [["성명", "홍길동"], ["연락처", "02-123-4567"]])
  })
})
