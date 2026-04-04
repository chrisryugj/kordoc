/**
 * DOCX (Office Open XML Document) 파서
 *
 * ZIP + XML 구조를 jszip + xmldom으로 파싱하여 IRBlock[]로 변환.
 * w:p → paragraph/heading, w:tbl → table, w:drawing → image.
 */

import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import type {
  IRBlock, IRTable, IRCell, DocumentMetadata, InternalParseResult,
  ParseOptions, ParseWarning, ExtractedImage, InlineStyle,
} from "../types.js"
import { KordocError, precheckZipSize } from "../utils.js"
import { blocksToMarkdown } from "../table/builder.js"

/** ZIP 압축 해제 누적 최대 크기 (100MB) — ZIP bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024

// ─── XML 헬퍼 ──────────────────────────────────────────

/** 네임스페이스 무시 태그 검색 — DOCX는 네임스페이스가 많음 */
function getChildElements(parent: Element | Document, localName: string): Element[] {
  const result: Element[] = []
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.nodeType === 1) {
      const el = node as Element
      if (el.localName === localName || el.tagName?.endsWith(`:${localName}`)) {
        result.push(el)
      }
    }
  }
  return result
}

/** 재귀적으로 localName 매칭 — getElementsByTagName 대안 */
function findElements(parent: Element | Document, localName: string): Element[] {
  const result: Element[] = []
  const walk = (node: Element | Document) => {
    const children = node.childNodes
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.nodeType === 1) {
        const el = child as Element
        if (el.localName === localName || el.tagName?.endsWith(`:${localName}`)) {
          result.push(el)
        }
        walk(el)
      }
    }
  }
  walk(parent)
  return result
}

function getAttr(el: Element, localName: string): string | null {
  // w:val, r:id 등 네임스페이스 포함 속성
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (attr.localName === localName || attr.name === localName) return attr.value
  }
  return null
}

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "text/xml")
}

// ─── 스타일 파싱 ────────────────────────────────────────

interface StyleInfo {
  name: string
  basedOn?: string
  outlineLevel?: number
}

function parseStyles(xml: string): Map<string, StyleInfo> {
  const doc = parseXml(xml)
  const styles = new Map<string, StyleInfo>()
  const styleElements = findElements(doc, "style")

  for (const el of styleElements) {
    const styleId = getAttr(el, "styleId")
    if (!styleId) continue

    const nameEls = getChildElements(el, "name")
    const name = nameEls.length > 0 ? (getAttr(nameEls[0], "val") ?? "") : ""
    const basedOnEls = getChildElements(el, "basedOn")
    const basedOn = basedOnEls.length > 0 ? (getAttr(basedOnEls[0], "val") ?? undefined) : undefined

    // outlineLevel으로 heading 감지
    const pPrEls = getChildElements(el, "pPr")
    let outlineLevel: number | undefined
    if (pPrEls.length > 0) {
      const outlineEls = getChildElements(pPrEls[0], "outlineLvl")
      if (outlineEls.length > 0) {
        const val = getAttr(outlineEls[0], "val")
        if (val !== null) outlineLevel = parseInt(val, 10)
      }
    }

    // Heading 패턴 매칭
    if (outlineLevel === undefined) {
      const headingMatch = name.match(/^(?:heading|Heading)\s*(\d+)$/i)
      if (headingMatch) outlineLevel = parseInt(headingMatch[1], 10) - 1
    }

    styles.set(styleId, { name, basedOn, outlineLevel })
  }
  return styles
}

// ─── 번호 매기기 파싱 ──────────────────────────────────

interface NumberingInfo {
  numFmt: string  // "decimal", "bullet", etc.
  level: number
}

function parseNumbering(xml: string): Map<string, Map<number, NumberingInfo>> {
  const doc = parseXml(xml)
  const abstractNums = new Map<string, Map<number, NumberingInfo>>()

  // abstractNum 파싱
  const abstractElements = findElements(doc, "abstractNum")
  for (const el of abstractElements) {
    const abstractNumId = getAttr(el, "abstractNumId")
    if (!abstractNumId) continue
    const levels = new Map<number, NumberingInfo>()
    const lvlElements = getChildElements(el, "lvl")
    for (const lvl of lvlElements) {
      const ilvl = parseInt(getAttr(lvl, "ilvl") ?? "0", 10)
      const numFmtEls = getChildElements(lvl, "numFmt")
      const numFmt = numFmtEls.length > 0 ? (getAttr(numFmtEls[0], "val") ?? "bullet") : "bullet"
      levels.set(ilvl, { numFmt, level: ilvl })
    }
    abstractNums.set(abstractNumId, levels)
  }

  // num → abstractNum 매핑
  const nums = new Map<string, Map<number, NumberingInfo>>()
  const numElements = findElements(doc, "num")
  for (const el of numElements) {
    const numId = getAttr(el, "numId")
    if (!numId) continue
    const abstractRefs = getChildElements(el, "abstractNumId")
    if (abstractRefs.length > 0) {
      const ref = getAttr(abstractRefs[0], "val")
      if (ref && abstractNums.has(ref)) {
        nums.set(numId, abstractNums.get(ref)!)
      }
    }
  }
  return nums
}

// ─── 관계 파싱 ─────────────────────────────────────────

function parseRels(xml: string): Map<string, string> {
  const doc = parseXml(xml)
  const map = new Map<string, string>()
  const rels = findElements(doc, "Relationship")
  for (const rel of rels) {
    const id = getAttr(rel, "Id")
    const target = getAttr(rel, "Target")
    if (id && target) map.set(id, target)
  }
  return map
}

// ─── 각주 파싱 ─────────────────────────────────────────

function parseFootnotes(xml: string): Map<string, string> {
  const doc = parseXml(xml)
  const notes = new Map<string, string>()
  const fnElements = findElements(doc, "footnote")
  for (const fn of fnElements) {
    const id = getAttr(fn, "id")
    if (!id || id === "0" || id === "-1") continue // 0=separator, -1=continuation
    const texts: string[] = []
    const pElements = findElements(fn, "p")
    for (const p of pElements) {
      const runs = findElements(p, "r")
      for (const r of runs) {
        const tElements = getChildElements(r, "t")
        for (const t of tElements) texts.push(t.textContent ?? "")
      }
    }
    notes.set(id, texts.join("").trim())
  }
  return notes
}

// ─── Run 텍스트 추출 ──────────────────────────────────

interface RunResult {
  text: string
  bold: boolean
  italic: boolean
}

function extractRun(r: Element): RunResult {
  const tElements = getChildElements(r, "t")
  const text = tElements.map(t => t.textContent ?? "").join("")

  let bold = false
  let italic = false
  const rPrEls = getChildElements(r, "rPr")
  if (rPrEls.length > 0) {
    bold = getChildElements(rPrEls[0], "b").length > 0
    italic = getChildElements(rPrEls[0], "i").length > 0
  }

  return { text, bold, italic }
}

// ─── 단락 파싱 ─────────────────────────────────────────

function parseParagraph(
  p: Element,
  styles: Map<string, StyleInfo>,
  numbering: Map<string, Map<number, NumberingInfo>>,
  footnotes: Map<string, string>,
  rels: Map<string, string>,
): IRBlock | null {
  // 스타일 확인
  const pPrEls = getChildElements(p, "pPr")
  let styleId = ""
  let numId = ""
  let ilvl = 0

  if (pPrEls.length > 0) {
    const pStyleEls = getChildElements(pPrEls[0], "pStyle")
    if (pStyleEls.length > 0) styleId = getAttr(pStyleEls[0], "val") ?? ""

    const numPrEls = getChildElements(pPrEls[0], "numPr")
    if (numPrEls.length > 0) {
      const numIdEls = getChildElements(numPrEls[0], "numId")
      const ilvlEls = getChildElements(numPrEls[0], "ilvl")
      numId = numIdEls.length > 0 ? (getAttr(numIdEls[0], "val") ?? "") : ""
      ilvl = ilvlEls.length > 0 ? parseInt(getAttr(ilvlEls[0], "val") ?? "0", 10) : 0
    }
  }

  // 텍스트 수집
  const parts: string[] = []
  let hasBold = false
  let hasItalic = false
  let href: string | undefined
  let footnoteText: string | undefined

  // 하이퍼링크 처리
  const hyperlinks = getChildElements(p, "hyperlink")
  const hyperlinkTexts = new Set<string>()

  for (const hl of hyperlinks) {
    const rId = getAttr(hl, "id")
    const hlText: string[] = []
    const runs = findElements(hl, "r")
    for (const r of runs) {
      const result = extractRun(r)
      hlText.push(result.text)
    }
    const text = hlText.join("")
    if (text) {
      hyperlinkTexts.add(text)
      if (rId && rels.has(rId)) {
        href = rels.get(rId)
        parts.push(text)
      } else {
        parts.push(text)
      }
    }
  }

  // 일반 run 처리
  const runs = getChildElements(p, "r")
  for (const r of runs) {
    // 하이퍼링크 내부 run은 이미 처리됨 — 부모가 hyperlink이면 스킵
    if (r.parentNode && (r.parentNode as Element).localName === "hyperlink") continue

    const result = extractRun(r)
    if (result.bold) hasBold = true
    if (result.italic) hasItalic = true

    // 각주 참조 확인
    const fnRefEls = getChildElements(r, "footnoteReference")
    if (fnRefEls.length > 0) {
      const fnId = getAttr(fnRefEls[0], "id")
      if (fnId && footnotes.has(fnId)) {
        footnoteText = footnotes.get(fnId)
      }
    }

    if (result.text) parts.push(result.text)
  }

  const text = parts.join("").trim()
  if (!text) return null

  // Heading 판별
  const style = styles.get(styleId)
  if (style?.outlineLevel !== undefined && style.outlineLevel >= 0 && style.outlineLevel <= 5) {
    return {
      type: "heading",
      text,
      level: style.outlineLevel + 1,
    }
  }

  // 리스트 판별
  if (numId && numId !== "0") {
    const numDef = numbering.get(numId)
    const levelInfo = numDef?.get(ilvl)
    const listType = levelInfo?.numFmt === "bullet" ? "unordered" : "ordered"
    return { type: "list", text, listType }
  }

  // 일반 단락
  const block: IRBlock = { type: "paragraph", text }
  if (hasBold || hasItalic) {
    block.style = { bold: hasBold || undefined, italic: hasItalic || undefined }
  }
  if (href) block.href = href
  if (footnoteText) block.footnoteText = footnoteText
  return block
}

// ─── 테이블 파싱 ────────────────────────────────────────

function parseTable(
  tbl: Element,
  styles: Map<string, StyleInfo>,
  numbering: Map<string, Map<number, NumberingInfo>>,
  footnotes: Map<string, string>,
  rels: Map<string, string>,
): IRBlock | null {
  const trElements = getChildElements(tbl, "tr")
  if (trElements.length === 0) return null

  const rows: IRCell[][] = []
  let maxCols = 0

  for (const tr of trElements) {
    const tcElements = getChildElements(tr, "tc")
    const row: IRCell[] = []

    for (const tc of tcElements) {
      // 셀 속성
      let colSpan = 1
      let rowSpan = 1
      const tcPrEls = getChildElements(tc, "tcPr")
      if (tcPrEls.length > 0) {
        const gridSpanEls = getChildElements(tcPrEls[0], "gridSpan")
        if (gridSpanEls.length > 0) {
          colSpan = parseInt(getAttr(gridSpanEls[0], "val") ?? "1", 10)
        }
        const vMergeEls = getChildElements(tcPrEls[0], "vMerge")
        if (vMergeEls.length > 0) {
          const val = getAttr(vMergeEls[0], "val")
          if (val !== "restart" && val !== null) {
            // 병합 계속 셀 — 스킵 마커
            row.push({ text: "", colSpan, rowSpan: 0 })
            continue
          }
        }
      }

      // 셀 텍스트
      const cellTexts: string[] = []
      const pElements = getChildElements(tc, "p")
      for (const p of pElements) {
        const block = parseParagraph(p, styles, numbering, footnotes, rels)
        if (block?.text) cellTexts.push(block.text)
      }

      row.push({ text: cellTexts.join("\n"), colSpan, rowSpan })
    }
    rows.push(row)
    if (row.length > maxCols) maxCols = row.length
  }

  // vMerge rowSpan 후처리: restart에서 아래로 연속되는 rowSpan=0 카운트
  for (let c = 0; c < maxCols; c++) {
    for (let r = 0; r < rows.length; r++) {
      const cell = rows[r][c]
      if (!cell || cell.rowSpan === 0) continue
      let span = 1
      for (let nr = r + 1; nr < rows.length; nr++) {
        if (rows[nr][c]?.rowSpan === 0) span++
        else break
      }
      cell.rowSpan = span
    }
  }

  // rowSpan=0인 placeholder 제거
  const cleanRows: IRCell[][] = []
  for (const row of rows) {
    const clean = row.filter(cell => cell.rowSpan !== 0)
    cleanRows.push(clean)
  }

  // 빈 테이블 체크
  if (cleanRows.length === 0) return null

  // 컬럼 수 재계산
  let cols = 0
  for (const row of cleanRows) {
    let c = 0
    for (const cell of row) c += cell.colSpan
    if (c > cols) cols = c
  }

  const table: IRTable = {
    rows: cleanRows.length,
    cols,
    cells: cleanRows,
    hasHeader: cleanRows.length > 1,
  }
  return { type: "table", table }
}

// ─── 이미지 추출 ────────────────────────────────────────

async function extractImages(
  zip: JSZip,
  rels: Map<string, string>,
  doc: Document,
): Promise<{ blocks: IRBlock[]; images: ExtractedImage[] }> {
  const blocks: IRBlock[] = []
  const images: ExtractedImage[] = []

  const drawingElements = findElements(doc.documentElement, "drawing")
  let imgIdx = 0

  for (const drawing of drawingElements) {
    // a:blip → r:embed
    const blips = findElements(drawing, "blip")
    for (const blip of blips) {
      const embedId = getAttr(blip, "embed")
      if (!embedId) continue
      const target = rels.get(embedId)
      if (!target) continue

      const imgPath = target.startsWith("/") ? target.slice(1)
        : target.startsWith("word/") ? target
        : `word/${target}`

      const imgFile = zip.file(imgPath)
      if (!imgFile) continue

      try {
        const data = await imgFile.async("uint8array")
        imgIdx++
        const ext = imgPath.split(".").pop()?.toLowerCase() ?? "png"
        const mimeMap: Record<string, string> = {
          png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
          gif: "image/gif", bmp: "image/bmp", wmf: "image/wmf", emf: "image/emf",
        }
        const filename = `image_${String(imgIdx).padStart(3, "0")}.${ext}`
        images.push({ filename, data, mimeType: mimeMap[ext] ?? "image/png" })
        blocks.push({ type: "image", text: filename })
      } catch { /* 이미지 실패 무시 */ }
    }
  }
  return { blocks, images }
}

// ─── 메인 파서 ─────────────────────────────────────────

export async function parseDocxDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
): Promise<InternalParseResult> {
  // ZIP bomb 사전 검사
  precheckZipSize(buffer, MAX_DECOMPRESS_SIZE)

  const zip = await JSZip.loadAsync(buffer)
  const warnings: ParseWarning[] = []

  // DOCX 구조 검증
  const docFile = zip.file("word/document.xml")
  if (!docFile) {
    throw new KordocError("유효하지 않은 DOCX 파일: word/document.xml이 없습니다")
  }

  // 1. 관계 로드
  let rels = new Map<string, string>()
  const relsFile = zip.file("word/_rels/document.xml.rels")
  if (relsFile) {
    rels = parseRels(await relsFile.async("text"))
  }

  // 2. 스타일 로드
  let styles = new Map<string, StyleInfo>()
  const stylesFile = zip.file("word/styles.xml")
  if (stylesFile) {
    try {
      styles = parseStyles(await stylesFile.async("text"))
    } catch { /* 스타일 실패 무시 */ }
  }

  // 3. 번호 매기기 로드
  let numbering = new Map<string, Map<number, NumberingInfo>>()
  const numFile = zip.file("word/numbering.xml")
  if (numFile) {
    try {
      numbering = parseNumbering(await numFile.async("text"))
    } catch { /* 번호 매기기 실패 무시 */ }
  }

  // 4. 각주 로드
  let footnotes = new Map<string, string>()
  const fnFile = zip.file("word/footnotes.xml")
  if (fnFile) {
    try {
      footnotes = parseFootnotes(await fnFile.async("text"))
    } catch { /* 각주 실패 무시 */ }
  }

  // 5. 본문 파싱
  const docXml = await docFile.async("text")
  const doc = parseXml(docXml)
  const body = findElements(doc, "body")
  if (body.length === 0) {
    throw new KordocError("DOCX 본문(w:body)을 찾을 수 없습니다")
  }

  const blocks: IRBlock[] = []
  const bodyEl = body[0]
  const children = bodyEl.childNodes

  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.nodeType !== 1) continue
    const el = node as Element
    const localName = el.localName ?? el.tagName?.split(":").pop()

    if (localName === "p") {
      const block = parseParagraph(el, styles, numbering, footnotes, rels)
      if (block) blocks.push(block)
    } else if (localName === "tbl") {
      const block = parseTable(el, styles, numbering, footnotes, rels)
      if (block) blocks.push(block)
    }
  }

  // 6. 이미지 추출
  const { blocks: imgBlocks, images } = await extractImages(zip, rels, doc)
  // 이미지 블록은 본문에 이미 포함되어야 하지만, 누락된 것 추가
  // (drawing이 paragraph 내에 있으므로 대부분 이미 포함됨)

  // 7. 메타데이터
  const metadata: DocumentMetadata = {}
  const coreFile = zip.file("docProps/core.xml")
  if (coreFile) {
    try {
      const coreXml = await coreFile.async("text")
      const coreDoc = parseXml(coreXml)
      const getFirst = (tag: string) => {
        const els = coreDoc.getElementsByTagName(tag)
        return els.length > 0 ? (els[0].textContent ?? "").trim() : undefined
      }
      metadata.title = getFirst("dc:title") || getFirst("dcterms:title")
      metadata.author = getFirst("dc:creator")
      metadata.description = getFirst("dc:description")
      const created = getFirst("dcterms:created")
      if (created) metadata.createdAt = created
      const modified = getFirst("dcterms:modified")
      if (modified) metadata.modifiedAt = modified
    } catch { /* 메타데이터 실패 무시 */ }
  }

  // 8. 아웃라인
  const outline = blocks
    .filter(b => b.type === "heading")
    .map(b => ({ level: b.level ?? 2, text: b.text ?? "" }))

  const markdown = blocksToMarkdown(blocks)

  return {
    markdown,
    blocks,
    metadata,
    outline: outline.length > 0 ? outline : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    images: images.length > 0 ? images : undefined,
  }
}
