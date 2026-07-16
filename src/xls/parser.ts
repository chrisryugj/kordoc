/**
 * XLS (BIFF8) 파서 — Workbook 스트림 → IRBlock[].
 *
 * 흐름:
 *   1. cfb-lenient로 OLE2 컨테이너 → "Workbook" 스트림 추출
 *   2. readRecords로 BIFF 레코드 시퀀스 파싱
 *   3. Globals 서브스트림: BoundSheet8 수집 + SST 디코딩
 *   4. 각 시트 BOF 인덱스 찾기 → extractSheetCells
 *   5. RawSheet → heading + IRTable 블록 변환
 *
 * 참조: docs/biff8-spec.md
 */

import type {
  IRBlock,
  CellContext,
  DocumentMetadata,
  InternalParseResult,
  ParseOptions,
  ParseWarning,
} from "../types.js"
import { KordocError } from "../utils.js"
import { buildTable, blocksToMarkdown } from "../table/builder.js"
import { parseLenientCfb } from "../hwp5/cfb-lenient.js"
import {
  readRecords,
  decodeBof,
  OP_BOF,
  OP_EOF,
  OP_BOUNDSHEET8,
  OP_FILEPASS,
  OP_CODEPAGE,
  OP_DATE1904,
  OP_FORMAT,
  OP_XF,
  DT_GLOBALS,
  DT_WORKSHEET,
  type BiffRecord,
} from "./record.js"
import { decodeSST } from "./sst.js"
import { extractSheetCells, type RawSheet, type CellValue } from "./cell.js"
import { decodeUtf16Le } from "./encoding.js"
import { dateKindOfFmt, dateSerialToIso, type DateKind } from "../xlsx/parser.js"

// ─── 상수 ─────────────────────────────────────────

const MAX_SHEETS = 100
/** BIFF8 실제 최대 행 수 (u16 주소 공간) — 밀집 그리드 상한 */
const MAX_ROWS = 65536
const MAX_COLS = 1_000

// ─── BoundSheet8 ─────────────────────────────────

interface BoundSheet {
  name: string
  /** Workbook 스트림 절대 오프셋 — 본 시트 BOF 위치 */
  lbPlyPos: number
  /** 0=Worksheet, 1=Chart, 2=Macro */
  dt: number
}

/**
 * BoundSheet8 레코드 디코딩.
 * 구조: lbPlyPos(4) hsState(1) dt(1) stName(ShortXLUnicodeString)
 *   ShortXLUnicodeString: cch(1) flags(1) chars(...)
 *   flags bit 0: 1=UTF-16LE, 0=compressed
 */
function decodeBoundSheet(data: Buffer): BoundSheet | null {
  if (data.length < 8) return null
  const lbPlyPos = data.readUInt32LE(0)
  const dt = data.readUInt8(5)
  const cch = data.readUInt8(6)
  const flags = data.readUInt8(7)
  const highByte = (flags & 0x01) !== 0
  const start = 8

  let name: string
  if (highByte) {
    const end = Math.min(start + cch * 2, data.length)
    name = decodeUtf16Le(data.subarray(start, end))
  } else {
    const end = Math.min(start + cch, data.length)
    const slice = data.subarray(start, end)
    const padded = Buffer.alloc(slice.length * 2)
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i]
    name = decodeUtf16Le(padded)
  }

  return { name, lbPlyPos, dt }
}

// ─── Globals 처리 ────────────────────────────────

interface GlobalsResult {
  sheets: BoundSheet[]
  sst: string[]
  codePage: number
  encrypted: boolean
  /** XF 인덱스(ixfe) → 날짜 서식 종류 (날짜 아닌 xf는 미포함) */
  dateXfs: Map<number, DateKind>
  /** DATE1904 레코드 — 1904 날짜 체계 */
  date1904: boolean
  /** Globals 서브스트림이 끝난 records 인덱스 */
  endIndex: number
}

/** Format 레코드(0x041E) 디코딩 — ifmt(2) + XLUnicodeString(cch(2) flags(1) rgb) */
function decodeFormatRecord(data: Buffer): { ifmt: number; code: string } | null {
  if (data.length < 5) return null
  const ifmt = data.readUInt16LE(0)
  const cch = data.readUInt16LE(2)
  const flags = data.readUInt8(4)
  const highByte = (flags & 0x01) !== 0
  const start = 5

  let code: string
  if (highByte) {
    const end = Math.min(start + cch * 2, data.length)
    code = decodeUtf16Le(data.subarray(start, end))
  } else {
    const end = Math.min(start + cch, data.length)
    const slice = data.subarray(start, end)
    const padded = Buffer.alloc(slice.length * 2)
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i]
    code = decodeUtf16Le(padded)
  }
  return { ifmt, code }
}

function processGlobals(records: BiffRecord[]): GlobalsResult {
  const sheets: BoundSheet[] = []
  let codePage = 1200
  let encrypted = false
  let date1904 = false
  const customFormats = new Map<number, string>()
  const xfFmtIds: number[] = [] // XF 레코드 순서 = ixfe 인덱스

  // 첫 BOF는 records[0]이어야 함
  const firstBof = records[0]
  if (!firstBof || firstBof.opcode !== OP_BOF) {
    throw new KordocError("XLS: 첫 레코드가 BOF가 아님")
  }
  const bof = decodeBof(firstBof.data)
  if (!bof || bof.dt !== DT_GLOBALS) {
    throw new KordocError("XLS: Globals 서브스트림 BOF 누락")
  }

  let i = 1
  while (i < records.length) {
    const r = records[i]
    if (r.opcode === OP_EOF) {
      i++
      break
    }
    if (r.opcode === OP_BOUNDSHEET8) {
      const bs = decodeBoundSheet(r.data)
      if (bs) sheets.push(bs)
    } else if (r.opcode === OP_CODEPAGE && r.data.length >= 2) {
      codePage = r.data.readUInt16LE(0)
    } else if (r.opcode === OP_FILEPASS) {
      encrypted = true
    } else if (r.opcode === OP_DATE1904 && r.data.length >= 2) {
      date1904 = r.data.readUInt16LE(0) === 1
    } else if (r.opcode === OP_FORMAT) {
      const f = decodeFormatRecord(r.data)
      if (f) customFormats.set(f.ifmt, f.code)
    } else if (r.opcode === OP_XF && r.data.length >= 4) {
      // XF 구조: ifnt(2) ifmt(2) ... — ifmt만 필요
      xfFmtIds.push(r.data.readUInt16LE(2))
    }
    i++
  }

  // XF 인덱스별 날짜 서식 판정 (내장 + 커스텀 Format)
  const dateXfs = new Map<number, DateKind>()
  for (let k = 0; k < xfFmtIds.length; k++) {
    const kind = dateKindOfFmt(xfFmtIds[k], customFormats)
    if (kind) dateXfs.set(k, kind)
  }

  // SST는 Globals 내부 어딘가 — 전체 records 검색하되 첫 EOF 이전만
  const globalsRecords = records.slice(0, i)
  const sst = decodeSST(globalsRecords)

  return { sheets, sst, codePage, encrypted, dateXfs, date1904, endIndex: i }
}

// ─── 시트 BOF 인덱스 찾기 ─────────────────────────

export function findSheetBofIndex(records: BiffRecord[], lbPlyPos: number): number {
  // 정확한 매칭 우선
  const exact = records.findIndex(
    r => r.opcode === OP_BOF && r.offset === lbPlyPos,
  )
  if (exact >= 0) return exact

  // 못 찾으면 최근접(오프셋 ≥ lbPlyPos) BOF — 일괄 두 번째 BOF 폴백은
  // 미매칭 시트가 전부 시트1 복제로 나오던 결함 (첫 BOF는 Globals라 제외)
  let best = -1
  let bestOffset = Infinity
  for (let idx = 1; idx < records.length; idx++) {
    const r = records[idx]
    if (r.opcode !== OP_BOF) continue
    if (r.offset >= lbPlyPos && r.offset < bestOffset) {
      best = idx
      bestOffset = r.offset
    }
  }
  return best
}

// ─── RawSheet → IRBlock[] ────────────────────────

function cellValueToText(v: CellValue): string {
  if (v === null || v === undefined) return ""
  if (typeof v === "number") {
    // 부동소수점 아티팩트 정리
    if (Number.isInteger(v)) return v.toString()
    const cleaned = parseFloat(v.toPrecision(15)).toString()
    return cleaned
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE"
  return v
}

function sheetToBlocks(
  sheetName: string,
  sheet: RawSheet,
  sheetIndex: number,
): IRBlock[] {
  const blocks: IRBlock[] = []

  if (sheetName) {
    blocks.push({
      type: "heading",
      text: sheetName,
      level: 2,
      pageNumber: sheetIndex + 1,
    })
  }

  if (sheet.cells.length === 0) return blocks

  // 그리드 크기 계산
  let maxRow = -1
  let maxCol = -1
  for (const c of sheet.cells) {
    if (c.row > maxRow) maxRow = c.row
    if (c.col > maxCol) maxCol = c.col
  }
  for (const m of sheet.merges) {
    if (m.r2 > maxRow) maxRow = m.r2
    if (m.c2 > maxCol) maxCol = m.c2
  }
  if (maxRow < 0 || maxCol < 0) return blocks

  // DOS 방어
  if (maxRow >= MAX_ROWS || maxCol >= MAX_COLS) {
    maxRow = Math.min(maxRow, MAX_ROWS - 1)
    maxCol = Math.min(maxCol, MAX_COLS - 1)
  }

  // 그리드 채우기
  const grid: string[][] = Array.from({ length: maxRow + 1 }, () =>
    Array(maxCol + 1).fill(""),
  )
  for (const c of sheet.cells) {
    if (c.row > maxRow || c.col > maxCol) continue
    grid[c.row][c.col] = cellValueToText(c.value)
  }

  // 병합 맵
  const mergeMap = new Map<string, { colSpan: number; rowSpan: number }>()
  const mergeSkip = new Set<string>()
  for (const m of sheet.merges) {
    const r1 = Math.min(m.r1, maxRow)
    const c1 = Math.min(m.c1, maxCol)
    const r2 = Math.min(m.r2, maxRow)
    const c2 = Math.min(m.c2, maxCol)
    mergeMap.set(`${r1},${c1}`, { colSpan: c2 - c1 + 1, rowSpan: r2 - r1 + 1 })
    for (let r = r1; r <= r2; r++) {
      for (let c = c1; c <= c2; c++) {
        if (r !== r1 || c !== c1) mergeSkip.add(`${r},${c}`)
      }
    }
  }

  // 유효 행 트리밍
  let firstRow = -1
  let lastRow = -1
  for (let r = 0; r <= maxRow; r++) {
    if (grid[r].some(v => v !== "")) {
      if (firstRow === -1) firstRow = r
      lastRow = r
    }
  }
  if (firstRow === -1) return blocks

  // CellContext[][] 빌드
  const cellRows: CellContext[][] = []
  for (let r = firstRow; r <= lastRow; r++) {
    const row: CellContext[] = []
    for (let c = 0; c <= maxCol; c++) {
      const key = `${r},${c}`
      if (mergeSkip.has(key)) continue
      const merge = mergeMap.get(key)
      row.push({
        text: grid[r][c],
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

// ─── 메인 ─────────────────────────────────────────

export async function parseXlsDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
): Promise<InternalParseResult> {
  const buf = Buffer.from(buffer)

  // 1. OLE2 컨테이너 → Workbook 스트림
  let cfb
  try {
    cfb = parseLenientCfb(buf)
  } catch (e) {
    throw new KordocError(
      `XLS: OLE2 시그니처 검증 실패 — ${e instanceof Error ? e.message : "알 수 없는 오류"}`,
    )
  }

  const wb = cfb.findStream("/Workbook") ?? cfb.findStream("/Book")
  if (!wb) {
    throw new KordocError("XLS: Workbook 스트림이 없음 (BIFF5 또는 비표준 파일)")
  }

  // 2. BIFF 레코드 시퀀스
  const records = readRecords(wb)
  if (records.length === 0) {
    throw new KordocError("XLS: 시그니처 레코드가 없음 (Workbook 스트림 손상)")
  }

  // 3. BIFF 버전 체크
  const firstBof = decodeBof(records[0].data)
  if (firstBof && firstBof.vers !== 0x0600) {
    throw new KordocError(
      `XLS: BIFF8(0x0600)만 지원 — 본 파일은 0x${firstBof.vers.toString(16)}`,
    )
  }

  // 4. Globals 처리
  const globals = processGlobals(records)
  const warnings: ParseWarning[] = []

  if (globals.encrypted) {
    return {
      markdown: "",
      blocks: [],
      metadata: { pageCount: globals.sheets.length },
      warnings: [
        {
          message: "XLS 파일이 암호화되어 있어 파싱할 수 없습니다",
          code: "PARTIAL_PARSE",
        },
      ],
    }
  }

  // 날짜 서식 셀 변환 훅 — 숫자 시리얼 → ISO 문자열
  const convertNum = globals.dateXfs.size > 0
    ? (n: number, ixfe: number): CellValue => {
        const kind = globals.dateXfs.get(ixfe)
        if (kind) {
          const iso = dateSerialToIso(n, globals.date1904, kind)
          if (iso) return iso
        }
        return n
      }
    : undefined

  // 5. 페이지/시트 필터
  const totalSheets = Math.min(globals.sheets.length, MAX_SHEETS)
  let pageFilter: Set<number> | null = null
  if (options?.pages) {
    const { parsePageRange } = await import("../page-range.js")
    pageFilter = parsePageRange(options.pages, totalSheets)
  }

  // 6. 각 시트 처리
  const allBlocks: IRBlock[] = []
  for (let i = 0; i < totalSheets; i++) {
    if (pageFilter && !pageFilter.has(i + 1)) continue
    const meta = globals.sheets[i]
    // BoundSheet8.dt: 0=Worksheet, 1=Macro, 2=Chart — 워크시트만 처리
    if (meta.dt !== 0) continue

    options?.onProgress?.(i + 1, totalSheets)

    const bofIdx = findSheetBofIndex(records, meta.lbPlyPos)
    if (bofIdx < 0) {
      warnings.push({
        page: i + 1,
        message: `시트 "${meta.name}" BOF를 찾을 수 없음 (lbPlyPos=${meta.lbPlyPos})`,
        code: "PARTIAL_PARSE",
      })
      continue
    }

    // 시트 BOF 검증
    const sheetBof = decodeBof(records[bofIdx].data)
    if (sheetBof && sheetBof.dt !== DT_WORKSHEET) {
      // 차트/매크로 등은 스킵
      continue
    }

    try {
      const { sheet } = extractSheetCells(records, bofIdx, globals.sst, convertNum)
      const blocks = sheetToBlocks(meta.name, sheet, i)
      allBlocks.push(...blocks)
    } catch (e) {
      warnings.push({
        page: i + 1,
        message: `시트 "${meta.name}" 파싱 실패: ${e instanceof Error ? e.message : "알 수 없는 오류"}`,
        code: "PARTIAL_PARSE",
      })
    }
  }

  // 7. 메타데이터
  const metadata: DocumentMetadata = {
    pageCount: totalSheets,
  }

  return {
    markdown: blocksToMarkdown(allBlocks),
    blocks: allBlocks,
    metadata,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}
