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
export const TAG_SHAPE_COMPONENT = 0x004c           // HWPTAG_BEGIN + 60
export const TAG_SHAPE_COMPONENT_PICTURE = 0x0055   // HWPTAG_BEGIN + 69
export const TAG_SHAPE_COMPONENT_CONTAINER = 0x0056 // HWPTAG_BEGIN + 70
export const TAG_CTRL_DATA = 0x0057                 // HWPTAG_BEGIN + 71
export const TAG_EQEDIT = 0x0058

// DocInfo 태그 (스타일 정보 해석용) — HWPTAG_BEGIN(0x0010) 기준
export const TAG_ID_MAPPINGS = 0x0011      // HWPTAG_BEGIN + 1
export const TAG_BIN_DATA = 0x0012         // HWPTAG_BEGIN + 2
export const TAG_FACE_NAME = 0x0013        // HWPTAG_BEGIN + 3
export const TAG_DOC_CHAR_SHAPE = 0x0015   // HWPTAG_BEGIN + 5
export const TAG_NUMBERING = 0x0017        // HWPTAG_BEGIN + 7
export const TAG_BULLET = 0x0018           // HWPTAG_BEGIN + 8
export const TAG_DOC_PARA_SHAPE = 0x0019   // HWPTAG_BEGIN + 9
export const TAG_DOC_STYLE = 0x001a        // HWPTAG_BEGIN + 10

// 특수 문자 코드 (UTF-16LE) — HWP 5.0 바이너리 스펙 + rhwp 검증
// 3가지 카테고리: char(2바이트), inline(16바이트), extended(16바이트)
// char:     0, 13, 24-31           — 제어문자만, 확장 데이터 없음
// inline:   4-9, 19-20             — 제어문자(2) + 확장(14) = 16바이트
// extended: 1-3, 10-12, 14-18, 21-23 — 제어문자(2) + 확장(14) = 16바이트
const CHAR_LINE = 0x0000        // char: 줄바꿈
const CHAR_SECTION_BREAK = 0x000a  // char: 강제 줄 나눔(line break, 2바이트). 구역/단 정의는 코드2(extended)라 혼동 주의
const CHAR_PARA = 0x000d        // char: 문단 끝
const CHAR_TAB = 0x0009         // inline: 탭
const CHAR_HYPHEN = 0x0018      // char: 하이픈 (스펙 코드 24 — pyhwp HYPHEN, hwp3 SIMPLE_CTRL 24/25와 동일)
const CHAR_NBSP = 0x001e        // char: 묶음 빈칸(비분리 공백, 스펙 코드 30 — pyhwp NONBREAK_SPACE)
const CHAR_FIXED_WIDTH = 0x001f // char: 고정폭 빈칸 (스펙 코드 31 — pyhwp FIXWIDTH_SPACE). 25~29(0x19~0x1d)는 예약

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
  /** 문단 머리 종류 (attr1 bits 23-24): 0=없음, 1=개요, 2=번호, 3=글머리표 */
  headType: number
  /** 문단 수준 (attr1 bits 25-27): 0-6 → 1-7수준 */
  paraLevel: number
  /** 번호/글머리표 ID (1-based) — headType=2면 numbering, 3이면 bullet 인덱스 */
  numberingId: number
}

/** DocInfo BIN_DATA 항목 — binDataId(1-based 레코드 순서) → BinData 스토리지 매핑 */
export interface HwpBinDataItem {
  /** 0=link(외부 파일), 1=embedding, 2=storage */
  kind: "link" | "embed" | "storage"
  /** BinData 스토리지 엔트리 번호 — 스트림명 "BIN%04X.ext" (16진) */
  storageId: number
  /** 확장자 (예: "jpg") */
  extension: string
}

/** DocInfo NUMBERING — 문단 번호 정의 (7수준) */
export interface HwpNumbering {
  /** 수준별(0-6) 번호 형식 문자열 (예: "^1.") — ^N은 N수준 번호로 치환 */
  levelFormats: string[]
  /** 수준별 번호 모양 코드 (HWP 표 43: 0=숫자, 1=원숫자, 8=가나다, 12=일이삼, 13=一二三 등) */
  numberFormats: number[]
  /** 수준별 시작 번호 (5.0.2.5+, 기본 1) */
  startNumbers: number[]
}

/** DocInfo BULLET — 글머리표 문자 */
export interface HwpBullet {
  /** 글머리표 문자 (PUA 가능 — 출력 시 mapPuaText로 정규화됨), U+FFFF=이미지 글머리표 */
  char: string
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
  /** BIN_DATA 항목 (1-based binDataId → binData[id-1]) */
  binData: HwpBinDataItem[]
  /** NUMBERING 정의 (1-based numberingId → numberings[id-1]) */
  numberings: HwpNumbering[]
  /** BULLET 정의 (1-based bulletId → bullets[id-1]) */
  bullets: HwpBullet[]
}

/** length-prefixed UTF-16LE 문자열 읽기 (HWP WCHAR 배열) */
function readHwpString(data: Buffer, offset: number): { value: string; next: number } {
  if (offset + 2 > data.length) return { value: "", next: data.length }
  const len = data.readUInt16LE(offset)
  const start = offset + 2
  const end = start + len * 2
  if (len === 0 || end > data.length) return { value: "", next: start }
  return { value: data.subarray(start, end).toString("utf16le"), next: end }
}

/** DocInfo 레코드들에서 스타일 정보 추출 */
export function parseDocInfo(records: HwpRecord[]): HwpDocInfo {
  const charShapes: HwpCharShape[] = []
  const paraShapes: HwpParaShape[] = []
  const styles: HwpStyle[] = []
  const binData: HwpBinDataItem[] = []
  const numberings: HwpNumbering[] = []
  const bullets: HwpBullet[] = []

  for (const rec of records) {
    // PARA_SHAPE — 문단 모양 (rhwp doc_info.rs parse_para_shape)
    // attr1(u32@0) 비트 팩: bits 23-24 = 머리 종류, bits 25-27 = 문단 수준
    // numberingId: u16@30 (attr1 4 + 여백/간격 i32*6 = 24 + tabDefId 2 → offset 30)
    if (rec.tagId === TAG_DOC_PARA_SHAPE && rec.data.length >= 4) {
      const attr1 = rec.data.readUInt32LE(0)
      const headType = (attr1 >>> 23) & 0x03
      const paraLevel = (attr1 >>> 25) & 0x07
      const numberingId = rec.data.length >= 32 ? rec.data.readUInt16LE(30) : 0
      paraShapes.push({ headType, paraLevel, numberingId })
    }

    // BIN_DATA — binDataId(레코드 순서 1-based) → 스토리지 ID(16진)/확장자 매핑
    // (rhwp doc_info.rs parse_bin_data: attr u16 → type/compression/status)
    if (rec.tagId === TAG_BIN_DATA && rec.data.length >= 2) {
      const attr = rec.data.readUInt16LE(0)
      const typeBits = attr & 0x000f
      if (typeBits === 0) {
        // link: absPath + relPath (외부 파일 — 스토리지 없음)
        binData.push({ kind: "link", storageId: 0, extension: "" })
      } else {
        const storageId = rec.data.length >= 4 ? rec.data.readUInt16LE(2) : 0
        const { value: extension } = readHwpString(rec.data, 4)
        binData.push({ kind: typeBits === 2 ? "storage" : "embed", storageId, extension })
      }
    }

    // NUMBERING — 문단 번호 정의 (rhwp doc_info.rs parse_numbering, HWP 표 40/41)
    if (rec.tagId === TAG_NUMBERING && rec.data.length >= 14) {
      const levelFormats: string[] = []
      const numberFormats: number[] = []
      const startNumbers: number[] = [1, 1, 1, 1, 1, 1, 1]
      let offset = 0
      for (let level = 0; level < 7; level++) {
        if (offset + 12 > rec.data.length) {
          levelFormats.push("")
          numberFormats.push(0)
          continue
        }
        // 문단 머리 정보(12B): attr(u32) + widthAdjust(i16) + textDistance(i16) + charShapeId(u32)
        const attr = rec.data.readUInt32LE(offset)
        numberFormats.push((attr >>> 5) & 0x0f)
        offset += 12
        // 번호 형식 문자열 (가변)
        const { value, next } = readHwpString(rec.data, offset)
        levelFormats.push(value)
        offset = next
      }
      // 시작 번호 (u16) + 수준별 시작 번호 (5.0.2.5+, u32×7)
      let baseStart = 1
      if (offset + 2 <= rec.data.length) {
        baseStart = rec.data.readUInt16LE(offset) || 1
        offset += 2
      }
      for (let level = 0; level < 7; level++) {
        if (offset + 4 <= rec.data.length) {
          startNumbers[level] = rec.data.readUInt32LE(offset) || 1
          offset += 4
        } else {
          startNumbers[level] = baseStart
        }
      }
      numberings.push({ levelFormats, numberFormats, startNumbers })
    }

    // BULLET — 글머리표 (rhwp doc_info.rs parse_bullet, HWP 표 44)
    // 머리 정보(12B) 다음 WCHAR가 글머리표 문자
    if (rec.tagId === TAG_BULLET && rec.data.length >= 14) {
      const code = rec.data.readUInt16LE(12)
      bullets.push({ char: code > 0 ? String.fromCharCode(code) : "•" })
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

        // type(u8) + nextStyleId(u8) + langId(s16) + paraShapeId(u16) + charShapeId(u16)
        // 주의: nextStyleId는 스펙상 BYTE — 2바이트 스킵하면 paraShapeId가 256배수로 깨짐 (off-by-one 버그 수정)
        const type = offset < rec.data.length ? rec.data.readUInt8(offset) : 0; offset += 1
        offset += 1 // nextStyleId (BYTE)
        offset += 2 // langId
        const paraShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0; offset += 2
        const charShapeId = offset + 2 <= rec.data.length ? rec.data.readUInt16LE(offset) : 0

        styles.push({ name, nameKo, charShapeId, paraShapeId, type })
      } catch {
        // 파싱 실패 — 스킵
      }
    }
  }

  return { charShapes, paraShapes, styles, binData, numberings, bullets }
}

// ─── UTF-16LE 텍스트 추출 (21가지 제어문자 처리) ─────

export type InlineControlResolver = (ctrlId: string) => string | null | undefined

/**
 * 확장 컨트롤(CTRL_HEADER 보유) 기반 인라인 치환 콜백.
 * - ctrlIdx: 문단 내 확장 컨트롤 등장 순서 (0-based, CTRL_HEADER 자식 레코드 순서와 1:1)
 * - ctrlId: u32 정규화 ID — 파일의 LE DWORD를 그대로 읽은 값 ("tbl " → 0x74626c20)
 * 인라인 컨트롤(4-9, 19-20 — CTRL_HEADER 없음)은 ctrlIdx = -1로 호출된다.
 */
export type IndexedControlResolver = (ctrlIdx: number, ctrlId: number) => string | null | undefined

/** FIELD_BEGIN(0x03)/FIELD_END(0x04) 스택 페어링으로 복원한 필드 anchor 범위 */
export interface HwpFieldRange {
  /** state.text 기준 시작 인덱스 */
  start: number
  /** state.text 기준 끝 인덱스 (exclusive) */
  end: number
  /** FIELD_BEGIN 컨트롤의 확장 컨트롤 인덱스 (CTRL_HEADER 순서) */
  ctrlIdx: number
}

/** 문단 단위 PARA_TEXT 누적 상태 — 여러 PARA_TEXT 레코드에 걸친 컨트롤 인덱스/필드 스택 유지 */
export interface ParaTextState {
  text: string
  ctrlIdx: number
  fieldStack: Array<{ start: number; ctrlIdx: number }>
  fieldRanges: HwpFieldRange[]
}

export function createParaTextState(): ParaTextState {
  return { text: "", ctrlIdx: 0, fieldStack: [], fieldRanges: [] }
}

export function extractText(data: Buffer): string {
  return extractTextWithControls(data)
}

/** 레거시 인터페이스 — ctrlId를 on-disk 바이트 순서 ASCII 문자열로 받는 resolver */
export function extractTextWithControls(data: Buffer, resolveControl?: InlineControlResolver): string {
  const state = createParaTextState()
  appendParaText(state, data, resolveControl
    ? (_idx, id) => resolveControl(ctrlIdToDiskAscii(id))
    : undefined)
  return state.text
}

/** u32 컨트롤 ID → on-disk 바이트 순서 ASCII (LE 저장이므로 역순 문자열, 예: 0x74626c20 → " lbt") */
function ctrlIdToDiskAscii(id: number): string {
  return String.fromCharCode(id & 0xff, (id >>> 8) & 0xff, (id >>> 16) & 0xff, (id >>> 24) & 0xff)
}

/** 확장 전용 컨트롤 문자 (CTRL_HEADER 자식 레코드 1개와 대응) — rhwp is_extended_only_ctrl_char */
export function isExtendedOnlyCtrlChar(ch: number): boolean {
  return (ch >= 1 && ch <= 3) || (ch >= 11 && ch <= 12) || (ch >= 14 && ch <= 18) || (ch >= 21 && ch <= 23)
}

/**
 * PARA_TEXT 레코드 1개를 상태에 누적.
 * 텍스트 추출 + 확장 컨트롤 인라인 치환 + FIELD_BEGIN/END 범위 추적을 동시에 수행한다.
 */
export function appendParaText(state: ParaTextState, data: Buffer, resolveControl?: IndexedControlResolver): void {
  let result = ""
  let i = 0
  // 필드 범위는 state.text 기준 인덱스로 기록
  const base = state.text.length

  const resolveAt = (byteOffset: number, extended: boolean): void => {
    const ctrlId = data.readUInt32LE(byteOffset)
    const idx = extended ? state.ctrlIdx : -1
    const replacement = resolveControl?.(idx, ctrlId)
    if (replacement) result += replacement
    if (extended) state.ctrlIdx++
  }

  while (i + 1 < data.length) {
    const ch = data.readUInt16LE(i)
    i += 2

    switch (ch) {
      // ── char 타입 (2바이트만, 확장 데이터 없음) ──
      case CHAR_LINE: result += "\n"; break
      case CHAR_SECTION_BREAK: { // 강제 줄 나눔(char 2바이트). 단, 뒤에 0x000b 수식 래퍼가 오는 경우만 확장 처리
        // 일부 HWP5 문서는 수식 placeholder를 0x000a + 0x000b + ctrlId + payload + 0x000b로 저장한다.
        if (i + 16 <= data.length && data.readUInt16LE(i) === 0x000b) {
          resolveAt(i + 2, true)
          i += 16
          break
        }
        // bare 0x000a = char 타입 줄바꿈(2바이트, 확장 데이터 없음) — 뒤 14바이트 소비 금지(줄마다 7글자 증발 버그).
        result += "\n"
        break
      }
      case CHAR_PARA: break  // 문단 끝
      case CHAR_HYPHEN: result += "-"; break
      case CHAR_NBSP: result += "\u00a0"; break  // 진짜 NBSP
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
          // char(24-31) → 스킵 없음 (24,30,31은 switch에서 처리, 25-29는 예약 — 출력 없이 통과)
          const isExtended = isExtendedOnlyCtrlChar(ch)
          const isInline = (ch >= 4 && ch <= 9) || (ch >= 19 && ch <= 20)
          if ((isExtended || isInline) && i + 14 <= data.length) {
            if (ch === 0x0003) {
              // FIELD_BEGIN: anchor 시작 위치 + 컨트롤 인덱스 push
              state.fieldStack.push({ start: base + result.length, ctrlIdx: state.ctrlIdx })
            } else if (ch === 0x0004) {
              // FIELD_END: 스택 페어링 → anchor 범위 확정
              const open = state.fieldStack.pop()
              if (open) {
                state.fieldRanges.push({ start: open.start, end: base + result.length, ctrlIdx: open.ctrlIdx })
              }
            }
            resolveAt(i, isExtended)
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

  state.text += result
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
