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
 * 클립은 묶음이 안 돼 제외된다 — 단 다른 클립을 품는 틀과 틀 안에 홀로 든 클립은 1칸 표다
 * (v4.12.2, 선서문·지정서·영치증 실측). 중첩 관계는 `TableGrid.clipParent` 로 넘겨 소비측이
 * 틀 셀의 `IRCell.blocks` 에 안쪽 표를 넣는다 (HWP 파서 IR 과 같은 모양).
 */

import type { ClipRect } from "./line-extract.js"
import type { ExtractedCell, LineSegment, TableGrid } from "./line-types.js"

/** 이웃 셀 판정 — 변 공유·좌표 클러스터 허용 오차 (pt) */
const CLIP_EDGE_TOL = 1.5
/** 이웃 셀의 공유 변 간격 상한 (pt) — 한컴 PDF 는 같은 표 셀 클립이 변을 정확히 공유한다(코퍼스 16,296쌍
 *  0.05pt 미만, 0.05~0.2pt 1쌍). 그보다 벌어지거나 겹친 사각형은 표 셀이 아니다: 표 캡션 클립은 표 윗변에
 *  0.3pt 겹쳐 깔리고(보도자료 "거래방식별 평균 대금…" 캡션이 5열 병합 첫 행으로 붙던 것), 행간을 두고 쌓인
 *  글줄 클립(자료형 표 셀 안 "BYTE"/"WORD" 0.72pt)·머리말 영역 클립(본문 틀과 1.0pt)도 1.5pt 로 붙이면 머리말+본문
 *  틀이 2×3 가짜 표가 되어 그 안의 실제 표가 중첩으로 묻힌다(행정업무운영 편람 45표 실측) */
const CLIP_ADJ_GAP = 0.15
/** 그리드로 인정하는 최소 셀 수 — 글상자 한두 개짜리 클립은 표가 아님 */
const CLIP_MIN_GROUP = 2
/** 페이지 면적 대비 이 비율 이상인 클립은 페이지/본문 영역 — 셀 아님 */
const CLIP_MAX_PAGE_FRAC = 0.75
/** 셀 최소 치수 (pt) */
/** 걸침 판정 — 상대 클립이 이 비율 넘게, 1-이 비율 못 미치게 들어 있어야 걸침(표 위 덮개). 그 밖은 넘친 안쪽 칸·가장자리 닿음 */
const STRADDLE_MIN = 0.1
/** 제목 아래 틀 판정 — 틀 윗변이 페이지 높이의 이 비율 아래에서 시작해야 한다 (본문 영역 클립은 9~11%, 별표 틀 26~52% 실측) */
const TITLED_FRAME_MIN_TOP = 0.2
/** 제목 아래 틀 판정 — 틀 폭이 페이지 폭의 이 비율 이상 (별표 틀 70~86% 실측, 2단 상자 38% 제외) */
const TITLED_FRAME_MIN_WIDTH = 0.6
/** 머리말 띠 — 이 비율 위의 글(머리말)은 "틀 위 본문 글" 로 세지 않는다 */
const HEADER_BAND = 0.08
const CLIP_MIN_W = 4
/** 가장자리 채움 칸 최소 폭 (pt) — 이보다 가는 채움 사각형은 괘선 */
const NARROW_FILL_MIN_W = 1
const CLIP_MIN_H = 2
/** 획 괘선이 변을 덮는다고 보는 거리(pt)·길이 비율 */
const STROKE_NEAR = 2
const STROKE_COVER = 0.5
/** 묶음 변 중 획 괘선 없는 비율이 이 이상이어야 "테두리 없는 표" — 실선 표는 line 경로에 양보 */
const CLIP_MIN_INVISIBLE = 0

/** 열·행 경계 좌표 묶음 오차 (pt) — 클립 좌표는 원본 셀 경계(HWPUNIT)를 그대로 옮겨, 같은 경계는 0.05pt 안에서
 *  겹치고 원본에서 다른 경계는 0.5pt 차이라도 따로 선다. 원본 표 격자(HWPX colAddr)는 그 미세한 차이를 별도 열로
 *  세므로(주거 유형 표: 211.6/212.5·320.3/321.8/322.3 → 9열) 1.5pt 로 묶으면 열이 합쳐진다(9열 → 6열) */
const CLIP_COORD_TOL = 0.3

const overlap = (a1: number, a2: number, b1: number, b2: number): number => Math.min(a2, b2) - Math.max(a1, b1)

function adjacent(a: ClipRect, b: ClipRect): boolean {
  // 세로변 공유(좌우 이웃) 또는 가로변 공유(상하 이웃) — 겹침이 양수여야 모서리만 닿은 대각 이웃 제외.
  // 같은 표의 이웃 칸은 맞닿은 변과 직각인 변도 하나는 격자선을 같이 쓴다(위아래 이웃은 왼쪽 또는 오른쪽 끝,
  // 좌우 이웃은 윗변 또는 밑변). 표 밑변에 정확히 붙은 주석 상자(※…, 표보다 좌우 1.4pt 넓음)처럼 격자선을
  // 하나도 같이 쓰지 않는 사각형은 표의 칸이 아니다 — 붙이면 가장자리에 폭 1pt 짜리 유령 열이 생긴다
  const al = (u: number, v: number): boolean => Math.abs(u - v) <= CLIP_COORD_TOL
  if ((Math.abs(a.x2 - b.x1) <= CLIP_ADJ_GAP || Math.abs(b.x2 - a.x1) <= CLIP_ADJ_GAP) && overlap(a.y1, a.y2, b.y1, b.y2) > CLIP_EDGE_TOL
    && (al(a.y1, b.y1) || al(a.y2, b.y2))) return true
  if ((Math.abs(a.y2 - b.y1) <= CLIP_ADJ_GAP || Math.abs(b.y2 - a.y1) <= CLIP_ADJ_GAP) && overlap(a.x1, a.x2, b.x1, b.x2) > CLIP_EDGE_TOL
    && (al(a.x1, b.x1) || al(a.x2, b.x2))) return true
  return false
}

/** a 가 b 를 품는가 (중첩표의 바깥 셀 클립) */
function contains(a: ClipRect, b: ClipRect): boolean {
  return b.x1 >= a.x1 - CLIP_EDGE_TOL && b.x2 <= a.x2 + CLIP_EDGE_TOL && b.y1 >= a.y1 - CLIP_EDGE_TOL && b.y2 <= a.y2 + CLIP_EDGE_TOL
    && ((b.x2 - b.x1) < (a.x2 - a.x1) - CLIP_EDGE_TOL || (b.y2 - b.y1) < (a.y2 - a.y1) - CLIP_EDGE_TOL)
}


/** 좌표 클러스터 — 오름차순 정렬 후 CLIP_COORD_TOL 이내는 평균으로 합침 */
function clusterCoords(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => a - b)
  const out: number[] = []
  let run: number[] = []
  for (const v of sorted) {
    if (run.length > 0 && v - run[run.length - 1] > CLIP_COORD_TOL) { out.push(run.reduce((s, x) => s + x, 0) / run.length); run = [] }
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
  /** 다음 쪽 판정에 넘길 이 쪽 사실 — 쪽 넘김 이어짐(continues) */
  page: ClipPage
}

/** 쪽 넘김 이어짐 판정에 쓰는 한 쪽의 클립 사실 */
export interface ClipPage {
  /** 이 쪽의 마지막 내용인 최상위 표 칸(그 아래엔 꼬리말 띠 글만) — 다음 쪽 첫 클립이 이 칸의 이어짐인지 가른다 */
  lastCells: ClipRect[]
  /** 이 쪽의 클립(중복 제거) — 다음 쪽 첫 클립과 같은 사각형이 있으면 쪽마다 같은 자리에 놓인 틀 요소(절 제목 띠)다 */
  clips: ClipRect[]
}

/** 쪽 넘김 이어짐 — 앞 쪽 칸과 이 쪽 클립의 좌우 변이 이 거리(pt) 안에서 같아야 한 칸. 한컴은 같은 칸을 쪽마다 같은 좌표로
 *  깐다(거대 칸 48쪽·규제영향분석서 이어짐 전부 0.01pt 안). 이웃 쪽의 다른 상자("5 | 시험 방법" 머리 상자, 0.12pt 차)는 가른다 */
const CONT_X_TOL = 0.1

export function buildClipCellGrids(
  rects: ClipRect[],
  strokedH: LineSegment[],
  strokedV: LineSegment[],
  pageWidth: number,
  pageHeight: number,
  textPoints: ReadonlyArray<{ x: number; y: number }> = [],
  fillRects: ClipRect[] = [],
  /** 바로 앞 쪽의 클립 사실(앞 쪽 결과의 page) — 없으면 쪽 넘김 이어짐을 보지 않는다 */
  prev: ClipPage = { lastCells: [], clips: [] },
): ClipCellResult {
  const pageArea = pageWidth * pageHeight
  const sameRect = (a: ClipRect, b: ClipRect): boolean =>
    Math.abs(a.x1 - b.x1) <= CLIP_EDGE_TOL && Math.abs(a.x2 - b.x2) <= CLIP_EDGE_TOL && Math.abs(a.y1 - b.y1) <= CLIP_EDGE_TOL && Math.abs(a.y2 - b.y2) <= CLIP_EDGE_TOL
  // 같은 사각형은 셀 안 문단마다 반복 클립된다(틀 3회·선서문 안쪽 1칸 표 2회 실측) — 좌표로 중복 제거.
  // 중복을 남기면 1칸 표가 서로 이웃도 포함도 아닌 단독 클립 여러 개로 흩어져 묶이지 않는다
  const cells: ClipRect[] = []
  // x1·y1 근처만 비교한다. 반복 클립이 많은 쪽에서 전체 선행 셀을 다시 훑지 않는다.
  const buckets = new Map<number, Map<number, ClipRect[]>>()
  for (const r of rects) {
    if ((r.x2 - r.x1) < CLIP_MIN_W || (r.y2 - r.y1) < CLIP_MIN_H) continue
    if (pageArea > 0 && (r.x2 - r.x1) * (r.y2 - r.y1) >= pageArea * CLIP_MAX_PAGE_FRAC) continue
    const bx = Math.floor(r.x1 / CLIP_EDGE_TOL), by = Math.floor(r.y1 / CLIP_EDGE_TOL)
    let duplicate = false
    for (let dx = -1; dx <= 1 && !duplicate; dx++) {
      const ys = buckets.get(bx + dx)
      for (let dy = -1; dy <= 1 && !duplicate; dy++) {
        duplicate = ys?.get(by + dy)?.some(c => sameRect(c, r)) ?? false
      }
    }
    if (duplicate) continue
    cells.push(r)
    let ys = buckets.get(bx)
    if (!ys) { ys = new Map(); buckets.set(bx, ys) }
    const row = ys.get(by)
    if (row) row.push(r)
    else ys.set(by, [r])
  }
  if (cells.length < 1) return { grids: [], containers: [], page: { lastCells: [], clips: [] } }

  // 포함 관계로 층을 나눈다 — 각 사각형의 부모 = 자기를 품는 가장 작은 사각형. 중첩표 셀은 바깥
  // 셀 안에 있으므로 같은 부모(그 바깥 셀)끼리만 묶이고, 바깥 셀은 자기 층(최상위 또는 그 위 셀)의
  // 이웃과 묶인다. 이렇게 하면 지정서·영치증의 1칸 틀도 위 제목행·아래 꼬리행과 한 표의 셀이 되고
  // (HWP 파서가 내는 1열 표와 같은 모양), 안쪽 "발신명의 | 직인" 표는 자기들끼리 별도 그리드가 된다.
  // 틀 안 자유 문단이 바깥 격자의 채움 셀로 찢기지 않고, 클러스터 표 감지에 걸려 가짜 다열 표가
  // 되지도 않는다 (영치증 "성 명:/주 소:" 실측)
  const parent = new Array<number>(cells.length).fill(-1)
  const area = (r: ClipRect): number => (r.x2 - r.x1) * (r.y2 - r.y1)
  // 다른 클립과 걸쳐 겹치는(교차하되 서로 품지 않는) 사각형은 부모가 못 된다 — 한 표의 칸끼리는 겹치지 않으므로 이런
  // 사각형은 표 위에 얹힌 그림·글상자다. 이것이 우연히 품은 칸들을 자식으로 삼으면 한 표가 그 테두리에서 층이 갈려 둘로
  // 쪼개진다: 복학원서 워터마크 그림(371pt 정사각)이 4×4 서명란 가운데 두 열만 품어 4×1·4×2·2×1 로, 결재문서 결문표
  // 아래쪽 10행을 덮은 빈 1칸 표(발신명의 행 중간까지)가 12×39 를 2×3·10×36 으로 갈랐다. 교차 폭은 두 축 다 CLIP_EDGE_TOL
  // 넘게 — 변을 맞댄 이웃·표 윗변에 0.3pt 겹쳐 깔리는 캡션 클립은 걸침이 아니다. b 가 a 안에 대부분(90% 넘게) 들었거나 거의 안
  // 들었으면(10% 미만) 걸침이 아니라 칸 폭을 조금 넘친 안쪽 표의 칸이다 — 공문 작성 안내서 "참고 | 첨부물 표시" 칩이 제 칸보다
  // 5.9pt 넓어 옆 칸에 걸친 것까지 걸침으로 보면 칩이 칸을 잃고 따로 표가 된다
  const straddles = (a: ClipRect, b: ClipRect): boolean => {
    const ix = overlap(a.x1, a.x2, b.x1, b.x2), iy = overlap(a.y1, a.y2, b.y1, b.y2)
    if (ix <= CLIP_EDGE_TOL || iy <= CLIP_EDGE_TOL || contains(a, b) || contains(b, a)) return false
    const inside = (ix * iy) / area(b)
    return inside > STRADDLE_MIN && inside < 1 - STRADDLE_MIN
  }
  const canParent = cells.map((a, i) => !cells.some((b, j) => i !== j && straddles(a, b)))
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      // 부모는 면적이 엄격히 큰 사각형만 — 포함 판정에 오차가 있어 비슷한 크기끼리는 서로를 품을 수 있고, 그러면 부모 사슬이 고리가 된다
      if (i === j || !canParent[j] || area(cells[j]) <= area(cells[i]) || !contains(cells[j], cells[i])) continue
      const cur = parent[i]
      if (cur < 0 || contains(cells[cur], cells[j])) parent[i] = j
    }
  }
  const ruledGaps = findRuledGaps(cells, parent, strokedH, strokedV)
  const isContainer = new Array<boolean>(cells.length).fill(false)
  for (const p of parent) if (p >= 0) isContainer[p] = true
  // 표 겉 클립 — 글자처럼 놓인 표는 칸 클립들 바깥에 표 테두리와 같은 사각형 클립이 하나 더 깔린다(행정업무운영
  // 편람 Q&A 상자 6×5 55개 실측). 틀로 보면 1×1 틀이 글을 다 가져가고 안쪽 표는 빈 표로 버려진다 — 자식 클립들을 합친
  // 테두리가 자기 사각형과 좌표 오차 안에서 같으면 틀이 아니라 그 표의 겉 클립이라 셀로 쓰지 않는다. 단 맞닿은 이웃이 모두 같은
  // 겉 클립 후보일 때만(위아래로 붙은 상자들) — 보통 칸이 이웃이면 여백 없이 중첩표를 품은 표의 칸이라 구멍을 내면 안 된다
  const tileParent = new Array<boolean>(cells.length).fill(false)
  const tableClip = new Array<boolean>(cells.length).fill(false)
  for (let p = 0; p < cells.length; p++) {
    if (!isContainer[p]) continue
    let n = 0, x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity
    for (let i = 0; i < cells.length; i++) {
      if (parent[i] !== p) continue
      const k = cells[i]
      n++
      x1 = Math.min(x1, k.x1); y1 = Math.min(y1, k.y1); x2 = Math.max(x2, k.x2); y2 = Math.max(y2, k.y2)
    }
    if (n < CLIP_MIN_GROUP) continue
    const c = cells[p]
    // 겉 클립은 칸 클립 묶음과 좌표까지 같다 — 틀 셀은 안쪽 여백(1.4pt 실측, 결재란 품은 마지막 행)만큼 벌어진다
    if (Math.max(Math.abs(x1 - c.x1), Math.abs(x2 - c.x2), Math.abs(y1 - c.y1), Math.abs(y2 - c.y2)) <= CLIP_COORD_TOL) tileParent[p] = true
  }
  for (let p = 0; p < cells.length; p++) {
    if (tileParent[p]) tableClip[p] = !cells.some((q, i) => i !== p && parent[i] === parent[p] && !tileParent[i] && adjacent(q, cells[p]))
  }
  /** 안쪽 표를 받을 부모 — 표 겉 클립과, 셀도 틀도 아닌 감싸개 클립(칸 안쪽 여백·글상자 클립: 쪽을 넘어온 큰 칸 안의
   *  단위 표들, 규제영향분석서 실측)은 건너뛰고 그것을 품은 셀·틀에 넣는다 */
  const effParent = (i: number): number => {
    let p = parent[i]
    for (let steps = 0; p >= 0 && steps <= cells.length; steps++) { // 면적이 커지는 사슬이라 고리는 없지만 걸음 수도 묶어 둔다
      if (!tableClip[p] && (isGridMember(p) || loneFrame(p) || continues(p))) return p
      p = parent[p]
    }
    return -1
  }
  // 연결 컴포넌트 (같은 층의 변 공유 이웃). 변 좌표가 가까운 사각형만 후보로 뽑는다.
  // 셀이 많은 쪽에서도 서로 멀리 있는 모든 쌍을 비교하지 않는다.
  const root = cells.map((_, i) => i)
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i] } return i }
  const edgeBin = (v: number): number => Math.floor(v / CLIP_ADJ_GAP)
  const startsX = new Map<number, number[]>(), endsX = new Map<number, number[]>()
  const startsY = new Map<number, number[]>(), endsY = new Map<number, number[]>()
  const addEdge = (map: Map<number, number[]>, v: number, i: number): void => {
    const k = edgeBin(v), row = map.get(k)
    if (row) row.push(i)
    else map.set(k, [i])
  }
  for (let i = 0; i < cells.length; i++) {
    addEdge(startsX, cells[i].x1, i); addEdge(endsX, cells[i].x2, i)
    addEdge(startsY, cells[i].y1, i); addEdge(endsY, cells[i].y2, i)
  }
  for (let i = 0; i < cells.length; i++) {
    if (tableClip[i]) continue
    const candidates = new Set<number>()
    const near = (map: Map<number, number[]>, v: number): void => {
      const k = edgeBin(v)
      for (let d = -1; d <= 1; d++) for (const j of map.get(k + d) ?? []) if (j > i) candidates.add(j)
    }
    near(startsX, cells[i].x2); near(endsX, cells[i].x1)
    near(startsY, cells[i].y2); near(endsY, cells[i].y1)
    for (const j of [...candidates].sort((a, b) => a - b)) {
      if (tableClip[j] || parent[i] !== parent[j]) continue
      if (adjacent(cells[i], cells[j])) { const ra = find(i), rb = find(j); if (ra !== rb) root[ra] = rb }
    }
  }
  // 괘선 틈을 사이에 둔 이웃(셀 간격 표·짧은 칸 클립)도 한 표 — 좌표는 격자를 만들 때 닫는다(closeGaps)
  for (const g of ruledGaps) {
    if (tableClip[g.i] || tableClip[g.j]) continue
    const ra = find(g.i), rb = find(g.j)
    if (ra !== rb) root[ra] = rb
  }
  const groups = new Map<number, number[]>()
  for (let i = 0; i < cells.length; i++) {
    const r = find(i)
    const g = groups.get(r)
    if (g) g.push(i)
    else groups.set(r, [i])
  }
  const containers: ClipRect[] = cells.filter((_, i) => isContainer[i])
  const groupSize = (i: number): number => groups.get(find(i))?.length ?? 0
  const isGridMember = (i: number): boolean => groupSize(i) >= CLIP_MIN_GROUP
  // 네 변이 모두 획 괘선인 사각형 — 서식의 1칸 틀(지정서·영치증·선서문 실측). 한컴은 본문 영역
  // (여백 안쪽 전체)에도 클립을 깔고 그 안에 페이지의 모든 표가 들어가므로, 획 없는 큰 컨테이너를
  // 틀로 보면 페이지가 통째로 1×1 표가 된다 (채용공고 PDF 실측 회귀) — 획 4변을 요구해 가른다
  const framed = (r: ClipRect): boolean =>
    edgeStroked(strokedH, "h", r.y1, r.x1, r.x2) && edgeStroked(strokedH, "h", r.y2, r.x1, r.x2)
    && edgeStroked(strokedV, "v", r.x1, r.y1, r.y2) && edgeStroked(strokedV, "v", r.x2, r.y1, r.y2)
  // 테두리 없는 1칸 틀(별표·선서문 바깥 틀) 과 본문 영역 클립의 구분 — 문서 단위 반복 통계는 반증됐다
  // (v4.12.3 실측: 채용공고 본문 영역 클립은 페이지마다 y1 이 73~91 로 달라 같은 사각형이 아니고, 별표는
  // 1쪽짜리라 반복 자체가 없다). 대신 기하로 가른다: 본문 영역은 여백 바로 안쪽(y1 ≈ 9~11%)에서 시작해
  // 머리말·쪽번호 말고는 바깥에 글이 없지만, 별표 틀은 제목("■ ○○법 [별표 N]"·별표명) 아래(y1 26~52%)
  // 에서 시작해 그 위에 본문 글이 있다. 위쪽 머리말 띠(8%)를 뺀 곳에 글이 있고 틀 안에도 글이 있어야 한다
  // 폭 조건: 별표 틀은 본문 폭 대부분(70~86%)을 차지한다 — 2단 채용공고의 단 상자(폭 38%, pair06)는 제외
  const titledFrame = (r: ClipRect): boolean =>
    r.y1 >= pageHeight * TITLED_FRAME_MIN_TOP
    && (r.x2 - r.x1) >= pageWidth * TITLED_FRAME_MIN_WIDTH
    && textPoints.some(p => p.y < r.y1 && p.y > pageHeight * HEADER_BAND && p.x >= r.x1 - CLIP_EDGE_TOL && p.x <= r.x2 + CLIP_EDGE_TOL)
    && textPoints.some(p => p.x > r.x1 && p.x < r.x2 && p.y > r.y1 && p.y < r.y2)
  /** 홀로 선 틀 — 다른 클립을 품고, 그리드 멤버가 아니며, 테두리가 그려져 있거나 제목 아래 틀이다 */
  const loneFrame = (i: number): boolean => isContainer[i] && !isGridMember(i) && (framed(cells[i]) || titledFrame(cells[i]))
  const headY = pageHeight * (1 - HEADER_BAND)
  /** 앞 쪽에서 넘어온 칸의 이어짐이면 그 앞 쪽 칸 — 한컴은 쪽을 넘는 칸을 쪽마다 그 쪽에 그려진 부분만 클립으로 깔아, 뒤 쪽
   *  조각은 이웃 없는 홀로 선 클립이 된다. 테두리 없는 표(경사형 휠체어리프트 기준 5×1 의 본문 칸이 47쪽을 넘음)는 틀로도
   *  안 잡혀 그 안의 표들이 칸을 잃고 최상위로 빠졌다. 앞 쪽 마지막 내용인 칸과 좌우 변이 같고(CONT_X_TOL) 이 쪽 첫 내용인
   *  최상위 클립(그 위엔 머리말 띠 글만)만 이어짐으로 본다 — 쪽 첫머리에 서식 번호 "(서식 5)" 가 붙은 다음 서식 틀은 가른다.
   *  앞 쪽에도 같은 사각형이 있으면(앞 칸 자신 말고) 쪽마다 같은 자리에 놓인 절 제목 띠다(공문 작성 안내서 "[2]"·"[3]" 띠가
   *  앞 쪽 마지막 틀과 폭이 같아 그 틀에 붙던 것) */
  const continues = (i: number): ClipRect | undefined => {
    if (!prev.lastCells.length || parent[i] >= 0 || tableClip[i] || isGridMember(i)) return undefined
    const c = cells[i]
    const from = prev.lastCells.find(b => Math.abs(b.x1 - c.x1) <= CONT_X_TOL && Math.abs(b.x2 - c.x2) <= CONT_X_TOL)
    if (!from) return undefined
    if (prev.clips.some(k => sameRect(k, c) && !sameRect(k, from))) return undefined
    if (textPoints.some(p => p.y > c.y2 && p.y < headY)) return undefined
    if (cells.some(o => o.y1 >= c.y2 - CLIP_EDGE_TOL && (o.y1 + o.y2) / 2 < headY)) return undefined
    return from
  }
  /** 이 클립의 부모가 안쪽 표를 받을 수 있는 셀인가 — 그리드의 셀이거나 홀로 선 틀 */
  const parentAttachable = (i: number): boolean => effParent(i) >= 0
  /** 부모 안에 이 클립 하나뿐인가 — 테두리 없는 바깥 틀 안에 테두리 있는 1칸 표 하나(선서문·서약서류).
   *  테두리 없는 틀은 본문 영역 클립과 구분이 안 돼 표로 못 삼지만, 그 안에 상자 하나만 있는 꼴은
   *  본문 영역(칩·표가 여럿)과 다르다 — 안쪽 상자만이라도 1×1 표로 낸다 */
  const onlyChild = (i: number): boolean => parent[i] >= 0 && parent.filter(p => p === parent[i]).length === 1
  const grids: TableGrid[] = []
  for (const idxs of groups.values()) {
    const first = idxs[0]
    if (tableClip[first]) continue
    const parentRect = parentAttachable(first) ? cells[effParent(first)] : undefined
    if (idxs.length < CLIP_MIN_GROUP) {
      // 이웃 없는 단독 클립은 원칙적으로 표가 아니다(글상자·그림·머리말·본문 영역). 예외 두 가지 —
      // 1칸 틀: ① 다른 클립을 품고 테두리가 그려진 틀(선서문·각서류의 바깥 1칸 표) ② 그런 틀 안에
      // 홀로 든 테두리 있는 클립(그 안의 1칸 표). 둘 다 HWP 에서는 1×1 표이고 안에 문단·표가 층으로
      // 들어 있다 — 1×1 그리드로 내서 소비측이 틀 셀의 blocks 에 안쪽 표를 넣게 한다. 앞 쪽 칸의 이어짐도 1칸 조각으로
      // 내고 표시해 둔다 — 문서 단계(mergeContinuedCells)가 앞 쪽 그 칸에 붙인다
      const from = continues(first)
      if (!from && !loneFrame(first) && !((parentRect || onlyChild(first)) && framed(cells[first]))) continue
      const r = cells[first]
      grids.push({
        rowYs: [r.y2, r.y1], colXs: [r.x1, r.x2],
        bbox: { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 },
        vertexRadius: 1,
        cells: [{ row: 0, col: 0, rowSpan: 1, colSpan: 1, bbox: { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 } }],
        ...(parentRect ? { clipParent: parentRect } : {}),
        ...(from ? { continues: from } : {}),
      })
      continue
    }
    const gs = ruledGaps.filter(g => find(g.i) === find(first))
    const members = gs.length ? closeGaps(idxs.map(i => cells[i]), gs) : idxs.map(i => cells[i])

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
        out.push({ row: rr, col: cc, rowSpan: 1, colSpan: 1, bbox: { x1: colXs[cc], y1: rowYs[rr + 1], x2: colXs[cc + 1], y2: rowYs[rr] }, filler: true })
      }
    }
    addNarrowEdgeCols(colXs, rowYs, out, fillRects)
    grids.push({
      rowYs, colXs,
      bbox: { x1: colXs[0], y1: rowYs[numRows], x2: colXs[colXs.length - 1], y2: rowYs[0] },
      vertexRadius: 1,
      cells: out,
      ...(parentRect ? { clipParent: parentRect } : {}),
    })
  }
  // 이 쪽 마지막 내용인 최상위 칸 — 가장 낮은 칸들이고, 그 아래엔 꼬리말 띠(HEADER_BAND) 글·클립만 있어야 한다. 본문 영역
  // 클립(채용공고: 쪽마다 본문 전체를 감싼 클립) 안의 칸은 좌우 변이 같은 그 클립에 싸여 있어 빼낸다 — 다음 쪽 본문 영역
  // 클립이 쪽 전체를 이어짐으로 삼키지 않게
  const tops = grids.filter(g => !g.clipParent).flatMap(g => g.cells!.filter(c => !c.filler).map(c => c.bbox))
  let lastCells: ClipRect[] = []
  if (tops.length) {
    const bottom = Math.min(...tops.map(b => b.y1))
    const footY = pageHeight * HEADER_BAND
    const below = (y: number): boolean => y < bottom - CLIP_EDGE_TOL && y > footY
    if (!textPoints.some(p => below(p.y)) && !cells.some(o => o.y2 < bottom && below((o.y1 + o.y2) / 2))) {
      lastCells = tops.filter(b => Math.abs(b.y1 - bottom) <= CLIP_COORD_TOL
        && !cells.some(k => Math.abs(k.x1 - b.x1) <= CONT_X_TOL && Math.abs(k.x2 - b.x2) <= CONT_X_TOL && k.y2 > b.y2 + CLIP_EDGE_TOL && contains(k, b)))
    }
  }
  return { grids, containers, page: { lastCells, clips: cells } }
}

/** 괘선 그어진 틈의 최대 폭 (pt) — 셀 간격 표(행정업무운영 편람 설계 기준 표 1.92~2.52pt)·아래 여백만큼 짧은 칸 클립
 *  (결재문서 문서번호 표 1.32~1.44pt) 실측 */
const CLIP_SPACING_MAX = 3

/** 괘선 틈 쌍 — 두 클립(i 가 위·왼쪽), 축, 양끝 좌표(y 틈의 lo 는 아래 칸 윗변·hi 는 위 칸 밑변), 두 클립이 겹친 직각 구간 e1~e2,
 *  괘선으로 본 닫을 좌표(ruleEnd) */
interface RuledGap { i: number; j: number; axis: "x" | "y"; lo: number; hi: number; e1: number; e2: number; to: number; both: boolean }

/**
 * 괘선이 그어진 좁은 틈을 사이에 둔 같은 층 이웃 클립 쌍 — 한 표의 칸으로 묶는다(좌표는 격자를 만들 때 closeGaps 가 닫는다).
 * 한컴은 셀 간격(cellSpacing)이 있는 표는 칸 클립 사이를 그만큼 띄우고, 결재문서 문서번호 표(4×2)는 칸 클립을 아래 여백
 * (1.41pt)만큼 짧게 깐다. 변 공유(CLIP_ADJ_GAP 0.15pt)로는 이웃이 안 돼 칸마다 홀로 떨어져, 문서번호 표는 행마다 1×2 표로
 * 흩어지고 설계 기준 표는 획 경로가 내면서 칸 안 서식 예시(4×7)가 제자리를 잃고 1칸 틀로 따로 나갔다.
 * 틈 쌍은 틈이 비어 있어야 한다(다른 클립이 없음 — 높이 2.76pt 짜리 진짜 빈 행을 틈으로 먹지 않게, 신구조문대비표 실측).
 *  ① 직각 두 변이 다 맞고 틈 한쪽 끝(칸 클립 변)에 겹친 폭의 절반 이상을 덮는 괘선이 그어진 쌍 — 표의 틈 폭을 확인한다.
 *  ② 괘선이 있거나 직각 두 변이 다 맞는 쌍 가운데, 틈 폭이 ①로 확인한 묶음의 틈 폭과 같은(0.3pt 안) 쌍 — 셀 간격은 가로세로 같은
 *     값이다. 머리 칸 아래 여러 칸(직각 변 한쪽만 맞음, 정책연구 주체별 역할 표)과 세로 테두리를 안 그린 셀 간격 표(응시번호 3×4 가
 *     열마다 3×1 로 갈리던 것)를 잇는다. 직각 변이 한쪽만 맞는 쌍은 같은 축 틈 폭만 보증한다 — 조직도 상자 사이 2.88pt 가로 틈이
 *     3pt 아래 다른 표와의 세로 틈을 잇지 않게(mel-001).
 * 괘선 없는 틈(칸 안 글줄 클립 0.72pt, 머리말 영역과 본문 틀 1.0pt)은 종전대로 가른다.
 */
function findRuledGaps(cells: ClipRect[], parent: number[], strokedH: LineSegment[], strokedV: LineSegment[]): RuledGap[] {
  const al = (u: number, v: number): boolean => Math.abs(u - v) <= CLIP_COORD_TOL
  /** 틈 사각형 안에 같은 층 다른 클립이 있는가 */
  const occupied = (i: number, j: number, x1: number, y1: number, x2: number, y2: number): boolean =>
    cells.some((k, n) => n !== i && n !== j && parent[n] === parent[i] && overlap(k.x1, k.x2, x1, x2) > CLIP_ADJ_GAP && overlap(k.y1, k.y2, y1, y2) > CLIP_ADJ_GAP)
  /** i·j 사이 틈 — 세로(i 위 j 아래)·가로(i 왼쪽 j 오른쪽) 가운데 조건 맞는 것 */
  const gapBetween = (i: number, j: number): RuledGap | undefined => {
    const a = cells[i], b = cells[j]
    const gv = a.y1 - b.y2
    if (gv > CLIP_ADJ_GAP && gv <= CLIP_SPACING_MAX && overlap(a.x1, a.x2, b.x1, b.x2) > CLIP_EDGE_TOL && (al(a.x1, b.x1) || al(a.x2, b.x2))
      && !occupied(i, j, Math.max(a.x1, b.x1), b.y2, Math.min(a.x2, b.x2), a.y1)) {
      const e1 = Math.max(a.x1, b.x1), e2 = Math.min(a.x2, b.x2)
      return { i, j, axis: "y", lo: b.y2, hi: a.y1, e1, e2, ...ruleEnd(strokedH, "h", b.y2, a.y1, e1, e2) }
    }
    const gh = b.x1 - a.x2
    if (gh > CLIP_ADJ_GAP && gh <= CLIP_SPACING_MAX && overlap(a.y1, a.y2, b.y1, b.y2) > CLIP_EDGE_TOL && (al(a.y1, b.y1) || al(a.y2, b.y2))
      && !occupied(i, j, a.x2, Math.max(a.y1, b.y1), b.x1, Math.min(a.y2, b.y2))) {
      const e1 = Math.max(a.y1, b.y1), e2 = Math.min(a.y2, b.y2)
      return { i, j, axis: "x", lo: a.x2, hi: b.x1, e1, e2, ...ruleEnd(strokedV, "v", a.x2, b.x1, e1, e2) }
    }
    return undefined
  }
  /** 틈 한쪽 끝(0.5pt 안)에 e1~e2 의 절반 이상을 덮는 괘선이 있는가 — 칸 테두리는 칸 클립 변에 그어진다. 틈 한가운데 뜬 괘선은
   *  글줄마다 클립을 까는 PDF 의 줄 사이 표 괘선이다(Microsoft Print To PDF 성과보고서: 행 괘선이 위아래 글줄 클립 사이 0.72pt 안쪽 —
   *  잇으면 "업무(①-1)" 의 ① 글줄들이 세로 1열 표로 빠져나갔다) */
  const ruled = (g: RuledGap): boolean => (g.axis === "y" ? strokedH : strokedV).some(l => {
    const pos = g.axis === "y" ? l.y1 : l.x1
    return (Math.abs(pos - g.lo) <= 0.5 || Math.abs(pos - g.hi) <= 0.5)
      && (g.axis === "y" ? overlap(l.x1, l.x2, g.e1, g.e2) : overlap(l.y1, l.y2, g.e1, g.e2)) >= (g.e2 - g.e1) * STROKE_COVER
  })
  const root = cells.map((_, i) => i)
  const find = (i: number): number => { while (root[i] !== i) { root[i] = root[root[i]]; i = root[i] } return i }
  const found: RuledGap[] = []
  /** 묶음 뿌리 → 확인된 틈 (축·폭) */
  const widths = new Map<number, Array<{ axis: "x" | "y"; w: number }>>()
  const link = (g: RuledGap): void => {
    found.push(g)
    const ri = find(g.i), rj = find(g.j)
    const w = [...(widths.get(rj) ?? []), ...(ri !== rj ? widths.get(ri) ?? [] : []), { axis: g.axis, w: g.hi - g.lo }]
    root[ri] = rj
    widths.set(rj, w)
  }
  const cand: Array<[RuledGap, boolean]> = []
  for (let i = 0; i < cells.length; i++) {
    for (let j = 0; j < cells.length; j++) {
      if (i === j || parent[i] !== parent[j]) continue
      const g = gapBetween(i, j)
      if (!g) continue
      const a = cells[i], b = cells[j]
      const both = g.axis === "y" ? al(a.x1, b.x1) && al(a.x2, b.x2) : al(a.y1, b.y1) && al(a.y2, b.y2)
      const isRuled = ruled(g)
      if (both && isRuled) link(g)
      else if (both || isRuled) cand.push([g, both])
    }
  }
  if (!found.length) return []
  // ② 확인된 틈 폭과 같은 틈 — 이은 묶음이 다시 다른 쌍을 보증할 수 있어 더 늘지 않을 때까지
  for (let grew = true; grew;) {
    grew = false
    for (let k = cand.length - 1; k >= 0; k--) {
      const [g, both] = cand[k], w = g.hi - g.lo
      if (![find(g.i), find(g.j)].some(r => (widths.get(r) ?? []).some(s => (both || s.axis === g.axis) && Math.abs(s.w - w) <= CLIP_COORD_TOL))) continue
      link(g)
      cand.splice(k, 1)
      grew = true
    }
  }
  return found
}

/** 틈을 닫을 좌표 — 겹친 폭 e1~e2 의 절반 이상을 덮는 괘선이 한쪽 끝(0.5pt 안)에만 있으면 그 끝(행 경계는 괘선 자리 — 문서번호 표는
 *  아래 칸 윗변), 양끝·없음이면 가운데(칸마다 제 테두리를 그리는 셀 간격 표) */
function ruleEnd(lines: LineSegment[], dir: "h" | "v", lo: number, hi: number, e1: number, e2: number): { to: number; both: boolean } {
  const at = (p: number): boolean => lines.some(l =>
    Math.abs((dir === "h" ? l.y1 : l.x1) - p) <= 0.5 && (dir === "h" ? overlap(l.x1, l.x2, e1, e2) : overlap(l.y1, l.y2, e1, e2)) >= (e2 - e1) * STROKE_COVER)
  const atLo = at(lo), atHi = at(hi)
  return { to: atLo && !atHi ? lo : atHi && !atLo ? hi : (lo + hi) / 2, both: atLo && atHi }
}

/**
 * 한 표(묶음) 칸들의 괘선 틈을 닫은 사본 — 같은 틈(축·양끝)의 쌍들을 한 줄로 모아(직각 구간은 합친 범위), 그 범위에 걸치거나 셀 간격
 * 하나 거리로 이어진 칸 가운데 틈 끝에 선 변을 한 좌표로 옮긴다. 쌍을 못 이룬 칸(병합 칸, 쪽 넘김으로 옆 칸 클립이 없는 칸)의 변도
 * 같은 경계가 된다 — 옮긴 변과
 * 안 옮긴 변이 따로 서면 유령 열·행이 생긴다(관인 종류 표 9×3 → 9×7, 설계 기준 표 5×2 → 5×3). 닫을 좌표는 이 표 안에서 틈
 * 없이 맞닿은 칸들이 이미 그 끝을 경계로 쓰면 그 끝(조직도 하단: 한 열에서만 아래 칸이 1.08pt 짧음 — 다른 열의 경계와 같은
 * 좌표여야 유령 행이 없다), 아니면 괘선 자리(ruleEnd)
 */
function closeGaps(members: ClipRect[], gaps: RuledGap[]): ClipRect[] {
  const al = (u: number, v: number): boolean => Math.abs(u - v) <= CLIP_COORD_TOL
  const lines: Array<{ axis: "x" | "y"; lo: number; hi: number; e1: number; e2: number; to: number; both: boolean }> = []
  for (const g of gaps) {
    const l = lines.find(k => k.axis === g.axis && al(k.lo, g.lo) && al(k.hi, g.hi))
    if (l) { l.e1 = Math.min(l.e1, g.e1); l.e2 = Math.max(l.e2, g.e2); l.both &&= g.both } else lines.push({ ...g })
  }
  const spacing = gaps.some(g => g.axis === "x") && gaps.some(g => g.axis === "y")
  // 실제 빈 열은 같은 좁은 틈이 표 높이 대부분의 여러 행에서 반복된다(정답 17×11: 6행,
  // 27×5: 19~24행). 독립 상자 사이의 시각적 간격은 한 번뿐이다(창원·조직도·머리표).
  // 한 축의 양끝 괘선만으로 빈 행까지 추정하지 않는다.
  const repeatedBlankColumn = (l: typeof lines[number]): boolean => {
    if (spacing || l.axis !== "x" || !l.both) return false
    const spans = gaps.filter(g => g.axis === "x" && al(g.lo, l.lo) && al(g.hi, l.hi))
      .map(g => [g.e1, g.e2] as const).sort((a, b) => a[0] - b[0])
    if (spans.length < 3) return false
    let covered = 0, end = -Infinity, distinct = 0
    for (const [lo, hi] of spans) {
      if (hi <= end + CLIP_COORD_TOL) continue
      covered += hi - Math.max(lo, end)
      end = hi
      distinct++
    }
    const height = Math.max(...members.map(r => r.y2)) - Math.min(...members.map(r => r.y1))
    return distinct >= 3 && covered >= height * 0.65
  }
  const out = members.map(r => ({ ...r }))
  for (const l of lines) {
    // 틈 없이 맞닿은 칸 쌍이 틈 한쪽 끝을 경계로 쓰는가 (y: 위 칸 밑변 = 아래 칸 윗변)
    const shared = (p: number): boolean => members.some(u => members.some(v => u !== v
      && (l.axis === "y"
        ? Math.abs(u.y1 - v.y2) <= CLIP_ADJ_GAP && al(u.y1, p) && overlap(u.x1, u.x2, v.x1, v.x2) > CLIP_EDGE_TOL
        : Math.abs(u.x2 - v.x1) <= CLIP_ADJ_GAP && al(u.x2, p) && overlap(u.y1, u.y2, v.y1, v.y2) > CLIP_EDGE_TOL)))
    const atLo = shared(l.lo), atHi = shared(l.hi)
    if (repeatedBlankColumn(l) && !atLo && !atHi) continue
    const to = atLo && !atHi ? l.lo : atHi && !atLo ? l.hi : l.to
    // 틈 끝에 선 칸 — 틈 줄 범위에 걸치거나 셀 간격 하나 거리로 이어지는 칸까지 (옆 열이 셀 간격만큼 떨어져 있고 그 열 칸의 짝이
    // 쪽 넘김으로 없어도 같은 행 경계다: 설계 기준 표 "구분" 칸)
    const onEdge = (r: ClipRect): boolean => l.axis === "y" ? al(r.y2, l.lo) || al(r.y1, l.hi) : al(r.x2, l.lo) || al(r.x1, l.hi)
    const span = (r: ClipRect): [number, number] => l.axis === "y" ? [r.x1, r.x2] : [r.y1, r.y2]
    const take = new Set<number>()
    for (let grew = true; grew;) {
      grew = false
      for (let n = 0; n < members.length; n++) {
        if (take.has(n) || !onEdge(members[n])) continue
        const [a1, a2] = span(members[n])
        if (overlap(a1, a2, l.e1, l.e2) <= -(CLIP_SPACING_MAX + CLIP_COORD_TOL)) continue
        take.add(n)
        l.e1 = Math.min(l.e1, a1); l.e2 = Math.max(l.e2, a2)
        grew = true
      }
    }
    for (const n of take) {
      const r = members[n], s = out[n]
      if (l.axis === "y") {
        if (al(r.y2, l.lo)) s.y2 = to
        if (al(r.y1, l.hi)) s.y1 = to
      } else {
        if (al(r.x2, l.lo)) s.x2 = to
        if (al(r.x1, l.hi)) s.x1 = to
      }
    }
  }
  return out
}

/**
 * 격자 왼끝·오른끝에 붙은 좁은 채움 사각형을 열로 더한다 (colXs·셀 목록 제자리 수정). 한컴은 폭 CLIP_MIN_W 미만의
 * 빈 칸에는 셀 클립을 깔지 않고 배경 채움만 그려(행정업무운영 편람 머리 상자 "1 | 제목" 양옆 2.9pt 회색 띠 54개 실측),
 * 원본 표의 가장자리 열이 격자에서 빠진다. 채움이 격자 끝에 맞붙고 위아래 변이 행 경계와 맞을 때만 그 표의 칸으로 본다.
 */
function addNarrowEdgeCols(colXs: number[], rowYs: number[], out: ExtractedCell[], fills: ClipRect[]): void {
  if (!fills.length) return
  const rowIdx = (y: number): number => { const i = nearestIndex(rowYs, y); return Math.abs(rowYs[i] - y) <= CLIP_COORD_TOL ? i : -1 }
  for (const side of ["l", "r"] as const) {
    const edge = side === "l" ? colXs[0] : colXs[colXs.length - 1]
    const hits = fills.filter(f => {
      const w = f.x2 - f.x1
      // 폭 1pt 미만은 채움으로 그린 괘선이다 — 칸이 아니다
      if (w < NARROW_FILL_MIN_W || w >= CLIP_MIN_W || Math.abs((side === "l" ? f.x2 : f.x1) - edge) > CLIP_COORD_TOL) return false
      const r0 = rowIdx(f.y2), r1 = rowIdx(f.y1)
      return r0 >= 0 && r1 > r0
    })
    if (!hits.length) continue
    let x = side === "l" ? Infinity : -Infinity
    for (const f of hits) x = side === "l" ? Math.min(x, f.x1) : Math.max(x, f.x2)
    if (side === "l") { colXs.unshift(x); for (const c of out) c.col++ } else colXs.push(x)
    const col = side === "l" ? 0 : colXs.length - 2
    const [cx1, cx2] = [colXs[col], colXs[col + 1]]
    const taken = new Array<boolean>(rowYs.length - 1).fill(false)
    for (const f of hits) {
      const r0 = rowIdx(f.y2), r1 = rowIdx(f.y1)
      if (taken.slice(r0, r1).some(Boolean)) continue
      taken.fill(true, r0, r1)
      out.push({ row: r0, col, rowSpan: r1 - r0, colSpan: 1, bbox: { x1: cx1, y1: rowYs[r1], x2: cx2, y2: rowYs[r0] } })
    }
    for (let r = 0; r < taken.length; r++) {
      if (!taken[r]) out.push({ row: r, col, rowSpan: 1, colSpan: 1, bbox: { x1: cx1, y1: rowYs[r + 1], x2: cx2, y2: rowYs[r] }, filler: true })
    }
  }
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
