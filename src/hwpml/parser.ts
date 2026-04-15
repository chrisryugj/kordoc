/** HWPML 2.x 파서 — XML 기반 한컴 문서 (.hwp with XML content) */

import { DOMParser } from "@xmldom/xmldom"
import type { IRBlock, InternalParseResult, ParseOptions, ParseWarning, DocumentMetadata, OutlineItem } from "../types.js"
import { blocksToMarkdown, buildTable } from "../table/builder.js"
import { parsePageRange } from "../page-range.js"
import { stripDtd } from "../utils.js"
import type { CellContext } from "../types.js"

const MAX_XML_DEPTH = 200
const MAX_TABLE_ROWS = 5000
const MAX_TABLE_COLS = 500
const MAX_HWPML_BYTES = 50 * 1024 * 1024  // 50MB 상한

/** ParaShape 헤딩 정보 */
interface ParaShapeInfo {
  headingLevel: number | null  // null = 일반 단락, 1-6 = 헤딩 레벨
}

/** HWPML 문서 파싱 진입점 */
export function parseHwpmlDocument(buffer: ArrayBuffer, options?: ParseOptions): InternalParseResult {
  if (buffer.byteLength > MAX_HWPML_BYTES) {
    throw new Error(`HWPML 파일 크기 초과 (${(buffer.byteLength / 1024 / 1024).toFixed(1)}MB > 50MB)`)
  }
  const text = new TextDecoder("utf-8").decode(buffer).replace(/^\uFEFF/, "")

  // &nbsp; 엔티티 치환 (DOCTYPE 제거 전에 처리)
  const normalized = text.replace(/&nbsp;/g, "&#160;")
  const xml = stripDtd(normalized)

  const warnings: ParseWarning[] = []
  const parser = new DOMParser({
    onError: (_level: string, msg: string) => {
      warnings.push({ message: `HWPML XML 파싱 경고: ${msg}`, code: "MALFORMED_XML" })
    },
  } as ConstructorParameters<typeof DOMParser>[0])

  const doc = parser.parseFromString(xml, "text/xml")
  if (!doc.documentElement) {
    return { markdown: "", blocks: [], warnings }
  }

  const root = doc.documentElement

  // ─── 메타데이터 추출 ──────────────────────────────────
  const metadata: DocumentMetadata = {}
  const docSummary = findChild(root, "DOCSUMMARY")
  if (docSummary) {
    const title = findChild(docSummary, "TITLE")
    const author = findChild(docSummary, "AUTHOR")
    const date = findChild(docSummary, "DATE")
    if (title) metadata.title = textContent(title).trim()
    if (author) metadata.author = textContent(author).trim()
    if (date) metadata.createdAt = textContent(date).trim() || undefined
  }

  // ─── HEAD: ParaShape 맵 구축 ──────────────────────────
  const paraShapeMap = buildParaShapeMap(root)

  // ─── BODY 파싱 ────────────────────────────────────────
  const body = findChild(root, "BODY")
  if (!body) {
    return { markdown: "", blocks: [], metadata, warnings }
  }

  const blocks: IRBlock[] = []
  const pageFilter = options?.pages ? parsePageRange(options.pages, countSections(body)) : null
  let sectionIdx = 0

  const children = body.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue
    if (localName(el) !== "SECTION") continue

    sectionIdx++
    if (pageFilter && !pageFilter.has(sectionIdx)) continue

    parseSection(el, blocks, paraShapeMap, sectionIdx, warnings)
  }

  // ─── 헤딩 트리(outline) 구성 ──────────────────────────
  const outline: OutlineItem[] = blocks
    .filter(b => b.type === "heading" && b.text)
    .map(b => ({ level: b.level ?? 1, text: b.text!, pageNumber: b.pageNumber }))

  const markdown = blocksToMarkdown(blocks)
  return {
    markdown,
    blocks,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    outline: outline.length > 0 ? outline : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

// ─── ParaShape 맵 ────────────────────────────────────────

function buildParaShapeMap(root: Element): Map<string, ParaShapeInfo> {
  const map = new Map<string, ParaShapeInfo>()
  const head = findChild(root, "HEAD")
  if (!head) return map

  const mappingTable = findChild(head, "MAPPINGTABLE")
  if (!mappingTable) return map

  const paraShapeList = findChild(mappingTable, "PARASHAPELIST")
  if (!paraShapeList) return map

  const children = paraShapeList.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1 || localName(el) !== "PARASHAPE") continue
    const id = el.getAttribute("Id") ?? ""
    const headingType = el.getAttribute("HeadingType") ?? "None"
    const level = parseInt(el.getAttribute("Level") ?? "0", 10)
    let headingLevel: number | null = null
    if (headingType === "Outline") {
      const safeLevel = isNaN(level) ? 0 : Math.max(0, level)
      headingLevel = Math.min(safeLevel + 1, 6)  // Level 0→H1, 1→H2, ..., 5→H6
    }
    map.set(id, { headingLevel })
  }

  return map
}

// ─── 섹션 파싱 ───────────────────────────────────────────

function parseSection(
  section: Element,
  blocks: IRBlock[],
  paraShapeMap: Map<string, ParaShapeInfo>,
  sectionNum: number,
  warnings: ParseWarning[],
): void {
  walkContent(section, blocks, paraShapeMap, sectionNum, warnings, false)
}

/**
 * 콘텐츠 노드를 재귀적으로 순회하여 IRBlock 생성.
 * inHeaderFooter=true일 때 단락/표 블록 출력 억제.
 */
function walkContent(
  node: Element,
  blocks: IRBlock[],
  paraShapeMap: Map<string, ParaShapeInfo>,
  sectionNum: number,
  warnings: ParseWarning[],
  inHeaderFooter: boolean,
  depth: number = 0,
): void {
  if (depth > MAX_XML_DEPTH) return
  const children = node.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue
    const tag = localName(el)

    if (tag === "HEADER" || tag === "FOOTER") {
      // 머리글/바닥글 — 텍스트 콘텐츠 무시
      continue
    }

    if (tag === "P") {
      if (!inHeaderFooter) {
        parseParagraph(el, blocks, paraShapeMap, sectionNum)
      }
      continue
    }

    if (tag === "TABLE") {
      if (!inHeaderFooter) {
        parseTable(el, blocks, paraShapeMap, sectionNum, warnings)
      }
      continue
    }

    // PARALIST, SUBLIST, SECTION 내부 등 — 재귀
    if (tag === "PARALIST" || tag === "SECTION" || tag === "COLDEF") {
      walkContent(el, blocks, paraShapeMap, sectionNum, warnings, inHeaderFooter, depth + 1)
      continue
    }

    // TEXT, SECDEF 등 내부에서도 P/TABLE이 중첩될 수 있음 — 재귀
    walkContent(el, blocks, paraShapeMap, sectionNum, warnings, inHeaderFooter, depth + 1)
  }
}

// ─── 단락 파싱 ───────────────────────────────────────────

function parseParagraph(
  el: Element,
  blocks: IRBlock[],
  paraShapeMap: Map<string, ParaShapeInfo>,
  sectionNum: number,
): void {
  const paraShapeId = el.getAttribute("ParaShape") ?? ""
  const shapeInfo = paraShapeMap.get(paraShapeId)

  const text = extractParagraphText(el)
  if (!text) return

  if (shapeInfo?.headingLevel != null) {
    blocks.push({ type: "heading", text, level: shapeInfo.headingLevel, pageNumber: sectionNum })
  } else {
    blocks.push({ type: "paragraph", text, pageNumber: sectionNum })
  }
}

/** <P> 에서 텍스트 추출 — <TEXT><CHAR> 순회 */
function extractParagraphText(p: Element): string {
  const parts: string[] = []
  collectCharText(p, parts)
  return parts.join("").trim()
}

function collectCharText(node: Element, parts: string[], depth: number = 0): void {
  if (depth > MAX_XML_DEPTH) return
  const children = node.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue
    const tag = localName(el)

    if (tag === "CHAR") {
      // textContent — 자식 텍스트 노드 직접 수집
      const t = textContent(el)
      if (t) parts.push(t)
    } else if (tag === "TABLE" || tag === "PICTURE" || tag === "SHAPEOBJECT") {
      // 단락 내 테이블/이미지는 별도 블록으로 처리되므로 스킵
    } else if (tag === "AUTONUM") {
      // 자동 번호 (페이지 번호 등) 스킵
    } else {
      collectCharText(el, parts, depth + 1)
    }
  }
}

// ─── 테이블 파싱 ─────────────────────────────────────────

function parseTable(
  el: Element,
  blocks: IRBlock[],
  paraShapeMap: Map<string, ParaShapeInfo>,
  sectionNum: number,
  warnings: ParseWarning[],
): void {
  const cells: CellContext[] = []
  const rowCount = parseInt(el.getAttribute("RowCount") ?? "0", 10)
  const colCount = parseInt(el.getAttribute("ColCount") ?? "0", 10)
  if (isNaN(rowCount) || isNaN(colCount) || rowCount === 0 || colCount === 0) return
  if (rowCount > MAX_TABLE_ROWS || colCount > MAX_TABLE_COLS) {
    warnings.push({ message: `테이블 크기 초과 (${rowCount}x${colCount}) — 스킵`, code: "TRUNCATED_TABLE" })
    return
  }

  // <ROW> → <CELL> 순회
  const children = el.childNodes
  for (let i = 0; i < children.length; i++) {
    const rowEl = children[i] as Element
    if (rowEl.nodeType !== 1 || localName(rowEl) !== "ROW") continue

    const rowCells = rowEl.childNodes
    for (let j = 0; j < rowCells.length; j++) {
      const cellEl = rowCells[j] as Element
      if (cellEl.nodeType !== 1 || localName(cellEl) !== "CELL") continue

      const colAddr = parseInt(cellEl.getAttribute("ColAddr") ?? "0", 10)
      const rowAddr = parseInt(cellEl.getAttribute("RowAddr") ?? "0", 10)
      // colSpan/rowSpan 클램핑: NaN, 음수, 과대값 방어
      const colSpan = Math.min(Math.max(1, parseInt(cellEl.getAttribute("ColSpan") ?? "1", 10) || 1), MAX_TABLE_COLS)
      const rowSpan = Math.min(Math.max(1, parseInt(cellEl.getAttribute("RowSpan") ?? "1", 10) || 1), MAX_TABLE_ROWS)

      // 셀 텍스트: PARALIST > P 재귀 추출
      const cellText = extractCellText(cellEl)

      cells.push({ text: cellText, colSpan, rowSpan, colAddr, rowAddr })
    }
  }

  if (cells.length === 0) return

  // 그리드 배치 (HWP5와 동일한 방식 — colAddr/rowAddr 사용)
  const grid: (CellContext | null)[][] = Array.from({ length: rowCount }, () => Array(colCount).fill(null))
  for (const cell of cells) {
    const r = cell.rowAddr ?? 0
    const c = cell.colAddr ?? 0
    if (isNaN(r) || isNaN(c) || r >= rowCount || c >= colCount) continue
    grid[r][c] = cell
    for (let dr = 0; dr < cell.rowSpan; dr++) {
      for (let dc = 0; dc < cell.colSpan; dc++) {
        if (dr === 0 && dc === 0) continue
        if (r + dr < rowCount && c + dc < colCount) {
          grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 }
        }
      }
    }
  }

  const cellRows: CellContext[][] = grid.map(row =>
    row.map(cell => cell ?? { text: "", colSpan: 1, rowSpan: 1 })
  )

  const table = buildTable(cellRows)
  blocks.push({ type: "table", table, pageNumber: sectionNum })
}

/** 셀 내부 텍스트 추출 — PARALIST > P 재귀, 중첩 테이블은 평탄화 */
function extractCellText(cellEl: Element): string {
  const textParts: string[] = []
  collectCellText(cellEl, textParts, 0)
  return textParts.filter(Boolean).join("\n").trim()
}

function collectCellText(node: Element, parts: string[], depth: number): void {
  if (depth > 20) return
  const children = node.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue
    const tag = localName(el)

    if (tag === "P") {
      const t = extractParagraphText(el)
      if (t) parts.push(t)
    } else if (tag === "TABLE") {
      // 중첩 테이블 — 텍스트로 평탄화
      parts.push("[중첩 테이블]")
    } else {
      collectCellText(el, parts, depth + 1)
    }
  }
}

// ─── XML 유틸 ────────────────────────────────────────────

function localName(el: Element): string {
  return (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
}

function findChild(parent: Element, tag: string): Element | null {
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType === 1 && localName(el) === tag) return el
  }
  return null
}

function textContent(el: Element): string {
  const children = el.childNodes
  const parts: string[] = []
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.nodeType === 3) {  // TEXT_NODE
      parts.push(node.nodeValue || "")
    } else if (node.nodeType === 1) {
      parts.push(textContent(node as Element))
    }
  }
  return parts.join("")
}

function countSections(body: Element): number {
  let count = 0
  const children = body.childNodes
  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType === 1 && localName(el) === "SECTION") count++
  }
  return count
}
