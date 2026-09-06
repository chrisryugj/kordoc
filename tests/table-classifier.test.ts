/** #76 — 표 분류기 픽스처 매트릭스. 임계값은 여기 픽스처가 근거 (바꾸면 어떤 픽스처가 움직이는지 설명할 것) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { classifyTable } from "../src/table/classifier.js"
import type { IRCell, IRTable, TableClassificationKind, TableClassificationSummary } from "../src/types.js"

const cell = (text: string, colSpan = 1, rowSpan = 1, extra: Partial<IRCell> = {}): IRCell => ({ text, colSpan, rowSpan, ...extra })
/** 문자열 격자 → IRTable. "" 은 빈 셀, "@" 로 시작하면 병합 커버 칸(무시) */
function tbl(rows: (string | IRCell)[][], extra: Partial<IRTable> = {}): IRTable {
  const cells = rows.map(r => r.map(c => (typeof c === "string" ? cell(c) : c)))
  return { rows: cells.length, cols: Math.max(...cells.map(r => r.length)), cells, hasHeader: cells.length > 1, ...extra }
}
const kindOf = (t: IRTable, near?: string[]): TableClassificationKind => classifyTable(t, { nearbyText: near }).kind
// 분류 계약 타입은 공개 타입 모듈에서 온다 (Task 1)
const isSummary = (s: TableClassificationSummary) => typeof s.confidence === "number" && Array.isArray(s.reasons)

describe("table classifier — semantic", () => {
  it("규칙적 밀집 데이터표 → semantic-table (repeated-row-schema·grid-regularity)", () => {
    const s = classifyTable(tbl([["이름", "부서", "인원"], ["홍길동", "개발", "10"], ["김철수", "기획", "7"], ["이영희", "영업", "12"], ["박민수", "총무", "3"]]))
    assert.equal(s.kind, "semantic-table", JSON.stringify(s))
    assert.ok(s.reasons.includes("repeated-row-schema") && s.reasons.includes("grid-regularity"))
    assert.ok(isSummary(s))
  })
  it("숫자·날짜 반복 열 → semantic (column-type-consistency)", () => {
    const s = classifyTable(tbl([["일자", "건수", "금액"], ["2026. 1. 5.", "12", "1,200,000"], ["2026. 2. 3.", "8", "800,000"], ["2026. 3. 1.", "15", "1,500,000"], ["2026. 4. 2.", "9", "900,000"]]))
    assert.equal(s.kind, "semantic-table", JSON.stringify(s))
    assert.ok(s.reasons.includes("column-type-consistency"))
  })
  it("헤더 병합(colspan) 데이터표는 여전히 semantic", () => {
    const s = classifyTable(tbl([[cell("구분", 2), "예산"], ["사업", "세부1", "100"], ["사업", "세부2", "200"], ["운영", "세부3", "300"], ["운영", "세부4", "400"]]))
    assert.equal(s.kind, "semantic-table", JSON.stringify(s))
  })
  it("조직도 키워드가 근처에 있어도 정상 표는 semantic 유지(키워드 단독 무력)", () => {
    const t = tbl([["이름", "부서", "인원"], ["홍길동", "개발", "10"], ["김철수", "기획", "7"], ["이영희", "영업", "12"]])
    const s = classifyTable(t, { nearbyText: ["조직도"] })
    assert.equal(s.kind, "semantic-table", JSON.stringify(s))
    assert.ok(!s.reasons.includes("diagram-context-keyword"))
  })
})

describe("table classifier — non-tabular", () => {
  it("희소 조직도(빈 띠·불규칙 병합) → non-tabular-layout", () => {
    // 7×5 격자, 기관장 1칸(3열 병합)·본부 2칸, 나머지 빈칸 + 빈 행/열
    const rows: (string | IRCell)[][] = [
      ["", "", cell("기관장", 1, 1), "", ""],
      ["", "", "", "", ""],
      ["", cell("기획본부"), "", cell("사업본부"), ""],
      ["", "", "", "", ""],
      [cell("기획팀"), "", cell("총무팀"), "", cell("사업팀")],
      ["", "", "", "", ""],
      ["", "", "", "", ""],
    ]
    const s = classifyTable(tbl(rows))
    assert.equal(s.kind, "non-tabular-layout", JSON.stringify(s))
    assert.ok(s.reasons.includes("spacer-bands") || s.reasons.includes("extreme-sparsity"))
  })
  it("비상연락망 — 구조 증거 + 키워드 → non-tabular, reasons 에 diagram-context-keyword", () => {
    const rows: (string | IRCell)[][] = [
      ["", cell("당직실 02-120", 3), "", "", ""],
      ["", "", "", "", ""],
      [cell("총무과"), "", cell("시설과"), "", cell("보안과")],
      ["", "", "", "", ""],
      ["", "", "", "", ""],
    ]
    const s = classifyTable(tbl(rows), { nearbyText: ["비상연락망"] })
    assert.equal(s.kind, "non-tabular-layout", JSON.stringify(s))
    assert.ok(s.reasons.includes("diagram-context-keyword"))
  })
  it("불규칙 병합 레이아웃(행마다 셀 수 제각각·본문 병합 다수) → non-tabular", () => {
    const rows: (string | IRCell)[][] = [
      [cell("제목 띠", 4)],
      [cell("좌", 1, 3), cell("가", 2), "다"],
      [cell("나", 3)],
      ["라", cell("마", 2)],
      [cell("바", 4)],
    ]
    const s = classifyTable(tbl(rows))
    assert.equal(s.kind, "non-tabular-layout", JSON.stringify(s))
    assert.ok(s.reasons.includes("span-irregularity"))
  })
  it("1×1 래퍼(셀에 중첩표) → non-tabular(nested-structure-wrapper)", () => {
    const inner = tbl([["a", "b"], ["1", "2"], ["3", "4"]])
    const s = classifyTable(tbl([[cell("", 1, 1, { blocks: [{ type: "table", table: inner }] })]]))
    assert.equal(s.kind, "non-tabular-layout")
    assert.deepEqual(s.reasons, ["nested-structure-wrapper"])
  })
})

describe("table classifier — uncertain", () => {
  it("작은 2×2·1×1 평문 메모는 uncertain(low-evidence)", () => {
    assert.equal(kindOf(tbl([["a", "b"], ["c", "d"]])), "uncertain")
    const memo = classifyTable(tbl([["※ 유의사항\n1. 신청서는 방문 제출\n2. 기한 엄수"]]))
    assert.equal(memo.kind, "uncertain")
    assert.ok(memo.reasons.includes("low-evidence"))
  })
  it("빈 서식 표(라벨|빈칸 반복)는 semantic 으로 단정하지 않는다", () => {
    const s = classifyTable(tbl([["성명", "", "생년월일", ""], ["주소", "", "연락처", ""], ["소속", "", "직위", ""], ["비고", cell("", 3)]]))
    assert.notEqual(s.kind, "semantic-table", JSON.stringify(s))
  })
})
