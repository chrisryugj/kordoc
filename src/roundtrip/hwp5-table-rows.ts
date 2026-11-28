/**
 * HWP 5.x 표 행 더하기·빼기 (HWPX table-rows 와 같은 몫). 영역(cell zone) 없는 표만.
 *
 * 고치기 전·뒤 행을 맞대어(alignUnits) 남는 새 행은 앞 행(없으면 첫 행)의 칸을 본떠 끼우고 — 칸 머리(LIST_HEADER) 사본에 새 문단 —
 * 남는 옛 행은 칸 레코드를 통째로 지운다. 합친 칸(행·열 합치기)은 표 다른 곳(머리 행 등)엔 있어도 되고, 본뜨는 행·지우는 행에는
 * 없어야 하며 위에서 내려오는 행 합치기가 그 경계를 걸치면 안 된다. 행 주소(LIST_HEADER @10)를 최종 차례로 다시 매기고 TABLE
 * 레코드의 행 수·행별 칸 수 배열을 고친다(필드 자리는 HWP 5.0 명세, hwp5/to-hwpx/controls.ts tableXml 과 같다).
 * 새 문단 줄 나눔 정보는 한글이 다시 짠다. 짝지어진 행 쌍은 돌려주어 호출자가 칸 글 고치기(종전 경로)를 한다.
 */
import { alignUnits } from "./markdown-units.js"
import { groupEnd, newParagraph, type NewPara } from "./hwp5-cell-lines.js"
import type { ScanCell5, ScanTable5, SectionScan5 } from "./hwp5-patch.js"

const TAG_PARA_HEADER = 0x42, TAG_LIST_HEADER = 0x48
const LAST = 0x80000000

/** 칸 레코드 끝(칸 머리 다음부터 그 칸 문단 묶음 끝까지) */
function cellEnd(scan: SectionScan5, cell: ScanCell5): number {
  const last = cell.paras[cell.paras.length - 1]
  return last ? groupEnd(scan, last.headerIdx) : cell.listHeaderIdx + 1
}

export interface RowsResult { applied: number; pairs: Array<[number, number]> }

/** 행 작업 — keep: 원래 행 o 유지, del: 원래 행 o 지움, add: 새 행(칸마다 줄 글) */
export type RowOp = { kind: "keep"; o: number } | { kind: "del"; o: number } | { kind: "add"; lines: string[][] }

/** 행 작업을 스테이징한다. 못 하는 표·행이면 null(아무것도 바꾸지 않는다) */
export function stageRowOps(scan: SectionScan5, table: ScanTable5, ops: RowOp[]): number | null {
  const { rows, cols, tableIdx } = table
  if (!scan.safe || tableIdx < 0 || !ops.some(op => op.kind !== "keep")) return null
  const records = scan.records
  const td = records[tableIdx].data
  if (td.length < 18 + rows * 2 + 4 || td.readUInt16LE(18 + rows * 2 + 2) !== 0) return null  // 영역 있는 표는 행 번호가 얽힌다
  // 칸 → 행·열·합치기
  const info = [...table.cells.values()].map(cell => {
    const lh = records[cell.listHeaderIdx].data
    return { cell, row: lh.readUInt16LE(10), col: lh.readUInt16LE(8), cs: lh.readUInt16LE(12), rs: lh.readUInt16LE(14) }
  })
  if (info.some(x => x.cell.tables.length || !x.cell.paras.length || x.row >= rows)) return null
  const rowCells = (r: number) => info.filter(x => x.row === r).sort((a, b) => a.col - b.col)
  /** 합친 칸 없이 열 수만큼 칸이 있는 행 */
  const plainRow = (r: number) => { const rc = rowCells(r); return rc.length === cols && rc.every(x => x.cs === 1 && x.rs === 1) }
  /** 행 r 과 r+1 사이를 행 합치기가 걸치는가 */
  const crosses = (r: number) => info.some(x => x.row <= r && x.row + x.rs - 1 > r)
  // 본뜰 행 — 앞 행이 합친 칸 없는 행이면 그 행, 아니면(병합 머리 행 뒤 등) 뒤 원래 행
  const tplFor = (x: number, prevO: number): number | null => {
    if (prevO >= 0 && plainRow(prevO)) return prevO
    const next = ops.slice(x + 1).find(o => o.kind !== "add") as { o: number } | undefined
    return next && plainRow(next.o) ? next.o : prevO < 0 && plainRow(0) ? 0 : null
  }
  // 확인 — 지우는 행·본뜨는 행·끼우는 자리
  let prev = -1
  const tpls: Array<number | null> = []
  for (const [x, op] of ops.entries()) {
    if (op.kind === "keep") { prev = op.o; tpls.push(null); continue }
    if (op.kind === "del") { if (!plainRow(op.o) || crosses(op.o - 1) || crosses(op.o)) return null; prev = op.o; tpls.push(null); continue }
    const tpl = tplFor(x, prev)
    if (tpl === null || op.lines.length !== cols || (prev >= 0 && crosses(prev))) return null
    tpls.push(tpl)
  }

  const level = records[rowCells(0)[0]?.cell.listHeaderIdx ?? table.tableIdx].level
  type Row = { orig: number } | { cells: Array<{ head: Buffer; paras: NewPara[] }> }
  const order: Row[] = []
  const insertAt = (o: number) => { const rc = rowCells(o >= 0 ? o : 0); return o >= 0 ? cellEnd(scan, rc[rc.length - 1].cell) : rc[0].cell.listHeaderIdx }
  let applied = 0
  prev = -1
  for (const [x, op] of ops.entries()) {
    if (op.kind === "keep") { order.push({ orig: op.o }); prev = op.o; continue }
    if (op.kind === "del") {
      for (const x of rowCells(op.o)) for (let j = x.cell.listHeaderIdx; j < cellEnd(scan, x.cell); j++) scan.repl.set(j, null)
      prev = op.o; applied++
      continue
    }
    const tplRow = rowCells(tpls[x]!)
    const cells = tplRow.map((x, c) => {
      const lines = op.lines[c].length ? op.lines[c] : [""]
      const paras = lines.map(t => newParagraph(scan, x.cell.paras[0], t.trim(), level))
      paras.forEach((p, k) => p.header.writeUInt32LE(((p.header.readUInt32LE(0) & ~LAST) | (k === paras.length - 1 ? LAST : 0)) >>> 0, 0))
      const head = Buffer.from(records[x.cell.listHeaderIdx].data)
      head.writeUInt16LE(paras.length, 0)
      return { head, paras }
    })
    order.push({ cells })
    const at = insertAt(prev)
    const list = scan.inserts.get(at) ?? []
    for (const cell of cells) {
      list.push({ tagId: TAG_LIST_HEADER, level, data: cell.head })
      for (const p of cell.paras) list.push({ tagId: TAG_PARA_HEADER, level, data: p.header }, ...p.recs)
    }
    scan.inserts.set(at, list)
    applied++
  }
  // 행 주소 다시 매기기 · TABLE 행 수와 행별 칸 수
  const sizes: number[] = []
  order.forEach((row, k) => {
    if ("orig" in row) {
      sizes.push(td.readUInt16LE(18 + row.orig * 2))
      if (row.orig === k) return
      for (const x of rowCells(row.orig)) {
        const cur = Buffer.from(scan.repl.get(x.cell.listHeaderIdx) ?? records[x.cell.listHeaderIdx].data)
        cur.writeUInt16LE(k, 10)
        scan.repl.set(x.cell.listHeaderIdx, cur)
      }
    } else {
      sizes.push(cols)
      for (const cell of row.cells) cell.head.writeUInt16LE(k, 10)
    }
  })
  const sz = Buffer.alloc(sizes.length * 2)
  sizes.forEach((v, k) => sz.writeUInt16LE(v, k * 2))
  const nt = Buffer.concat([td.subarray(0, 18), sz, td.subarray(18 + rows * 2)])
  nt.writeUInt16LE(sizes.length, 4)
  scan.repl.set(tableIdx, nt)
  return applied
}

/** 행 키로 맞댄 짝 → 행 작업과 짝지어진 행 */
export function rowOpsFromPairs(pairs: Array<[number | null, number | null]>, addLines: (e: number) => string[][] | null): { ops: RowOp[]; matched: Array<[number, number]> } | null {
  const ops: RowOp[] = [], matched: Array<[number, number]> = []
  for (const [o, e] of pairs) {
    if (o !== null && e !== null) { ops.push({ kind: "keep", o }); matched.push([o, e]) }
    else if (o !== null) ops.push({ kind: "del", o })
    else if (e !== null) {
      const lines = addLines(e)
      if (!lines) return null
      ops.push({ kind: "add", lines })
    }
  }
  return { ops, matched }
}

/**
 * GFM 표 행 더하기·빼기 — origRows·editedRows = GFM 행(칸 글), toPlain = GFM 칸 → 평문(못 다루는 서식이면 null).
 * 병합 없는 표(GFM 으로 나온 표)만. 이 경로로 못 하면 null(호출자가 건너뜀)
 */
export function stageTableRows(
  scan: SectionScan5, table: ScanTable5, origRows: string[][], editedRows: string[][], toPlain: (md: string) => string | null,
): RowsResult | null {
  if (origRows.length !== table.rows || origRows.some(r => r.length !== table.cols) || editedRows.some(r => r.length !== table.cols)) return null
  const key = (r: string[]) => r.join("\u0001")
  const plan = rowOpsFromPairs(alignUnits(origRows.map(key), editedRows.map(key)), e => {
    const lines = editedRows[e].map(c => c.split(/<br\s*\/?>/i).map(l => toPlain(l)))
    return lines.some(ls => ls.some(l => l === null)) ? null : lines as string[][]
  })
  if (!plan) return null
  const applied = stageRowOps(scan, table, plan.ops)
  return applied === null ? null : { applied, pairs: plan.matched }
}
