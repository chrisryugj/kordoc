/**
 * PDF 표 IR 곁정보 — 블록 조립 뒤 단계(같은 쪽 인접 병합·쪽 넘김 병합)가 쓰는 기하 사실.
 * IR 타입을 늘리지 않으려고 표 객체를 키로 한 약한 참조 표에 둔다 (공개 IR 에는 나가지 않는다).
 */

import type { IRCell, IRTable } from "../types.js"

/** 한컴 셀 클립으로 셀 기하가 확정된 표 — 클립 묶음이 이미 표 경계다 */
export const CLIP_TABLES = new WeakSet<IRTable>()
/** 표의 열 경계 x (그리드 좌표, 오름차순) */
export const TABLE_COLXS = new WeakMap<IRTable, number[]>()
/** 글 없는 클립 표 — 앞 쪽 표가 넘어온 조각일 수 있어(Q&A 상자 마지막 빈 행이 다음 쪽으로 넘어감) 쪽 넘김 잇기까지만
 *  두고, 잇지 못하면 버린다 (mergeCrossPageTables) */
export const EMPTY_PARTS = new WeakSet<IRTable>()
/** 셀 영역에 그림이 놓인 칸 — PDF 는 그림을 셀 글과 따로 뽑아 셀 text 가 비지만, HWP 계열은 셀에 그림 참조가 들어가
 *  비지 않은 칸이다(보도자료 머리표 오른쪽 끝 로고 칸). 후행 빈 열 판정(table-trim)에서 빈 칸으로 보지 않는다 */
export const IMAGE_CELLS = new WeakSet<IRCell>()
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
