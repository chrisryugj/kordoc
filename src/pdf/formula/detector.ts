/**
 * MFD (Mathematical Formula Detection) — YOLOv8 기반 수식 영역 검출
 *
 * 모델: breezedeus/pix2text-mfd (YOLOv8 small, imgsz=768, stride=32)
 * 출력: [1, 6, 12096] — (cx, cy, w, h, class0_score, class1_score) × anchors
 *   - class 0 = embedding (inline 수식)
 *   - class 1 = isolated (display 수식)
 *
 * 전처리: letterbox (긴 변 비율 유지 + 회색 패딩 114)
 * 후처리: conf ≥ 0.25 → class-per-class NMS (IoU ≥ 0.45) → 여러 줄 display 넓히기(growDisplays)
 */

import type { InferenceSession, Tensor } from "onnxruntime-node"
import type { FormulaKind, PixelFrame, FormulaRegion } from "./types.js"

const MFD_IMG_SIZE = 768
const MFD_NUM_CLASSES = 2
const MFD_CHANNELS = 4 + MFD_NUM_CLASSES
/** 기본 confidence 임계값 (Pix2Text 원본 0.25 — 누락은 적지만 noise 발생) */
const MFD_CONF_INLINE = 0.30
/** display 수식 임계값 — diagram/figure 오탐 감소 목적으로 inline 보다 높게 */
const MFD_CONF_DISPLAY = 0.40
const MFD_IOU_THRESHOLD = 0.45
/**
 * 여러 줄 display 식으로 넓힐 낮은 점수 후보 하한 — 검출기는 정렬식("E[…]" 다음 "=E[…]"·"≤…" 줄들)에서 첫 줄·끝 줄만 문턱을 넘기고
 * 식 전체 상자는 .1~.37 로 냈다(arXiv 2609.15723 p24: 여섯 줄 중 넷을 놓침)
 */
const MFD_CONF_DISPLAY_GROW = 0.10
/** 최소 bbox 면적 (px²) — 이보다 작으면 OCR noise 가능성 높음 */
const MFD_MIN_AREA = 80
const PAD_VALUE = 114 / 255

interface RawDetection {
  x1: number
  y1: number
  x2: number
  y2: number
  kind: FormulaKind
  score: number
}

/**
 * 단일 페이지 이미지에서 수식 영역 검출 (인식 없음 — recognizer 로 넘김).
 * bbox 는 원본 이미지 좌표계.
 */
export async function detectFormulaRegions(
  session: InferenceSession,
  frame: PixelFrame,
  ort: typeof import("onnxruntime-node"),
): Promise<Omit<FormulaRegion, "latex">[]> {
  const { scale, padX, padY, tensor } = letterbox(frame, MFD_IMG_SIZE)

  const input = new ort.Tensor("float32", tensor, [1, 3, MFD_IMG_SIZE, MFD_IMG_SIZE])
  const feeds: Record<string, Tensor> = { images: input }
  const outputs = await session.run(feeds)

  const firstKey = Object.keys(outputs)[0]
  const out = outputs[firstKey]
  if (!out || out.type !== "float32") {
    throw new Error("MFD 출력 없음 또는 dtype 불일치")
  }

  const outDims = out.dims
  if (outDims.length !== 3) {
    throw new Error(`MFD 출력 차원 예상 3, 실제 ${outDims.length}: [${outDims.join(",")}]`)
  }
  const channels = outDims[1]
  const anchors = outDims[2]
  if (channels !== MFD_CHANNELS) {
    throw new Error(`MFD 채널 수 예상 ${MFD_CHANNELS}, 실제 ${channels}`)
  }
  if (anchors <= 0) return []

  const data = out.data as Float32Array
  const candidates: RawDetection[] = []

  for (let a = 0; a < anchors; a++) {
    const cx = data[a]
    const cy = data[anchors + a]
    const w = data[2 * anchors + a]
    const h = data[3 * anchors + a]

    let bestCls = 0
    let bestScore = 0
    for (let c = 0; c < MFD_NUM_CLASSES; c++) {
      const s = data[(4 + c) * anchors + a]
      if (s > bestScore) {
        bestScore = s
        bestCls = c
      }
    }
    // 클래스별 임계값 — display 쪽은 diagram/figure 오탐 감소 목적으로 inline 보다 엄격.
    const threshold = bestCls === 1 ? MFD_CONF_DISPLAY_GROW : MFD_CONF_INLINE
    if (bestScore < threshold) continue

    // letterbox → 원본 좌표
    let x1 = (cx - w / 2 - padX) / scale
    let y1 = (cy - h / 2 - padY) / scale
    let x2 = (cx + w / 2 - padX) / scale
    let y2 = (cy + h / 2 - padY) / scale

    x1 = clamp(x1, 0, frame.width - 1)
    y1 = clamp(y1, 0, frame.height - 1)
    x2 = clamp(x2, 0, frame.width - 1)
    y2 = clamp(y2, 0, frame.height - 1)

    if (x2 - x1 < 2 || y2 - y1 < 2) continue
    // 너무 작은 bbox (픽셀 단위 noise 로 보이는 영역) 제외
    if ((x2 - x1) * (y2 - y1) < MFD_MIN_AREA) continue

    candidates.push({
      x1,
      y1,
      x2,
      y2,
      kind: bestCls === 1 ? "display" : "inline",
      score: bestScore,
    })
  }

  // 클래스별 NMS (혼합 클래스 bbox 간 중복은 허용 — Pix2Text 원본 동작)
  const kept: RawDetection[] = []
  for (const kind of ["inline", "display"] as FormulaKind[]) {
    const subset = candidates.filter((c) => c.kind === kind && (kind === "inline" || c.score >= MFD_CONF_DISPLAY))
    kept.push(...nms(subset, MFD_IOU_THRESHOLD))
  }
  const grown = growDisplays(kept, candidates)

  // 읽기 순서 정렬 (위→아래, 왼→오른쪽)
  grown.sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)

  return grown.map((d) => ({
    bbox: { x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2 },
    kind: d.kind,
    score: d.score,
  }))
}

/**
 * 문턱을 넘은 display 상자를 85% 넘게 품고 1.5~5 배 높은 낮은 점수(MFD_CONF_DISPLAY_GROW 이상) display 후보가 있으면 그 상자로
 * 넓힌다 — 여러 줄 식 전체를 덮는 상자. 넓힌 뒤 display 끼리 NMS 를 다시 한다
 */
function growDisplays(kept: RawDetection[], candidates: RawDetection[]): RawDetection[] {
  const low = nms(candidates.filter(c => c.kind === "display" && c.score < MFD_CONF_DISPLAY), MFD_IOU_THRESHOLD)
  const area = (a: RawDetection) => (a.x2 - a.x1) * (a.y2 - a.y1)
  for (const d of kept) {
    if (d.kind !== "display") continue
    const h = d.y2 - d.y1
    let best: RawDetection | null = null
    for (const c of low) {
      const ch = c.y2 - c.y1
      if (ch < h * 1.5 || ch > h * 5) continue
      const iw = Math.min(d.x2, c.x2) - Math.max(d.x1, c.x1), ih = Math.min(d.y2, c.y2) - Math.max(d.y1, c.y1)
      if (iw <= 0 || ih <= 0 || iw * ih < (d.x2 - d.x1) * h * 0.85) continue
      if (!best || c.score > best.score) best = c
    }
    if (!best) continue
    const b = best
    // 넓힐 영역이 다른 확정 display 상자와 겹치면 두지 않는다 — 이미 식 전체를 덮은 상자를 비슷한 상자로 갈아 끼워 다르게 읽거나
    // (2609.15723 p25 맞던 식 NED 0 → .005), 한 줄 식이 위 식과 겹친 상자가 되어 NMS 에 지워졌다(2609.15095 p8 "P₂ ≝ Id + …")
    const clash = kept.some(o => {
      if (o === d || o.kind !== "display") return false
      const iw = Math.min(o.x2, b.x2) - Math.max(o.x1, b.x1), ih = Math.min(o.y2, b.y2) - Math.max(o.y1, b.y1)
      return iw > 0 && ih > 0 && iw * ih > Math.min(area(o), area(b)) * 0.2
    })
    if (!clash) Object.assign(d, { x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 })
  }
  return [...kept.filter(d => d.kind === "inline"), ...nms(kept.filter(d => d.kind === "display"), MFD_IOU_THRESHOLD)]
}

/**
 * YOLOv8 letterbox 전처리 — RGBA 프레임을 target×target float32 CHW tensor 로.
 *
 * - 긴 변 기준으로 비율 유지 리사이즈
 * - 가운데 패딩 (회색 114)
 * - /255 정규화
 * - CHW 레이아웃
 */
export function letterbox(
  frame: PixelFrame,
  target: number,
): { scale: number; padX: number; padY: number; tensor: Float32Array } {
  const w = frame.width
  const h = frame.height
  const scale = Math.min(target / w, target / h)
  const newW = Math.max(1, Math.round(w * scale))
  const newH = Math.max(1, Math.round(h * scale))
  const padX = (target - newW) / 2
  const padY = (target - newH) / 2
  const offX = Math.floor(padX)
  const offY = Math.floor(padY)

  const ts = target
  const tensor = new Float32Array(3 * ts * ts)
  tensor.fill(PAD_VALUE)

  // RGBA 원본 → 먼저 nearest-neighbor resize 한 뒤 복사.
  // (sharp 로 정확한 bilinear 가능하지만, 여기선 이미 렌더링된 bitmap 이 충분히 해상도 높음 —
  //  결과는 동일한 수준으로 수식 박스 위치 맞춤. Rust 구현도 Triangle 사용.)
  const src = frame.data
  const srcW = frame.width
  const srcH = frame.height

  for (let y = 0; y < newH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y + 0.5) / newH * srcH))
    for (let x = 0; x < newW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x + 0.5) / newW * srcW))
      const srcIdx = (sy * srcW + sx) * 4
      const r = src[srcIdx]
      const g = src[srcIdx + 1]
      const b = src[srcIdx + 2]

      const tx = x + offX
      const ty = y + offY
      const idx = ty * ts + tx
      tensor[idx] = r / 255
      tensor[ts * ts + idx] = g / 255
      tensor[2 * ts * ts + idx] = b / 255
    }
  }

  return { scale, padX, padY, tensor }
}

function nms(cands: RawDetection[], iouThreshold: number): RawDetection[] {
  const sorted = [...cands].sort((a, b) => b.score - a.score)
  const kept: RawDetection[] = []
  for (const cand of sorted) {
    let keep = true
    for (const k of kept) {
      if (iou(cand, k) > iouThreshold) {
        keep = false
        break
      }
    }
    if (keep) kept.push(cand)
  }
  return kept
}

function iou(
  a: { x1: number; y1: number; x2: number; y2: number },
  b: { x1: number; y1: number; x2: number; y2: number },
): number {
  const x1 = Math.max(a.x1, b.x1)
  const y1 = Math.max(a.y1, b.y1)
  const x2 = Math.min(a.x2, b.x2)
  const y2 = Math.min(a.y2, b.y2)
  const interW = Math.max(0, x2 - x1)
  const interH = Math.max(0, y2 - y1)
  const inter = interW * interH
  const areaA = Math.max(0, a.x2 - a.x1) * Math.max(0, a.y2 - a.y1)
  const areaB = Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  const union = areaA + areaB - inter
  return union <= 0 ? 0 : inter / union
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

// 테스트 용도로만 export
export const __internal = { nms, iou, letterbox }
