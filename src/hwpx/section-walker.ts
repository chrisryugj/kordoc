/**
 * HWPX 섹션 XML 워커 (parser.ts에서 분리).
 *
 * walkSection ↔ walkParagraphChildren ↔ extractParagraphInfo ↔ handleShape ↔
 * extractDrawTextBlocks가 상호재귀하는 클러스터라 한 파일로 유지한다 —
 * 더 쪼개면 인위적 경계에 순환 import만 생김.
 */

import { KordocError, sanitizeHref, stripDtd } from "../utils.js"
import { MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { IRBlock, IRCell, IRTable, InlineStyle, ParseWarning } from "../types.js"
import { hmlToLatex } from "./equation.js"
import {
  clampSpan,
  createSectionShared,
  createXmlParser,
  extractTextFromNode,
  findChildByLocalName,
  MAX_XML_DEPTH,
  type CellCtxEx,
  type SectionShared,
  type TableState,
  type WalkCtx,
} from "./parser-shared.js"
import type { HwpxStyleMap } from "./styles.js"
import { resolveParaHeading } from "./para-heading.js"
import { completeTable } from "./table-build.js"

// ─── 섹션 XML 파싱 ──────────────────────────────────

export function parseSectionXml(xml: string, styleMap?: HwpxStyleMap, warnings?: ParseWarning[], sectionNum?: number, shared?: SectionShared): IRBlock[] {
  const parser = createXmlParser(warnings)
  const doc = parser.parseFromString(stripDtd(xml), "text/xml")
  if (!doc.documentElement) return []

  const ctx: WalkCtx = { styleMap, warnings, sectionNum, shared: shared ?? createSectionShared() }
  // 변경추적 삭제 구간은 섹션 경계를 넘지 않음 — 비정상 파일에서 본문 전체 소실 방지
  ctx.shared.track.deleteDepth = 0

  // secPr outlineShapeIDRef — 개요 문단의 자동번호 정의 참조
  for (const tagName of ["hp:secPr", "secPr"]) {
    const els = doc.getElementsByTagName(tagName)
    if (els.length > 0) {
      const v = els[0].getAttribute("outlineShapeIDRef")
      if (v) ctx.outlineNumId = v
      break
    }
  }

  const blocks: IRBlock[] = []
  walkSection(doc.documentElement as unknown as Node, blocks, null, [], ctx)
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
        tableCtx = completeTable(newTable, tableStack, blocks, ctx)
        break
      }

      // 표/도표 캡션 — IRTable.caption으로 보존 (v3.0, 기존 무음 드롭 수정)
      case "caption": {
        const capText = collectSubListText(el, ctx)
        if (capText) {
          if (tableCtx) {
            tableCtx.caption = (tableCtx.caption ? tableCtx.caption + "\n" : "") + capText
          } else {
            // 활성 표 컨텍스트 밖의 캡션 — 무음 드롭 대신 문단으로 보존 (#46)
            blocks.push({ type: "paragraph", text: capText, pageNumber: ctx.sectionNum })
          }
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
          if (el.getAttribute("header") === "1" || el.getAttribute("header") === "true") tableCtx.cell.isHeader = true
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
        const { text: rawText, href, footnote, style } = extractParagraphInfo(el, ctx.styleMap, ctx)
        let text = rawText
        let headingLevel: number | undefined
        if (text) {
          // 자동번호/글머리표/개요 접두 재현 (v3.0)
          const ph = resolveParaHeading(el, ctx)
          if (ph?.prefix) text = ph.prefix + " " + text
          headingLevel = ph?.headingLevel
        }
        if (text) {
          if (tableCtx?.cell) {
            const cell = tableCtx.cell
            if (footnote) text += ` (주: ${footnote})`
            cell.text += (cell.text ? "\n" : "") + text
            ;(cell.blocks ??= []).push({ type: "paragraph", text, pageNumber: ctx.sectionNum })
          } else if (!tableCtx) {
            const block: IRBlock = { type: headingLevel ? "heading" : "paragraph", text, pageNumber: ctx.sectionNum }
            if (headingLevel) block.level = headingLevel
            if (style) block.style = style
            if (href) block.href = href
            if (footnote) block.footnoteText = footnote
            blocks.push(block)
          } else {
            // 표 내부지만 셀 밖(비정상 경로) — 무음 드롭 대신 본문 문단으로 보존
            blocks.push({ type: "paragraph", text, pageNumber: ctx.sectionNum })
          }
        }
        // <p> 내부의 <tbl>만 별도 처리 — extractParagraphInfo가 이미 텍스트를 추출했으므로
        // 전체 walkSection 재귀 대신 테이블/이미지 자식만 선택적으로 처리
        tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1)
        break
      }

      // 이미지/그림/글상자 — 이미지·텍스트·캡션 병행 추출
      case "pic": case "shape": case "drawingObject": {
        if (tableCtx?.cell) {
          const sink: IRBlock[] = []
          handleShape(el, sink, ctx)
          mergeBlocksIntoCell(tableCtx.cell, sink)
        } else {
          handleShape(el, blocks, ctx)
        }
        break
      }

      // 메모 — 본문 혼입 차단 (v3.0)
      case "memogroup": case "memo": {
        if (ctx.warnings && extractTextFromNode(el)) {
          ctx.warnings.push({ page: ctx.sectionNum, message: "메모 텍스트 본문 제외: memogroup", code: "HIDDEN_TEXT_FILTERED" })
        }
        break
      }

      default:
        walkSection(el, blocks, tableCtx, tableStack, ctx, depth + 1)
        break
    }
  }
}

/**
 * 도형/그림 공통 처리 — 글상자 텍스트와 이미지를 병행 추출하고(기존 상호배타 수정),
 * 도형 캡션은 문단으로 보존한다. 둘 다 없으면 SKIPPED_IMAGE 경고.
 */
function handleShape(el: Element, sink: IRBlock[], ctx: WalkCtx): void {
  const imgRef = extractImageRef(el)
  const drawTextChild = findDescendant(el, "drawText")

  if (imgRef) {
    const block: IRBlock = { type: "image", text: imgRef, pageNumber: ctx.sectionNum }
    // 사용자 입력 그림 설명(alt) — builder가 image alt 출력을 지원할 때까지 IR에 보존,
    // 이미지 추출 실패 시 대체 문단의 각주로 표시된다
    const alt = userShapeComment(el)
    if (alt) block.footnoteText = alt
    sink.push(block)
  }
  if (drawTextChild) {
    extractDrawTextBlocks(drawTextChild, sink, ctx)
  }
  // 도형 캡션 (그림 캡션 등) — 이미지 아래 문단으로 보존
  const capEl = findChildByLocalName(el, "caption")
  if (capEl) {
    const capText = collectSubListText(capEl, ctx)
    if (capText) sink.push({ type: "paragraph", text: capText, pageNumber: ctx.sectionNum })
  }

  if (!imgRef && !drawTextChild && ctx.warnings && ctx.sectionNum) {
    const localTag = (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
    ctx.warnings.push({ page: ctx.sectionNum, message: `스킵된 요소: ${localTag}`, code: "SKIPPED_IMAGE" })
  }
}

/** 도형의 사용자 입력 그림 설명 — 한컴 자동생성 대체텍스트("그림입니다." 등)는 제외 */
function userShapeComment(el: Element): string | undefined {
  const commentEl = findChildByLocalName(el, "shapeComment")
  if (!commentEl) return undefined
  const text = extractTextFromNode(commentEl)
  if (!text) return undefined
  if (/^그림입니다/.test(text)) return undefined
  if (/^(?:모서리가 둥근 |둥근 )?[^\n]{1,20}입니다\.?$/.test(text)) return undefined
  return text
}

/** 도형/중첩 콘텐츠 블록을 셀에 병합 — 텍스트는 cell.text에, 구조는 cell.blocks에 보존 */
function mergeBlocksIntoCell(cell: CellCtxEx, sink: IRBlock[]): void {
  for (const b of sink) {
    if ((b.type === "paragraph" || b.type === "heading") && b.text) {
      cell.text += (cell.text ? "\n" : "") + b.text
      ;(cell.blocks ??= []).push(b)
    } else if (b.type === "image" || b.type === "table") {
      if (b.type === "image" && b.text) {
        // GFM 표 경로는 cell.text만 출력하므로 인라인 이미지 참조를 남긴다
        // (extractImagesFromZip이 추출 후 실제 파일명으로 치환)
        cell.text += (cell.text ? "\n" : "") + `![image](${b.text})`
      }
      ;(cell.blocks ??= []).push(b)
      cell.hasStructure = true
    }
  }
}

/** caption/header/footer 등의 subList 내부 문단 텍스트 수집 */
function collectSubListText(el: Node, ctx: WalkCtx, depth = 0): string {
  if (depth > 10) return ""
  const parts: string[] = []
  const children = el.childNodes
  if (!children) return ""
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "p" || tag === "para") {
      const t = extractParagraphInfo(ch, ctx.styleMap, ctx).text
      if (t) parts.push(t)
    } else if (tag === "tbl") {
      continue // 캡션/머리말 내 표는 미지원 — 텍스트만 수집
    } else {
      const t = collectSubListText(ch, ctx, depth + 1)
      if (t) parts.push(t)
    }
  }
  return parts.join("\n").trim()
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
  const walkChildren = (parent: Node, d: number, inShape = false) => {
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
        tableCtx = completeTable(newTable, tableStack, blocks, ctx)
      } else if (localTag === "caption" && !inShape) {
        // ctrl 래핑 표 캡션 — 도형(rect 등) 자체 캡션은 기존 텍스트 추출 경로에 맡긴다.
        // 셀 안이면 표 caption이 아니라 개체 캡션이므로 셀 텍스트로 귀속 (오귀속 방지)
        const capText = collectSubListText(el, ctx)
        if (capText) {
          if (tableCtx?.cell) mergeBlocksIntoCell(tableCtx.cell, [{ type: "paragraph", text: capText, pageNumber: ctx.sectionNum }])
          else if (tableCtx) tableCtx.caption = (tableCtx.caption ? tableCtx.caption + "\n" : "") + capText
          else blocks.push({ type: "paragraph", text: capText, pageNumber: ctx.sectionNum })
        }
      } else if (localTag === "pic" || localTag === "shape" || localTag === "drawingObject") {
        // 글상자 텍스트 + 이미지 병행 추출 — 셀 안이면 위치 보존을 위해 IRCell.blocks로
        if (tableCtx?.cell) {
          const sink: IRBlock[] = []
          handleShape(el, sink, ctx)
          mergeBlocksIntoCell(tableCtx.cell, sink)
        } else {
          handleShape(el, blocks, ctx)
        }
      } else if (localTag === "drawText") {
        // 글상자(TextBox) 안 텍스트 추출 — <hp:p> 순회
        if (tableCtx?.cell) {
          const sink: IRBlock[] = []
          extractDrawTextBlocks(el, sink, ctx)
          mergeBlocksIntoCell(tableCtx.cell, sink)
        } else {
          extractDrawTextBlocks(el, blocks, ctx)
        }
      } else if (localTag === "r" || localTag === "run" || localTag === "ctrl") {
        // <hp:run>, <hp:ctrl> 내부에 테이블/캡션이 포함될 수 있음 — 재귀
        walkChildren(el, d + 1, inShape)
      } else if (localTag === "rect" || localTag === "ellipse" || localTag === "polygon"
        || localTag === "line" || localTag === "arc" || localTag === "curve"
        || localTag === "connectLine" || localTag === "container") {
        // 도형 요소 내부에 테이블/이미지/글상자가 포함될 수 있음 — 재귀 (도형 자체 캡션은 제외)
        walkChildren(el, d + 1, true)
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
function extractDrawTextBlocks(drawTextNode: Node, blocks: IRBlock[], ctx: WalkCtx): void {
  const children = drawTextNode.childNodes
  if (!children) return
  for (let i = 0; i < children.length; i++) {
    const child = children[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "subList" || tag === "p" || tag === "para") {
      // subList 안의 <p>들을 순회
      if (tag === "subList") {
        extractDrawTextBlocks(child, blocks, ctx)
      } else {
        const info = extractParagraphInfo(child, ctx.styleMap, ctx)
        let text = info.text.trim()
        if (text) {
          const ph = resolveParaHeading(child, ctx)
          if (ph?.prefix) text = ph.prefix + " " + text
          const block: IRBlock = { type: "paragraph", text, style: info.style ?? undefined, pageNumber: ctx.sectionNum }
          if (info.href) block.href = info.href
          if (info.footnote) block.footnoteText = info.footnote
          blocks.push(block)
        }
        // 글상자 안 문단에 포함된 표/도형도 재귀 처리 — 조직도용 "글상자 안 표" 보존
        // (실증: 국방부 TF 5×7 조직표가 rect>drawText>p>tbl 구조로 통째 소실되던 케이스)
        walkParagraphChildren(child, blocks, null, [], ctx)
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

/** fieldBegin이 HYPERLINK면 stringParam name="Path"에서 URL 추출 (살균 포함) */
function extractHyperlinkHref(fieldBegin: Element): string | undefined {
  if ((fieldBegin.getAttribute("type") || "").toUpperCase() !== "HYPERLINK") return undefined
  const params = findChildByLocalName(fieldBegin, "parameters")
  if (!params) return undefined
  const children = params.childNodes
  if (!children) return undefined
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag !== "stringParam" || ch.getAttribute("name") !== "Path") continue
    let url = (ch.textContent || "").trim()
    if (!url) continue
    // 한컴이 중복 스킴을 저장하는 경우 정리 ("http://https://..." → "https://...")
    url = url.replace(/^https?:\/\/(?=https?:\/\/)/i, "")
    const safe = sanitizeHref(url)
    if (safe) return safe
  }
  return undefined
}

/** 변경추적 삭제 구간 내부 여부 */
function isInDeletedRange(ctx?: WalkCtx): boolean {
  return (ctx?.shared.track.deleteDepth ?? 0) > 0
}

function extractParagraphInfo(para: Element, styleMap?: HwpxStyleMap, ctx?: WalkCtx): ParagraphInfo {
  let text = ""
  let href: string | undefined
  let footnote: string | undefined
  let charPrId: string | undefined

  // 문단의 스타일 참조 → charPr로 간접 조회
  // HWPX <p>에는 paraPrIDRef/styleIDRef가 있고, charPrIDRef는 <r> 요소에 있음
  // 여기서는 일단 null — <r> 요소에서 charPrIDRef를 가져옴

  /** <hp:ctrl> 자식 선별 순회 — 머리말/꼬리말/각주/미주/하이퍼링크/변경추적 (v3.0) */
  const handleCtrl = (ctrlEl: Element) => {
    const kids = ctrlEl.childNodes
    if (!kids) return
    for (let j = 0; j < kids.length; j++) {
      const k = kids[j] as Element
      if (k.nodeType !== 1) continue
      const ktag = (k.tagName || k.localName || "").replace(/^[^:]+:/, "")
      switch (ktag) {
        // 머리말/꼬리말 — 문서당 1회 수집, 본문 앞/뒤 배치
        case "header": case "footer": {
          if (!ctx) break
          const t = collectSubListText(k, ctx)
          if (t) {
            const bucket = ktag === "header" ? ctx.shared.pageText.headers : ctx.shared.pageText.footers
            if (!bucket.includes(t)) bucket.push(t)
          }
          break
        }

        // 각주/미주 — 해당 문단의 footnote로 인라인 보존
        case "footNote": case "endNote": {
          const noteText = extractTextFromNode(k)
          if (noteText) footnote = (footnote ? footnote + "; " : "") + noteText
          break
        }

        // 하이퍼링크 — fieldBegin type=HYPERLINK의 Path 파라미터
        case "fieldBegin": {
          const url = extractHyperlinkHref(k)
          if (url && !href) href = url
          break
        }
        case "fieldEnd": break

        // 변경추적 — 삭제 구간(deleteBegin~End)의 텍스트는 출력 제외 (최종본 상태 재현)
        case "deleteBegin":
          if (ctx) ctx.shared.track.deleteDepth++
          break
        case "deleteEnd":
          if (ctx && ctx.shared.track.deleteDepth > 0) ctx.shared.track.deleteDepth--
          break
        case "insertBegin": case "insertEnd": break  // 삽입분은 최종본에 포함

        // 숨은 설명 — 본문 혼입 차단
        case "hiddenComment": {
          if (ctx?.warnings && extractTextFromNode(k)) {
            ctx.warnings.push({ page: ctx.sectionNum, message: "숨은 설명 텍스트 제외: hiddenComment", code: "HIDDEN_TEXT_FILTERED" })
          }
          break
        }

        // 콘텐츠 없는 제어 요소 — 스킵
        case "bookmark": case "pageNum": case "pageNumCtrl": case "pageHiding":
        case "newNum": case "autoNum": case "indexmark": case "colPr":
          break

        // 캡션 — walkParagraphChildren의 caption 분기가 보존하므로 손실 경고 대상 아님
        case "caption":
          break

        // 미지원 요소 — 텍스트를 가졌으면 무음 손실 대신 경고
        default: {
          if (ctx?.warnings && extractTextFromNode(k)) {
            ctx.warnings.push({ page: ctx.sectionNum, message: `미지원 제어 요소의 텍스트 손실: ${ktag}`, code: "UNSUPPORTED_ELEMENT" })
          }
        }
      }
    }
  }

  const walk = (node: Node) => {
    const children = node.childNodes
    if (!children) return
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as Element
      if (child.nodeType === 3) {
        const t = child.textContent || ""
        if (isInDeletedRange(ctx)) {
          if (t && ctx && !ctx.shared.track.warned) {
            ctx.shared.track.warned = true
            ctx.warnings?.push({ page: ctx.sectionNum, message: "변경추적 삭제 텍스트 출력 제외", code: "HIDDEN_TEXT_FILTERED" })
          }
        } else {
          text += t
        }
        continue
      }
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
        case "lineBreak": text += "\n"; break // 강제 줄바꿈 — ref 추출기·소스맵 스캐너와 동일 모델
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

        // 제어 요소 — 선별 순회 (머리말/꼬리말/각주/하이퍼링크/변경추적, v3.0)
        case "ctrl": handleCtrl(child); break

        // run 직계 fieldBegin (비표준 경로) — 하이퍼링크 URL만 추출
        case "fieldBegin": {
          const url = extractHyperlinkHref(child)
          if (url && !href) href = url
          break
        }

        // run 직계 변경추적 마커 (비표준 경로)
        case "deleteBegin": if (ctx) ctx.shared.track.deleteDepth++; break
        case "deleteEnd": if (ctx && ctx.shared.track.deleteDepth > 0) ctx.shared.track.deleteDepth--; break
        case "insertBegin": case "insertEnd": break

        case "fieldEnd":
        case "parameters": case "stringParam": case "integerParam":
        case "boolParam": case "floatParam":
        case "secPr":  // 섹션 속성 (페이지 설정 등)
        case "colPr":  // 다단 속성
        case "linesegarray": case "lineseg":  // 레이아웃 정보
        // 도형/이미지 요소 — 대체텍스트("사각형입니다." 등) 누출 방지 (walkParagraphChildren에서 처리)
        case "pic": case "shape": case "drawingObject":
        case "shapeComment": case "drawText":
          break

        // 수식: <hp:equation> 내부의 <hp:script> 에 HULK-style equation
        // 스크립트가 담겨 있음. hml-equation-parser 로 LaTeX 변환 후 `$...$`
        // 로 래핑. 실패/빈 스크립트면 무시 (대체 텍스트 누출 방지).
        case "equation": {
          const script = findChildByLocalName(child, "script")
          const raw = script ? extractTextFromNode(script) : ""
          if (raw.trim()) {
            try {
              const latex = hmlToLatex(raw).trim()
              if (latex) text += " $" + latex + "$ "
            } catch {
              // 변환 실패 시 조용히 드롭 — 텍스트 품질이 우선
            }
          }
          break
        }

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
  // NOTE: "수식" 은 제거 목록에서 빠져있음 — <hp:equation> 파싱으로 LaTeX 본문이 이미
  // `$...$` 형태로 삽입되기 때문에 여기서 지울 alt-text 는 존재하지 않는다.
  cleanText = cleanText.replace(/(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|선|직선|곡선|화살표|오각형|육각형|팔각형|별|십자|구름|마름모|도넛|평행사변형|사다리꼴|개체|그리기\s?개체|묶음\s?개체|글상자|표|그림|OLE\s?개체)\s?입니다\.?/g, "").trim()

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
