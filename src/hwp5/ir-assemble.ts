/**
 * 문단·셀 IR 조립 — HWP5(body.ts)·HWP3(hwp3/parser.ts) 공용.
 *
 * 두 바이너리 파서가 레코드/문자 스트림에서 뽑은 문단 글·개체 블록·좌표 셀을 HWPX 파서와 같은 IR 모양으로
 * 조립한다: 글자처럼 취급 표 앞뒤 글 분할(#49/#50), 셀 평탄화 줄 모델(#52), 머리말·각주 안 표 평탄화,
 * 좌표 셀 → builder 직접 배치(후행 빈 열 트림 계약)와 손상 표(겹친 앵커) 정리.
 */

import { buildTable, convertTableToText, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, IRTable, InlineStyle } from "../types.js"

/** 글자처럼 취급 표 자리 표지 — 문단 글을 표 앞뒤로 나눈다 (HWPX section-walker 와 같은 문자) */
export const INLINE_TABLE_MARK = "\x1E"

/**
 * 셀 평탄화에서 앞 줄에 공백으로 잇는 블록 — 글자처럼 취급 표와 그 뒤 조각은 한 줄이다
 * (HWPX completeTable/flush 의 lineOpen 규칙 #52). emitParagraphBlocks 가 표시하고 cellTextFromBlocks 가 읽는다
 */
const INLINE_JOIN = new WeakSet<IRBlock>()

/** 문단에 딸린 개체 (컨트롤 순서) */
export interface ParaObject {
  /** 개체 파생 블록 (표·그림·글상자) */
  blocks: IRBlock[]
  /** 표 개체 — 앞 글 조각을 먼저 내보낸다 */
  table: boolean
  /** 글자처럼 취급 표 — 문단 글에 INLINE_TABLE_MARK 자리가 있다 */
  inline: boolean
}

export interface ParaEmitInput {
  /** 필드 편집·리더 절단을 마친 문단 글 (INLINE_TABLE_MARK 포함 가능) */
  text: string
  headMarker: string | null
  /** 개요 제목 수준 (0 = 본문) */
  headingLevel: number
  style?: InlineStyle
  /** 각주/미주 ("1) 내용") */
  footnotes: string[]
  objects: ParaObject[]
  pageNumber?: number
}

/** 문단 1개 → [문단 블록(들), 개체 블록] */
export function emitParagraphBlocks(p: ParaEmitInput): IRBlock[] {
  const { headMarker, style, footnotes, objects, pageNumber } = p
  const blocks: IRBlock[] = []
  // 취소선·밑줄 문단(법령 개정문 삭제·개정 표시 등)은 ~~…~~ / <u>…</u> 로 방출 —
  // 대표(최빈) 스타일 기준이라 문단 전체가 그어진 경우만 잡는다 (부분 서식은 미지원)
  const decorate = (t: string): string => {
    let deco = style?.strike ? `~~${t}~~` : t
    if (style?.underline) deco = `<u>${deco}</u>`
    return deco
  }

  if (p.text.includes(INLINE_TABLE_MARK)) {
    // 글자처럼 취급 표가 있는 문단 — 표 앞 조각을 표 직전에 방출해 원문 순서를 지킨다(HWPX walkParagraphChildren
    // onTbl 대칭: 떠 있는 표도 앞 조각을 먼저 내고, 그리기 개체는 조각을 당기지 않는다). 조각은 본문 문단
    // (개요 제목 승격 없음 — HWPX 와 같다), 문단 머리표는 첫 글 조각에, 스타일·각주는 첫 블록에
    const segments = p.text.split(INLINE_TABLE_MARK)
    let segIdx = 0
    let first = true
    let lineOpen = false
    let markerPending = !!headMarker
    const flush = (): void => {
      if (segIdx >= segments.length) return
      const s = segments[segIdx++].replace(/\$\$/g, "$ $").trim()
      if (!s) return
      let t = decorate(s)
      if (markerPending) { t = `${headMarker} ${t}`; markerPending = false }
      const block: IRBlock = { type: "paragraph", text: t, pageNumber }
      if (first) {
        if (style) block.style = style
        if (footnotes.length > 0) block.footnoteText = footnotes.join("; ")
        first = false
      }
      if (lineOpen) INLINE_JOIN.add(block)
      lineOpen = true
      blocks.push(block)
    }
    for (const obj of objects) {
      if (obj.table) {
        flush()
        if (obj.inline && lineOpen) for (const b of obj.blocks) INLINE_JOIN.add(b)
        lineOpen = obj.inline
      }
      blocks.push(...obj.blocks)
    }
    while (segIdx < segments.length) flush()
    // 글 조각이 하나도 없는 각주 anchor — 각주 내용 자체를 문단으로 보존 (아래 단일 문단 경로와 같다)
    if (first && footnotes.length > 0) blocks.unshift({ type: "paragraph", text: `(주: ${footnotes.join("; ")})`, pageNumber })
    return blocks
  }

  const trimmed = p.text.replace(/\$\$/g, "$ $").trim()
  if (trimmed) {
    const block: IRBlock = {
      type: p.headingLevel > 0 ? "heading" : "paragraph",
      text: headMarker ? `${headMarker} ${trimmed}` : trimmed,
      pageNumber,
    }
    if (p.headingLevel > 0) block.level = p.headingLevel
    if (style) {
      block.style = style
      if (style.strike || style.underline) block.text = headMarker ? `${headMarker} ${decorate(trimmed)}` : decorate(trimmed)
    }
    if (footnotes.length > 0) block.footnoteText = footnotes.join("; ")
    blocks.push(block)
  } else if (footnotes.length > 0) {
    // 본문 없는 각주 anchor — 각주 내용 자체를 문단으로 보존
    blocks.push({ type: "paragraph", text: `(주: ${footnotes.join("; ")})`, pageNumber })
  }
  for (const obj of objects) blocks.push(...obj.blocks)
  return blocks
}

// ─── 평문 평탄화 ─────────────────────────────────────

/**
 * 표 → 평문 — 셀은 " / ", 행은 줄바꿈(convertTableToText), 캡션 먼저. HWPX completeTable·buildSubListTable 과 같은 모양.
 * 셀 이미지 sentinel("![image](hwp5bin:N)")은 남긴다 — images.ts 가 블록 트리 전체에서 추출 파일명으로 편다
 * (HWPX 도 머리말 표 이미지 셀을 "![image](…)" 로 남긴다). 종전엔 머리말·각주의 표를 건너뛰어 표 글이 통째로 사라졌다
 */
export function tableFlatText(table: IRTable): string {
  const flat = convertTableToText(table.cells)
  return table.caption ? table.caption + (flat ? "\n" + flat : "") : flat
}

/** 블록 리스트 → 평문 (각주 인라인 포함, 표는 평탄화, 이미지는 제외) — 머리말·각주·캡션용 */
export function blocksPlainText(blocks: IRBlock[], sep: string): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === "image") continue
    if (b.type === "table") {
      const flat = b.table ? tableFlatText(b.table) : ""
      if (flat) parts.push(flat)
      continue
    }
    if (b.text) {
      let t = b.text
      if (b.footnoteText) t += ` (주: ${b.footnoteText})`
      parts.push(t)
    }
  }
  return parts.join(sep).trim()
}

/**
 * 셀 문단 블록 → 하위 호환 셀 텍스트 (문단 평탄화 + 이미지 표지 + 중첩표 평문).
 * 글자처럼 취급 표와 그 뒤 조각은 앞 줄에 공백으로 잇는다(INLINE_JOIN). 셀 문단의 각주는 문단 글에 접어 넣는다 —
 * HWPX 셀 블록과 같은 IR(블록 text 에 "(주: …)"); footnoteText 로 따로 두면 병합 셀 HTML 경로(blocks 직렬화)가
 * 각주를 버렸다. hasStructure = 셀에 blocks 를 달 구조(이미지·중첩표)가 있는가
 */
export function cellTextFromBlocks(blocks: IRBlock[]): { text: string; hasStructure: boolean } {
  let text = ""
  const add = (part: string, b: IRBlock): void => { text += (text ? (INLINE_JOIN.has(b) ? " " : "\n") : "") + part }
  let hasStructure = false
  for (const b of blocks) {
    if (b.type === "image" && b.text) {
      add(`![image](hwp5bin:${b.text})`, b)
      hasStructure = true
    } else if (b.type === "table" && b.table) {
      // flattenLayoutTables 경유 시를 위한 평문 — 구조는 blocks가 보존
      const flat = tableFlatText(b.table)
      if (flat) add(flat, b)
      hasStructure = true
    } else if (b.text) {
      if (b.footnoteText) {
        b.text += ` (주: ${b.footnoteText})`
        delete b.footnoteText
      }
      add(b.text, b)
    }
  }
  return { text, hasStructure }
}

// ─── 좌표 셀 → IRTable ──────────────────────────────

/** 좌표를 가진 셀 (HWP5 LIST_HEADER colAddr/rowAddr, HWP3 셀 기하에서 복원한 좌표) */
export interface AddressedCell extends CellContext {
  blocks?: IRBlock[]
  isHeader?: boolean
}

/**
 * 좌표 셀 겹침 정리 (손상 파일) — 먼저 나온 셀이 칸을 차지한다. 앵커가 앞 셀 영역에 떨어진 셀은 글·구조를
 * 앞 셀에 이어 붙이고(한컴은 겹쳐 그릴 뿐 글을 버리지 않는다), 앞 셀 영역을 덮는 병합은 겹치지 않을 때까지
 * 줄인다. builder 직접 배치는 뒤 셀이 앞 앵커를 덮어써 글이 사라진다. 정상 표는 입력 그대로(같은 객체) 통과
 */
function resolveCellOverlaps<T extends AddressedCell>(cells: T[], rows: number, cols: number): T[] {
  const owner = new Map<number, T>()
  const out: T[] = []
  for (const cell of cells) {
    const r0 = cell.rowAddr ?? 0, c0 = cell.colAddr ?? 0
    const hit = owner.get(r0 * cols + c0)
    if (hit) {
      if (cell.blocks?.length) {
        hit.blocks = [...(hit.blocks ?? (hit.text ? [{ type: "paragraph" as const, text: hit.text }] : [])), ...cell.blocks]
      }
      if (cell.text.trim()) hit.text = hit.text.trim() ? `${hit.text}\n${cell.text}` : cell.text
      continue
    }
    // 첫 행에서 먼저 차지된 열 앞까지, 그 폭으로 먼저 차지된 행 앞까지 줄인다(표 안 칸만 한 번씩 훑는다).
    // 겹침이 없으면 span 을 건드리지 않는다 — 표 밖으로 뻗은 span 도 종전대로 builder 에 맡긴다
    const csIn = Math.max(1, Math.min(cell.colSpan, cols - c0))
    let cs = cell.colSpan
    for (let c = c0 + 1; c < c0 + csIn; c++) if (owner.has(r0 * cols + c)) { cs = c - c0; break }
    const rsIn = Math.max(1, Math.min(cell.rowSpan, rows - r0))
    let rs = cell.rowSpan
    scan: for (let r = r0 + 1; r < r0 + rsIn; r++) {
      for (let c = c0; c < c0 + Math.min(cs, csIn); c++) if (owner.has(r * cols + c)) { rs = r - r0; break scan }
    }
    const placed = cs === cell.colSpan && rs === cell.rowSpan ? cell : { ...cell, colSpan: cs, rowSpan: rs }
    for (let r = r0; r < Math.min(r0 + rs, rows); r++) for (let c = c0; c < Math.min(c0 + cs, cols); c++) owner.set(r * cols + c, placed)
    out.push(placed)
  }
  return out
}

/**
 * 좌표 셀 → IRTable — HWPX(table-build.ts)와 같은 builder 직접 배치(buildTableDirect)를 태워 표 계약
 * (후행 빈 열 트림 + 잘린 열에 걸친 span 절단, keepAnchoredEmptyCols 면 앵커 열 보존)을 맞춘다. HWP5 종전 경로는
 * 자체 그리드를 그대로 IRTable 로 내 빈 입력란 열이 남았다 — 같은 문서 HWPX 보다 1~9열 넓음(서식 표 300+ 실측).
 * 행 묶음은 rowAddr 기준(HWPX <tr> 과 같은 경계), 셀 blocks·제목 셀은 좌표로 재부착.
 * 손상 레코드(행·열 0, 표 밖 앵커)는 표를 버리지 않고 셀 좌표까지 넓힌다 — 글 손실 금지
 */
export function buildAddressedTable(cells: AddressedCell[], rows: number, cols: number, keepAnchoredEmptyCols?: boolean): IRTable | null {
  for (const c of cells) {
    rows = Math.max(rows, Math.min((c.rowAddr ?? 0) + 1, MAX_ROWS))
    cols = Math.max(cols, Math.min((c.colAddr ?? 0) + 1, MAX_COLS))
  }
  const placed = resolveCellOverlaps(cells, rows, cols)
  const byRow: AddressedCell[][] = Array.from({ length: rows }, () => [])
  for (const c of placed) {
    const r = c.rowAddr ?? 0
    if (r < rows && (c.colAddr ?? 0) < cols) byRow[r].push(c)
  }
  const table = buildTable(byRow, { keepAnchoredEmptyCols })
  if (table.rows === 0) return null
  for (const c of placed) {
    if (!c.blocks?.length && !c.isHeader) continue
    const target = table.cells[c.rowAddr ?? 0]?.[c.colAddr ?? 0]
    // 겹친 앵커로 합쳐진 셀·잘린 열의 앵커는 텍스트가 달라 붙지 않는다
    if (!target || target.text !== c.text.trim()) continue
    if (c.blocks?.length) target.blocks = c.blocks
    if (c.isHeader) target.isHeader = true
  }
  return table
}
