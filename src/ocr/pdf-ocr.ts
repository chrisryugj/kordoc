/**
 * PDF OCR 브릿지 — 대상 페이지를 pdfium 으로 래스터해 내장 엔진 또는
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

import type { IRBlock, OcrProvider, ParseWarning } from "../types.js"
import type { NormItem } from "../pdf/text-line.js"
import type { LineSegment } from "../pdf/line-types.js"
import { extractPageBlocksWithLines } from "../pdf/page-blocks.js"
import { detectRulingLines, rulingToPdfLines } from "./ruling-lines.js"
import { getOcrEngine, type OcrItem } from "./engine.js"
import { ensureOcrModels } from "./models.js"

/** OCR 렌더 스케일 (72dpi × 3 = 216dpi) — 10pt 본문이 rec 입력 높이(48px)에 근접 */
const OCR_RENDER_SCALE = 3
/** 페이지 하나당 OCR 타임아웃 — det+rec 수십 라인 기준 넉넉히 */
const PAGE_TIMEOUT_MS = 120_000

export type OcrMode = "builtin" | OcrProvider

/**
 * 대상 페이지들을 OCR 해 페이지별 블록 맵 반환.
 * @param buffer 원본 PDF (pdfjs 가 detach 하기 전에 clone 해 둔 것)
 * @param targets 1-based 페이지 번호 집합
 */
export async function runPdfOcr(
  buffer: ArrayBuffer,
  targets: Set<number>,
  mode: OcrMode,
  warnings: ParseWarning[],
  onProgress?: (current: number, total: number) => void,
): Promise<Map<number, IRBlock[]>> {
  const result = new Map<number, IRBlock[]>()
  if (targets.size === 0) return result

  // 환경 준비 — 실패는 그대로 throw (호출자가 NEEDS_OCR 폴백)
  const pdfiumMod = await tryImport<typeof import("@hyzyla/pdfium")>(
    "@hyzyla/pdfium",
    () => import("@hyzyla/pdfium"),
  )
  if (mode === "builtin") {
    await ensureOcrModels(p => {
      if (p.phase === "download" && p.downloaded === 0) {
        process.stderr.write(`[kordoc-ocr] ${p.spec.name} 다운로드 중 (~${p.spec.sizeMb}MB)...\n`)
      }
    })
  }
  const engine = mode === "builtin" ? await getOcrEngine() : null

  const pdfium = await pdfiumMod.PDFiumLibrary.init()
  const doc = await pdfium.loadDocument(new Uint8Array(buffer))
  try {
    let done = 0
    for (const page of doc.pages()) {
      // pdfium page.number 는 0-based pageIndex — 대외 계약(1-based)으로 환산
      const pageNo = page.number + 1
      if (!targets.has(pageNo)) continue
      onProgress?.(++done, targets.size)
      try {
        const blocks = await withTimeout(
          ocrOnePage(page, pageNo, mode, engine, warnings),
          PAGE_TIMEOUT_MS,
          `OCR 페이지 ${pageNo} 타임아웃 (${PAGE_TIMEOUT_MS / 1000}초)`,
        )
        result.set(pageNo, blocks)
      } catch (e) {
        warnings.push({
          page: pageNo,
          message: `페이지 ${pageNo} OCR 실패: ${e instanceof Error ? e.message : String(e)}`,
          code: "OCR_FAILED",
        })
      }
    }
  } finally {
    doc.destroy()
    pdfium.destroy()
  }
  return result
}

async function ocrOnePage(
  page: import("@hyzyla/pdfium").PDFiumPage,
  pageNo: number,
  mode: OcrMode,
  engine: Awaited<ReturnType<typeof getOcrEngine>> | null,
  warnings: ParseWarning[],
): Promise<IRBlock[]> {
  const { originalWidth: pdfW, originalHeight: pdfH } = page.getOriginalSize()
  const rendered = await page.render({
    scale: OCR_RENDER_SCALE,
    render: async ({ data }) => data,
  })
  const { data: bgra, width: rw, height: rh } = rendered
  const rgba = bgraToRgba(bgra)

  if (mode === "builtin") {
    const stats = { droppedLowConf: 0 }
    const items = await engine!.recognizePage(rgba, rw, rh, stats)
    if (stats.droppedLowConf > 0) {
      warnings.push({
        page: pageNo,
        message: `페이지 ${pageNo}: 저신뢰 OCR 라인 ${stats.droppedLowConf}개 폐기 (인식 결손 가능)`,
        code: "OCR_LOW_CONF",
      })
    }
    // 래스터에서 표 괘선 감지 — 스캔본 병합셀 서식도 선 기반 표 파이프라인을 탄다
    const scale = rh / pdfH
    const ruling = detectRulingLines(rgba, rw, rh, scale)
    const extraLines = rulingToPdfLines(ruling, scale, pdfH)
    return ocrItemsToBlocks(items, pageNo, pdfW, pdfH, scale, extraLines)
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
    return []
  }
  return [{ type: "paragraph", text: text.trim(), pageNumber: pageNo }]
}

/**
 * OcrItem(렌더 픽셀, top-left origin) → NormItem(PDF pt, bottom-up baseline)
 * 으로 환산해 기존 블록 파이프라인에 태운다. 괘선은 그래픽 ops 대신
 * 래스터 감지 결과(extraLines)로 공급 — 없으면 클러스터 감지기 몫이다.
 * (이미지 직접 입력 경로 image-ocr.ts 와 공유)
 */
export function ocrItemsToBlocks(
  items: OcrItem[],
  pageNumber: number,
  pdfW: number,
  pdfH: number,
  scale: number,
  extraLines?: { horizontals: LineSegment[]; verticals: LineSegment[] },
): IRBlock[] {
  const norm: NormItem[] = items.map(it => {
    const h = it.h / scale
    return {
      text: it.text,
      x: Math.round(it.x / scale),
      // NormItem.y 는 pdfjs transform[5] = 베이스라인 (bottom-up) — 박스 하단으로 근사
      y: Math.round(pdfH - (it.y + it.h) / scale),
      w: Math.round(it.w / scale),
      h: Math.round(h),
      fontSize: Math.max(1, Math.round(h * 0.8)), // 박스높이는 어센더+디센더 포함 — 글자크기 근사
      fontName: "ocr",
      isHidden: false,
    }
  })
  return extractPageBlocksWithLines(norm, pageNumber, { fnArray: [], argsArray: [] }, pdfW, pdfH, extraLines)
}

async function tryImport<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (e) {
    throw new Error(
      `OCR 을 사용하려면 optional dependency '${name}' 이 필요합니다. ` +
        `\`npm install ${name}\` 후 다시 실행하세요. 원인: ${(e as Error).message}`,
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

/** pdfium BGRA → RGBA */
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
