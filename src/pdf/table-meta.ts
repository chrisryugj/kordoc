/**
 * PDF 표 IR 곁정보 — 블록 조립 뒤 단계(같은 쪽 인접 병합·쪽 넘김 병합)가 쓰는 기하 사실.
 * IR 타입을 늘리지 않으려고 표 객체를 키로 한 약한 참조 표에 둔다 (공개 IR 에는 나가지 않는다).
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import type { LineSegment } from "./line-types.js"

/** 한컴 셀 클립으로 셀 기하가 확정된 표 — 클립 묶음이 이미 표 경계다 */
export const CLIP_TABLES = new WeakSet<IRTable>()
/** 번호 칩·빈 간격·한 줄 제목으로 확인된 장식 상자 — keep 원본 표를 남기고 출력에서만 문단으로 편다 */
export const FRAME_TITLE_BLOCKS = new WeakMap<IRTable, IRBlock>()
/** 표의 열 경계 x (그리드 좌표, 오름차순) */
export const TABLE_COLXS = new WeakMap<IRTable, number[]>()
/** 클립 표 첫 조각(첫 쪽)의 행 경계 y (위→아래 내림차순) — 쪽 넘김으로 밀려난 첫 행 묶음의 높이를 잰다 (table-parts) */
export const TABLE_ROWYS = new WeakMap<IRTable, number[]>()
/** 마지막 행 칸이 다음 쪽으로 넘어가 그 조각(CONT_PARTS)을 붙인 표 — 표가 실제로 끝나는 쪽과 그 쪽 조각의 밑변·높이
 *  (cell-continuation 이 기록, 쪽 넘김 잇기가 표 끝 자리로 본다) */
export const TABLE_TAIL = new WeakMap<IRTable, { page: number; y: number; height: number }>()
/** 쪽 넘김으로 이은 클립 표의 첫 조각 열 경계 — 이은 표의 TABLE_COLXS 는 모든 조각의 합집합이다 (table-parts) */
export const PART_COLXS = new WeakMap<IRTable, number[]>()
/** 글 없는 클립 표 — 앞 쪽 표가 넘어온 조각일 수 있어(Q&A 상자 마지막 빈 행이 다음 쪽으로 넘어감) 쪽 넘김 잇기까지만
 *  두고, 잇지 못하면 버린다 (mergeCrossPageTables) */
export const EMPTY_PARTS = new WeakSet<IRTable>()
/** 셀 영역에 그림이 놓인 칸 — PDF 는 그림을 셀 글과 따로 뽑아 셀 text 가 비지만, HWP 계열은 셀에 그림 참조가 들어가
 *  비지 않은 칸이다(보도자료 머리표 오른쪽 끝 로고 칸). 후행 빈 열 판정(table-trim)에서 빈 칸으로 보지 않는다 */
export const IMAGE_CELLS = new WeakSet<IRCell>()
/** 그림 칸(IMAGE_CELLS)의 칸 사각형 (쪽 좌표, y 는 아래가 0) — 그림 영역 OCR 결과가 표와 겹쳐 버려지지 않고 그 칸에 들어가게 (#225) */
export const IMAGE_CELL_BOXES = new WeakMap<IRCell, { x1: number; y1: number; x2: number; y2: number }>()
/** 클립이 없던 자리를 메운 칸 — 쪽 넘김 조각을 이을 때 비어 있는 자리로 본다 (앞 쪽 세로 병합이 이어진 칸) */
export const FILLER_CELLS = new WeakSet<IRCell>()
/** 앞 쪽 칸의 이어짐인 1칸 조각 → 그 앞 쪽 칸의 클립 사각형 (clip-cells 판정, cell-continuation 이 앞 쪽 표 그 칸에 붙인다) */
export const CONT_PARTS = new WeakMap<IRTable, { x1: number; x2: number }>()

/** 칸 글줄 상자 (쪽 좌표, y 는 기준선) — 쪽 넘김 이음 행이 한 칸의 두 조각인지 가를 때 쓴다 (table-parts) */
export interface LineBox { y: number; l: number; r: number; h: number }
/** 클립 표 칸의 글줄 상자, 위→아래 */
export const CELL_LINES = new WeakMap<IRCell, LineBox[]>()

/** 칸 글 조각을 글줄로 묶어 기록 — 기준선이 글자 크기 0.6배(최소 3pt) 안이면 한 줄 (cellTextToString 과 같은 묶음) */
export function recordCellLines(cell: IRCell, items: ReadonlyArray<{ x: number; y: number; w: number; fontSize: number; h: number }>): void {
  const lines: LineBox[] = []
  for (const it of [...items].sort((a, b) => b.y - a.y)) {
    const fs = it.fontSize || it.h
    const last = lines[lines.length - 1]
    if (last && Math.abs(last.y - it.y) <= Math.max(3, Math.min(fs, last.h) * 0.6)) {
      last.l = Math.min(last.l, it.x)
      last.r = Math.max(last.r, it.x + it.w)
      last.h = Math.max(last.h, fs)
    } else lines.push({ y: it.y, l: it.x, r: it.x + it.w, h: fs })
  }
  CELL_LINES.set(cell, lines)
}

/** 클립 표 가로 괘선 — 표 윗변·밑변이 그어졌는지, 칸 밑변(표 밑변 제외) 가운데 괘선이 그어진 자리·안 그어진 자리 수.
 *  쪽 넘김 쪼개진 행 판정이 본다: 행 경계마다 괘선을 긋는 표에서 쪽 경계만 괘선이 없으면 한 칸이 쪽을 넘은 것이다 (table-parts) */
export interface RowRules { top: boolean; bottom: boolean; innerRuled: number; innerOpen: number }
export const ROW_RULES = new WeakMap<IRTable, RowRules>()

type Box = { x1: number; y1: number; x2: number; y2: number }
/** 가로 괘선이 칸 변(y, x1~x2)을 덮는 비율 — 괘선 y 가 1.5pt 안 */
function ruleCover(hs: ReadonlyArray<LineSegment>, y: number, x1: number, x2: number): number {
  const segs = hs.filter(l => Math.abs(l.y1 - y) <= 1.5 && l.x2 > x1 && l.x1 < x2).map(l => [Math.max(l.x1, x1), Math.min(l.x2, x2)]).sort((a, b) => a[0] - b[0])
  let len = 0, end = x1
  for (const [a, b] of segs) if (b > end) { len += b - Math.max(a, end); end = b }
  return x2 > x1 ? len / (x2 - x1) : 0
}

/** 칸 상자(클립)와 가로 괘선으로 ROW_RULES 기록 — 괘선이 변 폭의 90% 이상을 덮으면 그어진 변. 클립 없이 메운 칸은 보지 않는다 */
export function recordRowRules(table: IRTable, cells: ReadonlyArray<{ bbox: Box; filler?: boolean }>, bbox: Box, hs: ReadonlyArray<LineSegment>): void {
  const real = cells.filter(c => !c.filler)
  const edge = (y: number, pick: (c: { bbox: Box }) => number): boolean => {
    let w = 0, covered = 0
    for (const c of real) if (Math.abs(pick(c) - y) <= 1) { w += c.bbox.x2 - c.bbox.x1; covered += ruleCover(hs, y, c.bbox.x1, c.bbox.x2) * (c.bbox.x2 - c.bbox.x1) }
    return w > 0 && covered >= 0.9 * w
  }
  let innerRuled = 0, innerOpen = 0
  for (const c of real) {
    if (Math.abs(c.bbox.y1 - bbox.y1) <= 1) continue
    if (ruleCover(hs, c.bbox.y1, c.bbox.x1 + 0.5, c.bbox.x2 - 0.5) >= 0.9) innerRuled++
    else innerOpen++
  }
  ROW_RULES.set(table, { top: edge(bbox.y2, c => c.bbox.y2), bottom: edge(bbox.y1, c => c.bbox.y1), innerRuled, innerOpen })
}
