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
