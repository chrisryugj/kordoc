/**
 * 라운드트립 표 행 추가/삭제 (HWPX 전용, v3.7).
 *
 * 편집된 마크다운의 표 행 수가 원본과 다를 때, alignUnits로 행을 정렬해
 * 삽입/삭제/수정을 구분하고 <hp:tr> 단위 splice로 반영한다.
 * 행 추가 = 인접 행 <hp:tr> 복제 → 셀 텍스트 교체 → rowAddr 재계산,
 * 행 삭제 = <hp:tr> 제거. 양쪽 모두 rowCnt·이후 행 rowAddr·표 sz height를 갱신한다.
 *
 * 보수적 게이트(전부 통과해야 행 연산 수행, 실패 시 표 전체 skip):
 * 세로 병합(rowSpan)이 변경 지점을 가로지르면 미지원, 삭제/템플릿 행에
 * 개체(중첩표·이미지·수식·필드)가 있으면 미지원, 셀 주소 표기 혼재 미지원.
 */

import type { IRTable } from "../types.js"
import {
  scanSectionXml, buildParagraphSplices, applySplices, allLinesegRemovalSplices,
  type ScanTable, type ScanCell, type SpliceEdit,
} from "./source-map.js"
import { alignUnits, sanitizeText, summarize } from "./markdown-units.js"
import type { TablePatchCtx } from "./table-patch.js"
import type { BorderVariants } from "./border-variants.js"

/** 삽입될 행의 셀 하나 — 마크다운에서 추출한 평문 라인들과 병합 시그니처 */
export interface InsertCell {
  lines: string[]
  colSpan: number
  rowSpan: number
}

export interface RowOpsInput {
  table: IRTable
  scanTable: ScanTable
  ctx: TablePatchCtx
  skip: (reason: string) => number
  /** 원본 마크다운 행 직렬화 키 (격자 행과 1:1 — 호출자가 보장) */
  origKeys: string[]
  /** 편집 마크다운 행 직렬화 키 */
  editedKeys: string[]
  /** 편집 행 ei의 셀 콘텐츠 (셀 순서). null = 삽입 불가 콘텐츠(이미지/중첩표 포함) */
  editedCells: (ei: number) => InsertCell[] | null
  /** 정렬된 행 쌍의 셀 단위 패치 (기존 경로 재사용) — 적용 건수 반환 */
  patchMatched: (oi: number, ei: number) => number
}

/** 행에 복제/삭제 불가능한 개체가 있는지 — 중첩표·그림·수식·글상자·필드·ctrl */
const ROW_OBJECT_RE = /<(?:[A-Za-z0-9_]+:)?(?:tbl|pic|equation|ole|container|shape|drawingObject|drawText|video|chart|fieldBegin|fieldEnd|ctrl)\b/

/** 태그 하나를 quote-aware로 읽는 sticky 정규식 (속성 값 내 '>' 안전) */
const TAG_AT_RE = /<[A-Za-z0-9_:]+(?:"[^"]*"|'[^']*'|[^>"'])*>/y

interface SeqEntry {
  kind: "keep" | "del" | "ins"
  oi?: number
  ei?: number
  /** ins 전용: 원본 격자 기준 삽입 위치 (이 인덱스의 행 앞) */
  insertAt?: number
}

/**
 * 표 행 추가/삭제 수행 — 게이트 전체 통과 시에만 splice를 기록한다.
 * 반환: 적용 건수 (행 연산 + 매칭 행 셀 패치 합).
 */
export function patchTableRows(input: RowOpsInput): number {
  const { table, scanTable, ctx, skip, origKeys, editedKeys } = input
  const xml = ctx.scans[scanTable.sectionIndex]?.xml
  if (!xml) return skip("섹션 XML 매핑 실패")

  // ── 구조 게이트: 격자 행 ↔ 마크다운 행 ↔ <hp:tr> 1:1 정렬 ──
  const numRows = table.rows
  if (origKeys.length !== numRows) return skip("표 행 좌표 불일치 — 행 추가/삭제 미지원")
  if (scanTable.rows.length !== numRows || scanTable.rowRanges.length !== numRows) {
    return skip("표 행 구조 좌표 불일치 (빈 행/병합 소실) — 행 추가/삭제 미지원")
  }
  for (let r = 0; r < numRows; r++) {
    if (scanTable.rows[r].some(c => c.rowAddr !== r)) {
      return skip("행 주소 비연속 — 행 추가/삭제 미지원")
    }
  }

  // 셀 주소 표기 all-or-none — 혼재하면 한컴 해석이 불명확
  const allCells = scanTable.rows.flat()
  const explicitAddr = (c: ScanCell) =>
    !!c.addrTagRange && /\browAddr\s*=\s*"/.test(xml.slice(c.addrTagRange.start, c.addrTagRange.end))
  const explicitCount = allCells.filter(explicitAddr).length
  if (explicitCount !== 0 && explicitCount !== allCells.length) {
    return skip("셀 주소(cellAddr) 표기 혼재 — 행 추가/삭제 미지원")
  }
  const hasExplicitAddr = explicitCount > 0

  // ── 행 정렬 → 연산 시퀀스 ──
  const pairs = pairChangedRuns(alignUnits(origKeys, editedKeys))
  const seq: SeqEntry[] = []
  let lastOrig = -1
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) { seq.push({ kind: "keep", oi, ei }); lastOrig = oi }
    else if (oi !== null) { seq.push({ kind: "del", oi }); lastOrig = oi }
    else if (ei !== null) seq.push({ kind: "ins", ei, insertAt: lastOrig + 1 })
  }
  const dels = seq.filter(e => e.kind === "del")
  const inss = seq.filter(e => e.kind === "ins")
  const keeps = seq.filter(e => e.kind === "keep")
  if (dels.length === 0 && inss.length === 0) {
    // 행 수가 달랐는데 정렬 결과 연산이 없을 수는 없음 — 방어
    return skip("표 행 정렬 실패 — 행 추가/삭제 미지원")
  }
  if (keeps.length + inss.length === 0) return skip("모든 행 삭제는 미지원")
  if (keeps.length === 0) return skip("행 전면 교체 — 서식 기준 행이 없어 미지원")

  // ── rowSpan 교차 게이트 ──
  const spans = allCells.filter(c => (c.rowSpan ?? 1) > 1)
  for (const d of dels) {
    if (spans.some(s => s.rowAddr! <= d.oi! && s.rowAddr! + s.rowSpan > d.oi!)) {
      return skip(`표 ${d.oi! + 1}행 삭제가 세로 병합과 겹침 — 미지원`)
    }
  }
  for (const ins of inss) {
    const p = ins.insertAt!
    if (spans.some(s => s.rowAddr! < p && s.rowAddr! + s.rowSpan > p)) {
      return skip("행 삽입 위치가 세로 병합 내부 — 미지원")
    }
  }

  // ── 삭제 행 게이트: 개체 포함 금지 ──
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi!]
    if (ROW_OBJECT_RE.test(xml.slice(rr.start, rr.end))) {
      return skip(`표 ${d.oi! + 1}행에 개체(중첩표/이미지/필드) 포함 — 행 삭제 미지원`)
    }
  }

  // ── 삽입 계획: 템플릿 선정 + 콘텐츠/구조 게이트 ──
  const keptSet = new Set(keeps.map(k => k.oi!))
  interface InsertPlan { entry: SeqEntry; template: number; cells: InsertCell[] }
  const insertPlans: InsertPlan[] = []
  for (const ins of inss) {
    const p = ins.insertAt!
    const kept = [...keptSet].sort((a, b) => a - b)
    let template = -1
    for (const k of kept) { if (k < p) template = k }
    // 헤더 행(0)은 데이터 행 서식이 아님 — 위 삽입이 아니면 다음 유지 행을 우선
    if (template <= 0 && p >= 1) {
      const following = kept.find(k => k >= 1)
      if (following !== undefined) template = following
    }
    if (template < 0) template = kept[0]

    const cells = input.editedCells(ins.ei!)
    if (!cells) return skip("삽입 행에 이미지/중첩표 포함 — 행 추가 미지원")
    for (const cell of cells) {
      const unstable = cell.lines.find(l => sanitizeText(l) !== l)
      if (unstable !== undefined) return skip("삽입 행에 공백 정규화 불안정 텍스트 — 미지원")
    }

    const tmplCells = scanTable.rows[template]
    const rr = scanTable.rowRanges[template]
    if (ROW_OBJECT_RE.test(xml.slice(rr.start, rr.end))) {
      return skip("서식 기준 행에 개체(중첩표/이미지/필드) 포함 — 행 추가 미지원")
    }
    if (tmplCells.some(c => c.rowSpan > 1)) return skip("서식 기준 행에 세로 병합 — 행 추가 미지원")
    const tmplWidth = tmplCells.reduce((s, c) => s + c.colSpan, 0)
    if (tmplWidth !== table.cols) return skip("서식 기준 행이 격자 전체를 덮지 않음 — 행 추가 미지원")
    if (cells.length !== tmplCells.length) {
      return skip(`삽입 행 셀 수(${cells.length}) ≠ 기준 행 셀 수(${tmplCells.length}) — 미지원`)
    }
    for (let i = 0; i < cells.length; i++) {
      if (cells[i].rowSpan !== 1 || cells[i].colSpan !== tmplCells[i].colSpan) {
        return skip("삽입 행 병합 구조가 기준 행과 다름 — 미지원")
      }
    }
    insertPlans.push({ entry: ins, template, cells })
  }

  // ── rowCnt 재작성 준비 (필수 — 없으면 구조 불신) ──
  const net = inss.length - dels.length
  TAG_AT_RE.lastIndex = scanTable.start
  const tblOpen = TAG_AT_RE.exec(xml)
  if (!tblOpen || tblOpen.index !== scanTable.start) return skip("표 여는 태그 해석 실패")
  const rowCntM = tblOpen[0].match(/\browCnt\s*=\s*"(\d+)"/)
  if (!rowCntM || rowCntM.index === undefined) return skip("표 rowCnt 속성 없음 — 행 추가/삭제 미지원")
  if (parseInt(rowCntM[1], 10) !== numRows) return skip("rowCnt와 실제 행 수 불일치 — 행 추가/삭제 미지원")

  // ── 최종 행 인덱스 계산 ──
  const finalIndex = new Map<SeqEntry, number>()
  {
    let fi = 0
    for (const e of seq) { if (e.kind !== "del") finalIndex.set(e, fi++) }
  }

  // ── 여기서부터 splice 기록 (게이트 전체 통과) ──
  const splices: SpliceEdit[] = []
  let applied = 0

  // 삭제
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi!]
    splices.push({ start: rr.start, end: rr.end, replacement: "" })
    applied++
  }

  // 삽입 — 같은 앵커의 연속 삽입은 시퀀스 순서로 이어붙여 한 splice로
  const fragmentsByAnchor = new Map<number, string[]>()
  let heightDelta = 0
  const lastFinal = numRows + net - 1
  const borders = ctx.borders ? rowBorders(xml, scanTable, ctx.borders) : null
  for (const plan of insertPlans) {
    const finalRow = finalIndex.get(plan.entry)!
    let fragment = buildRowFragment(xml, scanTable, plan.template, plan.cells, finalRow, hasExplicitAddr, ctx)
    if (fragment === null) return skip("행 복제 실패 (셀 문단 구조 미지원)")
    if (borders) fragment = borders.inserted(fragment, plan.template, finalRow === lastFinal)
    const p = plan.entry.insertAt!
    const anchor = p === 0 ? scanTable.rowRanges[0].start : scanTable.rowRanges[p - 1].end
    let list = fragmentsByAnchor.get(anchor)
    if (!list) fragmentsByAnchor.set(anchor, (list = []))
    list.push(fragment)
    heightDelta += rowHeightOf(fragment)
    applied++
  }
  for (const [anchor, fragments] of fragmentsByAnchor) {
    splices.push({ start: anchor, end: anchor, replacement: fragments.join("") })
  }
  for (const d of dels) {
    const rr = scanTable.rowRanges[d.oi!]
    heightDelta -= rowHeightOf(xml.slice(rr.start, rr.end))
  }

  // 원래 마지막 행 뒤에 행이 붙으면 그 행 아랫변(표 바깥선)은 안쪽 선이 된다 — 바깥선은 새 마지막 행이 가져갔다
  const origLast = keeps.find(k => k.oi === numRows - 1)
  if (borders && origLast && finalIndex.get(origLast) !== lastFinal) splices.push(...borders.unlast(numRows - 1))

  // 유지 행 rowAddr 재작성 (명시 주소일 때만 — 미표기 표는 tr 순서가 곧 격자)
  if (hasExplicitAddr) {
    for (const k of keeps) {
      const fi = finalIndex.get(k)!
      if (fi === k.oi) continue
      for (const cell of scanTable.rows[k.oi!]) {
        const sp = rowAddrRewrite(xml, cell, fi)
        if (sp) splices.push(sp)
      }
    }
  }

  // rowCnt 갱신
  {
    const valStart = scanTable.start + rowCntM.index + rowCntM[0].indexOf('"') + 1
    splices.push({ start: valStart, end: valStart + rowCntM[1].length, replacement: String(numRows + net) })
  }

  // 표 sz height 갱신 (선택적 — 못 찾으면 뷰어 재계산에 맡김)
  if (heightDelta !== 0) {
    const sp = tableSzHeightSplice(xml, scanTable, tblOpen[0].length, heightDelta)
    if (sp) splices.push(sp)
  }

  ctx.sectionSplices[scanTable.sectionIndex].push(...splices)

  // 매칭 행 셀 패치 (기존 경로 — 셀 단위 best-effort)
  for (const k of keeps) {
    if (origKeys[k.oi!] !== editedKeys[k.ei!]) applied += input.patchMatched(k.oi!, k.ei!)
  }
  return applied
}

/**
 * 유지 행 사이의 바뀐 구간(삭제·삽입 묶음)을 순서대로 짝지어 행 수정으로 본다 — 남는 삽입은 짝지은 행 뒤에, 남는 삭제는 그대로.
 * 서식의 빈 행에 실적을 넣으면 글이 전부 달라 정렬이 "빈 행 삭제 + 새 행 삽입"을 냈다: 같은 자리에 삭제·삽입 splice 가 겹쳐
 * 패치가 내부 오류로 멈췄고, 겹치지 않아도 새 행 서식을 머리 행에서 복제했다 (#146)
 */
function pairChangedRuns(pairs: Array<[number | null, number | null]>): Array<[number | null, number | null]> {
  const out: Array<[number | null, number | null]> = []
  let dels: number[] = [], inss: number[] = []
  const flush = () => {
    const n = Math.min(dels.length, inss.length)
    for (let i = 0; i < n; i++) out.push([dels[i], inss[i]])
    for (const oi of dels.slice(n)) out.push([oi, null])
    for (const ei of inss.slice(n)) out.push([null, ei])
    dels = []; inss = []
  }
  for (const [oi, ei] of pairs) {
    if (oi !== null && ei !== null) { flush(); out.push([oi, ei]) }
    else if (oi !== null) dels.push(oi)
    else if (ei !== null) inss.push(ei)
  }
  flush()
  return out
}

// ─── 조각 빌더 ───────────────────────────────────────

const FRAG_OPEN = "<hp:tbl>"
const FRAG_CLOSE = "</hp:tbl>"

/**
 * 템플릿 행 <hp:tr>을 복제해 셀 텍스트를 교체한 XML 조각을 만든다.
 * linesegarray는 제거(레이아웃 캐시 — 새 텍스트와 불일치), rowAddr는 최종 인덱스로.
 */
function buildRowFragment(
  xml: string, scanTable: ScanTable, template: number, cells: InsertCell[],
  finalRow: number, hasExplicitAddr: boolean, ctx: TablePatchCtx,
): string | null {
  const rr = scanTable.rowRanges[template]
  const wrapped = FRAG_OPEN + xml.slice(rr.start, rr.end) + FRAG_CLOSE
  const scan = scanSectionXml(wrapped, 0)
  const row = scan.tables[0]?.rows[0]
  if (!row || row.length !== cells.length) return null

  const splices: SpliceEdit[] = allLinesegRemovalSplices(wrapped)
  for (let i = 0; i < cells.length; i++) {
    const paras = row[i].paragraphs
    let lines = cells[i].lines
    if (lines.length > 0 && paras.length === 0) return null
    if (lines.length > paras.length) {
      // 넘치는 줄은 마지막 문단에 병합 (applyCellEdit와 동일한 관행)
      lines = [...lines.slice(0, paras.length - 1), lines.slice(paras.length - 1).join(" ")]
      ctx.skipped.push({ reason: "삽입 행 셀의 줄 수가 문단 수 초과 — 마지막 문단에 병합 적용", after: summarize(cells[i].lines.join(" ")), partial: true })
    }
    for (let p = 0; p < paras.length; p++) {
      const sp = buildParagraphSplices(paras[p], lines[p] ?? "", wrapped)
      if (sp === null) return null
      splices.push(...sp)
    }
    if (hasExplicitAddr) {
      const sp = rowAddrRewrite(wrapped, row[i], finalRow)
      if (sp) splices.push(sp)
    }
  }
  const patched = applySplices(wrapped, splices)
  return patched.slice(FRAG_OPEN.length, patched.length - FRAG_CLOSE.length)
}

/** 셀의 <hp:cellAddr> 태그에서 rowAddr 값만 교체하는 splice */
function rowAddrRewrite(xml: string, cell: ScanCell, newRow: number): SpliceEdit | null {
  if (!cell.addrTagRange) return null
  const tag = xml.slice(cell.addrTagRange.start, cell.addrTagRange.end)
  const m = tag.match(/\browAddr\s*=\s*"(\d+)"/)
  if (!m || m.index === undefined) return null
  if (parseInt(m[1], 10) === newRow) return null
  const valStart = cell.addrTagRange.start + m.index + m[0].indexOf('"') + 1
  return { start: valStart, end: valStart + m[1].length, replacement: String(newRow) }
}

/** tr 조각의 행 높이 — 셀 cellSz height의 최댓값 (없으면 0) */
function rowHeightOf(fragment: string): number {
  let max = 0
  for (const m of fragment.matchAll(/<(?:[A-Za-z0-9_]+:)?cellSz\b(?:"[^"]*"|'[^']*'|[^>"'])*>/g)) {
    const h = m[0].match(/\bheight\s*=\s*"(\d+)"/)
    if (h) max = Math.max(max, parseInt(h[1], 10))
  }
  return max
}

/**
 * 표 자체 <hp:sz>의 height를 delta만큼 조정하는 splice.
 * 첫 tr 앞 구간에서 첫 sz 태그를 찾는다 (스키마상 tbl 첫 자식). 못 찾으면 null.
 */
function tableSzHeightSplice(
  xml: string, scanTable: ScanTable, tblOpenLen: number, delta: number,
): SpliceEdit | null {
  const from = scanTable.start + tblOpenLen
  const to = scanTable.rowRanges[0]?.start ?? from
  const slice = xml.slice(from, to)
  const szM = slice.match(/<(?:[A-Za-z0-9_]+:)?sz\b(?:"[^"]*"|'[^']*'|[^>"'])*>/)
  if (!szM || szM.index === undefined) return null
  const hM = szM[0].match(/\bheight\s*=\s*"(\d+)"/)
  if (!hM || hM.index === undefined) return null
  const oldH = parseInt(hM[1], 10)
  const newH = Math.max(0, oldH + delta)
  const valStart = from + szM.index + hM.index + hM[0].indexOf('"') + 1
  return { start: valStart, end: valStart + hM[1].length, replacement: String(newH) }
}

// ─── 복제 행 테두리 ───────────────────────────────────

const TC_BF_RE = /<hp:tc\b[^>]*?\bborderFillIDRef="(\d+)"/g

/** 행 XML 안 셀 여는 태그의 borderFillIDRef 값 위치 (행 시작 기준) */
function cellBorderRefs(rowXml: string): Array<{ id: number; at: number; len: number }> {
  const out: Array<{ id: number; at: number; len: number }> = []
  for (const m of rowXml.matchAll(TC_BF_RE)) out.push({ id: +m[1], at: m.index! + m[0].length - m[1].length - 1, len: m[1].length })
  return out
}

/**
 * 행 추가 복제 행 테두리 — 새 행은 안쪽 행이라 위·아래 변을 표 안쪽 가로선으로, 표 끝이 되면 아랫변만 원래 마지막 행 아랫변(바깥선)으로.
 * 머리 행 바로 아래 행을 복제하면 윗변 이중선(머리 구분선)이, 마지막 행을 복제하면 아랫변 굵은 바깥선이 행마다 그어졌다.
 * 안쪽 가로선은 셋째 행부터의 윗변 → 견본 행이 마지막 행이 아니면 그 아랫변 → 같은 칸 안쪽 세로선 순으로 찾는다
 */
function rowBorders(xml: string, scanTable: ScanTable, borders: BorderVariants) {
  const rows = scanTable.rowRanges.map(rr => xml.slice(rr.start, rr.end))
  const refs = rows.map(r => (ROW_OBJECT_RE.test(r) ? null : cellBorderRefs(r)))
  const last = rows.length - 1
  const inner = (template: number, ci: number): string | undefined => {
    const n = refs[template]?.length ?? 0
    for (let r = 2; r < rows.length; r++) {
      const id = refs[r]?.length === n ? refs[r]![ci].id : undefined
      const top = id !== undefined ? borders.sides(id)?.top : undefined
      if (top) return top
    }
    const own = borders.sides(refs[template]![ci].id)
    if (!own) return undefined
    if (template < last) return own.bottom
    return n < 2 ? undefined : ci < n - 1 ? own.right : own.left
  }
  return {
    inserted(fragment: string, template: number, isLast: boolean): string {
      const tmpl = refs[template]
      const cells = cellBorderRefs(fragment)
      if (!tmpl || cells.length !== tmpl.length) return fragment
      let out = fragment
      for (let ci = cells.length - 1; ci >= 0; ci--) {
        const h = inner(template, ci)
        if (!h) continue
        const outer = isLast ? (refs[last]?.length === cells.length ? borders.sides(refs[last]![ci].id)?.bottom : undefined) ?? h : h
        const id = borders.variant(cells[ci].id, { top: h, bottom: outer })
        out = out.slice(0, cells[ci].at) + id + out.slice(cells[ci].at + cells[ci].len)
      }
      return out
    },
    unlast(row: number): SpliceEdit[] {
      const own = refs[row]
      if (!own) return []
      const base = scanTable.rowRanges[row].start
      return own.flatMap((c, ci) => {
        const h = inner(row, ci)
        const id = h ? borders.variant(c.id, { bottom: h }) : c.id
        return id === c.id ? [] : [{ start: base + c.at, end: base + c.at + c.len, replacement: String(id) }]
      })
    },
  }
}
