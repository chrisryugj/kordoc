/**
 * 머리 상자 아래 무괘선 행 (line-detector.ts 계열 전처리).
 *
 * 머리행만 칸 괘선(음영 상자)으로 두르고 데이터 행은 괘선 없이 같은 열에 늘어놓는 표가 있다
 * (ODL 127 감가상각표·130 수익률표). 선 격자는 머리 한 행이라 1행 격자로 버려지고(page-blocks),
 * 데이터 행은 클러스터 감지가 글 가장자리로 열을 다시 세워 빈 사이 열·잘린 행이 생긴다.
 *
 * 머리 상자의 칸 경계가 열 증거다. 상자 바로 아래 글줄이 저마다 상자 칸 하나 안에만 놓이고
 * 고른 줄 간격으로 이어지는 동안을 표 행으로 보고, 그 행 경계에 가상 괘선을, 칸 경계에 상자
 * 아래로 이어지는 가상 수직선을 더한다. 칸 경계를 가로지르는 글(본문 문장)·큰 간격·다른 괘선에서 멈춘다.
 * 클립 격자 쪽(한컴 PDF)은 클립이 진실이라 부르지 않는다.
 */

import type { LineSegment } from "./line-types.js"
import { buildTableGrids } from "./table-grid.js"
import { type NormItem, groupByY } from "./text-line.js"

/** 머리 상자 최대 높이 (pt) — 세 줄 머리 */
const MAX_BOX_H = 48
/** 칸 경계 넘침 허용 (pt) */
const EDGE_TOL = 2
/** 상자 아래 첫 줄까지 최대 간격 (글줄 높이 배수) */
const FIRST_GAP_K = 2.5
/** 줄 간격이 첫 행 간격의 이 배를 넘으면 표 끝 */
const PITCH_BREAK_K = 1.8
/** 앞 줄과의 간격이 행 간격의 이 비율 미만이면 같은 행의 꺾인 줄 */
const WRAP_K = 0.75
/** 최소 데이터 행 수 */
const MIN_ROWS = 2

/** 칸 경계 목록에서 아이템이 온전히 든 칸 번호 (없으면 -1) */
function columnOf(it: NormItem, colXs: number[]): number {
  for (let c = 0; c + 1 < colXs.length; c++) {
    if (it.x >= colXs[c] - EDGE_TOL && it.x + it.w <= colXs[c + 1] + EDGE_TOL) return c
  }
  return -1
}

/**
 * 1행 머리 상자 아래 무괘선 데이터 행에 가상 괘선을 더한다. 조건 미달이면 입력을 그대로 반환한다.
 */
export function extendHeaderBoxRows(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  items: NormItem[],
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const boxes = buildTableGrids(horizontals, verticals).filter(g => g.rowYs.length === 2 && g.colXs.length >= 3 &&
    g.bbox.y2 - g.bbox.y1 <= MAX_BOX_H)
  if (boxes.length === 0) return { horizontals, verticals }
  const addH: LineSegment[] = [], addV: LineSegment[] = []
  const lines = groupByY([...items].sort((a, b) => b.y - a.y || a.x - b.x))
  for (const box of boxes) {
    const { x1, x2, y1: boxBottom } = box.bbox
    const below = lines.filter(l => l[0].y + l[0].h < boxBottom + EDGE_TOL)
    const rows: NormItem[][][] = []
    let prevY = boxBottom, pitch = 0
    for (const line of below) {
      const y = line[0].y, h = Math.max(...line.map(it => it.h || it.fontSize))
      const gap = prevY - y
      if (rows.length === 0 ? boxBottom - (y + h) > h * FIRST_GAP_K : gap > (pitch || gap) * PITCH_BREAK_K) break
      // 줄에 표 밖 글이 있거나 칸 경계를 가로지르는 글이 있으면 표가 아니다
      if (line.some(it => it.x + it.w < x1 - EDGE_TOL || it.x > x2 + EDGE_TOL || columnOf(it, box.colXs) < 0)) break
      // 사이에 괘선이 있으면 다른 표·구획
      if (horizontals.some(hl => hl.y1 < prevY - EDGE_TOL && hl.y1 > y + h && hl.x1 < x2 && hl.x2 > x1)) break
      if (rows.length > 0 && pitch > 0 && gap < pitch * WRAP_K) rows[rows.length - 1].push(line)
      else {
        if (rows.length === 1) pitch = gap
        rows.push([line])
      }
      prevY = y
    }
    if (rows.length < MIN_ROWS || !rows.some(r => r.flat().length >= 2)) continue
    // 행 경계: 위 행 아래 끝과 아래 행 위 끝의 가운데, 마지막은 마지막 줄 아래
    const top = (r: NormItem[][]) => Math.max(...r.flat().map(it => it.y + (it.h || it.fontSize)))
    const bottom = (r: NormItem[][]) => Math.min(...r.flat().map(it => it.y))
    const cuts: number[] = []
    for (let i = 0; i + 1 < rows.length; i++) cuts.push((bottom(rows[i]) + top(rows[i + 1])) / 2)
    const tableBottom = bottom(rows[rows.length - 1]) - Math.max(2, (pitch - (top(rows[0]) - bottom(rows[0]))) / 2)
    cuts.push(tableBottom)
    for (const y of cuts) addH.push({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })
    for (const x of box.colXs) addV.push({ x1: x, y1: tableBottom, x2: x, y2: boxBottom, lineWidth: 0.5 })
  }
  if (addH.length === 0) return { horizontals, verticals }
  return { horizontals: [...horizontals, ...addH], verticals: [...verticals, ...addV] }
}
