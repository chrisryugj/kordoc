/**
 * HWP 3.0 (한글 워드프로세서 3.x) 텍스트 추출 파서.
 *
 * 1996~2002년 한컴이 사용한 binary 포맷. CFB(OLE2) 컨테이너가 아닌 단일 binary stream.
 * 내부 구조 요약:
 *   30 byte signature
 * + 128 byte DocInfo  (compressed/encrypted 플래그 + InfoBlock 길이)
 * + 1008 byte DocSummary (제목/저자/날짜)
 * + InfoBlock (가변 — 폰트/스타일 메타데이터)
 * + Body  (compressed!=0 이면 raw deflate 압축)
 *
 * Body 는 paragraph 의 list. 각 paragraph 는 헤더 + LineInfos + (inline char shapes) + char stream.
 * char stream 은 hchar (u16 little-endian) 의 시퀀스로, 1..31 영역(13 제외) 은 제어 문자
 * (제어 문자별로 추가 byte 를 소비하고 일부는 nested paragraph list 가짐).
 *
 * 본 구현은 **텍스트 추출 전용** — 표/그림 레이아웃, 글자 속성, 캡션 위치 등은 모두 무시한다.
 * 표 셀과 그림 캡션, 머리말/꼬리말, 각주의 본문 텍스트는 재귀로 모아서 결과에 포함시킨다.
 *
 * 출처: rhwp/src/parser/hwp3/mod.rs (Apache-2.0). 알고리즘 1:1 포팅 + minimal 변형.
 */

import { inflateRawSync } from "zlib"
import type { DocumentMetadata, IRBlock, InternalParseResult, ParseOptions, ParseWarning } from "../types.js"
import { JOHAB_UNMAPPED, decodeJohab } from "./johab.js"
import { Reader } from "./reader.js"
import { readHeader } from "./records.js"

const PARA_HEADER_FIXED_SIZE = 43 // follow_prev(1) + char_count(2) + line_count(2) + include_cs(1) + flags(1) + sc_flags(4) + style_idx(1) + rep_char_shape(31)
const PARA_SHAPE_SIZE = 187 // ParaShape 구조 (rhwp records.rs Hwp3ParaShape::read 합산)
const LINE_INFO_SIZE = 14 // Hwp3LineInfo (u16 × 7)
const INLINE_CHAR_SHAPE_SIZE = 31 // Hwp3CharShape (rep_char_shape 와 동일)
// 제어 문자별 ch 외 추가 read byte 수. (ch 는 이미 paragraph loop 가 read 한 후라 여기엔 미포함.)
// 단위: byte. 동시에 char_count 에서 차지하는 hchar 도 다름 — 아래 EXTRA_HCHAR.
//
// rhwp/src/parser/hwp3/mod.rs ch 분기 그대로 옮긴 표.
//   9   (Tab)         : extra=0 byte, hchar=1
//   18~21 (각종 번호)  : extra=6 byte, hchar=4
//   22  (메일머지)     : extra=22 byte, hchar=12
//   23  (글자겹침)     : extra=8 byte, hchar=5
//   24,25 (하이픈)     : extra=4 byte, hchar=3
//   26  (찾아보기)     : extra=244 byte, hchar=123 (1 + 122 추가)
//   28  (개요번호)     : extra=62 byte, hchar=32 (1 + 31 추가)
//   30  (묶음빈칸)     : extra=2 byte, hchar=2
//   31  (고정폭빈칸)   : extra=2 byte, hchar=2
//   7,8 (날짜)         : extra=6 byte, hchar=4
//   default (10/11/12/15/16/17/27/29 등): 8 byte 헤더 + 종류별 추가
type CtrlSimple = { extraBytes: number; extraHchar: number; emit: string | null }
const SIMPLE_CTRL: ReadonlyMap<number, CtrlSimple> = new Map([
  [9, { extraBytes: 0, extraHchar: 0, emit: "\t" }],
  [7, { extraBytes: 6, extraHchar: 3, emit: "￼" }],
  [8, { extraBytes: 6, extraHchar: 3, emit: "￼" }],
  [18, { extraBytes: 6, extraHchar: 3, emit: " " }], // AutoNumber → 공백 (HWP5 패턴)
  [19, { extraBytes: 6, extraHchar: 3, emit: "￼" }],
  [20, { extraBytes: 6, extraHchar: 3, emit: "￼" }],
  [21, { extraBytes: 6, extraHchar: 3, emit: "￼" }],
  [22, { extraBytes: 22, extraHchar: 11, emit: "￼" }],
  [23, { extraBytes: 8, extraHchar: 4, emit: "￼" }],
  [24, { extraBytes: 4, extraHchar: 2, emit: "-" }],
  [25, { extraBytes: 4, extraHchar: 2, emit: "-" }],
  [26, { extraBytes: 244, extraHchar: 122, emit: "￼" }],
  [28, { extraBytes: 62, extraHchar: 31, emit: "￼" }],
  [30, { extraBytes: 2, extraHchar: 1, emit: " " }],
  [31, { extraBytes: 2, extraHchar: 1, emit: " " }],
])

interface ParaContext {
  /** 누적된 paragraph text 의 array — 각 entry 가 한 paragraph */
  paragraphs: string[]
  warnings: ParseWarning[]
}

export interface Hwp3ParseOptions extends ParseOptions {
  /** 표/그림 nested paragraph 본문도 출력 (기본 true). */
  includeNested?: boolean
}

/**
 * HWP3 buffer → InternalParseResult.
 * encrypted 본문은 복호화 못하고 ENCRYPTED 코드로 throw.
 */
export function parseHwp3Document(
  buffer: ArrayBuffer,
  _options?: Hwp3ParseOptions,
): InternalParseResult {
  const headReader = new Reader(Buffer.from(buffer))
  const header = readHeader(headReader)

  if (header.encrypted !== 0) {
    const e: Error & { code?: string } = new Error("HWP3 본문이 암호로 보호되어 있어 추출할 수 없습니다.")
    e.code = "ENCRYPTED"
    throw e
  }

  // InfoBlock skip — 폰트/스타일 메타데이터, 텍스트 추출엔 불필요.
  headReader.skip(header.infoBlockLength)

  // Body: compressed != 0 이면 raw deflate (zlib 헤더 없는 RFC 1951)
  const tail = headReader.readToEnd()
  let body: Buffer
  const warnings: ParseWarning[] = []
  if (header.compressed !== 0) {
    try {
      body = inflateRawSync(tail)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`HWP3 압축 해제 실패: ${msg}`)
    }
  } else {
    body = tail
  }

  const bodyReader = new Reader(body)
  const ctx: ParaContext = { paragraphs: [], warnings }
  try {
    skipFontFacesAndStyles(bodyReader)
    parseParagraphList(bodyReader, ctx)
  } catch (err) {
    // 부분 파싱 실패 — 모은 만큼이라도 반환. truncated 경고 추가.
    warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 paragraph stream 도중 파싱 중단: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  const text = ctx.paragraphs.filter(p => p.length > 0).join("\n\n")
  const blocks: IRBlock[] = ctx.paragraphs.map(p => ({ type: "paragraph", text: p }))

  const metadata: DocumentMetadata = {
    title: header.title || undefined,
    author: header.author || undefined,
    description: header.subject || undefined,
    createdAt: header.date || undefined,
    version: "3.0",
  }

  return {
    markdown: text,
    blocks,
    metadata,
    warnings: warnings.length ? warnings : undefined,
  }
}

/**
 * 본문 paragraph_list 진입 전 — 압축 해제된 body 의 앞쪽에는 font / style 메타데이터가 있다.
 * rhwp/src/parser/hwp3/mod.rs:1654~1700 흐름 그대로:
 *   - 7개 언어별 font face: n_fonts(u16) + n_fonts × 40 byte name
 *   - n_styles(u16) + n_styles × (20 byte name + 31 byte char_shape + 187 byte para_shape)
 */
function skipFontFacesAndStyles(reader: Reader): void {
  const STYLE_RECORD_SIZE = 20 + 31 + 187 // = 238
  for (let lang = 0; lang < 7; lang++) {
    const n = reader.readU16()
    reader.skip(n * 40)
  }
  const nStyles = reader.readU16()
  reader.skip(nStyles * STYLE_RECORD_SIZE)
}

/** char_count==0 빈 paragraph 가 list 끝. */
function parseParagraphList(reader: Reader, ctx: ParaContext): void {
  for (;;) {
    if (reader.eof()) return

    // ParaInfo 헤더 (가변 size). list 끝 sentinel(empty para)이 아니어도 stream sync 가
    // 어긋난 이전 paragraph 의 잔재로 비정상 헤더가 들어올 수 있다. char_count 가
    // 1 paragraph 한도(64K) 를 넘는다거나 lineCount 가 비정상적이면 list 종료로 간주.
    const followPrev = reader.readU8()
    const charCount = reader.readU16()
    if (charCount === 0) {
      // 빈 paragraph: 이미 3 byte 읽었으므로 40 byte 더 read 후 종료
      reader.skip(40)
      return
    }
    const lineCount = reader.readU16()
    // 방어: 한 paragraph 의 line 수가 4096 을 넘는 건 stream 어긋남으로 간주.
    if (charCount > 60000 || lineCount > 4096) {
      ctx.warnings.push({
        code: "PARTIAL_PARSE",
        message: `HWP3 비정상 paragraph 헤더 (char_count=${charCount}, line_count=${lineCount}) → 이후 stream 포기`,
      })
      return
    }
    const includeCharShape = reader.readU8()
    reader.skip(1) // flags
    reader.skip(4) // special_char_flags
    reader.skip(1) // style_index
    reader.skip(31) // rep_char_shape
    if (followPrev === 0) reader.skip(PARA_SHAPE_SIZE)

    // LineInfos
    reader.skip(lineCount * LINE_INFO_SIZE)

    // Inline char shapes — char_count 만큼 (flag u8, flag != 1 이면 charshape 31 byte)
    if (includeCharShape !== 0) {
      for (let i = 0; i < charCount; i++) {
        const flag = reader.readU8()
        if (flag !== 1) reader.skip(INLINE_CHAR_SHAPE_SIZE)
      }
    }

    // Char stream — paragraph 단위로 try/catch 해서 한 paragraph 가 깨져도 list 전체는
    // 살리되, sync 가 어긋난 후의 후속 paragraph 들도 비정상 헤더가 나올 가능성이 커서
    // 헤더 sanity check 로 방어한다.
    try {
      const text = parseCharStream(reader, charCount, ctx)
      ctx.paragraphs.push(text)
    } catch (err) {
      ctx.warnings.push({
        code: "PARTIAL_PARSE",
        message: `HWP3 paragraph #${ctx.paragraphs.length} char stream 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
  }
}

/**
 * paragraph 본문 char_count 개의 hchar 를 처리해 텍스트 추출.
 * 제어 문자는 제어 byte 만큼 정확히 소비하고 일부 (10/11/15/16/17 등) 는
 * nested paragraph list 를 별도로 ctx 에 모은다.
 */
function parseCharStream(reader: Reader, charCount: number, ctx: ParaContext): string {
  let out = ""
  let i = 0
  while (i < charCount) {
    const ch = reader.readU16()
    i += 1

    if (ch === 13) {
      out += "\n"
      continue
    }
    if (ch === 0) {
      // 일부 패딩/오류 케이스 — 무시
      continue
    }
    if (ch >= 32) {
      // 일반 hchar (ASCII < 0x80 영역도 u16 으로 들어옴)
      const cp = decodeJohab(ch)
      if (cp !== JOHAB_UNMAPPED) out += String.fromCodePoint(cp)
      continue
    }

    // 1..31 (13 제외) 제어 문자
    const simple = SIMPLE_CTRL.get(ch)
    if (simple) {
      reader.skip(simple.extraBytes)
      i += simple.extraHchar
      if (simple.emit) out += simple.emit
      continue
    }

    // ch=10/11/12/14/15/16/17/27/29 등: 8 byte 추가 헤더 + 종류별 추가 처리
    // 8 byte = u32 header_val1 + u16 ch2 + 2 byte (hchar 정렬)
    const headerVal1 = reader.readU32() // size 또는 type-specific
    reader.readU16() // ch2 (sanity, ch와 같아야 함)
    i += 3 // 8 byte 헤더는 char_count 에서 4 hchar 차지 (1 이미 + 3)

    // 종류별 분기
    switch (ch) {
      case 10:
        // 표 / 글상자 / 수식 / 버튼: 84 byte info + cells + caption
        out += parseTableLike(reader, ctx)
        break
      case 11:
        // 그림: 348 byte info + n_ext byte
        parsePicture(reader, ctx)
        break
      case 12:
        // 선: 84 byte info
        reader.skip(84)
        break
      case 14:
        // 선 (alternate path) — rhwp mod.rs line 943: 84 byte info
        reader.skip(84)
        break
      case 15: {
        // 숨은 설명: 8 byte info + nested paragraph list
        reader.skip(8)
        parseParagraphList(reader, ctx)
        break
      }
      case 16: {
        // 머리말/꼬리말: 10 byte info + nested
        reader.skip(10)
        parseParagraphList(reader, ctx)
        break
      }
      case 17: {
        // 각주/미주: 14 byte info + nested
        reader.skip(14)
        parseParagraphList(reader, ctx)
        break
      }
      case 29:
        // 상호참조: header_val1 size raw skip (1MB 이상 비정상)
        if (headerVal1 < 1_000_000) reader.skip(headerVal1)
        break
      default:
        // ch=2/3/4/5/6/27 등: rhwp mod.rs:1011 의 "알 수 없음" 분기에서
        // header_val1 을 길이로 사용하지 않는다고 명시 ("ch=3 실증: 헤더 직후가 정상 단락
        // 내용이므로 추가 skip 없음"). 즉 8 byte 헤더만 소비하고 다음 char 로.
        // 경고는 첫 등장만 기록 — 본문에 페이지번호/필드코드가 많이 깔린 paragraph 가
        // 전형적인 케이스라 logging 폭주 방지.
        if (!ctx.warnings.some(w => w.code === "UNSUPPORTED_ELEMENT")) {
          ctx.warnings.push({
            code: "UNSUPPORTED_ELEMENT",
            message: `HWP3 부분 처리 제어 문자 ch=${ch} (이후 동일 코드 경고 생략)`,
          })
        }
        break
    }
  }
  return out.trim()
}

/** ch=10 표/글상자/수식/버튼 본문 텍스트 추출. */
function parseTableLike(reader: Reader, ctx: ParaContext): string {
  // 84 byte info_buf
  const info = reader.readBytes(84)
  const cellCount = info.readUInt16LE(80) || 1
  // 방어: cellCount 가 비정상적으로 크면 stream 어긋남으로 간주, 추가 처리 포기.
  // 한 표에 cell 256 개 초과는 사실상 없음 (HWP3 spec 상 행/열 한계도 그 미만).
  if (cellCount > 256) {
    ctx.warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 표 cell_count=${cellCount} 비정상 — 표 본문 추출 포기`,
    })
    throw new Error(`HWP3 비정상 cell_count=${cellCount}`)
  }
  // 각 셀: 27 byte 정보 → 셀별 nested paragraph list (재귀)
  reader.skip(27 * cellCount)

  // 셀별 텍스트 collect — 셀 내부 paragraph 는 ctx 에 직접 push 되므로
  // 본 paragraph 의 "표 자리" 에는 placeholder 만 남기고 셀 텍스트는 ctx 안에서 별도 paragraph 로 보존.
  for (let i = 0; i < cellCount; i++) {
    parseParagraphList(reader, ctx)
  }
  // 캡션 paragraph list 1회
  parseParagraphList(reader, ctx)
  return "" // 표 자리에는 빈 문자열 (셀 텍스트는 이미 ctx.paragraphs 에 포함됨)
}

/** ch=11 그림 — info 348 byte + n_ext bytes (info[0..4] 가 n_ext). */
function parsePicture(reader: Reader, _ctx: ParaContext): void {
  const info = reader.readBytes(348)
  const nExt = info.readUInt32LE(0)
  if (nExt > 0 && nExt < 100 * 1024 * 1024) reader.skip(nExt)
}
