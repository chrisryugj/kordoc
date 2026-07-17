/**
 * PDF 텍스트 아이템/줄 수준 유틸.
 *
 * pdfjs TextItem → NormItem 정규화(가짜 볼드 dedupe, 균등배분 분해, 공백 힌트 전파),
 * 줄 그룹핑(groupByY, 첨자 병합), 줄 텍스트 조립(mergeLineSimple),
 * 균등배분 공백 제거(collapseEvenSpacing), bbox/스타일 계산.
 */

import type { BoundingBox } from "../types.js"
import { detectEvenSpacedItems, spaceGapThreshold } from "./line-detector.js"

export interface PdfTextItem {
  str: string
  transform: number[]
  width: number
  height: number
  fontName?: string
}

export interface NormItem {
  text: string
  x: number
  y: number
  w: number
  h: number
  /** 폰트 높이(≈폰트 크기) — 헤딩 감지용 */
  fontSize: number
  fontName: string
  /** hidden text 여부 (투명/0pt) */
  isHidden: boolean
  /** pdfjs 공백 아이템이 이 아이템 직전에 있었음 — 단어 경계 힌트 */
  hasSpaceBefore?: boolean
  /** 취소선이 그어진 텍스트 (신구조문대비표 삭제 표시 등) */
  strike?: boolean
}

// ═══════════════════════════════════════════════════════
// Hidden text 필터링 (prompt injection 방어)
// ═══════════════════════════════════════════════════════

export function filterHiddenText(items: NormItem[], pageWidth: number, pageHeight: number): { visible: NormItem[]; hiddenCount: number } {
  let hiddenCount = 0
  const visible: NormItem[] = []

  for (const item of items) {
    // 0pt 폰트 / 너비 0 → 숨겨진 텍스트
    if (item.isHidden) { hiddenCount++; continue }
    // 페이지 범위 밖 (여백 10% 허용)
    const margin = Math.max(pageWidth, pageHeight) * 0.1
    if (item.x < -margin || item.x > pageWidth + margin || item.y < -margin || item.y > pageHeight + margin) {
      hiddenCount++; continue
    }
    visible.push(item)
  }

  return { visible, hiddenCount }
}

/**
 * 문자열 기반 균등배분 제거.
 * normalizeItems에서 분해 + 좌표 기반 감지가 주 경로이고, 여기는 안전망.
 * pdfjs가 이미 합친 "홍 보 담 당 관" 같은 TextItem 문자열에 적용.
 */
export function collapseEvenSpacing(text: string): string {
  // 1. 전체가 균등배분: 토큰의 70%가 1글자
  const tokens = text.split(" ")
  const singleCharCount = tokens.filter(t => t.length === 1).length
  if (tokens.length >= 3 && singleCharCount / tokens.length >= 0.7) {
    return tokens.join("")
  }

  // 2. 부분 균등배분: 한글 1자가 3개+ 연속 (2자 단어는 건드리지 않음)
  // "홍 보 담 당 관" → "홍보담당관", "지 역 경 제 과" → "지역경제과"
  // "중동 사태 대응" (2자 단어)는 매칭 안 됨 → 공백 유지
  return text.replace(
    /(?<![가-힣])[가-힣](?: [가-힣\d]){2,}(?![가-힣])/g,
    match => match.replace(/ /g, ""),
  )
}

/** 아이템 그룹에서 바운딩 박스 계산 */
export function computeBBox(items: NormItem[], pageNum: number): BoundingBox {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const i of items) {
    if (i.x < minX) minX = i.x
    if (i.y < minY) minY = i.y
    if (i.x + i.w > maxX) maxX = i.x + i.w
    // h가 0인 경우 fontSize를 높이 대용으로 사용 (pdfjs가 height를 제공하지 않는 경우)
    const effectiveH = i.h > 0 ? i.h : i.fontSize
    if (i.y + effectiveH > maxY) maxY = i.y + effectiveH
  }
  return { page: pageNum, x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 아이템 그룹의 대표 스타일 (최빈 폰트 크기) */
export function dominantStyle(items: NormItem[]): { fontSize: number; fontName?: string } | undefined {
  if (items.length === 0) return undefined
  // 최빈 폰트 크기 찾기
  const freq = new Map<number, number>()
  let maxCount = 0, dominantSize = 0
  for (const i of items) {
    if (i.fontSize <= 0) continue
    const count = (freq.get(i.fontSize) || 0) + 1
    freq.set(i.fontSize, count)
    if (count > maxCount) { maxCount = count; dominantSize = i.fontSize }
  }
  if (dominantSize === 0) return undefined
  // 대표 폰트명 (빈 문자열은 undefined로)
  const fontName = items.find(i => i.fontSize === dominantSize)?.fontName || undefined
  return fontName ? { fontSize: dominantSize, fontName } : { fontSize: dominantSize }
}

export function normalizeItems(rawItems: PdfTextItem[]): NormItem[] {
  const items: NormItem[] = []
  // pdfjs 공백 아이템 위치 수집 — 단어 경계 힌트로 활용
  const spacePositions: { x: number; y: number }[] = []

  for (const i of rawItems) {
    if (typeof i.str !== "string") continue
    const x = Math.round(i.transform[4])
    const y = Math.round(i.transform[5])

    if (!i.str.trim()) {
      // 공백 전용 아이템: 위치만 기록 (단어 구분 힌트)
      spacePositions.push({ x, y })
      continue
    }

    // 회전 텍스트 대응: 90° 회전 시 [0,s,-s,0] 꼴로 대각 성분이 0이 되므로
    // 열벡터 노름으로 실제 글리프 스케일을 구한다 (사이드탭·회전 표가 hidden 오분류되던 버그)
    const scaleX = Math.hypot(i.transform[0], i.transform[1])
    const scaleY = Math.hypot(i.transform[2], i.transform[3])
    const fontSize = Math.round(Math.max(scaleY, scaleX))
    const w = Math.round(i.width)
    const h = Math.round(i.height)
    const isHidden = fontSize === 0 || (i.width === 0 && i.str.trim().length > 0)

    // letterSpacing이 적용된 숫자/기호 문자열 정규화
    // "45 0 -7 3 40 )" → "450-7340)" (전화번호, 금액 등)
    let text = i.str.trim()
    if (/^[\d\s\-().·,☎]+$/.test(text) && /\d/.test(text) && / /.test(text)) {
      text = text.replace(/ /g, "")
    }

    // 균등배분 TextItem 분해: "홍 보 지 원 반" → 개별 글자 아이템으로
    const split = splitEvenSpacedItem(text, x, w, fontSize)
    if (split) {
      for (const s of split) {
        items.push({ text: s.text, x: s.x, y, w: s.w, h, fontSize, fontName: i.fontName || "", isHidden })
      }
    } else {
      items.push({ text, x, y, w, h, fontSize, fontName: i.fontName || "", isHidden })
    }
  }

  const sorted = items.sort((a, b) => b.y - a.y || a.x - b.x)

  // 1. 가짜 볼드 중복 제거: 같은 텍스트가 거의 동일한 좌표(±3px)에 2~3회 겹쳐진 경우
  // PDF에서 볼드 효과를 위해 텍스트를 여러 번 렌더링하는 기법
  const deduped: NormItem[] = []
  for (let i = 0; i < sorted.length; i++) {
    let isDup = false
    // Y 정렬(desc)이므로 역순 스캔 — Y 차이가 tolerance를 넘으면 중단
    for (let j = deduped.length - 1; j >= 0; j--) {
      const prev = deduped[j]
      if (prev.y - sorted[i].y > 3) break // 이전 아이템이 너무 높음 → 중단
      // x 허용치는 글리프 폭 비례 — 고정 ±3px는 좁은 글리프(괄호 w≈3)에서 나란히
      // 놓인 진짜 두 글자("경북))")까지 삼킨다. 가짜 볼드 오프셋은 폭의 절반 미만.
      const xTol = Math.min(3, Math.max(0.5, sorted[i].w * 0.5))
      if (Math.abs(prev.y - sorted[i].y) <= 3 &&
          prev.text === sorted[i].text && Math.abs(prev.x - sorted[i].x) <= xTol) {
        isDup = true
        break
      }
    }
    if (!isDup) deduped.push(sorted[i])
  }

  // 2. 공백 아이템 위치를 NormItem.hasSpaceBefore로 전파
  // 같은 Y라인(±3px)에서 공백 바로 오른쪽의 "가장 가까운" 아이템에만 표시.
  // (기존: 20px 윈도 내 모든 아이템 마킹 → "기관 [공백] 내부에서"의 '부'까지
  //  오마킹되어 "내 부에서" 과다 공백 발생 — 인접 아이템 1개로 제한)
  if (spacePositions.length > 0) {
    for (const sp of spacePositions) {
      let nearest: NormItem | null = null
      for (const item of deduped) {
        if (Math.abs(sp.y - item.y) > 3) continue
        const dist = item.x - sp.x
        if (dist >= -1 && dist <= 20 && (!nearest || item.x < nearest.x)) {
          nearest = item
        }
      }
      if (nearest) nearest.hasSpaceBefore = true
    }
  }

  return deduped
}

/**
 * 균등배분 TextItem 감지 및 분해.
 * "홍 보 지 원 반" (1자+공백 패턴) → [{text:"홍",x,w}, {text:"보",x,w}, ...]
 * 분해하면 이후 detectEvenSpacedItems가 좌표 기반으로 정확히 감지할 수 있음.
 */
function splitEvenSpacedItem(
  text: string, itemX: number, itemW: number, fontSize: number,
): { text: string; x: number; w: number }[] | null {
  // 한글/숫자 1자 + 공백이 3회+ 반복되는 패턴
  // "홍 보 지 원 반", "세 무 1 과", "주 요 내 용"
  if (!/^[가-힣\d](?: [가-힣\d]){2,}$/.test(text)) return null

  const chars = text.split(" ")
  if (chars.length < 3) return null

  // 글자당 폭 계산 — 전체 width를 글자 수로 나눔
  const charW = itemW / chars.length
  // 글자 폭이 너무 크면 균등배분이 아님 (한 글자가 fontSize의 2배 넘으면 이상)
  if (charW > fontSize * 2) return null

  return chars.map((ch, idx) => ({
    text: ch,
    x: Math.round(itemX + idx * charW),
    w: Math.round(charW * 0.8), // 실제 글자 폭은 간격보다 좁음
  }))
}

export function groupByY(items: NormItem[]): NormItem[][] {
  if (items.length === 0) return []
  const lines: NormItem[][] = []
  let curY = items[0].y
  let curLine: NormItem[] = [items[0]]

  for (let i = 1; i < items.length; i++) {
    // Y좌표 허용 오차 3px — PDF 렌더링 미세 오차 보정, 별표 행 경계 감지에 최적화된 값
    if (Math.abs(items[i].y - curY) > 3) {
      lines.push(curLine)
      curLine = []
      curY = items[i].y
    }
    curLine.push(items[i])
  }
  if (curLine.length > 0) lines.push(curLine)
  return lines
}

/**
 * 첨자 줄 병합 — 본문 줄보다 살짝 위에 뜬 작은 글자 조각(각주 마커 `*`, 원문자 ①,
 * 덧말)이 groupByY에서 별도 줄로 분리된 것을 본문 줄에 흡수한다.
 * 조각 줄(아이템 ≤3개·각 ≤8자·글자 박스가 인접 줄보다 확실히 작음)이 인접 줄과
 * 수직으로 겹치면 같은 시각적 줄이다. mergeLineSimple이 x순 정렬하므로
 * 병합 후 원래 인라인 위치("①근로자...")가 복원된다.
 */
export function mergeSuperscriptLines(lines: NormItem[][]): NormItem[][] {
  if (lines.length <= 1) return lines
  const band = (line: NormItem[]) => {
    let bottom = Infinity, top = -Infinity
    for (const i of line) {
      const h = i.h > 0 ? i.h : i.fontSize
      if (i.y < bottom) bottom = i.y
      if (i.y + h > top) top = i.y + h
    }
    return { bottom, top, height: top - bottom }
  }
  // 조각 판정 — 글자 단위로 흩어진 소형 라벨("과기정통부" 1자×5)도 흡수하도록
  // 아이템 수 대신 총 글자수로 제한 (높이비·수직겹침 가드가 과병합을 막는다)
  const isFrag = (line: NormItem[]) => {
    if (line.length > 8) return false
    let total = 0
    for (const i of line) total += i.text.trim().length
    return total > 0 && total <= 10
  }

  const result: NormItem[][] = [lines[0]]
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

export function mergeLineSimple(items: NormItem[]): string {
  if (items.length <= 1) return items[0]?.text || ""
  const sorted = [...items].sort((a, b) => a.x - b.x)

  // 좌표 기반 균등배분 감지 (ODL TextLineProcessor 방식)
  const isEvenSpaced = detectEvenSpacedItems(sorted)

  let result = sorted[0].text
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].x - (sorted[i - 1].x + sorted[i - 1].w)
    const avgFs = (sorted[i].fontSize + sorted[i - 1].fontSize) / 2

    // 탭 갭은 항상 탭으로 — 균등배분보다 우선
    // 기준: fontSize의 2배 이상 또는 30px+ (균등배분 간격은 보통 fontSize*1.5 이하)
    const tabThreshold = Math.max(avgFs * 2, 30)
    if (gap > tabThreshold) {
      result += "\t"
      result += sorted[i].text
      continue
    }

    // 균등배분 구간이면 공백 없이 합침
    if (isEvenSpaced[i]) {
      result += sorted[i].text
      continue
    }

    // pdfjs 공백 아이템이 있었으면 단어 경계 — 갭 크기 무관하게 공백 삽입
    if (sorted[i].hasSpaceBefore && gap >= avgFs * 0.05) {
      result += " "
      result += sorted[i].text
      continue
    }
    // 마커(□○▶ 등) 뒤에 한글이 오면 항상 공백 보장 — "□장소" → "□ 장소"
    if (/[□■○●▶◆◇ㅇ]$/.test(sorted[i - 1].text) && /^[가-힣]/.test(sorted[i].text) && gap > 1) {
      result += " "
      result += sorted[i].text
      continue
    }
    // 폰트 크기 비례 공백 임계값 — 고정 px 기준은 Type3/대형 폰트에서 공백 소실·과다 유발
    if (gap > spaceGapThreshold(avgFs)) result += " "
    result += sorted[i].text
  }
  return result
}
