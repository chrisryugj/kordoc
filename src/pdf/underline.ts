/**
 * 밑줄 감지 — baseline 바로 아래에 밀착한 얇은 수평선을 텍스트 아이템과 상관.
 *
 * PDF 에는 밑줄 폰트 플래그가 없다 — 밑줄은 별도 그래픽(선/얇은 사각형)으로
 * 그려지므로, 추출된 텍스트와 기하로 대조해 복원한다. 개정문 추가·변경 표시,
 * 제목 강조 보존용. 표 괘선 오탐 방어 4겹 — 수직선 접촉, 동일 스팬 반복,
 * 런 union 밀착(containment + coverage), 런 사이 컬럼급 구멍.
 *
 * firecrawl/pdf-inspector underline 휴리스틱 참조 (MIT)
 * https://github.com/firecrawl/pdf-inspector — src/extractor/underline.rs
 */

import type { LineSegment } from "./line-types.js"
import type { NormItem } from "./text-line.js"

/** 밑줄 최대 두께 (pt) — 굵은 선은 배경 채움/테두리 */
const UNDER_MAX_THICKNESS = 2.0
/** baseline 아래 허용 깊이 — CJK 밑줄은 전각 박스 하단(~0.67em)까지 내려간다 */
const UNDER_BELOW_EM = 0.72
/** baseline 아래 허용 깊이 최소값 (pt, 작은 폰트 라운딩) */
const UNDER_BELOW_MIN_PT = 3.0
/** baseline 위 허용 (pt, 라운딩) — 다음 줄 텍스트가 위 줄 밑줄에 매칭되는 것 차단 */
const UNDER_ABOVE_PT = 1.0
/** 선이 아이템을 덮어야 하는 최소 수평 비율 */
const UNDER_MIN_OVERLAP_RATIO = 0.6
/** 선이 매칭 런 union 을 벗어날 수 있는 좌우 여유 (em 배수 / 최소 pt) */
const UNDER_OWNER_PAD_EM = 0.75
const UNDER_OWNER_PAD_MIN_PT = 4.0
/** 매칭 텍스트 폭 합 / 선 폭 최소 비율 — 표 행 괘선은 셀 패딩·빈 열까지 걸쳐 미달 */
const UNDER_MIN_COVERAGE = 0.6
/** 수직선 접촉 판정 오차 (pt) — 접촉하면 표 그리드/폼 박스의 변 */
const UNDER_GRID_EPS = 2.0
/** 매칭 런 사이 구멍 한계 (em 배수) — 컬럼급 구멍이 있으면 표 행 괘선 */
const UNDER_COLUMN_GAP_EM = 2.0
/** 동일 x-스팬 수평선이 반복되는 y 레벨 수 — 이 이상이면 수평 괘선만의 표/폼 */
const UNDER_REPEATED_SPAN_LEVELS = 3
/** 동일 스팬 판정: 겹침 / 넓은 쪽 폭 최소 비율 */
const UNDER_SPAN_OVERLAP_RATIO = 0.8
/** 박스 상변 짝 탐색 창 (em 배수) — 배지/칩 높이는 대략 1~2줄 */
const UNDER_BOX_PAIR_MIN_EM = 0.5
const UNDER_BOX_PAIR_MAX_EM = 2.2
/** 상변 짝 스팬 유사성: 겹침 / 넓은 쪽 폭 (표 하변은 폭이 크게 달라 제외됨) */
const UNDER_BOX_PAIR_OVERLAP = 0.8

/**
 * baseline 바로 아래에 밀착한 얇은 수평선을 찾아 해당 아이템에 underline 마킹.
 */
export function markUnderlineItems(items: NormItem[], horizontals: LineSegment[], verticals: LineSegment[]): void {
  if (items.length === 0 || horizontals.length === 0) return

  for (const line of horizontals) {
    if (line.lineWidth > UNDER_MAX_THICKNESS) continue
    if (touchesVertical(line, verticals)) continue
    if (isRepeatedSpanRule(line, horizontals)) continue

    const matches: NormItem[] = []
    for (const item of items) {
      const h = item.h > 0 ? item.h : item.fontSize
      if (h <= 0 || item.w <= 0 || !item.text.trim()) continue
      const below = Math.max(h * UNDER_BELOW_EM, UNDER_BELOW_MIN_PT)
      if (line.y1 < item.y - below || line.y1 > item.y + UNDER_ABOVE_PT) continue
      const overlap = Math.min(line.x2, item.x + item.w) - Math.max(line.x1, item.x)
      if (overlap / item.w < UNDER_MIN_OVERLAP_RATIO) continue
      matches.push(item)
    }
    if (matches.length === 0) continue

    // 밀착 소유 검증: 선이 매칭 런 union 에 밀착해야 밑줄
    let x1 = Infinity, x2 = -Infinity, maxH = 0, covered = 0
    for (const m of matches) {
      x1 = Math.min(x1, m.x)
      x2 = Math.max(x2, m.x + m.w)
      maxH = Math.max(maxH, m.h > 0 ? m.h : m.fontSize)
      covered += m.w
    }
    const pad = Math.max(maxH * UNDER_OWNER_PAD_EM, UNDER_OWNER_PAD_MIN_PT)
    if (line.x1 < x1 - pad || line.x2 > x2 + pad) continue
    if (covered < (line.x2 - line.x1) * UNDER_MIN_COVERAGE) continue

    // 위쪽에 같은 스팬의 수평선이 마주보면 배지/칩/제목박스의 하변 — 밑줄은 위짝이 없다.
    // 라운드 모서리 배지는 상하변이 직선으로만 나와 수직선 접촉 방어를 비껴가므로 필수.
    if (hasBoxTopPair(line, maxH, horizontals)) continue

    // 매칭 런 사이 컬럼급 구멍 → 표 행 괘선 (밑줄 줄은 단어 간격 수준으로 연속)
    matches.sort((a, b) => a.x - b.x)
    let hole = false
    for (let i = 1; i < matches.length; i++) {
      if (matches[i].x - (matches[i - 1].x + matches[i - 1].w) > maxH * UNDER_COLUMN_GAP_EM) {
        hole = true
        break
      }
    }
    if (hole) continue

    for (const m of matches) m.underline = true
  }
}

/** 선의 x-스팬 내에서 선 y 를 지나는(접촉 포함) 수직선 존재 여부 — 표 그리드/폼 박스 판정 */
function touchesVertical(line: LineSegment, verticals: LineSegment[]): boolean {
  for (const v of verticals) {
    if (v.x1 < line.x1 - UNDER_GRID_EPS || v.x1 > line.x2 + UNDER_GRID_EPS) continue
    const lo = Math.min(v.y1, v.y2), hi = Math.max(v.y1, v.y2)
    if (lo <= line.y1 + UNDER_GRID_EPS && hi >= line.y1 - UNDER_GRID_EPS) return true
  }
  return false
}

/** 후보선 위쪽 0.5~2.2em 에 거의 같은 스팬의 수평선 존재 — 박스/배지의 상변 짝 */
function hasBoxTopPair(line: LineSegment, maxH: number, horizontals: LineSegment[]): boolean {
  const w = line.x2 - line.x1
  if (w <= 0) return false
  for (const o of horizontals) {
    if (o === line) continue
    const dy = o.y1 - line.y1
    if (dy < maxH * UNDER_BOX_PAIR_MIN_EM || dy > maxH * UNDER_BOX_PAIR_MAX_EM) continue
    const ow = o.x2 - o.x1
    if (ow <= 0) continue
    const overlap = Math.min(line.x2, o.x2) - Math.max(line.x1, o.x1)
    if (overlap / Math.max(w, ow) >= UNDER_BOX_PAIR_OVERLAP) return true
  }
  return false
}

/** 거의 같은 x-스팬의 수평선이 3+ y 레벨에서 반복 — 수평 괘선만 쓰는 표/폼 (서식류) */
function isRepeatedSpanRule(line: LineSegment, horizontals: LineSegment[]): boolean {
  const w = line.x2 - line.x1
  if (w <= 0) return false
  const ys: number[] = []
  for (const o of horizontals) {
    const ow = o.x2 - o.x1
    if (ow <= 0) continue
    const overlap = Math.min(line.x2, o.x2) - Math.max(line.x1, o.x1)
    if (overlap / Math.max(w, ow) < UNDER_SPAN_OVERLAP_RATIO) continue
    if (!ys.some(y => Math.abs(y - o.y1) < 2)) ys.push(o.y1)
  }
  return ys.length >= UNDER_REPEATED_SPAN_LEVELS
}

/**
 * underline 마킹된 아이템 run 을 <u>...</u> 로 감싼다 (GFM 은 밑줄 문법이 없어 인라인 HTML).
 * 같은 시각적 줄이라도 1em 넘게 떨어진 구간은 별도 run — 사이의 비밑줄 텍스트 오염 방지.
 */
export function wrapUnderlineRuns(items: NormItem[]): void {
  const marked = items.filter(i => i.underline)
  if (marked.length === 0) return

  const lines = new Map<number, NormItem[]>()
  for (const item of marked) {
    const key = Math.round(item.y / 3)
    const arr = lines.get(key) || []
    arr.push(item)
    lines.set(key, arr)
  }
  for (const arr of lines.values()) {
    arr.sort((a, b) => a.x - b.x)
    let runStart = 0
    for (let i = 1; i <= arr.length; i++) {
      const prev = arr[i - 1]
      const em = Math.max(prev.h > 0 ? prev.h : prev.fontSize, 1)
      const gap = i < arr.length ? arr[i].x - (prev.x + prev.w) : Infinity
      if (gap > em) {
        arr[runStart].text = "<u>" + arr[runStart].text
        prev.text = prev.text + "</u>"
        runStart = i
      }
    }
  }
}
