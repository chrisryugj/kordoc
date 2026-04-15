/**
 * HWPX 파서 — manifest 멀티섹션, colSpan/rowSpan, 중첩테이블
 *
 * lexdiff 기반 + edu-facility-ai 손상ZIP 복구
 */

import JSZip from "jszip"
import { inflateRawSync } from "zlib"
import { DOMParser } from "@xmldom/xmldom"
import { buildTable, convertTableToText, blocksToMarkdown, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { CellContext, IRBlock, DocumentMetadata, InternalParseResult, ParseOptions, ParseWarning, OutlineItem, InlineStyle, ExtractedImage } from "../types.js"
import { HEADING_RATIO_H1, HEADING_RATIO_H2, HEADING_RATIO_H3 } from "../types.js"
import { KordocError, isPathTraversal, sanitizeHref, precheckZipSize, stripDtd } from "../utils.js"
// 테스트 호환성 re-export
export { precheckZipSize } from "../utils.js"
import { parsePageRange } from "../page-range.js"

/** 압축 해제 최대 크기 (100MB) — ZIP bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024
/** 손상 ZIP 복구 시 최대 엔트리 수 */
const MAX_ZIP_ENTRIES = 500

/** colSpan/rowSpan을 안전한 범위로 클램핑 */
function clampSpan(val: number, max: number): number {
  return Math.max(1, Math.min(val, max))
}

/** XML DOM 재귀 최대 깊이 — 악성 파일의 스택 오버플로 방지 */
const MAX_XML_DEPTH = 200

interface TableState { rows: CellContext[][]; currentRow: CellContext[]; cell: CellContext | null }

/** walk 함수들이 공유하는 파싱 컨텍스트 — 개별 optional 파라미터를 하나로 묶어 시그니처 안정화 */
interface WalkCtx {
  styleMap?: HwpxStyleMap
  warnings?: ParseWarning[]
  sectionNum?: number
  counter?: { count: number }
}

/** xmldom DOMParser 생성 — onError 콜백으로 malformed XML 경고 수집 */
function createXmlParser(warnings?: ParseWarning[]): DOMParser {
  return new DOMParser({
    onError(level: "warn" | "error" | "fatalError", msg: string) {
      if (level === "fatalError") throw new KordocError(`XML 파싱 실패: ${msg}`)
      warnings?.push({ code: "MALFORMED_XML", message: `XML ${level === "warn" ? "경고" : "오류"}: ${msg}` })
    },
  })
}

// ─── HWPX 스타일 정보 ──────────────────────────────

interface HwpxCharProperty {
  fontSize?: number  // 단위: pt (hwpx는 centi-pt → /100)
  bold?: boolean
  italic?: boolean
  fontName?: string
}

interface HwpxStyleMap {
  charProperties: Map<string, HwpxCharProperty>  // id → property
  styles: Map<string, { name: string; charPrId?: string; paraPrId?: string }>  // id → style
}

/** head.xml 또는 header.xml에서 스타일 정보 추출 */
async function extractHwpxStyles(zip: JSZip, decompressed?: { total: number }): Promise<HwpxStyleMap> {
  const result: HwpxStyleMap = {
    charProperties: new Map(),
    styles: new Map(),
  }

  const headerPaths = ["Contents/header.xml", "header.xml", "Contents/head.xml", "head.xml"]
  for (const hp of headerPaths) {
    const hpLower = hp.toLowerCase()
    const file = zip.file(hp) || Object.values(zip.files).find(f => f.name.toLowerCase() === hpLower) || null
    if (!file) continue

    try {
      const xml = await file.async("text")
      if (decompressed) {
        decompressed.total += xml.length * 2
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      }
      const parser = createXmlParser()
      const doc = parser.parseFromString(stripDtd(xml), "text/xml")
      if (!doc.documentElement) continue

      // charProperties 파싱
      parseCharProperties(doc, result.charProperties)
      // styles 파싱
      parseStyleElements(doc, result.styles)
      break
    } catch { continue }
  }

  return result
}

function parseCharProperties(doc: Document, map: Map<string, HwpxCharProperty>): void {
  // <hh:charPr> 또는 <charPr> 요소 탐색
  const tagNames = ["hh:charPr", "charPr", "hp:charPr"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || ""
      if (!id) continue

      const prop: HwpxCharProperty = {}

      // height 속성 (centi-pt 단위)
      const height = el.getAttribute("height")
      if (height) {
        const parsedHeight = parseInt(height, 10)
        if (!isNaN(parsedHeight) && parsedHeight > 0) {
          prop.fontSize = parsedHeight / 100
        }
      }

      // bold/italic
      const bold = el.getAttribute("bold")
      if (bold === "true" || bold === "1") prop.bold = true
      const italic = el.getAttribute("italic")
      if (italic === "true" || italic === "1") prop.italic = true

      // 하위 요소에서 fontface 탐색
      const fontFaces = el.getElementsByTagName("*")
      for (let j = 0; j < fontFaces.length; j++) {
        const ff = fontFaces[j]
        const localTag = (ff.tagName || "").replace(/^[^:]+:/, "")
        if (localTag === "fontface" || localTag === "fontRef") {
          const face = ff.getAttribute("face") || ff.getAttribute("FontFace")
          if (face) { prop.fontName = face; break }
        }
      }

      map.set(id, prop)
    }
  }
}

function parseStyleElements(doc: Document, map: Map<string, { name: string; charPrId?: string; paraPrId?: string }>): void {
  const tagNames = ["hh:style", "style", "hp:style"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || String(i)
      const name = el.getAttribute("name") || el.getAttribute("engName") || ""
      const charPrId = el.getAttribute("charPrIDRef") || undefined
      const paraPrId = el.getAttribute("paraPrIDRef") || undefined
      map.set(id, { name, charPrId, paraPrId })
    }
  }
}

// stripDtd는 utils.js에서 import

export async function parseHwpxDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<InternalParseResult> {
  // Best-effort 사전 검증 — CD 선언 크기 기반 (위조 가능, 실제 방어는 per-file 누적 체크)
  precheckZipSize(buffer, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES)

  let zip: JSZip

  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    return extractFromBrokenZip(buffer)
  }

  // loadAsync 후 실제 엔트리 수 검증 — CD 위조와 무관한 진짜 방어선
  const actualEntryCount = Object.keys(zip.files).length
  if (actualEntryCount > MAX_ZIP_ENTRIES) {
    throw new KordocError("ZIP 엔트리 수 초과 (ZIP bomb 의심)")
  }

  // ZIP 전체 파일 누적 압축해제 크기 추적 (비섹션 파일 포함)
  const decompressed = { total: 0 }

  // 메타데이터 추출 (best-effort)
  const metadata: DocumentMetadata = {}
  await extractHwpxMetadata(zip, metadata, decompressed)

  // 스타일 정보 추출 (best-effort)
  const styleMap = await extractHwpxStyles(zip, decompressed)
  const warnings: ParseWarning[] = []

  const sectionPaths = await resolveSectionPaths(zip)
  if (sectionPaths.length === 0) throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")

  metadata.pageCount = sectionPaths.length

  // 페이지 범위 필터링 (섹션 단위 근사치)
  const pageFilter = options?.pages ? parsePageRange(options.pages, sectionPaths.length) : null
  const totalTarget = pageFilter ? pageFilter.size : sectionPaths.length
  const blocks: IRBlock[] = []
  const nestedTableCounter = { count: 0 }
  let parsedSections = 0
  for (let si = 0; si < sectionPaths.length; si++) {
    if (pageFilter && !pageFilter.has(si + 1)) continue
    const file = zip.file(sectionPaths[si])
    if (!file) continue
    try {
      const xml = await file.async("text")
      decompressed.total += xml.length * 2
      if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      blocks.push(...parseSectionXml(xml, styleMap, warnings, si + 1, nestedTableCounter))
      parsedSections++
      options?.onProgress?.(parsedSections, totalTarget)
    } catch (secErr) {
      if (secErr instanceof KordocError) throw secErr
      warnings.push({ page: si + 1, message: `섹션 ${si + 1} 파싱 실패: ${secErr instanceof Error ? secErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
    }
  }

  // 이미지 블록에서 ZIP 바이너리 추출
  const images = await extractImagesFromZip(zip, blocks, decompressed, warnings)

  // 스타일 기반 헤딩 감지
  detectHwpxHeadings(blocks, styleMap)

  // outline 구축
  const outline: OutlineItem[] = blocks
    .filter(b => b.type === "heading" && b.level && b.text)
    .map(b => ({ level: b.level!, text: b.text!, pageNumber: b.pageNumber }))

  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, metadata, outline: outline.length > 0 ? outline : undefined, warnings: warnings.length > 0 ? warnings : undefined, images: images.length > 0 ? images : undefined }
}

// ─── 이미지 추출 ───────────────────────────────────

/** 확장자 → MIME 타입 */
function imageExtToMime(ext: string): string {
  switch (ext.toLowerCase()) {
    case "jpg": case "jpeg": return "image/jpeg"
    case "png": return "image/png"
    case "gif": return "image/gif"
    case "bmp": return "image/bmp"
    case "tif": case "tiff": return "image/tiff"
    case "wmf": return "image/wmf"
    case "emf": return "image/emf"
    case "svg": return "image/svg+xml"
    default: return "application/octet-stream"
  }
}

/** MIME → 확장자 */
function mimeToExt(mime: string): string {
  if (mime.includes("jpeg")) return "jpg"
  if (mime.includes("png")) return "png"
  if (mime.includes("gif")) return "gif"
  if (mime.includes("bmp")) return "bmp"
  if (mime.includes("tiff")) return "tif"
  if (mime.includes("wmf")) return "wmf"
  if (mime.includes("emf")) return "emf"
  if (mime.includes("svg")) return "svg"
  return "bin"
}

/** blocks에서 type="image" 블록의 참조를 ZIP에서 실제 바이너리로 변환 */
async function extractImagesFromZip(
  zip: JSZip,
  blocks: IRBlock[],
  decompressed: { total: number },
  warnings?: ParseWarning[],
): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = []
  let imageIndex = 0

  for (const block of blocks) {
    if (block.type !== "image" || !block.text) continue

    const ref = block.text
    // BinData/ 폴더 내에서 참조 파일 찾기
    const candidates = [
      `BinData/${ref}`,
      `Contents/BinData/${ref}`,
      ref, // 절대 경로일 수도 있음
    ]

    let found = false
    for (const path of candidates) {
      if (isPathTraversal(path)) continue
      const file = zip.file(path)
      if (!file) continue

      try {
        const data = await file.async("uint8array")
        decompressed.total += data.length
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")

        const ext = ref.includes(".") ? (ref.split(".").pop() || "png") : "png"
        const mimeType = imageExtToMime(ext)
        imageIndex++
        const filename = `image_${String(imageIndex).padStart(3, "0")}.${mimeToExt(mimeType)}`

        images.push({ filename, data, mimeType })
        // 블록 텍스트를 참조 파일명으로 교체
        block.text = filename
        block.imageData = { data, mimeType, filename: ref }
        found = true
        break
      } catch (err) {
        if (err instanceof KordocError) throw err
        // 개별 이미지 실패는 경고로 처리
      }
    }

    if (!found) {
      warnings?.push({ page: block.pageNumber, message: `이미지 파일 없음: ${ref}`, code: "SKIPPED_IMAGE" })
      // image 블록을 paragraph로 전환 (참조만 남김)
      block.type = "paragraph"
      block.text = `[이미지: ${ref}]`
    }
  }

  return images
}

// ─── 메타데이터 추출 (best-effort) ───────────────────

/**
 * HWPX ZIP 내 메타데이터 파일에서 Dublin Core 정보 추출.
 * 표준 경로: meta.xml, docProps/core.xml, META-INF/container.xml
 */
async function extractHwpxMetadata(zip: JSZip, metadata: DocumentMetadata, decompressed?: { total: number }): Promise<void> {
  try {
    // meta.xml (HWPX 표준) 또는 docProps/core.xml (OOXML 호환)
    const metaPaths = ["meta.xml", "META-INF/meta.xml", "docProps/core.xml"]
    for (const mp of metaPaths) {
      const file = zip.file(mp) || Object.values(zip.files).find(f => f.name.toLowerCase() === mp.toLowerCase()) || null
      if (!file) continue
      const xml = await file.async("text")
      if (decompressed) {
        decompressed.total += xml.length * 2
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      }
      parseDublinCoreMetadata(xml, metadata)
      if (metadata.title || metadata.author) return
    }
  } catch {
    // best-effort
  }
}

/** Dublin Core (dc:) 메타데이터 XML 파싱 */
function parseDublinCoreMetadata(xml: string, metadata: DocumentMetadata): void {
  const parser = createXmlParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  if (!doc.documentElement) return

  const getText = (tagNames: string[]): string | undefined => {
    for (const tag of tagNames) {
      const els = doc.getElementsByTagName(tag)
      if (els.length > 0) {
        const text = els[0].textContent?.trim()
        if (text) return text
      }
    }
    return undefined
  }

  metadata.title = metadata.title || getText(["dc:title", "title"])
  metadata.author = metadata.author || getText(["dc:creator", "creator", "cp:lastModifiedBy"])
  metadata.description = metadata.description || getText(["dc:description", "description", "dc:subject", "subject"])
  metadata.createdAt = metadata.createdAt || getText(["dcterms:created", "meta:creation-date"])
  metadata.modifiedAt = metadata.modifiedAt || getText(["dcterms:modified", "meta:date"])

  const keywords = getText(["dc:keyword", "cp:keywords", "meta:keyword"])
  if (keywords && !metadata.keywords) {
    metadata.keywords = keywords.split(/[,;]/).map(k => k.trim()).filter(Boolean)
  }
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export async function extractHwpxMetadataOnly(buffer: ArrayBuffer): Promise<DocumentMetadata> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buffer)
  } catch {
    throw new KordocError("HWPX ZIP을 열 수 없습니다")
  }

  const metadata: DocumentMetadata = {}
  await extractHwpxMetadata(zip, metadata)

  const sectionPaths = await resolveSectionPaths(zip)
  metadata.pageCount = sectionPaths.length

  return metadata
}

// ─── 손상 ZIP 복구 (edu-facility-ai에서 포팅) ──────────

function extractFromBrokenZip(buffer: ArrayBuffer): InternalParseResult {
  const data = new Uint8Array(buffer)
  const view = new DataView(buffer)
  let pos = 0
  const blocks: IRBlock[] = []
  const warnings: ParseWarning[] = [
    { code: "BROKEN_ZIP_RECOVERY", message: "손상된 ZIP 구조 — Local File Header 기반 복구 모드" },
  ]
  let totalDecompressed = 0
  let entryCount = 0
  let sectionNum = 0
  const nestedTableCounter = { count: 0 }

  while (pos < data.length - 30) {
    // PK\x03\x04 시그니처 확인 — 미매칭 시 다음 PK 시그니처까지 스캔 (중간 손상 복구)
    if (data[pos] !== 0x50 || data[pos + 1] !== 0x4b || data[pos + 2] !== 0x03 || data[pos + 3] !== 0x04) {
      pos++
      while (pos < data.length - 30) {
        if (data[pos] === 0x50 && data[pos + 1] === 0x4b && data[pos + 2] === 0x03 && data[pos + 3] === 0x04) break
        pos++
      }
      continue
    }

    if (++entryCount > MAX_ZIP_ENTRIES) break

    const method = view.getUint16(pos + 8, true)
    const compSize = view.getUint32(pos + 18, true)
    const nameLen = view.getUint16(pos + 26, true)
    const extraLen = view.getUint16(pos + 28, true)

    // nameLen 상한 — 비정상 값에 의한 대규모 버퍼 할당 방지
    if (nameLen > 1024 || extraLen > 65535) { pos += 30 + nameLen + extraLen; continue }

    const fileStart = pos + 30 + nameLen + extraLen
    // 범위 초과 검증 — OOB 및 무한 루프 방지
    if (fileStart + compSize > data.length) break
    if (compSize === 0 && method !== 0) { pos = fileStart; continue }

    const nameBytes = data.slice(pos + 30, pos + 30 + nameLen)
    const name = new TextDecoder().decode(nameBytes)

    // 경로 순회 방지 — 상위 디렉토리 참조 및 절대 경로 차단
    if (isPathTraversal(name)) { pos = fileStart + compSize; continue }
    const fileData = data.slice(fileStart, fileStart + compSize)
    pos = fileStart + compSize

    if (!name.toLowerCase().includes("section") || !name.endsWith(".xml")) continue

    try {
      let content: string
      if (method === 0) {
        content = new TextDecoder().decode(fileData)
      } else if (method === 8) {
        const decompressed = inflateRawSync(Buffer.from(fileData), { maxOutputLength: MAX_DECOMPRESS_SIZE })
        content = new TextDecoder().decode(decompressed)
      } else {
        continue
      }
      totalDecompressed += content.length * 2
      if (totalDecompressed > MAX_DECOMPRESS_SIZE) throw new KordocError("압축 해제 크기 초과")
      sectionNum++
      blocks.push(...parseSectionXml(content, undefined, warnings, sectionNum, nestedTableCounter))
    } catch {
      continue
    }
  }

  if (blocks.length === 0) throw new KordocError("손상된 HWPX에서 섹션 데이터를 복구할 수 없습니다")
  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, warnings: warnings.length > 0 ? warnings : undefined }
}

// ─── Manifest 해석 ───────────────────────────────────

async function resolveSectionPaths(zip: JSZip): Promise<string[]> {
  const manifestPaths = ["Contents/content.hpf", "content.hpf"]
  for (const mp of manifestPaths) {
    const mpLower = mp.toLowerCase()
    const file = zip.file(mp) || Object.values(zip.files).find(f => f.name.toLowerCase() === mpLower) || null
    if (!file) continue
    const xml = await file.async("text")
    const paths = parseSectionPathsFromManifest(xml)
    if (paths.length > 0) return paths
  }

  // fallback: section*.xml 직접 검색
  const sectionFiles = zip.file(/[Ss]ection\d+\.xml$/)
  return sectionFiles.map(f => f.name).sort()
}

function parseSectionPathsFromManifest(xml: string): string[] {
  const parser = createXmlParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  const items = doc.getElementsByTagName("opf:item")
  const spine = doc.getElementsByTagName("opf:itemref")

  const isSectionId = (id: string) => /^s/i.test(id) || id.toLowerCase().includes("section")
  const idToHref = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.getAttribute("id") || ""
    let href = item.getAttribute("href") || ""
    const mediaType = item.getAttribute("media-type") || ""
    if (!isSectionId(id) && !mediaType.includes("xml")) continue
    if (!href.startsWith("/") && !href.startsWith("Contents/") && isSectionId(id))
      href = "Contents/" + href
    idToHref.set(id, href)
  }

  if (spine.length > 0) {
    const ordered: string[] = []
    for (let i = 0; i < spine.length; i++) {
      const href = idToHref.get(spine[i].getAttribute("idref") || "")
      if (href) ordered.push(href)
    }
    if (ordered.length > 0) return ordered
  }
  return Array.from(idToHref.entries())
    .filter(([id]) => isSectionId(id))
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, href]) => href)
}

// ─── 헤딩 감지 (스타일 기반) ────────────────────────

/** HWPX 스타일 기반 헤딩 감지 */
function detectHwpxHeadings(blocks: IRBlock[], styleMap: HwpxStyleMap): void {
  // 본문 폰트 크기 결정
  let baseFontSize = 0
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

  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200 || /^\d+$/.test(text)) continue

    let level = 0

    // 폰트 크기 기반
    if (baseFontSize > 0 && block.style?.fontSize) {
      const ratio = block.style.fontSize / baseFontSize
      if (ratio >= HEADING_RATIO_H1) level = 1
      else if (ratio >= HEADING_RATIO_H2) level = 2
      else if (ratio >= HEADING_RATIO_H3) level = 3
    }

    // "제N조/장/절" 패턴 — 균등배분 공백 허용 ("제 1 장" → "제1장")
    const compactText = text.replace(/\s+/g, "")
    if (/^제\d+[조장절편]/.test(compactText) && text.length <= 50) {
      if (level === 0) level = 3
    }

    if (level > 0) {
      block.type = "heading"
      block.level = level
    }
  }
}

// ─── 섹션 XML 파싱 ──────────────────────────────────

/** 중첩 테이블 마커 생성 — 순번 + 첫 행 힌트(있는 경우) */
function makeNestedTableMarker(counter: { count: number }, rows: CellContext[][]): string {
  counter.count++
  const firstRow = rows[0] ?? []
  const hint = firstRow.map(c => c.text.trim()).filter(Boolean).join(" | ")
  const hintChars = [...hint]
  const truncated = hintChars.length > 60 ? hintChars.slice(0, 60).join("") + "…" : hint
  return truncated
    ? `[중첩 테이블 #${counter.count}: ${truncated}]`
    : `[중첩 테이블 #${counter.count}]`
}

/**
 * 중첩 테이블 처리 공통 로직 — walkSection/walkParagraphChildren 중복 제거
 * 큰 중첩 테이블(≥3행, ≥2열)은 별도 블록으로 분리, 작은 것은 텍스트로 평탄화.
 * 두 경우 모두 부모 셀에 마커 삽입. parentTable을 반환하여 tableCtx 갱신에 사용.
 */
function handleNestedTable(
  newTable: TableState,
  tableStack: TableState[],
  blocks: IRBlock[],
  ctx: WalkCtx
): TableState {
  const parentTable = tableStack.pop()!
  let nestedCols = 0
  for (const r of newTable.rows) if (r.length > nestedCols) nestedCols = r.length
  const marker = ctx.counter
    ? makeNestedTableMarker(ctx.counter, newTable.rows)
    : "[중첩 테이블]"
  if (newTable.rows.length >= 3 && nestedCols >= 2) {
    blocks.push({ type: "table", table: buildTable(newTable.rows), pageNumber: ctx.sectionNum })
    if (parentTable.cell) {
      parentTable.cell.text += (parentTable.cell.text ? "\n" : "") + marker
    }
  } else {
    const nestedText = convertTableToText(newTable.rows)
    if (parentTable.cell) {
      parentTable.cell.text += (parentTable.cell.text ? "\n" : "") + marker + "\n" + nestedText
    }
  }
  return parentTable
}

function parseSectionXml(xml: string, styleMap?: HwpxStyleMap, warnings?: ParseWarning[], sectionNum?: number, counter?: { count: number }): IRBlock[] {
  const parser = createXmlParser(warnings)
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  if (!doc.documentElement) return []

  const blocks: IRBlock[] = []
  const ctx: WalkCtx = { styleMap, warnings, sectionNum, counter }
  walkSection(doc.documentElement, blocks, null, [], ctx)
  return blocks
}

/** pic/shape 요소에서 이미지 참조 경로 추출 (binaryItemIDRef 또는 href) */
function extractImageRef(el: Element): string | null {
  // HWPX: <hp:imgRect> 또는 <hp:img> 내 binaryItemIDRef 속성
  // 또는 하위에서 img 관련 속성 탐색
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "imgRect" || tag === "img" || tag === "imgClip") {
      const ref = child.getAttribute("binaryItemIDRef") || child.getAttribute("href") || ""
      if (ref) return ref
    }
    // lineShape > imgRect 같은 중첩 구조
    const nested = extractImageRef(child)
    if (nested) return nested
  }
  // 직접 속성 체크
  const directRef = el.getAttribute("binaryItemIDRef") || ""
  if (directRef) return directRef
  return null
}

function walkSection(
  node: Node, blocks: IRBlock[],
  tableCtx: TableState | null, tableStack: TableState[],
  ctx: WalkCtx, depth: number = 0
): void {
  if (depth > MAX_XML_DEPTH) return
  const children = node.childNodes
  if (!children) return

  for (let i = 0; i < children.length; i++) {
    const el = children[i] as Element
    if (el.nodeType !== 1) continue

    const tag = el.tagName || el.localName || ""
    const localTag = tag.replace(/^[^:]+:/, "")

    switch (localTag) {
      case "tbl": {
        if (tableCtx) tableStack.push(tableCtx)
        const newTable: TableState = { rows: [], currentRow: [], cell: null }
        walkSection(el, blocks, newTable, tableStack, ctx, depth + 1)

        if (newTable.rows.length > 0) {
          if (tableStack.length > 0) {
            tableCtx = handleNestedTable(newTable, tableStack, blocks, ctx)
          } else {
            blocks.push({ type: "table", table: buildTable(newTable.rows), pageNumber: ctx.sectionNum })
            tableCtx = null
          }
        } else {
          tableCtx = tableStack.length > 0 ? tableStack.pop()! : null
        }
        break
      }

      case "tr":
        if (tableCtx) {
          tableCtx.currentRow = []
          walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1)
          if (tableCtx.currentRow.length > 0) tableCtx.rows.push(tableCtx.currentRow)
          tableCtx.currentRow = []
        }
        break

      case "tc":
        if (tableCtx) {
          tableCtx.cell = { text: "", colSpan: 1, rowSpan: 1 }
          walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1)
          if (tableCtx.cell) {
            tableCtx.currentRow.push(tableCtx.cell)
            tableCtx.cell = null
          }
        }
        break

      case "cellAddr":
        if (tableCtx?.cell) {
          const ca = parseInt(el.getAttribute("colAddr") || "", 10)
          const ra = parseInt(el.getAttribute("rowAddr") || "", 10)
          if (!isNaN(ca)) tableCtx.cell.colAddr = ca
          if (!isNaN(ra)) tableCtx.cell.rowAddr = ra
        }
        break

      case "cellSpan":
        if (tableCtx?.cell) {
          const rawCs = parseInt(el.getAttribute("colSpan") || "1", 10)
          const cs = isNaN(rawCs) ? 1 : rawCs
          const rawRs = parseInt(el.getAttribute("rowSpan") || "1", 10)
          const rs = isNaN(rawRs) ? 1 : rawRs
          tableCtx.cell.colSpan = clampSpan(cs, MAX_COLS)
          tableCtx.cell.rowSpan = clampSpan(rs, MAX_ROWS)
        }
        break

      case "p": {
        const { text, href, footnote, style } = extractParagraphInfo(el, ctx.styleMap)
        if (text) {
          if (tableCtx?.cell) {
            tableCtx.cell.text += (tableCtx.cell.text ? "\n" : "") + text
          } else if (!tableCtx) {
            const block: IRBlock = { type: "paragraph", text, pageNumber: ctx.sectionNum }
            if (style) block.style = style
            if (href) block.href = href
            if (footnote) block.footnoteText = footnote
            blocks.push(block)
          }
        }
        // <p> 내부의 <tbl>만 별도 처리 — extractParagraphInfo가 이미 텍스트를 추출했으므로
        // 전체 walkSection 재귀 대신 테이블/이미지 자식만 선택적으로 처리
        tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1)
        break
      }

      // 이미지/그림 — 경로 추출 또는 경고
      case "pic": case "shape": case "drawingObject": {
        const imgRef = extractImageRef(el)
        if (imgRef) {
          blocks.push({ type: "image", text: imgRef, pageNumber: ctx.sectionNum })
        } else if (ctx.warnings && ctx.sectionNum) {
          ctx.warnings.push({ page: ctx.sectionNum, message: `스킵된 요소: ${localTag}`, code: "SKIPPED_IMAGE" })
        }
        break
      }

      default:
        walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1)
        break
    }
  }
}

/** <p> 내부에서 텍스트가 아닌 구조적 자식만 처리 (tbl, pic, shape). tableCtx 반환으로 상태 전파 */
function walkParagraphChildren(
  node: Node, blocks: IRBlock[],
  tableCtx: TableState | null, tableStack: TableState[],
  ctx: WalkCtx, depth: number = 0
): TableState | null {
  if (depth > MAX_XML_DEPTH) return tableCtx
  const children = node.childNodes
  if (!children) return tableCtx
  const walkChildren = (parent: Node, d: number) => {
    if (d > MAX_XML_DEPTH) return
    const kids = parent.childNodes
    if (!kids) return
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i] as Element
      if (el.nodeType !== 1) continue
      const tag = el.tagName || el.localName || ""
      const localTag = tag.replace(/^[^:]+:/, "")

      if (localTag === "tbl") {
        // 테이블은 walkSection으로 위임
        if (tableCtx) tableStack.push(tableCtx)
        const newTable: TableState = { rows: [], currentRow: [], cell: null }
        walkSection(el, blocks, newTable, tableStack, ctx, d + 1)
        if (newTable.rows.length > 0) {
          if (tableStack.length > 0) {
            tableCtx = handleNestedTable(newTable, tableStack, blocks, ctx)
          } else {
            blocks.push({ type: "table", table: buildTable(newTable.rows), pageNumber: ctx.sectionNum })
            tableCtx = null
          }
        } else {
          tableCtx = tableStack.length > 0 ? tableStack.pop()! : null
        }
      } else if (localTag === "pic" || localTag === "shape" || localTag === "drawingObject") {
        // 도형/이미지 안에 drawText(글상자)가 있으면 텍스트 추출 우선
        const drawTextChild = findDescendant(el, "drawText")
        if (drawTextChild) {
          extractDrawTextBlocks(drawTextChild, blocks, ctx.styleMap, ctx.sectionNum)
        } else {
          const imgRef = extractImageRef(el)
          if (imgRef) {
            blocks.push({ type: "image", text: imgRef, pageNumber: ctx.sectionNum })
          } else if (ctx.warnings && ctx.sectionNum) {
            ctx.warnings.push({ page: ctx.sectionNum, message: `스킵된 요소: ${localTag}`, code: "SKIPPED_IMAGE" })
          }
        }
      } else if (localTag === "drawText") {
        // 글상자(TextBox) 안 텍스트 추출 — <hp:p> 순회
        extractDrawTextBlocks(el, blocks, ctx.styleMap, ctx.sectionNum)
      } else if (localTag === "r" || localTag === "run" || localTag === "ctrl"
        || localTag === "rect" || localTag === "ellipse" || localTag === "polygon"
        || localTag === "line" || localTag === "arc" || localTag === "curve"
        || localTag === "connectLine" || localTag === "container") {
        // <hp:run>, <hp:ctrl>, 도형 요소 내부에 테이블/이미지/글상자가 포함될 수 있음 — 재귀
        walkChildren(el, d + 1)
      } else if (localTag === "run") {
        tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1)
      }
    }
  }
  walkChildren(node, depth)
  return tableCtx
}

/** 자손에서 특정 태그명의 첫 번째 요소 탐색 (최대 깊이 5) */
function findDescendant(node: Node, targetTag: string, depth = 0): Element | null {
  if (depth > 5) return null
  const children = node.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === targetTag) return child
    const found = findDescendant(child, targetTag, depth + 1)
    if (found) return found
  }
  return null
}

/** drawText(글상자) 내부의 <p> 요소들에서 텍스트를 추출하여 paragraph 블록 생성 */
function extractDrawTextBlocks(drawTextNode: Node, blocks: IRBlock[], styleMap?: HwpxStyleMap, sectionNum?: number): void {
  const children = drawTextNode.childNodes
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "subList" || tag === "p" || tag === "para") {
      // subList 안의 <p>들을 순회
      if (tag === "subList") {
        extractDrawTextBlocks(child, blocks, styleMap, sectionNum)
      } else {
        const info = extractParagraphInfo(child, styleMap)
        const text = info.text.trim()
        if (text) {
          blocks.push({ type: "paragraph", text, style: info.style ?? undefined, pageNumber: sectionNum })
        }
      }
    }
  }
}

interface ParagraphInfo {
  text: string
  href?: string
  footnote?: string
  style?: InlineStyle
}

function extractParagraphInfo(para: Element, styleMap?: HwpxStyleMap): ParagraphInfo {
  let text = ""
  let href: string | undefined
  let footnote: string | undefined
  let charPrId: string | undefined

  // 문단의 스타일 참조 → charPr로 간접 조회
  // HWPX <p>에는 paraPrIDRef/styleIDRef가 있고, charPrIDRef는 <r> 요소에 있음
  // 여기서는 일단 null — <r> 요소에서 charPrIDRef를 가져옴

  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) { text += child.textContent || ""; continue }
      if (child.nodeType !== 1) continue

      const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
      switch (tag) {
        case "t": walk(child); break  // 자식 순회 (tab 등 하위 요소 처리)
        case "tab": {
          const leader = child.getAttribute("leader")
          if (leader && leader !== "0") {
            // 목차 리더 탭 (점선/실선 등) — 뒤에 페이지번호가 오므로 이후 텍스트 무시
            text += "\x1F"  // 특수 마커: 이후 텍스트 제거용
          } else {
            text += "\t"
          }
          break
        }
        case "br":
          if ((child.getAttribute("type") || "line") === "line") text += "\n"
          break
        case "fwSpace": case "hwSpace": text += " "; break
        case "tbl": break // 테이블은 walkSection에서 처리

        // 하이퍼링크
        case "hyperlink": {
          const url = child.getAttribute("url") || child.getAttribute("href") || ""
          if (url) {
            // XSS 방지: 추출 시점에서 href 살균
            const safe = sanitizeHref(url)
            if (safe) href = safe
          }
          // 하이퍼링크 내 텍스트 추출
          walk(child)
          break
        }

        // 각주/미주
        case "footNote": case "endNote": case "fn": case "en": {
          const noteText = extractTextFromNode(child)
          if (noteText) footnote = (footnote ? footnote + "; " : "") + noteText
          break
        }

        // 제어 요소 — 필드, 컨트롤, 매개변수 등 스킵
        case "ctrl": case "fieldBegin": case "fieldEnd":
        case "parameters": case "stringParam": case "integerParam":
        case "boolParam": case "floatParam":
        case "secPr":  // 섹션 속성 (페이지 설정 등)
        case "colPr":  // 다단 속성
        case "linesegarray": case "lineseg":  // 레이아웃 정보
        // 도형/이미지 요소 — 대체텍스트("사각형입니다." 등) 누출 방지
        case "pic": case "shape": case "drawingObject":
        case "shapeComment": case "drawText":
          break

        // run 요소에서 charPrIDRef 추출
        case "r": {
          const runCharPr = child.getAttribute("charPrIDRef")
          if (runCharPr && !charPrId) charPrId = runCharPr
          walk(child)
          break
        }

        default: walk(child); break
      }
    }
  }
  walk(para)

  // 목차 리더 마커(\x1F) 이후 텍스트(페이지번호) 제거
  const leaderIdx = text.indexOf("\x1F")
  if (leaderIdx >= 0) text = text.substring(0, leaderIdx)

  let cleanText = text.replace(/[ \t]+/g, " ").trim()

  // 한글 이미지 OLE 대체 텍스트 필터링 ("그림입니다. 원본 그림의 이름: ...")
  if (/^그림입니다\.?\s*원본\s*그림의\s*(이름|크기)/.test(cleanText)) cleanText = ""
  // 멀티라인으로 삽입된 OLE 대체 텍스트도 제거
  cleanText = cleanText.replace(/그림입니다\.?\s*원본\s*그림의\s*(이름|크기)[^\n]*(\n[^\n]*원본\s*그림의\s*(이름|크기)[^\n]*)*/g, "").trim()
  // HWP 도형/개체 대체텍스트 제거 ("사각형입니다.", "개체 입니다." 등)
  cleanText = cleanText.replace(/(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|선|직선|곡선|화살표|오각형|육각형|팔각형|별|십자|구름|마름모|도넛|평행사변형|사다리꼴|개체|그리기\s?개체|묶음\s?개체|글상자|수식|표|그림|OLE\s?개체)\s?입니다\.?/g, "").trim()

  // 스타일 정보 조회
  let style: InlineStyle | undefined
  if (styleMap && charPrId) {
    const charProp = styleMap.charProperties.get(charPrId)
    if (charProp) {
      style = {}
      if (charProp.fontSize) style.fontSize = charProp.fontSize
      if (charProp.bold) style.bold = true
      if (charProp.italic) style.italic = true
      if (charProp.fontName) style.fontName = charProp.fontName
      if (!style.fontSize && !style.bold && !style.italic) style = undefined
    }
  }

  return { text: cleanText, href, footnote, style }
}

/** 노드 내 모든 텍스트를 재귀적으로 추출 */
function extractTextFromNode(node: Node): string {
  let result = ""
  const children = node.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType === 3) result += child.textContent || ""
    else if (child.nodeType === 1) result += extractTextFromNode(child)
  }
  return result.trim()
}
