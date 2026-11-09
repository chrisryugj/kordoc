/**
 * OCR 표 속 산문 행 — 스캔 강의 자료처럼 도표 그림과 그 아래 문단이 한 쪽에 섞이면 군집 표 검출이 그림 조각부터 문단 줄까지
 * 한 표로 묶어 문장 줄("특정상황에 적합한 리더 유형을 결정하기 위해서는 …")이 표 폭 전체를 덮는 칸 하나짜리 행이 된다.
 * 표 폭 전체를 덮는 칸 하나짜리 행이 이어진 묶음에 긴 문장(25자 이상·한글 12자 이상·띄어쓰기 있음)이 하나라도 있으면
 * 그 묶음 행들을 문단으로 꺼내고 위·아래 행은 따로 표로 둔다. 표 맨 끝 "※"·"*" 각주 행 묶음과, 행 병합 칸이 끊는 자리를 가로지르는 표는 그대로 둔다(OCR 전용)
 */
import type { IRBlock, IRCell, IRTable } from "../types.js"

const isProse = (s: string) => s.length >= 25 && (s.match(/[가-힣]/g) ?? []).length >= 12 && /\S\s+\S/.test(s)

function splitTable(b: IRBlock): IRBlock[] {
  const t = b.table!
  if (t.rows < 3 || t.cols < 2 || t.cells.length !== t.rows) return [b]
  // 행마다 앞 행 병합에 덮인 칸과 그 행 머리 칸들
  const covered = Array.from({ length: t.rows }, () => new Set<number>())
  const heads: Array<Array<{ c: number; cell: IRCell }>> = Array.from({ length: t.rows }, () => [])
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < (t.cells[r] ?? []).length; c++) {
    if (covered[r].has(c)) continue
    const cell = t.cells[r][c]
    const rs = Math.max(1, cell.rowSpan ?? 1), cs = Math.max(1, cell.colSpan ?? 1)
    for (let i = r; i < Math.min(t.rows, r + rs); i++) for (let j = c; j < c + cs; j++) if (i !== r || j !== c) covered[i].add(j)
    heads[r].push({ c, cell })
  }
  const fullRow = (r: number) => {
    const h = heads[r].filter(x => x.cell.text.trim() || x.cell.blocks?.length)
    return h.length === 1 && heads[r].length === 1 && (h[0].cell.colSpan ?? 1) >= t.cols && (h[0].cell.rowSpan ?? 1) === 1 && !h[0].cell.blocks?.length
  }
  // 칸 하나짜리 전폭 행 묶음 가운데 긴 문장이 든 것
  const prose = new Set<number>()
  for (let r = 0; r < t.rows;) {
    if (!fullRow(r)) { r++; continue }
    let e = r
    while (e + 1 < t.rows && fullRow(e + 1)) e++
    const texts = Array.from({ length: e - r + 1 }, (_, k) => heads[r + k][0].cell.text.trim())
    // 표 맨 끝 "※"·"*" 각주 행 묶음은 원본 표의 마지막 병합 칸(시험 조건 안내, 신분증 표 "* 단, 체류자격 변경 …")이다 — 표에 둔다
    const trailingNote = e === t.rows - 1 && texts.every(s => /^(?:※|\*{1,3}(?!\*))/.test(s))
    if (!trailingNote && texts.some(isProse)) for (let k = r; k <= e; k++) prose.add(k)
    r = e + 1
  }
  if (!prose.size) return [b]
  // 끊는 자리를 병합 칸이 가로지르면 그대로 둔다
  for (let r = 0; r < t.rows; r++) for (const { cell } of heads[r]) {
    const end = r + Math.max(1, cell.rowSpan ?? 1) - 1
    for (let k = r + 1; k <= end; k++) if (prose.has(k) !== prose.has(r)) return [b]
  }
  const out: IRBlock[] = []
  let seg: number[] = []
  const flush = () => {
    if (!seg.length) return
    const rows = seg.map(r => t.cells[r])
    const sub: IRTable = { ...t, rows: rows.length, cells: rows }
    out.push({ ...b, table: sub })
    seg = []
  }
  for (let r = 0; r < t.rows; r++) {
    if (!prose.has(r)) { seg.push(r); continue }
    flush()
    out.push({ type: "paragraph", text: heads[r][0].cell.text.trim(), pageNumber: b.pageNumber, ...(b.bbox ? { bbox: b.bbox } : {}) })
  }
  flush()
  return out
}

/** OCR 블록의 표마다 산문 행 묶음을 문단으로 꺼낸다 */
export function splitOcrProseRows(blocks: IRBlock[]): IRBlock[] {
  return blocks.flatMap(b => b.type === "table" && b.table ? splitTable(b) : [b])
}
