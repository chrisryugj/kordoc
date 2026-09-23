/**
 * 스캔 기울기 보정 — 투영 프로파일 방식.
 *
 * 스캔·사진 입력은 0.5~3° 기울기가 흔하다. det 은 축정렬 박스(connected-component bbox)
 * 라 기울어진 줄은 박스가 위아래 줄을 물고, 괘선 감지(ruling-lines.ts)는 축정렬 런렝스라
 * 기울면 표 괘선이 통째로 사라진다. 인식 전에 페이지를 바로 세운다.
 *
 * 추정: 페이지를 긴 변 ~1000px 로 줄여 잉크 픽셀을 모으고, 후보 각 θ 마다
 * y' = y·cosθ + x·sinθ 의 행 히스토그램 제곱합(줄이 수평일 때 가장 뾰족)을 비교 —
 * ±MAX 를 0.2° 간격으로 훑고 최댓값 주변을 0.02° 간격으로 다듬는다.
 * 적용 조건: |θ| ≥ MIN_APPLY_DEG 이고 0° 대비 뾰족함이 뚜렷할 때만 (클린 렌더는 무보정).
 */

/** 추정 범위 (°) — 이보다 큰 회전은 기울기가 아니라 방향 문제 (범위 밖) */
const MAX_SKEW_DEG = 5
/** 이보다 작은 기울기는 보정하지 않음 — 리샘플 흐림이 이득보다 크다 */
const MIN_APPLY_DEG = 0.25
/** 0° 대비 투영 뾰족함 비율 하한 — 글자 적은 페이지·도형의 우연한 봉우리 거부 */
const MIN_GAIN = 1.03
const TARGET_LONG = 1000

export interface SkewEstimate {
  /** 페이지 기울기 (°, 양수 = 시계 방향으로 기움 → 같은 각만큼 반시계로 돌리면 바로 섬) */
  angle: number
  /** 최적각 투영 점수 / 0° 점수 */
  gain: number
}

/** 기울기 추정 (적용 여부와 무관한 원값) */
export function estimateSkew(rgba: Uint8Array, width: number, height: number): SkewEstimate {
  const step = Math.max(1, Math.ceil(Math.max(width, height) / TARGET_LONG))
  const sw = Math.floor(width / step), sh = Math.floor(height / step)
  // 축소 휘도 + 전역 문턱 (잉크 = 어두운 픽셀)
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = ((y * step) * width + x * step) * 4
      const l = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
      if (l < 128) { xs.push(x); ys.push(y) }
    }
  }
  if (xs.length < 200) return { angle: 0, gain: 1 }
  const diag = Math.ceil(Math.hypot(sw, sh))
  const hist = new Float64Array(2 * diag + 2)
  const score = (deg: number): number => {
    const t = (deg * Math.PI) / 180
    const c = Math.cos(t), s = Math.sin(t)
    hist.fill(0)
    for (let k = 0; k < xs.length; k++) hist[Math.round(ys[k] * c + xs[k] * s) + diag]++
    let sum = 0
    for (let i = 0; i < hist.length; i++) sum += hist[i] * hist[i]
    return sum
  }
  const s0 = score(0)
  let best = 0, bestS = s0
  for (let d = -MAX_SKEW_DEG; d <= MAX_SKEW_DEG + 1e-9; d += 0.2) {
    const v = score(d)
    if (v > bestS) { bestS = v; best = d }
  }
  const coarse = best
  for (let d = coarse - 0.2; d <= coarse + 0.2 + 1e-9; d += 0.02) {
    const v = score(d)
    if (v > bestS) { bestS = v; best = d }
  }
  // 투영 회전각 θ 에서 줄이 수평 → 페이지는 −θ 만큼 기운 것
  return { angle: +(-best).toFixed(2), gain: s0 > 0 ? bestS / s0 : 1 }
}

/**
 * 필요하면 페이지를 바로 세운 RGBA 를 돌려준다 (같은 크기, 중심 회전, 바깥은 흰색).
 * 보정하지 않으면 입력 그대로 + angle 0.
 */
export function deskewPage(rgba: Uint8Array, width: number, height: number): { rgba: Uint8Array; angle: number } {
  const est = estimateSkew(rgba, width, height)
  if (Math.abs(est.angle) < MIN_APPLY_DEG || est.gain < MIN_GAIN) return { rgba, angle: 0 }
  return { rgba: rotateRgba(rgba, width, height, est.angle), angle: est.angle }
}

/**
 * 중심 기준 회전 (deg, 양수 = 화면상 반시계), 같은 캔버스 크기, bilinear, 바깥 흰색.
 * 출력 픽셀 (x,y) 는 입력의 역회전 위치에서 표본.
 */
export function rotateRgba(rgba: Uint8Array, width: number, height: number, deg: number): Uint8Array {
  const out = new Uint8Array(rgba.length)
  const t = (deg * Math.PI) / 180
  const c = Math.cos(t), s = Math.sin(t)
  const cx = (width - 1) / 2, cy = (height - 1) / 2
  for (let y = 0; y < height; y++) {
    const dy = y - cy
    for (let x = 0; x < width; x++) {
      const dx = x - cx
      // 화면 좌표(y 아래)에서 반시계 deg 회전의 역변환
      const sx = c * dx - s * dy + cx
      const sy = s * dx + c * dy + cy
      const o = (y * width + x) * 4
      const x0 = Math.floor(sx), y0 = Math.floor(sy)
      if (x0 < 0 || y0 < 0 || x0 >= width - 1 || y0 >= height - 1) {
        out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255
        continue
      }
      const wx = sx - x0, wy = sy - y0
      const i00 = (y0 * width + x0) * 4, i01 = i00 + 4, i10 = i00 + width * 4, i11 = i10 + 4
      for (let ch = 0; ch < 4; ch++) {
        const top = rgba[i00 + ch] * (1 - wx) + rgba[i01 + ch] * wx
        const bot = rgba[i10 + ch] * (1 - wx) + rgba[i11 + ch] * wx
        out[o + ch] = Math.round(top * (1 - wy) + bot * wy)
      }
    }
  }
  return out
}
