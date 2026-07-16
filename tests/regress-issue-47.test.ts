/** #47 — 표 오른쪽 끝 빈 열 삭제로 서식 입력란 소실 (앵커 기반 트림으로 수정) */
import { describe, it } from "node:test"
import assert from "node:assert"
import { buildTable } from "../src/table/builder.js"
import { markdownToHwpx, parseHwpx } from "../src/index.js"

describe("#47 후행 빈 열 보존", () => {
  it("서식 표의 빈 입력란 열이 왕복에서 보존된다 (이슈 재현)", async () => {
    const hwpx = await markdownToHwpx("| 성명 |  |\n| --- | --- |\n| 연락처 |  |\n")
    const r = await parseHwpx(hwpx)
    assert.ok(r.success)
    const t = r.blocks.filter(b => b.type === "table")[0].table!
    assert.equal(t.cols, 2, "빈 입력란 열이 트림됨")
    assert.equal(t.cells[0].length, 2)
  })

  it("앵커 있는 빈 후행 열은 보존, 앵커 없는 유령 열(span 인플레이션)은 트림", () => {
    // 행1: colSpan 3 인플레이션(앵커 col0만), 행2: 앵커 col0 — col1·2는 유령 → 트림
    const phantom = buildTable([
      [{ text: "a", colSpan: 3, rowSpan: 1 }],
      [{ text: "b", colSpan: 1, rowSpan: 1 }],
    ])
    assert.equal(phantom.cols, 1)

    // 명시적 빈 셀 앵커가 후행 열에 있으면 보존
    const anchored = buildTable([
      [{ text: "성명", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
      [{ text: "연락처", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
    ])
    assert.equal(anchored.cols, 2)
  })

  it("cellAddr 직접 배치 경로도 동일 (HWPX/HWP5)", () => {
    const t = buildTable([
      [
        { text: "성명", colSpan: 1, rowSpan: 1, colAddr: 0, rowAddr: 0 },
        { text: "", colSpan: 1, rowSpan: 1, colAddr: 1, rowAddr: 0 },
      ],
    ])
    assert.equal(t.cols, 2)
  })

  it("스프레드시트(trimTrailingEmptyCols)는 기존 텍스트 기준 트림 유지", () => {
    const t = buildTable(
      [
        [{ text: "값", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }],
      ],
      { trimTrailingEmptyCols: true },
    )
    assert.equal(t.cols, 1)
  })

  it("가운데 빈 열은 어느 모드에서도 보존 (기존 계약)", () => {
    const t = buildTable(
      [
        [{ text: "a", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }, { text: "c", colSpan: 1, rowSpan: 1 }],
      ],
      { trimTrailingEmptyCols: true },
    )
    assert.equal(t.cols, 3)
  })
})
