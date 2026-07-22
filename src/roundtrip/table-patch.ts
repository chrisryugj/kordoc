/**
 * 라운드트립 표 패치 — GFM/HTML/1x1/1열 표의 셀 단위 텍스트 치환
 * + GFM/HTML 표 행 추가/삭제 (v3.7, table-rows.ts).
 *
 * builder.ts 렌더링을 좌표 추적 버전으로 재현(markdown-units.ts)해 편집된 셀의
 * 격자 좌표를 역산하고, 소스맵의 cellAddr 앵커로 XML 셀을 찾아 문단 단위로
 * 치환한다. 재현 결과가 원본 마크다운과 불일치하면 graceful skip.
 * 중첩표 셀은 재귀 패치, 이미지는 변경 불가(텍스트만 적용).
 */

import type { IRTable, PatchSkip } from "../types.js"
import {
  buildParagraphSplices, buildRangeSplices, paraTText,
  type SectionScan, type ScanTable, type SpliceEdit,
} from "./source-map.js"
import {
  normForMatch, sanitizeText, escapeGfm, unescapeGfm, summarize,
  replicateGfmTable, parseGfmTable, unescapeGfmCell,
  replicateHtmlTable, replicateTableToHtml, parseHtmlTable, htmlCellInnerToLines, extractTopLevelTables,
  type MdUnit, type HtmlRowInfo, type MappedCell,
} from "./markdown-units.js"
import { patchTableRows, type InsertCell } from "./table-rows.js"

/** 표 패치에 필요한 컨텍스트 (patcher.ts PatchCtx의 부분집합) */
export interface TablePatchCtx {
  scans: SectionScan[]
  sectionSplices: SpliceEdit[][]
  skipped: PatchSkip[]
}

// ── GFM 표 ──

export function patchGfmTable(
  table: IRTable, scanTable: ScanTable, orig: MdUnit, edited: MdUnit, ctx: TablePatchCtx,
  skip: (reason: string) => number,
): number {
  const replica = replicateGfmTable(table)
  if (!replica) return skip("표 렌더 경로 식별 실패")
  const origRows = parseGfmTable(orig.lines)
  const editedRows = parseGfmTable(edited.lines)

  // 자기 검증 — 재현 결과가 원본 마크다운과 다르면 매핑 신뢰 불가
  if (replica.length !== origRows.length || replica.some((row, r) => row.length !== origRows[r].length || row.some((c, j) => c.text !== origRows[r][j]))) {
    return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
  }
  if (editedRows.length !== origRows.length) {
    return patchGfmTableRows(table, scanTable, origRows, editedRows, replica, ctx, skip)
  }

  let applied = 0
  for (let r = 0; r < origRows.length; r++) {
    applied += patchGfmRowPair(table, scanTable, origRows, editedRows, replica, r, r, ctx, skip)
  }
  return applied
}

/** GFM 행 쌍 하나의 셀 단위 패치 (행 수 동일 경로와 행 연산의 매칭 행 공용) */
function patchGfmRowPair(
  table: IRTable, scanTable: ScanTable, origRows: string[][], editedRows: string[][],
  replica: MappedCell[][], r: number, er: number, ctx: TablePatchCtx,
  skip: (reason: string) => number,
): number {
  if (editedRows[er].length !== origRows[r].length) {
    skip(`표 ${r + 1}행 열 수 변경은 미지원`)
    return 0
  }
  let applied = 0
  for (let c = 0; c < origRows[r].length; c++) {
    if (origRows[r][c] === editedRows[er][c]) continue
    const { gridR, gridC } = replica[r][c]
    // 이미지/플레이스홀더 토큰은 본문 텍스트가 아님 — 변경 불가, 적용 시 제외
    const origTokens = extractCellTokens(origRows[r][c])
    const editedTokens = extractCellTokens(editedRows[er][c])
    if (origTokens !== editedTokens) {
      skip("셀 내 이미지 변경은 미지원")
      continue
    }
    const newLines = unescapeGfmCell(stripCellTokens(editedRows[er][c]))
      .split("\n").map(s => s.trim()).filter(Boolean)
    const origLines = unescapeGfmCell(stripCellTokens(origRows[r][c]))
      .split("\n").map(s => s.trim()).filter(Boolean)
    const n = applyCellEdit(table, scanTable, gridR, gridC, newLines, ctx, origRows[r][c], editedRows[er][c], origLines.length)
    if (n > 0 && origTokens) {
      ctx.skipped.push({
        reason: "셀 내 이미지·텍스트 혼재 — 텍스트만 적용 (이미지 인접 배치는 <br> 분리로 재현됨)",
        before: summarize(origRows[r][c]), after: summarize(editedRows[er][c]), partial: true,
      })
    }
    applied += n
  }
  return applied
}

/** GFM 표 행 추가/삭제 — table-rows 엔진에 GFM 도메인을 연결 */
function patchGfmTableRows(
  table: IRTable, scanTable: ScanTable, origRows: string[][], editedRows: string[][],
  replica: MappedCell[][], ctx: TablePatchCtx,
  skip: (reason: string) => number,
): number {
  // 행 연산은 마크다운 행 ↔ 격자 행 1:1일 때만 (빈 행 소실/라벨 전파/병합 없음)
  if (replica.length !== table.rows || replica.some((row, r) => row.some(c => c.gridR !== r))) {
    return skip("표 렌더 행과 격자 행 불일치 (빈 행/병합) — 행 추가/삭제 미지원")
  }
  if (table.cells.some(row => row.some(c => c && (c.colSpan > 1 || c.rowSpan > 1)))) {
    return skip("병합 셀 표 — GFM 행 추가/삭제 미지원")
  }
  // 편집 결과가 builder 렌더로 안정 재현되는지 (빈 행 드롭/첫 열 전파가 일어나면 무손실 불가)
  if (!gfmRenderStable(editedRows, table.cols)) {
    return skip("행 변경 결과가 표 렌더에서 변형됨 (빈 행/첫 열 전파/열 수 불일치) — 미지원")
  }
  const key = (row: string[]) => row.join("\u0000")
  return patchTableRows({
    table, scanTable, ctx, skip,
    origKeys: origRows.map(key),
    editedKeys: editedRows.map(key),
    editedCells: ei => {
      const cells: InsertCell[] = []
      for (const cellMd of editedRows[ei]) {
        if (extractCellTokens(cellMd)) return null
        const lines = unescapeGfmCell(cellMd).split("\n").map(s => s.trim()).filter(Boolean)
        cells.push({ lines, colSpan: 1, rowSpan: 1 })
      }
      return cells
    },
    patchMatched: (oi, ei) => patchGfmRowPair(table, scanTable, origRows, editedRows, replica, oi, ei, ctx, skip),
  })
}

/** 편집된 GFM 행렬이 builder 렌더에서 그대로 재현되는지 (행 연산 사전 검증) */
function gfmRenderStable(editedRows: string[][], cols: number): boolean {
  const sim: IRTable = {
    rows: editedRows.length,
    cols,
    hasHeader: editedRows.length > 1,
    cells: editedRows.map(row => {
      const padded = row.length < cols ? [...row, ...Array(cols - row.length).fill("")] : row
      return padded.map(md => ({ text: unescapeGfmCell(md), colSpan: 1, rowSpan: 1 }))
    }),
  }
  const replica = replicateGfmTable(sim)
  if (!replica || replica.length !== editedRows.length) return false
  return replica.every((row, r) => row.length === editedRows[r].length && row.every((c, j) => c.text === editedRows[r][j]))
}

// ── HTML 표 ──

export function patchHtmlTable(
  table: IRTable, scanTable: ScanTable, orig: MdUnit, edited: MdUnit, ctx: TablePatchCtx,
  skip: (reason: string) => number,
): number {
  return patchHtmlTableRaw(table, scanTable, orig.raw, edited.raw, ctx, skip, 0)
}

/** HTML 표 패치 본체 — 중첩표 셀은 재귀 */
function patchHtmlTableRaw(
  table: IRTable, scanTable: ScanTable, origRaw: string, editedRaw: string, ctx: TablePatchCtx,
  skip: (reason: string) => number, depth: number,
): number {
  if (depth > 8) return skip("중첩표 깊이 초과")
  // 자기 검증 — builder 렌더와 동일해야 좌표 신뢰 가능
  if (replicateTableToHtml(table) !== origRaw) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
  const replica = replicateHtmlTable(table)
  // 되읽기 대칭 검증 — 셀 텍스트에 리터럴 '</td>' 등이 있으면 parseHtmlTable의 셀 경계가
  // 렌더와 어긋나 미편집 셀이 잘려 저장될 수 있음. 원본을 되읽어 replica와 대조한다.
  const origRows = parseHtmlTable(origRaw)
  if (!origRows || origRows.length !== replica.length
    || origRows.some((r, i) => r.cells.length !== replica[i].cells.length
      || r.cells.some((c, j) => c.inner !== replica[i].cells[j].inner))) {
    return skip("셀 경계 모호 (리터럴 태그 의심) — 매핑 신뢰 불가")
  }
  const editedRows = parseHtmlTable(editedRaw)
  if (!editedRows) return skip("편집된 HTML 표 파싱 실패")
  if (editedRows.length !== replica.length) {
    return patchHtmlTableRows(table, scanTable, replica, editedRows, ctx, skip, depth)
  }

  let applied = 0
  for (let r = 0; r < replica.length; r++) {
    applied += patchHtmlRowPair(table, scanTable, replica, editedRows, r, r, ctx, skip, depth)
  }
  return applied
}

/** HTML 행 쌍 하나의 셀 단위 패치 (행 수 동일 경로와 행 연산의 매칭 행 공용) */
function patchHtmlRowPair(
  table: IRTable, scanTable: ScanTable, replica: HtmlRowInfo[], editedRows: HtmlRowInfo[],
  r: number, er: number, ctx: TablePatchCtx,
  skip: (reason: string) => number, depth: number,
): number {
  if (editedRows[er].cells.length !== replica[r].cells.length) {
    skip(`표 ${r + 1}행 셀 수 변경은 미지원`)
    return 0
  }
  let applied = 0
  for (let c = 0; c < replica[r].cells.length; c++) {
    const oc = replica[r].cells[c]
    const ec = editedRows[er].cells[c]
    if (oc.colSpan !== ec.colSpan || oc.rowSpan !== ec.rowSpan) {
      skip(`셀 병합(colspan/rowspan) 변경은 미지원`)
      continue
    }
    if (oc.inner === ec.inner) continue

    const origContent = htmlCellInnerToLines(oc.inner)
    const editedContent = htmlCellInnerToLines(ec.inner)
    if (origContent.hadNonText || editedContent.hadNonText) {
      // 이미지 변경 불가
      if (extractImgTags(oc.inner) !== extractImgTags(ec.inner)) {
        skip("셀 내 이미지 변경은 미지원")
        continue
      }
      // 중첩표 변경 → 셀의 중첩 소스맵으로 재귀 패치
      const origTables = extractTopLevelTables(oc.inner)
      const editedTables = extractTopLevelTables(ec.inner)
      if (origTables.length !== editedTables.length) {
        skip("셀 내 중첩표 추가/삭제는 미지원")
        continue
      }
      if (origTables.join("\n") !== editedTables.join("\n")) {
        applied += patchNestedTables(table, scanTable, oc, origTables, editedTables, ctx, skip, depth)
      }
    }
    // 텍스트 라인 변경 (중첩표/이미지 제외분)
    if (origContent.lines.join("\n") !== editedContent.lines.join("\n")) {
      const newLines = editedContent.lines.map(l => unescapeGfm(l))
      applied += applyCellEdit(table, scanTable, oc.gridR!, oc.gridC!, newLines, ctx, oc.inner, ec.inner, origContent.lines.length)
    }
  }
  return applied
}

/** HTML 표 행 추가/삭제 — table-rows 엔진에 HTML 도메인을 연결 */
function patchHtmlTableRows(
  table: IRTable, scanTable: ScanTable, replica: HtmlRowInfo[], editedRows: HtmlRowInfo[],
  ctx: TablePatchCtx, skip: (reason: string) => number, depth: number,
): number {
  // 행 연산은 렌더 행 ↔ 격자 행 1:1일 때만 (병합으로 소실된 행 없음)
  if (replica.length !== table.rows || replica.some((row, r) => row.cells.some(c => c.gridR !== r))) {
    return skip("표 렌더 행과 격자 행 불일치 (병합 소실 행) — 행 추가/삭제 미지원")
  }
  const key = (row: HtmlRowInfo) =>
    row.cells.map(c => `${c.colSpan}x${c.rowSpan}:${c.inner}`).join("\u0000")
  return patchTableRows({
    table, scanTable, ctx, skip,
    origKeys: replica.map(key),
    editedKeys: editedRows.map(key),
    editedCells: ei => {
      const cells: InsertCell[] = []
      for (const cell of editedRows[ei].cells) {
        const content = htmlCellInnerToLines(cell.inner)
        if (content.hadNonText) return null
        cells.push({ lines: content.lines.map(l => unescapeGfm(l)), colSpan: cell.colSpan, rowSpan: cell.rowSpan })
      }
      return cells
    },
    patchMatched: (oi, ei) => patchHtmlRowPair(table, scanTable, replica, editedRows, oi, ei, ctx, skip, depth),
  })
}

/** 셀 내 중첩표 k번째 IRTable/ScanTable 쌍을 찾아 재귀 패치 */
function patchNestedTables(
  table: IRTable, scanTable: ScanTable, oc: { gridR?: number; gridC?: number },
  origTables: string[], editedTables: string[], ctx: TablePatchCtx,
  skip: (reason: string) => number, depth: number,
): number {
  const irCell = table.cells[oc.gridR!]?.[oc.gridC!]
  const scanCell = scanTable.cellByAnchor.get(`${oc.gridR},${oc.gridC}`)
  const nestedIRs = (irCell?.blocks ?? []).filter(b => b.type === "table" && b.table).map(b => b.table!)
  if (!scanCell || nestedIRs.length !== origTables.length || scanCell.tables.length !== origTables.length) {
    return skip("중첩표 소스맵 매핑 실패")
  }
  let applied = 0
  for (let k = 0; k < origTables.length; k++) {
    if (origTables[k] === editedTables[k]) continue
    applied += patchHtmlTableRaw(nestedIRs[k], scanCell.tables[k], origTables[k], editedTables[k], ctx, skip, depth + 1)
  }
  return applied
}

export function extractImgTags(inner: string): string {
  return (inner.match(/<img\s(?:"[^"]*"|'[^']*'|[^>"'])*?>/gi) || []).join(" ")
}

/** GFM 셀의 비텍스트 토큰 — 이미지 참조/추출실패 플레이스홀더 */
const CELL_TOKEN_RE = /!\[image\]\([^)]*\)|\[이미지: [^\]]*\]/g

export function extractCellTokens(text: string): string {
  return (text.match(CELL_TOKEN_RE) || []).join(" ")
}

export function stripCellTokens(text: string): string {
  return text.replace(CELL_TOKEN_RE, "")
}

// ── 1x1 / 1열 표 (텍스트 청크 렌더) ──

export function patchTextChunkTable(
  table: IRTable, scanTable: ScanTable, orig: MdUnit, edited: MdUnit, ctx: TablePatchCtx,
  skip: (reason: string) => number,
): number {
  if (table.rows === 1 && table.cols === 1) {
    // builder 1x1 경로 재현 (라인별 장식 포함, 유닛 분할 시 트림됨)
    const content = sanitizeText(table.cells[0][0].text)
    const replicaLines = content.split(/\n/).map(line => {
      const t = line.trim()
      if (!t) return ""
      if (/^\d+\.\s/.test(t)) return `**${escapeGfm(t)}**`
      return escapeGfm(t)
    }).filter(Boolean)
    if (replicaLines.join("\n") !== orig.lines.join("\n")) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
    if (extractCellTokens(orig.raw) !== extractCellTokens(edited.raw)) return skip("셀 내 이미지 변경은 미지원")
    const newLines = edited.lines.map(l => {
      // builder는 /^\d+\.\s/ 라인에만 '**' 볼드를 부여 — 그 경우만 벗기고
      // 리터럴 '**...**' 텍스트는 보존
      const m = l.match(/^\*\*([\s\S]*)\*\*$/)
      const unwrap = m && /^\d+\.\s/.test(unescapeGfm(m[1]))
      return stripCellTokens(unescapeGfm(unwrap ? m![1] : l)).trim()
    }).filter(Boolean)
    return applyCellEdit(table, scanTable, 0, 0, newLines, ctx, orig.raw, edited.raw, orig.lines.length)
  }

  if (table.cols === 1 && table.rows >= 2) {
    const replica: { line: string; gridR: number }[] = []
    for (let r = 0; r < table.rows; r++) {
      const line = escapeGfm(sanitizeText(table.cells[r][0].text)).replace(/\n/g, " ")
      if (line) replica.push({ line, gridR: r })
    }
    if (replica.map(x => x.line).join("\n") !== orig.lines.join("\n")) return skip("표 좌표 재현 불일치 — 매핑 신뢰 불가")
    if (edited.lines.length !== replica.length) return skip("표 행 추가/삭제는 미지원 (표 구조 변경)")
    let applied = 0
    for (let i = 0; i < replica.length; i++) {
      if (replica[i].line === edited.lines[i]) continue
      if (extractCellTokens(replica[i].line) !== extractCellTokens(edited.lines[i])) {
        skip("셀 내 이미지 변경은 미지원")
        continue
      }
      const newLines = [stripCellTokens(unescapeGfm(edited.lines[i])).trim()].filter(Boolean)
      applied += applyCellEdit(table, scanTable, replica[i].gridR, 0, newLines, ctx, replica[i].line, edited.lines[i], 1)
    }
    return applied
  }

  return skip("표 렌더 경로 식별 실패")
}

// ── 셀 공통 적용 ──

/**
 * 격자 좌표 (gridR, gridC)의 셀에 새 텍스트 라인들을 적용.
 * 라인 ↔ 셀 내 비어있지 않은 문단 순서 매핑 (filler-hwpx 치환 전략).
 * (session.ts 블록 단위 셀 편집에서도 공용)
 */
export function applyCellEdit(
  table: IRTable, scanTable: ScanTable, gridR: number, gridC: number,
  newLines: string[], ctx: TablePatchCtx, before: string, after: string,
  origLineCount?: number,
): number {
  const skip = (reason: string) => {
    ctx.skipped.push({ reason, before: summarize(before), after: summarize(after) })
    return 0
  }
  const cell = scanTable.cellByAnchor.get(`${gridR},${gridC}`)
  if (!cell) return skip("셀 좌표 매핑 실패 (병합 영역의 빈 칸이거나 좌표 불일치)")

  // 셀 콘텐츠 검증 — 스캔 문단 합산과 IR 셀 텍스트의 정규화 일치
  // (IR 셀 텍스트의 이미지 토큰은 스캔 문단에 없는 평탄화 산물이므로 제외)
  const irCell = table.cells[gridR]?.[gridC]
  const scanJoined = cell.paragraphs.map(p => p.text).filter(t => normForMatch(t)).join("\n")
  if (irCell && normForMatch(scanJoined) !== normForMatch(stripCellTokens(irCell.text))) {
    // 중첩표/글상자 등 구조 셀 — 평탄화 텍스트가 섞여 1:1 치환 불가
    if (normForMatch(irCell.text) !== "" || normForMatch(scanJoined) !== "") {
      const flatBlocks = (irCell.blocks ?? []).filter(b => b.type === "paragraph" || b.type === "heading")
      const flatJoined = flatBlocks.map(b => b.text ?? "").join("\n")
      if (normForMatch(scanJoined) !== normForMatch(flatJoined)) {
        return skip("셀 콘텐츠 구조 복잡 (중첩표/글상자) — 매핑 신뢰 불가")
      }
    }
  }

  const nonEmpty = cell.paragraphs.filter(p => normForMatch(p.text) !== "")
  // 원본 마크다운 라인 수 ≠ 실제 문단 수면 셀 텍스트에 리터럴 '<br>'(또는 문단 내
  // 강제 줄바꿈)이 있다는 뜻 — 라인↔문단 매핑이 모호하므로 정직하게 skip
  if (origLineCount !== undefined && nonEmpty.length > 0 && origLineCount !== nonEmpty.length) {
    return skip("셀 줄 경계 매핑 모호 (리터럴 <br>/문단 내 줄바꿈) — 미지원")
  }
  const splices: SpliceEdit[] = []
  let sectionIndex = -1

  // 기록될 텍스트가 재파싱 sanitize에서 변형되면(이중 공백 등) 무손실이 깨짐
  const unstable = newLines.find(l => sanitizeText(l) !== l)
  if (unstable !== undefined) return skip("공백 정규화 불안정 텍스트 — 패치 시 원문 보존 불가로 미지원")

  if (nonEmpty.length === 0) {
    // 빈 셀에 텍스트 채우기 — 첫 문단에 삽입
    if (newLines.length === 0) return 0
    const target = cell.paragraphs[0]
    if (!target) return skip("빈 셀에 문단이 없어 텍스트 삽입 불가")
    const value = newLines.join(" ")
    const xml = ctx.scans[target.sectionIndex]?.xml
    // 문단 raw t-도메인이 공백만일 때(IR상 빈 셀이나 XML엔 공백 문자 존재):
    // buildParagraphSplices는 그 공백 t를 통째 교체 대상으로 삼아 제거한다 —
    // 요청한 삽입 경계 밖의 원문 손실(#54). t 맨 앞에 zero-length 삽입해 보존한다.
    const rawT = xml ? paraTText(target, xml) : null
    let sp: SpliceEdit[] | null
    if (xml && rawT !== null && rawT.length > 0 && rawT.trim() === "") {
      sp = buildRangeSplices(target, xml, 0, 0, value)
      // 삽입 경계를 유일하게 정할 수 없으면(엔티티/내부 태그로 t-좌표 불일치) 조용한
      // 성공 대신 정직하게 skip — 원문 손실 방지(fail-closed)
      if (sp === null) return skip("빈 셀 공백 보존 삽입 경계 모호 — 원문 손실 방지로 미적용")
    } else {
      sp = buildParagraphSplices(target, value, xml)
      if (sp === null) return skip("셀 문단에 텍스트 노드를 만들 수 없음")
    }
    splices.push(...sp)
    sectionIndex = target.sectionIndex
    if (newLines.length > 1) {
      ctx.skipped.push({ reason: "셀 내 줄 추가는 문단 생성 미지원 — 한 문단으로 병합 적용", after: summarize(after), partial: true })
    }
  } else {
    // 라인 → 문단 순서 매핑
    const assigned: string[] = []
    for (let i = 0; i < nonEmpty.length; i++) {
      if (i < newLines.length) {
        assigned.push(i === nonEmpty.length - 1 && newLines.length > nonEmpty.length
          ? newLines.slice(i).join(" ")  // 넘치는 줄은 마지막 문단에 병합
          : newLines[i])
      } else {
        assigned.push("") // 줄이 줄어든 경우 비움
      }
    }
    if (newLines.length > nonEmpty.length) {
      ctx.skipped.push({ reason: "셀 내 줄 추가는 문단 생성 미지원 — 마지막 문단에 병합 적용", after: summarize(after), partial: true })
    } else if (newLines.length < nonEmpty.length && nonEmpty.length > 1) {
      // 텍스트는 편집대로 반영되지만 문단 자체는 제거하지 못함 — 뷰어에서 빈 줄로 보일 수 있음
      ctx.skipped.push({ reason: "셀 내 줄 삭제는 문단 제거 미지원 — 빈 문단 잔존(뷰어에 빈 줄 표시 가능)", before: summarize(before), after: summarize(after), partial: true })
    }
    for (let i = 0; i < nonEmpty.length; i++) {
      // assigned는 sanitize된 마크다운 도메인, nonEmpty[i].text는 XML 원문 — 정규화
      // 동치면 미편집 문단이므로 재작성하지 않는다 (공백·run 서식 보존)
      if (assigned[i] === nonEmpty[i].text || normForMatch(assigned[i]) === normForMatch(nonEmpty[i].text)) continue
      const sp = buildParagraphSplices(nonEmpty[i], assigned[i], ctx.scans[nonEmpty[i].sectionIndex]?.xml)
      if (sp === null) return skip("셀 문단에 텍스트 노드를 만들 수 없음")
      splices.push(...sp)
      sectionIndex = nonEmpty[i].sectionIndex
    }
  }

  if (splices.length === 0) return 0
  ctx.sectionSplices[sectionIndex].push(...splices)
  return 1
}
