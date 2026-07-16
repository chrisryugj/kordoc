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
import { KordocError, precheckZipSize, stripDtd } from "../utils.js"
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
  if (result.length > 0) return result
  // 한셀(HCell) 등은 spreadsheetml을 접두사로 선언(<x:sheet>) — localName 폴백 매칭
  const nsNodes = parent.getElementsByTagNameNS?.("*", tagName)
  if (nsNodes) for (let i = 0; i < nsNodes.length; i++) result.push(nsNodes[i] as Element)
  return result
}

function getTextContent(el: Element): string {
  return el.textContent?.trim() ?? ""
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(stripDtd(text), "text/xml") as unknown as Document
}

// ─── 공유 문자열 파싱 ──────────────────────────────────

/** si/is 하위 t 텍스트 수집 — rPh(후리가나) 하위 t는 본문이 아니므로 제외 */
function collectRichText(root: Element): string {
  let out = ""
  const walk = (node: Element) => {
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      if (children[i].nodeType !== 1) continue
      const el = children[i] as Element
      const local = el.localName || el.tagName?.replace(/^[^:]+:/, "") || ""
      if (local === "rPh") continue
      if (local === "t") out += el.textContent ?? ""
      else walk(el)
    }
  }
  walk(root)
  return out
}

function parseSharedStrings(xml: string): string[] {
  const doc = parseXml(xml)
  const strings: string[] = []
  const siList = getElements(doc.documentElement, "si")
  for (const si of siList) {
    // <si><t>text</t></si> 또는 <si><r><t>text</t></r>...</si>
    strings.push(collectRichText(si))
  }
  return strings
}

// ─── 날짜 서식 판정 ────────────────────────────────────

export type DateKind = "date" | "datetime"

/** ECMA-376 내장 날짜 numFmtId (14~17: 날짜, 18~22·45~47: 시각 포함) */
const BUILTIN_DATE_FMT: ReadonlyMap<number, DateKind> = new Map<number, DateKind>([
  [14, "date"], [15, "date"], [16, "date"], [17, "date"],
  [18, "datetime"], [19, "datetime"], [20, "datetime"], [21, "datetime"], [22, "datetime"],
  [45, "datetime"], [46, "datetime"], [47, "datetime"],
])

/**
 * 커스텀 formatCode의 날짜 패턴 감지.
 * 따옴표 리터럴·[조건/색상]·\이스케이프를 제거한 뒤 y/m/d/h가 있으면 날짜,
 * 그중 h/s가 있으면 시간 포함(datetime)으로 분류. 날짜 아니면 null.
 */
export function classifyDateFormat(code: string): DateKind | null {
  const stripped = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "")
  if (!/[ymdh]/i.test(stripped)) return null
  return /[hs]/i.test(stripped) ? "datetime" : "date"
}

/** 내장/커스텀 numFmtId → 날짜 종류 (날짜 아니면 null) */
export function dateKindOfFmt(fmtId: number, customFormats: Map<number, string>): DateKind | null {
  const builtin = BUILTIN_DATE_FMT.get(fmtId)
  if (builtin) return builtin
  const code = customFormats.get(fmtId)
  return code !== undefined ? classifyDateFormat(code) : null
}

/**
 * Excel 날짜 시리얼 → ISO 문자열 (date1904 반영).
 * 1900 체계는 존재하지 않는 1900-02-29(시리얼 60) 이전 구간 보정.
 * 범위 밖(음수·year>9999)이면 null → 호출자가 원시값 유지.
 */
export function dateSerialToIso(serial: number, date1904: boolean, kind: DateKind): string | null {
  if (!isFinite(serial) || serial < 0) return null
  let days = serial
  if (date1904) days += 1462
  else if (days < 60) days += 1
  // 기준일 1899-12-30 — epoch(1970-01-01)의 시리얼은 25569
  const ms = Math.round((days - 25569) * 86400000)
  const d = new Date(ms)
  if (isNaN(d.getTime()) || d.getUTCFullYear() > 9999) return null
  const iso = d.toISOString()
  return kind === "datetime" ? iso.slice(0, 19) : iso.slice(0, 10)
}

/** styles.xml → cellXfs 인덱스별 날짜 서식 종류 (날짜 아닌 xf는 미포함) */
function parseStyleDateXfs(xml: string): Map<number, DateKind> {
  const doc = parseXml(xml)
  const customFormats = new Map<number, string>()
  for (const el of getElements(doc.documentElement, "numFmt")) {
    const id = parseInt(el.getAttribute("numFmtId") ?? "", 10)
    if (isNaN(id)) continue
    customFormats.set(id, el.getAttribute("formatCode") ?? "")
  }
  const dateXfs = new Map<number, DateKind>()
  const cellXfsEls = getElements(doc.documentElement, "cellXfs")
  if (cellXfsEls.length === 0) return dateXfs
  const xfs = getElements(cellXfsEls[0], "xf")
  for (let i = 0; i < xfs.length; i++) {
    const fmtId = parseInt(xfs[i].getAttribute("numFmtId") ?? "", 10)
    if (isNaN(fmtId)) continue
    const kind = dateKindOfFmt(fmtId, customFormats)
    if (kind) dateXfs.set(i, kind)
  }
  return dateXfs
}

// ─── 시트 목록 파싱 ─────────────────────────────────────

interface SheetInfo {
  name: string
  sheetId: string
  rId: string
}

function parseWorkbook(xml: string): { sheets: SheetInfo[]; date1904: boolean } {
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
  // workbookPr date1904 — 날짜 시리얼 기준 체계
  const prEls = getElements(doc.documentElement, "workbookPr")
  const d1904 = prEls.length > 0 ? prEls[0].getAttribute("date1904") : null
  return { sheets, date1904: d1904 === "1" || d1904 === "true" }
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
  dateXfs: Map<number, DateKind>,
  date1904: boolean,
): { grid: string[][]; merges: MergeInfo[]; maxRow: number; maxCol: number } {
  const doc = parseXml(xml)
  const grid: string[][] = []
  let maxRow = 0
  let maxCol = 0

  // 데이터 행 파싱
  const rows = getElements(doc.documentElement, "row")
  let prevRow = -1 // 직전 행 번호 — r 부재 행의 순차 유도용 (ECMA-376: r은 optional)
  for (const rowEl of rows) {
    const rAttr = rowEl.getAttribute("r")
    const rowNum = rAttr !== null ? parseInt(rAttr, 10) - 1 : prevRow + 1
    if (rowNum < 0 || rowNum >= MAX_ROWS) continue
    if (Number.isFinite(rowNum)) prevRow = rowNum

    const cells = getElements(rowEl, "c")
    let prevCol = -1 // 직전 셀 열 — r 부재 셀의 순차 유도용
    for (const cellEl of cells) {
      const ref = cellEl.getAttribute("r")
      const pos = ref !== null ? parseCellRef(ref) : { col: prevCol + 1, row: rowNum }
      // row도 col처럼 상한 검증 — "A5000000000" 하나로 그리드 폭주 방지
      if (!pos || !Number.isFinite(pos.row) || pos.row < 0 || pos.row >= MAX_ROWS || pos.col >= MAX_COLS) continue
      prevCol = pos.col

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
          // 날짜 서식 셀(s → cellXfs 날짜 판정)은 시리얼 → ISO 문자열
          if (type === null || type === "n") {
            const sAttr = cellEl.getAttribute("s")
            const kind = sAttr !== null ? dateXfs.get(parseInt(sAttr, 10)) : undefined
            if (kind) {
              const iso = dateSerialToIso(parseFloat(raw), date1904, kind)
              if (iso) value = iso
            }
          }
        }
      } else if (type === "inlineStr") {
        // <is><t>text</t></is>
        const isEl = getElements(cellEl, "is")
        if (isEl.length > 0) {
          value = collectRichText(isEl[0])
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
    // 범위 클램프 — 거대 mergeCell 하나로 병합 맵 폭주 방지 (XLS 쪽과 동일)
    if (m) {
      merges.push({
        startCol: Math.min(m.startCol, MAX_COLS - 1),
        startRow: Math.min(m.startRow, MAX_ROWS - 1),
        endCol: Math.min(m.endCol, MAX_COLS - 1),
        endRow: Math.min(m.endRow, MAX_ROWS - 1),
      })
    }
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
    // 스프레드시트는 스타일만 있는 잔여 셀이 흔해 후행 빈 열을 텍스트 기준으로 전부 트림 (#47)
    const table = buildTable(cellRows, { trimTrailingEmptyCols: true })
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
  const { sheets, date1904 } = parseWorkbook(await workbookFile.async("text"))
  if (sheets.length === 0) {
    throw new KordocError("XLSX 파일에 시트가 없습니다")
  }

  // 2.5 스타일 로드 — 날짜 서식 xf 판정 (실패 시 날짜 변환만 생략)
  let dateXfs = new Map<number, DateKind>()
  const stylesFile = zip.file("xl/styles.xml")
  if (stylesFile) {
    try {
      dateXfs = parseStyleDateXfs(await stylesFile.async("text"))
    } catch { /* 날짜 판정 실패는 무시 — 시리얼 숫자 그대로 출력 */ }
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
      const { grid, merges, maxRow, maxCol } = parseWorksheet(sheetXml, sharedStrings, dateXfs, date1904)
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
