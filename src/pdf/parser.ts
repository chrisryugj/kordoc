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

import type { InternalParseResult, IRBlock, DocumentMetadata, ExtractedImage, ParseOptions, ParseWarning, OutlineItem } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange, hasRequestedPagesAfter } from "../page-range.js"
import { blocksToPages } from "../page-markdown.js"
import { blocksToMarkdown, escapeLiteralDollar } from "../table/builder.js"
import { extractImageRegions } from "./line-detector.js"
import { createPdfImageState, extractPageImages, injectPageImageBlocks } from "./image-extract.js"
import { computePageQuality, summarizeDocumentQuality, type PageQuality } from "./quality.js"
import { scanVectorGlyphs, ocrVectorOps } from "./vector-glyphs.js"
import { type PdfTextItem, normalizeItems, filterHiddenText } from "./text-line.js"
import { extractPageBlocksWithLines, type PageCarry } from "./page-blocks.js"
import { WrapLexicon, joinPageBreakWraps } from "./line-wrap.js"
import { mergeCrossPageTables } from "./table-parts.js"
import { mergeContinuedCells } from "./cell-continuation.js"
import { trimTrailingEmptyTableCols } from "./table-trim.js"
import { remapSymbolFontItems } from "./symbol-fonts.js"
import { computeMedianFontSizeFromFreq, detectHeadings, mergeStackedHeadingLines, detectTypographyHeadings, detectDocumentStyleHeadings, detectSiblingStyleHeadings, detectRepeatedPageLabels, detectPageLeadHeadings, detectMarkerHeadings, detectTableCaptions, detectKoreanListBlocks, removeHeaderFooterBlocks } from "./block-detect.js"
import { sanitizeBlockControlChars, cleanPdfText, splitSingleCellTables } from "./text-clean.js"
import { applyLinkAnnotations } from "./links.js"
import { applyFormulaOcr } from "./formula-ocr.js"
// polyfill 먼저 (ES 모듈 호이스팅되므로 별도 파일 필수)
import "./polyfill.js"
import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
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
    // pdfjs transfers its input to the worker; retain the caller's buffer for reuse.
    data: new Uint8Array(buffer.slice(0)),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0, // 오류만 — 경고("Warning: Indexing all PDF objects")를 console.log 로 stdout 에 찍어 MCP·CLI JSON 을 깼다
    ...pdfjsAssets,
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      loadingTask.promise.catch((e: unknown) => {
        if (e instanceof Error && e.name === "PasswordException") throw new KordocError("암호로 보호된 PDF 파일입니다 (PDF 열기 암호는 지원하지 않습니다)")
        throw e
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => { loadingTask.destroy(); reject(new KordocError("PDF 로딩 타임아웃 (30초 초과)")) }, PDF_LOAD_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export async function parsePdfDocument(buffer: ArrayBuffer, options?: ParseOptions): Promise<InternalParseResult> {
  // pdfjs receives a copy; both OCR paths can reuse the caller's original bytes.
  const formulaBuffer: ArrayBuffer | null = options?.formulaOcr ? buffer : null
  const ocrBuffer: ArrayBuffer | null = options?.ocr ? buffer : null
  const doc = await loadPdfWithTimeout(buffer)

  try {
    const pageCount = doc.numPages
    if (pageCount === 0) throw new KordocError("PDF에 페이지가 없습니다.")

    // 메타데이터 추출 (best-effort) — PDF는 항상 실제 페이지 단위 (#66)
    const metadata: DocumentMetadata = { pageCount, pageMode: "layout" }
    await extractPdfMetadata(doc, metadata)

    const blocks: IRBlock[] = []
    const warnings: ParseWarning[] = []
    const pageQuality: PageQuality[] = []
    let totalChars = 0
    let totalTextBytes = 0
    const effectivePageCount = Math.min(pageCount, MAX_PAGES)

    // 페이지 범위 필터링
    const pageFilter = options?.pages ? parsePageRange(options.pages, effectivePageCount) : null
    if (pageCount > MAX_PAGES && (!options?.pages || hasRequestedPagesAfter(options.pages, MAX_PAGES, pageCount))) {
      warnings.push({ message: `${pageCount}쪽 중 앞 ${MAX_PAGES}쪽만 파싱했습니다 (쪽 수 상한)`, code: "PARTIAL_PARSE" })
    }
    const totalTarget = pageFilter ? pageFilter.size : effectivePageCount

    // 전체 문서의 폰트 크기 빈도 수집 (헤딩 감지용) — 빈도 Map으로 메모리 절약
    const fontSizeFreq = new Map<number, number>()
    const pageHeights = new Map<number, number>()
    // 큰 이미지가 있는 페이지 (needsOcr 경고 노이즈 필터 + SKIPPED_IMAGE)
    const pagesWithLargeImage = new Set<number>()
    // 텍스트 없는 큰 이미지 영역: page → count
    const skippedImagePages = new Map<number, number>()
    // 이미지 XObject 바이트 추출 상태 (문서 단위 중복 억제·상한).
    // image 블록은 페이지 경계 표 병합(mergeCrossPageTables)의 인접성을 깨지 않도록
    // 페이지별로 모아뒀다가 병합 후 주입한다.
    const imageState = createPdfImageState()
    const extractedImages: ExtractedImage[] = []
    const pageImageBlocks = new Map<number, IRBlock[]>()
    // 쪽을 넘는 칸 — 앞 쪽 마지막 칸을 다음 쪽 클립 판정에 넘긴다 (clip-cells continues, 문서 단계 mergeContinuedCells)
    const carry: PageCarry = {}
    // OCR 로 갈 벡터 글자 쪽의 그래픽(글자 경로·클립 뺀 연산자 목록) — OCR 글자에 이 쪽의 실제 괘선을 붙인다
    const vectorPageOps = new Map<number, { fnArray: number[]; argsArray: unknown[][] }>()
    // 줄 꺾임 이음의 문서 어휘 증거 — 쪽을 처리할 때마다 그 쪽 줄 글이 더해진다 (line-wrap.ts)
    const wrapLexicon = new WrapLexicon()

    let parsedPages = 0
    for (let i = 1; i <= effectivePageCount; i++) {
      if (pageFilter && !pageFilter.has(i)) continue
      let loadedPage: Awaited<ReturnType<typeof doc.getPage>> | undefined
      try {
        const page = await doc.getPage(i)
        loadedPage = page
        const tc = await page.getTextContent()
        // Text and paths use unrotated user coordinates, including the CropBox origin.
        const [viewX1, viewY1, viewX2, viewY2] = page.view
        const pageW = viewX2 - viewX1, pageH = viewY2 - viewY1
        pageHeights.set(i, pageH)
        const rawItems = tc.items as PdfTextItem[]
        const items = normalizeItems(rawItems)

        // hidden text 필터링 + 경고 수집
        const { visible, hiddenCount } = filterHiddenText(items, pageW, pageH, viewX1, viewY1)
        if (hiddenCount > 0) {
          warnings.push({ page: i, message: `${hiddenCount}개 숨겨진 텍스트 요소 필터링됨`, code: "HIDDEN_TEXT_FILTERED" })
        }

        // 폰트 크기 빈도 수집
        for (const item of visible) {
          if (item.fontSize > 0) fontSizeFreq.set(item.fontSize, (fontSizeFreq.get(item.fontSize) || 0) + 1)
        }

        // 링크 어노테이션(/Annots /URI) → [text](url) 래핑 — 실패해도 텍스트 파싱 진행
        try {
          const annots = await page.getAnnotations()
          applyLinkAnnotations(visible, annots)
        } catch { /* 어노테이션 파싱 실패 무시 */ }

        // 선 기반 테이블 감지를 위한 operatorList
        const rawOps = await page.getOperatorList()
        // Downstream table/header/page-break geometry assumes an origin of (0,0).
        // Translate both text and graphics, after annotations have matched user coordinates.
        // Filtering alone would retain text but misclassify a repeated body as a header.
        const shifted = viewX1 !== 0 || viewY1 !== 0
        if (shifted) for (const item of visible) { item.x -= viewX1; item.y -= viewY1 }
        const opList = shifted ? {
          fnArray: [OPS.transform, ...rawOps.fnArray],
          argsArray: [[1, 0, 0, 1, -viewX1, -viewY1], ...rawOps.argsArray],
        } : rawOps

        // 심볼 폰트(Wingdings) 글리프 복원 — 폰트 실명은 operatorList 로드 뒤에야 commonObjs 에 있다
        remapSymbolFontItems(visible, (loadedName) => {
          try { return page.commonObjs.has(loadedName) ? (page.commonObjs.get(loadedName) as { name?: string } | null)?.name : undefined }
          catch { return undefined }
        })
        // 리터럴 $ 는 \$ — $…$ 는 수식 스팬 전용(IR 규약, HWPX·HWP5 와 같음). 종전엔 "단가(US $) … 금액(US $)" 사이가
        // 마크다운에서 수식으로 읽혀 사라졌다(야생생물 신고서·어셈블리 "lda $30,-16($30)"). 심볼 글꼴 복원 뒤라야 글자 표가 안 어긋난다
        for (const it of visible) if (it.text.includes("$")) it.text = escapeLiteralDollar(it.text)

        // 이미지 영역 감지 — 텍스트 없는 큰 이미지는 무음 정보손실이므로 가시화 (ODL 아이디어)
        const pageArea = pageW * pageH
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

        const pageBlocks = extractPageBlocksWithLines(visible, i, opList, pageW, pageH, undefined, options?.tables !== false, carry, wrapLexicon)
        for (const b of pageBlocks) blocks.push(b)

        // 이미지 XObject 바이트 추출 — 블록 주입은 표 병합 후(injectPageImageBlocks)
        // images:false 면 PNG 인코딩을 건너뛰고 자리 표시 블록만 받는다
        try {
          const { blocks: imgBlocks, images: pageImages } = await extractPageImages(page, opList.fnArray, opList.argsArray, i, imageState, warnings, options?.images !== false)
          if (imgBlocks.length > 0) pageImageBlocks.set(i, imgBlocks)
          extractedImages.push(...pageImages)
        } catch { /* 이미지 추출 실패가 텍스트 파싱을 막지 않도록 */ }

        // 이미지 기반 PDF 감지 + 크기 제한용 문자 수 집계 + 페이지 품질 신호
        let pageText = ""
        for (const b of pageBlocks) {
          let t = b.text || ""
          // 표 블록은 text 없이 table만 가지므로 셀 텍스트도 집계 — 괘선 양식(표-전용)
          // 문서가 totalChars=0으로 이미지 기반 오판되어 정상 파싱 표가 OCR로
          // 대체되는 것 방지. 페이지 품질(computePageQuality) 집계도 같은 뿌리.
          if (b.type === "table" && b.table) {
            const cellText = b.table.cells.map(row => row.map(c => c.text).join(" ")).join("\n")
            t = t ? t + "\n" + cellText : cellText
          }
          totalChars += t.replace(/\s/g, "").length
          totalTextBytes += t.length * 2
          pageText += pageText ? "\n" + t : t
        }
        // 텍스트층 밖 곡선 글자 — 글자를 채운 경로로 그린 쪽은 텍스트층 신호만으론 멀쩡해 보인다 (vector-glyphs.ts)
        const vector = scanVectorGlyphs(opList.fnArray, opList.argsArray, visible)
        const quality = computePageQuality(i, pageText, vector.glyphs)
        pageQuality.push(quality)
        // 회전·원점 이동 쪽은 pdfium 래스터 좌표가 사용자 공간과 어긋나 종전대로(래스터 괘선) 둔다
        if (options?.ocr && quality.ocrReason === "vector_text" && page.rotate % 360 === 0 && page.view[0] === 0 && page.view[1] === 0) {
          vectorPageOps.set(i, ocrVectorOps(opList, vector.paths))
        }
        if (totalTextBytes > MAX_TOTAL_TEXT) throw new KordocError("텍스트 추출 크기 초과")
        parsedPages++
        options?.onProgress?.(parsedPages, totalTarget)
      } catch (pageErr) {
        // 크기 초과는 전체 중단
        if (pageErr instanceof KordocError) throw pageErr
        warnings.push({ page: i, message: `페이지 ${i} 파싱 실패: ${pageErr instanceof Error ? pageErr.message : "알 수 없는 오류"}`, code: "PARTIAL_PARSE" })
      } finally {
        // Release page-local decoded images/operators on success and failure.
        // commonObjs (shared fonts/images) remains available to later pages.
        loadedPage?.cleanup()
      }
    }

    const parsedPageCount = parsedPages || (pageFilter ? pageFilter.size : effectivePageCount)
    // 문서 단위 이미지 기반 판정 (평균 10자/페이지 미만 = 텍스트층 부재)
    const isImageBased = pageFilter?.size !== 0 && totalChars / Math.max(parsedPageCount, 1) < 10

    // ── OCR 실행 (옵션) — 페이지 단위 선정·병합 ──
    // 대상: "force"=전 페이지 / 문서가 이미지 기반=전 페이지 /
    //       그 외=품질 신호가 OCR 을 권하는 페이지만 (깨진 텍스트층 포함 — F1,
    //       혼합 문서의 스캔 페이지 포함 — F2). 정상 페이지 파싱 결과는 유지 (F3).
    const ocrDone = new Set<number>()
    if (options?.ocr && ocrBuffer) {
      const inScope = (p: number) => !pageFilter || pageFilter.has(p)
      const targets = new Set<number>()
      if (options.ocr === "force" || isImageBased) {
        for (let i = 1; i <= effectivePageCount; i++) if (inScope(i)) targets.add(i)
      } else {
        for (const pq of pageQuality) {
          if (!pq.needsOcr) continue
          // low_text 는 빈 페이지(표지/간지)일 수 있으므로 큰 이미지가 있는 페이지만
          if (pq.ocrReason === "low_text" && !pagesWithLargeImage.has(pq.page)) continue
          targets.add(pq.page)
        }
      }
      if (targets.size > 0) {
        try {
          const { runPdfOcr } = await import("../ocr/pdf-ocr.js")
          const mode = typeof options.ocr === "function" ? options.ocr : ("builtin" as const)
          const ocrPageBlocks = await runPdfOcr(ocrBuffer, targets, mode, warnings, options.onProgress, options.tables !== false, vectorPageOps)
          if (ocrPageBlocks.size > 0) {
            // 페이지 단위 교체: OCR 성공 페이지의 기존(깨진/빈) 블록 제거 후 병합
            for (const p of ocrPageBlocks.keys()) ocrDone.add(p)
            const merged = blocks.filter(b => !(b.pageNumber && ocrDone.has(b.pageNumber)))
            for (const obs of ocrPageBlocks.values()) for (const b of obs) merged.push(b)
            merged.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0)) // stable — 페이지 내 순서 보존
            blocks.length = 0
            for (const b of merged) blocks.push(b)
            for (const pq of pageQuality) if (ocrDone.has(pq.page)) pq.ocrApplied = true
            warnings.push({
              message: `${ocrDone.size}개 페이지에 OCR 적용 (${mode === "builtin" ? "내장 PP-OCRv5" : "사용자 프로바이더"})`,
              code: "OCR_APPLIED",
            })
          }
        } catch (e) {
          // 환경 오류(의존성·모델) — 아래 NEEDS_OCR 폴백이 가시화, 원인은 별도 경고로 보존 (F6)
          warnings.push({
            message: `OCR 실행 불가: ${e instanceof Error ? e.message : String(e)}`,
            code: "OCR_FAILED",
          })
        }
      }
    }

    if (isImageBased && ocrDone.size === 0) {
      // OCR 미설정/실패 — 빈 출력을 무경고로 내보내지 않고 경고 + 플래그로 가시화 (v3.0)
      warnings.push({
        message: `이미지 기반 PDF (${pageCount}페이지, 텍스트 ${totalChars}자) — 텍스트 레이어가 없어 OCR이 필요합니다`,
        code: "NEEDS_OCR",
      })
    }

    // 페이지 단위 needsOcr 경고 — 텍스트+스캔 혼합 문서에서 스캔 페이지 무음 손실 방지.
    // low_text는 빈 페이지(표지/간지)일 수 있으므로 큰 이미지가 있는 페이지만 경고.
    // OCR 이 적용된 페이지는 해소된 것이므로 제외.
    if (!isImageBased) {
      const OCR_REASON_MESSAGES: Record<string, string> = {
        vector_text: "글자를 곡선(벡터 경로)으로 그린 페이지 (텍스트층에 글자 없음)",
        low_text: "텍스트가 거의 없는 페이지 (스캔/이미지 추정)",
        high_pua: "글꼴 매핑 실패 (PUA 비율 높음) — 추출 텍스트 신뢰 불가",
        high_control: "제어문자 비율 높음 — 추출 텍스트 신뢰 불가",
        high_replacement: "대체문자(U+FFFD) 비율 높음 — 추출 텍스트 신뢰 불가",
        garbled_hangul: "글꼴 매핑 실패 (한글 자소 분포 이상) — 추출 텍스트가 깨졌을 수 있음",
      }
      for (const pq of pageQuality) {
        if (!pq.needsOcr || !pq.ocrReason || pq.ocrApplied) continue
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

    // 쪽을 넘는 칸의 1칸 조각을 앞 쪽 표 그 칸에 붙인 뒤(행으로 갈리지 않게) 페이지 걸친 표 병합 —
    // 머리글/바닥글 제거 후 인접해진 표를 하나로 (ODL TableBorderProcessor.checkNeighborTables 포팅)
    mergeContinuedCells(blocks, pageHeights)
    mergeCrossPageTables(blocks, pageHeights)
    // 후행 빈 열 정리 — HWP 계열 표 빌더와 같은 규칙 (병합 뒤: 쪽마다 같은 열 구조일 때 이어 붙인 다음)
    if (!options?.keepTrailingEmptyCols) trimTrailingEmptyTableCols(blocks)
    // 쪽 넘김으로 꺾인 본문 문단 잇기 — 머리말·꼬리말 제거 뒤, 쪽 끝 그림 주입 전 (line-wrap.ts)
    joinPageBreakWraps(blocks, wrapLexicon)

    // 추출 이미지 참조를 페이지 말미 위치에 주입 (표 병합 뒤 — 인접성 보존)
    injectPageImageBlocks(blocks, pageImageBlocks)

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
    detectDocumentStyleHeadings(blocks)
    detectTypographyHeadings(blocks)
    detectSiblingStyleHeadings(blocks)
    detectRepeatedPageLabels(blocks)
    detectPageLeadHeadings(blocks)
    mergeStackedHeadingLines(blocks, medianFontSize)

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
    // 1×1 표(중첩 없음)는 줄마다 문단으로 — 셀 줄바꿈이 mergeKoreanLines 에 붙지 않게 (v4.12.3)
    const outBlocks = splitSingleCellTables(blocks)

    // blocksToMarkdown로 통일 — 헤딩 마크다운 반영 (HWP5/HWPX와 일관성)
    const finishMarkdown = (bs: IRBlock[]): string => cleanPdfText(blocksToMarkdown(bs))
    let markdown = finishMarkdown(outBlocks)

    return {
      markdown,
      pages: blocksToPages(outBlocks, finishMarkdown),
      blocks,
      metadata,
      outline: outline.length > 0 ? outline : undefined,
      warnings: warnings.length > 0 ? warnings : undefined,
      isImageBased: isImageBased || undefined,
      pageQuality,
      qualitySummary: summarizeDocumentQuality(pageQuality),
      images: extractedImages.length > 0 ? extractedImages : undefined,
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
