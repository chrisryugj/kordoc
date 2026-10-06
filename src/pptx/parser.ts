/**
 * PPTX (Office Open XML Presentation) 파서
 *
 * ZIP + XML 구조를 jszip + xmldom으로 파싱하여 IRBlock[]로 변환.
 * 슬라이드 1장 = 1쪽(pageNumber, presentation.xml 의 p:sldIdLst 순서).
 * p:sp → heading(제목 개체 틀)/list(본문 개체 틀·글머리표)/paragraph, a:tbl → table, p:pic → image,
 * 발표자 노트 → 인용(quote) 문단. 쪽 번호·날짜·바닥글 개체 틀은 내용이 아니라 버린다.
 */

import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import type {
  CellContext, IRBlock, DocumentMetadata, InternalParseResult,
  ParseOptions, ParseWarning, ExtractedImage,
} from "../types.js"
import { KordocError, partExtension, precheckZipSize, unzipLimitBytes, stripDtd } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { blocksToMarkdown, buildTable, escapeLiteralDollar } from "../table/builder.js"
import { escapeLiteralTags, tidyScriptTags, wrapScript } from "../script-tags.js"
import { detectImageMime } from "../hwp5/images.js"
import { localName, findChildByLocalName, childrenByLocalName, elementChildren, rawTextContent, MAX_XML_DEPTH } from "../shared/xml.js"

/** ZIP 압축 해제 누적 최대 크기 (100MB) — ZIP bomb 방지 (DOCX 와 같은 값) */
const MAX_DECOMPRESS_SIZE = unzipLimitBytes(100 * 1024 * 1024)
/** 그림·개체 파트 — images:false 면 풀지 않으니 ZIP 상한에서도 뺀다 (DOCX #108 과 같은 규약) */
const MEDIA_PART_RE = /^ppt\/(?:media|embeddings)\//
/** 그림이 아닌 미디어·OLE 임베드 — 파서가 어느 때도 풀지 않는다(ZIP 상한에서 늘 뺀다) */
const NEVER_READ_RE = /^ppt\/(?:embeddings\/.*|media\/.+\.(?:mp4|m4v|mov|avi|wmv|mpe?g|mkv|webm|mp3|wav|m4a|wma|aac|ogg|flac|mid|bin))$/i
/** ZIP 엔트리 상한 — 슬라이드마다 slide·rels·notes·notes rels 네 파트에 그림이 붙어
 *  HWPX·DOCX 기본(500)으로는 200장 남짓한 보통 발표 자료도 막힌다 */
const MAX_ZIP_ENTRIES = 10000
/** 슬라이드 수 상한 — sldIdLst 를 부풀린 악성 파일 방지 */
const MAX_SLIDES = 2000

/** 내용이 아닌 개체 틀 — 쪽 번호·날짜·바닥글·머리글, 노트의 슬라이드 그림 */
const SKIP_PLACEHOLDERS = new Set(["sldNum", "dt", "ftr", "hdr", "sldImg"])
/** 글머리표가 기본으로 켜진 개체 틀 (type 없는 ph 의 기본값은 "obj") */
const BULLET_PLACEHOLDERS = new Set(["body", "obj"])

const REL_NOTES = "/notesSlide"
const REL_IMAGE = "/image"
const SLIDE_PART_RE = /^ppt\/slides\/slide(\d+)\.xml$/

const IMAGE_MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", bmp: "image/bmp", wmf: "image/wmf", emf: "image/emf",
  tif: "image/tiff", tiff: "image/tiff", svg: "image/svg+xml",
}

// ─── XML 헬퍼 ──────────────────────────────────────────

function parseXml(text: string): Document {
  return new DOMParser().parseFromString(stripDtd(text), "text/xml") as unknown as Document
}

/** 네임스페이스 접두사 무시 속성 조회 — r:id·r:embed 등 */
function getAttr(el: Element, name: string): string | null {
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (attr.localName === name || attr.name === name) return attr.value
  }
  return null
}

const NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

/** 관계 참조 속성(r:id) — p:sldId 는 접두사 없는 id(슬라이드 번호)도 함께 가져 localName 만으로는 못 가른다 */
function getRelId(el: Element): string | null {
  const attrs = el.attributes
  for (let i = 0; i < attrs.length; i++) {
    const attr = attrs[i]
    if (attr.localName === "id" && (attr.namespaceURI === NS_REL || attr.name === "r:id")) return attr.value
  }
  return null
}

/** 자식 경로를 localName 으로 따라간다 — 하나라도 없으면 null */
function findPath(el: Element | null, ...names: string[]): Element | null {
  for (const name of names) {
    if (!el) return null
    el = findChildByLocalName(el, name)
  }
  return el
}

/** 파트 기준 상대 경로 → ZIP 절대 경로 ("../media/a.png", "/ppt/slides/slide1.xml" 모두) */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts = baseDir ? baseDir.split("/") : []
  for (const seg of target.split("/")) {
    if (seg === "..") parts.pop()
    else if (seg && seg !== ".") parts.push(seg)
  }
  return parts.join("/")
}

interface Rel { type: string; target: string }

/** 파트의 관계(.rels) — rId → { type, 절대 경로 }. 외부 링크는 뺀다 */
async function readRels(zip: JSZip, part: string): Promise<Map<string, Rel>> {
  const map = new Map<string, Rel>()
  const slash = part.lastIndexOf("/")
  const dir = slash >= 0 ? part.slice(0, slash) : ""
  const file = zip.file(`${dir ? dir + "/" : ""}_rels/${part.slice(slash + 1)}.rels`)
  if (!file) return map
  const doc = parseXml(await file.async("text"))
  for (const rel of childrenByLocalName(doc.documentElement, "Relationship")) {
    const id = getAttr(rel, "Id")
    const target = getAttr(rel, "Target")
    if (!id || !target || getAttr(rel, "TargetMode") === "External") continue
    map.set(id, { type: getAttr(rel, "Type") ?? "", target: resolvePart(dir, target) })
  }
  return map
}

/** 발표 순서대로 슬라이드 파트 — presentation.xml 이 없거나 비면 파일 번호 순 */
async function slideParts(zip: JSZip): Promise<string[]> {
  const ordered: string[] = []
  const presFile = zip.file("ppt/presentation.xml")
  if (presFile) {
    const pres = parseXml(await presFile.async("text"))
    const rels = await readRels(zip, "ppt/presentation.xml")
    const list = findChildByLocalName(pres.documentElement, "sldIdLst")
    for (const sld of list ? childrenByLocalName(list, "sldId") : []) {
      const target = rels.get(getRelId(sld) ?? "")?.target
      if (target && zip.file(target)) ordered.push(target)
    }
  }
  if (ordered.length === 0) {
    const names = Object.keys(zip.files).filter(n => SLIDE_PART_RE.test(n))
    names.sort((a, b) => Number(SLIDE_PART_RE.exec(a)![1]) - Number(SLIDE_PART_RE.exec(b)![1]))
    ordered.push(...names)
  }
  if (ordered.length > MAX_SLIDES) throw new KordocError(`PPTX 슬라이드 수 초과: ${ordered.length} (최대 ${MAX_SLIDES})`)
  return ordered
}

// ─── 글 ────────────────────────────────────────────────

/** a:p 한 문단의 글 — a:r·a:fld 의 a:t, 줄바꿈 a:br 은 공백. IR 규약대로 리터럴 $ 는 \$, 태그 꼴 "<sub>" 는 \<sub>
 *  (escapeLiteralDollar·escapeLiteralTags — 그대로 두면 "$10 ~ $20" 이 마크다운에서 수식이 된다) */
function paragraphText(p: Element): string {
  let text = ""
  for (const child of elementChildren(p)) {
    const name = localName(child)
    if (name === "r" || name === "fld") {
      const t = findChildByLocalName(child, "t")
      // 위·아래첨자 — a:rPr baseline(1/1000 %, 양수 위·음수 아래). 펴면 "10⁴" 가 "104" 로 값이 바뀐다 (DOCX·HWPX 와 같은 표지)
      const rPr = findChildByLocalName(child, "rPr")
      const baseline = Number(rPr ? getAttr(rPr, "baseline") ?? 0 : 0)
      if (t) text += wrapScript(escapeLiteralTags(escapeLiteralDollar(rawTextContent(t))), baseline > 0 ? "sup" : baseline < 0 ? "sub" : null)
    } else if (name === "br") {
      text += " "
    }
  }
  return tidyScriptTags(text.replace(/\s+/g, " ").trim())
}

type Bullet = "none" | "ordered" | "unordered" | undefined

interface Para { text: string; lvl: number; bullet: Bullet }

/** a:txBody 의 문단들 — 빈 문단은 뺀다. 글머리표는 a:pPr 에 적힌 것만(없으면 상속 = undefined) */
function bodyParagraphs(txBody: Element): Para[] {
  const out: Para[] = []
  for (const p of childrenByLocalName(txBody, "p")) {
    const text = paragraphText(p)
    if (!text) continue
    const pPr = findChildByLocalName(p, "pPr")
    let bullet: Bullet
    if (pPr) {
      if (findChildByLocalName(pPr, "buNone")) bullet = "none"
      else if (findChildByLocalName(pPr, "buAutoNum")) bullet = "ordered"
      else if (findChildByLocalName(pPr, "buChar") || findChildByLocalName(pPr, "buBlip")) bullet = "unordered"
    }
    const lvl = Math.max(0, parseInt(pPr ? getAttr(pPr, "lvl") ?? "0" : "0", 10) || 0)
    out.push({ text, lvl, bullet })
  }
  return out
}

/** 개체 틀 종류 — 개체 틀이 아니면 null, type 이 없으면 "obj" (OOXML 기본값) */
function placeholderType(sp: Element): string | null {
  const ph = findPath(sp, "nvSpPr", "nvPr", "ph")
  return ph ? getAttr(ph, "type") ?? "obj" : null
}

/** 문단 → 블록. 글머리 문단은 list 로, 수준 1 이상은 바로 앞 list 의 children 으로 (blocksToMarkdown 의 2단 목록) */
function pushParagraphs(paras: Para[], bulletDefault: boolean, page: number, out: IRBlock[]): void {
  let lastList: IRBlock | null = null
  for (const para of paras) {
    const bullet = para.bullet ?? (bulletDefault ? "unordered" : "none")
    if (bullet === "none") {
      out.push({ type: "paragraph", text: para.text, pageNumber: page })
      lastList = null
      continue
    }
    const item: IRBlock = { type: "list", text: para.text, listType: bullet, pageNumber: page }
    if (para.lvl > 0 && lastList) {
      ;(lastList.children ??= []).push(item)
    } else {
      out.push(item)
      lastList = item
    }
  }
}

// ─── 표 ────────────────────────────────────────────────

/** a:tbl → 표 블록. 병합 연속 칸(hMerge·vMerge)은 원점 칸의 gridSpan·rowSpan 이 덮으므로 뺀다 */
function parseTable(tbl: Element, page: number, keepEmptyCols?: boolean): IRBlock | null {
  const rows = childrenByLocalName(tbl, "tr")
  if (rows.length === 0) return null
  const cellRows: CellContext[][] = rows.map((tr, r) => {
    const cells: CellContext[] = []
    childrenByLocalName(tr, "tc").forEach((tc, c) => {
      if (getAttr(tc, "hMerge") === "1" || getAttr(tc, "vMerge") === "1") return
      const txBody = findChildByLocalName(tc, "txBody")
      const text = txBody ? bodyParagraphs(txBody).map(p => p.text).join("\n") : ""
      cells.push({
        text,
        colSpan: Math.max(1, parseInt(getAttr(tc, "gridSpan") ?? "1", 10) || 1),
        rowSpan: Math.max(1, parseInt(getAttr(tc, "rowSpan") ?? "1", 10) || 1),
        colAddr: c,
        rowAddr: r,
      })
    })
    return cells
  })
  const table = buildTable(cellRows, { keepAnchoredEmptyCols: keepEmptyCols })
  if (table.rows === 0 || table.cols === 0) return null
  return { type: "table", table, pageNumber: page }
}

// ─── 슬라이드 ───────────────────────────────────────────

interface SlideContext {
  zip: JSZip
  rels: Map<string, Rel>
  page: number
  warnings: ParseWarning[]
  options?: ParseOptions
  /** 그림 파트 → 파일명 (같은 그림을 여러 슬라이드가 쓰면 한 번만 저장) */
  imageNames: Map<string, string>
  images: ExtractedImage[]
}

async function pictureBlock(pic: Element, ctx: SlideContext): Promise<IRBlock | null> {
  const blip = findPath(pic, "blipFill", "blip")
  const embed = blip ? getAttr(blip, "embed") : null
  const rel = embed ? ctx.rels.get(embed) : undefined
  if (!rel || !rel.type.endsWith(REL_IMAGE)) return null
  let filename = ctx.imageNames.get(rel.target)
  if (!filename) {
    const file = ctx.zip.file(rel.target)
    if (!file) return null
    const ext = partExtension(rel.target)
    filename = `image_${String(ctx.imageNames.size + 1).padStart(3, "0")}.${ext}`
    try {
      // 삼항 안 await 는 CJS 빌드(sucrase)가 못 읽는다 — if 로
      if (ctx.options?.images !== false) {
        const data = await file.async("uint8array")
        ctx.images.push({ filename, data, mimeType: IMAGE_MIME[ext] ?? detectImageMime(data) ?? "application/octet-stream", source: rel.target })
      }
    } catch (err) {
      ctx.warnings.push({
        page: ctx.page, code: "SKIPPED_IMAGE",
        message: `PPTX 이미지 추출 실패 (${rel.target}): ${err instanceof Error ? err.message : String(err)}`,
      })
      return null
    }
    ctx.imageNames.set(rel.target, filename)
  }
  return { type: "image", text: filename, pageNumber: ctx.page }
}

/** p:spTree 를 그리는 순서대로 — 그룹(p:grpSp)은 펼치고 mc:AlternateContent 는 Choice 쪽을 본다 */
async function walkShapes(tree: Element, ctx: SlideContext, out: IRBlock[], depth = 0): Promise<void> {
  if (depth > MAX_XML_DEPTH) return
  for (const el of elementChildren(tree)) {
    switch (localName(el)) {
      case "grpSp":
        await walkShapes(el, ctx, out, depth + 1)
        break
      case "AlternateContent": {
        const choice = findChildByLocalName(el, "Choice")
        if (choice) await walkShapes(choice, ctx, out, depth + 1)
        break
      }
      case "sp": {
        const ph = placeholderType(el)
        const txBody = findChildByLocalName(el, "txBody")
        if ((ph && SKIP_PLACEHOLDERS.has(ph)) || !txBody) break
        const paras = bodyParagraphs(txBody)
        if (paras.length === 0) break
        if (ph === "title" || ph === "ctrTitle") {
          out.push({ type: "heading", level: ph === "ctrTitle" ? 1 : 2, text: paras.map(p => p.text).join(" "), pageNumber: ctx.page })
        } else {
          pushParagraphs(paras, ph !== null && BULLET_PLACEHOLDERS.has(ph), ctx.page, out)
        }
        break
      }
      case "graphicFrame": {
        const data = findPath(el, "graphic", "graphicData")
        const tbl = data ? findChildByLocalName(data, "tbl") : null
        if (tbl) {
          const block = parseTable(tbl, ctx.page, ctx.options?.keepTrailingEmptyCols)
          if (block) out.push(block)
        } else if (data) {
          const uri = getAttr(data, "uri") ?? ""
          const kind = /chart/i.test(uri) ? "차트" : /diagram/i.test(uri) ? "SmartArt" : "개체"
          ctx.warnings.push({ page: ctx.page, code: "UNSUPPORTED_ELEMENT", message: `PPTX ${kind}의 글은 읽지 않습니다 (${ctx.page}쪽)` })
        }
        break
      }
      case "pic": {
        const block = await pictureBlock(el, ctx)
        if (block) out.push(block)
        break
      }
    }
  }
}

/** 발표자 노트 — 노트 슬라이드의 본문 개체 틀 글 */
async function notesText(zip: JSZip, rels: Map<string, Rel>): Promise<string> {
  const rel = [...rels.values()].find(r => r.type.endsWith(REL_NOTES))
  const file = rel ? zip.file(rel.target) : null
  if (!file) return ""
  const tree = findPath(parseXml(await file.async("text")).documentElement, "cSld", "spTree")
  const texts: string[] = []
  for (const sp of tree ? childrenByLocalName(tree, "sp") : []) {
    const txBody = findChildByLocalName(sp, "txBody")
    if (placeholderType(sp) === "body" && txBody) texts.push(...bodyParagraphs(txBody).map(p => p.text))
  }
  return texts.join(" ")
}

// ─── 진입점 ────────────────────────────────────────────

export async function parsePptxDocument(
  buffer: ArrayBuffer,
  options?: ParseOptions,
): Promise<InternalParseResult> {
  // ZIP bomb 사전 검사
  precheckZipSize(buffer, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES, { re: MEDIA_PART_RE, skip: options?.images === false, never: NEVER_READ_RE })

  const zip = await JSZip.loadAsync(buffer)
  if (!zip.file("ppt/presentation.xml")) {
    throw new KordocError("유효하지 않은 PPTX 파일: ppt/presentation.xml이 없습니다")
  }
  const warnings: ParseWarning[] = []
  const blocks: IRBlock[] = []
  const imageNames = new Map<string, string>()
  const images: ExtractedImage[] = []

  const slides = await slideParts(zip)
  // 쪽 범위(-p·pages) — 슬라이드 1장 = 1쪽. 종전엔 범위를 무시하고 모든 슬라이드를 냈다
  const pageFilter = options?.pages ? parsePageRange(options.pages, slides.length) : null
  for (let i = 0; i < slides.length; i++) {
    const page = i + 1
    if (pageFilter && !pageFilter.has(page)) continue
    const root = parseXml(await zip.file(slides[i])!.async("text")).documentElement
    // 숨긴 슬라이드(show="0")는 발표에 나오지 않는다 — 쪽 번호는 유지하고 글만 뺀다
    if (getAttr(root, "show") === "0") {
      warnings.push({ page, code: "HIDDEN_TEXT_FILTERED", message: `PPTX 숨긴 슬라이드 ${page}쪽을 건너뜁니다` })
      continue
    }
    const rels = await readRels(zip, slides[i])
    const tree = findPath(root, "cSld", "spTree")
    if (tree) await walkShapes(tree, { zip, rels, page, warnings, options, imageNames, images }, blocks)
    const notes = await notesText(zip, rels)
    if (notes) blocks.push({ type: "paragraph", text: `발표자 노트: ${notes}`, quote: true, pageNumber: page })
  }

  // 메타데이터 — DOCX 와 같은 docProps/core.xml
  // 슬라이드는 실제 표시 쪽이라 pageMode "layout"
  const metadata: DocumentMetadata = { pageCount: slides.length, pageMode: "layout" }
  const coreFile = zip.file("docProps/core.xml")
  if (coreFile) {
    try {
      const coreDoc = parseXml(await coreFile.async("text"))
      const getFirst = (tag: string) => {
        const els = coreDoc.getElementsByTagName(tag)
        return els.length > 0 ? (els[0].textContent ?? "").trim() || undefined : undefined
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
        message: `PPTX 메타데이터(core.xml) 파싱 실패: ${err instanceof Error ? err.message : String(err)}`,
      })
    }
  }

  const outline = blocks
    .filter(b => b.type === "heading")
    .map(b => ({ level: b.level ?? 2, text: b.text ?? "", pageNumber: b.pageNumber }))

  return {
    markdown: blocksToMarkdown(blocks, { tableFormat: options?.tableFormat }),
    blocks,
    metadata,
    outline: outline.length > 0 ? outline : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    images: images.length > 0 ? images : undefined,
  }
}
