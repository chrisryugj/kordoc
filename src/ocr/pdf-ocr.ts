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
import { DEFAULT_OCR_TUNING, getOcrEngine, type OcrItem, type OcrPageStats, type OcrTuning } from "./engine.js"
import { deskewPage } from "./deskew.js"
import { ensureOcrModels } from "./models.js"
import { OPTIONAL_DEP_INSTALL_HINT } from "../utils.js"

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
    // 대상 쪽만 연다 — doc.pages() 는 모든 쪽을 불러오고, 쪽은 render() 가 끝에서만 닫아 대상 밖 쪽이 문서를 닫을 때까지 남았다
    // (changwon 328쪽 문서의 한 쪽 OCR: 6ms·26MB → 전 쪽 순회 970ms·330MB). pdfium 쪽 번호는 0-based — 대외 계약(1-based)으로 환산
    const count = doc.getPageCount()
    for (const pageNo of [...targets].filter(p => p >= 1 && p <= count).sort((a, b) => a - b)) {
      const page = doc.getPage(pageNo - 1)
      onProgress?.(++done, targets.size)
      try {
        const blocks = await withTimeout(
          ocrOnePage(page, pageNo, mode, engine, warnings, detectTables, vectorOps?.get(pageNo), imageRegions?.get(pageNo)),
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
  detectTables: boolean,
  vectorOps?: PageOps,
  regions?: Array<{ x1: number; y1: number; x2: number; y2: number }>,
): Promise<IRBlock[]> {
  const { originalWidth: pdfW, originalHeight: pdfH } = page.getOriginalSize()
  const renderScale = Math.min(OCR_RENDER_SCALE, Math.sqrt(MAX_OCR_PIXELS / Math.max(1, pdfW * pdfH)))
  if (renderScale < OCR_RENDER_SCALE) {
    warnings.push({ page: pageNo, code: "PARTIAL_PARSE", message: `OCR 래스터 픽셀 상한으로 렌더 해상도를 축소했습니다 (작은 글자 인식 결손 가능)` })
  }
  // 그림 영역만 읽는 쪽은 두 배로 한 번 그려 영역 다시 읽기(closer)에 쓰고, 쪽 배율 래스터는 2×2 평균으로 줄여 만든다
  // (pdfium 은 같은 쪽을 두 번 그리면 wasm 서명 오류가 난다)
  const closer = regions && mode === "builtin" && renderScale * 2 <= Math.sqrt(MAX_OCR_PIXELS / Math.max(1, pdfW * pdfH))
  const rendered = await page.render({
    scale: closer ? renderScale * 2 : renderScale,
    render: async ({ data }) => data,
  })
  const hiRgba = closer ? bgraToRgba(rendered.data) : null
  const { rgba, width: rw, height: rh } = hiRgba
    ? halve(hiRgba, rendered.width, rendered.height)
    : { rgba: bgraToRgba(rendered.data), width: rendered.width, height: rendered.height }

  if (mode === "builtin") {
    // 스캔 기울기 보정 — 인식과 괘선 감지가 같은(바로 선) 래스터를 본다. 클린 렌더는 무보정.
    // 벡터 글자 쪽은 보정하지 않는다 — 글자 좌표가 돌면 그 쪽 벡터 괘선과 어긋난다
    const upright = vectorOps ? rgba : deskewPage(rgba, rw, rh).rgba
    const stats: OcrPageStats = { droppedLowConf: 0 }
    const ruling = vectorOps ? undefined : detectRulingLines(upright, rw, rh, rh / pdfH)
    const items = await engine!.recognizePage(upright, rw, rh, stats, regions ? REGION_TUNING : undefined, ruling?.cellDividers)
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
    // 텍스트층이 있는 쪽의 그림 영역만 읽을 때는 영역마다 그 안 글줄로 따로 블록을 만든다 — 쪽 전체로 묶으면 본문 줄과 그림 글이
    // 한 문단으로 합쳐져 영역 판정(mergeOcrImageRegions)에서 빠진다
    if (regions) {
      const inside = (it: OcrItem, r: { x1: number; y1: number; x2: number; y2: number }) => {
        const cx = (it.x + it.w / 2) / scale, cy = pdfH - (it.y + it.h / 2) / scale
        return cx >= r.x1 && cx <= r.x2 && cy >= r.y1 && cy <= r.y2
      }
      const reads = hiRgba ? await closerReads(hiRgba, rw * 2, rh * 2, pdfH, scale * 2, regions, engine!) : []
      return regions.flatMap((r, k) => {
        let own = items.filter(it => inside(it, r))
        // 그림 속 글은 작다(차트 눈금·범례 6~8pt) — 영역만 두 배로 다시 읽어 글자 수로 가중한 평균 신뢰도가 높은 쪽을 쓴다
        const near = reads[k]
        if (near?.length && meanConfidence(near) > meanConfidence(own)) own = near
        return own.length ? ocrItemsToBlocks(own, pageNo, pdfW, pdfH, scale, ruling && rulingToPdfLines(ruling, scale, pdfH), detectTables, undefined, true) : []
      })
    }
    // 벡터 글자 쪽: 표 구조는 그 쪽의 실제 괘선으로 (rhwp cairo 13쌍 46표 exact: 래스터 괘선 14 → 실제 괘선 20)
    if (vectorOps) return ocrItemsToBlocks(items, pageNo, pdfW, pdfH, scale, undefined, detectTables, vectorOps)
    // 래스터에서 표 괘선 감지 — 스캔본 병합셀 서식도 선 기반 표 파이프라인을 탄다
    const extraLines = rulingToPdfLines(ruling!, scale, pdfH)
    return ocrItemsToBlocks(items, pageNo, pdfW, pdfH, scale, extraLines, detectTables)
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
const REGION_TUNING: Readonly<OcrTuning> = Object.freeze({ ...DEFAULT_OCR_TUNING, trimEdges: false })

function meanConfidence(items: OcrItem[]): number {
  let n = 0, sum = 0
  for (const it of items) { const len = [...it.text].length; n += len; sum += it.confidence * len }
  return n ? sum / n : 0
}

/** 그림 영역마다 두 배 래스터에서 잘라 다시 인식한 글줄 — 좌표는 쪽 배율 래스터 기준으로 되돌린다 */
async function closerReads(
  rgba: Uint8Array, rw: number, rh: number, pdfH: number, hi: number,
  regions: Array<{ x1: number; y1: number; x2: number; y2: number }>,
  engine: NonNullable<Awaited<ReturnType<typeof getOcrEngine>>>,
): Promise<Array<OcrItem[] | null>> {
  const out: Array<OcrItem[] | null> = []
  for (const r of regions) {
    const x0 = Math.max(0, Math.floor(r.x1 * hi)), y0 = Math.max(0, Math.floor((pdfH - r.y2) * hi))
    const cw = Math.min(rw, Math.ceil(r.x2 * hi)) - x0, ch = Math.min(rh, Math.ceil((pdfH - r.y1) * hi)) - y0
    if (cw < 16 || ch < 16) { out.push(null); continue }
    const crop = new Uint8Array(cw * ch * 4)
    for (let y = 0; y < ch; y++) crop.set(rgba.subarray(((y0 + y) * rw + x0) * 4, ((y0 + y) * rw + x0 + cw) * 4), y * cw * 4)
    const items = await engine.recognizePage(crop, cw, ch, undefined, REGION_TUNING)
    out.push(items.map(it => ({ ...it, x: (it.x + x0) / 2, y: (it.y + y0) / 2, w: it.w / 2, h: it.h / 2 })))
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
 * 한 줄 조각은 높이가 엇비슷하다 — 줄 높이 중앙값과 두 배 넘게 다른 박스(아이콘·로고·QR 잡음)와는 묶지 않고(줄의 작은 숫자 박스
 * 하나와 재면 두 행에 걸친 칸 박스가 제 행을 놓친다, changwon-plan2026 "3/8"), 높이의 8배 넘게 떨어진 조각은 세로 중심이 작은 박스
 * 높이의 0.35 안일 때만 같은 줄(차트 범례와 먼 축 눈금), 긴 글줄은 줄 안 가장 가까운 긴
 * 글줄과 높이의 5배 넘게 떨어지면 묶지 않는다(범례 라벨 사이 3~4배는 한 줄). 짧은 조각(숫자·라벨 칸)은 멀어도 묶는다(영수증 금액 칸).
 * 두 단 글의 좌우 줄은 높이가 엇비슷해도 다른 줄이다(ODL 141 두 단 카드 인포그래픽: 좌우 카드 줄 틈 7~60배 — 4.21.3 에서 한 줄로
 * 묶여 단 분리가 깨지고 가짜 표가 됐다, NID 0.96 → 0.44).
 */
export function groupOcrLines(items: OcrItem[]): number[][] {
  const order = items.map((_, i) => i).sort((a, b) => (items[a].y + items[a].h / 2) - (items[b].y + items[b].h / 2))
  const accepts = (l: number[], i: number): boolean => {
    const it = items[i], c = it.y + it.h / 2
    const lc = l.reduce((s, j) => s + items[j].y + items[j].h / 2, 0) / l.length
    const minH = Math.min(it.h, ...l.map(j => items[j].h))
    if (Math.abs(c - lc) > minH / 2) return false
    const hs = l.map(j => items[j].h).sort((a, b) => a - b), med = hs[hs.length >> 1]
    if (Math.max(it.h, med) > Math.min(it.h, med) * 2) return false
    let nearLong = 0, gap = Infinity
    for (const j of l) {
      const o = items[j]
      // 박스는 잉크 외곽에 여백이 붙어 이웃 낱말과 조금 겹친다(이마트·탄현점 32px) — 좁은 쪽 폭의 절반 넘게 겹칠 때만 다른 줄
      const ov = Math.min(it.x + it.w, o.x + o.w) - Math.max(it.x, o.x)
      if (ov >= Math.min(it.w, o.w) / 2) return false
      gap = Math.min(gap, Math.max(0, -ov))
      if (it.w >= it.h * 6 && o.w >= o.h * 6) nearLong = Math.min(nearLong || Infinity, Math.max(0, -ov) / Math.min(it.h, o.h))
    }
    // 높이의 8배 넘게 떨어진 조각은 세로로 거의 같은 줄이어야 한다 — 영수증 먼 칸은 중심 어긋남이 작은 박스 높이의 0.22 안, 원그래프
    // 값과 범례(ODL 148 "18.9%"·"Project Manager")는 0.31, 차트 범례 라벨과 멀리 왼쪽 축 눈금은 0.37~0.47 이라 반쯤 어긋난 채 묶여
    // 기준선이 옮겨지고 읽기 순서가 바뀌었다(ODL 128·140·057)
    if (gap > 8 * minH && Math.abs(c - lc) > minH * 0.35) return false
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
  // 줄마다 아래 끝을 중앙값으로 맞추고, 겹친 이웃 박스는 겹친 구간 가운데서 갈라 낱말 경계(따로 검출된 상자)를 공백으로 남긴다
  const bottoms = items.map(it => it.y + it.h)
  const xs = items.map(it => ({ x: it.x, r: it.x + it.w, space: false }))
  for (const line of groupOcrLines(items)) {
    if (line.length < 2) continue
    const sorted = line.map(j => items[j].y + items[j].h).sort((a, b) => a - b)
    for (const j of line) bottoms[j] = sorted[Math.floor(sorted.length / 2)]
    const byX = [...line].sort((a, b) => items[a].x - items[b].x)
    for (let k = 1; k < byX.length; k++) {
      const L = xs[byX[k - 1]], R = xs[byX[k]]
      if (R.x >= L.r) continue
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
    return {
      text: it.text,
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
  })
  return extractPageBlocksWithLines(norm, pageNumber, opList, pdfW, pdfH, extraLines, detectTables)
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
