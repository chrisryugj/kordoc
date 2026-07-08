/** HWP 5.x 바이너리 파서 — OLE2 컨테이너 → 섹션 → Markdown */

import {
  readRecords, decompressStream, parseFileHeader, extractEquationText, parseDocInfo,
  createParaTextState, appendParaText,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  TAG_EQEDIT, TAG_SHAPE_COMPONENT, TAG_SHAPE_COMPONENT_CONTAINER, TAG_SHAPE_COMPONENT_PICTURE,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DISTRIBUTION, FLAG_DRM,
  type HwpRecord, type HwpDocInfo, type IndexedControlResolver,
} from "./record.js"
import { NumberingState, expandNumberingFormat, formatNumber, shapeFormatToNumFmt } from "./numbering.js"
import { extractHwp5Images, extractHwp5ImagesLenient } from "./images.js"
import { decryptViewText } from "./crypto.js"
import { hwpEquationToLatex } from "./equation.js"
import { parseLenientCfb, type LenientCfbContainer } from "./cfb-lenient.js"
import { buildTable, blocksToMarkdown, convertTableToText, flattenLayoutTables, dedupeRunningHeaders, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, IRCell, IRTable, DocumentMetadata, InternalParseResult, ParseOptions, ParseWarning, OutlineItem, InlineStyle } from "../types.js"
import { HEADING_RATIO_H1, HEADING_RATIO_H2, HEADING_RATIO_H3 } from "../types.js"
import { KordocError, sanitizeHref } from "../utils.js"
import { parsePageRange } from "../page-range.js"

import { createRequire } from "module"
const require = createRequire(import.meta.url)
const CFB: CfbModule = require("cfb")

interface CfbEntry { name?: string; content?: Buffer | Uint8Array }
interface CfbContainer { FileIndex?: CfbEntry[] }
interface CfbModule {
  parse(data: Buffer): CfbContainer
  find(cfb: CfbContainer, path: string): CfbEntry | null
}

/** 최대 섹션 수 — 비정상 파일에 의한 무한 루프 방지 */
const MAX_SECTIONS = 100
/** 누적 압축 해제 최대 크기 (100MB) */
const MAX_TOTAL_DECOMPRESS = 100 * 1024 * 1024
/** 중첩표/글상자 재귀 깊이 상한 — 표 "중첩 단계" 기준.
 *  실무 문서 중첩은 2~3단이라 8이면 충분하며, 바이너리 파싱 비용상
 *  filler/소스맵(16)보다 보수적으로 둔다. hwpx MAX_XML_DEPTH(200)는
 *  XML 요소 깊이라 좌표계가 다름 — 상수 통일 대상 아님 */
const MAX_NEST_DEPTH = 8

// ─── 컨트롤 ID (u32 LE 정규화) ───────────────────────
// HWP는 ctrl_id를 DWORD(LE)로 저장한다. "tbl "은 파일에 [0x20,0x6c,0x62,0x74](" lbt")로
// 기록되므로, readUInt32LE로 읽으면 BE 문자열 상수 0x74626c20과 일치한다 (rhwp tags.rs 방식).

/** 4바이트 ASCII 문자열 → u32 컨트롤 ID 상수 ("tbl " → 0x74626c20) */
function cid(s: string): number {
  return ((s.charCodeAt(0) << 24) | (s.charCodeAt(1) << 16) | (s.charCodeAt(2) << 8) | s.charCodeAt(3)) >>> 0
}

const CTRL_TBL = cid("tbl ")    // 표
const CTRL_GSO = cid("gso ")    // 그리기 개체 (그림/글상자)
const CTRL_EQED = cid("eqed")   // 수식
const CTRL_HEAD = cid("head")   // 머리말
const CTRL_FOOT = cid("foot")   // 꼬리말
const CTRL_FN = cid("fn  ")     // 각주
const CTRL_EN = cid("en  ")     // 미주
const CTRL_ATNO = cid("atno")   // 자동 번호
const CTRL_NWNO = cid("nwno")   // 새 번호
const CTRL_PGNP = cid("pgnp")   // 쪽 번호 위치
const CTRL_PGHD = cid("pghd")   // 감추기
const CTRL_IDXM = cid("idxm")   // 찾아보기 표식
const CTRL_BOKM = cid("bokm")   // 책갈피
const CTRL_TCPS = cid("tcps")   // 글자 겹침
const CTRL_TDUT = cid("tdut")   // 덧말
const CTRL_TCMT = cid("tcmt")   // 숨은 설명
const CTRL_SECD = cid("secd")   // 구역 정의
const CTRL_COLD = cid("cold")   // 단 정의
const CTRL_FORM = cid("form")   // 양식 개체
const CTRL_OLE = cid("ole ")    // OLE 개체
const FIELD_HLK = cid("%hlk")   // 필드: 하이퍼링크
const FIELD_CLK = cid("%clk")   // 필드: 누름틀

const KNOWN_CTRL_IDS = new Set([
  CTRL_TBL, CTRL_GSO, CTRL_EQED, CTRL_HEAD, CTRL_FOOT, CTRL_FN, CTRL_EN,
  CTRL_ATNO, CTRL_NWNO, CTRL_PGNP, CTRL_PGHD, CTRL_IDXM, CTRL_BOKM,
  CTRL_TCPS, CTRL_TDUT, CTRL_TCMT, CTRL_SECD, CTRL_COLD, CTRL_FORM, CTRL_OLE,
])

/** 필드 컨트롤 여부 (첫 바이트 '%') */
function isFieldCtrlId(id: number): boolean {
  return (id >>> 24) === 0x25
}

/** 바이트 순서 뒤집기 — 비표준 작성기의 BE 저장 ctrl_id 방어 */
function swap32(id: number): number {
  return (((id & 0xff) << 24) | (((id >>> 8) & 0xff) << 16) | (((id >>> 16) & 0xff) << 8) | ((id >>> 24) & 0xff)) >>> 0
}

/** LE로 읽은 ctrl_id를 정규화 — 알려진 ID/필드가 아니고 스왑하면 일치할 때만 스왑 */
function normalizeCtrlId(raw: number): number {
  if (KNOWN_CTRL_IDS.has(raw) || isFieldCtrlId(raw)) return raw
  const sw = swap32(raw)
  if (KNOWN_CTRL_IDS.has(sw) || isFieldCtrlId(sw)) return sw
  return raw
}

export function parseHwp5Document(buffer: Buffer, options?: ParseOptions): InternalParseResult {
  // CFB 파싱: strict 먼저, 실패 시 lenient 폴백
  let cfb: CfbContainer | null = null
  let lenientCfb: LenientCfbContainer | null = null
  const warnings: ParseWarning[] = []

  try {
    cfb = CFB.parse(buffer)
  } catch {
    try {
      lenientCfb = parseLenientCfb(buffer)
      warnings.push({ message: "손상된 CFB 컨테이너 — lenient 모드로 복구", code: "LENIENT_CFB_RECOVERY" })
    } catch {
      throw new KordocError("CFB 컨테이너 파싱 실패 (strict 및 lenient 모두)")
    }
  }

  // CFB 래퍼: strict/lenient 통합 인터페이스
  const findStream = (path: string): Buffer | null => {
    if (cfb) {
      const entry = CFB.find(cfb, path)
      return entry?.content ? Buffer.from(entry.content) : null
    }
    return lenientCfb!.findStream(path)
  }

  const headerData = findStream("/FileHeader")
  if (!headerData) throw new KordocError("FileHeader 스트림 없음")
  const header = parseFileHeader(headerData)
  if (header.signature !== "HWP Document File") throw new KordocError("HWP 시그니처 불일치")
  if (header.flags & FLAG_ENCRYPTED) throw new KordocError("암호화된 HWP는 지원하지 않습니다")
  if (header.flags & FLAG_DRM) throw new KordocError("DRM 보호된 HWP는 지원하지 않습니다")
  const compressed = (header.flags & FLAG_COMPRESSED) !== 0
  const distribution = (header.flags & FLAG_DISTRIBUTION) !== 0

  const metadata: DocumentMetadata = {
    version: `${header.versionMajor}.x`,
  }
  if (cfb) extractHwp5Metadata(cfb, metadata)

  // DocInfo 파싱 (스타일 정보 추출)
  const docInfo = cfb
    ? parseDocInfoStream(cfb, compressed)
    : parseDocInfoFromStream(findStream("/DocInfo"), compressed)

  const sections = distribution
    ? (cfb ? findViewTextSections(cfb, compressed) : findViewTextSectionsLenient(lenientCfb!, compressed))
    : (cfb ? findSections(cfb) : findSectionsLenient(lenientCfb!, compressed))
  if (sections.length === 0) throw new KordocError("섹션 스트림을 찾을 수 없습니다")

  metadata.pageCount = sections.length

  // 페이지 범위 필터링 (섹션 단위 근사치)
  const pageFilter = options?.pages ? parsePageRange(options.pages, sections.length) : null
  const totalTarget = pageFilter ? pageFilter.size : sections.length

  const bodyBlocks: IRBlock[] = []
  const doc = createHwp5DocState()
  let totalDecompressed = 0
  let parsedSections = 0
  for (let si = 0; si < sections.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue
    try {
      const sectionData = sections[si]
      // 배포용 문서는 findViewTextSections에서 이미 복호화+압축해제 완료
      const data = (!distribution && compressed) ? decompressStream(Buffer.from(sectionData)) : Buffer.from(sectionData)
      totalDecompressed += data.length
      if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
      const records = readRecords(data)
      const sectionBlocks = parseSection(records, docInfo, warnings, si + 1, doc)
      bodyBlocks.push(...sectionBlocks)
      parsedSections++
      options?.onProgress?.(parsedSections, totalTarget)
    } catch (secErr) {
      if (secErr instanceof KordocError) throw secErr
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    }
  }

  // 머리말은 문서 맨 앞, 꼬리말은 맨 뒤에 1회 출력
  const blocks: IRBlock[] = [...doc.headerBlocks, ...bodyBlocks, ...doc.footerBlocks]

  // BinData에서 이미지 추출
  const images = cfb
    ? extractHwp5Images(cfb.FileIndex, blocks, warnings)
    : extractHwp5ImagesLenient(lenientCfb!, blocks, warnings)

  // 레이아웃 테이블 해체 (heading 감지 전에 수행하여 해체된 텍스트도 heading 감지 대상)
  let flatBlocks = flattenLayoutTables(blocks)
  // 페이지 레이아웃 표의 반복 러닝 헤더 중복 제거 — opt-in (기본 off).
  // 위치 정보가 없는 HWP5 특성상 정당한 번호매김 반복(붙임별 재번호)까지 오삭제할 수
  // 있어 옵션이 켜졌을 때만 수행하고, 실제 제거가 있으면 경고로 가시화한다.
  if (options?.dedupeRunningHeaders) {
    const deduped = dedupeRunningHeaders(flatBlocks)
    const removed = flatBlocks.length - deduped.length
    if (removed > 0) warnings.push({ message: `반복 러닝 헤더 ${removed}개 제거`, code: "HIDDEN_TEXT_FILTERED" })
    flatBlocks = deduped
  }

  // 스타일 기반 헤딩 감지
  if (docInfo) {
    detectHwp5Headings(flatBlocks, docInfo)
  }

  // outline 구축
  const outline: OutlineItem[] = flatBlocks
    .filter(b => b.type === "heading" && b.level && b.text)
    .map(b => ({ level: b.level!, text: b.text!, pageNumber: b.pageNumber }))

  const markdown = blocksToMarkdown(flatBlocks)
  return { markdown, blocks: flatBlocks, metadata, outline: outline.length > 0 ? outline : undefined, warnings: warnings.length > 0 ? warnings : undefined, images: images.length > 0 ? images : undefined }
}

/** DocInfo 스트림 파싱 (best-effort) */
function parseDocInfoStream(cfb: CfbContainer, compressed: boolean): HwpDocInfo | null {
  try {
    const entry = CFB.find(cfb, "/DocInfo")
    if (!entry?.content) return null
    const data = compressed ? decompressStream(Buffer.from(entry.content)) : Buffer.from(entry.content)
    const records = readRecords(data)
    return parseDocInfo(records)
  } catch {
    return null
  }
}

/** DocInfo — Buffer에서 직접 파싱 (lenient용) */
function parseDocInfoFromStream(raw: Buffer | null, compressed: boolean): HwpDocInfo | null {
  if (!raw) return null
  try {
    const data = compressed ? decompressStream(raw) : raw
    return parseDocInfo(readRecords(data))
  } catch {
    return null
  }
}

/** 스타일 기반 헤딩 감지 — 큰 폰트 + 짧은 텍스트 → heading */
function detectHwp5Headings(blocks: IRBlock[], docInfo: HwpDocInfo): void {
  // 기본(본문) 폰트 크기 = 블록 폰트 크기의 텍스트 길이 가중 최빈값.
  // 공문서는 바탕글(10pt)과 다른 크기(13-14pt)로 본문을 쓰는 경우가 많아
  // 바탕글 스타일을 기준으로 삼으면 본문 전체가 헤딩으로 오검출된다 (실증: 보도자료 24/24).
  let baseFontSize = 0
  const sizeFreq = new Map<number, number>()
  for (const b of blocks) {
    if (b.style?.fontSize && b.text) {
      sizeFreq.set(b.style.fontSize, (sizeFreq.get(b.style.fontSize) || 0) + b.text.length)
    }
  }
  let maxWeight = 0
  for (const [size, weight] of sizeFreq) {
    if (weight > maxWeight) { maxWeight = weight; baseFontSize = size }
  }

  // 블록 스타일이 전혀 없으면 "바탕글", "본문" 등 본문 스타일로 폴백
  if (baseFontSize === 0) {
    for (const style of docInfo.styles) {
      const name = (style.nameKo || style.name).toLowerCase()
      if (name.includes("바탕") || name.includes("본문") || name === "normal" || name === "body") {
        const cs = docInfo.charShapes[style.charShapeId]
        // cs.fontSize는 0.1pt 단위 → pt로 변환 (블록의 style.fontSize와 동일 단위)
        if (cs?.fontSize > 0) { baseFontSize = cs.fontSize / 10; break }
      }
    }
  }

  if (baseFontSize <= 0) return

  for (const block of blocks) {
    // 개요 수준(outlineLevel)으로 이미 heading이 된 블록은 스킵
    if (block.type === "heading") continue
    if (block.type !== "paragraph" || !block.text) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200) continue
    if (/^\d+$/.test(text)) continue

    let level = 0

    // 폰트 크기 비율 기반 헤딩 감지 (스타일 정보가 있을 때만)
    if (block.style?.fontSize && baseFontSize > 0) {
      const ratio = block.style.fontSize / baseFontSize
      if (ratio >= HEADING_RATIO_H1) level = 1
      else if (ratio >= HEADING_RATIO_H2) level = 2
      else if (ratio >= HEADING_RATIO_H3) level = 3
    }

    // "제N장/절/편" 패턴 → H2, "제N조" 패턴 → H3 (스타일 유무 무관)
    if (/^제\d+[장절편]\s/.test(text) && text.length <= 50) {
      if (level === 0) level = 2
    } else if (/^제\d+(조의?\d*)\s*[\(（]/.test(text) && text.length <= 80) {
      if (level === 0) level = 3
    }

    if (level > 0) {
      block.type = "heading"
      block.level = level
    }
  }
}

// ─── 메타데이터 추출 (best-effort) ───────────────────

/**
 * OLE2 SummaryInformation 스트림에서 제목/작성자 추출.
 * HWP5는 \005HwpSummaryInformation 또는 \005SummaryInformation에 저장.
 * OLE2 Property Set 포맷의 간이 파싱 — 실패 시 조용히 무시.
 */
function extractHwp5Metadata(cfb: CfbContainer, metadata: DocumentMetadata): void {
  try {
    // HWP 전용 SummaryInformation 먼저, 없으면 표준 OLE2
    const summaryEntry =
      CFB.find(cfb, "/\x05HwpSummaryInformation") ||
      CFB.find(cfb, "/\x05SummaryInformation")
    if (!summaryEntry?.content) return

    const data = Buffer.from(summaryEntry.content)
    if (data.length < 48) return

    // OLE2 Property Set Header: byte order(2) + version(2) + OS(4) + CLSID(16) + numSets(4) = 28
    // Then FMTID(16) + offset(4)
    const numSets = data.readUInt32LE(24)
    if (numSets === 0) return

    const setOffset = data.readUInt32LE(44)
    if (setOffset >= data.length - 8) return

    // Property Set: size(4) + numProperties(4) + [propertyId(4) + offset(4)] * N
    const numProps = data.readUInt32LE(setOffset + 4)
    if (numProps === 0 || numProps > 100) return

    for (let i = 0; i < numProps; i++) {
      const entryOffset = setOffset + 8 + i * 8
      if (entryOffset + 8 > data.length) break

      const propId = data.readUInt32LE(entryOffset)
      const propOffset = setOffset + data.readUInt32LE(entryOffset + 4)
      if (propOffset + 8 > data.length) continue

      // Property ID: 2=Title, 4=Author, 6=Subject/Description
      if (propId !== 2 && propId !== 4 && propId !== 6) continue

      const propType = data.readUInt32LE(propOffset)
      // Type 0x1E = VT_LPSTR (ANSI string)
      if (propType !== 0x1e) continue

      const strLen = data.readUInt32LE(propOffset + 4)
      if (strLen === 0 || strLen > 10000 || propOffset + 8 + strLen > data.length) continue

      const str = data.subarray(propOffset + 8, propOffset + 8 + strLen).toString("utf8").replace(/\0+$/, "").trim()
      if (!str) continue

      if (propId === 2) metadata.title = str
      else if (propId === 4) metadata.author = str
      else if (propId === 6) metadata.description = str
    }
  } catch {
    // best-effort — 실패 시 조용히 무시
  }
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export function extractHwp5MetadataOnly(buffer: Buffer): DocumentMetadata {
  const cfb = CFB.parse(buffer)
  const headerEntry = CFB.find(cfb, "/FileHeader")
  if (!headerEntry?.content) throw new KordocError("FileHeader 스트림 없음")
  const header = parseFileHeader(Buffer.from(headerEntry.content))
  if (header.signature !== "HWP Document File") throw new KordocError("HWP 시그니처 불일치")

  const metadata: DocumentMetadata = {
    version: `${header.versionMajor}.x`,
  }
  extractHwp5Metadata(cfb, metadata)

  const sections = findSections(cfb)
  metadata.pageCount = sections.length

  return metadata
}

/** 배포용 문서: ViewText/Section{N} 스트림을 복호화하여 반환 */
function findViewTextSections(cfb: CfbContainer, compressed: boolean): Buffer[] {
  const sections: Array<{ idx: number; content: Buffer }> = []

  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = CFB.find(cfb, `/ViewText/Section${i}`)
    if (!entry?.content) break
    try {
      const decrypted = decryptViewText(Buffer.from(entry.content), compressed)
      sections.push({ idx: i, content: decrypted })
    } catch {
      // 복호화 실패 시 해당 섹션 스킵
      break
    }
  }

  return sections.sort((a, b) => a.idx - b.idx).map(s => s.content)
}

function findSections(cfb: CfbContainer): Buffer[] {
  const sections: Array<{ idx: number; content: Buffer }> = []

  for (let i = 0; i < MAX_SECTIONS; i++) {
    const entry = CFB.find(cfb, `/BodyText/Section${i}`)
    if (!entry?.content) break
    sections.push({ idx: i, content: Buffer.from(entry.content) })
  }

  if (sections.length === 0 && cfb.FileIndex) {
    for (const entry of cfb.FileIndex) {
      if (sections.length >= MAX_SECTIONS) break
      if (entry.name?.startsWith("Section") && entry.content) {
        const idx = parseInt(entry.name.replace("Section", ""), 10) || 0
        sections.push({ idx, content: Buffer.from(entry.content) })
      }
    }
  }

  return sections.sort((a, b) => a.idx - b.idx).map(s => s.content)
}

/** Lenient CFB: BodyText/Section{N} 탐색 — 누적 압축해제 크기 추적 */
function findSectionsLenient(lcfb: LenientCfbContainer, compressed: boolean): Buffer[] {
  const sections: Array<{ idx: number; content: Buffer }> = []
  let totalDecompressed = 0
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const raw = lcfb.findStream(`/BodyText/Section${i}`) ?? lcfb.findStream(`Section${i}`)
    if (!raw) break
    const content = compressed ? decompressStream(raw) : raw
    totalDecompressed += content.length
    if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
    sections.push({ idx: i, content })
  }
  if (sections.length === 0) {
    // fallback: 이름에 "Section" 포함된 스트림
    for (const e of lcfb.entries()) {
      if (sections.length >= MAX_SECTIONS) break
      if (e.name.startsWith("Section")) {
        const idx = parseInt(e.name.replace("Section", ""), 10) || 0
        const raw = lcfb.findStream(e.name)
        if (raw) {
          const content = compressed ? decompressStream(raw) : raw
          totalDecompressed += content.length
          if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
          sections.push({ idx, content })
        }
      }
    }
  }
  return sections.sort((a, b) => a.idx - b.idx).map(s => s.content)
}

/** Lenient CFB: ViewText/Section{N} 복호화 — 누적 크기 추적 */
function findViewTextSectionsLenient(lcfb: LenientCfbContainer, compressed: boolean): Buffer[] {
  const sections: Array<{ idx: number; content: Buffer }> = []
  let totalDecompressed = 0
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const raw = lcfb.findStream(`/ViewText/Section${i}`) ?? lcfb.findStream(`Section${i}`)
    if (!raw) break
    try {
      const content = decryptViewText(raw, compressed)
      totalDecompressed += content.length
      if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
      sections.push({ idx: i, content })
    } catch { break }
  }
  return sections.sort((a, b) => a.idx - b.idx).map(s => s.content)
}

// ─── 수식 ────────────────────────────────────────────

function formatEquationForMarkdown(equation: string): string {
  const normalized = hwpEquationToLatex(equation)
  if (!normalized) return ""
  return `$${normalized.replace(/\$/g, "\\$")}$`
}

/** 컨트롤 자식 레코드 범위에서 EQEDIT 수식 추출 */
function extractEquationFromSlice(records: HwpRecord[], start: number, end: number): string | null {
  for (let i = start; i < end; i++) {
    if (records[i].tagId !== TAG_EQEDIT) continue
    const equation = extractEquationText(records[i].data)
    return equation ? formatEquationForMarkdown(equation) : null
  }
  return null
}

// ─── 본문 파싱 (문단 리스트 + 컨트롤 디스패치) ───────

/** 문서 전역 파싱 상태 — 섹션 간 유지 (번호 카운터, 머리말/꼬리말 등) */
export interface Hwp5DocState {
  numbering: NumberingState
  /** 구역 정의(secd)의 개요 번호 ID */
  outlineNumberingId: number
  /** 자동 번호 종류(0=쪽,1=각주,2=미주,3=그림,4=표,5=수식)별 다음 번호 */
  autoCounters: Map<number, number>
  headerTexts: Set<string>
  headerBlocks: IRBlock[]
  footerBlocks: IRBlock[]
}

export function createHwp5DocState(): Hwp5DocState {
  return {
    numbering: new NumberingState(),
    outlineNumberingId: 0,
    autoCounters: new Map(),
    headerTexts: new Set(),
    headerBlocks: [],
    footerBlocks: [],
  }
}

interface Hwp5Ctx {
  docInfo: HwpDocInfo | null
  warnings: ParseWarning[]
  sectionNum: number
  doc: Hwp5DocState
  depth: number
}

/** 섹션 레코드 → IRBlock[] (테스트에서 직접 사용 가능하도록 export) */
export function parseSection(
  records: HwpRecord[],
  docInfo: HwpDocInfo | null,
  warnings: ParseWarning[],
  sectionNum: number,
  doc?: Hwp5DocState,
): IRBlock[] {
  const ctx: Hwp5Ctx = { docInfo, warnings, sectionNum, doc: doc ?? createHwp5DocState(), depth: 0 }
  return parseParagraphList(records, 0, records.length, ctx)
}

/**
 * 레코드 범위에서 문단 리스트 파싱 (rhwp body_text.rs parse_paragraph_list 패턴).
 * 표 셀/글상자/머리말/각주 내부에서도 동일하게 재귀 사용된다.
 */
function parseParagraphList(records: HwpRecord[], start: number, end: number, ctx: Hwp5Ctx): IRBlock[] {
  const blocks: IRBlock[] = []
  let i = start
  while (i < end) {
    if (records[i].tagId === TAG_PARA_HEADER) {
      const baseLevel = records[i].level
      let j = i + 1
      while (j < end && records[j].level > baseLevel) j++
      blocks.push(...parseParagraph(records, i, j, ctx))
      i = j
    } else {
      i++
    }
  }
  return blocks
}

/** 문단 내 CTRL_HEADER 1개의 파싱 상태 */
interface ParsedCtrl {
  /** 정규화된 컨트롤 ID (u32, BE 문자열 상수와 비교 가능) */
  id: number
  /** LE로 읽은 원본 ID — PARA_TEXT 인라인 컨트롤과의 대조용 */
  idRaw: number
  /** CTRL_HEADER 레코드 데이터 (ctrl_id 4바이트 포함) */
  data: Buffer
  childStart: number
  childEnd: number
  /** 인라인 치환 텍스트 (수식/자동번호/각주 마커) */
  inlineText?: string
  /** 문단 뒤에 붙는 블록 (표/이미지/글상자) */
  afterBlocks?: IRBlock[]
  /** 각주/미주 내용 ("1) 내용" 형식) */
  footnote?: string
  /** 하이퍼링크 URL (%hlk) */
  href?: string
  /** resolver 중복 매칭 방지 */
  resolved?: boolean
}

/** 문단 1개 파싱 → [문단 블록?, ...컨트롤 파생 블록] */
function parseParagraph(records: HwpRecord[], start: number, end: number, ctx: Hwp5Ctx): IRBlock[] {
  const header = records[start]
  const baseLevel = header.level
  const paraShapeId = header.data.length >= 10 ? header.data.readUInt16LE(8) : -1

  const textRecords: Buffer[] = []
  const charShapeIds: number[] = []
  const ctrls: ParsedCtrl[] = []

  let i = start + 1
  while (i < end) {
    const rec = records[i]

    if (rec.tagId === TAG_CTRL_HEADER && rec.level === baseLevel + 1 && rec.data.length >= 4) {
      // 컨트롤 자식 레코드 범위 수집 (rhwp parse_paragraph 패턴)
      const childStart = i + 1
      let j = childStart
      while (j < end && records[j].level > baseLevel + 1) j++
      const idRaw = rec.data.readUInt32LE(0)
      ctrls.push({ id: normalizeCtrlId(idRaw), idRaw, data: rec.data, childStart, childEnd: j })
      i = j
      continue
    }

    if (rec.tagId === TAG_PARA_TEXT && rec.level === baseLevel + 1) {
      textRecords.push(rec.data)
    } else if (rec.tagId === TAG_CHAR_SHAPE && rec.level === baseLevel + 1 && rec.data.length >= 8) {
      // 구조: [position(u32) + charShapeId(u32)] * N
      for (let offset = 0; offset + 7 < rec.data.length; offset += 8) {
        charShapeIds.push(rec.data.readUInt32LE(offset + 4))
      }
    }
    i++
  }

  // 컨트롤별 효과 계산 (인라인 치환/파생 블록/각주/링크)
  for (const ctrl of ctrls) {
    applyCtrlEffect(ctrl, records, ctx)
  }

  // 텍스트 렌더링 — 확장 컨트롤 인덱스 ↔ CTRL_HEADER 순서 매핑
  const state = createParaTextState()
  const resolver: IndexedControlResolver = (idx, id) => {
    let ctrl = idx >= 0 && idx < ctrls.length ? ctrls[idx] : undefined
    if (!ctrl || (ctrl.idRaw !== id && ctrl.id !== id)) {
      ctrl = ctrls.find(c => !c.resolved && (c.idRaw === id || c.id === id))
    }
    if (!ctrl) return null
    ctrl.resolved = true
    return ctrl.inlineText ?? null
  }
  for (const data of textRecords) {
    appendParaText(state, data, resolver)
  }

  // FIELD_BEGIN/END 범위에 하이퍼링크 적용 — 시작 위치 내림차순으로 안전하게 치환
  let text = state.text
  if (state.fieldRanges.length > 0) {
    const ranges = [...state.fieldRanges].sort((a, b) => b.start - a.start)
    const applied: Array<[number, number]> = []
    for (const r of ranges) {
      const ctrl = ctrls[r.ctrlIdx]
      if (!ctrl?.href || r.end <= r.start) continue
      if (applied.some(([s, e]) => r.start < e && r.end > s)) continue
      const href = sanitizeHref(ctrl.href)
      if (!href) continue
      const anchor = text.slice(r.start, r.end)
      if (!anchor.trim()) continue
      text = text.slice(0, r.start) + `[${anchor}](${href})` + text.slice(r.end)
      applied.push([r.start, r.end])
    }
  }

  const trimmed = text.replace(/\$\$/g, "$ $").trim()

  // 문단번호/글머리표/개요 처리 (DocInfo PARA_SHAPE headType)
  let headingLevel = 0
  let headMarker: string | null = null
  const ps = ctx.docInfo && paraShapeId >= 0 && paraShapeId < ctx.docInfo.paraShapes.length
    ? ctx.docInfo.paraShapes[paraShapeId]
    : null
  if (ps && ps.headType > 0) {
    if (ps.headType === 1) {
      // 개요 — paraLevel 0-6 → heading 1-6 (개요 7수준은 H6로 클램프)
      headingLevel = Math.min(ps.paraLevel + 1, 6)
    }
    if (ps.headType === 1 || ps.headType === 2) {
      // 개요/번호 → NUMBERING 카운터 전진 + ^N 치환
      const nid = ps.numberingId || (ps.headType === 1 ? ctx.doc.outlineNumberingId : 0)
      const numbering = nid >= 1 ? ctx.docInfo?.numberings[nid - 1] : undefined
      if (numbering) {
        const counters = ctx.doc.numbering.advance(nid, ps.paraLevel)
        const fmt = numbering.levelFormats[Math.min(ps.paraLevel, 6)]
        if (fmt) {
          const headText = expandNumberingFormat(fmt, counters, numbering)
          if (headText) headMarker = headText
        }
      }
    } else if (ps.headType === 3) {
      // 글머리표 — U+FFFF는 이미지 글머리표 (문자 렌더링 불가)
      const bullet = ps.numberingId >= 1 ? ctx.docInfo?.bullets[ps.numberingId - 1] : undefined
      if (bullet && bullet.char !== "￿") headMarker = bullet.char
    }
  }

  const blocks: IRBlock[] = []
  const footnotes = ctrls.filter(c => c.footnote).map(c => c.footnote!)

  if (trimmed) {
    const block: IRBlock = {
      type: headingLevel > 0 ? "heading" : "paragraph",
      text: headMarker ? `${headMarker} ${trimmed}` : trimmed,
      pageNumber: ctx.sectionNum,
    }
    if (headingLevel > 0) block.level = headingLevel
    if (ctx.docInfo && charShapeIds.length > 0) {
      const style = resolveCharStyle(charShapeIds, ctx.docInfo)
      if (style) block.style = style
    }
    if (footnotes.length > 0) block.footnoteText = footnotes.join("; ")
    blocks.push(block)
  } else if (footnotes.length > 0) {
    // 본문 없는 각주 anchor — 각주 내용 자체를 문단으로 보존
    blocks.push({ type: "paragraph", text: `(주: ${footnotes.join("; ")})`, pageNumber: ctx.sectionNum })
  }

  // 컨트롤 파생 블록 (표/이미지/글상자) — 컨트롤 순서대로
  for (const ctrl of ctrls) {
    if (ctrl.afterBlocks) blocks.push(...ctrl.afterBlocks)
  }

  return blocks
}

/** 컨트롤 종류별 디스패치 (rhwp control.rs parse_control 대응) */
function applyCtrlEffect(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx): void {
  switch (ctrl.id) {
    case CTRL_TBL: {
      const table = parseTableControl(ctrl, records, ctx)
      if (table) ctrl.afterBlocks = [{ type: "table", table, pageNumber: ctx.sectionNum }]
      return
    }
    case CTRL_GSO: {
      const blocks = parseGsoControl(ctrl, records, ctx)
      if (blocks.length > 0) ctrl.afterBlocks = blocks
      return
    }
    case CTRL_EQED: {
      const eq = extractEquationFromSlice(records, ctrl.childStart, ctrl.childEnd)
      if (eq) ctrl.inlineText = eq
      return
    }
    case CTRL_FN:
    case CTRL_EN: {
      applyNoteEffect(ctrl, records, ctx, ctrl.id === CTRL_FN ? 1 : 2)
      return
    }
    case CTRL_HEAD:
    case CTRL_FOOT: {
      applyHeaderFooterEffect(ctrl, records, ctx, ctrl.id === CTRL_HEAD)
      return
    }
    case CTRL_ATNO: {
      // 자동 번호 (표 144): attr(u32) + number(u16) + 사용자기호 + 앞장식 + 뒤장식 (WCHAR)
      if (ctrl.data.length >= 8) {
        const attr = ctrl.data.readUInt32LE(4)
        const type = attr & 0x0f
        const format = (attr >>> 4) & 0xff
        const num = ctx.doc.autoCounters.get(type) ?? 1
        ctx.doc.autoCounters.set(type, num + 1)
        const prefix = ctrl.data.length >= 14 ? wcharAt(ctrl.data, 12) : ""
        const suffix = ctrl.data.length >= 16 ? wcharAt(ctrl.data, 14) : ""
        ctrl.inlineText = `${prefix}${formatNumber(num, shapeFormatToNumFmt(format))}${suffix}`
      }
      return
    }
    case CTRL_NWNO: {
      // 새 번호 지정 — 해당 종류의 카운터를 재설정 (표시 없음)
      if (ctrl.data.length >= 10) {
        const attr = ctrl.data.readUInt32LE(4)
        const type = attr & 0x0f
        const num = ctrl.data.readUInt16LE(8)
        if (num > 0) ctx.doc.autoCounters.set(type, num)
      }
      return
    }
    case CTRL_SECD: {
      // 구역 정의 — 개요 번호 ID (ctrl_id 4 + flags 4 + 간격 2*3 + tab 4 = offset 18)
      if (ctrl.data.length >= 20) {
        ctx.doc.outlineNumberingId = ctrl.data.readUInt16LE(18)
      }
      return
    }
    case CTRL_OLE: {
      ctx.warnings.push({ page: ctx.sectionNum, message: "스킵된 OLE 개체", code: "SKIPPED_OLE" })
      return
    }
    // 숨은 설명/단 정의/쪽번호 위치/감추기/찾아보기/책갈피/글자겹침/덧말 — 본문 텍스트 없음 또는 의도적 스킵
    case CTRL_TCMT:
    case CTRL_COLD:
    case CTRL_PGNP:
    case CTRL_PGHD:
    case CTRL_IDXM:
    case CTRL_BOKM:
    case CTRL_TCPS:
    case CTRL_TDUT:
    case CTRL_FORM:
      return
    default: {
      if (isFieldCtrlId(ctrl.id)) {
        applyFieldEffect(ctrl)
        return
      }
      // 알 수 없는 컨트롤 — LIST_HEADER 문단 리스트가 있으면 텍스트 보존 (정보손실 방지)
      const blocks = parseListHeaderParagraphs(ctrl, records, ctx)
      if (blocks.length > 0) ctrl.afterBlocks = blocks
    }
  }
}

/** WCHAR 1글자 읽기 (0이면 빈 문자열) */
function wcharAt(data: Buffer, offset: number): string {
  const code = data.readUInt16LE(offset)
  return code > 0 ? String.fromCharCode(code) : ""
}

/** 컨트롤 자식에서 첫 LIST_HEADER 이후의 문단 리스트 파싱 (rhwp find_list_header_paragraphs) */
function parseListHeaderParagraphs(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx): IRBlock[] {
  if (ctx.depth >= MAX_NEST_DEPTH) return []
  for (let i = ctrl.childStart; i < ctrl.childEnd; i++) {
    if (records[i].tagId === TAG_LIST_HEADER) {
      return parseParagraphList(records, i + 1, ctrl.childEnd, { ...ctx, depth: ctx.depth + 1 })
    }
  }
  return []
}

/** 블록 리스트 → 평문 (각주 인라인 포함, 표/이미지는 제외) */
function blocksPlainText(blocks: IRBlock[], sep: string): string {
  const parts: string[] = []
  for (const b of blocks) {
    if (b.type === "image") continue
    if (b.type === "table") continue
    if (b.text) {
      let t = b.text
      if (b.footnoteText) t += ` (주: ${b.footnoteText})`
      parts.push(t)
    }
  }
  return parts.join(sep).trim()
}

/** 각주('fn  ')/미주('en  ') — 번호 + 장식문자 + 내용 (rhwp parse_footnote_control) */
function applyNoteEffect(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx, autoType: number): void {
  // ctrl 데이터: ctrl_id(4) + number(u32) + before(WCHAR) + after(WCHAR) + numberShape(u32)
  // 번호는 각주 내용 안의 atno(자동번호)가 같은 카운터를 소비하므로 peek만 하고,
  // 내용 파싱 후 카운터가 안 움직였으면(atno 없음) 직접 전진시킨다 (rhwp assign_auto_numbers 정합)
  const num = ctx.doc.autoCounters.get(autoType) ?? 1

  let before = ""
  let after = ""
  let shape = 0
  if (ctrl.data.length >= 12) {
    before = wcharAt(ctrl.data, 8)
    after = wcharAt(ctrl.data, 10)
  }
  if (ctrl.data.length >= 16) {
    shape = ctrl.data.readUInt32LE(12) & 0xff
  }
  const formatted = formatNumber(num, shapeFormatToNumFmt(shape))
  const marker = before || after ? `${before}${formatted}${after}` : `${formatted})`

  const content = blocksPlainText(parseListHeaderParagraphs(ctrl, records, ctx), " ")
  if ((ctx.doc.autoCounters.get(autoType) ?? 1) <= num) {
    ctx.doc.autoCounters.set(autoType, num + 1)
  }
  ctrl.inlineText = marker
  // 각주 내용 첫머리의 atno가 이미 같은 마커를 생성했으면 중복 방지
  if (content) ctrl.footnote = content.startsWith(marker) ? content : `${marker} ${content}`
}

/** 머리말('head')/꼬리말('foot') — 문서당 1회, 동일 텍스트 중복 제거 */
function applyHeaderFooterEffect(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx, isHeader: boolean): void {
  const text = blocksPlainText(parseListHeaderParagraphs(ctrl, records, ctx), "\n")
  if (!text) return
  const key = (isHeader ? "h:" : "f:") + text
  if (ctx.doc.headerTexts.has(key)) return
  ctx.doc.headerTexts.add(key)
  const block: IRBlock = { type: "paragraph", text, pageNumber: ctx.sectionNum }
  if (isHeader) ctx.doc.headerBlocks.push(block)
  else ctx.doc.footerBlocks.push(block)
}

/** 필드 컨트롤(%hlk/%clk 등) — command 파싱 (rhwp parse_field_control, 표 154) */
function applyFieldEffect(ctrl: ParsedCtrl): void {
  if (ctrl.id === FIELD_HLK) {
    const command = parseFieldCommand(ctrl.data)
    if (command) {
      const url = hyperlinkUrlFromCommand(command)
      if (url) ctrl.href = url
    }
  }
  // %clk(누름틀) 등 기타 필드: anchor 텍스트는 PARA_TEXT에 있으므로 그대로 보존됨
}

/** 필드 CTRL_HEADER 데이터에서 command 추출 — ctrl_id(4) + 속성(4) + 기타(1) + len(u16) + UTF-16LE */
function parseFieldCommand(data: Buffer): string | null {
  if (data.length < 11) return null
  const cmdLen = data.readUInt16LE(9)
  if (cmdLen === 0) return null
  const start = 11
  const end = start + cmdLen * 2
  if (end > data.length) return null
  return data.subarray(start, end).toString("utf16le").replace(/\0+$/, "")
}

/** %hlk command에서 URL 추출 — 첫 ';' 구분 토큰 ('\;' 이스케이프 존중). mailto/책갈피(#) 포함 */
function hyperlinkUrlFromCommand(command: string): string | null {
  let url = ""
  for (let i = 0; i < command.length; i++) {
    const c = command[i]
    if (c === "\\" && i + 1 < command.length) {
      url += command[i + 1]
      i++
      continue
    }
    if (c === ";") break
    url += c
  }
  url = url.trim()
  return url.length > 0 && url.length < 2000 ? url : null
}

// ─── 표 파싱 ─────────────────────────────────────────

/** HWP5 셀 — CellContext + 중첩 구조 */
interface Hwp5Cell extends CellContext {
  blocks?: IRBlock[]
  isHeader?: boolean
}

/**
 * 표 컨트롤 파싱 (rhwp parse_table_control).
 * HWPTAG_TABLE 레코드 '이전'의 LIST_HEADER는 캡션, '이후'는 셀.
 */
function parseTableControl(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx): IRTable | null {
  if (ctx.depth >= MAX_NEST_DEPTH) return null
  const { childStart, childEnd } = ctrl

  // HWPTAG_TABLE 레코드에서 행/열 수
  let rows = 0
  let cols = 0
  let tableIdx = -1
  for (let i = childStart; i < childEnd; i++) {
    if (records[i].tagId === TAG_TABLE && records[i].data.length >= 8) {
      rows = Math.min(records[i].data.readUInt16LE(4), MAX_ROWS)
      cols = Math.min(records[i].data.readUInt16LE(6), MAX_COLS)
      tableIdx = i
      break
    }
  }
  if (tableIdx < 0 || rows === 0 || cols === 0) return null

  // 캡션: TABLE 레코드 이전의 LIST_HEADER
  let caption: string | undefined
  for (let i = childStart; i < tableIdx; i++) {
    if (records[i].tagId === TAG_LIST_HEADER) {
      const capBlocks = parseParagraphList(records, i + 1, tableIdx, { ...ctx, depth: ctx.depth + 1 })
      const capText = blocksPlainText(capBlocks, " ")
      if (capText) caption = capText
      break
    }
  }

  // 셀: TABLE 레코드 이후의 LIST_HEADER
  const cells: Hwp5Cell[] = []
  let i = tableIdx + 1
  while (i < childEnd) {
    const rec = records[i]
    if (rec.tagId === TAG_LIST_HEADER) {
      const cellLevel = rec.level
      let j = i + 1
      while (j < childEnd) {
        const r = records[j]
        if (r.level < cellLevel) break
        if (r.level === cellLevel && (r.tagId === TAG_LIST_HEADER || r.tagId === TAG_TABLE)) break
        j++
      }
      cells.push(parseCell(records, i, j, ctx))
      i = j
      continue
    }
    i++
  }

  if (cells.length === 0) return null

  // colAddr/rowAddr가 있으면 arrangeCells가 완성된 그리드를 반환 — 직접 IRTable 생성
  const hasAddr = cells.some(c => c.colAddr !== undefined && c.rowAddr !== undefined)
  if (hasAddr) {
    const cellRows = arrangeCells(rows, cols, cells)
    const irCells: IRCell[][] = cellRows.map(row => row.map(c => {
      const ir: IRCell = { text: c.text.trim(), colSpan: c.colSpan, rowSpan: c.rowSpan }
      if (c.blocks?.length) ir.blocks = c.blocks
      if (c.isHeader) ir.isHeader = true
      return ir
    }))
    const table: IRTable = { rows, cols, cells: irCells, hasHeader: rows > 1 }
    if (caption) table.caption = caption
    return table
  }

  const cellRows = arrangeCells(rows, cols, cells)
  const table = buildTable(cellRows)
  if (caption && table.rows > 0) table.caption = caption
  return table.rows > 0 ? table : null
}

/**
 * 표 셀 파싱 (rhwp parse_cell) — LIST_HEADER 구조:
 *   paraCount(u16) + listAttr(u32) + widthRef(u16) + colAddr(u16) + rowAddr(u16) + colSpan(u16) + rowSpan(u16)
 *   offset: 0          2              6              8              10             12             14
 * widthRef bit 2 = 제목 셀(is_header).
 * 셀 내부 문단 리스트는 재귀 파싱 — 중첩표는 IRCell.blocks에 IRBlock(type:'table')로 보존.
 */
function parseCell(records: HwpRecord[], lhIdx: number, end: number, ctx: Hwp5Ctx): Hwp5Cell {
  const rec = records[lhIdx]
  let colSpan = 1
  let rowSpan = 1
  let colAddr: number | undefined
  let rowAddr: number | undefined
  let isHeader = false
  if (rec.data.length >= 16) {
    isHeader = (rec.data.readUInt16LE(6) & 0x04) !== 0
    colAddr = rec.data.readUInt16LE(8)
    rowAddr = rec.data.readUInt16LE(10)
    const cs = rec.data.readUInt16LE(12)
    const rs = rec.data.readUInt16LE(14)
    if (cs > 0) colSpan = Math.min(cs, MAX_COLS)
    if (rs > 0) rowSpan = Math.min(rs, MAX_ROWS)
  }

  const blocks = ctx.depth < MAX_NEST_DEPTH
    ? parseParagraphList(records, lhIdx + 1, end, { ...ctx, depth: ctx.depth + 1 })
    : []

  // 하위 호환 텍스트: 문단 평탄화 + 이미지 sentinel + 중첩표 평문
  const parts: string[] = []
  let hasStructure = false
  for (const b of blocks) {
    if (b.type === "image" && b.text) {
      parts.push(`![image](hwp5bin:${b.text})`)
      hasStructure = true
    } else if (b.type === "table" && b.table) {
      // flattenLayoutTables 경유 시를 위한 평문 — 구조는 blocks가 보존
      const flat = convertTableToText(b.table.cells)
      if (flat) parts.push(flat)
      hasStructure = true
    } else if (b.text) {
      let t = b.text
      if (b.footnoteText) {
        t += ` (주: ${b.footnoteText})`
        hasStructure = true
      }
      parts.push(t)
    }
  }
  const cell: Hwp5Cell = { text: parts.join("\n"), colSpan, rowSpan, colAddr, rowAddr }
  if (hasStructure && blocks.length > 0) cell.blocks = blocks
  if (isHeader) cell.isHeader = true
  return cell
}

function arrangeCells(rows: number, cols: number, cells: Hwp5Cell[]): Hwp5Cell[][] {
  const grid: (Hwp5Cell | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null))

  // colAddr/rowAddr가 있으면 직접 배치 (HWP5 병합 테이블 정확도 향상)
  const hasAddr = cells.some(c => c.colAddr !== undefined && c.rowAddr !== undefined)

  if (hasAddr) {
    for (const cell of cells) {
      const r = cell.rowAddr ?? 0
      const c = cell.colAddr ?? 0
      if (r >= rows || c >= cols) continue
      grid[r][c] = cell

      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < rows && c + dc < cols)
            grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 }
        }
      }
    }
  } else {
    // fallback: 순차 배치 (colAddr 없는 경우)
    let cellIdx = 0
    for (let r = 0; r < rows && cellIdx < cells.length; r++) {
      for (let c = 0; c < cols && cellIdx < cells.length; c++) {
        if (grid[r][c] !== null) continue
        const cell = cells[cellIdx++]
        grid[r][c] = cell

        for (let dr = 0; dr < cell.rowSpan; dr++) {
          for (let dc = 0; dc < cell.colSpan; dc++) {
            if (dr === 0 && dc === 0) continue
            if (r + dr < rows && c + dc < cols)
              grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 }
          }
        }
      }
    }
  }

  return grid.map(row => row.map(c => c || { text: "", colSpan: 1, rowSpan: 1 }))
}

// ─── 그리기 개체(GSO) 파싱 ───────────────────────────

/**
 * GSO 컨트롤 파싱 (rhwp parse_gso_control).
 * - SHAPE_COMPONENT '이전' LIST_HEADER = 캡션
 * - SHAPE_COMPONENT '이후' 첫 LIST_HEADER = 글상자 문단 리스트
 * - SHAPE_COMPONENT_PICTURE 레코드 → binDataId(고정 오프셋 71) → 이미지 블록
 */
function parseGsoControl(ctrl: ParsedCtrl, records: HwpRecord[], ctx: Hwp5Ctx): IRBlock[] {
  if (ctx.depth >= MAX_NEST_DEPTH) return []
  const { childStart, childEnd } = ctrl
  const blocks: IRBlock[] = []

  // 첫 SHAPE_COMPONENT(_CONTAINER) 위치
  let scIdx = -1
  for (let i = childStart; i < childEnd; i++) {
    const t = records[i].tagId
    if (t === TAG_SHAPE_COMPONENT || t === TAG_SHAPE_COMPONENT_CONTAINER) {
      scIdx = i
      break
    }
  }

  // 캡션: SHAPE_COMPONENT 이전의 LIST_HEADER
  if (scIdx > childStart) {
    for (let i = childStart; i < scIdx; i++) {
      if (records[i].tagId === TAG_LIST_HEADER) {
        blocks.push(...parseParagraphList(records, i + 1, scIdx, { ...ctx, depth: ctx.depth + 1 }))
        break
      }
    }
  }

  // 글상자: SHAPE_COMPONENT 이후 첫 LIST_HEADER부터 끝까지
  const scanStart = scIdx >= 0 ? scIdx + 1 : childStart
  let textListIdx = -1
  for (let i = scanStart; i < childEnd; i++) {
    if (records[i].tagId === TAG_LIST_HEADER) {
      textListIdx = i
      break
    }
  }

  // 그림: 글상자 리스트 이전 구간에서 SHAPE_COMPONENT_PICTURE 스캔
  // (글상자 내부의 중첩 gso 그림은 문단 리스트 재귀에서 처리되므로 이중 집계 없음)
  const picEnd = textListIdx >= 0 ? textListIdx : childEnd
  for (let i = scanStart; i < picEnd; i++) {
    if (records[i].tagId === TAG_SHAPE_COMPONENT_PICTURE) {
      const img = pictureToImageBlock(records[i].data, ctx)
      if (img) blocks.push(img)
    }
  }

  if (textListIdx >= 0) {
    blocks.push(...parseParagraphList(records, textListIdx + 1, childEnd, { ...ctx, depth: ctx.depth + 1 }))
  }

  return blocks
}

/**
 * SHAPE_COMPONENT_PICTURE → 이미지 블록.
 * rhwp parse_picture(shape.rs)의 고정 레이아웃:
 *   borderColor(4) + borderWidth(4) + borderAttr(4) + 꼭짓점 x4/y4(32) + crop(16)
 *   + padding(8) + 밝기(1)/대비(1)/효과(1) = 71 → binDataId(u16 @71)
 * binDataId는 DocInfo BIN_DATA 1-based 인덱스 → storage_id로 변환 (스트림명 BIN%04X 16진).
 */
function pictureToImageBlock(data: Buffer, ctx: Hwp5Ctx): IRBlock | null {
  if (data.length < 73) return null
  const binDataId = data.readUInt16LE(71)
  if (binDataId === 0) return null

  const item = ctx.docInfo?.binData[binDataId - 1]
  if (item?.kind === "link") {
    ctx.warnings.push({ page: ctx.sectionNum, message: `외부 연결 이미지 (binDataId ${binDataId})`, code: "SKIPPED_IMAGE" })
    return null
  }
  // DocInfo BIN_DATA가 없으면 binDataId == storageId 관례에 폴백
  const storageId = item && item.storageId > 0 ? item.storageId : binDataId
  return { type: "image", text: String(storageId), pageNumber: ctx.sectionNum }
}

// ─── 스타일 ──────────────────────────────────────────

/** CHAR_SHAPE ID 배열에서 대표 스타일 결정 (최빈값) */
function resolveCharStyle(charShapeIds: number[], docInfo: HwpDocInfo): InlineStyle | undefined {
  if (charShapeIds.length === 0 || docInfo.charShapes.length === 0) return undefined

  // 가장 많이 나타나는 charShapeId 사용
  const freq = new Map<number, number>()
  let maxCount = 0, dominantId = charShapeIds[0]
  for (const id of charShapeIds) {
    const count = (freq.get(id) || 0) + 1
    freq.set(id, count)
    if (count > maxCount) { maxCount = count; dominantId = id }
  }

  const cs = docInfo.charShapes[dominantId]
  if (!cs) return undefined

  const style: InlineStyle = {}
  if (cs.fontSize > 0) style.fontSize = cs.fontSize / 10  // 0.1pt → pt
  if (cs.attrFlags & 0x01) style.italic = true
  if (cs.attrFlags & 0x02) style.bold = true

  return (style.fontSize || style.bold || style.italic) ? style : undefined
}
