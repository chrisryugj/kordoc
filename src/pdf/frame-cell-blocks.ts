import type { IRBlock, IRTable, BoundingBox } from "../types.js"
import type { TextItem } from "./line-types.js"
import { computeBBox, dominantStyle, groupByY, mergeSuperscriptLines, type NormItem } from "./text-line.js"
import { pushLineParagraphs } from "./paragraph-lines.js"
import { cleanCellText } from "./cell-text.js"
import type { WrapLexicon } from "./line-wrap.js"
import { CELL_EDGES } from "../table/layout-frames.js"
import { CLIP_TABLES, FRAME_TITLE_BLOCKS, TABLE_COLXS } from "./table-meta.js"

/** Native frame bounds survive paragraph reflow and later OCR-region insertion. */
export const FRAME_READING_UNITS = new WeakMap<IRBlock, { blocks: IRBlock[]; bbox: BoundingBox }>()
const FRAME_SOURCE_BOUNDS = new WeakMap<IRBlock, BoundingBox>()
export function recordFrameReadingUnit(blocks: IRBlock[], bbox: BoundingBox): void {
  for (const block of blocks) FRAME_SOURCE_BOUNDS.set(block, bbox)
  if (blocks.length < 2) return
  const unit = { blocks, bbox }
  for (const block of blocks) FRAME_READING_UNITS.set(block, unit)
}

/** Paragraph reflow must not change the occupied rectangles used to detect
 * columns. Each native frame contributes its source bounds once, even when
 * its only paragraph is shorter or it contains several short clauses. */
export function frameLayoutBoxes(blocks: IRBlock[]): BoundingBox[] {
  const boxes: BoundingBox[] = [], seen = new Set<BoundingBox>()
  for (const block of blocks) {
    const frame = FRAME_SOURCE_BOUNDS.get(block)
    if (frame) {
      if (!seen.has(frame)) { boxes.push(frame); seen.add(frame) }
    } else if (block.bbox) boxes.push(block.bbox)
  }
  return boxes
}

/** A frame gutter must not cut a continuous full-width title or prose line.
 * Independent columns retain their larger gap; only touching text runs and
 * their immediately following indented continuation share a paragraph unit. */
export function takeFrameSpanningText(items: NormItem[], cutX: number, pageNum: number, lex?: WrapLexicon): IRBlock[] {
  let minX = Infinity, maxR = -Infinity
  for (const item of items) { minX = Math.min(minX, item.x); maxR = Math.max(maxR, item.x + item.w) }
  const span = maxR - minX
  const rows = groupByY([...items].sort((a, b) => b.y - a.y || a.x - b.x)).map(line => {
    const runs: NormItem[][] = []
    for (const item of [...line].sort((a, b) => a.x - b.x)) {
      const run = runs[runs.length - 1], prev = run?.[run.length - 1]
      if (prev && item.x - (prev.x + prev.w) <= Math.max(prev.fontSize, item.fontSize) * 0.6) run.push(item)
      else runs.push([item])
    }
    return runs
  })
  const taken = new Set<NormItem>(), blocks: IRBlock[] = []
  for (let r = 0; r < rows.length; r++) for (const run of rows[r]) {
    if (taken.has(run[0]) || run[0].x >= cutX || Math.max(...run.map(i => i.x + i.w)) <= cutX) continue
    const lines = [run], fs = Math.max(...run.map(i => i.fontSize))
    const left = run[0].x, right = Math.max(...run.map(i => i.x + i.w))
    if (right - left < span * 0.75) continue
    let prevY = run[0].y
    for (let next = r + 1; next < rows.length && rows[next].length === 1; next++) {
      const tail = rows[next][0], y = tail[0].y
      if (taken.has(tail[0]) || prevY - y > fs * 1.8 || tail[0].x < left - 1 || tail[0].x > left + fs * 2 ||
          tail.some(i => Math.abs(i.fontSize - fs) > fs * 0.15) || Math.max(...tail.map(i => i.x + i.w)) > right + 1) break
      lines.push(tail)
      prevY = y
    }
    for (const line of lines) for (const item of line) taken.add(item)
    pushLineParagraphs(blocks, mergeSuperscriptLines(lines), pageNum, lex)
  }
  let keep = 0
  for (const item of items) if (!taken.has(item)) items[keep++] = item
  items.length = keep
  return blocks
}

/** An XY-Cut unit may not span a full-width paragraph's reading boundary. */
export function frameColumnTextBands(items: NormItem[], spanning: IRBlock[], cutX: number): NormItem[][] {
  const tops = spanning.filter(b => b.bbox).map(b => b.bbox!.y + b.bbox!.height).sort((a, b) => b - a)
  const bands = new Map<number, NormItem[][]>()
  for (const item of items) {
    let band = 0
    while (band < tops.length && tops[band] > item.y + item.h) band++
    const sides = bands.get(band) ?? [[], [], []]
    sides[item.x + item.w <= cutX ? 0 : item.x >= cutX ? 2 : 1].push(item)
    bands.set(band, sides)
  }
  return [...bands].sort((a, b) => a[0] - b[0]).flatMap(([, sides]) => sides.filter(side => side.length))
}

/** Paragraphs share a native one-cell box's reading unit. A larger confirmed
 * flow band takes precedence; never split it to reconstruct a smaller frame. */
export function groupFrameParagraphUnits(units: IRBlock[][], frames: IRBlock[][]): IRBlock[][] {
  const source = new Map<IRBlock, IRBlock[]>()
  for (const unit of units) for (const block of unit) source.set(block, unit)
  const members = new Map<IRBlock, IRBlock[]>(), emitted = new Set<IRBlock[]>()
  for (const frame of frames) {
    if (frame.length < 2 || frame.some(block => block.type !== "paragraph" || source.get(block)?.length !== 1)) continue
    for (const block of frame) members.set(block, frame)
  }
  const out: IRBlock[][] = []
  for (const unit of units) {
    const frame = unit.length === 1 ? members.get(unit[0]) : undefined
    if (!frame) out.push(unit)
    else if (!emitted.has(frame)) { out.push(frame); emitted.add(frame) }
  }
  for (const unit of out) {
    if (unit.length < 2 || FRAME_READING_UNITS.get(unit[0])?.blocks === unit) continue
    const bs = unit.map(b => b.bbox).filter((b): b is BoundingBox => !!b)
    if (bs.length !== unit.length) continue
    const x = Math.min(...bs.map(b => b.x)), y = Math.min(...bs.map(b => b.y))
    recordFrameReadingUnit(unit, { page: bs[0].page, x, y,
      width: Math.max(...bs.map(b => b.x + b.width)) - x, height: Math.max(...bs.map(b => b.y + b.height)) - y })
  }
  return out
}

/** 번호 칩·좁은 빈 간격·한 줄 제목을 가진 무괘선 클립 상자만 문단으로 확인한다. */
export function recordFrameTitle(table: IRTable, source: NormItem[], pageNum: number): void {
  if (!CLIP_TABLES.has(table) || table.rows !== 1 || table.cols !== 3 || source.length < 2) return
  const cells = table.cells[0]
  if (cells.length !== 3 || cells.some(c => c.colSpan !== 1 || c.rowSpan !== 1 || c.blocks?.length || c.text.includes("\n"))) return
  const [label, spacer, title] = cells
  if (!/^(?:붙임|별첨|첨부|부록)\s*\d{1,3}$/.test(label.text.trim()) || spacer.text.trim() || !title.text.trim()) return
  if (cells.some(c => { const e = CELL_EDGES.get(c); return !e || e.t || e.b || e.l || e.r })) return
  const xs = TABLE_COLXS.get(table), style = dominantStyle(source), fs = style?.fontSize ?? 0
  if (!xs || xs.length !== 4 || fs <= 0) return
  const width = xs[3] - xs[0], gap = xs[2] - xs[1]
  if (width < fs * 12 || gap <= 0 || gap > fs * 1.5 || xs[1] - xs[0] > width * 0.25 || xs[3] - xs[2] < width * 0.6) return
  if (source.some(i => i.fontName !== source[0].fontName || Math.abs(i.fontSize - fs) > fs * 0.15)) return
  if (groupByY([...source].sort((a, b) => b.y - a.y)).length !== 1) return
  FRAME_TITLE_BLOCKS.set(table, { type: "paragraph", text: `${label.text.trim()} ${title.text.trim()}`,
    pageNumber: pageNum, bbox: computeBBox(source, pageNum), style })
}

/** 틀 셀 좌표와 같은 부모를 가진 중첩표를 pending 에서 꺼낸다 (제자리 제거) */
export const FRAME_RECT_TOL = 1.5
export function takePendingNested(
  pending: Array<{ parent: { x1: number; y1: number; x2: number; y2: number }; block: IRBlock; contained?: true }>,
  cellBox: { x1: number; y1: number; x2: number; y2: number },
  clipCell: boolean,
): IRBlock[] {
  const out: IRBlock[] = []
  for (let i = pending.length - 1; i >= 0; i--) {
    const p = pending[i].parent
    // 선 격자 중첩표(contained)는 칸이 자기 상자를 품으면 그 칸의 표 — 클립 중첩표는 틀 칸 클립과 같은 사각형일 때만
    if (pending[i].contained
      ? p.x1 >= cellBox.x1 - FRAME_RECT_TOL && p.x2 <= cellBox.x2 + FRAME_RECT_TOL && p.y1 >= cellBox.y1 - FRAME_RECT_TOL && p.y2 <= cellBox.y2 + FRAME_RECT_TOL
      : clipCell && Math.abs(p.x1 - cellBox.x1) <= FRAME_RECT_TOL && Math.abs(p.x2 - cellBox.x2) <= FRAME_RECT_TOL
        && Math.abs(p.y1 - cellBox.y1) <= FRAME_RECT_TOL && Math.abs(p.y2 - cellBox.y2) <= FRAME_RECT_TOL) {
      out.push(pending[i].block)
      pending.splice(i, 1)
    }
  }
  return out
}

/**
 * 틀 셀의 blocks 조립 — 셀 자기 글(문단)과 안쪽 표를 위→아래 순서로 섞는다. 표의 y 띠 위·옆에
 * 있는 글은 표 앞 문단, 아래 글은 다음 덩어리. text 는 blocks 평탄화(하위 호환, IRCell 계약)
 */
export function buildFrameCellBlocks(cellItems: TextItem[], nested: IRBlock[], pageNum: number, lex?: WrapLexicon): { blocks: IRBlock[]; text: string } {
  const tables = [...nested].sort((a, b) => (b.bbox!.y + b.bbox!.height) - (a.bbox!.y + a.bbox!.height))
  // 나란한 표 둘(결재문서 머리: 왼쪽 문서번호 표 · 윗변이 조금 높은 오른쪽 결재 칸)은 왼쪽부터 — 가로로 떨어졌고 세로로 낮은 쪽 높이 절반 넘게 겹칠 때
  for (let i = 0; i + 1 < tables.length; i++) {
    const a = tables[i].bbox!, b = tables[i + 1].bbox!
    if (b.x + b.width > a.x || Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y) < Math.min(a.height, b.height) * 0.5) continue
    ;[tables[i], tables[i + 1]] = [tables[i + 1], tables[i]]
    i++
  }
  const blocks: IRBlock[] = []
  let rest = [...cellItems]
  const pushParagraphs = (items: TextItem[]) => {
    if (items.length === 0) return
    const source: NormItem[] = items.map(it => ({ ...it, isHidden: false }))
      .sort((a, b) => b.y - a.y || a.x - b.x)
    const paragraphs: IRBlock[] = []
    pushLineParagraphs(paragraphs, mergeSuperscriptLines(groupByY(source)), pageNum, lex)
    for (const block of paragraphs) {
      block.text = cleanCellText(block.text ?? "")
      if (block.text) blocks.push(block)
    }
  }
  for (const tb of tables) {
    const bottom = tb.bbox!.y
    pushParagraphs(rest.filter(it => it.y >= bottom))
    rest = rest.filter(it => it.y < bottom)
    blocks.push(tb)
  }
  pushParagraphs(rest)
  const text = blocks
    .map(b => b.type === "table" && b.table ? b.table.cells.flat().map(c => c.text).filter(Boolean).join("\n") : (b.text ?? ""))
    .filter(Boolean)
    .join("\n")
  return { blocks, text }
}
