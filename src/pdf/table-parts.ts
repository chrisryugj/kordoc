/**
 * 쪽 넘김으로 갈라진 표 잇기 (mergeCrossPageTables) — 클립 표 조각은 열 경계 합집합 격자에 두 조각을 다시 놓는다.
 *
 * 한컴 PDF 는 쪽마다 그 쪽에 그려진 칸만 클립으로 깐다. 긴 서식 표(규제영향분석서 24×13)가 쪽을 넘으면 앞 조각은
 * 앞쪽 행들이 쓰는 열 경계만(13×9), 뒤 조각은 뒤쪽 행들이 쓰는 열 경계만(11×6) 갖고, 앞 쪽에서 세로 병합으로
 * 넘어온 칸("기타"·"12.규제일몰제")은 글이 없어 뒤 쪽에 클립조차 없다. 열 수가 달라 종전 병합(열 수 동일)은
 * 두 조각을 따로 냈다. 여기서는
 *  1) 두 조각의 열 경계 x 를 합쳐 공통 격자를 만들고 각 칸을 x 로 다시 놓은 뒤,
 *  2) 뒤 조각 첫 행부터 칸이 비어 있는 열은 앞 조각 마지막 행에서 그 열을 덮던 칸의 세로 병합을 이어 늘린다.
 * 원본(HWPX) 표 격자는 모든 행의 경계 합집합이라 이 재배치가 같은 격자를 되살린다.
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import { CELL_LINES, CLIP_TABLES, EMPTY_PARTS, FILLER_CELLS, IMAGE_CELLS, TABLE_COLXS } from "./table-meta.js"

/** 두 조각의 경계를 같은 것으로 보는 거리 (pt) — 클립 좌표 오차 0.05pt, 조각 간 반올림 여유 */
const PART_COL_TOL = 1

interface Anchor { r: number; c: number; rs: number; cs: number; cell: IRCell }

/** IR 격자 → 앵커 목록 (병합으로 덮인 칸 제외, 행 우선) */
function anchorsOf(table: IRTable): Anchor[] {
  const out: Anchor[] = []
  const covered = new Set<number>()
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(r * 100000 + c)) continue
      const cell = table.cells[r]?.[c]
      if (!cell) continue
      out.push({ r, c, rs: cell.rowSpan, cs: cell.colSpan, cell })
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) if (dr || dc) covered.add((r + dr) * 100000 + (c + dc))
      }
    }
  }
  return out
}

/** 오름차순 좌표 합집합 — 앞 조각 경계는 그대로 두고(조각 안 경계는 클립 격자가 0.3pt 로 이미 가름), 뒤 조각
 *  경계 가운데 앞 조각 경계와 PART_COL_TOL 안에 겹치는 것만 같은 경계로 본다 */
function unionCoords(a: number[], b: number[]): number[] {
  const out = [...a]
  for (const v of b) if (!a.some(x => Math.abs(x - v) <= PART_COL_TOL)) out.push(v)
  return out.sort((x, y) => x - y)
}

const indexOf = (coords: number[], x: number): number => {
  let best = -1, bestD = Infinity
  for (let i = 0; i < coords.length; i++) {
    const d = Math.abs(coords[i] - x)
    if (d < bestD) { bestD = d; best = i }
  }
  return bestD <= PART_COL_TOL ? best : -1
}

const rowText = (anchors: Anchor[], r: number): string =>
  anchors.filter(a => a.r === r).map(a => a.cell.text.replace(/\s+/g, "")).join("|")
/** 행 글(rowText)에 칸 구분자 말고 글이 있나 */
const hasText = (t: string): boolean => t.replace(/\|/g, "") !== ""

/**
 * 두 조각을 합집합 격자로 잇는다. 경계 대응이 안 되면(조각 경계가 합집합에서 사라짐) null.
 * @param pcx·ccx 앞·뒤 조각의 열 경계 x (오름차순, 뒤 조각은 앞 조각 자리로 옮긴 좌표)
 * @param dx 뒤 조각을 옮긴 거리 — 뒤 조각 칸 글줄도 같이 옮겨 앞 조각 글줄과 맞댄다 (짝·홀 쪽 대칭 여백)
 * @param prevBottom 앞 조각 밑변 y — 쪽 경계에 걸친 세로 병합 칸 글을 가린다 (mergeStraddlingCells)
 * @returns split — 경계 행을 쪼개진 행으로 보고 합쳤는지
 */
export function joinSplitParts(prev: IRTable, pcx: number[], curr: IRTable, ccx: number[], dx = 0, prevBottom?: number): { table: IRTable; colXs: number[]; split: boolean; header: boolean } | null {
  if (pcx.length !== prev.cols + 1 || ccx.length !== curr.cols + 1) return null
  const U = unionCoords(pcx, ccx)
  const cols = U.length - 1
  if (cols < 1) return null
  const pa = anchorsOf(prev), ca = anchorsOf(curr)

  // 반복 머리 행 — 한컴은 머리 칸이 있는 표만 조각마다 머리 행(여러 줄일 수 있음)을 되풀이한다. 표 첫 조각은 머리 행 위에
  // 제목 상자가 붙어 나올 수 있어(편람 [별표 4] "[별표4] <개정…>" 행) 앞 조각 두 행 아래까지 어긋나게 맞춰 본다 (어긋난 맞춤은 글 있는 행만)
  let skip = 0
  while (skip < Math.min(3, curr.rows - 1, prev.rows) && rowText(ca, skip) !== "" && rowText(ca, skip) === rowText(pa, skip)) skip++
  for (let h = 1; h <= 2 && !skip; h++) {
    while (skip < Math.min(3, curr.rows - 1, prev.rows - h) && hasText(rowText(ca, skip)) && rowText(ca, skip) === rowText(pa, h + skip)) skip++
  }

  const rows = prev.rows + curr.rows - skip
  const grid: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  const owner: (Anchor | null)[][] = Array.from({ length: rows }, () => new Array<Anchor | null>(cols).fill(null))
  const place = (a: Anchor, x: number[], rowOff: number, shift = 0): boolean => {
    const c1 = indexOf(U, x[a.c]), c2 = indexOf(U, x[a.c + a.cs])
    if (c1 < 0 || c2 <= c1) return false
    const r = a.r + rowOff
    const placed: Anchor = { r, c: c1, rs: a.rs, cs: c2 - c1, cell: a.cell }
    for (let dr = 0; dr < a.rs; dr++) for (let dc = c1; dc < c2; dc++) {
      if (r + dr < rows) owner[r + dr][dc] = placed
    }
    grid[r][c1] = { ...a.cell, colSpan: c2 - c1, rowSpan: a.rs }
    // 곁정보는 복사한 칸으로 옮긴다 — 세 쪽 넘게 이어질 때 다음 이음(글줄)과 후행 빈 열 정리(그림 칸)가 본다
    const lines = CELL_LINES.get(a.cell)
    if (lines) CELL_LINES.set(grid[r][c1], shift ? lines.map(l => ({ ...l, l: l.l + shift, r: l.r + shift })) : lines)
    if (IMAGE_CELLS.has(a.cell)) IMAGE_CELLS.add(grid[r][c1])
    return true
  }
  // 채움 칸(클립 없던 자리)은 놓지 않는다 — 빈 자리로 남아 아래 세로 병합 잇기가 채운다
  for (const a of pa) if (!FILLER_CELLS.has(a.cell) && !place(a, pcx, 0)) return null
  for (const a of ca) {
    if (a.r < skip || FILLER_CELLS.has(a.cell)) continue
    if (!place(a, ccx, prev.rows - skip, dx)) return null
  }

  // 뒤 조각 첫 행부터 비어 있는 열 — 앞 조각 마지막 행에서 그 열을 덮던 칸의 세로 병합을 잇는다
  const first = prev.rows
  for (let c = 0; c < cols; c++) {
    const above = owner[first - 1]?.[c]
    if (!above) continue
    let r = first
    while (r < rows && owner[r][c] === null) r++
    if (r === first) continue
    // 이어 늘릴 칸은 그 열 폭을 전부 덮는 칸이어야 한다 — 자기 폭 안의 모든 열이 같은 구간만큼 비어 있을 때만
    const span = r - first
    let ok = true
    for (let dc = above.c; dc < above.c + above.cs && ok; dc++) {
      for (let rr = first; rr < first + span; rr++) if (owner[rr][dc] !== null) { ok = false; break }
    }
    if (!ok) continue
    const newRs = above.rs + span
    grid[above.r][above.c].rowSpan = newRs
    const grown: Anchor = { ...above, rs: newRs }
    for (let rr = above.r; rr < above.r + newRs; rr++) for (let dc = above.c; dc < above.c + above.cs; dc++) owner[rr][dc] = grown
  }

  // 아무 칸도 덮지 않은 자리는 채움 칸으로 남긴다 — 이 표가 다시 앞 쪽 조각과 이어질 때(세 쪽 넘게) 빈 자리로 보고 세로 병합을 잇게
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (owner[r][c] === null) FILLER_CELLS.add(grid[r][c])
  const table: IRTable = { rows, cols, cells: grid, hasHeader: prev.hasHeader, ...(prev.caption ? { caption: prev.caption } : {}) }
  const split = rows > prev.rows && mergeSplitRow(table, owner, prev.rows, U)
  if (rows > prev.rows && !split && prevBottom !== undefined) mergeStraddlingCells(table, owner, prev.rows, prevBottom)
  // 머리 행 증거는 되풀이된 행에 글 있는 칸이 둘 이상일 때만 — 한 칸짜리 제목 행은 같은 제목의 상자를 쪽마다 새로 놓은 것과 구별이
  // 안 된다 (편람 기안문 "작성방법" 상자가 짝·홀 쪽에 하나씩 놓여 한 표로 이어졌다, HWPX 는 두 표)
  return { table, colXs: U, split, header: ca.filter(a => a.r < skip && a.cell.text.trim()).length >= 2 }
}

/**
 * 쪽 경계에 걸친 세로 병합 칸 — 행은 새로 시작해도(쪼개진 행 아님) 앞 쪽에서 두 행 이상 덮은 칸의 짧은 글(가운데 정렬)이 앞 조각
 * 바닥에 붙어 있으면 그 글은 쪽 경계에 걸쳐 다음 쪽 첫 행 칸으로 이어진다 (시험기준표 분류 칸 "건축구조용 표면처리 / 경량형강
 * (KS D 3854)"·"석고보드 / (GB-R)"). 두 칸을 한 세로 병합 칸으로 잇는다. 쪽 넘김 후보를 HWPX 로 대조한 세 세트(시험기준표·법령 별표
 * 2세트)에서 이 모양 11건이 모두 같은 칸 — 새 분류 칸은 글이 칸 가운데라 앞 조각 바닥에서 떨어져 있고, 긴 글 칸은
 * 줄 수로 거른다(위→아래로 차 바닥에 닿아도 다음 쪽이 새 칸일 수 있다: 복제 규칙 "라. 항공경찰관 점퍼 …" 12줄 → "마. …").
 * 쪽 경계가 행 묶음 안을 지날 때만 본다 — 다른 열 칸이 경계를 넘어 이어져야 한다(뒤 조각 첫 행 자리에 클립 없음, 11건 모두).
 * 모든 칸이 경계에서 끝나면 다음 쪽 첫 행은 새 묶음이다 (연락처 표 되풀이된 "<공동>" 5건, 과제 목록 두 행 칸 "4-29" 한 줄이
 * 바닥 가까이 있어도 다음 쪽 "4-30" 은 새 과제)
 */
function mergeStraddlingCells(table: IRTable, owner: (Anchor | null)[][], first: number, prevBottom: number): void {
  const last = first - 1
  if (!owner[first].some((o, c) => o !== null && o === owner[last][c])) return
  for (let c = 0; c < table.cols;) {
    const u = owner[last][c], d = owner[first][c]
    if (!u) { c++; continue }
    c = u.c + u.cs
    if (!d || d === u || u.r >= last || u.r + u.rs - 1 !== last || d.r !== first || d.c !== u.c || d.cs !== u.cs) continue
    const a = table.cells[u.r][u.c], b = table.cells[first][d.c]
    const U = CELL_LINES.get(a)
    if (!U?.length || U.length > STRADDLE_MAX_LINES || !hasContent(b)) continue
    const lu = U[U.length - 1]
    if (lu.y - prevBottom > STRADDLE_BOTTOM * (lu.h || 10)) continue
    appendCell(a, b)
    a.rowSpan = first + d.rs - u.r
    table.cells[first][d.c] = { text: "", colSpan: 1, rowSpan: 1 }
    const grown: Anchor = { ...u, rs: a.rowSpan }
    for (let rr = u.r; rr < u.r + grown.rs; rr++) for (let dc = u.c; dc < u.c + u.cs; dc++) owner[rr][dc] = grown
  }
}

/** 끝줄이 칸 글 폭 오른끝에 이만큼(글자 크기 배) 안이면 꽉 찬 줄 */
const FULL_LINE_TOL = 1
/** 끝줄 폭이 칸 폭의 이 비율 이상이어야 꽉 찬 줄 (좁은 칸의 짧은 낱말 제외) */
const FULL_LINE_MIN_FRAC = 0.5
/** 앞 쪽 한 줄짜리 칸: 끝줄과 칸 오른끝 사이 최대 거리 — 셀 안쪽 여백(기본 1.8mm ≈ 5pt) + 여유(pt), 어절 하나 폭(글자 크기 배) */
const FULL_LINE_EDGE_MIN = 12
const SINGLE_LINE_WORD_GAP = 3.5
/** 왼쪽 정렬 증거 — 왼끝에서 시작해 오른끝보다 글자 크기의 이 배수 넘게 짧은 줄 */
const SHORT_LINE_GAP = 1.5
/** 쪽 경계에 걸친 세로 병합 칸 — 글 줄 수 상한, 끝줄 기준선이 앞 조각 밑변 위 글자 크기의 이 배수 안 */
const STRADDLE_MAX_LINES = 3
const STRADDLE_BOTTOM = 1.2
/** 칸 조각 이어짐 증거로 보는 빈 자리 열의 최소 폭 (pt) — 클립 격자의 셀 최소 폭과 같다 */
const CARRIED_MIN_COL_W = 4
/** 끝난 이름표 — 한 줄 칸 오른쪽에 남은 자리가 글자 크기의 이 배수 이상 (숫자 머리 "4." 한 어절이 들어간다) */
const LABEL_ROOM = 1.5
/** 내어쓰기 이어짐 — 앞 끝줄이 칸 글 왼끝보다 글자 크기의 이 배수 이상 들어가 있고, 뒤 첫 줄 왼끝이 이 거리(pt) 안에서 같다 */
const HANGING_MIN = 0.5
const HANGING_TOL = 1

/**
 * 앞 쪽 칸(u)의 글이 뒤 쪽 칸(d)으로 이어지는지 — 앞 쪽 끝줄이 칸 글 폭 오른끝까지 차 있으면 문단 중간에서 끊긴 것이다
 * (줄은 다음 어절이 안 들어갈 때만 바뀐다). 가운데 정렬 칸은 끝줄이 가장 긴 줄일 뿐이어도 오른끝에 닿으므로, 왼끝에서
 * 시작해 오른끝에 못 미친 줄(문단 끝줄)이 두 조각 어딘가에 있는 칸만 본다.
 */
function continuesAcross(u: IRCell, d: IRCell, x1: number, x2: number): boolean {
  const U = CELL_LINES.get(u), D = CELL_LINES.get(d)
  if (!U?.length || !D?.length) return false
  const last = U[U.length - 1]
  const fs = last.h || 10
  let minL = Infinity, maxR = -Infinity
  for (const l of U) { minL = Math.min(minL, l.l); maxR = Math.max(maxR, l.r) }
  for (const l of D) { minL = Math.min(minL, l.l); maxR = Math.max(maxR, l.r) }
  // 칸 글 오른끝 — 가장 긴 줄의 오른끝과 칸 오른끝(왼쪽 안쪽 여백을 오른쪽에도 둔) 가운데 먼 쪽. 줄이 모두 짧은 칸은 끝줄이 가장 긴
  // 줄이어도 꽉 찬 게 아니다 (편람 대비표 "제44조의2 [이동 …]" 두 줄이 다 334pt 에서 끝나는데 칸 글 오른끝은 371pt). 가운데 정렬 칸은
  // 가장 긴 줄의 좌우 여백이 같아 두 값이 같다
  maxR = Math.max(maxR, x2 - (minL - x1))
  if (maxR - last.r > FULL_LINE_TOL * fs) return false
  // 앞 쪽에 한 줄뿐이면 그 줄이 곧 가장 긴 줄이라 위 비교는 늘 참이다 — 그때는 칸 오른끝에서 어절 하나 폭 안까지 닿아야 한다
  // (오른쪽이 들쭉날쭉한 칸은 다음 어절이 안 들어가 그만큼 남기고 줄이 바뀐다: "…규범적 / 성격의 규제" 37pt, 13pt 글자)
  if (U.length === 1 && x2 - last.r > Math.max(FULL_LINE_EDGE_MIN, SINGLE_LINE_WORD_GAP * fs)) return false
  if (last.r - last.l < FULL_LINE_MIN_FRAC * (x2 - x1)) return false
  const leftAligned = (l: { l: number; r: number }) => l.l - minL <= fs && maxR - l.r > SHORT_LINE_GAP * fs
  // 양쪽 맞춤이라 모든 줄이 꽉 차 문단 끝줄이 없는 칸 — 앞 쪽 끝줄이 내어쓴 자리(문단 둘째 줄 이후)에서 시작하고 뒤 쪽 첫 줄이
  // 같은 자리에서 이어지면 같은 문단이다 (제약기업 인증 규정 별첨 대비표 "1. 다음 각 목의 … 해 / 당하는 … 받지 않거 / 나, 그 행정처분을…":
  // 93 → 104 → 104). 새 문단이면 뒤 첫 줄이 문단 머리 자리에서 시작한다 (물관리 제안요청서 "‧다국적 …" 다음 "‧수질오염 …")
  const hanging = U.length >= 2 && U.every(l => maxR - l.r <= FULL_LINE_TOL * fs)
    && last.l - minL >= HANGING_MIN * fs && Math.abs(D[0].l - last.l) <= HANGING_TOL
  return U.some(leftAligned) || D.some(leftAligned) || hanging
}

/** 한 줄로 끝난 왼쪽 정렬 칸 — 오른쪽에 남은 자리(왼쪽 안쪽 여백만큼 뺀)가 글자 크기의 LABEL_ROOM 배 이상이라 다음 어절이 들어갈 수 있었다.
 *  가운데 정렬 칸은 좌우 여백이 같아 해당하지 않는다 */
function lineEnded(c: IRCell, x1: number, x2: number): boolean {
  const L = CELL_LINES.get(c)
  if (!L || L.length !== 1) return false
  const l = L[0]
  return (x2 - l.r) - (l.l - x1) >= LABEL_ROOM * (l.h || 10)
}

/**
 * 칸 조각 b 를 a 뒤에 잇는다. 어느 한쪽이 블록(칸 안 표를 품은 틀 칸의 문단·표)을 가지면 블록으로 잇는다 — 렌더는 블록을 먼저
 * 보므로 글만 이으면 사라진다 (코드 예시 틀 칸이 쪽을 넘을 때 다음 쪽 코드가 통째로 빠졌다). 블록 없는 쪽 글은 줄마다 문단으로
 */
function appendCell(a: IRCell, b: IRCell): void {
  if (a.blocks?.length || b.blocks?.length) {
    const asBlocks = (c: IRCell): IRBlock[] => c.blocks?.length ? c.blocks
      : c.text.split("\n").map(l => l.trim()).filter(Boolean).map((text): IRBlock => ({ type: "paragraph", text }))
    a.blocks = [...asBlocks(a), ...asBlocks(b)]
  }
  if (b.text.trim()) a.text = a.text.trim() ? a.text + "\n" + b.text : b.text
}

/** 칸에 내용이 있나 — 글·블록·그림 (그림은 PDF 에서 칸 글과 따로 뽑혀 text 가 빈다) */
const hasContent = (cell: IRCell): boolean => !!cell.text.trim() || !!cell.blocks?.length || IMAGE_CELLS.has(cell)

/**
 * 쪽 넘김으로 쪼개진 행 — 뒤 조각 첫 행을 앞 조각 마지막 행에 합친다. 한컴은 칸 단위로 나누지 않는 표의 긴 행을 글줄
 * 사이에서 끊어 두 쪽에 나눠 그리고, 쪽 끝 행은 쪼개졌든 아니든 본문 바닥까지 늘려 그리므로 기하로는 구별이 안 된다.
 * 두 행의 칸 짜임(열 범위)이 같고, 다음 두 증거 가운데 하나가 있을 때만 합친다.
 *  1) 글 이어짐 — 어느 한 열에서 글이 앞 쪽 끝줄을 꽉 채우고 뒤 쪽으로 이어진다(continuesAcross).
 *  2) 칸 조각 이어짐 — 한컴은 칸의 첫 조각에는 글이 없어도 클립을 깐다(편람 대비표 빈 시행규칙 칸). 앞 쪽 끝 행에서 시작한
 *     칸(또는 앞 쪽에서도 클립이 없던 칸)이 다음 쪽에 클립이 없으면 그 칸은 다음 쪽 첫 행 띠까지 이어진 것이다. 글 있는 열 쌍이
 *     하나뿐이고 새 칸 증거(앞 쪽 빈 칸 뒤의 글)가 없으면 행이 쪼개진 것으로 본다. 칸 안 문단 경계에서 쪽이 넘어가 글 증거가 없는
 *     행(편람 대비표 "…제1항 / ② 중앙행정기관…")을 여기서 잡는다. 쪽 넘김 후보를 HWPX 로 같은 칸인지 확인한 대조: 표 GT 한컴
 *     407쌍에서 이 조건 42건이 전부 쪼개진 행, 따로 뗀 법령 서식·별표 4세트(rhwp 변환 HWPX)에서 121건 중 새 행 2건.
 *     글 있는 열 쌍이 둘 이상이면 세로 병합 칸만 이어지고 행은 새로 시작하는 경우(시험기준표 "플라이애시 / 시멘트")와
 *     섞여 쓰지 않는다. 위에서 내려온 세로 병합 칸이 클립 없이 넘어간 것은 새 행에서도 똑같아 증거가 아니다
 */
function mergeSplitRow(table: IRTable, owner: (Anchor | null)[][], first: number, colXs: number[]): boolean {
  const last = first - 1
  // 열마다 앞 행 칸과 뒤 행 칸을 맞춘다 — 두 행을 다 덮는 세로 병합 칸(앞 쪽에서 넘어와 이어 늘린 칸)은 그대로 두고,
  // 나머지는 앞 행에서 끝나는 칸과 뒤 행에서 시작하는 칸의 열 범위가 같아야 한다
  const pairs: Array<[Anchor, Anchor]> = []
  let carried = false
  for (let c = 0; c < table.cols;) {
    const a = owner[last][c], b = owner[first][c]
    // 두 쪽 모두 클립이 없던 자리 — 글 없는 칸이 쪽을 넘은 부분이다 (행정업무운영 편람 신구조문 대비표: 시행규칙 쪽이 빈 조문 행이
    // 네 쪽에 걸쳐 끊겨 103행 → 119행). 칸이 들어설 수 없는 좁은 열은 조각끼리 왼끝이 조금 어긋나 합집합 격자에 생긴 틈이라 증거가 아니다
    // (서식 쪽마다 왼끝 56.6/58.0 → 1.4pt 틈 열: 바닥글 "210mm×297mm…" 행이 다음 쪽 "(4쪽 중 제3쪽)" 행을 삼켰다)
    if (!a && !b) { if (colXs[c + 1] - colXs[c] >= CARRIED_MIN_COL_W) carried = true; c++; continue }
    if (!a || !b) return false
    if (a !== b) {
      if (a.c !== b.c || a.cs !== b.cs || a.r + a.rs - 1 !== last || b.r !== first || b.rs !== 1) return false
      pairs.push([a, b])
    } else if (a.r === last && a.rs === 2) carried = true // 앞 쪽 끝 행에서 시작한 칸을 뒤 쪽 첫 행 빈 자리로만 이어 늘렸다 — 더 아래까지
    // 비어 있으면 뒤 쪽 여러 행을 덮는 세로 병합 칸이다(규제영향분석서 "기타"). 쪼개진 행의 이어진 조각은 첫 행 띠 하나다
    c = a.c + a.cs
  }
  // 뒤 쪽 칸 조각의 글 없는 클립은 증거가 아니다 — 한컴 PDF 판(1.3.0.546·538)과 칸에 따라 이어진 빈 조각에도 클립을 깐다
  // (법령 별표 쪼개진 행 17건에 있음). 앞 쪽 빈 칸 뒤에 글이 오는 것만 새 칸 증거다 (글은 칸 위에서부터 흐른다)
  const carriedSplit = carried && pairs.filter(([u, d]) => hasContent(u.cell) && hasContent(d.cell)).length <= 1
    && !pairs.some(([u, d]) => !hasContent(u.cell) && hasContent(d.cell))
  // 글줄은 격자에 놓은 복사본 칸에서 본다 — 옮겨 맞댄 뒤 조각(짝·홀 쪽·단 넘김)은 복사본에만 옮긴 글줄이 있다
  const cell = (a: Anchor): IRCell => table.cells[a.r][a.c]
  if (!carriedSplit) {
    // 앞 쪽 칸이 한 줄로 끝난 이름표(다음 어절이 들어갈 자리가 남음)인데 뒤 쪽 같은 열에 다른 글이 있으면 그 열은 새 칸이다 — 끝난 칸의
    // 이어진 조각은 글이 없어 클립조차 없다. 다른 열 끝줄이 꽉 찬 것(글 이어짐)보다 이 모순이 앞선다 (편람 [별표 4] 가로 판
    // "8. 글자 | …꽉 찬 끝줄" 다음 쪽 "9. 한글과 함께 적는 외국글자 | 가. 단어를 …", 시험기준표 "액성한계·소성한계 | KS F 2303" 다음 쪽
    // "세립토 비율 | KS F 2309"). 같은 글이면 문단마다 붙는 표지다 (신구조문 대비표 "<신 설>" 이 큰 행 두 조각에 하나씩)
    const norm = (c: IRCell): string => c.text.replace(/\s+/g, "")
    if (pairs.some(([u, d]) => hasContent(d.cell) && norm(cell(d)) !== norm(cell(u)) && lineEnded(cell(u), colXs[u.c], colXs[u.c + u.cs]))) return false
    if (!pairs.some(([u, d]) => continuesAcross(cell(u), cell(d), colXs[u.c], colXs[u.c + u.cs]))) return false
  }
  for (const [u, d] of pairs) appendCell(table.cells[u.r][u.c], table.cells[d.r][d.c])
  // 위에서 내려와 두 행에 걸친 세로 병합 칸은 한 행 줄어든다
  for (let r = 0; r < first; r++) for (let c = 0; c < table.cols; c++) {
    const o = owner[r][c]
    if (o && o.r === r && o.c === c && r + table.cells[r][c].rowSpan > first) table.cells[r][c].rowSpan--
  }
  table.cells.splice(first, 1)
  table.rows--
  return true
}

/**
 * 페이지 걸친 표 병합 — ODL TableBorderProcessor.checkNeighborTables 포팅.
 * Original work: Copyright 2025-2026 Hancom Inc. (Apache-2.0)
 *
 * 페이지 N의 마지막 표와 페이지 N+1의 첫 표가:
 *  - 블록 배열에서 인접 (사이에 본문 블록 없음 — 머리글/바닥글 제거 후 기준)
 *  - 열 수 동일
 *  - 좌우 경계 근접 (폭 대비 0.2 비율 이내, ODL NEIGHBOUR_TABLE_EPSILON)
 * 이면 한 표로 병합. 반복 헤더 행(첫 행 텍스트 동일)은 제거.
 * 두 조각 사이에 자기 쪽 표 조각과 가로로 겹치지 않는 블록(besideOwn)만 끼어 있으면 인접으로 본다 (그 블록은 제자리에 둔다).
 * 같은 쪽 2단 넘김은 먼저 mergeColumnFlow 가 잇는다.
 */
const NEIGHBOR_TABLE_EPSILON = 0.2

/**
 * 표 두 조각 사이에 끼어도 이음을 막지 않는 블록 — 자기 쪽 표 조각과 가로 범위가 겹치지 않는 글(쪽 가장자리 장 표시 세로글 —
 * 행정업무운영 편람), 앞 표가 2단 지면의 오른쪽 단일 때 그 왼쪽 단에 놓인 글·표(입찰동향 붙임: 오른쪽 단 입찰내역표 앞에
 * 왼쪽 단 지역별 현황표)
 */
function besideOwn(b: IRBlock, p: IRBlock, c: IRBlock): boolean {
  if (!b.bbox) return false
  if (b.type === "table") return leftColumnOf(b, p)
  const t = (b.pageNumber === p.pageNumber ? p : c).bbox!
  const bx1 = b.bbox.x, bx2 = b.bbox.x + b.bbox.width
  return bx2 <= t.x + 1 || bx1 >= t.x + t.width - 1
}

/** 같은 쪽에서 표 t 의 왼쪽 단에 온전히 놓인 블록 */
function leftColumnOf(b: IRBlock, t: IRBlock): boolean {
  return !!b.bbox && b.pageNumber === t.pageNumber && b.bbox.x + b.bbox.width <= t.bbox!.x + 1
}

/**
 * 이은 표를 앞 조각(blocks[i]) 자리에 두고 뒤 조각(blocks[j])을 뺀다. 건너뛴 블록 가운데 앞 조각 왼쪽 단의 것이 있으면 이은 표를
 * 그 뒤로 옮긴다 — 블록은 윗변 순이라 2단 지면 오른쪽 단 표가 왼쪽 단 글·표보다 먼저 나오는데, 읽는 순서로는 왼쪽 단이 앞이다
 * (입찰동향 붙임: 오른쪽 단에서 시작해 다음 쪽으로 이어진 입찰내역표가 왼쪽 단 현황표 두 개보다 앞에 놓여 표 순서가 뒤바뀜)
 */
function placeJoined(blocks: IRBlock[], i: number, j: number, table: IRTable): void {
  const prev = blocks[i]
  blocks[i] = { ...prev, table }
  blocks.splice(j, 1)
  let k = j - 1
  while (k > i && !leftColumnOf(blocks[k], prev)) k--
  if (k > i) blocks.splice(k, 0, blocks.splice(i, 1)[0])
}

/** 같은 쪽에서 표 테두리 안에 든 블록 — 칸 안 예시 상자처럼 표 칸에 붙지 못하고 표 뒤에 따로 나온 조각 */
function insideTable(b: IRBlock, t: IRBlock): boolean {
  if (!b.bbox || b.pageNumber !== t.pageNumber) return false
  const o = t.bbox!
  return b.bbox.x >= o.x - 1 && b.bbox.x + b.bbox.width <= o.x + o.width + 1 && b.bbox.y >= o.y - 1 && b.bbox.y + b.bbox.height <= o.y + o.height + 1
}

/** 첫 행 전체를 차지하는 단위 표기 */
function startsWithUnitRow(table: IRTable): boolean {
  return /^\s*\(\s*단위\s*[:：]/.test(table.cells[0]?.[0]?.text ?? "")
    && table.cells[0]?.slice(1).every(c => !c.text.trim())
}

export function mergeCrossPageTables(blocks: IRBlock[], pageHeights?: Map<number, number>): void {
  mergeColumnFlow(blocks, pageHeights)
  for (let i = blocks.length - 2; i >= 0; i--) {
    const prev = blocks[i]
    if (prev.type !== "table" || !prev.table || !prev.bbox || !prev.pageNumber) continue
    // 다음 표 — 다음 쪽까지만 훑는다 (글만 긴 문서에서 블록마다 끝까지 훑지 않게). 앞 표 테두리 안에 든 표(칸 안 예시 상자가 따로 나온
    // 것)와 앞 표 왼쪽 단의 표(2단 지면)는 건너뛴다 — 편람 [별표 4] 서식 설계기준표는 "3. 쪽번호" 칸 안 예시 상자가 쪽 마지막 표가
    // 되어 다음 쪽 조각과 끊겼다
    let j = i + 1
    while (j < blocks.length && (blocks[j].type !== "table" || insideTable(blocks[j], prev) || leftColumnOf(blocks[j], prev)) && (blocks[j].pageNumber ?? 0) <= prev.pageNumber + 1) j++
    const curr = blocks[j]
    if (!curr || curr.type !== "table" || !curr.table || !curr.bbox || curr.pageNumber !== prev.pageNumber + 1) continue
    // 단위 행이 양쪽에 다시 나타나면 각 쪽에서 새 표를 시작한 것이다.
    if (startsWithUnitRow(prev.table) && startsWithUnitRow(curr.table)) continue
    const joined = j === i + 1 || blocks.slice(i + 1, j).every(b => besideOwn(b, prev, curr) || insideTable(b, prev))
      ? (looksContinued(prev, curr, pageHeights) && !restartsTable(blocks, i, curr.table, pageHeights) ? joinClipParts(prev, curr, pageHeights) ?? false : null)
      : null
    if (joined) {
      // 한컴 클립 표 조각 — 열 경계 합집합 격자로 이었다 (쪽마다 열 구성이 달라도)
      placeJoined(blocks, i, j, joined)
      continue
    }
    // 앞 표의 이어짐이 못 된 빈 조각은 버리고 같은 앞 표로 그다음 표를 다시 본다 — 쪽 첫머리 장식 띠 같은 빈 클립 표가 진짜
    // 이어짐을 가로막지 않게 (빈 조각의 뒤쪽 이음은 이미 앞선 차례에 시도했다)
    if (EMPTY_PARTS.has(curr.table)) { blocks.splice(j, 1); i++; continue }
    if (joined === null) continue
    if (prev.table.cols !== curr.table.cols || prev.table.renderAsTable !== curr.table.renderAsTable || EMPTY_PARTS.has(prev.table)) continue

    // 좌우 경계 근접 검증 (폭 대비 비율)
    const width = Math.max(prev.bbox.width, curr.bbox.width, 1)
    const leftDiff = Math.abs(prev.bbox.x - curr.bbox.x)
    const rightDiff = Math.abs((prev.bbox.x + prev.bbox.width) - (curr.bbox.x + curr.bbox.width))
    if (leftDiff > width * NEIGHBOR_TABLE_EPSILON || rightDiff > width * NEIGHBOR_TABLE_EPSILON) continue
    // 열 경계까지 같아야 한 표의 이어짐 — 열 수·좌우 끝만 보면 다음 쪽 첫머리의 "붙임 2 | 제목" 머리상자(1×3)가
    // 앞 쪽 일정표(3열)의 꼬리 행으로 붙는다(보도자료 붙임 실측). 경계 좌표가 없는 표(클러스터)는 종전대로.
    // 짝·홀 쪽 대칭 여백(책자형 편람: 쪽마다 본문이 11.4~12.5pt 옮겨짐)은 모든 경계가 같은 거리만큼 옮겨진 것이라 같은 경계로 본다
    // — 선 표 쪽 넘김 후보 가운데 이렇게 옮겨진 15건 중 사이 글 없이 쪽 끝·첫머리에 놓인 10건이 모두 같은 표다. 클립 표는
    // joinClipParts 가 쪼개진 행·반복 머리 행 증거가 있을 때만 옮겨 잇는다 (여기서 옮김을 받으면 연달아 놓인 Q&A 상자가 12×5 로 이어진다)
    const px = TABLE_COLXS.get(prev.table), cx = TABLE_COLXS.get(curr.table)
    if (px && cx && !shiftedSame(px, cx, !CLIP_TABLES.has(prev.table) && !CLIP_TABLES.has(curr.table))) continue

    // 반복 헤더 행 제거: 다음 표 첫 행이 이전 표 첫 행과 동일하면 중복 헤더
    let currCells = curr.table.cells
    if (currCells.length > 1 && prev.table.cells.length > 0 &&
        rowTextsEqual(prev.table.cells[0], currCells[0])) {
      currCells = currCells.slice(1)
    }
    if (currCells.length === 0) {
      blocks.splice(j, 1)
      continue
    }

    const merged: IRTable = {
      rows: prev.table.rows + currCells.length,
      cols: prev.table.cols,
      cells: [...prev.table.cells, ...currCells],
      hasHeader: prev.table.hasHeader,
      caption: prev.table.caption,
      ...(prev.table.renderAsTable ? { renderAsTable: true } : {}),
    }
    if (px ?? cx) TABLE_COLXS.set(merged, (px ?? cx)!)
    if (CLIP_TABLES.has(prev.table) || CLIP_TABLES.has(curr.table)) CLIP_TABLES.add(merged)
    placeJoined(blocks, i, j, merged)
  }
  // 잇지 못한 빈 클립 표 조각은 버린다 (쪽 추출 단계에서 빈 표를 버리던 종전 동작)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].table
    if (blocks[i].type === "table" && t && EMPTY_PARTS.has(t)) blocks.splice(i, 1)
  }
}

/**
 * 같은 쪽 단 넘김 — 2단 지면(가로 쪽 두 단 편람 [별표 4], 보도자료 붙임 두 쪽 모아 찍기)에서 왼쪽 단 바닥까지 찬 클립 표 조각과 같은
 * 쪽 오른쪽 단 첫머리의 표 조각을 잇는다. 쪽 넘김과 같은 모양(앞 조각이 바닥까지, 뒤 조각이 첫머리부터)에 뒤 조각이 단 거리만큼
 * 옮겨져 있어 증거도 쪽 넘김 평행 이동과 같다(쪼개진 행 또는 글 있는 머리 행 되풀이). 블록 순서는 윗변 기준이라 오른쪽 단 조각이
 * 먼저 나오기도 해 순서와 무관하게 짝을 찾고, 이은 표는 두 자리 중 앞선 자리에 둔다. 이은 표의 bbox 는 x·윗변을 왼쪽 조각(열 경계
 * 좌표계)에서, 밑변을 오른쪽 조각(흐름의 끝)에서 가져온다 — 다음 쪽 이음은 흐름 끝이 쪽 바닥까지 찼는지 봐야 한다
 */
function mergeColumnFlow(blocks: IRBlock[], pageHeights?: Map<number, number>): void {
  if (!pageHeights) return
  for (let i = 0; i < blocks.length; i++) {
    const L = blocks[i]
    if (L.type !== "table" || !L.table || !L.bbox || !L.pageNumber || !CLIP_TABLES.has(L.table) || EMPTY_PARTS.has(L.table)) continue
    const ph = pageHeights.get(L.pageNumber)
    if (!ph || L.bbox.y > ph * PAGE_EDGE_BAND) continue
    // 오른쪽 단 첫머리 표 — 같은 쪽(블록은 쪽 순서라 같은 쪽 구간만 훑는다), L 오른쪽에 온전히, 쪽 첫머리 띠 안에서 시작하는 가장 위 표
    let s0 = i, s1 = i
    while (s0 > 0 && blocks[s0 - 1].pageNumber === L.pageNumber) s0--
    while (s1 + 1 < blocks.length && blocks[s1 + 1].pageNumber === L.pageNumber) s1++
    let k = -1
    for (let q = s0; q <= s1; q++) {
      const R = blocks[q]
      if (q === i || R.type !== "table" || !R.table || !R.bbox || !leftColumnOf(L, R)) continue
      const top = R.bbox.y + R.bbox.height
      if (top < ph * (1 - PAGE_EDGE_BAND)) continue
      if (k < 0 || top > blocks[k].bbox!.y + blocks[k].bbox!.height) k = q
    }
    if (k < 0) continue
    const R = blocks[k]
    if (Math.abs(R.bbox!.width - L.bbox.width) > Math.max(R.bbox!.width, L.bbox.width) * NEIGHBOR_TABLE_EPSILON) continue
    if (!looksContinued(L, R) || restartsTable(blocks, i, R.table!, pageHeights)) continue
    const joined = joinClipParts(L, R, pageHeights)
    if (!joined) continue
    const top = L.bbox.y + L.bbox.height
    const at = Math.min(i, k)
    blocks[at] = { ...L, table: joined, bbox: { ...L.bbox, y: R.bbox!.y, height: Math.max(0, top - R.bbox!.y) } }
    blocks.splice(Math.max(i, k), 1)
    i = at - 1 // 이은 표가 다시 오른쪽 단으로 이어질 수 있다 (세 단)
  }
}

/**
 * 클립 표 두 조각이 한 표의 쪽 넘김인지 보고 이어 붙인다. 열 경계가 같으면 종전처럼 이어짐으로 보고, 다르면
 * 쪽 넘김 기하(앞 조각이 쪽 밑까지, 뒤 조각이 쪽 위부터 — PAGE_EDGE_BAND)와 오른쪽 끝 일치·뒤 조각 왼쪽 끝이 앞 조각
 * 경계 위에 있음을 요구한다(뒤 쪽에 세로 병합 이어진 칸이 비어 왼쪽 열이 빠진 경우).
 */
function joinClipParts(prev: IRBlock, curr: IRBlock, pageHeights?: Map<number, number>): IRTable | null {
  const pt = prev.table!, ct = curr.table!
  if (!CLIP_TABLES.has(pt) || !CLIP_TABLES.has(ct)) return null
  const px = TABLE_COLXS.get(pt), cx = TABLE_COLXS.get(ct)
  if (!px || !cx) return null
  let xs = cx, shifted = false, dx = 0
  if (!shiftedSame(px, cx, false)) {
    // 열 구성이 다르면 쪽 넘김 기하를 반드시 확인 (looksContinued 는 쪽 높이를 모르면 통과시킨다)
    if (!pageHeights?.get(prev.pageNumber!) || !pageHeights?.get(curr.pageNumber!)) return null
    // 짝·홀 쪽 대칭 여백(11.4pt)이나 2단 지면의 단 넘김(420pt)으로 표 전체가 옮겨졌으면 뒤 조각을 앞 조각 자리로 옮겨 맞댄다. 다만
    // 같은 틀 상자가 쪽마다 새로 놓인 것(편람 Q&A 상자 55개)과 가르려고 경계 행이 쪼개진 행이거나 글 있는 머리 행이 되풀이될 때만
    // 잇는다 — 새 상자의 첫 행은 빈 칸이고 앞 상자 끝 행과 칸 짜임이 달라 둘 다 될 수 없다. 이 조건 없이 옮김만 넣으면 연달아
    // 놓인 상자끼리 이어져 편람 −14표 (클립 표 평행 이동 후보 47건 중 같은 표 5건)
    dx = px[px.length - 1] - cx[cx.length - 1]
    if (Math.abs(dx) > CONTINUATION_COL_TOL) { xs = cx.map(x => x + dx); shifted = true } else dx = 0
    if (!px.some(x => Math.abs(x - xs[0]) <= CONTINUATION_COL_TOL)) return null
  }
  const res = joinSplitParts(pt, px, ct, xs, dx, prev.bbox?.y)
  if (!res || (shifted && !res.split && !res.header)) return null
  TABLE_COLXS.set(res.table, res.colXs)
  CLIP_TABLES.add(res.table)
  return res.table
}

/** 붙임·참고·별지 등 첨부 머리표 — 쪽 첫머리에 이런 칸으로 시작하는 표는 앞 쪽 표의 이어짐이 아니다 */
const ANNEX_HEAD_RE = /^\s*[<\[(【]?\s*(?:붙\s*임|참\s*고|별\s*첨|별\s*지|별\s*표|첨\s*부|부\s*록)(?:\s*\d|\s*$|\s*[>\])】])|^\s*■/

/**
 * 쪽 넘김 이어짐 판정 — 앞 표가 쪽 아래 PAGE_EDGE_BAND 안까지 차고 뒤 표가 쪽 위 PAGE_EDGE_BAND 안에서 시작하며, 뒤 표
 * 첫 칸이 첨부 머리표가 아니어야 한다. 보도자료·편람 쪽 넘김 후보 278건 대조(HWPX 로 같은 표인지 확인): 쪽 위쪽에 놓인
 * 머리 상자끼리(붙임 2 → 붙임 3, 시험지 쪽머리표)와 쪽 끝 담당자 표 → 다음 쪽 "붙임" 상자를 잇던 오병합이 이 두 조건으로
 * 빠지고, 참 이어짐은 1건만 놓친다. 쪽 높이를 모르면(외부 호출) 기하 조건은 건너뛴다
 */
function looksContinued(prev: IRBlock, curr: IRBlock, pageHeights?: Map<number, number>): boolean {
  const ph = pageHeights?.get(prev.pageNumber!), ch = pageHeights?.get(curr.pageNumber!)
  if (ph && ch && (prev.bbox!.y > ph * PAGE_EDGE_BAND || curr.bbox!.y + curr.bbox!.height < ch * (1 - PAGE_EDGE_BAND))) return false
  const firstText = curr.table!.cells[0]?.find(c => c.text.trim())?.text ?? ""
  return !ANNEX_HEAD_RE.test(firstText)
}

/** 표 첫 행 앵커 — 열 경계 x 범위와 글 */
function firstRowSig(t: IRTable): Array<{ x1: number; x2: number; t: string }> | null {
  const x = TABLE_COLXS.get(t)
  if (!x || x.length !== t.cols + 1) return null
  return anchorsOf(t).filter(a => a.r === 0).map(a => ({ x1: x[a.c], x2: x[a.c + a.cs], t: a.cell.text.replace(/\s+/g, "") }))
}

/**
 * 뒤 표 첫 행이 앞 조각이 속한 표(쪽 넘김 사슬 첫 조각)의 첫 행을 다시 시작하는가 — 앵커 칸 짜임(x 범위, 대칭 여백
 * 이동 허용)이 같고 이름표 칸 둘 이상이 같은 글인데 값 칸이 하나 이상 다르다. 한 서식을 품목마다 되풀이한 문서(과제 품목 명세서
 * 5벌, 서식마다 두 쪽)에서 앞 서식 끝 조각은 본문 바닥 근처에서 끝나고 다음 쪽 첫머리가 새 서식이라 쪽 넘김 기하로는 이어짐과
 * 같다(141×22 한 표로 뭉침). 반복 머리 행은 글이 모두 같아 해당 없고, 이어진 조각의 첫 행은 표 첫 행과 칸 짜임부터 다르다
 */
function restartsTable(blocks: IRBlock[], i: number, curr: IRTable, pageHeights?: Map<number, number>): boolean {
  const cs = firstRowSig(curr)
  if (!cs || cs.length < RESTART_MIN_ANCHORS) return false
  const hs = firstRowSig(blocks[chainHead(blocks, i, pageHeights)].table!)
  if (!hs || hs.length !== cs.length) return false
  const dx = hs[hs.length - 1].x2 - cs[cs.length - 1].x2
  if (!hs.every((h, n) => Math.abs(h.x1 - cs[n].x1 - dx) <= CONTINUATION_COL_TOL && Math.abs(h.x2 - cs[n].x2 - dx) <= CONTINUATION_COL_TOL)) return false
  let same = 0, diff = 0
  for (let n = 0; n < hs.length; n++) {
    if (!hs[n].t && !cs[n].t) continue
    if (hs[n].t === cs[n].t) same++
    else diff++
  }
  return same >= 2 && diff >= 1
}

/**
 * blocks[i] 표 조각이 속한 쪽 넘김 사슬의 첫 조각 위치 — 앞 쪽 마지막 표가 이음 모양(사이 글 없음·쪽 끝과 첫머리·열 경계 호환)이면
 * 거슬러 올라간다 (뒤에서부터 잇는 본 판정 전이라 아직 안 이은 조각끼리 본다). 이어진 조각의 첫 행은 데이터 행이라 거기와
 * 견주면 값이 되풀이되는 표(평가지표표 "실증을 통한 내부평가")가 새 표로 잘린다 — 표 첫 행과만 견준다
 */
function chainHead(blocks: IRBlock[], i: number, pageHeights?: Map<number, number>): number {
  let k = i
  for (let steps = 0; steps < RESTART_LOOKBACK_PAGES; steps++) {
    const cur = blocks[k]
    let p = k - 1
    while (p >= 0 && blocks[p].type !== "table" && (blocks[p].pageNumber ?? 0) >= (cur.pageNumber ?? 0) - 1) p--
    if (p < 0 || blocks[p].type !== "table" || !blocks[p].table || !blocks[p].bbox) break
    // 칸 안 예시 상자처럼 앞 표 테두리 안에 든 표면 그 앞 표로
    for (let q = p - 1; q >= 0 && blocks[q].pageNumber === blocks[p].pageNumber; q--) {
      if (blocks[q].type === "table" && blocks[q].bbox && insideTable(blocks[p], blocks[q])) { p = q; break }
    }
    const pb = blocks[p]
    if (pb.pageNumber !== (cur.pageNumber ?? 0) - 1) break
    if (!blocks.slice(p + 1, k).every(b => besideOwn(b, pb, cur) || insideTable(b, pb))) break
    if (!looksContinued(pb, cur, pageHeights)) break
    const px = TABLE_COLXS.get(pb.table!), cx = TABLE_COLXS.get(cur.table!)
    if (!px || !cx) break
    const dx = px[px.length - 1] - cx[cx.length - 1]
    if (!shiftedSame(px, cx) && !px.some(x => Math.abs(x - (cx[0] + dx)) <= CONTINUATION_COL_TOL)) break
    k = p
  }
  return k
}

/** 두 행의 셀 텍스트가 모두 동일한지 (공백 정규화 후 비교) */
function rowTextsEqual(a: IRCell[], b: IRCell[]): boolean {
  if (a.length !== b.length) return false
  const norm = (t: string) => t.replace(/\s+/g, "")
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i].text) !== norm(b[i].text)) return false
  }
  // 빈 행끼리의 비교는 의미 없음
  return a.some(c => c.text.trim() !== "")
}

/** 쪽 넘김 이음 판정 — 열 경계가 이 거리(pt) 안에서 전부 맞아야 같은 표 */
const CONTINUATION_COL_TOL = 2

/** 두 조각의 열 경계가 같은가 — allowShift 면 모든 경계가 같은 거리만큼 옮겨진 것도 같다고 본다 (짝·홀 쪽 대칭 여백) */
function shiftedSame(px: number[], cx: number[], allowShift = true): boolean {
  if (px.length !== cx.length) return false
  const dx = allowShift ? px[px.length - 1] - cx[cx.length - 1] : 0
  return px.every((x, k) => Math.abs(x - cx[k] - dx) <= CONTINUATION_COL_TOL)
}
/** 쪽 넘김 조각 판정 — 앞 조각 밑변이 쪽 아래 이 비율 안, 뒤 조각 윗변이 쪽 위 이 비율 안 (본문 여백 안쪽까지 찬 표) */
const PAGE_EDGE_BAND = 0.16
/** 새 표 시작 판정 — 첫 행 앵커가 이만큼 이상인 표만 (칸 짜임이 같다는 게 우연이 아닐 만큼), 사슬 첫 조각은 이 쪽 수까지 거슬러 찾는다 */
const RESTART_MIN_ANCHORS = 3
const RESTART_LOOKBACK_PAGES = 5
