/**
 * PDF 텍스트 추출 (pdfjs-dist static import 기반)
 *
 * polyfill을 먼저 import해야 DOMMatrix/Path2D/pdfjsWorker가 주입됨.
 * ES 모듈 호이스팅 때문에 별도 파일로 분리되어 있음.
 *
 * 이 파일은 엔트리(파이프라인 오케스트레이션)와 메타데이터 추출만 담당한다.
 * 세부 단계는 모듈로 분리: text-line(아이템/줄), xy-cut(읽기 순서),
 * columns(열 감지), page-blocks(블록 추출), block-detect(후처리 감지),
 * text-clean(마크다운 정리), formula-ocr(수식).
 */

import type { InternalParseResult, IRBlock, DocumentMetadata, ParseOptions, ParseWarning, OutlineItem } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange } from "../page-range.js"
import { blocksToMarkdown } from "../table/builder.js"
import { extractImageRegions } from "./line-detector.js"
import { computePageQuality, summarizeDocumentQuality, type PageQuality } from "./quality.js"
import { type PdfTextItem, normalizeItems, filterHiddenText } from "./text-line.js"
import { extractPageBlocksWithLines, mergeCrossPageTables } from "./page-blocks.js"
import { computeMedianFontSizeFromFreq, detectHeadings, detectMarkerHeadings, detectTableCaptions, detectKoreanListBlocks, removeHeaderFooterBlocks } from "./block-detect.js"
import { sanitizeBlockControlChars, cleanPdfText } from "./text-clean.js"
import { applyFormulaOcr } from "./formula-ocr.js"
// polyfill 먼저 (ES 모듈 호이스팅되므로 별도 파일 필수)
import "./polyfill.js"
import { getDocument, GlobalWorkerOptions } from "pdfjs-dist/legacy/build/pdf.mjs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

// 기존 공개 API 경로 유지 — 이동된 함수의 re-export
export { mergeCrossPageTables }
export { cleanPdfText }
export { detectTableCaptions, detectKoreanListBlocks, removeHeaderFooterBlocks }

// worker 비활성화 (polyfill에서 pdfjsWorker를 이미 주입했으므로)
GlobalWorkerOptions.workerSrc = ""

// ─── 안전 한계값 (구조적 파싱과 무관) ────────────────
const MAX_PAGES = 5000
const MAX_TOTAL_TEXT = 100 * 1024 * 1024 // 100MB
/** PDF 로딩 타임아웃 (30초) — 악성/대용량 PDF 무한 대기 방지 */
const PDF_LOAD_TIMEOUT_MS = 30_000

// CID 폰트 자산(cmaps/standard_fonts) 경로 — 미지정이면 CMap 필요 폰트의 텍스트가
// "loadFont failed: cMapUrl 필요" 경고와 함께 통째로 소실된다 (성과계획서류 숫자 전멸).
// pdfjs-dist 패키지 위치에서 해석하고, 실패 시 미지정(기존 동작) 유지.
const pdfjsAssets: { cMapUrl?: string; cMapPacked?: boolean; standardFontDataUrl?: string } = {}
try {
  const _require = createRequire(import.meta.url)
  const pkgDir = dirname(_require.resolve("pdfjs-dist/package.json"))
  pdfjsAssets.cMapUrl = join(pkgDir, "cmaps") + "/"
  pdfjsAssets.cMapPacked = true
  pdfjsAssets.standardFontDataUrl = join(pkgDir, "standard_fonts") + "/"
} catch { /* optional dep — 경로 해석 실패 시 cMap 없이 진행 */ }

/** getDocument + 타임아웃 래퍼 */
async function loadPdfWithTimeout(buffer: ArrayBuffer) {
  const loadingTask = getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    ...pdfjsAssets,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loadingTask.promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { loadingTask.destroy(); reject(new KordocError("PDF 로딩 타임아웃 (30초 초과)")) }, PDF_LOAD_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function parsePdfDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<InternalParseResult> {
  // pdfjs-dist 는 전달받은 buffer 의 underlying storage 를 detach 할 수 있다.
  // 수식 OCR 은 같은 버퍼를 재사용해야 하므로 옵션 on 일 때만 clone 을 보관.
  const formulaBuffer: ArrayBuffer | null = options?.formulaOcr ? buffer.slice(0) : null
  const doc = await loadPdfWithTimeout(buffer)

  try {
    const pageCount = doc.numPages
    if (pageCount === 0) throw new KordocError("PDF에 페이지가 없습니다.")

    // 메타데이터 추출 (best-effort)
    const metadata: DocumentMetadata = { pageCount }
    await extractPdfMetadata(doc, metadata)

    const blocks: IRBlock[] = []
    const warnings: ParseWarning[] = []
    const pageQuality: PageQuality[] = []
    let totalChars = 0
    let totalTextBytes = 0
    const effectivePageCount = Math.min(pageCount, MAX_PAGES)

    // 페이지 범위 필터링
    const pageFilter = options?.pages ? parsePageRange(options.pages, effectivePageCount) : null
    const totalTarget = pageFilter ? pageFilter.size : effectivePageCount

    // 전체 문서의 폰트 크기 빈도 수집 (헤딩 감지용) — 빈도 Map으로 메모리 절약
    const fontSizeFreq = new Map<number, number>()
    const pageHeights = new Map<number, number>()
    // 큰 이미지가 있는 페이지 (needsOcr 경고 노이즈 필터 + SKIPPED_IMAGE)
    const pagesWithLargeImage = new Set<number>()
    // 텍스트 없는 큰 이미지 영역: page → count
    const skippedImagePages = new Map<number, number>()

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

        // 폰트 크기 빈도 수집
        for (const item of visible) {
          if (item.fontSize > 0) fontSizeFreq.set(item.fontSize, (fontSizeFreq.get(item.fontSize) || 0) + 1)
        }

        // 선 기반 테이블 감지를 위한 operatorList
        const opList = await page.getOperatorList()

        // 이미지 영역 감지 — 텍스트 없는 큰 이미지는 무음 정보손실이므로 가시화 (ODL 아이디어)
        const pageArea = viewport.width * viewport.height
        if (pageArea > 0) {
          const imageRegions = extractImageRegions(opList.fnArray, opList.argsArray)
          let uncovered = 0
          for (const r of imageRegions) {
            const area = (r.x2 - r.x1) * (r.y2 - r.y1)
            if (area < pageArea * 0.05) continue // 작은 장식 이미지 무시
            pagesWithLargeImage.add(i)
            const hasText = visible.some(it => {
              const cx = it.x + it.w / 2
              const cy = it.y + (it.h || it.fontSize) / 2
              return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2
            })
            if (!hasText) uncovered++
          }
          if (uncovered > 0) skippedImagePages.set(i, uncovered)
        }

        const pageBlocks = extractPageBlocksWithLines(visible, i, opList, viewport.width, viewport.height)
        for (const b of pageBlocks) blocks.push(b)

        // 이미지 기반 PDF 감지 + 크기 제한용 문자 수 집계 + 페이지 품질 신호
        let pageText = ""
        for (const b of pageBlocks) {
          const t = b.text || ""
          totalChars += t.replace(/\s/g, "").length
          totalTextBytes += t.length * 2
          pageText += pageText ? "\n" + t : t
        }
        pageQuality.push(computePageQuality(i, pageText))
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
    let isImageBased = false
    if (totalChars / Math.max(parsedPageCount, 1) < 10) {
      if (options?.ocr) {
        try {
          const { ocrPages } = await import("../ocr/provider.js")
          const ocrBlocks = await ocrPages(doc, options.ocr, pageFilter, effectivePageCount)
          if (ocrBlocks.length > 0) {
            const ocrMarkdown = ocrBlocks.map(b => b.text || "").filter(Boolean).join("\n\n")
            return { markdown: ocrMarkdown, blocks: ocrBlocks, metadata, warnings, isImageBased: true, pageQuality, qualitySummary: summarizeDocumentQuality(pageQuality) }
          }
        } catch {
          // OCR 실패 시 일반 경로로 폴백 (아래에서 NEEDS_OCR 경고)
        }
      }
      // OCR 미설정/실패 — 빈 출력을 무경고로 내보내지 않고 경고 + 플래그로 가시화 (v3.0)
      isImageBased = true
      warnings.push({
        message: `이미지 기반 PDF (${pageCount}페이지, 텍스트 ${totalChars}자) — 텍스트 레이어가 없어 OCR이 필요합니다`,
        code: "NEEDS_OCR",
      })
    }

    // 페이지 단위 needsOcr 경고 — 텍스트+스캔 혼합 문서에서 스캔 페이지 무음 손실 방지.
    // low_text는 빈 페이지(표지/간지)일 수 있으므로 큰 이미지가 있는 페이지만 경고.
    if (!isImageBased) {
      const OCR_REASON_MESSAGES: Record<string, string> = {
        low_text: "텍스트가 거의 없는 페이지 (스캔/이미지 추정)",
        high_pua: "글꼴 매핑 실패 (PUA 비율 높음) — 추출 텍스트 신뢰 불가",
        high_control: "제어문자 비율 높음 — 추출 텍스트 신뢰 불가",
        high_replacement: "대체문자(U+FFFD) 비율 높음 — 추출 텍스트 신뢰 불가",
      }
      for (const pq of pageQuality) {
        if (!pq.needsOcr || !pq.ocrReason) continue
        if (pq.ocrReason === "low_text" && !pagesWithLargeImage.has(pq.page)) continue
        warnings.push({ page: pq.page, message: `${OCR_REASON_MESSAGES[pq.ocrReason]} — OCR 검토 필요`, code: "NEEDS_OCR" })
      }
    }

    // 텍스트 없는 큰 이미지 영역 경고 — 그림/차트/도장 무음 누락 가시화
    // (문서 전체가 이미지 기반이면 위의 NEEDS_OCR 단일 경고로 충분)
    if (!isImageBased) {
      for (const [page, count] of [...skippedImagePages.entries()].sort((a, b) => a[0] - b[0])) {
        warnings.push({ page, message: `${count}개 이미지 영역에 추출 가능한 텍스트 없음 (그림/차트/도장 내용 누락 가능)`, code: "SKIPPED_IMAGE" })
      }
    }

    // 머리글/바닥글 필터링 (기본 ON — 명시적 false일 때만 비활성화)
    if (options?.removeHeaderFooter !== false && parsedPageCount >= 3) {
      const removed = removeHeaderFooterBlocks(blocks, pageHeights, warnings)
      // 필터링된 블록 제거 (뒤에서부터 삭제)
      for (let ri = removed.length - 1; ri >= 0; ri--) {
        blocks.splice(removed[ri], 1)
      }
    }

    // 페이지 걸친 표 병합 — 머리글/바닥글 제거 후 인접해진 표를 하나로
    // (ODL TableBorderProcessor.checkNeighborTables 포팅)
    mergeCrossPageTables(blocks)

    // 수식 OCR (선택) — 기본 텍스트 추출과 별개로 페이지 이미지 렌더 후 수식만 검출/인식.
    // 실패 시 경고만 기록하고 일반 텍스트 추출 결과는 그대로 반환한다.
    if (options?.formulaOcr && formulaBuffer) {
      try {
        await applyFormulaOcr(formulaBuffer, blocks, pageFilter, effectivePageCount, warnings, options.onProgress)
      } catch (e) {
        warnings.push({
          message: `수식 OCR 실패: ${e instanceof Error ? e.message : String(e)}`,
          code: "PARTIAL_PARSE",
        })
      }
    }

    // 헤딩 감지: 폰트 크기 기반
    const medianFontSize = computeMedianFontSizeFromFreq(fontSizeFreq)
    if (medianFontSize > 0) {
      detectHeadings(blocks, medianFontSize)
    }

    // □/■ 마커 기반 서브헤딩 감지 (ODL 패턴)
    detectMarkerHeadings(blocks)

    // 표 캡션 감지 — 표 직전/직후 '표 N./그림 N' 패턴 텍스트를 IRTable.caption으로
    detectTableCaptions(blocks)

    // 한국어 리스트 감지 — 공문서 계층 라벨(1.→가.→1)→가)→①) 시퀀스 검증
    detectKoreanListBlocks(blocks)

    // outline 구축
    const outline: OutlineItem[] = blocks
      .filter(b => b.type === "heading" && b.level && b.text)
      .map(b => ({ level: b.level!, text: b.text!, pageNumber: b.pageNumber }))

    // 메트릭 수집 끝났으니 블록 텍스트의 C0/C1 제어문자(NUL 등) 정리
    sanitizeBlockControlChars(blocks)

    // blocksToMarkdown로 통일 — 헤딩 마크다운 반영 (HWP5/HWPX와 일관성)
    let markdown = cleanPdfText(blocksToMarkdown(blocks))

    return {
      markdown,
      blocks,
      metadata,
      outline: outline.length > 0 ? outline : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      isImageBased: isImageBased || undefined,
      pageQuality,
      qualitySummary: summarizeDocumentQuality(pageQuality),
    }
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
