/**
 * 내장 텍스트 OCR 엔진 — PP-OCRv5 korean (det DBNet + rec SVTR/CTC) ONNX 추론.
 *
 * 파이프라인: 페이지 RGBA → det(선 검출) → 박스 픽셀 분석(대비·행 밴드) → 라인 crop
 *   → rec 배치(CTC 인식) → 표기 후처리 → OcrItem[]
 * (좌표는 입력 픽셀 기준 top-left origin — 호출자가 PDF 좌표계로 변환).
 *
 * 전·후처리는 공식 inference.yml 스펙 그대로:
 *  - det: BGR, 긴 변 960 리사이즈(32 배수), mean/std [0.485,0.456,0.406]/[0.229,0.224,0.225],
 *         DBPostProcess thresh 0.3 / box_thresh 0.6 / unclip_ratio 1.5
 *  - rec: BGR, 높이 48 고정 비율 리사이즈 + 우측 zero-pad(최소 폭 320), (x/255-0.5)/0.5,
 *         CTC 디코드 (blank=0, 1..N=사전, N+1=공백), text_score 0.5.
 *         배치(recBatch>1)는 공식처럼 폭 비율로 정렬해 묶고 배치 최대 폭까지 zero-pad — 기본은 1
 * DB 후처리의 contour+minAreaRect 는 축정렬 connected-component bbox 로 근사
 * (공문서 스캔은 수평 텍스트가 지배적).
 *
 * 공식 파이프라인 밖의 보강 (근거는 bench/ocr-accuracy.mjs 코퍼스 실측, 각 모듈 주석):
 *  - 키 큰 박스(세로로 쌓인 글자)는 행 밴드로 갈라 밴드마다 인식 (line-split.ts)
 *  - 잉크 대비가 낮은 박스(배경 도안)는 인식하지 않음 — 환각 방지
 *  - 사전 밖 공문서 기호(○ △)·둥근 따옴표·천 단위 숫자 공백 복원, 점류 조각 폐기 (postprocess.ts)
 *  - 결과 좌표는 det 박스(unclip 여백) 대신 박스 안 잉크 외곽 — 텍스트층 아이템과 같은 기하
 *
 * 의존성(onnxruntime-node, sharp)은 optional — 미설치 시 create()가 명확한 에러.
 * 모델 미다운로드 시에도 즉시 실패 — 호출자가 ensureOcrModels() 먼저.
 */

import type { InferenceSession } from "onnxruntime-node"
import { readFile } from "fs/promises"
import { join } from "path"
import {
  OCR_DET_MODEL,
  OCR_REC_MODEL,
  OCR_REC_DICT,
  getOcrModelsDir,
  parseCharacterDict,
} from "./models.js"
import { grayCrop, inkBounds, inkStats, leaderRuns, leadingTriangle, splitRowBands } from "./line-split.js"
import { isDotFragment, joinLeaderItems, restoreBulletItems, restoreSymbols } from "./postprocess.js"
import { bandBoxes, splitBoxAtCellRules, lineCrop, type Box, REC_HEIGHT } from "./crop.js"

/** OCR 인식 결과 한 줄 — 좌표는 입력 이미지 픽셀 (top-left origin, y down) */
export interface OcrItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** CTC 평균 신뢰도 0~1 */
  confidence: number
}

export interface OcrPageStats {
  droppedLowConf: number
  truncatedBoxes?: number
}

/**
 * 엔진 튜닝 — 기본값이 제품 동작. 벤치·실험만 덮어쓴다 (공개 API 아님).
 */
export interface OcrTuning {
  /** det 입력 긴 변 (공식 resize_long). 1920 보존 실험은 recall Δ median +0.04pp에
   *  속도 -25%로 기각 (2026-08-02) */
  detLongSide: number
  detThresh: number
  detBoxThresh: number
  detUnclip: number
  /** 인식 신뢰도 하한 (공식 drop_score) */
  textScore: number
  /** rec 배치 크기. 공식 rec_batch_num 은 6 이지만 onnxruntime CPU 에선 배치(최대 폭까지
   *  zero-pad)가 오히려 느리다 — 코퍼스 16쪽 교대 실측 1: 0.57 · 4: 0.93 · 8: 0.87 s/page,
   *  정확도 차는 박스 내 CER 0.08pp (2026-09-23). 기본 1 */
  recBatch: number
  /** 키 큰 박스 행 밴드 분할 */
  splitTall: boolean
  /** 이 대비(전경/배경 평균 휘도 차) 미만 박스는 글자가 아님 — 0 이면 끔 */
  minInkContrast: number
  /** 기호·따옴표 복원 + 점류 조각 폐기 */
  postprocess: boolean
  /** 결과 좌표를 det 박스(unclip 여백 포함) 대신 박스 안 잉크 외곽으로 */
  tightBoxes: boolean
  /** 목차 리더 점 무리를 빼고 앞뒤를 따로 인식 (line-split.ts leaderRuns) */
  splitLeaders: boolean
}

export const DEFAULT_OCR_TUNING: Readonly<OcrTuning> = Object.freeze({
  detLongSide: 960,
  detThresh: 0.3,
  detBoxThresh: 0.6,
  detUnclip: 1.5,
  textScore: 0.5,
  recBatch: 1,
  splitTall: true,
  minInkContrast: 35,
  postprocess: true,
  tightBoxes: true,
  splitLeaders: true,
})

const DET_MIN_SIZE = 3
const DET_MAX_BOXES = 3000
const REC_MIN_WIDTH = 320
/** 배치 텐서 폭 합 상한 — 긴 줄 여러 개를 한 텐서로 묶어 메모리가 튀지 않게 */
const REC_BATCH_MAX_PIXELS = 48 * 16000
/** 키 큰 박스 판정 (공식 파이프라인의 세로 판정 h/w ≥ 1.5 와 같은 문턱) */
const TALL_RATIO = 1.5
/** 밴드로 갈라지지 않는 키 큰 박스 중 이 비율 이상은 90° 회전 글자 후보 */
const ROTATE_RATIO = 3
/** 리더로 볼 최소 점 수 — 말줄임표 "…"(3점)보다 많이. 목차 쪽번호 박스가 무는 점은 코퍼스 실측 4~9개가 대부분 */
const LEADER_MIN_DOTS = 4
/** 리더 앞 조각 crop 을 리더 안쪽으로 더 무는 폭 (박스 높이 배수, recognizePage 주석) */
const LEADER_CONTEXT = 0.5
/** 박스 잉크 비율 하한 (engine recognizePage 주석) */
const MIN_INK_RATIO = 0.01

// det: BGR 채널 순서에 yml 기재 순서 그대로 적용 (mean[0]→B)
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

type SharpFactory = (
  input: Uint8Array | Buffer,
  options?: { raw?: { width: number; height: number; channels: number } },
) => SharpChain
interface SharpChain {
  resize(w: number, h: number, opts?: { fit?: string }): SharpChain
  removeAlpha(): SharpChain
  raw(): { toBuffer(): Promise<Buffer> }
}

/** 인식 대상 한 줄 — rot 는 crop 회전(90=반시계, 270=시계). join: 리더로 가른 박스 번호, dotsBefore: 앞에 리더가 있었는지,
 *  trimDots: crop 이 뒤 리더 점을 물었는지(결과 끝 점을 지운다) */
interface LineJob { box: Box; rot: 0 | 90 | 270; group: number; join?: number; dotsBefore?: boolean; trimDots?: boolean }

export class OcrEngine {
  private det: InferenceSession
  private rec: InferenceSession
  private dict: string[]
  private ort: typeof import("onnxruntime-node")
  private sharp: SharpFactory

  private constructor(parts: {
    det: InferenceSession
    rec: InferenceSession
    dict: string[]
    ort: typeof import("onnxruntime-node")
    sharp: SharpFactory
  }) {
    this.det = parts.det
    this.rec = parts.rec
    this.dict = parts.dict
    this.ort = parts.ort
    this.sharp = parts.sharp
  }

  static async create(): Promise<OcrEngine> {
    const [ortMod, sharpModRaw] = await Promise.all([
      tryImport<typeof import("onnxruntime-node")>("onnxruntime-node", () => import("onnxruntime-node")),
      tryImport<{ default?: SharpFactory } & SharpFactory>(
        "sharp",
        () => import("sharp") as unknown as Promise<{ default?: SharpFactory } & SharpFactory>,
      ),
    ])
    const sharpAny = sharpModRaw as { default?: SharpFactory } | SharpFactory
    const sharpMod: SharpFactory =
      typeof sharpAny === "function" ? sharpAny : (sharpAny.default ?? (sharpAny as unknown as SharpFactory))

    const dir = getOcrModelsDir()
    const sessionOpts: import("onnxruntime-node").InferenceSession.SessionOptions = {
      graphOptimizationLevel: "all",
      executionProviders: ["cpu"],
      logSeverityLevel: 3, // paddle2onnx 변환 잔여물 W 로그 폭주 억제
    }
    const [det, rec, dictYml] = await Promise.all([
      ortMod.InferenceSession.create(join(dir, OCR_DET_MODEL.filename), sessionOpts),
      ortMod.InferenceSession.create(join(dir, OCR_REC_MODEL.filename), sessionOpts),
      readFile(join(dir, OCR_REC_DICT.filename), "utf-8"),
    ])
    const dict = parseCharacterDict(dictYml)
    if (dict.length === 0) throw new Error("OCR 사전 파싱 실패 — 모델 캐시를 삭제 후 재다운로드하세요")

    return new OcrEngine({ det, rec, dict, ort: ortMod, sharp: sharpMod })
  }

  /** onnxruntime-node 1.14+ InferenceSession.release() — 구버전은 무시 */
  async destroy(): Promise<void> {
    for (const s of [this.det, this.rec]) {
      const rel = (s as unknown as { release?: () => Promise<void> }).release
      if (typeof rel === "function") {
        try { await rel.call(s) } catch { /* ignore */ }
      }
    }
  }

  /**
   * 페이지 RGBA 픽셀 → 텍스트 라인 인식.
   * 반환 좌표는 입력 픽셀 기준. 라인은 위→아래, 좌→우 정렬.
   * @param stats 저신뢰(conf<0.5) 폐기 라인 카운트 출력 — 종전엔 무음 폐기라 관측 불가
   */
  async recognizePage(
    rgba: Uint8Array,
    width: number,
    height: number,
    stats?: OcrPageStats,
    tuning: Readonly<OcrTuning> = DEFAULT_OCR_TUNING,
    cellRules: Array<{ x1: number; y1: number; y2: number; thicknessPx: number }> = [],
  ): Promise<OcrItem[]> {
    if (width < DET_MIN_SIZE || height < DET_MIN_SIZE) return []
    const detected = await this.detect(rgba, width, height, tuning, stats)
    const boxes = cellRules.length ? detected.flatMap(b => splitBoxAtCellRules(b, cellRules)) : detected

    // 박스 픽셀 분석 → 인식 작업(라인) 목록. group = 한 결과로 합칠 후보 묶음(회전 후보)
    const jobs: LineJob[] = []
    /** 리더로 가른 검출 박스 — 조각 인식 결과를 모아 한 아이템으로 합친다 */
    const joins: Array<{ box: Box; parts: Array<{ x: number; text: string; dotsBefore: boolean; confidence: number }>; trailDots: boolean }> = []
    let group = 0
    for (const b of boxes) {
      const gray = grayCrop(rgba, width, b)
      const ink = inkStats(gray)
      if (tuning.minInkContrast > 0 && ink.contrast < tuning.minInkContrast) continue
      // 잉크가 박스의 1% 미만이면 가는 선·티끌이다 — 연한 배경 도안 띠를 가로지르는 파란 세로선이 대비 검사를
      // 통과시키고 인식기가 도안을 "D D D … O" 로 읽었다(ice-election-cases 표지, 잉크 0.4%). 가장 가는 글자("-")도
      // 여백 포함 박스의 1.5% 안팎이라 남는다. 점 하나("·")는 여기서 빠지지만 isDotFragment 가 어차피 버린다
      if (tuning.minInkContrast > 0 && ink.inkRatio < MIN_INK_RATIO) continue
      if (tuning.splitTall && b.h >= b.w * TALL_RATIO) {
        const bands = splitRowBands(gray, b.w, b.h, ink, 0.45)
        if (bands.length >= 2) {
          for (const sub of bandBoxes(b, bands, height)) jobs.push({ box: sub, rot: 0, group: group++ })
          continue
        }
        if (b.h >= b.w * ROTATE_RATIO) {
          for (const rot of [0, 90, 270] as const) jobs.push({ box: b, rot, group })
          group++
          continue
        }
      }
      // 목차 리더 점 무리는 인식하지 않고 앞뒤 글만 따로 인식한 뒤, 검출 박스 하나로 다시 합쳐 "제목 … 쪽번호" 아이템
      // 하나를 낸다 — 텍스트층도 목차 줄을 리더 글자까지 한 줄로 준다. 조각을 따로 두면 줄 기하가 바뀌어 뒤 단계가
      // 흔들렸다: 리더 자리를 비우면 속기록 1면 목차 줄이 2단 본문 줄로 잡혀 단 판정이 무너졌고(assembly-minutes-1179),
      // 리더를 따로 세우면 클러스터 표가 그것을 열로 삼았다(gwd-info-plan 목차). 리더 앞 조각은 점 한두 개까지 물려
      // 인식하고 물린 점은 결과 끝에서 지운다 — 끝 글자 바로 뒤에서 자르면 인식기가 오른쪽 맥락을 잃어 로마 숫자 Ⅰ 를
      // 1 로 읽었다(eval-rda "전략목표 Ⅰ"·"성과목표 Ⅰ-1", 박스 높이 0.5배 물림으로 Ⅰ·Ⅱ·Ⅲ 11줄 복원)
      const leaders = tuning.splitLeaders ? leaderRuns(gray, b.w, b.h, ink, LEADER_MIN_DOTS) : []
      if (leaders.length) {
        const join = joins.length
        joins.push({ box: b, parts: [], trailDots: false })
        let x0 = 0, dots = false
        for (const [a, c] of [...leaders, [b.w, b.w]]) {
          const bare = { x: b.x + x0, y: b.y, w: a - x0, h: b.h }
          const end = c > a ? Math.min(c, a + Math.round(b.h * LEADER_CONTEXT)) : a
          x0 = c
          if (bare.w >= DET_MIN_SIZE && inkStats(grayCrop(rgba, width, bare)).contrast >= Math.max(1, tuning.minInkContrast)) {
            jobs.push({ box: { ...bare, w: end - (bare.x - b.x) }, rot: 0, group: group++, join, dotsBefore: dots, trimDots: end > a })
            dots = false
          }
          if (c > a) dots = true
        }
        joins[join].trailDots = dots
        continue
      }
      jobs.push({ box: b, rot: 0, group: group++ })
    }

    const results = await this.recognizeJobs(rgba, width, jobs, tuning.recBatch)

    // 회전 후보 그룹은 최고 신뢰도 하나만
    const best = new Map<number, { job: LineJob; text: string; confidence: number }>()
    jobs.forEach((job, i) => {
      const r = results[i]
      if (!r) return
      const cur = best.get(job.group)
      if (!cur || r.confidence > cur.confidence) best.set(job.group, { job, ...r })
    })

    let items: OcrItem[] = []
    for (const { job, text: raw, confidence } of best.values()) {
      let text = tuning.postprocess ? restoreSymbols(raw.trim()) : raw
      if (!text.trim()) continue
      // 숫자 앞 △·▲ 는 사전 밖이라 빈칸으로 사라진다 — 박스 맨 앞 글자 모양으로 되살린다 (line-split.ts)
      if (tuning.postprocess && /^\d/.test(text) && job.rot === 0) {
        const g = grayCrop(rgba, width, job.box)
        const tri = leadingTriangle(g, job.box.w, job.box.h, inkStats(g))
        if (tri) text = tri + text
      }
      if (tuning.postprocess && isDotFragment(text)) continue
      if (confidence < tuning.textScore) { if (stats) stats.droppedLowConf++; continue }
      if (job.join !== undefined) {
        if (job.trimDots) text = text.replace(/[\s.:\u00b7\u2022\u2024\u2025\u2026\u2219\u22c5\u318d]+$/u, "")
        if (text) joins[job.join].parts.push({ x: job.box.x, text, dotsBefore: job.dotsBefore === true, confidence })
        continue
      }
      items.push({ text, ...this.itemBox(rgba, width, job.box, tuning), confidence })
    }
    const leaderEnds = new Map<OcrItem, { lead: boolean; trail: boolean }>()
    for (const j of joins) {
      if (!j.parts.length) continue
      j.parts.sort((a, b) => a.x - b.x)
      let text = ""
      for (const p of j.parts) text += (p.dotsBefore ? (text ? " \u2026 " : "\u2026") : text ? " " : "") + p.text
      if (j.trailDots) text += " \u2026"
      const item = { text, ...this.itemBox(rgba, width, j.box, tuning), confidence: Math.min(...j.parts.map(p => p.confidence)) }
      items.push(item)
      leaderEnds.set(item, { lead: j.parts[0].dotsBefore, trail: j.trailDots })
    }
    if (leaderEnds.size) items = joinLeaderItems(items, leaderEnds)
    if (tuning.postprocess) restoreBulletItems(items)
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x))
    return items
  }

  /** 결과 좌표 — det 박스 그대로 또는 박스 안 잉크 외곽 (tightBoxes) */
  private itemBox(rgba: Uint8Array, width: number, b: Box, tuning: Readonly<OcrTuning>): Box {
    if (!tuning.tightBoxes) return b
    const gray = grayCrop(rgba, width, b)
    const t = inkBounds(gray, b.w, b.h, inkStats(gray))
    return { x: b.x + t.x0, y: b.y + t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 }
  }

  // ─── det ─────────────────────────────────────────────

  private async detect(
    rgba: Uint8Array,
    width: number,
    height: number,
    tuning: Readonly<OcrTuning>,
    stats?: OcrPageStats,
  ): Promise<Box[]> {
    const ratio = tuning.detLongSide / Math.max(width, height)
    const dw = Math.max(32, Math.round((width * ratio) / 32) * 32)
    const dh = Math.max(32, Math.round((height * ratio) / 32) * 32)

    const rgb = await this.sharp(rgba, { raw: { width, height, channels: 4 } })
      .resize(dw, dh, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer()

    // HWC RGB → CHW BGR float32 정규화
    const plane = dw * dh
    const input = new Float32Array(3 * plane)
    for (let i = 0; i < plane; i++) {
      const r = rgb[i * 3] / 255
      const g = rgb[i * 3 + 1] / 255
      const b = rgb[i * 3 + 2] / 255
      input[i] = (b - DET_MEAN[0]) / DET_STD[0]
      input[plane + i] = (g - DET_MEAN[1]) / DET_STD[1]
      input[2 * plane + i] = (r - DET_MEAN[2]) / DET_STD[2]
    }

    const tensor = new this.ort.Tensor("float32", input, [1, 3, dh, dw])
    const out = await this.det.run({ [this.det.inputNames[0]]: tensor })
    const probMap = out[this.det.outputNames[0]].data as Float32Array

    const rawBoxes = componentBoxes(probMap, dw, dh, tuning.detThresh, tuning.detBoxThresh)
    if (stats) stats.truncatedBoxes = Math.max(0, rawBoxes.length - DET_MAX_BOXES)
    const sx = width / dw
    const sy = height / dh
    const boxes: Box[] = []
    for (const rb of rawBoxes.slice(0, DET_MAX_BOXES)) {
      // unclip: DB 는 학습 시 텍스트 영역을 수축시키므로 검출 박스를 되팽창
      const bw = rb.x2 - rb.x1 + 1
      const bh = rb.y2 - rb.y1 + 1
      const delta = (bw * bh * tuning.detUnclip) / (2 * (bw + bh))
      const x1 = Math.max(0, Math.floor((rb.x1 - delta) * sx))
      const y1 = Math.max(0, Math.floor((rb.y1 - delta) * sy))
      const x2 = Math.min(width, Math.ceil((rb.x2 + 1 + delta) * sx))
      const y2 = Math.min(height, Math.ceil((rb.y2 + 1 + delta) * sy))
      if (x2 - x1 < DET_MIN_SIZE || y2 - y1 < DET_MIN_SIZE) continue
      boxes.push({ x: x1, y: y1, w: x2 - x1, h: y2 - y1 })
    }
    return boxes
  }

  // ─── rec ─────────────────────────────────────────────

  /** 라인 작업들을 폭 비율 순으로 배치 인식 — 결과는 jobs 순서 */
  private async recognizeJobs(
    rgba: Uint8Array,
    pageW: number,
    jobs: LineJob[],
    batchSize: number,
  ): Promise<Array<{ text: string; confidence: number } | null>> {
    const crops = jobs.map(j => lineCrop(rgba, pageW, j.box, j.rot))
    const order = crops.map((_, i) => i).sort((a, b) => crops[a].w - crops[b].w)
    const results: Array<{ text: string; confidence: number } | null> = new Array(jobs.length).fill(null)
    const plane = REC_HEIGHT
    for (let s = 0; s < order.length;) {
      // 폭 오름차순이라 배치 마지막 원소가 최대 폭
      let e = s + 1
      while (e < order.length && e - s < Math.max(1, batchSize)
        && (e - s + 1) * Math.max(REC_MIN_WIDTH, crops[order[e]].w) * plane <= REC_BATCH_MAX_PIXELS) e++
      const idx = order.slice(s, e)
      const bw = Math.max(REC_MIN_WIDTH, crops[idx[idx.length - 1]].w)
      const n = idx.length
      const chw = 3 * REC_HEIGHT * bw
      const input = new Float32Array(n * chw) // pad 영역 0 (공식 zero-pad 와 동일)
      idx.forEach((ci, k) => {
        const c = crops[ci]
        const base = k * chw
        const p = REC_HEIGHT * bw
        for (let y = 0; y < REC_HEIGHT; y++) {
          for (let x = 0; x < c.w; x++) {
            const src = (y * c.w + x) * 3
            const dst = base + y * bw + x
            // HWC RGB → CHW BGR, (x/255-0.5)/0.5
            input[dst] = c.rgb[src + 2] / 127.5 - 1
            input[dst + p] = c.rgb[src + 1] / 127.5 - 1
            input[dst + 2 * p] = c.rgb[src] / 127.5 - 1
          }
        }
      })
      const tensor = new this.ort.Tensor("float32", input, [n, 3, REC_HEIGHT, bw])
      const out = await this.rec.run({ [this.rec.inputNames[0]]: tensor })
      const logits = out[this.rec.outputNames[0]]
      const [, T, C] = logits.dims as number[]
      const data = logits.data as Float32Array
      idx.forEach((ci, k) => {
        results[ci] = ctcDecode(data.subarray(k * T * C, (k + 1) * T * C), T, C, this.dict)
      })
      s = e
    }
    return results
  }
}

/** CTC greedy 디코드 — 연속 중복 붕괴 → blank(0) 제거 → 사전 매핑 (테스트용 export) */
export function ctcDecode(
  data: Float32Array,
  T: number,
  C: number,
  dict: string[],
): { text: string; confidence: number } | null {
  let text = ""
  let confSum = 0
  let confCount = 0
  let prev = -1
  for (let t = 0; t < T; t++) {
    const off = t * C
    let best = 0
    let bestV = data[off]
    for (let c = 1; c < C; c++) {
      const v = data[off + c]
      if (v > bestV) { bestV = v; best = c }
    }
    const repeat = best === prev
    prev = best
    if (best === 0 || repeat) continue
    // 모델 출력이 softmax 확률이 아니면 (>1) 해당 스텝만 정규화
    let p = bestV
    if (p > 1.0001 || p < 0) {
      let denom = 0
      for (let c = 0; c < C; c++) denom += Math.exp(data[off + c] - bestV)
      p = 1 / denom
    }
    confSum += p
    confCount++
    if (best >= 1 && best <= dict.length) text += dict[best - 1]
    else if (best === dict.length + 1) text += " "
  }
  if (!text) return null
  return { text, confidence: confCount > 0 ? confSum / confCount : 0 }
}

/** 이진화 확률맵의 4-연결 성분 bbox (score = 성분 평균 확률, 테스트용 export) */
export function componentBoxes(
  prob: Float32Array,
  w: number,
  h: number,
  thresh: number = DEFAULT_OCR_TUNING.detThresh,
  boxThresh: number = DEFAULT_OCR_TUNING.detBoxThresh,
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const visited = new Uint8Array(w * h)
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number; score: number }> = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (visited[start] || prob[start] <= thresh) continue
    let x1 = start % w, x2 = x1, y1 = (start / w) | 0, y2 = y1
    let sum = 0
    let count = 0
    stack.length = 0
    stack.push(start)
    visited[start] = 1
    while (stack.length) {
      const p = stack.pop()!
      const px = p % w
      const py = (p / w) | 0
      sum += prob[p]
      count++
      if (px < x1) x1 = px
      if (px > x2) x2 = px
      if (py < y1) y1 = py
      if (py > y2) y2 = py
      // 4-이웃
      if (px > 0 && !visited[p - 1] && prob[p - 1] > thresh) { visited[p - 1] = 1; stack.push(p - 1) }
      if (px < w - 1 && !visited[p + 1] && prob[p + 1] > thresh) { visited[p + 1] = 1; stack.push(p + 1) }
      if (py > 0 && !visited[p - w] && prob[p - w] > thresh) { visited[p - w] = 1; stack.push(p - w) }
      if (py < h - 1 && !visited[p + w] && prob[p + w] > thresh) { visited[p + w] = 1; stack.push(p + w) }
    }
    if (x2 - x1 + 1 < DET_MIN_SIZE && y2 - y1 + 1 < DET_MIN_SIZE) continue
    boxes.push({ x1, y1, x2, y2, score: sum / count })
  }

  return boxes
    .filter(b => b.score >= boxThresh)
    .sort((a, b) => (a.y1 - b.y1) || (a.x1 - b.x1))
}

async function tryImport<T>(name: string, loader: () => Promise<T>): Promise<T> {
  try {
    return await loader()
  } catch (e) {
    throw new Error(
      `내장 OCR 을 사용하려면 optional dependency '${name}' 이 필요합니다. ` +
        `\`npm install ${name}\` 후 다시 실행하세요. 원인: ${(e as Error).message}`,
    )
  }
}

// ─── 엔진 싱글턴 (watch/서버 장기 실행에서 세션 재사용) ───
let enginePromise: Promise<OcrEngine> | null = null

export function getOcrEngine(): Promise<OcrEngine> {
  if (!enginePromise) {
    enginePromise = OcrEngine.create().catch(err => {
      enginePromise = null // 실패는 캐시하지 않음 — 모델 설치 후 재시도 가능
      throw err
    })
  }
  return enginePromise
}
