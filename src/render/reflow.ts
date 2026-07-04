/**
 * Tier-2 reflow — 조판 캐시(linesegarray)가 없는 문단에 좌표를 합성 주입한다.
 *
 * 한컴은 저장 시 각 줄의 좌표(vertpos/horzpos/…)를 linesegarray로 캐시한다.
 * markdownToHwpx 산출물·에이전트 생성본·편집본엔 이 캐시가 없어 svg-render가
 * KordocError로 거부한다. reflow는 `simulateWrap`(수평, 실측 98% 일치)과 세로 모델
 * (실측 역설계 — `.claude/plans/render-poc/findings.md`)로 lineseg를 계산해 DOM
 * `<hp:p>`에 `<hp:linesegarray>`를 append → 그 뒤는 기존 렌더 파이프가 그대로 소비한다.
 *
 * 세로 모델(HWPUNIT): textheight = 줄 지배 charPr.height, baseline = round(0.85×th),
 * 줄 pitch = round(th × lineSpacing%/100), spacing(leading) = pitch − th.
 * 문단 세로 흐름 = 본문영역 로컬 누적(다음문단 = 이전끝 + pitch + next + prev).
 *
 * 원칙: 한컴본 캐시는 절대 건드리지 않는다(Tier-1 무회귀). segs가 있는 문단은 건너뛴다.
 * Phase 2: 최상위 텍스트 문단. 표 셀·개체 밀어내기·자동 페이지 분할은 Phase 3.
 */

import { buildPara } from "./svg-render.js"
import { simulateWrap, type WrapMode } from "../hwpx/text-metrics.js"
import { DEFAULT_CHAR, DEFAULT_PARA_GEOM, type RenderStyles, type RenderParaGeom } from "./head-styles.js"
import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { toInt32 } from "./layout.js"

/** lineseg flags 고정값 (한컴 저장본 실측 — 0x60000) */
const LINESEG_FLAGS = "393216"
/** baseline / textheight 비율 (실측 94/94 일치) */
const BASELINE_RATIO = 0.85

function ln(el: Element): string {
  return (el.tagName || "").replace(/^[^:]+:/, "")
}

function elements(el: Element): Element[] {
  const out: Element[] = []
  const kids = el.childNodes
  if (!kids) return out
  for (let i = 0; i < kids.length; i++) if (kids[i].nodeType === 1) out.push(kids[i] as Element)
  return out
}

function num(el: Element | null, attr: string, fallback = 0): number {
  return el ? toInt32(el.getAttribute(attr) ?? undefined, fallback) : fallback
}

/** 문단의 합성 linesegarray 줄들의 vertpos를 delta만큼 이동 (페이지 로컬 리셋용) */
function shiftParaVert(p: Element, delta: number): void {
  for (const lsa of elements(p)) {
    if (ln(lsa) !== "linesegarray") continue
    for (const seg of elements(lsa)) {
      if (ln(seg) !== "lineseg") continue
      seg.setAttribute("vertpos", String(num(seg, "vertpos") + delta))
    }
  }
}

export interface ReflowGeom {
  BODY_W: number
  BODY_H: number
}

/** 줄 pitch(다음 줄 vertpos 증분, HWPUNIT) — lineSpacing type별 */
function pitchFor(height: number, geom: RenderParaGeom): number {
  const v = geom.lineSpacingValue
  switch (geom.lineSpacingType) {
    case "PERCENT": return Math.round((height * v) / 100)
    case "FIXED": return v > 0 ? v : Math.round(height * 1.6) // 고정 줄높이(HWPUNIT)
    case "AT_LEAST": return Math.max(v, height)
    default: return Math.round(height * 1.6) // BETWEEN_LINES 등 — 기본 160% 근사
  }
}

/**
 * 문단 하나의 linesegarray를 합성해 p에 삽입.
 * @returns 세로 흐름 갱신값 (캐시 있어 건너뛴 경우 null)
 */
function reflowPara(
  p: Element,
  doc: Document,
  styles: RenderStyles,
  areaW: number,
  startV: number,
  mode: WrapMode,
): { paraBottom: number; spaceAfter: number } | null {
  const m = buildPara(p)
  if (m.segs.length > 0) return null // 이미 캐시 있음 — Tier-1 무회귀

  // 실텍스트 + UTF-16 유닛 → chars 슬롯 인덱스 매핑 (서로게이트 쌍은 슬롯 1개, 유닛 2개)
  const realIdx: number[] = []
  let text = ""
  for (let i = 0; i < m.chars.length; i++) {
    const ch = m.chars[i].ch
    if (ch === "") continue
    for (let u = 0; u < ch.length; u++) realIdx.push(i)
    text += ch
  }

  const geom = styles.paraGeom.get(m.paraPrId ?? "") ?? DEFAULT_PARA_GEOM
  // 문단 지배 charPr — 첫 실문자 우선(height/장평/자간)
  let domChar = DEFAULT_CHAR
  for (const c of m.chars) {
    if (c.ch !== "" && c.prId != null) {
      const st = styles.charPr.get(c.prId)
      if (st) { domChar = st; break }
    }
  }
  const height = domChar.height || 1000
  const ratio = domChar.ratio || 100
  const spacingPct = domChar.spacing || 0

  const marginL = geom.marginLeft
  const avail = Math.max(1000, areaW - marginL - geom.marginRight)
  // hanging(intent<0): 둘째 줄부터 |intent| 더 들어감 → contWidth 축소·contHorz 우측 이동
  const firstWidth = avail
  const contWidth = Math.max(500, avail + Math.min(0, geom.marginIntent))
  const contHorz = marginL - Math.min(0, geom.marginIntent)

  const wrap = text.length === 0
    ? { lines: 1, starts: [0], lastLineWidth: 0 }
    : simulateWrap(text, firstWidth, contWidth, height, ratio, mode, { spacingPct })

  const pitch = pitchFor(height, geom)
  const baseline = Math.round(height * BASELINE_RATIO)
  const spacing = Math.max(0, pitch - height)

  const lsa = doc.createElement("hp:linesegarray")
  for (let li = 0; li < wrap.starts.length; li++) {
    const startReal = wrap.starts[li]
    const textpos = startReal < realIdx.length ? realIdx[startReal] : m.chars.length
    const vertpos = startV + li * pitch
    const isFirst = li === 0
    const seg = doc.createElement("hp:lineseg")
    seg.setAttribute("textpos", String(textpos))
    seg.setAttribute("vertpos", String(vertpos))
    seg.setAttribute("vertsize", String(height))
    seg.setAttribute("textheight", String(height))
    seg.setAttribute("baseline", String(baseline))
    seg.setAttribute("spacing", String(spacing))
    seg.setAttribute("horzpos", String(isFirst ? marginL : contHorz))
    seg.setAttribute("horzsize", String(isFirst ? firstWidth : contWidth))
    seg.setAttribute("flags", LINESEG_FLAGS)
    lsa.appendChild(seg)
  }
  p.appendChild(lsa)

  // 문단 바닥 = 텍스트 줄 흐름과 개체(표·이미지) 높이 중 큰 쪽 (표 밀어내기 반영)
  const textBottom = startV + wrap.starts.length * pitch
  let objBottom = startV
  for (const o of m.objs) objBottom = Math.max(objBottom, startV + o.height)
  return { paraBottom: Math.max(textBottom, objBottom), spaceAfter: geom.spaceAfter }
}

/** 문단 run 안의 표를 찾아 각 셀 subList를 셀 로컬로 reflow (중첩 재귀) */
function reflowTablesIn(p: Element, doc: Document, styles: RenderStyles, mode: WrapMode, counter: { n: number }): void {
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const obj of elements(run)) {
      if (ln(obj) !== "tbl") continue
      for (const tr of elements(obj)) {
        if (ln(tr) !== "tr") continue
        for (const tc of elements(tr)) {
          if (ln(tc) !== "tc") continue
          const csz = findChildByLocalName(tc, "cellSz")
          const cm = findChildByLocalName(tc, "cellMargin")
          const cellW = num(csz, "width")
          const mL = cm ? num(cm, "left", 141) : 141
          const mR = cm ? num(cm, "right", 141) : 141
          const areaW = Math.max(500, cellW - mL - mR)
          const sub = findChildByLocalName(tc, "subList")
          if (sub) reflowBlockFlow(sub, doc, styles, areaW, mode, counter, 0)
        }
      }
    }
  }
}

/**
 * 한 블록 컨테이너(본문 root 또는 셀 subList) 안 문단들을 세로 흐름으로 reflow.
 * @param bodyH 최상위(본문)일 때만 >0 — 문단 단위 자동 페이지 나눔(vertpos 페이지 로컬 리셋).
 *   셀 subList는 0(페이지 나눔 없음).
 */
function reflowBlockFlow(
  container: Element,
  doc: Document,
  styles: RenderStyles,
  areaW: number,
  mode: WrapMode,
  counter: { n: number },
  bodyH: number,
): void {
  let cursorV = 0
  let prevSpaceAfter = 0
  for (const p of elements(container)) {
    if (ln(p) !== "p") continue
    const g = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")
    const startV = cursorV + prevSpaceAfter + (g?.spaceBefore ?? 0)
    const res = reflowPara(p, doc, styles, areaW, startV, mode)
    if (res) {
      const paraH = res.paraBottom - startV
      // 페이지 넘김: 문단이 현재 페이지를 넘치고, 문단 자체는 한 페이지에 들어가면 다음 페이지로.
      if (bodyH > 0 && startV > 0 && res.paraBottom > bodyH && paraH <= bodyH) {
        shiftParaVert(p, -startV) // 새 페이지 상단(로컬 0)으로 이동 → 프리패스가 vertpos 역행 감지
        cursorV = paraH
      } else {
        cursorV = res.paraBottom
      }
      prevSpaceAfter = res.spaceAfter
      counter.n++
    }
    // 문단 안 표 셀은 셀 로컬 좌표로 별도 reflow (본문 세로 흐름과 무관)
    reflowTablesIn(p, doc, styles, mode, counter)
  }
}

/**
 * section root의 조판 캐시 없는 문단에 linesegarray를 합성 주입한다(표 셀 재귀 포함).
 * 반환: 합성한 문단 수.
 * (Phase 2~3: 최상위 텍스트 + 표 셀 내부. 개체 밀어내기·자동 페이지 분할은 후속.)
 */
export function reflowSection(
  root: Element,
  styles: RenderStyles,
  geom: ReflowGeom,
  mode: WrapMode = "keep",
): number {
  const doc = root.ownerDocument as unknown as Document
  const counter = { n: 0 }
  reflowBlockFlow(root, doc, styles, geom.BODY_W, mode, counter, geom.BODY_H)
  return counter.n
}
