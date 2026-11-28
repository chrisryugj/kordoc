/**
 * HWP3 표 격자 복원 — 셀 정보(27바이트)의 기하로 행·열 좌표와 병합을 만든다.
 *
 * HWP3 셀 레코드에는 HWP5 LIST_HEADER 같은 격자 colAddr/rowAddr 가 없다(바이트 0·1 은 한글 97 자체 줄·칸 순번이라
 * 한컴 변환본 격자와 다르다). 셀마다 x·y·w·h(u16 @4·6·8·10, HWP3 단위)가 있어 다음 규칙으로 격자를 세운다 —
 * 한컴 HWP3→HWP5/HWPX 변환본 표 120개(hwp3-sample·10·11·16·19·SO-SUEOP)의 행·열·앵커를 전부 재현한 규칙:
 *   - 열 경계 = 셀 왼쪽 변 x 의 서로 다른 값 전부(허용치 없음 — 1단위 차이도 별도 열) + 표 오른쪽 끝,
 *     행 경계 = 셀 위쪽 변 y 전부 + 표 아래쪽 끝. 오른쪽·아래쪽 변은 경계를 만들지 않는다
 *     (셀 높이 합이 틀 높이보다 짧은 칸이 가짜 행을 만들지 않게 — sample16 접수 서식 16×4 → 15×4)
 *   - 셀의 오른쪽 끝 = 같은 행에 걸친 오른쪽 이웃 셀의 왼쪽 변(없으면 표 오른쪽 끝), 아래쪽 끝 = 아래 이웃의 위쪽 변
 *     (저장 좌표 1단위 어긋남으로 병합 폭이 한 칸 모자라지 않게 — sample16 인력 투입표)
 * 이 규칙은 rhwp(양쪽 변 + 허용치 40HU)와 다르다 — rhwp 규칙은 같은 120개 중 4개 표의 행·열이 어긋난다.
 * 겹침·빈 칸 처리는 호출측(ir-assemble.buildAddressedTable)이 맡는다.
 */

import { MAX_COLS, MAX_ROWS } from "../table/builder.js"

/** 이웃 판정 허용치 — 이웃 셀 왼쪽 변이 이 셀 오른쪽 변보다 조금 안쪽에 있어도(저장 반올림) 이웃으로 본다 */
const NEIGHBOR_SLACK = 10
/** 이웃 탐색 상한(서로 다른 시작 좌표 묶음 수) — 정상 표는 바로 다음 묶음에서 찾는다. 손상 파일의 계단형 셀(묶음마다 셀 하나)만 막는다 */
const MAX_NEIGHBOR_SCAN = 2048

export interface Hwp3CellPos {
  row: number
  col: number
  rowSpan: number
  colSpan: number
}

export interface Hwp3Grid {
  rows: number
  cols: number
  cells: Hwp3CellPos[]
}

interface Geo { x: number; y: number; r: number; b: number }

const uniqSorted = (values: number[]): number[] => [...new Set(values)].sort((a, b) => a - b)

/** 정렬된 경계 배열에서 v 의 위치 (v 는 경계에 있다) */
function edgeAt(edges: number[], v: number): number {
  let lo = 0, hi = edges.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (edges[mid] < v) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * 각 셀의 "다음 이웃 시작" — axis 방향(x: 오른쪽, y: 아래)으로 끝 변 이후에 시작하면서 다른 축으로 겹치는
 * 셀 중 가장 가까운 시작 좌표. 없으면 undefined.
 *
 * 셀을 시작 좌표별로 묶고, 묶음마다 다른 축 구간을 정렬해 겹치는 것끼리 합쳐 둔다. 끝 변 이후의 묶음을 가까운 것부터 보며
 * 묶음 안 겹침은 이분 탐색으로 가린다. 탐색 상한은 셀 수가 아니라 묶음 수다 — 종전엔 정렬한 셀을 2,048개까지 훑어, 행이
 * 2,048개를 넘는 표의 아래쪽 칸이 같은 열 위쪽 셀에 막혀 오른쪽 이웃을 못 찾고 표 끝까지 합쳐졌다
 */
function nextStarts(geo: Geo[], axis: "x" | "y"): Array<number | undefined> {
  const start = axis === "x" ? (g: Geo) => g.x : (g: Geo) => g.y
  const end = axis === "x" ? (g: Geo) => g.r : (g: Geo) => g.b
  const lo = axis === "x" ? (g: Geo) => g.y : (g: Geo) => g.x
  const hi = axis === "x" ? (g: Geo) => g.b : (g: Geo) => g.r
  const byStart = new Map<number, Array<[number, number]>>()
  for (const g of geo) {
    const list = byStart.get(start(g))
    if (list) list.push([lo(g), hi(g)])
    else byStart.set(start(g), [[lo(g), hi(g)]])
  }
  const starts = [...byStart.keys()].sort((a, b) => a - b)
  // 겹침 판정은 엄격(b.lo < a.hi && b.hi > a.lo)이라 끝점만 맞닿은 구간은 합치지 않는다
  const spans = starts.map(v => {
    const list = byStart.get(v)!.sort((a, b) => a[0] - b[0] || a[1] - b[1])
    const merged: Array<[number, number]> = []
    for (const [a, b] of list) {
      const last = merged[merged.length - 1]
      if (last && (a < last[1] || (a === last[0] && b === last[1]))) last[1] = Math.max(last[1], b)
      else merged.push([a, b])
    }
    return merged
  })
  /** 합친 구간 가운데 [a, b) 와 겹치는 것이 있나 — 시작이 b 보다 앞인 마지막 구간의 끝이 a 를 넘으면 */
  const overlaps = (merged: Array<[number, number]>, a: number, b: number): boolean => {
    let l = 0, h = merged.length
    while (l < h) { const m = (l + h) >> 1; if (merged[m][0] < b) l = m + 1; else h = m }
    return l > 0 && merged[l - 1][1] > a
  }
  return geo.map(g => {
    // 끝 변 − 허용치 이상, 그리고 자기 시작보다 뒤에서 시작하는 첫 묶음부터. 손상 파일의 계단형 셀이 O(n²) 로 돌지 않게 묶음 수로 묶는다
    let k = edgeAt(starts, Math.max(end(g) - NEIGHBOR_SLACK, start(g) + 1))
    if (k < starts.length && starts[k] < Math.max(end(g) - NEIGHBOR_SLACK, start(g) + 1)) k++
    for (let steps = 0; k < starts.length && steps < MAX_NEIGHBOR_SCAN; k++, steps++) {
      if (overlaps(spans[k], lo(g), hi(g))) return starts[k]
    }
    return undefined
  })
}

/** 셀 정보 블록(27바이트 × count) → 행·열 수와 셀별 좌표·병합 (셀 스트림 순서 그대로) */
export function hwp3CellGrid(info: Buffer, count: number): Hwp3Grid {
  const geo: Geo[] = []
  let right = 0, bottom = 0 // 셀 수가 수만일 수 있어 Math.max(...spread) 대신 누적 (인자 수 한도)
  for (let k = 0; k < count; k++) {
    const o = k * 27
    const x = info.readUInt16LE(o + 4), y = info.readUInt16LE(o + 6)
    const g = { x, y, r: x + info.readUInt16LE(o + 8), b: y + info.readUInt16LE(o + 10) }
    geo.push(g)
    if (g.r > right) right = g.r
    if (g.b > bottom) bottom = g.b
  }
  const xs = uniqSorted([...geo.map(g => g.x), right])
  const ys = uniqSorted([...geo.map(g => g.y), bottom])
  const nextX = nextStarts(geo, "x")
  const nextY = nextStarts(geo, "y")
  const cells = geo.map((g, k) => {
    const col = edgeAt(xs, g.x), row = edgeAt(ys, g.y)
    const c2 = nextX[k] !== undefined ? edgeAt(xs, nextX[k]!) : xs.length - 1
    const r2 = nextY[k] !== undefined ? edgeAt(ys, nextY[k]!) : ys.length - 1
    // 행·열·병합 상한은 HWP5 표와 같은 값 (손상 파일의 쓰레기 기하가 격자를 폭주시키지 않게)
    return { row, col, rowSpan: Math.min(Math.max(1, r2 - row), MAX_ROWS), colSpan: Math.min(Math.max(1, c2 - col), MAX_COLS) }
  })
  return { rows: Math.min(Math.max(1, ys.length - 1), MAX_ROWS), cols: Math.min(Math.max(1, xs.length - 1), MAX_COLS), cells }
}
