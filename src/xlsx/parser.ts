/**
 * XLSX (Office Open XML Spreadsheet) 파서
 *
 * ZIP + XML 구조를 jszip + xmldom으로 파싱하여 IRBlock[]로 변환.
 * 각 시트 → heading(시트명) + table(데이터) 블록.
 */

import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import type {
  IRBlock, IRTable, IRCell, CellContext, DocumentMetadata, InternalParseResult,
  ParseOptions, ParseWarning, ExtractedImage,
} from "../types.js"
import { KordocError, precheckZipSize } from "../utils.js"
import { buildTable, blocksToMarkdown } from "../table/builder.js"

// ─── 상수 ────────────────────────────────────────────

const MAX_SHEETS = 100
/** ZIP 압축 해제 누적 최대 크기 (100MB) — ZIP bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024
const MAX_ROWS = 10000
const MAX_COLS = 200

// ─── 숫자값 정리 ──────────────────────────────────────

/** 부동소수점 아티팩트 정리 (132.30000000000001 → 132.3) */
function cleanNumericValue(raw: string): string {
  if (!/^-?\d+\.\d+$/.test(raw)) return raw
  const num = parseFloat(raw)
  if (!isFinite(num)) return raw
  // toPrecision(15)로 IEEE 754 오차 제거 후 불필요한 후행 0 제거
  const cleaned = parseFloat(num.toPrecision(15)).toString()
  return cleaned
}

// ─── 셀 참조 파싱 ──────────────────────────────────────

/** "A1" → { col: 0, row: 0 }, "AB123" → { col: 27, row: 122 } */
function parseCellRef(ref: string): { col: number; row: number } | null {
  const m = ref.match(/^([A-Z]+)(\d+)$/)
  if (!m) return null
  let col = 0
  for (const ch of m[1]) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { col: col - 1, row: parseInt(m[2], 10) - 1 }
}

/** "A1:C3" → { startCol, startRow, endCol, endRow } */
function parseMergeRef(ref: string): { startCol: number; startRow: number; endCol: number; endRow: number } | null {
  const parts = ref.split(":")
  if (parts.length !== 2) return null
  const start = parseCellRef(parts[0])
  const end = parseCellRef(parts[1])
  if (!start || !end) return null
  return { startCol: start.col, startRow: start.row, endCol: end.col, endRow: end.row }
}

// ─── XML 헬퍼 ──────────────────────────────────────────

function getElements(parent: Element, tagName: string): Element[] {
  const nodes = parent.getElementsByTagName(tagName)
  const result: Element[] = []
  for (let i = 0; i < nodes.length; i++) result.push(nodes[i] as Element)
  return result
}

function getTextContent(el: Element): string {
  return el.textContent?.trim() ?? ""
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "text/xml")
}

// ─── 공유 문자열 파싱 ──────────────────────────────────

function parseSharedStrings(xml: string): string[] {
  const doc = parseXml(xml)
  const strings: string[] = []
  const siList = getElements(doc.documentElement, "si")
  for (const si of siList) {
    // <si><t>text</t></si> 또는 <si><r><t>text</t></r>...</si>
    const tElements = getElements(si, "t")
    strings.push(tElements.map(t => t.textContent ?? "").join(""))
  }
  return strings
}

// ─── 시트 목록 파싱 ─────────────────────────────────────

interface SheetInfo {
  name: string
  sheetId: string
  rId: string
}

function parseWorkbook(xml: string): SheetInfo[] {
  const doc = parseXml(xml)
  const sheets: SheetInfo[] = []
  const sheetElements = getElements(doc.documentElement, "sheet")
  for (const el of sheetElements) {
    sheets.push({
      name: el.getAttribute("name") ?? `Sheet${sheets.length + 1}`,
      sheetId: el.getAttribute("sheetId") ?? "",
      rId: el.getAttribute("r:id") ?? "",
    })
  }
  return sheets
}

/** workbook.xml.rels 파싱 → rId → target 매핑 */
function parseRels(xml: string): Map<string, string> {
  const doc = parseXml(xml)
  const map = new Map<string, string>()
  const rels = getElements(doc.documentElement, "Relationship")
  for (const rel of rels) {
    const id = rel.getAttribute("Id")
    const target = rel.getAttribute("Target")
    if (id && target) map.set(id, target)
  }
  return map
}

// ─── 워크시트 파싱 ──────────────────────────────────────

interface MergeInfo {
  startCol: number
  startRow: number
  endCol: number
  endRow: number
}

function parseWorksheet(
  xml: string,
  sharedStrings: string[],
): { grid: string[][]; merges: MergeInfo[]; maxRow: number; maxCol: number } {
  const doc = parseXml(xml)
  const grid: string[][] = []
  let maxRow = 0
  let maxCol = 0

  // 데이터 행 파싱
  const rows = getElements(doc.documentElement, "row")
  for (const rowEl of rows) {
    const rowNum = parseInt(rowEl.getAttribute("r") ?? "0", 10) - 1
    if (rowNum < 0 || rowNum >= MAX_ROWS) continue

    const cells = getElements(rowEl, "c")
    for (const cellEl of cells) {
      const ref = cellEl.getAttribute("r")
      if (!ref) continue
      const pos = parseCellRef(ref)
      if (!pos || pos.col >= MAX_COLS) continue

      // 값 추출
      const type = cellEl.getAttribute("t")
      const vElements = getElements(cellEl, "v")
      const fElements = getElements(cellEl, "f")
      let value = ""

      if (vElements.length > 0) {
        const raw = getTextContent(vElements[0])
        if (type === "s") {
          // shared string
          const idx = parseInt(raw, 10)
          value = sharedStrings[idx] ?? ""
        } else if (type === "b") {
          value = raw === "1" ? "TRUE" : "FALSE"
        } else {
          // 숫자값 부동소수점 아티팩트 정리 (9895607.8000000007 → 9895607.8)
          value = cleanNumericValue(raw)
        }
      } else if (type === "inlineStr") {
        // <is><t>text</t></is>
        const isEl = getElements(cellEl, "is")
        if (isEl.length > 0) {
          const tElements = getElements(isEl[0], "t")
          value = tElements.map(t => t.textContent ?? "").join("")
        }
      }

      // 수식이 있고 값이 없으면 수식 표시
      if (!value && fElements.length > 0) {
        value = `=${getTextContent(fElements[0])}`
      }

      // 그리드 확장
      while (grid.length <= pos.row) grid.push([])
      while (grid[pos.row].length <= pos.col) grid[pos.row].push("")
      grid[pos.row][pos.col] = value

      if (pos.row > maxRow) maxRow = pos.row
      if (pos.col > maxCol) maxCol = pos.col
    }
  }

  // 병합 셀 파싱
  const merges: MergeInfo[] = []
  const mergeCellElements = getElements(doc.documentElement, "mergeCell")
  for (const el of mergeCellElements) {
    const ref = el.getAttribute("ref")
    if (!ref) continue
    const m = parseMergeRef(ref)
    if (m) merges.push(m)
  }

  return { grid, merges, maxRow, maxCol }
}

// ─── 시트 → IRBlock[] 변환 ────────────────────────────

function sheetToBlocks(
  sheetName: string,
  grid: string[][],
  merges: MergeInfo[],
  maxRow: number,
  maxCol: number,
  sheetIndex: number,
): IRBlock[] {
  const blocks: IRBlock[] = []

  // 시트명 = heading
  if (sheetName) {
    blocks.push({
      type: "heading",
      text: sheetName,
      level: 2,
      pageNumber: sheetIndex + 1,
    })
  }

  // 빈 시트
  if (maxRow < 0 || maxCol < 0 || grid.length === 0) return blocks

  // 병합 맵: "row,col" → { colSpan, rowSpan }
  const mergeMap = new Map<string, { colSpan: number; rowSpan: number }>()
  const mergeSkip = new Set<string>()
  for (const m of merges) {
    const colSpan = m.endCol - m.startCol + 1
    const rowSpan = m.endRow - m.startRow + 1
    mergeMap.set(`${m.startRow},${m.startCol}`, { colSpan, rowSpan })
    for (let r = m.startRow; r <= m.endRow; r++) {
      for (let c = m.startCol; c <= m.endCol; c++) {
        if (r !== m.startRow || c !== m.startCol) {
          mergeSkip.add(`${r},${c}`)
        }
      }
    }
  }

  // 유효 행 범위 감지 (앞뒤 빈 행 제거)
  let firstRow = -1
  let lastRow = -1
  for (let r = 0; r <= maxRow; r++) {
    const row = grid[r]
    if (row && row.some(cell => cell !== "")) {
      if (firstRow === -1) firstRow = r
      lastRow = r
    }
  }
  if (firstRow === -1) return blocks

  // CellContext[][] → buildTable로 IRTable 생성 (2-pass 알고리즘 재사용)
  const cellRows: CellContext[][] = []

  for (let r = firstRow; r <= lastRow; r++) {
    const row: CellContext[] = []
    for (let c = 0; c <= maxCol; c++) {
      const key = `${r},${c}`
      if (mergeSkip.has(key)) continue

      const text = (grid[r] && grid[r][c]) ?? ""
      const merge = mergeMap.get(key)
      row.push({
        text,
        colSpan: merge?.colSpan ?? 1,
        rowSpan: merge?.rowSpan ?? 1,
      })
    }
    cellRows.push(row)
  }

  if (cellRows.length > 0) {
    const table = buildTable(cellRows)
    if (table.rows > 0) {
      blocks.push({ type: "table", table, pageNumber: sheetIndex + 1 })
    }
  }

  return blocks
}

// ─── 메인 파서 ─────────────────────────────────────────

export async function parseXlsxDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
): Promise<InternalParseResult> {
  // ZIP bomb 사전 검사
  precheckZipSize(buffer, MAX_DECOMPRESS_SIZE)

  const zip = await JSZip.loadAsync(buffer)
  const warnings: ParseWarning[] = []

  // XLSX 구조 검증
  const workbookFile = zip.file("xl/workbook.xml")
  if (!workbookFile) {
    throw new KordocError("유효하지 않은 XLSX 파일: xl/workbook.xml이 없습니다")
  }

  // 1. 공유 문자열 로드
  let sharedStrings: string[] = []
  const ssFile = zip.file("xl/sharedStrings.xml")
  if (ssFile) {
    sharedStrings = parseSharedStrings(await ssFile.async("text"))
  }

  // 2. 시트 목록 로드
  const sheets = parseWorkbook(await workbookFile.async("text"))
  if (sheets.length === 0) {
    throw new KordocError("XLSX 파일에 시트가 없습니다")
  }

  // 3. 관계 매핑 (rId → 파일 경로)
  let relsMap = new Map<string, string>()
  const relsFile = zip.file("xl/_rels/workbook.xml.rels")
  if (relsFile) {
    relsMap = parseRels(await relsFile.async("text"))
  }

  // 4. 페이지 필터
  let pageFilter: Set<number> | null = null
  if (options?.pages) {
    const { parsePageRange } = await import("../page-range.js")
    pageFilter = parsePageRange(options.pages, sheets.length)
  }

  // 5. 각 시트 파싱
  const blocks: IRBlock[] = []
  const processedSheets = Math.min(sheets.length, MAX_SHEETS)

  for (let i = 0; i < processedSheets; i++) {
    if (pageFilter && !pageFilter.has(i + 1)) continue

    const sheet = sheets[i]
    options?.onProgress?.(i + 1, processedSheets)

    // 시트 파일 경로 결정
    let sheetPath = relsMap.get(sheet.rId)
    if (sheetPath) {
      // 상대 경로 → 절대 경로
      if (!sheetPath.startsWith("xl/") && !sheetPath.startsWith("/")) {
        sheetPath = `xl/${sheetPath}`
      } else if (sheetPath.startsWith("/")) {
        sheetPath = sheetPath.slice(1)
      }
    } else {
      sheetPath = `xl/worksheets/sheet${i + 1}.xml`
    }

    const sheetFile = zip.file(sheetPath)
    if (!sheetFile) {
      warnings.push({
        page: i + 1,
        message: `시트 "${sheet.name}" 파일을 찾을 수 없습니다: ${sheetPath}`,
        code: "PARTIAL_PARSE",
      })
      continue
    }

    try {
      const sheetXml = await sheetFile.async("text")
      const { grid, merges, maxRow, maxCol } = parseWorksheet(sheetXml, sharedStrings)
      const sheetBlocks = sheetToBlocks(sheet.name, grid, merges, maxRow, maxCol, i)
      blocks.push(...sheetBlocks)
    } catch (err) {
      warnings.push({
        page: i + 1,
        message: `시트 "${sheet.name}" 파싱 실패: ${err instanceof Error ? err.message : "알 수 없는 오류"}`,
        code: "PARTIAL_PARSE",
      })
    }
  }

  // 6. 메타데이터 추출
  const metadata: DocumentMetadata = {
    pageCount: processedSheets,
  }
  const coreFile = zip.file("docProps/core.xml")
  if (coreFile) {
    try {
      const coreXml = await coreFile.async("text")
      const doc = parseXml(coreXml)
      const getFirst = (tag: string) => {
        const els = doc.getElementsByTagName(tag)
        return els.length > 0 ? (els[0].textContent ?? "").trim() : undefined
      }
      metadata.title = getFirst("dc:title") || getFirst("dcterms:title")
      metadata.author = getFirst("dc:creator")
      metadata.description = getFirst("dc:description")
      const created = getFirst("dcterms:created")
      if (created) metadata.createdAt = created
      const modified = getFirst("dcterms:modified")
      if (modified) metadata.modifiedAt = modified
    } catch { /* 메타데이터 실패는 무시 */ }
  }

  const markdown = blocksToMarkdown(blocks)

  return { markdown, blocks, metadata, warnings: warnings.length > 0 ? warnings : undefined }
}
