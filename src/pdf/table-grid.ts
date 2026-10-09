/**
 * 선 교차점(Vertex) 기반 테이블 그리드 구성 (line-detector.ts에서 분리).
 *
 * OpenDataLoader PDF의 TableBorderBuilder를 참고하여 TypeScript로
 * clean-room 재구현한 것입니다. Vertex 기반 동적 tolerance 포함.
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 * Core algorithm concepts from veraPDF-wcag-algs (GPLv3+/MPLv2+)
 */

import type { LineSegment, TableGrid } from "./line-types.js"
import { VERTEX_MERGE_FACTOR } from "./line-types.js"

/** 선 교차점 (Vertex) — ODL의 핵심 개념 */
interface Vertex {
  x: number
  y: number
  /** 교차하는 선들의 최대 lineWidth → tolerance 계산에 사용 */
  radius: number
}

/** 두 선이 같은 테이블에 속하는지 판별하는 거리 */
const CONNECT_TOL = 5
/** 최소 열 폭 (pt) — 이보다 좁은 열은 인접 열과 병합 */
const MIN_COL_WIDTH = 15
/** 좁은 열 무리의 최소 열 폭 (pt) — 20pt 안 열이 셋 넘게 이어진 숫자 칸 무리(평가 기준 별표2 "참여업체수에 따른 배분업체수" 2~20 열,
 *  14~17pt)는 12pt 까지 열이다. 15pt 에서 둘씩 합쳐져 29열 표가 21열이 되고 두 칸 값이 "1 1" 로 한 칸에 들었다. 홀로 좁은 들여쓰기 열은
 *  종전대로 합친다(영문 계약서 틀 표 — 들여쓰기 열이 서자 문단까지 표로 품었다) */
const NARROW_RUN_MIN_WIDTH = 12
const NARROW_RUN_MAX_WIDTH = 20
const NARROW_RUN_MIN = 4
/** 최소 행 높이 (pt) */
const MIN_ROW_HEIGHT = 6
/** 좌표 병합 최소 tolerance (pt) — vertexRadius가 작아도 이 값 이하로 내려가지 않음 */
const MIN_COORD_MERGE_TOL = 8

// ─── 적층 표 분리 (컷 라인) ──────────────────────────
/** 컷 후보 수평선이 그룹 폭에서 차지해야 할 최소 비율 */
const CUT_FULLWIDTH_RATIO = 0.9
/** 관통/소속 판정 y 여유 (pt) */
const CUT_CROSS_EPS = 2
/** 컷 양쪽에 각각 필요한 최소 수직선 수 (독립 표 성립 조건) */
const CUT_MIN_SIDE_VERTICALS = 2
/** 내부 수직선 판정 — 그룹 좌우 가장자리에서 이만큼 안쪽 (pt) */
const CUT_EDGE_MARGIN = 12
/** 내부 수직선 x 동일 판정 tolerance (pt) */
const CUT_INTERIOR_MATCH_TOL = 8
/** 내부 수직선 x-집합 겹침 허용 상한 — 초과하면 같은 열 구조의 연속(분리 금지) */
const CUT_MAX_INTERIOR_OVERLAP = 0.5
/** 컷 체인 뷰: 같은 논리 수직선으로 묶는 x 허용 오차 (pt) */
const CUT_VCHAIN_X_TOL = 1.5
/** 컷 체인 뷰: 콜리니어 수직 세그먼트 연결 최대 간격 (pt) — 한 표의 섹션별 세그먼트는
 *  정확히 맞닿고(gap≈0), 별개 표 사이에는 실간격(실측 2.9pt+)이 있다. line-extract
 *  CHAIN_GAP(3)보다 좁게 잡아 별개 표의 경계 간격을 잇지 않는다 */
const CUT_VCHAIN_GAP = 1.0

// ─── 선 격자 중첩표 ──────────────────────────────────
/** 한 표의 괘선은 끝점이 맞닿는다 — 이 허용차로 이은 성분이 괘선이 실제로 이어진 표 하나다 */
const NEST_STRICT_TOL = 0.5
/** 중첩 상자는 바깥 상자 안쪽에 칸 여백만큼 떠 있다(한컴 기본 안 여백 1.8mm ≈ 5pt, 아래 여백 1pt 실측) */
const NEST_MIN_GAP = 0.8
/** 상자 변: 그 변을 이루는 선이 변 길이의 이만큼 이상을 덮어야 닫힌 상자 */
const NEST_EDGE_COVER = 0.95
/** 이중 테두리: 안쪽 선이 바깥 선에서 이 거리(pt) 안에 네 쪽 모두 붙어 있으면 두 줄 테두리 한 벌 */
const NEST_DOUBLE_RULE_GAP = 6

// ─── Vertex(교차점) 생성 ─────────────────────────────

/**
 * 수평선과 수직선의 교차점(Vertex)을 생성.
 * ODL의 TableBorderBuilder.addLine()이 교차점을 자동 생성하는 것과 동일.
 * 각 Vertex는 교차하는 선들의 lineWidth로 radius를 계산 → 동적 tolerance.
 *
 * O(H×V) 회피: 수직선을 y-대역 버킷에 등록하고 각 수평선은 자기 y가 속한 버킷의
 * 후보만 검사 — 세로로 떨어진 다른 표의 수직선과의 교차 검사(전수 이중루프의 낭비
 * 대부분)를 건너뛴다. 수직선은 [y1-tol, y2+tol]을 덮는 모든 버킷에 인덱스 오름차순
 * 으로 등록되므로, h 순회 × 버킷 내 v 오름차순 = 기존 이중루프와 vertex 배열 순서가
 * 동일하다 (mergeVertices의 병합 결과가 순서에 민감).
 */
/** 수직선 y-대역 버킷 크기 (pt) */
const VERTEX_BUCKET_CELL = 100

/** 오름차순 배열에서 key 이상인 첫 위치 */
function lowerBound(sorted: number[], key: number): number {
  let lo = 0, hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

function buildVertices(horizontals: LineSegment[], verticals: LineSegment[]): Vertex[] {
  const vertices: Vertex[] = []
  const tol = CONNECT_TOL

  // 수직선은 수평선이 실제로 조회하는 버킷에만 등록한다 — [b1, b2] 전 구간을 돌면 루프가 선 길이/100 번이라, 좌표가 큰 괘선
  // 하나(726B PDF 의 길이 1e9 세로선)에 버킷 1,000만 개·3.2GB 를 만들다 "Map maximum size exceeded" 로 쪽을 잃었다. 조회되는
  // 버킷은 모두 수평선 y 의 버킷이라 등록 집합이 같다(교차 후보·vertex 순서 불변)
  const queried = [...new Set(horizontals.map(h => Math.floor(h.y1 / VERTEX_BUCKET_CELL)))].filter(Number.isFinite).sort((a, b) => a - b)
  const buckets = new Map<number, Array<LineSegment>>()
  for (const v of verticals) {
    const b1 = Math.floor((v.y1 - tol) / VERTEX_BUCKET_CELL)
    const b2 = Math.floor((v.y2 + tol) / VERTEX_BUCKET_CELL)
    for (let k = lowerBound(queried, b1); k < queried.length && queried[k] <= b2; k++) {
      const b = queried[k]
      const arr = buckets.get(b)
      if (arr) arr.push(v)
      else buckets.set(b, [v])
    }
  }

  for (const h of horizontals) {
    // h.y1 ∈ [v.y1-tol, v.y2+tol] 인 v는 h.y1의 버킷에 반드시 등록되어 있음
    const cand = buckets.get(Math.floor(h.y1 / VERTEX_BUCKET_CELL))
    if (!cand) continue
    for (const v of cand) {
      // 수평선의 X범위에 수직선의 X가 포함되고
      // 수직선의 Y범위에 수평선의 Y가 포함되면 → 교차
      if (v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol &&
          h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol) {
        const radius = Math.max(h.lineWidth, v.lineWidth, 1)
        vertices.push({ x: v.x1, y: h.y1, radius })
      }
    }
  }

  return vertices
}

/**
 * 근접 Vertex 병합 — 같은 교차점의 미세 위치 차이를 하나로 합침.
 * O(V²) 회피: 좌표 버킷 그리드로 근접 후보만 비교. mergeTol은 항상
 * VERTEX_MERGE_FACTOR × (전체 최대 radius) 이하이므로 셀 크기를 그 값으로 잡으면
 * ±1 셀 이웃만 봐도 기존 전수 비교와 결과(병합 집합·순서)가 동일하다.
 */
function mergeVertices(vertices: Vertex[]): Vertex[] {
  if (vertices.length <= 1) return vertices

  let maxRadiusAll = 1
  for (const v of vertices) { if (v.radius > maxRadiusAll) maxRadiusAll = v.radius }
  const cell = Math.max(VERTEX_MERGE_FACTOR * maxRadiusAll, 1)
  const buckets = new Map<number, Map<number, number[]>>()
  for (let i = 0; i < vertices.length; i++) {
    const cx = Math.floor(vertices[i].x / cell)
    const cy = Math.floor(vertices[i].y / cell)
    let column = buckets.get(cx)
    if (!column) { column = new Map(); buckets.set(cx, column) }
    const arr = column.get(cy)
    if (arr) arr.push(i)
    else column.set(cy, [i])
  }

  const merged: Vertex[] = []
  const used = new Array(vertices.length).fill(false)

  for (let i = 0; i < vertices.length; i++) {
    if (used[i]) continue
    let sumX = vertices[i].x, sumY = vertices[i].y
    let maxRadius = vertices[i].radius
    let count = 1

    // ±1 셀 이웃의 j > i 후보만 — 기존 j 오름차순 스캔과 동일 순서 유지
    const cx = Math.floor(vertices[i].x / cell)
    const cy = Math.floor(vertices[i].y / cell)
    const candidates: number[] = []
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const arr = buckets.get(cx + dx)?.get(cy + dy)
        if (!arr) continue
        for (const j of arr) { if (j > i && !used[j]) candidates.push(j) }
      }
    }
    candidates.sort((a, b) => a - b)

    for (const j of candidates) {
      if (used[j]) continue
      const mergeTol = VERTEX_MERGE_FACTOR * Math.max(maxRadius, vertices[j].radius)
      if (Math.abs(vertices[i].x - vertices[j].x) <= mergeTol &&
          Math.abs(vertices[i].y - vertices[j].y) <= mergeTol) {
        sumX += vertices[j].x
        sumY += vertices[j].y
        maxRadius = Math.max(maxRadius, vertices[j].radius)
        count++
        used[j] = true
      }
    }

    merged.push({ x: sumX / count, y: sumY / count, radius: maxRadius })
  }

  return merged
}

// ─── 테이블 그리드 구성 (Vertex 기반) ─────────────────

/**
 * 수평/수직 선에서 테이블 그리드를 추출.
 * ODL과 동일한 흐름:
 * 1. 선 전처리 (preprocessLines — 호출측에서 수행)
 * 2. 교차점(Vertex) 생성 + 병합
 * 3. 교차하는 선들을 그룹화 (연결 컴포넌트)
 * 4. 각 그룹에서 Vertex의 X/Y 좌표를 동적 tolerance로 클러스터링
 * 5. 그리드 검증 (최소 열 폭, 최소 행 높이)
 */
export function buildTableGrids(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  /** 좁은 열 무리를 12pt 까지 열로 둔다 — 텍스트층 벡터 괘선만. OCR 래스터 괘선은 조직도 상자 변이 좁은 열 무리처럼 보인다(web068) */
  narrowRuns = true,
): TableGrid[] {
  if (horizontals.length < 2 || verticals.length < 2) return []

  // 1. 교차점 생성
  const allVertices = buildVertices(horizontals, verticals)
  const vertices = mergeVertices(allVertices)

  if (vertices.length < 4) return [] // 최소 4꼭짓점 필요 (사각형)

  // 전체 vertex의 대표 radius (동적 tolerance)
  const globalRadius = vertices.reduce((max, v) => Math.max(max, v.radius), 1)

  // 2. 선들을 교차 관계로 그룹화
  const allLines = [
    ...horizontals.map((l, i) => ({ ...l, type: "h" as const, id: i })),
    ...verticals.map((l, i) => ({ ...l, type: "v" as const, id: i + horizontals.length })),
  ]

  // 적층 표 분리 — 분리된 밴드는 공유 컷라인 위 vertex가 반대편 표의 수직선 x를
  // 나르므로(교차점이 경계선상에 생김) 전역 vertex 대신 밴드 자기 선으로 재계산한다
  const groups: Array<{ lines: TypedLine[]; fromSplit: boolean; nested?: boolean }> = []
  for (const g0 of groupConnectedLines(allLines)) {
    // 칸 안에 떠 있는 닫힌 표(선 격자 중첩표)는 CONNECT_TOL 로 바깥 괘선에 붙어 한 격자로 뭉친다 — 먼저 떼어 따로 세운다
    const { outer: g, nested } = splitNestedBoxes(g0)
    for (const n of nested) groups.push({ lines: n, fromSplit: true, nested: true })
    if (g.length === 0) continue
    const bands = splitStackedGroup(g)
    for (const b of bands) groups.push({ lines: b, fromSplit: bands.length > 1 || nested.length > 0 })
  }
  const grids: TableGrid[] = []

  // 그룹별 vertex bbox 필터의 O(그룹수×V) 회피 — y 정렬 후 그룹 y범위만 이진탐색 스캔.
  // groupVertices는 최대 radius와 clusterCoordinates(내부 정렬) 입력으로만 쓰여
  // 순서 무관 — 전수 filter와 같은 다중집합이면 결과 동일.
  const byY = [...vertices].sort((a, b) => a.y - b.y)
  const vertexYs = byY.map(v => v.y)
  const lowerBoundY = (key: number): number => {
    let lo = 0, hi = vertexYs.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (vertexYs[mid] < key) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  for (const { lines: group, fromSplit, nested } of groups) {
    const hLines = group.filter(l => l.type === "h")
    const vLines = group.filter(l => l.type === "v")

    if (hLines.length < 2 || vLines.length < 2) continue

    // 3. 이 그룹의 Vertex만 수집
    let gx1 = Infinity, gy1 = Infinity, gx2 = -Infinity, gy2 = -Infinity
    for (const l of vLines) { if (l.x1 < gx1) gx1 = l.x1; if (l.x1 > gx2) gx2 = l.x1 }
    for (const l of hLines) { if (l.y1 < gy1) gy1 = l.y1; if (l.y1 > gy2) gy2 = l.y1 }
    const groupBbox = {
      x1: gx1 - CONNECT_TOL,
      y1: gy1 - CONNECT_TOL,
      x2: gx2 + CONNECT_TOL,
      y2: gy2 + CONNECT_TOL,
    }

    let groupVertices: Vertex[]
    if (fromSplit) {
      groupVertices = mergeVertices(buildVertices(hLines, vLines))
    } else {
      groupVertices = []
      for (let k = lowerBoundY(groupBbox.y1); k < byY.length && vertexYs[k] <= groupBbox.y2; k++) {
        const v = byY[k]
        if (v.x >= groupBbox.x1 && v.x <= groupBbox.x2) groupVertices.push(v)
      }
    }

    // 그룹 vertex의 대표 radius
    const groupRadius = groupVertices.length > 0
      ? groupVertices.reduce((max, v) => Math.max(max, v.radius), 1)
      : globalRadius

    // 4. Vertex 기반 좌표 클러스터링 (동적 tolerance)
    const coordMergeTol = Math.max(VERTEX_MERGE_FACTOR * groupRadius, MIN_COORD_MERGE_TOL)

    // 좁은 표의 오른쪽 셀 안에서 같은 바깥 테두리까지 반복된 밑줄은 행 경계가
    // 아니다. 전역적으로 1교차 선을 버리면 부분 괘선인 실제 표까지 손상된다.
    const leftEdge = Math.min(...vLines.map(v => v.x1))
    const rightEdge = Math.max(...vLines.map(v => v.x1))
    const underlines = hLines.filter(h => {
      const crossings = new Set<number>()
      for (const v of vLines) {
        if (v.x1 >= h.x1 - CONNECT_TOL && v.x1 <= h.x2 + CONNECT_TOL
          && h.y1 >= v.y1 - CONNECT_TOL && h.y1 <= v.y2 + CONNECT_TOL) crossings.add(v.x1)
      }
      return crossings.size === 1 && Math.abs(h.x2 - rightEdge) <= CONNECT_TOL
        && h.x1 > (leftEdge + rightEdge) / 2
        && h.x2 - h.x1 < (rightEdge - leftEdge) * 0.6
    })
    const rowLines = underlines.length >= 3 && hLines.length - underlines.length <= 4
      ? hLines.filter(h => !underlines.includes(h)) : hLines
    const rowVertices = rowLines.length === hLines.length ? groupVertices : groupVertices.filter(v =>
      rowLines.some(h => Math.abs(v.y - h.y1) <= CONNECT_TOL))

    // Y좌표: 행 경계 수평선 y + 해당 Vertex y
    const rawYs = [
      ...rowLines.map(l => l.y1),
      ...rowVertices.map(v => v.y),
    ]
    const rowYs = clusterCoordinates(rawYs, coordMergeTol).sort((a, b) => b - a)

    // X좌표: 수직선 x + Vertex x
    const rawXs = [
      ...vLines.map(l => l.x1),
      ...groupVertices.map(v => v.x),
    ]
    const colXs = clusterCoordinates(rawXs, coordMergeTol).sort((a, b) => a - b)

    if (rowYs.length < 2 || colXs.length < 2) continue

    // 5. 그리드 검증: 최소 열 폭, 최소 행 높이
    const validColXs = enforceMinWidth(colXs, MIN_COL_WIDTH, narrowRuns)
    const validRowYs = enforceMinHeight(rowYs, MIN_ROW_HEIGHT)

    if (validRowYs.length < 2 || validColXs.length < 2) continue

    const bbox = {
      x1: validColXs[0], y1: validRowYs[validRowYs.length - 1],
      x2: validColXs[validColXs.length - 1], y2: validRowYs[0],
    }

    grids.push({ rowYs: validRowYs, colXs: validColXs, bbox, vertexRadius: groupRadius, ...(nested ? { lineNested: true } : {}) })
  }

  // 중첩표는 제자리에 둔다 — 같은 열 수로 위아래 붙은 칸 안 표 둘을 한 표로 잇지 않는다
  return [...mergeAdjacentGrids(grids.filter(g => !g.lineNested)), ...grids.filter(g => g.lineNested)]
}

/** 음영 클립 판정: 클립 칸과 채움 사각형 좌표 허용 차 (pt) */
const SHADE_CLIP_TOL = 1.5
/** 음영 클립 격자가 선 격자에서 차지하는 면적 상한 — 넘으면 표 전체를 덮는 클립(한컴 방식)으로 본다 */
const SHADE_CLIP_MAX_AREA = 0.5

/**
 * 음영 칸 클립 격자 버리기 — 한컴 PDF 는 표의 모든 칸에 클립을 깔지만 cairo(rhwp 렌더) 등은 배경을 칠하는 칸에만
 * 채움용 클립을 건다. 그 클립이 머리행 1x2 같은 조각 격자를 이뤄 먼저 글을 가져가면, 괘선으로 온전한 3x2 선 표는
 * 머리행이 빈 채 강등돼 본문 행이 "중견기업 : 4개까지 수행 가능" 문단으로 흩어진다(연구개발 지원 공고 cairo 2쪽).
 * 클립 칸이 전부 같은 좌표의 채움 사각형이고, 그 격자가 열 경계가 맞는 선 격자 안에 들며, 그 선 격자 안의 클립 격자를
 * 다 합쳐도 선 격자 면적의 절반 이하이면(선 표 대부분에 클립이 없음) 음영이지 표가 아니다 — 선 격자가 표를 맡는다.
 * 한컴은 모든 칸에 클립을 깔아 선 격자가 여러 표에 걸쳐 커져도 그 안이 클립 격자로 덮인다(벤처투자조합 등록신청서:
 * 흰색으로 칠한 "신청인" 4x3 클립 표가 서식 전체 선 격자 14x4 안에 있으나 나머지도 클립 표들이 덮는다).
 * 음영 칸 사이가 획 없이 흰 틈으로만 갈린 머리행(한컴 구버전 성과지표 표 "실적 | 목표치")은 클립이 선에 없는 칸
 * 경계를 주므로 둔다 — 클립 격자의 안쪽 칸 경계마다 그 띠를 덮는 세로 괘선이 있을 때만 버린다.
 */
export function dropShadingClipGrids(clipGrids: TableGrid[], lineGrids: TableGrid[], fillRects: Array<{ x1: number; y1: number; x2: number; y2: number }>, verticals: LineSegment[] = []): TableGrid[] {
  if (clipGrids.length === 0 || lineGrids.length === 0 || fillRects.length === 0) return clipGrids
  const near = (a: number, b: number) => Math.abs(a - b) <= SHADE_CLIP_TOL
  const area = (b: TableGrid["bbox"]) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
  const inter = (a: TableGrid["bbox"], b: TableGrid["bbox"]) => area({ x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) })
  return clipGrids.filter(c => {
    if (!c.cells?.length || c.clipParent) return true
    const sourceCells = c.cells.filter(cell => !cell.filler)
    if (sourceCells.length === 0) return true
    const shaded = sourceCells.every(cell => fillRects.some(f => near(f.x1, cell.bbox.x1) && near(f.x2, cell.bbox.x2) && near(f.y1, cell.bbox.y1) && near(f.y2, cell.bbox.y2)))
    if (!shaded) return true
    // 칸 경계마다 괘선 — 칸의 오른변(표 오른끝 제외)이 그 칸 높이의 75% 이상 세로선에 덮여야 한다
    const ruled = sourceCells.every(cell => cell.bbox.x2 >= c.bbox.x2 - SHADE_CLIP_TOL || verticals.some(v =>
      Math.abs(v.x1 - cell.bbox.x2) <= SHADE_CLIP_TOL * 2
      && Math.min(v.y2, cell.bbox.y2) - Math.max(v.y1, cell.bbox.y1) >= (cell.bbox.y2 - cell.bbox.y1) * 0.75))
    if (!ruled) return true
    const host = lineGrids.find(l =>
      // Inferred filler cells carry no boundary evidence. Replace their frame only
      // with a finer ruled grid of the same extent, never a larger surrounding form.
      (!c.cells!.some(cell => cell.filler) || (
        near(c.bbox.x1, l.bbox.x1) && near(c.bbox.x2, l.bbox.x2)
        && near(c.bbox.y1, l.bbox.y1) && near(c.bbox.y2, l.bbox.y2)
        && l.rowYs.length > c.rowYs.length
        && sourceCells.every(cell => [cell.bbox.y1, cell.bbox.y2].every(y => l.rowYs.some(ly => near(y, ly))))
      )) &&
      c.bbox.x1 >= l.bbox.x1 - SHADE_CLIP_TOL && c.bbox.x2 <= l.bbox.x2 + SHADE_CLIP_TOL
      && c.bbox.y1 >= l.bbox.y1 - SHADE_CLIP_TOL && c.bbox.y2 <= l.bbox.y2 + SHADE_CLIP_TOL
      && c.colXs.every(x => l.colXs.some(lx => near(lx, x)))
      && (clipGrids.reduce((s, o) => s + (o.cells?.some(cell => cell.filler)
        ? o.cells.filter(cell => !cell.filler).reduce((a, cell) => a + inter(cell.bbox, l.bbox), 0)
        : inter(o.bbox, l.bbox)), 0) <= area(l.bbox) * SHADE_CLIP_MAX_AREA
        // 상단 음영 두 행만 클립이고 마지막 흰 행은 선으로만 그린 표. 클립 면적이 절반을 넘어도
        // 선 격자가 같은 열·행 경계에 마지막 행 하나를 더 가지면 온전한 선 격자를 쓴다.
        || (l.rowYs.length === c.rowYs.length + 1 && c.rowYs.every((y, i) => near(y, l.rowYs[i]))
          && l.colXs.length === c.colXs.length && c.colXs.every((x, i) => near(x, l.colXs[i]))
          && !clipGrids.some(o => o !== c && inter(o.bbox, l.bbox) > 0))))
    return !host
  })
}

/** 여백 클립 판정: 클립 격자 위·아래 변이 선 격자 행 괘선에서 떨어진 최소 거리 (pt) — Word 칸 위·아래 여백 5~6pt 실측 */
const INSET_CLIP_MIN = 2

/**
 * 칸 여백 클립 격자 버리기 — Word 는 칸 글 영역(칸 테두리에서 위·아래 여백만큼 안쪽)에 클립을 건다. 행마다 여백으로 떨어져
 * 클립 격자가 행 하나씩 따로 서고, 클립이 없는 전폭 행("Learning Outcomes")은 표 밖 문단이 되어 한 표가 여러 조각으로
 * 갈렸다(ODL 146·150). 한컴 클립은 칸 테두리와 같은 좌표라 선 격자 행 괘선 위에 놓인다. 1행 클립 격자가 선 격자의 한 행 띠
 * 안에 위·아래 모두 떠 있고 좌우 끝은 선 격자 끝과 같으면 칸 여백 클립이다 — 온전한 선 격자가 표를 맡는다.
 */
export function dropInsetClipGrids(clipGrids: TableGrid[], lineGrids: TableGrid[]): TableGrid[] {
  if (clipGrids.length === 0 || lineGrids.length === 0) return clipGrids
  const near = (a: number, b: number) => Math.abs(a - b) <= SHADE_CLIP_TOL
  return clipGrids.filter(c => c.clipParent || c.rowYs.length !== 2 || !lineGrids.some(l =>
    l.rowYs.length >= 3 && near(c.bbox.x1, l.bbox.x1) && near(c.bbox.x2, l.bbox.x2)
    && l.rowYs.some((top, r) => r + 1 < l.rowYs.length
      && top - c.bbox.y2 >= INSET_CLIP_MIN && c.bbox.y1 - l.rowYs[r + 1] >= INSET_CLIP_MIN)))
}

/**
 * 쪽 넘김 머리 행 클립 띠 버리기 — 한컴은 이어진 쪽의 되풀이 머리 행(과 그 아래 몇 칸)을 따로 클립해 그린다. 그 클립 격자가 선 격자와
 * 열 경계가 같고, 선 격자 윗변에 붙어 행 경계가 모두 선 격자 행 경계 위에 놓이면 같은 표의 윗줄을 두 번 잡은 것이다 — 클립 격자가
 * 먼저 글을 가져가 선 표 첫 행들이 빈 채 남고 쪽 넘김 잇기가 끊겼다(국제기능올림픽 선수단 명단 57행 → 29행 + 30행). 선 격자 나머지를
 * 다른 클립이 덮으면(클립으로 그린 표 여럿이 한 틀 안에) 두고, 중첩표 클립(clipParent)은 대상이 아니다
 */
export function dropHeadBandClipGrids(clipGrids: TableGrid[], lineGrids: TableGrid[]): TableGrid[] {
  if (clipGrids.length === 0 || lineGrids.length === 0) return clipGrids
  const near = (a: number, b: number) => Math.abs(a - b) <= SHADE_CLIP_TOL
  const overlaps = (a: TableGrid["bbox"], b: TableGrid["bbox"]) => Math.min(a.x2, b.x2) > Math.max(a.x1, b.x1) && Math.min(a.y2, b.y2) > Math.max(a.y1, b.y1)
  return clipGrids.filter(c => c.clipParent || !c.cells?.length || !lineGrids.some(l =>
    l.rowYs.length > c.rowYs.length && l.colXs.length === c.colXs.length && c.colXs.every((x, k) => near(x, l.colXs[k]))
    && c.rowYs.every((y, k) => near(y, l.rowYs[k]))
    && !clipGrids.some(o => o !== c && overlaps(o.bbox, l.bbox))))
}

/** 최소 열 폭 보장 — 너무 좁은 열은 인접 열과 병합 */
function enforceMinWidth(colXs: number[], minWidth: number, narrowRuns = true): number[] {
  if (colXs.length <= 2) return colXs
  // 20pt 안 열이 NARROW_RUN_MIN 개 넘게 이어진 무리 안 경계는 12pt 까지 둔다
  const inRun = new Array(colXs.length).fill(false)
  for (let s = 0; s + 1 < colXs.length;) {
    let e = s
    while (e + 1 < colXs.length && colXs[e + 1] - colXs[e] < NARROW_RUN_MAX_WIDTH) e++
    if (narrowRuns && e - s >= NARROW_RUN_MIN) for (let k = s; k <= e; k++) inRun[k] = true
    s = Math.max(e, s + 1)
  }
  const result: number[] = [colXs[0]]
  for (let i = 1; i < colXs.length; i++) {
    const prevX = result[result.length - 1]
    if (colXs[i] - prevX < (inRun[i] ? NARROW_RUN_MIN_WIDTH : minWidth) && i < colXs.length - 1) {
      // 너무 좁으면 스킵 (다음 열과 병합)
      continue
    }
    result.push(colXs[i])
  }
  return result
}

/** 최소 행 높이 보장 — 너무 낮은 행은 인접 행과 병합 */
function enforceMinHeight(rowYs: number[], minHeight: number): number[] {
  if (rowYs.length <= 2) return rowYs
  // rowYs는 내림차순 (위→아래)
  const result: number[] = [rowYs[0]]
  for (let i = 1; i < rowYs.length; i++) {
    const prevY = result[result.length - 1]
    if (prevY - rowYs[i] < minHeight && i < rowYs.length - 1) {
      continue
    }
    result.push(rowYs[i])
  }
  return result
}

/** 같은 열 구조를 가진 인접 그리드를 병합 */
function mergeAdjacentGrids(grids: TableGrid[]): TableGrid[] {
  if (grids.length <= 1) return grids
  const sorted = [...grids].sort((a, b) => b.bbox.y2 - a.bbox.y2)
  const merged: TableGrid[] = [sorted[0]]

  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = sorted[i]

    if (prev.colXs.length === curr.colXs.length) {
      const mergeTol = Math.max(VERTEX_MERGE_FACTOR * Math.max(prev.vertexRadius, curr.vertexRadius), 6) * 3
      const colMatch = prev.colXs.every((x, ci) => Math.abs(x - curr.colXs[ci]) <= mergeTol)
      const verticalGap = prev.bbox.y1 - curr.bbox.y2
      if (colMatch && verticalGap >= -CONNECT_TOL && verticalGap <= 20) {
        const allRowYs = [...new Set([...prev.rowYs, ...curr.rowYs])].sort((a, b) => b - a)
        merged[merged.length - 1] = {
          rowYs: allRowYs,
          colXs: prev.colXs,
          bbox: {
            x1: Math.min(prev.bbox.x1, curr.bbox.x1),
            y1: Math.min(prev.bbox.y1, curr.bbox.y1),
            x2: Math.max(prev.bbox.x2, curr.bbox.x2),
            y2: Math.max(prev.bbox.y2, curr.bbox.y2),
          },
          vertexRadius: Math.max(prev.vertexRadius, curr.vertexRadius),
        }
        continue
      }
    }
    merged.push(curr)
  }
  return merged
}

/** 좌표값 클러스터링 — 동적 tolerance 기반 (ODL의 vertex radius 반영) */
function clusterCoordinates(values: number[], tolerance: number): number[] {
  if (values.length === 0) return []
  const sorted = [...values].sort((a, b) => a - b)
  const clusters: { sum: number; count: number }[] = [{ sum: sorted[0], count: 1 }]

  for (let i = 1; i < sorted.length; i++) {
    const last = clusters[clusters.length - 1]
    const avg = last.sum / last.count
    if (Math.abs(sorted[i] - avg) <= tolerance) {
      last.sum += sorted[i]
      last.count++
    } else {
      clusters.push({ sum: sorted[i], count: 1 })
    }
  }

  return clusters.map(c => c.sum / c.count)
}

type TypedLine = LineSegment & { type: "h" | "v"; id: number }

/**
 * 컷 관통 판정용 체인 뷰 — 같은 x의 콜리니어 수직 세그먼트(섹션별로 쪼개 그은 외곽선·
 * 구분선)를 논리 수직선 하나로 잇는다. 한 표의 세그먼트는 정확히 맞닿고(gap≈0) 별개 표
 * 사이에는 실간격이 있어 잇지 않는다. 판정 전용 — 물리 수직선은 수정하지 않는다
 * (물리 병합은 셀 배치 변질 실측으로 폐기 — line-extract chainCollinearRules 주석 참조).
 */
function chainVerticals(vs: TypedLine[]): Array<{ y1: number; y2: number }> {
  if (vs.length <= 1) return vs.map(v => ({ y1: v.y1, y2: v.y2 }))
  const sorted = [...vs].sort((a, b) => a.x1 - b.x1 || a.y1 - b.y1)
  const rules: Array<{ y1: number; y2: number }> = []
  let bandStart = 0
  const flushBand = (end: number) => {
    const band = sorted.slice(bandStart, end).sort((a, b) => a.y1 - b.y1)
    let cur = { y1: band[0].y1, y2: band[0].y2 }
    for (let i = 1; i < band.length; i++) {
      const seg = band[i]
      if (seg.y1 - cur.y2 <= CUT_VCHAIN_GAP) {
        if (seg.y2 > cur.y2) cur.y2 = seg.y2
      } else {
        rules.push(cur)
        cur = { y1: seg.y1, y2: seg.y2 }
      }
    }
    rules.push(cur)
  }
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].x1 - sorted[bandStart].x1 > CUT_VCHAIN_X_TOL) {
      flushBand(i)
      bandStart = i
    }
  }
  return rules
}

/**
 * 적층 표 분리 — 위아래로 붙은 별개 표 두 개가 경계 수평선 하나를 공유해 Union-Find가
 * 한 그룹으로 묶은 경우(채용공고 머리 스트립+응시원서 본표 실측)를 세로 밴드로 분리.
 *
 * 컷 라인 판정: 그룹 전폭급 수평선 중
 *  (a) 이를 관통하는 논리 수직선(체인 뷰)이 하나도 없고 — 별개 표는 외곽 수직선이 각자
 *      영역에서 끊기지만, 한 표 내부의 전폭 구조변화 경계(섹션 헤더 행 등)는 외곽
 *      수직선이 연속(또는 맞닿은 세그먼트 체인)으로 관통한다
 *  (b) 양쪽에 독립 표를 이룰 수직선이 2+개씩 있으며
 *  (c) 내부 수직선 x-집합이 절반 넘게 겹치지 않는 경우 — 같은 열 구조의 연속이면 한 표
 * 컷 라인 자체는 양쪽 밴드에 복제된다 (위 표의 하변이자 아래 표의 상변).
 */
function splitStackedGroup(group: TypedLine[]): TypedLine[][] {
  const hs = group.filter(l => l.type === "h")
  const vs = group.filter(l => l.type === "v")
  if (hs.length < 3 || vs.length < 4) return [group]

  let gx1 = Infinity, gx2 = -Infinity
  for (const l of group) {
    if (l.x1 < gx1) gx1 = l.x1
    if (l.x2 > gx2) gx2 = l.x2
  }
  const groupW = gx2 - gx1
  if (groupW <= 0) return [group]

  const isInterior = (v: TypedLine) => v.x1 > gx1 + CUT_EDGE_MARGIN && v.x1 < gx2 - CUT_EDGE_MARGIN
  const chained = chainVerticals(vs)
  const cuts: number[] = []
  for (const h of hs) {
    const y = h.y1
    if (h.x2 - h.x1 < groupW * CUT_FULLWIDTH_RATIO) continue
    if (cuts.some(c => Math.abs(c - y) <= CUT_CROSS_EPS)) continue
    // (a) 관통 논리 수직선 존재 → 같은 표 내부 경계
    if (chained.some(v => v.y1 < y - CUT_CROSS_EPS && v.y2 > y + CUT_CROSS_EPS)) continue
    // (b) 양쪽 수직선 수 — 컷이 성립하려면 위아래 각각 표 꼴이어야 함
    const above = vs.filter(v => v.y1 >= y - CUT_CROSS_EPS)
    const below = vs.filter(v => v.y2 <= y + CUT_CROSS_EPS)
    if (above.length < CUT_MIN_SIDE_VERTICALS || below.length < CUT_MIN_SIDE_VERTICALS) continue
    // (c) 내부 수직선 x-집합 겹침
    const ia = above.filter(isInterior)
    const ib = below.filter(isInterior)
    if (ia.length === 0 || ib.length === 0) continue
    let matched = 0
    for (const a of ia) if (ib.some(b => Math.abs(a.x1 - b.x1) <= CUT_INTERIOR_MATCH_TOL)) matched++
    if (matched / Math.min(ia.length, ib.length) > CUT_MAX_INTERIOR_OVERLAP) continue
    cuts.push(y)
  }
  if (cuts.length === 0) return [group]

  cuts.sort((a, b) => b - a) // 위→아래
  // y 위치가 속한 밴드: 컷 c보다 위(y > c)면 그 컷 앞 밴드
  const bandOf = (y: number) => {
    let k = 0
    while (k < cuts.length && y < cuts[k]) k++
    return k
  }
  const bands: TypedLine[][] = Array.from({ length: cuts.length + 1 }, () => [])
  for (const v of vs) bands[bandOf((v.y1 + v.y2) / 2)].push(v) // (a)에 의해 컷을 안 걸침
  for (const h of hs) {
    const atCut = cuts.findIndex(c => Math.abs(h.y1 - c) <= CUT_CROSS_EPS)
    if (atCut >= 0) {
      // 공유 경계선 — 양쪽 밴드에 복제
      bands[atCut].push(h)
      bands[atCut + 1].push(h)
    } else {
      bands[bandOf(h.y1)].push(h)
    }
  }
  return bands.filter(b => b.length > 0)
}

/**
 * 선 격자 중첩표 떼어내기 — 칸 클립이 없는 PDF(rhwp·워드 등)에서 틀 칸 안의 표는 칸 여백(≈5pt)만큼 떨어져 그려지는데
 * CONNECT_TOL(5) 이 그 틈을 이어 틀과 안쪽 표가 격자 하나(개인정보 분석 별지 17×11)로 뭉쳤다. 끝점이 실제로 맞닿는
 * 선끼리(NEST_STRICT_TOL) 이은 성분 가운데 네 변이 닫힌 상자이고, 다른 성분의 상자 안쪽에 네 변 모두 NEST_MIN_GAP 이상
 * 떨어져 있으며, 다른 성분의 선이 그 안을 지나지 않는 것을 중첩표로 본다. 한 표 안의 괘선은 맞닿으므로 떨어지지 않는다
 */
function splitNestedBoxes(group: TypedLine[]): { outer: TypedLine[]; nested: TypedLine[][] } {
  const comps = groupConnectedLines(group, NEST_STRICT_TOL)
  if (comps.length < 2) return { outer: group, nested: [] }
  const boxes = comps.map(c => {
    const hs = c.filter(l => l.type === "h"), vs = c.filter(l => l.type === "v")
    if (hs.length < 2 || vs.length < 2) return null
    const x1 = Math.min(...vs.map(v => v.x1)), x2 = Math.max(...vs.map(v => v.x1))
    const y1 = Math.min(...hs.map(h => h.y1)), y2 = Math.max(...hs.map(h => h.y1))
    if (x2 - x1 < 1 || y2 - y1 < 1) return null
    const cover = (segs: Array<[number, number]>, a: number, b: number) =>
      segs.reduce((s, [p, q]) => s + Math.max(0, Math.min(q, b) - Math.max(p, a)), 0) >= (b - a) * NEST_EDGE_COVER
    const edgeH = (y: number) => cover(hs.filter(h => Math.abs(h.y1 - y) <= NEST_STRICT_TOL).map(h => [h.x1, h.x2]), x1, x2)
    const edgeV = (x: number) => cover(vs.filter(v => Math.abs(v.x1 - x) <= NEST_STRICT_TOL).map(v => [v.y1, v.y2]), y1, y2)
    return edgeH(y1) && edgeH(y2) && edgeV(x1) && edgeV(x2) ? { x1, y1, x2, y2 } : null
  })
  const bboxOf = (c: TypedLine[]) => ({
    x1: Math.min(...c.map(l => Math.min(l.x1, l.x2))), x2: Math.max(...c.map(l => Math.max(l.x1, l.x2))),
    y1: Math.min(...c.map(l => Math.min(l.y1, l.y2))), y2: Math.max(...c.map(l => Math.max(l.y1, l.y2))),
  })
  const extents = comps.map(bboxOf)
  const nestedIdx = new Set<number>()
  comps.forEach((_, i) => {
    const b = boxes[i]
    if (!b) return
    const e = extents[i]
    // 안쪽에 떠 있기: 다른 성분(좌우 세로선이 있는 틀 — 쪽을 넘어 윗변·아랫변이 없는 틀 조각 포함)이 네 쪽 모두 틈을 두고 감싼다
    // 안쪽 괘선 없는 상자(네 변뿐)가 바깥 상자에 네 쪽 모두 바짝 붙어 있으면 이중 테두리 글상자다(인천 현장실습 매뉴얼 2쪽:
    // 65~490 / 69~486 이중선 상자 둘) — 중첩표로 떼면 바깥 틀이 산문 상자로 강등되며 글이 사라졌다
    const uniq = (xs: number[]) => xs.filter((x, k) => xs.findIndex(y => Math.abs(y - x) <= NEST_STRICT_TOL) === k).length
    const bare = uniq(comps[i].filter(l => l.type === "h").map(l => l.y1)) === 2 && uniq(comps[i].filter(l => l.type === "v").map(l => l.x1)) === 2
    const inside = comps.some((c, j) => {
      if (j === i || c.filter(l => l.type === "v").length < 2 || !c.some(l => l.type === "h")) return false
      const p = extents[j]
      const gaps = [e.x1 - p.x1, p.x2 - e.x2, e.y1 - p.y1, p.y2 - e.y2]
      return gaps.every(g => g >= NEST_MIN_GAP) && !(bare && gaps.every(g => g <= NEST_DOUBLE_RULE_GAP))
    })
    if (!inside) return
    // 다른 성분의 선이 상자 안을 지나면(격자의 한 조각) 중첩표가 아니다
    const crossed = comps.some((c, j) => j !== i && c.some(l => l.type === "h"
      ? l.y1 > e.y1 + NEST_MIN_GAP && l.y1 < e.y2 - NEST_MIN_GAP && Math.min(l.x2, e.x2) - Math.max(l.x1, e.x1) > NEST_MIN_GAP
      : l.x1 > e.x1 + NEST_MIN_GAP && l.x1 < e.x2 - NEST_MIN_GAP && Math.min(l.y2, e.y2) - Math.max(l.y1, e.y1) > NEST_MIN_GAP)
      && !(extents[j].x1 >= e.x1 && extents[j].x2 <= e.x2 && extents[j].y1 >= e.y1 && extents[j].y2 <= e.y2))
    if (!crossed) nestedIdx.add(i)
  })
  if (nestedIdx.size === 0) return { outer: group, nested: [] }
  return {
    outer: comps.filter((_, i) => !nestedIdx.has(i)).flat(),
    nested: comps.filter((_, i) => nestedIdx.has(i)),
  }
}

/** 선 bbox 버킷 그리드 셀 크기 (pt) — 근접 후보 열거용 */
const GROUP_BUCKET_CELL = 100

/**
 * 교차하는 선들을 Union-Find로 그룹화.
 * O(L²) 회피: 선 bbox(±CONNECT_TOL)를 좌표 버킷 그리드에 등록하고 같은 셀을
 * 공유하는 쌍만 교차 판정. 교차 가능한 쌍(bbox 겹침)은 반드시 셀을 공유하므로
 * 연결 컴포넌트가 동일하고, 그룹 출력 순서(컴포넌트 최소 선 인덱스 순·그룹 내
 * 인덱스 순)는 union 순서와 무관해 기존과 결과가 같다.
 */
function groupConnectedLines(lines: TypedLine[], tol = CONNECT_TOL): TypedLine[][] {
  const parent = lines.map((_, i) => i)

  function find(x: number): number {
    while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x] }
    return x
  }
  function union(a: number, b: number) {
    const ra = find(a), rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // 선마다 bbox 가 덮는 셀 전부가 아니라, 열·행이 어떤 선의 시작 셀(cx1·cy1)인 셀에만 등록한다. 두 bbox 가 겹치면 겹친 구간의
  // 최소 모서리 (max(cx1), max(cy1)) 는 둘 중 한 선의 시작 열·행이고 두 선 모두 덮으므로 거기서 만난다 — 교차 판정 쌍이 같고
  // 등록 수는 종전 이하. 전 구간 등록은 좌표가 큰 괘선 하나에 셀 수천만 개를 만들었다(buildVertices 주석)
  const span = lines.map(l => [
    Math.floor((Math.min(l.x1, l.x2) - CONNECT_TOL) / GROUP_BUCKET_CELL),
    Math.floor((Math.max(l.x1, l.x2) + CONNECT_TOL) / GROUP_BUCKET_CELL),
    Math.floor((Math.min(l.y1, l.y2) - CONNECT_TOL) / GROUP_BUCKET_CELL),
    Math.floor((Math.max(l.y1, l.y2) + CONNECT_TOL) / GROUP_BUCKET_CELL),
  ])
  const startXs = [...new Set(span.map(s => s[0]))].filter(Number.isFinite).sort((a, b) => a - b)
  const startYs = [...new Set(span.map(s => s[2]))].filter(Number.isFinite).sort((a, b) => a - b)
  const cellMap = new Map<string, number[]>()
  for (let i = 0; i < lines.length; i++) {
    const [cx1, cx2, cy1, cy2] = span[i]
    for (let a = lowerBound(startXs, cx1); a < startXs.length && startXs[a] <= cx2; a++) {
      for (let b = lowerBound(startYs, cy1); b < startYs.length && startYs[b] <= cy2; b++) {
        const key = startXs[a] + "," + startYs[b]
        const arr = cellMap.get(key)
        if (arr) arr.push(i)
        else cellMap.set(key, [i])
      }
    }
  }

  const tested = new Set<number>()
  for (const arr of cellMap.values()) {
    for (let a = 0; a < arr.length; a++) {
      for (let b = a + 1; b < arr.length; b++) {
        const i = Math.min(arr[a], arr[b])
        const j = Math.max(arr[a], arr[b])
        const key = i * lines.length + j
        if (tested.has(key)) continue
        tested.add(key)
        if (linesIntersect(lines[i], lines[j], tol)) {
          union(i, j)
        }
      }
    }
  }

  const groups = new Map<number, TypedLine[]>()
  for (let i = 0; i < lines.length; i++) {
    const root = find(i)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root)!.push(lines[i])
  }

  return [...groups.values()]
}

/** 수평선과 수직선의 교차 판정 (tolerance 포함) */
function linesIntersect(a: TypedLine, b: TypedLine, tol = CONNECT_TOL): boolean {
  if (a.type === b.type) {
    if (a.type === "h") {
      if (Math.abs(a.y1 - b.y1) > tol) return false
      return Math.min(a.x2, b.x2) >= Math.max(a.x1, b.x1) - tol
    } else {
      if (Math.abs(a.x1 - b.x1) > tol) return false
      return Math.min(a.y2, b.y2) >= Math.max(a.y1, b.y1) - tol
    }
  }

  const h = a.type === "h" ? a : b
  const v = a.type === "h" ? b : a

  return (
    v.x1 >= h.x1 - tol && v.x1 <= h.x2 + tol &&
    h.y1 >= v.y1 - tol && h.y1 <= v.y2 + tol
  )
}
