/**
 * HWPX 실제 페이지 경계 복원 (#66) — 한컴 저장본의 조판 캐시(linesegarray)로
 * 섹션 내 top-level 문단별 실제 페이지 배정을 계산한다.
 *
 * 신호 4종 (bench/corpus/pairs hwp↔hwpx↔pdf 6쌍 전수 일치로 검증):
 *  1. top-level 문단 lineseg vertpos 역행 — 페이지 로컬 좌표라 리셋 지점이 곧 경계.
 *     다단(colCount>1)은 단 이동도 리셋되므로 horzpos가 왼쪽으로 돌아올 때만 인정,
 *     "동일 v"도 문단 첫 seg + horzpos 비전진이면 경계 (svg-render 프리패스와 동일 규칙)
 *  2. 명시적 쪽나눔 <hp:p pageBreak="1"> — 같은 문단 첫 seg의 역행과 중복 시 1회만
 *  3. 페이지 걸침 표 내부 분할: 셀 직접 문단 흐름의 vertpos 리셋(셀 로컬 좌표도
 *     분할 시 0부터 재시작) — 행별 max 합산. top-level lineseg에 흔적 없는 경계 복원
 *  4. 분할 표 직후 top-level "중간높이"(v≥MIDPAGE_V) 역행 1회 억제 — 표 꼬리가
 *     다음 페이지 상단을 차지해 후속 텍스트가 중간 높이에서 재개되는 형태로,
 *     신호 3과 같은 경계의 이중 카운트를 막는다
 *
 * lineseg flags bit0("페이지의 첫 줄", HWP5 스펙 표60)은 한컴 저장본에서 항상 0이라
 * 못 쓴다(실측). 렌더러(svg-render.ts)는 그리기용 seg 단위 배정이 필요해 이 모듈과
 * 별도 프리패스를 유지한다 — 신호 1 규칙을 고치면 양쪽을 함께 검토할 것.
 */

/** 이 값 이상에서 시작하는 역행은 페이지 상단 리셋이 아니다 (신호 4 판별, HWPUNIT) */
const MIDPAGE_V = 2000

/** 섹션 페이지 감지 결과 */
export interface SectionPageDetect {
  /** top-level <hp:p> → 섹션 내 0-based 페이지 (문단 시작 위치 기준) */
  paraPage: Map<Element, number>
  /** 섹션이 차지하는 페이지 수 (≥1) */
  pages: number
  /** 조판 캐시 신뢰 가능 여부 — top-level 문단 전부가 lineseg를 가질 때만 true */
  usable: boolean
}

const localName = (el: Element): string => {
  const n = el.nodeName
  const i = n.indexOf(":")
  return i >= 0 ? n.slice(i + 1) : n
}

const childElements = (parent: Node): Element[] => {
  const out: Element[] = []
  for (let c = parent.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === 1) out.push(c as Element)
  }
  return out
}

const numAttr = (el: Element, name: string): number => {
  const v = el.getAttribute(name)
  const n = v == null ? NaN : Number(v)
  return Number.isFinite(n) ? n : 0
}

const findDescendant = (root: Element, local: string, maxDepth = 8): Element | null => {
  if (maxDepth < 0) return null
  for (const c of childElements(root)) {
    if (localName(c) === local) return c
    const found = findDescendant(c, local, maxDepth - 1)
    if (found) return found
  }
  return null
}

/** 문단의 linesegarray → lineseg 요소들 (없으면 빈 배열) */
function linesegsOf(p: Element): Element[] {
  const lsa = childElements(p).find(c => localName(c) === "linesegarray")
  return lsa ? childElements(lsa).filter(s => localName(s) === "lineseg") : []
}

/** 셀 직접 문단 흐름의 vertpos 리셋 수 — 중첩 표의 문단은 세지 않는다 */
function cellFlowResets(subList: Element): number {
  let prevV = Number.NEGATIVE_INFINITY
  let resets = 0
  for (const p of childElements(subList)) {
    if (localName(p) !== "p") continue
    for (const s of linesegsOf(p)) {
      const v = numAttr(s, "vertpos")
      if (v < prevV) resets++
      prevV = v
    }
  }
  return resets
}

/** 표의 내부 페이지 나눔 수 — 행별 max(셀 흐름 리셋) 합산 (같은 행 셀들은 같은 경계에서 분할) */
function tableIntraBreaks(tbl: Element): number {
  const rowMax = new Map<number, number>()
  for (const tr of childElements(tbl)) {
    if (localName(tr) !== "tr") continue
    for (const tc of childElements(tr)) {
      if (localName(tc) !== "tc") continue
      const addr = childElements(tc).find(e => localName(e) === "cellAddr")
      const row = addr ? numAttr(addr, "rowAddr") : 0
      const sub = childElements(tc).find(e => localName(e) === "subList")
      if (!sub) continue
      const r = cellFlowResets(sub)
      rowMax.set(row, Math.max(rowMax.get(row) ?? 0, r))
    }
  }
  let sum = 0
  for (const v of rowMax.values()) sum += v
  return sum
}

/**
 * 섹션 루트에서 top-level 문단별 페이지 배정을 계산한다.
 * 문단의 페이지 = 그 문단 내용이 시작되는 페이지 (명시 쪽나눔·첫 seg 역행 반영 후).
 */
export function detectHwpxSectionPages(root: Element): SectionPageDetect {
  const colPr = findDescendant(root, "colPr")
  const multiCol = colPr ? numAttr(colPr, "colCount") > 1 : false

  const paraPage = new Map<Element, number>()
  let cur = 0
  let prevV = Number.NEGATIVE_INFINITY
  let prevH = Number.NEGATIVE_INFINITY
  let first = true
  let suppressMidReset = false
  let topParas = 0
  let parasWithSegs = 0

  for (const p of childElements(root)) {
    if (localName(p) !== "p") continue
    topParas++

    const explicit = p.getAttribute("pageBreak") === "1"
    let brokeByExplicit = false
    if (explicit && !first) {
      cur++
      brokeByExplicit = true
      suppressMidReset = false
    }

    const segs = linesegsOf(p)
    if (segs.length > 0) parasWithSegs++
    let paraFirst = true
    let startPage = cur
    for (const s of segs) {
      const v = numAttr(s, "vertpos")
      const h = numAttr(s, "horzpos")
      const brk = v < prevV
        ? (!multiCol || h <= prevH)
        : (paraFirst && v === prevV && h <= prevH)
      if (brk && !(paraFirst && brokeByExplicit)) {
        // 신호 4: 직전 표의 셀 카운트가 소비한 경계 — 표 꼬리 아래 중간높이 재개는 억제
        if (paraFirst && suppressMidReset && v >= MIDPAGE_V) {
          // 같은 페이지 계속
        } else {
          cur++
        }
      }
      if (paraFirst) {
        suppressMidReset = false
        startPage = cur
      }
      paraFirst = false
      prevV = v
      prevH = h
    }
    // seg 없는 문단(빈 문단·캐시 누락)은 현재 페이지 상속
    paraPage.set(p, startPage)
    first = false

    // 신호 3: 이 문단이 호스트하는 top-level 표의 내부 분할 — 문단 뒤에 반영
    let add = 0
    for (const r of childElements(p)) {
      if (localName(r) !== "run") continue
      for (const t of childElements(r)) {
        if (localName(t) === "tbl") add += tableIntraBreaks(t)
      }
    }
    if (add > 0) {
      cur += add
      suppressMidReset = true
    }
  }

  return {
    paraPage,
    pages: cur + 1,
    usable: topParas > 0 && parasWithSegs === topParas,
  }
}
