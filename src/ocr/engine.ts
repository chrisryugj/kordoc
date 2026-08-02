/**
 * 내장 텍스트 OCR 엔진 — PP-OCRv5 korean (det DBNet + rec SVTR/CTC) ONNX 추론.
 *
 * 파이프라인: 페이지 RGBA → det(선 검출) → 라인 crop → rec(CTC 인식) → OcrItem[]
 * (좌표는 입력 픽셀 기준 top-left origin — 호출자가 PDF 좌표계로 변환).
 *
 * 전·후처리는 공식 inference.yml 스펙 그대로:
 *  - det: BGR, 긴 변 960 리사이즈(32 배수), mean/std [0.485,0.456,0.406]/[0.229,0.224,0.225],
 *         DBPostProcess thresh 0.3 / box_thresh 0.6 / unclip_ratio 1.5
 *  - rec: BGR, 높이 48 고정 비율 리사이즈 + 우측 zero-pad, (x/255-0.5)/0.5,
 *         CTC 디코드 (blank=0, 1..N=사전, N+1=공백), text_score 0.5
 * DB 후처리의 contour+minAreaRect 는 축정렬 connected-component bbox 로 근사
 * (공문서 스캔은 수평 텍스트가 지배적 — 회전 텍스트는 v1 범위 밖).
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

/** det 입력 긴 변 (공식 resize_long) — 1920 보존 실험은 recall Δ median +0.04pp에
 *  속도 -25%로 기각 (bench/ocr-accuracy.mjs 실측, 2026-08-02) */
const DET_LONG_SIDE = 960
const DET_THRESH = 0.3
const DET_BOX_THRESH = 0.6
const DET_UNCLIP_RATIO = 1.5
const DET_MIN_SIZE = 3
const DET_MAX_BOXES = 1000
const REC_HEIGHT = 48
const REC_MIN_WIDTH = 320
const REC_MAX_WIDTH = 3200
const TEXT_SCORE = 0.5

// det: BGR 채널 순서에 yml 기재 순서 그대로 적용 (mean[0]→B)
const DET_MEAN = [0.485, 0.456, 0.406]
const DET_STD = [0.229, 0.224, 0.225]

type SharpFactory = (
  input: Uint8Array | Buffer,
  options?: { raw?: { width: number; height: number; channels: number } },
) => SharpChain
interface SharpChain {
  extract(region: { left: number; top: number; width: number; height: number }): SharpChain
  resize(w: number, h: number, opts?: { fit?: string }): SharpChain
  removeAlpha(): SharpChain
  raw(): { toBuffer(): Promise<Buffer> }
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
    stats?: { droppedLowConf: number },
  ): Promise<OcrItem[]> {
    if (width < DET_MIN_SIZE || height < DET_MIN_SIZE) return []
    const boxes = await this.detect(rgba, width, height)
    const items: OcrItem[] = []
    for (const b of boxes) {
      const r = await this.recognizeLine(rgba, width, height, b)
      if (!r || !r.text.trim()) continue
      if (r.confidence >= TEXT_SCORE) items.push(r)
      else if (stats) stats.droppedLowConf++
    }
    items.sort((a, b) => (a.y - b.y) || (a.x - b.x))
    return items
  }

  // ─── det ─────────────────────────────────────────────

  private async detect(
    rgba: Uint8Array,
    width: number,
    height: number,
  ): Promise<Array<{ x: number; y: number; w: number; h: number }>> {
    const ratio = DET_LONG_SIDE / Math.max(width, height)
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

    const rawBoxes = componentBoxes(probMap, dw, dh)
    const sx = width / dw
    const sy = height / dh
    const boxes: Array<{ x: number; y: number; w: number; h: number }> = []
    for (const rb of rawBoxes.slice(0, DET_MAX_BOXES)) {
      // unclip: DB 는 학습 시 텍스트 영역을 수축시키므로 검출 박스를 되팽창
      const bw = rb.x2 - rb.x1 + 1
      const bh = rb.y2 - rb.y1 + 1
      const delta = (bw * bh * DET_UNCLIP_RATIO) / (2 * (bw + bh))
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

  private async recognizeLine(
    rgba: Uint8Array,
    width: number,
    height: number,
    box: { x: number; y: number; w: number; h: number },
  ): Promise<OcrItem | null> {
    const rw = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((box.w * REC_HEIGHT) / box.h)))
    const padded = Math.max(REC_MIN_WIDTH, rw)

    const rgb = await this.sharp(rgba, { raw: { width, height, channels: 4 } })
      .extract({ left: box.x, top: box.y, width: box.w, height: box.h })
      .resize(rw, REC_HEIGHT, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer()

    // HWC RGB → CHW BGR, (x/255-0.5)/0.5, 우측 zero-pad
    const plane = padded * REC_HEIGHT
    const input = new Float32Array(3 * plane) // pad 영역은 0 (=정규화 후 회색 아님 주의: PP 도 0 pad)
    for (let y = 0; y < REC_HEIGHT; y++) {
      for (let x = 0; x < rw; x++) {
        const src = (y * rw + x) * 3
        const dst = y * padded + x
        input[dst] = rgb[src + 2] / 255 / 0.5 - 1 // B
        input[plane + dst] = rgb[src + 1] / 255 / 0.5 - 1 // G
        input[2 * plane + dst] = rgb[src] / 255 / 0.5 - 1 // R
      }
    }

    const tensor = new this.ort.Tensor("float32", input, [1, 3, REC_HEIGHT, padded])
    const out = await this.rec.run({ [this.rec.inputNames[0]]: tensor })
    const logits = out[this.rec.outputNames[0]]
    const [, T, C] = logits.dims as number[]
    const data = logits.data as Float32Array

    const decoded = ctcDecode(data, T, C, this.dict)
    if (!decoded) return null
    return { text: decoded.text, x: box.x, y: box.y, w: box.w, h: box.h, confidence: decoded.confidence }
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
): Array<{ x1: number; y1: number; x2: number; y2: number }> {
  const visited = new Uint8Array(w * h)
  const boxes: Array<{ x1: number; y1: number; x2: number; y2: number; score: number }> = []
  const stack: number[] = []

  for (let start = 0; start < w * h; start++) {
    if (visited[start] || prob[start] <= DET_THRESH) continue
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
      if (px > 0 && !visited[p - 1] && prob[p - 1] > DET_THRESH) { visited[p - 1] = 1; stack.push(p - 1) }
      if (px < w - 1 && !visited[p + 1] && prob[p + 1] > DET_THRESH) { visited[p + 1] = 1; stack.push(p + 1) }
      if (py > 0 && !visited[p - w] && prob[p - w] > DET_THRESH) { visited[p - w] = 1; stack.push(p - w) }
      if (py < h - 1 && !visited[p + w] && prob[p + w] > DET_THRESH) { visited[p + w] = 1; stack.push(p + w) }
    }
    if (x2 - x1 + 1 < DET_MIN_SIZE && y2 - y1 + 1 < DET_MIN_SIZE) continue
    boxes.push({ x1, y1, x2, y2, score: sum / count })
  }

  return boxes
    .filter(b => b.score >= DET_BOX_THRESH)
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
