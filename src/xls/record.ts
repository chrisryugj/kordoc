/**
 * BIFF8 (Excel 97-2003) 레코드 리더.
 *
 * Workbook 스트림(OLE2 → cfb-lenient로 추출)에서 4바이트 헤더(opcode u16 + length u16)
 * 기반 레코드를 순차 읽어들인다. 길이가 8224를 초과하는 데이터는 직후 CONTINUE
 * 레코드로 분할되며, 본 모듈은 호출자가 원할 때 자동 결합 옵션을 제공한다.
 *
 * 참조: docs/biff8-spec.md §2~§3, [MS-XLS] §2.4
 */

// ─── Opcode 상수 ─────────────────────────────────────

export const OP_BOF = 0x0809
export const OP_EOF = 0x000a
export const OP_CONTINUE = 0x003c

// Globals 서브스트림
export const OP_BOUNDSHEET8 = 0x0085
export const OP_SST = 0x00fc
export const OP_EXTSST = 0x00ff
export const OP_CODEPAGE = 0x0042
export const OP_DATE1904 = 0x0022
export const OP_FILEPASS = 0x002f

// Worksheet 서브스트림 — 셀
export const OP_NUMBER = 0x0203
export const OP_RK = 0x027e
export const OP_MULRK = 0x00bd
export const OP_LABELSST = 0x00fd
export const OP_LABEL = 0x0204
export const OP_FORMULA = 0x0006
export const OP_STRING = 0x0207
export const OP_BOOLERR = 0x0205
export const OP_BLANK = 0x0201
export const OP_MULBLANK = 0x00be
export const OP_MERGECELLS = 0x00e5
export const OP_ROW = 0x0208

// BOF dt 필드 값
export const DT_GLOBALS = 0x0005
export const DT_WORKSHEET = 0x0010
export const DT_CHART = 0x0020
export const DT_MACRO = 0x0040

// ─── 타입 ──────────────────────────────────────────

export interface BiffRecord {
  opcode: number
  /** 본 레코드의 데이터 (CONTINUE 결합 안 한 raw) */
  data: Buffer
  /** Workbook 스트림 내 절대 오프셋 (헤더 시작 위치) — BoundSheet8 lbPlyPos 매칭용 */
  offset: number
}

// ─── 리더 ──────────────────────────────────────────

/** 비정상 파일에 의한 메모리 폭주 방지 */
const MAX_RECORDS = 1_000_000

/**
 * Workbook 스트림 전체에서 BIFF 레코드를 순차 읽는다.
 * CONTINUE 결합은 호출자 책임 (SST 디코딩 시점에서 처리).
 */
export function readRecords(stream: Buffer): BiffRecord[] {
  const out: BiffRecord[] = []
  let offset = 0

  while (offset + 4 <= stream.length && out.length < MAX_RECORDS) {
    const recOffset = offset
    const opcode = stream.readUInt16LE(offset)
    const length = stream.readUInt16LE(offset + 2)
    offset += 4

    if (offset + length > stream.length) {
      // 잘린 레코드 — lenient: 부분 데이터로 끊고 종료
      const data = stream.subarray(offset, stream.length)
      out.push({ opcode, data, offset: recOffset })
      break
    }

    const data = stream.subarray(offset, offset + length)
    out.push({ opcode, data, offset: recOffset })
    offset += length
  }

  return out
}

/**
 * 특정 레코드부터 직후 연속된 CONTINUE 레코드 데이터를 결합.
 * SST처럼 8224바이트를 초과해 분할되는 레코드 처리용.
 *
 * 반환: { combined: Buffer, segments: number[] }
 *   - combined: 결합된 데이터
 *   - segments: 각 CONTINUE 경계의 결합 후 오프셋 (디코딩 시 flags 재해석에 사용)
 */
export function combineWithContinue(
  records: BiffRecord[],
  startIndex: number,
): { combined: Buffer; segments: number[]; nextIndex: number } {
  const first = records[startIndex]
  const chunks: Buffer[] = [first.data]
  const segments: number[] = [first.data.length] // 첫 CONTINUE 경계
  let i = startIndex + 1
  let total = first.data.length

  while (i < records.length && records[i].opcode === OP_CONTINUE) {
    chunks.push(records[i].data)
    total += records[i].data.length
    segments.push(total)
    i++
  }

  return {
    combined: Buffer.concat(chunks),
    segments,
    nextIndex: i,
  }
}

// ─── BOF 헬퍼 ──────────────────────────────────────

export interface BofInfo {
  vers: number
  /** 서브스트림 타입 (DT_*) */
  dt: number
}

export function decodeBof(data: Buffer): BofInfo | null {
  if (data.length < 4) return null
  return {
    vers: data.readUInt16LE(0),
    dt: data.readUInt16LE(2),
  }
}

// ─── RK / MulRk 디코더 ─────────────────────────────

/**
 * RK 32bit 압축 숫자 디코딩.
 *
 * 비트 0 (fDiv100): 1이면 결과를 100으로 나눔
 * 비트 1 (fInt): 1이면 정수, 0이면 double
 * 비트 2~31: 30비트 값
 *
 * 정수: 30비트 부호확장.
 * double: 30비트를 double의 상위 30비트(63..34)에 배치, 하위 34비트는 0.
 */
export function decodeRk(rk: number): number {
  const fDiv100 = (rk & 0x01) !== 0
  const fInt = (rk & 0x02) !== 0
  const val30 = rk >> 2 // signed 31-bit shift, 그러나 30bit 부호확장 별도 처리

  let num: number
  if (fInt) {
    // 30bit signed → 부호확장
    num = val30 // JS의 >> 2는 산술시프트라 부호 유지됨
  } else {
    // double 복원: 30bit가 double의 상위 30bit (63..34)
    // 하위 34bit는 0. JS bitwise는 32bit이므로 BigInt 사용.
    const high32 = (rk & 0xfffffffc) >>> 0 // 상위 30bit + 하위 2bit(0)
    // double 비트 패턴: high32 << 32 | 0
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE(0, 0)
    buf.writeUInt32LE(high32, 4)
    num = buf.readDoubleLE(0)
  }

  return fDiv100 ? num / 100 : num
}

export interface MulRkCell {
  col: number
  ixfe: number
  value: number
}

/**
 * MulRk 레코드 디코딩.
 * data 구조: [row u16][colFirst u16][rkrec_0]...[rkrec_n][colLast u16]
 *   rkrec = [ixfe u16][rk u32] = 6바이트
 *
 * 반환: { row, cells: [{col, ixfe, value}, ...] }
 */
export function decodeMulRk(data: Buffer): { row: number; cells: MulRkCell[] } | null {
  if (data.length < 6) return null
  const row = data.readUInt16LE(0)
  const colFirst = data.readUInt16LE(2)
  const colLast = data.readUInt16LE(data.length - 2)
  const count = colLast - colFirst + 1
  if (count <= 0) return { row, cells: [] }

  const cells: MulRkCell[] = []
  let off = 4
  for (let i = 0; i < count && off + 6 <= data.length - 2; i++) {
    const ixfe = data.readUInt16LE(off)
    const rk = data.readUInt32LE(off + 2)
    cells.push({ col: colFirst + i, ixfe, value: decodeRk(rk) })
    off += 6
  }

  return { row, cells }
}

// ─── 일반 셀 헤더 (row, col, ixfe) ────────────────

export interface CellHeader {
  row: number
  col: number
  ixfe: number
}

export function readCellHeader(data: Buffer): CellHeader | null {
  if (data.length < 6) return null
  return {
    row: data.readUInt16LE(0),
    col: data.readUInt16LE(2),
    ixfe: data.readUInt16LE(4),
  }
}
