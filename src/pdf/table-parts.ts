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
import { CELL_LINES, CLIP_TABLES, EMPTY_PARTS, FILLER_CELLS, IMAGE_CELLS, PART_COLXS, ROW_RULES, TABLE_COLXS, TABLE_ROWYS, TABLE_TAIL, type LineBox } from "./table-meta.js"
import { CONTACT_HEAD, CONTACT_ROLE } from "./contact-table.js"
import { markJoinedPages } from "./table-pages.js"
import { startsNewItem, type WrapLexicon } from "./line-wrap.js"
import { NO_EDGES, joinCellEdges } from "./cell-edges.js"
import { CELL_EDGES } from "../table/layout-frames.js"

/** 글 이어짐은 표시 서식이 아니라 실제 글로 판정한다. 출력 칸의 밑줄·취소선은 그대로 둔다. */
const flowText = (text: string): string => text.replace(/<\/?u>|~~/g, "")

/** 두 조각의 경계를 같은 것으로 보는 거리 (pt) — 클립 좌표 오차 0.05pt, 조각 간 반올림 여유 */
const PART_COL_TOL = 1
/** 쪽 조각끼리 짜임이 다를 때 같은 경계로 보는 거리 (pt) — 쪽 안 클립 격자(clip-cells CLIP_COORD_TOL)와 같다 */
const PART_COL_SNAP = 0.3

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

/** 오름차순 좌표 합집합 — 앞 조각 경계는 그대로 두고(조각 안 경계는 클립 격자가 0.3pt 로 이미 가름), 뒤 조각 경계는 앞 조각 경계와
 *  하나씩 짝지어(가까운 쌍부터) 같은 경계로 본다. 짝 없는 뒤 조각 경계는 새 경계다. 두 조각 경계가 같은 수로 차례차례 1pt 안이면 같은
 *  짜임이 쪽마다 조금 어긋난 것(세금포인트 보도자료 108.06/108.54·151.48/150.52·183.50/184.46)이라 PART_COL_TOL 로 짝짓고, 짜임이
 *  다르면 클립 좌표 오차(PART_COL_SNAP) 안만 짝짓는다 — 쪽마다 칸 짜임이 바뀌는 표는 1pt 떨어진 경계도 원본 격자에서 따로 선다
 *  (석유사업법 과태료 금액 칸 189.4/190.3·338.1/339.1·445.4/446.4, 원본 76열 — 1pt 로 짝지으면 62열)
 *  @returns U 합집합, map 뒤 조각 경계 → 합집합 좌표 */
function unionCoords(a: number[], b: number[]): { U: number[]; map: Map<number, number> } {
  // 경계 수가 같고 모두 차례로 PART_COL_TOL 안이면 같은 짜임이 조금 어긋난 것 — 그 밖에는 클립 좌표 오차(PART_COL_SNAP) 안만 같은 경계
  const drift = a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= PART_COL_TOL)
  const tol = drift ? PART_COL_TOL : PART_COL_SNAP
  const pairs: Array<[number, number, number]> = []
  for (const v of b) for (const x of a) if (Math.abs(x - v) <= tol) pairs.push([Math.abs(x - v), v, x])
  pairs.sort((p, q) => p[0] - q[0])
  const map = new Map<number, number>(), taken = new Set<number>()
  for (const [, v, x] of pairs) if (!map.has(v) && !taken.has(x)) { map.set(v, x); taken.add(x) }
  const out = [...a]
  for (const v of b) if (!map.has(v)) { map.set(v, v); out.push(v) }
  return { U: out.sort((x, y) => x - y), map }
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
  anchors.filter(a => a.r === r).map(a => flowText(a.cell.text).replace(/\s+/g, "")).join("|")
/** 행 글(rowText)에 칸 구분자 말고 글이 있나 */
const hasText = (t: string): boolean => t.replace(/\|/g, "") !== ""

/**
 * 두 조각을 합집합 격자로 잇는다. 경계 대응이 안 되면(조각 경계가 합집합에서 사라짐) null.
 * @param pcx·ccx 앞·뒤 조각의 열 경계 x (오름차순, 뒤 조각은 앞 조각 자리로 옮긴 좌표)
 * @param dx 뒤 조각을 옮긴 거리 — 뒤 조각 칸 글줄도 같이 옮겨 앞 조각 글줄과 맞댄다 (짝·홀 쪽 대칭 여백)
 * @param prevBottom 앞 조각 밑변 y — 쪽 경계에 걸친 세로 병합 칸 글을 가린다 (mergeStraddlingCells)
 * @returns split — 경계 행을 쪼개진 행으로 보고 합쳤는지
 */
export function joinSplitParts(prev: IRTable, pcx: number[], curr: IRTable, ccx: number[], dx = 0, prevBottom?: number, lex?: WrapLexicon): { table: IRTable; colXs: number[]; split: boolean; header: boolean } | null {
  if (pcx.length !== prev.cols + 1 || ccx.length !== curr.cols + 1) return null
  const { U, map } = unionCoords(pcx, ccx)
  const cxU = ccx.map(v => map.get(v) ?? v)
  const cols = U.length - 1
  if (cols < 1) return null
  const pa = anchorsOf(prev), ca = anchorsOf(curr)

  // 반복 머리 행 — 한컴은 머리 칸이 있는 표만 조각마다 머리 행(여러 줄일 수 있음)을 되풀이한다. 표 첫 조각은 머리 행 위에
  // 제목 상자가 붙어 나올 수 있어(편람 [별표 4] "[별표4] <개정…>" 행) 앞 조각 두 행 아래까지 어긋나게 맞춰 본다 (어긋난 맞춤은 글 있는 행만)
  let skip = 0, head = 0
  while (skip < Math.min(3, curr.rows - 1, prev.rows) && rowText(ca, skip) !== "" && rowText(ca, skip) === rowText(pa, skip)) skip++
  for (let h = 1; h <= 2 && !skip; h++) {
    head = h
    while (skip < Math.min(3, curr.rows - 1, prev.rows - h) && hasText(rowText(ca, skip)) && rowText(ca, skip) === rowText(pa, h + skip)) skip++
  }
  // 되풀이 머리 행은 원래 머리 행과 칸 자리(x 범위)까지 같다 — 한컴은 머리 행을 같은 칸 기하로 다시 그린다(짝·홀 쪽 여백만큼 통째로
  // 옮겨질 뿐). 글만 같고 칸 자리가 다르면 같은 머리를 단 새 표다(경찰복제 특수복식 "경찰악대원" 11×5 다음 쪽 "도형 | 형태 및 규격 |
  // 색상 및 재질" 11×5: 칸 경계가 2.8~8.5pt 어긋남, HWPX 두 표). 글 없는 행은 머리 행 증거가 아니라 거기서 되풀이를 끊는다
  const sameSpans = (u: Anchor[], d: Anchor[]): boolean => {
    if (u.length !== d.length || !u.length) return false
    const shift = pcx[u[u.length - 1].c + u[u.length - 1].cs] - ccx[d[d.length - 1].c + d[d.length - 1].cs]
    return u.every((a, n) => Math.abs(pcx[a.c] - ccx[d[n].c] - shift) <= CONTINUATION_COL_TOL && Math.abs(pcx[a.c + a.cs] - ccx[d[n].c + d[n].cs] - shift) <= CONTINUATION_COL_TOL)
  }
  for (let k = 0; k < skip; k++) {
    if (sameSpans(pa.filter(a => a.r === head + k), ca.filter(a => a.r === k))) continue
    if (hasText(rowText(ca, k))) return null
    skip = k
  }

  const rows = prev.rows + curr.rows - skip
  const grid: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  const owner: (Anchor | null)[][] = Array.from({ length: rows }, () => new Array<Anchor | null>(cols).fill(null))
  /** 보이는 변 곁정보(cell-edges)를 가진 칸을 놓았나 — 그러면 빈 자리 채움 칸도 자기 테두리 없는 칸으로 둔다 */
  let edged = false
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
    const edges = CELL_EDGES.get(a.cell)
    if (edges) { CELL_EDGES.set(grid[r][c1], edges); edged = true }
    return true
  }
  // 채움 칸(클립 없던 자리)은 놓지 않는다 — 빈 자리로 남아 아래 세로 병합 잇기가 채운다
  for (const a of pa) if (!FILLER_CELLS.has(a.cell) && !place(a, pcx, 0)) return null
  for (const a of ca) {
    if (a.r < skip || FILLER_CELLS.has(a.cell)) continue
    if (!place(a, cxU, prev.rows - skip, dx)) return null
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
  // 채움 칸은 자기 테두리가 없다 — 곁정보 없는 칸은 layout-frames 가 네 변 다 보이는 칸으로 본다 (둘레 칸의 변이 선을 댄다)
  if (edged) for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) if (owner[r][c] === null) CELL_EDGES.set(grid[r][c], NO_EDGES)
  // 앞 조각 왼쪽에 빠진 열(prevLacksLeftCols) — 쪽 전체를 덮은 세로 병합 칸이 그 쪽에서 클립 없이 지나간 자리다. 쪼개진 행 판정에는 두
  // 조각 경계를 가로지르는 한 칸으로 보인다(뒤 조각 첫머리 빈 자리까지). "두 쪽 모두 클립 없는 빈 칸 조각" 증거로 쓰면 조세특례 국가전략기술
  // "반도체" 칸 옆 "너. …" / 다음 쪽 "더. …" 가 한 행으로 합쳐진다. 채움 칸 표시는 그대로라 앞 쪽 조각과 다시 이을 때 세로 병합으로 이어진다
  for (let c = 0; c < cols && U[c + 1] <= pcx[0] + PART_COL_TOL; c++) {
    let r = prev.rows
    while (r < rows && owner[r][c] === null) r++
    const through: Anchor = { r: 0, c, rs: r, cs: 1, cell: grid[0][c] }
    for (let rr = 0; rr < r; rr++) owner[rr][c] = through
  }
  const table: IRTable = { rows, cols, cells: grid, hasHeader: prev.hasHeader, ...(prev.caption ? { caption: prev.caption } : {}) }
  // 쪽 경계 괘선 — 두 조각 모두 칸 밑변마다 괘선을 긋는데 앞 조각 밑변·뒤 조각 윗변만 안 그었으면(open) 쪼개진 행 증거다(mergeSplitRow 3).
  // 두 쪽 모두 쪽 경계에 괘선을 그었으면(ruled) 칸 조각 이어짐만으로는 세로 병합 칸이 넘어간 새 행과 못 가른다. 짝·홀 쪽으로 옮겨 맞댄
  // 조각(shifted)은 쪽마다 새로 놓인 상자일 수 있다 — 한 칸 제목 행을 되풀이했으면(편람 "작 성 방 법" 상자 "1. … 8." / "9. …", HWPX 는
  // 두 표) 목록 번호 이어짐을 증거로 쓰지 않고, 아니어도 앞 조각 목록 번호가 둘 이상일 때만 쓴다 (편람 전송상태값 상자 "…가. …" / "나. …")
  const pr = ROW_RULES.get(prev), cr = ROW_RULES.get(curr)
  const shifted = dx !== 0
  const cut: Cut = {
    open: !!pr && !!cr && !pr.bottom && !cr.top && pr.innerOpen + cr.innerOpen === 0 && pr.innerRuled + cr.innerRuled > 0,
    ruled: !!pr && !!cr && pr.bottom && cr.top,
    list: !shifted ? "any" : skip > 0 && ca.filter(a => a.r < skip && a.cell.text.trim()).length < 2 ? "none" : "multi",
  }
  let split = rows > prev.rows && mergeSplitRow(table, owner, prev.rows, U, false, cut)
  // 세로 병합 칸을 이은 뒤 다시 본다 — 뒤 조각 이름표가 여러 행을 덮어 쪼개진 행 판정에서 빠졌던 행("일몰설정 / 예외기준" 이름표 옆
  // "…적용 되어야 / 하는 규제", 규제영향분석서)은 이름표가 한 칸이 되면 칸 조각 이어짐으로 판정된다
  // (글 이어짐 증거만 — 이어 늘린 빈 칸 조각은 증거로 쓰지 않는다: 시험기준표 "KS M ISO 2507-1," / "KS M ISO 2507-2" 는 두 행)
  if (rows > prev.rows && !split && prevBottom !== undefined && mergeStraddlingCells(table, owner, prev.rows, prevBottom, lex, U)) split = mergeSplitRow(table, owner, prev.rows, U, true, { ...cut, open: false })
  // 이은 표의 괘선 — 세 쪽 넘게 이어질 때 앞 조각과 다시 견준다. 잇지 않은 쪽 경계는 칸 밑변 하나로 센다
  if (pr && cr) {
    const cutRuled = pr.bottom || cr.top
    ROW_RULES.set(table, { top: pr.top, bottom: cr.bottom, innerRuled: pr.innerRuled + cr.innerRuled + (!split && cutRuled ? 1 : 0), innerOpen: pr.innerOpen + cr.innerOpen + (!split && !cutRuled ? 1 : 0) })
  }
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
function mergeStraddlingCells(table: IRTable, owner: (Anchor | null)[][], first: number, prevBottom: number, lex?: WrapLexicon, colXs?: number[]): boolean {
  const last = first - 1
  const straddles = owner[first].some((o, c) => o !== null && o === owner[last][c])
  // 뒤 조각 첫 행에서 글 있는 새 칸이 처음 나오는 열 — 빈 이어짐은 그보다 왼쪽(이름표 열)만 본다. 왼쪽 이름표 열에 새 묶음 이름이
  // 있으면 그 행은 새 묶음이고 오른쪽 빈 칸(비고)은 새 칸이다(시험기준표 "드레인보드" 행 비고 칸)
  let firstNew = table.cols
  for (let c = 0; c < table.cols; c++) {
    const d = owner[first][c]
    if (d && d.r === first && d !== owner[last][c] && hasContent(table.cells[d.r][d.c])) { firstNew = c; break }
  }
  // 두 조각 글이 문서 어휘로 어절 중간에서 갈린 열이 하나라도 있으면(줄 꺾임 이음 "") 쪽 경계가 세로 병합 칸들을 가로질러 자른
  // 것이다 — 같은 모양(앞 조각 한 행 → 뒤 조각 여러 행)의 다른 이름표 칸도 글 위치(바닥 근접)와 무관하게 잇는다
  // (시험기준표 "급속함수량측 / 정기 사용불가" 옆 "시멘트안정처리 / 기층", 문서 안 "…측정기")
  let midWord = false
  if (lex) for (let c = 0; c < table.cols && !midWord;) {
    const u = owner[last][c], d = owner[first][c]
    if (!u) { c++; continue }
    c = u.c + u.cs
    if (!d || d === u || u.r + u.rs - 1 !== last || d.r !== first || d.c !== u.c || d.cs !== u.cs) continue
    // 쪽 경계 병합 모양(앞 조각 끝 행 한 칸 → 뒤 조각 여러 행)인 열에서, 두 글자+두 글자 문서 어휘 증거로만 (줄 꺾임 판정의 한 글자
    // 쌍·조각 규칙은 칸 조각 쌍에 잡음이 많다 — "경도 / 체결 축력", "슬럼프 … / 공기량")
    if (u.r !== last || d.rs < 2) continue
    const tail = table.cells[u.r][u.c].text.trim().split(/\s+/).pop() ?? "", head = table.cells[first][d.c].text.trim().split(/\s+/)[0] ?? ""
    if (/^[가-힣]{2,}$/.test(tail) && /^[가-힣]{2,}/.test(head) && lex.evidence2(tail, head) === "") midWord = true
  }
  // 긴 글 칸도 글이 이어지면 쪽 경계에 걸친 칸이다 — 다른 열 칸이 경계를 넘어 이어지고(straddles) 앞 조각에서 여러 행을 덮은 칸의 끝줄이
  // 칸 오른끝까지 차 문장이 다음 쪽 칸으로 넘어갔다(continuesAcross). 같은 모양(앞 조각 행 범위·뒤 조각 행 수)의 옆 칸도 줄 수·바닥 거리와
  // 무관하게 같은 병합 칸의 나머지다 (경찰복제 특수복식 교통경찰관 17→18쪽: "…주머니를 작게 한" / "다. 나) 하의 …" 옆 색상 칸
  // "가) 상의" / "(1) 아이보리화이트색" — HWPX 두 칸 모두 3행 병합). 끝줄이 짧게 끝난 긴 칸("라. 항공경찰관 점퍼" 12줄 → "마.")은 해당 없다
  const crossed = new Set<string>()
  const shape = (u: Anchor, d: Anchor): string => `${u.r}:${u.rs}:${d.rs}`
  if (straddles && colXs) for (let c = 0; c < table.cols;) {
    const u = owner[last][c], d = owner[first][c]
    if (!u) { c++; continue }
    c = u.c + u.cs
    if (!d || d === u || u.r + u.rs - 1 !== last || d.r !== first || d.c !== u.c || d.cs !== u.cs || u.rs < 2) continue
    const a = table.cells[u.r][u.c], b = table.cells[first][d.c]
    if (hasContent(a) && hasContent(b) && continuesAcross(a, b, colXs[u.c], colXs[u.c + u.cs])) crossed.add(shape(u, d))
  }
  let merged = false
  for (let c = 0; c < table.cols;) {
    const u = owner[last][c], d = owner[first][c]
    if (!u) { c++; continue }
    c = u.c + u.cs
    if (!d || d === u || u.r + u.rs - 1 !== last || d.r !== first || d.c !== u.c || d.cs !== u.cs) continue
    const a = table.cells[u.r][u.c], b = table.cells[first][d.c]
    // 빈 이어짐 — 앞 조각에서 두 행 이상 덮은 이름표 칸 아래 뒤 조각 첫 칸이 비었으면 그 칸의 나머지다. 새 묶음이면 이름표가 있다
    // (aift 기업 현황 "자본잠식현황" 앞 쪽 2행 + 다음 쪽 빈 4행, "자본총계" 2행 + 빈 1행 — 모든 칸이 쪽 경계에서 끝나도).
    // 글이 이어진 칸과 같은 모양(crossed)이면 아래 짧은 글 조건을 보지 않는다
    if (!crossed.has(shape(u, d)) && !(u.rs >= 2 && u.c + u.cs <= firstNew && hasContent(a) && !hasContent(b))) {
      if (!straddles && !midWord) continue
      // 앞 조각에 끝 행 하나만 보인 칸도 뒤 조각 칸이 두 행 이상을 덮으면 쪽 경계에 걸친 병합 칸이다(성능시험 TRL 표 "제품화 / 단계",
      // 시험기준표 "플라이애시 / 시멘트(KS L 5211)") — 뒤 조각 한 행 칸은 새 칸일 수 있어 그대로 둔다
      if (u.r >= last && d.rs < 2) continue
      const U = CELL_LINES.get(a)
      if (!U?.length || !hasContent(b)) continue
      if (!(straddles && filledToBottom(U, prevBottom) && clauseContinues(a, b))) {
        if (U.length > STRADDLE_MAX_LINES) continue
        const lu = U[U.length - 1]
        // 앞 조각에 한 행만 보인 칸은 글이 쪽 경계에 걸쳐야 한다(가운데 정렬 병합 칸 글이 바닥 반 줄 안) — 한 행짜리 새 칸 글은 행 가운데에 선다
        if (!midWord && lu.y - prevBottom > (u.r >= last ? STRADDLE_BOTTOM_ONE_ROW : STRADDLE_BOTTOM) * (lu.h || 10)) continue
      }
    }
    appendCell(a, b)
    a.rowSpan = first + d.rs - u.r
    table.cells[first][d.c] = { text: "", colSpan: 1, rowSpan: 1 }
    const grown: Anchor = { ...u, rs: a.rowSpan }
    for (let rr = u.r; rr < u.r + grown.rs; rr++) for (let dc = u.c; dc < u.c + u.cs; dc++) owner[rr][dc] = grown
    merged = true
  }
  return merged
}

/**
 * 위에서부터 흐른 칸 글이 앞 조각 바닥까지 찼다 — 끝줄 아래 남은 자리가 줄 간격(글줄 사이 기준선 거리)에 글자 크기
 * FILL_SLACK 배를 더한 것보다 작아 다음 줄이 들어갈 수 없었다. 가운데 정렬 병합 칸(바닥 반 줄 안, STRADDLE_BOTTOM)과 달리
 * 위 정렬 칸은 글이 여러 줄이어도 끝줄이 바닥에 붙지 않는다 (출입국관리법 과태료 "차. …준용하는" 끝줄 기준선이 밑변 위 25pt,
 * 줄 간격 22pt·12pt 글자)
 */
function filledToBottom(U: ReadonlyArray<{ y: number; h: number }>, bottom: number): boolean {
  if (U.length < 2) return false
  const lu = U[U.length - 1]
  return lu.y - bottom < (U[0].y - lu.y) / (U.length - 1) + FILL_SLACK * (lu.h || 10)
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
const STRADDLE_BOTTOM_ONE_ROW = 0.55
/** 바닥까지 찬 글 — 줄 간격에 더하는 여유(글자 크기 배): 끝줄 아래 글자 내림(0.25배)과 칸 아래 여백 */
const FILL_SLACK = 0.5
/** 칸 조각 이어짐 증거로 보는 빈 자리 열의 최소 폭 (pt) — 클립 격자의 셀 최소 폭과 같다 */
const CARRIED_MIN_COL_W = 4
/** 끝난 이름표 — 한 줄 칸 오른쪽에 남은 자리가 글자 크기의 이 배수 이상 (숫자 머리 "4." 한 어절이 들어간다) */
const LABEL_ROOM = 1.5
/** 내어쓰기 이어짐 — 앞 끝줄이 칸 글 왼끝보다 글자 크기의 이 배수 이상 들어가 있고, 뒤 첫 줄 왼끝이 이 거리(pt) 안에서 같다 */
const HANGING_MIN = 0.5
const HANGING_TOL = 1

/** 항목 머리 차례 — 한글 가나다(가~하, 거~허, 고~호 …)·숫자 */
const KO_ITEMS = "가나다라마바사아자차카타파하거너더러머버서어저처커터퍼허고노도로모보소오조초코토포호구누두루무부수우주추쿠투푸후"
const ITEM_MARK = /^\s*(?:([가-힣])\.|(\d{1,3})[.)]|\(([가-힣\d]{1,3})\))(?=\s)/

/** 뒤 글이 앞 글 첫머리 항목의 바로 다음 항목(같은 꼴)으로 시작하는가 — "커." 다음 "터.", "3." 다음 "4.", "(나)" 다음 "(다)" */
export function nextItemHead(prev: string, next: string): boolean {
  const a = ITEM_MARK.exec(prev), b = ITEM_MARK.exec(next)
  if (!a || !b) return false
  const succ = (x: string, y: string) => /^\d+$/.test(x) ? /^\d+$/.test(y) && Number(y) === Number(x) + 1
    : KO_ITEMS.indexOf(x) >= 0 && KO_ITEMS.indexOf(y) === KO_ITEMS.indexOf(x) + 1
  if (a[1] && b[1]) return succ(a[1], b[1])
  if (a[2] && b[2]) return succ(a[2], b[2]) && prev.trimStart()[a[2].length] === next.trimStart()[b[2].length]
  if (a[3] && b[3]) return succ(a[3], b[3])
  return false
}

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
  // 내어쓴 자리에서 시작한 끝줄은 그 자리부터 칸 오른끝까지가 줄 폭이다 (좁은 칸 "(나) 그 / 밖 의" 둘째 줄 31pt, 칸 75pt)
  const indented = last.l - minL >= HANGING_MIN * fs
  if (last.r - last.l < FULL_LINE_MIN_FRAC * (indented ? x2 - last.l : x2 - x1)) return false
  // 문단 끝줄은 칸 글 왼끝에서 시작하거나, 내어쓴 자리에서 시작하면 같은 자리의 다른 줄과 오른끝이 달라야 한다 — 가운데 정렬 줄은
  // 왼끝이 같으면 폭도 같다. 내어쓰기가 글자 하나보다 깊은 칸(10pt 글자에 13pt 내어쓰기, 안전인증기관 기준 "가. … / 1) …")은 끝줄이
  // 칸 글 왼끝에서 글자 하나 넘게 들어가 있다. 이 넓힌 증거와 아래 내어쓰기 첫 줄은 뒤 쪽 글이 새 항목 머리로 시작하면 쓰지 않는다 —
  // 앞 끝줄이 문단 끝인데 우연히 꽉 찬 것이다 (폐기물관리법 과태료 "…갱신하지 않은 경우" / 다음 쪽 새 행 "부. 법 제40조제8항에 …")
  const newItem = startsNewItem(u.text, d.text)
  const all = D.length ? U.concat(D) : U
  const leftAligned = (l: LineBox) => maxR - l.r > SHORT_LINE_GAP * fs
    && (l.l - minL <= fs || (!newItem && all.some(o => o !== l && Math.abs(o.l - l.l) <= HANGING_TOL && Math.abs(o.r - l.r) >= HANGING_MIN * fs)))
  // 양쪽 맞춤이라 모든 줄이 꽉 차 문단 끝줄이 없는 칸 — 앞 쪽 끝줄이 내어쓴 자리(문단 둘째 줄 이후)에서 시작하고 뒤 쪽 첫 줄이
  // 같은 자리에서 이어지면 같은 문단이다 (제약기업 인증 규정 별첨 대비표 "1. 다음 각 목의 … 해 / 당하는 … 받지 않거 / 나, 그 행정처분을…":
  // 93 → 104 → 104). 새 문단이면 뒤 첫 줄이 문단 머리 자리에서 시작한다 (물관리 제안요청서 "‧다국적 …" 다음 "‧수질오염 …")
  const hanging = U.length >= 2 && U.every(l => maxR - l.r <= FULL_LINE_TOL * fs)
    && indented && Math.abs(D[0].l - last.l) <= HANGING_TOL
  // 문단 머리 줄에서 끊긴 내어쓰기 — 앞 쪽 끝줄이 문단 머리 자리(내어쓰기 전)에서 꽉 차고, 뒤 쪽 줄이 모두 그보다 들어간 한 자리에서
  // 꽉 차게 이어진다 (석유사업법 과태료 "4) 법 제38조의" / 다음 쪽 "2제1항을 위반 / 하여 석유제품 / …" 66 → 75). 새 칸의 문단이면 뒤 첫 줄이
  // 머리 자리에서 시작하거나(내어쓰기) 둘째 줄이 첫 줄보다 나온다(들여쓰기)
  const hangingHead = !indented && D.length >= 2 && D[0].l - last.l >= HANGING_MIN * fs && maxR - D[0].r <= FULL_LINE_TOL * fs
    && D.every(l => Math.abs(l.l - D[0].l) <= HANGING_TOL)
  // 내어쓰기 첫 줄 — 앞 쪽에 문단 첫 줄 한 줄만 보이고 뒤 쪽 첫 줄이 그보다 들어간 자리(내어쓴 자리)에서 새 항목 머리 없이 이어진다
  // (도시정비법 과징금 "3) 건설업자 또는 등록사업자가" 75pt / 다음 쪽 "법 제132조제2항을 …" 86pt). 새 행이면 뒤 첫 줄은 항목 머리 자리에서
  // 시작한다. 가운데·오른쪽 정렬 칸도 짧은 뒷줄은 들어가 시작하므로, 뒤 첫 줄이 칸 폭 절반 넘게 차 오른끝을 같이 쓰거나(양쪽 맞춤 — 오른쪽
  // 정렬 짧은 글 "사무관" / "과장" 과 가른다) 오른끝이 짧게 끝나며 가운데가 어긋나야 한다(가운데 정렬은 두 줄 가운데가 같다)
  const d0 = D[0]
  // 뒤 쪽 둘째 줄부터가 첫 줄보다 나오면 첫 줄만 들여 쓴 새 문단이다 — 내어쓰기 이어짐이면 뒤 줄이 모두 그 자리 안쪽에 선다
  const hangStart = U.length === 1 && !newItem && d0.l - last.l >= HANGING_MIN * fs && D.every(l => l.l >= d0.l - HANGING_TOL)
    && ((Math.abs(d0.r - last.r) <= HANGING_TOL && d0.r - d0.l >= FULL_LINE_MIN_FRAC * (x2 - x1))
      || (last.r - d0.r > SHORT_LINE_GAP * fs && Math.abs(d0.l + d0.r - last.l - last.r) / 2 >= HANGING_MIN * fs))
  return U.some(leftAligned) || D.some(leftAligned) || hanging || hangingHead || hangStart
}

/** 개조식 절 제목 줄(□) */
const OUTLINE_HEAD = /^[□■]\s*\S/
/** 절 제목 아래 단계 항목 부호 */
const OUTLINE_ITEM = /^[ㅇ○◦\-‐–·․‧※*]\s*\S/

/**
 * 개조식 위계 이어짐 — 앞 쪽 칸 글이 □ 절 제목 아래 항목이고 뒤 쪽 칸 글이 그 아래 단계 부호(ㅇ·-·※)로 시작하면 절 안 목록이
 * 다음 쪽으로 넘어간 것이다 (새 칸이면 절 제목부터 시작한다). 칸 안 문단 경계에서 쪽이 넘어가 글 이어짐 증거가 없는 행을 잡는다
 * (과제 품목 명세서 "□ 개발내용 / ㅇ … / - … 주사제형화 기술 개발" / 다음 쪽 "ㅇ PFC 나노산소운반체의 …")
 */
function outlineContinues(u: IRCell, d: IRCell): boolean {
  const U = flowText(u.text).split("\n").map(l => l.trim()).filter(Boolean)
  const D = flowText(d.text).split("\n").map(l => l.trim()).filter(Boolean)
  return U.length >= 2 && D.length >= 1 && U.some(l => OUTLINE_HEAD.test(l)) && OUTLINE_ITEM.test(D[0])
}

/** 한 줄로 끝난 왼쪽 정렬 칸 — 오른쪽에 남은 자리(왼쪽 안쪽 여백만큼 뺀)가 글자 크기의 LABEL_ROOM 배 이상이라 다음 어절이 들어갈 수 있었다.
 *  다음 조각 첫 어절을 알면 그 폭(한글·한자 1em, 나머지 0.55em)도 들어가야 한다 — "…적용 되어야" 뒤 1.5em 남짓한 자리에 "하는"(2em)은
 *  안 들어가 줄이 바뀐 것이다(규제영향분석서 12.규제일몰제). 가운데 정렬 칸은 좌우 여백이 같아 해당하지 않는다 */
function lineEnded(c: IRCell, x1: number, x2: number, next?: IRCell): boolean {
  const L = CELL_LINES.get(c)
  if (!L || L.length !== 1) return false
  const l = L[0], h = l.h || 10
  // 뒤 조각 첫 줄이 앞 줄보다 들어간 자리에서 시작하면 끝난 이름표 뒤의 새 이름표가 아니라 앞 문단의 아래 항목·내어쓴 줄이다
  // (군인연금법 유족 증명서류 "1. 가족관계증명서상 자녀인 경우" 168pt / 다음 쪽 "가. 군인등의 …" 180pt — 같은 칸 목록이 쪽을 넘었다)
  const d0 = next ? CELL_LINES.get(next)?.[0] : undefined
  if (d0 && d0.l - l.l >= HANGING_MIN * h) return false
  return (x2 - l.r) - (l.l - x1) >= Math.max(LABEL_ROOM, firstWordUnits(next?.text ?? "")) * h
}

/** 첫 어절 폭(글자 크기 배) — 한글·한자 1, 나머지 0.55. 여는 괄호 뒤 공백은 텍스트층이 끼운 것이라 다음 낱말과 한 어절로 본다
 *  (선관위 자격증 "( 자격증종류는 별표 12에 의함)") */
function firstWordUnits(text: string): number {
  const word = flowText(text).trim().replace(/^([(\[「『<〈])\s+/, "$1").split(/\s+/)[0] ?? ""
  let units = 0
  for (const ch of word) units += /[가-힣\u3400-\u9fff]/.test(ch) ? 1 : 0.55
  return units
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
  joinCellEdges(a, b)
}

/** 칸에 내용이 있나 — 글·블록·그림 (그림은 PDF 에서 칸 글과 따로 뽑혀 text 가 빈다) */
const hasContent = (cell: IRCell): boolean => !!cell.text.trim() || !!cell.blocks?.length || IMAGE_CELLS.has(cell)

/**
 * 쪽 넘김으로 쪼개진 행 — 뒤 조각 첫 행을 앞 조각 마지막 행에 합친다. 한컴은 칸 단위로 나누지 않는 표의 긴 행을 글줄
 * 사이에서 끊어 두 쪽에 나눠 그리고, 쪽 끝 행은 쪼개졌든 아니든 본문 바닥까지 늘려 그리므로 기하로는 구별이 안 된다.
 * 두 행의 칸 짜임(열 범위)이 같고, 다음 증거 가운데 하나가 있을 때만 합친다.
 *  1) 글 이어짐 — 어느 한 열에서 글이 앞 쪽 끝줄을 꽉 채우고 뒤 쪽으로 이어지거나(continuesAcross) 문장 중간에서 끊겼다(clauseContinues),
 *     뒤 쪽 첫 줄 번호가 앞 쪽 칸 목록의 다음 차례다(listContinues).
 *  2) 칸 조각 이어짐 — 한컴은 칸의 첫 조각에는 글이 없어도 클립을 깐다(편람 대비표 빈 시행규칙 칸). 앞 쪽 끝 행에서 시작한
 *     칸(또는 앞 쪽에서도 클립이 없던 칸)이 다음 쪽에 클립이 없으면 그 칸은 다음 쪽 첫 행 띠까지 이어진 것이다. 글 있는 열 쌍이
 *     하나뿐이고 새 칸 증거(앞 쪽 빈 칸 뒤의 글)가 없으면 행이 쪼개진 것으로 본다. 칸 안 문단 경계에서 쪽이 넘어가 글 증거가 없는
 *     행(편람 대비표 "…제1항 / ② 중앙행정기관…")을 여기서 잡는다. 쪽 넘김 후보를 HWPX 로 같은 칸인지 확인한 대조: 표 GT 한컴
 *     407쌍에서 이 조건 42건이 전부 쪼개진 행, 따로 뗀 법령 서식·별표 4세트(rhwp 변환 HWPX)에서 121건 중 새 행 2건.
 *     글 있는 열 쌍이 둘 이상이면 세로 병합 칸만 이어지고 행은 새로 시작하는 경우(시험기준표 "플라이애시 / 시멘트")와
 *     섞여 쓰지 않는다(아래 carriedSplit 의 두 예외). 위에서 내려온 세로 병합 칸이 클립 없이 넘어간 것은 새 행에서도 똑같아 증거가 아니다
 *  3) 괘선 없는 쪽 경계 — 두 조각 모두 칸 밑변마다 괘선을 긋는데 쪽 경계만 앞 조각 밑변·뒤 조각 윗변 괘선이 없다(한컴은 쪽을 넘는 칸의
 *     잘린 변에 테두리를 긋지 않는다). 법령 별표 272건 쪽 넘김 후보에서 이 모양 40건이 모두 쪼개진 행, 새 행 0건
 *     (군인연금법 유족 증명서류 "바. 「군인 재해보 / 상법」 …" 옆 "1. … 자녀인 경우 / 가. 군인등의 …")
 */
/** 문장 중간에서 끊긴 끝 어절 — 받침에 맞는 목적격 조사(받침 뒤 "을"·모음 뒤 "를" — "마을" 은 아니다)나 관형형·연결 어미(뒤에 서술어가 와야 하는 -어야 포함) */
const CLAUSE_OPEN_ENDING = /(?:하는|되는|하고|하며|하여|되어|되고|되며|이며|으며|어야|아야|여야)$/
const batchim = (ch: string): boolean => { const k = ch.charCodeAt(0) - 0xac00; return k >= 0 && k < 11172 && k % 28 !== 0 }
/**
 * 글 이어짐(문장) — 앞 쪽 칸 글이 문장 중간에서 끊기고 뒤 쪽 칸이 새 항목 머리가 아닌 한글로 시작한다. 가운데 정렬 칸은 끝줄이 오른끝에
 * 닿는지(continuesAcross)로 못 가려(규제영향분석서 정성분석 "…폐기 사실을 / 입력하므로 제도 도입에 따른…") 말 자체로 본다
 */
function clauseContinues(u: IRCell, d: IRCell): boolean {
  const tail = flowText(u.text).trim().split(/\s+/).pop() ?? "", head = flowText(d.text).trim()
  if (!/^[가-힣]{2,}$/.test(tail) || !/^[가-힣]/.test(head) || startsNewItem(u.text, head)) return false
  const last = tail[tail.length - 1], before = tail[tail.length - 2]
  return (last === "을" && batchim(before)) || (last === "를" && !batchim(before)) || CLAUSE_OPEN_ENDING.test(tail)
}

/**
 * 줄 넘침 — 앞 쪽 끝줄에 뒤 쪽 첫 어절을 붙이면 칸 폭을 넘는다(가운데 정렬이어도 그 어절은 그 줄에 못 들어가 줄이 바뀌었다). 좁은 칸의
 * 짧은 글은 새 칸 글과도 곧잘 들어맞아 홀로는 증거가 못 되고, 칸 조각 이어짐(carried)과 함께 볼 때만 쓴다
 * (양곡가공업자 처분기준 "영업정지 / 3개월" 57pt 칸, 선관위 자격증 "방송 / 통신" 40pt 칸)
 */
function wordOverflows(u: IRCell, d: IRCell, x1: number, x2: number): boolean {
  const U = CELL_LINES.get(u)
  if (!U?.length || startsNewItem(u.text, d.text)) return false
  const last = U[U.length - 1], units = firstWordUnits(d.text)
  return units > 0 && last.r - last.l + units * (last.h || 10) > x2 - x1
}

/** 한글 항목 번호 차례 */
const KO_ORDER = "가나다라마바사아자차카타파하"
/** 줄 머리 항목 번호 — 꼴(1.·1)·(1)·가.·가)·(가)·①·A.)과 차례 */
function itemMark(line: string): { style: string; n: number } | null {
  line = flowText(line).trim()
  let m = /^(\d{1,2})([.)])(?!\d)/.exec(line)
  if (m) return { style: "1" + m[2], n: +m[1] }
  if ((m = /^\((\d{1,2})\)/.exec(line))) return { style: "(1)", n: +m[1] }
  if ((m = /^([가-하])([.)])/.exec(line)) && KO_ORDER.includes(m[1])) return { style: "가" + m[2], n: KO_ORDER.indexOf(m[1]) }
  if ((m = /^\(([가-하])\)/.exec(line)) && KO_ORDER.includes(m[1])) return { style: "(가)", n: KO_ORDER.indexOf(m[1]) }
  if ((m = /^[①-⑳]/.exec(line))) return { style: "①", n: m[0].charCodeAt(0) }
  if ((m = /^([A-Z])\.\s/.exec(line))) return { style: "A.", n: m[1].charCodeAt(0) }
  return null
}

/**
 * 목록 이어짐 — 뒤 쪽 칸 첫 줄의 항목 번호가 앞 쪽 칸 목록의 다음 차례다(같은 꼴의 마지막 번호 + 1). 칸 안 문단 경계에서 쪽이 넘어가
 * 글 이어짐 증거가 없는 행(진단기관 지정기준 "가. … 바. …" / 다음 쪽 "사. …", 직무교육기관 장비 "1) … 8) …" / "9) …")을 잡는다.
 * 앞 쪽 칸 목록은 번호가 둘 이상이거나 칸 첫 줄이 아닌 자리에서 시작해야 한다 — 행마다 항목 하나를 둔 표는 칸 첫 줄이 번호이고
 * 다음 행이 다음 번호로 시작한다(과태료 부과기준 "다. …" 행 다음 "라. …" 행)
 */
function listContinues(u: IRCell, d: IRCell, multi = false): boolean {
  const head = itemMark(d.text.trim())
  if (!head) return false
  const marks = u.text.split("\n").map(l => itemMark(l.trim()))
  let last = -1, count = 0
  marks.forEach((m, i) => { if (m?.style === head.style) { last = i; count++ } })
  return last >= 0 && marks[last]!.n + 1 === head.n && (count >= 2 || (!multi && last > 0))
}

/** 뒤 쪽 첫 행에 글 있는 칸이 하나뿐이고 그 칸이 개조식 위계로 이어진다 — 다른 열에 새 글(이름표)이 오면 새 행이다 */
function outlineOnly(pairs: Array<[Anchor, Anchor]>, cell: (a: Anchor) => IRCell): boolean {
  const filled = pairs.filter(([, d]) => hasContent(d.cell))
  return filled.length === 1 && outlineContinues(cell(filled[0][0]), cell(filled[0][1]))
}

/** 쪽 경계 괘선과 목록 번호 증거 범위 — joinSplitParts 가 두 조각 곁정보로 정한다 */
interface Cut { open: boolean; ruled: boolean; list: "any" | "multi" | "none" }
const NO_CUT: Cut = { open: false, ruled: false, list: "any" }

function mergeSplitRow(table: IRTable, owner: (Anchor | null)[][], first: number, colXs: number[], textOnly = false, cut: Cut = NO_CUT): boolean {
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
      if (a.c !== b.c || a.cs !== b.cs || a.r + a.rs - 1 !== last || b.r !== first) return false
      // 뒤 조각 칸이 여러 행을 덮으면 쪽 경계에 걸친 세로 병합 칸의 나머지다(외국환거래법 "다. 등록 또는 인가의 내용 / 이나 조건을
      // 위반한 경우" 가 다음 쪽 두 행을 덮는다). 앞 쪽 칸이 비었으면 새로 시작한 세로 병합 이름표(가산대상 자격증 빈 칸 아래 "임업"),
      // 앞 쪽에서도 여러 행을 덮었으면 행은 새로 시작하고 이름표만 쪽 경계를 넘은 것이다(과태료 기준 "…준용하는 / 경우를 포함한다)" 옆
      // "5회 | 70만원" / "6회 | 90만원" — mergeStraddlingCells 가 잇는다)
      if (b.rs > 1 && (a.rs > 1 || !hasContent(a.cell))) return false
      pairs.push([a, b])
    } else if (a.r === last && a.rs === 2) carried = true // 앞 쪽 끝 행에서 시작한 칸을 뒤 쪽 첫 행 빈 자리로만 이어 늘렸다 — 더 아래까지
    // 비어 있으면 뒤 쪽 여러 행을 덮는 세로 병합 칸이다(규제영향분석서 "기타"). 쪼개진 행의 이어진 조각은 첫 행 띠 하나다
    c = a.c + a.cs
  }
  // 뒤 쪽 칸 조각의 글 없는 클립은 증거가 아니다 — 한컴 PDF 판(1.3.0.546·538)과 칸에 따라 이어진 빈 조각에도 클립을 깐다
  // (법령 별표 쪼개진 행 17건에 있음). 앞 쪽 빈 칸 뒤에 글이 오는 것만 새 칸 증거다 (글은 칸 위에서부터 흐른다)
  const newCell = pairs.some(([u, d]) => !hasContent(u.cell) && hasContent(d.cell))
  // 글줄은 격자에 놓은 복사본 칸에서 본다 — 옮겨 맞댄 뒤 조각(짝·홀 쪽·단 넘김)은 복사본에만 옮긴 글줄이 있다
  const cell = (a: Anchor): IRCell => table.cells[a.r][a.c]
  // 글 있는 열 쌍이 둘 이상이면 세로 병합 칸만 넘어가고 행은 새로 시작하는 표(규제영향분석서 "10.영향평가 여부" 옆 "기술영향평가 |
  // 경쟁영향평가 | …" / 다음 쪽 "해당없음 | 해당없음 | …")와 가려야 한다. 쪼개진 행 증거로 쓰는 경우 —
  //  · 글 있는 뒤 조각 칸이 모두 여러 행을 덮는다: 쪽 경계에 걸린 행의 세로 병합 칸들이 함께 넘어갔다. 새 행이면 한 행 칸이 적어도
  //    하나 있다 (선관위 자격증 "방송 / 통신"·"기술사 / (자격증종류는 …)" 가 다음 쪽 두 행을 덮고, 옆 "통신사" 칸은 클립 없이 이어진다)
  //  · 쪽 경계에 괘선이 없고 글 쌍 하나라도 줄 넘침이다 (양곡가공업자 "영업정지 / 3개월")
  // 이때 다른 열의 한 줄 끝난 글은 칸 안 문단 경계다(선관위 "기능장" / "기사(6) …") — 끝난 이름표 모순(lineEnded)을 보지 않는다.
  // 법령 별표 272건에서 칸 조각 이어짐 + 글 쌍 둘 이상 35건이 모두 쪼개진 행, 표 GT 에서 새 행 1건(위 규제영향분석서, 괘선 있는 쪽 경계)
  const contentPairs = pairs.filter(([u, d]) => hasContent(u.cell) && hasContent(d.cell))
  const carriedSplit = !textOnly && carried && !newCell && (contentPairs.length <= 1 || contentPairs.every(([, d]) => d.rs > 1)
    || (!cut.ruled && contentPairs.some(([u, d]) => wordOverflows(cell(u), cell(d), colXs[u.c], colXs[u.c + u.cs]))))
  if (!carriedSplit) {
    // 앞 쪽 칸이 한 줄로 끝난 이름표(다음 어절이 들어갈 자리가 남음)인데 뒤 쪽 같은 열에 다른 글이 있으면 그 열은 새 칸이다 — 끝난 칸의
    // 이어진 조각은 글이 없어 클립조차 없다. 다른 열 끝줄이 꽉 찬 것(글 이어짐)보다 이 모순이 앞선다 (편람 [별표 4] 가로 판
    // "8. 글자 | …꽉 찬 끝줄" 다음 쪽 "9. 한글과 함께 적는 외국글자 | 가. 단어를 …", 시험기준표 "액성한계·소성한계 | KS F 2303" 다음 쪽
    // "세립토 비율 | KS F 2309"). 같은 글이면 문단마다 붙는 표지다 (신구조문 대비표 "<신 설>" 이 큰 행 두 조각에 하나씩)
    const norm = (c: IRCell): string => flowText(c.text).replace(/\s+/g, "")
    if (pairs.some(([u, d]) => hasContent(d.cell) && norm(cell(d)) !== norm(cell(u)) && lineEnded(cell(u), colXs[u.c], colXs[u.c + u.cs], cell(d)))) return false
    // 한 칸은 앞 조각 머리 항목의 바로 다음 항목으로 시작하고("커. …" / "터. …"), 다른 칸은 두 조각 모두 서로 다른 한 줄 값이면("법 제47조" /
    // "법 제45조") 새 행이다 — 좁은 칸 끝줄 "2) 2회 이상 위반" 이 꽉 차 보여 다음 쪽 새 행을 앞 행에 잇고 ○ 표시까지 섞었다(총포화약법
    // 행정처분기준, 4.17.0 회귀). 칸 안 목록이 "가. …" / "나. …" 로 이어지는 대비표는 다른 칸 값이 같거나(<신 설>) 비어 있다
    const oneLine = (c: IRCell): boolean => CELL_LINES.get(c)?.length === 1
    if (pairs.some(([u, d]) => nextItemHead(cell(u).text, cell(d).text))
      && pairs.some(([u, d]) => hasContent(u.cell) && hasContent(d.cell) && oneLine(cell(u)) && oneLine(cell(d)) && norm(cell(u)) !== norm(cell(d)))) return false
    const flows = ([u, d]: [Anchor, Anchor]): boolean => continuesAcross(cell(u), cell(d), colXs[u.c], colXs[u.c + u.cs]) || clauseContinues(cell(u), cell(d))
    // 괘선 없는 쪽 경계(3)는 글 증거 없이 합친다 — 앞 쪽 빈 칸 뒤 글(새 칸)이 없을 때만 (쪽 끝 빈 행 다음 새 표 행, 노인복지법 운영기준)
    if (!(cut.open && !newCell)) {
      // 그 칸 글이 스스로 이어지지 않는 여러 행 칸은 다음 쪽에서 새로 시작한 세로 병합 칸이다 (시험기준표 "KS D 3502 / KS F 4603" 아래
      // 세 행을 덮는 새 "KS F 4603")
      if (pairs.some(p => p[1].rs > 1 && !flows(p))) return false
      // 다른 글 이어짐 증거는 뒤 조각에서 한 행인 칸에서만 본다 — 여러 행을 덮는 칸은 쪽 경계에 걸친 세로 병합 칸이라 그 글이 이어져도
      // 행은 새로 시작할 수 있다 (특수복식 "2) 여자 경찰 / 공무원 근무복" 칸 옆 "2) 여자 경찰공무원 근무복" 다음 행 "가) 상의 앞면, 뒷면")
      const one = pairs.filter(([, d]) => d.rs === 1)
      if (!outlineOnly(pairs, cell) && !one.some(flows) && (cut.list === "none" || !one.some(([u, d]) => listContinues(cell(u), cell(d), cut.list === "multi")))) return false
    }
  }
  for (const [u, d] of pairs) {
    appendCell(table.cells[u.r][u.c], table.cells[d.r][d.c])
    // 뒤 조각에서 여러 행을 덮던 칸은 이은 칸이 그만큼 더 덮는다 (아래 줄이기가 경계 행 하나를 뺀다)
    if (d.rs > 1) table.cells[u.r][u.c].rowSpan = u.rs + d.rs
  }
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
 * 두 조각 사이에 자기 쪽 표 조각과 가로로 겹치지 않는 블록(besideOwn)이나 쪽 끝·첫머리 띠의 쪽 번호(pageNumberBetween)만 끼어 있으면
 * 인접으로 본다 (그 블록은 제자리에 둔다).
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

/** 쪽 번호 한 줄 — "21", "- 21 -" */
const PAGE_NUMBER_TEXT = /^[-–—]?\s*\d{1,4}\s*[-–—]?$/

/**
 * 두 조각 사이의 쪽 번호 — 앞 조각 아래 쪽 끝 띠나 뒤 조각 위 쪽 첫머리 띠에 홀로 놓인 쪽 번호 문단. 머리글·바닥글 제거는 3쪽 이상
 * 파싱할 때만 돌아 두 쪽만 뽑거나(-p 29-30) 제거를 끄면(--no-header-footer) 쪽 번호가 표 폭 안에 남아 이음을 막았다(응급의료기관 평가
 * 기준집 p.29-30: 앞 쪽 끝 행 가중치 1.5 칸이 다음 쪽 두 행에 걸친 표가 두 표로 갈려 다음 쪽 행의 가중치가 빈 칸). 쪽 높이를 모르면 두지 않는다
 */
function pageNumberBetween(b: IRBlock, p: IRBlock, c: IRBlock, pageHeights?: Map<number, number>): boolean {
  if (b.type !== "paragraph" || !b.bbox || !PAGE_NUMBER_TEXT.test(b.text?.trim() ?? "")) return false
  const h = b.pageNumber ? pageHeights?.get(b.pageNumber) : undefined
  if (!h) return false
  if (b.pageNumber === p.pageNumber) return b.bbox.y + b.bbox.height <= Math.min(p.bbox!.y, h * PAGE_EDGE_BAND) + 1
  if (b.pageNumber === c.pageNumber) return b.bbox.y >= Math.max(c.bbox!.y + c.bbox!.height, h * (1 - PAGE_EDGE_BAND)) - 1
  return false
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
  markJoinedPages(table, prev, blocks[j])
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

/** 두 첫 행이 같은 머리 모양인가 — 칸마다 열·행 병합이 같고, 세로 병합 칸(두 행 이상)을 하나 이상 품었다 */
function sameHeadShape(a: IRCell[] | undefined, b: IRCell[] | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false
  let tall = false
  for (let c = 0; c < a.length; c++) {
    if (a[c].colSpan !== b[c].colSpan || a[c].rowSpan !== b[c].rowSpan) return false
    if (a[c].rowSpan >= 2 && a[c].text.trim() && b[c].text.trim()) tall = true
  }
  return tall
}

export function mergeCrossPageTables(blocks: IRBlock[], pageHeights?: Map<number, number>, lex?: WrapLexicon): void {
  mergeColumnFlow(blocks, pageHeights, lex)
  for (let i = blocks.length - 2; i >= 0; i--) {
    const tail = tailOf(blocks[i])
    if (tail.type !== "table" || !tail.table || !tail.bbox || !tail.pageNumber) continue
    // 다음 표 — 다음 쪽까지만 훑는다 (글만 긴 문서에서 블록마다 끝까지 훑지 않게). 앞 표 테두리 안에 든 표(칸 안 예시 상자가 따로 나온
    // 것)와 앞 표 왼쪽 단의 표(2단 지면)는 건너뛴다 — 편람 [별표 4] 서식 설계기준표는 "3. 쪽번호" 칸 안 예시 상자가 쪽 마지막 표가
    // 되어 다음 쪽 조각과 끊겼다
    let j = i + 1
    const skip = (b: IRBlock): boolean => b.type !== "table" || [blocks[i], tail].some(t => insideTable(b, t) || leftColumnOf(b, t))
    while (j < blocks.length && skip(blocks[j]) && (blocks[j].pageNumber ?? 0) <= tail.pageNumber + 1) j++
    const curr = blocks[j]
    // 붙인 이어짐 조각과 같은 쪽에 이어 놓인 표는 종전처럼 표 첫 쪽에서 본다 (규제영향분석서 연도별 편익 표: 다음 쪽 첫머리 조각 바로 아래
    // "근거설명" 행 조각 — 조각 쪽 기준으로는 같은 쪽이라 잇지 못했다)
    const prev = tail !== blocks[i] && curr?.pageNumber === tail.pageNumber ? blocks[i] : tail
    if (!prev.table || !prev.bbox || !prev.pageNumber) continue
    if (!curr || curr.type !== "table" || !curr.table || !curr.bbox || curr.pageNumber !== prev.pageNumber + 1) continue
    // 단위 행이 양쪽에 다시 나타나면 각 쪽에서 새 표를 시작한 것이다.
    if (startsWithUnitRow(prev.table) && startsWithUnitRow(curr.table)) continue
    const joined = j === i + 1 || blocks.slice(i + 1, j).every(b => besideOwn(b, prev, curr) || insideTable(b, prev) || pageNumberBetween(b, prev, curr, pageHeights))
      ? (looksContinued(prev, curr, pageHeights) && !restartsTable(blocks, i, curr.table, pageHeights) ? joinClipParts(prev, curr, pageHeights, lex) ?? false : null)
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

    // 다음 표 첫 행이 앞 표 첫 행과 같은 모양(칸마다 열·행 병합이 같고 세로 병합 칸을 품은 머리)인데 글이 다르면 새 표의 머리다
    // — 쪽마다 새로 놓인 같은 틀 상자("일 러 두 기" 다음 쪽 "목 차", 보도자료 표지 상자). 되풀이 머리 행은 글이 같다
    if (!rowTextsEqual(prev.table.cells[0], curr.table.cells[0]) && sameHeadShape(prev.table.cells[0], curr.table.cells[0])) continue

    // 반복 헤더 행 제거: 다음 표 첫 행들이 이전 표 첫 행들과 같으면 중복 헤더. 머리가 여러 행이면(첫 행 칸이 세로 병합으로
    // 그 깊이를 알린다 — "구분|장비분류|구급차 구분" 위, "특수구급차|일반구급차" 아래) 그 깊이까지 본다. 첫 행만 빼면 둘째 머리 행이
    // 본문 행으로 남아 첫 행 세로 병합 자리가 빈 칸으로 드러났다(구급차 관리·운용 안내 [별표 16] 30~31쪽)
    let currCells = curr.table.cells
    const headRows = repeatedHeaderRows(prev.table, curr.table)
    if (headRows < 0) continue
    if (headRows) currCells = currCells.slice(headRows)
    // 앞 조각 마지막 행에서 끝나는 세로 병합 칸(상위 항목 "나. 응급 처치용 의료장비")이 다음 쪽 조각 첫 행에서 글 없는 세로 병합 칸으로
    // 다시 그려졌으면 같은 칸의 이어짐이다 — 앞 칸 병합을 늘리고 뒤 빈 칸은 덮인 자리로 둔다. 글 없는 한 행 칸은 증거로 쓰지 않는다
    if (currCells.length) continueRowSpans(prev.table.cells, currCells)
    if (currCells.length === 0) {
      blocks.splice(j, 1)
      continue
    }

    // 선 격자도 반복 머리행 아래의 본문이 쪽 중간에서 끊긴다. 기존 칸·문장 이어짐 검증을 재사용한다.
    // 한 줄로 끝난 이름표·새 항목은 mergeSplitRow가 거절하며, 글줄 증거 없는 표는 종전대로 행을 붙인다.
    if (px && cx && !CLIP_TABLES.has(prev.table) && !CLIP_TABLES.has(curr.table)
      && currCells.length < curr.table.cells.length && curr.table.cells[0].filter(c => c.text.trim()).length >= 2
      && prev.table.cells.at(-1)!.concat(currCells[0]).every(c => c.rowSpan === 1 && c.colSpan === 1 && CELL_LINES.has(c))) {
      const dx = px[0] - cx[0]
      const part = joinSplitParts(prev.table, px, curr.table, cx.map(x => x + dx), dx, undefined, lex)
      if (part?.split && part.table.rows === prev.table.rows + currCells.length - 1) {
        const last = prev.table.rows - 1
        for (let c = 0; c < part.table.cols; c++) {
          const U = CELL_LINES.get(prev.table.cells[last][c])!, D = CELL_LINES.get(currCells[0][c])!
          CELL_LINES.set(part.table.cells[last][c], U.concat(D.map(l => ({ ...l, l: l.l + dx, r: l.r + dx }))))
        }
        TABLE_COLXS.set(part.table, part.colXs)
        placeJoined(blocks, i, j, part.table)
        continue
      }
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
function mergeColumnFlow(blocks: IRBlock[], pageHeights?: Map<number, number>, lex?: WrapLexicon): void {
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
    const joined = joinClipParts(L, R, pageHeights, lex)
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
 * 경계 위에 있음을 요구한다(뒤 쪽에 세로 병합 이어진 칸이 비어 왼쪽 열이 빠진 경우). 앞 조각 쪽에서 왼쪽 열이 빠진 경우
 * (prevLacksLeftCols)와 뒤 조각 경계가 모두 앞 조각 경계 위에 있는 경우(양옆 열이 빠진 쪼개진 끝 행)도 잇는다.
 */
function joinClipParts(prev: IRBlock, curr: IRBlock, pageHeights?: Map<number, number>, lex?: WrapLexicon): IRTable | null {
  const pt = prev.table!, ct = curr.table!
  if (!CLIP_TABLES.has(pt) || !CLIP_TABLES.has(ct)) return null
  const px = TABLE_COLXS.get(pt), cx = TABLE_COLXS.get(ct)
  if (!px || !cx) return null
  let xs = cx, shifted = false, dx = 0, foreign = false, within = false
  if (!shiftedSame(px, cx, false)) {
    // 열 구성이 다르면 쪽 넘김 기하를 반드시 확인 (looksContinued 는 쪽 높이를 모르면 통과시킨다)
    if (!pageHeights?.get(prev.pageNumber!) || !pageHeights?.get(curr.pageNumber!)) return null
    // 짝·홀 쪽 대칭 여백(11.4pt)이나 2단 지면의 단 넘김(420pt)으로 표 전체가 옮겨졌으면 뒤 조각을 앞 조각 자리로 옮겨 맞댄다. 다만
    // 같은 틀 상자가 쪽마다 새로 놓인 것(편람 Q&A 상자 55개)과 가르려고 경계 행이 쪼개진 행이거나 글 있는 머리 행이 되풀이될 때만
    // 잇는다 — 새 상자의 첫 행은 빈 칸이고 앞 상자 끝 행과 칸 짜임이 달라 둘 다 될 수 없다. 이 조건 없이 옮김만 넣으면 연달아
    // 놓인 상자끼리 이어져 편람 −14표 (클립 표 평행 이동 후보 47건 중 같은 표 5건)
    dx = px[px.length - 1] - cx[cx.length - 1]
    // 뒤 조각의 경계가 모두 앞 조각 경계 위에 있으면 옮겨진 것이 아니라 양옆 열이 빠진 조각이다 — 쪼개진 끝 행에서 글이 넘어간 열만
    // 클립이 깔리고 글 없이 넘어간 좌우 열은 클립이 없다(총포 행정처분기준 "너. …전자장치를 임의로 / 제거 또는 훼손" 은 위반사항·적용법령
    // 두 열만 다음 쪽 첫머리에, 9열 중 오른쪽 6열이 빠져 오른끝이 196pt 어긋남). 경계가 우연히 맞물린 새 표와 가르려고 옮긴 조각처럼
    // 쪼개진 행 증거를 요구한다
    within = Math.abs(dx) > CONTINUATION_COL_TOL && cx.length >= 3 && cx.every(x => px.some(p => Math.abs(p - x) <= CONTINUATION_COL_TOL))
    if (Math.abs(dx) > CONTINUATION_COL_TOL && !within) { xs = cx.map(x => x + dx); shifted = true } else dx = 0
    if (!px.some(x => Math.abs(x - xs[0]) <= CONTINUATION_COL_TOL) && !prevLacksLeftCols(prev, px, xs, pageHeights)) return null
    // 뒤 조각이 절 제목 상자 꼴로 시작하고 안쪽 열 경계가 앞 조각 경계 어디에도 맞물리지 않으면 새로 놓인 상자다 — 옮긴 조각처럼
    // 쪼개진 행·글 있는 머리 행 되풀이가 있을 때만 잇는다(서식 7열 표 뒤 다음 쪽 "목 차" 상자, "3 | 기대성과 및 기대효과"·"5 | 시험방법"
    // 번호 머리 상자, "② 세미나, 포럼, 언론 활동" 제목 상자 — tac-img-02·pr-1674). 쪽마다 열 짜임을 바꾸며 이어지는 별표·서식은 첫 행이
    // 앞 쪽 비고의 이어진 문단("가. 제조(수입)업무의 …", 과징금 산정기준)이거나 안쪽 경계 일부가 맞물린다(규제영향분석서)
    // 뒤 조각이 이미 그다음 쪽 조각과 이어진 표면 그 첫 조각의 경계로도 본다 — 뒤쪽 쪽들의 열 짜임이 섞여 들어와 새 상자로 보이면 안 된다
    // (자동차종합검사 시설기준: 셋째 쪽 전폭 행 조각이 다섯째 쪽 "구 분 | 자 격 | 직 무" 조각과 먼저 이어져 둘째 쪽과 끊겼다)
    const unrelated = (b: number[]): boolean => {
      const inner = b.slice(1, -1).map(x => x + dx)
      return inner.length > 0 && !inner.some(x => px.some(p => Math.abs(p - x) <= CONTINUATION_COL_TOL))
    }
    // 첫 행부터 칸이 셋 이상인 뒤 조각도 같다 — 제 열 짜임으로 시작한 새 표다. 한 표의 쪽 넘김이면 두 조각이 한 격자의 경계를 나눠
    // 쓰는데, 안쪽 경계가 하나도 안 맞물리면 합집합 격자는 행마다 제 병합만 남은 짜깁기가 된다(안전보건표지 [별표 6] 1쪽 13열 표 →
    // 2쪽 "4. | 401 녹십자표지 | …" 10열 표, 안쪽 경계 12개·9개 가운데 맞물림 0 — HWPX 두 표). 첫 행이 한 칸인 이어진 문단은 그대로 잇는다
    foreign = unrelated(cx) && unrelated(PART_COLXS.get(ct) ?? cx)
      && (headingRow(ct.cells[0] ?? []) || px.length > FOREIGN_FIRST_ROW_CELLS && anchorsOf(ct).filter(a => a.r === 0).length >= FOREIGN_FIRST_ROW_CELLS)
  }
  const res = joinSplitParts(pt, px, ct, xs, dx, prev.bbox?.y, lex)
  if (!res || ((shifted || foreign || within) && !res.split && !res.header)) return null
  TABLE_COLXS.set(res.table, res.colXs)
  const ys = TABLE_ROWYS.get(pt)
  if (ys) TABLE_ROWYS.set(res.table, ys)
  PART_COLXS.set(res.table, PART_COLXS.get(pt) ?? px)
  CLIP_TABLES.add(res.table)
  return res.table
}

/**
 * 앞 조각에 왼쪽 열이 빠졌나 — 앞 조각 왼끝이 뒤 조각 안쪽 경계 위에 있고 앞 조각이 쪽 머리부터 바닥까지 찼다. 왼쪽 열의 세로 병합
 * 칸이 쪽 전체를 덮고 그 쪽에 글이 없으면 한컴은 그 칸에 클립을 깔지 않아, 가운데 쪽 조각만 왼쪽 열 없이 나온다(해양경찰 관할구역
 * "동해지방해양경찰청" 칸, 체류자격 첨부서류 "교수(E-1)" 칸). 쪽 전체를 차지한 조각은 표 첫머리가 아니라 사슬 가운데라 머리 행이 없다
 */
function prevLacksLeftCols(prev: IRBlock, px: number[], xs: number[], pageHeights?: Map<number, number>): boolean {
  const ph = pageHeights?.get(prev.pageNumber!)
  if (!ph || prev.bbox!.y + prev.bbox!.height < ph * (1 - PAGE_EDGE_BAND)) return false
  return xs[0] < px[0] && xs.slice(1, -1).some(x => Math.abs(x - px[0]) <= CONTINUATION_COL_TOL)
}

/** 절 제목 상자 꼴의 첫 행 — 짧은 제목 한 칸(공백 뺀 8자 이하), 원문자로 시작하는 제목 한 칸, 번호 칸 + 제목 칸 */
function headingRow(row: IRCell[]): boolean {
  const heads = row.map(c => flowText(c.text).replace(/\s+/g, "")).filter(Boolean)
  if (heads.length === 1) return heads[0].length <= 8 || /^[①-⑳❶-❿]/.test(heads[0])
  return heads.length === 2 && /^(?:\d{1,2}|[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]+|[①-⑳❶-❿])$/.test(heads[0])
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
  if (ph && ch && ((prev.bbox!.y > ph * PAGE_EDGE_BAND && !pushedLead(prev, curr)) || curr.bbox!.y + curr.bbox!.height < ch * (1 - PAGE_EDGE_BAND))) return false
  const firstRow = curr.table!.cells[0] ?? []
  const firstText = firstRow.find(c => c.text.trim())?.text ?? ""
  if (!ANNEX_HEAD_RE.test(firstText)) return true
  // 신구조문 대비표 행 — 현행·개정안 두 칸 이상에 같은 "[별표 2] …" 가 들면 첨부 머리표가 아니라 대비표 본문이다 (머리표는 제목 한 칸)
  const filled = firstRow.map(c => flowText(c.text).replace(/\s+/g, "")).filter(Boolean)
  return filled.length >= 2 && filled.every(t => t === filled[0])
}

/**
 * 쪽 넘김으로 밀려난 그림 행 묶음 — 앞 조각이 쪽 끝 띠 위에서 끝났어도 뒤 조각 첫 행 묶음(첫 행에서 세로 병합으로 이어진 행들)에 그림 칸이
 * 있고 그 높이가 앞 쪽 남은 자리(앞 조각 밑변에서 쪽 밑 끝까지)보다 높으면 그 자리에 들어갈 수 없어 다음 쪽으로 넘어간 것이다. 한컴은
 * 칸 그림을 쪽 경계에서 쪼개지 않아 복장 도면 같은 큰 그림이 든 표는 앞 쪽 바닥이 크게 빈다(경찰복제 특수복식 80×27: 3쪽 밑변 142pt
 * ← 4쪽 "방한외투 및 방한복" 세 행 187pt, 4쪽 258pt ← 5쪽 "상의" 여섯 행 387pt, 5쪽 152pt ← 6쪽 "하의" 세 행 245pt). 머리 행으로
 * 시작하는 새 표는 첫 묶음이 그림 없는 한 행(21pt)이라 해당하지 않는다(같은 문서의 쪽마다 놓인 11×5 표들). 글만 든 행은 쪽 경계에서
 * 쪼개질 수 있어 밀려남의 증거가 아니다 — 쪽 나누기로 다음 쪽에 새로 놓인 서식 표와 가르지 못한다
 */
function pushedLead(prev: IRBlock, curr: IRBlock): boolean {
  if (!CLIP_TABLES.has(prev.table!) || !CLIP_TABLES.has(curr.table!)) return false
  const lead = leadRows(curr.table!)
  return lead.image && lead.height > prev.bbox!.y
}

/** 표 첫 행 묶음(첫 행에서 세로 병합 칸으로 이어진 행들)의 높이(첫 조각 행 경계로, 모르면 0)와 그림 칸이 들었는지 */
function leadRows(t: IRTable): { height: number; image: boolean } {
  const ys = TABLE_ROWYS.get(t)
  if (!ys || ys.length < 2) return { height: 0, image: false }
  const anchors = anchorsOf(t)
  let end = 1, image = false
  for (let r = 0; r < end; r++) {
    for (const a of anchors) {
      if (a.r !== r) continue
      end = Math.max(end, r + a.rs)
      if (IMAGE_CELLS.has(a.cell)) image = true
    }
  }
  return { height: ys[0] - ys[Math.min(end, ys.length - 1)], image }
}

/** 표 끝 자리 — 마지막 행 칸이 다음 쪽으로 넘어가 그 조각을 붙인 표(TABLE_TAIL)는 그 쪽과 조각 밑변을, 아니면 블록 그대로. 쪽 넘김
 *  잇기는 앞 표가 끝난 쪽·자리를 봐야 한다 — 위험물 안전관리자 교육 [별표 4] 틀 표는 2쪽 끝 칸이 3쪽을 통째로 채우고 4쪽 조각으로
 *  이어지는데, 3쪽 조각을 2쪽 표에 붙인 뒤 표가 2쪽에 있는 것으로 보여 4쪽 조각과 잇지 못했다 (HWPX 19×7 한 표) */
function tailOf(b: IRBlock): IRBlock {
  const t = b.table && TABLE_TAIL.get(b.table)
  return t && b.bbox ? { ...b, pageNumber: t.page, bbox: { ...b.bbox, page: t.page, y: t.y, height: t.height } } : b
}

/** 표 첫 행 앵커 — 열 경계 x 범위와 글 */
function firstRowSig(t: IRTable): Array<{ x1: number; x2: number; t: string }> | null {
  const x = TABLE_COLXS.get(t)
  if (!x || x.length !== t.cols + 1) return null
  return anchorsOf(t).filter(a => a.r === 0).map(a => ({ x1: x[a.c], x2: x[a.c + a.cs], t: flowText(a.cell.text).replace(/\s+/g, "") }))
}

/**
 * 뒤 표 첫 행이 앞 조각이 속한 표(쪽 넘김 사슬 첫 조각)의 첫 행을 다시 시작하는가 — 앵커 칸 짜임(x 범위, 대칭 여백
 * 이동 허용)이 같고 이름표 칸 둘 이상이 같은 글인데 값 칸이 하나 이상 다르다. 한 서식을 품목마다 되풀이한 문서(과제 품목 명세서
 * 5벌, 서식마다 두 쪽)에서 앞 서식 끝 조각은 본문 바닥 근처에서 끝나고 다음 쪽 첫머리가 새 서식이라 쪽 넘김 기하로는 이어짐과
 * 같다(141×22 한 표로 뭉침). 반복 머리 행은 글이 모두 같아 해당 없고, 이어진 조각의 첫 행은 표 첫 행과 칸 짜임부터 다르다
 */
function restartsTable(blocks: IRBlock[], i: number, curr: IRTable, pageHeights?: Map<number, number>): boolean {
  const cs = firstRowSig(curr)
  if (!cs) return false
  const head = blocks[chainHead(blocks, i, pageHeights)].table!
  if (cs.length === 1 && restartsTitledForm(head, curr)) return true
  if (cs.length < RESTART_MIN_ANCHORS) return false
  // 보도자료 연락처 표의 다음 부처 묶음 — "담당 부서 | 부처 | 책임자 | …" 를 되풀이해도 한 표다 (HWPX 연락처 표 522개 중 여러 묶음 72개,
  // 묶음마다 따로 둔 표 0개). 정부합동 보도자료에서 쪽 끝 묶음과 다음 쪽 묶음이 두 표로 갈렸다
  if (CONTACT_HEAD.test(cs[0].t) && cs.some(c => CONTACT_ROLE.test(c.t))) return false
  const hs = firstRowSig(head)
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
 * 전폭 제목 칸으로 시작하는 서식의 되풀이 — 두 표 첫 행이 모두 전폭 한 칸이고 글이 다르며, 둘째 행의 칸 짜임과 첫 칸 이름표가 같다.
 * "3) 공공데이터 자동수집 / 목표 | … / 세부 목표 | …" 상자를 과제마다 놓은 계획서(tac-img-02)에서 쪽 끝 상자와 다음 쪽 첫 상자가
 * 쪽 넘김 기하로 이어져 6×2 로 뭉쳤다. 이어진 조각이면 첫 행이 제목 칸일 때 그 아래 행 이름표까지 표 첫머리와 같을 까닭이 없다
 */
function restartsTitledForm(head: IRTable, curr: IRTable): boolean {
  if (head.rows < 2 || curr.rows < 2 || head.cols !== curr.cols) return false
  const full = (t: IRTable) => t.cells[0][0]?.colSpan === t.cols
  if (!full(head) || !full(curr)) return false
  const norm = (c: IRCell | undefined) => flowText(c?.text ?? "").replace(/\s+/g, "")
  const ht = norm(head.cells[0][0]), ct = norm(curr.cells[0][0])
  if (!ht || !ct || ht === ct) return false
  // 제목 칸만 — 앞 쪽에서 넘어온 본문 칸("ㅇ …"·"- …" 긴 글)으로 시작하는 이어진 조각끼리는 짜임이 같아도 새 표가 아니다(form-002)
  const titleLike = (t: string) => t.length <= TITLE_ROW_MAX_CHARS && !/^[ㅇ○◦•·\-–※*□■▪☞]/.test(t)
  if (!titleLike(ht) || !titleLike(ct)) return false
  const spans = (t: IRTable) => anchorsOf(t).filter(a => a.r === 1).map(a => `${a.c}:${a.cs}`).join(",")
  const label = norm(head.cells[1][0])
  return spans(head) === spans(curr) && label !== "" && label === norm(curr.cells[1][0])
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
    const pb = tailOf(blocks[p])
    if (pb.pageNumber !== (cur.pageNumber ?? 0) - 1) break
    if (!blocks.slice(p + 1, k).every(b => besideOwn(b, pb, cur) || insideTable(b, pb) || pageNumberBetween(b, pb, cur, pageHeights))) break
    if (!looksContinued(pb, cur, pageHeights)) break
    const px = TABLE_COLXS.get(pb.table!), cx = TABLE_COLXS.get(cur.table!)
    if (!px || !cx) break
    const dx = px[px.length - 1] - cx[cx.length - 1]
    if (!shiftedSame(px, cx) && !px.some(x => Math.abs(x - (cx[0] + dx)) <= CONTINUATION_COL_TOL) && !prevLacksLeftCols(pb, px, cx, pageHeights)) break
    k = p
  }
  return k
}

/** 쪽 넘김 조각 경계에서 끊긴 세로 병합 칸 잇기 — 앞 조각 끝 행까지 걸친 글 있는 병합 원점과 같은 열·폭의 뒤 조각 첫 행 빈 병합 칸 */
const ROW_CONTINUATIONS = new WeakMap<IRCell, IRCell>()

function continueRowSpans(prevCells: IRCell[][], currCells: IRCell[][]): void {
  const first = currCells[0]
  const last = prevCells.length
  for (let c = 0; c < first.length; c++) {
    const cell = first[c]
    if (hasContent(cell) || (cell.rowSpan || 1) < 2) continue
    let anchor: IRCell | undefined
    for (let r = last - 1; r >= 0 && !anchor; r--) {
      const a = prevCells[r]?.[c]
      if (a && r + (a.rowSpan || 1) === last && (a.colSpan || 1) === (cell.colSpan || 1)
        && (hasContent(a) || a.rowSpan >= 2)) anchor = a
    }
    if (!anchor) continue
    // 역순 이음에서 가운데 쪽의 빈 원점은 아직 이름표를 모른다. 실제 쪽 경계의 조각 관계만 보관하고 이름표를 찾았을 때 잇는다.
    if (!hasContent(anchor)) { ROW_CONTINUATIONS.set(anchor, cell); continue }
    for (let part: IRCell | undefined = cell; part;) {
      const next = ROW_CONTINUATIONS.get(part)
      anchor.rowSpan = (anchor.rowSpan || 1) + part.rowSpan
      // 원점 객체를 유지해야 앞서 보관한 사슬이 끊기지 않는다. 덮인 자리는 격자 자리표만 남긴다.
      part.rowSpan = 1
      part.colSpan = 1
      ROW_CONTINUATIONS.delete(part)
      part = next
    }
  }
}

/** 첫 행에서 시작한 머리 병합의 전이적 깊이까지, 글과 앵커 모양이 모두 같을 때만 머리를 통째로 뺀다. -1은 다른 머리. */
function repeatedHeaderRows(prev: IRTable, curr: IRTable): number {
  if (!rowTextsEqual(prev.cells[0], curr.cells[0])) return 0
  const pa = anchorsOf(prev), ca = anchorsOf(curr)
  let depth = 1
  for (let r = 0; r < depth && r < prev.rows; r++) {
    for (const a of pa) if (a.r === r) depth = Math.max(depth, r + a.rs)
  }
  if (depth >= curr.rows || depth > prev.rows) return -1
  const p = pa.filter(a => a.r < depth), d = ca.filter(a => a.r < depth)
  const norm = (text: string) => flowText(text).replace(/\s+/g, "")
  return p.length === d.length && p.every((a, i) => a.r === d[i].r && a.c === d[i].c && a.rs === d[i].rs
    && a.cs === d[i].cs && norm(a.cell.text) === norm(d[i].cell.text)) ? depth : -1
}

/** 두 행의 셀 텍스트가 모두 동일한지 (공백 정규화 후 비교) */
function rowTextsEqual(a: IRCell[], b: IRCell[]): boolean {
  if (a.length !== b.length) return false
  const norm = (t: string) => flowText(t).replace(/\s+/g, "")
  for (let i = 0; i < a.length; i++) {
    if (norm(a[i].text) !== norm(b[i].text)) return false
  }
  // 빈 행끼리의 비교는 의미 없음
  return a.some(c => c.text.trim() !== "")
}

/** 쪽 넘김 이음 판정 — 열 경계가 이 거리(pt) 안에서 전부 맞아야 같은 표 */
const CONTINUATION_COL_TOL = 2
/** 안쪽 열 경계가 앞 조각과 하나도 안 맞물리는 뒤 조각이 새 표 — 첫 행 칸이 이만큼 이상 (제 열 짜임으로 시작), 앞 조각도 열이 이만큼
 *  이상. 1열 앞 조각(별표 제목 틀·서식 머리 칸)은 안쪽 경계가 없어 맞물림을 따질 수 없다 (과징금 부과기준 1쪽 4×1 → 2쪽 6×6, HWPX 한 표) */
const FOREIGN_FIRST_ROW_CELLS = 3

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
/** 되풀이 서식의 전폭 제목 칸 글 길이 상한 (공백 뺀 글자) */
const TITLE_ROW_MAX_CHARS = 40
const RESTART_LOOKBACK_PAGES = 5
