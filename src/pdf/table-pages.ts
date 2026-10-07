/**
 * 쪽 넘김으로 이은 표의 쪽 귀속 (#136) — 잇기(table-parts·cell-continuation)가 뒤 쪽 조각이 놓인 쪽을 남기고, 틀 풀기는 행마다 그 쪽을,
 * 쪽별 마크다운(pages)은 쪽이 바뀌는 자리에서 표를 다시 가른다. 쪽은 칸 객체에 단다(CELL_PAGES) — 틀 풀기가 표를 새로 짜도 칸 객체는
 * 그대로 옮긴다. 한 칸 안에서 쪽을 넘은 글은 칸 블록의 pageNumber나 글 안 자리(CELL_SPLITS)로 안다. 문서 마크다운은 바꾸지 않는다
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import { CELL_PAGES } from "../table/layout-frames.js"

/** 한 칸 글 안에서 뒤 쪽 글이 시작하는 자리들 (글자 자리 오름차순) — 쪼개진 행·칸 이어짐 */
type Split = { at: number; page: number }
const CELL_SPLITS = new WeakMap<IRCell, Split[]>()

/** 같은 글이 옮겨 간 칸에서 쪼갠 자리를 다시 찾는다 — 잇기가 줄을 다듬어도 자리 뒤 20자는 그대로다. from 앞은 보지 않는다 */
function relocate(src: IRCell, dst: IRCell, from = 0): Split[] {
  const out: Split[] = []
  for (const s of CELL_SPLITS.get(src) ?? []) {
    const at = dst.text.indexOf(src.text.slice(s.at, s.at + 20).trimEnd(), Math.max(from, out.at(-1)?.at ?? 0))
    if (at >= 0) out.push({ at, page: s.page })
  }
  return out
}

const setSplits = (cell: IRCell, splits: Split[]): void => {
  if (splits.length) CELL_SPLITS.set(cell, splits.sort((a, b) => a.at - b.at))
}

/** 칸 이어짐(글만 든 칸) — 이을 글 add 가 cell 글 뒤 어디서 시작하는지 남긴다. add 안에 앞서 남긴 자리도 옮긴다 */
export function markContinuedText(cell: IRCell, add: IRCell, page: number): void {
  if (!add.text.trim()) return
  const base = cell.text.trim() ? cell.text.length + 1 : 0
  setSplits(cell, [
    ...(CELL_SPLITS.get(cell) ?? []),
    { at: base, page },
    ...(CELL_SPLITS.get(add) ?? []).map(s => ({ at: base + s.at, page: s.page })),
  ])
}

/** 행마다 그 행에서 시작하는 칸 (병합에 덮인 자리는 빼고) — 칸과 열 번호 */
function rowStarts(t: IRTable): Array<Array<{ cell: IRCell; c: number }>> {
  const covered = new Set<number>()
  const rows: Array<Array<{ cell: IRCell; c: number }>> = []
  for (let r = 0; r < t.rows; r++) {
    const starts: Array<{ cell: IRCell; c: number }> = []
    for (let c = 0; c < t.cols; c++) {
      if (covered.has(r * 100000 + c)) continue
      const cell: IRCell | undefined = t.cells[r]?.[c]
      if (!cell) continue
      for (let dr = 0; dr < cell.rowSpan; dr++) for (let dc = 0; dc < cell.colSpan; dc++) if (dr || dc) covered.add((r + dr) * 100000 + c + dc)
      starts.push({ cell, c })
    }
    rows.push(starts)
  }
  return rows
}

/** 행 r 을 덮는 칸 (위에서 세로 병합으로 내려온 칸 포함) */
const covering = (t: IRTable, r: number): IRCell[] =>
  rowStarts(t).slice(0, r + 1).flatMap((starts, rr) => starts.filter(s => rr + s.cell.rowSpan > r).map(s => s.cell))

/** 칸이 놓인 쪽 — 쪽 표시, 없으면 칸 블록이 모두 쪽을 알 때 그 첫 쪽 (앞 쪽 조각이 비어 칸 글 전부가 뒤 쪽인 칸 이어짐) */
function cellPage(cell: IRCell): number | undefined {
  const p = CELL_PAGES.get(cell)
  if (p !== undefined || !cell.blocks?.length || cell.blocks.some(b => b.pageNumber === undefined)) return p
  return Math.min(...cell.blocks.map(b => b.pageNumber!))
}

/** 표 행마다 쪽 — 그 행에서 시작하는 칸의 쪽(여럿이면 큰 쪽). 쪽 모르는 글 칸 행은 표 블록 쪽, 덮인 자리·빈 칸뿐인 행은 윗행 쪽.
 *  쪽은 아래로 줄지 않는다 */
function tableRowPages(t: IRTable, pageNumber: number | undefined): Array<number | undefined> {
  const pages: Array<number | undefined> = []
  let prev = pageNumber
  for (const starts of rowStarts(t)) {
    let mark: number | undefined, text = false
    for (const { cell } of starts) {
      const p = cellPage(cell)
      if (p !== undefined) mark = Math.max(mark ?? p, p)
      else if (cell.text.trim() || cell.blocks?.length) text = true
    }
    const page = mark ?? (text ? pageNumber : prev)
    prev = page !== undefined && prev !== undefined ? Math.max(prev, page) : page ?? prev
    pages.push(prev)
  }
  return pages
}

/**
 * 이은 표 칸에 쪽을 단다 — 잇기 경로는 칸을 새로 짜기도 해 조각 칸의 표시가 옮겨 오지 않는다. 어느 경로든 앞 조각 행이 위에 그대로
 * 놓이고 뒤 조각은 끝 행들을 차지하니(되풀이 머리 행은 빠진다) 행 자리로 옮긴다. 쪼개진 행(뒤 조각 첫 행을 앞 조각 마지막 행에 합침)은
 * 앞 쪽 행으로 두고 칸 글 안 뒤 쪽 자리를 남긴다 — 앞 조각 칸 글로 시작해 글이 늘어난 칸만 (되풀이 머리 행만 빠진 잇기는 늘지 않는다).
 * 앞 조각 행이 줄었으면 자리를 모르니 달지 않는다
 */
export function markJoinedPages(table: IRTable, prev: IRBlock, curr: IRBlock): void {
  const pt = prev.table!, ct = curr.table!
  if (!curr.pageNumber || table.rows < pt.rows) return
  const pp = tableRowPages(pt, prev.pageNumber), cp = tableRowPages(ct, curr.pageNumber)
  const off = table.rows - ct.rows
  const rows = rowStarts(table), ptRows = rowStarts(pt), ctRows = rowStarts(ct)
  rows.forEach((starts, r) => {
    const page = r < pt.rows ? pp[r] : cp[r - off]
    for (const { cell } of starts) {
      if (page !== undefined && page !== prev.pageNumber) CELL_PAGES.set(cell, page)
      // 앞서 남긴 쪼갠 자리 — 잇기가 칸을 새로 짜면 글이 같은 칸으로 옮긴다
      const src = (r < pt.rows ? ptRows[r] : ctRows[r - off])?.find(s => s.cell !== cell && s.cell.text === cell.text && CELL_SPLITS.has(s.cell))
      if (src) setSplits(cell, relocate(src.cell, cell))
    }
  })
  const cr = pt.rows - 1 - off, page = cp[cr]
  if (cr < 0 || page === undefined || page === prev.pageNumber) return
  const tails = ctRows[cr].filter(s => s.cell.text.trim())
  // 뒤 조각 칸 블록이 앞 칸에 옮겨 붙었으면(appendCell) 그 블록에 쪽을 단다
  for (const { cell } of ctRows[cr]) for (const b of cell.blocks ?? []) b.pageNumber ??= page
  const heads = covering(pt, pt.rows - 1)
  for (const cell of covering(table, pt.rows - 1)) {
    if (cell.blocks?.length) continue
    const head = heads.filter(h => h.text.trim() && cell.text.startsWith(h.text.trimEnd()) && cell.text.trim().length > h.text.trim().length)
      .sort((a, b) => b.text.length - a.text.length)[0]
    if (!head) continue
    const from = head.text.trimEnd().length
    // 뒤 조각 칸 글은 잇기가 줄을 다듬어 끝까지 같지 않을 수 있다 — 머리 20자가 앞 글 뒤에 놓인 자리로 찾는다
    const hit = tails.map(t => ({ t: t.cell, at: cell.text.indexOf(t.cell.text.trim().slice(0, 20), from) })).filter(h => h.at >= from)
      .sort((a, b) => a.at - b.at)[0]
    if (!hit) continue
    setSplits(cell, [...relocate(head, cell), { at: hit.at, page }, ...relocate(hit.t, cell, hit.at)])
  }
}

/** 칸 안에서 쪽을 넘은 글 — 앞 쪽 몫, 뒤 쪽 첫 몫과 그 쪽(더 뒤 쪽 몫은 꼬리 칸에 남아 다시 가른다). 없으면 null */
function splitCell(cell: IRCell, page: number | undefined): { head: Partial<IRCell>; tail: Partial<IRCell>; page: number; rest: Split[] } | null {
  if (page === undefined) return null
  if (cell.blocks?.length) {
    const k = cell.blocks.findIndex(b => (b.pageNumber ?? page) > page)
    if (k <= 0) return null
    const head = cell.blocks.slice(0, k), tail = cell.blocks.slice(k)
    const text = (bs: IRBlock[]): string => bs.map(b => b.text ?? "").filter(Boolean).join("\n")
    return { head: { text: text(head), blocks: head }, tail: { text: text(tail), blocks: tail }, page: tail[0].pageNumber!, rest: [] }
  }
  const splits = CELL_SPLITS.get(cell) ?? []
  const k = splits.findIndex(s => s.page > page && s.at < cell.text.length)
  if (k < 0) return null
  const s = splits[k]
  const rest = cell.text.slice(s.at), lead = rest.length - rest.trimStart().length
  return {
    head: { text: cell.text.slice(0, s.at).trimEnd() },
    tail: { text: rest.trim() },
    page: s.page,
    rest: splits.slice(k + 1).map(x => ({ at: x.at - s.at - lead, page: x.page })).filter(x => x.at > 0),
  }
}

/**
 * 칸 안에서 쪽을 넘은 글을 그 행 아래 새 행으로 뗀다 — 새 행은 뗀 칸들이 덮는 마지막 행 바로 아래, 그 자리를 지나 내려가는 세로 병합
 * 칸은 한 행 더 덮는다. 세 쪽에 걸친 칸은 꼬리 칸을 다시 가른다. 뗄 칸이 없으면 표를 그대로 돌려준다
 */
function splitCrossPageRows(t: IRTable, pageNumber: number | undefined): IRTable {
  const pages = tableRowPages(t, pageNumber)
  const rows = rowStarts(t)
  for (let r = 0; r < t.rows; r++) {
    const splits = rows[r].map(s => ({ ...s, split: splitCell(s.cell, pages[r]) })).filter(s => s.split)
    if (!splits.length) continue
    // 칸을 고쳐 복제해도 쪽 표시·남은 쪼갠 자리는 따라간다
    const clone = (cell: IRCell, patch: Partial<IRCell>): IRCell => {
      const out = { ...cell, ...patch }
      const p = CELL_PAGES.get(cell)
      if (p !== undefined) CELL_PAGES.set(out, p)
      if (!("text" in patch) && CELL_SPLITS.has(cell)) CELL_SPLITS.set(out, CELL_SPLITS.get(cell)!)
      return out
    }
    const e = Math.max(...splits.map(s => r + s.cell.rowSpan - 1))
    const cells = t.cells.map(row => row.slice())
    const row: IRCell[] = Array.from({ length: t.cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
    for (const { cell, c, split } of splits) {
      cells[r][c] = clone(cell, split!.head)
      const tail: IRCell = { ...cell, ...split!.tail, rowSpan: 1 }
      CELL_PAGES.set(tail, split!.page)
      setSplits(tail, split!.rest)
      row[c] = tail
    }
    rows.forEach((starts, rr) => {
      for (const { cell, c } of starts) {
        if (splits.some(s => s.cell === cell) || rr > e || rr + cell.rowSpan - 1 <= e) continue
        cells[rr][c] = clone(cells[rr][c], { rowSpan: cell.rowSpan + 1 })
      }
    })
    cells.splice(e + 1, 0, row)
    return splitCrossPageRows({ ...t, rows: t.rows + 1, cells }, pageNumber)
  }
  return t
}

/**
 * 쪽별 사영용 블록 — 쪽 넘김으로 이은 표를 행의 쪽이 바뀌는 자리에서 다시 쪽마다 가른다 (#136). 이은 표는 첫 쪽 블록 하나라 뒤 쪽 행이
 * 앞 쪽 항목에 들어가고, 쪽 내용이 표뿐이면 그 쪽 항목이 비거나 빠졌다. 문서 블록·마크다운은 이은 그대로 두고 새 배열만 낸다.
 * 쪽 경계를 넘는 세로 병합 칸은 앞 쪽 끝 행에서 자른다
 */
export function splitPageTables(blocks: IRBlock[]): IRBlock[] {
  return blocks.flatMap(b => {
    if (b.type !== "table" || !b.table) return [b]
    const t = splitCrossPageRows(b.table, b.pageNumber)
    const pages = tableRowPages(t, b.pageNumber)
    const cuts: number[] = [0]
    for (let r = 1; r < t.rows; r++) if (pages[r] !== pages[r - 1]) cuts.push(r)
    if (cuts.length === 1) return t === b.table ? [b] : [{ ...b, table: t }]
    return cuts.map((from, k) => {
      const end = cuts[k + 1] ?? t.rows
      const cells = t.cells.slice(from, end).map((row, dr) => row.map(cell =>
        cell && from + dr + cell.rowSpan > end ? { ...cell, rowSpan: end - from - dr } : cell))
      const table: IRTable = { ...t, rows: end - from, cells, ...(k ? { caption: undefined, captionBlocks: undefined } : {}) }
      return { ...b, table, pageNumber: pages[from] }
    })
  })
}
