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
import { sortLineByX } from "./text-line.js"
import { type WrapLexicon, cellLineWraps, cellLineFills, startsNewItem, wrapJoiner } from "./line-wrap.js"

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

  keepWordsInOneCell(result)
  return result
}

/**
 * 낱말 응집 — 한 줄에서 공백 없이 붙은 조각(한 낱말)이 두 칸에 나뉘면 폭을 더 많이 담은 칸으로 모은다. 선 격자는 좁은
 * 들여쓰기 열(8.5pt 상자 좌변)을 최소 열폭으로 합쳐 경계 하나를 지우는데, 그 행에 괘선이 없는 경계를 걸친 낱말은 첫
 * 글자만 위 칸(행 병합)으로 떨어졌다("사|회적기업 사업개발비", "단|체교섭" — 부천·속초 세출예산사업명세서, 글자마다 따로
 * 그린 굴림체). 괘선이 있는 경계는 글이 걸칠 수 없으므로(획·칸 클립) 낱말의 어떤 글자가 제 칸 밖으로 1pt 넘게
 * 삐져나올 때(글이 경계를 실제로 가로지름)만 모은다 — 좁은 칸에 바짝 붙은 서로 다른 칸 글("10월|11월|12월", 창원
 * 월별 일정표 머리행)은 글자가 제 칸 안에 있어 그대로 둔다
 */
function keepWordsInOneCell(result: Map<ExtractedCell, TextItem[]>): void {
  const owner = new Map<TextItem, ExtractedCell>()
  for (const [cell, arr] of result) for (const it of arr) owner.set(it, cell)
  if (result.size < 2 || owner.size < 2) return
  const all = [...owner.keys()].sort((a, b) => b.y - a.y || a.x - b.x)
  for (let i = 0; i < all.length;) {
    let j = i + 1
    while (j < all.length && Math.abs(all[j].y - all[i].y) <= 1) j++
    const line = all.slice(i, j).sort((a, b) => a.x - b.x)
    for (let k = 0; k < line.length;) {
      let e = k + 1
      while (e < line.length && !line[e].hasSpaceBefore
        && line[e].x - (line[e - 1].x + line[e - 1].w) <= spaceGapThreshold((line[e].fontSize + line[e - 1].fontSize) / 2)) e++
      const word = line.slice(k, e)
      const width = new Map<ExtractedCell, number>()
      for (const it of word) { const c = owner.get(it)!; width.set(c, (width.get(c) ?? 0) + it.w) }
      const crosses = word.some(it => { const b = owner.get(it)!.bbox; return it.x < b.x1 - 1 || it.x + it.w > b.x2 + 1 })
      if (width.size > 1 && crosses) {
        const target = [...width].sort((a, b) => b[1] - a[1])[0][0]
        for (const it of word) {
          const c = owner.get(it)!
          if (c === target) continue
          result.set(c, result.get(c)!.filter(x => x !== it))
          result.get(target)!.push(it)
          owner.set(it, target)
        }
      }
      k = e
    }
    i = j
  }
}

/**
 * 셀 내 텍스트 아이템을 읽기 순서로 정렬 후 합치기.
 * Y 내림차순 (위→아래) → X 오름차순 (좌→우)
 * @param wrap 칸 상자·문서 어휘 증거 — 있으면 줄 꺾임을 기하·어휘로 판정해 어절 중간 꺾임만 붙인다(line-wrap.ts).
 *   없으면(과소분할 재구성 등 칸 상자 없는 호출) 종전 조각 규칙
 */
export function cellTextToString(items: TextItem[], wrap?: { box: { x1: number; x2: number }; lex?: WrapLexicon }): string {
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
    const s = sortLineByX(line)
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

  if (!wrap) return mergeCellTextLines(textLines)
  // 줄마다 "다음 줄로 꺾여 넘어갔나" — 다음 줄 첫 글자가 이 줄 뒤에 칸 안쪽으로 못 들어갈 때
  let contentLeft = Infinity
  for (const it of items) if (it.x < contentLeft) contentLeft = it.x
  const lineEnds = merged.map(line => {
    const s = sortLineByX(line)
    let right = -Infinity
    for (const it of s) if (it.x + it.w > right) right = it.x + it.w
    const first = s[0]
    return { right, fontSize: first.fontSize, firstCharW: first.w / Math.max(1, [...first.text].length) }
  })
  let cellRight = -Infinity
  for (const e of lineEnds) if (e.right > cellRight) cellRight = e.right
  const wraps = lineEnds.slice(0, -1).map((a, i) => cellLineWraps(wrap.box, contentLeft, a.right, a.fontSize, lineEnds[i + 1].firstCharW)
    || (lineEnds.length >= 3 && !textLines[i + 1].startsWith("(") && cellLineFills(wrap.box, contentLeft, cellRight, a.right, a.fontSize)))
  return mergeCellTextLines(textLines, { wraps, lex: wrap.lex })
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
  // 별지서식 기입 빈칸 "년   월   일"·"시   분" 은 균등배분이 아니다 — 글자 단위가 전부 날짜·시각 단위면 두고 문자열 안전망
  // (collapseEvenSpacing isDateUnitBlank)과 같게. 공백 글리프 없이 칸을 벌린 서식은 틈이 3em 안이면 여기서 붙었다
  // (hwpx↔pdf 칸 줄: 한 글자 조각이 날짜 단위뿐인 줄 46곳 중 원문이 붙여 쓴 곳 0 — 행정업무운영 편람 서식 "년 월 일")
  let dateOnly = true
  for (let i = start; i < end; i++) if (!/^[년월일시분초]$/.test(items[i].text)) { dateOnly = false; break }
  if (dateOnly) return
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
 * wrap 이 있으면 한글 줄 이음은 꺾임 판정(wraps[i] = textLines[i] 가 다음 줄로 꺾였나)과 어절 판정(wrapJoiner)으로:
 * 어절 중간 꺾임만 붙이고 어절 경계 꺾임·문단 경계는 줄바꿈으로 둔다(칸은 가운데 정렬 칸의 넓은 줄이 찬 줄처럼 보여 문단
 * 경계를 공백으로 잇는 건 삼간다). 종전 조각 규칙 — 8자 이하 한글 조각 붙임·쉼표/여는 괄호 뒤 15자 붙임 — 은 hwpx↔pdf 417쌍
 * 칸 줄 이음 실측에서 정밀도 10%(맞음 101·틀림 874)·2%(맞음 5·틀림 316)라 칸 상자가 있는 호출에서는 쓰지 않는다
 */
function mergeCellTextLines(textLines: string[], wrap?: { wraps: boolean[]; lex?: WrapLexicon }): string {
  // 셀 내 줄바꿈 병합 — 잘린 단어/숫자 조각 복구
  if (textLines.length <= 1) return textLines[0] || ""
  const merged: string[] = [textLines[0]]
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = textLines[i]
    if (wrap
      ? wrap.wraps[i - 1] && !startsNewItem(prev, curr) && wrapJoiner(prev, curr, wrap.lex) === ""
      : /[가-힣]$/.test(prev) && /^[가-힣]+$/.test(curr) && curr.length <= 8 && !curr.includes(" ")) {
      merged[merged.length - 1] = prev + curr
    }
    else if (curr.trim().length <= 3 && /^[)\]%}]/.test(curr.trim())) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else if (!wrap && /[,(]$/.test(prev.trim()) && curr.trim().length <= 15) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    // 줄바꿈에 잘린 숫자 조각("1,234,5" / "67")은 잇되, 온전한 숫자 뒤 숫자 줄은 잇지 않는다 — 병합 칸에 쌓인 천 단위 숫자
    // ("20,775,661" / "5,187,590")와 쉼표 없는 세 자리 이하 숫자("810" / "810" → 종전 "810810810", "2,240" / "0" →
    // "2,2400", 괴산·부천 예산서 텍스트층·OCR 공통). 쉼표 뒤 세 자리로 끝난 줄에 숫자 줄을 이으면 ",dddd" 꼴이 되므로 늘 끊고,
    // 쉼표 없는 세 자리 이하 숫자는 다음 줄도 온전한 숫자일 때 끊는다
    else if (/[\d,]$/.test(prev) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10
      && !(/\d,\d{3}$/.test(prev) && /^\d/.test(curr.trim()))
      && !(/(?:^|[^\d,])\d{1,3}$/.test(prev) && /^(\d{1,3}(,\d{3})+|\d{1,3})$/.test(curr.trim()))) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    else {
      merged.push(curr)
    }
  }
  return merged.join("\n")
}
