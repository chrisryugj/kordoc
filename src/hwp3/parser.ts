/**
 * HWP 3.0 (한글 워드프로세서 3.x) 파서.
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
 * IR 은 HWP5·HWPX 파서와 같은 모양으로 조립한다(hwp5/ir-assemble.ts 공용): 표·글상자·단추(ch=10)는 셀 기하로
 * 복원한 IRTable(hwp3/table.ts — 한컴 HWP3→HWPX 변환본도 글상자·단추를 1×1 표로 낸다), 수식은 LaTeX, 각주·미주는
 * 마커 + (주: …), 머리말·꼬리말은 본문 앞·뒤 1회, 개요 번호는 번호 글자, 숨은 설명은 제외. 글자 속성·레이아웃은 무시.
 *
 * 출처: rhwp/src/parser/hwp3/mod.rs (MIT). 바이트 소비 규칙은 1:1 포팅.
 */

import { inflateRawSync } from "zlib"
import type { DocumentMetadata, IRBlock, InternalParseResult, ParseOptions, ParseWarning } from "../types.js"
import { KordocError } from "../utils.js"
import { blocksToMarkdown, escapeLiteralDollar, flattenLayoutTables } from "../table/builder.js"
import { hwpEquationToLatex } from "../hwp5/equation.js"
import { formatNumber, type NumFmt } from "../hwp5/numbering.js"
import {
  INLINE_TABLE_MARK, blocksPlainText, buildAddressedTable, cellTextFromBlocks, emitParagraphBlocks,
  type AddressedCell, type ParaObject,
} from "../hwp5/ir-assemble.js"
import { collectDrawingTextBoxLists } from "./drawing.js"
import { decodeJohabText } from "./johab.js"
import { Reader } from "./reader.js"
import { readHeader } from "./records.js"
import { decryptHwp3Document, isEncryptedHwp3 } from "./crypto.js"
import { hwp3CellGrid } from "./table.js"

/** 압축 해제 최대 크기 (100MB) — decompression bomb 방지 (hwp5/record.ts와 동일 캡) */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024

/** ch=11 그림 정보 offset 74 — 3 이면 확장 블록이 그리기 개체 트리다 (0/1/2 는 그림). */
const PIC_TYPE_DRAWING = 3

/** ch=10 개체 종류(info[78]) — 0 표, 1 글상자, 2 수식, 3 단추 (rhwp parse_hwp3_object_dispatch) */
const OBJ_EQUATION = 2
/** ch=10 기타 옵션(info[14]) bit 4 — 하이퍼텍스트 개체 */
const OPT_HYPERTEXT = 0x10

/** 채움(점끌기) 탭 표지 — 뒤는 목차 쪽번호라 문단 글을 여기서 자른다 (HWPX \x1F·HWP5 LEADER_TAB_MARK 와 같은 정책) */
const LEADER_TAB_MARK = "\x1F"

/**
 * 개요 번호(ch=28) 수준별 모양 — 한글 97 기본 개요 (rhwp ensure_hwp3_default_outline_numbering 과 같은 표).
 * 한컴 HWP3→HWPX 변환본 실측(SO-SUEOP): Ⅰ. / 1) / (1) / 가. / 가) / (가) / ①
 */
const OUTLINE_FORMATS: Array<{ fmt: NumFmt; before: string; after: string }> = [
  { fmt: "romanUpper", before: "", after: "." },
  { fmt: "digit", before: "", after: ")" },
  { fmt: "digit", before: "(", after: ")" },
  { fmt: "ganada", before: "", after: "." },
  { fmt: "ganada", before: "", after: ")" },
  { fmt: "ganada", before: "(", after: ")" },
  { fmt: "circled", before: "", after: "" },
]

const PARA_SHAPE_SIZE = 187 // ParaShape 구조 (rhwp records.rs Hwp3ParaShape::read 합산)
const LINE_INFO_SIZE = 14 // Hwp3LineInfo (u16 × 7)
const INLINE_CHAR_SHAPE_SIZE = 31 // Hwp3CharShape (rep_char_shape 와 동일)
// 제어 문자별 ch 외 추가 read byte 수. (ch 는 이미 paragraph loop 가 read 한 후라 여기엔 미포함.)
// 단위: byte. 동시에 char_count 에서 차지하는 hchar 도 다름 — 아래 EXTRA_HCHAR.
//
// rhwp/src/parser/hwp3/mod.rs ch 분기 그대로 옮긴 표. 탭(9)·자동번호(18)·개요번호(28)는 내용을 읽어야 해서
// parseCharStream 이 따로 처리한다:
//   9   (Tab)         : extra=6 byte, hchar=4 — spec §10.5 표 39: hchar+hunit 탭폭+word 점끌기+hchar 닫기
//                       = 8 byte 구조 (rhwp d89b689 #929 정합 — 2 byte 소비 시 탭마다 desync)
//   18~21 (각종 번호)  : extra=6 byte, hchar=4
//   22  (메일머지)     : extra=22 byte, hchar=12
//   23  (글자겹침)     : extra=8 byte, hchar=5
//   24  (하이픈)       : extra=4 byte, hchar=3 — spec §10.18 표 59, 실제 하이픈 글리프
//   25  (차례 표시)    : extra=4 byte, hchar=3 — spec §10.19 표 60, 제목/표/그림 차례 표식.
//                       비가시 마크라 글리프를 방출하지 않는다 (rhwp #2765 정합 — 종전엔
//                       하이픈(24)과 같은 항목이라 차례 표식마다 잉여 '-' 가 본문에 삽입)
//   26  (찾아보기)     : extra=244 byte, hchar=123 (1 + 122 추가)
//   28  (개요번호)     : extra=62 byte, hchar=32 (1 + 31 추가)
//   30  (묶음빈칸)     : extra=2 byte, hchar=2
//   31  (고정폭빈칸)   : extra=2 byte, hchar=2
//   default (7/8/10/11/12/15/16/17/27/29 등): 8 byte 헤더 + 종류별 추가
//     7,8 (날짜 형식/코드) 은 84/96 byte 가변폭 구조체라 simple 이 아니다 — 8 byte 헤더
//     뒤 76/88 byte 를 더 소비해야 한다 (rhwp #2844 정합, 아래 switch 참조)
type CtrlSimple = { extraBytes: number; extraHchar: number; emit: string | null }
const SIMPLE_CTRL: ReadonlyMap<number, CtrlSimple> = new Map([
  // 19/20/21 (새 번호·쪽 번호 위치·쪽 감추기) 는 비가시 마커다 — 한글도 그 자리에
  // 아무 글자를 내지 않는다 (rhwp #4957). 종전엔 U+FFFC 를 본문에 심어 마크다운에
  // 대체 문자가 그대로 남았다 (samples 33개 중 6문서 11건). 차례 표식(25) 과 같은 계약.
  [19, { extraBytes: 6, extraHchar: 3, emit: null }],
  [20, { extraBytes: 6, extraHchar: 3, emit: null }],
  [21, { extraBytes: 6, extraHchar: 3, emit: null }],
  [22, { extraBytes: 22, extraHchar: 11, emit: "￼" }],
  [23, { extraBytes: 8, extraHchar: 4, emit: "￼" }],
  [24, { extraBytes: 4, extraHchar: 2, emit: "-" }],
  [25, { extraBytes: 4, extraHchar: 2, emit: null }], // 차례 표식 — 비가시 (rhwp #2765)
  [26, { extraBytes: 244, extraHchar: 122, emit: "￼" }],
  [30, { extraBytes: 2, extraHchar: 1, emit: " " }],
  [31, { extraBytes: 2, extraHchar: 1, emit: " " }],
])

/** 문서 전역 파싱 상태 */
interface ParaContext {
  warnings: ParseWarning[]
  /** 머리말·꼬리말 — 본문 앞·뒤에 1회 (HWP5 applyHeaderFooterEffect·HWPX applyPageText 와 같은 배치) */
  headerBlocks: IRBlock[]
  footerBlocks: IRBlock[]
  headerTexts: Set<string>
  /** 쪽 번호 자동번호(ch=18 종류 0)를 만난 횟수 — 쪽 번호뿐인 머리말(크롬) 판별 */
  pageNumbers: number
  /** 각주·미주 번호가 비었을 때의 순번 */
  noteSeq: [number, number]
}

/** 문단 1개의 파싱 누적 — 파싱이 중간에 깨져도 모은 만큼 방출한다 */
interface Hwp3Para {
  text: string
  objects: ParaObject[]
  footnotes: string[]
  /** 개요 번호 (ch=28 종류 1) — 수준 + 저장된 수준별 현재 번호 */
  outline?: { level: number; numbers: number[] }
}

export interface Hwp3ParseOptions extends ParseOptions {
  /** 표/그림 nested paragraph 본문도 출력 (기본 true). */
  includeNested?: boolean
}

/**
 * HWP3 buffer → InternalParseResult.
 * 암호 문서는 options.password 로 복호한다 — 없으면 ENCRYPTED 코드로 throw.
 */
export function parseHwp3Document(
  buffer: ArrayBuffer,
  options?: Hwp3ParseOptions,
): InternalParseResult {
  let source = Buffer.from(buffer)

  // 암호 문서는 복호해서 평문 바이트로 바꾼 뒤 아래 경로를 그대로 탄다.
  // KordocError 라야 sanitizeError 가 메시지를 보존하고 classifyError 가 ENCRYPTED 로 분류한다
  // (plain Error + e.code 는 둘 다 무시되어 PARSE_ERROR/일반 문구로 뭉개졌다)
  if (isEncryptedHwp3(source)) {
    if (!options?.password) {
      throw new KordocError(
        "암호로 보호된 HWP3 문서입니다. password 옵션에 열기 암호를 지정하세요.",
      )
    }
    source = decryptHwp3Document(source, options.password)
  }

  const headReader = new Reader(source)
  const header = readHeader(headReader)

  // InfoBlock skip — 폰트/스타일 메타데이터, 텍스트 추출엔 불필요.
  headReader.skip(header.infoBlockLength)

  // Body: compressed != 0 이면 raw deflate (zlib 헤더 없는 RFC 1951)
  const tail = headReader.readToEnd()
  let body: Buffer
  const warnings: ParseWarning[] = []
  if (header.compressed !== 0) {
    try {
      body = inflateRawSync(tail, { maxOutputLength: MAX_DECOMPRESS_SIZE })
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new KordocError(`HWP3 압축 해제 결과가 최대 허용 크기(${MAX_DECOMPRESS_SIZE / 1024 / 1024}MB)를 초과했습니다`)
      }
      const msg = err instanceof Error ? err.message : String(err)
      throw new KordocError(`HWP3 압축 해제 실패: ${msg}`)
    }
  } else {
    body = tail
  }

  const bodyReader = new Reader(body)
  const ctx: ParaContext = { warnings, headerBlocks: [], footerBlocks: [], headerTexts: new Set(), pageNumbers: 0, noteSeq: [0, 0] }
  const bodyBlocks: IRBlock[] = []
  try {
    skipFontFacesAndStyles(bodyReader)
    parseParagraphList(bodyReader, ctx, bodyBlocks)
  } catch (err) {
    // 부분 파싱 실패 — 모은 만큼이라도 반환. truncated 경고 추가.
    warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 paragraph stream 도중 파싱 중단: ${err instanceof Error ? err.message : String(err)}`,
    })
  }

  // 레이아웃 표 해체 — HWP5 와 같은 바이너리 계열 정책(표로 페이지를 짠 구형 문서). HWP5 쌍 벤치는 HWPX 쪽에도
  // 같은 함수를 적용해 대칭으로 비교한다
  const blocks = flattenLayoutTables([...ctx.headerBlocks, ...bodyBlocks, ...ctx.footerBlocks])

  const metadata: DocumentMetadata = {
    title: header.title || undefined,
    author: header.author || undefined,
    description: header.subject || undefined,
    createdAt: header.date || undefined,
    version: "3.0",
  }

  return {
    markdown: blocksToMarkdown(blocks),
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

/**
 * char_count==0 빈 paragraph 가 list 끝. 블록은 sink 에 바로 쌓는다 — 스트림이 도중에 깨져 throw 해도
 * 모은 만큼은 호출자에게 남는다.
 */
function parseParagraphList(reader: Reader, ctx: ParaContext, sink: IRBlock[]): void {
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
    // 헤더 sanity check 로 방어한다. 깨진 paragraph 도 모은 글·개체는 방출한다
    const para: Hwp3Para = { text: "", objects: [], footnotes: [] }
    try {
      parseCharStream(reader, charCount, ctx, para)
    } catch (err) {
      sink.push(...emitHwp3Paragraph(para))
      ctx.warnings.push({
        code: "PARTIAL_PARSE",
        message: `HWP3 paragraph char stream 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      })
      return
    }
    sink.push(...emitHwp3Paragraph(para))
  }
}

/** 파싱을 마친 문단 → IR 블록 (HWP5 와 같은 조립기: 리더 절단 → 개요 번호 → 표 자리 분할) */
function emitHwp3Paragraph(para: Hwp3Para): IRBlock[] {
  let text = para.text
  const leaderAt = text.indexOf(LEADER_TAB_MARK)
  if (leaderAt >= 0) text = text.slice(0, leaderAt)
  let headMarker: string | null = null
  if (para.outline) {
    const { level, numbers } = para.outline
    const f = OUTLINE_FORMATS[level]
    const n = numbers[level]
    if (f && n > 0) headMarker = f.before + formatNumber(n, f.fmt) + f.after
    // 개요 번호 뒤 글은 한글 97 이 번호와 한 칸 띄워 그린다 — 본문 앞 공백은 번호 자리 여백
    text = text.replace(/^ +/, "")
  }
  return emitParagraphBlocks({ text: text.trim(), headMarker, headingLevel: 0, footnotes: para.footnotes, objects: para.objects })
}

/**
 * paragraph 본문 char_count 개의 hchar 를 처리해 para 에 누적한다.
 * 제어 문자는 제어 byte 만큼 정확히 소비하고 일부 (10/11/15/16/17 등) 는 nested paragraph list 를 읽는다.
 */
function parseCharStream(reader: Reader, charCount: number, ctx: ParaContext, para: Hwp3Para): void {
  let i = 0
  while (i < charCount) {
    const ch = reader.readU16()
    i += 1

    if (ch === 13) {
      para.text += "\n"
      continue
    }
    if (ch === 0) {
      // 일부 패딩/오류 케이스 — 무시
      continue
    }
    if (ch >= 32) {
      // 일반 hchar (ASCII < 0x80 영역도 u16 으로 들어옴).
      // 아래아 음절은 자모 2~3개가 되므로 문자열 단위로 받는다
      para.text += escapeLiteralDollar(decodeJohabText(ch) ?? "") // 리터럴 $ 는 \$ — $…$ 는 수식 전용
      continue
    }
    if (ch === 9) {
      // 탭 — hunit 탭폭 + word 점끌기 + hchar 닫기. 점끌기(채움)가 있으면 목차 쪽번호 탭
      reader.skip(2)
      const leader = reader.readU16()
      reader.skip(2)
      i += 3
      para.text += leader ? LEADER_TAB_MARK : "\t"
      continue
    }
    if (ch === 18) {
      // 자동 번호 — 종류(u16: 0 쪽·1 각주·2 미주·3 그림·4 표·5 수식) + 번호(u16) + 닫기
      const info = reader.readBytes(6)
      i += 3
      para.text += autoNumberText(info.readUInt16LE(0), info.readUInt16LE(2), ctx)
      continue
    }
    if (ch === 28) {
      // 개요 번호 — 종류(u16: 1 = 번호) + 모양(u8) + 수준(u8) + 수준별 현재 번호 u16[7] + … (62 byte).
      // 번호 값이 파일에 저장돼 있다 (SO-SUEOP 실측 — 수준 2 "(1)"·"(2)" 가 [1,1,1]·[1,1,2])
      const info = reader.readBytes(62)
      i += 31
      if (info.readUInt16LE(0) === 1) {
        para.outline = { level: Math.min(info[3], 6), numbers: Array.from({ length: 7 }, (_, k) => info.readUInt16LE(4 + k * 2)) }
      }
      continue
    }

    // 1..31 (13 제외) 제어 문자
    const simple = SIMPLE_CTRL.get(ch)
    if (simple) {
      reader.skip(simple.extraBytes)
      i += simple.extraHchar
      if (simple.emit) para.text += simple.emit
      continue
    }

    // ch=5/6/7/8/10/11/14~17/29 + 예약(0~4/12/27): 8 byte 추가 헤더 + 종류별 추가 처리
    // 8 byte = u32 header_val1 + u16 ch2 + 2 byte (hchar 정렬)
    const headerVal1 = reader.readU32() // size 또는 type-specific
    reader.readU16() // ch2 (sanity, ch와 같아야 함)
    i += 3 // 8 byte 헤더는 char_count 에서 4 hchar 차지 (1 이미 + 3)

    // 종류별 분기
    switch (ch) {
      case 10:
        // 표 / 글상자 / 수식 / 버튼: 84 byte info + cells + caption
        parseTableLike(reader, ctx, para)
        break
      case 11:
        // 그림: 348 byte info + n_ext byte
        para.objects.push({ blocks: parsePicture(reader, ctx), table: false, inline: false })
        break
      case 14:
        // 선 (spec 표 31): 84 byte info
        reader.skip(84)
        break
      case 15: {
        // 숨은 설명: 8 byte info + nested paragraph list — 읽기만 하고 본문에 넣지 않는다
        // (HWP5 CTRL_TCMT·HWPX hiddenComment 와 같은 정책 — 한컴은 화면·인쇄에 그리지 않는다)
        reader.skip(8)
        const hidden: IRBlock[] = []
        parseParagraphList(reader, ctx, hidden)
        if (hidden.length > 0 && !ctx.warnings.some(w => w.code === "HIDDEN_TEXT_FILTERED")) {
          ctx.warnings.push({ code: "HIDDEN_TEXT_FILTERED", message: "HWP3 숨은 설명 텍스트 본문 제외" })
        }
        break
      }
      case 16: {
        // 머리말/꼬리말: 10 byte info(8 = 0 머리말·1 꼬리말) + nested
        const info = reader.readBytes(10)
        parseHeaderFooter(reader, ctx, info[8] === 1)
        break
      }
      case 17: {
        // 각주/미주: 14 byte info(8 = 번호, 10 = 1 미주) + nested
        const info = reader.readBytes(14)
        parseNote(reader, ctx, para, info.readUInt16LE(8), info.readUInt16LE(10) === 1 ? 1 : 0)
        break
      }
      case 5:
        // 필드 코드 (spec §10.1 표 33): 8 byte 헤더 + header_val1 byte 세부 정보
        // (rhwp dcf64b4 #877 정합 — 미소비 시 stream desync). 1MB 이상은 비정상.
        if (headerVal1 > 0 && headerVal1 < 1_000_000) reader.skip(headerVal1)
        break
      case 6:
        // 책갈피 (spec §10.2 표 36): 42 byte total = 8 byte 헤더 + 이름 32 + 종류 2
        // (rhwp dcf64b4 #877 정합 — 34 byte 미소비 시 이후 문단 전체 오염)
        reader.skip(34)
        break
      case 7:
        // 날짜 형식 (spec §10.3 표 37): 84 byte total = 8 byte 헤더 + 76
        //   2..82 hchar array[40] 형식 문자열, 82..84 닫는 ch=7
        // (rhwp #2844 정합 — 종전 simple 6 byte 처리는 76 byte desync 를 남겨
        //  날짜 필드 뒤 문단 전체를 오염시켰다. 공문서는 날짜가 거의 항상 들어간다.)
        reader.skip(76)
        break
      case 8:
        // 날짜 코드 (spec §10.4 표 38): 96 byte total = 8 byte 헤더 + 88
        //   2..82 형식, 82..90 날짜 word[4], 90..94 시각 word[2], 94..96 닫는 ch=8
        reader.skip(88)
        break
      case 29:
        // 상호참조: header_val1 size raw skip (1MB 이상 비정상)
        if (headerVal1 < 1_000_000) reader.skip(headerVal1)
        break
      default:
        // ch=0~4/12/27 등 예약 코드 (spec 표 31): rhwp 의 "알 수 없음" 분기에서
        // header_val1 을 길이로 사용하지 않는다고 명시 ("ch=3 실증: 헤더 직후가 정상 단락
        // 내용이므로 추가 skip 없음"). 즉 8 byte 헤더만 소비하고 다음 char 로.
        // (spec 표 32 는 예약 코드를 8+n byte 로 규정하지만, rhwp 실측이 이와 어긋나
        //  실증 쪽을 따른다. ch=12 는 '선' 이 아니라 예약 — 종전 84 byte skip 은
        //  선(14) 의 info 크기를 잘못 적용한 것이라 오히려 desync 를 만들었다.)
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
  para.text = para.text.trim()
}

/**
 * 자동 번호(ch=18) 표시 글자 — 각주·미주 번호는 "N)"(한컴 PDF 실측, 각주 내용 첫머리의 번호), 그림·표·수식
 * 번호는 저장된 번호(HWP5 CTRL_ATNO 가 번호를 내는 것과 같다). 쪽 번호는 조판 시점 값이라 내지 않는다
 */
function autoNumberText(type: number, num: number, ctx: ParaContext): string {
  if (type === 0) {
    ctx.pageNumbers++
    return ""
  }
  if (num <= 0) return " "
  return type === 1 || type === 2 ? `${num})` : String(num)
}

/** 각주·미주 — 본문 자리에 마커 "N)", 내용은 "N) 내용" 으로 문단 footnoteText 에 (HWP5 applyNoteEffect 와 같은 모양) */
function parseNote(reader: Reader, ctx: ParaContext, para: Hwp3Para, number: number, kind: 0 | 1): void {
  const blocks: IRBlock[] = []
  parseParagraphList(reader, ctx, blocks)
  const n = number > 0 ? number : ++ctx.noteSeq[kind]
  const marker = `${n})`
  para.text += marker
  const content = blocksPlainText(blocks, " ")
  if (content) para.footnotes.push(content.startsWith(marker) ? content : `${marker} ${content}`)
}

/** 머리말·꼬리말 — 문서당 1회(같은 글 중복 제거), 쪽 번호뿐인 머리말은 크롬이라 버린다 (HWPX 와 같은 정책) */
function parseHeaderFooter(reader: Reader, ctx: ParaContext, isFooter: boolean): void {
  const pagesBefore = ctx.pageNumbers
  const blocks: IRBlock[] = []
  parseParagraphList(reader, ctx, blocks)
  const text = blocksPlainText(blocks, "\n")
  if (!text) return
  if (ctx.pageNumbers > pagesBefore && !/\p{L}/u.test(text)) return
  const key = (isFooter ? "f:" : "h:") + text
  if (ctx.headerTexts.has(key)) return
  ctx.headerTexts.add(key)
  ;(isFooter ? ctx.footerBlocks : ctx.headerBlocks).push({ type: "paragraph", text })
}

/**
 * ch=10 표/글상자/수식/버튼 — 84 byte 정보 → 셀 정보 27 byte × n → 셀별 문단 리스트 → 캡션 문단 리스트.
 * 수식(개체 종류 2)은 첫 셀 글이 수식 스크립트 → 본문 자리에 $LaTeX$. 나머지는 셀 기하로 복원한 표 —
 * 한컴 HWP3→HWPX 변환본도 글상자·단추를 1×1 표로 낸다(SO-SUEOP 실측 3개). 글자처럼 취급(기준 위치 0)이면
 * 문단 글 흐름 안의 자리에 표지를 심는다
 */
function parseTableLike(reader: Reader, ctx: ParaContext, para: Hwp3Para): void {
  // 84 byte info_buf
  const info = reader.readBytes(84)
  const cellCount = info.readUInt16LE(80) || 1
  // 방어: 셀 정보(27 byte × n)가 잔여 스트림보다 크면 손상된 헤더로 간주.
  // 종전의 고정 상한 256 은 실존 문서를 죽였다 — rhwp samples/hwp3-sample16 에
  // 367 셀 표가 실재한다 (rhwp 는 개수 상한 없이 버퍼 크기 캡만 둔다).
  if (27 * cellCount > reader.remaining()) {
    ctx.warnings.push({
      code: "PARTIAL_PARSE",
      message: `HWP3 표 cell_count=${cellCount} 비정상 — 표 본문 추출 포기`,
    })
    throw new Error(`HWP3 비정상 cell_count=${cellCount}`)
  }
  const cellInfo = reader.readBytes(27 * cellCount)

  // 셀별 문단 리스트 — 스트림이 셀 도중에 깨져도 읽은 셀 글은 표 밖 문단으로 남긴다
  const cellBlocks: IRBlock[][] = []
  try {
    for (let i = 0; i < cellCount; i++) {
      const blocks: IRBlock[] = []
      cellBlocks.push(blocks)
      parseParagraphList(reader, ctx, blocks)
    }
  } catch (err) {
    para.objects.push({ blocks: cellBlocks.flat(), table: false, inline: false })
    throw err
  }
  // 캡션 paragraph list 1회
  const captionBlocks: IRBlock[] = []
  parseParagraphList(reader, ctx, captionBlocks)
  const caption = blocksPlainText(captionBlocks, " ")

  if (info.readUInt16LE(78) === OBJ_EQUATION) {
    const script = (cellBlocks[0] ?? []).map(b => b.text ?? "").join("\n").trim()
    const latex = script ? hwpEquationToLatex(script) : ""
    if (latex) para.text += `$${latex.replace(/\$/g, "\\$")}$`
    if (caption) para.objects.push({ blocks: [{ type: "paragraph", text: caption }], table: false, inline: false })
    return
  }
  if (info.readUInt16LE(14) & OPT_HYPERTEXT) {
    // 하이퍼텍스트 개체(기타 옵션 bit 4) — 표가 아니라 연결 글자다(rhwp Hyperlink, 한컴 변환본에도 표 없음 —
    // sample16 단추 4개). 셀 글을 그 자리 본문으로
    para.text += blocksPlainText(cellBlocks.flat(), " ")
    if (caption) para.objects.push({ blocks: [{ type: "paragraph", text: caption }], table: false, inline: false })
    return
  }

  const grid = hwp3CellGrid(cellInfo, cellCount)
  const cells: AddressedCell[] = cellBlocks.map((blocks, k) => {
    const pos = grid.cells[k]
    const { text, hasStructure } = cellTextFromBlocks(blocks)
    const cell: AddressedCell = { text, colSpan: pos.colSpan, rowSpan: pos.rowSpan, colAddr: pos.col, rowAddr: pos.row }
    if (hasStructure && blocks.length > 0) cell.blocks = blocks
    return cell
  })
  // 셀 스트림은 시각 배치 순서라 병합 행에서 행 우선이 깨질 수 있다 — 행 우선으로 (겹침 정리의 "먼저 나온 셀")
  cells.sort((a, b) => a.rowAddr! - b.rowAddr! || a.colAddr! - b.colAddr!)
  const table = buildAddressedTable(cells, grid.rows, grid.cols)
  if (!table) {
    // 표를 못 세우면 셀 글을 문단으로 — 글 손실 금지
    para.objects.push({ blocks: [...cellBlocks.flat(), ...captionBlocks], table: false, inline: false })
    return
  }
  if (caption) table.caption = caption
  const inline = info[8] === 0
  if (inline) para.text += INLINE_TABLE_MARK
  para.objects.push({ blocks: [{ type: "table", table }], table: true, inline })
}

/**
 * ch=11 그림 — info 348 byte + n_ext bytes (info[0..4] 가 n_ext) + 캡션 paragraph list.
 *
 * spec §10.7 그림: 식별 정보(8) → 그림 정보(348+n) → **캡션 문단 리스트**.
 * 캡션이 없어도 빈 문단 sentinel(43 byte)이 항상 뒤따른다 (rhwp 의 ch==11 분기도
 * pic_type 과 무관하게 무조건 캡션 리스트를 파싱한다 — 표(ch=10)와 같은 계약).
 *
 * 종전엔 이 리스트를 소비하지 않아 그림 하나당 최소 43 byte 가 어긋났고, 어긋난
 * 자리가 char_count=0 으로 읽히면 문단 리스트가 "정상 종료"로 판정돼 **경고 없이**
 * 본문 나머지를 통째로 버렸다 (rhwp samples/hwp3-sample10: 본문 4MB 중 99.7% 유실).
 *
 * `pic_type`(info[74])이 3 이면 확장 블록은 그림이 아니라 **그리기 개체 트리**다 (#73).
 * 글상자·캡션 글은 그림 뒤 문단 블록으로 돌려준다.
 */
function parsePicture(reader: Reader, ctx: ParaContext): IRBlock[] {
  const info = reader.readBytes(348)
  const nExt = info.readUInt32LE(0)
  let ext: Buffer | null = null
  if (nExt > 0 && nExt < 100 * 1024 * 1024) ext = reader.readBytes(nExt)
  const blocks: IRBlock[] = []
  if (ext && info[74] === PIC_TYPE_DRAWING) parseDrawingObject(ext, ctx, blocks)
  parseParagraphList(reader, ctx, blocks)
  return blocks
}

/**
 * 그리기 개체 트리 안 글상자 텍스트를 회수한다 (#73).
 *
 * 본 스트림은 이미 확장 블록 길이만큼 전진했고 여기서는 그 **슬라이스만** 다루므로,
 * 트리 해석이 어긋나도 본문 문단 스트림의 동기는 깨지지 않는다. 그래서 실패는
 * 경고 한 줄로 삼키고 종전(통째로 건너뛰기) 동작으로 되돌아간다.
 */
function parseDrawingObject(ext: Buffer, ctx: ParaContext, sink: IRBlock[]): void {
  let lists: Buffer[]
  try {
    lists = collectDrawingTextBoxLists(ext)
  } catch (err) {
    pushDrawingWarning(ctx, `HWP3 그리기 개체 트리 파싱 실패 — 글상자 텍스트 생략: ${errText(err)}`)
    return
  }
  for (const list of lists) {
    try {
      parseParagraphList(new Reader(list), ctx, sink)
    } catch (err) {
      pushDrawingWarning(ctx, `HWP3 글상자 문단 리스트 파싱 실패: ${errText(err)}`)
    }
  }
}

/** 그리기 개체 경고는 문서당 한 번만 — 도형이 많은 문서에서 경고가 폭주한다. */
function pushDrawingWarning(ctx: ParaContext, message: string): void {
  if (ctx.warnings.some(w => w.code === "UNSUPPORTED_ELEMENT" && w.message.startsWith("HWP3 그리기"))) return
  ctx.warnings.push({ code: "UNSUPPORTED_ELEMENT", message })
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
