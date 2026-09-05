/**
 * 셀 클립 사각형 → 표 그리드 (테두리 없는 표 복원).
 *
 * 한컴 PDF 는 표 셀마다 `W n`(clip + endPath) 사각형을 깔고 그 안에 글을 찍는다. 법령 별지서식의
 * 외곽 표는 테두리 "없음" 셀이 대부분이라 획 괘선만 보는 line 파이프라인은 표를 못 잡고
 * 제목·기입란이 헤딩·문단으로 흩어진다 (법제처 별지서식 PDF 실측, v4.12.1). 클립 사각형은
 * 병합 셀까지 그대로 담은 실제 셀 기하라, 선→교차점→클러스터 경로 없이 곧장 셀로 쓴다 —
 * 전 페이지를 한 그리드로 합칠 때 행마다 다른 열 경계가 MIN_COL_WIDTH 병합으로 뭉개지는
 * 것도 피한다.
 *
 * 적용 범위는 보수적으로 잡는다: 서로 변을 맞대는 클립 묶음이 CLIP_MIN_GROUP 개 이상이고,
 * 그 변 가운데 획 괘선이 없는 비율이 CLIP_MIN_INVISIBLE 이상일 때만 이 경로를 탄다. 실선
 * 테두리 표는 검증된 line 경로가 그대로 맡는다. 글상자·그림·머리말처럼 이웃 없는 단독
 * 클립은 묶음이 안 돼 제외된다.
 */

import type { ClipRect } from "./line-extract.js"
import type { ExtractedCell, LineSegment, TableGrid } from "./line-types.js"

/** 이웃 셀 판정 — 변 공유·좌표 클러스터 허용 오차 (pt) */
const CLIP_EDGE_TOL = 1.5
/** 그리드로 인정하는 최소 셀 수 — 글상자 한두 개짜리 클립은 표가 아님 */
const CLIP_MIN_GROUP = 2
/** 페이지 면적 대비 이 비율 이상인 클립은 페이지/본문 영역 — 셀 아님 */
const CLIP_MAX_PAGE_FRAC = 0.75
/** 셀 최소 치수 (pt) */
const CLIP_MIN_W = 4
const CLIP_MIN_H = 2
/** 획 괘선이 변을 덮는다고 보는 거리(pt)·길이 비율 */
const STROKE_NEAR = 2
const STROKE_COVER = 0.5
/** 묶음 변 중 획 괘선 없는 비율이 이 이상이어야 "테두리 없는 표" — 실선 표는 line 경로에 양보 */
const CLIP_MIN_INVISIBLE = 0

const overlap = (a1: number, a2: number, b1: number, b2: number): number => Math.min(a2, b2) - Math.max(a1, b1)

function adjacent(a: ClipRect, b: ClipRect): boolean {
  // 세로변 공유(좌우 이웃) 또는 가로변 공유(상하 이웃) — 겹침이 양수여야 모서리만 닿은 대각 이웃 제외
  if ((Math.abs(a.x2 - b.x1) <= CLIP_EDGE_TOL || Math.abs(b.x2 - a.x1) <= CLIP_EDGE_TOL) && overlap(a.y1, a.y2, b.y1, b.y2) > CLIP_EDGE_TOL) return true
  if ((Math.abs(a.y2 - b.y1) <= CLIP_EDGE_TOL || Math.abs(b.y2 - a.y1) <= CLIP_EDGE_TOL) && overlap(a.x1, a.x2, b.x1, b.x2) > CLIP_EDGE_TOL) return true
  return false
}

/** a 가 b 를 품는가 (중첩표의 바깥 셀 클립) */
function contains(a: ClipRect, b: ClipRect): boolean {
  return b.x1 >= a.x1 - CLIP_EDGE_TOL && b.x2 <= a.x2 + CLIP_EDGE_TOL && b.y1 >= a.y1 - CLIP_EDGE_TOL && b.y2 <= a.y2 + CLIP_EDGE_TOL
    && ((b.x2 - b.x1) < (a.x2 - a.x1) - CLIP_EDGE_TOL || (b.y2 - b.y1) < (a.y2 - a.y1) - CLIP_EDGE_TOL)
}

/** 좌표 클러스터 — 오름차순 정렬 후 CLIP_EDGE_TOL 이내는 평균으로 합침 */
function clusterCoords(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  let run: number[] = []
  for (const v of sorted) {
    if (run.length > 0 && v - run[run.length - 1] > CLIP_EDGE_TOL) { out.push(run.reduce((s, x) => s + x, 0) / run.length); run = [] }
    run.push(v)
  }
  if (run.length > 0) out.push(run.reduce((s, x) => s + x, 0) / run.length)
  return out
}

const nearestIndex = (coords: number[], v: number): number => {
  let best = 0
  for (let i = 1; i < coords.length; i++) if (Math.abs(coords[i] - v) < Math.abs(coords[best] - v)) best = i
  return best
}

/** 변이 획 괘선으로 덮여 있는가 */
function edgeStroked(lines: LineSegment[], dir: "h" | "v", pos: number, a1: number, a2: number): boolean {
  const len = a2 - a1
  if (len <= 0) return true
  for (const l of lines) {
    if (dir === "h") {
      if (Math.abs(l.y1 - pos) <= STROKE_NEAR && overlap(l.x1, l.x2, a1, a2) >= len * STROKE_COVER) return true
    } else if (Math.abs(l.x1 - pos) <= STROKE_NEAR && overlap(l.y1, l.y2, a1, a2) >= len * STROKE_COVER) {
      return true
    }
  }
  return false
}

/**
 * 클립 사각형 묶음에서 테두리 없는 표 그리드를 만든다. 셀은 `TableGrid.cells` 로 미리 확정해
 * 넘기므로 소비측은 extractCells 대신 이를 쓴다.
 * @param strokedH/strokedV 획 괘선 (전처리 전) — 실선 표 판정용
 */
export interface ClipCellResult {
  /** 셀 그리드 — 틀(중첩표 바깥 셀·1칸 테두리)은 자기 층의 셀로 들어가고, 안쪽 표는 별도 그리드.
   *  소비측은 면적 오름차순으로 처리해 안쪽 표가 글을 먼저 가져가게 한다 */
  grids: TableGrid[]
  /** 다른 클립을 품어 셀이 아니라 틀로 판정된 사각형(중복 제거) — line 그리드 정리(dropGridsInside)에 쓴다 */
  containers: ClipRect[]
}

export function buildClipCellGrids(
  rects: ClipRect[],
  strokedH: LineSegment[],
  strokedV: LineSegment[],
  pageWidth: number,
  pageHeight: number,
): ClipCellResult {
  const pageArea = pageWidth * pageHeight
  const cells = rects.filter(r =>
    (r.x2 - r.x1) >= CLIP_MIN_W && (r.y2 - r.y1) >= CLIP_MIN_H
    && (pageArea <= 0 || (r.x2 - r.x1) * (r.y2 - r.y1) < pageArea * CLIP_MAX_PAGE_FRAC))
  if (cells.length < CLIP_MIN_GROUP) return { grids: [], containers: [] }

  // 포함 관계로 층을 나눈다 — 각 사각형의 부모 = 자기를 품는 가장 작은 사각형. 중첩표 셀은 바깥
  // 셀 안에 있으므로 같은 부모(그 바깥 셀)끼리만 묶이고, 바깥 셀은 자기 층(최상위 또는 그 위 셀)의
  // 이웃과 묶인다. 이렇게 하면 지정서·영치증의 1칸 틀도 위 제목행·아래 꼬리행과 한 표의 셀이 되고
  // (HWP 파서가 내는 1열 표와 같은 모양), 안쪽 "발신명의 | 직인" 표는 자기들끼리 별도 그리드가 된다.
  // 틀 안 자유 문단이 바깥 격자의 채움 셀로 찢기지 않고, 클러스터 표 감지에 걸려 가짜 다열 표가
  // 되지도 않는다 (영치증 "성 명:/주 소:" 실측)
  const parent = new Array<number>(cells.length).fill(-1)
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j || !contains(cells[j], cells[i])) continue
      const cur = parent[i]
      if (cur < 0 || contains(cells[cur], cells[j])) parent[i] = j
    }
  }
  const isContainer = new Array<boolean>(cells.length).fill(false)
  for (const p of parent) if (p >= 0) isContainer[p] = true
  // 연결 컴포넌트 (같은 층의 변 공유 이웃) — 페이지당 클립은 수백 개라 O(n²) 허용
  const root = cells.map((_, i) => i)
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i] } return i }
  for (let i = 0; i < cells.length; i++) {
    for (let j = i + 1; j < cells.length; j++) {
      if (parent[i] !== parent[j]) continue
      if (adjacent(cells[i], cells[j])) { const ra = find(i), rb = find(j); if (ra !== rb) root[ra] = rb }
    }
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < cells.length; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  }
  // 틀(무언가를 품는 사각형)은 같은 사각형이 문단마다 반복 클립되므로(영치증 실측 3회) 좌표로 중복 제거
  const containers: ClipRect[] = []
  for (let i = 0; i < cells.length; i++) {
    if (!isContainer[i]) continue
    const r = cells[i]
    if (!containers.some(c => Math.abs(c.x1 - r.x1) <= CLIP_EDGE_TOL && Math.abs(c.x2 - r.x2) <= CLIP_EDGE_TOL && Math.abs(c.y1 - r.y1) <= CLIP_EDGE_TOL && Math.abs(c.y2 - r.y2) <= CLIP_EDGE_TOL)) containers.push(r)
  }
  const grids: TableGrid[] = []
  for (const idxs of groups.values()) {
    if (idxs.length < CLIP_MIN_GROUP) continue
    const members = idxs.map(i => cells[i])

    // 테두리 없는 표 판정 — 변 4개씩 획 괘선 유무
    let edges = 0, invisible = 0
    for (const r of members) {
      edges += 4
      if (!edgeStroked(strokedH, "h", r.y1, r.x1, r.x2)) invisible++
      if (!edgeStroked(strokedH, "h", r.y2, r.x1, r.x2)) invisible++
      if (!edgeStroked(strokedV, "v", r.x1, r.y1, r.y2)) invisible++
      if (!edgeStroked(strokedV, "v", r.x2, r.y1, r.y2)) invisible++
    }
    if (invisible / edges < CLIP_MIN_INVISIBLE) continue

    const colXs = clusterCoords(members.flatMap(r => [r.x1, r.x2]))
    const rowYs = clusterCoords(members.flatMap(r => [r.y1, r.y2])).reverse() // 위→아래 내림차순
    const numRows = rowYs.length - 1, numCols = colXs.length - 1
    if (numRows < 1 || numCols < 1) continue

    const occupied = Array.from({ length: numRows }, () => new Array<boolean>(numCols).fill(false))
    const out: ExtractedCell[] = []
    for (const r of members) {
      const c0 = nearestIndex(colXs, r.x1), c1 = nearestIndex(colXs, r.x2)
      const r0 = nearestIndex(rowYs, r.y2), r1 = nearestIndex(rowYs, r.y1)
      if (c1 <= c0 || r1 <= r0) continue
      let clash = false
      for (let rr = r0; rr < r1 && !clash; rr++) for (let cc = c0; cc < c1; cc++) if (occupied[rr][cc]) { clash = true; break }
      if (clash) continue // 겹치는 클립(이중 그리기) — 먼저 온 셀 유지
      for (let rr = r0; rr < r1; rr++) for (let cc = c0; cc < c1; cc++) occupied[rr][cc] = true
      out.push({ row: r0, col: c0, rowSpan: r1 - r0, colSpan: c1 - c0, bbox: { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } })
    }
    // 클립이 안 덮은 칸(중첩표 바깥 셀의 잔여 영역 등)은 1×1 빈 셀로 채워 그 자리 글이 표 밖으로 새지 않게 한다
    for (let rr = 0; rr < numRows; rr++) {
      for (let cc = 0; cc < numCols; cc++) {
        if (occupied[rr][cc]) continue
        out.push({ row: rr, col: cc, rowSpan: 1, colSpan: 1, bbox: { x1: colXs[cc], y1: rowYs[rr + 1], x2: colXs[cc + 1], y2: rowYs[rr] } })
      }
    }
    grids.push({
      rowYs, colXs,
      bbox: { x1: colXs[0], y1: rowYs[numRows], x2: colXs[numCols], y2: rowYs[0] },
      vertexRadius: 1,
      cells: out,
    })
  }
  return { grids, containers }
}

/**
 * 클립 정보로 line 그리드 정리 — 같은 표를 두 번 내거나 한 셀의 글을 격자로 썰지 않는다.
 * - 클립 그리드 안에 든 line 그리드: 제거 (실선 내부표는 클립 셀이 이미 담고 있다)
 * - 틀(container) 안에 든 line 그리드: 제거 — 지정서·영치증의 1칸 테두리 틀은 클립상 셀 하나인데,
 *   틀 안 작은 표(발신명의 | 직인)의 괘선이 틀 괘선과 교차해 line 경로가 틀 전체를 3×3 격자로
 *   만들고 본문 문단을 열로 찢는다(영치증 실측: "1. 위 자동차는 자동차세(방세법」…"). 틀 안 글은
 *   문단 경로로 흐르고 작은 표는 클립 그리드가 낸다 — HWP5 파서의 1칸 레이아웃 표 해체와 같은 모양
 */
export function dropGridsInside(lineGrids: TableGrid[], clipGrids: TableGrid[], containers: ClipRect[] = []): TableGrid[] {
  if (clipGrids.length === 0 && containers.length === 0) return lineGrids
  type Box = { x1: number; y1: number; x2: number; y2: number }
  const area = (b: Box): number => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  // "안에 든다" 가 아니라 면적 절반 이상 겹치면 버린다 — 틀 괘선이 위 행들의 외곽선과 이어져
  // line 그리드가 틀보다 위로 뻗는 경우(영치증: 틀 144~668 vs line 그리드 144~766)도 잡는다.
  // 겹친 바깥 부분은 클립 그리드가 이미 셀로 담고 있어 잃는 글이 없다
  const overlapsHalf = (g: Box, b: Box): boolean => {
    const ix = Math.min(g.x2, b.x2) - Math.max(g.x1, b.x1)
    const iy = Math.min(g.y2, b.y2) - Math.max(g.y1, b.y1)
    if (ix <= 0 || iy <= 0) return false
    const ga = area(g)
    return ga > 0 && (ix * iy) / ga >= 0.5
  }
  return lineGrids.filter(g => {
    if (clipGrids.some(c => overlapsHalf(g.bbox, c.bbox))) return false
    if (containers.some(c => overlapsHalf(g.bbox, c))) return false
    return true
  })
}
