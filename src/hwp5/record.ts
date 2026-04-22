/** HWP 5.x 레코드 리더, UTF-16LE 텍스트 추출, 스트림 압축해제 */

import { inflateRawSync, inflateSync } from "zlib"
import { KordocError } from "../utils.js"

// ─── 레코드 태그 상수 ────────────────────────────────

export const TAG_PARA_HEADER = 0x0042
export const TAG_PARA_TEXT = 0x0043
export const TAG_CHAR_SHAPE = 0x0044
export const TAG_PARA_SHAPE = 0x0045
export const TAG_CTRL_HEADER = 0x0047
export const TAG_LIST_HEADER = 0x0048
export const TAG_TABLE = 0x004d
export const TAG_EQEDIT = 0x0058

// DocInfo 태그 (스타일 정보 해석용) — HWPTAG_BEGIN(0x0010) 기준
export const TAG_ID_MAPPINGS = 0x0011      // HWPTAG_BEGIN + 1
export const TAG_FACE_NAME = 0x0013        // HWPTAG_BEGIN + 3
export const TAG_DOC_CHAR_SHAPE = 0x0015   // HWPTAG_BEGIN + 5
export const TAG_DOC_PARA_SHAPE = 0x0019   // HWPTAG_BEGIN + 9
export const TAG_DOC_STYLE = 0x001a        // HWPTAG_BEGIN + 10

// 특수 문자 코드 (UTF-16LE) — HWP 5.0 바이너리 스펙 + rhwp 검증
// 3가지 카테고리: char(2바이트), inline(16바이트), extended(16바이트)
// char:     0, 13, 24-31           — 제어문자만, 확장 데이터 없음
// inline:   4-9, 19-20             — 제어문자(2) + 확장(14) = 16바이트
// extended: 1-3, 10-12, 14-18, 21-23 — 제어문자(2) + 확장(14) = 16바이트
const CHAR_LINE = 0x0000        // char: 줄바꿈
const CHAR_SECTION_BREAK = 0x000a  // extended: 구역/단 정의 (14바이트 확장 데이터)
const CHAR_PARA = 0x000d        // char: 문단 끝
const CHAR_TAB = 0x0009         // inline: 탭
const CHAR_HYPHEN = 0x001e      // char: 하이픈
const CHAR_NBSP = 0x001f        // char: 비분리 공백
const CHAR_FIXED_NBSP = 0x0018  // char: 고정 비분리 공백
const CHAR_FIXED_WIDTH = 0x0019 // char: 고정폭 공백

// FileHeader 플래그
export const FLAG_COMPRESSED = 1 << 0
export const FLAG_ENCRYPTED = 1 << 1
export const FLAG_DISTRIBUTION = 1 << 2
export const FLAG_DRM = 1 << 4

// ─── 레코드 구조 ─────────────────────────────────────

export interface HwpRecord {
  tagId: number
  level: number
  size: number
  data: Buffer
}

export interface HwpFileHeader {
  signature: string
  versionMajor: number
  flags: number
}

// ─── 레코드 리더 ─────────────────────────────────────

/** 최대 레코드 수 — 비정상 파일에 의한 메모리 폭주 방지 */
const MAX_RECORDS = 500_000

export function readRecords(data: Buffer): HwpRecord[] {
  const records: HwpRecord[] = []
  let offset = 0

  while (offset + 4 <= data.length && records.length < MAX_RECORDS) {
    const header = data.readUInt32LE(offset)
    offset += 4

    const tagId = header & 0x3ff
    const level = (header >> 10) & 0x3ff
    let size = (header >> 20) & 0xfff

    // 확장 크기
    if (size === 0xfff) {
      if (offset + 4 > data.length) break
      size = data.readUInt32LE(offset)
      offset += 4
    }

    if (offset + size > data.length) break
    records.push({ tagId, level, size, data: data.subarray(offset, offset + size) })
    offset += size
  }

  return records
}

// ─── 스트림 압축 해제 ────────────────────────────────

/** 압축 해제 최대 크기 (100MB) — decompression bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024

export function decompressStream(data: Buffer): Buffer {
  const opts = { maxOutputLength: MAX_DECOMPRESS_SIZE }
  if (data.length >= 2 && data[0] === 0x78) {
    try { return inflateSync(data, opts) } catch { /* fallback to raw */ }
  }
  return inflateRawSync(data, opts)
}

// ─── FileHeader 파싱 ─────────────────────────────────

export function parseFileHeader(data: Buffer): HwpFileHeader {
  if (data.length < 40) throw new KordocError("FileHeader가 너무 짧습니다 (최소 40바이트)")
  const sig = data.subarray(0, 32).toString("utf8").replace(/\0+$/, "")
  return {
    signature: sig,
    versionMajor: data[35],
    flags: data.readUInt32LE(36),
  }
}

// ─── 스타일 정보 구조 ────────────────────────────────

/** DocInfo에서 추출한 문단 모양 (PARA_SHAPE) */
export interface HwpParaShape {
  /** 개요 수준: 0=본문, 1-7=개요수준 1-7 (heading 계층) */
  outlineLevel: number
}

/** DocInfo에서 추출한 글자 모양 (CHAR_SHAPE) */
export interface HwpCharShape {
  /** 글꼴 크기 (단위: 0.1pt, 예: 100 = 10pt) */
  fontSize: number
  /**
   * 속성 플래그 (HWP5 바이너리 스펙 1.1 기준):
   * bit 0 = italic, bit 1 = bold, bit 2 = underline, bit 3 = outline
   * 검증 완료: 공식 스펙 + pyhwp/hwp.js 등 오픈소스 파서와 일치 (v1.7)
   */
  attrFlags: number
}

/** DocInfo에서 추출한 스타일 */
export interface HwpStyle {
  name: string
  /** 한글 이름 (UTF-16LE) */
  nameKo: string
  /** 연결된 charShape 인덱스 */
  charShapeId: number
  /** 연결된 paraShape 인덱스 */
  paraShapeId: number
  /** 스타일 타입: 0=paragraph, 1=character */
  type: number
}

/** DocInfo 파싱 결과 */
export interface HwpDocInfo {
  charShapes: HwpCharShape[]
  paraShapes: HwpParaShape[]
  styles: HwpStyle[]
}

/** DocInfo 레코드들에서 스타일 정보 추출 */
export function parseDocInfo(records: HwpRecord[]): HwpDocInfo {
  const charShapes: HwpCharShape[] = []
  const paraShapes: HwpParaShape[] = []
  const styles: HwpStyle[] = []

  for (const rec of records) {
    // PARA_SHAPE — 문단 모양 (개요 수준 추출)
    // 첫 4바이트(u32) 비트 팩: bits 25-27 = 개요 수준 (0=본문, 1-7=heading)
    if (rec.tagId === TAG_DOC_PARA_SHAPE && rec.data.length >= 4) {
      const flags = rec.data.readUInt32LE(0)
      const outlineLevel = (flags >> 25) & 0x07 // bits 25-27 → 3bit (0-7)
      paraShapes.push({ outlineLevel })
    }

    if (rec.tagId === TAG_DOC_CHAR_SHAPE && rec.data.length >= 18) {
      // HWP5 CHAR_SHAPE 구조 (바이너리 스펙 1.1 기준):
      //   faceId: 7개 언어 * u16 = 14바이트 (offset 0-13)
      //   ratio:  7개 언어 * u8  =  7바이트 (offset 14-20)
      //   spacing: 7개 언어 * s8 =  7바이트 (offset 21-27)
      //   relSize: 7개 언어 * u8 =  7바이트 (offset 28-34)
      //   charOffset: 7개 언어 * s8 = 7바이트 (offset 35-41)
      //   baseSize: u32 at offset 42 (단위: 0.1pt)
      //   attrFlags: u32 at offset 46 (bit0=italic, bit1=bold) — 공식 스펙 검증 완료
      if (rec.data.length >= 50) {
        const fontSize = rec.data.readUInt32LE(42)  // 단위: 0.1pt
        const attrFlags = rec.data.readUInt32LE(46)
        charShapes.push({ fontSize, attrFlags })
      } else {
        // 짧은 레코드 — 스타일 정보 없음
        charShapes.push({ fontSize: 0, attrFlags: 0 })
      }
    }

    if (rec.tagId === TAG_DOC_STYLE && rec.data.length >= 8) {
      try {
        // STYLE 구조: nameLen(u16) + name(UTF-16LE) + nameKoLen(u16) + nameKo(UTF-16LE)
        // + type(u8) + nextStyleId(u16) + langId(s16) + paraShapeId(u16) + charShapeId(u16)
        let offset = 0
        const nameLen = rec.data.readUInt16LE(offset); offset += 2
        const nameBytes = nameLen * 2
        const name = nameBytes > 0 && offset + nameBytes <= rec.data.length
          ? rec.data.subarray(offset, offset + nameBytes).toString("utf16le")
          : ""
        offset += nameBytes

        let nameKo = ""
        if (offset + 2 <= rec.data.length) {
          const nameKoLen = rec.data.readUInt16LE(offset); offset += 2
          const nameKoBytes = nameKoLen * 2
          if (nameKoBytes > 0 && offset + nameKoBytes <= rec.data.length) {
            nameKo = rec.data.subarray(offset, offset + nameKoBytes).toString("utf16le")
          }
          offset += nameKoBytes
        }

        // type(u8) + nextStyleId(u16) + langId(s16) + paraShapeId(u16) + charShapeId(u16)
        const type = offset < rec.data.length ? rec.data.readUInt8(offset) : 0; offset += 1
        offset += 2 // nextStyleId
        offset += 2 // langId
        const paraShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0; offset += 2
        const charShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0

        styles.push({ name, nameKo, charShapeId, paraShapeId, type })
      } catch {
        // 파싱 실패 — 스킵
      }
    }
  }

  return { charShapes, paraShapes, styles }
}

// ─── UTF-16LE 텍스트 추출 (21가지 제어문자 처리) ─────

export type InlineControlResolver = (ctrlId: string) => string | null | undefined

export function extractText(data: Buffer): string {
  return extractTextWithControls(data)
}

export function extractTextWithControls(data: Buffer, resolveControl?: InlineControlResolver): string {
  let result = ""
  let i = 0

  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    i += 2

    switch (ch) {
      // ── char 타입 (2바이트만, 확장 데이터 없음) ──
      case CHAR_LINE: result += "\n"; break
      case CHAR_SECTION_BREAK: { // 구역/단 정의 또는 일부 inline control 래퍼
        // 일부 HWP5 문서는 수식 placeholder를 0x000a + 0x000b + ctrlId + payload + 0x000b로 저장한다.
        if (i + 16 <= data.length && data.readUInt16LE(i) === 0x000b) {
          const ctrlId = data.subarray(i + 2, i + 6).toString("ascii")
          const replacement = resolveControl?.(ctrlId)
          if (replacement) result += replacement
          i += 16
          break
        }
        result += "\n"
        if (i + 14 <= data.length) i += 14
        break
      }
      case CHAR_PARA: break  // 문단 끝
      case CHAR_HYPHEN: result += "-"; break
      case CHAR_NBSP: result += " "; break
      case CHAR_FIXED_NBSP: result += "\u00a0"; break  // 진짜 NBSP
      case CHAR_FIXED_WIDTH: result += " "; break  // 고정폭 공백

      // ── inline 타입 (2바이트 + 14바이트 확장) ──
      case CHAR_TAB:
        result += "\t"
        if (i + 14 <= data.length) i += 14
        break

      default:
        if (ch >= 0x0001 && ch <= 0x001f) {
          // rhwp 기준 3-카테고리 분류:
          // extended(1-3, 11-12, 14-18, 21-23) + inline(4-9, 19-20) → 14바이트 스킵
          // char(24-31) → 스킵 없음 (이미 switch에서 24,25,30,31 처리됨)
          const isExtended = (ch >= 1 && ch <= 3) || (ch >= 11 && ch <= 12) || (ch >= 14 && ch <= 18) || (ch >= 21 && ch <= 23)
          const isInline = (ch >= 4 && ch <= 9) || (ch >= 19 && ch <= 20)
          if ((isExtended || isInline) && i + 14 <= data.length) {
            const ctrlId = data.subarray(i, i + 4).toString("ascii")
            const replacement = resolveControl?.(ctrlId)
            if (replacement) result += replacement
            i += 14
          }
        } else if (ch >= 0x0020) {
          // UTF-16 surrogate pair 처리 (BMP 외 문자: 이모지, CJK 확장 등)
          if (ch >= 0xd800 && ch <= 0xdbff && i + 1 < data.length) {
            const lo = data.readUInt16LE(i)
            if (lo >= 0xdc00 && lo <= 0xdfff) {
              i += 2
              const codePoint = ((ch - 0xd800) << 10) + (lo - 0xdc00) + 0x10000
              result += String.fromCodePoint(codePoint)
              break
            }
          }
          result += String.fromCharCode(ch)
        }
        break
    }
  }

  return result
}

/** HWP5 EQEDIT(0x58) 레코드에서 한글 수식 스크립트 원문 추출 */
export function extractEquationText(data: Buffer): string | null {
  if (data.length < 6) return null

  const scriptLength = data.readUInt16LE(4)
  const scriptStart = 6
  const scriptEnd = scriptStart + scriptLength * 2
  if (scriptLength <= 0 || scriptEnd > data.length) return null

  const equation = data.subarray(scriptStart, scriptEnd).toString("utf16le").replace(/\0+/g, "").trim()
  return equation || null
}
