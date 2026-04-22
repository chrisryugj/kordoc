/** HWP 5.x 바이너리 파서 — OLE2 컨테이너 → 섹션 → Markdown */

import {
  readRecords, decompressStream, parseFileHeader, extractTextWithControls, extractEquationText, parseDocInfo,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CHAR_SHAPE, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  TAG_EQEDIT,
  FLAG_COMPRESSED, FLAG_ENCRYPTED, FLAG_DISTRIBUTION, FLAG_DRM,
  type HwpRecord, type HwpDocInfo, type HwpCharShape, type HwpParaShape,
} from "./record.js"
import { decryptViewText } from "./crypto.js"
import { hwpEquationToLatex } from "./equation.js"
import { parseLenientCfb, type LenientCfbContainer } from "./cfb-lenient.js"
import { buildTable, blocksToMarkdown, flattenLayoutTables, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, IRTable, DocumentMetadata, InternalParseResult, ParseOptions, ParseWarning, OutlineItem, InlineStyle, ExtractedImage } from "../types.js"
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

  const blocks: IRBlock[] = []
  const nestedTableCounter = { count: 0 }
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
      const sectionBlocks = parseSection(records, docInfo, warnings, si + 1, nestedTableCounter)
      blocks.push(...sectionBlocks)
      parsedSections++
      options?.onProgress?.(parsedSections, totalTarget)
    } catch (secErr) {
      if (secErr instanceof KordocError) throw secErr
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    }
  }

  // BinData에서 이미지 추출
  const images = cfb
    ? extractHwp5Images(cfb, blocks, compressed, warnings)
    : extractHwp5ImagesLenient(lenientCfb!, blocks, compressed, warnings)

  // 레이아웃 테이블 해체 (heading 감지 전에 수행하여 해체된 텍스트도 heading 감지 대상)
  const flatBlocks = flattenLayoutTables(blocks)

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
  // 기본 폰트 크기 결정 (본문 스타일 또는 가장 많이 사용되는 크기)
  let baseFontSize = 0

  // "바탕글", "본문" 등 본문 스타일 찾기
  for (const style of docInfo.styles) {
    const name = (style.nameKo || style.name).toLowerCase()
    if (name.includes("바탕") || name.includes("본문") || name === "normal" || name === "body") {
      const cs = docInfo.charShapes[style.charShapeId]
      // cs.fontSize는 0.1pt 단위 → pt로 변환 (블록의 style.fontSize와 동일 단위)
      if (cs?.fontSize > 0) { baseFontSize = cs.fontSize / 10; break }
    }
  }

  // 본문 스타일 못 찾으면 블록의 폰트 크기 중 최빈값 사용
  if (baseFontSize === 0) {
    const sizeFreq = new Map<number, number>()
    for (const b of blocks) {
      if (b.style?.fontSize) {
        sizeFreq.set(b.style.fontSize, (sizeFreq.get(b.style.fontSize) || 0) + 1)
      }
    }
    let maxCount = 0
    for (const [size, count] of sizeFreq) {
      if (count > maxCount) { maxCount = count; baseFontSize = size }
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

// ─── BinData ���미지 추출 ─────��─────────────────��────

/** SHAPE_COMPONENT 태그 — HWP5 스펙 */
const TAG_SHAPE_COMPONENT = 0x004a
const CTRL_ID_EQEDIT = "deqe"

/** gso 제어 뒤의 하위 레코드에서 binDataId 추출 (best-effort) */
function extractBinDataId(records: HwpRecord[], ctrlIdx: number): number {
  const ctrlLevel = records[ctrlIdx].level
  // CTRL_HEADER 이후의 하위 레코드들을 순회
  for (let j = ctrlIdx + 1; j < records.length && j < ctrlIdx + 50; j++) {
    const r = records[j]
    if (r.level <= ctrlLevel) break // 같은/상위 레벨이면 이 제어 블록 끝
    // SHAPE_COMPONENT에서 picture 타입이면 binDataId 추출
    // picture 데이터는 SHAPE_COMPONENT 뒤에 오는 하위 레코드에 있음
    // HWP5에서 그림 정보는 level이 높은 하위 레코드에 binDataId가 uint16LE로 저장
    if (r.data.length >= 2) {
      // 매직바이트로 이미지인지 확인하는 대신, SHAPE_COMPONENT 뒤의 하위 레코드에서 binDataId를 읽음
      // HWP5 picture 구조: CTRL_HEADER(gso) → LIST_HEADER → SHAPE_COMPONENT → [picture data record]
      // picture data record에서 offset 0부터 uint16LE = binDataId
      if (r.tagId > TAG_SHAPE_COMPONENT && r.level > ctrlLevel + 1 && r.data.length >= 4) {
        const possibleId = r.data.readUInt16LE(0)
        if (possibleId < 10000) return possibleId // 합리적 범위
      }
    }
  }
  return -1
}

function isEquationControlId(ctrlId: string): boolean {
  return ctrlId === CTRL_ID_EQEDIT || ctrlId === "eqed"
}

function formatEquationForMarkdown(equation: string): string {
  const normalized = hwpEquationToLatex(equation)
  if (!normalized) return ""
  return `$${normalized.replace(/\$/g, "\\$")}$`
}

function extractEquationFromControl(records: HwpRecord[], ctrlIdx: number): string | null {
  const ctrlLevel = records[ctrlIdx].level
  for (let j = ctrlIdx + 1; j < records.length && j < ctrlIdx + 10; j++) {
    const r = records[j]
    if (r.level <= ctrlLevel) break
    if (r.tagId !== TAG_EQEDIT) continue
    const equation = extractEquationText(r.data)
    return equation ? formatEquationForMarkdown(equation) : null
  }
  return null
}

function renderTextWithEquations(textRecords: Buffer[], equations: string[]): string {
  const queue = [...equations]
  return textRecords
    .map(data => extractTextWithControls(data, ctrlId => {
      if (!isEquationControlId(ctrlId) || queue.length === 0) return null
      return queue.shift()
    }))
    .join("")
    .replace(/\$\$/g, "$ $")
}

/** MIME 타입 매직바이트 판별 */
function detectImageMime(data: Buffer | Uint8Array): string | null {
  if (data.length < 4) return null
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png"
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg"
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif"
  if (data[0] === 0x42 && data[1] === 0x4d) return "image/bmp"
  if (data[0] === 0xd7 && data[1] === 0xcd && data[2] === 0xc6 && data[3] === 0x9a) return "image/wmf"
  if (data[0] === 0x01 && data[1] === 0x00 && data[2] === 0x00 && data[3] === 0x00) return "image/emf"
  return null
}

/** OLE2 BinData 스토리지에서 이미지 추출, blocks의 image 블록과 매핑 */
function extractHwp5Images(
  cfb: CfbContainer,
  blocks: IRBlock[],
  compressed: boolean,
  warnings: ParseWarning[],
): ExtractedImage[] {
  // BinData 스토리지의 모든 파일을 FileIndex 순회로 수집 (O(n), 기존 O(20000) CFB.find 제거)
  const binDataMap = new Map<number, { data: Buffer; name: string }>()
  const binDataRe = /\/BinData\/[Bb][Ii][Nn](\d{4})$/
  if (cfb.FileIndex) {
    for (const entry of cfb.FileIndex) {
      if (!entry?.name || !entry.content) continue
      const match = entry.name.match(binDataRe)
      if (!match) continue
      const idx = parseInt(match[1], 10)
      let data = Buffer.from(entry.content)
      if (compressed) {
        try { data = decompressStream(data) } catch { /* 이미 비압축일 수 있음 */ }
      }
      binDataMap.set(idx, { data, name: entry.name })
    }
  }

  if (binDataMap.size === 0) return []

  const images: ExtractedImage[] = []
  let imageIndex = 0

  for (const block of blocks) {
    if (block.type !== "image" || !block.text) continue
    const binId = parseInt(block.text, 10)
    if (isNaN(binId)) continue

    const bin = binDataMap.get(binId)
    if (!bin) {
      warnings.push({ page: block.pageNumber, message: `BinData ${binId} 없음`, code: "SKIPPED_IMAGE" })
      block.type = "paragraph"
      block.text = `[이미지: BinData ${binId}]`
      continue
    }

    const mime = detectImageMime(bin.data)
    if (!mime) {
      warnings.push({ page: block.pageNumber, message: `BinData ${binId}: 알 수 없는 이미지 형식`, code: "SKIPPED_IMAGE" })
      block.type = "paragraph"
      block.text = `[이미지: ${bin.name}]`
      continue
    }

    imageIndex++
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("bmp") ? "bmp" : "bin"
    const filename = `image_${String(imageIndex).padStart(3, "0")}.${ext}`

    images.push({ filename, data: new Uint8Array(bin.data), mimeType: mime })
    block.text = filename
    block.imageData = { data: new Uint8Array(bin.data), mimeType: mime, filename: bin.name }
  }

  return images
}

/** Lenient CFB: BinData 이미지 추출 */
function extractHwp5ImagesLenient(
  lcfb: LenientCfbContainer,
  blocks: IRBlock[],
  compressed: boolean,
  warnings: ParseWarning[],
): ExtractedImage[] {
  // BinData 엔트리 수집
  const binDataMap = new Map<number, { data: Buffer; name: string }>()
  const binRe = /^BIN(\d{4})/i
  for (const e of lcfb.entries()) {
    const match = e.name.match(binRe)
    if (!match) continue
    const idx = parseInt(match[1], 10)
    let raw = lcfb.findStream(e.name)
    if (!raw) continue
    if (compressed) {
      try { raw = decompressStream(raw) } catch { /* 이미 비압축일 수 있음 */ }
    }
    binDataMap.set(idx, { data: raw, name: e.name })
  }
  if (binDataMap.size === 0) return []

  const images: ExtractedImage[] = []
  let imageIndex = 0
  for (const block of blocks) {
    if (block.type !== "image" || !block.text) continue
    const binId = parseInt(block.text, 10)
    if (isNaN(binId)) continue
    const bin = binDataMap.get(binId)
    if (!bin) {
      warnings.push({ page: block.pageNumber, message: `BinData ${binId} ���음`, code: "SKIPPED_IMAGE" })
      block.type = "paragraph"; block.text = `[이미지: BinData ${binId}]`; continue
    }
    const mime = detectImageMime(bin.data)
    if (!mime) {
      warnings.push({ page: block.pageNumber, message: `BinData ${binId}: 알 수 없는 이미지 형식`, code: "SKIPPED_IMAGE" })
      block.type = "paragraph"; block.text = `[이미지: ${bin.name}]`; continue
    }
    imageIndex++
    const ext = mime.includes("jpeg") ? "jpg" : mime.includes("png") ? "png" : mime.includes("gif") ? "gif" : mime.includes("bmp") ? "bmp" : "bin"
    const filename = `image_${String(imageIndex).padStart(3, "0")}.${ext}`
    images.push({ filename, data: new Uint8Array(bin.data), mimeType: mime })
    block.text = filename
    block.imageData = { data: new Uint8Array(bin.data), mimeType: mime, filename: bin.name }
  }
  return images
}

function parseSection(records: HwpRecord[], docInfo: HwpDocInfo | null, warnings: ParseWarning[], sectionNum: number, counter?: { count: number }): IRBlock[] {
  const blocks: IRBlock[] = []
  let i = 0

  while (i < records.length) {
    const rec = records[i]

    if (rec.tagId === TAG_PARA_HEADER && rec.level === 0) {
      const { paragraph, tables, nextIdx, charShapeIds, paraShapeId } = parseParagraphWithTables(records, i, counter)
      if (paragraph) {
        const block: IRBlock = { type: "paragraph", text: paragraph, pageNumber: sectionNum }
        // CHAR_SHAPE 기반 스타일 정보 추가
        if (docInfo && charShapeIds.length > 0) {
          const style = resolveCharStyle(charShapeIds, docInfo)
          if (style) block.style = style
        }
        // PARA_SHAPE 개요 수준으로 heading 즉시 설정
        if (docInfo && paraShapeId >= 0 && paraShapeId < docInfo.paraShapes.length) {
          const ol = docInfo.paraShapes[paraShapeId].outlineLevel
          if (ol >= 1 && ol <= 6) {
            block.type = "heading"
            block.level = ol
          }
        }
        blocks.push(block)
      }
      for (const t of tables) blocks.push({ type: "table", table: t, pageNumber: sectionNum })
      i = nextIdx
      continue
    }

    if (rec.tagId === TAG_CTRL_HEADER && rec.level <= 1 && rec.data.length >= 4) {
      const ctrlId = rec.data.subarray(0, 4).toString("ascii")
      if (ctrlId === " lbt" || ctrlId === "tbl ") {
        const { table, nextIdx } = parseTableBlock(records, i, counter)
        if (table) blocks.push({ type: "table", table, pageNumber: sectionNum })
        i = nextIdx
        continue
      }
      // 그리기 객체(gso) — 이미지 또는 글상자
      if (ctrlId === "gso " || ctrlId === " osg") {
        const binId = extractBinDataId(records, i)
        if (binId >= 0) {
          blocks.push({ type: "image", text: String(binId), pageNumber: sectionNum })
        } else {
          // 이미지가 아니면 글상자(TextBox) 텍스트 추출 시도
          const boxText = extractTextBoxText(records, i)
          if (boxText) {
            blocks.push({ type: "paragraph", text: boxText, pageNumber: sectionNum })
          }
          // 텍스트도 없으면 조용히 스킵 (장식용 도형)
        }
      } else if (ctrlId === " elo" || ctrlId === "ole ") {
        warnings.push({ page: sectionNum, message: `스킵된 제어 요소: ${ctrlId.trim()}`, code: "SKIPPED_IMAGE" })
      }
      // 각주/미주 — CTRL_HEADER 아래의 텍스트를 추출하여 footnoteText로 연결
      else if (ctrlId === "fn  " || ctrlId === " nf " || ctrlId === "en  " || ctrlId === " ne ") {
        const noteText = extractNoteText(records, i)
        if (noteText && blocks.length > 0) {
          // 직전 paragraph 블록에 footnoteText 연결
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock.type === "paragraph") {
            lastBlock.footnoteText = lastBlock.footnoteText
              ? lastBlock.footnoteText + "; " + noteText
              : noteText
          }
        }
      }
      // 하이퍼링크 — CTRL_HEADER 데이터에서 URL 추출
      else if (ctrlId === "%tok" || ctrlId === "klnk") {
        const url = extractHyperlinkUrl(rec.data)
        if (url && blocks.length > 0) {
          const lastBlock = blocks[blocks.length - 1]
          if (lastBlock.type === "paragraph" && !lastBlock.href) {
            lastBlock.href = sanitizeHref(url) ?? undefined
          }
        }
      }
    }

    i++
  }

  return blocks
}

/** 각주/미주 CTRL_HEADER 아래의 본문 텍스트 추출 */
function extractNoteText(records: HwpRecord[], ctrlIdx: number): string | null {
  const ctrlLevel = records[ctrlIdx].level
  const texts: string[] = []
  let textRecords: Buffer[] = []
  let equations: string[] = []

  const flushText = () => {
    const text = renderTextWithEquations(textRecords, equations).trim()
    if (text) texts.push(text)
    textRecords = []
    equations = []
  }

  for (let j = ctrlIdx + 1; j < records.length && j < ctrlIdx + 100; j++) {
    const r = records[j]
    if (r.level <= ctrlLevel) break  // 상위 레벨 도달 → 이 컨트롤 블록 끝

    if (r.tagId === TAG_PARA_HEADER) {
      flushText()
    }

    if (r.tagId === TAG_PARA_TEXT) {
      textRecords.push(r.data)
    }

    if (r.tagId === TAG_CTRL_HEADER && r.data.length >= 4) {
      const ctrlId = r.data.subarray(0, 4).toString("ascii")
      if (isEquationControlId(ctrlId)) {
        const equation = extractEquationFromControl(records, j)
        if (equation) equations.push(equation)
      }
    }
  }

  flushText()
  return texts.length > 0 ? texts.join(" ") : null
}

/** 글상자(TextBox) 제어 요소 아래의 텍스트 추출 — extractNoteText와 동일 패턴 */
function extractTextBoxText(records: HwpRecord[], ctrlIdx: number): string | null {
  const ctrlLevel = records[ctrlIdx].level
  const texts: string[] = []
  let textRecords: Buffer[] = []
  let equations: string[] = []

  const flushText = () => {
    const text = renderTextWithEquations(textRecords, equations).trim()
    if (text) texts.push(text)
    textRecords = []
    equations = []
  }

  for (let j = ctrlIdx + 1; j < records.length && j < ctrlIdx + 200; j++) {
    const r = records[j]
    if (r.level <= ctrlLevel) break

    if (r.tagId === TAG_PARA_HEADER) {
      flushText()
    }

    if (r.tagId === TAG_PARA_TEXT) {
      textRecords.push(r.data)
    }

    if (r.tagId === TAG_CTRL_HEADER && r.data.length >= 4) {
      const ctrlId = r.data.subarray(0, 4).toString("ascii")
      if (isEquationControlId(ctrlId)) {
        const equation = extractEquationFromControl(records, j)
        if (equation) equations.push(equation)
      }
    }
  }

  flushText()
  return texts.length > 0 ? texts.join("\n") : null
}

/** 하이퍼링크 CTRL_HEADER에서 URL 추출 (best-effort) */
function extractHyperlinkUrl(data: Buffer): string | null {
  // HWP5 하이퍼링크 CTRL_HEADER 구조:
  // ctrlId(4) + 기타 필드들... + URL 문자열 (UTF-16LE, length-prefixed)
  // 정확한 오프셋은 버전마다 다를 수 있으므로 URL 패턴 스캔으로 폴백
  try {
    // UTF-16LE에서 "http" 시그니처 스캔
    const httpSig = Buffer.from("http", "utf16le")  // "h\0t\0t\0p\0"
    const idx = data.indexOf(httpSig)
    if (idx >= 0) {
      // null terminator(0x0000 0x0000)까지 UTF-16LE로 읽기
      let end = idx
      while (end + 1 < data.length) {
        const ch = data.readUInt16LE(end)
        if (ch === 0) break
        end += 2
      }
      const url = data.subarray(idx, end).toString("utf16le")
      // 기본 URL 검증
      if (/^https?:\/\/.+/.test(url) && url.length < 2000) {
        return url
      }
    }
  } catch { /* best-effort */ }
  return null
}

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

function parseParagraphWithTables(records: HwpRecord[], startIdx: number, counter?: { count: number }) {
  const startLevel = records[startIdx].level
  const textRecords: Buffer[] = []
  const equations: string[] = []
  const tables: ReturnType<typeof buildTable>[] = []
  const charShapeIds: number[] = []

  // PARA_HEADER에서 paraShapeId 추출 (offset 8-9, u16)
  const paraHeaderData = records[startIdx].data
  const paraShapeId = paraHeaderData.length >= 10 ? paraHeaderData.readUInt16LE(8) : -1

  let i = startIdx + 1

  while (i < records.length) {
    const rec = records[i]
    if (rec.tagId === TAG_PARA_HEADER && rec.level <= startLevel) break

    if (rec.tagId === TAG_PARA_TEXT) {
      textRecords.push(rec.data)
    }

    // CHAR_SHAPE 레코드 — 문단 내 글자 모양 인덱스 배열
    if (rec.tagId === TAG_CHAR_SHAPE && rec.data.length >= 8) {
      // 구조: [position(u32) + charShapeId(u32)] * N
      for (let offset = 0; offset + 7 < rec.data.length; offset += 8) {
        charShapeIds.push(rec.data.readUInt32LE(offset + 4))
      }
    }

    if (rec.tagId === TAG_CTRL_HEADER && rec.data.length >= 4) {
      const ctrlId = rec.data.subarray(0, 4).toString("ascii")
      if (isEquationControlId(ctrlId)) {
        const equation = extractEquationFromControl(records, i)
        if (equation) equations.push(equation)
      } else if (ctrlId === " lbt" || ctrlId === "tbl ") {
        const { table, nextIdx } = parseTableBlock(records, i, counter)
        if (table) tables.push(table)
        i = nextIdx
        continue
      }
    }
    i++
  }

  const text = renderTextWithEquations(textRecords, equations)
  const trimmed = text.trim()
  return { paragraph: trimmed || null, tables, nextIdx: i, charShapeIds, paraShapeId }
}

function parseTableBlock(records: HwpRecord[], startIdx: number, counter?: { count: number }) {
  const tableLevel = records[startIdx].level
  let i = startIdx + 1
  let rows = 0, cols = 0
  const cells: CellContext[] = []

  while (i < records.length) {
    const rec = records[i]
    if (rec.tagId === TAG_PARA_HEADER && rec.level <= tableLevel) break
    if (rec.tagId === TAG_CTRL_HEADER && rec.level <= tableLevel) break

    if (rec.tagId === TAG_TABLE && rec.data.length >= 8) {
      rows = Math.min(rec.data.readUInt16LE(4), MAX_ROWS)
      cols = Math.min(rec.data.readUInt16LE(6), MAX_COLS)
    }

    if (rec.tagId === TAG_LIST_HEADER) {
      const { cell, nextIdx } = parseCellBlock(records, i, tableLevel, counter)
      if (cell) cells.push(cell)
      i = nextIdx
      continue
    }
    i++
  }

  if (rows === 0 || cols === 0 || cells.length === 0) return { table: null, nextIdx: i }

  // colAddr/rowAddr가 있으면 arrangeCells가 이미 완성된 그리드를 반환하므로
  // buildTable(2-pass) 없이 직접 IRTable 생성 — 이중 colSpan 확장 방지
  const hasAddr = cells.some(c => c.colAddr !== undefined && c.rowAddr !== undefined)
  if (hasAddr) {
    const cellRows = arrangeCells(rows, cols, cells)
    const irCells = cellRows.map(row => row.map(c => ({
      text: c.text.trim(),
      colSpan: c.colSpan,
      rowSpan: c.rowSpan,
    })))
    return { table: { rows, cols, cells: irCells, hasHeader: rows > 1 }, nextIdx: i }
  }

  const cellRows = arrangeCells(rows, cols, cells)
  return { table: buildTable(cellRows), nextIdx: i }
}

function parseCellBlock(records: HwpRecord[], startIdx: number, tableLevel: number, counter?: { count: number }) {
  const rec = records[startIdx]
  const cellLevel = rec.level
  const texts: string[] = []
  let textRecords: Buffer[] = []
  let equations: string[] = []

  const flushText = () => {
    const text = renderTextWithEquations(textRecords, equations).trim()
    if (text) texts.push(text)
    textRecords = []
    equations = []
  }

  // LIST_HEADER에서 셀 위치 및 병합 정보 추출
  // HWP5 셀 LIST_HEADER 구조:
  //   paraCount(u16) + flags(u32) + width(u16) + colAddr(u16) + rowAddr(u16) + colSpan(u16) + rowSpan(u16)
  //   offset: 0         2            6           8              10             12             14
  let colSpan = 1
  let rowSpan = 1
  let colAddr: number | undefined
  let rowAddr: number | undefined
  if (rec.data.length >= 16) {
    colAddr = rec.data.readUInt16LE(8)
    rowAddr = rec.data.readUInt16LE(10)
    const cs = rec.data.readUInt16LE(12)
    const rs = rec.data.readUInt16LE(14)
    if (cs > 0) colSpan = Math.min(cs, MAX_COLS)
    if (rs > 0) rowSpan = Math.min(rs, MAX_ROWS)
  }

  let i = startIdx + 1

  while (i < records.length) {
    const r = records[i]
    if (r.tagId === TAG_LIST_HEADER && r.level <= cellLevel) break
    if (r.level <= tableLevel && (r.tagId === TAG_PARA_HEADER || r.tagId === TAG_CTRL_HEADER)) break

    if (r.tagId === TAG_PARA_HEADER) {
      flushText()
    }

    if (r.tagId === TAG_PARA_TEXT) {
      textRecords.push(r.data)
    }

    // 셀 내부 중첩 테이블 감지 (HWP5에서는 내용 파싱 없이 마커만 표시)
    // 힌트 없음 — HWP5는 이 단계에서 중첩 테이블 내부를 파싱하지 않으므로 첫 행 추출 불가
    if (r.tagId === TAG_CTRL_HEADER && r.data.length >= 4) {
      const ctrlId = r.data.subarray(0, 4).toString("ascii")
      if (isEquationControlId(ctrlId)) {
        const equation = extractEquationFromControl(records, i)
        if (equation) equations.push(equation)
      } else if (ctrlId === " lbt" || ctrlId === "tbl ") {
        flushText()
        if (counter) {
          counter.count++
          texts.push(`[중첩 테이블 #${counter.count}]`)
        } else {
          texts.push("[중첩 테이블]")
        }
      }
    }

    i++
  }

  flushText()
  return { cell: { text: texts.join("\n"), colSpan, rowSpan, colAddr, rowAddr } as CellContext, nextIdx: i }
}

function arrangeCells(rows: number, cols: number, cells: CellContext[]): CellContext[][] {
  const grid: (CellContext | null)[][] = Array.from({ length: rows }, () => Array(cols).fill(null))

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
