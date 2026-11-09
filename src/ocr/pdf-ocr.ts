/**
 * PDF OCR 브릿지 — 대상 페이지를 hayro 로 래스터해 내장 엔진 또는
 * 사용자 OcrProvider 로 인식하고, 페이지별 IRBlock[] 을 돌려준다.
 *
 * - 내장 엔진: OcrItem 좌표를 PDF 포인트로 환산해 기존 블록 파이프라인
 *   (extractPageBlocksWithLines — xy-cut 읽기순서·클러스터 표 감지)에 태운다.
 *   스캔 문서도 표 구조 복원이 가능한 이유.
 * - 사용자 프로바이더: 페이지 PNG → 텍스트 → 페이지당 paragraph 블록 (종전 계약).
 *
 * 에러 계약 (v4.1.0 리뷰 F6/F7):
 * - 환경 오류(의존성·모델 미설치, PDF 오픈 실패)는 throw — 호출자가 NEEDS_OCR 폴백.
 * - 페이지 단위 실패는 본문 오염 대신 warnings(OCR_FAILED) 로 기록하고 계속.
 */

import { splitStackedOcrRows, unframeOcrLayoutTables } from "./ocr-stacked-rows.js"
import { splitOcrNameValueColumns } from "./ocr-name-value-columns.js"
import type { IRBlock, OcrLine, OcrPageLines, OcrProvider, ParseOptions, ParseWarning } from "../types.js"
import type { NormItem } from "../pdf/text-line.js"
import type { LineSegment } from "../pdf/line-types.js"
import { extractPageBlocksWithLines } from "../pdf/page-blocks.js"
import { UNRULED_REGION_TABLES } from "../pdf/ocr-region-merge.js"
import { detectRulingLines, rulingToPdfLines, type RulingLines } from "./ruling-lines.js"
import { DEFAULT_OCR_TUNING, getOcrEngine, type OcrItem, type OcrPageStats, type OcrTuning } from "./engine.js"
import { deskewPage, rotateQuarter } from "./deskew.js"
import { copyOcrTextGaps } from "./text-gaps.js"
import { similarity } from "../diff/text-diff.js"
import { DEFAULT_OCR_MODELS, ensureOcrModelsFor, handwritingFallbackModels, ocrModelsCached, resolveOcrModels, type OcrModelSelection } from "./models.js"
import { validateOcrOptions } from "./options.js"
import { chartPlotItems } from "./ocr-chart-axes.js"
import { splitOcrContactColumns } from "./ocr-contact-columns.js"
import { splitOcrJoinedHeaders } from "./ocr-header-split.js"
import { splitOcrProseRows } from "./ocr-prose-rows.js"
import { rescueEmptyCells } from "./empty-cell-rescue.js"
import { KordocError, OPTIONAL_DEP_INSTALL_HINT } from "../utils.js"
import { openHayro, rasterPage, type RasterPage } from "../pdf/hayro.js"

/** OCR 렌더 스케일 (72dpi × 3 = 216dpi) — 10pt 본문이 rec 입력 높이(48px)에 근접 */
const OCR_RENDER_SCALE = 3
/**
 * OCR 래스터 픽셀 상한 (쪽·이미지 공통) — 이보다 큰 쪽은 배율을 낮춰 이 안에 맞춘다. 쪽 크기를 가리지 않고 ×3 으로 그리면 628B PDF
 * (4000pt 정사각 쪽)가 12000² 래스터에 사본·괘선 마스크까지 2.38GB 를 먹었다(16000² PNG 1.84GB). A2(1191×1684pt)도 216dpi 로 18MP 라
 * 공문서 판형은 줄지 않는다
 */
export const MAX_OCR_PIXELS = 24_000_000
/** 페이지 하나당 OCR 타임아웃 — det+rec 수십 라인 기준 넉넉히 */
const PAGE_TIMEOUT_MS = 120_000

export type OcrMode = "builtin" | OcrProvider

/** 내장 엔진 설정 — 모델 선택·튜닝·줄 내보내기 (ParseOptions 의 ocrDet·ocrDetLongSide·ocrRec·ocrRecDict·ocrLines) */
export interface BuiltinOcrConfig {
  models: OcrModelSelection
  tuning: Readonly<OcrTuning>
  /** 줄 내보내기 — undefined 면 끔(종전과 같은 일만 한다) */
  lines?: "kept" | "all"
  /** 확신도 낮은 쪽을 다시 읽을 손글씨 rec 모델 — 기본 설정·`ocrRec: "auto"` */
  handwriting?: OcrModelSelection
  /** 손글씨 rec 로 바꿀 문턱 — 쪽 평균 확신도 상한·확신도 상승 하한. lazy 면 모델을 미리 받지 않고 받기·인식 실패는 기본 rec 결과로 둔다.
   *  fetch 가 없으면(OCR 을 따로 켜지 않은 자동 OCR) 캐시에 있을 때만 쓴다 — 자동 OCR 은 내려받지 않는다 */
  autoRec?: { pageConf: number; gain: number; altConf?: number; sureGain?: number; minDiff?: number; minChars?: number; lazy?: true; fetch?: true }
}

/** 저신뢰로 버린 줄이 많은 쪽을 큰 검출로 다시 읽는 문턱 (recognizeOcrPage) */
const REDETECT = { minDropped: 15, minShare: 0.15, scale: 5 / 3 }

/** `ocrRec: "auto"` 문턱 — 쪽 평균 확신도(글자 수 가중)가 이보다 낮은 쪽만 손글씨 rec 로 다시 읽고, 평균이 gain 이상 오를 때만 바꾼다.
 *  KoOCR-Bench 손글씨 쪽은 기본 rec .74~.90 → 손글씨 rec +.07~.22, 인쇄 쪽은 .87~.98 에 대개 +.05 이하였다 */
const AUTO_REC = { pageConf: 0.9, gain: 0.06 }
/** 기본 설정 문턱 — 쪽 확신도 .9 아래에서 손글씨 rec 가 +.10 넘게 오르면 바꾸고, +.08~.10 이면 손글씨 rec 확신도 .95 이상·두 결과 글
 *  8% 이상 차이·글자 80자 이상일 때만 바꾼다(altConf·minDiff·minChars). 인쇄 시험지(기본 .84~.90)는 손글씨 rec 로 +.066~.077·확신도
 *  .91~.94 에 그치고(수능 수학 CER .65 → .86 으로 망가졌다), 잡음 낀 인쇄 스캔은 .95 를 넘어도 두 rec 가 거의 같은 글을 읽으며(차이
 *  .007~.07), 짧은 영역(목차 64자)은 평균이 흔들린다. 손글씨 쪽은 +.08 넘게 올라 .95 를 넘고 글이 8.5~15% 다르다(기본 rec 가 실제로
 *  틀림). 종전(.85·.10)은 .85~.90 손글씨 쪽을 놓쳤다 */
const DEFAULT_AUTO_REC = { pageConf: 0.9, gain: 0.08, altConf: 0.95, sureGain: 0.1, minDiff: 0.08, minChars: 80, lazy: true as const }

export const DEFAULT_BUILTIN_OCR: Readonly<BuiltinOcrConfig> = Object.freeze({
  models: DEFAULT_OCR_MODELS, tuning: DEFAULT_OCR_TUNING, handwriting: handwritingFallbackModels(DEFAULT_OCR_MODELS), autoRec: DEFAULT_AUTO_REC,
})
/** OCR 을 켠(`ocr: true`·`"force"`) 기본 설정 — 손글씨 쪽을 처음 만나면 손글씨 rec 를 받는다 */
const DEFAULT_BUILTIN_OCR_FETCH: Readonly<BuiltinOcrConfig> = Object.freeze({ ...DEFAULT_BUILTIN_OCR, autoRec: { ...DEFAULT_AUTO_REC, fetch: true as const } })

/** ParseOptions → 내장 엔진 설정. 옵션이 없으면 기본 설정 객체 그대로. 잘못된 옵션은 throw — parse() 는 먼저 걸러 실패 결과로 낸다 */
export function builtinOcrConfig(o: ParseOptions | undefined): Readonly<BuiltinOcrConfig> {
  if (!o || (o.ocrDet === undefined && o.ocrDetLongSide === undefined && o.ocrRec === undefined && o.ocrRecDict === undefined && !o.ocrLines)) return o?.ocr ? DEFAULT_BUILTIN_OCR_FETCH : DEFAULT_BUILTIN_OCR
  const bad = validateOcrOptions(o)
  if (bad) throw new KordocError(bad)
  const models = resolveOcrModels(o)
  return {
    models,
    ...(o.ocrRec === "auto" ? { handwriting: handwritingFallbackModels(models), autoRec: AUTO_REC }
      : o.ocrRec === undefined ? { handwriting: handwritingFallbackModels(models), autoRec: o.ocr ? { ...DEFAULT_AUTO_REC, fetch: true as const } : DEFAULT_AUTO_REC } : {}),
    tuning: o.ocrDetLongSide === undefined ? DEFAULT_OCR_TUNING : { ...DEFAULT_OCR_TUNING, detLongSide: o.ocrDetLongSide },
    lines: o.ocrLines === "all" ? "all" : o.ocrLines ? "kept" : undefined,
  }
}

/** 쪽 인식 — 손글씨 rec 가 있으면(기본·`ocrRec: "auto"`) 확신도 낮은 쪽을 손글씨 rec 로 다시 읽어 더 확신하는 쪽을 쓴다(stats 도 고른 쪽 것으로) */
export async function recognizeOcrPage(
  engine: Awaited<ReturnType<typeof getOcrEngine>>, config: Readonly<BuiltinOcrConfig>, tuning: Readonly<OcrTuning>,
  rgba: Uint8Array, width: number, height: number, stats: OcrPageStats,
  cellRules?: Array<{ x1: number; y1: number; y2: number; thicknessPx: number }>, rowRules?: Array<{ x1: number; x2: number; y1: number; thicknessPx: number }>,
): Promise<OcrItem[]> {
  const read = async (t: Readonly<OcrTuning>, st: OcrPageStats) => {
    const items = await engine.recognizePage(rgba, width, height, st, t, cellRules, rowRules)
    return st.pageRotation ? items : withHandwritingRec(items, config, t, rgba, width, height, st, cellRules, rowRules)
  }
  const items = await read(tuning, stats)
  // 검출 상자 여럿이 저신뢰로 버려진 쪽 — 검출 크기를 5/3 배로 키워 다시 읽고(손글씨 rec 판정까지) 버린 줄이 줄고 확신도가 오르면 그것을
  // 쓴다. 하늘 수채화 바탕 손편지(640×920)는 960 검출에서 글줄이 획 조각으로 갈려 124줄 중 66줄을 버려 CER .51 이었고, 1600 검출 +
  // 손글씨 rec 면 버린 줄 0·CER .15. 검출 크기를 늘 키우면 손글씨 쪽 다수가 나빠졌다(1280 일괄 반려) — KoOCR 손글씨 108쪽 중 버린 줄
  // 15+·전체 줄 15%+ 인 쪽은 둘뿐(그 밖은 7줄 이하)
  if (!tuning.redetect || stats.pageRotation || stats.droppedLowConf < REDETECT.minDropped || stats.droppedLowConf < (items.length + stats.droppedLowConf) * REDETECT.minShare) return items
  const bigStats: OcrPageStats = { droppedLowConf: 0, ...(stats.dropped ? { dropped: [] } : {}) }
  const big = await read({ ...tuning, detLongSide: Math.round(tuning.detLongSide * REDETECT.scale) }, bigStats)
  if (bigStats.pageRotation || bigStats.droppedLowConf >= stats.droppedLowConf || meanConfidence(big) <= meanConfidence(items)) return items
  Object.assign(stats, bigStats)
  return big
}

/** 확신도 낮은 쪽을 손글씨 rec 로 다시 읽어 더 확신하는 쪽을 쓴다(stats 도 고른 쪽 것으로) */
async function withHandwritingRec(
  items: OcrItem[], config: Readonly<BuiltinOcrConfig>, tuning: Readonly<OcrTuning>,
  rgba: Uint8Array, width: number, height: number, stats: OcrPageStats,
  cellRules?: Array<{ x1: number; y1: number; y2: number; thicknessPx: number }>, rowRules?: Array<{ x1: number; x2: number; y1: number; thicknessPx: number }>,
): Promise<OcrItem[]> {
  if (!config.handwriting) return items
  const auto: NonNullable<BuiltinOcrConfig["autoRec"]> = config.autoRec ?? AUTO_REC
  const base = meanConfidence(items)
  if (base >= auto.pageConf) return items
  const altStats: OcrPageStats = { droppedLowConf: 0, ...(stats.dropped ? { dropped: [] } : {}) }
  let alt: OcrItem[]
  try {
    if (auto.lazy && !auto.fetch && !await ocrModelsCached(config.handwriting)) return items
    if (auto.lazy) await ensureOcrModelsFor(config.handwriting, reportModelDownload)
    alt = await (await getOcrEngine(config.handwriting)).recognizePage(rgba, width, height, altStats, tuning, cellRules, rowRules)
  } catch (e) {
    // 기본 설정은 손글씨 rec 를 고르지 않았다 — 받기(오프라인)·인식 실패는 기본 rec 결과로 둔다
    if (!auto.lazy) throw e
    return items
  }
  const altMean = meanConfidence(alt)
  if (altMean - base < auto.gain) return items
  if (auto.altConf !== undefined && altMean - base < (auto.sureGain ?? Infinity)) {
    if (altMean < auto.altConf) return items
    const text = (xs: OcrItem[]) => xs.map(it => it.text).join("").replace(/\s/g, "")
    const a = text(items), b = text(alt)
    if (a.length < (auto.minChars ?? 0) || 1 - similarity(a, b) < (auto.minDiff ?? 0)) return items
  }
  Object.assign(stats, altStats)
  return alt
}

/** 다운로드를 알린 모델 — 진행 콜백은 받은 조각마다 오고 첫 콜백도 downloaded > 0 이라, 종전 조건(downloaded === 0)으로는 안내가 나가지 않았다 */
const announced = new Set<string>()

/** 내장 모델 다운로드 안내 (stderr, 모델마다 한 번) */
export function reportModelDownload(p: { phase: string; downloaded: number; spec: { name: string; filename: string; sizeMb: number } }): void {
  if (p.phase !== "download" || announced.has(p.spec.filename)) return
  announced.add(p.spec.filename)
  process.stderr.write(`[kordoc-ocr] ${p.spec.name} 다운로드 중 (~${p.spec.sizeMb}MB)...\n`)
}

/** OcrItem(래스터 px) → 결과 줄 */
export function toOcrLine(it: OcrItem, dropped = false): OcrLine {
  return { text: it.text, box: { x: it.x, y: it.y, w: it.w, h: it.h }, confidence: it.confidence, ...(dropped ? { dropped: true as const } : {}) }
}

/** 쪽 줄 묶음 — 블록에 쓴 줄 + (all) 버린 줄을 위→아래, 왼→오른 순으로 */
export function pageLines(pageNumber: number, width: number, height: number, scale: number, deskewAngle: number,
  kept: OcrItem[], dropped: OcrItem[] = [], regionsOnly = false): OcrPageLines {
  const lines = [...kept.map(it => toOcrLine(it)), ...dropped.map(it => toOcrLine(it, true))]
    .sort((a, b) => (a.box.y - b.box.y) || (a.box.x - b.box.x))
  return { pageNumber, width, height, scale, deskewAngle, ...(regionsOnly ? { regionsOnly: true as const } : {}), lines }
}

/** 위아래 끝이 모두 가로 괘선에 닿는 세로선 — 표 칸 경계 */
export function cellEdgeVerticals(r: RulingLines): RulingLines["verticals"] {
  const touches = (x: number, y: number) => r.horizontals.some(h => Math.abs(h.y1 - y) <= h.thicknessPx + 3 && h.x1 - 3 <= x && h.x2 + 3 >= x)
  return r.verticals.filter(v => touches(v.x1, Math.min(v.y1, v.y2)) && touches(v.x1, Math.max(v.y1, v.y2)))
}

/** 양끝이 모두 세로 괘선에 닿는 가로선 — 표 행 경계 */
export function cellEdgeHorizontals(r: RulingLines): RulingLines["horizontals"] {
  const touches = (x: number, y: number) => r.verticals.some(v => Math.abs(v.x1 - x) <= v.thicknessPx + 3 && Math.min(v.y1, v.y2) - 3 <= y && Math.max(v.y1, v.y2) + 3 >= y)
  return r.horizontals.filter(h => touches(Math.min(h.x1, h.x2), h.y1) && touches(Math.max(h.x1, h.x2), h.y1))
}

/** pdfjs 연산자 목록 (그래픽만 쓴다 — 괘선·채움·그림 영역) */
export type PageOps = { fnArray: Uint32Array | number[]; argsArray: unknown[][] }

/**
 * 대상 페이지들을 OCR 해 페이지별 블록 맵 반환.
 * @param buffer 원본 PDF (pdfjs 가 detach 하기 전에 clone 해 둔 것)
 * @param targets 1-based 페이지 번호 집합
 * @param vectorOps 벡터 글자 쪽(글자를 곡선으로 그린 쪽)의 그래픽(vector-glyphs.ts ocrVectorOps) — 그 쪽은 표 구조를
 *   래스터 괘선 감지 대신 이것(실제 괘선)으로 복원한다. 스캔 쪽은 벡터가 없으니 없다
 */
export async function runPdfOcr(
  buffer: ArrayBuffer,
  targets: Set<number>,
  mode: OcrMode,
  warnings: ParseWarning[],
  onProgress?: (current: number, total: number) => void,
  detectTables = true,
  vectorOps?: Map<number, PageOps>,
  imageRegions?: Map<number, Array<{ x1: number; y1: number; x2: number; y2: number }>>,
  config: Readonly<BuiltinOcrConfig> = DEFAULT_BUILTIN_OCR,
  /** config.lines 일 때 쪽별 OCR 줄을 여기에 모은다 */
  linesOut?: Map<number, OcrPageLines>,
): Promise<Map<number, IRBlock[]>> {
  const result = new Map<number, IRBlock[]>()
  if (targets.size === 0) return result

  // 환경 준비 — 실패는 그대로 throw (호출자가 NEEDS_OCR 폴백)
  if (mode === "builtin") await ensureOcrModelsFor(config.models, reportModelDownload)
  if (mode === "builtin" && config.handwriting && !config.autoRec?.lazy) await ensureOcrModelsFor(config.handwriting, reportModelDownload)
  const engine = mode === "builtin" ? await getOcrEngine(config.models) : null

  // 쪽 래스터는 hayro 렌더(흰 바탕 RGBA)
  const doc = await openHayro(new Uint8Array(buffer))
  try {
    let done = 0
    // 대상 쪽만 그린다. 쪽 번호는 0-based — 대외 계약(1-based)으로 환산
    const count = doc.pageCount()
    for (const pageNo of [...targets].filter(p => p >= 1 && p <= count).sort((a, b) => a - b)) {
      const page = rasterPage(doc, pageNo - 1)
      onProgress?.(++done, targets.size)
      try {
        const { blocks, lines } = await withTimeout(
          ocrOnePage(page, pageNo, mode, engine, warnings, detectTables, vectorOps?.get(pageNo), imageRegions?.get(pageNo), config),
          PAGE_TIMEOUT_MS,
          `OCR 페이지 ${pageNo} 타임아웃 (${PAGE_TIMEOUT_MS / 1000}초)`,
        )
        result.set(pageNo, blocks)
        // 줄은 블록과 함께 받은 쪽만 — 타임아웃으로 버린 쪽이 뒤늦게 끝나도 섞이지 않는다
        if (lines) linesOut?.set(pageNo, lines)
      } catch (e) {
        warnings.push({
          page: pageNo,
          message: `페이지 ${pageNo} OCR 실패: ${e instanceof Error ? e.message : String(e)}`,
          code: "OCR_FAILED",
        })
      }
    }
  } finally {
    doc.close()
  }
  return result
}

export async function ocrOnePage(
  page: RasterPage,
  pageNo: number,
  mode: OcrMode,
  engine: Awaited<ReturnType<typeof getOcrEngine>> | null,
  warnings: ParseWarning[],
  detectTables: boolean,
  vectorOps?: PageOps,
  regions?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  config: Readonly<BuiltinOcrConfig> = DEFAULT_BUILTIN_OCR,
): Promise<{ blocks: IRBlock[]; lines?: OcrPageLines }> {
  let { originalWidth: pdfW, originalHeight: pdfH } = page.getOriginalSize()
  const renderScale = Math.min(OCR_RENDER_SCALE, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, pdfW * pdfH)))
  if (renderScale < OCR_RENDER_SCALE) {
    warnings.push({ page: pageNo, code: "PARTIAL_PARSE", message: `OCR 래스터 픽셀 상한으로 렌더 해상도를 축소했습니다 (작은 글자 인식 결손 가능)` })
  }
  // 그림 영역만 읽는 쪽은 두 배로 한 번 그려 영역 다시 읽기(closer)에 쓰고, 쪽 배율 래스터는 2×2 평균으로 줄여 만든다
  const closer = regions && mode === "builtin" && renderScale * 2 <= Math.sqrt(MAX_OCR_PIXELS / Math.max(1, pdfW * pdfH))
  const rendered = await page.render({
    scale: closer ? renderScale * 2 : renderScale,
    render: async ({ data }) => data,
  })
  const hiRgba = closer ? bgraToRgba(rendered.data) : null
  let { rgba, width: rw, height: rh } = hiRgba
    ? halve(hiRgba, rendered.width, rendered.height)
    : { rgba: bgraToRgba(rendered.data), width: rendered.width, height: rendered.height }

  if (mode === "builtin") {
    // 스캔 기울기 보정 — 인식과 괘선 감지가 같은(바로 선) 래스터를 본다. 클린 렌더는 무보정.
    // 벡터 글자·그림 영역 쪽은 PDF 원본 좌표를 유지한다. 회전하면 벡터 괘선·영역 경계 및
    // 원본 래스터를 잘라 읽는 closerReads와 좌표계가 달라져 줄 선택·병합이 어긋난다.
    let { rgba: upright, angle } = vectorOps || regions ? { rgba, angle: 0 } : deskewPage(rgba, rw, rh)
    const stats: OcrPageStats = { droppedLowConf: 0, ...(config.lines === "all" ? { dropped: [] } : {}) }
    let ruling = vectorOps ? undefined : detectRulingLines(upright, rw, rh, rh / pdfH)
    // 그림 영역만 읽는 쪽은 표 행 경계 보강선(isolated)을 뺀다 — 도해 상자·화살표 선이 행 경계로 잡혀 이름표 읽기 순서가 흔들렸다(ODL 055 팜유 흐름도)
    if (ruling && regions) ruling = { ...ruling, horizontals: ruling.horizontals.filter(h => !h.isolated) }
    // 눕힌 쪽 판정은 쪽 래스터 전체를 읽을 때만 — 벡터 글자 쪽은 벡터 괘선, 그림 영역은 PDF 좌표를 그대로 써야 한다
    const tuning = regions ? regionTuning(config.tuning) : vectorOps ? { ...config.tuning, orientPage: false } : config.tuning
    // 검출 박스가 표 칸 경계를 가로지르면 그 선에서 가른다 — 연한 칸 구분선(cellDividers)만이 아니라 진한 칸 경계도. 촘촘한 표에서
    // 검출기가 이웃 칸 글을 한 줄로 묶었다(검정고시 계획 과목 표). 칸 경계 = 위아래 끝이 모두 가로 괘선에 닿는 세로선 — 끝이 떠 있는
    // 여백선·단 구분선은 글줄을 가르면 안 된다(속기록 2단)
    // 위아래 두 행을 한 박스로 묶은 검출도 그 사이 행 경계(양끝이 세로 괘선에 닿는 가로선)에서 가른다
    let items = await recognizeOcrPage(engine!, config, tuning, upright, rw, rh, stats, ruling ? [...(ruling.cellDividers ?? []), ...cellEdgeVerticals(ruling)] : undefined,
      ruling ? cellEdgeHorizontals(ruling) : undefined)
    // 가로 표를 눕혀 찍은 쪽 — 래스터를 세워 괘선부터 다시 읽는다. 쪽 가로·세로도 바꿔 블록 상자는 세운 쪽 기준이다
    if (stats.pageRotation) {
      ({ rgba: upright, width: rw, height: rh } = rotateQuarter(upright, rw, rh, stats.pageRotation));
      [pdfW, pdfH] = [pdfH, pdfW]
      delete stats.pageRotation
      ruling = detectRulingLines(upright, rw, rh, rh / pdfH)
      items = await recognizeOcrPage(engine!, config, { ...tuning, orientPage: false }, upright, rw, rh, stats,
        [...(ruling.cellDividers ?? []), ...cellEdgeVerticals(ruling)], cellEdgeHorizontals(ruling))
    }
    // 쪽 검출이 놓친 빈 칸 글 — 괘선 칸만 잘라 다시 읽는다(empty-cell-rescue). 그림 영역·벡터 글자 쪽은 쪽 래스터를 다 읽지 않는다
    if (ruling && !regions && !vectorOps && config.tuning.postprocess) items = [...items, ...await rescueEmptyCells(engine!, tuning, upright, rw, rh, ruling, items)]
    if (stats.droppedLowConf > 0) {
      warnings.push({
        page: pageNo,
        message: `페이지 ${pageNo}: 저신뢰 OCR 라인 ${stats.droppedLowConf}개 폐기 (인식 결손 가능)`,
        code: "OCR_LOW_CONF",
      })
    }
    if (stats.truncatedBoxes) {
      warnings.push({ page: pageNo, message: `페이지 ${pageNo}: OCR 검출 상자가 너무 많아 ${stats.truncatedBoxes}개는 인식하지 않음 (일부 글 결손)`, code: "PARTIAL_PARSE" })
    }
    const scale = rh / pdfH
    /** 블록과 함께 돌려줄 쪽 줄 (config.lines 일 때만) */
    const withLines = (blocks: IRBlock[], kept: OcrItem[], regionsOnly = false) =>
      config.lines ? { blocks, lines: pageLines(pageNo, rw, rh, scale, angle, kept, stats.dropped, regionsOnly) } : { blocks }
    // 텍스트층이 있는 쪽의 그림 영역만 읽을 때는 영역마다 그 안 글줄로 따로 블록을 만든다 — 쪽 전체로 묶으면 본문 줄과 그림 글이
    // 한 문단으로 합쳐져 영역 판정(mergeOcrImageRegions)에서 빠진다
    if (regions) {
      const inside = (it: OcrItem, r: { x1: number; y1: number; x2: number; y2: number }) => {
        const cx = (it.x + it.w / 2) / scale, cy = pdfH - (it.y + it.h / 2) / scale
        return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2
      }
      const reads = hiRgba ? await closerReads(hiRgba, rw * 2, rh * 2, pdfH, scale * 2, regions, engine!, tuning) : []
      /** 영역마다 쓴 줄 — 겹친 두 영역이 같은 줄을 쓰면 한 번만 */
      const used = new Set<OcrItem>()
      /** 두 배 래스터로 다시 읽은 쪽을 쓴 영역 — 그 영역의 쪽 배율 인식(버린 줄 포함)은 쓰지 않았다 */
      const reread = new Set<number>()
      const regionBlocks = regions.flatMap((r, k) => {
        let own = items.filter(it => inside(it, r))
        // 그림 속 글은 작다(차트 눈금·범례 6~8pt) — 영역만 두 배로 다시 읽어 글자 수로 가중한 평균 신뢰도가 높은 쪽을 쓴다
        const near = reads[k]
        if (near?.length && meanConfidence(near) > meanConfidence(own)) { own = near; reread.add(k) }
        if (!own.length) return []
        for (const it of own) used.add(it)
        const blocks = ocrItemsToBlocks(own, pageNo, pdfW, pdfH, scale, ruling && rulingToPdfLines(ruling, scale, pdfH), detectTables, undefined, true)
        // 영역 안 세로 괘선이 둘 미만이면 그 영역의 OCR 표는 글 정렬만으로 묶은 것이다 — 그림 영역 병합이 표로 받지 않는다
        const x1 = r.x1 * scale - 2, x2 = r.x2 * scale + 2, y1 = (pdfH - r.y2) * scale - 2, y2 = (pdfH - r.y1) * scale + 2
        const columnRules = ruling?.verticals.filter(s => Math.min(s.x1, s.x2) >= x1 && Math.max(s.x1, s.x2) <= x2 && Math.min(s.y1, s.y2) >= y1 && Math.max(s.y1, s.y2) <= y2).length ?? 0
        if (columnRules < 2) for (const b of blocks) if (b.type === "table") UNRULED_REGION_TABLES.add(b)
        return blocks
      })
      // 그림 영역 쪽의 버린 줄은 쪽 전체 인식에서 나온 것이라 영역 밖 줄도 섞인다 — 쪽 배율 인식을 쓴 영역 안 것만
      if (stats.dropped) stats.dropped = stats.dropped.filter(it => regions.some((r, k) => !reread.has(k) && inside(it, r)))
      return withLines(regionBlocks, [...used], true)
    }
    // 벡터 글자 쪽: 표 구조는 그 쪽의 실제 괘선으로 (rhwp cairo 13쌍 46표 exact: 래스터 괘선 14 → 실제 괘선 20)
    if (vectorOps) return withLines(ocrItemsToBlocks(items, pageNo, pdfW, pdfH, scale, undefined, detectTables, vectorOps), items)
    // 래스터에서 표 괘선 감지 — 스캔본 병합셀 서식도 선 기반 표 파이프라인을 탄다
    const extraLines = rulingToPdfLines(ruling!, scale, pdfH)
    return withLines(ocrItemsToBlocks(items, pageNo, pdfW, pdfH, scale, extraLines, detectTables), items)
  }

  // 사용자 프로바이더 — PNG 인코딩 후 호출, 페이지당 paragraph (종전 계약)
  type SharpPngFactory = (
    input: Uint8Array,
    opts: { raw: { width: number; height: number; channels: number } },
  ) => { png(): { toBuffer(): Promise<Buffer> } }
  const sharpModRaw = await tryImport<{ default?: SharpPngFactory } & SharpPngFactory>(
    "sharp",
    () => import("sharp") as unknown as Promise<{ default?: SharpPngFactory } & SharpPngFactory>,
  )
  const sharpAny = sharpModRaw as { default?: SharpPngFactory } | SharpPngFactory
  const sharp: SharpPngFactory =
    typeof sharpAny === "function" ? sharpAny : (sharpAny.default ?? (sharpAny as unknown as SharpPngFactory))
  const png = await sharp(rgba, { raw: { width: rw, height: rh, channels: 4 } })
    .png()
    .toBuffer()

  const text = await mode(new Uint8Array(png), pageNo, "image/png")
  if (!text.trim()) {
    warnings.push({ page: pageNo, message: `페이지 ${pageNo} OCR 결과 없음`, code: "OCR_FAILED" })
    return { blocks: [] }
  }
  return { blocks: [{ type: "paragraph", text: text.trim(), pageNumber: pageNo }] }
}

/** 2×2 평균 축소 (RGBA) */
function halve(src: Uint8Array, w: number, h: number): { rgba: Uint8Array; width: number; height: number } {
  const W = w >> 1, H = h >> 1
  const out = new Uint8Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const a = ((2 * y) * w + 2 * x) * 4, b = a + w * 4, o = (y * W + x) * 4
    for (let c = 0; c < 4; c++) out[o + c] = (src[a + c] + src[a + 4 + c] + src[b + c] + src[b + 4 + c] + 2) >> 2
  }
  return { rgba: out, width: W, height: H }
}

/** 그림 영역만 읽을 때 — 끝자락 지우기를 끈다 (engine OcrTuning.trimEdges 주석) */
const REGION_TUNING: Readonly<OcrTuning> = Object.freeze({ ...DEFAULT_OCR_TUNING, trimEdges: false, orientPage: false, redetect: false })
const regionTuning = (t: Readonly<OcrTuning>): Readonly<OcrTuning> => t === DEFAULT_OCR_TUNING ? REGION_TUNING : { ...t, trimEdges: false, orientPage: false, redetect: false }

function meanConfidence(items: OcrItem[]): number {
  let n = 0, sum = 0
  for (const it of items) { const len = [...it.text].length; n += len; sum += it.confidence * len }
  return n ? sum / n : 0
}

/**
 * 옅은 그림 글 명암 늘리기 — 투명도(소프트 마스크)를 씌운 글 그림은 흰 바탕에 휘도 230 언저리로 그려져 검출기가 글줄을 못 잡았다
 * (ODL 184 각주 띠 "1 Evaluated against …", 그림 파일만 따로 읽으면 읽힌다). 영역 휘도의 어두운 끝(1%)이 밝은 끝(99%)과 120 넘게
 * 차이 나지 않으면 그 폭을 0~255 로 늘린다 — 대비가 제대로 된 영역은 그대로
 */
export function stretchFaintCrop(rgba: Uint8Array): void {
  const n = rgba.length >> 2
  if (!n) return
  const hist = new Uint32Array(256)
  for (let i = 0; i < n; i++) hist[(rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8]++
  let lo = 0, hi = 255
  for (let acc = 0; lo < 255 && (acc += hist[lo]) < n * 0.01;) lo++
  for (let acc = 0; hi > 0 && (acc += hist[hi]) < n * 0.01;) hi--
  if (hi - lo >= 120 || hi - lo < 16) return
  const k = 255 / (hi - lo)
  for (let i = 0; i < n * 4; i++) if ((i & 3) !== 3) rgba[i] = Math.max(0, Math.min(255, Math.round((rgba[i] - lo) * k)))
}

/** 그림 영역마다 두 배 래스터에서 잘라 다시 인식한 글줄 — 좌표는 쪽 배율 래스터 기준으로 되돌린다 */
async function closerReads(
  rgba: Uint8Array, rw: number, rh: number, pdfH: number, hi: number,
  regions: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  engine: NonNullable<Awaited<ReturnType<typeof getOcrEngine>>>,
  tuning: Readonly<OcrTuning> = REGION_TUNING,
): Promise<Array<OcrItem[] | null>> {
  const out: Array<OcrItem[] | null> = []
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x1 * hi)), y0 = Math.max(0, Math.floor((pdfH - r.y2) * hi))
    const cw = Math.min(rw, Math.ceil(r.x2 * hi)) - x0, ch = Math.min(rh, Math.ceil((pdfH - r.y1) * hi)) - y0
    if (cw < 16 || ch < 16) { out.push(null); continue }
    const crop = new Uint8Array(cw * ch * 4)
    for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((y0 + y) * rw + x0) * 4, ((y0 + y) * rw + x0 + cw) * 4), y * cw * 4)
    // 글 한 줄 띠(가로가 높이 6배 이상)만 — 큰 그림(손글씨 판서 사진, ODL 106)까지 늘리면 잡음 글이 달라졌다
    if (cw >= ch * 6) stretchFaintCrop(crop)
    const items = await engine.recognizePage(crop, cw, ch, undefined, tuning)
    out.push(items.map(it => {
      const placed = { ...it, x: (it.x + x0) / 2, y: (it.y + y0) / 2, w: it.w / 2, h: it.h / 2 }
      copyOcrTextGaps(it, placed, 0.5, x0 / 2)
      return placed
    }))
  }
  return out
}

/**
 * OcrItem(렌더 픽셀, top-left origin) → NormItem(PDF pt, bottom-up baseline)
 * 으로 환산해 기존 블록 파이프라인에 태운다. 괘선은 래스터 감지 결과(extraLines)로
 * 공급 — 없으면 클러스터 감지기 몫이다. 벡터 글자 쪽은 그 쪽 그래픽 연산자 목록(opList)을
 * 넘겨 실제 괘선을 쓴다.
 * (이미지 직접 입력 경로 image-ocr.ts 와 공유)
 */
/**
 * OCR 박스를 줄로 묶는다(박스 번호 묶음). 같은 줄 조각도 글자 크기(큰 대표 줄)·숫자 하강부·기울어진 감열지 때문에 박스 아래 끝이
 * 몇 pt 씩 어긋나, 박스마다 아래 끝을 기준선으로 넘기면 블록 파이프라인의 줄 묶음(3pt)이 한 줄을 여럿으로 쪼개고 위쪽 y 순으로
 * 뒤집는다(#141 영수증: "탄현점 / 이마트", 품목 바코드·단가·금액이 다른 행). 중심 y 차이 ≤ 작은 박스 높이의 절반이면 한 줄,
 * 가로로 크게 겹치는 박스는 같은 줄에 넣지 않는다(큰 로고 박스가 위아래 두 줄을 잇지 않게).
 * 한 줄 조각은 높이가 엇비슷하다 — 줄 높이 중앙값과 두 배 넘게 다른 박스는 인식 신뢰도 0.8 미만 박스(아이콘·로고·QR 잡음)가 낄 때
 * 묶지 않는다. 높이는 줄 높이 중앙값과 잰다(줄의 작은 숫자 박스 하나와 재면 두 행에 걸친 칸 박스가 제 행을 놓친다, changwon-plan2026
 * "3/8"). 신뢰도가 높으면 높이 차가 커도 같은 줄 — 기울어진 스캔의 긴 글줄 박스는 기울기만큼 키가 크고 체크 표 "√" 옆 라벨·두 줄이 한
 * 박스로 붙은 칸도 2~2.7배다(열화 서식 OCR 다섯 쪽 CER 상승). 그림 영역에서는 높이의 8배 넘게 떨어진 조각은 세로 중심이 작은 박스
 * 높이의 0.35 안일 때만 같은 줄(차트 범례와 먼 축 눈금 — 쪽 전체 OCR 의 서식 먼 칸은 쪽이 기운 만큼 어긋난다). 긴 글줄(폭이 높이의
 * 7배 이상 — 서식 라벨 "주민등록번호" 6배는 아니다, 숫자가 30% 넘는 금액 칸도 아니다 — 예산 표 행의 항목명과 "경정4,200,000원")은 줄 안
 * 가장 가까운 긴 글줄과 높이의 5배 넘게 떨어지면 묶지 않는다(범례 라벨 사이 3~4배는 한 줄). 짧은 조각(숫자·라벨 칸)은 멀어도 묶는다
 * (영수증 금액 칸).
 * 두 단 글의 좌우 줄은 높이가 엇비슷해도 다른 줄이다(ODL 141 두 단 카드 인포그래픽: 좌우 카드 줄 틈 7~60배 — 4.21.3 에서 한 줄로
 * 묶여 단 분리가 깨지고 가짜 표가 됐다, NID 0.96 → 0.44).
 */
/** 긴 글줄 상자 — 폭이 높이의 7배 이상이고 숫자가 글자의 30% 미만(금액 칸 "경정4,200,000원"·"210mm×297mm" 은 표 칸이다) */
const proseBox = (b: OcrItem) => {
  const t = b.text.replace(/\s/g, "")
  return b.w >= b.h * 7 && (t.match(/\d/g)?.length ?? 0) < t.length * 0.3
}

export function groupOcrLines(items: OcrItem[], figureRegion = false): number[][] {
  const order = items.map((_, i) => i).sort((a, b) => (items[a].y + items[a].h / 2) - (items[b].y + items[b].h / 2))
  const accepts = (l: number[], i: number): boolean => {
    const it = items[i], c = it.y + it.h / 2
    const lc = l.reduce((s, j) => s + items[j].y + items[j].h / 2, 0) / l.length
    const minH = Math.min(it.h, ...l.map(j => items[j].h))
    if (Math.abs(c - lc) > minH / 2) return false
    const hs = l.map(j => items[j].h).sort((a, b) => a - b), med = hs[hs.length >> 1]
    const weak = it.confidence < 0.8 || l.some(j => items[j].confidence < 0.8)
    if (weak && Math.max(it.h, med) > Math.min(it.h, med) * 2) return false
    let nearLong = 0, gap = Infinity
    for (const j of l) {
      const o = items[j]
      // 박스는 잉크 외곽에 여백이 붙어 이웃 낱말과 조금 겹친다(이마트·탄현점 32px) — 좁은 쪽 폭의 절반 넘게 겹칠 때만 다른 줄
      const ov = Math.min(it.x + it.w, o.x + o.w) - Math.max(it.x, o.x)
      if (ov >= Math.min(it.w, o.w) / 2) return false
      gap = Math.min(gap, Math.max(0, -ov))
      if (proseBox(it) && proseBox(o)) nearLong = Math.min(nearLong || Infinity, Math.max(0, -ov) / Math.min(it.h, o.h))
    }
    // 그림 영역에서 높이의 8배 넘게 떨어진 조각은 세로로 거의 같은 줄이어야 한다 — 영수증 먼 칸은 중심 어긋남이 작은 박스 높이의 0.22 안, 원그래프
    // 값과 범례(ODL 148 "18.9%"·"Project Manager")는 0.31, 차트 범례 라벨과 멀리 왼쪽 축 눈금은 0.37~0.47 이라 반쯤 어긋난 채 묶여
    // 기준선이 옮겨지고 읽기 순서가 바뀌었다(ODL 128·140·057)
    if (figureRegion && gap > 8 * minH && Math.abs(c - lc) > minH * 0.35) return false
    // 긴 글줄은 줄 안 가장 가까운 긴 글줄과 높이의 5배 안이어야 한다 — 사이에 짧은 상자(카드 번호)가 끼어도 다리가 되지 않는다
    return nearLong <= 5
  }
  const lines: number[][] = []
  for (const i of order) {
    const line = lines.find(l => accepts(l, i))
    if (line) line.push(i)
    else lines.push([i])
  }
  // 홀로 남은 박스는 줄이 다 선 뒤 한 번 더 넣어 본다 — 먼저 만난 줄에 먼 긴 글줄만 있어 갈린 범례 라벨(ODL 059 "Construction | Waste")
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].length !== 1) continue
    const i = lines[k][0]
    const target = lines.find((l, m) => m !== k && l.length > 0 && accepts(l, i))
    if (target) { target.push(i); lines[k] = [] }
  }
  return lines.filter(l => l.length > 0)
}

export function ocrItemsToBlocks(
  items: OcrItem[],
  pageNumber: number,
  pdfW: number,
  pdfH: number,
  scale: number,
  extraLines?: { horizontals: LineSegment[]; verticals: LineSegment[] },
  detectTables = true,
  opList: PageOps = { fnArray: [], argsArray: [] },
  figureRegion = false,
): IRBlock[] {
  // 쪽 OCR 의 그림 속 차트(두 축 눈금이 감싼 판) 글은 뺀다 — 원본에선 그림이다(ocr-chart-axes.ts)
  if (!figureRegion) {
    const chart = chartPlotItems(items)
    if (chart.size) items = items.filter((_, i) => !chart.has(i))
  }
  // 줄마다 아래 끝을 중앙값으로 맞추고, 겹친 이웃 박스는 겹친 구간 가운데서 갈라 낱말 경계(따로 검출된 상자)를 공백으로 남긴다
  const bottoms = items.map(it => it.y + it.h)
  const xs = items.map(it => ({ x: it.x, r: it.x + it.w, space: false }))
  // 겹친 검출 상자가 이음매 글자를 두 번 읽은 것("너와조금" + "금은" → "조금금은", 손글씨) — 오른쪽 상자 앞 글자가 왼쪽 상자 끝
  // 글자와 같고 겹친 폭이 그 글자 폭의 절반을 넘으면 오른쪽에서 지운다(다 지워지면 상자를 뺀다)
  const texts = items.map(it => it.text)
  for (const line of groupOcrLines(items, figureRegion)) {
    if (line.length < 2) continue
    const sorted = line.map(j => items[j].y + items[j].h).sort((a, b) => a - b)
    for (const j of line) bottoms[j] = sorted[Math.floor(sorted.length / 2)]
    const byX = [...line].sort((a, b) => items[a].x - items[b].x)
    for (let k = 1; k < byX.length; k++) {
      const L = xs[byX[k - 1]], R = xs[byX[k]]
      if (R.x >= L.r) continue
      const lt = [...texts[byX[k - 1]]], rt = [...texts[byX[k]]], per = items[byX[k]].w / Math.max(1, rt.length)
      for (let n = Math.min(3, rt.length, lt.length); n >= 1; n--) {
        if (lt.slice(-n).join("") === rt.slice(0, n).join("") && /[가-힣]/.test(rt[0]) && L.r - R.x >= per * n * 0.5) { texts[byX[k]] = rt.slice(n).join(""); break }
      }
      const mid = (R.x + L.r) / 2, half = Math.min(items[byX[k - 1]].h, items[byX[k]].h) * 0.15
      L.r = Math.max(L.x + 1, mid - half)
      R.x = Math.min(R.r - 1, mid + half)
      R.space = true
    }
  }
  const norm: NormItem[] = items.map((it, i) => {
    // 그림 영역은 기준선을 줄 중앙값으로 옮겨도 박스 위 끝은 그대로 — 높이째 옮기면 키 큰 칸 박스가 윗행 칸과 더 겹쳐 그 칸에 붙었다(ODL 110
    // 그림 속 표 "14"·"15" → "1415"). 쪽 전체 OCR 은 높이째 옮긴다 — 위 끝을 지키자 스캔 쪽 셋의 CER 이 올랐다(topik 1.50 → 1.88%).
    // 글자 크기는 원래 박스 높이로 잰다
    const h = (figureRegion ? Math.max(1, bottoms[i] - it.y) : it.h) / scale
    const normalized: NormItem = {
      text: texts[i],
      x: Math.round(xs[i].x / scale),
      // NormItem.y 는 pdfjs transform[5] = 베이스라인 (bottom-up) — 잉크 하단으로 근사
      y: Math.round(pdfH - bottoms[i] / scale),
      w: Math.round((xs[i].r - xs[i].x) / scale),
      h: Math.round(h),
      // 박스는 잉크 외곽(engine tightBoxes) — 한글 줄 잉크 높이 ≈ 0.9em
      fontSize: Math.max(1, Math.round(it.h / scale / 0.9)),
      fontName: "ocr",
      isHidden: false,
      ...(xs[i].space ? { hasSpaceBefore: true } : {}),
    }
    copyOcrTextGaps(it, normalized, 1 / scale)
    return normalized
  }).filter(it => it.text)
  // 글자 획이 이은 가짜 세로 괘선 — 줄 간격 좁은 두 줄 칸에서 위아래 줄 글자의 세로 획이 이어져 최소 괘선 길이를 넘었고(60px), 그 칸 열이
  // 다섯 칸으로 갈렸다(복지사업 우수기관 표 "자치단체명"). 진짜 칸 경계는 검출 상자를 미리 가르므로 아이템 상자 안쪽을 지나지 않는다 —
  // 글자 높이 중앙값의 2.5배 이하인 세로선이 아이템 상자 안쪽(좌우 끝 3px 안)을 세로로 절반 넘게 지나가면 뺀다
  if (extraLines?.verticals.length && items.length) {
    const hs = items.map(it => it.h).sort((p, q) => p - q)
    const maxLen = hs[hs.length >> 1] * 2.5 / scale
    const boxes = items.map(it => ({ x0: (it.x + 3) / scale, x1: (it.x + it.w - 3) / scale, yTop: pdfH - it.y / scale, yBot: pdfH - (it.y + it.h) / scale }))
    extraLines = {
      ...extraLines,
      verticals: extraLines.verticals.filter(v => {
        const lo = Math.min(v.y1, v.y2), hi = Math.max(v.y1, v.y2)
        if (hi - lo > maxLen) return true
        return !boxes.some(b => v.x1 > b.x0 && v.x1 < b.x1 && Math.min(hi, b.yTop) - Math.max(lo, b.yBot) > (hi - lo) * 0.5)
      }),
    }
  }
  const laid = unframeOcrLayoutTables(splitOcrJoinedHeaders(splitOcrContactColumns(splitOcrNameValueColumns(splitStackedOcrRows(extractPageBlocksWithLines(norm, pageNumber, opList, pdfW, pdfH, extraLines, detectTables))))), pdfH)
  // 표 속 산문 행 꺼내기는 쪽 OCR 에만 — 그림 영역 OCR 은 조각을 위치로 다시 늘어놓아 표 상자를 받은 문단이 앞으로 간다
  const blocks = figureRegion ? laid : splitOcrProseRows(laid)
  if (!figureRegion) markOcrHeadings(blocks)
  return blocks
}

/**
 * OCR 쪽 제목 — 텍스트층 쪽은 글자 크기 빈도로 제목을 가리는데(detectHeadings), 스캔·이미지 쪽은 그 빈도가 없어 제목이 하나도 안
 * 나왔다(보고서 "제4장 실증분석" 이 문단). OCR 글자 크기는 줄마다 흔들려 더 엄격하게: 쪽 본문 크기(문단 글자 수 가중 중앙값)의
 * 1.3배 이상인 한 줄짜리 짧은 글(2~40자, 문장 끝 부호 없음)만(1.5배 넘으면 두 줄·60자까지). 1.5배 이상은 1수준
 */
export function markOcrHeadings(blocks: IRBlock[]): void {
  const sized = blocks.filter(b => b.type === "paragraph" && b.text && b.style?.fontSize)
  const weights: Array<[number, number]> = sized.map(b => [b.style!.fontSize!, b.text!.length])
  const total = weights.reduce((n, [, w]) => n + w, 0)
  if (total < 100) return
  weights.sort((a, b) => a[0] - b[0])
  let acc = 0, body = 0
  for (const [size, w] of weights) { acc += w; if (acc >= total / 2) { body = size; break } }
  if (!body) return
  for (const b of sized) {
    const text = b.text!.trim(), size = b.style!.fontSize!
    const ratio = size / body
    // 번호 붙은 장·절 제목("제1절 임금변동성과 측정방법")은 본문보다 조금만 커도 제목이다 — 1.3배 문턱에 못 미쳐 절 제목을 놓쳤다(KDI
    // 보고서). 한 줄·30자 안·문장부호로 안 끝날 때만(본문 "제1절에서는 …" 은 길거나 여러 줄이다). OCR 이 번호 뒤 공백을 빠뜨린 "제1절미국" 도 —
    // 번호 바로 뒤에 붙은 조사("제1절의")는 본문이다. 띄어 쓴 뒤의 첫 글자는 조사가 아니다("제1절 의장의 직권상정")
    if (ratio >= 1 && ratio < 1.3 && /^제\s*\d+\s*[장절편부](?:\s+\S|(?![에의은는을를이가와과로도만\s])\S)/.test(text) && text.length <= 30 && !/[.!?。,]$|다\.?$/.test(text) &&
        (!b.bbox || b.bbox.height <= size * 1.6)) {
      b.type = "heading"
      b.level = /^제\s*\d+\s*절/.test(text) ? 2 : 1
      continue
    }
    // 영문 대문자만으로 된 한 줄("BUT COPYRIGHT DOESN'T COVER EVERYTHING")은 제목이다 — 글자 그림을 OCR 한 쪽은 줄마다 잰 크기가
    // 들쭉날쭉해(본문 16~45) 크기 문턱으로 못 가린다(ODL 141). 두 낱말·글자 12자 이상, 소문자·한글 없이, 마침표·쉼표로 안 끝날 때만(두 줄로 꺾인 것까지)
    if (text.length <= 60 && /^[A-Z0-9][A-Z0-9 '’&:!,-]*$/.test(text) && (text.match(/[A-Z]/g) ?? []).length >= 12 &&
        /[A-Z]{2,}[,:]?\s+[A-Z]{2,}/.test(text) && !/[.,]$/.test(text) && (!b.bbox || b.bbox.height <= size * 3.2)) {
      b.type = "heading"
      b.level = ratio >= 1.5 ? 1 : 2
      continue
    }
    if (ratio < 1.3) continue
    if (text.length < 2 || text.length > (ratio >= 1.5 ? 60 : 40) || /[.!?。]$|다\.?$/.test(text) || /^[\d\s.,%·-]+$/.test(text)) continue
    // 크게 읽힌 수식 조각("1g(w)=Dt−()+, =1980")·문장 조각(", n"·"can be explained with the")은 제목이 아니다 — 등호가 있거나
    // 문장부호·영문 소문자로 시작한다
    if (/=/.test(text) || /^[,.;:)\]}]/.test(text) || /^[a-z]/.test(text)) continue
    // 한 줄만 — 1.5배 넘게 큰 짧은 글은 두 줄로 꺾인 장 제목까지
    if (b.bbox && b.bbox.height > size * (ratio >= 1.5 ? 3.2 : 1.6)) continue
    b.type = "heading"
    b.level = ratio >= 1.5 ? 1 : 2
  }
  // 위아래로 쌓인 한 제목 — "제4장" 줄 아래 "실증분석", 두 줄로 꺾인 장 제목. 같은 수준 제목이 줄 간격 안(글자 크기 1.2배)으로 바로
  // 아래에 놓이고 가로로 겹치면 잇는다. 같은 줄에 나란한 조각은 잇지 않는다(로고 글 "동행매력"·"서울관광재단" 순서가 바뀌었다)
  for (let i = blocks.length - 1; i > 0; i--) {
    const a = blocks[i - 1], b = blocks[i]
    if (a.type !== "heading" || b.type !== "heading" || !a.bbox || !b.bbox) continue
    // 장 번호 줄("제4장"·"CHAPTER 3")은 제목 줄과 떨어져 놓여도(글자 크기 3배 안) 한 제목이다
    const marker = /^(?:제\s*\d+\s*[장절편부]|chapter\s*\d+|part\s*\d+)$/i.test(a.text!.trim())
    // 크기가 크게 다른 두 제목은 따로다("10 THINGS YOU SHOULD KNOW ABOUT" 66 | "COPYRIGHT" 190, ODL 141)
    const sa = a.style?.fontSize ?? 0, sb = b.style?.fontSize ?? 0
    if (!marker && (a.level !== b.level || Math.max(sa, sb) > Math.min(sa, sb) * 1.3)) continue
    const gap = a.bbox.y - (b.bbox.y + b.bbox.height), size = Math.max(a.style?.fontSize ?? 0, b.style?.fontSize ?? 0)
    const across = Math.min(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width) - Math.max(a.bbox.x, b.bbox.x)
    if (gap < 0 || gap > size * (marker ? 3 : 1.2) || across <= 0) continue
    a.level = Math.min(a.level ?? 2, b.level ?? 2)
    a.text = `${a.text!.trim()} ${b.text!.trim()}`
    const x = Math.min(a.bbox.x, b.bbox.x)
    a.bbox = { ...a.bbox, x, y: b.bbox.y, width: Math.max(a.bbox.x + a.bbox.width, b.bbox.x + b.bbox.width) - x, height: a.bbox.y + a.bbox.height - b.bbox.y }
    blocks.splice(i, 1)
  }
}

async function tryImport<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (e) {
    throw new Error(
      `OCR 을 사용하려면 optional dependency '${name}' 이 필요합니다. ` +
        `\`npm install ${name}\` 후 다시 실행하세요.${OPTIONAL_DEP_INSTALL_HINT} 원인: ${(e as Error).message}`,
    )
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, msg: string): Promise<T> {
  // 타임아웃 패배 후 원 promise 의 사후 reject 가 unhandled rejection 이 되지 않게 흡수
  promise.catch(() => {})
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** 렌더 버퍼의 R·B 자리를 바꾼다 — 종전 PDFium 래퍼 경로와 같은 바이트를 OCR 에 준다(렌더 설정은 OCR 쪽에서 다시 맞춘다) */
function bgraToRgba(bgra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bgra.length)
  for (let i = 0; i < bgra.length; i += 4) {
    out[i] = bgra[i + 2]
    out[i + 1] = bgra[i + 1]
    out[i + 2] = bgra[i]
    out[i + 3] = bgra[i + 3]
  }
  return out
}
