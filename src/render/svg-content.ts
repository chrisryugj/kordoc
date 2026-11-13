/** 문단·글상자·그룹 개체 그리기와 페이지 출력 문맥. */

import { findChildByLocalName } from "../hwpx/parser-shared.js"
import { measureTextWidth, faceClassOf } from "../hwpx/text-metrics.js"
import { DEFAULT_CHAR, type RenderStyles } from "./head-styles.js"
import { glyphWidth, joinsJamo } from "./reflow.js"
import { mapPuaText } from "../shared/pua.js"
import { latexToPlain } from "./equation-text.js"
import { layoutFractions } from "./equation-layout.js"
import { hwpEquationToLatex } from "../hwp5/equation.js"
import { RegionCollector, type PageBBox } from "./scene.js"
import { nextParaNumber, type NumberCounters } from "./para-number.js"
import { ln, elements, num, type Seg, type ParaChar, OBJ_TAGS, FORM_TAGS, type ParaObj, type ParaModel, buildPara, tabAdvance, paraHeadAdvance, type ExtentMemo, cellContentExtent, measureTableHeight, captionOf, captionExtra } from "./para-model.js"
import { planTableRows } from "./table-pages.js"
import { mulAffine, objectGeometry, renderingMatrix, shapeGeometry, rotatedBounds, SHAPE_TAGS, type Affine, type RegionRotation } from "./shape-geometry.js"
import { anchorObject, linePushedBy } from "./object-anchor.js"

export function escapeXml(s: string): string {
  return s
    // XML 1.0 금지 C0 제어문자 제거(탭 0x09·개행 0x0A·CR 0x0D는 유지) — 남기면 산출 SVG가
    // 불법 XML이라 뷰어·브라우저가 그 페이지 렌더를 통째로 중단한다("PCDATA invalid Char value").
    // gen-ids.escapeXml·source-map.escapeXmlText와 같은 계약 (rhwp #3382 동종)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ─── 내부 모델 ────────────────────────────────────

/** mirrorDx — 맞쪽(gutterType LEFT_RIGHT) 짝수 쪽의 본문 가로 이동(오른쪽 여백 − 왼쪽 여백). 짝수 쪽은 좌우 여백이 바뀐다 */
export interface PageGeom { PW: number; PH: number; ML: number; MT: number; BODY_W: number; BODY_H: number; mirrorDx?: number }

export interface Ctx {
  draw: {
    table: (tbl: Element, x: number, y: number, ctx: Ctx, depth: number) => void
    pic: (pic: Element, x: number, y: number, ctx: Ctx) => void
    picFrame: (pic: Element, x: number, y: number, w: number, h: number, transform: string, ctx: Ctx) => void
  }
  /** 최상위 문단의 문단 영역 위(앞 문단 끝, 새 쪽이면 0) — 첫 줄이 개체 아래로 밀려 저장된 문단의 개체 기준 */
  paraTops?: Map<Element, number>
  /** 그리는 최상위 문단의 문단 영역 위(절대)·본문 왼쪽·폭 — 칸 안에서 쪽 영역 안으로 제한을 끈(flowWithText 0) 문단 기준 개체의 기준 */
  escOrigin?: { x: number; y: number; w: number }
  /** 다단 구역의 단 폭·간격 — 최상위 떠 있는 개체의 단(COLUMN·PARA) 기준을 앵커 줄의 단으로 잡는다 */
  cols?: { w: number; gap: number }
  /** 쪽에서 갈린 본문 표 칸의 문단을 그리는 중 — 그 문단의 떠 있는 표도 쪽에서 가른다 */
  splitCell?: boolean
  /** 갈린 칸 안 표가 이어지는 쪽에서 다시 시작하는 자리(바깥 표의 이어진 쪽 위 + 칸 위 여백) */
  splitContMT?: number
  /** 본문(맞쪽 이동 묶음 안)을 그리는 중 — 쪽마다 본문 가로 이동량. region·용지 기준 개체는 이만큼 보정한다 */
  bodyDx?: (page: number) => number
  /** 행 계획이 옮긴 칸 안 떠 있는 개체의 쪽·위(절대 y) — 쪽을 넘게 쌓인 개체(planTableRows place) */
  objPlace?: Map<Element, { page: number; y: number }>
  /** 페이지별 SVG 버퍼 — emit()이 현재 페이지(page)로 라우팅 */
  pages: string[][]
  /** 현재 그리는 페이지 인덱스 — 최상위 문단만 갱신, 셀/중첩 콘텐츠는 호스트 페이지 상속 */
  page: number
  geom: PageGeom
  styles: RenderStyles
  images: Map<string, { dataUri: string; symId?: string; orgW?: number; orgH?: number }>
  /** 이미지 심볼 defs — dataURI는 여기 1회만, 본문은 <use> 참조 (occurrence당 재emit 금지) */
  defs: string[]
  /** 검색어 형광펜 (소문자 정규화, 빈 문자열 제거) */
  highlights: string[]
  /** 문단 번호 카운터 — 그리는 순서(문서 순서)로 센다. 전 구역 공유 */
  nums: NumberCounters
  warnings: string[]
  warned: Set<string>
  stats: { texts: number; images: number; tables: number; shapes: number }
  /** 셀/표 측정 메모 — 중첩표 지수 재계산 캡 (렌더 1회 공유) */
  extentMemo: ExtentMemo
  /** 개체 region 수집 — 그리는 순서로 결정적 id (#75). 전 구역 공유 */
  regions: RegionCollector
  /** 현재 열린 부모 region id 스택 (표 셀 콘텐츠·문단 개체·도형 글상자) */
  parentStack: string[]
  /** 앞선 구역들의 페이지 수 누계 — 전역 1-based 페이지 = pageBase + page + 1 */
  pageBase: number
  /** 이 구역 페이지의 실높이(HWPUNIT) — 단일 페이지 캔버스 연장 포함. region 하단 클램프용 */
  pageH: number
  paintJobs: PaintJob[] | null
  /** Same ancestor rotations as the SVG groups containing this object's paint. */
  regionRotations: Array<RegionRotation | Affine>
}
export interface PaintJob { page: number; layer: number; z: number; draw: () => void; body?: boolean }

export const pt = (u: number): string => String(Math.round(u) / 100)
/** HWPUNIT → pt (소수 둘째 자리) */
export const ptNum = (u: number): number => Math.round(u) / 100

/** 현재 그리는 페이지의 전역 1-based 번호 */
export function pageNo(ctx: Ctx): number { return ctx.pageBase + ctx.page + 1 }

/** HWPUNIT 사각형 → 페이지 로컬 pt bbox. 페이지 하단을 넘는 높이는 잘라 기록(분할 지오메트리 없음) */
export function bboxOf(ctx: Ctx, x: number, y: number, w: number, h: number): PageBBox {
  const b = rotatedBounds({ x, y, w, h }, ctx.regionRotations)
  if (ctx.bodyDx) b.x += ctx.bodyDx(ctx.page)
  const clippedH = Math.max(0, Math.min(b.h, ctx.pageH - b.y))
  return { page: pageNo(ctx), x: ptNum(b.x), y: ptNum(b.y), width: ptNum(Math.max(0, b.w)), height: ptNum(clippedH) }
}

export function regionOpenTag(id: string, type: string, page: number): string {
  return `<g data-kordoc-id="${id}" data-kordoc-type="${type}" data-kordoc-page="${page}">`
}

export function parentId(ctx: Ctx): string | undefined {
  return ctx.parentStack.length ? ctx.parentStack[ctx.parentStack.length - 1] : undefined
}

export function emit(ctx: Ctx, s: string): void {
  ctx.pages[ctx.page].push(s)
}

export function warnOnce(ctx: Ctx, key: string, msg: string): void {
  if (ctx.warned.has(key)) return
  ctx.warned.add(key)
  ctx.warnings.push(msg)
}

// ─── 문단 모델 구축 ────────────────────────────────

// ─── 줄 렌더 (run별 charPr + 정렬) ──────────────────

interface LinePlan {
  seg: Seg
  /** 줄 시작 x 보정 (정렬) */
  xoff: number
  /** 텍스트 조각 폭 스케일 */
  scale: number
  /** 양쪽 정렬 줄의 빈칸마다 더하는 폭(HWPUNIT) — 한컴은 남는 폭을 빈칸에만 나눈다 */
  spaceAdd: number
  /** spaceAdd 를 받는 빈칸의 시작(줄 앞 빈칸 뒤) */
  spFrom: number
  /** 넘친 양쪽 정렬 줄에서 빈칸 아닌 글자마다 더하는 폭(HWPUNIT, 음수) — 빈칸이 줄 수 있는 몫을 넘은 나머지 */
  charAdd?: number
  start: number
  end: number
  /** 탭 슬롯 → 전진폭(HWPUNIT, 스케일 불변) */
  tabs: Map<number, number>
  /** 이 인덱스 앞(줄의 마지막 탭까지)은 스케일 없이 — 양쪽 정렬은 마지막 탭 뒤 글에만 걸린다 */
  fixedTo: number
  /** 줄 끝 공백을 뺀 끝 — 줄 끝 공백은 걸리기만 하고(hang) 정렬·그리기에서 빠진다 */
  textEnd: number
  /** 첫 줄 앞에 그릴 글머리표 — x 는 줄 글 시작 바로 앞 */
  bullet?: { ch: string; w: number; prId: string | null }
}

function charW(c: ParaChar, styles: RenderStyles, prev?: ParaChar): number {
  const st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
  if (c.ch === "" && c.ctrlText) return measureTextWidth(c.ctrlText, c.ctrlSup ? Math.round(st.height * 3 / 4) : st.height, st.ratio, { spacingPct: st.spacing, faceClass: faceClassOf(st.face) })
  // 글자 폭은 reflow 와 같은 한컴 폭 — 언어별(영문) 글꼴·장평·상대크기, 4 단위 양자화, 첨자 16/25, 합성 굵기.
  // 옛한글 자모는 reflow 와 같이 앞 자모에 합쳐 잰다
  let w = 0, last = prev?.ch ? prev.ch.codePointAt(prev.ch.length - 1) ?? 0 : 0
  for (const ch of c.ch) { const cp = ch.codePointAt(0)!; if (!joinsJamo(last, cp)) w += glyphWidth(ch, st).w; last = cp }
  return w
}

/** 줄 자연폭 = 텍스트 조각 + 인라인 개체 폭 (개체 폭은 스케일 불변, TAC 표는 outMargin 좌/우 포함) */
function lineNaturalWidth(m: ParaModel, styles: RenderStyles, start: number, end: number): { text: number; obj: number } {
  let text = 0
  for (let i = start; i < end && i < m.chars.length; i++) text += charW(m.chars[i], styles, m.chars[i - 1])
  let obj = 0
  for (const o of m.objs) if (o.inline && o.index >= start && o.index < end) obj += o.omL + o.width + o.omR
  return { text, obj }
}

/** numText: 문단 번호 머리 글("1."·"가)") — 글머리표처럼 첫 줄 앞에 그리고 그만큼 들인다 */
function planLines(m: ParaModel, styles: RenderStyles, numText = ""): LinePlan[] {
  const align = (m.paraPrId != null ? styles.paraAlign.get(m.paraPrId) : undefined) ?? "JUSTIFY"
  const geom = m.paraPrId != null ? styles.paraGeom.get(m.paraPrId) : undefined
  const hang = geom && geom.marginIntent < 0 ? -geom.marginIntent : 0
  // 줄 앞머리 — 한컴 lineseg 의 horzpos·horzsize 는 첫 줄 들여쓰기(양수 intent)·둘째 줄부터의 내어쓰기(음수 intent)·글머리표를 빼지 않는다
  // (들여쓰기 문단 645개·내어쓰기 문단 수천 개 전부 horzpos = 왼쪽 여백). 글은 그만큼 들어가서 시작하고, 양쪽 정렬도 남는 폭에 맞춘다.
  // 글머리표는 autoIndent 면 둘째 줄부터도 들인다
  const bu = geom?.bullet ?? (numText && geom?.number ? { ch: numText, ...geom.number } : undefined)
  const firstPr = m.chars.find(c => c.ch !== "")?.prId ?? null
  const bst = (bu?.charPrId != null ? styles.charPr.get(bu.charPrId) : firstPr != null ? styles.charPr.get(firstPr) : undefined) ?? DEFAULT_CHAR
  const headW = bu?.useInstWidth === false ? [...bu.ch].reduce((w, ch) => w + glyphWidth(ch, bst, false).w, 0) : bu ? measureTextWidth(bu.ch, bst.height, bst.ratio, { spacingPct: bst.spacing, faceClass: faceClassOf(bst.face) }) : 0
  const bulletW = bu ? paraHeadAdvance(bu, bst.height, headW) : 0
  const plans: LinePlan[] = []
  // 탭 앞 x 에는 글자처럼 취급하는 개체 폭(바깥 여백 좌우 포함)도 든다 — reflow 와 같다. 빼면 내어쓰기 자동 탭이 개체 폭만큼 더 길어진다
  // (한컴 PDF: 체크칸 사각형 978 뒤 "KZ⇥Kazakhstan" 의 탭이 내어쓰기 위치에 선다 — 빼고 재면 9.6pt 오른쪽)
  const inlineW = new Map<number, number>()
  for (const o of m.objs) if (o.inline) inlineW.set(o.index, o.omL + o.width + o.omR)
  for (let i = 0; i < m.segs.length; i++) {
    const seg = m.segs[i]
    const start = seg.textpos
    const end = i + 1 < m.segs.length ? m.segs[i + 1].textpos : Math.max(m.chars.length, start)
    // 탭 해석 — 자연폭으로 정지점을 잡고, 마지막 탭까지는 스케일 없이 고정폭으로 둔다
    const tabs = new Map<number, number>()
    const lead = i === 0 ? Math.max(geom?.marginIntent ?? 0, 0) + bulletW : hang + (bu?.autoIndent ? bulletW : 0)
    let x = (i === 0 ? Math.max(geom?.marginIntent ?? 0, 0) : hang) + (i === 0 || bu?.autoIndent ? bulletW : 0) // 첫 줄은 들여쓰기(양수 intent)만큼 들어가서 시작
    let fixedTo = start
    let fixedW = 0
    for (let k = start; k < end && k < m.chars.length; k++) {
      const c = m.chars[k]
      const ow = inlineW.get(k)
      if (ow !== undefined) { x += ow; continue }
      if (!c.tab) { x += charW(c, styles, m.chars[k - 1]); continue }
      const adv = tabAdvance(x, i === 0, geom, c.tabW)
      tabs.set(k, adv)
      x += adv
      fixedTo = k + 1
    }
    if (fixedTo > start) fixedW = lineNaturalWidth(m, styles, start, fixedTo).text + [...tabs.values()].reduce((a, b) => a + b, 0)
    // 줄 끝 공백 제외 — 어절 줄바꿈은 줄마다 끝에 공백이 걸린다. 넣고 늘이면 글이 오른쪽 끝에 못 닿는다
    // 강제 줄바꿈 앞 공백도 줄 끝 공백이다(같은 판 한컴 PDF: "… 아시아 ⏎" 가운데 정렬 제목이 공백 빼고 가운데 — 넣으면 공백 반 폭 6.4pt 왼쪽)
    let textEnd = Math.min(end, m.chars.length)
    while (textEnd > fixedTo && m.chars[textEnd - 1].br) textEnd--
    while (textEnd > fixedTo && m.chars[textEnd - 1].ch === " ") textEnd--
    const nat = lineNaturalWidth(m, styles, fixedTo, textEnd)
    for (const o of m.objs) if (o.inline && o.index >= textEnd && o.index < end) nat.obj += o.omL + o.width + o.omR
    nat.obj += fixedW
    for (const o of m.objs) if (o.inline && o.index >= start && o.index < fixedTo) nat.obj += o.omL + o.width + o.omR
    // 강제 줄바꿈(lineBreak)으로 끝난 줄도 마지막 줄처럼 늘이지 않는다 — 한컴 PDF: 양쪽 정렬 문단의 줄바꿈 줄이 자연 폭(114pt, 늘였다면 131pt)
    let brEnd = false
    for (let k = start; k < end && k < m.chars.length; k++) if (m.chars[k].br) brEnd = true
    const isLast = i === m.segs.length - 1 || brEnd
    let xoff = 0
    let scale = 1
    const lineW = seg.horzsize - lead
    const avail = lineW - nat.obj
    // 줄 끝 글자 뒤에는 자간을 두지 않는다 — 정렬·늘이기 폭에서 마지막 글자의 자간 몫을 뺀다(조판 넘침 판정과 같다)
    // (같은 판이 저장·인쇄한 한컴 PDF: 자간 −16% 26pt 가운데 정렬 제목 줄의 끝 글자 전진폭 25.19pt, 다른 한글 21.23pt)
    let lastSp = 0
    if (fixedTo === start) {
      let k = textEnd - 1
      while (k >= start && m.chars[k].ch === "") k--
      if (k >= start) {
        const c = m.chars[k], st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
        const cps = [...c.ch]
        lastSp = glyphWidth(cps[cps.length - 1], st).sp
      }
    }
    // 늘이기는 양쪽 정렬의 중간 줄·배분 정렬만 — 왼쪽·가운데·오른쪽 정렬은 줄마다 자연 폭으로 그 자리에 맞춘다
    // (한컴 PDF: 가운데 정렬 문단의 첫 줄이 가운데, 종전엔 중간 줄을 정렬과 무관하게 줄 폭에 늘였다)
    const stretch = align === "JUSTIFY" || align === "DISTRIBUTE" || align === "DISTRIBUTE_SPACE"
    let spaceAdd = 0, spaceFrom = fixedTo, charAdd = 0
    // 넘친 줄(자연 폭 > 줄 폭)은 빈칸을 제 폭의 20% 까지만 줄이고 나머지는 빈칸 아닌 글자마다 똑같이 줄인다 — 정렬과 공백 최소값(condense)에
    // 상관없다. 같은 판 한컴 PDF 넘친 줄 90여 개(글자마다 PDF 전진 − 자연 폭): 빈칸 몫은 −140(14pt 빈칸 700 의 20%)에서 멈추고
    // 글자 몫 = (모자람 − 빈칸 몫) / 글자 수 — 양쪽 정렬 3296·빈칸 7·글자 37 → −62(PDF −62), 가운데 정렬 마지막 줄 936·글자 10 → −93(PDF −93),
    // 왼쪽 정렬 3252·빈칸 13·글자 38 → −44(PDF −44). 모자람이 빈칸 몫 안이면 빈칸만(536·빈칸 10 → −54, PDF −52·글자 0)
    const squeeze = (spFrom: number): void => {
      const short = nat.text - lastSp - avail
      let nSp = 0, cap = 0, nG = 0
      for (let k = spFrom; k < textEnd; k++) { const c = m.chars[k]; if (c.ch === " ") { nSp++; cap += charW(c, styles, m.chars[k - 1]) * 0.2 } else if (c.ch && !c.tab) nG++ }
      if (nSp > 0) { spaceAdd = -Math.min(short, cap) / nSp; spaceFrom = spFrom }
      if (short > cap && nG > 0) charAdd = -(short - (nSp > 0 ? cap : 0)) / nG
    }
    if (nat.text > 0 && stretch && (!isLast || align === "DISTRIBUTE" || align === "DISTRIBUTE_SPACE")) {
      // 줄바꿈이 고정된 중간 줄·배분정렬 — 줄 영역 폭에 맞춰 고정 (원본 조판 재현). 양쪽 정렬·빈칸 배분은 남는 폭을 빈칸에만 나눈다
      // (한컴 PDF: 양쪽 정렬 줄 30개 모두 빈칸 아닌 글자의 늘임 0~5 HWPUNIT, 늘임은 빈칸에). 빈칸 없는 줄·배분 정렬은 글자 전체를 늘인다
      let nSp = 0, spFrom = fixedTo
      // 줄 앞 빈칸은 늘이지 않는다 — 컨트롤(누름틀·떠 있는 개체 앵커)이 앞에 있으면 그 뒤 빈칸은 줄 앞이 아니다
      // (같은 판 한컴 PDF: 누름틀로 시작하는 양쪽 정렬 줄의 첫 빈칸이 다른 빈칸처럼 늘어난다)
      while (spFrom < textEnd && (m.chars[spFrom].ch === " " || m.chars[spFrom].ch === "") && !m.chars[spFrom].ctrl) spFrom++
      for (let k = spFrom; k < textEnd; k++) if (m.chars[k].ch === " ") nSp++
      if (nSp > 0 && align !== "DISTRIBUTE") {
        spaceAdd = (avail - nat.text + lastSp) / nSp; spaceFrom = spFrom
        if (spaceAdd < 0) squeeze(spFrom)
      }
      else scale = avail > 0 ? avail / nat.text : 1
    } else if (nat.text + nat.obj > 0 && (isLast || !stretch)) {
      const w = nat.text + nat.obj - lastSp
      if (align === "CENTER") xoff = Math.max(0, (lineW - w) / 2)
      else if (align === "RIGHT") xoff = Math.max(0, lineW - w)
    }
    // 늘이지 않는 줄(왼쪽·가운데·오른쪽 정렬, 마지막 줄)도 넘치면 같은 규칙으로 줄인다 — 저장 줄 나눔이 그렇게 한 줄에 넣은 것이다
    if (spaceAdd === 0 && charAdd === 0 && scale === 1 && nat.text - lastSp > avail) {
      let spFrom = fixedTo
      while (spFrom < textEnd && (m.chars[spFrom].ch === " " || m.chars[spFrom].ch === "") && !m.chars[spFrom].ctrl) spFrom++
      squeeze(spFrom)
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1
    scale = Math.min(4, Math.max(0.25, scale))
    plans.push({ seg, xoff: xoff + lead, scale, spaceAdd, spFrom: spaceFrom, ...(charAdd ? { charAdd } : {}), start, end, tabs, fixedTo, textEnd, ...(i === 0 && bu ? { bullet: { ch: bu.ch, w: bulletW, prId: bu.charPrId ?? firstPr } } : {}) })
  }
  return plans
}

/** 줄 안 [start, upto) 구간의 전진폭 (텍스트×스케일 + 인라인 개체 — TAC 표는 outMargin 좌/우 포함) */
function advanceTo(m: ParaModel, styles: RenderStyles, plan: LinePlan, upto: number): number {
  let x = 0
  for (let i = plan.start; i < upto && i < m.chars.length; i++) {
    const c = m.chars[i], inStretch = i >= plan.spFrom && i < plan.textEnd
    x += c.tab ? plan.tabs.get(i) ?? 0 : charW(c, styles, m.chars[i - 1]) * (i < plan.fixedTo ? 1 : plan.scale) + (inStretch && c.ch === " " ? plan.spaceAdd : 0) + (inStretch && plan.charAdd && c.ch && c.ch !== " " ? plan.charAdd : 0)
  }
  for (const o of m.objs) if (o.inline && o.index >= plan.start && o.index < upto) x += o.omL + o.width + o.omR
  return x
}

// ─── 문단 드로잉 ───────────────────────────────────

/**
 * @param segPages 최상위 문단 전용 — seg 인덱스별 페이지 배정 (vertpos 리셋 감지 결과).
 *   셀/중첩 콘텐츠는 전달하지 않아 호스트의 ctx.page 를 상속한다.
 */
export function drawPara(p: Element, ox: number, oy: number, areaW: number, ctx: Ctx, depth: number, segPages?: number[]): void {
  if (depth > 16) { warnOnce(ctx, "depth", "중첩 깊이 16 초과 — 이하 생략"); return }
  const m = buildPara(p)
  const numText = nextParaNumber(ctx.nums, m.paraPrId != null ? ctx.styles.paraGeom.get(m.paraPrId) : undefined)
  if (m.segs.length === 0) {
    // 조판 캐시 없는 문단 — 개체만이라도 문단 원점에 배치. 텍스트는 무음 생략 금지
    if (m.chars.some(c => c.ch !== "")) {
      warnOnce(ctx, "no-lineseg", "조판 캐시 없는 문단 텍스트 생략 — reflow 옵션으로 합성 가능")
    }
    for (const o of m.objs) {
      const { x, y } = o.inline ? { x: ox, y: oy } : anchorObject(o, ox, oy, 0, areaW, ctx)
      drawObject(o, x, y, 0, areaW, ctx, depth)
    }
    return
  }
  const plans = planLines(m, ctx.styles, numText)
  const baseV = m.segs[0].vertpos

  // 문단 region — 실문자가 있는 문단만. 줄(lineseg) 영역의 페이지별 합집합, 페이지가 바뀌면 조각을 나눈다.
  // SVG 는 페이지 버퍼별로 <g data-kordoc-*> 래퍼를 열고 닫는다(개체는 별도 region, parentId=문단).
  const hasText = m.chars.some(c => c.ch !== "" && c.ch.trim() !== "")
  let paraRegionId: string | null = null
  let gOpenOn = -1

  for (let li = 0; li < plans.length; li++) {
    const plan = plans[li]
    if (segPages && segPages[li] !== undefined) ctx.page = segPages[li]
    const { seg } = plan
    if (hasText) {
      const lineBox = bboxOf(ctx, ox + seg.horzpos, oy + seg.vertpos, seg.horzsize, seg.textheight)
      if (paraRegionId === null) paraRegionId = ctx.regions.add("paragraph", lineBox, { parentId: parentId(ctx) })
      else ctx.regions.addFragment(paraRegionId, lineBox)
      if (gOpenOn !== ctx.page) {
        if (gOpenOn >= 0) ctx.pages[gOpenOn].push("</g>")
        emit(ctx, regionOpenTag(paraRegionId, "paragraph", pageNo(ctx)))
        gOpenOn = ctx.page
      }
    }
    // charPr 단위 조각으로 분할
    let i = plan.start
    let cursor = ox + seg.horzpos + plan.xoff
    const y = oy + seg.vertpos + seg.baseline
    // 문단 세로 정렬 가운데·아래 — 저장 baseline 은 줄 가운데(높이/2)·줄 바닥이고, 한컴은 글자 상자(기준선 85%)를 거기에 맞춘다:
    // 가운데면 기준선 = 줄 가운데 + 0.35·글자 크기, 아래면 줄 바닥 − 0.15·글자 크기(한컴 PDF: 가운데 정렬 칸 숫자가 3.9pt 아래)
    const pva = m.paraPrId != null ? ctx.styles.paraGeom.get(m.paraPrId)?.vertAlign : undefined
    const glyphY = (h: number): number => y + (pva === "CENTER" ? Math.round(h * 0.35) : pva === "BOTTOM" ? -Math.round(h * 0.15) : 0)
    if (plan.bullet) {
      const bs = (plan.bullet.prId != null ? ctx.styles.charPr.get(plan.bullet.prId) : undefined) ?? DEFAULT_CHAR
      const attrs = [`x="${pt(cursor - plan.bullet.w)}"`, `y="${pt(glyphY(bs.height))}"`, `font-size="${pt(bs.height)}"`]
      if (bs.fontFamily) attrs.push(`font-family="${escapeXml(bs.fontFamily)}"`)
      if (bs.color) attrs.push(`fill="${escapeXml(bs.color)}"`)
      emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(plan.bullet.ch)}</text>`)
      ctx.stats.texts++
    }
    while (i < plan.end && i < m.chars.length) {
      if (i >= plan.textEnd && m.chars[i].ch === " ") { i++; continue }
      // 필러 슬롯(컨트롤·서로게이트 자리)은 그리지 않고 건너뛴다 —
      // 인라인 개체의 폭 전진은 개체 첫 슬롯에서 1회 수행
      if (m.chars[i].ch === "") {
        // 글을 그리는 컨트롤(주석 머리 번호 "1)"·각주·미주 본문 참조 번호) — reflow 와 같은 폭으로 그 자리에 그린다(참조 번호는 위첨자 크기·위로)
        const ct = m.chars[i].ctrlText
        if (ct) {
          const cs0 = (m.chars[i].prId != null ? ctx.styles.charPr.get(m.chars[i].prId!) : undefined) ?? DEFAULT_CHAR
          const sup = !!m.chars[i].ctrlSup, fh = sup ? Math.round(cs0.height * 16 / 25) : cs0.height
          const cw = measureTextWidth(ct, sup ? Math.round(cs0.height * 3 / 4) : fh, cs0.ratio, { spacingPct: cs0.spacing, faceClass: faceClassOf(cs0.face) })
          const attrs = [`x="${pt(cursor)}"`, `y="${pt(glyphY(cs0.height) - (sup ? Math.round(cs0.height * 0.35) : 0))}"`, `font-size="${pt(fh)}"`]
          if (cs0.fontFamily) attrs.push(`font-family="${escapeXml(cs0.fontFamily)}"`)
          if (cs0.color) attrs.push(`fill="${escapeXml(cs0.color)}"`)
          emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(ct)}</text>`)
          ctx.stats.texts++
          cursor += cw * plan.scale
        }
        if (m.chars[i].tab) cursor += plan.tabs.get(i) ?? 0
        for (const o of m.objs) if (o.inline && o.index === i) cursor += o.omL + o.width + o.omR
        i++
        continue
      }
      // 마지막 탭 앞(부호 등)은 양쪽 정렬 스케일 없이 — 탭 뒤 내용 시작이 정지점에 정확히 선다
      const scale = i < plan.fixedTo ? 1 : plan.scale
      const prId = m.chars[i].prId
      let j = i
      let piece = ""
      // 필러에서 멈추므로 piece 안은 실문자뿐 — 개체 경계 절단이 자연 발생
      while (j < plan.end && j < m.chars.length && m.chars[j].prId === prId && m.chars[j].ch !== "" && !(j >= plan.textEnd && m.chars[j].ch === " ")) { piece += m.chars[j].ch; j++ }
      // 연속 공백(2+) 경계 절단 — 공백 폭 오차(한컴 0.5em 고정 vs 뷰어 폰트)를
      // 공백 구간에 가둔다 (공무원 스페이스 정렬 원문에서 글자 벌어짐 방지)
      // (문자열 인덱스를 슬롯 오프셋으로 쓴다 — 서로게이트 쌍이 섞이면 1슬롯 오차, 무시)
      {
        const cut = piece.search(/ {2,}/)
        if (cut > 0) { piece = piece.slice(0, cut); j = i + cut }
        else if (cut === 0) {
          const runEnd = piece.match(/^ +/)![0].length
          piece = piece.slice(0, runEnd); j = i + runEnd
        }
      }
      const st = (prId != null ? ctx.styles.charPr.get(prId) : undefined) ?? DEFAULT_CHAR

      // 텍스트 세그먼트 1개를 렌더하고 전진폭 반환. hit=true 면 형광펜 배경 rect 를
      // 텍스트 앞에 깐다. 세그먼트마다 자체 textLength 를 쓰므로 rect(hit)와 글자가
      // 완전히 같은 폭·위치로 계산돼 형광펜이 어긋나지 않는다.
      // 위·아래 첨자 — 크기 16/25, 위첨자 기준선은 0.44·크기 위(한컴 PDF 위첨자 61문서: 9.59pt/15pt, 올림 0.434~0.446·크기). 아래첨자 높이는 실측 없음 — 기준선 그대로
      const fh = st.script ? Math.round(st.height * 16 / 25) : st.height
      const raise = st.script === "sup" ? Math.round(st.height * 0.44) : 0
      // 조각 폭 = 글자마다 한컴 폭(charW 와 같다 — 양쪽 정렬 계획과 그리기가 같은 폭을 쓴다)
      const measure = (text: string): number => { let w = 0, last = 0; for (const ch of text) { const cp = ch.codePointAt(0)!; if (!joinsJamo(last, cp)) w += glyphWidth(ch, st).w; last = cp } return w }
      // 늘임을 받는 빈칸 수 — 이 조각이 줄 앞 빈칸(spFrom 앞)에서 시작하면 그 빈칸은 뺀다
      const skipLead = Math.max(0, plan.spFrom - i)
      const spacesIn = (text: string): number => {
        let n = 0, k = 0
        for (const c of text) { if (c === " " && !(k < skipLead && text === piece)) n++; k++ }
        return n
      }
      const renderSeg = (text: string, cx: number, hit: boolean): number => {
        const sw = measure(text) * scale + (plan.spaceAdd && i >= plan.fixedTo ? plan.spaceAdd * spacesIn(text) : 0) + (plan.charAdd && i >= plan.fixedTo ? plan.charAdd * [...text].filter(ch => ch !== " ").length : 0)
        // 글자 음영 — 글자 상자(기준선 위 0.85·크기부터 크기만큼, 한컴 PDF 13pt 글자의 음영 상자 13.07pt)
        if (st.shade) emit(ctx, `<rect x="${pt(cx)}" y="${pt(glyphY(st.height) - Math.round(st.height * 0.85))}" width="${pt(sw)}" height="${pt(st.height)}" fill="${escapeXml(st.shade)}"/>`)
        if (hit) {
          emit(ctx, `<rect x="${pt(cx)}" y="${pt(oy + seg.vertpos)}" width="${pt(sw)}" height="${pt(seg.textheight)}" fill="#ffd54f" fill-opacity="0.45"/>`)
        }
        if (text.trim().length > 0) {
          const attrs: string[] = [`x="${pt(cx)}"`, `y="${pt(glyphY(st.height) - raise)}"`, `font-size="${pt(fh)}"`]
          if (st.fontFamily) attrs.push(`font-family="${escapeXml(st.fontFamily)}"`)
          if ([...text].length > 1 && sw > 50) {
            attrs.push(`textLength="${pt(sw)}"`, `lengthAdjust="${scale < 1 ? "spacingAndGlyphs" : "spacing"}"`)
          }
          if (st.bold) attrs.push(`font-weight="bold"`)
          if (st.italic) attrs.push(`font-style="italic"`)
          if (st.underline) attrs.push(`text-decoration="underline"`)
          if (st.color) attrs.push(`fill="${escapeXml(st.color)}"`)
          // 한컴 기호 PUA(Wingdings 계열·보충 사용자 영역)는 파서와 같은 표로 표준 기호로 바꿔 그린다 — 폭은 원래 글자로 쟀다(뷰어에 그 글꼴이 없어 빈 상자가 되던 것)
          emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(mapPuaText(text))}</text>`)
          ctx.stats.texts++
        }
        return sw
      }

      // 형광펜 매치 구간 수집 → 병합(겹침 제거) → [평문·매치·평문…] 분할 렌더
      const merged: Array<[number, number]> = []
      if (ctx.highlights.length > 0 && piece.trim().length > 0) {
        const found: Array<[number, number]> = []
        const lower = piece.toLowerCase()
        for (const term of ctx.highlights) {
          for (let f = lower.indexOf(term); f !== -1; f = lower.indexOf(term, f + term.length)) {
            found.push([f, f + term.length])
          }
        }
        found.sort((a, b) => a[0] - b[0])
        for (const [s, e] of found) {
          const tail = merged[merged.length - 1]
          if (tail && s <= tail[1]) tail[1] = Math.max(tail[1], e)
          else merged.push([s, e])
        }
      }

      if (merged.length === 0) {
        cursor += renderSeg(piece, cursor, false)
      } else {
        let segCur = cursor
        let last = 0
        for (const [s, e] of merged) {
          segCur += renderSeg(piece.slice(last, s), segCur, false)
          segCur += renderSeg(piece.slice(s, e), segCur, true)
          last = e
        }
        segCur += renderSeg(piece.slice(last), segCur, false)
        cursor = segCur
      }
      i = j
    }
  }
  if (gOpenOn >= 0) ctx.pages[gOpenOn].push("</g>")

  // 개체 배치 — 인라인은 소속 줄 위치, 앵커는 hp:pos 해석. 개체 region 의 부모는 문단(없으면 상위)
  if (paraRegionId) ctx.parentStack.push(paraRegionId)
  /** 위아래 배치 개체 쌓기 — 개체마다 문단 영역 위에서 센 위치 */
  let tbStack: Map<Element, number> | undefined
  let tbStackTop: number | undefined
  if (depth === 0) {
    const top = ctx.paraTops?.get(p)
    ctx.escOrigin = top !== undefined ? { x: ox, y: oy + top, w: areaW } : undefined
  }
  for (const o of m.objs) {
    if (o.inline) {
      let planIdx = 0
      for (let k = 0; k < plans.length; k++) {
        const pl = plans[k]
        if (pl.start <= o.index && (o.index < pl.end || k === plans.length - 1)) planIdx = k
      }
      const plan = plans[planIdx]
      if (segPages && segPages[planIdx] !== undefined) ctx.page = segPages[planIdx]
      // TAC 표 괘선은 pen + outMargin좌 (advanceTo는 o.index 앞까지라 자신의 om 미포함)
      const x = ox + plan.seg.horzpos + plan.xoff + advanceTo(m, ctx.styles, plan, o.index) + o.omL
      // 개체가 줄보다 낮으면 baseline 위에 얹고, 줄을 채우는 개체(th==h)는 줄 상단
      // 수식은 제 기준선(높이 × baseLine%)을 줄 기준선에 맞춘다
      // 그림은 높이의 85% 가 기준선 위, 15% 는 아래(한컴 PDF: 기준선 2960 줄의 그림 2834·3276·3482 위가 줄 위 아래 551·175·0 — reflow 기준선 모델과 같다)
      // 그림자 있는 사진은 그림자까지 든 높이로 줄을 짠다 — 줄 높이가 사진보다 크고 기준선이 그 85% 면 사진은 줄 맨 위(같은 판 한컴 PDF:
      // 그림자 거리 300 인 34978 사진의 줄 35962·기준선 30568 = 0.85 × 35962, 사진 위가 줄 위)
      const shadowed = o.tag === "pic" && !!findChildByLocalName(findChildByLocalName(o.el, "effects") ?? o.el, "shadow") && plan.seg.textheight > o.height && Math.abs(plan.seg.baseline - Math.round(plan.seg.textheight * 0.85)) <= 2
      // 표는 그려질 높이(칸 글로 자란 실효 높이)로 얹는다 — reflow 가 그 높이로 줄을 짜는데 저장 sz 로 얹으면 자란 만큼 아래로 내려가
      // 위에 빈 자리가 생기고 뒤 문단과 겹쳤다(패치로 칸 글만 늘어난 표, sz 10601 → 그려진 표 20534)
      const eqAsc = o.tag === "equation" && Number(o.el.getAttribute("baseLine")) > 0 ? Math.round(o.height * Number(o.el.getAttribute("baseLine")) / 100) : shadowed ? Math.round(plan.seg.textheight * 0.85) : o.tag === "pic" ? Math.round(o.height * 0.85)
        : o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, ctx.extentMemo)) : o.height
      // 바깥 여백: 개체(+아래 여백)는 기준선 위에 얹되 줄 위 + 위 여백보다 위로는 안 간다(한컴 PDF: 줄을 채우는 인라인 표 = 줄 위 + outMargin 위)
      const iom = findChildByLocalName(o.el, "outMargin"), iomT = num(iom, "top"), iomB = num(iom, "bottom")
      // 표는 바깥 여백까지 든 높이의 85% 가 기준선 위다(reflow 기준선 모델과 같다 — 같은 판 한컴 PDF: 기준선 9841 줄에 나란한 인라인 표 11578·8452 중
      // 작은 표 위가 줄 위 아래 26.6pt = 9841 − 0.85 × 8452 + 140, 바닥을 기준선에 두면 13.9pt)
      const capX = captionExtra(o.el)
      const yTop = oy + plan.seg.vertpos + Math.max(iomT, o.tag === "tbl" && capX === 0 ? plan.seg.baseline - Math.round((eqAsc + iomT + iomB) * 0.85) + iomT : plan.seg.baseline - eqAsc - iomB - capX)
      drawObject(o, x, yTop, baseV, areaW, ctx, depth)
    } else {
      // 앵커 좌표는 첫 seg(baseV) 기준이므로 첫 seg 의 페이지에 귀속
      if (segPages && segPages[0] !== undefined) ctx.page = segPages[0]
      // 칸 안 개체가 쪽 영역 안으로 제한을 끄면(flowWithText 0) 칸을 벗어나 표를 담은 최상위 문단·본문 기준이다
      // (한컴 PDF: 칸 문단의 vertOffset 10436 그림이 본문 위 + 104.4pt·본문 왼쪽, 표는 그 그림 아래로 밀린 줄에)
      const posE = findChildByLocalName(o.el, "pos")
      if (depth > 0 && ctx.escOrigin && posE?.getAttribute("flowWithText") === "0" && (posE.getAttribute("vertRelTo") ?? "PARA") === "PARA") {
        const { x, y } = anchorObject(o, ctx.escOrigin.x, ctx.escOrigin.y, 0, ctx.escOrigin.w, ctx, undefined, 0)
        drawObject(o, x, y, baseV, areaW, ctx, depth)
        continue
      }
      // 다단 본문의 단·문단 기준 개체는 앵커 첫 줄이 든 단을 영역으로(한컴 PDF 실측: 오른쪽 단 문단의 CENTER 개체 = 오른쪽 단 + (단 폭 − 폭)/2 + 오프셋)
      let ax = ox, aw = areaW
      if (depth === 0 && ctx.cols && plans[0]) {
        const col = Math.floor((plans[0].seg.horzpos + 1) / (ctx.cols.w + ctx.cols.gap))
        ax = ox + col * (ctx.cols.w + ctx.cols.gap); aw = ctx.cols.w
      }
      // 문단 기준(horzRelTo PARA) 가로 위치는 문단 왼쪽·오른쪽 여백 안에서 잰다(같은 판 한컴 PDF: 왼쪽 여백 1500 문단의 표가 본문 왼쪽 + 15pt + 바깥 여백)
      if (findChildByLocalName(o.el, "pos")?.getAttribute("horzRelTo") === "PARA" && m.paraPrId != null) {
        const g = ctx.styles.paraGeom.get(m.paraPrId)
        if (g) { ax += g.marginLeft; aw -= g.marginLeft + g.marginRight }
      }
      // 어울림(SQUARE) 개체 위 = max(문단 위 + vertOffset, 앵커 줄 위) — reflow 의 zoneStart 와 같은 규칙
      let anchorLineV: number | undefined
      let anchorLineH = 0
      let anchorSeg: Seg | undefined
      let anchorK = -1
      plans.forEach((pl, k) => { if (pl.start <= o.index) { anchorLineV = pl.seg.vertpos; anchorLineH = pl.seg.textheight; anchorSeg = pl.seg; anchorK = k } })
      // 첫 줄이 개체 아래로 밀려 저장된 문단(줄이 문단 영역 위 + 위 간격보다 아래) — 글을 밀지 않는 개체는 문단 시작 기준
      let objBaseV = baseV
      const pTop = depth === 0 ? ctx.paraTops?.get(p) : undefined
      const wrapA = o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM"
      const top0 = pTop ?? (depth > 0 && wrapA !== "TOP_AND_BOTTOM" ? cellParaTop(p, ctx.styles.paraGeom) : undefined)
      if (top0 !== undefined && wrapA !== "TOP_AND_BOTTOM") {
        const start = top0 + (m.paraPrId != null ? ctx.styles.paraGeom.get(m.paraPrId)?.spaceBefore ?? 0 : 0)
        if (baseV > start + 100) { objBaseV = start; if (anchorLineV === baseV) anchorLineV = start }
        // 칸 안 문단의 글 뒤·앞·어울림 개체는 위 간격 앞(칸 안 문단 영역 위)이 원점이다(같은 판 한컴 PDF: 위 간격 500 칸 문단의 vertOffset 0 글 뒤 그림이 줄보다 5pt 위)
        else if (depth > 0 && start > top0 && Math.abs(baseV - start) <= 100) { objBaseV = top0; if (anchorLineV === baseV) anchorLineV = top0 }
      }
      const tbFloats = m.objs.filter(q => !q.inline && (q.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM" && (findChildByLocalName(q.el, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA").length
      let stay = tbFloats < 2 && !m.objs.some(q => q.inline) && !m.chars.some(c => c.ch !== "" && !c.nb && c.ch.trim() !== "")
      // 제자리 줄 문단의 개체는 문단 영역 위(위 간격 앞)에 놓인다 — reflow 와 같다(한컴 PDF: 위 간격 1000 문단의 표가 줄보다 10pt 위)
      const sbA = m.paraPrId != null ? ctx.styles.paraGeom.get(m.paraPrId)?.spaceBefore ?? 0 : 0
      // 줄이 개체만큼 밀려 저장됐으면 제자리가 아니다 — 줄 자리에 두면 그림이 쪽 밖으로 밀려났다
      // 칸 안 문단은 칸 안 앞 문단 끝과 견준다(한컴 PDF: 칸 안 빈 문단 줄 31301 = 앞 문단 끝 7920 + 바깥 여백 + 표 23099 — 표는 줄 위)
      if (stay && wrapA === "TOP_AND_BOTTOM" && linePushedBy(o, anchorLineV ?? baseV, pTop ?? (depth > 0 ? cellParaTop(p, ctx.styles.paraGeom) : undefined))) stay = false
      // 앵커 줄이 다음 쪽 첫 줄로 넘어간 문단의 위아래 개체는 앞 쪽, 그 줄이 앞 쪽에 이어졌을 자리(앞 줄 끝 + 줄 간격)에 남는다
      // (한컴 PDF: 인라인 표 줄 64153 뒤 둘째 줄(저장 vertpos 0, 다음 쪽)에 앵커한 글상자가 앞 쪽 표 줄 아래 — 다음 쪽 줄 자리를 앞 쪽에 쓰면 쪽 맨 위)
      let carried: number | undefined
      if (segPages && anchorK > 0 && segPages[anchorK] !== segPages[0] && segPages[anchorK - 1] === segPages[0] && wrapA === "TOP_AND_BOTTOM" &&
        (findChildByLocalName(o.el, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA") {
        const s0 = plans[anchorK - 1].seg
        carried = s0.vertpos + s0.textheight + (s0.spacing ?? 0)
      }
      const firstLine = anchorLineV === undefined || anchorLineV === baseV
      let { x, y } = anchorObject(o, ax, oy, objBaseV, aw, ctx, anchorLineV, stay ? sbA : false, (firstLine || wrapA === "SQUARE") && pTop !== undefined && pTop < baseV ? pTop : undefined, anchorLineH, firstLine ? sbA : 0,
        // 문단 중간 글자 앵커인데 첫 줄부터 앵커 줄만큼 좁게 저장됐으면 개체는 문단 위에 있다(같은 판 한컴 PDF: 둘째 줄 앵커 사진, 네 줄 모두 34602)
        m.chars.slice(o.index).some(c => c.ch.trim() !== "") && !!anchorSeg && plans.length > 0 && plans[0].seg !== anchorSeg &&
          Math.abs(plans[0].seg.horzsize - anchorSeg.horzsize) <= 100 && anchorSeg.horzpos + anchorSeg.horzsize < aw - 1000 ? "top" : m.chars.slice(o.index).some(c => c.ch.trim() !== "") ? "mid" : "end")
      if (carried !== undefined) {
        const posC = findChildByLocalName(o.el, "pos"), rawC = num(posC, "vertOffset")
        y = oy + carried + num(findChildByLocalName(o.el, "outMargin"), "top") + Math.max(0, rawC >= 2 ** 31 ? rawC - 2 ** 32 : rawC)
      }
      // 같은 문단의 위아래 배치 개체 둘 이상은 문단 영역 위부터 겹치지 않고 차례로 쌓인다 — reflow 와 같은 규칙
      // (한컴 PDF: 보도자료 머리 표 셋 3481·2797·12846 이 쪽 위부터 차례로, 첫 줄 20822 는 그 아래)
      // 칸 안 문단도 같다 — 문단 위는 칸 안 앞 문단 끝(같은 판 한컴 PDF: 칸 첫 문단의 vertOffset 2072·6986·17070 표 셋이 칸 위부터 그 자리에)
      let stackTop = depth === 0 ? pTop ?? 0 : cellParaTop(p, ctx.styles.paraGeom)
      if (tbFloats >= 2 && wrapA === "TOP_AND_BOTTOM" && stackTop !== undefined) {
        if (!tbStack) {
          // 문서 순서(앵커 글자 순)로 쌓는다 — 개체 목록은 그리는 순서일 수 있다. 겹침 허용(allowOverlap=1) 개체는 쌓지 않는다
          // (한컴 PDF: 겹침 허용 글상자 둘은 같은 자리에 겹친다)
          tbStack = new Map()
          // 가로로 겹치는 앞 개체 아래로만 쌓는다 — 옆에 나란한 개체(가로 오프셋 24181, 세로 −1630)는 제 오프셋 자리
          const placed: { x0: number; x1: number; bottom: number }[] = []
          const stackable = m.objs.filter(q => !q.inline && (q.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM") === "TOP_AND_BOTTOM" && (findChildByLocalName(q.el, "pos")?.getAttribute("vertRelTo") ?? "PARA") === "PARA" && findChildByLocalName(q.el, "pos")?.getAttribute("allowOverlap") !== "1")
          for (const q of stackable.length >= 2 ? stackable.sort((a, b) => a.index - b.index) : []) {
            const posQ = findChildByLocalName(q.el, "pos"), omQ = findChildByLocalName(q.el, "outMargin"), raw = num(posQ, "vertOffset")
            const x0 = num(posQ, "horzOffset"), x1 = x0 + num(omQ, "left") + q.width + num(omQ, "right")
            const below = Math.max(0, ...placed.filter(r => r.x0 < x1 && x0 < r.x1).map(r => r.bottom))
            // 칸 안에선 위로 올린 오프셋이 문단 위에서 멈춘다(anchorObject 와 같다)
            const top = Math.max(below, depth > 0 ? Math.max(0, raw) : raw)
            tbStack.set(q.el, top + num(omQ, "top"))
            placed.push({ x0, x1, bottom: top + num(omQ, "top") + (q.tag === "tbl" ? Math.max(q.height, measureTableHeight(q.el, ctx.extentMemo)) : q.height) + num(omQ, "bottom") })
          }
          // 칸 안: 줄이 쌓은 개체 아래로 밀려 저장됐으면 문단 위 = 줄 − 쌓은 높이 — 앞 문단의 떠 있는 표가 칸 안 앞 문단 끝보다 아래로 뻗었다
          // (같은 판 PDF: 앞 문단 끝 1600, 줄 4532 − 쌓은 1700 = 2832 에 두 표)
          if (depth > 0 && placed.length) tbStackTop = Math.max(stackTop, baseV - Math.max(...placed.map(r => r.bottom)))
        }
        if (depth > 0 && tbStackTop !== undefined) stackTop = tbStackTop
        const st = tbStack.get(o.el)
        if (st !== undefined) y = oy + stackTop + st
      }
      const moved = ctx.objPlace?.get(o.el)
      if (moved) {
        const pg = ctx.page
        ctx.page = moved.page
        drawObject(o, x, moved.y, baseV, areaW, ctx, depth)
        ctx.page = pg
      } else drawObject(o, x, y, baseV, areaW, ctx, depth)
    }
  }
  if (paraRegionId) ctx.parentStack.pop()
}

/** hp:pos 기준계 해석 → 개체 좌상단 절대좌표 (tac=0) */
/** 칸 안 문단의 영역 위 — 앞 문단 끝 줄(vertpos + 높이 + 간격) + 앞 문단 아래 간격, 첫 문단은 0. 앞 문단 줄이 없으면 모른다.
 *  글을 밀지 않는 개체가 첫 줄을 덮어 줄이 개체 아래로 저장된 칸 문단도 개체는 문단 위 기준이다(한컴 PDF: 칸 안 글 뒤 앵커 그림 −80 이 칸 위에, 글 줄 2551 은 그 아래) */
export function cellParaTop(p: Element, geom: RenderStyles["paraGeom"]): number | undefined {
  let prev = p.previousSibling as Element | null
  while (prev && ln(prev) !== "p") prev = prev.previousSibling as Element | null
  if (!prev) return 0
  const lsa = findChildByLocalName(prev, "linesegarray")
  const segs = lsa ? elements(lsa).filter(e => ln(e) === "lineseg") : []
  if (!segs.length) return undefined
  const last = segs[segs.length - 1]
  return num(last, "vertpos") + num(last, "vertsize") + num(last, "spacing") + (geom.get(prev.getAttribute("paraPrIDRef") ?? "")?.spaceAfter ?? 0)
}


function drawObject(o: ParaObj, x: number, y: number, baseV: number, areaW: number, ctx: Ctx, depth: number): void {
  if (!o.inline && depth === 0 && ctx.paintJobs) {
    const wrap = o.el.getAttribute("textWrap")
    const layer = wrap === "BEHIND_TEXT" ? -1 : wrap === "IN_FRONT_OF_TEXT" ? 1 : 0
    const page = ctx.page, parents = [...ctx.parentStack], esc = ctx.escOrigin
    ctx.paintJobs.push({ page, layer, z: num(o.el, "zOrder"), body: !!ctx.bodyDx, draw: () => {
      ctx.page = page
      const saved = ctx.parentStack
      ctx.parentStack = parents
      ctx.escOrigin = esc
      drawObject(o, x, y, baseV, areaW, ctx, depth)
      ctx.parentStack = saved
    } })
    return
  }
  // 캡션 — 위 캡션은 개체를 캡션 높이 + 간격만큼 내리고, 아래 캡션은 개체 바닥 + 간격에, 왼쪽·오른쪽은 옆에 그린다
  const cap = o.tag === "tbl" || o.tag === "pic" ? captionOf(o.el) : null
  if (cap) {
    const objH = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, ctx.extentMemo)) : o.height
    let ox = x, oy = y, cx = x, cy = y
    if (cap.side === "TOP") oy = y + cap.h + cap.gap
    else if (cap.side === "LEFT") ox = x + cap.width + cap.gap
    else if (cap.side === "RIGHT") cx = x + o.width + cap.gap
    else cy = y + objH + cap.gap
    for (const cp of elements(cap.sub)) if (ln(cp) === "p") drawPara(cp, cx, cy, cap.width, ctx, depth + 1)
    x = ox; y = oy
  }
  if (o.tag === "tbl") ctx.draw.table(o.el, x, y, ctx, depth + 1)
  else if (o.tag === "pic") ctx.draw.pic(o.el, x, y, ctx)
  else if (o.tag === "container") {
    if (drawGroupByMatrix(o, x, y, baseV, areaW, ctx, depth)) return
    // 그리기개체 묶음(행렬 없음 — HWP5 장면) — 자식 개체를 컨테이너 원점 기준으로 재귀 배치
    for (const ch of elements(o.el)) {
      const tag = ln(ch)
      if (!OBJ_TAGS.has(tag)) continue
      const sz = findChildByLocalName(ch, "sz")
      const off = findChildByLocalName(ch, "offset")
      const sub: ParaObj = { el: ch, tag, index: 0, inline: true, width: num(sz, "width"), height: num(sz, "height"), omL: 0, omR: 0 }
      drawObject(sub, x + num(off, "x"), y + num(off, "y"), baseV, areaW, ctx, depth + 1)
    }
  } else if (o.tag === "equation") {
    // 수식 — 수식 조판 대신 스크립트를 한 줄 유니코드 글(a/b·√·첨자)로 상자 폭에 맞춰 그린다. 기준선 = 상자 위 + 높이 × baseLine%
    const script = findChildByLocalName(o.el, "script")?.textContent ?? ""
    const latex = script ? hwpEquationToLatex(script) : ""
    const text = latex ? latexToPlain(latex) : ""
    const frac = text && o.width > 0 && o.height > 0 ? layoutFractions(latex) : null
    if (frac) {
      // 분수가 든 수식 — 분자·가로선·분모로 쌓아 상자에 맞춘다(배율은 폭·높이 가운데 작은 쪽, 기준선은 상자의 baseLine)
      const bl = Number(o.el.getAttribute("baseLine")), size = num(o.el, "baseUnit", 1000)
      const k = Math.min(o.width / (frac.w * size), o.height / ((frac.a + frac.d) * size)), em = size * Math.max(0.5, Math.min(1.5, k))
      const by = y + Math.round(o.height * (Number.isFinite(bl) && bl > 0 ? bl / 100 : frac.a / (frac.a + frac.d)))
      const x0 = x + Math.max(0, (o.width - frac.w * em) / 2)
      const color = o.el.getAttribute("textColor"), fill = color && color !== "#000000" ? escapeXml(color) : null
      for (const op of frac.ops) {
        const ox = x0 + op.x * em, oy = by - op.y * em
        if (op.rule) emit(ctx, `<line x1="${pt(ox)}" y1="${pt(oy)}" x2="${pt(ox + op.rule * em)}" y2="${pt(oy)}" stroke="${fill ?? "#000"}" stroke-width="${pt(em * 0.05)}"/>`)
        else if (op.text) {
          emit(ctx, `<text x="${pt(ox)}" y="${pt(oy)}" font-size="${pt(em)}" font-family="'Times New Roman','HCR Batang','Noto Serif KR',serif"${fill ? ` fill="${fill}"` : ""}>${escapeXml(op.text)}</text>`)
          ctx.stats.texts++
        }
      }
    } else if (text && o.width > 0) {
      const bl = Number(o.el.getAttribute("baseLine")), size = num(o.el, "baseUnit", 1000)
      const by = y + Math.round(o.height * (Number.isFinite(bl) && bl > 0 ? bl / 100 : 0.85))
      const color = o.el.getAttribute("textColor")
      const attrs = [`x="${pt(x)}"`, `y="${pt(by)}"`, `font-size="${pt(size)}"`, `font-family="'Times New Roman','HCR Batang','Noto Serif KR',serif"`]
      if ([...text].length > 1) attrs.push(`textLength="${pt(o.width)}"`, `lengthAdjust="spacingAndGlyphs"`)
      if (color && color !== "#000000") attrs.push(`fill="${escapeXml(color)}"`)
      emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(text)}</text>`)
      ctx.stats.texts++
    }
  } else if (SHAPE_TAGS.has(o.tag)) {
    drawShape(o, x, y, ctx, depth)
  } else if (!FORM_TAGS.has(o.tag)) {
    // 양식 컨트롤(체크 상자 등)은 줄에서 자리만 차지하고 그리지 않는다(종전과 같이)
    warnOnce(ctx, `shape:${o.tag}`, `개체(${o.tag}) 렌더 미지원 — 생략`)
  }
}

/**
 * 묶음(hp:container) — 안쪽 개체마다 renderingInfo 행렬로 원본 좌표를 최상위 묶음 상자에 놓는다(배율·회전·중첩 묶음 한 번에).
 * 최상위 묶음 자기 행렬이 그리는 상자를 묶음 자리(x, y)에 맞춘다. 종전엔 offset 만 더해 배율 묶음(지도·도식)의 그림이 작게,
 * 곡선·도형이 엉뚱한 자리에 크게 그려졌다(#116). 행렬 없는 묶음(HWP5 장면)은 false — 종전 offset 경로
 */
function drawGroupByMatrix(o: ParaObj, x: number, y: number, baseV: number, areaW: number, ctx: Ctx, depth: number): boolean {
  const top = renderingMatrix(o.el)
  const leaves: Element[] = []
  const collect = (el: Element): boolean => {
    for (const ch of elements(el)) {
      const tag = ln(ch)
      if (!OBJ_TAGS.has(tag)) continue
      if (tag === "container") { if (!collect(ch)) return false }
      else if (renderingMatrix(ch)) leaves.push(ch)
      else return false
    }
    return true
  }
  if (!top || !collect(o.el)) return false
  const org = findChildByLocalName(o.el, "orgSz")
  const box = rotatedBounds({ x: 0, y: 0, w: num(org, "width"), h: num(org, "height") }, [top])
  const base: Affine = [1, 0, 0, 1, x - box.x, y - box.y]
  for (const leaf of leaves) {
    const m = mulAffine(base, renderingMatrix(leaf)!)
    const tag = ln(leaf), lorg = findChildByLocalName(leaf, "orgSz")
    const w = num(lorg, "width") || num(findChildByLocalName(leaf, "curSz"), "width")
    const h = num(lorg, "height") || num(findChildByLocalName(leaf, "curSz"), "height")
    ctx.regionRotations.push(m)
    emit(ctx, `<g transform="matrix(${m.slice(0, 4).map(v => Math.round(v * 1e6) / 1e6).join(" ")} ${pt(m[4])} ${pt(m[5])})">`)
    const sub: ParaObj = { el: leaf, tag, index: 0, inline: true, width: w, height: h, omL: 0, omR: 0 }
    if (tag === "pic") ctx.draw.picFrame(leaf, 0, 0, w, h, "", ctx)
    else if (SHAPE_TAGS.has(tag)) drawShape(sub, 0, 0, ctx, depth + 1, [Math.hypot(m[0], m[1]) || 1, Math.hypot(m[2], m[3]) || 1])
    else drawObject(sub, 0, 0, baseV, areaW, ctx, depth + 1)
    emit(ctx, "</g>")
    ctx.regionRotations.pop()
  }
  return true
}

// ─── 그리기 도형 ───────────────────────────────────
/** groupScale — 묶음 행렬 안에서 원본 좌표로 그릴 때 그 행렬의 가로·세로 배율. 글상자 글은 배율을 되돌려 그린다(아래) */
function drawShape(o: ParaObj, x: number, y: number, ctx: Ctx, depth: number, groupScale?: [number, number]): void {
  const geometry = shapeGeometry(o, x, y, ctx.defs, ctx.images, (key, msg) => warnOnce(ctx, key, msg), !!groupScale)
  // Transform original corners through every ancestor and this shape's rotation
  // before bounding once. An intermediate axis-aligned box inflates nested crops.
  const b = geometry
  if (geometry.rotation) ctx.regionRotations.push(geometry.rotation)
  ctx.stats.shapes++
  const shapeId = ctx.regions.add("shape", bboxOf(ctx, b.x, b.y, b.w, b.h), { parentId: parentId(ctx) })
  emit(ctx, regionOpenTag(shapeId, "shape", pageNo(ctx)))
  ctx.parentStack.push(shapeId)
  if (geometry.transform) emit(ctx, `<g transform="${geometry.transform}">`)
  emit(ctx, geometry.svg)
  const dt = findChildByLocalName(o.el, "drawText")
  const sub = dt ? findChildByLocalName(dt, "subList") : null
  // 글은 틀 자리(돌린 도형은 외접 상자 안으로 옮긴 틀, objectGeometry)에서. 묶음 안 도형은 글 줄 배치(lineseg)가 이미 배율 뒤
  // 단위라 행렬의 배율만 되돌린다 — 글자는 늘어나지 않고 회전만 따른다 (한컴: 묶음 크기를 바꿔도 글자 크기는 그대로)
  if (sub) {
    const [sx, sy] = groupScale ?? [1, 1]
    const unscale = sx !== 1 || sy !== 1
    if (unscale) { emit(ctx, `<g transform="scale(${1 / sx} ${1 / sy})">`); ctx.regionRotations.push([1 / sx, 0, 0, 1 / sy, 0, 0]) }
    // 글상자 안 여백(drawText textMargin) — 글은 틀 안쪽 여백만큼 들어간 자리에서(한컴 PDF: 여백 283 글상자의 로고 표 x = 틀 + 2.83pt)
    const tm = dt ? findChildByLocalName(dt, "textMargin") : null
    const mL = num(tm, "left"), mR = num(tm, "right"), mT = num(tm, "top"), mB = num(tm, "bottom")
    // 글상자 세로 정렬(subList vertAlign) — 칸과 같이 안쪽 높이에서 내용 높이를 뺀 나머지의 절반(가운데)·전부(아래)만큼 내린다
    // (한컴 PDF: 안쪽 6804 에 내용 5860 인 가운데 정렬 글상자의 글이 4.7pt 아래)
    const va = sub.getAttribute("vertAlign") ?? "TOP"
    let yoff = 0
    // 떠 있는 개체가 든 글상자는 내용 높이를 잴 근거가 없어 맞추지 않는다(한컴 PDF: 떠 있는 안쪽 글상자를 품은 가운데 글상자가 제자리)
    const floats = elements(sub).some(q => ln(q) === "p" && buildPara(q).objs.some(ob => !ob.inline))
    if (!floats && (va === "CENTER" || va === "BOTTOM")) {
      const extent = cellContentExtent({ el: dt!, ca: 0, ra: 0, cs: 1, rs: 1, w: 0, h: 0, bfId: null, sub, marginL: 0, marginR: 0, marginT: 0, marginB: 0 }, ctx.extentMemo)
      const free = geometry.h * sy - mT - mB - extent
      yoff = Math.max(0, va === "CENTER" ? free / 2 : free)
    }
    // 안 여백·세로 정렬 몫은 묶음 배율을 받지 않는다 — 배율을 되돌린 좌표에 그대로 더한다
    // (한컴 PDF: 세로 3.68배로 늘린 묶음 글상자의 글이 안 위 여백 283 만큼만 아래, 배율을 곱하면 7.8pt 더 내려갔다)
    for (const p of elements(sub)) if (ln(p) === "p") drawPara(p, geometry.x * sx + mL, geometry.y * sy + mT + yoff, geometry.w * sx - mL - mR, ctx, depth + 1)
    if (unscale) { ctx.regionRotations.pop(); emit(ctx, "</g>") }
  }
  if (geometry.rotation) ctx.regionRotations.pop()
  if (geometry.transform) emit(ctx, "</g>")
  ctx.parentStack.pop()
  emit(ctx, "</g>")
}
