/**
 * PDF 텍스트 추출 (pdfjs-dist static import 기반)
 *
 * polyfill을 먼저 import해야 DOMMatrix/Path2D/pdfjsWorker가 주입됨.
 * ES 모듈 호이스팅 때문에 별도 파일로 분리되어 있음.
 */

import type { ParseResult, IRBlock, IRTable, DocumentMetadata, ParseOptions, BoundingBox, ParseWarning, OutlineItem } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { blocksToMarkdown } from "../table/builder.js"
import { extractLines, filterPageBorderLines, buildTableGrids, extractCells, mapTextToCells, cellTextToString, type TextItem, type TableGrid, type ExtractedCell } from "./line-detector.js"
import { detectClusterTables, type ClusterItem } from "./cluster-detector.js"
// polyfill 먼저 (ES 모듈 호이스팅되므로 별도 파일 필수)
import "./polyfill.js"
import { getDocument, OPS, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"

// worker 비활성화 (polyfill에서 pdfjsWorker를 이미 주입했으므로)
GlobalWorkerOptions.workerSrc = ""

// ─── 안전 한계값 (구조적 파싱과 무관) ────────────────
const MAX_PAGES = 5000
const MAX_TOTAL_TEXT = 100 * 1024 * 1024 // 100MB
/** PDF 로딩 타임아웃 (30초) — 악성/대용량 PDF 무한 대기 방지 */
const PDF_LOAD_TIMEOUT_MS = 30_000

/** getDocument + 타임아웃 래퍼 */
async function loadPdfWithTimeout(buffer: ArrayBuffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
  })
  let timeoutId: ReturnType<typeof setTimeout>
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => { loadingTask.destroy(); reject(new KordocError("PDF 로딩 타임아웃 (30초 초과)")) }, PDF_LOAD_TIMEOUT_MS)
  })
  return Promise.race([loadingTask.promise, timeoutPromise]).finally(() => clearTimeout(timeoutId))
}

interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName?: string
}

interface NormItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** 폰트 높이(≈폰트 크기) — 헤딩 감지용 */
  fontSize: number
  fontName: string
  /** hidden text 여부 (투명/0pt) */
  isHidden: boolean
}

export async function parsePdfDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<ParseResult> {
  const doc = await loadPdfWithTimeout(buffer)

  try {
    const pageCount = doc.numPages
    if (pageCount === 0) return { success: false, fileType: "pdf", pageCount: 0, error: "PDF에 페이지가 없습니다.", code: "PARSE_ERROR" }

    // 메타데이터 추출 (best-effort)
    const metadata: DocumentMetadata = { pageCount }
    await extractPdfMetadata(doc, metadata)

    const blocks: IRBlock[] = []
    const warnings: ParseWarning[] = []
    let totalChars = 0
    let totalTextBytes = 0
    const effectivePageCount = Math.min(pageCount, MAX_PAGES)

    // 페이지 범위 필터링
    const pageFilter = options?.pages ? parsePageRange(options.pages, effectivePageCount) : null
    const totalTarget = pageFilter ? pageFilter.size : effectivePageCount

    // 전체 문서의 폰트 크기 통계 수집 (헤딩 감지용)
    const allFontSizes: number[] = []
    const pageHeights = new Map<number, number>()

    let parsedPages = 0
    for (let i = 1; i <= effectivePageCount; i++) {
      if (pageFilter && !pageFilter.has(i)) continue
      try {
        const page = await doc.getPage(i)
        const tc = await page.getTextContent()
        const viewport = page.getViewport({ scale: 1 })
        pageHeights.set(i, viewport.height)
        const rawItems = tc.items as PdfTextItem[]
        const items = normalizeItems(rawItems)

        // hidden text 필터링 + 경고 수집
        const { visible, hiddenCount } = filterHiddenText(items, viewport.width, viewport.height)
        if (hiddenCount > 0) {
          warnings.push({ page: i, message: `${hiddenCount}개 숨겨진 텍스트 요소 필터링됨`, code: "HIDDEN_TEXT_FILTERED" })
        }

        // 폰트 크기 통계 수집
        for (const item of visible) {
          if (item.fontSize > 0) allFontSizes.push(item.fontSize)
        }

        // 선 기반 테이블 감지를 위한 operatorList
        const opList = await page.getOperatorList()

        const pageBlocks = extractPageBlocksWithLines(visible, i, opList, viewport.width, viewport.height)
        for (const b of pageBlocks) blocks.push(b)

        // 이미지 기반 PDF 감지 + 크기 제한용 문자 수 집계
        for (const b of pageBlocks) {
          const t = b.text || ""
          totalChars += t.replace(/\s/g, "").length
          totalTextBytes += t.length * 2
        }
        if (totalTextBytes > MAX_TOTAL_TEXT) throw new KordocError("텍스트 추출 크기 초과")
        parsedPages++
        options?.onProgress?.(parsedPages, totalTarget)
      } catch (pageErr) {
        // 크기 초과는 전체 중단
        if (pageErr instanceof KordocError) throw pageErr
        warnings.push({ page: i, message: `페이지 ${i} 파싱 실패: ${pageErr instanceof Error ? pageErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
      }
    }

    const parsedPageCount = parsedPages || (pageFilter ? pageFilter.size : effectivePageCount)
    if (totalChars / Math.max(parsedPageCount, 1) < 10) {
      if (options?.ocr) {
        try {
          const { ocrPages } = await import("../ocr/provider.js")
          const ocrBlocks = await ocrPages(doc, options.ocr, pageFilter, effectivePageCount)
          if (ocrBlocks.length > 0) {
            const ocrMarkdown = ocrBlocks.map(b => b.text || "").filter(Boolean).join("\n\n")
            return { success: true, fileType: "pdf", markdown: ocrMarkdown, pageCount: parsedPageCount, blocks: ocrBlocks, metadata, isImageBased: true, warnings }
          }
        } catch {
          // OCR 실패 시 원래 에러 반환
        }
      }
      return { success: false, fileType: "pdf", pageCount, isImageBased: true, error: `이미지 기반 PDF (${pageCount}페이지, ${totalChars}자)`, code: "IMAGE_BASED_PDF" }
    }

    // 머리글/바닥글 필터링
    if (options?.removeHeaderFooter && parsedPageCount >= 3) {
      const removed = removeHeaderFooterBlocks(blocks, pageHeights, warnings)
      // 필터링된 블록 제거 (뒤에서부터 삭제)
      for (let ri = removed.length - 1; ri >= 0; ri--) {
        blocks.splice(removed[ri], 1)
      }
    }

    // 헤딩 감지: 폰트 크기 기반
    const medianFontSize = computeMedianFontSize(allFontSizes)
    if (medianFontSize > 0) {
      detectHeadings(blocks, medianFontSize)
    }

    // outline 구축
    const outline: OutlineItem[] = blocks
      .filter(b => b.type === "heading" && b.level && b.text)
      .map(b => ({ level: b.level!, text: b.text!, pageNumber: b.pageNumber }))

    // blocksToMarkdown로 통일 — 헤딩 마크다운 반영 (HWP5/HWPX와 일관성)
    let markdown = cleanPdfText(blocksToMarkdown(blocks))

    return { success: true, fileType: "pdf", markdown, pageCount: parsedPageCount, blocks, metadata, outline: outline.length > 0 ? outline : undefined, warnings: warnings.length > 0 ? warnings : undefined }
  } finally {
    await doc.destroy().catch(() => {})
  }
}

// ─── PDF 메타데이터 추출 ────────────────────────────

async function extractPdfMetadata(doc: { getMetadata(): Promise<unknown> }, metadata: DocumentMetadata): Promise<void> {
  try {
    const result = await doc.getMetadata() as { info?: Record<string, unknown> } | null
    if (!result?.info) return
    const info = result.info

    if (typeof info.Title === "string" && info.Title.trim()) metadata.title = info.Title.trim()
    if (typeof info.Author === "string" && info.Author.trim()) metadata.author = info.Author.trim()
    if (typeof info.Creator === "string" && info.Creator.trim()) metadata.creator = info.Creator.trim()
    if (typeof info.Subject === "string" && info.Subject.trim()) metadata.description = info.Subject.trim()
    if (typeof info.Keywords === "string" && info.Keywords.trim()) {
      metadata.keywords = info.Keywords.split(/[,;]/).map((k: string) => k.trim()).filter(Boolean)
    }
    if (typeof info.CreationDate === "string") metadata.createdAt = parsePdfDate(info.CreationDate)
    if (typeof info.ModDate === "string") metadata.modifiedAt = parsePdfDate(info.ModDate)
  } catch {
    // best-effort
  }
}

/** PDF 날짜 형식 (D:YYYYMMDDHHmmSS) → ISO 8601 변환 */
function parsePdfDate(dateStr: string): string | undefined {
  const m = dateStr.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/)
  if (!m) return undefined
  const [, year, month = "01", day = "01", hour = "00", min = "00", sec = "00"] = m
  return `${year}-${month}-${day}T${hour}:${min}:${sec}`
}

/** 메타데이터만 추출 (전체 파싱 없이) — MCP parse_metadata용 */
export async function extractPdfMetadataOnly(buffer: ArrayBuffer): Promise<DocumentMetadata> {
  const doc = await loadPdfWithTimeout(buffer)

  try {
    const metadata: DocumentMetadata = { pageCount: doc.numPages }
    await extractPdfMetadata(doc, metadata)
    return metadata
  } finally {
    await doc.destroy().catch(() => {})
  }
}

// ═══════════════════════════════════════════════════════
// Hidden text 필터링 (prompt injection 방어)
// ═══════════════════════════════════════════════════════

function filterHiddenText(items: NormItem[], pageWidth: number, pageHeight: number): { visible: NormItem[]; hiddenCount: number } {
  let hiddenCount = 0
  const visible: NormItem[] = []

  for (const item of items) {
    // 0pt 폰트 / 너비 0 → 숨겨진 텍스트
    if (item.isHidden) { hiddenCount++; continue }
    // 페이지 범위 밖 (여백 10% 허용)
    const margin = Math.max(pageWidth, pageHeight) * 0.1
    if (item.x < -margin || item.x > pageWidth + margin || item.y < -margin || item.y > pageHeight + margin) {
      hiddenCount++; continue
    }
    visible.push(item)
  }

  return { visible, hiddenCount }
}

// ═══════════════════════════════════════════════════════
// 헤딩 감지 (폰트 크기 기반)
// ═══════════════════════════════════════════════════════

function computeMedianFontSize(sizes: number[]): number {
  if (sizes.length === 0) return 0
  const sorted = [...sizes].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
}

/**
 * 블록의 폰트 크기를 median과 비교하여 헤딩으로 승격.
 * - 150%+ → heading level 1
 * - 130%+ → heading level 2
 * - 115%+ → heading level 3
 * 조건: 짧은 텍스트 (200자 미만), 숫자만으로 구성되지 않음
 */
function detectHeadings(blocks: IRBlock[], medianFontSize: number): void {
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text || !block.style?.fontSize) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200) continue
    // 숫자만이면 헤딩 아님
    if (/^\d+$/.test(text)) continue

    const ratio = block.style.fontSize / medianFontSize
    let level = 0
    if (ratio >= 1.5) level = 1
    else if (ratio >= 1.3) level = 2
    else if (ratio >= 1.15) level = 3

    if (level > 0) {
      block.type = "heading"
      block.level = level
    }
  }
}

// ═══════════════════════════════════════════════════════
// XY-Cut 읽기 순서 알고리즘
// ═══════════════════════════════════════════════════════

interface TextRegion {
  items: NormItem[]
  minX: number; minY: number; maxX: number; maxY: number
}

/**
 * XY-Cut: 페이지를 재귀적으로 X/Y축 공백으로 분할하여 읽기 순서 결정.
 * - Y축 분할 (수평 공백 감지) → 위에서 아래
 * - X축 분할 (수직 공백 감지) → 왼쪽에서 오른쪽
 * - 분할 불가능하면 리프 노드 (하나의 텍스트 블록)
 */
/** 재귀 깊이 제한 — 수천 아이템의 pathological 레이아웃에서 스택 오버플로 방지 */
const MAX_XYCUT_DEPTH = 50

function xyCutOrder(items: NormItem[], gapThreshold: number, depth = 0): NormItem[][] {
  if (items.length === 0) return []
  if (items.length <= 2 || depth >= MAX_XYCUT_DEPTH) return [items]

  const region = computeRegion(items)

  // Y축 분할 시도 (수평 공백 감지)
  const ySplit = findYSplit(items, region, gapThreshold)
  if (ySplit !== null) {
    const upper = items.filter(i => i.y > ySplit)
    const lower = items.filter(i => i.y <= ySplit)
    // 빈 파티션 방어 — 한쪽이 비면 분할 의미 없음
    if (upper.length > 0 && lower.length > 0 && upper.length < items.length) {
      return [...xyCutOrder(upper, gapThreshold, depth + 1), ...xyCutOrder(lower, gapThreshold, depth + 1)]
    }
  }

  // X축 분할 시도 (수직 공백 감지)
  const xSplit = findXSplit(items, region, gapThreshold)
  if (xSplit !== null) {
    const left = items.filter(i => i.x + i.w / 2 < xSplit)
    const right = items.filter(i => i.x + i.w / 2 >= xSplit)
    if (left.length > 0 && right.length > 0 && left.length < items.length) {
      return [...xyCutOrder(left, gapThreshold, depth + 1), ...xyCutOrder(right, gapThreshold, depth + 1)]
    }
  }

  // 분할 불가 → 리프 노드
  return [items]
}

function computeRegion(items: NormItem[]): TextRegion {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of items) {
    if (i.x < minX) minX = i.x
    if (i.y < minY) minY = i.y
    if (i.x + i.w > maxX) maxX = i.x + i.w
    if (i.y + i.h > maxY) maxY = i.y + i.h
  }
  return { items, minX, minY, maxX, maxY }
}

/** Y축 분할점 찾기 — 수평 공백 밴드 중 가장 넓은 갭 */
function findYSplit(items: NormItem[], region: TextRegion, gapThreshold: number): number | null {
  // 아이템을 Y좌표로 정렬 (내림차순 — 위에서 아래)
  const sorted = [...items].sort((a, b) => b.y - a.y)
  let bestGap = gapThreshold
  let bestSplit: number | null = null

  for (let i = 1; i < sorted.length; i++) {
    const prevBottom = sorted[i - 1].y - sorted[i - 1].h
    const currTop = sorted[i].y
    const gap = prevBottom - currTop
    if (gap > bestGap) {
      bestGap = gap
      bestSplit = (prevBottom + currTop) / 2
    }
  }
  return bestSplit
}

/** X축 분할점 찾기 — 수직 공백 밴드 중 가장 넓은 갭 */
function findXSplit(items: NormItem[], region: TextRegion, gapThreshold: number): number | null {
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let bestGap = gapThreshold
  let bestSplit: number | null = null

  for (let i = 1; i < sorted.length; i++) {
    const prevRight = sorted[i - 1].x + sorted[i - 1].w
    const currLeft = sorted[i].x
    const gap = currLeft - prevRight
    if (gap > bestGap) {
      bestGap = gap
      bestSplit = (prevRight + currLeft) / 2
    }
  }
  return bestSplit
}

// ═══════════════════════════════════════════════════════
// 페이지 콘텐츠 추출 → IRBlock[] (v2: 바운딩 박스 + 페이지 번호)
// ═══════════════════════════════════════════════════════

/**
 * 선 기반 테이블 감지를 우선 시도, 실패 시 기존 휴리스틱 fallback.
 */
function extractPageBlocksWithLines(
  items: NormItem[],
  pageNum: number,
  opList: { fnArray: Uint32Array | number[]; argsArray: unknown[][] },
  pageWidth: number,
  pageHeight: number,
): IRBlock[] {
  if (items.length === 0) return []

  // 1단계: PDF 그래픽 명령에서 선 추출
  let { horizontals, verticals } = extractLines(opList.fnArray, opList.argsArray)
  ;({ horizontals, verticals } = filterPageBorderLines(horizontals, verticals, pageWidth, pageHeight))

  // 2단계: 선으로 테이블 그리드 구성
  const grids = buildTableGrids(horizontals, verticals)

  if (grids.length > 0) {
    return extractBlocksWithGrids(items, pageNum, grids, horizontals, verticals)
  }

  // Fallback: 기존 휴리스틱 (선이 없는 PDF)
  return extractPageBlocksFallback(items, pageNum)
}

/**
 * 선 기반 그리드가 감지된 경우: 테이블 영역의 텍스트는 셀에 매핑,
 * 나머지는 일반 텍스트 블록으로 처리.
 */
function extractBlocksWithGrids(
  items: NormItem[],
  pageNum: number,
  grids: TableGrid[],
  horizontals: import("./line-detector.js").LineSegment[],
  verticals: import("./line-detector.js").LineSegment[],
): IRBlock[] {
  const blocks: IRBlock[] = []
  const usedItems = new Set<NormItem>()

  // 그리드를 Y좌표 내림차순 정렬 (위→아래)
  const sortedGrids = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)

  for (const grid of sortedGrids) {
    // 그리드 영역 내 텍스트 아이템 수집
    const tableItems: NormItem[] = []
    const pad = 3
    for (const item of items) {
      if (usedItems.has(item)) continue
      if (item.x >= grid.bbox.x1 - pad && item.x + item.w <= grid.bbox.x2 + pad &&
          item.y >= grid.bbox.y1 - pad && item.y <= grid.bbox.y2 + pad) {
        tableItems.push(item)
        usedItems.add(item)
      }
    }

    // 셀 추출
    const cells = extractCells(grid, horizontals, verticals)
    if (cells.length === 0) continue

    // 텍스트→셀 매핑
    const textItems: TextItem[] = tableItems.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName,
    }))
    const cellTextMap = mapTextToCells(textItems, cells)

    // IRTable 구성
    const numRows = grid.rowYs.length - 1
    const numCols = grid.colXs.length - 1
    const irGrid: import("../types.js").IRCell[][] = Array.from(
      { length: numRows },
      () => Array.from({ length: numCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })),
    )

    for (const cell of cells) {
      const cellItems = cellTextMap.get(cell) || []
      const text = cellTextToString(cellItems)
      irGrid[cell.row][cell.col] = {
        text,
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      }
    }

    const irTable: IRTable = {
      rows: numRows,
      cols: numCols,
      cells: irGrid,
      hasHeader: numRows > 1,
    }

    // 빈 테이블(모든 셀이 빈 문자열) 스킵
    const hasContent = irGrid.some(row => row.some(cell => cell.text.trim() !== ""))
    if (!hasContent) continue

    blocks.push({
      type: "table",
      table: irTable,
      pageNumber: pageNum,
      bbox: {
        page: pageNum,
        x: grid.bbox.x1, y: grid.bbox.y1,
        width: grid.bbox.x2 - grid.bbox.x1, height: grid.bbox.y2 - grid.bbox.y1,
      },
    })
  }

  // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
  const remaining = items.filter(i => !usedItems.has(i))
  if (remaining.length > 0) {
    // 위→아래 순서로 정렬
    remaining.sort((a, b) => b.y - a.y || a.x - b.x)

    // 테이블 전/후 텍스트를 Y좌표 기준으로 적절히 배치
    const textBlocks = detectListBlocks(extractPageBlocksFallback(remaining, pageNum))

    // Y좌표 기반으로 테이블과 텍스트를 올바른 순서로 병합
    const allBlocks = [...blocks, ...textBlocks]
    allBlocks.sort((a, b) => {
      const ay = a.bbox ? (a.bbox.y + a.bbox.height) : 0
      const by = b.bbox ? (b.bbox.y + b.bbox.height) : 0
      return by - ay // PDF는 y가 위가 큼 → 내림차순
    })
    return allBlocks
  }

  return blocks
}

/**
 * 기존 휴리스틱 기반 페이지 블록 추출 (선이 없는 PDF 대비 fallback).
 */
function extractPageBlocksFallback(items: NormItem[], pageNum: number): IRBlock[] {
  if (items.length === 0) return []

  const blocks: IRBlock[] = []

  // 1단계: 페이지 전체에서 컬럼 감지 (테이블 우선)
  const allYLines = groupByY(items)
  const columns = detectColumns(allYLines)

  if (columns && columns.length >= 3) {
    // 테이블 감지됨 → 기존 extractWithColumns 로직 사용 (XY-Cut 스킵)
    const tableText = extractWithColumns(allYLines, columns)
    const bbox = computeBBox(items, pageNum)
    blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(items) })
  } else {
    // 2단계: 클러스터 기반 테이블 감지 (2열 이상, 선 없는 PDF)
    const clusterItems: ClusterItem[] = items.map(i => ({
      text: i.text, x: i.x, y: i.y, w: i.w, h: i.h,
      fontSize: i.fontSize, fontName: i.fontName,
    }))
    const clusterResults = detectClusterTables(clusterItems, pageNum)

    if (clusterResults.length > 0) {
      // 클러스터 테이블로 소비된 아이템 추적 (인덱스 기반 — 문자열 키보다 안전)
      const usedIndices = new Set<number>()
      for (const cr of clusterResults) {
        for (const ci of cr.usedItems) {
          // clusterItems와 items는 1:1 매핑, 동일 참조로 인덱스 찾기
          const idx = clusterItems.indexOf(ci)
          if (idx >= 0) usedIndices.add(idx)
        }
        blocks.push({ type: "table", table: cr.table, pageNumber: pageNum, bbox: cr.bbox })
      }

      // 테이블에 속하지 않은 나머지 텍스트 → 일반 블록
      const remaining = items.filter((_, idx) => !usedIndices.has(idx))
      if (remaining.length > 0) {
        const yLines = groupByY(remaining)
        for (const line of yLines) {
          const text = mergeLineSimple(line)
          if (!text.trim()) continue
          const bbox = computeBBox(line, pageNum)
          blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) })
        }
      }

      // Y좌표 기준 정렬
      blocks.sort((a, b) => {
        const ay = a.bbox ? (a.bbox.y + a.bbox.height) : 0
        const by = b.bbox ? (b.bbox.y + b.bbox.height) : 0
        return by - ay
      })
    } else {
      // 3단계: XY-Cut으로 읽기 순서 결정
      const allY = items.map(i => i.y)
      const pageHeight = Math.max(...allY) - Math.min(...allY)
      const gapThreshold = Math.max(15, pageHeight * 0.03)

      const orderedGroups = xyCutOrder(items, gapThreshold)

      for (const group of orderedGroups) {
        if (group.length === 0) continue
        const yLines = groupByY(group)

        // 그룹 내에서도 컬럼 감지 시도 (소형 테이블)
        const groupColumns = detectColumns(yLines)
        if (groupColumns && groupColumns.length >= 3) {
          const tableText = extractWithColumns(yLines, groupColumns)
          const bbox = computeBBox(group, pageNum)
          blocks.push({ type: "paragraph", text: tableText, pageNumber: pageNum, bbox, style: dominantStyle(group) })
        } else {
          for (const line of yLines) {
            const text = mergeLineSimple(line)
            if (!text.trim()) continue
            const bbox = computeBBox(line, pageNum)
            blocks.push({ type: "paragraph", text, pageNumber: pageNum, bbox, style: dominantStyle(line) })
          }
        }
      }
    }
  }

  // 한국어 특수 테이블 감지 (구분/항목/종류 패턴)
  return detectSpecialKoreanTables(blocks)
}

/** 아이템 그룹에서 바운딩 박스 계산 */
function computeBBox(items: NormItem[], pageNum: number): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of items) {
    if (i.x < minX) minX = i.x
    if (i.y < minY) minY = i.y
    if (i.x + i.w > maxX) maxX = i.x + i.w
    // h가 0인 경우 fontSize를 높이 대용으로 사용 (pdfjs가 height를 제공하지 않는 경우)
    const effectiveH = i.h > 0 ? i.h : i.fontSize
    if (i.y + effectiveH > maxY) maxY = i.y + effectiveH
  }
  return { page: pageNum, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 아이템 그룹의 대표 스타일 (최빈 폰트 크기) */
function dominantStyle(items: NormItem[]): { fontSize: number; fontName: string } | undefined {
  if (items.length === 0) return undefined
  // 최빈 폰트 크기 찾기
  const freq = new Map<number, number>()
  let maxCount = 0, dominantSize = 0
  for (const i of items) {
    if (i.fontSize <= 0) continue
    const count = (freq.get(i.fontSize) || 0) + 1
    freq.set(i.fontSize, count)
    if (count > maxCount) { maxCount = count; dominantSize = i.fontSize }
  }
  if (dominantSize === 0) return undefined
  // 대표 폰트명 (빈 문자열은 undefined로)
  const fontName = items.find(i => i.fontSize === dominantSize)?.fontName || undefined
  return { fontSize: dominantSize, fontName }
}

function normalizeItems(rawItems: PdfTextItem[]): NormItem[] {
  return rawItems
    .filter(i => typeof i.str === "string" && i.str.trim() !== "")
    .map(i => {
      // transform matrix: [scaleX, skewY, skewX, scaleY, translateX, translateY]
      // 폰트 크기 ≈ scaleY의 절대값 (일반적으로 transform[3])
      const scaleY = Math.abs(i.transform[3])
      const scaleX = Math.abs(i.transform[0])
      const fontSize = Math.round(Math.max(scaleY, scaleX))

      return {
        text: i.str.trim(),
        x: Math.round(i.transform[4]),
        y: Math.round(i.transform[5]),
        w: Math.round(i.width),
        h: Math.round(i.height),
        fontSize,
        fontName: i.fontName || "",
        // 0pt 폰트이거나 너비 0 → hidden text (prompt injection 의심)
        isHidden: fontSize === 0 || (i.width === 0 && i.str.trim().length > 0),
      }
    })
    .sort((a, b) => b.y - a.y || a.x - b.x)
}

function groupByY(items: NormItem[]): NormItem[][] {
  if (items.length === 0) return []
  const lines: NormItem[][] = []
  let curY = items[0].y
  let curLine: NormItem[] = [items[0]]

  for (let i = 1; i < items.length; i++) {
    // Y좌표 허용 오차 3px — PDF 렌더링 미세 오차 보정, 별표 행 경계 감지에 최적화된 값
    if (Math.abs(items[i].y - curY) > 3) {
      lines.push(curLine)
      curLine = []
      curY = items[i].y
    }
    curLine.push(items[i])
  }
  if (curLine.length > 0) lines.push(curLine)
  return lines
}

// ═══════════════════════════════════════════════════════
// 열 경계 감지 — 빈도 기반 x-히스토그램 클러스터링
// ═══════════════════════════════════════════════════════

/** prose 라인 판별: 아이템 간 gap이 모두 작으면 문장 (단어 나열) */
function isProseSpread(items: NormItem[]): boolean {
  if (items.length < 4) return false
  const sorted = [...items].sort((a, b) => a.x - b.x)
  const gaps: number[] = []
  for (let i = 1; i < sorted.length; i++) {
    gaps.push(sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w))
  }
  // gap의 최대값이 작고 평균 단어 길이가 짧으면 prose
  const maxGap = Math.max(...gaps)
  const avgLen = items.reduce((s, i) => s + i.text.length, 0) / items.length
  // 짧은 단어들이 좁은 간격으로 나열 = prose (예: "위 표 제3호나목에서 남은 유효기간...")
  return maxGap < 40 && avgLen < 5
}

function detectColumns(yLines: NormItem[][]): number[] | null {
  const allItems = yLines.flat()
  if (allItems.length === 0) return null
  const pageWidth = Math.max(...allItems.map(i => i.x + i.w)) - Math.min(...allItems.map(i => i.x))
  if (pageWidth < 100) return null

  // "비고" 이전 아이템만 사용 (비고 이후는 prose)
  let bigoLineIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoLineIdx = i
      break
    }
  }
  const tableYLines = bigoLineIdx >= 0 ? yLines.slice(0, bigoLineIdx) : yLines

  // Step 1: 모든 아이템의 x를 수집 (prose 라인 제외)
  // CLUSTER_TOL 22px — 한국 공문서 PDF 열 간격에 최적화, 별표 표 열 감지 핵심값
  const CLUSTER_TOL = 22
  const xClusters: { center: number; count: number; minX: number }[] = []

  for (const line of tableYLines) {
    if (isProseSpread(line)) continue
    for (const item of line) {
      let found = false
      for (const c of xClusters) {
        if (Math.abs(item.x - c.center) <= CLUSTER_TOL) {
          c.center = Math.round((c.center * c.count + item.x) / (c.count + 1))
          c.minX = Math.min(c.minX, item.x)
          c.count++
          found = true
          break
        }
      }
      if (!found) {
        xClusters.push({ center: item.x, count: 1, minX: item.x })
      }
    }
  }

  // Step 2: 빈도 피크 — 최소 3회 이상 등장 (단발성 텍스트 노이즈 제거)
  const peaks = xClusters
    .filter(c => c.count >= 3)
    .sort((a, b) => a.minX - b.minX)

  // 최소 3개 열이 있어야 테이블로 판별 — 2열은 일반 2단 레이아웃과 구분 불가
  if (peaks.length < 3) return null

  // Step 3: 가까운 피크 병합 — MERGE_TOL 30px (같은 논리 열의 미세 위치 차이 흡수)
  const MERGE_TOL = 30
  const merged: { center: number; count: number; minX: number }[] = [peaks[0]]
  for (let i = 1; i < peaks.length; i++) {
    const prev = merged[merged.length - 1]
    if (peaks[i].minX - prev.minX < MERGE_TOL) {
      // 빈도 높은 쪽 유지, 최소 x는 작은 값
      if (peaks[i].count > prev.count) {
        prev.center = peaks[i].center
      }
      prev.count += peaks[i].count
      prev.minX = Math.min(prev.minX, peaks[i].minX)
    } else {
      merged.push({ ...peaks[i] })
    }
  }

  // 열 경계 = 각 클러스터의 minX (왼쪽 정렬 기준), 병합 후 재검증
  const columns = merged.filter(c => c.count >= 3).map(c => c.minX)
  return columns.length >= 3 ? columns : null
}

function findColumn(x: number, columns: number[]): number {
  for (let i = columns.length - 1; i >= 0; i--) {
    // 10px 왼쪽 허용 오차 — 셀 내 텍스트 미세 좌측 이탈 보정
    if (x >= columns[i] - 10) return i
  }
  return 0
}

// ═══════════════════════════════════════════════════════
// 열 기반 추출 — 테이블/텍스트 영역 분리
// ═══════════════════════════════════════════════════════

function extractWithColumns(yLines: NormItem[][], columns: number[]): string {
  const result: string[] = []
  const colMin = columns[0]
  const colMax = columns[columns.length - 1]

  // "비고" 라인 감지 — 이후는 텍스트로 처리
  let bigoIdx = -1
  for (let i = 0; i < yLines.length; i++) {
    if (yLines[i].length <= 2 && yLines[i].some(item => item.text === "비고")) {
      bigoIdx = i
      break
    }
  }

  // 테이블 시작: 첫 번째 다열(3+ 열 사용) 라인
  let tableStart = -1
  for (let i = 0; i < (bigoIdx >= 0 ? bigoIdx : yLines.length); i++) {
    const usedCols = new Set(yLines[i].map(item => findColumn(item.x, columns)))
    if (usedCols.size >= 3) {
      tableStart = i
      break
    }
  }

  const tableEnd = bigoIdx >= 0 ? bigoIdx : yLines.length

  // 테이블 시작 이전 = 텍스트
  for (let i = 0; i < (tableStart >= 0 ? tableStart : tableEnd); i++) {
    result.push(mergeLineSimple(yLines[i]))
  }

  // 테이블 영역: 모든 라인을 그리드에 포함 (단일 아이템 라인도)
  if (tableStart >= 0) {
    const tableLines = yLines.slice(tableStart, tableEnd)
    // 테이블 x범위 밖의 라인만 텍스트로 분리
    // 좌측 20px, 우측 200px 허용 — 비고/주석 열이 오른쪽에 넓게 위치하는 공문서 특성 반영
    const gridLines: NormItem[][] = []
    for (const line of tableLines) {
      const inRange = line.some(item =>
        item.x >= colMin - 20 && item.x <= colMax + 200
      )
      if (inRange && !isProseSpread(line)) {
        gridLines.push(line)
      } else {
        // 그리드 밖 라인은 현재까지 축적된 그리드 출력 후 텍스트로
        if (gridLines.length > 0) {
          result.push(buildGridTable(gridLines.splice(0), columns))
        }
        result.push(mergeLineSimple(line))
      }
    }
    if (gridLines.length > 0) {
      result.push(buildGridTable(gridLines, columns))
    }
  }

  // 비고 영역
  if (bigoIdx >= 0) {
    result.push("")
    for (let i = bigoIdx; i < yLines.length; i++) {
      result.push(mergeLineSimple(yLines[i]))
    }
  }

  return result.join("\n")
}

// ═══════════════════════════════════════════════════════
// 그리드 테이블 빌더 — y-라인을 열에 배치 후 행 병합
// ═══════════════════════════════════════════════════════

function buildGridTable(lines: NormItem[][], columns: number[]): string {
  const numCols = columns.length

  // Step 1: 각 y-라인을 열에 배치
  const yRows: string[][] = lines.map(items => {
    const row = Array(numCols).fill("")
    for (const item of items) {
      const col = findColumn(item.x, columns)
      row[col] = row[col] ? row[col] + " " + item.text : item.text
    }
    return row
  })

  // Step 2: 행 병합 — 새 논리적 행 판별
  // 데이터 열 기준점 (가격 등이 들어가는 오른쪽 열들)
  const dataColStart = Math.max(2, Math.floor(numCols / 2))
  const merged: string[][] = []

  for (const row of yRows) {
    if (row.every(c => c === "")) continue

    if (merged.length === 0) {
      merged.push([...row])
      continue
    }

    const prev = merged[merged.length - 1]
    const filledCols = row.map((c, i) => c ? i : -1).filter(i => i >= 0)
    const filledCount = filledCols.length

    let isNewRow = false

    // Rule 1: col 0에 텍스트 (3글자 이상) → 새 행 (단, "권"처럼 짧은 건 continuation)
    if (row[0] && row[0].length >= 3) {
      isNewRow = true
    }

    // Rule 2: col 1에 텍스트 → 항상 새 행 (새 항목 시작)
    if (!isNewRow && numCols > 1 && row[1]) {
      isNewRow = true
    }

    // Rule 3: 데이터 열(3+)에 새 값이 있고 이전 행 데이터 열에도 이미 값 있음 → 새 가격 행
    if (!isNewRow) {
      const hasData = row.slice(dataColStart).some(c => c !== "")
      const prevHasData = prev.slice(dataColStart).some(c => c !== "")
      if (hasData && prevHasData) {
        isNewRow = true
      }
    }

    // Exception: filledCount=1이고 col 0에 짧은 텍스트(≤2자) → word continuation (예: "권", "여권")
    if (isNewRow && filledCount === 1 && row[0] && row[0].length <= 2) {
      isNewRow = false
    }

    if (isNewRow) {
      merged.push([...row])
    } else {
      for (let c = 0; c < numCols; c++) {
        if (row[c]) {
          prev[c] = prev[c] ? prev[c] + " " + row[c] : row[c]
        }
      }
    }
  }

  if (merged.length < 2) {
    return merged.map(r => r.filter(c => c).join(" ")).join("\n")
  }

  // Step 3: 헤더 행 병합 — 첫 N행이 모두 데이터열(dataColStart+)에 값이 없으면 헤더
  let headerEnd = 0
  for (let r = 0; r < merged.length; r++) {
    const hasDataValues = merged[r].slice(dataColStart).some(c => c && /\d/.test(c))
    if (hasDataValues) break
    headerEnd = r + 1
  }

  if (headerEnd > 1) {
    // 헤더 행들을 하나로 합침
    const headerRow = Array(numCols).fill("")
    for (let r = 0; r < headerEnd; r++) {
      for (let c = 0; c < numCols; c++) {
        if (merged[r][c]) {
          headerRow[c] = headerRow[c] ? headerRow[c] + " " + merged[r][c] : merged[r][c]
        }
      }
    }
    merged.splice(0, headerEnd, headerRow)
  }

  // Step 4: 마크다운 테이블
  const md: string[] = []
  md.push("| " + merged[0].join(" | ") + " |")
  md.push("| " + merged[0].map(() => "---").join(" | ") + " |")
  for (let r = 1; r < merged.length; r++) {
    md.push("| " + merged[r].join(" | ") + " |")
  }
  return md.join("\n")
}

// ═══════════════════════════════════════════════════════
// 유틸
// ═══════════════════════════════════════════════════════

function mergeLineSimple(items: NormItem[]): string {
  if (items.length <= 1) return items[0]?.text || ""
  const sorted = [...items].sort((a, b) => a.x - b.x)
  let result = sorted[0].text
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
    const avgFs = (sorted[i].fontSize + sorted[i - 1].fontSize) / 2
    // 15px+ 갭 = 탭 (열 구분)
    if (gap > 15) result += "\t"
    // 한글-한글 사이 매우 작은 갭 (< fontSize * 0.3) → 공백 없이 붙임
    else if (gap < avgFs * 0.3 && /[가-힣]$/.test(result) && /^[가-힣]/.test(sorted[i].text)) {
      /* 한글 어절 끊김 복원: PDF가 문자별로 배치할 때 생기는 미세 갭 */
    }
    // 3px+ 갭 = 공백 (단어 구분)
    else if (gap > 3) result += " "
    result += sorted[i].text
  }
  return result
}

export function cleanPdfText(text: string): string {
  return mergeKoreanLines(
    text
      .replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "")
      .replace(/^\s*\d+\s*\/\s*\d+\s*$/gm, "")
  )
    // NOTE: 한국어 어절 중간 끊김("기 준을")은 형태소 분석 없이 정규식으로 수리하기 어려움.
    // 과매칭 위험이 높아 현재는 적용하지 않음.
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function startsWithMarker(line: string): boolean {
  const t = line.trimStart()
  return /^[가-힣ㄱ-ㅎ][.)]/.test(t) || /^\d+[.)]/.test(t) || /^\([가-힣ㄱ-ㅎ\d]+\)/.test(t) ||
    /^[○●※▶▷◆◇■□★☆\-·]\s/.test(t) || /^제\d+[조항호장절]/.test(t)
}

function isStandaloneHeader(line: string): boolean {
  return /^제\d+[조항호장절](\([^)]*\))?(\s+\S+){0,7}$/.test(line.trim())
}

// ═══════════════════════════════════════════════════════
// 리스트 감지 — paragraph 블록 중 번호 패턴을 list 블록으로 변환
// ═══════════════════════════════════════════════════════

/**
 * 연속된 paragraph 블록에서 번호 리스트 패턴을 감지하여 list 블록으로 변환.
 * "비고" 헤더 뒤에 오는 "1.", "2." 패턴이 대표적.
 */
function detectListBlocks(blocks: IRBlock[]): IRBlock[] {
  const result: IRBlock[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // paragraph에서 번호 리스트 패턴 감지
    if (block.type === "paragraph" && block.text) {
      const match = block.text.match(/^(\d+)\.\s/)
      if (match) {
        result.push({
          ...block,
          type: "list",
          listType: "ordered",
          // 원래 번호를 text에 보존 (blocksToMarkdown에서 그대로 출력)
          text: block.text,
        })
        continue
      }
    }

    result.push(block)
  }

  return result
}

// ═══════════════════════════════════════════════════════
// 한국어 특수 테이블 감지 — "구분/항목/종류" 패턴 기반 key-value 테이블
// ═══════════════════════════════════════════════════════

/**
 * ODL SpecialTableProcessor 포팅: 연속된 "구분:", "항목:", "종류:" 등
 * 한국어 key-value 패턴을 2열 테이블로 변환.
 *
 * 동작:
 * 1) paragraph 블록의 텍스트에서 한국어 key-value 패턴 감지
 * 2) ":"가 있으면 key | value 2열, 없으면 colSpan=2 (전체 행)
 * 3) 연속된 패턴을 하나의 테이블로 그룹화
 */
const KOREAN_TABLE_HEADER_RE = /^\(?(구분|항목|종류|분류|유형|대상|내용|기간|금액|비율|방법|절차|요건|조건|근거|목적|범위|기준)\)?[:\s]/

/** KV 오탐 패턴: 시간(14:30), URL(://), 숫자:숫자(3:2) */
const KV_FALSE_POSITIVE_RE = /\d{1,2}:\d{2}|:\/\/|\d+:\d+/

function detectSpecialKoreanTables(blocks: IRBlock[]): IRBlock[] {
  const result: IRBlock[] = []
  let kvLines: { key: string; value: string; block: IRBlock }[] = []

  const flushKvTable = () => {
    if (kvLines.length < 2) {
      // 2행 미만이면 테이블로 만들 가치 없음 → 원래 블록 복원
      for (const kv of kvLines) result.push(kv.block)
      kvLines = []
      return
    }

    // 2열 테이블 생성
    const cells: import("../types.js").IRCell[][] = kvLines.map(kv => {
      if (kv.value) {
        return [
          { text: kv.key, colSpan: 1, rowSpan: 1 },
          { text: kv.value, colSpan: 1, rowSpan: 1 },
        ]
      }
      // ":" 없는 줄 → 전체 행 (colSpan=2)
      return [
        { text: kv.key, colSpan: 2, rowSpan: 1 },
        { text: "", colSpan: 1, rowSpan: 1 },
      ]
    })

    const irTable: IRTable = {
      rows: cells.length,
      cols: 2,
      cells,
      hasHeader: true,
    }

    // 첫 블록의 위치 정보 사용
    const firstBlock = kvLines[0].block
    result.push({
      type: "table",
      table: irTable,
      pageNumber: firstBlock.pageNumber,
      bbox: firstBlock.bbox,
    })
    kvLines = []
  }

  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) {
      flushKvTable()
      result.push(block)
      continue
    }

    const text = block.text.trim()

    // "구분: xxx" 또는 "항목: xxx" 패턴 매칭
    if (KOREAN_TABLE_HEADER_RE.test(text)) {
      const colonIdx = text.indexOf(":")
      if (colonIdx >= 0) {
        kvLines.push({
          key: text.slice(0, colonIdx).trim(),
          value: text.slice(colonIdx + 1).trim(),
          block,
        })
      } else {
        // ":" 없이 공백으로 구분된 경우: "구분 xxx"
        const spaceIdx = text.search(/\s/)
        if (spaceIdx > 0) {
          kvLines.push({
            key: text.slice(0, spaceIdx).trim(),
            value: text.slice(spaceIdx + 1).trim(),
            block,
          })
        } else {
          kvLines.push({ key: text, value: "", block })
        }
      }
      continue
    }

    // key-value 패턴이 아닌 블록이 나오면 축적된 것을 flush
    // 단, 이미 수집 중이고 현재 블록이 "label: value" 형태면 계속 수집
    if (kvLines.length > 0 && text.includes(":")) {
      // 오탐 제외: 시간(14:30), URL(http://), 숫자:숫자(3:2), 괄호 포함
      if (!KV_FALSE_POSITIVE_RE.test(text) && !text.includes("(") && !text.includes(")")) {
        const colonIdx = text.indexOf(":")
        const key = text.slice(0, colonIdx).trim()
        // key가 순수 한글 2~8자 (공백/괄호 없음)면 유효한 key-value 라인
        if (/^[가-힣]+$/.test(key) && key.length >= 2 && key.length <= 8) {
          kvLines.push({
            key,
            value: text.slice(colonIdx + 1).trim(),
            block,
          })
          continue
        }
      }
    }

    flushKvTable()
    result.push(block)
  }

  flushKvTable()
  return result
}

// ─── 머리글/바닥글 감지 ────────────────────────────

/** 상단/하단 10% 영역에서 페이지간 반복 텍스트를 감지하여 제거 대상 인덱스 반환 */
function removeHeaderFooterBlocks(
  blocks: IRBlock[],
  pageHeights: Map<number, number>,
  warnings: ParseWarning[],
): number[] {
  const ZONE_RATIO = 0.1 // 상하 10%
  const MIN_REPEAT = 3   // 최소 3페이지에서 반복

  // 페이지별 상단/하단 텍스트 수집
  const headerTexts = new Map<number, string[]>() // page → texts
  const footerTexts = new Map<number, string[]>()

  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    if (!b.bbox || !b.pageNumber || !b.text?.trim()) continue
    const ph = pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber)
    if (!ph) continue

    const blockTop = ph - (b.bbox.y + b.bbox.height) // PDF Y좌표는 아래가 0
    const blockBottom = ph - b.bbox.y

    if (blockBottom <= ph * ZONE_RATIO) {
      // 하단 영역
      const arr = footerTexts.get(b.pageNumber) || []
      arr.push(b.text.trim())
      footerTexts.set(b.pageNumber, arr)
    } else if (blockTop >= ph * (1 - ZONE_RATIO)) {
      // 상단 영역
      const arr = headerTexts.get(b.pageNumber) || []
      arr.push(b.text.trim())
      headerTexts.set(b.pageNumber, arr)
    }
  }

  // 반복 패턴 찾기: 페이지 번호 변동 허용 (숫자만 다른 경우)
  const repeatedPatterns = new Set<string>()
  for (const textsMap of [headerTexts, footerTexts]) {
    const patternCount = new Map<string, number>()
    for (const [, texts] of textsMap) {
      for (const t of texts) {
        // 숫자를 와일드카드로 치환하여 "- 1 -", "- 2 -" 같은 패턴 통합
        const normalized = t.replace(/\d+/g, "#")
        patternCount.set(normalized, (patternCount.get(normalized) || 0) + 1)
      }
    }
    for (const [pattern, count] of patternCount) {
      if (count >= MIN_REPEAT) repeatedPatterns.add(pattern)
    }
  }

  if (repeatedPatterns.size === 0) return []

  // 반복 패턴에 매칭되는 블록 인덱스 수집
  const removeIndices: number[] = []
  for (let bi = 0; bi < blocks.length; bi++) {
    const b = blocks[bi]
    if (!b.bbox || !b.pageNumber || !b.text?.trim()) continue
    const ph = pageHeights.get(b.bbox.page) || pageHeights.get(b.pageNumber)
    if (!ph) continue

    const blockTop = ph - (b.bbox.y + b.bbox.height)
    const blockBottom = ph - b.bbox.y
    const inZone = blockBottom <= ph * ZONE_RATIO || blockTop >= ph * (1 - ZONE_RATIO)
    if (!inZone) continue

    const normalized = b.text.trim().replace(/\d+/g, "#")
    if (repeatedPatterns.has(normalized)) {
      removeIndices.push(bi)
    }
  }

  if (removeIndices.length > 0) {
    warnings.push({ message: `${removeIndices.length}개 머리글/바닥글 요소 제거됨`, code: "HIDDEN_TEXT_FILTERED" })
  }

  return removeIndices
}

function mergeKoreanLines(text: string): string {
  if (!text) return ""
  const lines = text.split("\n")
  if (lines.length <= 1) return text
  const result: string[] = [lines[0]]

  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1]
    const curr = lines[i]
    // 마크다운 헤딩 라인(#)은 병합하지 않음
    if (/^#{1,6}\s/.test(prev) || /^#{1,6}\s/.test(curr)) {
      result.push(curr)
      continue
    }
    if (/[가-힣·,\-]$/.test(prev) && /^[가-힣(]/.test(curr) && !curr.trimStart().startsWith("|") && !startsWithMarker(curr) && !isStandaloneHeader(prev)) {
      result[result.length - 1] = prev + " " + curr
    } else {
      result.push(curr)
    }
  }
  return result.join("\n")
}
