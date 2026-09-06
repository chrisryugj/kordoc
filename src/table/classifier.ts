/**
 * 표 분류기 (#76) — IRTable 이 "데이터 표"인지 "표를 레이아웃 캔버스로 쓴 것"(조직도·비상연락망·체계도)인지 휴리스틱 판정.
 *
 * 신호는 두 축. 의미 신호: 반복 행 스키마·격자 규칙성·활성 밀도·열 타입 일관성. 비표 신호: 병합 불규칙·빈 띠(행/열)·
 * 극단적 희소·중첩 구조 래퍼. 도표 문맥 키워드(조직도 등)는 구조 증거가 있을 때만 가산한다 — "조직도" 한 단어가 정상 표를
 * 도표로 바꾸면 안 된다. LLM·네트워크 없음. confidence 는 확률이 아니라 두 점수의 격차.
 */

import type { IRBlock, IRCell, IRTable, TableClassificationReason, TableClassificationSummary } from "../types.js"

export interface ClassifyContext {
  /** 표 앞뒤 문단·캡션 텍스트 — 도표 문맥 키워드 판정용 */
  nearbyText?: string[]
}

/** 도표 문맥 키워드 — 구조 증거(nonTabular ≥ KEYWORD_GATE)가 있을 때만 가산 */
const DIAGRAM_KEYWORDS = /조직도|비상\s*연락망|연락망|체계도|업무\s*체계도|기구표|배치도|흐름도|추진\s*체계/u
const KEYWORD_GATE = 0.3

type CellType = "empty" | "number" | "date" | "short" | "long"

function cellType(cell: IRCell): CellType {
  const t = cell.text.trim()
  if (!t && !cell.blocks?.length) return "empty"
  if (!t) return "short"
  if (/^[-+]?[\d,]+(\.\d+)?\s*(%|원|명|건|개|천원|백만원|㎡|㎢|kg|km|시간|일)?$/u.test(t)) return "number"
  if (/^\d{2,4}[.\-/년]\s*\d{1,2}[.\-/월]?(\s*\d{1,2}[.일]?)?\.?$/u.test(t)) return "date"
  return [...t].length <= 12 ? "short" : "long"
}

interface Anchor { r: number; c: number; cell: IRCell; type: CellType }

/** 병합 커버 칸을 제외한 앵커 셀 목록 */
function anchors(table: IRTable): Anchor[] {
  const out: Anchor[] = []
  const covered = new Set<string>()
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(`${r},${c}`)) continue
      const cell = table.cells[r]?.[c]
      if (!cell) continue
      for (let dr = 0; dr < cell.rowSpan; dr++) for (let dc = 0; dc < cell.colSpan; dc++) if (dr || dc) covered.add(`${r + dr},${c + dc}`)
      out.push({ r, c, cell, type: cellType(cell) })
    }
  }
  return out
}

function isWrapper(table: IRTable): boolean {
  if (table.rows !== 1 || table.cols !== 1) return false
  const cell = table.cells[0]?.[0]
  return !!cell?.blocks?.some(b => b.type === "table" && b.table)
}

function round2(v: number): number { return Math.round(v * 100) / 100 }

export function classifyTable(table: IRTable, ctx: ClassifyContext = {}): TableClassificationSummary {
  const reasons: TableClassificationReason[] = []
  const done = (kind: TableClassificationSummary["kind"], semantic: number, nonTabular: number): TableClassificationSummary =>
    ({ kind, confidence: round2(Math.min(1, Math.abs(semantic - nonTabular))), semanticScore: round2(semantic), nonTabularScore: round2(nonTabular), reasons })

  // 1×1 래퍼(중첩표 포함) — 구조 래퍼 관행 유지. 평문 1×1 은 근거 부족 → uncertain
  if (isWrapper(table)) { reasons.push("nested-structure-wrapper"); return done("non-tabular-layout", 0.05, 0.85) }
  const slots = table.rows * table.cols
  const A = anchors(table)
  if (slots <= 4 || A.length <= 2) { reasons.push("low-evidence"); return done("uncertain", 0.2, 0.2) }

  // ── 신호 ──
  const activeSlots = A.filter(a => a.type !== "empty").reduce((s, a) => s + a.cell.colSpan * a.cell.rowSpan, 0)
  const activeRatio = activeSlots / slots
  const rowHasContent = Array.from({ length: table.rows }, () => false), colHasContent = Array.from({ length: table.cols }, () => false)
  for (const a of A) if (a.type !== "empty") { for (let dr = 0; dr < a.cell.rowSpan; dr++) rowHasContent[a.r + dr] = true; for (let dc = 0; dc < a.cell.colSpan; dc++) colHasContent[a.c + dc] = true }
  const spacerRows = rowHasContent.filter(x => !x).length, spacerCols = colHasContent.filter(x => !x).length
  const spacerBands = (spacerRows + spacerCols) / (table.rows + table.cols)
  // 병합 불규칙 — 헤더 행(0)의 가로 병합은 정상 관행이라 제외. 본문 앵커 중 병합 셀 비율 + 행별 앵커 수 편차
  const body = A.filter(a => a.r > 0)
  const bodyMerged = body.filter(a => a.cell.colSpan > 1 || a.cell.rowSpan > 1).length
  const anchorsPerRow = new Map<number, number>()
  for (const a of A) anchorsPerRow.set(a.r, (anchorsPerRow.get(a.r) ?? 0) + 1)
  const counts = [...anchorsPerRow.values()]
  const meanCnt = counts.reduce((s, v) => s + v, 0) / Math.max(1, counts.length)
  const rowVariance = counts.length > 1 ? counts.reduce((s, v) => s + Math.abs(v - meanCnt), 0) / counts.length / Math.max(1, meanCnt) : 0
  const spanIrregularity = Math.min(1, (body.length ? bodyMerged / body.length : 0) * 0.7 + Math.min(1, rowVariance) * 0.6)
  // 격자 규칙성 — 1×1 앵커 비율(헤더 가로 병합 허용)
  const gridRegularity = A.length ? A.filter(a => (a.cell.colSpan === 1 && a.cell.rowSpan === 1) || (a.r === 0 && a.cell.rowSpan === 1)).length / A.length : 0
  // 반복 행 스키마 — 내용이 있는 본문 행(1..) 의 "채워진 칸 위치+타입" 서명 최빈 비율 (3행 미만은 0).
  // 빈 행끼리는 서명이 같아 보이므로 제외 — 조직도의 빈 띠가 반복 스키마로 잡히지 않게
  let repeatedRowSchema = 0
  if (table.rows >= 3) {
    const sigs = new Map<string, number>()
    let n = 0
    for (let r = 1; r < table.rows; r++) {
      const rowA = A.filter(a => a.r === r && a.type !== "empty")
      if (!rowA.length) continue
      const sig = rowA.map(a => `${a.c}:${a.type === "long" ? "short" : a.type}`).join("|")
      sigs.set(sig, (sigs.get(sig) ?? 0) + 1); n++
    }
    repeatedRowSchema = n ? Math.max(...sigs.values()) / n : 0
    if (n < 2) repeatedRowSchema *= 0.5
  }
  // 열 타입 일관성 — 열마다 본문 비어있지 않은 셀의 지배 타입 비율 평균
  let columnTypeConsistency = 0
  {
    const cols: number[] = []
    for (let c = 0; c < table.cols; c++) {
      const types = A.filter(a => a.r > 0 && a.c === c && a.cell.colSpan === 1 && a.type !== "empty").map(a => a.type)
      if (types.length < 2) continue
      const freq = new Map<string, number>()
      for (const t of types) freq.set(t, (freq.get(t) ?? 0) + 1)
      cols.push(Math.max(...freq.values()) / types.length)
    }
    columnTypeConsistency = cols.length ? cols.reduce((s, v) => s + v, 0) / cols.length : 0
  }
  const sparsity = Math.max(0, (0.6 - activeRatio) / 0.6) // 활성 60% 이상이면 0, 0% 면 1

  // ── 점수 ── 의미 점수는 빈 칸 비율·빈 띠·병합 불규칙으로 감쇠한다 — 규칙적 "빈 격자"가 데이터표로 읽히지 않게
  const emptyShare = 1 - activeRatio
  let semantic = (0.35 * repeatedRowSchema + 0.25 * gridRegularity + 0.2 * Math.min(1, activeRatio / 0.7) + 0.2 * columnTypeConsistency)
    * (1 - 0.6 * Math.max(0, emptyShare - 0.2) / 0.8) * (1 - spacerBands) * (1 - 0.5 * spanIrregularity)
  let nonTabular = 0.6 * spanIrregularity + 0.4 * spacerBands + 0.5 * sparsity
  // 중첩 구조 래퍼(셀 대부분이 중첩표) 는 비표 쪽
  const nestedCells = A.filter(a => a.cell.blocks?.some(b => b.type === "table" && b.table)).length
  if (nestedCells && nestedCells >= A.length * 0.5) { nonTabular += 0.25; reasons.push("nested-structure-wrapper") }

  if (repeatedRowSchema >= 0.6) reasons.push("repeated-row-schema")
  if (gridRegularity >= 0.9) reasons.push("grid-regularity")
  if (activeRatio >= 0.7) reasons.push("high-active-density")
  if (columnTypeConsistency >= 0.75) reasons.push("column-type-consistency")
  if (spanIrregularity >= 0.35) reasons.push("span-irregularity")
  if (spacerBands >= 0.25) reasons.push("spacer-bands")
  if (sparsity >= 0.5) reasons.push("extreme-sparsity")

  // 도표 키워드 — 구조 증거가 있을 때만 가산
  const text = [table.caption ?? "", ...(ctx.nearbyText ?? [])].join("\n")
  if (DIAGRAM_KEYWORDS.test(text) && nonTabular >= KEYWORD_GATE) { nonTabular += 0.15; reasons.push("diagram-context-keyword") }

  semantic = Math.min(1, semantic); nonTabular = Math.min(1, nonTabular)
  if (semantic >= 0.55 && semantic - nonTabular >= 0.2) return done("semantic-table", semantic, nonTabular)
  if (nonTabular >= 0.45 && nonTabular - semantic >= 0.15) return done("non-tabular-layout", semantic, nonTabular)
  reasons.push(Math.max(semantic, nonTabular) < 0.35 ? "low-evidence" : "ambiguous-scores")
  return done("uncertain", semantic, nonTabular)
}

/** 셀 안 블록에서 표 블록 재귀 수집 (문서 순서) — analyze·visual 이 공유 */
export function collectTableBlocks(blocks: IRBlock[], out: IRBlock[] = []): IRBlock[] {
  for (const b of blocks) {
    if (b.type === "table" && b.table) {
      out.push(b)
      for (const row of b.table.cells) for (const cell of row) if (cell.blocks) collectTableBlocks(cell.blocks, out)
      if (b.table.captionBlocks) collectTableBlocks(b.table.captionBlocks, out)
    }
    if (b.children) collectTableBlocks(b.children, out)
  }
  return out
}
