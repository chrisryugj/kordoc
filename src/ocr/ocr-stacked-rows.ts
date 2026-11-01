/**
 * OCR 표의 쌓인 행 가르기 — 행 사이에 괘선 없이 빈 틈만 둔 통계표(통계청 보도자료 "성·연령별 사망률")는 칸 경계가 행을 가르지 못해
 * 여러 행 숫자가 한 칸에 줄바꿈으로 쌓인다("3.1\n0.1\n0.2"). 한 행에서 숫자 꼴 칸 여럿이 같은 줄 수 k(≥2)로 쌓였으면 그 행을
 * k 행으로 나누고 줄마다 한 행에 넣는다. 한 줄뿐인 칸(행 이름표)은 첫 행에 두고 k 행에 걸친다. 글이 꺾인 칸(줄이 길고 숫자가 아님)이
 * 섞이면 가르지 않는다. 텍스트층 표는 칸 클립·글줄로 행이 이미 갈려 이 처리를 타지 않는다(OCR 전용)
 */
import type { IRBlock, IRCell, IRTable } from "../types.js"

const NUMERIC = /^[-+−△▲▽▼]?[\d.,]+[%p]?$|^[-–—·∼~]$|^\([-+−△▲▽▼]?[\d.,]+\)$/

const blank = (): IRCell => ({ text: "", colSpan: 1, rowSpan: 1 })

/** 행 r 의 칸 자리마다 [앵커 열, 앵커 칸] — 위 행에서 내려온 rowSpan 이 걸치면 null */
function rowAnchors(t: IRTable, r: number, coveredFromAbove: boolean[]): Array<{ c: number; cell: IRCell }> | null {
  if (coveredFromAbove.some(Boolean)) return null
  const out: Array<{ c: number; cell: IRCell }> = []
  const row = t.cells[r] ?? []
  for (let c = 0; c < row.length;) {
    const cell = row[c]
    if ((cell.rowSpan ?? 1) > 1) return null
    out.push({ c, cell })
    c += Math.max(1, cell.colSpan ?? 1)
  }
  return out
}

function splitTable(t: IRTable): boolean {
  let changed = false
  // 위 행 rowSpan 이 덮는 자리
  const cover: boolean[][] = Array.from({ length: t.rows }, () => Array(t.cols).fill(false))
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < (t.cells[r] ?? []).length; c++) {
    const cell = t.cells[r][c], rs = Math.max(1, cell.rowSpan ?? 1), cs = Math.max(1, cell.colSpan ?? 1)
    if (cover[r][c]) continue
    for (let i = r + 1; i < Math.min(t.rows, r + rs); i++) for (let j = c; j < Math.min(t.cols, c + cs); j++) cover[i][j] = true
    // 같은 행 colSpan 이 덮는 자리는 rowAnchors 가 건너뛴다
  }
  const newRows: IRCell[][] = []
  for (let r = 0; r < t.rows; r++) {
    const row = t.cells[r] ?? []
    const anchors = rowAnchors(t, r, cover[r])
    const lines = anchors?.map(a => a.cell.text.split("\n").map(s => s.trim()).filter(Boolean)) ?? []
    const counts = new Map<number, number>()
    for (const ls of lines) if (ls.length >= 2) counts.set(ls.length, (counts.get(ls.length) ?? 0) + 1)
    const [k, n] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
    const nonEmpty = lines.filter(ls => ls.length).length
    // 이웃 열 숫자가 한 검출 상자로 붙은 칸은 줄이 한둘 모자란다 — 다수 줄 수의 80% 이상이면 같은 쌓임으로 보고 모자란 줄은 아래를 비운다
    const near = (ls: string[]) => ls.length >= 2 && ls.length <= k && ls.length >= Math.ceil(k * 0.8)
    const stacked = lines.filter(near)
    const flat = stacked.flat()
    const numericShare = flat.length ? flat.filter(s => NUMERIC.test(s.replace(/\s+/g, ""))).length / flat.length : 0
    const ok = anchors && k >= 2 && n >= 2 && stacked.length * 2 >= nonEmpty && lines.every(ls => ls.length <= 1 || near(ls)) && numericShare >= 0.6
    if (!ok) { newRows.push(row); continue }
    const sub: IRCell[][] = Array.from({ length: k }, () => Array.from({ length: row.length }, blank))
    anchors!.forEach(({ c, cell }, idx) => {
      const ls = lines[idx], cs = Math.max(1, cell.colSpan ?? 1)
      if (ls.length >= 2) for (let i = 0; i < k; i++) sub[i][c] = { ...cell, text: ls[i] ?? "", colSpan: cs, rowSpan: 1 }
      else sub[0][c] = { ...cell, rowSpan: k }
    })
    newRows.push(...sub)
    changed = true
  }
  if (changed) { t.cells = newRows; t.rows = newRows.length }
  return changed
}

/** OCR 블록의 표마다 쌓인 행을 가른다(제자리) */
export function splitStackedOcrRows(blocks: IRBlock[]): IRBlock[] {
  for (const b of blocks) if (b.type === "table" && b.table) splitTable(b.table)
  return blocks
}
