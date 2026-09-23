/**
 * builder 표 무결성·마크다운 이스케이프 회귀 (v4.14.3, rhwp 코퍼스 편입).
 *
 * - buildTableDirect: 셀 글을 어떤 경우에도 버리지 않고 IR 불변식(모든 span 이 표 안, 병합 덮개 아래
 *   앵커 없음)을 지킨다 — 빈 <hp:tr/>·앵커 충돌·주소 없는 셀 (셀 주소 표 공용 경로)
 * - escapeGfm: 리터럴 | · 줄 첫 ATX # · 원시 HTML 로 읽힐 < 를 이스케이프, 한글·숫자 뒤따르는 <…> 와
 *   kordoc 자신의 <u> 는 그대로
 * - 중첩표 담은 표는 수식이 섞여도 HTML (GFM 평탄화로 구조 소실 금지), 통째로 덮인 행은 빈 <tr></tr>
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { buildTable, blocksToMarkdown, escapeGfm } from "../src/table/builder.js"
import type { CellContext, IRBlock, IRTable } from "../src/types.js"

/** IR 표 불변식 위반 목록 — 행 길이·span 초과·병합 덮개 아래 글 있는 앵커 (lead probe_kordoc 규칙) */
export function tableInvariantViolations(t: IRTable): string[] {
  const out: string[] = []
  const covered = new Set<string>()
  for (let r = 0; r < t.rows; r++) {
    const row = t.cells[r] ?? []
    if (row.length !== t.cols) out.push(`ragged r${r}`)
    for (let c = 0; c < row.length; c++) {
      const cell = row[c]
      if (covered.has(`${r},${c}`)) {
        if (cell.text.trim()) out.push(`anchor under span (${r},${c}) "${cell.text}"`)
        continue
      }
      if (r + cell.rowSpan > t.rows || c + cell.colSpan > t.cols) out.push(`span overflow (${r},${c}) ${cell.rowSpan}x${cell.colSpan}`)
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) if (dr || dc) covered.add(`${r + dr},${c + dc}`)
      }
    }
  }
  return out
}

const cell = (text: string, colAddr?: number, rowAddr?: number, colSpan = 1, rowSpan = 1): CellContext =>
  ({ text, colSpan, rowSpan, ...(colAddr !== undefined ? { colAddr } : {}), ...(rowAddr !== undefined ? { rowAddr } : {}) })

const allText = (t: IRTable) => t.cells.flat().map(c => c.text).join("|")

describe("buildTableDirect — 셀 글 무손실·IR 불변식", () => {
  it("빈 <hp:tr/> 이 빠져 행 수보다 큰 rowAddr 도 격자를 늘려 싣는다 (종전: 9~12 소실)", () => {
    // 1행 네 칸이 rowSpan 2 로 2행을 통째로 덮고, 3행 앵커는 rowAddr=2 — 행 목록엔 2줄뿐
    const rows = [
      [0, 1, 2, 3].map(c => cell(String(c + 1), c, 0, 1, 2)),
      [0, 1, 2, 3].map(c => cell(String(c + 9), c, 2)),
    ]
    const t = buildTable(rows)
    assert.equal(t.rows, 3)
    assert.equal(t.cells[2][0].text, "9")
    assert.equal(t.cells[2][3].text, "12")
    assert.deepEqual(tableInvariantViolations(t), [])
  })

  it("같은 칸 충돌은 먼저 온 셀이 갖고 뒤 셀 글은 이어 붙인다 (병합 덮개 아래 앵커 금지)", () => {
    const rows = [
      [cell("1", 0, 0, 1, 2), cell("2", 1, 0)],
      [cell("5", 0, 1), cell("6", 1, 1)], // (1,0) 은 "1" 의 rowSpan 덮개
    ]
    const t = buildTable(rows)
    assert.equal(t.cells[0][0].text, "1\n5")
    assert.equal(t.cells[1][1].text, "6")
    assert.deepEqual(tableInvariantViolations(t), [])
    assert.ok(allText(t).includes("5"))
  })

  it("주소 없는 셀은 자기 tr 행의 첫 빈 칸 (종전: (0,0) 덮어쓰기)", () => {
    const rows = [
      [cell("A", 0, 0), cell("B", 1, 0)],
      [cell("C", 0, 1), cell("주소없음")],
    ]
    const t = buildTable(rows)
    assert.equal(t.cells[0][0].text, "A")
    assert.equal(t.cells[1][1].text, "주소없음")
    assert.deepEqual(tableInvariantViolations(t), [])
  })

  it("병합이 다른 앵커를 덮으려 하면 그 앞에서 자른다", () => {
    const rows = [
      [cell("가로", 0, 0, 3, 1), cell("선점", 2, 0)], // "선점"이 (0,2) 를 먼저 가진 게 아니라 뒤에 온다 → 가로가 갖고 선점 글은 이어 붙음
      [cell("x", 0, 1), cell("y", 1, 1), cell("z", 2, 1)],
    ]
    const t = buildTable(rows)
    assert.deepEqual(tableInvariantViolations(t), [])
    assert.ok(allText(t).includes("선점"))
    const rows2 = [
      [cell("선점", 2, 0), cell("가로", 0, 0, 3, 1)], // 선점이 먼저 — 가로 병합은 (0,2) 앞에서 잘린다
      [cell("x", 0, 1), cell("y", 1, 1), cell("z", 2, 1)],
    ]
    const t2 = buildTable(rows2)
    assert.deepEqual(tableInvariantViolations(t2), [])
    assert.equal(t2.cells[0][0].colSpan, 2)
    assert.equal(t2.cells[0][2].text, "선점")
  })

  it("후행 빈 열 트림 뒤에도 span 은 표 폭 안 (불변식)", () => {
    const rows = [
      [cell("1.", 0, 0), cell("", 1, 0), cell("제목", 2, 0, 2)],
      [0, 1, 2, 3].map(c => cell("", c, 1)),
    ]
    assert.deepEqual(tableInvariantViolations(buildTable(rows)), [])
  })
})

describe("escapeGfm — 리터럴 글의 마크다운 오해석 방지", () => {
  const md = (text: string) => blocksToMarkdown([{ type: "paragraph", text } as IRBlock])

  it("문단 리터럴 | 는 \\| (GFM 표 구분자와 구별), 이미 이스케이프된 \\| 는 그대로", () => {
    assert.equal(md("| 이형식 |"), "\\| 이형식 \\|")
    assert.equal(escapeGfm("a \\| b"), "a \\| b")
  })

  it("줄 첫 ATX # 은 \\# (본문 \"# arch -k\" 가 헤딩이 되던 것), 줄 중간·#include 는 그대로", () => {
    assert.equal(md("# arch -k"), "\\# arch -k")
    assert.equal(escapeGfm("텍스트\n## 둘째 줄"), "텍스트\n\\## 둘째 줄")
    assert.equal(escapeGfm("#include <x> 와 a # b"), "#include \\<x> 와 a # b")
  })

  it("원시 HTML 로 읽힐 < 만 \\< — <Table …>·<br> 글, 한글·숫자·공백 뒤따름과 kordoc <u> 는 그대로", () => {
    assert.equal(md("표 24. <Table 18-4: Living Donor>"), "표 24. \\<Table 18-4: Living Donor>")
    assert.equal(escapeGfm("document.write(\"<br>\")"), "document.write(\"\\<br>\")")
    for (const keep of ["<개정 2012.2.14>", "<신설>", "< 요약 >", "x<3", "<u>밑줄</u>"]) assert.equal(escapeGfm(keep), keep)
  })

  it("수식 스팬 안은 건드리지 않는다", () => {
    assert.equal(escapeGfm("$a|b<c$ | d"), "$a|b<c$ \\| d")
  })

  it("GFM 셀의 | 는 한 번만 이스케이프 (escapeGfm 뒤 셀 이스케이프와 중복 금지)", () => {
    const table: IRTable = {
      rows: 2, cols: 2, hasHeader: true,
      cells: [[{ text: "a|b", colSpan: 1, rowSpan: 1 }, { text: "c", colSpan: 1, rowSpan: 1 }],
        [{ text: "d", colSpan: 1, rowSpan: 1 }, { text: "e", colSpan: 1, rowSpan: 1 }]],
    }
    const out = blocksToMarkdown([{ type: "table", table }])
    assert.ok(out.includes("| a\\|b | c |"), out)
    assert.ok(!out.includes("\\\\|"), out)
  })
})

describe("blocksToMarkdown — 헤딩 문단의 각주", () => {
  it("헤딩 블록의 footnoteText 도 \" (주: …)\" 로 남는다 (종전: 헤딩 경로가 버림)", () => {
    const out = blocksToMarkdown([{ type: "heading", level: 2, text: "2. 미국76)", footnoteText: "76) 본 단원은 참고하였다." }])
    assert.equal(out, "## 2. 미국76) (주: 76) 본 단원은 참고하였다.)")
  })
})

describe("tableToMarkdown — 구조 보존", () => {
  it("중첩표를 담은 표는 셀 글에 수식이 있어도 HTML (GFM 평탄화로 중첩표 소실 금지)", () => {
    const inner: IRTable = { rows: 1, cols: 2, hasHeader: false, cells: [[{ text: "안1", colSpan: 1, rowSpan: 1 }, { text: "안2", colSpan: 1, rowSpan: 1 }]] }
    const table: IRTable = {
      rows: 1, cols: 1, hasHeader: false,
      cells: [[{ text: "수식 $x^2$ 과 표", colSpan: 1, rowSpan: 1, blocks: [
        { type: "paragraph", text: "수식 $x^2$ 과 표" },
        { type: "table", table: inner },
      ] }]],
    }
    const out = blocksToMarkdown([{ type: "table", table }])
    assert.equal((out.match(/<table>/g) ?? []).length, 2, out)
  })

  it("위 행 rowspan 에 통째로 덮인 행도 빈 <tr></tr> 로 남는다 (행 수·병합 보존)", () => {
    const t = buildTable([
      [0, 1].map(c => cell(`윗${c}`, c, 0, 1, 2)),
      [0, 1].map(c => cell(`아래${c}`, c, 2)),
    ])
    const out = blocksToMarkdown([{ type: "table", table: t }])
    assert.equal((out.match(/<tr>/g) ?? []).length, 3, out)
    assert.ok(out.includes("<tr></tr>"), out)
  })
})

describe("buildTableDirect — 손상 좌표 방어", () => {
  it("거대 rowAddr 하나가 격자를 MAX_ROWS 로 키우지 않고, 그 셀 글은 버리지 않는다", () => {
    const t = buildTable([[cell("A", 0, 0), cell("B", 1, 0)], [cell("멀리", 0, 99999)]])
    assert.ok(t.rows <= 2 + 3 + 1, `rows=${t.rows} — tr 수 + 셀 수 + 1 이 상한`)
    assert.ok(allText(t).includes("멀리"))
    assert.deepEqual(tableInvariantViolations(t), [])
  })
})
