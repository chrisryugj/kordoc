/**
 * PDF 표 조립 회귀 — 쪽 넘김 잇기(table-parts)·후행 빈 열(table-trim)·클립 격자 보강(clip-cells).
 *
 * 한컴 PDF 실측에서 온 규칙들: 쪽마다 그 쪽에 그려진 칸만 클립으로 깔리고(조각마다 열 구성이 다름), 쪽 끝 행은
 * 쪼개졌든 아니든 본문 바닥까지 늘려 그려지며, 폭 3pt 안팎의 좁은 빈 칸은 클립 없이 배경 채움만 그려진다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { joinSplitParts, mergeCrossPageTables } from "../src/pdf/table-parts.js"
import { WrapLexicon } from "../src/pdf/line-wrap.js"
import { CLIP_TABLES, EMPTY_PARTS, FILLER_CELLS, TABLE_COLXS, CELL_LINES, ROW_RULES, recordCellLines } from "../src/pdf/table-meta.js"
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
  it("두 쪽 모두 단위 행으로 시작하면 열이 같아도 별도 표로 둔다", () => {
    const make = (name: string, page: number): IRBlock => {
      const table = grid(3, 3, [[0, 0, "(단위: ha, %)", 3], [1, 0, "지역"], [1, 1, "2025"], [1, 2, "2026"], [2, 0, name], [2, 1, "1"], [2, 2, "2"]])
      TABLE_COLXS.set(table, [60, 160, 260, 360])
      return { type: "table", table, pageNumber: page, bbox: { page, x: 60, y: 60, width: 300, height: 700 } }
    }
    const blocks = [make("서울", 1), make("부산", 2)]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[1].table!.cells[2][0].text, "부산")
  })
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

  it("열 경계가 앞 조각 경계에 맞물리지 않는 다른 짜임의 표는 쪼개진 행·머리 행 증거 없이 잇지 않는다 (서식 표 다음 쪽 \"목 차\" 상자)", () => {
    // tac-img-02: 4쪽 과제 신청 서식 7열 표가 바닥까지 차고 5쪽 첫머리에 목차 상자 3열 — 가운데 경계 203·392 가 앞 표 경계 어디에도 없다
    const form = [60, 79, 104, 116, 141, 186, 360, 535]
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 7, [[0, 0, "구분"], [0, 5, "주관기관"], [0, 6, "참여기관"], [1, 0, "1"], [1, 5, "가"], [1, 6, "나"]]), form, 1, 70, 600),
      clipBlock(grid(3, 3, [[0, 1, "목 차"], [2, 0, "Ⅰ. 개요 00"]]), [61, 203, 392, 534], 2, 640, 130),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 2)
    // 뒤 조각이 앞 조각 경계의 부분 집합이면(세로 병합 칸이 넘어가 왼쪽 열이 빠진 조각) 종전대로 잇는다
    const blocks2: IRBlock[] = [
      clipBlock(grid(2, 3, [[0, 0, "구분"], [0, 1, "항목"], [0, 2, "내용"], [1, 0, "기타"], [1, 1, "가"], [1, 2, "나"]]), [60, 160, 300, 460], 1, 70, 600),
      clipBlock(grid(1, 2, [[0, 0, "다"], [0, 1, "라"]]), [160, 300, 460], 2, 640, 130),
    ]
    mergeCrossPageTables(blocks2, PAGE_H)
    assert.equal(blocks2.length, 1)
    // 첫 행이 앞 쪽 비고의 이어진 문단(한 칸)인 조각은 열 짜임이 달라도 종전대로 잇는다 (쪽마다 짜임을 바꾸는 과징금 산정기준 별표).
    // 첫 행부터 칸이 셋 이상인 조각은 제 열 짜임으로 시작한 새 표다 (다음 쪽 "담당자 | 업무내용 | 관련자료찾기" 새 장 표 — ice-jci·pcccr 실측)
    const blocks3: IRBlock[] = [
      clipBlock(grid(2, 7, [[0, 0, "구분"], [0, 5, "주관기관"], [0, 6, "참여기관"], [1, 0, "1"], [1, 5, "가"], [1, 6, "나"]]), form, 1, 70, 600),
      clipBlock(grid(2, 3, [[0, 0, "가. 제조(수입)업무의 정지처분을 갈음하여 부과하는 과징금", 3], [1, 0, "1"], [1, 1, "3만원"], [1, 2, "5억원 미만"]]), [61, 203, 392, 534], 2, 640, 130),
    ]
    mergeCrossPageTables(blocks3, PAGE_H)
    assert.equal(blocks3.length, 1)
    const blocks3b: IRBlock[] = [
      clipBlock(grid(2, 7, [[0, 0, "구분"], [0, 5, "주관기관"], [0, 6, "참여기관"], [1, 0, "1"], [1, 5, "가"], [1, 6, "나"]]), form, 1, 70, 600),
      clipBlock(grid(2, 3, [[0, 0, "담당자"], [0, 1, "업무내용"], [0, 2, "관련자료 찾기"], [1, 0, "교사"], [1, 1, "가. 사전교육"], [1, 2, "안전보건교육"]]), [61, 203, 392, 534], 2, 640, 130),
    ]
    mergeCrossPageTables(blocks3b, PAGE_H)
    assert.equal(blocks3b.length, 2)
    // 번호 칸 + 제목 칸 머리 상자("5 | 시험방법")도 새 상자다
    const blocks4: IRBlock[] = [
      clipBlock(grid(2, 7, [[0, 0, "구분"], [0, 5, "주관기관"], [0, 6, "참여기관"], [1, 0, "1"], [1, 5, "가"], [1, 6, "나"]]), form, 1, 70, 600),
      clipBlock(grid(1, 2, [[0, 0, "5"], [0, 1, "시험방법"]]), [61, 90, 534], 2, 740, 30),
    ]
    mergeCrossPageTables(blocks4, PAGE_H)
    assert.equal(blocks4.length, 2)
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

  it("신구조문 대비표의 '[별표 2] …' 행(현행·개정안 두 칸에 같은 글)은 첨부 머리표가 아니라 이어짐이다", () => {
    const blocks: IRBlock[] = [
      clipBlock(grid(2, 2, [[0, 0, "현 행"], [0, 1, "개정안"], [1, 0, "제5조 내용"], [1, 1, "제5조 개정 내용"]]), [60, 296, 532], 1, 70, 700),
      clipBlock(grid(2, 2, [[0, 0, "[별표 2] 과태료의 부과기준\n2. 개별기준"], [0, 1, "[별표 2] 과태료의 부과기준\n2. 개별기준"], [1, 0, "사. 법 제38조"], [1, 1, "사. ----"]]), [60, 296, 532], 2, 600, 167),
    ]
    mergeCrossPageTables(blocks, PAGE_H)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 4)
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

  it("홀로 선 첫소리 자모(U+1100~1112)는 호환 자모로 — 한컴 PDF 글머리 \"ᄋ (추진배경)\" → \"ㅇ (추진배경)\", 옛한글 음절은 그대로", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "\u110B (추진배경) 농업기계 \u1100\u119E\u11A8" },
      { type: "table", table: grid(1, 1, [[0, 0, "\u110B\n대전권"]]) },
    ]
    sanitizeBlockControlChars(blocks)
    assert.equal(blocks[0].text, "\u3147 (추진배경) 농업기계 \u1100\u119E\u11A8")
    assert.equal(blocks[1].table!.cells[0][0].text, "\u3147\n대전권")
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
  it("칸 오른끝에 붙은 오른쪽 정렬 금액은 꺾인 숫자가 아니다 — 쌓인 \"500\" 둘을 잇지 않는다 (속초 세출예산서 OCR \"500500\")", () => {
    const right = (text: string, y: number) => ({ text, x: 414 - text.length * 5, y, w: text.length * 5, h: 10, fontSize: 10, fontName: "f" })
    assert.equal(cellTextToString([right("500", 100), right("500", 85)], { box: { x1: 336, x2: 418 } }), "500\n500")
    // 칸을 채운 줄에서 잘린 숫자는 칸 상자가 있어도 잇는다
    const full = (text: string, y: number, x: number) => ({ text, x, y, w: text.length * 5, h: 10, fontSize: 10, fontName: "f" })
    assert.equal(cellTextToString([full("1,234,567,8", 100, 338), full("90", 85, 338)], { box: { x1: 336, x2: 394 } }), "1,234,567,890")
  })
  it("좁은 쪽 번호 칸에 쌓인 세 자리 번호는 잇지 않는다 — 칸을 다 채우지 않은 줄 (현장실습 매뉴얼 목차 \"124135\")", () => {
    const page = (text: string, y: number) => ({ text, x: 480 - text.length * 6, y, w: text.length * 6, h: 10, fontSize: 10, fontName: "f" })
    assert.equal(cellTextToString([page("95", 120), page("124", 100), page("135", 85)], { box: { x1: 439, x2: 479 } }), "95\n124\n135")
    // 칸 폭을 꽉 채우고 꺾인 숫자는 잇는다
    const fill = (text: string, y: number) => ({ text, x: 441, y, w: text.length * 6, h: 10, fontSize: 10, fontName: "f" })
    assert.equal(cellTextToString([fill("123456", 100), fill("78", 85)], { box: { x1: 439, x2: 479 } }), "12345678")
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
  it("가운데 정렬 칸이라도 앞 조각 글이 문장 중간(목적격 조사·관형형)에서 끊기고 뒤 조각이 이어지는 말로 시작하면 쪼개진 행이다", () => {
    // 규제영향분석서 정성분석: "…폐기 사실을" / 다음 쪽 "입력하므로 제도 도입에 따른 발생 비용은 미미함" (가운데 정렬 — 끝줄이 오른끝 증거 없음)
    const prev = grid(2, 3, [[0, 0, "비용"], [0, 1, "편익"], [0, 2, "순비용"], [1, 0, "정부에서 구축한 농업기계\n신고관리시스템에 농업용\n지게차 제원 및\n폐기 사실을"], [1, 1, "농업용 지게차\n제원 및 폐기\n사실이\n농업기계\n신고관리시스템\n을 통해 이력"], [1, 2, ""]])
    const curr = grid(2, 3, [[0, 0, "입력하므로 제도\n도입에 따른\n발생 비용은\n미미함"], [0, 1, "관리되어\n농업인의 알\n권리를\n보장하고,\n정책에 활용"], [0, 2, ""], [1, 0, "주요내용", 3]])
    lines(prev.cells[1][0], [[20, 80, 60], [30, 70, 45]]) // 가운데 정렬 — 끝줄이 오른끝(95)에 못 미친다
    lines(curr.cells[0][0], [[25, 75, 780]])
    const res = joinSplitParts(prev, [0, 100, 200, 300], curr, [0, 100, 200, 300])
    assert.ok(res?.split)
    assert.equal(res.table.rows, 3)
    assert.match(res.table.cells[1][0].text, /폐기 사실을\n입력하므로/)
    // 앞 조각 글이 문장으로 끝났으면(미미함) 이어짐 증거가 아니다
    const prev2 = grid(2, 3, [[0, 0, "비용"], [0, 1, "편익"], [0, 2, "순비용"], [1, 0, "발생 비용은 미미함"], [1, 1, "보장함"], [1, 2, ""]])
    const curr2 = grid(1, 3, [[0, 0, "입력하므로"], [0, 1, "관리되어"], [0, 2, ""]])
    lines(prev2.cells[1][0], [[20, 80, 60]])
    const res2 = joinSplitParts(prev2, [0, 100, 200, 300], curr2, [0, 100, 200, 300])
    assert.ok(res2 && !res2.split)
  })

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

  it("머리 칸이 바로 다음 항목으로 시작하고 다른 칸이 서로 다른 한 줄 값이면 끝줄이 꽉 차도 새 행이다 (총포화약법 커. / 터.)", () => {
    const prev = grid(1, 2, [[0, 0, "커. 안전방호를 위한\n명령 불이행\n1) 1회 위반\n2) 2회 이상 위반"], [0, 1, "법 제47조"]])
    const curr = grid(1, 2, [[0, 0, "터. 수출하기 위한 목적으로\n국내에 판매한 때"], [0, 1, "법 제45조"]])
    // 좁은 칸이라 앞 조각 끝줄 "2) 2회 이상 위반" 이 오른끝까지 차고(글 이어짐처럼 보임), 값 칸 "법 제47조" 도 칸을 꽉 채운다(끝난 이름표 아님)
    lines(prev.cells[0][0], [[3, 60, 120], [3, 50, 105], [3, 70, 90], [3, 97, 75]])
    lines(prev.cells[0][1], [[103, 157, 120]])
    lines(curr.cells[0][0], [[3, 97, 780], [3, 70, 765]])
    lines(curr.cells[0][1], [[103, 157, 780]])
    const res = joinSplitParts(prev, [0, 100, 160], curr, [0, 100, 160])
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 2)
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

  it("다음 쪽 선 표 첫 행이 앞 표 첫 행과 같은 세로 병합 머리 모양인데 글이 다르면 새 상자다 (\"일 러 두 기\" 상자 다음 쪽 \"목 차\" 상자)", () => {
    const line = (t: IRTable, xs: number[], page: number, y: number, h: number): IRBlock => {
      TABLE_COLXS.set(t, xs)
      return { type: "table", table: t, pageNumber: page, bbox: { page, x: xs[0], y, width: xs[xs.length - 1] - xs[0], height: h } }
    }
    const box = (title: string, body: string): IRTable => grid(3, 3, [[0, 0, ""], [0, 1, title, 1, 2], [0, 2, ""], [1, 0, ""], [1, 2, ""], [2, 0, body, 3]])
    const blocks: IRBlock[] = [line(box("일 러 두 기", "□ 본 보도자료는 …"), [60, 200, 400, 540], 1, 70, 700), line(box("목 차", "□ 결과(요약) … 1"), [60, 200, 400, 540], 2, 400, 370)]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 2)
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

  it("보도자료 연락처 표의 다음 부처 묶음(담당 부서·책임자 되풀이)은 새 표가 아니다", () => {
    // 정부합동 보도자료 — HWPX 는 부처마다 "담당 부서 | 부처 | 책임자 | 직위 | 이름 | 연락처" 묶음을 한 표에 잇는다(연락처 표 522개 중
    // 여러 묶음 72개, 묶음마다 따로 둔 표 0개)
    const group = (dept: string, name: string, tel: string): IRTable => grid(2, 6, [[0, 0, "담당 부서"], [0, 1, dept], [0, 2, "책임자"], [0, 3, "과장"], [0, 4, name], [0, 5, tel],
      [1, 0, ""], [1, 1, "과"], [1, 2, "담당자"], [1, 3, "사무관"], [1, 4, "김철수"], [1, 5, "(044-000-0001)"]])
    const xs = [59, 122, 273, 334, 390, 446, 536]
    const blocks: IRBlock[] = [
      clipBlock(group("재정경제부", "홍길동", "(044-215-0000)"), xs, 1, 82, 200),
      clipBlock(group("산업통상부", "강규형", "(044-203-4260)"), xs, 2, 642, 125),
    ]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 4)
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
  it("모든 칸이 경계에서 끝나도 두 조각 글이 문서 어휘로 어절 중간 이음이면 세로 병합 칸으로 잇는다 (\"시멘트안정처리 / 기층\", \"급속함수량측 / 정기 사용불가\")", () => {
    // 문서 어휘에 "…측정기" 만 있고 "시멘트안정처리기층" 은 없다 — 한 열의 어절 중간 이음이 같은 경계의 다른 이름표 칸도 잇게 한다
    const lex = new WrapLexicon()
    lex.addLine("노상 및 기층 공사 급속함수량측정기 사용불가 조건")
    const prev = grid(2, 3, [[0, 0, "종별"], [0, 1, "시험종목"], [0, 2, "비고"], [1, 0, "시멘트안정처리"], [1, 1, "밀도"], [1, 2, "급속함수량측"]])
    const curr = grid(2, 3, [[0, 0, "기층", 1, 2], [0, 1, "함수비"], [1, 1, "다짐"], [0, 2, "정기 사용불가", 1, 2]])
    lines(prev.cells[1][0], [[5, 95, 40]]) // 글이 바닥(30)에서 한 줄 위 — 바닥 근접 검사로는 새 칸
    lines(prev.cells[1][2], [[305, 395, 40]])
    const res = joinSplitParts(prev, [0, 100, 300, 400], curr, [0, 100, 300, 400], 0, 30, lex)
    assert.ok(res && !res.split)
    assert.equal(res.table.cells[1][0].text, "시멘트안정처리\n기층")
    assert.equal(res.table.cells[1][0].rowSpan, 3)
    assert.equal(res.table.cells[1][2].rowSpan, 3)
    // 어휘 증거가 띄움이면(새 칸 이름) 종전대로 새 칸
    const lex2 = new WrapLexicon()
    lex2.addLine("시멘트안정처리 기층 공사 급속함수량측 정기 사용불가")
    const prev2 = grid(2, 3, [[0, 0, "종별"], [0, 1, "시험종목"], [0, 2, "비고"], [1, 0, "시멘트안정처리"], [1, 1, "밀도"], [1, 2, "급속함수량측"]])
    const curr2 = grid(2, 3, [[0, 0, "기층", 1, 2], [0, 1, "함수비"], [1, 1, "다짐"], [0, 2, "정기 사용불가", 1, 2]])
    lines(prev2.cells[1][0], [[5, 95, 33]])
    lines(prev2.cells[1][2], [[305, 395, 33]])
    const res2 = joinSplitParts(prev2, [0, 100, 300, 400], curr2, [0, 100, 300, 400], 0, 30, lex2)
    assert.ok(res2)
    assert.equal(res2.table.cells[1][0].rowSpan, 1)
  })

  it("세로 병합 이름표를 이은 뒤 그 행이 쪼개진 행이면 다시 잇는다 (규제영향분석서 \"일몰설정/예외기준\" + \"…되어야 / 하는 규제\")", () => {
    // 앞 쪽 끝: 일몰설정 | 1. 국제조약 … 되어야 | 미해당, 다음 쪽: 예외기준(2행) | 하는 규제 | (클립 없음) / 2. 국가의 … | 미해당
    const prev = grid(2, 3, [[0, 0, "대분류"], [0, 1, "소분류"], [0, 2, ""], [1, 0, "일몰설정"], [1, 1, "1. 국제조약 등에 따라 동일하게 적용 되어야"], [1, 2, "미해당"]])
    const curr = grid(2, 3, [[0, 0, "예외기준", 1, 2], [0, 1, "하는 규제"], [1, 1, "2. 국가의 질서 유지"], [1, 2, "미해당"]])
    FILLER_CELLS.add(curr.cells[0][2])
    lines(prev.cells[1][0], [[10, 60, 33]]) // 앞 조각 밑변 30 — 이름표 글이 쪽 경계에 걸침
    lines(prev.cells[1][1], [[75, 290, 33]])
    const res = joinSplitParts(prev, [0, 70, 300, 360], curr, [0, 70, 300, 360], 0, 30)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 3)
    assert.equal(res.table.cells[1][0].text, "일몰설정\n예외기준")
    assert.equal(res.table.cells[1][0].rowSpan, 2)
    assert.equal(res.table.cells[1][1].text, "1. 국제조약 등에 따라 동일하게 적용 되어야\n하는 규제")
    assert.equal(res.table.cells[2][1].text, "2. 국가의 질서 유지")
    // 글 이어짐 증거 없이 이어 늘린 빈 칸 조각만 있으면 다시 보지 않는다 (시험기준표 "KS M ISO 2507-1," / "KS M ISO 2507-2" 두 행)
    const prev2 = grid(2, 3, [[0, 0, "구분"], [0, 1, "시험방법"], [0, 2, "비고"], [1, 0, "IDDV"], [1, 1, "KS M ISO 2507-1,"], [1, 2, ""]])
    const curr2 = grid(2, 3, [[0, 0, "(ISO 3633)", 1, 2], [0, 1, "KS M ISO 2507-2"], [1, 1, "KS M 3401"], [1, 2, ""]])
    FILLER_CELLS.add(curr2.cells[0][2])
    lines(prev2.cells[1][0], [[10, 40, 33]])
    lines(prev2.cells[1][1], [[75, 160, 33]])
    const r2 = joinSplitParts(prev2, [0, 70, 300, 360], curr2, [0, 70, 300, 360], 0, 30)
    assert.ok(r2 && !r2.split)
    assert.equal(r2.table.cells[2][1].text, "KS M ISO 2507-2")
  })

  it("두 행 이상 덮은 이름표 칸 아래 뒤 조각 첫 칸이 비어 있으면 모든 칸이 경계에서 끝나도 세로로 잇는다 (aift \"자본잠식현황\"·\"자본총계\")", () => {
    // 앞 쪽: 자본잠식현황(2행) | 자본총계(2행) | 20××년 …, 다음 쪽: 빈 칸(4행) | 빈 칸(1행) | 20××년 … + 자본금(3행)
    const prev = grid(3, 3, [[0, 0, "구분"], [0, 1, "항목"], [0, 2, "연도"], [1, 0, "자본잠식현황", 1, 2], [1, 1, "자본총계", 1, 2], [1, 2, "20××년"], [2, 2, "20××년"]])
    const curr = grid(4, 3, [[0, 0, "", 1, 4], [0, 1, ""], [0, 2, "20××년"], [1, 1, "자본금", 1, 3], [1, 2, "20××년"], [2, 2, "20××년"], [3, 2, "20××년"]])
    const res = joinSplitParts(prev, [0, 100, 200, 400], curr, [0, 100, 200, 400], 0, 30)
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 7)
    assert.equal(res.table.cells[1][0].rowSpan, 6)
    assert.equal(res.table.cells[1][1].rowSpan, 3)
    assert.equal(res.table.cells[4][1].text, "자본금")
    // 이름표 칸이 한 행이면(행마다 새 칸) 빈 칸이어도 잇지 않는다
    const prev2 = grid(2, 2, [[0, 0, "구분"], [0, 1, "값"], [1, 0, "가"], [1, 1, "1"]])
    const curr2 = grid(1, 2, [[0, 0, ""], [0, 1, "2"]])
    const res2 = joinSplitParts(prev2, [0, 100, 200], curr2, [0, 100, 200], 0, 30)
    assert.ok(res2)
    assert.equal(res2.table.cells[1][0].rowSpan, 1)
    // 왼쪽 이름표 열에 새 묶음 이름이 있으면 오른쪽 빈 비고 칸은 새 칸이다 (시험기준표 "드레인보드")
    const prev3 = grid(3, 3, [[0, 0, "구분"], [0, 1, "시험종목"], [0, 2, "비고"], [1, 0, "토목용 부직포", 1, 2], [1, 1, "겉모양"], [2, 1, "두께"], [1, 2, "시험방법은 개정 검토중", 1, 2]])
    const curr3 = grid(2, 3, [[0, 0, "드레인보드", 1, 2], [0, 1, "인장강도"], [1, 1, "투수계수"], [0, 2, "", 1, 2]])
    const res3 = joinSplitParts(prev3, [0, 100, 200, 400], curr3, [0, 100, 200, 400], 0, 30)
    assert.ok(res3)
    assert.equal(res3.table.cells[1][2].rowSpan, 2)
    assert.equal(res3.table.cells[3][0].text, "드레인보드")
  })

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

  it("앞 조각에 한 행만 보인 칸도 글이 쪽 경계에 걸치고(바닥 반 줄 안) 뒤 조각 칸이 여러 행을 덮으면 잇는다 (TRL 표 \"제품화 / 단계\")", () => {
    const make = (baseline: number) => {
      const prev = grid(2, 3, [[0, 0, "구분"], [0, 1, "단계"], [0, 2, "정의"], [1, 0, "제품화"], [1, 1, "7"], [1, 2, "신뢰성 평가 및"]])
      const curr = grid(3, 3, [[0, 0, "단계", 1, 3], [0, 2, "수요기업 평가", 1, 2], [2, 1, "8"], [2, 2, "시제품 인증"]])
      for (let r = 0; r < 2; r++) FILLER_CELLS.add(curr.cells[r][1]) // "7" 칸이 쪽 경계를 넘어 이어진다
      lines(prev.cells[1][0], [[5, 95, baseline]]) // 앞 조각 밑변 30
      lines(prev.cells[1][2], [[105, 290, baseline]])
      return joinSplitParts(prev, [0, 100, 300, 400], curr, [0, 100, 300, 400], 0, 30)
    }
    const res = make(34)
    assert.ok(res && !res.split)
    assert.equal(res.table.cells[1][0].text, "제품화\n단계")
    assert.equal(res.table.cells[1][0].rowSpan, 4)
    assert.equal(res.table.cells[1][2].text, "신뢰성 평가 및\n수요기업 평가")
    // 글이 한 행 칸 가운데(바닥에서 9pt)면 새 칸 (규제영향분석서 "대분류" 다음 쪽 "일몰설정 예외기준")
    const res2 = make(39)
    assert.ok(res2)
    assert.equal(res2.table.cells[1][0].text, "제품화")
    assert.equal(res2.table.cells[2][0].text, "단계")
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

describe("쪽 넘김 2차 — 개조식 위계 이어짐", () => {
  it("앞 쪽 칸이 □ 제목 줄로 끝나고 뒤 쪽 같은 칸이 아래 단계 부호(ㅇ·-)로 시작하면 쪼개진 행이다", () => {
    // 과제 품목 명세서 "□ 개념 … □ 개발내용" / 다음 쪽 "ㅇ PFC 나노산소운반체의 …" — 제목 아래 내용이 없는 칸은 없다
    const prev = grid(2, 1, [[0, 0, "1. 개념 및 개발내용"], [1, 0, "□ 개념\nㅇ 혈액보다 산소 용해도가 높은 나노 입자\n□ 개발내용"]])
    const curr = grid(2, 1, [[0, 0, "ㅇ PFC 나노산소운반체의 최적 제조공정 개발"], [1, 0, "2. 지원 필요성"]])
    lines(prev.cells[1][0], [[10, 60, 90], [20, 250, 75], [10, 70, 60]])
    lines(curr.cells[0][0], [[20, 240, 780]])
    const res = joinSplitParts(prev, [0, 300], curr, [0, 300])
    assert.ok(res?.split)
    assert.equal(res.table.rows, 3)
    assert.equal(res.table.cells[1][0].text, "□ 개념\nㅇ 혈액보다 산소 용해도가 높은 나노 입자\n□ 개발내용\nㅇ PFC 나노산소운반체의 최적 제조공정 개발")
  })

  it("□ 절 안 목록이 쪽을 넘어 같은 단계 부호로 이어지면 쪼개진 행이다", () => {
    const prev = grid(1, 1, [[0, 0, "□ 개발내용\nㅇ 제형화 기술 개발\n- 주사제형화 기술 개발"]])
    const curr = grid(1, 1, [[0, 0, "ㅇ 최적 제조공정 개발"]])
    lines(prev.cells[0][0], [[10, 70, 90], [20, 150, 75], [30, 200, 60]])
    lines(curr.cells[0][0], [[20, 150, 780]])
    const res = joinSplitParts(prev, [0, 300], curr, [0, 300])
    assert.ok(res?.split)
  })

  it("다른 열에 새 이름표가 오면 개조식 부호로 시작해도 새 행이다", () => {
    const prev = grid(1, 2, [[0, 0, "추진배경"], [0, 1, "□ 현황\nㅇ 내용"]])
    const curr = grid(1, 2, [[0, 0, "추진계획"], [0, 1, "ㅇ 단계별 계획"]])
    lines(prev.cells[0][0], [[5, 50, 90]])
    lines(prev.cells[0][1], [[105, 150, 90], [115, 200, 75]])
    lines(curr.cells[0][0], [[5, 50, 780]])
    lines(curr.cells[0][1], [[115, 200, 780]])
    const res = joinSplitParts(prev, [0, 100, 300], curr, [0, 100, 300])
    assert.ok(res && !res.split)
  })

  it("□ 제목 줄 뒤에 같은 단계 □ 로 시작하면 새 행이다", () => {
    const prev = grid(1, 1, [[0, 0, "□ 개념\nㅇ 내용\n□ 개발내용"]])
    const curr = grid(1, 1, [[0, 0, "□ 추진체계"]])
    lines(prev.cells[0][0], [[10, 60, 90], [20, 150, 75], [10, 70, 60]])
    lines(curr.cells[0][0], [[10, 70, 780]])
    const res = joinSplitParts(prev, [0, 300], curr, [0, 300])
    assert.ok(res && !res.split)
  })
})

describe("쪽 넘김 3차 — 쪼개진 행의 내어쓰기·세로 병합 나머지", () => {
  it("앞 쪽에 문단 첫 줄 한 줄만 보이고 뒤 쪽 첫 줄이 내어쓴 자리에서 이어지면 쪼개진 행이다", () => {
    // 도시정비법 과징금: "3) 건설업자 또는 등록사업자가"(75~257) / 다음 쪽 "법 제132조제2항을 위반하여 …"(86~257), 오른쪽 칸 "공사비의" / "100분의 10"
    const xs = [58, 261.9, 410.4, 508.5]
    const prev = grid(1, 3, [[0, 0, "3) 건설업자 또는 등록사업자가"], [0, 1, ""], [0, 2, "공사비의"]])
    const curr = grid(1, 3, [[0, 0, "법 제132조제2항을 위반하여 시공외제안한 가액의 합이 500만원 이상 1천만원 미만인 경우"], [0, 1, ""], [0, 2, "100분의 10"]])
    lines(prev.cells[0][0], [[75, 257, 39]])
    lines(curr.cells[0][0], [[86, 257, 770], [86, 257, 751], [86, 248, 732]])
    lines(prev.cells[0][2], [[436, 484, 39]])
    lines(curr.cells[0][2], [[430, 490, 770]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 1)
    assert.match(res.table.cells[0][2].text, /공사비의\n100분의 10/)
    // 뒤 쪽 첫 줄이 새 항목 머리("4) …")면 들어가 있어도 새 행이다
    const curr2 = grid(1, 3, [[0, 0, "4) 건설업자 또는 등록사업자가 법 제132조제2항을 위반한 경우"], [0, 1, ""], [0, 2, "공사비의"]])
    lines(curr2.cells[0][0], [[86, 257, 770], [97, 200, 751]])
    lines(curr2.cells[0][2], [[436, 484, 770]])
    const res2 = joinSplitParts(prev, xs, curr2, xs)
    assert.ok(res2 && !res2.split)
  })

  it("가운데 정렬 칸은 뒤 쪽 짧은 첫 줄이 들어가 시작해도 내어쓰기 증거가 아니다", () => {
    const prev = grid(1, 2, [[0, 0, "가나다라마바사아자차카타파하"], [0, 1, "비고"]])
    const curr = grid(1, 2, [[0, 0, "거너더러머버서"], [0, 1, "비고 둘"]])
    lines(prev.cells[0][0], [[20, 280, 60]]) // 가운데 150
    lines(curr.cells[0][0], [[40, 260, 780]]) // 가운데 150, 오른끝도 20 들어감
    const res = joinSplitParts(prev, [0, 300, 400], curr, [0, 300, 400])
    assert.ok(res && !res.split)
  })

  it("내어쓰기가 글자 하나보다 깊은 칸도 같은 자리에서 시작한 짧은 줄이 있으면 왼쪽 정렬로 본다", () => {
    // 10pt 글자에 13pt 내어쓰기(154 → 167): 끝줄이 칸 글 왼끝에서 글자 하나 넘게 들어가 있다
    const prev = grid(1, 1, [[0, 0, "가. 다음의 어느 하나에 해당하는 사람 1명 이상 1) 관련 분야 기사 자격을 취득한 후"]])
    const curr = grid(1, 1, [[0, 0, "해당 실무경력이 3년 이상인 사람 2) 관련 학과 졸업"]])
    lines(prev.cells[0][0], [[154, 356, 106], [167, 356, 90], [167, 240, 74], [167, 356, 58]])
    lines(curr.cells[0][0], [[167, 356, 768], [167, 356, 752]])
    const res = joinSplitParts(prev, [151.6, 358.5], curr, [151.6, 358.5])
    assert.ok(res?.split)
  })

  it("뒤 쪽 칸이 여러 행을 덮으면 쪽 경계에 걸친 세로 병합 칸의 나머지로 이어 그 행 수만큼 덮는다", () => {
    // 외국환거래법: "다. 등록 또는 인가의 내용 / 이나 조건을 위반한 경우"(다음 쪽 두 행), 가운데 칸은 행마다 새 칸, 오른쪽 "업무정지 3개월"
    // 칸은 다음 쪽 첫 행 자리에 클립 없이 이어진다(칸 조각 이어짐) — 글 쌍 "1) 등록 또는 인가의 내용 / 이나 …" 는 줄 넘침
    const xs = [59.5, 202.1, 344.8, 504.6]
    const prev = grid(1, 3, [[0, 0, "다. 등록 또는 인가의 내용"], [0, 1, "1) 등록 또는 인가의 내용"], [0, 2, "업무정지 3개월"]])
    const curr = grid(2, 3, [[0, 0, "이나 조건을 위반한 경우", 1, 2], [0, 1, "이나 조건을 처음 위반한 경우"], [0, 2, ""], [1, 1, "2) 등록 또는 인가의 내용이나 조건을 위반"], [1, 2, "등록 또는 인가취소"]])
    FILLER_CELLS.add(curr.cells[0][2])
    lines(prev.cells[0][0], [[61, 201, 43]])
    lines(curr.cells[0][0], [[72, 198, 711]])
    lines(prev.cells[0][1], [[204, 343, 43]])
    lines(curr.cells[0][1], [[213, 343, 771], [213, 235, 753]])
    lines(prev.cells[0][2], [[425, 503, 43]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 2)
    assert.equal(res.table.cells[0][0].rowSpan, 2)
    assert.equal(res.table.cells[0][0].text, "다. 등록 또는 인가의 내용\n이나 조건을 위반한 경우")
    assert.equal(res.table.cells[0][2].rowSpan, 1)
    assert.equal(res.table.cells[1][2].text, "등록 또는 인가취소")
    // 칸 조각 이어짐이 없으면 여러 행 칸은 그 칸 글이 스스로 이어져야 한다 — 새로 시작한 세로 병합 칸(시험기준표 "KS F 4603")은 새 행
    const prev2 = grid(1, 3, [[0, 0, "H형강 말뚝"], [0, 1, "겉모양, 치수, 무게"], [0, 2, "KS D 3502\nKS F 4603"]])
    const curr2 = grid(2, 3, [[0, 0, "", 1, 2], [0, 1, "화학성분"], [0, 2, "KS F 4603", 1, 2], [1, 1, "기계적 성질"]])
    lines(prev2.cells[0][1], [[144, 230, 46]])
    lines(curr2.cells[0][1], [[144, 184, 753]])
    lines(prev2.cells[0][2], [[260, 314, 52], [260, 313, 40]])
    lines(curr2.cells[0][2], [[260, 313, 727]])
    const res2 = joinSplitParts(prev2, [57.1, 141.4, 239.5, 333.5], curr2, [57.1, 141.4, 239.5, 333.5])
    assert.ok(res2 && !res2.split)
  })

  it("앞 쪽 빈 칸 아래 뒤 쪽 칸이 여러 행을 덮으면 새로 시작한 세로 병합 이름표라 새 행이다", () => {
    // 가산대상 자격증: 앞 쪽 끝 행 직렬 칸이 비고 다음 쪽 첫 행에 "임업"(네 행) — 다른 열 끝줄이 꽉 차 보여도 잇지 않는다
    const xs = [0, 50, 100, 200]
    const prev = grid(1, 3, [[0, 0, ""], [0, 1, "생명유전"], [0, 2, "기사 자격증 가산비율 적용: 방사성동위원소취급자(일반), 방사선취급감독자"]])
    const curr = grid(2, 3, [[0, 0, "임업", 1, 2], [0, 1, "산림조경"], [0, 2, "기사 자격증 가산비율 적용: 나무의사"], [1, 1, "산림자원"], [1, 2, ""]])
    lines(prev.cells[0][2], [[105, 194, 83], [105, 195, 70], [105, 186, 57]])
    lines(curr.cells[0][2], [[105, 194, 767], [105, 116, 749]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res && !res.split)
    assert.equal(res.table.rows, 3)
  })
})

describe("쪽 넘김 3차 — 목록 이어짐·괘선 없는 쪽 경계·칸 조각 이어짐", () => {
  it("뒤 쪽 칸 첫 줄 번호가 앞 쪽 칸 목록의 다음 차례면 칸 안 문단 경계에서 쪼개진 행이다", () => {
    // 직무교육기관 장비: "1) … 8) 심폐소생 인체모형" / 다음 쪽 "9) 혈압계 …", 수량 칸 "1" 줄마다
    const xs = [70.2, 444.8, 507.1]
    const prev = grid(1, 2, [[0, 0, "1) 절연저항측정기\n2) 접지저항측정기\n8) 심폐소생 인체모형"], [0, 1, "1\n1\n1"]])
    const curr = grid(1, 2, [[0, 0, "9) 혈압계\n10) 혈당검사용 간이검사기"], [0, 1, "1\n1"]])
    lines(prev.cells[0][0], [[76, 160, 93], [76, 170, 74], [76, 194, 55]])
    lines(curr.cells[0][0], [[76, 128, 757], [76, 224, 738]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 1)
    // 행마다 항목 하나를 둔 표 — 앞 칸 첫 줄의 번호 다음 차례로 시작하는 뒤 칸은 새 행이다
    const prev2 = grid(1, 2, [[0, 0, "다. 법 제14조를 위반하여 신고하지 않은 경우"], [0, 1, "100"]])
    const curr2 = grid(1, 2, [[0, 0, "라. 법 제14조제4항을 위반한 경우"], [0, 1, "50"]])
    lines(prev2.cells[0][0], [[76, 300, 60]])
    lines(curr2.cells[0][0], [[76, 280, 760]])
    const res2 = joinSplitParts(prev2, xs, curr2, xs)
    assert.ok(res2 && !res2.split)
  })

  it("짝·홀 쪽으로 옮겨 맞댄 조각이 한 칸 제목 행을 되풀이하면 목록 번호 이어짐은 증거가 아니다 (쪽마다 새로 놓인 상자)", () => {
    // 편람 "작 성 방 법" 상자: "1. … 8. …" / 다음 쪽 "작 성 방 법" + "9. …" (HWPX 는 두 표)
    const prev = grid(2, 1, [[0, 0, "작 성 방 법"], [1, 0, "1. 행정기관명\n7. 시행 처리과명\n8. 우 도로명주소"]])
    const curr = grid(2, 1, [[0, 0, "작 성 방 법"], [1, 0, "9. 누리집(홈페이지) 주소"]])
    lines(prev.cells[1][0], [[95, 300, 160], [95, 350, 140], [108, 250, 120]])
    lines(curr.cells[1][0], [[95, 400, 700]])
    const shifted = joinSplitParts(prev, [87.5, 480.8], curr, [99, 492.3].map(x => x - 11.5), 11.5)
    assert.ok(shifted && !shifted.split)
    // 같은 자리 조각이면 목록 이어짐으로 잇는다
    const same = joinSplitParts(prev, [87.5, 480.8], curr, [87.5, 480.8])
    assert.ok(same?.split)
  })

  it("칸 밑변마다 괘선을 긋는 표에서 쪽 경계만 괘선이 없으면 글 증거 없이도 쪼개진 행이다", () => {
    // 군인연금법 유족 증명서류: "1. 가족관계증명서상 자녀인 경우" / 다음 쪽 "가. 군인등의 (상세)가족관계증명서" — 칸 안 문단 경계
    const xs = [58, 164.8, 531.2]
    const make = () => ({
      prev: grid(2, 2, [[0, 0, "마. 조부모"], [0, 1, "1. 군인등의 부모의 가족관계증명서"], [1, 0, "바. 손자녀"], [1, 1, "1. 가족관계증명서상 자녀인 경우"]]),
      curr: grid(2, 2, [[0, 0, "상이연금 등급"], [0, 1, "가. 군인등의 (상세)가족관계증명서"], [1, 0, ""], [1, 1, "2. 가족관계증명서상 자녀가 아닌 경우"]]),
    })
    const { prev, curr } = make()
    lines(prev.cells[1][1], [[168, 347, 42]])
    lines(curr.cells[0][1], [[180, 372, 770]])
    ROW_RULES.set(prev, { top: true, bottom: false, innerRuled: 3, innerOpen: 0 })
    ROW_RULES.set(curr, { top: false, bottom: true, innerRuled: 2, innerOpen: 0 })
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 3)
    // 쪽 경계에 괘선이 있으면(행 경계) 잇지 않는다
    const b = make()
    lines(b.prev.cells[1][1], [[168, 347, 42]])
    lines(b.curr.cells[0][1], [[180, 372, 770]])
    ROW_RULES.set(b.prev, { top: true, bottom: true, innerRuled: 3, innerOpen: 0 })
    ROW_RULES.set(b.curr, { top: true, bottom: true, innerRuled: 2, innerOpen: 0 })
    const res2 = joinSplitParts(b.prev, xs, b.curr, xs)
    assert.ok(res2 && !res2.split)
  })

  it("칸 조각 이어짐에 글 쌍이 둘 이상이면 뒤 조각 칸이 모두 여러 행을 덮거나, 괘선 없는 쪽 경계에서 줄 넘침이어야 잇는다", () => {
    // 선관위 자격증: "방송 | 통신사 | 기술사" / 다음 쪽 "통신(두 행) | (클립 없음) | (자격증종류는 …)(두 행)", 그 아래 "통신기술"
    const xs = [59.5, 100, 149, 226.9]
    const prev = grid(1, 3, [[0, 0, "방송"], [0, 1, "통신사"], [0, 2, "기술사"]])
    const curr = grid(2, 3, [[0, 0, "통신", 1, 2], [0, 1, ""], [0, 2, "( 자격증종류는 별표 12에 의함)", 1, 2], [1, 1, "통신기술"]])
    FILLER_CELLS.add(curr.cells[0][1])
    lines(prev.cells[0][0], [[69, 91, 42]])
    lines(prev.cells[0][2], [[150, 182, 42]])
    const res = joinSplitParts(prev, xs, curr, xs)
    assert.ok(res?.split)
    assert.equal(res.table.rows, 2)
    assert.equal(res.table.cells[0][0].text, "방송\n통신")
    assert.equal(res.table.cells[0][0].rowSpan, 2)
    assert.equal(res.table.cells[1][1].text, "통신기술")
    // 양곡가공업자 처분기준: 이름표 칸들은 클립 없이 이어지고 "영업정지 / 3개월" 은 57pt 칸에 한 줄로 못 들어간다
    const ys = [72.3, 282.6, 408.1, 465.1, 522]
    const mk = () => {
      const p = grid(1, 4, [[0, 0, "2) 과실인 경우"], [0, 1, "경고"], [0, 2, "영업정지"], [0, 3, "영업정지"]])
      const c = grid(1, 4, [[0, 0, ""], [0, 1, ""], [0, 2, "3개월"], [0, 3, "6개월"]])
      FILLER_CELLS.add(c.cells[0][0]); FILLER_CELLS.add(c.cells[0][1])
      lines(p.cells[0][2], [[416, 457, 88]]); lines(p.cells[0][3], [[473, 514, 88]])
      lines(c.cells[0][2], [[423, 451, 750]]); lines(c.cells[0][3], [[480, 507, 750]])
      return { p, c }
    }
    const a = mk()
    const res2 = joinSplitParts(a.p, ys, a.c, ys)
    assert.ok(res2?.split)
    assert.equal(res2.table.cells[0][2].text, "영업정지\n3개월")
    // 두 쪽 모두 쪽 경계에 괘선을 그었으면 세로 병합 이름표만 넘어간 새 행(규제영향분석서 "10.영향평가 여부" / "해당없음")과 못 가른다
    const b = mk()
    ROW_RULES.set(b.p, { top: true, bottom: true, innerRuled: 4, innerOpen: 0 })
    ROW_RULES.set(b.c, { top: true, bottom: true, innerRuled: 4, innerOpen: 0 })
    const res3 = joinSplitParts(b.p, ys, b.c, ys)
    assert.ok(res3 && !res3.split)
  })
})
