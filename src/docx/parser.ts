/**
 * DOCX (Office Open XML Document) 파서
 *
 * ZIP + XML 구조를 jszip + xmldom으로 파싱하여 IRBlock[]로 변환.
 * w:p → paragraph/heading, w:tbl → table, w:drawing → image.
 */

import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import type {
  CellContext, IRBlock, DocumentMetadata, InternalParseResult,
  ParseOptions, ParseWarning, ExtractedImage, InlineStyle,
} from "../types.js"
import { KordocError, precheckZipSize, stripDtd } from "../utils.js"
import { blocksToMarkdown, buildTable } from "../table/builder.js"
import { ommlElementToLatex, isDisplayMath } from "./equation.js"

/** ZIP 압축 해제 누적 최대 크기 (100MB) — ZIP bomb 방지 */
const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024

// ─── XML 헬퍼 ──────────────────────────────────────────

function matchesLocal(el: Element, localName: string): boolean {
  return el.localName === localName || (el.tagName?.endsWith(`:${localName}`) ?? false)
}

/**
 * sdt(콘텐츠 컨트롤)를 투명하게 평탄화한 직속 자식 엘리먼트.
 * `<w:sdt>`는 `<w:sdtContent>`로 실제 내용을 감싸므로(Google Docs 익스포트가
 * 본문 거의 전체를 sdt로 래핑), sdt를 만나면 sdtContent의 자식으로 펼쳐 본다.
 * 블록 sdt(문단/표 래핑)와 인라인 sdt(run 래핑) 모두 동일하게 처리.
 */
function effectiveChildElements(parent: Element | Document): Element[] {
  const result: Element[] = []
  const children = parent.childNodes
  for (let i = 0; i < children.length; i++) {
    const node = children[i]
    if (node.nodeType !== 1) continue
    const el = node as Element
    if (matchesLocal(el, "sdt")) {
      // sdtContent 안으로 평탄화 (중첩 sdt 대비 재귀)
      for (let j = 0; j < el.childNodes.length; j++) {
        const c = el.childNodes[j]
        if (c.nodeType === 1 && matchesLocal(c as Element, "sdtContent")) {
          result.push(...effectiveChildElements(c as Element))
        }
      }
    } else {
      result.push(el)
    }
  }
  return result
}

/** 네임스페이스 무시 + sdt 투명 처리 직속 자식 검색 — DOCX는 네임스페이스가 많음 */
function getChildElements(parent: Element | Document, localName: string): Element[] {
  return effectiveChildElements(parent).filter(el => matchesLocal(el, localName))
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
  return new DOMParser().parseFromString(stripDtd(text), "text/xml") as unknown as Document
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

// ─── OMML 수집 ────────────────────────────────────────

/**
 * paragraph 내부의 최상위 OMML 엘리먼트(`<m:oMath>` / `<m:oMathPara>`) 수집.
 * `<m:oMathPara>` 안의 중첩 `<m:oMath>` 는 중복 제외.
 */
function collectOmmlRoots(p: Element): Element[] {
  const out: Element[] = []
  const walk = (node: Element) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i]
      if (child.nodeType !== 1) continue
      const el = child as Element
      const tag = el.localName || el.tagName?.replace(/^[^:]+:/, "") || ""
      if (tag === "oMath" || tag === "oMathPara") {
        out.push(el)
        // 내부는 재귀하지 않음 (oMathPara 안의 oMath 중복 방지)
      } else if (tag === "txbxContent" || tag === "Fallback") {
        // 텍스트박스 내용은 별도 블록으로 처리되고 mc:Fallback은 mc:Choice의 사본 —
        // 여기서 재귀하면 같은 수식이 앵커 문단 + 텍스트박스 블록으로 이중/삼중 방출
      } else {
        walk(el)
      }
    }
  }
  walk(p)
  return out
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

  // OMML 수식 — <m:oMath> / <m:oMathPara> 를 LaTeX 로 변환해 덧붙임.
  // 인라인 수식은 `$...$`, display 는 `$$...$$`. 순서는 run 뒤로 몰리지만
  // 대부분 한 단락 내 수식/텍스트가 분리돼 있어 실용상 무해.
  for (const om of collectOmmlRoots(p)) {
    const latex = ommlElementToLatex(om)
    if (!latex) continue
    if (isDisplayMath(om)) parts.push(" $$" + latex + "$$ ")
    else parts.push(" $" + latex + "$ ")
  }

  const text = parts.join("").replace(/[ \t]{2,}/g, " ").trim()
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

/**
 * 문단 하위 텍스트박스(w:txbxContent) 문단 수집.
 * mc:AlternateContent는 Choice(drawing)와 Fallback(pict)이 같은 텍스트박스를
 * 이중으로 담으므로 Fallback 서브트리는 스킵한다. 한 번의 워크로 중첩
 * 텍스트박스·텍스트박스 안 표 셀 문단까지 문서 순서대로 수집한다.
 */
function collectTextboxParagraphs(node: Element, inTxbx = false, out: Element[] = [], depth = 0): Element[] {
  if (depth > 40) return out
  for (const el of effectiveChildElements(node)) {
    if (matchesLocal(el, "Fallback")) continue
    const nowIn = inTxbx || matchesLocal(el, "txbxContent")
    if (nowIn && matchesLocal(el, "p")) out.push(el)
    collectTextboxParagraphs(el, nowIn, out, depth + 1)
  }
  return out
}

interface RawDocxCell {
  /** 그리드 열 주소 — gridSpan 누적 합 (배열 인덱스는 span 앞에서 어긋난다) */
  col: number
  colSpan: number
  vMerge: "restart" | "continue" | null
  text: string
}

function parseTable(
  tbl: Element,
  styles: Map<string, StyleInfo>,
  numbering: Map<string, Map<number, NumberingInfo>>,
  footnotes: Map<string, string>,
  rels: Map<string, string>,
): IRBlock | null {
  const trElements = getChildElements(tbl, "tr")
  if (trElements.length === 0) return null

  const rawRows: RawDocxCell[][] = []
  for (const tr of trElements) {
    const row: RawDocxCell[] = []
    // w:trPr/w:gridBefore — 행 앞에서 건너뛴 그리드 열 수. 안 읽으면 그리드가 왼쪽으로
    // 밀려 셀이 다른 열에 무음 오배치된다(병합·들여쓴 행에서 흔함).
    let col = 0
    const trPrEls = getChildElements(tr, "trPr")
    if (trPrEls.length > 0) {
      const gridBeforeEls = getChildElements(trPrEls[0], "gridBefore")
      if (gridBeforeEls.length > 0) {
        // 음수 gridBefore(기형 docx) 클램프 — colAddr=-1 로 첫 셀이 무음 탈락하던 것 방지
        col = Math.max(0, parseInt(getAttr(gridBeforeEls[0], "val") ?? "0", 10) || 0)
      }
    }
    for (const tc of getChildElements(tr, "tc")) {
      let colSpan = 1
      let vMerge: RawDocxCell["vMerge"] = null
      const tcPrEls = getChildElements(tc, "tcPr")
      if (tcPrEls.length > 0) {
        const gridSpanEls = getChildElements(tcPrEls[0], "gridSpan")
        if (gridSpanEls.length > 0) {
          colSpan = parseInt(getAttr(gridSpanEls[0], "val") ?? "1", 10) || 1
        }
        const vMergeEls = getChildElements(tcPrEls[0], "vMerge")
        if (vMergeEls.length > 0) {
          // val 없는 <w:vMerge/>는 계속 셀 (OOXML 기본값)
          vMerge = getAttr(vMergeEls[0], "val") === "restart" ? "restart" : "continue"
        }
      }
      // continue 셀도 텍스트를 수집한다 — 정상 Word는 빈 문단이지만 손상·타 생성기
      // docx는 내용이 있을 수 있고, 버리면 무음 소실 (리뷰 #18)
      const text = collectCellText(tc, styles, numbering, footnotes, rels, 0).join("\n")
      row.push({ col, colSpan, vMerge, text })
      col += colSpan
    }
    rawRows.push(row)
  }

  // 내용 있는 continue 셀 보존: 위쪽 시작 셀이 있으면 텍스트 합류, 없으면(restart
  // 없는 고아 continue) 일반 셀로 승격해 병합 흡수에서 제외
  for (let r = 0; r < rawRows.length; r++) {
    for (const cell of rawRows[r]) {
      if (cell.vMerge !== "continue" || !cell.text) continue
      let start: RawDocxCell | undefined
      for (let pr = r - 1; pr >= 0 && !start; pr--) {
        start = rawRows[pr].find(pc => pc.col === cell.col && pc.vMerge !== "continue")
      }
      if (start) {
        start.text = start.text ? `${start.text}\n${cell.text}` : cell.text
        cell.text = ""
      } else {
        cell.vMerge = null
      }
    }
  }

  // vMerge 계속 셀은 같은 그리드 열의 시작 셀 rowSpan으로 흡수
  const cellRows: CellContext[][] = rawRows.map((row, r) =>
    row
      .filter(cell => cell.vMerge !== "continue")
      .map(cell => {
        let rowSpan = 1
        if (cell.vMerge === "restart") {
          for (let nr = r + 1; nr < rawRows.length; nr++) {
            if (!rawRows[nr].some(nc => nc.col === cell.col && nc.vMerge === "continue")) break
            rowSpan++
          }
        }
        return { text: cell.text, colSpan: cell.colSpan, rowSpan, colAddr: cell.col, rowAddr: r }
      })
  )

  const table = buildTable(cellRows)
  if (table.rows === 0 || table.cols === 0) return null
  return { type: "table", table }
}

/** 셀 내용 수집 — 문단 + 셀 안 중첩 표 텍스트 평탄화 (hml과 동일 규약, 문서 순서 유지) */
function collectCellText(
  tc: Element,
  styles: Map<string, StyleInfo>,
  numbering: Map<string, Map<number, NumberingInfo>>,
  footnotes: Map<string, string>,
  rels: Map<string, string>,
  depth: number,
): string[] {
  const parts: string[] = []
  if (depth > 20) return parts
  for (const el of effectiveChildElements(tc)) {
    if (matchesLocal(el, "p")) {
      const block = parseParagraph(el, styles, numbering, footnotes, rels)
      if (block?.text) parts.push(block.text)
      for (const tp of collectTextboxParagraphs(el)) {
        const tb = parseParagraph(tp, styles, numbering, footnotes, rels)
        if (tb?.text) parts.push(tb.text)
      }
    } else if (matchesLocal(el, "tbl")) {
      for (const tr of getChildElements(el, "tr")) {
        for (const nestedTc of getChildElements(tr, "tc")) {
          parts.push(...collectCellText(nestedTc, styles, numbering, footnotes, rels, depth + 1))
        }
      }
    }
  }
  return parts
}

// ─── 이미지 추출 ────────────────────────────────────────

async function extractImages(
  zip: JSZip,
  rels: Map<string, string>,
  doc: Document,
  warnings: ParseWarning[],
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
      } catch (err) {
        warnings.push({
          code: "SKIPPED_IMAGE",
          message: `DOCX 이미지 추출 실패 (${imgPath}): ${err instanceof Error ? err.message : String(err)}`,
        })
      }
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
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX 스타일(styles.xml) 파싱 실패 — 기본 스타일로 계속: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // 3. 번호 매기기 로드
  let numbering = new Map<string, Map<number, NumberingInfo>>()
  const numFile = zip.file("word/numbering.xml")
  if (numFile) {
    try {
      numbering = parseNumbering(await numFile.async("text"))
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX 번호매기기(numbering.xml) 파싱 실패 — 목록 번호 생략: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  // 4. 각주 로드
  let footnotes = new Map<string, string>()
  const fnFile = zip.file("word/footnotes.xml")
  if (fnFile) {
    try {
      footnotes = parseFootnotes(await fnFile.async("text"))
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX 각주(footnotes.xml) 파싱 실패 — 각주 생략: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
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
  // sdt(콘텐츠 컨트롤)로 감싼 블록 문단/표도 펼쳐서 본다
  const topLevel = effectiveChildElements(bodyEl)

  for (const el of topLevel) {
    const localName = el.localName ?? el.tagName?.split(":").pop()

    if (localName === "p") {
      const block = parseParagraph(el, styles, numbering, footnotes, rels)
      if (block) blocks.push(block)
      // 텍스트박스(도형 안 글) 문단 — 앵커 문단 뒤에 별도 블록으로
      for (const tp of collectTextboxParagraphs(el)) {
        const tb = parseParagraph(tp, styles, numbering, footnotes, rels)
        if (tb) blocks.push(tb)
      }
    } else if (localName === "tbl") {
      const block = parseTable(el, styles, numbering, footnotes, rels)
      if (block) blocks.push(block)
    }
  }

  // 6. 이미지 추출
  const { blocks: imgBlocks, images } = await extractImages(zip, rels, doc, warnings)
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
    } catch (err) {
      warnings.push({
        code: "PARTIAL_PARSE",
        message: `DOCX 메타데이터(core.xml) 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
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
