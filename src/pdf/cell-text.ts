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
import { sortLineByX, isCjkLatinAutospace, collapseEvenSpacing, isAttachedScripts } from "./text-line.js"
import { tagScripts } from "./script-items.js"

/** 시도·전국 이름표 — 두 음절 배분 칸을 문서 어휘 증거 없이도 붙이는 닫힌 목록. "전 체"·"구 분" 같은 표 머리글은 원고에서 띄어 쓰기도
 *  해서(해외직접투자 보도자료 정답 "전 체") 넣지 않는다 */
export const REGION_LABELS = new Set(["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주", "전국"])
import { type WrapLexicon, cellLineWraps, cellLineFills, startsNewItem, wrapJoiner } from "./line-wrap.js"

/** 셀 경계 내부 판별 여유 (텍스트 매핑용) */
const CELL_PADDING = 2

/** 셀 텍스트 정리 — 페이지 번호 표시 제거 + 줄별 균등배분 공백 정리 */
export function cleanCellText(text: string): string {
  const stripped = text.replace(/^[\s]*[-–—]\s*\d+\s*[-–—][\s]*$/gm, "").trim()
  return stripped.split("\n").map(line => collapseEvenSpacing(line)).join("\n")
}

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
  const candidates = items.length * cells.length >= 5000 ? cellBandLookup(cells) : () => cells

  for (const item of items) {
    const pad = CELL_PADDING

    let bestCell: ExtractedCell | null = null
    let bestScore = 0

    for (const cell of candidates(item.y - pad, item.y + (item.h || item.fontSize) + pad)) {
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
 * 칸 여럿에 걸친 한 조각 — 제작기가 표 한 행의 칸 글을 한 글 조각으로 내면(평가 기준 별표2 "2 100 1.0 2.0 … 10.0" 9칸, 가계동향조사
 * 머리 행 "근로소득 사업소득 재산소득 이전소득" 4칸) 어느 칸에도 30% 넘게 겹치지 않아 칸 밖 글로 샜다. 걸친 칸(한 행, 서로 다른 열)
 * 수와 낱말 수가 같으면 왼→오로 칸마다 한 낱말. 그 밖은 그대로
 */
export function splitAcrossCells(item: TextItem, cells: ExtractedCell[]): TextItem[] {
  const words = item.text.trim().split(/\s+/)
  if (words.length < 2) return [item]
  const ih = item.h || item.fontSize
  const spanned = cells.filter(c => Math.min(item.y + ih, c.bbox.y2) - Math.max(item.y, c.bbox.y1) >= ih * 0.5 &&
    Math.min(item.x + item.w, c.bbox.x2) - Math.max(item.x, c.bbox.x1) > 1).sort((a, b) => a.bbox.x1 - b.bbox.x1)
  if (spanned.length !== words.length) return [item]
  for (let k = 1; k < spanned.length; k++) if (spanned[k].bbox.x1 < spanned[k - 1].bbox.x2 - 1) return [item]
  // 한 칸에 30% 넘게 겹치면 종전대로 그 칸 글이다
  const itemArea = Math.max(item.w, 1) * Math.max(ih, 1)
  if (spanned.some(c => (Math.min(item.x + item.w, c.bbox.x2) - Math.max(item.x, c.bbox.x1)) * ih / itemArea > 0.3)) return [item]
  return words.map((text, k) => {
    const b = spanned[k].bbox
    return { ...item, text, x: b.x1 + 1, w: Math.max(1, b.x2 - b.x1 - 2), hasSpaceBefore: false }
  })
}

/** 세로 범위로 칸 후보를 좁힌다. 병합 칸도 포함하고, 동률 배정은 원래 칸 순서를 그대로 따른다. */
function cellBandLookup(cells: ExtractedCell[]): (lo: number, hi: number) => ExtractedCell[] {
  const sorted = cells.map((cell, index) => ({ cell, index })).sort((a, b) => a.cell.bbox.y1 - b.cell.bbox.y1)
  interface Band { start: number; end: number; lo: number; hi: number; left?: Band; right?: Band }
  const build = (start: number, end: number): Band => {
    let lo = Infinity, hi = -Infinity
    for (let i = start; i < end; i++) { lo = Math.min(lo, sorted[i].cell.bbox.y1); hi = Math.max(hi, sorted[i].cell.bbox.y2) }
    const band: Band = { start, end, lo, hi }
    if (end - start > 8) {
      const mid = (start + end) >> 1
      band.left = build(start, mid); band.right = build(mid, end)
    }
    return band
  }
  const root = build(0, sorted.length)
  return (lo, hi) => {
    const found: typeof sorted = []
    const visit = (band: Band): void => {
      if (band.hi <= lo || band.lo >= hi) return
      if (band.left && band.right) { visit(band.left); visit(band.right) }
      else for (let i = band.start; i < band.end; i++) {
        const entry = sorted[i]
        if (entry.cell.bbox.y2 > lo && entry.cell.bbox.y1 < hi) found.push(entry)
      }
    }
    visit(root)
    return found.sort((a, b) => a.index - b.index).map(entry => entry.cell)
  }
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
  const merged = mergeSuperscriptRows(lines).map(line => sortLineByX(line))

  // 각 행을 텍스트로 변환 — 좌표 기반 균등배분 감지 포함
  const textLines = merged.map(s => {
    if (s.length === 1) return s[0].text
    // 두 음절 배분 정렬 칸("중  동"·"유  럽") — 세 글자 이상 균등배분(detectEvenSpacedItems)과 같은 조판인데 두 글자라 빠졌다.
    // 음절 사이가 글자 크기의 1.5배 이상이고 두 음절이 칸 폭을 꽉 채우며(배분 정렬은 첫 글자를 칸 왼쪽, 끝 글자를 오른쪽 여백에
    // 붙인다) 붙인 꼴이 같은 문서 줄 안에서 한 어절로 나오거나 두 음절이 어절 안에서만 이웃할 때만(line-wrap 문서 어휘 증거).
    // 원문에 공백을 친 채 벌린 칸은 그림이 같아 기하로 못 가른다: 좁은 칸 "과 장"(보도자료 연락처)은 간격 1.0배 안팎이라 문턱에서,
    // 서식 이름표 "성  명"은 본문에 한 어절로 잘 안 나와 어휘에서 걸러진다. 본문에도 나오는 낱말을 크게 벌린 이름표("경  력"·"은  행")는
    // 못 가른다(hwpx↔pdf 751쌍: 건설업조사·해외직접투자 보도자료 등 나아짐, 2문서 1~4어절 나빠짐)
    // 통계표 지역 이름표(시도·전국)는 본문에 한 어절로 안 나와도 붙인다 — 띄어 쓰는 일이 없는 닫힌 목록(건설업조사 보도자료 "서  울" 102곳)
    if (s.length === 2 && /^[가-힣]$/.test(s[0].text) && /^[가-힣]$/.test(s[1].text) && !!wrap?.lex &&
        (wrap.lex.isWord(s[0].text + s[1].text) || wrap.lex.evidence(s[0].text, s[1].text) === "" || REGION_LABELS.has(s[0].text + s[1].text)) &&
        s[1].x - (s[0].x + s[0].w) >= Math.max(s[0].fontSize, s[1].fontSize) * 1.5 &&
        s[1].x + s[1].w - s[0].x >= (wrap.box.x2 - wrap.box.x1) - Math.max(s[0].fontSize, s[1].fontSize) * 2) return s[0].text + s[1].text

    // 균등배분 구간 감지 (좌표 기반)
    const evenSpaced = detectEvenSpacedItems(s, true)

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
      if (isCjkLatinAutospace(s[j - 1].text, s[j].text, gap, avgFs)) {
        result += s[j].text
      } else if (s[j].hasSpaceBefore && gap >= avgFs * 0.05) {
        result += " " + s[j].text
      } else if (gap > spaceGapThreshold(avgFs)) {
        result += " " + s[j].text
      } else {
        result += s[j].text
      }
    }
    return result
  })

  // 첨자 태그는 줄 병합 판정(평문)을 다 한 뒤에 — 판정은 글 끝 글자를 본다
  const scripted = (s: string) => tagScripts(s, merged)
  if (!wrap) return scripted(mergeCellTextLines(textLines))
  // 줄마다 "다음 줄로 꺾여 넘어갔나" — 다음 줄 첫 글자가 이 줄 뒤에 칸 안쪽으로 못 들어갈 때
  let contentLeft = Infinity
  for (const it of items) if (it.x < contentLeft) contentLeft = it.x
  const lineEnds = merged.map(s => {
    let right = -Infinity, left = Infinity
    for (const it of s) { if (it.x + it.w > right) right = it.x + it.w; if (it.x < left) left = it.x }
    const first = s[0]
    // 아이템에 붙인 표시 태그는 글리프가 아니다 — 다음 줄 첫 글자 폭은 실제 글자 수로 나눈다.
    const visible = first.text.replace(/<\/?u>|~~/g, "")
    return { left, right, fontSize: first.fontSize, firstCharW: first.w / Math.max(1, [...visible].length) }
  })
  let cellRight = -Infinity
  for (const e of lineEnds) if (e.right > cellRight) cellRight = e.right
  const wraps = lineEnds.slice(0, -1).map((a, i) => cellLineWraps(wrap.box, contentLeft, a.right, a.fontSize, lineEnds[i + 1].firstCharW)
    || (lineEnds.length >= 3 && !textLines[i + 1].startsWith("(") && cellLineFills(wrap.box, contentLeft, cellRight, a.right, a.fontSize)))
  // 줄이 칸 안쪽 폭을 채웠나 — 다음 줄 첫 글자가 이 줄 앞뒤 어디에도 못 들어갈 때만 꺾여 잘린 숫자다. 오른쪽 정렬 금액("500")은 칸 오른끝에
  // 닿아 꺾임으로 보여도 칸을 채운 줄이 아니고, 좁은 쪽 번호 칸에 쌓인 세 자리 번호("124" / "135" → 종전 "124135", 현장실습 매뉴얼 목차 —
  // 칸 안쪽 폭의 64%라 종전 60% 문턱을 넘었다)도 그렇다. 안 여백은 글 왼끝·오른끝 쪽 빈자리 가운데 좁은 쪽 — 오른쪽 정렬 칸의 왼쪽 빈자리는 여백이 아니다
  const pad = Math.min(6, Math.max(0, contentLeft - wrap.box.x1), Math.max(0, wrap.box.x2 - cellRight))
  const inner = wrap.box.x2 - wrap.box.x1 - 2 * pad
  const wide = lineEnds.slice(0, -1).map((a, i) => a.right - a.left + 1.5 * lineEnds[i + 1].firstCharW > inner)
  return scripted(mergeCellTextLines(textLines, { wraps, lex: wrap.lex, wide }))
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
    // 글자마다 붙은 첨자 여럿(서식 칸 "□예 □아니오" 의 작은 "예"·"아니오" 가 한 줄에 여섯)도 본문 줄과 같은 규칙으로 (isAttachedScripts)
    const prevIsFrag = (isFrag(prev) || isAttachedScripts(prev, curr)) && a.height <= b.height * 0.8 && overlap >= a.height * 0.5
    const currIsFrag = (isFrag(curr) || isAttachedScripts(curr, prev)) && b.height <= a.height * 0.8 && overlap >= b.height * 0.5
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
function detectEvenSpacedItems(items: TextItem[], cellLine = false): boolean[] {
  const result = new Array(items.length).fill(false)
  if (items.length < 3) return result
  const visible = items.map(it => it.text.replace(/<\/?u>|~~/g, ""))
  // 칸 한 줄이 한 음절 글자뿐이고 글자 틈이 모두 벌어졌는데 공백 글리프가 하나도 없으면(pdfjs 가 틈에 만든 공백뿐) 배분 정렬 칸이다 —
  // "보 [-777.8] 험 [-777.8] 업"(해외직접투자 보도자료), 틈 일부에만 합성 공백이 든 "법 무 연 수 원"(교정공무원 인사). 공백 글리프가 있거나
  // 붙은 글자가 있으면(한 글자씩 찍고 낱말 틈만 벌린 글) 아래 종전 규칙(공백에서 끊음)대로.
  // 칸 글에서만 — 쪽 줄(mergeLineSimple)은 칸 경계를 넘어 한 글자씩 찍은 행("대구교도소장 김진아")을 한 낱말로 붙였다
  if (cellLine && visible.every(text => /^[가-힣]$/.test(text)) && items.slice(1).every(it => !it.hasSpaceBefore || it.syntheticSpace)
    && items.slice(1).every((it, k) => it.x - (items[k].x + items[k].w) >= it.fontSize * 0.1)) {
    markEvenRun(items, visible, result, 0, items.length)
    // 줄 전체가 고른 배분이 아니면(틈 비율 3배 넘음 — "전 문 업 종  건 설 업") 종전 규칙으로 부분 run 을 본다
    if (result.some(Boolean)) return result
  }

  let runStart = -1
  for (let i = 0; i < items.length; i++) {
    // 균등배분 = 한글 1자 개별 배치. 2자 단어는 균등배분이 아니라 실제 단어.
    const isShortKorean = /^[가-힣]{1}$/.test(visible[i]) || /^[\d]{1}$/.test(visible[i])

    // 명시적 공백 글리프가 직전에 있으면 단어 경계 — 균등배분 run 분리.
    // (Type3 폰트가 글자를 1자씩 배치하면서 공백 글리프를 따로 두는 경우,
    //  진짜 단어 경계를 균등배분으로 오판해 문장 전체가 붙는 것을 방지)
    if (isShortKorean && runStart >= 0 && items[i].hasSpaceBefore) {
      if (i - runStart >= 3) markEvenRun(items, visible, result, runStart, i)
      runStart = i
      continue
    }

    // 이전 아이템과의 갭이 fontSize*3+ 이면 run 끊기 (다른 영역)
    if (isShortKorean && runStart >= 0 && i > 0) {
      const gap = items[i].x - (items[i - 1].x + items[i - 1].w)
      const maxRunGap = Math.max(items[i].fontSize * 3, 30)
      if (gap > maxRunGap) {
        if (i - runStart >= 3) markEvenRun(items, visible, result, runStart, i)
        runStart = i
        continue
      }
    }

    if (isShortKorean) {
      if (runStart < 0) runStart = i
    } else {
      if (runStart >= 0 && i - runStart >= 3) {
        markEvenRun(items, visible, result, runStart, i)
      }
      runStart = -1
    }
  }
  if (runStart >= 0 && items.length - runStart >= 3) {
    markEvenRun(items, visible, result, runStart, items.length)
  }

  return result
}

function markEvenRun(items: TextItem[], visible: string[], result: boolean[], start: number, end: number): void {
  // 별지서식 기입 빈칸 "년   월   일"·"시   분" 은 균등배분이 아니다 — 글자 단위가 전부 날짜·시각 단위면 두고 문자열 안전망
  // (collapseEvenSpacing isDateUnitBlank)과 같게. 공백 글리프 없이 칸을 벌린 서식은 틈이 3em 안이면 여기서 붙었다
  // (hwpx↔pdf 칸 줄: 한 글자 조각이 날짜 단위뿐인 줄 46곳 중 원문이 붙여 쓴 곳 0 — 행정업무운영 편람 서식 "년 월 일")
  let dateOnly = true
  for (let i = start; i < end; i++) if (!/^[년월일시분초]$/.test(visible[i])) { dateOnly = false; break }
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
function mergeCellTextLines(textLines: string[], wrap?: { wraps: boolean[]; lex?: WrapLexicon; wide?: boolean[] }): string {
  // 셀 내 줄바꿈 병합 — 잘린 단어/숫자 조각 복구
  if (textLines.length <= 1) return textLines[0] || ""
  const numberWrapped = (k: number) => !!wrap?.wraps[k] && (wrap.wide?.[k] ?? true)
  const merged: string[] = [textLines[0]]
  for (let i = 1; i < textLines.length; i++) {
    const prev = merged[merged.length - 1]
    const curr = textLines[i]
    if (wrap
      ? wrap.wraps[i - 1] && !startsNewItem(prev, curr) && wrapJoiner(prev, curr, wrap.lex, false) === ""
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
    // 쉼표 없는 세 자리 이하 숫자는 다음 줄도 온전한 숫자일 때 끊는다. 줄에 홀로 선 정수(첫머리·공백 뒤) 다음 정수 줄도 끊는다 —
    // 칸에 줄마다 적은 "600" / "1000"·"1500" / "2500"(table_giant_cell_overfill). 칸 폭을 채우고 꺾인 줄(wraps)은 잘린 한 숫자라
    // 잇고, 글 뒤에 붙은 번호 조각("02-123" / "4567")은 홀로 선 수가 아니라 종전대로 잇는다. 꺾임은 칸을 채운 줄만 — 오른쪽 정렬 금액은
    // 칸 오른끝에 닿아도 잘린 숫자가 아니다(속초 세출예산서 OCR 칸 "500" / "500" → "500500")
    else if (/[\d,]$/.test(prev) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10
      && !(/\d,\d{3}$/.test(prev) && /^\d/.test(curr.trim()))
      // 칸 상자를 알면 쉼표 든 숫자도 칸을 채우고 꺾인 줄만 잇는다 — 값 위에 작게 얹은 각주 첨자 "3,4" 가 아래 줄 값 "60" 과 "3,460",
      // 첨자끼리 "3" / "3,4" 가 "33,4" 로 붙었다(고속선 안전 코드 화재 구역 표 "₃,₄⏎60", 정답 첨자). 상자 없는 호출은 종전대로 잇는다
      && !(wrap && !numberWrapped(i - 1))
      && !(/(?:^|[^\d,])\d{1,3}$/.test(prev) && /^(\d{1,3}(,\d{3})+|\d{1,3})$/.test(curr.trim()) && !numberWrapped(i - 1))
      && !(/(?:^|\s)\d{1,7}$/.test(prev) && /^\d{1,7}$/.test(curr.trim()) && !numberWrapped(i - 1))) {
      merged[merged.length - 1] = prev + curr.trim()
    }
    // 글이 든 줄이 쉼표로 끝나고 다음 줄이 숫자뿐이면 낱말 사이 꺾임이다 — 칸을 다 채운 줄이 아니라 숫자 이음은 아니고(종전엔 숫자째 붙여
    // "April 30,2022"), 줄바꿈으로 두면 날짜가 갈린다. 공백으로 잇는다(정답 "April 30, 2022", ODL 180 판 이력 표). 글 없는 "3,4" 첨자 줄은 그대로
    else if (wrap && /[A-Za-z가-힣]/.test(prev) && /,$/.test(prev.trim()) && /^[\d,]+[)\]]?$/.test(curr.trim()) && curr.trim().length <= 10) {
      merged[merged.length - 1] = prev.trimEnd() + " " + curr.trim()
    }
    else {
      merged.push(curr)
    }
  }
  return merged.join("\n")
}

/** 칸 안 라틴 글 줄 꺾임 — 두 줄 모두 한글 없이 라틴 낱말을 품고, 다음 줄이 새 항목(글머리 부호·번호)이 아닐 때 */
export function latinSoftWrap(prev: string, curr: string): boolean {
  const a = prev.trim(), b = curr.trim()
  // 다음 줄은 라틴 낱말이나 괄호 덧붙임("Reservation⏎(1994)")으로 시작한다
  if (!a || !b || /[가-힣]/.test(a + b) || !/[A-Za-z]{2}/.test(a) || !/[A-Za-z]/.test(b) && !/^\(.*\)$/.test(b)) return false
  if (/^(?:[•●○◦▪▫■□◆◇➢➤►▶✓✔\-–—*·]|\(?\d{1,2}[.)]\s|\(?[a-z][.)]\s|\([ivx]{1,4}\)\s)/.test(b)) return false
  return !startsNewItem(a, b)
}
