/**
 * HWPX 손상 ZIP 복구 + Manifest 섹션 경로 해석 (parser.ts에서 분리).
 * Central Directory 손상 시 Local File Header(PK\x03\x04) 직접 스캔 (edu-facility-ai에서 포팅).
 */

import JSZip from "jszip"
import { inflateRawSync } from "zlib"
import { KordocError, isPathTraversal, stripDtd, normalizeSectionHref, compareSectionPaths } from "../utils.js"
import { blocksToMarkdown } from "../table/builder.js"
import type { InternalParseResult, IRBlock, ParseWarning } from "../types.js"
import { applyPageText, createSectionShared, createXmlParser, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES } from "./parser-shared.js"
import { parseSectionXml } from "./section-walker.js"

// ─── 손상 ZIP 복구 (edu-facility-ai에서 포팅) ──────────

export function extractFromBrokenZip(buffer: ArrayBuffer): InternalParseResult {
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
  const shared = createSectionShared()

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
      const secBlocks = parseSectionXml(content, undefined, warnings, sectionNum, shared)
      // 복구 경로는 조판 캐시를 신뢰하지 않는다 — 섹션 근사 고정 (#66)
      for (const b of secBlocks) b.pageNumber = sectionNum
      blocks.push(...secBlocks)
    } catch {
      continue
    }
  }

  if (blocks.length === 0) throw new KordocError("손상된 HWPX에서 섹션 데이터를 복구할 수 없습니다")
  applyPageText(blocks, shared)
  const markdown = blocksToMarkdown(blocks)
  return { markdown, blocks, warnings: warnings.length > 0 ? warnings : undefined }
}

// ─── Manifest 해석 ───────────────────────────────────

/**
 * content.hpf의 kordoc 생성자 마커 판독 — 왕복 채널(자사 파일 한정 복원)의 게이트.
 * generator가 아닌 파일(한컴 산출물 등)은 null → id 기반 인라인 강조·인용 복원 꺼짐.
 */
export async function readKordocLayout(zip: JSZip): Promise<string | null> {
  const file = zip.file("Contents/content.hpf") ?? zip.file("content.hpf")
  if (!file) return null
  try {
    const xml = await file.async("text")
    if (!/<opf:meta\b[^>]*name="generator"[^>]*content="kordoc"/.test(xml)) return null
    return xml.match(/<opf:meta\b[^>]*name="kordoc-layout"[^>]*content="([^"]*)"/)?.[1] ?? null
  } catch {
    return null
  }
}

export async function resolveSectionPaths(zip: JSZip): Promise<string[]> {
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
  return sectionFiles.map(f => f.name).sort(compareSectionPaths)
}

function parseSectionPathsFromManifest(xml: string): string[] {
  const parser = createXmlParser()
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  const items = doc.getElementsByTagName("opf:item")
  const spine = doc.getElementsByTagName("opf:itemref")

  const idToHref = new Map<string, string>()
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const id = item.getAttribute("id") || ""
    const href = normalizeSectionHref(item.getAttribute("href") || "")
    if (id && href) idToHref.set(id, href)
  }

  if (spine.length > 0) {
    const ordered: string[] = []
    for (let i = 0; i < spine.length; i++) {
      const href = idToHref.get(spine[i].getAttribute("idref") || "")
      if (href) ordered.push(href)
    }
    if (ordered.length > 0) return ordered
  }
  return Array.from(idToHref.values()).sort(compareSectionPaths)
}
