/**
 * HWPX 메타데이터 추출 (parser.ts에서 분리) — content.hpf(OPF)·Dublin Core best-effort.
 */

import JSZip from "jszip"
import { KordocError, stripDtd } from "../utils.js"
import type { DocumentMetadata } from "../types.js"
import { createXmlParser, MAX_DECOMPRESS_SIZE } from "./parser-shared.js"
import { resolveSectionPaths } from "./zip-sections.js"
import { elementChildren, findChildByLocalName, localName } from "../shared/xml.js"

// ─── 메타데이터 추출 (best-effort) ───────────────────

/**
 * HWPX ZIP 내 메타데이터 파일에서 문서 정보 추출.
 * 한컴 저장본은 패키지 문서 Contents/content.hpf(OPF)의 opf:metadata 에 둔다 — 먼저 읽고,
 * 제목·지은이가 없으면 Dublin Core 경로(meta.xml, docProps/core.xml)로 비는 필드를 채운다.
 */
export async function extractHwpxMetadata(zip: JSZip, metadata: DocumentMetadata, decompressed?: { total: number }): Promise<void> {
  try {
    const read = async (path: string): Promise<string | null> => {
      const file = zip.file(path) || Object.values(zip.files).find(f => f.name.toLowerCase() === path.toLowerCase()) || null
      if (!file) return null
      const xml = await file.async("text")
      if (decompressed) {
        decompressed.total += xml.length * 2
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      }
      return xml
    }
    for (const hp of ["Contents/content.hpf", "content.hpf"]) {
      const xml = await read(hp)
      if (!xml) continue
      parseOpfMetadata(xml, metadata)
      break
    }
    if (metadata.title || metadata.author) return
    // meta.xml (HWPX 표준) 또는 docProps/core.xml (OOXML 호환)
    const metaPaths = ["meta.xml", "META-INF/meta.xml", "docProps/core.xml"]
    for (const mp of metaPaths) {
      const xml = await read(mp)
      if (!xml) continue
      parseDublinCoreMetadata(xml, metadata)
      if (metadata.title || metadata.author) return
    }
  } catch {
    // best-effort
  }
}

/**
 * 한컴 패키지 문서(content.hpf) 메타 — opf:title 과 opf:meta name=creator·subject·description·keyword·
 * CreatedDate·ModifiedDate (값은 요소 글, content="text" 는 형식 표지). HWP5 요약 정보(2 제목·4 지은이·
 * 6 설명|3 주제·5 키워드·12/13 날짜)와 같은 필드 — 한컴이 저장한 hwp↔hwpx 짝에서 값이 같다.
 * lastsaveby·date(한국어 날짜 글)는 HWP5 와 같이 싣지 않는다
 */
function parseOpfMetadata(xml: string, metadata: DocumentMetadata): void {
  const root = createXmlParser().parseFromString(stripDtd(xml), "text/xml").documentElement as unknown as Element | null
  const md = root ? findChildByLocalName(root, "metadata") : null
  if (!md) return
  let title: string | undefined
  const meta = new Map<string, string>()
  for (const el of elementChildren(md)) {
    const text = el.textContent?.trim()
    if (!text) continue
    const tag = localName(el)
    if (tag === "title") title ??= text
    else if (tag === "meta") {
      const name = el.getAttribute("name")
      if (name && !meta.has(name)) meta.set(name, text)
    }
  }
  const put = <K extends keyof DocumentMetadata>(k: K, v: DocumentMetadata[K] | undefined) => {
    if (v !== undefined && !metadata[k]) metadata[k] = v
  }
  const keywords = meta.get("keyword")?.split(/[,;]/).map(k => k.trim()).filter(Boolean)
  put("title", title)
  put("author", meta.get("creator"))
  put("description", meta.get("description") || meta.get("subject"))
  put("keywords", keywords?.length ? keywords : undefined)
  put("createdAt", isoDate(meta.get("CreatedDate")))
  put("modifiedAt", isoDate(meta.get("ModifiedDate")))
}

/**
 * content.hpf 날짜 → ISO 8601. 한컴은 보통 "2023-07-14T02:14:57Z"(UTC)로 쓰지만 T·Z 없는 "2025-07-07 09:40:07"
 * 저장본도 있다 — 이 꼴은 저장한 PC 의 현지 시각이다 (pairs/pair02 ModifiedDate "1601-01-01 09:00:00" = FILETIME 0
 * + KST 9시간). 시간대를 지어내지 않고 "T" 만 넣어 시간대 없는 ISO 8601 로 둔다. FILETIME 0(1601-01-01, 미기록)은
 * HWP5 요약 정보처럼 없음, 모르는 꼴은 그대로
 */
function isoDate(s: string | undefined): string | undefined {
  if (!s || s.startsWith("1601-01-01")) return undefined
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(s)
  return m ? `${m[1]}T${m[2]}` : s
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
