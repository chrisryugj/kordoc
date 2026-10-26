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
import { createHash } from "crypto"
import { readFile, stat } from "fs/promises"
import { basename } from "path"
import { KordocError, OPTIONAL_DEP_INSTALL_HINT } from "../utils.js"
import {
  DEFAULT_OCR_MODELS,
  type OcrModelSelection,
  type OcrModelSource,
  ocrSelectionKey,
  ocrSourcePath,
  parseCharacterDict,
} from "./models.js"
import { edgeTrim, leadingBullet, tallInkCount, grayCrop, inkBounds, inkStats, leaderRuns, leadingTriangle, leadingRing, splitRowBands } from "./line-split.js"
import { restoreGlyphs, trimInklessEnds } from "./glyph-restore.js"
import { isDotFragment, joinLeaderItems, restoreBulletItems, restoreSymbols } from "./postprocess.js"
import { bandBoxes, splitBoxAtCellRules, lineCrop, type Box, REC_HEIGHT } from "./crop.js"
import { disableOrtTelemetry } from "./runtime-env.js"
import { findOcrTextGaps, rememberOcrTextGaps } from "./text-gaps.js"

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
  /** 주면 저신뢰로 버린 줄을 여기에 모은다 (ocrLines "all") — 없으면 세기만 */
  dropped?: OcrItem[]
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
  /** 한 줄 박스에 걸린 이웃 줄 끝자락·상자 테두리를 지운 crop 도 인식 (line-split edgeTrim). 그림 영역만 읽을 때는 끈다 —
   *  쪽 배율·두 배 재인식 중 평균 신뢰도로 한쪽을 통째로 고르는데 지운 판이 한쪽 신뢰도만 올려 선택이 뒤집혔다(ODL 073) */
  trimEdges: boolean
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
  trimEdges: true,
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
/** 이웃 줄 끝자락을 지운 crop 이 원본 crop 을 이기려면 넘어야 할 신뢰도 차 (recognizePage 주석) */
const KEEP_MARGIN = 0.06
/** 리더로 볼 최소 점 수 — 말줄임표 "…"(3점)보다 많이. 목차 쪽번호 박스가 무는 점은 코퍼스 실측 4~9개가 대부분 */
const LEADER_MIN_DOTS = 4
/** 리더 앞 조각 crop 을 리더 안쪽으로 더 무는 폭 (박스 높이 배수, recognizePage 주석) */
const LEADER_CONTEXT = 0.5
/** 박스 잉크 비율 하한 (engine recognizePage 주석) */
const MIN_INK_RATIO = 0.01
/** 로컬 모델 파일 크기 상한 — PP-OCRv5 server det 가 88MB, 가장 큰 rec 도 수십 MB */
const MAX_LOCAL_MODEL_BYTES = 1024 * 1024 * 1024

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
/** keep: 인식 crop 에서 남길 박스 로컬 구간 — 밖(이웃 줄 끝자락·상자 테두리)은 배경으로 칠한다 (edgeTrim) */
interface LineJob { box: Box; rot: 0 | 90 | 270; group: number; join?: number; dotsBefore?: boolean; trimDots?: boolean; keep?: { x0: number; x1: number; y0: number; y1: number; bg: number } }

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

  static async create(models: OcrModelSelection = DEFAULT_OCR_MODELS): Promise<OcrEngine> {
    disableOrtTelemetry()
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

    const sessionOpts: import("onnxruntime-node").InferenceSession.SessionOptions = {
      graphOptimizationLevel: "all",
      executionProviders: ["cpu"],
      logSeverityLevel: 3, // paddle2onnx 변환 잔여물 W 로그 폭주 억제
    }
    // 내장 모델은 캐시 경로에서 바로(ensureOcrModelsFor 가 검증), 로컬 파일은 한 번 읽은 바이트를 대조해 그 바이트로 연다 —
    // 대조 뒤 파일이 바뀌어도 검증하지 않은 바이트를 올리지 않는다. 로컬 파일을 모두 대조한 뒤에 세션을 만든다(하나가 틀리면 아무것도 안 올린다)
    const local = (s: OcrModelSource) => "spec" in s ? Promise.resolve(null) : verifiedBytes(s)
    const [detBytes, recBytes, dictBytes] = await Promise.all([local(models.det), local(models.rec), local(models.dict)])
    const session = (s: OcrModelSource, bytes: Uint8Array | null) =>
      bytes
        ? ortMod.InferenceSession.create(bytes, sessionOpts).catch(() => {
          throw new KordocError(`OCR 모델을 열지 못했습니다: ${basename(ocrSourcePath(s))} — ONNX 모델이 아니거나 손상됐습니다`)
        })
        : ortMod.InferenceSession.create(ocrSourcePath(s), sessionOpts)
    const [det, rec, dictYml] = await Promise.all([
      session(models.det, detBytes),
      session(models.rec, recBytes),
      dictBytes ? new TextDecoder().decode(dictBytes) : readFile(ocrSourcePath(models.dict), "utf-8"),
    ])
    const dict = parseCharacterDict(dictYml)
    if (dict.length === 0) {
      throw "spec" in models.dict
        ? new Error("OCR 사전 파싱 실패 — 모델 캐시를 삭제 후 재다운로드하세요")
        : new KordocError(`OCR 사전 파싱 실패 — ${basename(models.dict.file.path)} 에 PostProcess.character_dict 목록이 없습니다`)
    }

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
      // 한 줄 박스가 문 위아래 이웃 줄 글자 끝자락·좌우 끝 상자 테두리는 인식 crop 에서 배경으로 지운다 — 인식기가 받침·"|" 로
      // 읽는다 (line-split edgeTrim). 박스를 줄이면 인식 입력 배율이 바뀌어 가운뎃점이 "•" 로 커 보였다 — 박스·좌표는 그대로 둔다
      const trim = tuning.trimEdges ? edgeTrim(gray, b.w, b.h, ink) : null
      const keep = trim ? { ...trim, bg: median(gray) } : undefined
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
      // 지운 crop 은 원본 crop 과 한 그룹으로 둘 다 인식해 신뢰도가 높은 쪽을 쓴다 — 끝자락이 글자 획과 붙어 있거나
      // 인식기가 조각 없이도 흔들리는 줄(아이콘·로고 칸)에서 지우기가 오히려 틀리게 만들지 않게
      if (keep) jobs.push({ box: b, rot: 0, group, keep })
      jobs.push({ box: b, rot: 0, group: group++ })
    }

    const results = await this.recognizeJobs(rgba, width, jobs, tuning.recBatch)

    // 회전 후보 그룹은 최고 신뢰도 하나만
    const best = new Map<number, { job: LineJob; text: string; confidence: number; steps: number[]; stepPx: number }>()
    // 끝자락을 지운 crop 은 원본보다 신뢰도가 KEEP_MARGIN 넘게 높을 때만 — 받침 조각 오독은 원본 0.46~0.89 → 지운 쪽 0.99 로
    // 차이가 크고, 차이가 작은 쪽은 띄어쓰기·대시 길이 같은 잡음이었다(과학영재 안내문 "gifted" → "gifed" +0.015)
    const score = (job: LineJob, confidence: number) => confidence - (job.keep ? KEEP_MARGIN : 0)
    jobs.forEach((job, i) => {
      const r = results[i]
      if (!r) return
      const cur = best.get(job.group)
      if (!cur || score(job, r.confidence) > score(cur.job, cur.confidence)) best.set(job.group, { job, ...r })
    })

    let items: OcrItem[] = []
    for (const r of best.values()) {
      const { job, confidence, stepPx } = r
      const { text: read, steps } = tuning.postprocess && job.rot === 0 ? trimInklessEnds(rgba, width, job.box, r.text, r.steps, stepPx) : r
      const note: { ringLead?: boolean } = {}
      const raw = tuning.postprocess && job.rot === 0 ? restoreGlyphs(rgba, width, job.box, read, steps, stepPx, note) : read
      let text = tuning.postprocess ? restoreSymbols(raw.trim(), note.ringLead) : raw
      if (!text.trim()) continue
      // 사전 밖·작은 점으로 읽히거나 빠지는 글머리(◎ ● ▪ □) — 첫 글리프 모양으로 되살린다 (line-split.ts)
      if (tuning.postprocess && job.rot === 0 && !/^[◎●▪□■○ㅇ]/.test(text)) {
        const chars = [...read], k = chars.findIndex(c => c.trim())
        if (k >= 0 && steps.length === chars.length) {
          const g = grayCrop(rgba, width, job.box)
          const b = leadingBullet(g, job.box.w, job.box.h, inkStats(g), (steps[k] + 0.5) * stepPx)
          // ◎ 는 "O" 로 잘못 읽은 자리만 바꾼다(장식 아이콘에 끼워 넣지 않게). ●▪ 는 본문 줄(뒤 글 한글 4음절 이상)에서만 —
          // 표 칸의 큰 가운뎃점("·수학"·"·승합", 글꼴에 따라 네모·원으로 그려짐)은 정답도 "·" 다
          const body = (text.match(/[가-힣]/g) ?? []).length >= 4
          const miss = /^[Oo0•·ㆍ∙‧○]/.test(text)
          if (b?.mark === "\u25ce" && b.covers && /^[Oo0○]/.test(text)) text = b.mark + " " + text.slice(1).trimStart()
          // □ 는 인식에서 빠진 자리만(첫 글자 앞) — 모델은 사전에 □ 가 있어도 내지 않고 통째로 빠뜨린다
          else if (b?.mark === "\u25a1") { if (!b.covers && body) text = b.mark + " " + text }
          else if (b && b.mark !== "\u25ce" && body) text = b.covers ? (miss ? b.mark + " " + text.slice(1).trimStart() : text) : b.mark + " " + text
          // 통째로 빠진 고리 글머리 ○ — 첫 글자 앞 맨 왼쪽 조각이 도형 ○ 일 때만 (line-split leadingRing)
          else if (!b && body && /^[가-힣]/.test(chars[k]) && leadingRing(g, job.box.w, job.box.h, inkStats(g), (steps[k] + 0.5) * stepPx)) text = "\u25cb " + text
        }
      }
      // 숫자 앞 △·▲ 는 사전 밖이라 빈칸으로 사라진다 — 박스 맨 앞 글자 모양으로 되살린다 (line-split.ts)
      if (tuning.postprocess && /^\d/.test(text) && job.rot === 0) {
        const g = grayCrop(rgba, width, job.box)
        const tri = leadingTriangle(g, job.box.w, job.box.h, inkStats(g))
        if (tri) text = tri + text
      }
      if (tuning.postprocess && isDotFragment(text)) continue
      if (confidence < tuning.textScore) {
        if (stats) {
          stats.droppedLowConf++
          stats.dropped?.push({ text, ...this.itemBox(rgba, width, job.box, tuning), confidence })
        }
        continue
      }
      if (job.join !== undefined) {
        if (job.trimDots) text = text.replace(/[\s.:\u00b7\u2022\u2024\u2025\u2026\u2219\u22c5\u318d]+$/u, "")
        if (text) joins[job.join].parts.push({ x: job.box.x, text, dotsBefore: job.dotsBefore === true, confidence })
        continue
      }
      const item = { text, ...this.itemBox(rgba, width, job.box, tuning), confidence }
      if (job.rot === 0) rememberOcrTextGaps(item, findOcrTextGaps(rgba, width, job.box, read, text, steps, stepPx))
      items.push(item)
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
  ): Promise<Array<{ text: string; confidence: number; steps: number[]; stepPx: number } | null>> {
    const crops = jobs.map(j => lineCrop(rgba, pageW, j.box, j.rot, j.keep))
    const order = crops.map((_, i) => i).sort((a, b) => crops[a].w - crops[b].w)
    const results: Array<{ text: string; confidence: number; steps: number[]; stepPx: number } | null> = new Array(jobs.length).fill(null)
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
      // CTC 클래스 = blank + 사전 + 공백 — 사전과 짝이 아닌 rec 모델은 글자를 엉뚱하게 옮긴다(로컬 모델 교체 시 실수)
      if (C !== this.dict.length + 2) throw new KordocError(`OCR rec 출력 클래스 ${C}개가 사전 ${this.dict.length}자 + 2 와 다릅니다 — 모델에 맞는 사전(ocrRecDict)을 지정하세요`)
      const data = logits.data as Float32Array
      idx.forEach((ci, k) => {
        const r = ctcDecode(data.subarray(k * T * C, (k + 1) * T * C), T, C, this.dict)
        // CTC 시점 하나가 덮는 원본 픽셀 폭 — crop 은 높이 48 로 줄인 뒤 bw 까지 오른쪽을 채웠다 (회전 crop 은 세로 축)
        const job = jobs[ci], src = job.rot === 0 ? job.box.w : job.box.h
        // 채운 자리(crop 폭 밖)에 찍힌 글자 — CTC 는 짧은 박스의 진짜 끝 글자도 마지막 시점에 찍어("54" → 시점 36·39) 자리만으로는 못 가른다.
        // crop 안 키 큰 잉크 덩어리보다 키 큰 글자가 많을 때 남는 것만 지어낸 것으로 버린다 — 칸에 "/" 하나만 든 박스가 "/)"·"(/:)" 로
        // 읽혔다(여수 인원표). 점·쉼표류는 덩어리로 안 세니 그대로 둔다. "(cid:9)" 환각은 restoreSymbols 가 통째로 걷도록 손대지 않는다.
        // crop 안 글자가 두 자 이하인 작은 박스만 — 긴 낱말은 그림 성분이 글자 높이를 부풀려 소문자를 덩어리로 못 세었다("ToContent" → "ToCont")
        let kept = r
        const last = (crops[ci].w * T) / bw + 1
        const chars = r ? [...r.text] : []
        if (r && job.rot === 0 && chars.length === r.steps.length && r.steps.some(t => t > last) && !r.text.includes("(cid:")) {
          const tallCh = (c: string) => !/[\s.,:;\u00b7\u2026'"\u2018-\u201d`\-_~]/.test(c)
          const g = grayCrop(rgba, pageW, job.box)
          const inside = chars.filter((c, i) => r.steps[i] <= last && tallCh(c)).length
          let budget = inside <= 2 ? tallInkCount(g, job.box.w, job.box.h, inkStats(g)) - inside : Infinity
          const keep = chars.map((c, i) => r.steps[i] <= last || !tallCh(c) || budget-- > 0)
          if (!keep.every(Boolean)) kept = { ...r, text: chars.filter((_, i) => keep[i]).join(""), steps: r.steps.filter((_, i) => keep[i]) }
        }
        results[ci] = kept && { ...kept, stepPx: (bw / T) * (src / crops[ci].w) }
      })
      s = e
    }
    return results
  }
}

/** 회색조 중앙값 — 글줄 박스는 배경 픽셀이 다수라 배경 휘도가 된다 */
function median(gray: Uint8Array): number {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  for (let v = 0, n = 0; v < 256; v++) if ((n += hist[v]) * 2 >= gray.length) return v
  return 255
}

/** CTC greedy 디코드 — 연속 중복 붕괴 → blank(0) 제거 → 사전 매핑 (테스트용 export) */
export function ctcDecode(
  data: Float32Array,
  T: number,
  C: number,
  dict: string[],
): { text: string; confidence: number; steps: number[] } | null {
  let text = ""
  let confSum = 0
  let confCount = 0
  let prev = -1
  /** 글자(코드 포인트)마다 CTC 시점 구간 [첫, 끝] — 괄호 모양 판별이 글자 자리를 픽셀로 옮길 때 쓴다 */
  const runs: Array<[number, number]> = []
  let open: Array<[number, number]> = []
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
    if (repeat && best !== 0) { for (const r of open) r[1] = t; continue }
    open = []
    if (best === 0) continue
    // 모델 출력이 softmax 확률이 아니면 (>1) 해당 스텝만 정규화
    let p = bestV
    if (p > 1.0001 || p < 0) {
      let denom = 0
      for (let c = 0; c < C; c++) denom += Math.exp(data[off + c] - bestV)
      p = 1 / denom
    }
    confSum += p
    confCount++
    const tok = best >= 1 && best <= dict.length ? dict[best - 1] : best === dict.length + 1 ? " " : ""
    text += tok
    for (const _ of tok) { const r: [number, number] = [t, t]; runs.push(r); open.push(r) }
  }
  if (!text) return null
  return { text, confidence: confCount > 0 ? confSum / confCount : 0, steps: runs.map(([a, b]) => (a + b) / 2) }
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
        `\`npm install ${name}\` 후 다시 실행하세요.${OPTIONAL_DEP_INSTALL_HINT} 원인: ${(e as Error).message}`,
    )
  }
}

/** 로컬 모델 파일을 읽어 SHA-256 을 대조한다 — 다르면 로드하지 않는다 */
async function verifiedBytes(s: { file: { path: string; sha256: string } }): Promise<Uint8Array> {
  // 경로 전체는 내지 않는다(sanitizeError 와 같은 원칙) — 파일 이름과 원인만. errno(ENOENT) 를 그대로 쓰면 classifyError 가
  // 입력 문서가 없는 FILE_NOT_FOUND 로 분류한다
  const name = basename(s.file.path)
  const fail = (why: string) => new KordocError(`OCR 모델 파일을 읽지 못했습니다: ${name} (${why})`)
  const why = (e: unknown) => {
    const code = (e as NodeJS.ErrnoException).code
    return code === "ENOENT" ? "파일이 없음" : code === "EACCES" || code === "EPERM" ? "권한 없음" : "읽기 실패"
  }
  // 일반 파일만, 상한 안에서 — FIFO 는 readFile 이 끝나지 않고, 엉뚱한 큰 파일을 메모리에 다 올리지 않는다
  let st: Awaited<ReturnType<typeof stat>>
  try { st = await stat(s.file.path) } catch (e) { throw fail(why(e)) }
  if (!st.isFile()) throw fail("일반 파일이 아님")
  if (st.size > MAX_LOCAL_MODEL_BYTES) throw fail(`${Math.round(st.size / 1048576)}MB — 모델 파일로 보기에 너무 큽니다`)
  let bytes: Buffer
  try { bytes = await readFile(s.file.path) } catch (e) { throw fail(why(e)) }
  const actual = createHash("sha256").update(bytes).digest("hex")
  if (actual !== s.file.sha256) {
    throw new KordocError(`OCR 모델 SHA256 mismatch: ${basename(s.file.path)} — expected ${s.file.sha256}, got ${actual} (로드 거부)`)
  }
  return bytes
}

// ─── 엔진 캐시 (watch/서버 장기 실행에서 세션 재사용) — 모델 선택마다 하나 ───
const engines = new Map<string, Promise<OcrEngine>>()

export function getOcrEngine(models: OcrModelSelection = DEFAULT_OCR_MODELS): Promise<OcrEngine> {
  const key = ocrSelectionKey(models)
  let p = engines.get(key)
  if (!p) {
    p = OcrEngine.create(models).catch(err => {
      engines.delete(key) // 실패는 캐시하지 않음 — 모델 설치 후 재시도 가능
      throw err
    })
    engines.set(key, p)
  }
  return p
}
