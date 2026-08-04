/**
 * 기하 전용 2단 레이아웃 검출 + 밴드 읽기순 정렬 (#64)
 *
 * findTwoColumnProseCutX(cluster-detector)는 속기록류 2단 "프로즈" 전용이라
 * justify·마커 희박·긴 줄을 요구한다 — 시험지(①~⑤ 마커 다량·짧은 선지 줄)나
 * 표가 많은 2단 지면에서는 불발한다. 여기는 텍스트 특성 없이 순수 기하 신호만 본다:
 *   ① 중앙(30~70%) 스캔에서 높이 가중 커버리지가 거의 0인 빈 띠(거터) 존재
 *   ② 좌·우 양측 모두 충분한 요소 수·높이 합·수직 범위 (사이드바/서명란 배제)
 *   ③ 좌우 단 폭 대칭 (라벨열+본문 구조 배제)
 * 전폭 요소(표 머리글·쪽번호 박스 등)는 폭 필터로 스캔에서 제외하고,
 * 정렬 단계에서 밴드 경계로 쓴다 (밴드 내 좌단 전체 → 우단 전체).
 */

/** 검출·정렬 입력 사각형 (PDF pt, y는 아래가 원점 — bottom-up) */
export interface ColRect {
  x: number
  y: number
  w: number
  h: number
}

/** 거터 스캔 범위 (콘텐츠 폭 비율) */
const GUTTER_SCAN_LO = 0.3
const GUTTER_SCAN_HI = 0.7
/** 스캔 샘플 수 상한 (오염 좌표 폭주 방지 — findTwoColumnProseCutX와 동일 발상) */
const GUTTER_MAX_SAMPLES = 400
/** 전폭(cross) 요소 판정: 콘텐츠 폭 대비 비율 — 이보다 넓으면 스캔 제외 */
const WIDE_RECT_RATIO = 0.55
/** 거터 허용 커버리지: 좁은 요소 높이 합 대비 (쪽번호 박스·중앙 꼬리표 몇 개 허용) */
const GUTTER_MAX_COVER_RATIO = 0.06
/** 좌·우 각 측 최소 요소 수 */
const SIDE_MIN_COUNT = 5
/** 좌·우 높이 합 비율 최소값 (작은 사이드바 배제) */
const SIDE_MIN_HEIGHT_RATIO = 0.3
/** 좌·우 각 측 수직 범위 최소값 (전체 수직 범위 대비 — 상단 구석 요소 배제) */
const SIDE_MIN_VSPAN_RATIO = 0.45
/** 좌우 단 폭 대칭 최소값 */
const SIDE_MIN_WIDTH_SYMMETRY = 0.5
/** 2단으로 인정할 최소 콘텐츠 폭 (pt) */
const MIN_CONTENT_SPAN = 300
/** 텍스트급 rect 판정 높이 상한 (pt) — 이보다 크면 표/블록 bbox로 본다 */
const TEXT_RECT_MAX_H = 20
/** 같은 행 판정 y 오차 (pt) */
const ROW_Y_TOL = 2
/** 좌·우 각 측 최소 텍스트 행 수 — 진짜 단은 세로로 길다 (코퍼스 실측: 시험지 25~60행,
 * 오발화 스파스 페이지 ~10행) */
const SIDE_MIN_TEXT_ROWS = 12
/** 크로스 연속 행 판정 갭 (pt) — 같은 행의 좌측 끝~우측 시작이 이보다 좁으면
 * 거터가 문장/단어 사이를 뚫고 지나간 것 (진짜 단 마진은 30pt+) */
const CROSS_ROW_TINY_GAP = 12
/** 허용 크로스 연속 행 수 (노이즈 1행 허용) */
const MAX_TINY_GAP_ROWS = 1
/** 양측 동시 행 비율 상한 — 초과는 행 짝 구조(예산서·대비표: 라벨-값이 같은 행) */
const MAX_BOTH_SIDE_ROW_RATIO = 0.65
/** 텍스트급 rect가 이보다 적으면 블록(표) 지배 지면 — 행 가드 생략 (블록 재배열은
 * 텍스트를 쪼개지 않아 안전) */
const BLOCK_DOMINANT_TEXT_RECTS = 10

/**
 * 좁은 요소들의 x-프로젝션(높이 가중)에서 중앙 빈 띠를 찾아 거터 x를 반환.
 * 2단 레이아웃이 아니라고 판단되면 null.
 */
export function detectColumnGutter(rects: ColRect[]): number | null {
  if (rects.length < 8) return null

  let minX = Infinity
  let maxX = -Infinity
  for (const r of rects) {
    if (r.x < minX) minX = r.x
    if (r.x + r.w > maxX) maxX = r.x + r.w
  }
  const span = maxX - minX
  if (!Number.isFinite(span) || span < MIN_CONTENT_SPAN) return null

  // 전폭 요소 제외 — 표 머리글/전면 표는 밴드 경계일 뿐 단 구조 신호가 아님
  const narrow = rects.filter(r => r.w < span * WIDE_RECT_RATIO && r.w > 0 && r.h > 0)
  if (narrow.length < SIDE_MIN_COUNT * 2) return null

  let totalH = 0
  for (const r of narrow) totalH += r.h
  if (totalH <= 0) return null

  // 중앙부 스캔: 각 x를 덮는 좁은 요소의 높이 합이 최소인 지점 = 거터 후보
  const lo = minX + span * GUTTER_SCAN_LO
  const hi = minX + span * GUTTER_SCAN_HI
  const step = Math.max(2, (hi - lo) / GUTTER_MAX_SAMPLES)
  let gutterX = 0
  let bestCover = Infinity
  for (let x = lo; x <= hi; x += step) {
    let cover = 0
    for (const r of narrow) {
      if (r.x < x && r.x + r.w > x) cover += r.h
    }
    if (cover < bestCover) { bestCover = cover; gutterX = x }
  }
  if (bestCover > totalH * GUTTER_MAX_COVER_RATIO) return null

  // 좌·우 분류 (거터를 걸치는 요소는 어느 쪽도 아님 — 위에서 커버리지로 이미 소수 보장)
  const left: ColRect[] = []
  const right: ColRect[] = []
  for (const r of narrow) {
    if (r.x + r.w <= gutterX) left.push(r)
    else if (r.x >= gutterX) right.push(r)
  }
  if (left.length < SIDE_MIN_COUNT || right.length < SIDE_MIN_COUNT) return null

  const sideStats = (side: ColRect[]) => {
    let sMinX = Infinity, sMaxR = -Infinity, sMinY = Infinity, sMaxT = -Infinity, hSum = 0
    for (const r of side) {
      if (r.x < sMinX) sMinX = r.x
      if (r.x + r.w > sMaxR) sMaxR = r.x + r.w
      if (r.y < sMinY) sMinY = r.y
      if (r.y + r.h > sMaxT) sMaxT = r.y + r.h
      hSum += r.h
    }
    return { width: sMaxR - sMinX, vspan: sMaxT - sMinY, minY: sMinY, maxT: sMaxT, hSum }
  }
  const L = sideStats(left)
  const R = sideStats(right)

  // 높이 합 균형 — 본문 옆 작은 사이드바(부서명·서명란)로는 단 분리하지 않는다
  if (Math.min(L.hSum, R.hSum) / Math.max(L.hSum, R.hSum) < SIDE_MIN_HEIGHT_RATIO) return null

  // 양측 모두 지면 수직 범위의 상당 부분을 차지해야 함
  const unionVspan = Math.max(L.maxT, R.maxT) - Math.min(L.minY, R.minY)
  if (unionVspan <= 0) return null
  if (L.vspan / unionVspan < SIDE_MIN_VSPAN_RATIO) return null
  if (R.vspan / unionVspan < SIDE_MIN_VSPAN_RATIO) return null

  // 좌우 단 폭 대칭 — 라벨열+본문(비대칭)은 표/공문 구조일 가능성
  if (Math.min(L.width, R.width) / Math.max(L.width, R.width) < SIDE_MIN_WIDTH_SYMMETRY) return null

  // 행 구조 가드 — 오발화의 두 형태를 코퍼스 실측 지표로 기각한다:
  //  (a) 거터가 프로즈 문장의 단어 갭을 뚫고 지나간 경우: 같은 행의 좌측 끝~우측
  //      시작 간격이 단어 갭 수준(<12pt)인 행이 생긴다. 진짜 단 마진은 30pt+.
  //  (b) 예산서·대비표류 행 짝 구조: 거의 모든 행이 좌(라벨)·우(값) 동시 존재.
  //      진짜 2단은 단끼리 독립 조판이라 동시 행 비율이 낮다 (실측 0.11~0.59 vs 0.69~1.0).
  // 여기서 오발화하면 한 행이 두 단으로 찢겨 텍스트가 유실된다 (코퍼스 -0.7%p 실측).
  const textRects = (side: ColRect[]) => side.filter(r => r.h <= TEXT_RECT_MAX_H)
  const lText = textRects(left)
  const rText = textRects(right)
  if (lText.length + rText.length >= BLOCK_DOMINANT_TEXT_RECTS) {
    interface RowEdge { lEnd: number; rStart: number }
    const rows = new Map<number, RowEdge>()
    const rowKey = (y: number) => Math.round(y / ROW_Y_TOL)
    for (const r of lText) {
      const k = rowKey(r.y)
      const e = rows.get(k) ?? { lEnd: -Infinity, rStart: Infinity }
      if (r.x + r.w > e.lEnd) e.lEnd = r.x + r.w
      rows.set(k, e)
    }
    const lRowCount = rows.size
    for (const r of rText) {
      const k = rowKey(r.y)
      const e = rows.get(k) ?? { lEnd: -Infinity, rStart: Infinity }
      if (r.x < e.rStart) e.rStart = r.x
      rows.set(k, e)
    }
    let rRowCount = 0
    let bothRows = 0
    let tinyGapRows = 0
    for (const e of rows.values()) {
      if (e.rStart < Infinity) rRowCount++
      if (e.lEnd > -Infinity && e.rStart < Infinity) {
        bothRows++
        if (e.rStart - e.lEnd < CROSS_ROW_TINY_GAP) tinyGapRows++
      }
    }
    if (lRowCount < SIDE_MIN_TEXT_ROWS || rRowCount < SIDE_MIN_TEXT_ROWS) return null
    if (tinyGapRows > MAX_TINY_GAP_ROWS) return null
    if (bothRows / Math.min(lRowCount, rRowCount) > MAX_BOTH_SIDE_ROW_RATIO) return null
  }

  return gutterX
}

/**
 * 거터 기준 밴드 읽기순 정렬 — 거터를 가로지르는 유닛(전폭 표·머리글·쪽번호)을
 * 위→아래 밴드 경계로 삼고, 각 밴드 안에서 좌단 전체(위→아래) → 우단 전체 순서.
 * 유닛 내부 순서는 건드리지 않는다.
 */
export function orderByGutter<T>(units: T[], rectOf: (u: T) => ColRect, gutterX: number): T[] {
  interface Tagged { u: T; top: number }
  const left: Tagged[] = []
  const right: Tagged[] = []
  const cross: Tagged[] = []
  for (const u of units) {
    const r = rectOf(u)
    const top = r.y + r.h
    if (r.x < gutterX && r.x + r.w > gutterX) cross.push({ u, top })
    else if (r.x + r.w <= gutterX) left.push({ u, top })
    else right.push({ u, top })
  }
  const byTopDesc = (a: Tagged, b: Tagged) => b.top - a.top
  cross.sort(byTopDesc)
  left.sort(byTopDesc)
  right.sort(byTopDesc)

  // 밴드 k = 자기보다 위에 있는(top이 더 큰) 경계 수
  const bandOf = (top: number) => {
    let k = 0
    while (k < cross.length && cross[k].top > top) k++
    return k
  }

  const ordered: T[] = []
  for (let k = 0; k <= cross.length; k++) {
    for (const t of left) { if (bandOf(t.top) === k) ordered.push(t.u) }
    for (const t of right) { if (bandOf(t.top) === k) ordered.push(t.u) }
    if (k < cross.length) ordered.push(cross[k].u)
  }
  return ordered
}
