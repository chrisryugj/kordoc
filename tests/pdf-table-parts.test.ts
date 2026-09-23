/**
 * PDF 표 조립 회귀 — 쪽 넘김 잇기(table-parts)·후행 빈 열(table-trim)·클립 격자 보강(clip-cells).
 *
 * 한컴 PDF 실측에서 온 규칙들: 쪽마다 그 쪽에 그려진 칸만 클립으로 깔리고(조각마다 열 구성이 다름), 쪽 끝 행은
 * 쪼개졌든 아니든 본문 바닥까지 늘려 그려지며, 폭 3pt 안팎의 좁은 빈 칸은 클립 없이 배경 채움만 그려진다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { joinSplitParts, mergeCrossPageTables } from "../src/pdf/table-parts.js"
import { CLIP_TABLES, EMPTY_PARTS, FILLER_CELLS, TABLE_COLXS, CELL_LINES, recordCellLines } from "../src/pdf/table-meta.js"
import { trimTrailingEmptyTableCols, markImageCell } from "../src/pdf/table-trim.js"
import { buildClipCellGrids } from "../src/pdf/clip-cells.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"
import type { LineSegment } from "../src/pdf/line-types.js"
import { sortLineByX } from "../src/pdf/text-line.js"
import { sanitizeBlockControlChars } from "../src/pdf/text-clean.js"
import { cellTextToString } from "../src/pdf/cell-text.js"

/** 앵커 목록 → 덮인 자리까지 채운 IR 격자 ([행, 열, 글, 열병합, 행병합]) */
function grid(rows: number, cols: number, anchors: Array<[number, number, string, number?, number?]>): IRTable {
  const cells: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  for (const [r, c, text, cs = 1, rs = 1] of anchors) cells[r][c] = { text, colSpan: cs, rowSpan: rs }
  return { rows, cols, cells, hasHeader: rows > 1 }
}

/** 쪽·위치를 가진 클립 표 블록 (y 는 밑변, 쪽 좌표) */
function clipBlock(table: IRTable, colXs: number[], page: number, y: number, height: number): IRBlock {
  CLIP_TABLES.add(table)
  TABLE_COLXS.set(table, colXs)
  return { type: "table", table, pageNumber: page, bbox: { page, x: colXs[0], y, width: colXs[colXs.length - 1] - colXs[0], height } }
}

/** 칸 글줄 기록 — [왼끝, 오른끝, 기준선] 줄마다 글자 크기 10 */
function lines(cell: IRCell, spec: Array<[number, number, number]>): void {
  recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 10, h: 10 })))
}

const PAGE_H = new Map([[1, 842], [2, 842]])

describe("joinSplitParts — 쪽 넘김 클립 표 조각을 열 경계 합집합 격자로 잇기", () => {
  it("뒤 조각에 클립이 없던 왼쪽 열은 앞 조각 마지막 행 칸의 세로 병합을 이어 늘린다", () => {
    // 앞 조각: 2열 [0,100,300] — 둘째 행 "기타" 칸이 다음 쪽으로 이어진다. 뒤 조각: 오른쪽 열만 [100,300]
    const prev = grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "기타"], [1, 1, "가"]])
    const curr = grid(2, 1, [[0, 0, "나"], [1, 0, "다"]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 4)
    assert.equal(res.table.cols, 2)
    assert.equal(res.table.cells[1][0].text, "기타")
    assert.equal(res.table.cells[1][0].rowSpan, 3)
    assert.equal(res.table.cells[3][1].text, "다")
    assert.deepEqual(res.colXs, [0, 100, 300])
  })

  it("반복 머리 행은 한 번만 남긴다", () => {
    const prev = grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]])
    const curr = grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "2"], [1, 1, "나"]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 3)
    assert.equal(res.table.cells[2][0].text, "2")
  })

  it("앞 쪽 끝줄이 칸 오른끝까지 찬 칸은 쪼개진 행으로 보고 뒤 조각 첫 행을 합친다", () => {
    const prev = grid(2, 2, [[0, 0, "제1조"], [0, 1, "목적"], [1, 0, "제2조"], [1, 1, "이 규정은 행정기관의 업무를"]])
    const curr = grid(1, 2, [[0, 0, ""], [0, 1, "효율적으로 처리하기 위하여 정한다."]])
    // 윗줄 둘은 오른끝(295)까지 꽉 차고, 뒤 쪽 끝줄은 짧다(문단 끝줄 — 왼쪽 정렬 증거)
    lines(prev.cells[1][1], [[105, 295, 60], [105, 295, 45]])
    lines(curr.cells[0][1], [[105, 295, 780], [105, 200, 765]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 2)
    assert.equal(res.table.cells[1][1].text, "이 규정은 행정기관의 업무를\n효율적으로 처리하기 위하여 정한다.")
  })

  it("앞 쪽 끝줄이 짧으면(문단이 끝남) 행 경계로 보고 합치지 않는다", () => {
    const prev = grid(2, 2, [[0, 0, "제1조"], [0, 1, "목적"], [1, 0, "제2조"], [1, 1, "정의는 다음과 같다."]])
    const curr = grid(1, 2, [[0, 0, "제3조"], [0, 1, "적용 범위"]])
    lines(prev.cells[1][1], [[105, 295, 60], [105, 180, 45]])
    lines(curr.cells[0][1], [[105, 160, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 3)
  })

  it("가운데 정렬 칸은 끝줄이 가장 긴 줄이어도 증거가 아니다", () => {
    const prev = grid(2, 2, [[0, 0, "구분"], [0, 1, "지원"], [1, 0, "24"], [1, 1, "보훈대상 재해위로금 지원"]])
    const curr = grid(1, 2, [[0, 0, "25"], [0, 1, "위기가족 긴급지원"]])
    // 줄마다 좌우 여백이 같다 (가운데 정렬)
    lines(prev.cells[1][1], [[140, 260, 60], [110, 290, 45]])
    lines(curr.cells[0][1], [[125, 275, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 3)
  })
})

describe("mergeCrossPageTables — 클립 표 쪽 넘김 판정", () => {
  it("두 조각 사이에 표와 가로로 겹치지 않는 가장자리 글(장 표시 세로글)만 있으면 잇는다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]]), [60, 160, 460], 1, 70, 300),
      { type: "paragraph", text: "제5장", pageNumber: 1, bbox: { page: 1, x: 520, y: 90, width: 12, height: 80 } },
      clipBlock(grid(1, 2, [[0, 0, "2"], [0, 1, "나"]]), [60, 160, 460], 2, 700, 72),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].table!.rows, 3)
    assert.equal(blocks[1].type, "paragraph")
  })

  it("사이에 본문 폭 글이 있으면 잇지 않는다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]]), [60, 160, 460], 1, 70, 300),
      { type: "paragraph", text: "※ 자료: 통계청", pageNumber: 1, bbox: { page: 1, x: 60, y: 60, width: 200, height: 10 } },
      clipBlock(grid(1, 2, [[0, 0, "2"], [0, 1, "나"]]), [60, 160, 460], 2, 700, 72),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 3)
  })

  it("다음 쪽 첫머리의 첨부 머리표(붙임·별지)는 앞 표의 이어짐이 아니다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]]), [60, 160, 460], 1, 70, 300),
      clipBlock(grid(1, 2, [[0, 0, "붙임 2"], [0, 1, "추진 일정"]]), [60, 160, 460], 2, 700, 72),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 2)
  })

  it("글 없는 클립 조각은 이어질 때만 살아남고, 못 이으면 버린다", () => {
    const tail = grid(1, 2, [[0, 0, ""], [0, 1, ""]])
    EMPTY_PARTS.add(tail)
    const stray = grid(2, 2, [[0, 0, ""], [0, 1, ""], [1, 0, ""], [1, 1, ""]])
    EMPTY_PARTS.add(stray)
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "문"], [0, 1, "질의"], [1, 0, "답"], [1, 1, "답변"]]), [60, 160, 460], 1, 70, 300),
      clipBlock(tail, [60, 160, 460], 2, 740, 30),
      clipBlock(stray, [60, 160, 460], 2, 300, 40),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 3)
  })
})

describe("trimTrailingEmptyTableCols — 후행 빈 열 정리 (HWP 계열 표 빌더와 같은 규칙)", () => {
  it("칸 단위로 전부 빈 마지막 열을 자르고, 걸친 병합 칸은 표 폭 안으로 줄인다", () => {
    const t = grid(2, 4, [[0, 0, "위원회 설치(예시)"], [0, 1, ""], [0, 2, ""], [0, 3, ""], [1, 0, "본문", 4]])
    const blocks: IRBlock[] = [{ type: "table", table: t }]
    trimTrailingEmptyTableCols(blocks)
    assert.equal(t.cols, 1)
    assert.equal(t.cells[1][0].colSpan, 1)
  })

  it("그림만 든 칸(로고)은 빈 칸이 아니다", () => {
    const t = grid(1, 3, [[0, 0, "보도자료"], [0, 1, ""], [0, 2, ""]])
    markImageCell(t.cells[0][1])
    trimTrailingEmptyTableCols([{ type: "table", table: t }])
    assert.equal(t.cols, 2)
  })
})

describe("buildClipCellGrids — 클립 격자 보강", () => {
  const hline = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
  const vline = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.5 })

  it("격자 끝에 맞붙은 좁은 채움 사각형(클립 없는 폭 3pt 빈 칸)을 열로 되살린다", () => {
    // 머리 상자 "1 | 제목" 3행 × 2열 + 양옆 2.9pt 회색 띠 (행정업무운영 편람)
    const rows = [[553, 555.8], [527.5, 553], [524.6, 527.5]]
    const rects = rows.flatMap(([y1, y2]) => [{ x1: 76.5, y1, x2: 110.2, y2 }, { x1: 110.2, y1, x2: 464.9, y2 }])
    const fills = rows.flatMap(([y1, y2]) => [{ x1: 73.6, y1, x2: 76.5, y2 }, { x1: 464.9, y1, x2: 467.8, y2 }])
    const { grids } = buildClipCellGrids(rects, [], [], 555, 754, [], fills)
    assert.equal(grids.length, 1)
    assert.deepEqual(grids[0].colXs.map(v => +v.toFixed(1)), [73.6, 76.5, 110.2, 464.9, 467.8])
    assert.equal(grids[0].cells!.filter(c => c.col === 0).length, 3)
  })

  it("행 경계와 안 맞는 채움 사각형은 칸이 아니다", () => {
    const rects = [{ x1: 76.5, y1: 527.5, x2: 110.2, y2: 553 }, { x1: 110.2, y1: 527.5, x2: 464.9, y2: 553 }]
    const { grids } = buildClipCellGrids(rects, [], [], 555, 754, [], [{ x1: 73.6, y1: 530, x2: 76.5, y2: 540 }])
    assert.equal(grids[0].colXs.length, 3)
  })

  it("칸 클립 묶음과 좌표까지 같은 바깥 클립은 표 겉 클립이다 — 1×1 틀로 글을 가로채지 않는다", () => {
    // Q&A 상자: 겉 클립 + 2×2 칸 (겉 클립에 테두리 획)
    const outer = { x1: 85, y1: 330, x2: 481, y2: 547 }
    const cells = [
      { x1: 85, y1: 440, x2: 150, y2: 547 }, { x1: 150, y1: 440, x2: 481, y2: 547 },
      { x1: 85, y1: 330, x2: 150, y2: 440 }, { x1: 150, y1: 330, x2: 481, y2: 440 },
    ]
    const strokedH = [hline(330, 85, 481), hline(547, 85, 481)], strokedV = [vline(85, 330, 547), vline(481, 330, 547)]
    const { grids } = buildClipCellGrids([outer, ...cells], strokedH, strokedV, 555, 754)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].colXs.length - 1, 2)
    assert.equal(grids[0].clipParent, undefined)
  })

  it("틀 칸 안의 감싸개 클립(안쪽 여백) 안 표는 감싸개를 건너뛰어 틀 칸에 든다", () => {
    const frame = { x1: 150, y1: 70, x2: 530, y2: 780 } // 테두리 획 있는 큰 칸 (쪽을 넘어온 칸)
    const wrapper = { x1: 155, y1: 73, x2: 525, y2: 777 } // 획 없는 안쪽 클립
    const inner = [
      { x1: 160, y1: 400, x2: 300, y2: 420 }, { x1: 300, y1: 400, x2: 520, y2: 420 },
      { x1: 160, y1: 380, x2: 300, y2: 400 }, { x1: 300, y1: 380, x2: 520, y2: 400 },
    ]
    const strokedH = [hline(70, 150, 530), hline(780, 150, 530)], strokedV = [vline(150, 70, 780), vline(530, 70, 780)]
    const { grids } = buildClipCellGrids([frame, wrapper, ...inner], strokedH, strokedV, 595, 842)
    const nested = grids.find(g => g.colXs.length === 3)
    assert.ok(nested)
    assert.deepEqual(nested.clipParent, frame)
  })
})

describe("recordCellLines — 칸 글줄 상자", () => {
  it("기준선이 가까운 조각은 한 줄로 묶고 위→아래로 둔다", () => {
    const cell: IRCell = { text: "", colSpan: 1, rowSpan: 1 }
    recordCellLines(cell, [
      { x: 10, y: 100, w: 20, fontSize: 10, h: 10 }, { x: 40, y: 101, w: 30, fontSize: 10, h: 10 },
      { x: 10, y: 85, w: 50, fontSize: 10, h: 10 },
    ])
    assert.deepEqual(CELL_LINES.get(cell)!.map(l => [l.l, l.r]), [[10, 70], [10, 60]])
  })
})

describe("글자 조각 순서·자리표시 글리프", () => {
  it("x 가 1pt 안으로 겹친 이웃은 콘텐츠 스트림 순서를 따른다 (자간 줄인 숫자 \"8.\" 뒤바뀜)", () => {
    const items = [{ x: 252, seq: 1, t: "." }, { x: 251, seq: 2, t: "8" }, { x: 240, seq: 0, t: "1" }]
    assert.equal(sortLineByX(items).map(i => i.t).join(""), "1.8")
    const far = [{ x: 260, seq: 1, t: "b" }, { x: 250, seq: 2, t: "a" }]
    assert.equal(sortLineByX(far).map(i => i.t).join(""), "ab")
  })

  it("한컴 PDF 의 유니코드 없는 글리프 자리표시(U+F000)는 글과 칸에서 지운다", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "\uF000 추진 배경" },
      { type: "table", table: grid(1, 1, [[0, 0, "\uF000\uF000 항목"]]) },
    ]
    sanitizeBlockControlChars(blocks)
    assert.equal(blocks[0].text, " 추진 배경")
    assert.equal(blocks[1].table!.cells[0][0].text, " 항목")
  })
})

describe("칸 글 줄 병합 — 숫자", () => {
  const item = (text: string, y: number) => ({ text, x: 10, y, w: text.length * 5, h: 10, fontSize: 10, fontName: "f" })
  it("병합 칸에 쌓인 온전한 천 단위 숫자 둘은 잇지 않는다", () => {
    assert.equal(cellTextToString([item("20,775,661", 100), item("5,187,590", 85)]), "20,775,661\n5,187,590")
  })
  it("줄바꿈에 잘린 숫자 조각은 잇는다", () => {
    assert.equal(cellTextToString([item("1,234,5", 100), item("67", 85)]), "1,234,567")
  })
})

describe("리뷰 회귀 — 경계 입력", () => {
  it("앞 쪽에 한 줄뿐인 칸은 그 줄이 칸 오른끝에 닿지 않으면 쪼개진 행이 아니다", () => {
    const prev = grid(2, 2, [[0, 0, "제1조"], [0, 1, "목적"], [1, 0, "제2조"], [1, 1, "정의"]])
    const curr = grid(1, 2, [[0, 0, "제3조"], [0, 1, "범위"]])
    lines(prev.cells[1][1], [[105, 230, 60]])
    lines(curr.cells[0][1], [[105, 180, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 3)
  })

  it("잇고 남은 빈 자리는 채움 칸으로 남긴다 (세 쪽 넘게 이어질 때 다음 이음이 빈 자리로 본다)", () => {
    const prev = grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, ""], [1, 1, "가"]])
    FILLER_CELLS.add(prev.cells[1][0])
    const curr = grid(1, 1, [[0, 0, "나"]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 3)
    assert.ok(FILLER_CELLS.has(res.table.cells[2][0]))
  })

  it("앞 표의 이어짐이 못 된 빈 조각(쪽 첫머리 장식 띠)은 버리고 그다음 표와 잇는다", () => {
    const strip = grid(1, 3, [[0, 0, ""], [0, 1, ""], [0, 2, ""]])
    EMPTY_PARTS.add(strip)
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]]), [60, 160, 460], 1, 70, 300),
      clipBlock(strip, [20, 40, 60, 80], 2, 800, 20),
      clipBlock(grid(1, 2, [[0, 0, "2"], [0, 1, "나"]]), [60, 160, 460], 2, 700, 72),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 3)
  })

  it("포함 오차로 서로를 품는 사각형들도 무한 루프 없이 끝난다", () => {
    const rects = [
      { x1: 100, y1: 100, x2: 300, y2: 300 }, { x1: 103.05, y1: 99.85, x2: 301.45, y2: 301.45 },
      { x1: 101.6, y1: 102.9, x2: 301.45, y2: 302.9 }, { x1: 101.45, y1: 101.45, x2: 299.7, y2: 303.05 },
      { x1: 150, y1: 150, x2: 200, y2: 200 }, { x1: 200, y1: 150, x2: 250, y2: 200 },
    ]
    const { grids } = buildClipCellGrids(rects, [], [], 595, 842)
    assert.ok(Array.isArray(grids))
  })

  it("폭 1pt 미만 채움(채움으로 그린 괘선)은 가장자리 칸이 아니다", () => {
    const rects = [{ x1: 76.5, y1: 527.5, x2: 110.2, y2: 553 }, { x1: 110.2, y1: 527.5, x2: 464.9, y2: 553 }]
    const { grids } = buildClipCellGrids(rects, [], [], 555, 754, [], [{ x1: 76, y1: 527.5, x2: 76.5, y2: 553 }])
    assert.equal(grids[0].colXs.length, 3)
  })
})
