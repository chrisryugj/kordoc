/**
 * HWPX 섹션 XML 워커 (parser.ts에서 분리).
 *
 * walkSection ↔ walkParagraphChildren ↔ extractParagraphInfo ↔ handleShape ↔
 * extractDrawTextBlocks가 상호재귀하는 클러스터라 한 파일로 유지한다 —
 * 더 쪼개면 인위적 경계에 순환 import만 생김.
 */

import { KordocError, sanitizeHref, stripDtd } from "../utils.js"
import { convertTableToText, MAX_COLS, MAX_ROWS } from "../table/builder.js"
import type { IRBlock, IRCell, IRSpan, IRTable, InlineStyle, ParseWarning } from "../types.js"
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

/** pic/shape 요소에서 이미지 참조 경로 추출 (binaryItemIDRef 또는 href) — MAX_XML_DEPTH 가드 */
function extractImageRef(el: Element, depth: number = 0): string | null {
  if (depth > MAX_XML_DEPTH) return null
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
    const nested = extractImageRef(child, depth + 1)
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
        // kordoc 왕복 채널 (v4.0.5 P2) — 생성기가 heading 의미를 장식표(개조식 표지·
        // 장헤더·1페이지형 제목박스)에 인코딩할 때 제목 셀 name 속성에 심은 마커.
        // 마커가 있으면 표 대신 heading으로 복원(h#), 파생물(목차·제목반복)은 스킵해
        // 재파싱 중복을 막는다. 최상위 표에서만 판독 — 셀 안 중첩표는 일반 표 취급.
        if (!tableCtx) {
          const chan = kordocTableChannel(el, ctx)
          if (chan) {
            if (chan.kind === "heading" && chan.text) {
              blocks.push({ type: "heading", level: chan.level, text: chan.text, pageNumber: ctx.sectionNum })
            }
            break
          }
        }
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
        const { text: rawText, href, footnote, style, segments } = extractParagraphInfo(el, ctx.styleMap, ctx)
        let text = rawText
        let headingLevel: number | undefined
        // 자동번호/글머리표/개요 접두 재현 (v3.0). 텍스트 유무와 무관하게 호출 —
        // 한글은 빈 번호 문단도 번호를 소비하므로, 텍스트 있을 때만 advance하면
        // 빈 문단 이후 항목 전부가 1씩 낮게 재현된다 (v4.0.5 카운터 드리프트)
        const ph = resolveParaHeading(el, ctx)
        if (text) {
          if (ph?.prefix) text = ph.prefix + " " + text
          headingLevel = ph?.headingLevel
        }
        // 인라인 표 포함 문단 (#49/#50) — 문단 텍스트를 통째로 먼저 push하면 원문에서
        // 표가 앞설 때 순서가 역전된다. 표 경계 조각을 walkParagraphChildren의 onTbl
        // 콜백으로 표 직전마다 방출해 문서 순서를 보존한다 (treatAsChar inline 표 배치).
        if (segments) {
          const cell = tableCtx?.cell ?? null
          const segs = [...segments]
          if (ph?.prefix) {
            const fi = segs.findIndex(s => s)
            if (fi >= 0) segs[fi] = ph.prefix + " " + segs[fi]
          }
          let segIdx = 0
          let first = true
          const flush = () => {
            const s = segs[segIdx++]
            if (!s) return
            const block: IRBlock = { type: "paragraph", text: s, pageNumber: ctx.sectionNum }
            if (first && !cell) {
              first = false
              if (style) block.style = style
              if (href) block.href = href
              if (footnote) block.footnoteText = footnote
            }
            if (cell) {
              // IRCell.text 평탄화는 blocks 순서를 따라야 한다 (#52, 타입 계약). 종전엔
              // 문단 텍스트를 통째로 선append해 중첩표 평탄화(completeTable)보다 앞서
              // 역전됐다 — 세그먼트를 표와 교대로 나온 자리에서 이어붙여 문서 순서 보존.
              cell.text += (cell.text ? "\n" : "") + s
              ;(cell.blocks ??= []).push(block)
            } else blocks.push(block)
          }
          tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1, flush)
          while (segIdx < segs.length) flush()
          // 셀 각주(주석) — 세그먼트 평탄화 뒤 종전과 동일하게 보존 (희소 경로)
          if (footnote && cell) cell.text += (cell.text ? "\n" : "") + `(주: ${footnote})`
          break
        }
        if (text) {
          if (tableCtx?.cell) {
            const cell = tableCtx.cell
            if (footnote) text += ` (주: ${footnote})`
            cell.text += (cell.text ? "\n" : "") + text
            const cellBlock: IRBlock = { type: "paragraph", text, pageNumber: ctx.sectionNum }
            // 왕복 채널 — 셀 문단도 인라인 강조 span 복원 (v4.0.4: 최상위 한정 확장,
            // v4.0.5: gongmun·외래 확장). GFM 셀 방출이 마커를 재방출하고 generateRuns가
            // 되읽는다. 자사 default 외에는 혼합 가드 — 전체 볼드 셀은 헤더행·라벨열의
            // 구조 서식이 지배적이라 마커를 억제한다
            const cellSpanMode = spanModeOf(ctx.shared.kordocLayout)
            if (cellSpanMode && !ph?.prefix) {
              const spans = extractRunSpans(el, ctx, cellSpanMode, cellSpanMode !== "kordoc")
              if (spans && spans.map(s => s.text).join("").replace(/[ \t]+/g, " ").trim() === text) {
                cellBlock.spans = spans
              }
            }
            ;(cell.blocks ??= []).push(cellBlock)
          } else if (!tableCtx) {
            // 구분선 문단('─' 연속 — kordoc 생성기의 hr 렌더) → separator 복원.
            // 재파싱 시 장식 대시가 본문 텍스트로 남던 왕복 비대칭 수정 (v4.0.5 P2).
            // kordocLayout 채널 있는 자사 생성 문서 한정 — 외래 문서의 실제 '─' 장식
            // 문단이 separator로 둔갑하는 것 방지
            if (ctx.shared.kordocLayout && /^─{10,}$/.test(text)) {
              blocks.push({ type: "separator", pageNumber: ctx.sectionNum })
              // p 내부 구조 자식 처리 경로 유지를 위해 아래 공통 처리로 진행
              tableCtx = walkParagraphChildren(el, blocks, tableCtx, tableStack, ctx, depth + 1)
              break
            }
            const block: IRBlock = { type: headingLevel ? "heading" : "paragraph", text, pageNumber: ctx.sectionNum }
            if (headingLevel) block.level = headingLevel
            if (style) block.style = style
            if (href) block.href = href
            if (footnote) block.footnoteText = footnote
            // 들여쓰기 관찰 슬롯 (v4.0.4) — paraPr hc:left + 양수 hc:intent(첫줄).
            // 마크다운 방출엔 불참 — gongmun 리스트 depth 재유도 등 소비자 몫
            const ind = ctx.styleMap?.paraIndents.get(el.getAttribute("paraPrIDRef") ?? "")
            if (ind) {
              const eff = ind.left + Math.max(0, ind.intent)
              if (eff > 0) block.indent = eff
            }
            // indent 소비 (v4.0.5) — 자사 gongmun 파일의 md 리스트 충돌 부호('- '·'1) ')는
            // 재생성 시 md 파서가 list_item으로 선점해 리터럴 부호 재분류(gen-gongmun-fit)가
            // 못 받고 depth0으로 붕괴한다. paraPr 들여쓰기를 run 글자크기(=levelIndent
            // 단위)로 역산해 blocksToMarkdown이 2칸/단계 선행 공백을 방출하게 한다
            if (ctx.shared.kordocLayout === "gongmun" && block.indent && /^(?:-|\d{1,3}\)) /.test(text)) {
              const depth = gongmunDepthFromIndent(el, block.indent, ctx)
              if (depth) block.listDepth = depth
            }
            // 왕복 채널(자사 생성 파일 + 외래 실속성) — 인라인 강조 span·인용 복원
            const spanMode = spanModeOf(ctx.shared.kordocLayout)
            if (!headingLevel && spanMode) {
              if (!ph?.prefix) {
                const spans = extractRunSpans(el, ctx, spanMode, spanMode === "gongmun")
                // 무결성 가드: span 연결이 블록 텍스트와 일치할 때만 (cleanText 변형과
                // 어긋난 문단은 평문 유지 — 마커가 본문을 오염시키지 않게)
                if (spans && spans.map(s => s.text).join("").replace(/[ \t]+/g, " ").trim() === text) {
                  block.spans = spans
                }
              }
              // 인용 paraPr 규약은 자사 파일 한정(외래는 무규약) — gongmun도 기본
              // 0~7 paraPr 블록을 공유하므로 6번=인용 유효 (실측 프리셋 인용은 ※ 문단으로
              // 방출돼 여기 안 옴 — 글리프 재분류가 왕복 담당)
              if (spanMode !== "foreign" && el.getAttribute("paraPrIDRef") === KORDOC_PARA_QUOTE) block.quote = true
            }
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

/** kordoc 왕복 채널 판독 결과 — heading 복원 또는 파생물 스킵 */
interface KordocTableChannel {
  kind: "heading" | "skip"
  level?: number
  text?: string
}

/**
 * kordoc 생성기의 장식표 왕복 마커 판독 (v4.0.5 P2).
 * 제목 셀 `name="__kordoc_h1~6"` → heading 복원, `__kordoc_toc`/`__kordoc_skip` →
 * 파생물(목차·표지 제목 반복)이므로 통째 스킵. 마커 없으면 null(일반 표).
 */
function kordocTableChannel(tblEl: Element, ctx: WalkCtx): KordocTableChannel | null {
  const found = findKordocMarkedCell(tblEl, 0)
  if (!found) return null
  const m = found.name.match(/^__kordoc_(?:h([1-6])|(toc|skip))$/)
  if (!m) return null
  if (m[2]) return { kind: "skip" }
  const text = collectSubListText(found.cell, ctx).trim()
  return { kind: "heading", level: Number(m[1]), text }
}

/** tbl 하위에서 __kordoc_ 마커 셀 탐색 (중첩표 안까지는 내려가지 않음) */
function findKordocMarkedCell(el: Node, depth: number): { cell: Element; name: string } | null {
  if (depth > 6) return null
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "tc") {
      const name = ch.getAttribute("name") || ""
      if (name.startsWith("__kordoc_")) return { cell: ch, name }
      continue // 셀 내부(중첩표)는 탐색하지 않음 — 최상위 표의 셀만
    }
    if (tag === "tbl" && depth > 0) continue // 중첩표 진입 금지
    const found = findKordocMarkedCell(ch, depth + 1)
    if (found) return found
  }
  return null
}

/** 머리말/꼬리말 subList에 페이지 번호 autoNum(numType=PAGE)이 있는지 검사 */
function hasPageAutoNum(el: Node, depth = 0): boolean {
  if (depth > 10) return false
  const children = el.childNodes
  if (!children) return false
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "autoNum" && ch.getAttribute?.("numType") === "PAGE") return true
    if (hasPageAutoNum(ch, depth + 1)) return true
  }
  return false
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
      // 문단 run 안의 중첩표 (hp:p > hp:run > hp:tbl — HWPX 표준 배치)
      const tbls: Element[] = []
      findTopLevelTbls(ch, tbls)
      for (const tbl of tbls) {
        const flat = flattenSubListTable(tbl, ctx, depth)
        if (flat) parts.push(flat)
      }
    } else if (tag === "tbl") {
      const flat = flattenSubListTable(ch, ctx, depth)
      if (flat) parts.push(flat)
    } else {
      const t = collectSubListText(ch, ctx, depth + 1)
      if (t) parts.push(t)
    }
  }
  return parts.join("\n").trim()
}

/**
 * 캡션/머리말 내 중첩표 평탄화 — 셀 텍스트를 표 평탄화 규칙(" / " 구분·행별
 * 줄바꿈)으로 순서 보존 이어붙임. 스킵하면 캡션 표 내용이 통째로 무음 유실됨 (#46)
 */
function flattenSubListTable(el: Element, ctx: WalkCtx, depth: number): string {
  const sink: IRBlock[] = []
  const st: TableState = { rows: [], currentRow: [], cell: null }
  walkSection(el, sink, st, [], ctx, depth + 1)
  let flat = convertTableToText(st.rows)
  if (st.caption) flat = st.caption + (flat ? "\n" + flat : "")
  return flat
}

/** 노드 하위의 최상위 tbl 수집 — tbl 내부 미진입 (셀 안 중첩표는 표 워커가 처리) */
function findTopLevelTbls(el: Node, out: Element[], depth = 0): void {
  if (depth > MAX_XML_DEPTH) return
  const kids = el.childNodes
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const ch = kids[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "tbl") { out.push(ch); continue }
    findTopLevelTbls(ch, out, depth + 1)
  }
}

/**
 * <p> 내부에서 텍스트가 아닌 구조적 자식만 처리 (tbl, pic, shape). tableCtx 반환으로 상태 전파.
 * onTbl: 각 표 처리 직전 호출 — 호출자가 표 앞 텍스트 조각을 먼저 방출해
 * 문서 순서를 보존한다 (#49/#50, extractParagraphInfo의 \x1E 마커와 1:1 대응)
 */
function walkParagraphChildren(
  node: Node, blocks: IRBlock[],
  tableCtx: TableState | null, tableStack: TableState[],
  ctx: WalkCtx, depth: number = 0, onTbl?: () => void
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
        // 표 앞 텍스트 조각 선방출 — 문서 순서 보존 (#49/#50/#53). inline·float 표
        // 모두 직전에 방출한다: float 표는 흐름 불참이지만 자기보다 앞선 텍스트를
        // 추월하면 안 된다 (#53 — 같은 문단에 inline 표가 있을 때, 텍스트 조각이 다음
        // inline 표 직전까지 미뤄져 그 사이 float 표가 텍스트를 건너뛰던 역전 수정).
        // flush는 세그먼트 소진(빈/undefined)에 안전한 no-op이라 float가 여럿이어도 무해.
        if (onTbl) onTbl()
        // kordoc 왕복 채널 (v4.0.5 P2) — walkSection tbl 케이스와 동일 판독.
        // 최상위(셀 밖) 표에서만: heading 복원 또는 파생물(목차·제목반복) 스킵
        if (!tableCtx) {
          const chan = kordocTableChannel(el, ctx)
          if (chan) {
            if (chan.kind === "heading" && chan.text) {
              blocks.push({ type: "heading", level: chan.level, text: chan.text, pageNumber: ctx.sectionNum })
            }
            continue
          }
        }
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

/**
 * 글자취급(treatAsChar) 인라인 표 여부 — <hp:pos treatAsChar="1"> (#49/#50).
 * inline 표만 같은 줄 텍스트와 문서 순서로 읽는다 (reflow 개체 흐름 모델과 동일 구분)
 */
function isInlineTbl(tbl: Element): boolean {
  return findChildByLocalName(tbl, "pos")?.getAttribute("treatAsChar") === "1"
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
        // 텍스트 유무와 무관하게 호출 — 본문 경로와 동일. 빈 번호 문단도 카운터를
        // 소비하므로 텍스트 있을 때만 호출하면 이후 항목 번호가 낮게 재현된다
        const ph = resolveParaHeading(child, ctx)
        if (text) {
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
  /**
   * 인라인 표 경계로 분할된 텍스트 조각 (#49/#50) — 문단 안에 표가 있을 때만 존재.
   * segments[i]는 i번째 표 앞의 텍스트, 마지막 조각은 마지막 표 뒤의 텍스트.
   * text는 기존과 동일한 전체 평탄화본 (하위 호환).
   */
  segments?: string[]
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

  // 하이퍼링크 필드 범위 — fieldBegin/fieldEnd의 텍스트 오프셋을 추적해 필드 extent만
  // 인라인 [anchor](url)로 방출 (HWP5 fieldRanges와 동일 모델). extent를 못 닫으면
  // (문단 경계 걸침 등) 기존 문단 전체 href로 폴백.
  const linkRanges: Array<{ url: string; start: number; end?: number }> = []
  const openFields: Array<{ rangeIdx?: number }> = []
  const onFieldBegin = (el: Element) => {
    const url = extractHyperlinkHref(el)
    if (url) {
      linkRanges.push({ url, start: text.length })
      openFields.push({ rangeIdx: linkRanges.length - 1 })
      if (!href) href = url
    } else {
      openFields.push({})
    }
  }
  const onFieldEnd = () => {
    const open = openFields.pop()
    if (open?.rangeIdx !== undefined) linkRanges[open.rangeIdx].end = text.length
  }

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
        // 페이지 번호 크롬(autoNum PAGE + 문자 없는 잔여 텍스트, 예: "- 1 -")은 본문 정보가
        // 아니므로 방출하지 않는다
        case "header": case "footer": {
          if (!ctx) break
          const t = collectSubListText(k, ctx)
          if (t && hasPageAutoNum(k) && !/\p{L}/u.test(t)) break
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

        // 하이퍼링크 — fieldBegin type=HYPERLINK의 Path 파라미터 (extent 오프셋 추적)
        case "fieldBegin": onFieldBegin(k); break
        case "fieldEnd": onFieldEnd(); break

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

  const walk = (node: Node, depth: number = 0) => {
    if (depth > MAX_XML_DEPTH) return
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
          // \x1E는 인라인 표 경계 마커로 예약 — 원문 혼입 방지 (#49/#50)
          text += t.replace(/\x1E/g, "")
        }
        continue
      }
      if (child.nodeType !== 1) continue

      const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
      switch (tag) {
        case "t": walk(child, depth + 1); break  // 자식 순회 (tab 등 하위 요소 처리)
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
        // 테이블 자체는 walkSection에서 처리 — 글자취급(inline) 표만 경계 마커를 남겨
        // 표 앞뒤 텍스트를 문서 순서대로 분할 방출할 수 있게 한다 (#49/#50).
        // float·페이지 앵커 표는 텍스트 흐름 불참(reflow 모델 정합) — 종전대로 텍스트 뒤 방출
        case "tbl":
          if (isInlineTbl(child)) text += "\x1E"
          break

        // 하이퍼링크
        case "hyperlink": {
          const url = child.getAttribute("url") || child.getAttribute("href") || ""
          if (url) {
            // XSS 방지: 추출 시점에서 href 살균
            const safe = sanitizeHref(url)
            if (safe) href = safe
          }
          // 하이퍼링크 내 텍스트 추출
          walk(child, depth + 1)
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

        // run 직계 fieldBegin (비표준 경로) — 하이퍼링크 URL·extent 추적
        case "fieldBegin": onFieldBegin(child); break

        // run 직계 변경추적 마커 (비표준 경로)
        case "deleteBegin": if (ctx) ctx.shared.track.deleteDepth++; break
        case "deleteEnd": if (ctx && ctx.shared.track.deleteDepth > 0) ctx.shared.track.deleteDepth--; break
        case "insertBegin": case "insertEnd": break

        case "fieldEnd": onFieldEnd(); break
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
          walk(child, depth + 1)
          break
        }

        default: walk(child, depth + 1); break
      }
    }
  }
  walk(para)

  // 하이퍼링크 extent 인라인 적용 — 시작 내림차순 치환(HWP5와 동일), 겹침 금지.
  // anchor가 줄바꿈·리더마커·대괄호를 품으면 문법이 깨지므로 그 필드는 건너뛴다.
  {
    const applied: Array<[number, number]> = []
    const closed = linkRanges
      .filter(r => r.end !== undefined && r.end > r.start)
      .sort((a, b) => b.start - a.start)
    for (const r of closed) {
      if (applied.some(([s, e]) => r.start < e && r.end! > s)) continue
      const anchor = text.slice(r.start, r.end!)
      if (!anchor.trim() || /[\n\x1F\x1E\[\]]/.test(anchor)) continue
      text = text.slice(0, r.start) + `[${anchor}](${r.url})` + text.slice(r.end!)
      applied.push([r.start, r.end!])
    }
    if (applied.length) href = undefined // 문단 전체 href 중복 방지
  }

  // 목차 리더 마커(\x1F) 이후 텍스트(페이지번호) 제거
  const leaderIdx = text.indexOf("\x1F")
  if (leaderIdx >= 0) text = text.substring(0, leaderIdx)

  const cleanParaText = (raw: string): string => {
    let t = raw.replace(/[ \t]+/g, " ").trim()
    // 한글 이미지 OLE 대체 텍스트 필터링 ("그림입니다. 원본 그림의 이름: ...")
    if (/^그림입니다\.?\s*원본\s*그림의\s*(이름|크기)/.test(t)) t = ""
    // 멀티라인으로 삽입된 OLE 대체 텍스트도 제거
    t = t.replace(/그림입니다\.?\s*원본\s*그림의\s*(이름|크기)[^\n]*(\n[^\n]*원본\s*그림의\s*(이름|크기)[^\n]*)*/g, "").trim()
    // HWP 도형/개체 대체텍스트 제거 ("사각형입니다.", "개체 입니다." 등)
    // 행 전체 일치(^…$m)로 한정 — 무앵커면 "붙임 문서는 표 입니다." 같은 본문 중간을 오삭제한다.
    // NOTE: "수식" 은 제거 목록에서 빠져있음 — <hp:equation> 파싱으로 LaTeX 본문이 이미
    // `$...$` 형태로 삽입되기 때문에 여기서 지울 alt-text 는 존재하지 않는다.
    return t.replace(/^(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|선|직선|곡선|화살표|오각형|육각형|팔각형|별|십자|구름|마름모|도넛|평행사변형|사다리꼴|개체|그리기\s?개체|묶음\s?개체|글상자|표|그림|OLE\s?개체)\s?입니다\.?$/gm, "").trim()
  }

  // 인라인 표 경계(\x1E)로 분할 — 표 전후 텍스트를 문서 순서대로 방출 (#49/#50).
  // text는 마커 제거 후 기존과 동일 파이프라인 (표 없는 문단은 바이트 동일)
  let segments: string[] | undefined
  if (text.includes("\x1E")) {
    segments = text.split("\x1E").map(cleanParaText)
    text = text.replace(/\x1E/g, "")
  }
  const cleanText = cleanParaText(text)

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

  return { text: cleanText, href, footnote, style, segments }
}

/** kordoc 생성 default 레이아웃의 인라인 코드 charPr id (gen-ids CHAR_CODE와 동기) */
const KORDOC_CHAR_CODE = "4"
/** kordoc 생성 default 레이아웃의 인용문 paraPr id (gen-ids PARA_QUOTE와 동기) */
const KORDOC_PARA_QUOTE = "6"

/**
 * run-span 채널 모드 (v4.0.5 확장) — kordoc: 자사 default 레이아웃(고정 id 규약 전부),
 * gongmun: 자사 공문서 레이아웃(기본 charPr 0~10 블록은 default와 동일 — id4 code 유효.
 * 단 구조 볼드(report 1단계 □ 전체 CHAR_BOLD 등)가 있어 혼합 가드 필수),
 * foreign: 메타 없는 외래 한컴 문서(실속성 볼드/이탤릭만 — id 규약 없음).
 * 미지의 자사 레이아웃 값은 null — 채널 꺼짐 (id 재배치 오검출 가드).
 */
type SpanMode = "kordoc" | "gongmun" | "foreign"

function spanModeOf(layout: string | null | undefined): SpanMode | null {
  if (layout === "default") return "kordoc"
  if (layout === "gongmun") return "gongmun"
  if (!layout) return "foreign"
  return null
}

/**
 * 문단 직계 run들의 인라인 강조 span 추출. 볼드/이탤릭은 charPr id가
 * 아니라 styleMap 실속성(<hh:bold/> 등)으로 읽고, 코드만 고정 id로 식별한다(자사 한정).
 * 개체(표·이미지·수식 등)나 run 외 요소가 섞인 문단, 서식 span이 하나도 없는 문단은
 * null — 평문 경로 유지 (마커 재방출 이득이 없으면 켜지 않는다).
 * requireMixed: 무서식 span과 서식 span이 공존할 때만 인정 — 전체가 서식인 문단은
 * 구조적 서식(gongmun 1단계 볼드, 표 헤더행 볼드 등)일 개연성이 높아 마커를 억제한다.
 */
function extractRunSpans(para: Element, ctx: WalkCtx, mode: SpanMode, requireMixed: boolean): IRSpan[] | null {
  const styleMap = ctx.styleMap
  if (!styleMap) return null
  const spans: IRSpan[] = []
  let styled = false
  const kids = para.childNodes
  if (!kids) return null
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "linesegarray") continue // 조판 캐시 — 텍스트 무관
    if (tag !== "run" && tag !== "r") return null
    let text = ""
    const rkids = child.childNodes
    for (let j = 0; j < (rkids?.length ?? 0); j++) {
      const rc = rkids![j] as Element
      if (rc.nodeType !== 1) continue
      const rtag = (rc.tagName || rc.localName || "").replace(/^[^:]+:/, "")
      if (rtag === "t") {
        const tkids = rc.childNodes
        for (let k = 0; k < (tkids?.length ?? 0); k++) {
          const tk = tkids![k]
          if (tk.nodeType === 3) text += tk.textContent || ""
          else if (tk.nodeType === 1) return null // tab/br 등 — 평문 경로
        }
      } else if (rtag === "secPr" || rtag === "colPr") {
        // 첫 run이 나르는 섹션 속성 — 텍스트 무관
      } else if (rtag === "ctrl") {
        if (extractTextFromNode(rc)) return null
      } else {
        return null // 표·이미지·수식 등 개체 동반 문단
      }
    }
    if (!text) continue
    const prId = child.getAttribute("charPrIDRef") ?? ""
    const cp = styleMap.charProperties.get(prId)
    const span: IRSpan = { text }
    if (mode !== "foreign" && prId === KORDOC_CHAR_CODE) span.code = true
    else {
      if (cp?.bold) span.bold = true
      if (cp?.italic) span.italic = true
      if (cp?.strike) span.strike = true
    }
    if (span.bold || span.italic || span.strike || span.code) styled = true
    spans.push(span)
  }
  if (!styled || spans.length === 0) return null
  // 인접 동일 서식 span 병합 — 한컴은 편집 이력 경계에서 같은 서식 run을 임의 분할
  // 하므로(외래 문서) 그대로 두면 run마다 마커 쌍이 생긴다('**안****녕**' 오염)
  const merged: IRSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && !!last.bold === !!s.bold && !!last.italic === !!s.italic && !!last.strike === !!s.strike && !!last.code === !!s.code) {
      last.text += s.text
    } else {
      merged.push(s)
    }
  }
  // requireMixed(구조적 서식 억제)는 bold/italic 에만 적용 — 취소선은 전체 문단이
  // 통째로 그어진 경우(법령 개정문 삭제 조문)가 정상 패턴이라 억제하지 않는다
  if (requireMixed && !merged.some((s) => s.strike) && !merged.some((s) => !(s.bold || s.italic || s.code))) return null
  return merged
}

/**
 * gongmun levelIndent 역산 (v4.0.5) — left = depth × 본문크기(standard/report) 또는
 * 개조식 반계단(1.0/1.5/2.0, 이후 +0.5/단계) × 본문크기 HWPUNIT. 단위는 문단 첫 run의
 * charPr 글자크기(pt×100 = HWPUNIT)로 도출 — 생성기 levelIndent가 bodyHeight를 쓰는
 * 것의 미러. 부호 시퀀스상 md 충돌 부호('-'·'*'·'N)')는 전부 법정 2단계에서만 나오므로
 * 역산 결과는 사실상 2 — 그래도 파일 자체가 정본이 되게 지문으로 산출한다.
 */
function gongmunDepthFromIndent(para: Element, left: number, ctx: WalkCtx): number | null {
  const styleMap = ctx.styleMap
  if (!styleMap) return null
  let unit = 0
  const kids = para.childNodes
  for (let i = 0; i < (kids?.length ?? 0); i++) {
    const child = kids[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag !== "run" && tag !== "r") continue
    const size = styleMap.charProperties.get(child.getAttribute("charPrIDRef") ?? "")?.fontSize
    if (size) unit = size * 100
    break
  }
  if (!unit) return null
  const r = left / unit
  const nearInt = Math.round(r)
  // 정수배 = standard/report(depth=r), x.5 계단 = 개조식(depth = 2r-1: 1.5→2, 2.5→4)
  const depth = Math.abs(r - nearInt) < 0.2 ? nearInt : Math.round(2 * r - 1)
  return depth >= 1 && depth < 8 ? depth : null
}
