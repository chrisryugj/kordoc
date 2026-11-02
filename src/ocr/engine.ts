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
import { arrowGlyph, edgeTrim, leadingBullet, tallInkCount, grayCrop, inkBounds, inkStats, leaderRuns, leadingTriangle, leadingRing, splitRowBands } from "./line-split.js"
import type { InkStats } from "./line-split.js"
import { restoreGlyphs, trimInklessEnds } from "./glyph-restore.js"
import { dropNestedFragments, isDotFragment, joinLeaderItems, restoreBulletItems, restoreSymbols } from "./postprocess.js"
import { bandBoxes, splitBoxAtCellRules, splitBoxAtRowRules, lineCrop, type Box, REC_HEIGHT } from "./crop.js"
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
  /** 가로 표를 눕혀 찍은 쪽으로 보여 인식하지 않고 돌릴 각만 적었다(orientPage) — 호출측이 래스터를 돌려(rotateQuarter) 다시 부른다 */
  pageRotation?: 90 | 270
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
  /** 눕혀 찍은 쪽 판정 — 검출 상자 대부분이 세로로 길면 돌릴 각을 stats.pageRotation 에 적고 인식을 건너뛴다 */
  orientPage: boolean
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
  orientPage: true,
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
/** 눕힌 쪽 판정 — 검출 상자가 이만큼 이상이고 그 가운데 키 큰(TALL_RATIO) 상자가 이 비율 이상일 때만 본다 */
const ORIENT_MIN_BOXES = 20
const ORIENT_TALL_SHARE = 0.6
/** 방향을 가릴 표본 상자 수 — 키 큰 순 */
const ORIENT_SAMPLE = 12
/** 돌려 읽은 표본 평균 신뢰도 하한, 그대로 읽은 것보다 앞서야 할 차 */
const ORIENT_MIN_CONF = 0.7
const ORIENT_GAIN = 0.1
/** 이웃 줄 끝자락을 지운 crop 이 원본 crop 을 이기려면 넘어야 할 신뢰도 차 (recognizePage 주석) */
const KEEP_MARGIN = 0.06
/** 두 줄로 갈라 다시 읽은 줄(recognizePage 재시도)을 받을 신뢰도 하한 */
const RETRY_SCORE = 0.9
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
interface LineJob { box: Box; rot: 0 | 90 | 270; group: number; footer?: boolean; join?: number; dotsBefore?: boolean; trimDots?: boolean; keep?: { x0: number; x1: number; y0: number; y1: number; bg: number } }

/**
 * 검출기가 놓친 줄 머리 대시 — 목차 하위 항목 "–  영농지원과" 의 짧은 가로 막대는 상자 밖에 홀로 남아 빠졌다(함평 목차). 한글이 두 자
 * 이상인 줄(한 자씩 벌린 칸은 아이템마다 한 자)의 가장 왼쪽 아이템 앞(띠 높이 2.5배 안), 띠 안 상자 밖 잉크가 가로 막대 하나뿐이면(높이 띠의 0.2배 이하·폭
 * 0.3~1.2배·세로 가운데 30~70%), 첫 아이템이 한글로 열면 그 자리에 "-" 아이템을 낸다
 */
export function rowHeadDashes(rgba: Uint8Array, width: number, items: OcrItem[]): OcrItem[] {
  const out: OcrItem[] = []
  const dark = (x: number, y: number) => { const p = (y * width + x) * 4; return ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8) < 160 }
  const inBox = (x: number, y: number) => items.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
  const done = new Set<OcrItem>()
  for (const it of [...items]) {
    if (done.has(it) || it.h < 12) continue
    const row = items.filter(o => Math.min(o.y + o.h, it.y + it.h) - Math.max(o.y, it.y) >= Math.min(o.h, it.h) * 0.6)
    for (const o of row) done.add(o)
    if (row.reduce((k, o) => k + (o.text.match(/[가-힣]/g)?.length ?? 0), 0) < 2) continue
    const first = row.reduce((m, o) => (o.x < m.x ? o : m))
    // 한글로 여는 항목만 — 제목 "【목차】" 앞 장식 막대를 대시로 넣었다(나라배움터 계획)
    if (!/^[가-힣]/.test(first.text)) continue
    // 숫자 칸이 둘 이상인 표 줄은 뺀다 — 예산표 "—전기요금 5,600,000원 5,600 …" 의 줄표를 "-" 로 넣었다(부천 예산서)
    if (row.filter(o => /\d/.test(o.text)).length >= 2) continue
    const y0 = Math.min(...row.map(o => o.y)), y1 = Math.max(...row.map(o => o.y + o.h)), h = y1 - y0
    const x0 = Math.max(0, Math.round(first.x - 2.5 * h)), x1 = first.x - 2
    let minX = -1, maxX = -1, minY = Infinity, maxY = -1, groups = 0
    for (let x = x0; x < x1; x++) {
      let on = false
      for (let y = y0; y < y1; y++) if (dark(x, y) && !inBox(x, y)) { on = true; if (y < minY) minY = y; if (y > maxY) maxY = y }
      if (!on) continue
      if (maxX < 0 || x - maxX > 2) { groups++; if (groups === 1) minX = x }
      maxX = x
    }
    const bw = maxX - minX + 1, bh = maxY - minY + 1, cy = ((minY + maxY) / 2 - y0) / h
    if (groups !== 1 || bh > h * 0.2 || bw < h * 0.3 || bw > h * 1.2 || cy < 0.3 || cy > 0.7) continue
    // 막대 양끝 2~4px(1px 은 막대 자신의 번짐)에 연한 잉크도 없어야 — 조직도 연결선은 줄기·흐려진 상자 테두리에 닿는다(web068 흐림 판)
    const faint = (x: number, y: number) => { const p = (y * width + x) * 4; return ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8) < 230 }
    let touch = minX <= x0
    for (let y = minY; y <= maxY && !touch; y++) for (let d = 2; d <= 4 && !touch; d++) touch = (minX - d >= 0 && faint(minX - d, y)) || faint(maxX + d, y)
    if (touch) continue
    // 따로 "-" 아이템으로 — 첫 아이템 글에 붙이면 한 자씩 벌린 낱말("영 농 지 원 과") 합치기가 깨진다
    // 붙임표·줄표는 막대 길이로 못 가른다(부천 예산서 줄표 "—" 0.48배 < 함평 목차 "–" 0.67배, 글꼴마다 다르다) — "-"
    out.push({ text: "-", x: minX, y: y0, w: bw, h, confidence: first.confidence })
  }
  return out
}

/**
 * 줄 끝 상자 밖 잉크 무리 — 한글이 두 자 이상인 줄(같은 높이 띠)의 가장 오른쪽 아이템 뒤에서 쪽 오른 여백(폭 95%) 앞까지, 띠 안 잉크 열이 한
 * 무리뿐이고 그 무리가 띠 높이 0.5배 이상·폭 4배 이하면 그 외곽(여백 4px)을 낸다. 다른 무리가 섞이면(표 칸·글) 내지 않는다
 */
export function rowTailBoxes(rgba: Uint8Array, width: number, items: OcrItem[]): Box[] {
  const out: Box[] = []
  const dark = (x: number, y: number) => { const p = (y * width + x) * 4; return ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8) < 160 }
  const done = new Set<OcrItem>()
  for (const it of items) {
    if (done.has(it) || it.h < 12) continue
    const row = items.filter(o => Math.min(o.y + o.h, it.y + it.h) - Math.max(o.y, it.y) >= Math.min(o.h, it.h) * 0.6)
    for (const o of row) done.add(o)
    // 한글 목차·본문 줄만 — 영문 그림의 축 눈금 줄에서 숫자를 지어냈다(ODL 137)
    if (row.reduce((k, o) => k + (o.text.match(/[가-힣]/g)?.length ?? 0), 0) < 2) continue
    const last = row.reduce((m, o) => (o.x + o.w > m.x + m.w ? o : m))
    // 이미 숫자로 끝난 줄은 뺀다 — 기울인 목차에서 리더 조각이 읽은 쪽 번호 잉크가 상자 밖으로 삐져 한 번 더 넣었다(khs 예산서 기울임 판)
    if (/\d$/.test(last.text.trim())) continue
    const y0 = Math.min(...row.map(o => o.y)), y1 = Math.max(...row.map(o => o.y + o.h)), h = y1 - y0
    const x0 = last.x + last.w + 4, x1 = Math.floor(width * 0.95)
    if (x1 - x0 < h) continue
    // 글자 사이 틈(띠 높이 안)은 한 무리 — 다른 무리는 높이보다 멀리 떨어진 것. 잉크 높이가 띠의 0.3배 안 되는 열(리더 점)은 무리에 넣지
    // 않는다 — 상자가 제목에서 끊긴 목차 줄은 점 줄과 쪽 번호가 한 무리로 이어져 폭 상한에 걸렸다(나라배움터 계획 "1. 운영 개요 ····· 1")
    const groups: { minX: number; maxX: number; minY: number; maxY: number }[] = []
    for (let x = x0; x < x1; x++) {
      let top = -1, bot = -1
      for (let y = y0; y < y1; y++) if (dark(x, y)) { if (top < 0) top = y; bot = y }
      if (top < 0 || bot - top + 1 < h * 0.3) continue
      const g = groups[groups.length - 1]
      if (!g || x - g.maxX > h) groups.push({ minX: x, maxX: x, minY: top, maxY: bot })
      else { g.maxX = x; g.minY = Math.min(g.minY, top); g.maxY = Math.max(g.maxY, bot) }
    }
    // 표 세로 테두리·틀 선은 띠 밖 위아래로 이어진다 — 무리 위·아래 2px 밖에 잉크가 있으면 무리로 세지 않는다(부천 예산서 표 오른끝·나라배움터 목차 틀)
    const height = Math.floor(rgba.length / 4 / width)
    const rule = (g: typeof groups[number]) => { for (let x = g.minX; x <= g.maxX; x++) if ((g.minY > 1 && dark(x, g.minY - 2)) || (g.maxY + 2 < height && dark(x, g.maxY + 2))) return true; return false }
    const ink = groups.filter(g => !rule(g))
    if (ink.length !== 1) continue
    const { minX, maxX, minY, maxY } = ink[0]
    if (maxY - minY + 1 < h * 0.5 || maxX - minX + 1 > h * 4) continue
    const pad = 4
    out.push({ x: Math.max(0, minX - pad), y: Math.max(0, minY - pad), w: maxX - minX + 1 + 2 * pad, h: maxY - minY + 1 + 2 * pad })
  }
  return out
}

/**
 * 상자 사이 리더로 갈린 목차 줄 — 잡음·흐림 판에서 리더 점이 끊기면 검출기가 [제목] [쪽 번호] 두 상자를 내고, 쪽 번호 열이 클러스터 표를
 * 불러 목차를 열 단위로 섞었다(제안요청서 목차 잡음 판, 원본 판은 리더까지 한 상자라 "제목 … 2"). 숫자만 든 아이템의 같은 줄 왼쪽 이웃과의
 * 틈(줄 높이 3배 이상)을 양쪽 줄 높이만큼 넓혀 잘라 리더 점 무리(line-split leaderRuns, 점 4개+)가 틈의 60% 넘게 덮으면 한 아이템으로 잇는다
 */
export function joinGapLeaders(rgba: Uint8Array, width: number, items: OcrItem[]): OcrItem[] {
  const gone = new Set<OcrItem>()
  const sameLine = (a: OcrItem, b: OcrItem) => Math.abs(a.y + a.h / 2 - (b.y + b.h / 2)) <= Math.max(a.h, b.h) / 2
  // 리더 점 조각만 읽힌 아이템("·", "…:")은 이웃으로 보지 않고, 틈 안에 있으면 리더로 지운다
  const junk = (o: OcrItem) => /^[\s.:\u00b7\u2022\u2026]+$/u.test(o.text)
  for (const num of [...items].sort((a, b) => a.x - b.x)) {
    if (gone.has(num) || !/^[\s.:\u00b7\u2026]*\d{1,4}$/u.test(num.text)) continue
    let left: OcrItem | null = null
    for (const o of items) if (o !== num && !gone.has(o) && !junk(o) && sameLine(o, num) && o.x + o.w <= num.x + 2 && (!left || o.x + o.w > left.x + left.w)) left = o
    if (!left || /\u2026/.test(left.text) || !/[가-힣A-Za-z]/.test(left.text)) continue
    const h = Math.max(left.h, num.h), g0 = left.x + left.w, g1 = num.x
    if (g1 - g0 < h * 3) continue
    // 위아래로도 줄 높이 0.25배 넓힌다 — 띠 높이만큼 큰 글자 성분은 괘선으로 빠진다(components)
    const pad = Math.round(h * 0.25), y = Math.max(0, Math.min(left.y, num.y) - pad), x = Math.max(0, Math.round(g0 - h))
    const box = { x, y, w: Math.min(width, Math.round(g1 + h)) - x, h: Math.min(Math.floor(rgba.length / 4 / width), Math.max(left.y + left.h, num.y + num.h) + pad) - y }
    const gray = grayCrop(rgba, width, box)
    const runs = leaderRuns(gray, box.w, box.h, inkStats(gray), LEADER_MIN_DOTS)
    const cover = runs.reduce((k, [a, b]) => k + Math.max(0, Math.min(b, g1 - box.x) - Math.max(a, g0 - box.x)), 0)
    if (cover < (g1 - g0) * 0.6) continue
    for (const o of items) if (junk(o) && sameLine(o, num) && o.x >= g0 - 2 && o.x + o.w <= g1 + 2) gone.add(o)
    // 탭으로 잇는다 — 따로 남은 두 아이템도 줄 묶기에서 탭으로 붙었고 텍스트층도 목차 탭 리더를 탭으로 준다. 순서만 바로잡는다
    left.text = left.text.trimEnd() + "\t" + num.text.replace(/^[\s.:\u00b7\u2026]+/u, "")
    const x2 = Math.max(left.x + left.w, num.x + num.w), y2 = Math.max(left.y + left.h, num.y + num.h)
    left.y = Math.min(left.y, num.y); left.w = x2 - left.x; left.h = y2 - left.y
    left.confidence = Math.min(left.confidence, num.confidence)
    gone.add(num)
  }
  return items.filter(it => !gone.has(it))
}

/**
 * 줄 머리 상자 밖 잉크 무리 — 한글·숫자로 여는 줄(한글 두 자 이상)의 가장 왼쪽 아이템 앞(줄 높이 4배 안), 띠 안 상자 밖 잉크 열이 한 무리뿐이고
 * 그 무리가 줄 높이(아이템 높이 중앙값) 0.5배 이상·폭 3배 이하면 그 외곽(여백 4px)을 낸다. 무늬 바탕 목차의 장 번호 "Ⅱ."·"Ⅲ." 는
 * 검출기가 상자를 치지 않았다(함평 계획 — 같은 열 "Ⅰ." 는 잡힘). 받을지는 인식 결과가 번호 꼴인지로 정한다(recognizePage)
 */
export function rowHeadBoxes(rgba: Uint8Array, width: number, items: OcrItem[]): Box[] {
  const out: Box[] = []
  const dark = (x: number, y: number) => { const p = (y * width + x) * 4; return ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8) < 160 }
  const inBox = (x: number, y: number) => items.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
  const height = Math.floor(rgba.length / 4 / width)
  const done = new Set<OcrItem>()
  for (const it of items) {
    if (done.has(it) || it.h < 12) continue
    const row = items.filter(o => Math.min(o.y + o.h, it.y + it.h) - Math.max(o.y, it.y) >= Math.min(o.h, it.h) * 0.6)
    for (const o of row) done.add(o)
    if (row.reduce((k, o) => k + (o.text.match(/[가-힣]/g)?.length ?? 0), 0) < 2) continue
    const first = row.reduce((m, o) => (o.x < m.x ? o : m))
    // 숫자로 여는 제목("2026년 군정목표")도 — 받을지는 인식 결과로 거른다
    if (!/^[가-힣\d]/.test(first.text)) continue
    const hs = row.map(o => o.h).sort((a, b) => a - b), h = hs[hs.length >> 1]
    const y0 = Math.min(...row.map(o => o.y)), y1 = Math.max(...row.map(o => o.y + o.h))
    const x0 = Math.max(0, Math.round(first.x - 4 * h)), x1 = first.x - 2
    if (x1 - x0 < h) continue
    let groups = 0, minX = -1, maxX = -1, minY = Infinity, maxY = -1
    for (let x = x0; x < x1; x++) {
      let on = false
      for (let y = y0; y < y1; y++) if (dark(x, y) && !inBox(x, y)) { on = true; if (y < minY) minY = y; if (y > maxY) maxY = y }
      if (!on) continue
      if (maxX < 0 || x - maxX > h) { groups++; if (groups === 1) minX = x }
      maxX = x
    }
    if (groups !== 1 || minX <= x0 || maxY - minY + 1 < h * 0.5 || maxX - minX + 1 > h * 3) continue
    // 표 세로 테두리·상자 변은 띠 밖으로 이어진다 — 무리 위·아래 2px 밖에 잉크가 있으면 뺀다
    let rule = false
    for (let x = minX; x <= maxX && !rule; x++) rule = (minY > 1 && dark(x, minY - 2) && !inBox(x, minY - 2)) || (maxY + 2 < height && dark(x, maxY + 2) && !inBox(x, maxY + 2))
    if (rule) continue
    // 여백은 무리 높이 0.3배 — 4px 로 바투 자르면 인식기가 가장자리 Ⅱ·Ⅲ 를 버리고 "." 만 읽었다
    const pad = Math.max(4, Math.round((maxY - minY + 1) * 0.3))
    out.push({ x: Math.max(0, minX - pad), y: Math.max(0, minY - pad), w: maxX - minX + 1 + 2 * pad, h: maxY - minY + 1 + 2 * pad })
  }
  return out
}

/**
 * 두 줄 상자의 가운데 빈 행 — 높이 30~70% 안에서 잉크가 폭 2% 이하인 행이 이어진 구간 중 가운데에 가장 가까운 것 [시작, 끝). 세로 괘선
 * (높이 85% 이상 잉크인 열)은 세지 않는다. splitRowBands 는 띠 잉크 폭을 글자 크기로 보아(세로쓰기 칸) 가로로 긴 두 줄을 한 띠로 합친다
 */
export function midBlankRow(gray: Uint8Array, w: number, h: number, ink: InkStats): [number, number] | null {
  if (h < 24) return null
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  const colInk = new Uint32Array(w)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isInk(gray[y * w + x])) colInk[x]++
  const blank = (y: number) => { let n = 0; for (let x = 0; x < w; x++) if (colInk[x] < h * 0.85 && isInk(gray[y * w + x])) n++; return n <= Math.max(1, w * 0.02) }
  let best: [number, number] | null = null
  for (let y = Math.floor(h * 0.3); y < Math.ceil(h * 0.7); y++) {
    if (!blank(y)) continue
    let a = y, b = y + 1
    while (a > 0 && blank(a - 1)) a--
    while (b < h && blank(b)) b++
    if (!best || Math.abs((a + b) / 2 - h / 2) < Math.abs((best[0] + best[1]) / 2 - h / 2)) best = [a, b]
    y = b
  }
  return best
}

/**
 * 검출기가 놓친 서식 빈칸 네모 — 코드 입력 칸 "□□□"·"□□-□□□" 는 글이 아니라 가는 테두리 네모만 늘어서 검출 지도에 글줄로 잡히지
 * 않는다(법령 별지서식 건축허가 신청서 "지역 □□□ 지구 □□□"). 검출 상자에 들지 않은 잉크 성분 가운데 속 빈 정사각(한 변 12~60px —
 * 조직도의 3pt 표시 네모는 뺀다,
 * 가로세로 0.75~1.33배, 네 변이 80% 넘게 차고 안쪽 25% 테두리 안은 비었다)을 같은 줄에서 한 변 길이 안 틈으로 이어 "□" 무리로
 * 내고, 무리 사이 짧은 가로 막대(두 변 길이 안)는 "-" 로 잇는다
 */
export function placeholderSquares(rgba: Uint8Array, width: number, height: number, items: OcrItem[]): OcrItem[] {
  const dark = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < dark.length; p++, i += 4) dark[p] = ((rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8) < 128 ? 1 : 0
  const covered = (x: number, y: number) => items.some(b => x >= b.x - 2 && x < b.x + b.w + 2 && y >= b.y - 2 && y < b.y + b.h + 2)
  const seen = new Uint8Array(width * height)
  type C = { x0: number; y0: number; x1: number; y1: number; n: number; px: number[] }
  const squares: C[] = [], bars: C[] = []
  const stack: number[] = []
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue
    const c: C = { x0: width, y0: height, x1: -1, y1: -1, n: 0, px: [] }
    stack.push(start); seen[start] = 1
    while (stack.length) {
      const p = stack.pop()!, x = p % width, y = (p - x) / width
      c.n++; if (c.px.length < 4000) c.px.push(p)
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x; if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y
      for (const q of [p - 1, p + 1, p - width, p + width]) if (q >= 0 && q < dark.length && !seen[q] && dark[q] && Math.abs((q % width) - x) <= 1) { seen[q] = 1; stack.push(q) }
      if (c.n > 4000) break
    }
    while (stack.length) { const p = stack.pop()!; seen[p] = 1 }
    const w = c.x1 - c.x0 + 1, h = c.y1 - c.y0 + 1
    if (c.n > 4000 || covered((c.x0 + c.x1) >> 1, (c.y0 + c.y1) >> 1)) continue
    if (h >= 2 && h <= 6 && w >= 4 && w <= 30 && c.n >= w * h * 0.7) { bars.push(c); continue }
    if (w < 12 || h < 12 || w > 60 || h > 60 || w > h * 1.33 || h > w * 1.33) continue
    const at = (x: number, y: number) => dark[y * width + x] === 1
    const row = (y: number) => { let k = 0; for (let x = c.x0; x <= c.x1; x++) if (at(x, y)) k++; return k / w }
    const col = (x: number) => { let k = 0; for (let y = c.y0; y <= c.y1; y++) if (at(x, y)) k++; return k / h }
    const edge = (vals: number[]) => Math.max(...vals) >= 0.8
    const top = edge([row(c.y0), row(c.y0 + 1)]), bottom = edge([row(c.y1), row(c.y1 - 1)]), left = edge([col(c.x0), col(c.x0 + 1)]), right = edge([col(c.x1), col(c.x1 - 1)])
    let inner = 0
    for (let y = c.y0 + Math.ceil(h * 0.25); y <= c.y1 - Math.ceil(h * 0.25); y++) for (let x = c.x0 + Math.ceil(w * 0.25); x <= c.x1 - Math.ceil(w * 0.25); x++) if (at(x, y)) inner++
    if (top && bottom && left && right && inner === 0) squares.push(c)
  }
  squares.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)
  const out: OcrItem[] = []
  const used = new Set<C>()
  for (const s0 of squares) {
    if (used.has(s0)) continue
    const run: C[] = [s0]
    used.add(s0)
    const side = s0.y1 - s0.y0 + 1, cy = (s0.y0 + s0.y1) / 2
    let text = "\u25a1"
    for (;;) {
      const last = run[run.length - 1]
      const next = squares.find(q => !used.has(q) && Math.abs((q.y0 + q.y1) / 2 - cy) <= side * 0.3 && q.x0 > last.x1 && q.x0 - last.x1 <= side * 2)
      if (!next) break
      const gap = next.x0 - last.x1
      const bar = bars.find(b => b.x0 > last.x1 && b.x1 < next.x0 && Math.abs((b.y0 + b.y1) / 2 - cy) <= side * 0.3)
      // 잡티가 붙은 막대는 막대 꼴 판정을 못 넘는다(잡음 판 "□□-□-□□□" → "□□□-□□□") — 틈 가운데 띠의 가로 잉크 줄 길이로도 본다
      let stroke = 0
      if (!bar) for (let y = Math.round(cy - side * 0.15); y <= Math.round(cy + side * 0.15); y++) {
        let k = 0
        for (let x = last.x1 + 1; x < next.x0; x++) { k = dark[y * width + x] ? k + 1 : 0; if (k > stroke) stroke = k }
      }
      if (bar || stroke >= Math.max(4, side * 0.25)) text += "-"
      else if (gap > side) break
      text += "\u25a1"
      used.add(next); run.push(next)
    }
    const x0 = run[0].x0, x1 = run[run.length - 1].x1
    out.push({ text, x: x0, y: s0.y0, w: x1 - x0 + 1, h: side, confidence: 0.9 })
  }
  return out
}

/**
 * 검출기가 놓친 쪽 번호 꼬리말 — 띄엄띄엄 얇은 "-   1   -" 는 DB 검출 지도에서 글줄로 이어지지 않아 상자가 아예 없다(국회 예산 검토
 * 보고서·연구 보고서·업무보고 첫 쪽). 쪽 아래 12%·가운데 40% 띠에서 검출 상자에 들지 않은 잉크의 외곽이 쪽 높이 0.5~2.5% 면
 * 그 외곽(여백 4px)을 인식 상자로 하나 더 낸다 — 결과가 쪽 번호 꼴("- 1 -"·"3"·"- ii -")이 아니면 버린다
 */
export function footerInkBox(rgba: Uint8Array, width: number, height: number, boxes: Box[]): Box | null {
  const y0 = Math.floor(height * 0.88), x0 = Math.floor(width * 0.3), x1 = Math.ceil(width * 0.7)
  let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1
  for (let y = y0; y < height; y++) for (let x = x0; x < x1; x++) {
    const p = (y * width + x) * 4
    if ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8 >= 128) continue
    if (boxes.some(b => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)) continue
    if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y
  }
  if (maxX < 0) return null
  const bh = maxY - minY + 1
  if (bh < height * 0.005 || bh > height * 0.025 || maxX - minX + 1 > width * 0.2) return null
  const pad = 4, bx = Math.max(0, minX - pad), by = Math.max(0, minY - pad)
  return { x: bx, y: by, w: Math.min(width, maxX + pad + 1) - bx, h: Math.min(height, maxY + pad + 1) - by }
}

/**
 * 서식 칸에서 멀리 떨어진 닫는 괄호 — "(전화 :            )" 처럼 빈칸 뒤 홀로 선 ")" 는 검출기가 상자로 잡지 않는다(법령 별지서식
 * 신청서 주소 칸). 닫히지 않은 "(" 로 끝나는 줄 박스 오른쪽, 같은 높이 띠에서 다음 박스 앞까지 잉크가 좁고 키 큰 조각 하나뿐이면
 * 그 자리에 ")" 아이템을 낸다(폭 ≤ 띠 높이 0.5·높이 ≥ 0.6, 박스 높이 16배 안 — 건축허가신청서 전화 칸은 14배)
 */
export function closingParens(rgba: Uint8Array, width: number, items: OcrItem[]): OcrItem[] {
  const out: OcrItem[] = []
  const dark = (x: number, y: number) => { const p = (y * width + x) * 4; return ((rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8) < 128 }
  for (const it of items) {
    const t = it.text.replace(/\s+$/, "")
    if ((t.match(/\(/g)?.length ?? 0) <= (t.match(/\)/g)?.length ?? 0) || !/\([^()]*$/.test(t)) continue
    const x0 = it.x + it.w + 2
    const next = items.filter(o => o !== it && o.x >= x0 && o.y < it.y + it.h && o.y + o.h > it.y).reduce((m, o) => Math.min(m, o.x), Infinity)
    let x1 = Math.min(width, next, x0 + it.h * 16)
    // 칸 세로 테두리(띠 높이 90% 넘게 잉크인 열)에서 끊는다 — ")" 바로 뒤 테두리를 둘째 무리로 세어 놓쳤다(대리인선임허가신청서 "(전화:      )│")
    const pageH = Math.floor(rgba.length / 4 / width)
    const colInk = (x: number) => { let k = 0; for (let y = it.y; y < it.y + it.h; y++) if (dark(x, y)) k++; return k }
    for (let x = x0; x < x1; x++) if (colInk(x) >= it.h * 0.9) { x1 = x; while (x1 > x0 && colInk(x1 - 1) >= it.h * 0.5) x1--; break }
    // 상자가 문 칸 가로 괘선 줄(그 구간 80% 넘게 잉크)은 빼고 본다 — 위 칸 괘선까지 문 상자는 띠 전체가 한 무리가 됐다
    const ruleRow = new Set<number>()
    // 괘선 줄 위아래 한 줄도 — 테두리와 만나는 모서리 번짐이 따로 한 무리가 됐다
    for (let y = it.y; y < it.y + it.h; y++) { let k = 0; for (let x = x0; x < x1; x++) if (dark(x, y)) k++; if (k > (x1 - x0) * 0.8) for (const d of [-1, 0, 1]) ruleRow.add(y + d) }
    let minX = Infinity, maxX = -1, minY = Infinity, maxY = -1, cols = 0, prevOn = false, runs = 0
    for (let x = x0; x < x1; x++) {
      let on = false
      for (let y = it.y; y < it.y + it.h; y++) if (!ruleRow.has(y) && dark(x, y)) { on = true; if (y < minY) minY = y; if (y > maxY) maxY = y }
      if (on) { cols++; if (!prevOn) runs++; if (x < minX) minX = x; maxX = x }
      prevOn = on
    }
    if (runs !== 1 || maxX - minX + 1 > it.h * 0.5 || maxY - minY + 1 < it.h * 0.6) continue
    // 칸 세로 테두리는 띠 밖으로 멀리 이어진다 — 위아래로 이어진 잉크 줄이 띠 높이 0.6배를 넘으면 뺀다(괄호는 한글 상자보다 몇 px
    // 삐져나올 뿐이다, 건축허가신청서 "(전화번호:            )")
    const inkRow = (y: number) => { for (let x = minX; x <= maxX; x++) if (dark(x, y)) return true; return false }
    let over = 0
    for (let y = minY - 1; y >= 0 && !ruleRow.has(y) && inkRow(y) && over <= it.h; y--) over++
    for (let y = maxY + 1; y < pageH && !ruleRow.has(y) && inkRow(y) && over <= it.h; y++) over++
    if (over > it.h * 0.6) continue
    // ")" 는 가운데가 오른쪽으로 휜다 — 위·아래 20% 줄의 잉크 x 평균보다 가운데 줄이 오른쪽
    const meanX = (ya: number, yb: number) => { let sx = 0, k = 0; for (let y = ya; y < yb; y++) for (let x = minX; x <= maxX; x++) if (dark(x, y)) { sx += x; k++ } return k ? sx / k : NaN }
    const ch = maxY - minY + 1, band = Math.max(1, Math.round(ch * 0.2))
    const ends = (meanX(minY, minY + band) + meanX(maxY + 1 - band, maxY + 1)) / 2, mid = meanX(minY + Math.floor(ch * 0.4), minY + Math.ceil(ch * 0.6))
    if (!(mid - ends >= 0.8)) continue
    out.push({ text: ")", x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1, confidence: it.confidence })
  }
  return out
}

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
  /**
   * 박스 바깥 줄 머리 □ — 가는 테두리 □ 는 검출기가 글줄 박스에 넣지 않아 박스 왼쪽에 따로 남고 통째로 빠진다(장흥 계획 "□ 비전 및 목표",
   * 함평 "□ 국내외 여건"). 한글 넷 이상 줄의 박스 왼쪽 높이 1.6배 띠에 다른 박스가 없고, 넓힌 crop 의 맨 앞 덩어리가 속 빈 □ 인데
   * 박스 첫 글자에 걸치지 않으면 붙인다. 이 □ 는 글자 높이만큼 커(1.0배) 박스 안 판정 상한(0.92)을 1.05 로 푼다
   */
  private outerSquare(rgba: Uint8Array, width: number, it: OcrItem, items: OcrItem[]): void {
    if (/^[◎●▪□■▣❐❏○ㅇ‣\u2022·]/.test(it.text) || (it.text.match(/[가-힣]/g) ?? []).length < 4) return
    const ext = Math.round(it.h * 1.6), x = Math.max(0, it.x - ext)
    if (it.x - x < it.h * 0.8) return
    if (items.some(o => o !== it && o.x < it.x && o.x + o.w > x && o.y < it.y + it.h && o.y + o.h > it.y)) return
    const box = { x, y: it.y, w: it.x + it.w - x, h: it.h }
    const g = grayCrop(rgba, width, box)
    const b = leadingBullet(g, box.w, box.h, inkStats(g), it.x - x, 1.05)
    if (b?.mark !== "\u25a1" || b.covers) return
    // 박스 왼끝을 □ 왼끝(띠의 첫 잉크 열)으로 넓힌다
    const ink = inkStats(g), on = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
    let left = 0
    while (left < it.x - x && !Array.from({ length: box.h }, (_, y) => g[y * box.w + left]).some(on)) left++
    it.text = "\u25a1 " + it.text
    it.w += it.x - (x + left)
    it.x = x + left
  }

  async recognizePage(
    rgba: Uint8Array,
    width: number,
    height: number,
    stats?: OcrPageStats,
    tuning: Readonly<OcrTuning> = DEFAULT_OCR_TUNING,
    cellRules: Array<{ x1: number; y1: number; y2: number; thicknessPx: number }> = [],
    rowRules: Array<{ x1: number; x2: number; y1: number; thicknessPx: number }> = [],
  ): Promise<OcrItem[]> {
    if (width < DET_MIN_SIZE || height < DET_MIN_SIZE) return []
    const detected = await this.detect(rgba, width, height, tuning, stats)
    // 가로 표를 90° 눕혀 찍은 쪽(통계 간행물 가로 표) — 글줄 상자 대부분이 세로로 길다. 키 큰 상자 몇 개를 그대로·90°·270° 로 읽어
    // 돌린 쪽이 확실히 더 잘 읽히면 그 각을 적고 돌아간다. 상자 하나씩 돌려 읽으면(ROTATE_RATIO) 글은 나와도 표 행·열이 뒤바뀐다
    if (tuning.orientPage && stats && detected.length >= ORIENT_MIN_BOXES) {
      const tall = detected.filter(b => b.h >= b.w * TALL_RATIO)
      if (tall.length >= detected.length * ORIENT_TALL_SHARE) {
        const sample = [...tall].sort((a, b) => b.h - a.h).slice(0, ORIENT_SAMPLE)
        const rots = [0, 90, 270] as const
        const probe = await this.recognizeJobs(rgba, width, sample.flatMap((box, group) => rots.map(rot => ({ box, rot, group }))), tuning.recBatch)
        const mean = (k: number) => sample.reduce((sum, _, i) => sum + (probe[i * rots.length + k]?.confidence ?? 0), 0) / sample.length
        const [m0, m90, m270] = rots.map((_, k) => mean(k))
        const best = Math.max(m90, m270)
        if (best >= ORIENT_MIN_CONF && best >= m0 + ORIENT_GAIN) {
          stats.pageRotation = m90 >= m270 ? 90 : 270
          return []
        }
      }
    }
    const rows = rowRules.length ? detected.flatMap(b => splitBoxAtRowRules(b, rowRules)) : detected
    const boxes = cellRules.length ? rows.flatMap(b => splitBoxAtCellRules(b, cellRules)) : rows
    const footer = tuning.postprocess ? footerInkBox(rgba, width, height, boxes) : null

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

    if (footer) jobs.push({ box: footer, rot: 0, group: group++, footer: true })
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
    // 지운 crop 만 줄 머리 가운뎃점을 읽은 그룹 — 원본 crop 은 윗줄 끝자락에 묻혀 "·" 를 놓쳤다("·군의원" → "군의원", 선관위 사례집 표
    // 칸). 공백 빼고 나머지 글이 같으면 원본 결과 앞에 "·" 를 붙인다
    jobs.forEach((job, i) => {
      const r = results[i], cur = best.get(job.group)
      if (!job.keep || !r || !cur || cur.job === job) return
      const b = cur.text.replace(/\s/g, "")
      if (r.text.replace(/\s/g, "") === "\u00b7" + b && /^[가-힣]/.test(b)) best.set(job.group, { ...cur, text: "\u00b7" + cur.text, steps: [r.steps[0], ...cur.steps] })
    })

    let items: OcrItem[] = []
    /** 신뢰도에 걸려 버린 상자 — 줄 띠가 둘 이상이면 띠마다 다시 읽는다(아래) */
    const retry: Box[] = []
    for (const r of best.values()) {
      const { job, confidence, stepPx } = r
      const { text: read, steps } = tuning.postprocess && job.rot === 0 ? trimInklessEnds(rgba, width, job.box, r.text, r.steps, stepPx) : r
      const note: { ringLead?: boolean } = {}
      const raw = tuning.postprocess && job.rot === 0 ? restoreGlyphs(rgba, width, job.box, read, steps, stepPx, note) : read
      let text = tuning.postprocess ? restoreSymbols(raw.trim(), note.ringLead) : raw
      if (!text.trim()) continue
      // 빗금 하나만 든 칸을 "(/:"·"(/" 로 지어 읽었다(여수 인원표 "현원/정원" 칸) — 키 큰 잉크 덩어리가 하나뿐이면 "/"
      if (tuning.postprocess && job.rot === 0 && text !== "/" && /^[(:;/)]+$/.test(text) && text.includes("/")) {
        const g = grayCrop(rgba, width, job.box)
        if (tallInkCount(g, job.box.w, job.box.h, inkStats(g)) === 1) text = "/"
      }
      // 사전 밖·작은 점으로 읽히거나 빠지는 글머리(◎ ● ▪ □) — 첫 글리프 모양으로 되살린다 (line-split.ts)
      let ringByShape = false
      if (tuning.postprocess && job.rot === 0 && !/^[◎●▪□■▣❐❏○ㅇ◆◇◈]/.test(text)) {
        const chars = [...read], k = chars.findIndex(c => c.trim())
        if (k >= 0 && steps.length === chars.length) {
          const g = grayCrop(rgba, width, job.box)
          const b = leadingBullet(g, job.box.w, job.box.h, inkStats(g), (steps[k] + 0.5) * stepPx)
          // ◎ 는 "O" 로 잘못 읽은 자리만 바꾼다(장식 아이콘에 끼워 넣지 않게). ●▪ 는 본문 줄(뒤 글 한글 4음절 이상)에서만 —
          // 표 칸의 큰 가운뎃점("·수학"·"·승합", 글꼴에 따라 네모·원으로 그려짐)은 정답도 "·" 다
          const body = (text.match(/[가-힣]/g) ?? []).length >= 4
          const miss = /^[Oo0•·ㆍ∙‧○]/.test(text)
          // © 로도 읽는다(1° 기울인 함평 목차 ◎ 열)
          if (b?.mark === "\u25ce" && b.covers && /^[Oo0○©]/.test(text)) { text = b.mark + " " + text.slice(1).trimStart(); ringByShape = true }
          // □ 는 인식에서 빠진 자리만(첫 글자 앞) — 모델은 사전에 □ 가 있어도 내지 않고 통째로 빠뜨린다
          else if (b?.mark === "\u25a1" || b?.mark === "\u25a3") { if (!b.covers && body) text = b.mark + " " + text }
          // 마름모 ◆◇◈ 는 사전 밖이라 다른 기호(√ 등)로 읽거나 빠뜨린다 — 기호 글자 자리면 바꾸고, 빠졌으면 본문 줄에 붙인다
          else if (b?.mark === "\u25c6" || b?.mark === "\u25c7" || b?.mark === "\u25c8") {
            if (b.covers ? /^[\p{S}\p{P}]/u.test(text) : body) text = b.covers ? b.mark + " " + text.slice(1).trimStart() : b.mark + " " + text
          }
          // ❐ 는 모델이 자모 ㅁ 으로 읽거나 빠뜨린다 — 그림자 모양으로 정했으니 그 글자를 바꾸거나 붙인다
          else if (b?.mark === "\u2023") { if (b.covers ? text.startsWith("\u2192") : body) text = b.covers ? b.mark + " " + text.slice(1).trimStart() : b.mark + " " + text }
          else if (b?.mark === "\u2750" || b?.mark === "\u274f") { if (b.covers ? /^[ㅁ口]/.test(text) : body) text = b.covers ? b.mark + text.slice(1) : b.mark + " " + text }
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
      // 홀로 선 화살표는 모양대로 — 사전에 → 만 있다 (line-split arrowGlyph)
      if (tuning.postprocess && text === "\u2192" && job.rot === 0 && job.join === undefined) {
        const g = grayCrop(rgba, width, job.box)
        text = arrowGlyph(g, job.box.w, job.box.h, inkStats(g)) ?? text
      }
      // 쪽 번호 꼴만 받고 막대는 붙임표로(OCR 코퍼스 정답 쪽 번호 31곳 모두 "-")
      if (job.footer) {
        if (!/^[-\u2013\u2014]?\s*(?:\d{1,4}|[ivxIVXⅰ-ⅹⅠ-Ⅹ]{1,4})\s*[-\u2013\u2014]?$/.test(text.trim())) continue
        text = text.replace(/[\u2013\u2014]/g, "-")
      }
      if (tuning.postprocess && isDotFragment(text)) continue
      // 모양으로 정한 ◎ 하나만 든 상자(목차 ◎ 열)는 인식 신뢰도와 상관없이 받는다 — 기울기 보정 뒤 "◎" 를 0.27~0.43 으로 읽어 열 절반이 빠졌다
      if (confidence < tuning.textScore && !(ringByShape && text.trim() === "\u25ce")) {
        if (tuning.postprocess && job.rot === 0 && job.join === undefined && !job.footer) retry.push(job.box)
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
    // 두 줄을 한 상자로 잡아 인식이 무너진 표 칸 — 상자가 넓어 세로로 긴 상자 가르기(splitTall)에 안 걸린다(여수 인원표 "산 단 환 경 /
    // 관 리 과" 가 "살다까" 로 읽혀 버려짐). 버려질 상자만 가운데 빈 행에서 두 줄로 갈라 다시 읽어 신뢰도를 넘는 줄을 받는다
    if (retry.length) {
      const subs: Box[] = []
      for (const b of retry) {
        const gray = grayCrop(rgba, width, b)
        const cut = midBlankRow(gray, b.w, b.h, inkStats(gray))
        // 가로 글줄만 — 좁은 세로쓰기 조직도 칸("중앙노동위원회")의 두 글자 조각("원회")은 순서가 섞여 들어갔다(web068)
        if (cut && b.w >= 3 * Math.max(cut[0], b.h - cut[1])) subs.push({ ...b, h: cut[0] }, { ...b, y: b.y + cut[1], h: b.h - cut[1] })
      }
      // 이미 읽힌 아이템과 반 넘게 겹치는 줄은 뺀다 — 검출기가 두 줄 상자와 아랫줄 상자를 함께 내 "봉림동" 이 두 번 들어갔다(창원 계획)
      const overlap = (a: Box, o: OcrItem) => Math.max(0, Math.min(a.x + a.w, o.x + o.w) - Math.max(a.x, o.x)) * Math.max(0, Math.min(a.y + a.h, o.y + o.h) - Math.max(a.y, o.y))
      for (let k = subs.length - 1; k >= 0; k--) if (subs[k].h < 8 || items.some(o => overlap(subs[k], o) * 2 > subs[k].w * subs[k].h)) subs.splice(k, 1)
      const res = subs.length ? await this.recognizeJobs(rgba, width, subs.map((box, k) => ({ box, rot: 0 as const, group: k })), tuning.recBatch) : []
      subs.forEach((box, k) => {
        const r = res[k]
        // 문턱은 본 인식보다 높게 — 그림 속 작은 글("e-learning" → "eleanig" 0.79)이 붙었다(나라배움터 계획)
        if (!r || r.confidence < RETRY_SCORE) return
        const text = restoreSymbols(restoreGlyphs(rgba, width, box, r.text, r.steps, r.stepPx).trim())
        // 글자·숫자가 두 자 이상이어야 — 장식 띠를 "---" 로 읽었고(경기 학교 매뉴얼 머리), 그림 세로 축 글자 한 자("s")가 끼어 줄 묶음이 바뀌었다(ODL 134)
        if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 2) items.push({ text, ...this.itemBox(rgba, width, box, tuning), confidence: r.confidence })
      })
    }
    const leaderEnds = new Map<OcrItem, { lead: boolean; trail: boolean }>()
    for (const j of joins) {
      if (!j.parts.length) continue
      j.parts.sort((a, b) => a.x - b.x)
      let text = ""
      // 리더 점 무리 가장자리에 걸친 점·쌍점 조각은 리더의 일부다("행정지원국 : … 419", "추진방향· … 7")
      const junk = /[\s.:\u00b7\u2022\u2024\u2025\u2026\u2219\u22c5\u318d]+$/u
      for (const p of j.parts) {
        if (p.dotsBefore) text = text.replace(junk, "")
        const t = p.dotsBefore ? p.text.replace(/^[\s.:\u00b7\u2022\u2024\u2025\u2026\u2219\u22c5\u318d]+/u, "") : p.text
        if (t) text += (p.dotsBefore ? (text ? " \u2026 " : "\u2026") : text ? " " : "") + t
      }
      if (j.trailDots) text = text.replace(junk, "") + " \u2026"
      text = text.trim()
      if (!text) continue
      const item = { text, ...this.itemBox(rgba, width, j.box, tuning), confidence: Math.min(...j.parts.map(p => p.confidence)) }
      items.push(item)
      // 첫 조각이 점·쌍점 잡티였다 지워졌으면 박스는 리더로 시작한다
      leaderEnds.set(item, { lead: text.startsWith("\u2026"), trail: j.trailDots })
    }
    if (leaderEnds.size) items = joinLeaderItems(items, leaderEnds)
    if (tuning.postprocess) items = dropNestedFragments(items)
    if (tuning.postprocess) for (const it of items) this.outerSquare(rgba, width, it, items)
    if (tuning.postprocess) items.push(...closingParens(rgba, width, items))
    if (tuning.postprocess) items.push(...placeholderSquares(rgba, width, height, items))
    if (tuning.postprocess) items.push(...rowHeadDashes(rgba, width, items))
    if (tuning.postprocess) {
      // 줄 끝 쪽 번호 — 목차 줄 오른쪽 끝의 홑 숫자("1. 사업 개요 … 1")는 획이 가늘고 홀로 서서 검출기가 놓친다(같은 열의 "9" 는 잡힌다).
      // 아이템 줄 오른쪽, 같은 높이 띠에 상자 밖 잉크 무리가 하나뿐이면 다시 인식해 숫자만 받는다
      const tails = rowTailBoxes(rgba, width, items)
      if (tails.length) {
        const res = await this.recognizeJobs(rgba, width, tails.map((box, k) => ({ box, rot: 0 as const, group: k })), tuning.recBatch)
        tails.forEach((box, k) => {
          const t = res[k]?.text.trim() ?? ""
          if (/^\d{1,4}$/.test(t) && (res[k]?.confidence ?? 0) >= tuning.textScore) items.push({ text: t, ...this.itemBox(rgba, width, box, tuning), confidence: res[k]!.confidence })
        })
      }
      // 줄 머리 장 번호 — 같은 방식으로 앞쪽 무리를 다시 인식해 번호 꼴("Ⅱ."·"III."·"3.")만 받는다
      const heads = rowHeadBoxes(rgba, width, items)
      if (heads.length) {
        const res = await this.recognizeJobs(rgba, width, heads.map((box, k) => ({ box, rot: 0 as const, group: k })), tuning.recBatch)
        heads.forEach((box, k) => {
          const t = res[k]?.text.trim() ?? ""
          if (/^(?:[IVXⅠ-Ⅻ]{1,4}|\d{1,2})\s?\.$/.test(t) && (res[k]?.confidence ?? 0) >= tuning.textScore) items.push({ text: t, ...this.itemBox(rgba, width, box, tuning), confidence: res[k]!.confidence })
        })
      }
    }
    // 줄 끝 쪽 번호(rowTailBoxes)까지 들어온 뒤에 잇는다
    if (tuning.postprocess) items = joinGapLeaders(rgba, width, items)
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
