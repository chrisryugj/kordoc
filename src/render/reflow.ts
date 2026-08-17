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
 * Phase 3(v4.0.4): 개체 세로 흐름 — float(TOP_AND_BOTTOM)는 텍스트를 outMargin 포함
 * 개체 아래로 밀고, PAGE/PAPER 앵커·BEHIND/IN_FRONT는 흐름 불참, inline 표는 실효높이
 * +leading 전진. 혼합 캐시 문서는 캐시 문단의 한컴 좌표로 커서를 이어 받는다
 * (seoul 코퍼스 자기일관성 59/59 — 36264961 전 문단 d=0 실측).
 */

import { buildPara, measureTableHeight } from "./svg-render.js"
import { simulateWrap, faceClassOf, type WrapMode } from "../hwpx/text-metrics.js"
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
  // 실문자가 없는 문단(빈 줄·개체 전용)도 run의 charPrIDRef가 줄높이를 지배한다 —
  // DEFAULT_CHAR(1000)로 재면 빈 문단 pitch가 본문(예: 1300→2080)보다 작아 이후
  // 문단 전체가 위로 밀린다 (seoul 코퍼스 36264961 실측 −480×빈줄 누적)
  if (domChar === DEFAULT_CHAR) {
    for (const run of elements(p)) {
      if (ln(run) !== "run") continue
      const st = styles.charPr.get(run.getAttribute("charPrIDRef") ?? "")
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

  // 문단 paraPr의 breakSetting이 있으면 그 선언(어절/글자)을 따르고, 없으면 호출자 모드
  const paraMode = geom.wrapMode ?? mode
  // 폭 테이블: 지배 charPr 글꼴이 고정폭(굴림체류)이면 전용 클래스 — 함초롬 테이블(한글
  // 0.97em)로 재면 줄당 1~2자 과대적재로 wrap이 어긋난다 (seoul 코퍼스 3건 실측)
  const faceClass = faceClassOf(domChar.face)
  const wrap = text.length === 0
    ? { lines: 1, starts: [0], lastLineWidth: 0 }
    : simulateWrap(text, firstWidth, contWidth, height, ratio, paraMode, { spacingPct, faceClass })

  const pitch = pitchFor(height, geom)
  const baseline = Math.round(height * BASELINE_RATIO)
  const spacing = Math.max(0, pitch - height)

  // ── 개체(표·이미지) 세로 흐름 분류 (Phase 3 — 한컴 실측 모델, 36264961) ──
  // · float(treatAsChar=0) + TOP_AND_BOTTOM + PARA 앵커: 개체가 문단 상단을 차지하고
  //   텍스트는 outTop+개체높이+outBottom 아래부터 흐른다 (두문 결재표 실측:
  //   140+16653+852=17645 정확 일치)
  // · BEHIND_TEXT/IN_FRONT_OF_TEXT 또는 PAGE/PAPER 앵커: 본문 흐름에 불참
  //   (페이지 하단 직인 스탬프가 커서를 밀던 것 제거)
  // · inline(treatAsChar=1): 줄 하나로 취급 — outMargin 포함 높이 + 줄 leading(spacing)
  //   만큼 전진 (실측: 표끝→다음 문단 간격 = 성장 포함 표높이 + spacing)
  let floatBelow = 0 // 텍스트 시작을 아래로 미는 float 개체 바닥 (문단 로컬)
  let objBottom = startV
  for (const o of m.objs) {
    const effH = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el)) : o.height
    const pos = findChildByLocalName(o.el, "pos")
    const om = findChildByLocalName(o.el, "outMargin")
    const outT = num(om, "top"), outB = num(om, "bottom")
    if (o.inline) {
      objBottom = Math.max(objBottom, startV + outT + effH + outB + spacing)
      continue
    }
    const wrapAttr = o.el.getAttribute("textWrap") ?? ""
    if (wrapAttr === "BEHIND_TEXT" || wrapAttr === "IN_FRONT_OF_TEXT") continue
    const vertRel = pos?.getAttribute("vertRelTo") ?? "PARA"
    if (vertRel === "PAGE" || vertRel === "PAPER") continue
    const vo = Math.max(0, num(pos, "vertOffset"))
    if (wrapAttr === "TOP_AND_BOTTOM") {
      floatBelow = Math.max(floatBelow, vo + outT + effH + outB)
    } else {
      objBottom = Math.max(objBottom, startV + vo + outT + effH + outB)
    }
  }
  const textStartV = startV + floatBelow

  const lsa = doc.createElement("hp:linesegarray")
  for (let li = 0; li < wrap.starts.length; li++) {
    const startReal = wrap.starts[li]
    // 실텍스트 없는 문단(인라인 표·개체만)의 textpos는 0 — chars.length로 폴백하면
    // planLines의 plan.start가 개체 index보다 커져 advanceTo 가로 전진에서 개체가
    // 전부 빠지고 같은 x에 겹쳐 그려진다 (공문 결재란 라벨표∩스탬프표 겹침의 원인)
    const textpos = startReal < realIdx.length ? realIdx[startReal] : 0
    const vertpos = textStartV + li * pitch
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

  // 문단 바닥 = 텍스트 줄 흐름(float 개체 아래부터)과 개체 바닥 중 큰 쪽.
  // 표는 셀 콘텐츠 성장으로 선언 sz보다 커질 수 있어 drawTable과 같은 실효 높이를 쓴다
  // (셀 lineseg 필요 — reflowBlockFlow가 reflowTablesIn을 먼저 돌린다).
  const textBottom = textStartV + wrap.starts.length * pitch
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
    // 문단 안 표 셀을 먼저 셀 로컬 좌표로 reflow (본문 세로 흐름과 무관) —
    // reflowPara의 표 실효높이 측정이 셀 lineseg를 읽으므로 호스트 문단보다 앞서야 한다
    reflowTablesIn(p, doc, styles, mode, counter)
    const g = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")
    const startV = cursorV + prevSpaceAfter + (g?.spaceBefore ?? 0)
    const res = reflowPara(p, doc, styles, areaW, startV, mode)
    if (!res) {
      // 캐시 보유 문단(Tier-1) — 한컴 실좌표로 커서를 전진시킨다. 혼합 캐시 문서
      // (한컴 저장본을 프로그램 편집해 일부 문단만 캐시가 없는 경우)에서 캐시 없는
      // 문단이 흐름 위치 대신 0에 겹쳐 그려지던 결함 수정 (36264961 실측: 캐시 문단
      // p18 57165+1300+780 → 캐시 없는 p19가 정확히 59245에 붙는다).
      const lsa = findChildByLocalName(p, "linesegarray")
      if (lsa) {
        let bottom = Number.NEGATIVE_INFINITY
        for (const seg of elements(lsa)) {
          if (ln(seg) !== "lineseg") continue
          const th = Math.max(num(seg, "vertsize", 1000), num(seg, "textheight", 1000))
          bottom = Math.max(bottom, num(seg, "vertpos") + th + num(seg, "spacing"))
        }
        if (Number.isFinite(bottom)) {
          cursorV = bottom
          prevSpaceAfter = g?.spaceAfter ?? 0
        }
      }
      continue
    }
    const paraH = res.paraBottom - startV
    // 페이지 넘김: 문단이 현재 페이지를 넘치고, 문단 자체는 한 페이지에 들어가면 다음 페이지로.
    // 명시적 쪽 나눔(hp:p pageBreak="1" — 한컴 '쪽 나누기' 저장 속성)도 같은 경로로 존중한다.
    const explicitBreak = bodyH > 0 && startV > 0 && p.getAttribute("pageBreak") === "1"
    if (explicitBreak || (bodyH > 0 && startV > 0 && res.paraBottom > bodyH && paraH <= bodyH)) {
      shiftParaVert(p, -startV) // 새 페이지 상단(로컬 0)으로 이동 → 프리패스가 vertpos 역행 감지
      cursorV = paraH
    } else {
      cursorV = res.paraBottom
    }
    prevSpaceAfter = res.spaceAfter
    counter.n++
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
