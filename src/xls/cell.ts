/**
 * BIFF8 Worksheet 서브스트림의 셀 레코드 → RawCell 변환.
 *
 * 처리 대상: Number, RK, MulRk, LabelSst, BoolErr, Formula(+String), Label, Blank, MulBlank, MergeCells
 * 무시: Row 메타, GUTS, Header/Footer, Window 등
 *
 * 참조: docs/biff8-spec.md §3.4, §3.5
 */

import {
  OP_NUMBER,
  OP_RK,
  OP_MULRK,
  OP_LABELSST,
  OP_LABEL,
  OP_FORMULA,
  OP_STRING,
  OP_BOOLERR,
  OP_BLANK,
  OP_MULBLANK,
  OP_MERGECELLS,
  OP_BOF,
  OP_EOF,
  decodeMulRk,
  decodeRk,
  readCellHeader,
  type BiffRecord,
} from "./record.js"
import { decodeUtf16Le } from "./encoding.js"

export type CellValue = string | number | boolean | null

export interface RawCell {
  row: number
  col: number
  value: CellValue
}

export interface MergeRange {
  r1: number
  c1: number
  r2: number
  c2: number
}

export interface RawSheet {
  /** 시트 시작 BOF의 절대 오프셋 */
  bofOffset: number
  cells: RawCell[]
  merges: MergeRange[]
}

/** BIFF8 표준 에러 코드 → 표시 문자열 */
function errorCodeToText(code: number): string {
  switch (code) {
    case 0x00:
      return "#NULL!"
    case 0x07:
      return "#DIV/0!"
    case 0x0f:
      return "#VALUE!"
    case 0x17:
      return "#REF!"
    case 0x1d:
      return "#NAME?"
    case 0x24:
      return "#NUM!"
    case 0x2a:
      return "#N/A"
    default:
      return `#ERR${code}`
  }
}

/**
 * BIFF8 Label 레코드의 단순 문자열 디코딩.
 * 구조: row(2) col(2) ixfe(2) cch(2) flags(1) rgb(...)
 * - flags bit 0: 1=UTF-16LE, 0=compressed
 */
function decodeLabelString(data: Buffer): string {
  if (data.length < 9) return ""
  const cch = data.readUInt16LE(6)
  const flags = data.readUInt8(8)
  const highByte = (flags & 0x01) !== 0
  const start = 9

  if (highByte) {
    const end = Math.min(start + cch * 2, data.length)
    return decodeUtf16Le(data.subarray(start, end))
  } else {
    const end = Math.min(start + cch, data.length)
    // compressed → utf16 패딩 후 디코딩
    const slice = data.subarray(start, end)
    const padded = Buffer.alloc(slice.length * 2)
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i]
    return decodeUtf16Le(padded)
  }
}

/**
 * Formula 레코드의 결과값 디코딩.
 *   val 8바이트:
 *     val[6..8] == 0xFFFF 이고:
 *       val[0]=0x00: 결과가 문자열 → 직후 String 레코드 참조
 *       val[0]=0x01: boolean → val[2] (0/1)
 *       val[0]=0x02: error → val[2]
 *       val[0]=0x03: empty
 *     그 외: double로 해석
 *
 * 반환:
 *   - 문자열 결과 신호: { kind: 'stringRef' }
 *   - 그 외: { kind: 'value', value: ... }
 */
type FormulaResult =
  | { kind: "stringRef" }
  | { kind: "value"; value: CellValue }

function decodeFormulaResult(val: Buffer): FormulaResult {
  if (val.length < 8) return { kind: "value", value: null }
  const tail = val.readUInt16LE(6)
  if (tail === 0xffff) {
    const code = val.readUInt8(0)
    if (code === 0x00) return { kind: "stringRef" }
    if (code === 0x01) return { kind: "value", value: val.readUInt8(2) === 1 }
    if (code === 0x02) return { kind: "value", value: errorCodeToText(val.readUInt8(2)) }
    return { kind: "value", value: null } // empty
  }
  return { kind: "value", value: val.readDoubleLE(0) }
}

/**
 * Formula 직후의 String 레코드에서 결과 문자열 디코딩.
 * 구조: cch(2) flags(1) rgb(...)
 */
function decodeFormulaStringRecord(data: Buffer): string {
  if (data.length < 3) return ""
  const cch = data.readUInt16LE(0)
  const flags = data.readUInt8(2)
  const highByte = (flags & 0x01) !== 0
  const start = 3

  if (highByte) {
    const end = Math.min(start + cch * 2, data.length)
    return decodeUtf16Le(data.subarray(start, end))
  } else {
    const end = Math.min(start + cch, data.length)
    const slice = data.subarray(start, end)
    const padded = Buffer.alloc(slice.length * 2)
    for (let i = 0; i < slice.length; i++) padded[i * 2] = slice[i]
    return decodeUtf16Le(padded)
  }
}

/**
 * 단일 Worksheet 서브스트림 (BOF~EOF) 의 셀 레코드 추출.
 * @param records 전체 레코드 배열
 * @param bofIndex 본 시트 BOF의 records 인덱스
 * @param sst 디코딩된 SST
 * @returns RawSheet — 다음 시트로 넘어갈 수 있는 endIndex 포함
 */
export function extractSheetCells(
  records: BiffRecord[],
  bofIndex: number,
  sst: string[],
): { sheet: RawSheet; endIndex: number } {
  const cells: RawCell[] = []
  const merges: MergeRange[] = []
  const bofOffset = records[bofIndex].offset

  let i = bofIndex + 1
  while (i < records.length) {
    const rec = records[i]
    if (rec.opcode === OP_EOF) {
      i++
      break
    }
    if (rec.opcode === OP_BOF) {
      // 새 서브스트림 시작 — 안전장치
      break
    }

    switch (rec.opcode) {
      case OP_NUMBER: {
        const h = readCellHeader(rec.data)
        if (h && rec.data.length >= 14) {
          cells.push({ row: h.row, col: h.col, value: rec.data.readDoubleLE(6) })
        }
        break
      }
      case OP_RK: {
        const h = readCellHeader(rec.data)
        if (h && rec.data.length >= 10) {
          cells.push({ row: h.row, col: h.col, value: decodeRk(rec.data.readInt32LE(6)) })
        }
        break
      }
      case OP_MULRK: {
        const m = decodeMulRk(rec.data)
        if (m) {
          for (const c of m.cells) {
            cells.push({ row: m.row, col: c.col, value: c.value })
          }
        }
        break
      }
      case OP_LABELSST: {
        const h = readCellHeader(rec.data)
        if (h && rec.data.length >= 10) {
          const isst = rec.data.readUInt32LE(6)
          cells.push({ row: h.row, col: h.col, value: sst[isst] ?? "" })
        }
        break
      }
      case OP_LABEL: {
        const h = readCellHeader(rec.data)
        if (h) {
          cells.push({ row: h.row, col: h.col, value: decodeLabelString(rec.data) })
        }
        break
      }
      case OP_FORMULA: {
        const h = readCellHeader(rec.data)
        if (h && rec.data.length >= 14) {
          const result = decodeFormulaResult(rec.data.subarray(6, 14))
          if (result.kind === "stringRef") {
            // 직후 String 레코드 찾기
            const next = records[i + 1]
            if (next && next.opcode === OP_STRING) {
              cells.push({
                row: h.row,
                col: h.col,
                value: decodeFormulaStringRecord(next.data),
              })
              i++ // String 레코드 건너뛰기
            } else {
              cells.push({ row: h.row, col: h.col, value: "" })
            }
          } else {
            cells.push({ row: h.row, col: h.col, value: result.value })
          }
        }
        break
      }
      case OP_BOOLERR: {
        const h = readCellHeader(rec.data)
        if (h && rec.data.length >= 8) {
          const v = rec.data.readUInt8(6)
          const isErr = rec.data.readUInt8(7) === 1
          if (isErr) {
            cells.push({ row: h.row, col: h.col, value: errorCodeToText(v) })
          } else {
            cells.push({ row: h.row, col: h.col, value: v === 1 })
          }
        }
        break
      }
      case OP_BLANK:
      case OP_MULBLANK: {
        // 빈 셀은 결과 그리드에서 자연 처리됨 — 명시적 추가 안 함
        break
      }
      case OP_MERGECELLS: {
        // [cmcs u16][Ref8U[cmcs] (각 8바이트: rwFirst rwLast colFirst colLast)]
        if (rec.data.length >= 2) {
          const cmcs = rec.data.readUInt16LE(0)
          let off = 2
          for (let k = 0; k < cmcs && off + 8 <= rec.data.length; k++) {
            const r1 = rec.data.readUInt16LE(off)
            const r2 = rec.data.readUInt16LE(off + 2)
            const c1 = rec.data.readUInt16LE(off + 4)
            const c2 = rec.data.readUInt16LE(off + 6)
            merges.push({ r1, c1, r2, c2 })
            off += 8
          }
        }
        break
      }
      default:
        // 무시 (Row, Window, GUTS, etc)
        break
    }

    i++
  }

  return {
    sheet: { bofOffset, cells, merges },
    endIndex: i,
  }
}
