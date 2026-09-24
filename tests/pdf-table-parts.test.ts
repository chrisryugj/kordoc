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
    // 글 없이 넘어간 "제2조" 칸 조각은 한컴이 클립을 깔지 않는다 — 채움 칸
    FILLER_CELLS.add(curr.cells[0][0])
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
  it("쉼표 없는 세 자리 이하 온전한 숫자가 쌓인 칸도 잇지 않는다 (괴산 예산서 \"810810810\"·부천 \"2,2400\")", () => {
    assert.equal(cellTextToString([item("810", 100), item("810", 85), item("810", 70)]), "810\n810\n810")
    assert.equal(cellTextToString([item("2,240", 100), item("0", 85)]), "2,240\n0")
  })
  it("글 뒤에 붙은 번호 조각(\"02-123\" / \"4567\")은 종전처럼 잇는다", () => {
    assert.equal(cellTextToString([item("02-123", 100), item("4567", 85)]), "02-1234567")
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
    const prev = grid(3, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"], [2, 0, ""], [2, 1, "나"]])
    FILLER_CELLS.add(prev.cells[2][0])
    // 뒤 조각 첫 행 왼쪽 칸은 새 칸(글 없는 클립)이라 쪼개진 행이 아니다
    const curr = grid(1, 2, [[0, 0, ""], [0, 1, "다"]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 4)
    assert.ok(FILLER_CELLS.has(res.table.cells[2][0]))
  })

  it("양쪽 쪽 모두 클립이 없던 자리는 칸 조각이 이어진 것이다 — 글 쌍 하나면 쪼개진 행 (세 쪽에 걸친 대비표 행)", () => {
    // 앞 조각은 이미 앞 쪽에서 넘어온 행 하나뿐(왼쪽 칸 클립 없음), 뒤 조각 첫 행 왼쪽도 클립 없음
    const prev = grid(1, 2, [[0, 0, ""], [0, 1, "여럿인 경우에는 두문의 수신란에"]])
    FILLER_CELLS.add(prev.cells[0][0])
    const curr = grid(1, 2, [[0, 0, ""], [0, 1, "⑥ 결문은 다음 각 호의 사항으로 구성한다."]])
    FILLER_CELLS.add(curr.cells[0][0])
    // 오른쪽 칸은 문단 경계에서 끊겨 글 이어짐 증거가 없다 (앞 끝줄이 짧음)
    lines(prev.cells[0][1], [[105, 295, 60], [105, 180, 45]])
    lines(curr.cells[0][1], [[105, 250, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res)
    assert.equal(res.table.rows, 1)
    assert.ok(res.split)
    assert.equal(res.table.cells[0][1].text, "여럿인 경우에는 두문의 수신란에\n⑥ 결문은 다음 각 호의 사항으로 구성한다.")
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

describe("쪽 넘김 2차 — 쪼개진 행 증거", () => {
  it("앞 쪽 끝 행에서 시작한 칸이 다음 쪽 첫 행에 클립 없이 넘어가고 글 쌍이 하나면 쪼개진 행이다 (칸 안 문단 경계)", () => {
    // 신구조문 대비표: 왼쪽 조문이 "① …" 문단에서 끝나고 다음 쪽 "② …" 로 이어진다. 오른쪽 빈 칸 조각은 다음 쪽에 클립이 없다
    const prev = grid(2, 2, [[0, 0, "제20조"], [0, 1, ""], [1, 0, "제21조 ① 행정기관의 장은 업무를 관리한다."], [1, 1, ""]])
    const curr = grid(2, 2, [[0, 0, "② 중앙행정기관의 장은 구축한다."], [0, 1, ""], [1, 0, "제22조"], [1, 1, "제19조"]])
    FILLER_CELLS.add(curr.cells[0][1])
    lines(prev.cells[1][0], [[105, 295, 60], [105, 200, 45]]) // 끝줄이 짧다 — 글 이어짐 증거 없음
    lines(curr.cells[0][0], [[105, 250, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res?.split)
    assert.equal(res.table.rows, 3)
    assert.equal(res.table.cells[1][0].text, "제21조 ① 행정기관의 장은 업무를 관리한다.\n② 중앙행정기관의 장은 구축한다.")
  })

  it("클립 없는 칸이 뒤 조각 여러 행을 덮으면 세로 병합 칸이지 쪼개진 행의 증거가 아니다", () => {
    const prev = grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "기타"], [1, 1, "가"]])
    const curr = grid(2, 2, [[0, 0, ""], [0, 1, "나"], [1, 0, ""], [1, 1, "다"]])
    FILLER_CELLS.add(curr.cells[0][0])
    FILLER_CELLS.add(curr.cells[1][0])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 4)
    assert.equal(res.table.cells[1][0].rowSpan, 3)
  })

  it("칸 글 오른끝에 못 미친 끝줄은 두 조각의 가장 긴 줄이어도 글 이어짐이 아니다", () => {
    // 편람 대비표: "제44조의2 [제44조의2는 제46조의4로 이동]" 두 줄이 다 334pt 에서 끝나고 다음 쪽 "제44조의3 [...]" 도 같다 — 칸 글 오른끝은 371pt
    const xs = [70.9, 376.9, 682.9]
    const prev = grid(2, 2, [[0, 0, "제44조"], [0, 1, "제20조"], [1, 0, "제44조의2 [이동]"], [1, 1, ""]])
    const curr = grid(1, 2, [[0, 0, "제44조의3 [이동]"], [0, 1, ""]])
    const lines11 = (cell: IRCell, spec: Array<[number, number, number]>) => recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 11, h: 11 })))
    lines11(prev.cells[1][0], [[77, 126, 110], [87, 334, 95]])
    lines11(curr.cells[0][0], [[77, 126, 424], [87, 334, 409]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 3)
  })

  it("이어진 칸 조각의 글 없는 클립은 새 칸 증거가 아니다 (한컴 PDF 판·칸에 따라 깔린다)", () => {
    // 법령 별표: 분류 칸 "5. 자연휴양림 등조성" 과 "3억원이상" 칸이 다음 쪽에 글 없는 클립으로 이어지고 목록 칸 글이 넘어간다
    const prev = grid(2, 3, [[0, 0, "4. 산림토목"], [0, 1, "가. 임도사업"], [0, 2, "3억원"], [1, 0, "5. 자연휴양림"], [1, 1, "가. 자연휴양림조성 바."], [1, 2, "3억원"]])
    const curr = grid(1, 3, [[0, 0, ""], [0, 1, "사. 유아숲체험원 조성"], [0, 2, ""]])
    lines(prev.cells[1][1], [[105, 250, 80], [105, 296, 61]])
    lines(curr.cells[0][1], [[105, 296, 786], [105, 180, 766]])
    const res = joinSplitParts(prev, [0, 100, 300, 360], curr, [0, 100, 300, 360])
    assert.ok(res?.split)
    assert.equal(res.table.rows, 2)
  })

  it("표 전체가 빈 좁은 장식 열의 클립은 새 칸 증거가 아니다", () => {
    const prev = grid(2, 3, [[0, 0, ""], [0, 1, "머리"], [0, 2, ""], [1, 0, ""], [1, 1, "1. (위조) 다음의 경우에는 위조에 해당함"], [1, 2, ""]])
    const curr = grid(1, 3, [[0, 0, ""], [0, 1, "연구 결과를 허위로 제시하는 경우"], [0, 2, ""]])
    lines(prev.cells[1][1], [[110, 280, 60], [110, 295, 45]])
    lines(curr.cells[0][1], [[110, 200, 780]])
    const res = joinSplitParts(prev, [0, 6, 294, 300], curr, [0, 6, 294, 300])
    assert.ok(res?.split)
    assert.equal(res.table.rows, 2)
  })

  it("한 줄로 끝난 이름표 뒤 다른 글이 오면 다른 열 끝줄이 꽉 차도 새 행이다", () => {
    const prev = grid(1, 2, [[0, 0, "8. 글자"], [0, 1, "가. 글자는 줄 또는 칸의 왼쪽부터 쓴다"]])
    const curr = grid(1, 2, [[0, 0, "9. 외국글자"], [0, 1, "가. 단어를 함께 적는 경우"]])
    lines(prev.cells[0][0], [[3, 30, 60]])
    lines(prev.cells[0][1], [[105, 250, 75], [105, 295, 60]])
    lines(curr.cells[0][0], [[3, 50, 780]])
    lines(curr.cells[0][1], [[105, 295, 780], [120, 200, 765]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res && !res.split)
    // 두 조각에 같은 글이 한 줄씩이면 문단마다 붙는 표지라 모순이 아니다 (신구조문 대비표 "<신 설>")
    const prev2 = grid(1, 2, [[0, 0, "<신 설>"], [0, 1, "가. 글자는 줄 또는 칸의 왼쪽부터 쓴다"]])
    const curr2 = grid(1, 2, [[0, 0, "<신 설>"], [0, 1, "나. 단어를 함께 적는 경우"]])
    lines(prev2.cells[0][0], [[20, 60, 60]])
    lines(prev2.cells[0][1], [[105, 250, 75], [105, 295, 60]])
    lines(curr2.cells[0][0], [[20, 60, 780]])
    lines(curr2.cells[0][1], [[105, 295, 780], [120, 200, 765]])
    const res2 = joinSplitParts(prev2, [0, 100, 300], curr2, [0, 100, 300])
    assert.ok(res2?.split)
  })

  it("칸 조각 이어짐 증거가 있어도 앞 쪽 빈 칸 뒤 같은 열에 글이 오면 새 행이다 (글은 칸 위에서부터 흐른다)", () => {
    // 왼쪽 열은 두 쪽 모두 클립 없음(칸 조각 이어짐), 오른쪽 열은 앞 쪽 끝 행이 빈 칸이고 다음 쪽 첫 행에 새 조문
    const prev = grid(2, 2, [[0, 0, "제4조"], [0, 1, "제4조(보존) 내용"], [1, 0, ""], [1, 1, ""]])
    FILLER_CELLS.add(prev.cells[1][0])
    const curr = grid(1, 2, [[0, 0, ""], [0, 1, "제5조(기록) 새 조문"]])
    FILLER_CELLS.add(curr.cells[0][0])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 3)
  })

  it("양쪽 맞춤이라 모든 줄이 꽉 찬 칸은 내어쓴 자리에서 이어지면 같은 문단이다", () => {
    // 신구조문 대비표 두 칸(73.8~297.6·297.6~521.4), 글자 14pt, 문단 머리 93 → 내어쓴 줄 104
    const xs = [73.8, 297.6, 521.4]
    const prev = grid(1, 2, [[0, 0, "1. 다음 각 목의 어느 하나에 해 당하는 행정처분을 받지 않거"], [0, 1, "1. ----"]])
    const curr = grid(1, 2, [[0, 0, "나, 그 행정처분을 받은 횟수가"], [0, 1, "----"]])
    const lines14 = (cell: IRCell, spec: Array<[number, number, number]>) => recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 14, h: 14 })))
    lines14(prev.cells[0][0], [[93, 292, 122], [104, 292, 96]])
    lines14(curr.cells[0][0], [[104, 292, 739], [104, 291, 714]])
    lines14(prev.cells[0][1], [[317, 516, 122], [328, 516, 96]])
    lines14(curr.cells[0][1], [[328, 516, 739]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    // 새 문단이 문단 머리 자리에서 시작하면 잇지 않는다
    const curr2 = grid(1, 2, [[0, 0, "2. 새 문단"], [0, 1, "2. ----"]])
    lines14(curr2.cells[0][0], [[93, 292, 739], [104, 291, 714]])
    lines14(curr2.cells[0][1], [[317, 516, 739]])
    const res2 = joinSplitParts(prev, xs, curr2, xs)
    assert.ok(res2 && !res2.split)
  })

  it("머리 행 위에 제목 상자 행이 붙은 첫 조각도 반복 머리 행을 찾는다", () => {
    const prev = grid(3, 2, [[0, 0, "[별표 4]", 2], [1, 0, "구분"], [1, 1, "설계기준"], [2, 0, "1. 기본형식"], [2, 1, "가."]])
    const curr = grid(2, 2, [[0, 0, "구분"], [0, 1, "설계기준"], [1, 0, "2. 용지여백"], [1, 1, "상단은"]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res?.header)
    assert.equal(res.table.rows, 4)
    assert.equal(res.table.cells[3][0].text, "2. 용지여백")
  })
})

describe("쪽 넘김 2차 — 잇기 판정", () => {
  const H = new Map([[1, 842], [2, 842]])
  it("짝·홀 쪽 대칭 여백으로 옮겨진 클립 조각은 쪼개진 행이나 반복 머리 행이 있을 때만 잇는다", () => {
    const head = (): IRTable => grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "1"], [1, 1, "가"]])
    // 반복 머리 행 — 잇는다
    const a: IRBlock[] = [clipBlock(head(), [60, 160, 460], 1, 70, 300), clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "내용"], [1, 0, "2"], [1, 1, "나"]]), [71.4, 171.4, 471.4], 2, 700, 72)]
    mergeCrossPageTables(a, H)
    assert.equal(a.length, 1)
    assert.equal(a[0].table!.rows, 3)
    // 증거 없음(연달아 놓인 같은 틀 상자) — 잇지 않는다
    const b: IRBlock[] = [clipBlock(head(), [60, 160, 460], 1, 70, 300), clipBlock(grid(2, 2, [[0, 0, "문"], [0, 1, "질의"], [1, 0, "답"], [1, 1, "답변"]]), [71.4, 171.4, 471.4], 2, 700, 72)]
    mergeCrossPageTables(b, H)
    assert.equal(b.length, 2)
    // 한 칸짜리 제목 행이 되풀이된 것은 머리 행 증거가 아니다 — 같은 제목 상자가 쪽마다 새로 놓인 것 (기안문 "작성방법" 상자 둘)
    const box = (item: string): IRTable => grid(2, 1, [[0, 0, "작성방법"], [1, 0, item]])
    const c: IRBlock[] = [clipBlock(box("1. 행정기관명 : 기안한 부서가 속한 행정기관명"), [87.5, 480.8], 1, 88, 554), clipBlock(box("9. 누리집 주소 : 행정기관의 누리집 주소"), [75, 468.3], 2, 88, 554)]
    mergeCrossPageTables(c, new Map([[1, 754], [2, 754]]))
    assert.equal(c.length, 2)
    // 칸 둘 이상인 머리 행이면 같은 자리 상자도 잇는다 (위 a 와 같은 판정, 쪽 높이만 다름)
    const d: IRBlock[] = [clipBlock(grid(2, 2, [[0, 0, "작성"], [0, 1, "방법"], [1, 0, "1."], [1, 1, "행정기관명"]]), [87.5, 180, 480.8], 1, 88, 554), clipBlock(grid(2, 2, [[0, 0, "작성"], [0, 1, "방법"], [1, 0, "9."], [1, 1, "누리집 주소"]]), [75, 167.5, 468.3], 2, 88, 554)]
    mergeCrossPageTables(d, new Map([[1, 754], [2, 754]]))
    assert.equal(d.length, 1)
  })

  it("선 표는 모든 경계가 같은 거리만큼 옮겨진 조각을 잇는다 (짝·홀 쪽 대칭 여백)", () => {
    const line = (t: IRTable, xs: number[], page: number, y: number, h: number): IRBlock => {
      TABLE_COLXS.set(t, xs)
      return { type: "table", table: t, pageNumber: page, bbox: { page, x: xs[0], y, width: xs[xs.length - 1] - xs[0], height: h } }
    }
    const blocks: IRBlock[] = [
      line(grid(2, 2, [[0, 0, "기관"], [0, 1, "정보"], [1, 0, "교육부"], [1, 1, "증명서"]]), [87, 178.6, 480.1], 1, 90, 500),
      line(grid(2, 2, [[0, 0, "기관"], [0, 1, "정보"], [1, 0, "병무청"], [1, 1, "병적증명서"]]), [75.6, 167.2, 468.7], 2, 90, 660),
    ]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 3)
  })

  it("앞 표 테두리 안의 예시 상자가 쪽 마지막 표여도 앞 표를 다음 쪽 조각과 잇는다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "기준"], [1, 0, "3. 쪽번호"], [1, 1, "우측 상단에"]]), [60, 160, 460], 1, 70, 300),
      clipBlock(grid(1, 1, [[0, 0, "예시: (3쪽 중 제1쪽)"]]), [170, 450], 1, 80, 60),
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "기준"], [1, 0, "4. 항목란"], [1, 1, "가."]]), [60, 160, 460], 2, 700, 72),
    ]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].table!.rows, 3)
  })

  it("다음 쪽 첫머리가 앞 표 첫 행의 이름표를 되풀이하며 값만 다르면 새 표다 (서식 되풀이)", () => {
    const form = (no: string): IRTable => grid(2, 4, [[0, 0, "품목번호"], [0, 1, no], [0, 2, "분류"], [0, 3, "중분류"], [1, 0, "□ 개념", 4]])
    const blocks: IRBlock[] = [
      clipBlock(form("A-01"), [60, 150, 300, 360, 530], 1, 70, 700),
      // 앞 서식 끝 조각 — 본문 바닥 근처(쪽 아래 16% 띠 안)에서 끝나 쪽 넘김 기하로는 이어짐과 같다
      clipBlock(grid(2, 1, [[0, 0, "ㅇ 개발내용"], [1, 0, "지원기간"]]), [60, 530], 2, 88, 680),
      clipBlock(form("A-02"), [60, 150, 300, 360, 530], 3, 70, 700),
    ]
    mergeCrossPageTables(blocks, new Map([[1, 842], [2, 842], [3, 842]]))
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].table!.cells[0][1].text, "A-02")
  })

  it("값이 되풀이되는 데이터 행은 표 첫 행과 견주므로 새 표로 자르지 않는다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 4, [[0, 0, "순번"], [0, 1, "평가항목"], [0, 2, "구분"], [0, 3, "평가방법"], [1, 0, "1"], [1, 1, "정확도"], [1, 2, "1차년도"], [1, 3, "내부평가"]]), [58, 95, 171, 271, 534], 1, 70, 400),
      clipBlock(grid(1, 4, [[0, 0, "3"], [0, 1, "BOM"], [0, 2, "1차년도"], [0, 3, "내부평가"]]), [58, 95, 171, 271, 534], 2, 70, 700),
      clipBlock(grid(1, 4, [[0, 0, "4"], [0, 1, "검색"], [0, 2, "1차년도"], [0, 3, "내부평가"]]), [58, 95, 171, 271, 534], 3, 600, 200),
    ]
    mergeCrossPageTables(blocks, new Map([[1, 842], [2, 842], [3, 842]]))
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 4)
  })

  it("2단 지면 — 같은 쪽 왼쪽 단 바닥 조각과 오른쪽 단 첫머리 조각을 순서와 무관하게 잇고, 오른쪽 단 끝을 다음 쪽 왼쪽 단과 잇는다", () => {
    const W = new Map([[1, 595], [2, 595]])
    const t = (rows: Array<[string, string]>): IRTable => grid(rows.length + 1, 2, [[0, 0, "입찰일"], [0, 1, "공사명"], ...rows.flatMap(([a, b], k): Array<[number, number, string]> => [[k + 1, 0, a], [k + 1, 1, b]])])
    const blocks: IRBlock[] = [
      clipBlock(t([["9.21", "갑 공사"]]), [462, 520, 801], 1, 50, 480), // 쪽 1 오른쪽 단 (표 시작)
      clipBlock(t([["9.22", "을 공사"]]), [462, 520, 801], 2, 50, 490), // 쪽 2 오른쪽 단 — 블록 순서가 왼쪽 단보다 앞
      clipBlock(t([["9.21", "병 공사"]]), [41, 99, 380], 2, 50, 490), // 쪽 2 왼쪽 단
    ]
    mergeCrossPageTables(blocks, W)
    assert.equal(blocks.length, 1)
    assert.deepEqual(blocks[0].table!.cells.map(r => r[1].text), ["공사명", "갑 공사", "병 공사", "을 공사"])
  })

  it("2단 지면 오른쪽 단 표를 다음 쪽과 이으면 건너뛴 왼쪽 단 표 뒤에 둔다 (블록은 윗변 순이라 오른쪽 단 표가 먼저 나온다)", () => {
    const W = new Map([[1, 595], [2, 595]])
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "입찰일"], [0, 1, "공사명"], [1, 0, "9.21"], [1, 1, "갑 공사"]]), [462, 520, 801], 1, 50, 480), // 오른쪽 단, 윗변 530
      clipBlock(grid(2, 2, [[0, 0, "구분"], [0, 1, "금주"], [1, 0, "서울"], [1, 1, "3"]]), [41, 100, 380], 1, 380, 140), // 왼쪽 단, 윗변 520
      clipBlock(grid(2, 2, [[0, 0, "입찰일"], [0, 1, "공사명"], [1, 0, "9.22"], [1, 1, "을 공사"]]), [41, 99, 380], 2, 50, 490), // 다음 쪽 왼쪽 단
    ]
    mergeCrossPageTables(blocks, W)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].table!.cells[0][0].text, "구분")
    assert.deepEqual(blocks[1].table!.cells.map(r => r[1].text), ["공사명", "갑 공사", "을 공사"])
  })
})

describe("쪽 넘김 2차 — 합집합 격자 틈 열", () => {
  it("조각 왼끝이 조금 어긋나 생긴 좁은 틈 열의 빈 자리는 칸 조각 이어짐 증거가 아니다", () => {
    // 앞 조각 왼끝 58.0, 뒤 조각 왼끝 56.6 — 합집합 격자에 1.4pt 틈 열이 생기고 두 쪽 모두 비어 있다
    const prev = grid(2, 1, [[0, 0, "(4쪽 중 제2쪽)"], [1, 0, "210mm×297mm(백상지 80g/㎡)"]])
    const curr = grid(2, 2, [[0, 0, ""], [0, 1, "(4쪽 중 제3쪽)"], [1, 0, "가"], [1, 1, "나"]])
    FILLER_CELLS.add(curr.cells[0][0])
    const res = joinSplitParts(prev, [58, 538.2], curr, [56.6, 58, 538.2])
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 4)
  })
})

describe("쪽 넘김 2차 — 쪽 경계에 걸친 세로 병합 칸", () => {
  it("앞 쪽에서 두 행을 덮은 칸의 짧은 글이 앞 조각 바닥에 붙어 있으면 다음 쪽 첫 행 칸과 세로로 잇는다 (행은 새로)", () => {
    // 분류 칸 "건축구조용 표면처리"(앞 쪽 2행) + 다음 쪽 "경량형강(KS D 3854)"(3행), 시험종목 열은 행마다 새 칸,
    // 시험빈도 열 칸은 다음 쪽에 글이 없어 클립 없이 넘어간다 (쪽 경계가 행 묶음 안을 지남)
    const prev = grid(3, 3, [[0, 0, "구분"], [0, 1, "시험종목"], [0, 2, "시험빈도"], [1, 0, "건축구조용 표면처리", 1, 2], [1, 1, "화학성분"], [2, 1, "항복점"], [1, 2, "·제조회사별", 1, 2]])
    const curr = grid(3, 3, [[0, 0, "경량형강(KS D 3854)", 1, 3], [0, 1, "인장강도"], [1, 1, "연신율"], [2, 1, "굽힘성"]])
    for (let r = 0; r < 3; r++) FILLER_CELLS.add(curr.cells[r][2])
    lines(prev.cells[1][0], [[5, 95, 49], [5, 95, 34]]) // 앞 조각 밑변 30 — 끝줄 기준선 34
    lines(prev.cells[2][1], [[105, 150, 34]])
    lines(curr.cells[0][1], [[105, 150, 780]])
    const res = joinSplitParts(prev, [0, 100, 300, 400], curr, [0, 100, 300, 400], 0, 30)
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 6)
    assert.equal(res.table.cells[1][0].text, "건축구조용 표면처리\n경량형강(KS D 3854)")
    assert.equal(res.table.cells[1][0].rowSpan, 5)
    assert.equal(res.table.cells[1][2].rowSpan, 5)
    // 글이 칸 가운데(바닥에서 떨어짐)면 새 분류 칸
    const prev2 = grid(3, 3, [[0, 0, "구분"], [0, 1, "시험종목"], [0, 2, "시험빈도"], [1, 0, "석고보드", 1, 2], [1, 1, "휨파괴하중"], [2, 1, "함수율"], [1, 2, "·제조회사별", 1, 2]])
    lines(prev2.cells[1][0], [[5, 95, 60]])
    const curr2 = grid(1, 3, [[0, 0, "섬유강화 시멘트판"], [0, 1, "겉모양"]])
    FILLER_CELLS.add(curr2.cells[0][2])
    const res2 = joinSplitParts(prev2, [0, 100, 300, 400], curr2, [0, 100, 300, 400], 0, 30)
    assert.ok(res2)
    assert.equal(res2.table.cells[1][0].rowSpan, 2)
    assert.equal(res2.table.cells[3][0].text, "섬유강화 시멘트판")
  })

  it("줄이 많은 칸은 위에서부터 차 바닥에 닿은 것이라 쪽 경계에 걸친 글로 보지 않는다 (\"라. …\" 뒤 새 칸 \"마. …\")", () => {
    const prev = grid(3, 3, [[0, 0, "구분"], [0, 1, "내용"], [0, 2, "비고"], [1, 0, "라. 항공경찰관 점퍼 제식", 1, 2], [1, 1, "색상"], [2, 1, "재질"], [1, 2, "공통", 1, 2]])
    const curr = grid(2, 3, [[0, 0, "마. 항공경찰관 모자", 1, 2], [0, 1, "색상"], [1, 1, "재질"]])
    for (let r = 0; r < 2; r++) FILLER_CELLS.add(curr.cells[r][2])
    lines(prev.cells[1][0], [[5, 95, 79], [5, 95, 64], [5, 95, 49], [5, 95, 34]])
    const res = joinSplitParts(prev, [0, 100, 300, 400], curr, [0, 100, 300, 400], 0, 30)
    assert.ok(res && !res.split)
    assert.equal(res.table.cells[1][0].rowSpan, 2)
    assert.equal(res.table.cells[3][0].text, "마. 항공경찰관 모자")
  })

  it("모든 칸이 쪽 경계에서 끝나면 바닥 가까운 두 행 칸 글도 다음 쪽 첫 행 새 칸과 잇지 않는다 (되풀이된 \"<공동>\", 새 과제 \"4-30\")", () => {
    const prev = grid(3, 2, [[0, 0, "담당부서"], [0, 1, "부서"], [1, 0, "<공동>", 1, 2], [1, 1, "관세청"], [2, 1, "마약과"]])
    const curr = grid(2, 2, [[0, 0, "<공동>", 1, 2], [0, 1, "대검찰청"], [1, 1, "마약과"]])
    lines(prev.cells[1][0], [[20, 60, 40]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300], 0, 30)
    assert.ok(res)
    assert.equal(res.table.cells[1][0].rowSpan, 2)
    assert.equal(res.table.cells[3][0].text, "<공동>")
    const prev2 = grid(3, 2, [[0, 0, "번호"], [0, 1, "지표"], [1, 0, "4-29", 1, 2], [1, 1, "트램 구축거리"], [2, 1, "tCO2/km"]])
    const curr2 = grid(3, 2, [[0, 0, "4-30", 1, 3], [0, 1, "설치 도로면적"], [1, 1, "0.0408"], [2, 1, "tCO2eq/㎡"]])
    lines(prev2.cells[1][0], [[40, 60, 39]]) // 앞 조각 밑변 30 — 한 줄 기준선 39 (글자 크기 10 의 1.2 배 안)
    const res2 = joinSplitParts(prev2, [0, 100, 300], curr2, [0, 100, 300], 0, 30)
    assert.ok(res2 && !res2.split)
    assert.equal(res2.table.cells[1][0].text, "4-29")
    assert.equal(res2.table.cells[1][0].rowSpan, 2)
    assert.equal(res2.table.cells[3][0].text, "4-30")
  })
})

describe("쪽 넘김 2차 — 쪼개진 틀 칸 잇기", () => {
  it("블록(칸 안 표)을 가진 칸에 뒤 쪽 글 조각을 이으면 블록으로 이어 렌더에서 빠지지 않는다", () => {
    const inner: IRBlock = { type: "table", table: grid(1, 1, [[0, 0, "HwpCtrl.Run(\"TableCellBlock\");"]]) }
    const prev = grid(1, 1, [[0, 0, "function InsertBgImg() {"]])
    prev.cells[0][0].blocks = [{ type: "paragraph", text: "function InsertBgImg() {" }, inner]
    const curr = grid(1, 1, [[0, 0, "act = HwpCtrl.CreateAction(\"CellBorderFill\");\nset = act.CreateSet();"]])
    lines(prev.cells[0][0], [[10, 290, 60], [10, 150, 45]])
    lines(curr.cells[0][0], [[10, 290, 780], [10, 120, 765]])
    // 글 이어짐 증거 대신 칸 조각 이어짐으로 합치게 — 두 쪽 모두 클립 없는 둘째 열
    const p2 = grid(1, 2, [[0, 0, ""], [0, 1, ""]]), c2 = grid(1, 2, [[0, 0, ""], [0, 1, ""]])
    p2.cells[0][0] = prev.cells[0][0]; FILLER_CELLS.add(p2.cells[0][1])
    c2.cells[0][0] = curr.cells[0][0]; FILLER_CELLS.add(c2.cells[0][1])
    const res = joinSplitParts(p2, [0, 300, 320], c2, [0, 300, 320])
    assert.ok(res?.split)
    const cell = res.table.cells[0][0]
    assert.deepEqual(cell.blocks!.map(b => b.type === "table" ? "table" : b.text), ["function InsertBgImg() {", "table", "act = HwpCtrl.CreateAction(\"CellBorderFill\");", "set = act.CreateSet();"])
  })
})
