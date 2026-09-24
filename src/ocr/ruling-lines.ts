/**
 * 래스터 괘선 감지 — 스캔/이미지 페이지의 픽셀에서 표 괘선(수평/수직 선)을
 * 찾아 선 기반 표 파이프라인(line-detector → table-grid)에 공급한다.
 *
 * PDF 그래픽 ops 가 없는 OCR 경로는 종전에 클러스터 감지기만 탔는데,
 * 병합 라벨 셀 + 다중줄 서술형 서식(정부 제출 서식류)은 라인 클러스터로
 * 행 경계를 잡을 수 없다. 괘선은 이미지에 실존하므로 이진화 + 런렝스로
 * 직접 감지한다 — ML 없음, 축 정렬 전제(스캔 스큐 보정은 스코프 밖).
 *
 * 오탐 방어 3겹 (실측: 우수사례 제출 서식 스캔 — 진짜 괘선은 길고 얇음):
 * - 최소 길이 20pt: 글리프 획(가로 ≤한 글자폭·세로 ≤글자높이)은 걸러짐
 * - 두께 상한 2.5pt: 굵은 제목 획(6~13px)·텍스트 줄 밴드·채운 색상바 탈락
 * - 양측 잉크 포위 제외: 색상바(붙임 박스 등) 안 흰 글자 틈새 슬리버 탈락
 *
 * 텍스트층 경로가 선으로 받는 것 중 잉크 런렝스로 안 보이는 두 가지도 선으로 낸다 — 점선 괘선(DOT_*),
 * 채움 사각형의 변(FILL_*). 둘 다 표 괘선에 맞물린 것만.
 */

import type { LineSegment } from "../pdf/line-types.js"

/**
 * 잉크 판정 휘도 상한 — 셀 배경 음영(회색 ~220)은 통과, 실선(진회~검정·남색)만 잉크. 0.12mm 가는 괘선이 픽셀 경계에
 * 걸려 두 픽셀로 번지면 픽셀마다 192~207 이라 190 에선 놓쳤다(ice-geomjeong 시험일정표 "구분│일자" 세로선, ktdb 목록표)
 */
const INK_LUMA_MAX = 205
/** 최소 선 길이 (pt) — 최소 셀 변(≈7mm)과 대형 글리프 획(≤1em) 사이 */
const MIN_LINE_LENGTH_PT = 20
/** 선 두께 상한 (pt) — 진짜 괘선(0.12~0.7mm ≈ 0.3~2pt)과 굵은 글리프 획(2pt+) 분리 */
const MAX_LINE_WIDTH_PT = 2.5
/** 런 내 허용 끊김 (px) — 스캔 노이즈/JPEG 아티팩트 */
const GAP_TOL_PX = 2
/** 밴드 병합 시 요구하는 x(또는 y) 범위 겹침 비율 (짧은 쪽 기준) */
const BAND_OVERLAP_RATIO = 0.5
/** 밴드 양측(±2px)이 이 비율 이상 잉크면 채운 영역 내부 슬리버로 판정 */
const SURROUND_INK_RATIO = 0.35
/**
 * 점선·파선 괘선. 텍스트층 경로(line-extract.ts)는 대시 패턴을 보지 않고 경로 기하만 읽어 점선 괘선도
 * 실선으로 받는데, 래스터에선 점 사이 간격(216dpi 에서 2~4px)이 GAP_TOL_PX 를 넘어 선이 조각난다 —
 * 점선으로 행을 가른 표가 OCR 경로에서만 한 행으로 뭉쳤다(changwon-plan2026 p5 정원표 22행 → 2행,
 * ice-geomjeong-plan p3 세로 점선 표 → 열 없는 한 칸). 점 사이 간격 상한 1.3pt 안에서 짧은 점(대시 4pt 이하)이
 * 8개+ 이어지면 점선 후보. 목차 리더 점("······")도 같은 모양이라 주기로 가른다 — 코퍼스 실측 괘선 점선 주기
 * 0.8~2.0pt(점 ≈ 간격), 리더 2.5~3.3pt(간격 ≈ 점 × 2). 대시가 간격보다 확연히 긴(1.5배+) 파선은 주기 무관.
 * 마지막으로 수직 방향 괘선(실선·점선)과 닿는 것만 남긴다 — 리더는 글자 사이에 떠 있고 괘선은 표·상자 테두리에 물린다.
 */
const DOT_MAX_GAP_PT = 1.3
const DOT_MAX_DASH_PT = 4
const DOT_MAX_PERIOD_PT = 2.2
const DOT_MIN_COUNT = 8
/** 점선 후보가 수직 괘선에 닿았다고 보는 거리 (pt) */
const DOT_TOUCH_PT = 1.5
/**
 * 채움 경계. 텍스트층 경로는 순수 채움 경로(머리 행 음영·색 칸의 사각형)의 변도 선으로 받는다(line-extract.ts
 * flushPath → classifyAndAdd). 잉크 감지(휘도 ≤ 190)는 연한 채움과 흰 바탕의 경계를 못 봐, 머리 행에만 좌우 변이
 * 있는 개방 변 표 두 개를 가상 테두리가 한 격자로 용접했고(ice-election-cases p5 8×3·10×3 → 19×5, seoul-archives p3,
 * ice-geomjeong p3), 흰 틈으로 칸을 가른 색 머리 행이 한 칸으로 뭉쳤다(cbe-record-guide). 쪽 바탕(휘도 최빈값)보다
 * FILL_DELTA 이상 어두운 곳이 안쪽으로 FILL_MIN_DEPTH_PT 이상 이어지는 바깥 경계 픽셀 런을 선으로 낸다 — 괘선(≤ 2.5pt)과
 * 글자 획은 그보다 얇다. 바탕을 흰색으로 못박으면 크림색 바탕 쪽 전체가 채움이 되어 본문이 통째로 표가 됐다
 * (pen-cyberbridge p2 바탕 휘도 242). 경계 안쪽 휘도가 고르지 않은 것(사진·그림·배경 도안)은 채움이 아니다.
 */
const FILL_DELTA = 10
/** 채움 경계 최소 길이 (pt) — 색 머리 행 높이(15~18pt)의 칸 틈도 잡게 괘선(20pt)보다 짧게. 글자 획은 두께 조건이 막는다 */
const FILL_MIN_LENGTH_PT = 10
const FILL_MIN_DEPTH_PT = 4
const FILL_FLAT_TOL = 12
const FILL_FLAT_RATIO = 0.8

/** 픽셀 공간(top-left origin) 선분 — 두께는 밴드 픽셀 수 */
export interface PxSegment {
  x1: number; y1: number
  x2: number; y2: number
  thicknessPx: number
}

export interface RulingLines {
  horizontals: PxSegment[]
  verticals: PxSegment[]
}

/**
 * RGBA 래스터에서 수평/수직 괘선 감지.
 * @param scale 렌더 스케일 (px/pt) — 길이·두께 임계를 pt 기준으로 환산
 */
export function detectRulingLines(
  rgba: Uint8Array,
  width: number,
  height: number,
  scale: number,
): RulingLines {
  const minLenPx = Math.round(MIN_LINE_LENGTH_PT * scale)
  const maxThickPx = Math.max(1, Math.floor(MAX_LINE_WIDTH_PT * scale))

  // 잉크 마스크 1회 구축 — 수평/수직 두 패스가 공유
  const ink = new Uint8Array(width * height)
  // 휘도는 채움 경계(fillEdges)도 쓴다 — 한 번만 계산
  const luma = new Uint8Array(width * height)
  for (let p = 0, i = 0; p < ink.length; p++, i += 4) {
    // ITU-R BT.601 휘도 근사 (정수 시프트)
    const l = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8
    luma[p] = l
    if (l <= INK_LUMA_MAX && rgba[i + 3] >= 128) ink[p] = 1
  }

  const solid: RunReader = (m, base, step, span) => solidRuns(m, base, step, span, minLenPx)
  const dot = {
    maxGap: Math.max(2, Math.round(DOT_MAX_GAP_PT * scale)),
    maxDash: Math.max(2, Math.round(DOT_MAX_DASH_PT * scale)),
    maxPeriod: DOT_MAX_PERIOD_PT * scale,
  }
  const dotted: RunReader = (m, base, step, span) => dottedRuns(m, base, step, span, minLenPx, dot.maxGap, dot.maxDash, dot.maxPeriod)
  const horizontals = detectBands(ink, width, height, maxThickPx, false, solid)
  const verticals = detectBands(ink, width, height, maxThickPx, true, solid)
  const dotH = detectBands(ink, width, height, maxThickPx, false, dotted)
  const dotV = detectBands(ink, width, height, maxThickPx, true, dotted)
  const tol = Math.max(2, Math.round(DOT_TOUCH_PT * scale))
  const allH = [...horizontals, ...dotH], allV = [...verticals, ...dotV]
  // 가로 a 가 세로 선(p.x1 = p.x2)과 만나거나 끝이 닿는지 (세로 a 는 축을 바꿔 같은 판정)
  const touchesV = (a: PxSegment) => allV.some(p => p.x1 >= a.x1 - tol && p.x1 <= a.x2 + tol && a.y1 >= p.y1 - tol && a.y1 <= p.y2 + tol)
  const touchesH = (a: PxSegment) => allH.some(p => p.y1 >= a.y1 - tol && p.y1 <= a.y2 + tol && a.x1 >= p.x1 - tol && a.x1 <= p.x2 + tol)
  horizontals.push(...dotH.filter(touchesV))
  verticals.push(...dotV.filter(touchesH))
  // 채움 경계는 표 괘선에 맞물린 것만 쓴다 — 머리 행 음영의 윗변·아랫변은 표 가로 괘선(세로 괘선과 만나는 것)과 폭(양 끝)이
  // 같고, 좌우 변은 그 가로선 끝점에, 칸 사이 흰 틈은 바로 위아래 본문 세로 괘선과 같은 x 에 선다. 칸 안에 놓인 단색
  // 로고·그림의 변은 어느 쪽도 아니다(kmcc-press 참여 기업 표: 로고 칸이 행·열을 쪼갰다 — 로고 밑줄은 잉크 선으로 잡히지만
  // 세로 괘선과 만나지 않는다)
  const inkV = [...verticals]
  const ruleH = horizontals.filter(p => inkV.some(v => v.x1 >= p.x1 - tol && v.x1 <= p.x2 + tol && p.y1 >= v.y1 - tol && p.y1 <= v.y2 + tol))
  const fill = fillEdges(luma, width, height, scale)
  const fillH = fill.horizontals.filter(a => ruleH.some(p => Math.abs(p.x1 - a.x1) <= tol && Math.abs(p.x2 - a.x2) <= tol))
  horizontals.push(...fillH)
  const edgeH = [...ruleH, ...fillH]
  verticals.push(...fill.verticals.filter(a =>
    inkV.some(p => Math.abs(p.x1 - a.x1) <= tol && p.y1 <= a.y2 + tol && p.y2 >= a.y1 - tol) ||
    edgeH.some(p => (Math.abs(p.x1 - a.x1) <= tol || Math.abs(p.x2 - a.x1) <= tol) && p.y1 >= a.y1 - tol && p.y1 <= a.y2 + tol)))
  return { horizontals, verticals }
}

/**
 * 채움 영역의 바깥 경계 선 (FILL_* 주석). 채움 경계는 칸 크기 단위라 해상도가 필요 없어 k×k(≈1pt) 블록으로 줄여 본다 —
 * 블록 휘도는 가장 밝은 픽셀(칸 사이 1~3px 흰 틈이 채움에 묻히지 않게). 방향마다 안쪽 연속 채움 길이를 한 번 누적해
 * 경계 마스크를 만들고, 찾은 선은 원래 픽셀 좌표로 되돌린다
 */
function fillEdges(pageLuma: Uint8Array, width: number, height: number, scale: number): RulingLines {
  const k = Math.max(1, Math.round(scale))
  const w = Math.floor(width / k), h = Math.floor(height / k), n = w * h
  const luma = new Uint8Array(n)
  const hist = new Uint32Array(256)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let mx = 0
      for (let by = 0; by < k; by++) {
        let i = (y * k + by) * width + x * k
        for (let bx = 0; bx < k; bx++, i++) if (pageLuma[i] > mx) mx = pageLuma[i]
      }
      luma[y * w + x] = mx
      hist[mx]++
    }
  }
  let bg = 255
  for (let v = 0; v < 256; v++) if (hist[v] > hist[bg]) bg = v
  const tint = new Uint8Array(n)
  for (let p = 0; p < n; p++) if (luma[p] < bg - FILL_DELTA) tint[p] = 1
  const depth = Math.max(2, Math.round(FILL_MIN_DEPTH_PT * scale / k))
  const minLen = Math.round(FILL_MIN_LENGTH_PT * scale / k)
  const solid: RunReader = (m, base, step, span) => solidRuns(m, base, step, span, minLen)
  const run = new Uint16Array(n)
  const mask = new Uint8Array(n)
  const out: RulingLines = { horizontals: [], verticals: [] }
  // dx,dy = 채움 안쪽 방향. 위 변(0,1)·아래 변(0,-1)·왼 변(1,0)·오른 변(-1,0)
  for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
    // run[p] = p 에서 안쪽 방향으로 이어지는 채움 길이 (안쪽 끝부터 거꾸로 누적)
    const step = dy * w + dx
    const ys = dy > 0 ? [h - 1, -1, -1] : [0, h, 1]
    const xs = dx > 0 ? [w - 1, -1, -1] : [0, w, 1]
    for (let y = ys[0]; y !== ys[1]; y += ys[2]) {
      for (let x = xs[0]; x !== xs[1]; x += xs[2]) {
        const p = y * w + x
        const nx = x + dx, ny = y + dy
        run[p] = tint[p] ? (nx >= 0 && nx < w && ny >= 0 && ny < h ? Math.min(65535, run[p + step] + 1) : 1) : 0
      }
    }
    mask.fill(0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const p = y * w + x
        if (run[p] < depth) continue
        const ox = x - dx, oy = y - dy // 바깥 이웃
        if (ox < 0 || oy < 0 || ox >= w || oy >= h || !tint[p - step]) mask[p] = 1
      }
    }
    const vertical = dx !== 0
    const flat = (s: PxSegment) => {
      // 경계 안쪽 depth/2 지점의 휘도가 고른지 — 사진·도안 탈락
      const d = depth >> 1
      const vals: number[] = []
      if (vertical) {
        const x = Math.round(s.x1) + dx * d
        for (let y = Math.round(s.y1); y <= s.y2; y++) if (x >= 0 && x < w) vals.push(luma[y * w + x])
      } else {
        const y = Math.round(s.y1) + dy * d
        for (let x = Math.round(s.x1); x <= s.x2; x++) if (y >= 0 && y < h) vals.push(luma[y * w + x])
      }
      if (!vals.length) return false
      const med = [...vals].sort((a, b) => a - b)[vals.length >> 1]
      return vals.filter(v => Math.abs(v - med) <= FILL_FLAT_TOL).length >= vals.length * FILL_FLAT_RATIO
    }
    for (const s of detectBands(mask, w, h, 1, vertical, solid)) {
      if (!flat(s)) continue
      const c = (v: number) => v * k + (k - 1) / 2
      ;(vertical ? out.verticals : out.horizontals).push({ x1: c(s.x1), y1: c(s.y1), x2: c(s.x2), y2: c(s.y2), thicknessPx: 1 })
    }
  }
  return out
}

/**
 * 스캔라인 하나의 런 판독 — 마스크의 base + pos·step 픽셀(pos = 0..span-1). 가로 스캔은 step 1, 세로 스캔은 step = 쪽 폭.
 * 픽셀마다 접근 함수를 부르던 종전 모양은 괘선 감지 시간의 40% 가 그 호출이었다(쪽당 4패스 × 450만 픽셀)
 */
type RunReader = (mask: Uint8Array, base: number, step: number, span: number) => Array<{ lo: number; hi: number }>

/** 스캔라인 하나의 실선 런 (GAP_TOL_PX 이하 끊김 허용, 최소 길이 이상) */
function solidRuns(mask: Uint8Array, base: number, step: number, span: number, minLenPx: number): Array<{ lo: number; hi: number }> {
  const runs: Array<{ lo: number; hi: number }> = []
  let runStart = -1
  let gap = 0
  for (let pos = 0; pos <= span; pos++) {
    const on = pos < span && mask[base + pos * step] === 1
    if (on) {
      if (runStart < 0) runStart = pos
      gap = 0
    } else if (runStart >= 0) {
      if (++gap > GAP_TOL_PX || pos >= span) {
        const hi = pos - gap
        if (hi - runStart + 1 >= minLenPx) runs.push({ lo: runStart, hi })
        runStart = -1
        gap = 0
      }
    }
  }
  return runs
}

/** 스캔라인 하나의 점선 런 — 짧은 잉크 조각(≤ maxDash)이 간격 ≤ maxGap 으로 DOT_MIN_COUNT 개+ 이어진 사슬 (DOT_* 주석) */
function dottedRuns(
  mask: Uint8Array,
  base: number,
  step: number,
  span: number,
  minLenPx: number,
  maxGap: number,
  maxDash: number,
  maxPeriod: number,
): Array<{ lo: number; hi: number }> {
  const runs: Array<{ lo: number; hi: number }> = []
  // 사슬 조각의 [lo, hi] — 사슬이 끊길 때만 통계를 본다 (대부분 스캔라인은 사슬이 없다)
  const chain: number[] = []
  const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]
  const flush = () => {
    const cnt = chain.length >> 1
    if (cnt >= DOT_MIN_COUNT && chain[chain.length - 1] - chain[0] + 1 >= minLenPx) {
      const periods: number[] = [], dashes: number[] = [], gaps: number[] = []
      for (let k = 0; k < cnt; k++) {
        dashes.push(chain[2 * k + 1] - chain[2 * k] + 1)
        if (k) { periods.push(chain[2 * k] - chain[2 * k - 2]); gaps.push(chain[2 * k] - chain[2 * k - 1] - 1) }
      }
      if (median(periods) <= maxPeriod || median(dashes) >= 1.5 * median(gaps)) runs.push({ lo: chain[0], hi: chain[chain.length - 1] })
    }
    chain.length = 0
  }
  let s = -1
  for (let pos = 0; pos <= span; pos++) {
    const on = pos < span && mask[base + pos * step] === 1
    if (on) { if (s < 0) s = pos; continue }
    if (s < 0) continue
    const lo = s, hi = pos - 1
    s = -1
    if (hi - lo + 1 > maxDash) { flush(); continue }
    if (chain.length && lo - chain[chain.length - 1] - 1 > maxGap) flush()
    chain.push(lo, hi)
  }
  flush()
  return runs
}

/** 열린 밴드 — 인접 스캔라인의 런을 누적 */
interface Band {
  lo: number // 런 진행축 시작 (h: x1, v: y1)
  hi: number // 런 진행축 끝
  first: number // 직교축 시작 스캔라인 (h: yTop, v: xLeft)
  last: number // 직교축 마지막 스캔라인
}

/**
 * 스캔라인 런렝스 → 인접 라인 밴드 병합 → 두께 필터 → 선분 방출.
 * transpose=false 면 수평선(행 스캔), true 면 수직선(열 스캔).
 */
function detectBands(
  ink: Uint8Array,
  width: number,
  height: number,
  maxThickPx: number,
  transpose: boolean,
  readRuns: RunReader,
): PxSegment[] {
  const lines = transpose ? width : height // 스캔라인 개수 (직교축)
  const span = transpose ? height : width // 런 진행축 길이
  const step = transpose ? width : 1
  const baseOf = (line: number) => (transpose ? line : line * width)

  const out: PxSegment[] = []
  let open: Band[] = []

  /** 밴드 양측(±2px 스캔라인)의 잉크 비율 — 채운 색상바 안 흰 글자 틈새 슬리버 판별 */
  const surroundInkRatio = (b: Band, side: number): number => {
    if (side < 0 || side >= lines) return 0
    let dark = 0, total = 0
    const base = baseOf(side)
    for (let pos = b.lo; pos <= b.hi; pos += 3) {
      total++
      if (ink[base + pos * step] === 1) dark++
    }
    return total > 0 ? dark / total : 0
  }

  const emit = (b: Band) => {
    const thick = b.last - b.first + 1
    if (thick > maxThickPx) return // 색상바·텍스트 밴드
    if (
      surroundInkRatio(b, b.first - 2) >= SURROUND_INK_RATIO &&
      surroundInkRatio(b, b.last + 2) >= SURROUND_INK_RATIO
    ) return // 채운 영역 내부 슬리버
    const center = (b.first + b.last) / 2
    out.push(
      transpose
        ? { x1: center, y1: b.lo, x2: center, y2: b.hi, thicknessPx: thick }
        : { x1: b.lo, y1: center, x2: b.hi, y2: center, thicknessPx: thick },
    )
  }

  for (let line = 0; line < lines; line++) {
    // 1) 이 스캔라인의 런 (실선 또는 점선 사슬)
    const runs = readRuns(ink, baseOf(line), step, span)

    // 2) 열린 밴드와 병합 — 직전 스캔라인까지 이어졌고 범위가 겹치면 확장
    const next: Band[] = []
    const used = new Set<number>()
    for (const band of open) {
      if (band.last !== line - 1) { emit(band); continue } // 연속 끊김 → 확정
      let merged = false
      for (let r = 0; r < runs.length; r++) {
        if (used.has(r)) continue
        const run = runs[r]
        const overlap = Math.min(band.hi, run.hi) - Math.max(band.lo, run.lo) + 1
        const shorter = Math.min(band.hi - band.lo, run.hi - run.lo) + 1
        if (overlap >= shorter * BAND_OVERLAP_RATIO) {
          band.lo = Math.min(band.lo, run.lo)
          band.hi = Math.max(band.hi, run.hi)
          band.last = line
          next.push(band)
          used.add(r)
          merged = true
          break
        }
      }
      if (!merged) emit(band)
    }
    for (let r = 0; r < runs.length; r++) {
      if (!used.has(r)) next.push({ lo: runs[r].lo, hi: runs[r].hi, first: line, last: line })
    }
    open = next
  }
  for (const band of open) emit(band)
  return out
}

/**
 * 픽셀 선분 → PDF pt LineSegment (bottom-up, classifyAndAdd 규약:
 * 수평선 y1==y2·x1<x2, 수직선 x1==x2·y1<y2).
 */
export function rulingToPdfLines(
  ruling: RulingLines,
  scale: number,
  pdfHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = ruling.horizontals.map(s => {
    const y = pdfHeight - (s.y1 + s.y2) / 2 / scale
    return {
      x1: Math.min(s.x1, s.x2) / scale,
      y1: y,
      x2: Math.max(s.x1, s.x2) / scale,
      y2: y,
      lineWidth: s.thicknessPx / scale,
    }
  })
  const verticals: LineSegment[] = ruling.verticals.map(s => {
    const x = (s.x1 + s.x2) / 2 / scale
    const yA = pdfHeight - Math.max(s.y1, s.y2) / scale
    const yB = pdfHeight - Math.min(s.y1, s.y2) / scale
    return { x1: x, y1: yA, x2: x, y2: yB, lineWidth: s.thicknessPx / scale }
  })
  return { horizontals, verticals }
}
