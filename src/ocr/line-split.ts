/**
 * 검출 박스 픽셀 분석 — 행 밴드 분할 + 잉크 대비.
 *
 * DB 검출기는 줄 간격보다 글자 간격이 넓으면 글자를 세로로 잇는다: 표 머리의 세로쓰기
 * ("국/균/도/시", "사회복지과"), 균등배분 목차의 같은 열 글자들이 키 큰 박스 하나가 되고,
 * 인식기(높이 48 고정)는 이를 짓눌러 빈 문자열이나 저신뢰 쓰레기를 낸다(실측: 코퍼스
 * 80쪽에서 GT 글자 0.55% 가 이런 박스와 함께 폐기). 박스 안 행 투영의 빈 띠로 밴드를
 * 갈라 밴드마다 따로 인식하면 글자가 자기 위치(행)를 되찾는다.
 *
 * 잉크 대비는 배경 무늬(연한 바탕의 흰 도안)를 글자로 읽는 환각을 거른다 — 진짜 글자는
 * 전경/배경 평균 휘도 차가 크다.
 */

/** RGBA 페이지에서 박스 영역 휘도(BT.601 정수 근사) 추출 */
export function grayCrop(
  rgba: Uint8Array,
  pageW: number,
  box: { x: number; y: number; w: number; h: number },
): Uint8Array {
  const out = new Uint8Array(box.w * box.h)
  for (let y = 0; y < box.h; y++) {
    let si = ((box.y + y) * pageW + box.x) * 4
    let di = y * box.w
    for (let x = 0; x < box.w; x++, si += 4, di++) {
      out[di] = (rgba[si] * 77 + rgba[si + 1] * 150 + rgba[si + 2] * 29) >> 8
    }
  }
  return out
}

export interface InkStats {
  /** Otsu 임계값 */
  threshold: number
  /** 잉크 = 소수 클래스. true 면 어두운 쪽이 잉크(일반 문서) */
  darkInk: boolean
  /** 두 클래스 평균 휘도 차 (0~255) — 글자 대비 */
  contrast: number
  /** 잉크 픽셀 비율 */
  inkRatio: number
}

/** Otsu 이진화 — 잉크 극성(소수 클래스)과 대비 */
export function inkStats(gray: Uint8Array): InkStats {
  const hist = new Uint32Array(256)
  for (let i = 0; i < gray.length; i++) hist[gray[i]]++
  const total = gray.length
  let sumAll = 0
  for (let v = 0; v < 256; v++) sumAll += v * hist[v]
  let wB = 0, sumB = 0, best = -1, thr = 127
  for (let t = 0; t < 256; t++) {
    wB += hist[t]
    if (wB === 0) continue
    const wF = total - wB
    if (wF === 0) break
    sumB += t * hist[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > best) { best = between; thr = t }
  }
  let nDark = 0, sDark = 0
  for (let v = 0; v <= thr; v++) { nDark += hist[v]; sDark += v * hist[v] }
  const nLight = total - nDark
  const sLight = sumAll - sDark
  if (nDark === 0 || nLight === 0) return { threshold: thr, darkInk: true, contrast: 0, inkRatio: 0 }
  const darkInk = nDark <= nLight
  return {
    threshold: thr,
    darkInk,
    contrast: sLight / nLight - sDark / nDark,
    inkRatio: (darkInk ? nDark : nLight) / total,
  }
}

/**
 * 행 투영의 빈 띠로 밴드 분할. 반환: 밴드별 [y0, y1) 행 구간과 괘선을 뺀 잉크 [x0, x1) 열 구간
 * (박스 로컬). 분할 불가면 길이 1.
 * @param minBandRatio 밴드 최소 높이 = 이 비율 × 글자 크기. 이보다 얇은 조각(한 글자 안의
 *   획 띠 "을"의 ㅇ/ㅡ/ㄹ, 밑줄, 박스 끝에 걸린 이웃 글자 조각)은 간격이 좁은 쪽 이웃 밴드에
 *   흡수된다. 글자 크기는 밴드별 잉크 가로 폭의 중앙값 — 박스 폭은 unclip 여백만큼 글자보다
 *   넓고(◎ 40px 에 박스 92px) 박스 전체 잉크 폭은 옆 열 글자 조각에 끌려가서, 둘 다 쓰면
 *   제대로 된 글자 밴드까지 합쳐진다(함평 목차 실측). 획 조각도 가로 폭은 글자 폭(ㅡ)이라
 *   중앙값이 흔들리지 않는다
 */
export function splitRowBands(
  gray: Uint8Array,
  w: number,
  h: number,
  ink: InkStats,
  minBandRatio: number,
): Array<{ y0: number; y1: number; x0: number; x1: number }> {
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  // 박스를 관통하는 괘선 — 세로선(행 85%+ 에 잉크인 열)은 투영에서 빼고, 가로선(남은 폭
  // 85%+ 가 잉크인 행)은 빈 행(구분자)으로 본다. 표 칸 사이 세로쓰기 라벨("국/균/도/시")
  // 박스는 칸 경계 세로선을 끼고 잡혀 빈 행이 하나도 없다(부천 예산서 실측)
  const colInk = new Uint32Array(w)
  for (let y = 0; y < h; y++) {
    const off = y * w
    for (let x = 0; x < w; x++) if (isInk(gray[off + x])) colInk[x]++
  }
  const ruleCol = new Uint8Array(w)
  let liveW = 0
  for (let x = 0; x < w; x++) { if (colInk[x] >= h * 0.85) ruleCol[x] = 1; else liveW++ }
  const rowInk = new Uint32Array(h)
  for (let y = 0; y < h; y++) {
    let n = 0
    const off = y * w
    for (let x = 0; x < w; x++) if (!ruleCol[x] && isInk(gray[off + x])) n++
    rowInk[y] = n >= liveW * 0.85 ? 0 : n
  }
  // 안티앨리어싱·잡티 허용: 폭의 2% (최소 1px) 이하면 빈 행
  const blank = Math.max(1, Math.floor(w * 0.02))
  let bands: Array<[number, number]> = []
  let start = -1
  for (let y = 0; y <= h; y++) {
    const on = y < h && rowInk[y] > blank
    if (on && start < 0) start = y
    else if (!on && start >= 0) { bands.push([start, y]); start = -1 }
  }
  const inkCols = (y0: number, y1: number): [number, number] => {
    let x0 = w, x1 = -1
    for (let y = y0; y < y1; y++) {
      const off = y * w
      for (let x = 0; x < w; x++) if (!ruleCol[x] && isInk(gray[off + x])) { if (x < x0) x0 = x; if (x > x1) x1 = x }
    }
    return x1 >= x0 ? [x0, x1 + 1] : [0, w]
  }
  if (bands.length <= 1) return [{ y0: bands[0]?.[0] ?? 0, y1: bands[0]?.[1] ?? h, x0: 0, x1: w }]
  const widths = bands.map(([y0, y1]) => { const [a, b] = inkCols(y0, y1); return b - a }).sort((a, b) => a - b)
  const charSize = widths[widths.length >> 1]
  const minBand = Math.max(3, minBandRatio * charSize)
  // 글자 안 빈 행(“업”의 어/ㅂ 사이 2px) — 간격이 글자 크기 15% 이하이고 합쳐도 한 글자
  // 높이(1.3배) 안이면 한 밴드. 세로쓰기의 글자 사이 간격은 이보다 넓고, 두 글자를 합치면
  // 높이 상한에 걸린다
  for (let i = 0; i + 1 < bands.length;) {
    const gap = bands[i + 1][0] - bands[i][1]
    if (gap <= Math.max(2, charSize * 0.15) && bands[i + 1][1] - bands[i][0] <= charSize * 1.3) {
      bands.splice(i, 2, [bands[i][0], bands[i + 1][1]])
    } else i++
  }
  // 박스 위아래 끝에 걸린 얇은 조각 = 이웃 줄 글자의 끝자락 — 합치지 않고 버린다
  while (bands.length > 1 && bands[0][0] <= 1 && bands[0][1] - bands[0][0] < minBand) bands.shift()
  while (bands.length > 1 && bands[bands.length - 1][1] >= h - 1 && bands[bands.length - 1][1] - bands[bands.length - 1][0] < minBand) bands.pop()
  // 얇은 밴드 흡수 — 간격이 더 좁은 쪽 이웃과 합침 (가장 얇은 것부터 반복)
  for (;;) {
    let idx = -1, minH = Infinity
    for (let i = 0; i < bands.length; i++) {
      const bh = bands[i][1] - bands[i][0]
      if (bh < minBand && bh < minH) { minH = bh; idx = i }
    }
    if (idx < 0 || bands.length === 1) break
    const gapPrev = idx > 0 ? bands[idx][0] - bands[idx - 1][1] : Infinity
    const gapNext = idx < bands.length - 1 ? bands[idx + 1][0] - bands[idx][1] : Infinity
    const j = gapPrev <= gapNext ? idx - 1 : idx + 1
    const a = Math.min(idx, j), b = Math.max(idx, j)
    bands = [...bands.slice(0, a), [bands[a][0], bands[b][1]], ...bands.slice(b + 1)]
  }
  if (bands.length === 1) return [{ y0: bands[0][0], y1: bands[0][1], x0: 0, x1: w }]
  return bands.map(([y0, y1]) => { const [x0, x1] = inkCols(y0, y1); return { y0, y1, x0, x1 } })
}

type Comp = { x0: number; x1: number; y0: number; y1: number; id: number }

/**
 * 글자 잉크 연결 성분(8-이웃) — 성분마다 bbox, label 은 픽셀별 성분 번호(0 = 배경). 박스를 관통하는 칸 경계
 * 괘선 성분(박스 높이·폭의 85%+, inkBounds 와 같은 기준)은 글자가 아니라 뺀다 — 괘선이 가장 큰 성분이 되면
 * 글자 높이가 부풀어 숫자들이 "점"으로 잡혔다(goesan-budget-2013 두 칸을 문 박스 "8,000 │ 1,000")
 */
function components(gray: Uint8Array, w: number, h: number, ink: InkStats): { comps: Comp[]; label: Int32Array } {
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  const comps: Comp[] = []
  const label = new Int32Array(w * h)
  const stack: number[] = []
  for (let p0 = 0; p0 < w * h; p0++) {
    if (label[p0] || !isInk(gray[p0])) continue
    const c = { x0: w, x1: 0, y0: h, y1: 0, id: comps.length + 1 }
    label[p0] = c.id
    stack.push(p0)
    while (stack.length) {
      const p = stack.pop()!
      const x = p % w, y = (p / w) | 0
      if (x < c.x0) c.x0 = x
      if (x + 1 > c.x1) c.x1 = x + 1
      if (y < c.y0) c.y0 = y
      if (y + 1 > c.y1) c.y1 = y + 1
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (!label[q] && isInk(gray[q])) { label[q] = c.id; stack.push(q) }
      }
    }
    if (c.y1 - c.y0 < h * 0.85 && c.x1 - c.x0 < w * 0.85) comps.push(c)
  }
  return { comps, label }
}

/**
 * 박스 맨 앞 글자가 삼각형(△ 감액·▲ 증가 표시)인지. 인식 사전에 △·▲ 가 없어 모델은 숫자 앞 삼각형을
 * 빈칸으로 버린다 — 예산서 "△400,352" → "400,352" (코퍼스 GT △ 81개 중 OCR 30개, 나머지 부호 소실).
 * 가장 왼쪽 성분(글자 높이 40%+)이 밑변(아래 두 줄이 폭 70%+)·좁은 꼭짓점(위 20% 줄이 폭 40% 이하·가운데)·
 * 양옆 빗변(높이 60% 줄의 잉크가 폭 30% 안쪽과 70% 바깥 양쪽)을 가지면 삼각형, 그 줄 가운데가 비면 △ 차면 ▲.
 * 숫자(4·1·2·7 등)는 밑변이나 꼭짓점·빗변 조건 중 하나에서 걸린다.
 */
export function leadingTriangle(gray: Uint8Array, w: number, h: number, ink: InkStats): "\u25b3" | "\u25b2" | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  const first = comps.filter(c => c.y1 - c.y0 >= charH * 0.4).sort((a, b) => a.x0 - b.x0)[0]
  if (!first || charH < 8) return null
  const cw = first.x1 - first.x0, ch = first.y1 - first.y0
  if (cw < ch * 0.8 || cw > ch * 1.8) return null
  const rowSpan = (y: number): { n: number; lo: number; hi: number; runs: number } => {
    let n = 0, lo = -1, hi = -1, runs = 0, prev = false
    for (let x = first.x0; x < first.x1; x++) {
      const on = label[y * w + x] === first.id
      if (on) { n++; if (lo < 0) lo = x - first.x0; hi = x - first.x0; if (!prev) runs++ }
      prev = on
    }
    return { n, lo, hi, runs }
  }
  const base = Math.max(rowSpan(first.y1 - 1).n, rowSpan(first.y1 - 2).n)
  if (base < cw * 0.7) return null
  for (let y = first.y0; y < first.y0 + Math.max(1, Math.round(ch * 0.2)); y++) {
    const r = rowSpan(y)
    if (r.n === 0) continue
    if (r.hi - r.lo + 1 > cw * 0.4 || (r.lo + r.hi) / 2 < cw * 0.25 || (r.lo + r.hi) / 2 > cw * 0.75) return null
  }
  const mid = rowSpan(first.y0 + Math.round(ch * 0.6))
  if (mid.lo < 0 || mid.lo > cw * 0.3 || mid.hi < cw * 0.7) return null
  return mid.runs >= 2 ? "\u25b3" : "\u25b2"
}

/**
 * 목차 리더 점("·········")의 가로 구간들 (박스 로컬 [x0, x1)). 검출기는 쪽번호를 앞쪽 리더 점과 한 박스로
 * 묶는데, 인식기는 점 무리 뒤 숫자를 망친다 — "·····5"→"…55", "·····141"→"…11", "·····203"→"03"
 * (changwon-plan2026 목차 실측, 코퍼스 80쪽의 리더 섞인 박스 192개). 점 무리를 빼고 앞뒤 글만 따로 인식한다.
 * 잉크 연결 성분(8-이웃)을 x 가 겹치는 것끼리 묶은 글자 덩어리 단위로 본다 — 한글 한 글자는 여러 성분("소" = ㅅ+ㅗ)
 * 이라 성분 하나로 글자 높이를 재면 굵은 리더 점(9px)이 점으로 안 잡혔다(yeosu 목차). 점: 글자 높이(가장 큰 덩어리
 * 높이) 30% 이하의 작은 덩어리이고 중심이 글자 띠(점 크기를 넘는 성분들의 세로 범위) 안 — 박스 위아래 여백에 걸친
 * 점선 괘선 조각은 띠 밖이다(changwon 정원표 칸 실측). 무리: x 순서로 연달아 놓인 점들이 세로 중심 한 줄(±20%)·
 * 간격 글자 높이 이하로 minDots 개+. 리더는 같은 줄 글자를 잇는다 — 무리 앞이나 뒤 글자 높이 2배 안에 점 높이를
 * 세로로 품는 글자 성분이 있어야 한다. 두 행 사이 점선 괘선을 문 박스(위아래 행 글자가 띠를 넓힘)는 여기서 걸린다.
 * 리더는 같은 글리프를 고른 간격으로 찍은 것이라 점 크기(최대/최소 2.5배 이내)·주기(1.8배 이내)가 고르다 — 작은
 * 글꼴의 가는 획이 이진화로 쪼갠 조각("gifted.kaist.ac.kr", pen-cyberbridge 흐름도)은 여기서 걸린다. 박스 끝에 닿아
 * 잘린 점은 통계에서 빼고, 값이 5개 이상이면 양 끝값도 뺀다.
 */
export function leaderRuns(
  gray: Uint8Array,
  w: number,
  h: number,
  ink: InkStats,
  minDots: number,
): Array<[number, number]> {
  const comps = components(gray, w, h, ink).comps.sort((a, b) => a.x0 - b.x0)
  // x 구간이 겹치는 성분끼리 한 덩어리
  const blobs: Array<{ x0: number; x1: number; y0: number; y1: number }> = []
  for (const c of comps) {
    const last = blobs[blobs.length - 1]
    if (last && c.x0 < last.x1) { last.x1 = Math.max(last.x1, c.x1); last.y0 = Math.min(last.y0, c.y0); last.y1 = Math.max(last.y1, c.y1) }
    else blobs.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1 })
  }
  let charH = 0
  for (const b of blobs) charH = Math.max(charH, b.y1 - b.y0)
  if (charH < 8) return []
  const small = (c: { x0: number; x1: number; y0: number; y1: number }) => c.x1 - c.x0 <= charH * 0.3 && c.y1 - c.y0 <= charH * 0.3
  let bandTop = h, bandBot = 0
  for (const c of comps) if (!small(c)) { bandTop = Math.min(bandTop, c.y0); bandBot = Math.max(bandBot, c.y1) }
  const cy = (c: { y0: number; y1: number }) => (c.y0 + c.y1) / 2
  const isDot = (b: { x0: number; x1: number; y0: number; y1: number }) => small(b) && cy(b) >= bandTop && cy(b) <= bandBot
  const runs: Array<[number, number]> = []
  for (let i = 0; i < blobs.length;) {
    if (!isDot(blobs[i])) { i++; continue }
    let j = i
    while (j + 1 < blobs.length && isDot(blobs[j + 1]) && blobs[j + 1].x0 - blobs[j].x1 <= charH
      && Math.abs(cy(blobs[j + 1]) - cy(blobs[i])) <= charH * 0.2) j++
    const x0 = blobs[i].x0, x1 = blobs[j].x1, y = cy(blobs[i])
    const onLine = comps.some(c => !small(c) && c.y0 <= y && c.y1 >= y
      && ((c.x1 <= x0 + 2 && c.x1 >= x0 - 2 * charH) || (c.x0 >= x1 - 2 && c.x0 <= x1 + 2 * charH)))
    const run = blobs.slice(i, j + 1).filter(b => b.x0 > 0 && b.x1 < w)
    const spread = (xs: number[]) => {
      const v = [...xs].sort((a, b) => a - b).slice(xs.length >= 5 ? 1 : 0, xs.length >= 5 ? -1 : undefined)
      return v[v.length - 1] / Math.max(1, v[0])
    }
    const even = run.length >= 2 && spread(run.map(b => b.x1 - b.x0)) <= 2.5 && spread(run.map(b => b.y1 - b.y0)) <= 2.5
      && spread(run.slice(1).map((b, k) => b.x0 - run[k].x0)) <= 1.8
    if (j - i + 1 >= minDots && onLine && even) runs.push([x0, x1])
    i = j + 1
  }
  return runs
}

/**
 * 박스 안 잉크 외곽 (박스 로컬, [x0,x1)·[y0,y1)) — 관통 괘선(행/열 85%+ 잉크)의 픽셀은 뺀다.
 * det 박스는 unclip 여백만큼 글자보다 커서(본문 10pt 에 박스 높이 ≈ 1.5em) 이를 그대로
 * 좌표로 넘기면 글자 크기·줄 기준선·칸 배정이 텍스트층 아이템과 어긋난다. 표 칸 숫자 박스는
 * 칸 경계 괘선을 물고 잡히므로(고산 예산서 실측) 괘선 픽셀을 빼지 않으면 외곽이 박스 전체가
 * 된다. 잉크가 없으면 박스 전체.
 */
export function inkBounds(
  gray: Uint8Array,
  w: number,
  h: number,
  ink: InkStats,
): { x0: number; y0: number; x1: number; y1: number } {
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  const colInk = new Uint32Array(w)
  const rowInk = new Uint32Array(h)
  for (let y = 0; y < h; y++) {
    const off = y * w
    for (let x = 0; x < w; x++) if (isInk(gray[off + x])) { colInk[x]++; rowInk[y]++ }
  }
  const ruleCol = new Uint8Array(w), ruleRow = new Uint8Array(h)
  for (let x = 0; x < w; x++) if (colInk[x] >= h * 0.85) ruleCol[x] = 1
  for (let y = 0; y < h; y++) if (rowInk[y] >= w * 0.85) ruleRow[y] = 1
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = 0; y < h; y++) {
    if (ruleRow[y]) continue
    const off = y * w
    for (let x = 0; x < w; x++) {
      if (ruleCol[x] || !isInk(gray[off + x])) continue
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
    }
  }
  if (x1 < x0 || y1 < y0) return { x0: 0, y0: 0, x1: w, y1: h }
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}
