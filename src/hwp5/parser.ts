/** HWP 5.x 바이너리 파서 — OLE2 컨테이너 → 섹션 → Markdown */

import {
  readRecords, decompressStream, parseFileHeader, parseDocInfo, FLAG_COMPRESSED, FLAG_ENCRYPTED,
  FLAG_DISTRIBUTION, FLAG_DRM, type HwpRecord, type HwpDocInfo, type HwpFileHeader,
} from "./record.js"
import { extractHwp5Images, extractHwp5ImagesLenient, collectHwp5BinData, collectHwp5BinDataLenient } from "./images.js"
import { inlineImagesIntoMarkdown } from "../image/transcode.js"
import { decryptViewText } from "./crypto.js"
import { parseLenientCfb, type LenientCfbContainer } from "./cfb-lenient.js"
import { blocksToMarkdown, flattenLayoutTables, dedupeRunningHeaders } from "../table/builder.js"
import type { IRBlock, DocumentMetadata, InternalParseResult, ParseOptions, ParseWarning, OutlineItem } from "../types.js"
import { HEADING_RATIO_H1, HEADING_RATIO_H2, HEADING_RATIO_H3 } from "../types.js"
import { assertDecryptedDocInfo, assertSupportedEncryptVersion, decryptPasswordStream, readEncryptVersion } from "./pw-crypto.js"
import { KordocError } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { detectHwp5SectionPages, type Hwp5SectionPageDetect } from "./page-boundary.js"
import { indexHwp5Tables } from "./table-ids.js"
import { parseSection, createHwp5DocState } from "./body.js"

export { parseSection, createHwp5DocState, hasRealStrike, hasRealUnderline, type Hwp5DocState } from "./body.js"

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

/**
 * 열린 HWP5 컨테이너 — 파서와 렌더 어댑터(#75 Task 7)가 공유하는 스트림 접근 계층.
 * strict CFB → lenient 폴백, DRM 거부, 암호 문서 복호(findStream 에 내장), 압축·배포용 플래그.
 */
export interface Hwp5Container {
  cfb: CfbContainer | null
  lenientCfb: LenientCfbContainer | null
  header: HwpFileHeader
  compressed: boolean
  distribution: boolean
  encrypted: boolean
  /** 스트림 읽기 — 암호 문서는 복호를 거친다 */
  findStream: (path: string) => Buffer | null
  warnings: ParseWarning[]
}

export function openHwp5Container(buffer: Buffer, options?: Pick<ParseOptions, "password">): Hwp5Container {
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
  const readRawStream = (path: string): Buffer | null => {
    if (cfb) {
      const entry = CFB.find(cfb, path)
      return entry?.content ? Buffer.from(entry.content) : null
    }
    return lenientCfb!.findStream(path)
  }

  const headerData = readRawStream("/FileHeader")
  if (!headerData) throw new KordocError("FileHeader 스트림 없음")
  const header = parseFileHeader(headerData)
  if (header.signature !== "HWP Document File") throw new KordocError("HWP 시그니처 불일치")
  if (header.flags & FLAG_DRM) throw new KordocError("DRM 보호된 HWP는 지원하지 않습니다")

  // 비밀번호 암호 문서 — FileHeader 외 모든 스트림이 AES-CFB 로 암호화되어 있다.
  // 복호를 findStream 래퍼에 끼워 넣어 이후 경로가 평문 문서와 같아지게 한다.
  const encrypted = (header.flags & FLAG_ENCRYPTED) !== 0
  if (encrypted) {
    if (!options?.password) {
      throw new KordocError("암호로 보호된 HWP 문서입니다. password 옵션에 열기 암호를 지정하세요.")
    }
    assertSupportedEncryptVersion(readEncryptVersion(headerData))
  }
  const password = encrypted ? options!.password! : undefined
  const findStream = (path: string): Buffer | null => {
    const raw = readRawStream(path)
    if (!raw || !password) return raw
    return decryptPasswordStream(raw, password)
  }

  const compressed = (header.flags & FLAG_COMPRESSED) !== 0
  const distribution = (header.flags & FLAG_DISTRIBUTION) !== 0

  // 암호 문서는 여기서 비밀번호를 검증한다 — DocInfo·섹션 파싱은 실패를 경고로 흡수해서,
  // 오답으로 나온 난수 데이터가 "성공했는데 내용이 쓰레기"인 결과로 흘러가기 때문이다.
  if (encrypted) {
    const rawDocInfo = findStream("/DocInfo")
    if (!rawDocInfo) throw new KordocError("DocInfo 스트림 없음")
    let docInfoData: Buffer
    try {
      docInfoData = compressed ? decompressStream(rawDocInfo) : rawDocInfo
    } catch {
      throw new KordocError("비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다.")
    }
    assertDecryptedDocInfo(docInfoData, readRecords)
  }

  return { cfb, lenientCfb, header, compressed, distribution, encrypted, findStream, warnings }
}

/** DocInfo 원시 레코드 (best-effort) — 렌더 어댑터가 FACE_NAME·BORDER_FILL 등 파서가 안 쓰는 레코드를 읽는다 */
export function readHwp5DocInfoRecords(c: Hwp5Container): HwpRecord[] | null {
  try {
    const raw = c.findStream("/DocInfo")
    if (!raw) return null
    return readRecords(c.compressed ? decompressStream(raw) : raw)
  } catch {
    return null
  }
}

/** 섹션 원시 스트림 — 배포용은 복호+압축해제 완료, 그 외는 readHwp5SectionRecords 가 압축을 푼다 */
export function readHwp5SectionStreams(c: Hwp5Container): Buffer[] {
  return c.distribution
    ? (c.cfb ? findViewTextSections(c.cfb, c.compressed) : findViewTextSectionsLenient(c.lenientCfb!, c.compressed))
    : c.encrypted
      ? findSectionsVia(c.findStream)
      : (c.cfb ? findSections(c.cfb) : findSectionsLenient(c.lenientCfb!, c.compressed))
}

/** 섹션 스트림 → 레코드 (누적 압축해제 상한). 실패한 섹션은 null + PARTIAL_PARSE 경고 */
export function readHwp5SectionRecords(c: Hwp5Container, sections: Buffer[], warnings: ParseWarning[]): (HwpRecord[] | null)[] {
  const out: (HwpRecord[] | null)[] = []
  let totalDecompressed = 0
  for (let si = 0; si < sections.length; si++) {
    try {
      // 배포용 문서는 findViewTextSections에서 이미 복호화+압축해제 완료
      const data = (!c.distribution && c.compressed) ? decompressStream(Buffer.from(sections[si])) : Buffer.from(sections[si])
      totalDecompressed += data.length
      if (totalDecompressed > MAX_TOTAL_DECOMPRESS) throw new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")
      out.push(readRecords(data))
    } catch (secErr) {
      if (secErr instanceof KordocError) throw secErr
      out.push(null)
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    }
  }
  return out
}

/** BinData 스토리지 — storageId(16진 BIN%04X) → 바이트(항목별 압축 정규화) */
export function readHwp5BinData(c: Hwp5Container): Map<number, { data: Buffer; name: string }> {
  return c.cfb ? collectHwp5BinData(c.cfb.FileIndex) : collectHwp5BinDataLenient(c.lenientCfb!)
}

export function parseHwp5Document(buffer: Buffer, options?: ParseOptions): InternalParseResult {
  const c = openHwp5Container(buffer, options)
  const { cfb, lenientCfb, compressed, encrypted, findStream, warnings } = c

  const metadata: DocumentMetadata = {
    version: `${c.header.versionMajor}.x`,
  }
  if (cfb) extractHwp5Metadata(cfb, metadata)

  // DocInfo 파싱 (스타일 정보 추출)
  // 암호 문서는 복호를 거치는 findStream 경로로 — cfb 직접 접근은 암호문을 읽는다
  const docInfo = cfb && !encrypted
    ? parseDocInfoStream(cfb, compressed)
    : parseDocInfoFromStream(findStream("/DocInfo"), compressed)

  const sections = readHwp5SectionStreams(c)
  if (sections.length === 0) throw new KordocError("섹션 스트림을 찾을 수 없습니다")

  // (#66) 1단계: 섹션 레코드 확보 + 실제 페이지 프리패스 — 조판 캐시(PARA_LINE_SEG)가
  // 전 섹션에서 신뢰 가능하면 layout 모드(실제 페이지), 아니면 종전 섹션 근사.
  const sectionRecords = readHwp5SectionRecords(c, sections, warnings)
  const sectionDetects: (Hwp5SectionPageDetect | null)[] = sectionRecords.map(r => r ? detectHwp5SectionPages(r) : null)
  // 표 순번(sourceId) 프리패스 — 렌더 어댑터(#75)와 같은 규칙(table-ids.ts)
  const sectionTableIds: Map<number, string>[] = []
  {
    let base = 0
    for (const r of sectionRecords) {
      const ix = indexHwp5Tables(r ?? [], base)
      sectionTableIds.push(ix.ids)
      base += ix.count
    }
  }

  const layoutPages = sectionDetects.length > 0 && sectionDetects.every(d => d != null && d.usable)
  metadata.pageMode = layoutPages ? "layout" : "section"
  metadata.pageCount = layoutPages
    ? Math.max(sectionDetects.reduce((sum, d) => sum + (d?.pages ?? 0), 0), 1)
    : sections.length
  const pageFilter = options?.pages ? parsePageRange(options.pages, metadata.pageCount) : null
  if (pageFilter && !layoutPages) {
    warnings.push({ code: "PAGE_BOUNDARY_APPROXIMATE", message: "조판 캐시가 없어 pages 필터를 섹션 단위 근사로 적용했습니다" })
  }

  // 2단계: 본문 파싱 — layout 모드는 전 섹션 파싱 후 블록 단위 필터,
  // 섹션 근사는 종전(v4.7.2까지)처럼 섹션 스킵
  let bodyBlocks: IRBlock[] = []
  const doc = createHwp5DocState()
  doc.keepTrailingEmptyCols = options?.keepTrailingEmptyCols
  let parsedSections = 0
  let pageBase = 0
  for (let si = 0; si < sections.length; si++) {
    const records = sectionRecords[si]
    if (!records) continue
    const detect = sectionDetects[si]!
    if (!layoutPages && pageFilter && !pageFilter.has(si + 1)) continue
    try {
      const sectionBlocks = parseSection(records, docInfo, warnings, si + 1, doc,
        layoutPages ? { base: pageBase, pageAtPara: detect.pageAtPara } : undefined, sectionTableIds[si])
      bodyBlocks.push(...sectionBlocks)
      parsedSections++
      options?.onProgress?.(parsedSections, sections.length)
    } catch (secErr) {
      if (secErr instanceof KordocError) throw secErr
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    } finally {
      pageBase += detect.pages
    }
  }

  // layout 모드 페이지 필터 — 실제 페이지 기준 블록 필터링
  if (pageFilter && layoutPages) {
    bodyBlocks = bodyBlocks.filter(b => b.pageNumber != null && pageFilter.has(b.pageNumber))
  }

  // 머리말은 문서 맨 앞, 꼬리말은 맨 뒤에 1회 출력
  const blocks: IRBlock[] = [...doc.headerBlocks, ...bodyBlocks, ...doc.footerBlocks]

  // BinData에서 이미지 추출 — 전체 파싱 시 본문 미참조 BinData 이미지도 스윕
  const images = cfb
    ? extractHwp5Images(cfb.FileIndex, blocks, warnings, !pageFilter)
    : extractHwp5ImagesLenient(lenientCfb!, blocks, warnings, !pageFilter)

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

  let markdown = blocksToMarkdown(flatBlocks)
  // 이미지 인라인 옵션 — BMP→PNG 압축 후 base64 data URI 로 치환 (AI 에이전트 자체 완결형 마크다운)
  if (options?.inlineImages && options.images !== false && images.length > 0) {
    try {
      markdown = inlineImagesIntoMarkdown(markdown, images, { compress: true })
    } catch (inlineErr) {
      // 설계 계약상 bmpToPng 는 실패 시 null 을 반환하지만, 극단 입력·Node 버전차로 할당이
      // throw 하면 전체 파싱이 죽지 않도록 원본(비인라인) 마크다운을 유지하고 경고만 남긴다.
      warnings.push({ message: `이미지 인라인 실패 — 원본 파일 참조로 폴백: ${inlineErr instanceof Error ? inlineErr.message : "알 수 없는 오류"}`, code: "SKIPPED_IMAGE" })
    }
  }
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

const VT_I2 = 0x02, VT_LPSTR = 0x1e, VT_LPWSTR = 0x1f, VT_FILETIME = 0x40
/** VT_LPSTR 코드 페이지 → TextDecoder 레이블 (1250~1258 은 windows-N) */
const CODE_PAGE_LABELS: Record<number, string> = { 949: "euc-kr", 932: "shift_jis", 936: "gbk", 950: "big5", 65001: "utf-8" }

/**
 * OLE2 SummaryInformation 스트림에서 제목/작성자/설명/키워드/날짜 추출.
 * HWP5는 \005HwpSummaryInformation 또는 \005SummaryInformation에 저장.
 * OLE2 Property Set 포맷의 간이 파싱 — 실패 시 조용히 무시.
 * 한컴 HwpSummaryInformation(FMTID 9FA2B660-1061-11D4-B4C6-006097C09D8C)은 코드 페이지 속성 없이 문자열을 전부
 * VT_LPWSTR 로 쓴다(코퍼스 1,435건 전부) — 종전엔 VT_LPSTR 만 읽어 제목·지은이가 한 번도 안 나왔다.
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

    // 속성 ID → 값 위치(type 4바이트부터). 코드 페이지(1)가 문자열 뒤에 올 수 있어 표를 먼저 모은다
    const props = new Map<number, number>()
    for (let i = 0; i < numProps; i++) {
      const entryOffset = setOffset + 8 + i * 8
      if (entryOffset + 8 > data.length) break
      const propOffset = setOffset + data.readUInt32LE(entryOffset + 4)
      if (propOffset + 8 <= data.length) props.set(data.readUInt32LE(entryOffset), propOffset)
    }
    const cpAt = props.get(1) // PID_CODEPAGE (VT_I2) — VT_LPSTR 해석용
    const codePage = cpAt !== undefined && data.readUInt32LE(cpAt) === VT_I2 ? data.readUInt16LE(cpAt + 4) : 0
    const text = (id: number) => { const at = props.get(id); return at === undefined ? undefined : readPropString(data, at, codePage) }
    const time = (id: number) => { const at = props.get(id); return at === undefined ? undefined : readPropFileTime(data, at) }

    // SummaryInformation 번호(한컴 FMTID 도 같음): 2 제목·3 주제·4 지은이·5 키워드·6 설명·12 만든 날짜·13 마지막 저장.
    // HWPX 짝 content.hpf 의 opf:title·subject·creator·keyword·description·CreatedDate 와 같은 값(한컴 저장 쌍 209건 실측).
    // 설명이 비면 주제 — HWPX metadata.ts(description → subject)·PDF(Subject) 와 같은 자리
    const title = text(2), author = text(4), description = text(6) || text(3)
    if (title) metadata.title = title
    if (author) metadata.author = author
    if (description) metadata.description = description
    const keywords = text(5)?.split(/[,;]/).map(k => k.trim()).filter(Boolean)
    if (keywords?.length) metadata.keywords = keywords
    const createdAt = time(12), modifiedAt = time(13)
    if (createdAt) metadata.createdAt = createdAt
    if (modifiedAt) metadata.modifiedAt = modifiedAt
  } catch {
    // best-effort — 실패 시 조용히 무시
  }
}

/**
 * 문자열 속성 값 (at = type 위치). VT_LPWSTR: 글자 수(UTF-16 단위, NUL 포함) + UTF-16LE,
 * VT_LPSTR: 바이트 수(NUL 포함) + 코드 페이지 문자열(1200 = UTF-16LE, 없음·모름 = UTF-8 — 종전 동작).
 * 값 뒤 4바이트 정렬 패딩은 오프셋 표로 찾으므로 무관
 */
function readPropString(data: Buffer, at: number, codePage: number): string | undefined {
  const type = data.readUInt32LE(at)
  const unit = type === VT_LPWSTR ? 2 : type === VT_LPSTR ? 1 : 0
  const count = data.readUInt32LE(at + 4)
  if (!unit || count === 0 || count > 10000 || at + 8 + count * unit > data.length) return undefined
  const bytes = data.subarray(at + 8, at + 8 + count * unit)
  let s: string
  if (unit === 2 || codePage === 1200) s = bytes.toString("utf16le")
  else {
    const label = CODE_PAGE_LABELS[codePage] ?? (codePage >= 1250 && codePage <= 1258 ? `windows-${codePage}` : "utf-8")
    try { s = new TextDecoder(label).decode(bytes) } catch { s = bytes.toString("utf8") } // ICU 없는 Node — 레이블 미지원
  }
  const nul = s.indexOf("\0")
  return (nul >= 0 ? s.slice(0, nul) : s).trim() || undefined
}

/** VT_FILETIME — 1601-01-01 UTC 부터 100ns 단위 u64 → ISO 8601 초 단위(content.hpf CreatedDate 꼴). 0(미기록)은 undefined */
function readPropFileTime(data: Buffer, at: number): string | undefined {
  if (data.readUInt32LE(at) !== VT_FILETIME || at + 12 > data.length) return undefined
  const ticks = data.readBigUInt64LE(at + 4)
  if (ticks === 0n) return undefined
  // 초로 먼저 나눠 정수 연산 — u64 를 double 로 옮기면 정각 값이 1초 앞당겨질 수 있다
  return new Date((Number(ticks / 10000000n) - 11644473600) * 1000).toISOString().replace(".000Z", "Z")
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

/** 스트림 리더로 BodyText 섹션 수집 — 압축 해제는 호출부가 맡는다(findSections와 같은 계약) */
function findSectionsVia(read: (path: string) => Buffer | null): Buffer[] {
  const sections: Buffer[] = []
  for (let i = 0; i < MAX_SECTIONS; i++) {
    const raw = read(`/BodyText/Section${i}`)
    if (!raw) break
    sections.push(raw)
  }
  return sections
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
