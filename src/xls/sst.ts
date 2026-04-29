/**
 * BIFF8 Shared String Table 디코더.
 *
 * SST 레코드(0x00FC)는 데이터가 8224B를 초과하면 직후 CONTINUE(0x003C) 레코드로 분할됨.
 * 단순히 데이터를 이어붙이는 게 아니라, **각 CONTINUE 경계의 첫 바이트는 새 flags
 * 바이트로 재해석**해야 한다 (MS-XLS §2.4.265 ~ §2.4.272).
 *
 * 본 모듈은 SST + 후속 CONTINUE를 통합 버퍼로 만든 후, segments 경계를 활용해
 * XLUnicodeRichExtendedString을 순차 디코딩한다.
 *
 * 참조: docs/biff8-spec.md §3.3
 */

import { decodeCompressed, decodeUtf16Le } from "./encoding.js"
import { combineWithContinue, type BiffRecord, OP_SST } from "./record.js"

interface ParseStringResult {
  text: string
  consumed: number
}

/**
 * 단일 XLUnicodeRichExtendedString 디코딩.
 *
 * 구조 (가변):
 *   cch          u16     문자 수
 *   flags        u8      bit 0 fHighByte (1=UTF-16LE, 0=compressed)
 *                        bit 2 fExtSt
 *                        bit 3 fRichSt
 *   [cRun        u16]    rich text run 수 (fRichSt=1일 때만)
 *   [cbExtRst    u32]    확장 데이터 길이 (fExtSt=1일 때만)
 *   rgb          가변     문자 데이터 (compressed: cch바이트, uncompressed: 2*cch바이트)
 *   [richRuns    4*cRun] (fRichSt=1)
 *   [extRst      cbExtRst] (fExtSt=1)
 *
 * **CONTINUE 경계 처리**: 본 함수는 segments 정보를 받아 문자 데이터(rgb)가 경계를
 * 가로지르면 경계 직후 1바이트(새 flags)를 스킵하고 인코딩이 바뀌면 재해석한다.
 */
function parseString(
  buf: Buffer,
  offset: number,
  segments: number[],
): ParseStringResult | null {
  if (offset + 3 > buf.length) return null

  const cch = buf.readUInt16LE(offset)
  let flags = buf.readUInt8(offset + 2)
  let off = offset + 3

  let highByte = (flags & 0x01) !== 0
  const extSt = (flags & 0x04) !== 0
  const richSt = (flags & 0x08) !== 0

  let cRun = 0
  let cbExtRst = 0
  if (richSt) {
    if (off + 2 > buf.length) return null
    cRun = buf.readUInt16LE(off)
    off += 2
  }
  if (extSt) {
    if (off + 4 > buf.length) return null
    cbExtRst = buf.readUInt32LE(off)
    off += 4
  }

  // 문자 데이터 읽기 — CONTINUE 경계마다 새 flags 재해석
  // segments는 결합 버퍼 기준 경계 오프셋들. 첫 segment는 SST의 끝, 그 다음부터 CONTINUE 경계.
  const charBytes: Buffer[] = []
  let charsRead = 0

  while (charsRead < cch) {
    // 다음 경계 찾기
    const nextBoundary = segments.find(s => s > off) ?? buf.length

    const remainChars = cch - charsRead
    const bytesPerChar = highByte ? 2 : 1
    const bytesAvail = nextBoundary - off
    const charsInThisRun = Math.min(remainChars, Math.floor(bytesAvail / bytesPerChar))
    const bytesToRead = charsInThisRun * bytesPerChar

    if (bytesToRead > 0) {
      const slice = buf.subarray(off, off + bytesToRead)
      // highByte=0 (compressed) 처리: utf16le 통일을 위해 0x00 패딩 후 합칠 수도 있으나
      // 디코딩은 latin1로 따로 처리 후 string concat이 명확.
      charBytes.push(highByte ? slice : padToUtf16(slice))
      off += bytesToRead
      charsRead += charsInThisRun
    }

    if (charsRead < cch) {
      // 경계 진입 — 새 flags 1바이트
      if (off >= buf.length) return null
      flags = buf.readUInt8(off)
      highByte = (flags & 0x01) !== 0
      off += 1
    }
  }

  // 모든 charBytes는 utf16le로 통일된 상태 → 합쳐서 디코딩
  const text = decodeUtf16Le(Buffer.concat(charBytes))

  // rich runs 스킵
  if (richSt) off += 4 * cRun
  // extRst 스킵
  if (extSt) off += cbExtRst

  // 안전장치: 경계 넘침 방지
  if (off > buf.length) off = buf.length

  return { text, consumed: off - offset }
}

/** compressed (1바이트/문자) → utf16le (2바이트/문자) 패딩. */
function padToUtf16(compressed: Buffer): Buffer {
  const out = Buffer.alloc(compressed.length * 2)
  for (let i = 0; i < compressed.length; i++) {
    out[i * 2] = compressed[i]
    out[i * 2 + 1] = 0
  }
  return out
}

/**
 * 레코드 배열에서 SST를 찾아 디코딩한다.
 * SST가 없으면 빈 배열 반환.
 */
export function decodeSST(records: BiffRecord[]): string[] {
  const sstIndex = records.findIndex(r => r.opcode === OP_SST)
  if (sstIndex < 0) return []

  const { combined, segments } = combineWithContinue(records, sstIndex)
  if (combined.length < 8) return []

  // const cstTotal = combined.readUInt32LE(0)  // 참조 횟수 (사용 안 함)
  const cstUnique = combined.readUInt32LE(4)

  const strings: string[] = []
  let off = 8
  for (let i = 0; i < cstUnique && off < combined.length; i++) {
    const r = parseString(combined, off, segments)
    if (!r) break
    strings.push(r.text)
    off += r.consumed
  }

  return strings
}

// _ unused export silencer
void decodeCompressed
