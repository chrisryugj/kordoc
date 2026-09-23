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

/**
 * 두 조각을 합집합 격자로 잇는다. 경계 대응이 안 되면(조각 경계가 합집합에서 사라짐) null.
 * @param pcx·ccx 앞·뒤 조각의 열 경계 x (오름차순)
 */
export function joinSplitParts(prev: IRTable, pcx: number[], curr: IRTable, ccx: number[]): { table: IRTable; colXs: number[] } | null {
  if (pcx.length !== prev.cols + 1 || ccx.length !== curr.cols + 1) return null
  const U = unionCoords(pcx, ccx)
  const cols = U.length - 1
  if (cols < 1) return null
  const pa = anchorsOf(prev), ca = anchorsOf(curr)

  // 반복 머리 행 — 한컴은 머리 칸이 있는 표만 조각마다 머리 행(여러 줄일 수 있음)을 되풀이한다
  let skip = 0
  while (skip < Math.min(3, curr.rows - 1, prev.rows) && rowText(ca, skip) !== "" && rowText(ca, skip) === rowText(pa, skip)) skip++

  const rows = prev.rows + curr.rows - skip
  const grid: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  const owner: (Anchor | null)[][] = Array.from({ length: rows }, () => new Array<Anchor | null>(cols).fill(null))
  const place = (a: Anchor, x: number[], rowOff: number): boolean => {
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
    if (lines) CELL_LINES.set(grid[r][c1], lines)
    if (IMAGE_CELLS.has(a.cell)) IMAGE_CELLS.add(grid[r][c1])
    return true
  }
  // 채움 칸(클립 없던 자리)은 놓지 않는다 — 빈 자리로 남아 아래 세로 병합 잇기가 채운다
  for (const a of pa) if (!FILLER_CELLS.has(a.cell) && !place(a, pcx, 0)) return null
  for (const a of ca) {
    if (a.r < skip || FILLER_CELLS.has(a.cell)) continue
    if (!place(a, ccx, prev.rows - skip)) return null
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
  if (rows > prev.rows) mergeSplitRow(table, owner, prev.rows, U)
  return { table, colXs: U }
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
  if (maxR - last.r > FULL_LINE_TOL * fs) return false
  // 앞 쪽에 한 줄뿐이면 그 줄이 곧 가장 긴 줄이라 위 비교는 늘 참이다 — 그때는 칸 오른끝에서 어절 하나 폭 안까지 닿아야 한다
  // (오른쪽이 들쭉날쭉한 칸은 다음 어절이 안 들어가 그만큼 남기고 줄이 바뀐다: "…규범적 / 성격의 규제" 37pt, 13pt 글자)
  if (U.length === 1 && x2 - last.r > Math.max(FULL_LINE_EDGE_MIN, SINGLE_LINE_WORD_GAP * fs)) return false
  if (last.r - last.l < FULL_LINE_MIN_FRAC * (x2 - x1)) return false
  const leftAligned = (l: { l: number; r: number }) => l.l - minL <= fs && maxR - l.r > SHORT_LINE_GAP * fs
  return U.some(leftAligned) || D.some(leftAligned)
}

/**
 * 쪽 넘김으로 쪼개진 행 — 뒤 조각 첫 행을 앞 조각 마지막 행에 합친다. 한컴은 칸 단위로 나누지 않는 표의 긴 행을 글줄
 * 사이에서 끊어 두 쪽에 나눠 그리고, 쪽 끝 행은 쪼개졌든 아니든 본문 바닥까지 늘려 그리므로 기하로는 구별이 안 된다.
 * 두 행의 칸 짜임(열 범위)이 같고, 어느 한 열에서 글이 앞 쪽 끝줄을 꽉 채우고 뒤 쪽으로 이어질 때만(continuesAcross).
 */
function mergeSplitRow(table: IRTable, owner: (Anchor | null)[][], first: number, colXs: number[]): void {
  const last = first - 1
  // 열마다 앞 행 칸과 뒤 행 칸을 맞춘다 — 두 행을 다 덮는 세로 병합 칸(앞 쪽에서 넘어와 이어 늘린 칸)은 그대로 두고,
  // 나머지는 앞 행에서 끝나는 칸과 뒤 행에서 시작하는 칸의 열 범위가 같아야 한다
  const pairs: Array<[Anchor, Anchor]> = []
  for (let c = 0; c < table.cols;) {
    const a = owner[last][c], b = owner[first][c]
    if (!a || !b) return
    if (a !== b) {
      if (a.c !== b.c || a.cs !== b.cs || a.r + a.rs - 1 !== last || b.r !== first || b.rs !== 1) return
      pairs.push([a, b])
    }
    c = a.c + a.cs
  }
  if (!pairs.some(([u, d]) => continuesAcross(u.cell, d.cell, colXs[u.c], colXs[u.c + u.cs]))) return
  for (const [u, d] of pairs) {
    const a = table.cells[u.r][u.c], b = table.cells[d.r][d.c]
    if (b.text.trim()) a.text = a.text.trim() ? a.text + "\n" + b.text : b.text
    if (b.blocks?.length) a.blocks = [...(a.blocks ?? []), ...b.blocks]
  }
  // 위에서 내려와 두 행에 걸친 세로 병합 칸은 한 행 줄어든다
  for (let r = 0; r < first; r++) for (let c = 0; c < table.cols; c++) {
    const o = owner[r][c]
    if (o && o.r === r && o.c === c && r + table.cells[r][c].rowSpan > first) table.cells[r][c].rowSpan--
  }
  table.cells.splice(first, 1)
  table.rows--
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
 * 두 조각 사이에 두 표 어느 쪽과도 가로로 겹치지 않는 글(쪽 가장자리 장 표시 세로글 — 행정업무운영 편람)만 끼어 있으면
 * 인접으로 본다 (그 글은 제자리에 둔다).
 */
const NEIGHBOR_TABLE_EPSILON = 0.2

/** 표 두 조각 사이에 끼어도 이음을 막지 않는 글 — 두 조각 모두와 가로 범위가 겹치지 않는 블록 */
function besideBoth(b: IRBlock, p: IRBlock, c: IRBlock): boolean {
  if (b.type === "table" || !b.bbox) return false
  const bx1 = b.bbox.x, bx2 = b.bbox.x + b.bbox.width
  return [p.bbox!, c.bbox!].every(t => bx2 <= t.x + 1 || bx1 >= t.x + t.width - 1)
}

export function mergeCrossPageTables(blocks: IRBlock[], pageHeights?: Map<number, number>): void {
  for (let i = blocks.length - 2; i >= 0; i--) {
    const prev = blocks[i]
    if (prev.type !== "table" || !prev.table || !prev.bbox || !prev.pageNumber) continue
    // 다음 표 — 다음 쪽까지만 훑는다 (글만 긴 문서에서 블록마다 끝까지 훑지 않게)
    let j = i + 1
    while (j < blocks.length && blocks[j].type !== "table" && (blocks[j].pageNumber ?? 0) <= prev.pageNumber + 1) j++
    const curr = blocks[j]
    if (!curr || curr.type !== "table" || !curr.table || !curr.bbox || curr.pageNumber !== prev.pageNumber + 1) continue
    const joined = j === i + 1 || blocks.slice(i + 1, j).every(b => besideBoth(b, prev, curr))
      ? (looksContinued(prev, curr, pageHeights) ? joinClipParts(prev, curr, pageHeights) ?? false : null)
      : null
    if (joined) {
      // 한컴 클립 표 조각 — 열 경계 합집합 격자로 이었다 (쪽마다 열 구성이 달라도)
      blocks[i] = { ...prev, table: joined }
      blocks.splice(j, 1)
      continue
    }
    // 앞 표의 이어짐이 못 된 빈 조각은 버리고 같은 앞 표로 그다음 표를 다시 본다 — 쪽 첫머리 장식 띠 같은 빈 클립 표가 진짜
    // 이어짐을 가로막지 않게 (빈 조각의 뒤쪽 이음은 이미 앞선 차례에 시도했다)
    if (EMPTY_PARTS.has(curr.table)) { blocks.splice(j, 1); i++; continue }
    if (joined === null) continue
    if (prev.table.cols !== curr.table.cols || EMPTY_PARTS.has(prev.table)) continue

    // 좌우 경계 근접 검증 (폭 대비 비율)
    const width = Math.max(prev.bbox.width, curr.bbox.width, 1)
    const leftDiff = Math.abs(prev.bbox.x - curr.bbox.x)
    const rightDiff = Math.abs((prev.bbox.x + prev.bbox.width) - (curr.bbox.x + curr.bbox.width))
    if (leftDiff > width * NEIGHBOR_TABLE_EPSILON || rightDiff > width * NEIGHBOR_TABLE_EPSILON) continue
    // 열 경계까지 같아야 한 표의 이어짐 — 열 수·좌우 끝만 보면 다음 쪽 첫머리의 "붙임 2 | 제목" 머리상자(1×3)가
    // 앞 쪽 일정표(3열)의 꼬리 행으로 붙는다(보도자료 붙임 실측). 경계 좌표가 없는 표(클러스터)는 종전대로
    const px = TABLE_COLXS.get(prev.table), cx = TABLE_COLXS.get(curr.table)
    if (px && cx && (px.length !== cx.length || px.some((x, k) => Math.abs(x - cx[k]) > CONTINUATION_COL_TOL))) continue

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
    }
    if (px ?? cx) TABLE_COLXS.set(merged, (px ?? cx)!)
    if (CLIP_TABLES.has(prev.table) || CLIP_TABLES.has(curr.table)) CLIP_TABLES.add(merged)
    blocks[i] = { ...prev, table: merged }
    blocks.splice(j, 1)
  }
  // 잇지 못한 빈 클립 표 조각은 버린다 (쪽 추출 단계에서 빈 표를 버리던 종전 동작)
  for (let i = blocks.length - 1; i >= 0; i--) {
    const t = blocks[i].table
    if (blocks[i].type === "table" && t && EMPTY_PARTS.has(t)) blocks.splice(i, 1)
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
  const sameCols = px.length === cx.length && px.every((x, k) => Math.abs(x - cx[k]) <= CONTINUATION_COL_TOL)
  if (!sameCols) {
    // 열 구성이 다르면 쪽 넘김 기하를 반드시 확인 (looksContinued 는 쪽 높이를 모르면 통과시킨다)
    if (!pageHeights?.get(prev.pageNumber!) || !pageHeights?.get(curr.pageNumber!)) return null
    if (Math.abs(px[px.length - 1] - cx[cx.length - 1]) > CONTINUATION_COL_TOL) return null
    if (!px.some(x => Math.abs(x - cx[0]) <= CONTINUATION_COL_TOL)) return null
  }
  const res = joinSplitParts(pt, px, ct, cx)
  if (!res) return null
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
/** 쪽 넘김 조각 판정 — 앞 조각 밑변이 쪽 아래 이 비율 안, 뒤 조각 윗변이 쪽 위 이 비율 안 (본문 여백 안쪽까지 찬 표) */
const PAGE_EDGE_BAND = 0.16
