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
 * 적용 조건: |θ| ≥ MIN_APPLY_DEG 이고 0° 대비 뾰족함이 뚜렷할 때만 (클린 렌더는 무보정). 글줄이 MIN_LINES 보다 적으면 더 뚜렷해야 한다.
 *
 * 원근 펴기: 휴대폰으로 비스듬히 찍은 쪽은 글줄 기울기가 위아래로 다르다(사다리꼴). 쪽 전체의 투영은 위아래 각이 서로 상쇄돼
 * 봉우리가 무뎌지고 0° 근처로 나와 보정하지 않았다(실측 사진 4장: 위 띠 +2.6°·아래 띠 −0.7° 인 쪽이 전체 −0.76°·뾰족함 1.010).
 * 쪽을 겹치는 가로 띠로 나눠 띠마다 같은 방식으로 재고, 뚜렷한 띠 사이 각 차이가 DEWARP_SPREAD_DEG 이상이고 편 쪽이 한 각 회전보다
 * 투영이 뚜렷이 뾰족하면 회전 대신
 * 행마다 (x − cx)·tanθ(y) 만큼 세로로 밀어 글줄을 편다. θ(y) 는 뚜렷한 띠 각을 잇는 구간 직선, 바깥은 끝 띠 각 그대로.
 */

/** 추정 범위 (°) — 이보다 큰 회전은 기울기가 아니라 방향 문제 (범위 밖) */
const MAX_SKEW_DEG = 5
/** 이보다 작은 기울기는 보정하지 않음 — 리샘플 흐림이 이득보다 크다 */
const MIN_APPLY_DEG = 0.25
/** 0° 대비 투영 뾰족함 비율 하한 — 글자 적은 페이지·도형의 우연한 봉우리 거부 */
const MIN_GAIN = 1.03
/** 글줄이 이보다 적은 그림은 뾰족함 하한을 MIN_GAIN_FEW 로 올린다. 두 줄 그림은 글꼴 획 모양이 봉우리를 끌어 기울지 않은 렌더도
 *  0.6~0.9° 로 읽혔다(#233: "대한민국 정부 2026" / "문서 검증 테스트" 840×260, 고딕 글꼴 −0.62~−0.92°·뾰족함 1.031~1.034).
 *  같은 그림을 0.5° 이상 실제로 기울이면 1.05~1.17, 손글씨 한 줄 띠(3,700×190)의 기울기는 1.07 안팎이다 */
const MIN_LINES = 3
const MIN_GAIN_FEW = 1.05
/** 글줄 띠 — 투영 칸이 최댓값의 이 비율을 넘는 연속 구간. 글줄 안 빈 행(한글 초성·종성 사이)보다 낮고 표 세로 괘선만 지나는 행보다 높다 */
const LINE_BIN_FRAC = 0.05
const TARGET_LONG = 1000

/** 원근 펴기 — 띠 수(절반씩 겹침)·뚜렷한 띠의 뾰족함 하한·글줄 수 하한·적용하는 띠 사이 각 차이 */
const DEWARP_BANDS = 6
const DEWARP_MIN_GAIN = 1.05
const DEWARP_MIN_LINES = 3
const DEWARP_SPREAD_DEG = 0.8
/** 원근은 위에서 아래로 기울기가 한쪽으로만 변한다 — 뚜렷한 띠 각이 이보다 크게 되돌아가면(도장·큰 제목 띠 하나가 튄 쪽) 펴지 않는다 */
const DEWARP_MONO_TOL_DEG = 0.3
/** 편 뒤 투영 뾰족함이 쪽 전체 한 각 회전의 최고 점수보다 이 배수 넘게 높아야 편다 */
const DEWARP_WIN = 1.02
/** 원근 펴기 기준점이 직선에서 이만큼(°) 안이면 사다리꼴로 보고 직선을 쪽 끝까지 쓴다 */
const DEWARP_LINEAR_TOL_DEG = 0.8
/** 한 직선 펴기를 고르는 투영 뾰족함 비. 구간 직선 펴기보다 이 배수 넘게 뾰족해야 한다 */
const DEWARP_LINEAR_WIN = 1.12

/** 원근 펴기 — 행 y(래스터 px)의 글줄 기울기 θ(y)(°, deskewAngle 과 같은 뜻)를 잇는 기준점. 펴진 래스터 (x, y) 는 입력 (x, y + (x − cx)·tanθ(y)) */
export interface SkewField {
  cx: number
  knots: Array<[number, number]>
}

/** 기준점을 잇는 θ(y) — 바깥은 끝 기준점 각 */
export function fieldAngle(f: SkewField, y: number): number {
  const k = f.knots
  if (y <= k[0][0]) return k[0][1]
  for (let i = 1; i < k.length; i++) if (y <= k[i][0]) { const t = (y - k[i - 1][0]) / (k[i][0] - k[i - 1][0]); return k[i - 1][1] * (1 - t) + k[i][1] * t }
  return k[k.length - 1][1]
}

/** 띠별 기울기 — 뚜렷한 띠가 둘 이상이고 그 각 차이가 DEWARP_SPREAD_DEG 이상이며 위→아래로 한쪽으로만 변할 때만 기준점을 낸다 */
export function estimateSkewField(rgba: Uint8Array, width: number, height: number): SkewField | null {
  const bh = Math.floor(height / (DEWARP_BANDS / 2 + 0.5))
  if (bh < 50) return null
  const knots: Array<[number, number]> = []
  // 띠도 쪽 전체와 같은 축소 간격으로 — 띠마다 긴 변을 맞추면 띠가 덜 줄어 쪽 전체 추정의 4배 가까이 셌다
  const step = pageStep(width, height)
  for (let k = 0; k < DEWARP_BANDS; k++) {
    const y0 = Math.floor((k * (height - bh)) / (DEWARP_BANDS - 1))
    const e = estimateSkew(rgba.subarray(y0 * width * 4, (y0 + bh) * width * 4), width, bh, step)
    if (e.gain >= DEWARP_MIN_GAIN && e.lines >= DEWARP_MIN_LINES) knots.push([y0 + bh / 2, e.angle])
  }
  if (knots.length < 2) return null
  const as = knots.map(k => k[1])
  if (Math.max(...as) - Math.min(...as) < DEWARP_SPREAD_DEG) return null
  const up = as.some((a, i) => i > 0 && a - as[i - 1] > DEWARP_MONO_TOL_DEG), down = as.some((a, i) => i > 0 && as[i - 1] - a > DEWARP_MONO_TOL_DEG)
  if (up && down) return null
  return { cx: (width - 1) / 2, knots }
}

/**
 * 기준점에 맞춘 한 직선 θ(y) 를 쪽 위아래 끝까지 쓴 펴기(기준점이 직선에서 DEWARP_LINEAR_TOL_DEG 안일 때). 사다리꼴 원근은 높이에 따라
 * 기울기가 고르게 변하는데 띠 기준점은 띠 가운데라, 바깥을 끝 띠 각으로 두면 쪽 위아래 끝 줄이 덜 펴졌다(오른쪽 변 8% 줄인 예산서 표:
 * 실제 위끝 3.2° 를 2.1° 로, 괘선이 기울어 머리 행이 표 밖으로 빠짐). 구간 직선과 견줘 편 투영이 더 뾰족한 쪽을 고른다(deskewPage)
 */
export function linearSkewField(f: SkewField, height: number): SkewField | null {
  const k = f.knots
  if (k.length < 3) return null
  const n = k.length, my = k.reduce((s, p) => s + p[0], 0) / n, ma = k.reduce((s, p) => s + p[1], 0) / n
  const b = k.reduce((s, p) => s + (p[0] - my) * (p[1] - ma), 0) / k.reduce((s, p) => s + (p[0] - my) ** 2, 0)
  const at = (y: number) => ma + b * (y - my)
  if (k.some(p => Math.abs(p[1] - at(p[0])) > DEWARP_LINEAR_TOL_DEG)) return null
  // 기준점 각이 0 을 사이에 두고 위아래로 갈릴 때만(쪽 가운데가 바로 선 사다리꼴). 한쪽 각만 있는 쪽(원근에 회전이 겹침)은 직선이
  // 끝 줄을 넘치게 펴 표가 흐트러졌다(괴산 예산서·코바코 보도자료 원근+2° 판)
  if (Math.min(...k.map(p => p[1])) >= 0 || Math.max(...k.map(p => p[1])) <= 0) return null
  return { cx: f.cx, knots: [[0, at(0)], [height - 1, at(height - 1)]] }
}

/** 행마다 세로 밀기 — 펴진 (x, y) 는 입력 (x, y + (x − cx)·tanθ(y)) 에서 bilinear(세로), 바깥은 흰색 */
export function dewarpRows(rgba: Uint8Array, width: number, height: number, f: SkewField): Uint8Array {
  const out = new Uint8Array(rgba.length)
  for (let y = 0; y < height; y++) {
    const t = Math.tan((fieldAngle(f, y) * Math.PI) / 180)
    for (let x = 0; x < width; x++) {
      const sy = y + (x - f.cx) * t, y0 = Math.floor(sy), wy = sy - y0, o = (y * width + x) * 4
      if (y0 < 0 || y0 >= height - 1) { out[o] = 255; out[o + 1] = 255; out[o + 2] = 255; out[o + 3] = 255; continue }
      const i0 = (y0 * width + x) * 4, i1 = i0 + width * 4
      for (let c = 0; c < 4; c++) out[o + c] = Math.round(rgba[i0 + c] * (1 - wy) + rgba[i1 + c] * wy)
    }
  }
  return out
}

export interface SkewEstimate {
  /** 페이지 기울기 (°, 양수 = 시계 방향으로 기움 → 같은 각만큼 반시계로 돌리면 바로 섬) */
  angle: number
  /** 최적각 투영 점수 / 0° 점수 */
  gain: number
  /** 최적각 투영의 글줄 띠 수 */
  lines: number
  /** 최적각 투영 점수(행 히스토그램 제곱합) — 펴기와 견줄 때 */
  score: number
}

/** 축소 잉크 점 — 긴 변 ~TARGET_LONG 축소(또는 주어진 간격) 휘도의 전역 문턱(어두운 픽셀) */
function inkPoints(rgba: Uint8Array, width: number, height: number, step: number): { xs: number[]; ys: number[]; sw: number; sh: number } {
  const sw = Math.floor(width / step), sh = Math.floor(height / step)
  const xs: number[] = [], ys: number[] = []
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = ((y * step) * width + x * step) * 4
      const l = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
      if (l < 128) { xs.push(x); ys.push(y) }
    }
  }
  return { xs, ys, sw, sh }
}

const pageStep = (width: number, height: number) => Math.max(1, Math.ceil(Math.max(width, height) / TARGET_LONG))

/** 기울기 추정 (적용 여부와 무관한 원값). step 은 축소 간격 — 주지 않으면 긴 변이 ~TARGET_LONG 이 되게 */
export function estimateSkew(rgba: Uint8Array, width: number, height: number, step = pageStep(width, height)): SkewEstimate {
  const { xs, ys, sw, sh } = inkPoints(rgba, width, height, step)
  if (xs.length < 200) return { angle: 0, gain: 1, lines: 0, score: 0 }
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
  score(best)
  let max = 0
  for (let i = 0; i < hist.length; i++) if (hist[i] > max) max = hist[i]
  let lines = 0, on = false
  for (let i = 0; i < hist.length; i++) {
    const ink = hist[i] > max * LINE_BIN_FRAC
    if (ink && !on) lines++
    on = ink
  }
  // 투영 회전각 θ 에서 줄이 수평 → 페이지는 −θ 만큼 기운 것
  return { angle: +(-best).toFixed(2), gain: s0 > 0 ? bestS / s0 : 1, lines, score: bestS }
}

/** 편 뒤의 투영 뾰족함 — estimateSkew 와 같은 축소 잉크 점을 편 행(y − (x − cx)·tanθ(y))에 모은 행 히스토그램 제곱합 */
function dewarpScore(rgba: Uint8Array, width: number, height: number, f: SkewField, step: number): number {
  const { xs, ys, sh } = inkPoints(rgba, width, height, step)
  const pad = Math.ceil(sh / 2), hist = new Float64Array(sh + 2 * pad + 2)
  for (let k = 0; k < xs.length; k++) {
    const x = xs[k] * step, y = ys[k] * step
    const r = Math.round((y - (x - f.cx) * Math.tan((fieldAngle(f, y) * Math.PI) / 180)) / step) + pad
    if (r >= 0 && r < hist.length) hist[r]++
  }
  let sum = 0
  for (let i = 0; i < hist.length; i++) sum += hist[i] * hist[i]
  return sum
}

/**
 * 필요하면 페이지를 바로 세운 RGBA 를 돌려준다 (같은 크기, 중심 회전, 바깥은 흰색). 글줄 기울기가 위아래로 다르면(원근) 회전 대신
 * 행마다 펴고 dewarp 에 기준점을 싣는다(angle 0). 보정하지 않으면 입력 그대로 + angle 0.
 */
/** 원근 쪽을 먼저 돌린 뒤 펴는 쪽 각 하한(°) */
const ROTATE_DEWARP_MIN_DEG = 1.2

/** 편 쪽 세로 괘선이 섰다고 보는 펴기 평균각 상한(°). 돌린 뒤 편 쪽은 남은 원근이 0 을 사이에 두고 갈려 평균이 작다 */
const STRAIGHT_MEAN_DEG = 1

/** 펴기 기울기 θ(y) 의 쪽 높이 평균(°) */
export function meanFieldAngle(f: SkewField, height: number): number {
  let sum = 0, n = 0
  for (let y = 0; y < height; y += 8) { sum += fieldAngle(f, y); n++ }
  return n ? sum / n : 0
}

/** 원근을 펴서 세로 괘선까지 선 쪽인가. 행만 밀어 편 쪽은 평균각만큼 세로 괘선이 기운 채 남는다 */
export function verticalsStraightened(f: SkewField | undefined, height: number): boolean {
  return !!f && Math.abs(meanFieldAngle(f, height)) < STRAIGHT_MEAN_DEG
}

export function deskewPage(rgba: Uint8Array, width: number, height: number): { rgba: Uint8Array; angle: number; dewarp?: SkewField } {
  const est = estimateSkew(rgba, width, height)
  const step = pageStep(width, height)
  // 펴기가 쪽 전체 한 각 회전보다 글줄을 뚜렷이 더 곧게 만들 때만 — 고르게 기운 쪽에 그림·도장 띠 하나가 엉뚱한 각을 내거나
  // 클린 렌더의 띠 각이 글꼴 획 탓에 흔들리면 기준점은 나와도 한 각 회전(또는 그대로)이 더 뾰족하다
  const direct = pickField(rgba, width, height, step)
  const rotates = Math.abs(est.angle) >= MIN_APPLY_DEG && est.gain >= (est.lines < MIN_LINES ? MIN_GAIN_FEW : MIN_GAIN)
  // 원근에 회전이 겹친 쪽(휴대폰 사진)은 행마다 세로로 미는 펴기만으로는 세로 괘선 기울기가 남는다. 먼저 쪽 각만큼 돌리고 남은 원근을 편다
  // (좌표는 펴기를 먼저, 회전을 나중에 되돌린다)
  // 쪽 각이 작으면(ROTATE_DEWARP_MIN_DEG 미만) 행 밀기만으로 회전이 거의 보정되고, 먼저 돌리면 오히려 남은 원근 기준점이 흔들렸다(시험 계획 원근 판 CER .046 → .092)
  const rotated = rotates ? rotateRgba(rgba, width, height, est.angle) : null
  const after = rotated && Math.abs(est.angle) >= ROTATE_DEWARP_MIN_DEG ? pickField(rotated, width, height, step) : null
  const useDirect = direct && direct.score > est.score * DEWARP_WIN && (!after || direct.score >= after.score)
  if (useDirect) return { rgba: dewarpRows(rgba, width, height, direct.f), angle: 0, dewarp: direct.f }
  if (rotated && after && after.score > est.score * DEWARP_WIN) return { rgba: dewarpRows(rotated, width, height, after.f), angle: est.angle, dewarp: after.f }
  if (!rotated) return { rgba, angle: 0 }
  return { rgba: rotated, angle: est.angle }
}

/** 원근 펴기 고르기: 구간 직선과 한 직선 가운데 편 투영이 더 뾰족한 쪽(한 직선은 DEWARP_LINEAR_WIN 배 넘게 뾰족할 때만) */
function pickField(rgba: Uint8Array, width: number, height: number, step: number): { f: SkewField; score: number } | null {
  const piecewise = estimateSkewField(rgba, width, height)
  if (!piecewise) return null
  // 한 직선은 구간 직선보다 투영이 DEWARP_LINEAR_WIN 배 넘게 뾰족할 때만. 차이가 작으면 직선이 끝 줄을 넘치게 펴 표가 흐트러졌다
  // (토픽 계획 원근 판: 1.09 배인데 CER .046 → .116)
  const linear = linearSkewField(piecewise, height)
  const pwScore = dewarpScore(rgba, width, height, piecewise, step)
  const linScore = linear ? dewarpScore(rgba, width, height, linear, step) : 0
  return linear && linScore > pwScore * DEWARP_LINEAR_WIN ? { f: linear, score: linScore } : { f: piecewise, score: pwScore }
}

/**
 * 쪽을 4분의 1 바퀴 돌린 래스터 — 가로·세로가 바뀐다. 각은 인식 crop(lineCrop)과 같은 뜻(90 = 반시계, 270 = 시계)
 */
export function rotateQuarter(rgba: Uint8Array, width: number, height: number, rot: 90 | 270): { rgba: Uint8Array; width: number; height: number } {
  const out = new Uint8Array(rgba.length)
  // 새 래스터는 폭 height·높이 width. (u, v) 는 옛 래스터 (width-1-v, u)(90) 또는 (v, height-1-u)(270)
  for (let v = 0; v < width; v++) {
    for (let u = 0; u < height; u++) {
      const px = rot === 90 ? width - 1 - v : v, py = rot === 90 ? u : height - 1 - u
      const o = (v * height + u) * 4, i = (py * width + px) * 4
      out[o] = rgba[i]; out[o + 1] = rgba[i + 1]; out[o + 2] = rgba[i + 2]; out[o + 3] = rgba[i + 3]
    }
  }
  return { rgba: out, width: height, height: width }
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
