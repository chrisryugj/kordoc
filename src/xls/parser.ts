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
  DT_GLOBALS,
  DT_WORKSHEET,
  type BiffRecord,
} from "./record.js"
import { decodeSST } from "./sst.js"
import { extractSheetCells, type RawSheet, type CellValue } from "./cell.js"
import { decodeUtf16Le } from "./encoding.js"

// ─── 상수 ─────────────────────────────────────────

const MAX_SHEETS = 100
const MAX_ROWS = 100_000
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
  /** Globals 서브스트림이 끝난 records 인덱스 */
  endIndex: number
}

function processGlobals(records: BiffRecord[]): GlobalsResult {
  const sheets: BoundSheet[] = []
  let codePage = 1200
  let encrypted = false

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
    }
    i++
  }

  // SST는 Globals 내부 어딘가 — 전체 records 검색하되 첫 EOF 이전만
  const globalsRecords = records.slice(0, i)
  const sst = decodeSST(globalsRecords)

  return { sheets, sst, codePage, encrypted, endIndex: i }
}

// ─── 시트 BOF 인덱스 찾기 ─────────────────────────

function findSheetBofIndex(records: BiffRecord[], lbPlyPos: number): number {
  // 정확한 매칭 우선
  const exact = records.findIndex(
    r => r.opcode === OP_BOF && r.offset === lbPlyPos,
  )
  if (exact >= 0) return exact

  // 못 찾으면 가장 가까운 BOF (관용)
  const bofIndices = records
    .map((r, idx) => (r.opcode === OP_BOF ? idx : -1))
    .filter(idx => idx >= 0)
  if (bofIndices.length === 0) return -1
  // 첫 BOF는 Globals → 두 번째부터 시트
  return bofIndices.length > 1 ? bofIndices[1] : -1
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
    const table = buildTable(cellRows)
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
      const { sheet } = extractSheetCells(records, bofIdx, globals.sst)
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
