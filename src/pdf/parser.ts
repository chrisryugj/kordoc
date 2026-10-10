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

import { escapeLiteralTags, stripScriptTags } from "../script-tags.js"
import type { InternalParseResult, IRBlock, DocumentMetadata, ExtractedImage, ParseOptions, ParseWarning, OutlineItem } from "../types.js"
import { KordocError } from "../utils.js"
import { parsePageRange, hasRequestedPagesAfter } from "../page-range.js"
import { blocksToPages } from "../page-markdown.js"
import { assignTableIds, blocksToMarkdown, escapeLiteralDollar } from "../table/builder.js"
import { unframeLayoutTables, CONTENT_CELLS, CELL_BASELINES } from "../table/layout-frames.js"
import { CELL_LINES, CLIP_TABLES, IMAGE_CELLS } from "./table-meta.js"
import { extractImageRegions, extractLines } from "./line-detector.js"
import { mergeOcrImageRegions, type ImageRegion } from "./ocr-region-merge.js"
import { createPdfImageState, extractPageImages, injectPageImageBlocks } from "./image-extract.js"
import { computePageQuality, summarizeDocumentQuality, type PageQuality } from "./quality.js"
import { scanVectorGlyphs, ocrVectorOps } from "./vector-glyphs.js"
import { type PdfTextItem, type NormItem, normalizeItems, filterHiddenText } from "./text-line.js"
import { extractPageBlocksWithLines, type PageCarry } from "./page-blocks.js"
import { WrapLexicon, joinPageBreakWraps, splitPageBreakWraps } from "./line-wrap.js"
import { mergeCrossPageTables } from "./table-parts.js"
import { splitPageTables } from "./table-pages.js"
import { mergeContinuedCells } from "./cell-continuation.js"
import { restoreUnmappedGlyphs } from "./symbol-glyphs.js"
import { trimTrailingEmptyTableCols } from "./table-trim.js"
import { selectionContextPages, marginContextBlocks } from "./selection-context.js"
import { restoreImageBullets } from "./image-bullets.js"
import { detectRightArrowRegions } from "./flow-boxes.js"
import { remapSymbolFontItems } from "./symbol-fonts.js"
import { wrapEquationRuns } from "./equation-runs.js"
import { remapControlGlyphs, restoreNamedGlyphs } from "./glyph-names.js"
import { occludedTextItems } from "./occluded-text.js"
import { joinVerticalColumns } from "./vertical-text.js"
import { restoreTrackedSpacing, markSyntheticSpaces, markTrailingSpaceGlyphs } from "./tracked-text.js"
import { relocateEndnotes } from "./endnotes.js"
import { dropTabLeaderDots } from "./tab-leaders.js"
import { orderTwoUpPage } from "./two-up.js"
import { removeSideTabs } from "./side-tabs.js"
import { superscriptNoteMarks, inlineFootnotes, footnoteSeparators, type PageNotes } from "./footnotes.js"
import { demoteNonHeadingRoles } from "./heading-demote.js"
import { computeMedianFontSizeFromFreq, detectHeadings, mergeStackedHeadingLines, detectTypographyHeadings, detectDocumentStyleHeadings, detectSiblingStyleHeadings, detectRepeatedPageLabels, detectPageLeadHeadings, refineDocumentStyleHeadings, detectMarkerHeadings, detectTableCaptions, detectKoreanListBlocks, removeHeaderFooterBlocks } from "./block-detect.js"
import { sanitizeBlockControlChars, cleanPdfText, splitSingleCellTables, joinLatinCellWraps } from "./text-clean.js"
import { applyLinkAnnotations, mergeLinkRuns } from "./links.js"
import { applyFormulaOcr } from "./formula-ocr.js"
// polyfill 먼저 (ES 모듈 호이스팅되므로 별도 파일 필수)
import "./polyfill.js"
import { getDocument, GlobalWorkerOptions, OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { ocrModelsCached } from "../ocr/models.js"
import { splitContactTables } from "./contact-table.js"

// 기존 공개 API 경로 유지 — 이동된 함수의 re-export

/**
 * 그림 영역 OCR 대상 — `ocr: true` 는 글 없는 그림 후보 전부(쪽 면적 2%+·머리 띠 로고), 기본값의 자동 OCR 은 쪽 면적 5% 넘는 큰
 * 그림만 읽는다(작은 아이콘·로고는 잡음 글이 되기 쉽고 쪽당 시간을 키운다). 큰 그림이 없는 쪽은 뺀다
 */
export function ocrImageRegions(regions: Map<number, ImageRegion[]>, large: Set<ImageRegion>, all: boolean): Map<number, ImageRegion[]> {
  if (all) return regions
  const out = new Map<number, ImageRegion[]>()
  for (const [p, rs] of regions) {
    const big = rs.filter(r => large.has(r))
    if (big.length) out.set(p, big)
  }
  return out
}

export { mergeCrossPageTables }
export { cleanPdfText }
export { detectTableCaptions, detectKoreanListBlocks, removeHeaderFooterBlocks }

// worker 비활성화 (polyfill에서 pdfjsWorker를 이미 주입했으므로)
GlobalWorkerOptions.workerSrc = ""

// ─── 안전 한계값 (구조적 파싱과 무관) ────────────────
const MAX_PAGES = 5000
const MAX_TOTAL_TEXT = 100 * 1024 * 1024 // 100MB
/** 문서 글꼴 캐시를 비우는 기준 — 마지막으로 비운 뒤 쪽들이 불러온 글꼴 사전 수. pdf.js 는 글꼴을 사전 단위로 문서 끝까지 쥔다
 *  (사전당 약 1.5MB, #137 제안요청서 30쪽 글꼴 사전 2,965개 = 힙 4.2GB). 코퍼스 PDF 1,911개의 문서당 글꼴 사전은 최대 155개라
 *  보통 문서는 비우지 않는다(비우면 다음 쪽 글꼴을 다시 변환한다) */
const FONT_CACHE_LIMIT = 256

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

/**
 * 글꼴을 받기만 하는 문서 (#137) — pdf.js 는 FontFace 를 못 쓰면(disableFontFace, Node 의 FontFace 부재) 글자마다 글리프 윤곽 경로를
 * 만들고, 그 렌더러가 글꼴 프로그램의 글리프를 전부 쪼개 글꼴 사전마다 따로 쥔다. kordoc 은 pdf.js 로 그리지 않아(OCR·수식 래스터는
 * pdfium) 경로가 필요 없다. 이 문서를 ownerDocument 로 주면 FontLoader 가 @font-face 규칙을 넣고(버림) Node 의 동기 글꼴 적재로
 * 끝나 경로를 만들지 않는다. Bullzip PDF Printer 공시 첨부(글꼴 파일 2개를 글꼴 사전 400여 개가 나눠 씀, 글리프 6.5만 개): 1쪽
 * getOperatorList 힙 3.6GB → 0.6GB. 쓰는 멤버는 FontLoader.insertRule·clear 뿐이다(pdfjs 4.10)
 */
const HEADLESS_FONT_DOCUMENT = {
  createElement: () => ({ sheet: { cssRules: [], insertRule() {} }, remove() {} }),
  documentElement: { getElementsByTagName: () => [{ append() {} }] },
} as unknown as HTMLDocument

/** getDocument 옵션 (data 제외) */
export const PDFJS_DOCUMENT_OPTIONS = {
  useSystemFonts: true,
  // 글꼴 /Differences 글리프 이름 — ToUnicode 없는 옛 숫자·작은 대문자 복원(glyph-names.ts)
  fontExtraProperties: true,
  disableFontFace: false,
  ownerDocument: HEADLESS_FONT_DOCUMENT,
  isEvalSupported: false,
  verbosity: 0, // 오류만 — 경고("Warning: Indexing all PDF objects")를 console.log 로 stdout 에 찍어 MCP·CLI JSON 을 깼다
  ...pdfjsAssets,
}

/** getDocument + 타임아웃 래퍼 */
async function loadPdfWithTimeout(buffer: ArrayBuffer) {
  const loadingTask = getDocument({
    // pdfjs transfers its input to the worker; retain the caller's buffer for reuse.
    data: new Uint8Array(buffer.slice(0)),
    ...PDFJS_DOCUMENT_OPTIONS,
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
  // ocr 을 지정하지 않으면(false 아님) 텍스트층 없는 쪽과 큰 그림 속 글을 자동 OCR — 내장 모델이 이미 캐시에 있을 때만(다운로드하지 않는다)
  const autoOcr = options?.ocr === undefined && await ocrModelsCached()
  const ocrBuffer: ArrayBuffer | null = options?.ocr || autoOcr ? buffer : null
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
    const pageWidths = new Map<number, number>()
    // 글꼴 id → 실제 서체 이름(서브셋 접두 뗌) — 제목 강등의 기울임·굵기 증거
    const faceNames = new Map<string, string>()
    // 큰 이미지가 있는 페이지 (needsOcr 경고 노이즈 필터 + SKIPPED_IMAGE)
    const pagesWithLargeImage = new Set<number>()
    // 텍스트 없는 큰 이미지 영역: page → count
    const skippedImagePages = new Map<number, number>()
    const uncoveredImageRegions = new Map<number, ImageRegion[]>()
    // 그 가운데 쪽 면적 5% 넘는 큰 그림 — 기본값(자동 OCR)은 이것만 읽는다 (ocrImageRegions)
    const largeImageRegions = new Set<ImageRegion>()
    // 이미지 XObject 바이트 추출 상태 (문서 단위 중복 억제·상한).
    // image 블록은 페이지 경계 표 병합(mergeCrossPageTables)의 인접성을 깨지 않도록
    // 페이지별로 모아뒀다가 병합 후 주입한다.
    const imageState = createPdfImageState()
    const imageBulletShapes = new Map<string, boolean>()
    const imageArrowDirections = new Map<string, -1 | 0 | 1>()
    const extractedImages: ExtractedImage[] = []
    const pageImageBlocks = new Map<number, IRBlock[]>()
    // 쪽을 넘는 칸 — 앞 쪽 마지막 칸을 다음 쪽 클립 판정에 넘긴다 (clip-cells continues, 문서 단계 mergeContinuedCells)
    const carry: PageCarry = {}
    // OCR 로 갈 벡터 글자 쪽의 그래픽(글자 경로·클립 뺀 연산자 목록) — OCR 글자에 이 쪽의 실제 괘선을 붙인다
    const vectorPageOps = new Map<number, { fnArray: number[]; argsArray: unknown[][] }>()
    // 줄 꺾임 이음의 문서 어휘 증거 — 쪽을 처리할 때마다 그 쪽 줄 글이 더해진다 (line-wrap.ts)
    const wrapLexicon = new WrapLexicon()
    // 쪽마다 본문 위첨자 각주 참조 표시("권고사항⁶⁾") — 쪽 아래 각주를 참조 문단으로 옮길 때 쓴다 (footnotes.ts)
    const noteMarks = new Map<number, PageNotes>()

    // A selected page alone cannot establish the existing three-page repetition rule.
    // Read only nearby text margins; context never enters output, OCR, counts or progress.
    const headerContext: IRBlock[] = []
    if (pageFilter && options?.removeHeaderFooter !== false && pageFilter.size < effectivePageCount) {
      for (const number of selectionContextPages(pageFilter, effectivePageCount)) {
        let contextPage: Awaited<ReturnType<typeof doc.getPage>> | undefined
        try {
          contextPage = await doc.getPage(number)
          const content = await contextPage.getTextContent()
          pageHeights.set(number, contextPage.view[3] - contextPage.view[1])
          headerContext.push(...marginContextBlocks(content.items as PdfTextItem[], number, contextPage.view))
        } catch { /* unavailable context leaves selected content intact */ }
        finally { contextPage?.cleanup() }
      }
    }

    let parsedPages = 0
    const loadedFonts = new Set<string>()
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
        pageWidths.set(i, pageW)
        const rawItems = tc.items as PdfTextItem[]
        // 선 기반 테이블 감지를 위한 operatorList — 글리프 이름 복원(restoreNamedGlyphs)이 공백 정리 전에 써서 먼저 받는다
        const rawOps = await page.getOperatorList()
        for (let k = 0; k < rawOps.fnArray.length; k++) if (rawOps.fnArray[k] === OPS.setFont) loadedFonts.add(rawOps.argsArray[k][0])
        // 폰트 실명·/Differences 는 operatorList 로드 뒤에야 commonObjs 에 있다
        const fontObj = (loadedName: string) => {
          try { return page.commonObjs.has(loadedName) ? page.commonObjs.get(loadedName) as { name?: string; isType3Font?: boolean } | null : undefined }
          catch { return undefined }
        }
        const differencesOf = (loadedName: string) => (fontObj(loadedName) as { differences?: ArrayLike<string | undefined> } | null | undefined)?.differences
        // 줄 끝 공백 글리프(어절 경계에서 꺾인 줄) — 아래 복원들이 아이템 글을 바꾸기 전에 흐름과 맞춘다
        markTrailingSpaceGlyphs(rawItems, rawOps.fnArray, rawOps.argsArray)
        restoreNamedGlyphs(rawItems, rawOps.fnArray, rawOps.argsArray, differencesOf, n => fontObj(n)?.name)
        // 유니코드 없는 기호 글리프(U+F000)는 글꼴 윤곽 모양으로 되살린다 — 한컴 자동 글머리표 "▸"·"□"·겹화살괄호 (symbol-glyphs.ts)
        restoreUnmappedGlyphs(rawItems, rawOps.fnArray, rawOps.argsArray, n => fontObj(n) as { data?: Uint8Array } | null | undefined)
        // 자간 벌린 글("E M A I L") — 글리프 흐름의 진짜 공백으로 낱말 경계를 되살린다
        restoreTrackedSpacing(rawItems, rawOps.fnArray, rawOps.argsArray)
        // pdfjs 가 글자 틈으로 만든 공백 아이템 표시 — 균등배분 판정이 진짜 공백 글리프에서만 끊도록
        markSyntheticSpaces(rawItems, rawOps.fnArray, rawOps.argsArray)
        // 뒤에 칠한 불투명 사각형에 가려진 글(쪽 배경 아래 깔린 머리글 등)은 보이지 않는다
        const occluded = occludedTextItems(rawItems, rawOps.fnArray, rawOps.argsArray)
        const items = normalizeItems(occluded.size ? rawItems.filter(it => !occluded.has(it)) : rawItems)

        // hidden text 필터링 + 경고 수집
        const filtered = filterHiddenText(items, pageW, pageH, viewX1, viewY1)
        // 세로쓰기 글상자(한 자씩 쌓은 기둥이 오른쪽→왼쪽)는 기둥마다 한 줄로
        const joined = joinVerticalColumns(filtered.visible)
        // 탭 채움 리더(가운뎃점)는 글이 아니다 — 목차 줄이 "제목 ···· 3" 로 남던 것. 글꼴 크기 빈도(제목 판정의 본문 크기)는 빼기 전
        // 아이템으로 센다 — 목차 긴 문서에서 리더 점 수천 개가 빠지면 중앙값이 흔들려 제목 판정이 통째로 바뀐다(강원 정보화 계획 402 → 233)
        const visible = dropTabLeaderDots(joined)
        const hiddenCount = filtered.hiddenCount + occluded.size
        if (hiddenCount > 0) {
          warnings.push({ page: i, message: `${hiddenCount}개 숨겨진 텍스트 요소 필터링됨`, code: "HIDDEN_TEXT_FILTERED" })
        }

        // 폰트 크기 빈도 수집
        for (const item of joined) {
          if (item.fontSize > 0) fontSizeFreq.set(item.fontSize, (fontSizeFreq.get(item.fontSize) || 0) + 1)
        }

        // 링크 어노테이션(/Annots /URI) → [text](url) 래핑 — 실패해도 텍스트 파싱 진행
        try {
          const annots = await page.getAnnotations()
          applyLinkAnnotations(visible, annots)
        } catch { /* 어노테이션 파싱 실패 무시 */ }

        // Downstream table/header/page-break geometry assumes an origin of (0,0).
        // Translate both text and graphics, after annotations have matched user coordinates.
        // Filtering alone would retain text but misclassify a repeated body as a header.
        const shifted = viewX1 !== 0 || viewY1 !== 0
        if (shifted) for (const item of visible) { item.x -= viewX1; item.y -= viewY1 }
        const opList = shifted ? {
          fnArray: [OPS.transform, ...rawOps.fnArray],
          argsArray: [[1, 0, 0, 1, -viewX1, -viewY1], ...rawOps.argsArray],
        } : rawOps

        // 심볼 폰트(Wingdings) 글리프 복원
        remapSymbolFontItems(visible, (loadedName) => fontObj(loadedName)?.name)
        remapControlGlyphs(visible, differencesOf)
        await restoreImageBullets(visible, page, opList.fnArray, opList.argsArray, imageBulletShapes)
        // 글꼴 id(g_d0_fN)는 글꼴 객체마다 다르다. 크롬은 한 서체를 Type3 글꼴 객체 여러 개(256자마다 새 객체)로 쪼개
        // 같은 본문이 "다른 서체"로 보여 제목으로 승격된다(#89). Type3 는 서브셋 접두(ABCDEF+)를 뗀 서체 이름으로 맞춘다.
        // 다른 글꼴은 같은 이름의 서브셋 객체 차이가 굵게 흉내 낸 제목의 유일한 증거일 수 있어 그대로 둔다(ODL 181 Calibri).
        // 서브셋 접두가 없는 Type3 이름(cairo "T2"·"T3")은 쪽마다 다른 글꼴에 되쓰여 합치지 않는다
        const faces = new Map<string, string>()
        for (const it of visible) {
          if (!it.fontName) continue
          let face = faces.get(it.fontName)
          if (face === undefined) {
            const obj = fontObj(it.fontName)
            face = (obj?.isType3Font && /^[A-Z]{6}\+./.test(obj.name ?? "") && obj.name!.slice(7)) || it.fontName
            faces.set(it.fontName, face)
          }
          it.fontName = face
          if (!faceNames.has(face)) faceNames.set(face, (fontObj(face)?.name ?? "").replace(/^[A-Z]{6}\+/, ""))
        }
        // 리터럴 $ 는 \$ — $…$ 는 수식 스팬 전용(IR 규약, HWPX·HWP5 와 같음). 종전엔 "단가(US $) … 금액(US $)" 사이가
        // 마크다운에서 수식으로 읽혀 사라졌다(야생생물 신고서·어셈블리 "lda $30,-16($30)"). 심볼 글꼴 복원 뒤라야 글자 표가 안 어긋난다
        for (const it of visible) if (it.text.includes("$")) it.text = escapeLiteralDollar(it.text)
        // 태그 모양 원문 글자 "<sub>"·"</sup>" 는 \<sub> — 첨자 끔(기본)·평문이 원문 글자까지 걷던 것 (#122, escapeLiteralTags)
        for (const it of visible) if (it.text.includes("<")) it.text = escapeLiteralTags(it.text)
        // 한컴 수식 글꼴 글자 → $…$ 수식 스팬 (HWPX·HWP5 수식 출력과 같은 모양, 리터럴 $ 이스케이프 뒤)
        wrapEquationRuns(visible, face => faceNames.get(face))

        // 이미지 영역 감지 — 텍스트 없는 큰 이미지는 무음 정보손실이므로 가시화 (ODL 아이디어)
        const pageArea = pageW * pageH
        if (pageArea > 0) {
          const imageRegions = extractImageRegions(opList.fnArray, opList.argsArray)
          let uncovered = 0
          for (const r of imageRegions) {
            const area = (r.x2 - r.x1) * (r.y2 - r.y1)
            // 쪽 면적 2% 넘는 그림은 OCR 영역 후보(로고 글 "LAW LIBRARY", ODL 085), 5% 넘는 것만 "읽지 못한 그림" 경고 — 1% 로 내리면
            // 아이콘이 잡음 글("0 0")로 들어와 제목 구조가 흐트러진다(ODL 200 실측)
            // 쪽 머리 띠(위 20%)의 작은 로고(0.5% 이상)도 — 기관·사업 이름이 로고 글로만 있다(ODL 147·148·150 "ECO Circle")
            const headerLogo = area >= pageArea * 0.005 && r.y1 >= pageH * 0.8
            if (area < pageArea * 0.02 && !headerLogo) continue // 작은 장식 이미지 무시
            const large = area >= pageArea * 0.05
            if (large) pagesWithLargeImage.add(i)
            const hasText = visible.some(it => {
              const cx = it.x + it.w / 2
              const cy = it.y + (it.h || it.fontSize) / 2
              return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2
            })
            if (!hasText) {
              if (large) uncovered++
              if (page.rotate % 360 === 0 && viewX1 === 0 && viewY1 === 0) {
                const regions = uncoveredImageRegions.get(i) ?? []
                regions.push(r)
                uncoveredImageRegions.set(i, regions)
                if (large) largeImageRegions.add(r)
              }
            }
          }
          if (uncovered > 0) skippedImagePages.set(i, uncovered)
        }

        // 본문 글 밖 여백에 세로로 돌려 찍은 글(arXiv 도장)은 가로 줄 흐름에 섞이면 옆 본문 줄에 붙는다 — 따로 떼어 쪽 첫 문단으로
        const marks = superscriptNoteMarks(visible)
        if (marks.length) noteMarks.set(i, { marks, seps: footnoteSeparators(extractLines(opList.fnArray, opList.argsArray).horizontals, pageW, pageH) })
        const stamp = marginStamp(visible)
        const flow = stamp.length ? visible.filter(it => !stamp.includes(it)) : visible
        // 가로 쪽 두 쪽 모아찍기는 왼쪽 쪽 → 오른쪽 쪽
        const rightArrows = options?.tables !== false ? await detectRightArrowRegions(page, opList.fnArray, opList.argsArray, imageArrowDirections) : []
        const pageBlocks = orderTwoUpPage(extractPageBlocksWithLines(flow, i, opList, pageW, pageH, undefined, options?.tables !== false, carry, wrapLexicon, rightArrows), pageW, pageH)
        if (stamp.length) pageBlocks.unshift({ type: "paragraph", text: [...stamp].sort((a, b) => a.y - b.y).map(it => it.text).join(" "), pageNumber: i })
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
      if (loadedFonts.size > FONT_CACHE_LIMIT) {
        await doc.cleanup()
        loadedFonts.clear()
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
    // 그림 영역 OCR — ocr: true 는 후보 전부, 자동 OCR(기본값)은 큰 그림만
    const ocrRegions = options?.ocr === true || autoOcr ? ocrImageRegions(uncoveredImageRegions, largeImageRegions, options?.ocr === true) : new Map<number, ImageRegion[]>()
    if (ocrBuffer) {
      const inScope = (p: number) => !pageFilter || pageFilter.has(p)
      const targets = new Set<number>()
      if (options?.ocr === "force" || isImageBased) {
        for (let i = 1; i <= effectivePageCount; i++) if (inScope(i)) targets.add(i)
      } else {
        for (const pq of pageQuality) {
          if (!pq.needsOcr) continue
          // low_text 는 빈 페이지(표지/간지)일 수 있으므로 큰 이미지가 있는 페이지만
          if (pq.ocrReason === "low_text" && !pagesWithLargeImage.has(pq.page)) continue
          // 자동 OCR 은 텍스트층이 없는 쪽만 — 글꼴 매핑이 깨진 쪽(텍스트층은 있다)은 ocr: true 로
          if (autoOcr && pq.ocrReason !== "low_text" && pq.ocrReason !== "vector_text") continue
          targets.add(pq.page)
        }
        for (const p of ocrRegions.keys()) targets.add(p)
      }
      if (targets.size > 0) {
        try {
          const { runPdfOcr } = await import("../ocr/pdf-ocr.js")
          const mode = typeof options?.ocr === "function" ? options.ocr : ("builtin" as const)
          // 텍스트층이 멀쩡한 쪽은 그림 영역만 읽는다 (쪽 전체를 갈아 끼우는 쪽 — 스캔·깨진 텍스트층 — 은 쪽 전체)
          const regionPages = new Map([...ocrRegions].filter(([p]) =>
            options?.ocr !== "force" && !isImageBased && !pageQuality.find(q => q.page === p)?.needsOcr))
          const ocrPageBlocks = await runPdfOcr(ocrBuffer, targets, mode, warnings, options?.onProgress, options?.tables !== false, vectorPageOps, regionPages)
          // OCR 글은 첨자를 가르지 않는다 — 검출 박스 높이·위치로는 기준선을 믿을 수 없다(scriptTags 를 켜도)
          for (const obs of ocrPageBlocks.values()) stripScriptTags({ blocks: obs })
          if (ocrPageBlocks.size > 0) {
            const replacePages = new Set<number>()
            for (const [p, obs] of ocrPageBlocks) {
              const needsOcr = pageQuality.find(q => q.page === p)?.needsOcr
              if (options?.ocr === "force" || isImageBased || needsOcr) {
                replacePages.add(p)
                ocrDone.add(p)
                continue
              }
              const regions = ocrRegions.get(p)
              if (!regions || mergeOcrImageRegions(blocks, p, regions, obs) === 0) continue
              ocrDone.add(p)
              // The extracted image remains in result.images; its Markdown placeholder
              // is replaced only when it was the sole image on the page.
              if (pageImageBlocks.get(p)?.length === 1) pageImageBlocks.delete(p)
            }
            if (replacePages.size) {
              const merged = blocks.filter(b => !(b.pageNumber && replacePages.has(b.pageNumber)))
              for (const [p, obs] of ocrPageBlocks) if (replacePages.has(p)) merged.push(...obs)
              merged.sort((a, b) => (a.pageNumber ?? 0) - (b.pageNumber ?? 0))
              blocks.length = 0
              blocks.push(...merged)
            }
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
        message: `이미지 기반 PDF (${pageCount}페이지, 텍스트 ${totalChars}자) — 텍스트 레이어가 없어 OCR이 필요합니다. ocr: true (CLI --ocr) 로 다시 파싱하면 읽습니다`,
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
        warnings.push({ page: pq.page, message: `${OCR_REASON_MESSAGES[pq.ocrReason]} — OCR 검토 필요 (ocr: true / CLI --ocr 로 다시 파싱)`, code: "NEEDS_OCR" })
      }
    }

    // 텍스트 없는 큰 이미지 영역 경고 — 그림/차트/도장 무음 누락 가시화
    // (문서 전체가 이미지 기반이면 위의 NEEDS_OCR 단일 경고로 충분)
    if (!isImageBased) {
      for (const [page, count] of [...skippedImagePages.entries()].sort((a, b) => a[0] - b[0])) {
        if (ocrDone.has(page)) continue
        warnings.push({ page, message: `${count}개 이미지 영역에 추출 가능한 텍스트 없음 (그림/차트/도장 내용 누락 가능 — 그림 속 글은 ocr: true / CLI --ocr 로 읽습니다)`, code: "SKIPPED_IMAGE" })
      }
    }

    // 머리글/바닥글 필터링 (기본 ON — 명시적 false일 때만 비활성화)
    if (options?.removeHeaderFooter !== false && (parsedPageCount >= 3 || headerContext.length)) {
      const removed = removeHeaderFooterBlocks(blocks, pageHeights, warnings, noteMarks, false, headerContext)
      // 필터링된 블록 제거 (뒤에서부터 삭제)
      for (let ri = removed.length - 1; ri >= 0; ri--) {
        blocks.splice(removed[ri], 1)
      }
      // 쪽 옆 띠의 장·절 색인 탭(좌우 바깥 띠에 되풀이되는 짧은 글)
      const kept = removeSideTabs(blocks, pageWidths)
      if (kept !== blocks) { blocks.length = 0; blocks.push(...kept) }
    }

    // 쪽을 넘는 칸의 1칸 조각을 앞 쪽 표 그 칸에 붙인 뒤(행으로 갈리지 않게) 페이지 걸친 표 병합 —
    // 머리글/바닥글 제거 후 인접해진 표를 하나로 (ODL TableBorderProcessor.checkNeighborTables 포팅)
    mergeContinuedCells(blocks, pageHeights)
    mergeCrossPageTables(blocks, pageHeights, wrapLexicon)
    // 괘선 상자 머리말·꼬리말(표 블록) — 쪽 넘김 표 병합 뒤라야 상자가 갈라 두던 이웃 쪽 표를 잇지 않는다 (block-detect.ts)
    if (options?.removeHeaderFooter !== false && parsedPageCount >= 3) {
      const boxes = removeHeaderFooterBlocks(blocks, pageHeights, warnings, noteMarks, true)
      for (let ri = boxes.length - 1; ri >= 0; ri--) blocks.splice(boxes[ri], 1)
    }
    // 칸 클립 없는 PDF 의 보도자료 연락처 표 4열 → HWPX 서식 6열 (contact-table.ts)
    splitContactTables(blocks)
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
    refineDocumentStyleHeadings(blocks)

    // □/■ 마커 기반 서브헤딩 감지 (ODL 패턴)
    detectMarkerHeadings(blocks)
    // 승격이 끝난 뒤 머리말·캡션·수식 번호 줄처럼 제목이 될 수 없는 역할을 되돌림
    demoteNonHeadingRoles(blocks, pageHeights, faceNames)

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
    // 1×1 상자는 원문 기하에서 얻은 문단·중첩표 순서로 편다. keep 모드의 원 구조는 반환 blocks 에 남긴다.
    let outBlocks = splitSingleCellTables(blocks)
    if (options?.layoutTables !== "keep") {
      blocks.length = 0
      for (const block of outBlocks) blocks.push(block)
    }
    // 문서 끝에 모인 미주(해설)를 본문 참조 자리 뒤로 — HWPX·HWP5 출력과 같은 순서
    // 쪽 아래 각주를 참조 문단 끝 " (주: …)" 로 — HWPX·HWP5 출력과 같은 자리
    outBlocks = inlineFootnotes(outBlocks, noteMarks)
    outBlocks = relocateEndnotes(outBlocks)
    // 쪽번호는 쪽 위·아래 가장자리 띠의 숫자 문단뿐이다 — 본문 한가운데 홀로 선 숫자(차트 축 눈금 "0"·"500", 장 번호 "2")는 글이다
    // removeHeaderFooter: false 면 쪽번호도 글로 남긴다(머리글·바닥글과 같은 쪽 가장자리 띠)
    if (options?.removeHeaderFooter !== false) outBlocks = outBlocks.filter(b => {
      if (b.type !== "paragraph" || !/^\s*\d{1,4}\s*$/.test(b.text ?? "")) return true
      const h = pageHeights.get(b.pageNumber ?? 0)
      if (!b.bbox || !h) return false
      return b.bbox.y > h * 0.1 && b.bbox.y + b.bbox.height < h * 0.9
    })
    joinLatinCellWraps(outBlocks)
    // 보이지 않는 틀 표 풀기 (v4.17.0, table/layout-frames) — 표 잇기(쪽 넘김·칸 이어짐)가 끝나 칸마다 보이는 변(cell-edges)이 제자리에
    // 있고 쪽번호 거르기(bbox 없는 문단을 버린다)도 지난 뒤. 새로 짠 표에는 PDF 표 곁정보(table-meta)가 없지만 여기서부터는 그 곁정보를
    // 보는 단계가 없다. 결과 blocks(쪽 넘김 잇기 뒤 원 목록)에도 같은 풀이를 쓴다 — 표 블록마다 한 번만 푼다(푸는 동안 칸을 제자리 고친다).
    // 클립 격자 풀기는 한컴 PDF 만 — 다른 제작기 클립 표는 테두리 없는 머리 행이 글로 풀려 표가 깨진다
    // (ODL 064 "PORT | SHIPCALLS" 머리 행: 한컴 원본 그림이 아니라 이 규칙의 정답이 없다)
    if (options?.layoutTables !== "keep") {
      const hancom = await isHancomPdf(doc)
      const shown = new Map<IRBlock, IRBlock[]>()
      // 그림 칸(IMAGE_CELLS)은 글이 비어도 내용이 있다 — 빈 여백 행으로 접히지 않게 (칸 안 표까지). 칸 글줄 기준선은 목차 행 짝짓기가 본다
      const markContent = (bs: IRBlock[] | undefined): void => {
        for (const b of bs ?? []) if (b.table) for (const row of b.table.cells) for (const c of row) {
          if (IMAGE_CELLS.has(c)) CONTENT_CELLS.add(c)
          const lines = CELL_LINES.get(c)
          if (lines) CELL_BASELINES.set(c, lines.map(l => l.y))
          markContent(c.blocks)
        }
      }
      const visual = (bs: IRBlock[]): IRBlock[] => bs.flatMap(b => {
        if (b.type !== "table") return [b]
        // 다른 제작기의 클립 머리행은 보존한다. 선 격자 밖에서 합성한 단위행은 제작기와 관계없이 문단이다.
        if (!hancom && b.table && CLIP_TABLES.has(b.table)) return [b]
        let v = shown.get(b)
        if (!v) { markContent([b]); shown.set(b, v = unframeLayoutTables([b], !!options?.keepTrailingEmptyCols)) }
        return v
      })
      outBlocks = visual(outBlocks)
      const kept = visual(blocks)
      blocks.length = 0
      for (const b of kept) blocks.push(b) // 큰 문서(수십만 블록)는 펼침 인자 상한을 넘는다
    }

    // blocksToMarkdown로 통일 — 헤딩 마크다운 반영 (HWP5/HWPX와 일관성)
    const finishMarkdown = (bs: IRBlock[]): string => mergeLinkRuns(cleanPdfText(blocksToMarkdown(bs, { tableFormat: options?.tableFormat }), { keepLoneNumbers: true }))
    // gfm 표 id 는 반환 blocks(IR) 순서로 먼저 — 마크다운용 outBlocks 는 같은 표 객체를 공유하므로 청크·쪽 렌더와 id 가 맞는다
    if (options?.tableFormat === "gfm") assignTableIds(blocks)
    let markdown = finishMarkdown(outBlocks)

    return {
      markdown,
      pages: blocksToPages(splitPageTables(splitPageBreakWraps(outBlocks)), finishMarkdown),
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

/** 한컴 PDF — Producer "Hancom PDF 1.3.0.xxx" 또는 Creator "Hwp 2018·2020 …" (법령 별표 273건 271건·표 정답 세트 한컴 산출물 실측).
 *  정보 사전을 못 읽거나 다른 제작기면 아니다 */
async function isHancomPdf(doc: { getMetadata(): Promise<unknown> }): Promise<boolean> {
  try {
    const info = (await doc.getMetadata() as { info?: Record<string, unknown> } | null)?.info
    return [info?.Producer, info?.Creator].some(v => typeof v === "string" && /^\s*(?:hancom\b|hwp\b)/i.test(v))
  } catch {
    return false
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

/** 쪽 여백의 세로 글 — 돌린 글 띠(시계 반대 90°는 기준점 왼쪽으로 글자 높이만큼)의 높이 범위에 놓인 가로 글이 모두 한쪽에만 있을 때 */
function marginStamp(items: NormItem[]): NormItem[] {
  const rotated = items.filter(it => it.rotated)
  if (rotated.length === 0) return []
  const flat = items.filter(it => !it.rotated)
  if (flat.length < 20) return []
  const outside = (it: NormItem) => {
    const x1 = it.x - it.fontSize, x2 = it.x + it.w + it.fontSize
    const beside = flat.filter(f => f.y >= it.y && f.y <= it.y + it.rotated!)
    return beside.length >= 5 && (beside.every(f => f.x >= x2) || beside.every(f => f.x + f.w <= x1))
  }
  return rotated.every(outside) ? rotated : []
}
