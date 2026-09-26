/**
 * 가로 괘선만 있는 표 (booktabs).
 *
 * 학술지 표는 위·머리 아래·아래에 같은 폭의 가로 괘선만 긋고 세로선을 긋지 않는다(ODL 190 Table 6·7).
 * 선 격자는 세로선이 없어 생기지 않고, 무괘선 경로에서는 쪽의 두 단 판정이 표 한가운데를 거터로 잘라
 * 좌우 반쪽 표가 된다.
 *
 * 같은 폭(끝점 정렬) 가로 괘선이 셋 이상 이어지고, 이웃 괘선 사이 띠마다 글이 괘선 폭 안에서 빈 세로 틈
 * (열 사이)을 두고 놓이면 그 띠들을 한 표로 본다. 열 경계는 몸통 띠 글의 x 투영 틈이고, 행은 몸통 글줄이다.
 * 머리 띠는 한 행이며, 머리 글이 여러 열에 걸치면 병합 칸이다. 산문 줄이 낀 띠는 투영 틈이 없어 표가 아니다.
 * 행 간격이 선 격자의 좌표 병합 허용(8pt)보다 좁은 촘촘한 표도 있어 가상 괘선 대신 표를 바로 만든다.
 * 세로선이 이미 있는 표는 선 격자가 맡는다.
 */

import type { IRBlock, IRCell } from "../types.js"
import type { LineSegment } from "./line-types.js"
import { chainCollinearRules } from "./line-extract.js"
import { cellTextToString } from "./cell-text.js"
import { type NormItem, groupByY } from "./text-line.js"
import { isTableOfContents } from "./table-roles.js"

/** 끝점 정렬 괘선 묶음 허용 오차 (pt) */
const ALIGN_TOL = 3
/** 괘선 폭 밖 글 허용 (pt) */
const EDGE_TOL = 2
/** 최소 괘선 수 — 위·머리 아래·아래 */
const MIN_RULES = 3
/** 최소 괘선 폭 (pt) */
const MIN_WIDTH = 120
/** 열 사이 틈 최소 (글자 크기 배수) — 낱말 사이(0.25~0.35em)보다 넓다 */
const COL_GAP_K = 0.8
/** 두 칸 이상 채운 몸통 행의 최소 비율 */
const MIN_FILLED_ROWS = 0.6
/** 몸통 줄 간격이 행 간격의 이 비율 미만이면 같은 행의 꺾인 줄 */
const WRAP_K = 0.7

type Interval = [number, number]
export interface RuledTable { block: IRBlock; items: NormItem[] }

/** 글 x 구간 합집합을 틈(minGap 이상)에서 끊은 구간들 */
function projectColumns(items: NormItem[], minGap: number): Interval[] {
  const spans = items.map(it => [it.x, it.x + it.w] as Interval).sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const s of spans) {
    const last = out[out.length - 1]
    if (last && s[0] - last[1] < minGap) last[1] = Math.max(last[1], s[1])
    else out.push([s[0], s[1]])
  }
  return out
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const s = [...values].sort((a, b) => a - b)
  return s[s.length >> 1]
}

/** 첫 줄이 몸통 열마다 하나씩 놓인 한 줄 머리행인지 — 여러 단 머리(걸친 묶음 제목)는 괘선 둘로 행을 가를 수 없다 */
function flatHeader(lines: NormItem[][]): boolean {
  const body = lines.slice(1).flat()
  const fs = median(body.map(it => it.fontSize).filter(s => s > 0)) || 10
  const cols = projectColumns(body, fs * COL_GAP_K)
  const head = projectColumns(lines[0], fs * COL_GAP_K)
  return cols.length >= 2 && head.length === cols.length &&
    head.every(h => cols.filter(c => Math.min(c[1], h[1]) - Math.max(c[0], h[0]) > 0).length === 1)
}

/** 띠 글줄들을 한 행(칸마다 글)으로 — 여러 열에 걸친 글은 병합 칸 */
function buildRow(rowItems: NormItem[], bounds: number[], colSpans?: Interval[]): IRCell[] {
  const cols = bounds.length + 1
  const colOf = (x: number) => bounds.filter(b => x > b).length
  const cells: NormItem[][] = Array.from({ length: cols }, () => [])
  const span = new Array<number>(cols).fill(1)
  for (const it of rowItems) {
    let first = colOf(it.x + EDGE_TOL), last = colOf(it.x + it.w - EDGE_TOL)
    // 몸통 열 글 범위를 둘 이상 실제로 덮을 때만 병합 칸 — 좁은 값 열("O") 위의 넓은 머리 글은 중심이 가까운 열 하나
    if (last > first && colSpans) {
      const covered = colSpans.map((c, k) => Math.min(c[1], it.x + it.w) - Math.max(c[0], it.x) > 0 ? k : -1).filter(k => k >= 0)
      if (covered.length <= 1) {
        const cx = it.x + it.w / 2
        first = last = covered[0] ?? colSpans.reduce((best, c, k) => Math.abs((c[0] + c[1]) / 2 - cx) < Math.abs((colSpans[best][0] + colSpans[best][1]) / 2 - cx) ? k : best, 0)
      } else { first = covered[0]; last = covered[covered.length - 1] }
    }
    cells[first].push(it)
    if (last > first) span[first] = Math.max(span[first], last - first + 1)
  }
  const row: IRCell[] = []
  for (let c = 0; c < cols;) {
    const n = Math.min(span[c], cols - c)
    const items = cells.slice(c, c + n).flat()
    row.push({ text: cellTextToString(items.map(it => ({ ...it }))), colSpan: n, rowSpan: 1 })
    for (let k = 1; k < n; k++) row.push({ text: "", colSpan: 1, rowSpan: 1 })
    c += n
  }
  return row
}

/**
 * 가로 괘선 전용 표를 찾아 IR 표 블록과 그 글 아이템을 낸다. 목차(항목 + 쪽번호)는 표가 아니라 뺀다.
 */
export function detectRuledBandTables(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  items: NormItem[],
  pageNum: number,
): RuledTable[] {
  if (horizontals.length < 2) return []
  const groups: LineSegment[][] = []
  for (const rule of chainCollinearRules(horizontals)) {
    if (rule.x2 - rule.x1 < MIN_WIDTH) continue
    const g = groups.find(gr => Math.abs(gr[0].x1 - rule.x1) <= ALIGN_TOL && Math.abs(gr[0].x2 - rule.x2) <= ALIGN_TOL)
    if (g) g.push(rule)
    else groups.push([rule])
  }
  const lines = groupByY([...items].sort((a, b) => b.y - a.y || a.x - b.x))
  const found: RuledTable[] = []
  type Band = { top: number; bottom: number; lines: NormItem[][] }
  const emit = (bands: Band[], x1: number, x2: number) => {
    const top = bands[0].top, bottom = bands[bands.length - 1].bottom
    // 세로선이 안에 있으면 선 격자가, 양끝에 있으면 테두리 상자(문단 테두리 1열 틀)다
    // 머리 상자 좌우변처럼 일부 높이만 덮는 양끝 선은 틀이 아니다
    if (verticals.some(v => v.y1 < top && v.y2 > bottom && (v.x1 > x1 + EDGE_TOL && v.x1 < x2 - EDGE_TOL ||
      Math.abs(v.x1 - x1) <= ALIGN_TOL + EDGE_TOL && Math.min(v.y2, top) - Math.max(v.y1, bottom) > (top - bottom) * 0.5 ||
      Math.abs(v.x1 - x2) <= ALIGN_TOL + EDGE_TOL && Math.min(v.y2, top) - Math.max(v.y1, bottom) > (top - bottom) * 0.5))) return
    const body = bands.slice(1).flatMap(b => b.lines)
    const fs = median(body.flat().map(it => it.fontSize).filter(s => s > 0)) || 10
    const cols = projectColumns(body.flat(), fs * COL_GAP_K)
    if (cols.length < 2) return
    const bounds = cols.slice(1).map((c, i) => (cols[i][1] + c[0]) / 2)
    const rows: IRCell[][] = [buildRow(bands[0].lines.flat(), bounds, cols)]
    for (const band of bands.slice(1)) {
      const pitch = median(band.lines.slice(1).map((l, i) => band.lines[i][0].y - l[0].y)) || Infinity
      const bandRows: NormItem[][] = []
      band.lines.forEach((l, i) => {
        if (i > 0 && band.lines[i - 1][0].y - l[0].y < pitch * WRAP_K) bandRows[bandRows.length - 1].push(...l)
        else bandRows.push([...l])
      })
      for (const r of bandRows) rows.push(buildRow(r, bounds))
    }
    const table = { rows: rows.length, cols: bounds.length + 1, cells: rows, hasHeader: true }
    // 몸통 행 대부분이 두 칸 이상을 채운다 — 한 칸짜리 목록·본문 줄 사이에 점선 리더 줄 몇 개가 낀 머리 상자(회의록 개회식 순서)는 표가 아니다
    const bodyRows = rows.slice(1)
    if (bodyRows.filter(r => r.filter(c => c.text.trim()).length >= 2).length < bodyRows.length * MIN_FILLED_ROWS) return
    if (isTableOfContents(table)) return
    const used = bands.flatMap(b => b.lines.flat())
    found.push({
      block: { type: "table", table, pageNumber: pageNum, bbox: { page: pageNum, x: x1, y: bottom, width: x2 - x1, height: top - bottom } },
      items: used,
    })
  }
  for (const g of groups) {
    if (g.length < 2) continue
    const rules = [...g].sort((a, b) => b.y1 - a.y1)
    const x1 = Math.min(...rules.map(r => r.x1)), x2 = Math.max(...rules.map(r => r.x2))
    let run: Band[] = []
    const flush = () => {
      if (run.length >= 2) emit(run, x1, x2)
      // 위·아래 괘선 둘뿐인 표(머리 아래 선 생략) — 첫 줄을 머리 띠로
      else if (g.length === 2 && run.length === 1 && run[0].lines.length >= 4 && flatHeader(run[0].lines)) {
        const [band] = run, head = band.lines[0]
        const cut = (head[0].y + band.lines[1][0].y + Math.max(...band.lines[1].map(it => it.h || it.fontSize))) / 2
        emit([{ top: band.top, bottom: cut, lines: [head] }, { top: cut, bottom: band.bottom, lines: band.lines.slice(1) }], x1, x2)
      }
      run = []
    }
    let title: Band | null = null
    for (let i = 0; i + 1 < rules.length; i++) {
      const top = rules[i].y1, bottom = rules[i + 1].y1
      const band = lines.filter(l => l[0].y < top && l[0].y > bottom)
      const inside = !band.some(l => l.some(it => it.x < x1 - EDGE_TOL || it.x + it.w > x2 + EDGE_TOL))
      const fs = median(band.flat().map(it => it.fontSize).filter(s => s > 0)) || 10
      if (band.length > 0 && inside && projectColumns(band.flat(), fs * COL_GAP_K).length >= 2) {
        // 표 전체에 걸친 한 칸 제목 띠(2줄 이하)는 머리 띠다 (ODL 132 "Fish species on IUCN Red List")
        if (run.length === 0 && title) run.push(title)
        run.push({ top, bottom, lines: band })
        title = null
      } else {
        flush()
        title = band.length > 0 && band.length <= 2 && inside ? { top, bottom, lines: band } : null
      }
    }
    flush()
  }
  return found
}
