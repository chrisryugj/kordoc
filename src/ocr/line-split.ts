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
 * 홀로 선 화살표 박스의 모양 — 사전에 → 만 있어 모델은 화살표류를 모두 → 로 읽는다(서식 흐름도 ➔·▶, 업무계획 ⇨).
 * 가장 큰 잉크 성분의 왼쪽(대) 부분 세로 단면으로 가른다: 단면이 위아래 둘(테두리만)이면 속 빈 ⇨, 왼끝 단면이 성분
 * 높이를 거의 채우고 오른쪽으로 갈수록 줄면 삼각 ▶(대가 따로 떨어진 "----▶"), 대 굵기가 성분 높이의 22% 넘으면 굵은 ➔.
 * 그 밖(가는 대)은 → 그대로(null)
 */
export function arrowGlyph(gray: Uint8Array, w: number, h: number, ink: InkStats): "\u21e8" | "\u25b6" | "\u2794" | null {
  const { comps, label } = components(gray, w, h, ink)
  const main = comps.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0]
  if (!main) return null
  const cw = main.x1 - main.x0, ch = main.y1 - main.y0
  if (ch < 8 || cw < ch * 0.6) return null
  const runs = (x: number): number[] => {
    const out: number[] = []
    let n = 0
    for (let y = main.y0; y < main.y1; y++) {
      if (label[y * w + x] === main.id) n++
      else if (n) { out.push(n); n = 0 }
    }
    if (n) out.push(n)
    return out
  }
  const cols: number[][] = []
  for (let x = main.x0 + 1; x < main.x0 + Math.max(2, Math.round(cw * 0.35)); x++) cols.push(runs(x))
  if (cols.length < 2) return null
  if (cols.filter(r => r.length === 2).length >= cols.length * 0.7) return "\u21e8"
  // 대 끝 쪽 단면에 머리 날개 끝이 걸릴 수 있다 — 한 덩어리 단면이 대부분이면 그것만 본다
  const single = cols.filter(r => r.length === 1)
  if (single.length < cols.length * 0.7) return null
  const lens = single.map(r => r[0]).sort((a, b) => a - b), med = lens[lens.length >> 1]
  const tail = runs(main.x0 + Math.round(cw * 0.8))
  if (med >= ch * 0.8 && tail.length === 1 && tail[0] <= ch * 0.5) return "\u25b6"
  if (med >= ch * 0.22 && med < ch * 0.5 && cw >= ch * 0.9) return "\u2794"
  return null
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
  // 세로 괘선의 번진 가장자리 — 기울기 보정으로 다시 돌린 세로 괘선은 보간 때문에 옆 열로 번져(잉크 62%) 글 잉크로 잡히고, 숫자 상자가
  // 그 열의 세로 범위만큼 위아래로 부풀었다(3° 기운 예산서 "500" 19 → 44px, 세부 행이 위 행에 합쳐짐). 좌우 15% 띠의 괘선 열에 붙은
  // 열이 잉크 절반을 넘으면 괘선으로 본다. 가로 괘선 쪽에 같은 규칙을 걸면 기운 서식 표의 행이 다시 짜여 CER 이 올랐다(허가신청서 서식)
  for (const r of [ruleCol.slice()]) for (let x = 0; x < w; x++) if (!r[x] && (x < w * 0.15 || x >= w * 0.85) && ((x > 0 && r[x - 1]) || (x + 1 < w && r[x + 1])) && colInk[x] >= h * 0.5) ruleCol[x] = 1
  // 점선 칸 괘선 너머의 이웃 칸 글자 끝자락 — 점선은 잉크가 절반쯤이라 85% 문턱에 안 걸려, 숫자 상자 외곽이 윗행 쉼표 꼬리까지 늘어나
  // 이웃 행 값과 한 칸에 몰렸다(성남시 혼인 건수 표 "1,605<br>3,388"). 상자 위아래 30% 띠의 점선(짧고 고른 조각이 폭 85% 넘게)
  // 너머에 잉크가 있을 때만 그 점선과 너머를 뺀다 — 너머가 비면 그대로 둔다(외곽이 줄면 띄어 쓴 머리 "전  세" 가 글자마다 갈렸다)
  let top = 0, bottom = h
  const inkRow = (y: number) => { for (let x = 0, off = y * w; x < w; x++) if (!ruleCol[x] && isInk(gray[off + x])) return true; return false }
  for (let y = Math.floor(h * 0.3); y >= 1; y--) {
    if (ruleRow[y] || !dottedRow(gray, w, h, y, isInk)) continue
    let beyond = false
    for (let k = 0; k < y && !beyond; k++) if (!ruleRow[k] && inkRow(k) && !dottedRow(gray, w, h, k, isInk)) beyond = true
    if (beyond) { top = y + 1; break }
  }
  for (let y = Math.ceil(h * 0.7); y < h - 1; y++) {
    if (ruleRow[y] || !dottedRow(gray, w, h, y, isInk)) continue
    let beyond = false
    for (let k = y + 1; k < h && !beyond; k++) if (!ruleRow[k] && inkRow(k) && !dottedRow(gray, w, h, k, isInk)) beyond = true
    if (beyond) { bottom = y; break }
  }
  let x0 = w, x1 = -1, y0 = h, y1 = -1
  for (let y = top; y < bottom; y++) {
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
  // 상자 테두리 옆 번진 띠 — 잡음·흐림·회전 보간이 섞이면 테두리에 붙은 열에 잉크가 남아(테두리 열 66/66, 바로 옆 열 20/66) 외곽이
  // 테두리까지 늘었다(조직도 팀 상자 "폐기물관리"·"산단폐기물" 이 테두리에 닿아 상자 밖 글이 됨). 외곽 끝이 괘선 열에 바로 붙은 2열
  // 안 무리(열마다 잉크 높이 45% 이하)이고 본문 잉크와 빈 열 3개 넘게 떨어져 있으면 뺀다
  const colAt = (x: number) => {
    let n = 0
    for (let y = Math.max(y0, top); y <= Math.min(y1, bottom - 1); y++) if (!ruleRow[y] && isInk(gray[y * w + x])) n++
    return n
  }
  const trimSpecks = (edge: number, d: number) => {
    let k = edge, n = 0
    for (; n < 2 && k >= 0 && k < w && !ruleCol[k] && colAt(k) > 0; n++, k -= d) if (colAt(k) > h * 0.45) return edge
    const touches = [edge + d, edge + 2 * d].some(r => r >= 0 && r < w && ruleCol[r])
    if (!touches || !n) return edge
    let gap = 0
    for (; k >= 0 && k < w && !ruleCol[k] && colAt(k) === 0; k -= d) gap++
    return gap >= 3 && k >= 0 && k < w && !ruleCol[k] ? k : edge
  }
  x1 = trimSpecks(x1, 1)
  x0 = trimSpecks(x0, -1)
  return { x0, y0, x1: x1 + 1, y1: y1 + 1 }
}

/**
 * 한 줄이 점선인가 — 조각 6개 이상이 길이 85% 넘게 걸치고, 조각·틈이 짧고(중앙값 4px 이하) 고르며(틈 최대가 중앙값의 2.5배 이하),
 * 얇다(3px 옆 줄의 같은 자리 잉크가 조각 픽셀의 30% 미만). 작은 대문자 글줄("DEPARTMENT STORE" 로고)을 가로지르는 행도
 * 짧고 고른 조각이지만 획이 옆 줄로 이어진다. at(i) = 줄의 i 번째 픽셀이 잉크인가, side(d, i) = d 만큼 옆 줄의 i 번째(없으면 null)
 */
function dottedLine(n: number, at: (i: number) => boolean, side: (d: number, i: number) => boolean | null): boolean {
  const runs: Array<[number, number]> = []
  for (let i = 0; i < n;) {
    if (!at(i)) { i++; continue }
    let e = i
    while (e < n && at(e)) e++
    runs.push([i, e])
    i = e
  }
  if (runs.length < 6 || runs[runs.length - 1][1] - runs[0][0] < n * 0.85) return false
  const med = (v: number[]) => [...v].sort((p, q) => p - q)[v.length >> 1]
  const lens = runs.map(([a, b]) => b - a), gaps = runs.slice(1).map(([a], i) => a - runs[i][1])
  const ml = med(lens), mg = med(gaps)
  if (!(ml <= 4 && mg <= 4 && Math.max(...lens) <= Math.max(3, ml * 2.5) && Math.max(...gaps) <= Math.max(3, mg * 2.5))) return false
  let px = 0
  for (const [a, b] of runs) px += b - a
  for (const d of [-3, 3]) {
    let n = 0, seen = false
    for (const [a, b] of runs) for (let i = a; i < b; i++) {
      const v = side(d, i)
      if (v === null) break
      seen = true
      if (v) n++
    }
    if (seen && n >= px * 0.3) return false
  }
  return true
}

function dottedRow(gray: Uint8Array, w: number, h: number, y: number, isInk: (v: number) => boolean): boolean {
  return dottedLine(w, x => isInk(gray[y * w + x]), (d, x) => (y + d < 0 || y + d >= h ? null : isInk(gray[(y + d) * w + x])))
}


/**
 * 괄호 조각 모양 — 윗·아랫 띠(높이 15%)의 가로 획 길이(폭 대비)와 기울기 줄 비율(taper: 획 폭과 전체 폭 사이 폭인 줄 / 높이).
 * [ ] 는 윗·아랫변 뒤 한 번에 획 폭으로 떨어지고(taper ≈ 0), 【】 는 위아래에서 가운데로 폭이 줄어든다(창원 계획 【 0.19~0.52 · 강원 정보화 계획 [ 0.03~0.06)
 */
export interface BracketFeatures { top: number; bottom: number; taper: number; fill: number; cw: number; ch: number; charH: number }

/** 박스 로컬 x 중심(cx) 자리의 괄호 조각 — 글자 높이 30% 이상 성분 가운데 cx 에 가장 가까운 것 (「」 는 글자 높이의 절반쯤이다) */
export function bracketFeatures(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): BracketFeatures | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 8) return null
  const tol = Math.max(2, charH * 0.3)
  let best: Comp | null = null, bestD = Infinity
  for (const c of comps) {
    if (c.y1 - c.y0 < charH * 0.3 || c.x1 < cx - tol || c.x0 > cx + tol) continue
    const d = Math.abs((c.x0 + c.x1) / 2 - cx)
    if (d < bestD) { bestD = d; best = c }
  }
  if (!best) return null
  const b = best
  const cw = b.x1 - b.x0, ch = b.y1 - b.y0
  if (cw < 3 || ch < 8) return null
  const spans: number[] = []
  for (let y = b.y0; y < b.y1; y++) {
    let n = 0
    for (let x = b.x0; x < b.x1; x++) if (label[y * w + x] === b.id) n++
    spans.push(n)
  }
  const band = Math.max(1, Math.round(ch * 0.15))
  const top = Math.max(...spans.slice(0, band)) / cw, bottom = Math.max(...spans.slice(ch - band)) / cw
  const midRows = spans.slice(Math.floor(ch * 0.3), Math.ceil(ch * 0.7)).sort((p, q) => p - q)
  const stroke = midRows[midRows.length >> 1] ?? 0
  const taper = spans.filter(n => n > stroke && n < cw).length / ch
  const fill = spans.reduce((a, n) => a + n, 0) / (cw * ch)
  return { top, bottom, taper, fill, cw, ch, charH }
}

/**
 * 평행 기호 ∥ — 앞뒤 글자 CTC 자리(글자 높이 0.35배 안쪽) 사이에 중심이 든 키 큰 성분(글자 높이 35% 이상) 가운데 가늘고(폭이 높이의
 * 절반 이하) 기운(위·아래 25% 줄 잉크 중심 차가 높이의 12% 이상) 것이 꼭 둘이고 같은 쪽으로 나란하면 참. 로마 숫자 Ⅱ 는 곧고 세리프가 있다
 */
export function slantedPair(gray: Uint8Array, w: number, h: number, ink: InkStats, prevX: number, nextX: number): boolean {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return false
  const m = charH * 0.35
  const slant = (c: Comp) => {
    const H = c.y1 - c.y0, q = Math.max(1, Math.round(H / 4))
    const mid = (y0: number, y1: number) => { let n = 0, sx = 0; for (let y = y0; y < y1; y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) { n++; sx += x } return n ? sx / n : 0 }
    return (mid(c.y0, c.y0 + q) - mid(c.y1 - q, c.y1)) / H
  }
  // 이웃 글자 조각(곧은 획)도 범위에 들 수 있어 기운 가는 성분만 센다
  const bars = comps.filter(c => c.y1 - c.y0 >= m && (c.x0 + c.x1) / 2 > prevX + m && (c.x0 + c.x1) / 2 < nextX - m && c.x1 - c.x0 <= (c.y1 - c.y0) * 0.5 && Math.abs(slant(c)) >= 0.12)
  if (bars.length !== 2) return false
  const [a, b] = bars, ha = a.y1 - a.y0, hb = b.y1 - b.y0
  // 가는 획 끝은 문턱에 따라 몇 px 잘린다(17·13px) — 높이 차 35% 까지
  return Math.sign(slant(a)) === Math.sign(slant(b)) && Math.abs(ha - hb) <= Math.max(ha, hb) * 0.35 && Math.abs((a.x0 + a.x1) - (b.x0 + b.x1)) / 2 <= Math.max(ha, hb)
}

/**
 * 로마 숫자 세로 획 수 — 사전에 Ⅰ~Ⅲ 가 있어도 모델은 한 글리프 Ⅲ 을 "II"·"I" 로, Ⅱ 를 "I" 로 줄여 읽는다(코퍼스 장 제목·목차).
 * 앞뒤 글자의 CTC 자리(prevX·nextX, 박스 로컬) 사이에 중심이 든 키 큰 성분(글자 높이 60% 이상)의 가운데 절반 줄에서 잉크 토막을 센다 —
 * CTC 자리는 글리프 한쪽에 치우치기도 해 가운데 금이 아니라 이웃 글자 자리에서 글자 높이 0.35배 떨어진 곳까지 본다.
 * 세리프 Ⅲ 은 위아래 가로대로 이어진 한 성분이어도 가운데 줄은 세 토막이다. 줄의 70% 이상이 같은 수이고 토막이 가늘 때(세로 획)만 낸다
 */
export function romanStems(gray: Uint8Array, w: number, h: number, ink: InkStats, prevX: number, nextX: number, prevHangul = false): number | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return null
  const x0 = prevX + charH * 0.35, x1 = nextX - charH * 0.35
  // 앞 글자가 한글이면 그 중심에서 글자 높이 0.75배 안에서 시작하는 성분은 그 글자 것 — ㅏ 세로획을 획으로 더 셌다("통장Ⅰ" → "통장Ⅱ",
  // 괴산 예산서). 로마 숫자 획은 1.2배 넘게 떨어진다
  const sel = comps.filter(c => c.y1 - c.y0 >= charH * 0.6 && (c.x0 + c.x1) / 2 >= x0 && (c.x0 + c.x1) / 2 < x1 && !(prevHangul && c.x0 < prevX + charH * 0.75))
  if (!sel.length) return null
  const ids = new Set(sel.map(c => c.id))
  const ux0 = Math.min(...sel.map(c => c.x0)), ux1 = Math.max(...sel.map(c => c.x1))
  const uy0 = Math.min(...sel.map(c => c.y0)), uy1 = Math.max(...sel.map(c => c.y1))
  const uh = uy1 - uy0
  const counts = new Map<number, number>()
  let rows = 0
  for (let y = uy0 + Math.floor(uh * 0.25); y < uy1 - Math.floor(uh * 0.25); y++) {
    let runs = 0, len = 0, thick = false
    for (let x = ux0; x <= ux1; x++) {
      const on = x < ux1 && ids.has(label[y * w + x])
      if (on) len++
      else if (len) { runs++; if (len > uh * 0.35) thick = true; len = 0 }
    }
    rows++
    if (!thick) counts.set(runs, (counts.get(runs) ?? 0) + 1)
  }
  const [n, k] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [0, 0]
  return n >= 1 && n <= 3 && k >= rows * 0.7 ? n : null
}

/**
 * 원문자 숫자 — 사전에 ①~⑨ 가 있어도 모델은 고리를 버리고 숫자만 읽는다(항 번호 "① 문서는 …" → "1문서는").
 * xs(박스 로컬 — 숫자 글자의 CTC 자리)마다 그 자리를 품는 둥근 고리 성분(글자 높이 55% 이상, 가로세로 0.8~1.25배)이 키 35% 이상
 * 성분(숫자)을 안에 두면 원문자다. 괄호 숫자 "(1)"·네모 칸은 고리가 아니라 걸리지 않는다
 */
export function circledAt(gray: Uint8Array, w: number, h: number, ink: InkStats, xs: number[]): boolean[] {
  const rings = ringBoxes(gray, w, h, ink)
  return xs.map(x => rings.some(r => x >= r.x0 && x <= r.x1))
}

/** 원문자 고리 상자(박스 로컬) — 둥근 고리 성분이 안에 글자 성분을 둔 것(circledAt 의 판정). 안쪽 x0·x1·y0·y1 은 고리 속 글자 성분을 감싼다 */
export function ringBoxes(gray: Uint8Array, w: number, h: number, ink: InkStats): Array<{ x0: number; x1: number; y0: number; y1: number; inner: { x0: number; x1: number; y0: number; y1: number }; jamo: string | null }> {
  const strict = ringsAt(gray, w, h, ink)
  // 잉크 문턱을 배경 쪽으로 절반 늦춰 한 번 더 — 원문자 고리는 1px 옅은 선이라 Otsu 문턱에서 군데군데 끊겨 한 성분이 안 됐다(수능
  // "㉡그러나"). 늦춘 문턱은 고리와 이웃 괄호를 한 성분으로 붙이기도 해("(Ⅰ-3-②)" → "-3-2)") 제 문턱이 못 찾은 자리만 보탠다
  const loose = ringsAt(gray, w, h, { ...ink, threshold: ink.darkInk ? ink.threshold + (255 - ink.threshold) / 2 : ink.threshold / 2 })
  return [...strict, ...loose.filter(r => !strict.some(s => r.x0 < s.x1 && s.x0 < r.x1))]
}

function ringsAt(gray: Uint8Array, w: number, h: number, ink: InkStats): Array<{ x0: number; x1: number; y0: number; y1: number; inner: { x0: number; x1: number; y0: number; y1: number }; jamo: string | null }> {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  // 고리 폭은 위·아래 30% 띠의 잉크 폭 — 앞 붙임표가 고리 옆구리에 붙으면 한 성분이 돼 외곽이 옆으로 늘었다("-3-①)" → "-3-1)", 농진청 목차)
  const arcX = (r: Comp): [number, number] => {
    const band = Math.max(1, Math.round((r.y1 - r.y0) * 0.3))
    let a = Infinity, b = -Infinity
    for (let y = r.y0; y < r.y1; y++) {
      if (y >= r.y0 + band && y < r.y1 - band) continue
      for (let x = r.x0; x < r.x1; x++) if (label[y * w + x] === r.id) { if (x < a) a = x; if (x > b) b = x }
    }
    return a <= b ? [a, b + 1] : [r.x0, r.x1]
  }
  return charH < 10 ? [] : comps.flatMap(r => {
    const rh = r.y1 - r.y0
    if (rh < charH * 0.55) return []
    const [x0, x1] = arcX(r), rw = x1 - x0
    if (rw < rh * 0.8 || rw > rh * 1.25) return []
    const inside = comps.filter(d => d !== r && d.x0 > x0 && d.x1 < x1 && d.y0 > r.y0 && d.y1 < r.y1)
    if (!inside.some(d => d.y1 - d.y0 >= rh * 0.35)) return []
    const inner = { x0: Math.min(...inside.map(d => d.x0)), x1: Math.max(...inside.map(d => d.x1)), y0: Math.min(...inside.map(d => d.y0)), y1: Math.max(...inside.map(d => d.y1)) }
    const ids = new Set(inside.map(d => d.id))
    return [{ x0, x1, y0: r.y0, y1: r.y1, inner, jamo: ringJamo(label, w, inner, ids) }]
  })
}

/**
 * 고리 속 홀자모 ㄱ~ㅁ 을 획 자리로 — 모델은 고리 속 홀자모를 음절("그")·네모("□")로 읽는다. 속 글자 상자의 위·가운데·아래 가로 띠와
 * 왼쪽·오른쪽 세로 띠마다 잉크가 덮는 비율(띠 안 줄·열 중 가장 많이 덮은 것)로 가른다: ㄱ 위·오른쪽, ㄴ 왼쪽·아래, ㄷ 위·왼쪽·아래,
 * ㄹ 위·가운데·아래(세로 변은 반만), ㅁ 네 변. 어느 꼴에도 안 맞으면 null
 */
function ringJamo(label: Int32Array, w: number, b: { x0: number; x1: number; y0: number; y1: number }, ids: Set<number>): string | null {
  const W = b.x1 - b.x0, H = b.y1 - b.y0
  if (W < 4 || H < 4) return null
  const on = (x: number, y: number) => ids.has(label[y * w + x])
  const row = (y: number) => { let n = 0; for (let x = b.x0; x < b.x1; x++) if (on(x, y)) n++; return n / W }
  const col = (x: number) => { let n = 0; for (let y = b.y0; y < b.y1; y++) if (on(x, y)) n++; return n / H }
  const band = (f: (v: number) => number, a: number, z: number) => { let m = 0; for (let v = Math.floor(a); v < Math.ceil(z); v++) m = Math.max(m, f(v)); return m }
  const top = band(row, b.y0, b.y0 + H * 0.25), bot = band(row, b.y1 - H * 0.25, b.y1), mid = band(row, b.y0 + H * 0.35, b.y1 - H * 0.35)
  const left = band(col, b.x0, b.x0 + W * 0.25), right = band(col, b.x1 - W * 0.25, b.x1)
  const S = 0.75, Wk = 0.45
  if (top >= S && bot >= S && left >= S && right >= S && mid < Wk) return "ㅁ"
  if (top >= S && mid >= S && bot >= S && left < S && right < S) return "ㄹ"
  if (top >= S && bot >= S && left >= S && right < Wk) return "ㄷ"
  if (top >= S && right >= S && bot < Wk && left < Wk) return "ㄱ"
  if (left >= S && bot >= S && top < Wk && right < Wk) return "ㄴ"
  return null
}

/**
 * 따옴표 머리 위치 — 모델은 ‘ ’ 를 곧은 ' 로 읽어 방향은 문맥(smartQuotes)이 정하는데, 연도 앞 "‘24년"·"’24년" 은 문서마다
 * 섞여 문맥으로 못 가른다. cx(박스 로컬 — 따옴표 글자의 CTC 자리)에 가장 가까운 작은 성분(글자 높이 12~50%, 글줄 위쪽 절반)의
 * 잉크 무게중심 높이를 성분 높이 비로 낸다 — 둥근 머리가 아래인 ‘(6 꼴)는 크고 위인 ’(9 꼴)는 작다
 */
export function quoteHead(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): number | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return null
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  if (!tall.length) return null
  const mid = (Math.min(...tall.map(c => c.y0)) + Math.max(...tall.map(c => c.y1))) / 2
  let best: Comp | null = null, bestD = charH * 0.4
  for (const c of comps) {
    const ch = c.y1 - c.y0, d = Math.abs((c.x0 + c.x1) / 2 - cx)
    if (ch < charH * 0.12 || ch > charH * 0.5 || (c.y0 + c.y1) / 2 > mid || d > bestD) continue
    bestD = d; best = c
  }
  if (!best) return null
  let n = 0, sy = 0
  for (let y = best.y0; y < best.y1; y++) for (let x = best.x0; x < best.x1; x++) if (label[y * w + x] === best.id) { n++; sy += y }
  return n ? (sy / n - best.y0) / (best.y1 - best.y0) : null
}

/**
 * 한 줄 박스 위아래 끝에 걸린 이웃 줄 글자 끝자락 — 줄 간격이 좁은 칸(조직도 상자 "노동 / 시장 / 정책관")은 검출 박스가 위아래 줄
 * 글자 끝을 물어, 인식기가 그 조각을 받침으로 읽었다("노동" → "논동"·"시장" → "싫장"·"근로" → "근록", web068). 박스 끝 행(1px 안)에
 * 닿은 잉크 띠가 빈 행으로 글줄과 떨어져 있고 가장 높은 띠의 45% 미만이면, 그 띠와 다음 띠 사이 빈 행 가운데까지 잘라낸 세로 구간을
 * 낸다(높이 24px 이상, 남는 띠가 글자 두 자 이상인 글줄일 때만). 괘선(행·열 85% 이상 잉크)은 splitRowBands 처럼 빼고 본다. 좌우 끝 20% 안의 세로 테두리(상자 테두리 — 인식기가 "|"·"["·"(" 로
 * 읽었다)도 그 바깥에 글 잉크가 없으면 괘선 안쪽으로 잘라낸다. 걸린 것이 없으면 null
 */
export function edgeTrim(gray: Uint8Array, w: number, h: number, ink: InkStats): { x0: number; x1: number; y0: number; y1: number } | null {
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  const colInk = new Uint32Array(w)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (isInk(gray[y * w + x])) colInk[x]++
  const ruleCol = new Uint8Array(w)
  let liveW = 0
  for (let x = 0; x < w; x++) { if (colInk[x] >= h * 0.85) ruleCol[x] = 1; else liveW++ }
  const blank = Math.max(1, Math.floor(w * 0.02))
  const bands: Array<[number, number]> = []
  let start = -1
  for (let y = 0; y <= h; y++) {
    let n = 0
    if (y < h) for (let x = 0; x < w; x++) if (!ruleCol[x] && isInk(gray[y * w + x])) n++
    const on = y < h && n > blank && n < liveW * 0.85
    if (on && start < 0) start = y
    else if (!on && start >= 0) { bands.push([start, y]); start = -1 }
  }
  let y0 = 0, y1 = h
  if (bands.length >= 2 && h >= 24) {
    const mh = Math.max(...bands.map(([a, b]) => b - a))
    const [top, next] = [bands[0], bands[1]], [bot, prev] = [bands[bands.length - 1], bands[bands.length - 2]]
    if (top[0] <= 1 && top[1] - top[0] < mh * 0.45) y0 = (top[1] + next[0]) >> 1
    if (bot[1] >= h - 1 && bot[1] - bot[0] < mh * 0.45) y1 = (bot[0] + prev[1] + 1) >> 1
    // 남는 띠가 글줄이어야 한다 — 글자 크기(띠 높이 30% 이상 폭) 잉크 열 토막이 둘 이상. 아이콘("Q" 로 읽힌 돋보기)·큰 장 번호 한 자
    // (옅은 "6" 의 끊긴 윗곡선이 조각으로 잘렸다)는 그대로 둔다
    if (y0 > 0 || y1 < h) {
      let runs = 0, len = 0
      for (let x = 0; x <= w; x++) {
        let on = false
        if (x < w && !ruleCol[x]) for (let y = y0; y < y1 && !on; y++) on = isInk(gray[y * w + x])
        if (on) len++
        else { if (len >= (y1 - y0) * 0.3) runs++; len = 0 }
      }
      if (runs < 2) { y0 = 0; y1 = h }
    }
  }
  // 좌우 끝 세로 괘선 — 박스 높이 95% 이상을 관통하는 열이고, 그 바깥 열엔 잉크가 없고, 안쪽으로 빈 열 틈(높이 10%, 2px 이상)을
  // 두고 글이 시작해야 한다. 큰 제목 글자의 세로 줄기("D")도 박스 높이 85% 를 넘어 테두리로 잘렸다(ODL 073 "Defensoria" → "ria")
  // 박스 위아래 끝에 걸친 가로 괘선 행(폭의 85% 넘게 잉크)은 글로 보지 않는다 — 그 행 때문에 모든 열이 글 열이 돼 테두리를 찾기 전에
  // 멈췄다(통계표 칸 상자 윗변)
  const ruleRow = new Uint8Array(h)
  for (let y = 0; y < h; y++) { let n = 0; for (let x = 0; x < w; x++) if (isInk(gray[y * w + x])) n++; if (n >= w * 0.85) ruleRow[y] = 1 }
  const textCol = (x: number) => { for (let y = y0; y < y1; y++) if (!ruleRow[y] && isInk(gray[y * w + x])) return true; return false }
  // 점선 세로선도 테두리다 — 맨 위·맨 아래 10% 에 잉크가 닿고 빈 토막이 높이 15% 이하로 촘촘한 열(잉크 35% 이상). 글자 획은 박스
  // 위아래 여백에 못 닿는다(통계표 점선 칸 사이 "60.5" → "(.5")
  const dotted = (x: number) => {
    if (colInk[x] < h * 0.35) return false
    let first = -1, last = -1, run = 0, maxRun = 0
    for (let y = 0; y < h; y++) {
      if (isInk(gray[y * w + x])) { if (first < 0) first = y; last = y; maxRun = Math.max(maxRun, first === y ? 0 : run); run = 0 } else run++
    }
    return first <= h * 0.1 && last >= h * 0.9 && maxRun <= h * 0.15
  }
  const border = (x: number) => colInk[x] >= h * 0.95 || dotted(x)
  const gap = Math.max(2, Math.round(h * 0.1))
  const clearFrom = (x: number, dir: 1 | -1) => { for (let k = 0; k < gap; k++) { const c = x + dir * k; if (c < 0 || c >= w || textCol(c)) return false } return true }
  // 겹선(‖) — 테두리 바로 안쪽(빈 틈 gap 안)에 또 테두리가 서면 둘을 한 테두리로 본다(통계표 머리 열 겹선 옆 "0:36" → ":36")
  const runEnd = (x: number, dir: 1 | -1) => {
    let e = x
    for (;;) {
      while (e + dir >= 0 && e + dir < w && border(e + dir)) e += dir
      let k = 1
      while (k <= gap && e + dir * k >= 0 && e + dir * k < w && !border(e + dir * k) && !textCol(e + dir * k)) k++
      if (k <= gap && e + dir * k >= 0 && e + dir * k < w && border(e + dir * k)) e += dir * k
      else return e
    }
  }
  let x0 = 0, x1 = w
  // 글이 먼저 나와도 끝 20% 안에 높이를 꽉 채운 실선이 있으면 그 너머는 이웃 칸 글자 끝자락이다(검출 박스가 칸 괘선을 넘어 옆 칸
  // "73.1" 의 끝을 물어 "60.5" 가 "(.5" 로 읽혔다) — 실선이고 안쪽 틈이 비었을 때만
  const solidAt = (from: number, to: number, dir: 1 | -1) => { for (let x = from; dir > 0 ? x < to : x >= to; x += dir) if (colInk[x] >= h * 0.95) return x; return -1 }
  for (let x = 0; x < w * 0.2; x++) {
    if (border(x)) { const e = runEnd(x, 1); if (clearFrom(e + 1, 1)) x0 = e + 1; break }
    if (textCol(x)) { const s = solidAt(x + 1, Math.floor(w * 0.2), 1); if (s >= 0) { const e = runEnd(s, 1); if (clearFrom(e + 1, 1)) x0 = e + 1 } break }
  }
  for (let x = w - 1; x >= w * 0.8; x--) {
    if (border(x)) { const e = runEnd(x, -1); if (clearFrom(e - 1, -1)) x1 = e; break }
    if (textCol(x)) { const s = solidAt(x - 1, Math.ceil(w * 0.8), -1); if (s >= 0) { const e = runEnd(s, -1); if (clearFrom(e - 1, -1)) x1 = e } break }
  }
  return y0 > 0 || y1 < h || x0 > 0 || x1 < w ? { x0, x1, y0, y1 } : null
}

/** 키 큰 잉크 덩어리 수 — 글자 높이 절반 이상 성분을 x 가 겹치는 것끼리 묶어 센다(한 글자 = 한 덩어리, 점·쉼표는 안 셈) */
export function tallInkCount(gray: Uint8Array, w: number, h: number, ink: InkStats): number {
  const { comps } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.5).sort((a, b) => a.x0 - b.x0)
  let n = 0, end = -1
  for (const c of tall) { if (c.x0 >= end) n++; end = Math.max(end, c.x1) }
  return n
}

/**
 * 두 글자 사이에서 통째로 빠진 기호 — 인식기가 사전에 없거나(「」) 드물게 배운 기호(▲ □ · . 。)를 글자 자리 없이 건너뛴다. 글줄 띠(키 큰
 * 성분 위아래)와 x 가 겹치는 다른 성분이 없는(빈 열로 떨어진) 조각만 모양으로 가른다:
 *   · 가운데 높이(띠 30~70%)의 작은 둥근 점(띠 높이 8%·3px 이상 25% 이하, 채움 60% 이상 — 1px 잡티는 빼고), 아래쪽(75% 아래)이면 .
 *     2px 까지 작은 점은 "·\u0001" — 모델이 공백으로 읽은 자리에서만 쓴다
 *   。 아래쪽(60% 아래) 작은 고리(띠 높이 40% 이하, 가운데 줄 두 토막)
 *   ▲ 띠 높이 50% 이상·가로세로 0.9~1.4배, 위로 갈수록 좁아지고 줄마다 한 토막인 속 찬 삼각형
 *   「 」 띠 높이 30~65%, 위(「)·아래(」)에 붙어 그 변이 폭 70% 넘게 차고 반대쪽 변은 절반 이하, 줄기가 왼쪽(「)·오른쪽(」)
 *   / 띠 높이 60% 이상의 가는 사선(분수 칸 "7/5" — 모델이 숫자 사이 빗금을 빠뜨림)
 *   - 가운데 높이의 짧은 가로 막대(쪽번호 꼬리말 "- 1 -" 의 앞 막대 — 줄 머리에서만 쓴다)
 *   □ 띠 높이 60~92%·가로세로 0.8~1.25배, 위아래 변이 폭 80% 넘게 차고 가운데 줄은 양끝 두 획. 줄에서 가장 큰 조각이면(글 없이 정사각만
 *     늘어선 칸 "□□-□□□") "□\0" — 새로 넣지는 않고 0·O 로 읽힌 자리만 바꾼다(제목 앞 도형 네모와 섞이지 않게)
 * 칸 경계 세로선(띠 높이 90% 이상·가는 열)은 뺀다. 반환은 박스 로컬 x 구간과 기호, 글줄 띠 높이
 */
export function gapGlyphs(gray: Uint8Array, w: number, h: number, ink: InkStats): { glyphs: Array<{ x0: number; x1: number; mark: string }>; bandH: number } {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return { glyphs: [], bandH: 0 }
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  const bandT = Math.min(...tall.map(c => c.y0)), bandB = Math.max(...tall.map(c => c.y1)), bh = bandB - bandT
  const inBand = (c: Comp) => c.y1 > bandT && c.y0 < bandB
  const out: Array<{ x0: number; x1: number; mark: string }> = []
  for (const c of comps) {
    if (!inBand(c)) continue
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0
    if (ch >= bh * 0.9 && cw <= bh * 0.15) continue
    // 빈 열로 떨어진 조각 — 안에 든 성분(□ 속 잡티)은 괜찮다
    const others = comps.filter(o => o !== c && inBand(o) && !(o.x0 >= c.x0 && o.x1 <= c.x1 && o.y0 >= c.y0 && o.y1 <= c.y1))
    const apart = !others.some(o => o.x0 < c.x1 + 1 && o.x1 > c.x0 - 1)
    // 홑낫표는 다음 글자와 빈 열 없이 맞닿기도 한다(촘촘한 글꼴 "현행「공직선거법」,「정치자금법」" 의 둘째 「 — 「 끝 열 = 정 첫 열).
    // x 가 겹치지만 않으면 괄호 모양만 본다
    const abut = !apart && ch >= bh * 0.3 && ch <= bh * 0.65 && !others.some(o => o.x0 < c.x1 && o.x1 > c.x0)
    // 빗금은 이웃 숫자와 x 가 2px 까지 겹쳐도 된다(사선이라 촘촘히 짠 "7/5" 에서 양옆 숫자 밑·위로 들어간다)
    const nearlyApart = !others.some(o => Math.min(o.x1, c.x1) - Math.max(o.x0, c.x0) > 2)
    const spans: number[] = [], runs: number[] = []
    let n = 0
    for (let y = c.y0; y < c.y1; y++) {
      let s = 0, r = 0, prev = false
      for (let x = c.x0; x < c.x1; x++) { const on = label[y * w + x] === c.id; if (on) { s++; if (!prev) r++ } prev = on }
      spans.push(s); runs.push(r); n += s
    }
    const fill = n / (cw * ch), cy = ((c.y0 + c.y1) / 2 - bandT) / bh
    const band = Math.max(1, Math.round(ch * 0.15))
    const top = Math.max(...spans.slice(0, band)) / cw, bottom = Math.max(...spans.slice(ch - band)) / cw
    let mark: string | null = null
    const speck = Math.max(3, bh * 0.08)
    const dot = ch <= bh * 0.25 && cw <= bh * 0.25 && ch >= speck && cw >= speck && cw >= ch * 0.6 && cw <= ch * 1.6
    // 이웃 글자와 x 가 겹치거나(촘촘한 글꼴 "개발·보급") 2px 까지 작은 둥근 점은 공백 자리 대체용으로만 — 한글 자모엔 떨어진 둥근 점이 없다
    const small = ch <= bh * 0.25 && cw <= bh * 0.25 && ch >= 2 && cw >= 2 && cw >= ch * 0.6 && cw <= ch * 1.6 && fill >= 0.6 && cy >= 0.3 && cy <= 0.7
    // 아래쪽 점은 이웃과 x 가 겹치지만 않으면(빈 열 없이 맞닿음) 본다 — 날짜 끝 마침표 뒤에 쉼표가 붙은 "2013.3.23.,2014.11.19." 의 "." (교육청 공문서 지침)
    // 작은 점의 위·아래 행 잉크 중심 차가 반 칸 안 — 마침표는 대칭, 쉼표는 꼬리가 치우친다
    const rowMid = (y: number) => { let sx = 0, k = 0; for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) { sx += x; k++ } return k ? sx / k : NaN }
    // 위·아래 반쪽 잉크 양도 비슷해야 — 3×4 작은 쉼표는 꼬리 쪽 아래 반쪽이 가늘다(교사추천서, → .)
    const half = Math.floor(ch / 2), topInk = spans.slice(0, half).reduce((a, b) => a + b, 0), botInk = spans.slice(ch - half).reduce((a, b) => a + b, 0)
    const upright = () => Math.abs(rowMid(c.y0) - rowMid(c.y1 - 1)) <= 0.5 && topInk <= botInk * 1.25 && botInk <= topInk * 1.25
    const flushDot = !apart && dot && fill >= 0.6 && cy >= 0.75 && (cw >= ch * 0.8 || (ch - cw <= 1 && upright())) && !others.some(o => o.x0 < c.x1 && o.x1 > c.x0)
    if (!apart && !abut && !flushDot && !(nearlyApart && ch >= bh * 0.6)) { if (small) out.push({ x0: c.x0, x1: c.x1, mark: "\u00b7\u0001" }); continue }
    // 줄기 쪽 — 가로 변을 뺀 줄의 잉크 x 평균(폭 비). 「 는 왼쪽, 」 는 오른쪽 (한글 ㄱ·ㄴ 은 반대쪽이라 걸리지 않는다)
    const bracket = (): string | null => {
      const stem = (from: number, to: number) => {
        let sx = 0, k = 0
        for (let y = from; y < to; y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) { sx += x - c.x0; k++ }
        return k ? sx / k / cw : 0.5
      }
      // 띠 위·아래 끝에서 20% 안 — 반각 홑낫표(｢ ｣, 교육청 공문서 지침)는 전각보다 0.5px 남짓 안쪽에 앉는다(15% 에서 놓쳤다)
      if (c.y0 <= bandT + bh * 0.2 && top >= 0.7 && bottom <= 0.5 && stem(c.y0 + band, c.y1) <= 0.35) return "\u300c"
      if (c.y1 >= bandB - bh * 0.2 && bottom >= 0.7 && top <= 0.5 && stem(c.y0, c.y1 - band) >= 0.65) return "\u300d"
      return null
    }
    if (flushDot) mark = "."
    else if (!apart && !abut) { /* 빗금 후보만 아래에서 */ } else if (abut) { if (fill < 0.5) mark = bracket() } else if (dot && fill >= 0.6 && cy >= 0.3 && cy <= 0.7) mark = "\u00b7"
    else if (small) mark = "\u00b7\u0001"
    // 꼬리 달린 쉼표(세로로 긴 점)는 빼고 — 픽셀 반올림으로 1px 길어진 작은 마침표(3×4, 국회 회의록 "…하겠읍니다.")는 위·아래 행 잉크
    // 중심이 같을 때만 마침표(작은 쉼표는 꼬리 쪽 아래 행이 왼쪽으로 치우친다)
    else if (dot && fill >= 0.6 && cy >= 0.75 && (cw >= ch * 0.8 || (ch - cw <= 1 && upright()))) mark = "."
    else if (ch <= bh * 0.4 && ch >= speck && cw >= ch * 0.75 && cw <= ch * 1.3 && fill < 0.6 && runs[ch >> 1] === 2 && cy >= 0.6) mark = "\u3002"
    else if (ch <= bh * 0.15 && cw >= ch * 2 && cw <= bh * 0.8 && fill >= 0.7 && cy >= 0.35 && cy <= 0.75) mark = "-"
    else if (ch >= bh * 0.5 && cw >= ch * 0.9 && cw <= ch * 1.4 && fill >= 0.4 && runs.every(r => r <= 1)
      && top <= 0.4 && bottom >= 0.8) mark = "\u25b2"
    else if (ch >= bh * 0.3 && ch <= bh * 0.65 && fill < 0.5) mark = bracket()
    else if (ch >= charH * 0.6 && cw >= ch * 0.8 && cw <= ch * 1.25 && fill < 0.5 && top >= 0.8 && bottom >= 0.8
      && runs[ch >> 1] === 2) mark = ch <= charH * 0.92 ? "\u25a1" : "\u25a1\u0000"
    // 빗금 / — 띠 높이 60% 이상의 가는 사선(폭이 높이의 0.25~0.7배, 줄마다 한 토막, 위쪽이 오른쪽으로 폭의 절반 넘게 치우침)
    if (!mark && ch >= bh * 0.6 && cw >= ch * 0.25 && cw <= ch * 0.7 && fill <= 0.4 && runs.every(r => r <= 1)) {
      const mx = (y: number) => { let sx = 0, k = 0; for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) { sx += x; k++ } return k ? sx / k : NaN }
      if (mx(c.y0 + band) - mx(c.y1 - 1 - band) >= cw * 0.5) mark = "/"
    }
    if (mark) out.push({ x0: c.x0, x1: c.x1, mark })
  }
  return { glyphs: out, bandH: bh }
}

/**
 * 줄 머리 고리 글머리 ○ / ㅇ — 모델은 같은 글리프를 "O"·"ㅇ" 로 오락가락 읽는다(장흥 계획 ○ 27개 중 9개가 ㅇ). cx(첫 글자의 CTC 자리)에
 * 가장 가까운 키 30% 이상 성분이 고리(가로세로 0.85~1.2배, 가운데 가로·세로줄 모두 두 토막)면 크기·채움으로 가른다 — 도형 ○ 는 글줄 띠
 * 높이의 0.65~1.0배에 획이 가늘고(폭의 10% 이하, 채움 0.23 이하 — 그림자 진 고리는 가는 쪽 획 8% 이하·채움 0.33 이하), 자모 ㅇ 은
 * 0.47~0.56배에 채움 0.24 이상(코퍼스 9문서 실측), 라틴 o 는 0.6~0.8배로 줄 아래쪽에 앉는다
 */
export function ringBullet(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): "\u25cb" | "\u3147" | "o" | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return null
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  const bandT = Math.min(...tall.map(c => c.y0)), bh = Math.max(...tall.map(c => c.y1)) - bandT
  let best: Comp | null = null, bestD = bh * 0.6
  for (const c of comps) {
    const d = Math.abs((c.x0 + c.x1) / 2 - cx)
    if (c.y1 - c.y0 >= bh * 0.3 && d < bestD) { bestD = d; best = c }
  }
  if (!best) return null
  const c = best, cw = c.x1 - c.x0, ch = c.y1 - c.y0
  if (cw < ch * 0.85 || cw > ch * 1.2) return null
  const runs = (xs: number[], at: (k: number) => boolean) => {
    let n = 0, len = 0, mx = 0, mn = Infinity
    for (const k of [...xs, -1]) { if (k >= 0 && at(k)) { if (!len) n++; len++; mx = Math.max(mx, len) } else { if (len) mn = Math.min(mn, len); len = 0 } }
    return { n, mx, mn }
  }
  const my = (c.y0 + c.y1) >> 1, mx = (c.x0 + c.x1) >> 1
  const row = runs(Array.from({ length: cw }, (_, k) => c.x0 + k), x => label[my * w + x] === c.id)
  const col = runs(Array.from({ length: ch }, (_, k) => c.y0 + k), y => label[y * w + mx] === c.id)
  if (row.n !== 2 || col.n !== 2) return null
  let n = 0
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) n++
  const fill = n / (cw * ch), rel = ch / bh
  // 그림자 진 고리(한쪽 획만 두꺼움 — ❍, 글꼴에 따라 ○ 도 이렇게 그려진다)도 가는 쪽 획이 가늘면 도형 ○. 기울기 보정·흐림으로 가는 쪽이
  // 1px 번지면(2 → 3px, 폭 8% 초과) 두꺼운 쪽과의 차(1.5배 이상)로 본다 — 글자 O·o 는 좌우 획이 고르다(농진청 계획 1° 판 ❍ → o)
  if (rel >= 0.62 && (fill <= 0.23 ? row.mx <= cw * 0.1 : fill <= 0.33 && (row.mn <= cw * 0.08 || row.mn * 1.5 <= row.mx))) return "\u25cb"
  if (rel <= 0.58 && fill >= 0.24) return "\u3147"
  // 라틴 소문자 o — x 높이(띠 0.6~0.8배)로 줄 아래쪽에 앉은 굵은 고리(속초 예산서 "o 기본급", 모델은 숫자 0 으로 읽음). 숫자 0 은 세로로 길고
  // (폭/높이 0.58) 자모 ㅇ 은 띠 가운데(0.41~0.51)에 뜬다
  if (rel >= 0.6 && rel <= 0.8 && fill >= 0.3 && ((c.y0 + c.y1) / 2 - bandT) / bh >= 0.55) return "o"
  return null
}

/**
 * cx 자리 대시 획 길이 / 글줄 띠 높이 — 모델은 같은 붙임표를 "-"·"–"·"—" 로 오락가락 읽는다(KAIST 영재 공고 "-(조건 1)" 이
 * "—(조건 1)", 전화 "042-350" 이 "042–350"). 붙임표는 띠의 0.30~0.55배, 긴 줄표 ― 는 0.85배(부천 예산서). cx 에 가장 가까운 납작한
 * 성분(높이가 띠의 25% 이하, 폭이 높이의 2배 이상)으로 잰다. 글줄 띠를 잴 글자가 없으면 null
 */
export function dashRatio(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): number | null {
  const { comps } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return null
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  const bh = Math.max(...tall.map(c => c.y1)) - Math.min(...tall.map(c => c.y0))
  const dash = comps
    .filter(c => c.y1 - c.y0 <= bh * 0.25 && c.x1 - c.x0 >= (c.y1 - c.y0) * 2 && Math.abs((c.x0 + c.x1) / 2 - cx) <= bh * 0.6)
    .sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - cx) - Math.abs((b.x0 + b.x1) / 2 - cx))[0]
  return dash ? (dash.x1 - dash.x0) / bh : null
}

/**
 * 인식에서 통째로 빠진 줄 머리 도형 ○ — 첫 글자 CTC 자리(firstX)가 상자 높이 0.8배 넘게 뒤에 있고(맨 앞 조각을 아무 글자도 덮지
 * 않음) 맨 왼쪽 잉크 조각이 도형 ○(ringBullet)면 참(금천 예산서 차례 "○ 감사담당관 … 155"). 자모 ㅇ·라틴 o 로 보이는 조각은 첫
 * 글자의 일부일 수 있어 거짓
 */
export function leadingRing(gray: Uint8Array, w: number, h: number, ink: InkStats, firstX: number): boolean {
  if (firstX < h * 0.8) return false
  const isInk = (v: number) => (ink.darkInk ? v <= ink.threshold : v > ink.threshold)
  let left = -1
  for (let x = 0; x < w && left < 0; x++) for (let y = 0; y < h; y++) if (isInk(gray[y * w + x])) { left = x; break }
  if (left < 0 || ringBullet(gray, w, h, ink, left + h * 0.25) !== "\u25cb") return false
  // 속 빈 네모(□·▣)도 가운데 줄이 두 토막이라 고리로 잡힌다 — 맨 앞 조각의 네 귀퉁이에 잉크가 있으면 네모다(함평 계획 "□ 국내외 여건",
  // 선거 사례집 "▣ 선거별 법정 일자")
  const colInk = (x: number) => { for (let y = 0; y < h; y++) if (isInk(gray[y * w + x])) return true; return false }
  let right = left
  while (right + 1 < w && colInk(right + 1)) right++
  let top = h, bottom = -1
  for (let y = 0; y < h; y++) for (let x = left; x <= right; x++) if (isInk(gray[y * w + x])) { top = Math.min(top, y); bottom = Math.max(bottom, y); break }
  const cw = right - left + 1, ch = bottom - top + 1, kx = Math.max(1, Math.round(cw * 0.1)), ky = Math.max(1, Math.round(ch * 0.1))
  const corner = (x0: number, y0: number) => { for (let y = y0; y < y0 + ky; y++) for (let x = x0; x < x0 + kx; x++) if (isInk(gray[y * w + x])) return true; return false }
  return !corner(left, top) && !corner(right + 1 - kx, top) && !corner(left, bottom + 1 - ky) && !corner(right + 1 - kx, bottom + 1 - ky)
}

/** cx 자리 성분이 큰 속 찬 원(●)인가 — 글줄 띠 높이의 45~105%, 가로세로 0.8~1.25배, 채움 0.65~0.9. 가운뎃점은 크게 그려도 띠의 32% 안팎 */
export function discAt(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): boolean {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return false
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  const bh = Math.max(...tall.map(c => c.y1)) - Math.min(...tall.map(c => c.y0))
  const c = comps.filter(o => Math.abs((o.x0 + o.x1) / 2 - cx) <= bh * 0.4).sort((a, b) => Math.abs((a.x0 + a.x1) / 2 - cx) - Math.abs((b.x0 + b.x1) / 2 - cx))[0]
  if (!c) return false
  const cw = c.x1 - c.x0, ch = c.y1 - c.y0
  if (ch < bh * 0.45 || ch > bh * 1.05 || cw < ch * 0.8 || cw > ch * 1.25) return false
  let n = 0
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) n++
  const fill = n / (cw * ch)
  return fill >= 0.65 && fill <= 0.9
}

/**
 * 숫자 1 로 읽은 로마 숫자 Ⅰ — 세리프 Ⅰ 은 윗머리·아랫머리가 줄기 양쪽으로 고르게 뻗고, 숫자 1 은 윗머리가 왼쪽(깃)으로만 뻗는다
 * (코퍼스 실측: Ⅰ 좌우 0.8·0.8·1.3·1.3 줄기 폭, 숫자 1 오른쪽 0). cx 자리를 품는 가장 키 큰 성분의 위·아래 20% 줄 잉크 범위를
 * 가운데 줄(40~60%) 줄기와 견준다. 세리프 없는 막대는 가를 수 없어 false
 */
export function serifOne(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): boolean {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return false
  const c = comps.filter(o => o.x0 - 3 <= cx && o.x1 + 3 >= cx && o.y1 - o.y0 >= charH * 0.6).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0))[0]
  if (!c) return false
  const ch = c.y1 - c.y0
  const span = (a: number, b: number) => {
    let mn = Infinity, mx = -1
    for (let y = c.y0 + Math.floor(ch * a); y < c.y0 + Math.ceil(ch * b); y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) { mn = Math.min(mn, x); mx = Math.max(mx, x) }
    return [mn, mx]
  }
  const [m0, m1] = span(0.4, 0.6), [t0, t1] = span(0, 0.2), [b0, b1] = span(0.8, 1)
  const sw = m1 - m0 + 1
  const even = (l: number, r: number) => l >= sw * 0.4 && r >= sw * 0.4 && Math.abs(l - r) <= Math.max(l, r) * 0.35
  return sw >= 2 && sw <= ch * 0.3 && even(m0 - t0, t1 - m1) && even(m0 - b0, b1 - m1)
}

/**
 * 이어진 별표 수 — CTC 는 같은 글자가 붙어 나오면 하나로 합친다("등록증**" → "등록증*"). cx(별표 글자의 CTC 자리)에 가장 가까운 별표
 * 꼴 조각(글줄 띠 높이 20~50%, 가로세로 0.7~1.4배, 채움 0.25~0.65, 띠 위쪽 절반)에서 좌우로 틈이 조각 폭 이하인 같은 꼴 조각을 센다
 */
export function starRun(gray: Uint8Array, w: number, h: number, ink: InkStats, cx: number): number {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return 0
  const tall = comps.filter(c => c.y1 - c.y0 >= charH * 0.6)
  const bandT = Math.min(...tall.map(c => c.y0)), bh = Math.max(...tall.map(c => c.y1)) - bandT
  const star = (c: Comp) => {
    const cw = c.x1 - c.x0, ch = c.y1 - c.y0
    if (ch < bh * 0.2 || ch > bh * 0.5 || cw < ch * 0.7 || cw > ch * 1.4 || ((c.y0 + c.y1) / 2 - bandT) / bh > 0.55) return false
    let n = 0
    for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) if (label[y * w + x] === c.id) n++
    const fill = n / (cw * ch)
    return fill >= 0.25 && fill <= 0.65
  }
  const stars = comps.filter(star).sort((a, b) => a.x0 - b.x0)
  const k = stars.findIndex(c => cx >= c.x0 - (c.x1 - c.x0) && cx <= c.x1 + (c.x1 - c.x0))
  if (k < 0) return 0
  let lo = k, hi = k
  while (lo > 0 && stars[lo].x0 - stars[lo - 1].x1 <= stars[lo].x1 - stars[lo].x0) lo--
  while (hi + 1 < stars.length && stars[hi + 1].x0 - stars[hi].x1 <= stars[hi].x1 - stars[hi].x0) hi++
  return hi - lo + 1
}

/** 【】 로 볼 기울기 줄 비율 — 코퍼스 실측 [ ] 최대 0.13, 【】 최소 0.19 */
const BRACKET_TAPER = 0.16

/** 【】 로 볼 채움·폭 하한 — 【】 는 속이 찬 렌즈 꼴로 폭이 글자 높이의 0.28~0.44배·기울기 줄 0.24~0.65(코퍼스 실측), 모서리가 둥근
 *  소괄호 ( ) 는 기울기 줄이 있어도 좁고 적다(굵은 압축 글꼴 0.22~0.25배·0.17~0.25 — 방송통신위원회 보도자료·산림청 공고에서 모델이 [ ] 로 읽음) */
const BRACKET_SOLID = 0.4
const BRACKET_WIDE = 0.265
const BRACKET_LENS = 0.35

/** 괄호 모양 판별 — 모를 때 null (인식 결과 [ ] 를 둔다). 곧은 ㄱ·ㄴ 꼴은 「」, 휜 조각(기울기 줄)은 ( ), 넓고 속 빈 꺾인 조각은 〔〕 */
export function bracketShape(f: BracketFeatures, close: boolean): string | null {
  const [near, far] = close ? [f.bottom, f.top] : [f.top, f.bottom]
  const paren = close ? ")" : "("
  if (near >= 0.7 && far <= 0.5) return f.taper < BRACKET_TAPER ? (close ? "\u300d" : "\u300c") : paren
  if (near >= 0.7 && far >= 0.7 && f.taper >= BRACKET_TAPER) {
    // 거북등 괄호 〔〕 — 끝이 꺾인 가는 줄기라 속이 비고(채움 0.37~0.43) 폭이 높이의 0.35배 안팎으로 넓다. 소괄호는 0.22~0.25배,
    // 【】 는 속이 차 채움 0.65 이상(기록관리 지침 목차 "〔기록물생산자〕" 가 "(…】")
    if (f.fill < 0.45 && f.cw >= f.ch * 0.3 && f.taper < BRACKET_LENS) return close ? "\u3015" : "\u3014"
    return f.fill >= BRACKET_SOLID && (f.cw >= f.ch * BRACKET_WIDE || f.taper >= BRACKET_LENS) ? (close ? "\u3011" : "\u3010") : paren
  }
  return null
}


/**
 * 박스 맨 앞 글머리 기호 — 인식 사전에 없거나(◎ ▪) 모델이 작은 점으로 읽거나(● → •·) 통째로 빠뜨리는(□) 공문서 글머리를 잉크 조각 모양으로 가른다.
 * 맨 앞 덩어리(x 가 겹치는 성분 묶음)가 글자 높이 대비 크기·채움·겹침으로:
 *   ◎ 이중 원 — 성분 둘 이상이 안팎으로 겹치고 속이 빈 둥근 조각 (함평 계획 21개가 "O")
 *   ● 큰 속 찬 원 — 채움 0.65~0.88(원 π/4≈0.79), 글자 높이 0.45배 이상 (교육청 안내문 17개가 "•"·누락)
 *   ▪ 작은 속 찬 네모 — 채움 0.9 이상, 글자 높이 0.28~0.6배 (가운뎃점 "·" 은 0.21배 안팎), 그보다 크면(1.0배까지) ■
 *   ❐·❏ 그림자 진 네모 — 오른쪽과 위(❐)·아래(❏) 변이 맞은편보다 1.8배 넘게 두꺼운 네모 (모델은 자모 ㅁ 으로 읽는다)
 *   ‣ 오른쪽 삼각 — 줄마다 한 토막이 왼끝에서 시작하고 가운데 줄이 가장 긴 글자 높이 0.3~0.7배 조각 (모델은 → 로 읽는다)
 *   ▣ 속 찬 네모를 품은 네모 — 바깥 네모 테두리 + 가운데 속 찬 정사각, 글자 높이 0.6~0.92배
 * 속 빈 원(○·ㅇ·❍)은 픽셀로 못 가르니 건드리지 않는다. squareMax 는 □ 크기 상한(글자 높이 배) — 박스 안 맨 앞은 0.92(글자 높이만큼 큰
 * 네모는 그림으로 그린 도형이기 쉽다, eval-perf-2024), 박스 바깥으로 떨어진 줄 머리는 따로 정한다. firstX 는 첫 인식 글자의 CTC 자리(박스 로컬) —
 * 덩어리가 그 앞에서 끝나면 인식에서 빠진 것, 그 글자 자리에 걸치면 그 글자가 이 기호를 잘못 읽은 것이다
 */
export function leadingBullet(gray: Uint8Array, w: number, h: number, ink: InkStats, firstX: number, squareMax = 0.92): { mark: "◎" | "●" | "▪" | "■" | "□" | "▣" | "❐" | "❏" | "‣" | "◆" | "◇" | "◈"; covers: boolean } | null {
  const { comps, label } = components(gray, w, h, ink)
  let charH = 0
  for (const c of comps) charH = Math.max(charH, c.y1 - c.y0)
  if (charH < 10) return null
  const cand = comps.filter(c => c.y1 - c.y0 >= charH * 0.15).sort((a, b) => a.x0 - b.x0)
  const first = cand[0]
  if (!first) return null
  const cl = cand.filter(c => c.x0 < first.x1 && c.x1 > first.x0)
  const x0 = Math.min(...cl.map(c => c.x0)), x1 = Math.max(...cl.map(c => c.x1)), y0 = Math.min(...cl.map(c => c.y0)), y1 = Math.max(...cl.map(c => c.y1))
  const cw = x1 - x0, ch = y1 - y0
  // 오른쪽 삼각 글머리 ‣ — 줄마다 한 토막이 모두 왼끝에서 시작하고 가운데 줄이 가장 길다(서울기록원 지침 "‣ 기록관리기준표 …",
  // 모델은 → 로 읽거나 빠뜨림). 화살표 → 는 머리 쪽 줄이 왼끝에서 시작하지 않는다
  if (cl.length === 1 && cw >= ch * 0.55 && cw <= ch * 1.1 && ch >= charH * 0.3 && ch <= charH * 0.7) {
    const runs: number[] = []
    let aligned = true
    for (let y = y0; y < y1 && aligned; y++) {
      let first = -1, last = -1, segs = 0, prev = false
      for (let x = x0; x < x1; x++) { const on = label[y * w + x] === cl[0].id; if (on) { if (!prev) segs++; if (first < 0) first = x; last = x } prev = on }
      aligned = segs === 1 && first - x0 <= Math.max(1, cw * 0.15)
      runs.push(last - first + 1)
    }
    const peak = runs.indexOf(Math.max(...runs))
    if (aligned && Math.abs(peak - ch / 2) <= ch * 0.2 && runs[0] <= cw * 0.45 && runs[runs.length - 1] <= cw * 0.45 && Math.max(...runs) >= cw * 0.85) {
      const next = cand.find(c => c.x0 >= x1)
      if (!next || next.x0 - x1 >= ch * 0.3) return { mark: "\u2023", covers: firstX <= x1 + ch * 0.3 }
    }
  }
  if (cw < ch * 0.8 || cw > ch * 1.25) return null
  // 덩어리 뒤에 틈이 있어야 글머리다 (글자 획이 아님). 기호 하나만 든 상자(목차 열의 ◎)는 뒤가 비어 있다
  const next = cand.find(c => c.x0 >= x1)
  if (next && next.x0 - x1 < ch * 0.3) return null
  let inkN = 0
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (cl.some(c => label[y * w + x] === c.id)) inkN++
  const fill = inkN / (cw * ch)
  const rel = ch / charH
  // 이중 원 — 안쪽 조각도 가운데 놓인 둥근 고리여야 한다 (원문자 ①② 는 안쪽이 숫자라 좁다)
  const ring = (c: Comp) => { const a = c.x1 - c.x0, b = c.y1 - c.y0; return a >= b * 0.75 && a <= b * 1.33 }
  const nested = cl.length >= 2 && cl.some(a => cl.some(b => a !== b && b.x0 > a.x0 && b.x1 < a.x1 && b.y0 > a.y0 && b.y1 < a.y1 && ring(b)
    && Math.abs((b.x0 + b.x1) - (a.x0 + a.x1)) <= (a.x1 - a.x0) * 0.2 && Math.abs((b.y0 + b.y1) - (a.y0 + a.y1)) <= (a.y1 - a.y0) * 0.2))
  // 속 빈 정사각 □ — 윗·아랫 띠(높이 15%)가 폭 80% 넘게 차고 가운데 줄이 양끝 두 획뿐. 글자 높이의 0.6~0.92배
  // (제목 앞 도형 네모는 글자 높이만큼 커 0.98배, 한글 첫소리 ㅁ 은 인식된 글자라 covers 로 걸러진다)
  const span = (y: number) => { let n = 0; for (let x = x0; x < x1; x++) if (cl.some(c => label[y * w + x] === c.id)) n++; return n }
  const band = Math.max(1, Math.round(ch * 0.15))
  const edgeFull = (from: number, dir: 1 | -1) => { let m = 0; for (let k = 0; k < band; k++) m = Math.max(m, span(from + dir * k)); return m >= cw * 0.8 }
  let midRuns = 0
  { let prev = false; const my = y0 + (ch >> 1); for (let x = x0; x < x1; x++) { const on = cl.some(c => label[my * w + x] === c.id); if (on && !prev) midRuns++; prev = on } }
  const hollowSquare = cl.length === 1 && fill < 0.5 && midRuns === 2 && edgeFull(y0, 1) && edgeFull(y1 - 1, -1)
  // 속 찬 네모를 품은 네모 ▣ — 바깥 조각 위아래 변이 차고, 안쪽 조각이 가운데 놓인 속 찬 정사각(선거 사례집 "▣ 선거별 법정 일자")
  const core = cl.length === 2 ? cl.find(b => cl.some(a => a !== b && b.x0 > a.x0 && b.x1 < a.x1 && b.y0 > a.y0 && b.y1 < a.y1)) : undefined
  const coreFill = (() => {
    if (!core) return 0
    let k = 0
    for (let y = core.y0; y < core.y1; y++) for (let x = core.x0; x < core.x1; x++) if (label[y * w + x] === core.id) k++
    return k / ((core.x1 - core.x0) * (core.y1 - core.y0))
  })()
  const filledSquare = !!core && coreFill >= 0.85 && ring(core) && Math.abs((core.x0 + core.x1) - (x0 + x1)) <= cw * 0.2
    && Math.abs((core.y0 + core.y1) - (y0 + y1)) <= ch * 0.2 && edgeFull(y0, 1) && edgeFull(y1 - 1, -1)
  // 그림자 진 네모 — 오른쪽 변과 위·아래 한 변이 맞은편보다 1.8배 넘게 두껍다(농진청 계획 "❐ 글로벌 경쟁 …", 모델은 자모 ㅁ 으로 읽음).
  // 획 두께는 가운데 가로줄·세로줄에서 바깥 끝부터 이어진 잉크 길이. 자모 ㅁ·□ 는 네 변 두께가 고르다
  // 바깥 끝 2px 안 빈 칸은 건너뛴다 — 기울기 보정 뒤 남은 0.1° 안팎 기울기로 가운데 줄의 외곽 끝 픽셀이 비어 두께가 0 으로 재졌다(농진청 계획 1° 판 ❐ → □)
  const run = (x: number, y: number, dx: number, dy: number) => {
    const inside = () => x >= x0 && x < x1 && y >= y0 && y < y1, on = () => cl.some(c => label[y * w + x] === c.id)
    for (let k = 0; k < 2 && inside() && !on(); k++) { x += dx; y += dy }
    let n = 0
    while (inside() && on()) { n++; x += dx; y += dy }
    return n
  }
  const my0 = y0 + (ch >> 1), mx0 = x0 + (cw >> 1)
  // 비율만 보면 가는 획(1px·2px)에서 갈린다 — 그림자 쪽이 실제로 몇 px 더 두꺼워야 한다(web044 "□ (경과)" 아랫변 2px·윗변 1px)
  const thin = (a: number, b: number) => a > 0 && b >= a * 1.8 && b - a >= Math.max(3, ch * 0.08)
  const boxed = cl.length === 1 && midRuns === 2 && edgeFull(y0, 1) && edgeFull(y1 - 1, -1) && thin(run(x0, my0, 1, 0), run(x1 - 1, my0, -1, 0))
  const top = run(mx0, y0, 0, 1), bottom = run(mx0, y1 - 1, 0, -1)
  // 오른쪽 위 그림자 ❐(U+2750) · 오른쪽 아래 그림자 ❏(U+274F)
  const shadow = !boxed ? null : thin(bottom, top) ? "\u2750" : thin(top, bottom) ? "\u274f" : null
  // 마름모 ◆·◇·◈ — 줄마다 잉크 외곽 폭이 가운데에서 위아래로 고르게 준다(전략목표 머리 "◈ 전략목표 Ⅰ", 모델은 √ 로 읽거나 빠뜨림).
  // 속이 차면 ◆, 비면 ◇, 안에 속 찬 마름모를 품으면 ◈. 글자 높이 0.5~1.0배
  const diamond = (() => {
    if (rel < 0.5 || rel > 1.0) return false
    const half = ch / 2, cyc = y0 + half
    let ok = 0
    for (let y = y0; y < y1; y++) {
      let l = -1, r = -1
      for (let x = x0; x < x1; x++) if (cl.some(c => label[y * w + x] === c.id)) { if (l < 0) l = x; r = x }
      const want = cw * (1 - Math.abs(y + 0.5 - cyc) / half)
      if (l >= 0 && Math.abs(r - l + 1 - want) <= Math.max(2, cw * 0.15)) ok++
    }
    return ok >= ch * 0.85
  })()
  let mark: "\u25ce" | "\u25cf" | "\u25aa" | "\u25a0" | "\u25a1" | "\u25a3" | "\u2750" | "\u274f" | "\u25c6" | "\u25c7" | "\u25c8" | null = null
  if (diamond) mark = cl.length >= 2 && core ? "\u25c8" : cl.length === 1 && fill >= 0.4 ? "\u25c6" : cl.length === 1 ? "\u25c7" : null
  if (mark) return { mark, covers: firstX <= x1 + ch * 0.3 }
  if (shadow && rel >= 0.6 && rel <= 0.92) mark = shadow
  else if (hollowSquare && rel >= 0.6 && rel <= squareMax) mark = "\u25a1"
  else if (filledSquare && rel >= 0.6 && rel <= 0.92) mark = "\u25a3"
  else if (nested && fill < 0.45 && rel >= 0.6) mark = "\u25ce"
  else if (cl.length === 1 && fill >= 0.9 && rel >= 0.28 && rel <= 0.6) mark = "\u25aa"
  // 큰 속 찬 네모 ■ — 서식 머리 "■ 국토의 계획 및 이용에 관한 법률 시행규칙 [별지 …]"(모델은 빠뜨림). 글자 높이 0.6~1.0배
  else if (cl.length === 1 && fill >= 0.9 && rel > 0.6 && rel <= 1.0) mark = "\u25a0"
  else if (cl.length === 1 && fill >= 0.65 && fill <= 0.88 && rel >= 0.5 && rel <= 0.8) mark = "\u25cf"
  if (!mark) return null
  return { mark, covers: firstX <= x1 + ch * 0.3 }
}

/** 세로로 쌓인 글자로 볼 잉크 키/폭 비 — 한 글자는 1 안팎, 두 글자 세로쓰기는 2 안팎 */
const STACK_INK_RATIO = 1.6

/**
 * 세로로 쌓인 두세 글자 상자의 글자 띠 — 표 머리 "서/울"·"부/산" 은 여백 붙은 검출 상자 키가 폭의 1.3배라 세로 상자 가르기(engine TALL_RATIO)에
 * 안 걸려 한 줄로 읽히고("설울"·빈 글) 버려진다. 잉크가 폭의 STACK_INK_RATIO 배 넘게 길고 글자 띠 2~4개로 갈릴 때만 띠를 낸다
 */
export function stackedGlyphBands(gray: Uint8Array, w: number, h: number, ink: InkStats): Array<{ y0: number; y1: number; x0: number; x1: number }> | null {
  const ib = inkBounds(gray, w, h, ink)
  if (ib.y1 - ib.y0 < STACK_INK_RATIO * (ib.x1 - ib.x0)) return null
  const bands = splitRowBands(gray, w, h, ink, 0.45)
  return bands.length >= 2 && bands.length <= 4 ? bands : null
}
