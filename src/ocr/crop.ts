/**
 * 인식 입력 준비 — 밴드 서브 박스 좌표, 라인 crop 리사이즈(회전 포함).
 * (engine.ts 에서 분리 — 엔진은 세션·배치·후처리 흐름만)
 */

export interface Box { x: number; y: number; w: number; h: number }

/** rec 입력 높이 (공식 RecResizeImg image_shape [3, 48, 320]) */
export const REC_HEIGHT = 48
const REC_MAX_WIDTH = 3200
const MIN_SIZE = 3

/**
 * 밴드 → 페이지 좌표 서브 박스. 위아래는 밴드 높이 20% 여유(이웃 밴드와의 간격 절반 이내),
 * 좌우는 괘선을 뺀 잉크 폭 + 밴드 높이 20% 여유(원 박스 안) — 칸 경계 세로선이 crop 에
 * 들어가 "|국" 으로 읽히지 않게
 */
export function bandBoxes(b: Box, bands: Array<{ y0: number; y1: number; x0: number; x1: number }>, pageH: number): Box[] {
  const out: Box[] = []
  for (let i = 0; i < bands.length; i++) {
    const { y0, y1, x0, x1 } = bands[i]
    const bh = y1 - y0
    const upGap = i > 0 ? (y0 - bands[i - 1].y1) / 2 : y0
    const downGap = i < bands.length - 1 ? (bands[i + 1].y0 - y1) / 2 : b.h - y1
    const top = Math.max(0, Math.round(b.y + y0 - Math.min(bh * 0.2, upGap)))
    const bot = Math.min(pageH, Math.round(b.y + y1 + Math.min(bh * 0.2, downGap)))
    const left = Math.max(b.x, Math.round(b.x + x0 - bh * 0.2))
    const right = Math.min(b.x + b.w, Math.round(b.x + x1 + bh * 0.2))
    if (bot - top >= MIN_SIZE && right - left >= MIN_SIZE) out.push({ x: left, y: top, w: right - left, h: bot - top })
  }
  return out
}

/**
 * 라인 crop → rec 입력 크기(높이 48, 비율 유지 폭) RGB. 회전은 crop 좌표계에서
 * (90 = 반시계 np.rot90, 270 = 시계). 리사이즈는 bilinear(반픽셀 중심, cv2 INTER_LINEAR 등가)
 * — 공식 전처리(cv2.resize 기본)와 같은 보간.
 */
export function lineCrop(rgba: Uint8Array, pageW: number, box: Box, rot: 0 | 90 | 270): { rgb: Uint8Array; w: number } {
  const srcW = rot === 0 ? box.w : box.h
  const srcH = rot === 0 ? box.h : box.w
  const rw = Math.min(REC_MAX_WIDTH, Math.max(16, Math.round((srcW * REC_HEIGHT) / srcH)))
  const rgb = new Uint8Array(rw * REC_HEIGHT * 3)
  // 회전 좌표 → 페이지 픽셀
  const at = (u: number, v: number): number => {
    let px: number, py: number
    if (rot === 0) { px = u; py = v }
    else if (rot === 90) { px = box.w - 1 - v; py = u }
    else { px = v; py = box.h - 1 - u }
    return ((box.y + py) * pageW + (box.x + px)) * 4
  }
  const fx = srcW / rw
  const fy = srcH / REC_HEIGHT
  for (let dy = 0; dy < REC_HEIGHT; dy++) {
    let sy = (dy + 0.5) * fy - 0.5
    if (sy < 0) sy = 0
    const y0 = Math.min(srcH - 1, Math.floor(sy))
    const y1 = Math.min(srcH - 1, y0 + 1)
    const wy = sy - y0
    for (let dx = 0; dx < rw; dx++) {
      let sx = (dx + 0.5) * fx - 0.5
      if (sx < 0) sx = 0
      const x0 = Math.min(srcW - 1, Math.floor(sx))
      const x1 = Math.min(srcW - 1, x0 + 1)
      const wx = sx - x0
      const i00 = at(x0, y0), i01 = at(x1, y0), i10 = at(x0, y1), i11 = at(x1, y1)
      const o = (dy * rw + dx) * 3
      for (let c = 0; c < 3; c++) {
        const top = rgba[i00 + c] * (1 - wx) + rgba[i01 + c] * wx
        const bottom = rgba[i10 + c] * (1 - wx) + rgba[i11 + c] * wx
        rgb[o + c] = Math.round(top * (1 - wy) + bottom * wy)
      }
    }
  }
  return { rgb, w: rw }
}

