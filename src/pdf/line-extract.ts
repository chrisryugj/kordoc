/**
 * PDF 그래픽 명령에서 수평/수직 선을 추출하는 모듈 (line-detector.ts에서 분리).
 *
 * 선 전처리 파이프라인은 OpenDataLoader PDF의 LinesPreprocessingConsumer를
 * 참고하여 TypeScript로 clean-room 재구현한 것입니다.
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 */

import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import type { LineSegment } from "./line-types.js"

// ─── pdfjs-dist v5 DrawOPS ──
const enum DrawOPS {
  moveTo = 0,
  lineTo = 1,
  curveTo = 2,
  quadraticCurveTo = 3,
  closePath = 4,
}

/** 수평/수직 판별 허용 오차 (pt) */
const ORIENTATION_TOL = 2
/** 최소 선 길이 — 짧은 장식선(체크박스 테두리 등) 무시 */
const MIN_LINE_LENGTH = 15
/** 굵은 선 필터 — ODL: MAX_LINE_WIDTH = 5.0 (배경 채움/장식 사각형 제외) */
const MAX_LINE_WIDTH = 5.0

// ─── 선 추출 ──────────────────────────────────────────

/**
 * pdfjs operatorList에서 수평/수직 선을 추출.
 * constructPath(91) 내의 moveTo→lineTo, rectangle 패턴을 인식.
 */
export function extractLines(
  fnArray: Uint32Array | number[],
  argsArray: unknown[][],
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const horizontals: LineSegment[] = []
  const verticals: LineSegment[] = []
  let lineWidth = 1

  // CTM 추적 — 경로 좌표는 구성 시점의 CTM 공간에 있다. 콘텐츠 스트림이
  // 축소/플립 변환을 깔면(성과계획서류: [0.75,0,0,-0.75,0,H]) 선이 텍스트
  // (getTextContent는 CTM 적용 완료)와 다른 좌표계에 놓여 그리드-텍스트 매핑이
  // 전멸한다. extractImageRegions와 동일하게 save/restore/transform을 따라간다.
  let ctm = [1, 0, 0, 1, 0, 0]
  const ctmStack: number[][] = []
  const applyCtm = (x: number, y: number): [number, number] =>
    [ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]
  /** CTM 평균 스케일 — lineWidth를 사용자 공간 두께로 환산 */
  const ctmScale = () =>
    (Math.hypot(ctm[0], ctm[1]) + Math.hypot(ctm[2], ctm[3])) / 2

  let currentPath: Array<{ x1: number; y1: number; x2: number; y2: number }> = []
  let pathStartX = 0, pathStartY = 0
  let curX = 0, curY = 0

  /** 원시 좌표 세그먼트를 CTM 적용해 경로에 추가 */
  function pushSeg(x1: number, y1: number, x2: number, y2: number) {
    const [tx1, ty1] = applyCtm(x1, y1)
    const [tx2, ty2] = applyCtm(x2, y2)
    currentPath.push({ x1: tx1, y1: ty1, x2: tx2, y2: ty2 })
  }

  function pushRectangle(rx: number, ry: number, rw: number, rh: number) {
    // 얇은 사각형(선으로 그린 괘선) 판별은 CTM 적용 후 실제 두께 기준
    const effH = Math.abs(rh) * Math.hypot(ctm[2], ctm[3])
    const effW = Math.abs(rw) * Math.hypot(ctm[0], ctm[1])
    if (effH < ORIENTATION_TOL * 2) {
      pushSeg(rx, ry + rh / 2, rx + rw, ry + rh / 2)
    } else if (effW < ORIENTATION_TOL * 2) {
      pushSeg(rx + rw / 2, ry, rx + rw / 2, ry + rh)
    } else {
      pushSeg(rx, ry, rx + rw, ry)
      pushSeg(rx + rw, ry, rx + rw, ry + rh)
      pushSeg(rx + rw, ry + rh, rx, ry + rh)
      pushSeg(rx, ry + rh, rx, ry)
    }
  }

  function flushPath(isStroke: boolean) {
    if (!isStroke) { currentPath = []; return }
    const effWidth = lineWidth * ctmScale()
    for (const seg of currentPath) {
      classifyAndAdd(seg, effWidth, horizontals, verticals)
    }
    currentPath = []
  }

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i]
    const args = argsArray[i]

    switch (op) {
      case OPS.setLineWidth:
        lineWidth = (args as number[])[0] || 1
        break

      case OPS.save:
        ctmStack.push(ctm.slice())
        break

      case OPS.restore:
        ctm = ctmStack.pop() ?? [1, 0, 0, 1, 0, 0]
        break

      case OPS.transform: {
        const t = args as number[]
        ctm = [
          ctm[0] * t[0] + ctm[2] * t[1],
          ctm[1] * t[0] + ctm[3] * t[1],
          ctm[0] * t[2] + ctm[2] * t[3],
          ctm[1] * t[2] + ctm[3] * t[3],
          ctm[0] * t[4] + ctm[2] * t[5] + ctm[4],
          ctm[1] * t[4] + ctm[3] * t[5] + ctm[5],
        ]
        break
      }

      case OPS.constructPath: {
        const arg0 = args[0]

        if (Array.isArray(arg0)) {
          // ── pdfjs-dist v4 형식 ──
          const subOps = arg0 as number[]
          const coords = (args as [number[], number[]])[1]
          let ci = 0

          for (const subOp of subOps) {
            if (subOp === OPS.moveTo) {
              curX = coords[ci++]; curY = coords[ci++]
              pathStartX = curX; pathStartY = curY
            } else if (subOp === OPS.lineTo) {
              const x2 = coords[ci++], y2 = coords[ci++]
              pushSeg(curX, curY, x2, y2)
              curX = x2; curY = y2
            } else if (subOp === OPS.rectangle) {
              const rx = coords[ci++], ry = coords[ci++]
              const rw = coords[ci++], rh = coords[ci++]
              pushRectangle(rx, ry, rw, rh)
            } else if (subOp === OPS.closePath) {
              if (curX !== pathStartX || curY !== pathStartY) {
                pushSeg(curX, curY, pathStartX, pathStartY)
              }
              curX = pathStartX; curY = pathStartY
            } else if (subOp === OPS.curveTo) {
              ci += 6
            } else if (subOp === OPS.curveTo2 || subOp === OPS.curveTo3) {
              ci += 4
            }
          }
        } else {
          // ── pdfjs-dist v5 형식 ──
          const afterOp = arg0 as number
          const dataArr = args[1] as unknown[]
          const pathData = dataArr?.[0] as Record<number, number> | undefined
          if (pathData && typeof pathData === "object") {
            const len = Object.keys(pathData).length
            let di = 0
            while (di < len) {
              const drawOp = pathData[di++]
              if (drawOp === DrawOPS.moveTo) {
                curX = pathData[di++]; curY = pathData[di++]
                pathStartX = curX; pathStartY = curY
              } else if (drawOp === DrawOPS.lineTo) {
                const x2 = pathData[di++], y2 = pathData[di++]
                pushSeg(curX, curY, x2, y2)
                curX = x2; curY = y2
              } else if (drawOp === DrawOPS.curveTo) {
                di += 6
              } else if (drawOp === DrawOPS.quadraticCurveTo) {
                di += 4
              } else if (drawOp === DrawOPS.closePath) {
                if (curX !== pathStartX || curY !== pathStartY) {
                  pushSeg(curX, curY, pathStartX, pathStartY)
                }
                curX = pathStartX; curY = pathStartY
              } else {
                break
              }
            }
          }

          if (afterOp === OPS.stroke || afterOp === OPS.closeStroke) {
            flushPath(true)
          } else if (afterOp === OPS.fill || afterOp === OPS.eoFill ||
                     afterOp === OPS.fillStroke || afterOp === OPS.eoFillStroke ||
                     afterOp === OPS.closeFillStroke || afterOp === OPS.closeEOFillStroke) {
            flushPath(true)
          } else if (afterOp === OPS.endPath) {
            flushPath(false)
          }
        }
        break
      }

      case OPS.stroke:
      case OPS.closeStroke:
        flushPath(true)
        break

      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        flushPath(true)
        break

      case OPS.endPath:
        flushPath(false)
        break
    }
  }

  return { horizontals, verticals }
}


function classifyAndAdd(
  seg: { x1: number; y1: number; x2: number; y2: number },
  lineWidth: number,
  horizontals: LineSegment[],
  verticals: LineSegment[],
) {
  const dx = Math.abs(seg.x2 - seg.x1)
  const dy = Math.abs(seg.y2 - seg.y1)
  const length = Math.sqrt(dx * dx + dy * dy)

  if (length < MIN_LINE_LENGTH) return

  if (dy <= ORIENTATION_TOL) {
    const y = (seg.y1 + seg.y2) / 2
    const x1 = Math.min(seg.x1, seg.x2)
    const x2 = Math.max(seg.x1, seg.x2)
    horizontals.push({ x1, y1: y, x2, y2: y, lineWidth })
  } else if (dx <= ORIENTATION_TOL) {
    const x = (seg.x1 + seg.x2) / 2
    const y1 = Math.min(seg.y1, seg.y2)
    const y2 = Math.max(seg.y1, seg.y2)
    verticals.push({ x1: x, y1, x2: x, y2, lineWidth })
  }
}

// ─── 선 전처리 파이프라인 (ODL LinesPreprocessingConsumer 포팅) ──

/**
 * 선 전처리: 굵은 선 필터 → 음영 스택 제거 → 근접 선 병합 → 장식선 필터링
 * ODL의 LinesPreprocessingConsumer가 하는 핵심 로직.
 */
export function preprocessLines(
  horizontals: LineSegment[],
  verticals: LineSegment[],
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  // 1. 굵은 선 필터링 (배경 채움 사각형, 장식 테두리 등)
  let h = horizontals.filter(l => l.lineWidth <= MAX_LINE_WIDTH)
  let v = verticals.filter(l => l.lineWidth <= MAX_LINE_WIDTH)

  // 1.5. 음영/그라디언트 스택 제거 — 근접 병합 전에 해야 실제 괘선을 삼키지 않음
  h = dropShadingStacks(h, "h")
  v = dropShadingStacks(v, "v")

  // 2. 근접 평행 선 병합 (인쇄 잔상, 이중선)
  h = mergeParallelLines(h, "h")
  v = mergeParallelLines(v, "v")

  return { horizontals: h, verticals: v }
}

// ─── 음영 스택 필터 ───────────────────────────────────

/** 음영 스택 판정: 같은 범위 평행선의 연속 간격이 이 값 미만 (실제 괘선 행 높이는 6pt+) */
const STACK_GAP = 2
/** 음영 스택 최소 줄 수 — 괘선 이중 인쇄(2줄)와 구분 */
const STACK_MIN_LINES = 6

/**
 * 음영/그라디언트 스택 제거 — 한컴 PDF는 글상자 배경 그라디언트를 같은 범위의
 * 가는 평행선 수십 개(0.5pt 간격)로 그린다. 이대로 두면 근접 평행 선 병합이
 * 스택과 함께 주변의 실제 상하 테두리까지 연쇄 흡수해 박스 괘선이 소실된다.
 */
function dropShadingStacks(lines: LineSegment[], dir: "h" | "v"): LineSegment[] {
  if (lines.length < STACK_MIN_LINES) return lines

  // 같은 (시작~끝) 범위끼리 그룹 — 스택은 같은 그리기 루프 산물이라 좌표가 동일
  const groups = new Map<string, LineSegment[]>()
  for (const l of lines) {
    const key = dir === "h"
      ? `${Math.round(l.x1)}:${Math.round(l.x2)}`
      : `${Math.round(l.y1)}:${Math.round(l.y2)}`
    const arr = groups.get(key)
    if (arr) arr.push(l)
    else groups.set(key, [l])
  }

  const dropped = new Set<LineSegment>()
  for (const group of groups.values()) {
    if (group.length < STACK_MIN_LINES) continue
    group.sort((a, b) => (dir === "h" ? a.y1 - b.y1 : a.x1 - b.x1))
    let runStart = 0
    for (let i = 1; i <= group.length; i++) {
      const gap = i < group.length
        ? (dir === "h" ? group[i].y1 - group[i - 1].y1 : group[i].x1 - group[i - 1].x1)
        : Infinity
      if (gap < STACK_GAP) continue
      if (i - runStart >= STACK_MIN_LINES) {
        for (let j = runStart; j < i; j++) dropped.add(group[j])
      }
      runStart = i
    }
  }
  return dropped.size ? lines.filter(l => !dropped.has(l)) : lines
}

// ─── 개방 변 표 테두리 합성 ──────────────────────────

/** 수평 괘선 끝점 정렬 그룹 허용 오차 (pt) */
const EDGE_ALIGN_TOL = 3
/** 합성 최소 괘선 수 (3줄 = 2행 이상) */
const EDGE_MIN_RULES = 3
/** 그룹 y-스팬 최소 (2행 × 최소 행 높이) — 장식 겹줄 배제 */
const EDGE_MIN_SPAN = 12
/** 내부 수직선 판정: 변에서 이만큼 안쪽 (table-grid MIN_COL_WIDTH와 동일) */
const EDGE_INSET = 15
/** 기존 수직선이 이 거리 안에 있으면 그 변은 이미 닫힌 것 */
const EDGE_NEAR = 10
/** 선 교차 판정 여유 (table-grid CONNECT_TOL과 동일) */
const EDGE_CONNECT_TOL = 5
/** 체인 뷰: 같은 논리 괘선으로 묶는 y 허용 오차 (pt) */
const CHAIN_Y_TOL = 1.5
/** 체인 뷰: 콜리니어 세그먼트 연결 최대 간격 (pt) */
const CHAIN_GAP = 3

/**
 * 체인 뷰 — 같은 y의 콜리니어 세그먼트(셀 단위로 쪼개 그은 괘선)를 논리
 * 괘선 하나로 잇는다. closeOpenTableEdges의 끝점 정렬 판정 전용이며 물리
 * 수평선은 수정하지 않는다 (물리 병합은 셀 배치 변질 실측으로 폐기, 9차).
 * 근접 평행 겹줄(장식 이중선)도 한 논리 괘선으로 흡수된다.
 */
function chainCollinearRules(horizontals: LineSegment[]): LineSegment[] {
  if (horizontals.length <= 1) return horizontals
  const sorted = [...horizontals].sort((a, b) => a.y1 - b.y1 || a.x1 - b.x1)
  const rules: LineSegment[] = []
  let bandStart = 0
  const flushBand = (end: number) => {
    const band = sorted.slice(bandStart, end).sort((a, b) => a.x1 - b.x1)
    let cur = { ...band[0] }
    for (let i = 1; i < band.length; i++) {
      const seg = band[i]
      if (seg.x1 - cur.x2 <= CHAIN_GAP) {
        if (seg.x2 > cur.x2) cur.x2 = seg.x2
        if (seg.lineWidth > cur.lineWidth) cur.lineWidth = seg.lineWidth
      } else {
        rules.push(cur)
        cur = { ...seg }
      }
    }
    rules.push(cur)
  }
  for (let i = 1; i <= sorted.length; i++) {
    if (i === sorted.length || sorted[i].y1 - sorted[bandStart].y1 > CHAIN_Y_TOL) {
      flushBand(i)
      bandStart = i
    }
  }
  return rules
}

/**
 * 개방 변 표 테두리 합성 — 한국 행정문서 표는 좌/우 바깥 테두리를 생략하는
 * 스타일이 흔하다 (수평 괘선은 전폭으로 긋고 수직선은 내부 구분선만).
 * 교차점(Vertex) 기반 그리드 구성은 수직선 없는 변의 열을 통째로 잃으므로,
 * 끝점이 정렬된 수평 괘선 묶음(≥3줄)에 그 묶음 괘선 2개 이상과 교차하는 내부
 * 수직선이 실존할 때에 한해 끝점 x에 가상 수직 테두리를 합성해 그리드를 닫는다.
 * 판정은 체인 뷰(콜리니어 세그먼트를 이은 논리 괘선) 기준 — 셀 단위로 쪼개
 * 그은 중간 괘선도 끝점 정렬 그룹에 합류한다.
 *
 * 전역 끝점 그룹핑이라 폭이 비슷한 표가 위아래로 쌓인 페이지에선 그룹 하나로
 * 뭉쳐 y-범위가 넓어지고, 가장자리에 이미 수직선이 있는 경우가 많아 발동이
 * 보수적이다 — 의도된 안전 특성 (컴포넌트 단위 정밀화는 실측에서 demote 연쇄
 * 부작용으로 보류, 9차 세션 기록 참조).
 */
export function closeOpenTableEdges(
  horizontals: LineSegment[],
  verticals: LineSegment[],
): LineSegment[] {
  if (horizontals.length < EDGE_MIN_RULES) return verticals

  // 1) 끝점 정렬 그룹핑 (x1·x2 모두 근접) — 체인 뷰의 논리 괘선 기준
  const groups: LineSegment[][] = []
  for (const hl of chainCollinearRules(horizontals)) {
    let placed = false
    for (const g of groups) {
      if (Math.abs(g[0].x1 - hl.x1) <= EDGE_ALIGN_TOL && Math.abs(g[0].x2 - hl.x2) <= EDGE_ALIGN_TOL) {
        g.push(hl)
        placed = true
        break
      }
    }
    if (!placed) groups.push([hl])
  }

  const synthesized: LineSegment[] = []
  for (const g of groups) {
    if (g.length < EDGE_MIN_RULES) continue
    let yMin = Infinity, yMax = -Infinity, x1 = 0, x2 = 0
    for (const hl of g) {
      if (hl.y1 < yMin) yMin = hl.y1
      if (hl.y1 > yMax) yMax = hl.y1
      x1 += hl.x1
      x2 += hl.x2
    }
    x1 /= g.length
    x2 /= g.length
    if (yMax - yMin < EDGE_MIN_SPAN) continue

    // 2) 내부 수직선 실존 확인 — 그룹 괘선 2개 이상과 교차해야 표 기하
    const crossCount = (v: LineSegment) => {
      let n = 0
      for (const hl of g) {
        if (v.x1 >= hl.x1 - EDGE_CONNECT_TOL && v.x1 <= hl.x2 + EDGE_CONNECT_TOL &&
            hl.y1 >= v.y1 - EDGE_CONNECT_TOL && hl.y1 <= v.y2 + EDGE_CONNECT_TOL) n++
      }
      return n
    }
    const hasInterior = verticals.some(v =>
      v.x1 > x1 + EDGE_INSET && v.x1 < x2 - EDGE_INSET && crossCount(v) >= 2)
    if (!hasInterior) continue

    // 3) 변마다 근처에 기존 수직선이 없으면 가상 테두리 합성
    for (const edgeX of [x1, x2]) {
      const closed = verticals.some(v =>
        Math.abs(v.x1 - edgeX) <= EDGE_NEAR &&
        v.y1 <= yMax + EDGE_CONNECT_TOL && v.y2 >= yMin - EDGE_CONNECT_TOL)
      if (!closed) {
        synthesized.push({ x1: edgeX, y1: yMin, x2: edgeX, y2: yMax, lineWidth: 0.5 })
      }
    }
  }

  return synthesized.length ? [...verticals, ...synthesized] : verticals
}


/**
 * 근접 평행 선 병합 — 같은 방향의 가까운 선을 하나로 합침.
 * 이중선, 인쇄 잔상, PDF 렌더링 미세 차이로 인한 중복 선 제거.
 */
function mergeParallelLines(lines: LineSegment[], dir: "h" | "v"): LineSegment[] {
  if (lines.length <= 1) return lines

  // 수평선: y로 정렬, 수직선: x로 정렬
  const sorted = [...lines].sort((a, b) => {
    const posA = dir === "h" ? a.y1 : a.x1
    const posB = dir === "h" ? b.y1 : b.x1
    if (Math.abs(posA - posB) > 0.1) return posA - posB
    // 같은 위치면 시작 좌표로
    return dir === "h" ? (a.x1 - b.x1) : (a.y1 - b.y1)
  })

  const MERGE_TOL = 3 // 3pt 이내 평행 선 병합

  const result: LineSegment[] = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = result[result.length - 1]
    const curr = sorted[i]

    const prevPos = dir === "h" ? prev.y1 : prev.x1
    const currPos = dir === "h" ? curr.y1 : curr.x1

    if (Math.abs(prevPos - currPos) <= MERGE_TOL) {
      // 범위가 겹치는지 확인
      const prevStart = dir === "h" ? prev.x1 : prev.y1
      const prevEnd = dir === "h" ? prev.x2 : prev.y2
      const currStart = dir === "h" ? curr.x1 : curr.y1
      const currEnd = dir === "h" ? curr.x2 : curr.y2

      const overlap = Math.min(prevEnd, currEnd) - Math.max(prevStart, currStart)
      const minLen = Math.min(prevEnd - prevStart, currEnd - currStart)

      if (overlap > minLen * 0.3) {
        // 병합: 범위 확장, lineWidth는 최대값 유지
        if (dir === "h") {
          prev.x1 = Math.min(prev.x1, curr.x1)
          prev.x2 = Math.max(prev.x2, curr.x2)
          prev.y1 = (prev.y1 + curr.y1) / 2
          prev.y2 = prev.y1
        } else {
          prev.y1 = Math.min(prev.y1, curr.y1)
          prev.y2 = Math.max(prev.y2, curr.y2)
          prev.x1 = (prev.x1 + curr.x1) / 2
          prev.x2 = prev.x1
        }
        prev.lineWidth = Math.max(prev.lineWidth, curr.lineWidth)
        continue
      }
    }
    result.push(curr)
  }
  return result
}

// ─── 페이지 경계(클립) 선 필터링 ──────────────────────

export function filterPageBorderLines(
  horizontals: LineSegment[],
  verticals: LineSegment[],
  pageWidth: number,
  pageHeight: number,
): { horizontals: LineSegment[]; verticals: LineSegment[] } {
  const margin = 5
  return {
    horizontals: horizontals.filter(l =>
      !(Math.abs(l.y1) < margin || Math.abs(l.y1 - pageHeight) < margin) ||
      (l.x2 - l.x1) < pageWidth * 0.9
    ),
    verticals: verticals.filter(l =>
      !(Math.abs(l.x1) < margin || Math.abs(l.x1 - pageWidth) < margin) ||
      (l.y2 - l.y1) < pageHeight * 0.9
    ),
  }
}

