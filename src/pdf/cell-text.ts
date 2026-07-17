/**
 * 셀 텍스트 매핑/조립 (line-detector.ts에서 분리).
 * 텍스트 아이템 → 셀 매핑(교차 비율), 셀 텍스트 문자열 조립(균등배분·탭 갭),
 * 셀 내 줄바꿈 병합.
 *
 * getIntersectionPercent 방식은 OpenDataLoader PDF 참고 clean-room 재구현.
 * Original algorithm: Copyright 2025-2026 Hancom, Inc. (Apache 2.0)
 * https://github.com/opendataloader-project/opendataloader-pdf
 */

import type { ExtractedCell, TextItem } from "./line-types.js"

/** 셀 경계 내부 판별 여유 (텍스트 매핑용) */
const CELL_PADDING = 2

/**
 * 공백 삽입 갭 임계값 — 폰트 크기 비례.
 * 절대 px(3px) 기준은 Type3 폰트(예: fontSize 10.5에서 단어 갭 2.7px)에서 공백이
 * 소실되고, 작은 폰트에서는 과다 삽입됨. fontSize×0.17 비례 기준으로 교체
 * (veraPDF wcag-algs TEXT_LINE_SPACE_RATIO 아이디어의 클린룸 재구현 — 코드 비복사).
 */
export const SPACE_GAP_RATIO = 0.17

export function spaceGapThreshold(fontSize: number): number {
  return Math.max(fontSize * SPACE_GAP_RATIO, 1)
}

/**
 * 텍스트 아이템을 셀에 매핑.
 * v2: ODL의 getIntersectionPercent 방식 — 텍스트 bbox와 셀 bbox의 교차 비율로 판별.
 * 중심점만 보는 기존 방식보다 정확 (긴 텍스트가 셀 경계를 걸치는 경우 처리).
 */
export function mapTextToCells(
  items: TextItem[],
  cells: ExtractedCell[],
): Map<ExtractedCell, TextItem[]> {
  const result = new Map<ExtractedCell, TextItem[]>()
  for (const cell of cells) {
    result.set(cell, [])
  }

  for (const item of items) {
    const pad = CELL_PADDING

    let bestCell: ExtractedCell | null = null
    let bestScore = 0

    for (const cell of cells) {
      // 텍스트 bbox와 셀 bbox의 교차 영역 계산
      const ix1 = Math.max(item.x, cell.bbox.x1 - pad)
      const ix2 = Math.min(item.x + item.w, cell.bbox.x2 + pad)
      const iy1 = Math.max(item.y, cell.bbox.y1 - pad)
      const iy2 = Math.min(item.y + (item.h || item.fontSize), cell.bbox.y2 + pad)

      if (ix1 >= ix2 || iy1 >= iy2) continue

      const intersectArea = (ix2 - ix1) * (iy2 - iy1)
      const itemArea = Math.max(item.w, 1) * Math.max(item.h || item.fontSize, 1)
      const score = intersectArea / itemArea // ODL의 MIN_CELL_CONTENT_INTERSECTION_PERCENT

      if (score > bestScore) {
        bestScore = score
        bestCell = cell
      }
    }

    // 교차 비율 > 0.3이면 셀에 할당 (ODL은 0.6이지만 PDF 텍스트 좌표 오차 고려)
    if (bestCell && bestScore > 0.3) {
      result.get(bestCell)!.push(item)
    }
  }

  return result
}

/**
 * 셀 내 텍스트 아이템을 읽기 순서로 정렬 후 합치기.
 * Y 내림차순 (위→아래) → X 오름차순 (좌→우)
 */
export function cellTextToString(items: TextItem[]): string {
  if (items.length === 0) return ""
  if (items.length === 1) return items[0].text

  // Y좌표로 행 그룹핑 (tolerance: max(3, fontSize*0.6))
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: TextItem[][] = []
  let curLine: TextItem[] = [sorted[0]]
  let curY = sorted[0].y

  for (let i = 1; i < sorted.length; i++) {
    const tol = Math.max(3, Math.min(sorted[i].fontSize, curLine[0].fontSize) * 0.6)
    if (Math.abs(sorted[i].y - curY) <= tol) {
      curLine.push(sorted[i])
    } else {
      lines.push(curLine)
      curLine = [sorted[i]]
      curY = sorted[i].y
    }
  }
  lines.push(curLine)

  // 첨자 행 흡수 — 본문 행보다 살짝 떠 있는 작은 심볼 조각(▲·원문자·각주 마커)이
  // tolerance를 벗어나 별도 행이 된 것을 수직 겹침으로 되돌린다
  // (text-line.ts mergeSuperscriptLines와 동일 규칙: 조각 ≤3개·각 ≤8자·
  //  높이가 인접 행의 80% 이하·수직 겹침 ≥ 조각 높이 50%)
  const merged = mergeSuperscriptRows(lines)

  // 각 행을 텍스트로 변환 — 좌표 기반 균등배분 감지 포함
  const textLines = merged.map(line => {
    const s = line.sort((a, b) => a.x - b.x)
    if (s.length === 1) return s[0].text

    // 균등배분 구간 감지 (좌표 기반)
    const evenSpaced = detectEvenSpacedItems(s)

    let result = s[0].text
    for (let j = 1; j < s.length; j++) {
      // 균등배분 구간이면 무조건 공백 없이 합침
      if (evenSpaced[j]) {
        result += s[j].text
        continue
      }

      const gap = s[j].x - (s[j - 1].x + s[j - 1].w)
      const avgFs = (s[j].fontSize + s[j - 1].fontSize) / 2
      // pdfjs 공백 아이템 힌트 — 단어 경계 확정 (Type3 폰트 글자 분리 셀 텍스트 복원)
      if (s[j].hasSpaceBefore && gap >= avgFs * 0.05) {
        result += " " + s[j].text
      } else if (gap > spaceGapThreshold(avgFs)) {
        result += " " + s[j].text
      } else {
        result += s[j].text
      }
    }
    return result
  })

  return mergeCellTextLines(textLines)
}

/** 첨자 행 병합 — cellTextToString 행 그룹핑 결과에 적용 (규칙은 text-line.ts와 동일) */
function mergeSuperscriptRows(lines: TextItem[][]): TextItem[][] {
  if (lines.length <= 1) return lines
  const band = (line: TextItem[]) => {
    let bottom = Infinity, top = -Infinity
    for (const i of line) {
      const h = i.h > 0 ? i.h : i.fontSize
      if (i.y < bottom) bottom = i.y
      if (i.y + h > top) top = i.y + h
    }
    return { bottom, top, height: top - bottom }
  }
  const isFrag = (line: TextItem[]) => {
    if (line.length > 8) return false
    let total = 0
    for (const i of line) total += i.text.trim().length
    return total > 0 && total <= 10
  }

  const result: TextItem[][] = [lines[0]]
  for (let i = 1; i < lines.length; i++) {
    const prev = result[result.length - 1]
    const curr = lines[i]
    const a = band(prev)
    const b = band(curr)
    const overlap = Math.min(a.top, b.top) - Math.max(a.bottom, b.bottom)
    const prevIsFrag = isFrag(prev) && a.height <= b.height * 0.8 && overlap >= a.height * 0.5
    const currIsFrag = isFrag(curr) && b.height <= a.height * 0.8 && overlap >= b.height * 0.5
    if (prevIsFrag || currIsFrag) {
      result[result.length - 1] = [...prev, ...curr]
    } else {
      result.push(curr)
    }
  }
  return result
}

/**
 * 좌표 기반 균등배분 감지 — TextItem 배열에서 한글 1~2자 아이템이
 * 일정 간격으로 3개+ 연속되면 균등배분으로 판단.
 * ODL TextLineProcessor의 핵심 로직을 좌표 기반으로 구현.
 */
function detectEvenSpacedItems(items: TextItem[]): boolean[] {
  const result = new Array(items.length).fill(false)
  if (items.length < 3) return result

  let runStart = -1
  for (let i = 0; i < items.length; i++) {
    // 균등배분 = 한글 1자 개별 배치. 2자 단어는 균등배분이 아니라 실제 단어.
    const isShortKorean = /^[가-힣]{1}$/.test(items[i].text) || /^[\d]{1}$/.test(items[i].text)

    // 명시적 공백 글리프가 직전에 있으면 단어 경계 — 균등배분 run 분리.
    // (Type3 폰트가 글자를 1자씩 배치하면서 공백 글리프를 따로 두는 경우,
    //  진짜 단어 경계를 균등배분으로 오판해 문장 전체가 붙는 것을 방지)
    if (isShortKorean && runStart >= 0 && items[i].hasSpaceBefore) {
      if (i - runStart >= 3) markEvenRun(items, result, runStart, i)
      runStart = i
      continue
    }

    // 이전 아이템과의 갭이 fontSize*3+ 이면 run 끊기 (다른 영역)
    if (isShortKorean && runStart >= 0 && i > 0) {
      const gap = items[i].x - (items[i - 1].x + items[i - 1].w)
      const maxRunGap = Math.max(items[i].fontSize * 3, 30)
      if (gap > maxRunGap) {
        if (i - runStart >= 3) markEvenRun(items, result, runStart, i)
        runStart = i
        continue
      }
    }

    if (isShortKorean) {
      if (runStart < 0) runStart = i
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        markEvenRun(items, result, runStart, i)
      }
      runStart = -1
    }
  }
  if (runStart >= 0 && items.length - runStart >= 3) {
    markEvenRun(items, result, runStart, items.length)
  }

  return result
}

function markEvenRun(items: TextItem[], result: boolean[], start: number, end: number): void {
  const gaps: number[] = []
  for (let i = start + 1; i < end; i++) {
    gaps.push(items[i].x - (items[i - 1].x + items[i - 1].w))
  }
  const posGaps = gaps.filter(g => g > 0)
  if (posGaps.length < 2) return

  let minGap = Infinity, maxGap = -Infinity
  for (const g of posGaps) { if (g < minGap) minGap = g; if (g > maxGap) maxGap = g }
  const avgFs = items[start].fontSize

  // 간격이 fontSize의 0.1~3배 사이이고, 최대/최소 비율 3배 이내
  if (minGap >= avgFs * 0.1 && maxGap <= avgFs * 3 && maxGap / Math.max(minGap, 0.1) <= 3) {
    for (let i = start + 1; i < end; i++) {
      result[i] = true
    }
  }
}

export { detectEvenSpacedItems }

/**
 * 셀 내 텍스트 아이템을 읽기 순서로 정렬 후 합치기 — 줄바꿈 병합 전용.
 * (cellTextToString 내부에서 사용)
 */
function mergeCellTextLines(textLines: string[]): string {
  // 셀 내 줄바꿈 병합 — 잘린 단어/숫자 조각 복구
  if (textLines.length <= 1) return textLines[0] || ""
  const merged: string[] = [textLines[0]]
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = textLines[i]
    if (/[가-힣]$/.test(prev) && /^[가-힣]+$/.test(curr) && curr.length <= 8 && !curr.includes(" ")) {
      merged[merged.length - 1] = prev + curr
    }
    else if (curr.trim().length <= 3 && /^[)\]%}]/.test(curr.trim())) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else if (/[,(]$/.test(prev.trim()) && curr.trim().length <= 15) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else if (/[\d,]$/.test(prev) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else {
      merged.push(curr)
    }
  }
  return merged.join("\n")
}
