import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { flattenLayoutTables, buildTable } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

describe("flattenLayoutTables — 중첩표 구조 보존", () => {
  it("레이아웃 표 해체 시 cell.blocks의 중첩 3×3 표를 실제 table 블록으로 보존", () => {
    // 중첩 spec 표 (numRows=3 → 레이아웃 휴리스틱에 걸리지 않아 표로 살아남아야 함)
    const nested = buildTable([
      [{ text: "h1", colSpan: 1, rowSpan: 1 }, { text: "h2", colSpan: 1, rowSpan: 1 }, { text: "h3", colSpan: 1, rowSpan: 1 }],
      [{ text: "a1", colSpan: 1, rowSpan: 1 }, { text: "a2", colSpan: 1, rowSpan: 1 }, { text: "a3", colSpan: 1, rowSpan: 1 }],
      [{ text: "b1", colSpan: 1, rowSpan: 1 }, { text: "b2", colSpan: 1, rowSpan: 1 }, { text: "b3", colSpan: 1, rowSpan: 1 }],
    ])
    assert.equal(nested.rows, 3)
    assert.equal(nested.cols, 3)

    // 외곽 2×1 페이지 레이아웃 표: cell(0,0)=반복 머리말, cell(1,0)=본문(blocks 보유)
    // cell(1,0).text는 줄바꿈 다량 → 레이아웃 휴리스틱(totalNewlines>5) 트리거.
    // 페이지 사슬 레이아웃 표는 본문 한 페이지 분량(수백~수천 자)이다 — 별지서식 1칸 틀
    // (중첩표 + 글 ≤600자)과 가르는 기준이라 픽스처도 페이지 분량으로 둔다 (v4.12.2)
    const pageBody = Array.from({ length: 8 }, (_, k) => `줄${k + 1} ` + "본문 문장이 한 페이지를 채운다. ".repeat(4)).join("\n")
    const outer: IRBlock = {
      type: "table",
      pageNumber: 3,
      table: {
        rows: 2,
        cols: 1,
        hasHeader: true,
        cells: [
          [{ text: "머리말 반복 running header", colSpan: 1, rowSpan: 1 }],
          [{
            text: pageBody,
            colSpan: 1,
            rowSpan: 1,
            blocks: [
              { type: "paragraph", text: "셀 본문 문단", pageNumber: 3 },
              { type: "table", table: nested, pageNumber: 3 },
            ],
          }],
        ],
      },
    }

    const flat = flattenLayoutTables([outer])

    // 중첩표가 실제 table 블록으로 보존 (문단으로 해체되지 않음)
    const tableBlocks = flat.filter(b => b.type === "table" && b.table)
    assert.equal(tableBlocks.length, 1, "중첩 3×3 표가 실제 table 블록으로 보존되어야 함")
    const preserved = tableBlocks[0].table!
    assert.equal(preserved.rows, 3, "보존된 표 행 수")
    assert.equal(preserved.cols, 3, "보존된 표 열 수")
    assert.equal(preserved.cells[0][0].text, "h1")
    assert.equal(preserved.cells[2][2].text, "b3")

    // 표 셀 텍스트가 문단으로 새어나오지 않음 (해체 안 됨의 반증)
    const paraTexts = flat.filter(b => b.type === "paragraph").map(b => b.text)
    assert.ok(!paraTexts.includes("h1"), "중첩표 셀이 문단으로 해체되지 않아야 함")

    // blocks 내 문단은 보존, blocks 없는 셀(머리말)은 text-split
    assert.ok(paraTexts.includes("셀 본문 문단"), "blocks 내 문단 보존")
    assert.ok(paraTexts.includes("머리말 반복 running header"), "머리말 셀은 text-split")

    // pageNumber 보존
    const headerPara = flat.find(b => b.type === "paragraph" && b.text === "머리말 반복 running header")
    assert.equal(headerPara?.pageNumber, 3, "text-split 문단 pageNumber 보존")
  })

  it("별지서식 1칸 틀(제목행+틀+꼬리행 3×1, 틀 안 발신명의|직인 중첩표, 글 적음)은 해체하지 않는다 — HWPX·PDF 파서와 같은 모양", () => {
    const seal = buildTable([[{ text: "국토교통부장관", colSpan: 1, rowSpan: 1 }, { text: "직인", colSpan: 1, rowSpan: 1 }]])
    const frame: IRBlock = {
      type: "table", pageNumber: 1,
      table: {
        rows: 3, cols: 1, hasHeader: false,
        cells: [
          [{ text: "■ 항공보안법 시행규칙 [별지 제6호서식]", colSpan: 1, rowSpan: 1 }],
          [{
            text: "제 호\n보안검색교육기관 지정서\n1. 명칭\n2. 주소\n3. 전화번호\n4. 교육과정\n5. 피교육생 정원\n년 월 일",
            colSpan: 1, rowSpan: 1,
            blocks: [
              ...["제 호", "보안검색교육기관 지정서", "1. 명칭", "2. 주소", "3. 전화번호", "4. 교육과정", "5. 피교육생 정원", "년 월 일"]
                .map(t => ({ type: "paragraph" as const, text: t, pageNumber: 1 })),
              { type: "table", table: seal, pageNumber: 1 },
            ],
          }],
          [{ text: "210mm×297mm[백상지 120g/㎡]", colSpan: 1, rowSpan: 1 }],
        ],
      },
    }
    const flat = flattenLayoutTables([frame])
    assert.equal(flat.length, 1, "틀 표가 그대로 남는다")
    assert.equal(flat[0].type, "table")
    assert.equal(flat[0].table!.rows, 3)
    const nested = flat[0].table!.cells[1][0].blocks!.find(b => b.type === "table")
    assert.ok(nested, "중첩 발신명의|직인 표는 틀 셀 blocks 안에 남는다")
  })

  it("blocks 없는 셀은 기존대로 줄 단위 paragraph로 분해 (회귀 방지)", () => {
    const outer: IRBlock = {
      type: "table",
      pageNumber: 5,
      table: {
        rows: 2,
        cols: 1,
        hasHeader: true,
        cells: [
          [{ text: "머리말", colSpan: 1, rowSpan: 1 }],
          [{ text: "가\n나\n다\n라\n마\n바\n사", colSpan: 1, rowSpan: 1 }],
        ],
      },
    }

    const flat = flattenLayoutTables([outer])

    assert.ok(flat.every(b => b.type === "paragraph"), "표 블록 없이 모두 문단으로 해체")
    const texts = flat.map(b => b.text)
    for (const t of ["머리말", "가", "나", "다", "라", "마", "바", "사"]) {
      assert.ok(texts.includes(t), `'${t}' 문단 존재`)
    }
    assert.ok(flat.every(b => b.pageNumber === 5), "pageNumber 보존")
  })
})
