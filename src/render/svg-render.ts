/**
 * 레이아웃 보존 렌더 — HWPX 조판 캐시(lineseg·cellAddr·hp:pos)를 SVG 절대배치로 그린다.
 *
 * 조판 엔진 없음: 한컴이 저장 시 기록한 좌표를 그대로 사용한다. 따라서
 * 한컴(또는 조판 캐시를 기록하는 편집기)에서 저장한 파일만 렌더 가능 —
 * markdownToHwpx 산출물엔 linesegarray가 없어 KordocError를 던진다.
 *
 * 좌표 산식(실측 검증 — .claude/plans/render-poc/findings.md):
 * - 단위 HWPUNIT(1/7200in), pt = /100. 최상위 문단 lineseg = 본문영역 로컬,
 *   셀 문단 = 셀 로컬. PARA 밀어내기 개체 anchor = 호스트vp − (omTop+h+omBottom) 역산.
 * - horzsize는 줄 "영역" 폭(텍스트 폭 아님) — 마지막 줄이 아닌 줄은 원본 줄바꿈에
 *   맞춰 textLength로 고정하고, 마지막 줄만 paraPr 정렬(LEFT 자연폭/CENTER/RIGHT/배분)을 적용.
 * - 좌표 속성엔 uint32로 저장된 음수가 섞여 있다(toInt32 필수).
 * - 표 열은 span 제약 경계 전파로, 행은 rs=1 max + 콘텐츠 초과 성장으로 푼다.
 *
 * 페이지: 최상위 lineseg vertpos는 페이지 로컬(페이지마다 0부터 리셋)이므로 역행
 *   지점을 페이지 경계로 감지, 전 페이지를 세로 스택으로 그린다(페이지별 흰 배경 +
 *   클립). 페이지에 걸친 표는 시작 페이지에서 잘린다(조판 캐시에 분할점이 없음).
 *
 * 범위: section0 한정(다중 구역은 첫 구역만), 수식·그리기개체 도형은 미지원(경고 수집).
 */

import JSZip from "jszip"
import { KordocError, precheckZipSize } from "../utils.js"
import { createXmlParser, findChildByLocalName, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES } from "../hwpx/parser-shared.js"
import { toInt32, solveBoundaries, solveRowHeights, type SpanConstraint } from "./layout.js"
import { measureTextWidth, type WrapMode } from "../hwpx/text-metrics.js"
import { parseRenderStyles, DEFAULT_CHAR, type RenderStyles, type RenderBorderEdge } from "./head-styles.js"
import { reflowSection } from "./reflow.js"

export interface RenderSvgOptions {
  /** 이미지 1장당 허용 최대 바이트 (기본 40MB) */
  maxImageBytes?: number
  /** 검색어 형광펜 — 텍스트 조각 내 매치 구간에 배경 rect (대소문자 무시).
   *  charPr(스타일) 경계에 걸친 매치는 칠하지 못한다. */
  highlights?: string[]
  /** Tier-2 reflow — 조판 캐시(linesegarray) 없는 파일도 순수 TS 조판으로 렌더.
   *  캐시가 있으면 무시(한컴본은 캐시 재생). 기본 false(캐시 없으면 KordocError). */
  reflow?: boolean
  /** reflow 줄바꿈 폴백 모드 — 'keep'(어절) / 'charAll'(글자). 문단 paraPr에
   *  breakSetting 선언이 있으면 그 값이 우선하며(BREAK_WORD=어절, KEEP_WORD=글자 —
   *  이름 역전 주의), 이 옵션은 선언 없는 문단에만 적용된다. */
  reflowMode?: WrapMode
}

export interface RenderSvgResult {
  svg: string
  /** 페이지 폭 (pt) */
  width: number
  /** 전체 캔버스 높이 (pt) — 페이지 세로 스택 + 간격 */
  height: number
  /** 렌더된 페이지 수 */
  pageCount: number
  warnings: string[]
  stats: { texts: number; images: number; tables: number }
}

// ─── XML 헬퍼 ─────────────────────────────────────

function ln(el: Element): string {
  return (el.tagName || "").replace(/^[^:]+:/, "")
}

function elements(el: Element): Element[] {
  const out: Element[] = []
  const children = el.childNodes
  if (!children) return out
  for (let i = 0; i < children.length; i++) {
    if (children[i].nodeType === 1) out.push(children[i] as Element)
  }
  return out
}

function num(el: Element | null, attr: string, fallback = 0): number {
  return el ? toInt32(el.getAttribute(attr) ?? undefined, fallback) : fallback
}

function findFirst(el: Element, name: string, depth = 0): Element | null {
  if (depth > 64) return null
  for (const ch of elements(el)) {
    if (ln(ch) === name) return ch
    const found = findFirst(ch, name, depth + 1)
    if (found) return found
  }
  return null
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

// ─── 내부 모델 ────────────────────────────────────

interface PageGeom { PW: number; PH: number; ML: number; MT: number; BODY_W: number; BODY_H: number }

export interface Seg { textpos: number; vertpos: number; horzpos: number; horzsize: number; textheight: number; baseline: number }

export interface ParaChar { ch: string; prId: string | null }

/** 렌더 대상 개체 태그 — 이 외(도형류)는 경고 후 생략 */
const OBJ_TAGS = new Set(["tbl", "pic", "container", "equation", "rect", "ellipse", "polygon", "curv", "line", "arc", "ole", "textart"])

interface ParaObj { el: Element; tag: string; index: number; inline: boolean; width: number; height: number }

export interface ParaModel { chars: ParaChar[]; segs: Seg[]; objs: ParaObj[]; paraPrId: string | null }

interface Ctx {
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
  warnings: string[]
  warned: Set<string>
  stats: { texts: number; images: number; tables: number }
  /** 셀/표 측정 메모 — 중첩표 지수 재계산 캡 (렌더 1회 공유) */
  extentMemo: ExtentMemo
}

const pt = (u: number): string => String(Math.round(u) / 100)

function emit(ctx: Ctx, s: string): void {
  ctx.pages[ctx.page].push(s)
}

function warnOnce(ctx: Ctx, key: string, msg: string): void {
  if (ctx.warned.has(key)) return
  ctx.warned.add(key)
  ctx.warnings.push(msg)
}

// ─── 문단 모델 구축 ────────────────────────────────

/** hp:t 안에서 1슬롯을 차지하는 문자형 컨트롤 (HWP5 문자 스트림 모델) —
 * 탭(0x09)은 char가 아니라 inline 컨트롤 = 8슬롯(16바이트)이라 여기 넣으면 안 된다
 * (record.ts 0x09 처리의 i+=14와 같은 모델. 1슬롯로 세면 탭당 7슬롯씩 줄 경계가 밀린다) */
const CHAR_CTRL_1SLOT = new Set(["lineBreak", "hyphen", "nbSpace", "fwSpace"])

/** lineseg textpos 정합용 0폭 필러 슬롯 — 컨트롤이 차지하는 문자 위치를 채운다 */
function pushFillers(chars: ParaChar[], n: number, prId: string | null): void {
  for (let i = 0; i < n; i++) chars.push({ ch: "", prId })
}

/**
 * hp:t 내용을 슬롯 스트림으로 변환 — lineseg textpos 는 HWP5 문자 스트림 기준이라
 * 텍스트 1문자=1슬롯(서로게이트 쌍은 2), tab 등 문자형 컨트롤도 1슬롯을 차지한다.
 * markpen 등 래퍼 요소는 슬롯 없이 내용만 재귀한다.
 * (탭 폭은 탭스톱 미해석으로 0 — 경계 정합이 우선, 폭 오차는 줄 스케일이 흡수)
 */
function pushTextSlots(t: Element, chars: ParaChar[], prId: string | null, depth: number): void {
  if (depth > 32) return
  const kids = t.childNodes
  if (!kids) return
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i]
    if (c.nodeType === 3) {
      for (const cp of c.textContent ?? "") {
        chars.push({ ch: cp, prId })
        if (cp.length === 2) chars.push({ ch: "", prId }) // UTF-16 두 번째 유닛 슬롯
      }
    } else if (c.nodeType === 1) {
      const el = c as Element
      const tag = ln(el)
      if (tag === "tab") {
        pushFillers(chars, 8, prId) // inline 컨트롤 8슬롯 (전부 폭 0 — 탭스톱 미해석)
      } else if (CHAR_CTRL_1SLOT.has(tag)) {
        chars.push({ ch: tag === "nbSpace" || tag === "fwSpace" ? " " : "", prId })
      } else {
        pushTextSlots(el, chars, prId, depth + 1)
      }
    }
  }
}

export function buildPara(p: Element): ParaModel {
  const chars: ParaChar[] = []
  const objs: ParaObj[] = []
  let segs: Seg[] = []
  for (const runEl of elements(p)) {
    const tag = ln(runEl)
    if (tag === "run") {
      const prId = runEl.getAttribute("charPrIDRef")
      for (const ch of elements(runEl)) {
        const cn = ln(ch)
        if (cn === "t") {
          pushTextSlots(ch, chars, prId, 0)
        } else if (OBJ_TAGS.has(cn)) {
          const sz = findChildByLocalName(ch, "sz")
          const pos = findChildByLocalName(ch, "pos")
          // 그리기 도형은 hp:sz가 없다 — curSz(>0) → orgSz 폴백
          const w = num(sz, "width") || num(findChildByLocalName(ch, "curSz"), "width") || num(findChildByLocalName(ch, "orgSz"), "width")
          const h = num(sz, "height") || num(findChildByLocalName(ch, "curSz"), "height") || num(findChildByLocalName(ch, "orgSz"), "height")
          objs.push({
            el: ch, tag: cn, index: chars.length,
            inline: pos?.getAttribute("treatAsChar") === "1",
            width: w, height: h,
          })
          // 확장 컨트롤(GSO 등)은 문자 스트림에서 8슬롯 — 실측: 데모 코퍼스 1,132개
          // 멀티라인 문단에서 textpos 가 8슬롯 블록 중간에 걸린 경계 0건
          pushFillers(chars, 8, prId)
        } else {
          // secPr·ctrl(구역/단 정의)·필드 등 나머지 run 자식도 확장/인라인 컨트롤 8슬롯
          pushFillers(chars, 8, prId)
        }
      }
    } else if (tag === "linesegarray") {
      segs = elements(runEl).filter(s => ln(s) === "lineseg").map(s => ({
        textpos: num(s, "textpos"), vertpos: num(s, "vertpos"), horzpos: num(s, "horzpos"),
        horzsize: num(s, "horzsize"), textheight: num(s, "textheight", 1000), baseline: num(s, "baseline", 850),
      }))
    }
  }
  return { chars, segs, objs, paraPrId: p.getAttribute("paraPrIDRef") }
}

// ─── 줄 렌더 (run별 charPr + 정렬) ──────────────────

interface LinePlan {
  seg: Seg
  /** 줄 시작 x 보정 (정렬) */
  xoff: number
  /** 텍스트 조각 폭 스케일 */
  scale: number
  start: number
  end: number
}

function charW(c: ParaChar, styles: RenderStyles): number {
  const st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
  return measureTextWidth(c.ch, st.height, st.ratio, { spacingPct: st.spacing })
}

/** 줄 자연폭 = 텍스트 조각 + 인라인 개체 폭 (개체 폭은 스케일 불변) */
function lineNaturalWidth(m: ParaModel, styles: RenderStyles, start: number, end: number): { text: number; obj: number } {
  let text = 0
  for (let i = start; i < end && i < m.chars.length; i++) text += charW(m.chars[i], styles)
  let obj = 0
  for (const o of m.objs) if (o.inline && o.index >= start && o.index < end) obj += o.width
  return { text, obj }
}

function planLines(m: ParaModel, styles: RenderStyles): LinePlan[] {
  const align = (m.paraPrId != null ? styles.paraAlign.get(m.paraPrId) : undefined) ?? "JUSTIFY"
  const plans: LinePlan[] = []
  for (let i = 0; i < m.segs.length; i++) {
    const seg = m.segs[i]
    const start = seg.textpos
    const end = i + 1 < m.segs.length ? m.segs[i + 1].textpos : Math.max(m.chars.length, start)
    const nat = lineNaturalWidth(m, styles, start, end)
    const isLast = i === m.segs.length - 1
    let xoff = 0
    let scale = 1
    const avail = seg.horzsize - nat.obj
    if (nat.text > 0 && (!isLast || align === "DISTRIBUTE" || align === "DISTRIBUTE_SPACE")) {
      // 줄바꿈이 고정된 중간 줄·배분정렬 — 줄 영역 폭에 맞춰 고정 (원본 조판 재현)
      scale = avail > 0 ? avail / nat.text : 1
    } else if (nat.text + nat.obj > 0 && isLast) {
      const w = nat.text + nat.obj
      if (align === "CENTER") xoff = Math.max(0, (seg.horzsize - w) / 2)
      else if (align === "RIGHT") xoff = Math.max(0, seg.horzsize - w)
    }
    if (!Number.isFinite(scale) || scale <= 0) scale = 1
    scale = Math.min(4, Math.max(0.25, scale))
    plans.push({ seg, xoff, scale, start, end })
  }
  return plans
}

/** 줄 안 [start, upto) 구간의 전진폭 (텍스트×스케일 + 인라인 개체) */
function advanceTo(m: ParaModel, styles: RenderStyles, plan: LinePlan, upto: number): number {
  let x = 0
  for (let i = plan.start; i < upto && i < m.chars.length; i++) x += charW(m.chars[i], styles) * plan.scale
  for (const o of m.objs) if (o.inline && o.index >= plan.start && o.index < upto) x += o.width
  return x
}

// ─── 문단 드로잉 ───────────────────────────────────

/**
 * @param segPages 최상위 문단 전용 — seg 인덱스별 페이지 배정 (vertpos 리셋 감지 결과).
 *   셀/중첩 콘텐츠는 전달하지 않아 호스트의 ctx.page 를 상속한다.
 */
function drawPara(p: Element, ox: number, oy: number, areaW: number, ctx: Ctx, depth: number, segPages?: number[]): void {
  if (depth > 16) { warnOnce(ctx, "depth", "중첩 깊이 16 초과 — 이하 생략"); return }
  const m = buildPara(p)
  if (m.segs.length === 0) {
    // 조판 캐시 없는 문단 — 개체만이라도 문단 원점에 배치. 텍스트는 무음 생략 금지
    if (m.chars.some(c => c.ch !== "")) {
      warnOnce(ctx, "no-lineseg", "조판 캐시 없는 문단 텍스트 생략 — reflow 옵션으로 합성 가능")
    }
    for (const o of m.objs) drawObject(o, ox, oy, 0, areaW, ctx, depth)
    return
  }
  const plans = planLines(m, ctx.styles)
  const baseV = m.segs[0].vertpos

  for (let li = 0; li < plans.length; li++) {
    const plan = plans[li]
    if (segPages && segPages[li] !== undefined) ctx.page = segPages[li]
    const { seg } = plan
    // charPr 단위 조각으로 분할
    let i = plan.start
    let cursor = ox + seg.horzpos + plan.xoff
    const y = oy + seg.vertpos + seg.baseline
    while (i < plan.end && i < m.chars.length) {
      // 필러 슬롯(컨트롤·서로게이트 자리)은 그리지 않고 건너뛴다 —
      // 인라인 개체의 폭 전진은 개체 첫 슬롯에서 1회 수행
      if (m.chars[i].ch === "") {
        for (const o of m.objs) if (o.inline && o.index === i) cursor += o.width
        i++
        continue
      }
      const prId = m.chars[i].prId
      let j = i
      let piece = ""
      // 필러에서 멈추므로 piece 안은 실문자뿐 — 개체 경계 절단이 자연 발생
      while (j < plan.end && j < m.chars.length && m.chars[j].prId === prId && m.chars[j].ch !== "") { piece += m.chars[j].ch; j++ }
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
      const renderSeg = (text: string, cx: number, hit: boolean): number => {
        const sw = measureTextWidth(text, st.height, st.ratio, { spacingPct: st.spacing }) * plan.scale
        if (hit) {
          emit(ctx, `<rect x="${pt(cx)}" y="${pt(oy + seg.vertpos)}" width="${pt(sw)}" height="${pt(seg.textheight)}" fill="#ffd54f" fill-opacity="0.45"/>`)
        }
        if (text.trim().length > 0) {
          const attrs: string[] = [`x="${pt(cx)}"`, `y="${pt(y)}"`, `font-size="${pt(st.height)}"`]
          if (st.fontFamily) attrs.push(`font-family="${escapeXml(st.fontFamily)}"`)
          if ([...text].length > 1 && sw > 50) {
            attrs.push(`textLength="${pt(sw)}"`, `lengthAdjust="${plan.scale < 1 ? "spacingAndGlyphs" : "spacing"}"`)
          }
          if (st.bold) attrs.push(`font-weight="bold"`)
          if (st.italic) attrs.push(`font-style="italic"`)
          if (st.underline) attrs.push(`text-decoration="underline"`)
          if (st.color) attrs.push(`fill="${escapeXml(st.color)}"`)
          emit(ctx, `<text ${attrs.join(" ")}>${escapeXml(text)}</text>`)
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

  // 개체 배치 — 인라인은 소속 줄 위치, 앵커는 hp:pos 해석
  for (const o of m.objs) {
    if (o.inline) {
      let planIdx = 0
      for (let k = 0; k < plans.length; k++) {
        const pl = plans[k]
        if (pl.start <= o.index && (o.index < pl.end || k === plans.length - 1)) planIdx = k
      }
      const plan = plans[planIdx]
      if (segPages && segPages[planIdx] !== undefined) ctx.page = segPages[planIdx]
      const x = ox + plan.seg.horzpos + plan.xoff + advanceTo(m, ctx.styles, plan, o.index)
      // 개체가 줄보다 낮으면 baseline 위에 얹고, 줄을 채우는 개체(th==h)는 줄 상단
      const yTop = oy + plan.seg.vertpos + Math.max(0, plan.seg.baseline - o.height)
      drawObject(o, x, yTop, baseV, areaW, ctx, depth)
    } else {
      // 앵커 좌표는 첫 seg(baseV) 기준이므로 첫 seg 의 페이지에 귀속
      if (segPages && segPages[0] !== undefined) ctx.page = segPages[0]
      const { x, y } = anchorObject(o, ox, oy, baseV, areaW, ctx)
      drawObject(o, x, y, baseV, areaW, ctx, depth)
    }
  }
}

/** hp:pos 기준계 해석 → 개체 좌상단 절대좌표 (tac=0) */
function anchorObject(o: ParaObj, ox: number, oy: number, baseV: number, areaW: number, ctx: Ctx): { x: number; y: number } {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = ctx.geom
  const pos = findChildByLocalName(o.el, "pos")
  const om = findChildByLocalName(o.el, "outMargin")
  const omT = num(om, "top"), omB = num(om, "bottom")
  const w = o.width, h = o.height
  if (!pos) return { x: ox, y: oy + baseV }
  const vo = num(pos, "vertOffset")
  const ho = num(pos, "horzOffset")
  const vrel = pos.getAttribute("vertRelTo") ?? "PARA"
  const hrel = pos.getAttribute("horzRelTo") ?? "PARA"
  const va = pos.getAttribute("vertAlign") ?? "TOP"
  const ha = pos.getAttribute("horzAlign") ?? "LEFT"
  const wrap = o.el.getAttribute("textWrap") ?? "TOP_AND_BOTTOM"

  let y: number
  if (vrel === "PAPER") {
    y = va === "BOTTOM" ? PH - h - vo : va === "CENTER" ? (PH - h) / 2 + vo : vo
  } else if (vrel === "PAGE") {
    y = va === "BOTTOM" ? MT + BODY_H - h - vo : va === "CENTER" ? MT + (BODY_H - h) / 2 + vo : MT + vo
  } else if (wrap === "TOP_AND_BOTTOM") {
    // PARA 밀어내기 역산 — 호스트 문단 vp가 개체(여백 포함)만큼 밀렸다는 모델 (실측 일치).
    // 음수면 밀지 않은 개체(빈 호스트 줄 등)로 보고 현재 흐름 y 사용.
    const pushed = baseV - (omT + h + omB)
    const anchor = pushed >= -100 ? pushed : baseV
    y = oy + anchor + omT + vo
  } else {
    // BEHIND_TEXT/IN_FRONT/SQUARE — 문단을 밀지 않는 개체는 문단 원점 흐름 배치
    y = oy + baseV + vo
  }

  let x: number
  if (hrel === "PAGE") {
    x = ha === "RIGHT" ? ML + BODY_W - w - ho : ha === "CENTER" ? ML + (BODY_W - w) / 2 + ho : ML + ho
  } else if (hrel === "PAPER") {
    x = ha === "RIGHT" ? PW - w - ho : ha === "CENTER" ? (PW - w) / 2 + ho : ho
  } else {
    // PARA/COLUMN — 현재 텍스트 영역 기준 (셀 안이면 셀 내부 폭. COLUMN을 페이지
    // 단으로 읽으면 셀 안 개체가 페이지 왼쪽으로 튄다 — 사진대지 우측 셀 실측)
    x = ha === "RIGHT" ? ox + areaW - w - ho : ha === "CENTER" ? ox + (areaW - w) / 2 + ho : ox + ho
  }
  return { x, y }
}

function drawObject(o: ParaObj, x: number, y: number, baseV: number, areaW: number, ctx: Ctx, depth: number): void {
  if (o.tag === "tbl") drawTable(o.el, x, y, ctx, depth + 1)
  else if (o.tag === "pic") drawPic(o.el, x, y, ctx)
  else if (o.tag === "container") {
    // 그리기개체 묶음 — 자식 개체를 컨테이너 원점 기준으로 재귀 배치
    for (const ch of elements(o.el)) {
      const tag = ln(ch)
      if (!OBJ_TAGS.has(tag)) continue
      const sz = findChildByLocalName(ch, "sz")
      const off = findChildByLocalName(ch, "offset")
      const sub: ParaObj = { el: ch, tag, index: 0, inline: true, width: num(sz, "width"), height: num(sz, "height") }
      drawObject(sub, x + num(off, "x"), y + num(off, "y"), baseV, areaW, ctx, depth + 1)
    }
  } else if (o.tag === "equation") {
    warnOnce(ctx, "equation", "수식 개체는 렌더 미지원 — 생략")
  } else if (SHAPE_TAGS.has(o.tag)) {
    drawShape(o, x, y, ctx, depth)
  } else {
    warnOnce(ctx, `shape:${o.tag}`, `개체(${o.tag}) 렌더 미지원 — 생략`)
  }
}

// ─── 그리기 도형 (rect/ellipse/line/polygon/curv/arc) ────────────────
// geometry 좌표는 개체 로컬(orgSz 기준). 실제 크기 = curSz(있으면)로 스케일.
// lineShape=선(color/width/style), fillBrush>winBrush=채움(faceColor). 회전은 근사 생략.

const SHAPE_TAGS = new Set(["rect", "ellipse", "line", "polygon", "curv", "arc"])

/** lineShape width(1/100 mm) → pt */
function shapeStrokePt(v: number): number {
  return Math.max(0.2, (v / 100) * 2.834645)
}

function drawShape(o: ParaObj, x: number, y: number, ctx: Ctx, depth: number): void {
  const el = o.el
  const orgSz = findChildByLocalName(el, "orgSz")
  const curSz = findChildByLocalName(el, "curSz")
  const ow = num(orgSz, "width"), oh = num(orgSz, "height")
  const w = num(curSz, "width") || ow || o.width
  const h = num(curSz, "height") || oh || o.height
  const sx = ow > 0 ? w / ow : 1
  const sy = oh > 0 ? h / oh : 1

  const lineShape = findChildByLocalName(el, "lineShape")
  const lstyle = lineShape?.getAttribute("style") ?? "SOLID"
  const strokeCol = lineShape?.getAttribute("color") || "#000000"
  const hasStroke = lstyle !== "NONE"
  const strokeW = hasStroke ? shapeStrokePt(lineShape ? num(lineShape, "width") : 33) : 0
  const dash = /DASH|DOT/.test(lstyle) ? ` stroke-dasharray="${lstyle.includes("DOT") ? "1,1.5" : "3,1.5"}"` : ""
  const strokeAttr = hasStroke ? ` stroke="${escapeXml(strokeCol)}" stroke-width="${strokeW.toFixed(2)}"${dash}` : ""

  const fillBrush = findChildByLocalName(el, "fillBrush")
  const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null
  const face = winBrush?.getAttribute("faceColor")
  const fill = face && face.toLowerCase() !== "none" ? face : "none"
  const fillAttr = ` fill="${fill === "none" ? "none" : escapeXml(fill)}"`

  if (o.tag === "rect") {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"${fillAttr}${strokeAttr}/>`)
  } else if (o.tag === "ellipse") {
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}"${fillAttr}${strokeAttr}/>`)
  } else if (o.tag === "line") {
    const s = findChildByLocalName(el, "startPt"), e = findChildByLocalName(el, "endPt")
    const x1 = x + num(s, "x") * sx, y1 = y + num(s, "y") * sy
    const x2 = x + num(e, "x") * sx, y2 = y + num(e, "y") * sy
    emit(ctx, `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml(strokeCol)}" stroke-width="${(strokeW || 0.3).toFixed(2)}"${dash}/>`)
  } else if (o.tag === "polygon" || o.tag === "curv") {
    const pts: string[] = []
    for (const c of elements(el)) if (ln(c) === "pt") pts.push(`${pt(x + num(c, "x") * sx)},${pt(y + num(c, "y") * sy)}`)
    if (pts.length >= 2) emit(ctx, `<polygon points="${pts.join(" ")}"${fillAttr}${strokeAttr}/>`)
  } else if (o.tag === "arc") {
    // 호는 외접 박스 타원으로 근사 (start/sweep 각 미해석)
    emit(ctx, `<ellipse cx="${pt(x + w / 2)}" cy="${pt(y + h / 2)}" rx="${pt(w / 2)}" ry="${pt(h / 2)}" fill="none"${strokeAttr || ` stroke="${escapeXml(strokeCol)}" stroke-width="0.3"`}/>`)
  }

  // 도형 안 텍스트(drawText>subList) — 조판 캐시 있으면 그린다
  const dt = findChildByLocalName(el, "drawText")
  const sub = dt ? findChildByLocalName(dt, "subList") : null
  if (sub) {
    for (const p of elements(sub)) if (ln(p) === "p") drawPara(p, x, y, w, ctx, depth + 1)
  }
}

// ─── 표 ───────────────────────────────────────────

interface CellModel {
  el: Element
  ca: number; ra: number; cs: number; rs: number
  w: number; h: number
  bfId: string | null
  sub: Element | null
  marginL: number; marginR: number; marginT: number; marginB: number
}

/**
 * 셀/표 측정 메모 — drawTable(rowH·yoff)과 cellContentExtent↔measureTableHeight 상호재귀가
 * 중첩 단계마다 하위 표를 재측정해 지수적으로 불어나는 것을 캡. 렌더 1회 안에서만 공유
 * (reflow의 DOM 변형은 드로잉 시작 전에 끝나므로 캐시가 stale해지지 않는다).
 */
export interface ExtentMemo { cell: WeakMap<Element, number>; table: WeakMap<Element, number> }

/** 셀 콘텐츠 세로 범위 — 줄(vp+th) + 인라인 개체(중첩표·treatAsChar) + PARA 앵커 개체(anchor+h) 최대값 */
function cellContentExtent(cell: CellModel, memo?: ExtentMemo): number {
  if (!cell.sub) return 0
  const hit = memo?.cell.get(cell.el)
  if (hit !== undefined) return hit
  let ext = 0
  for (const p of elements(cell.sub)) {
    if (ln(p) !== "p") continue
    const m = buildPara(p)
    for (const s of m.segs) ext = Math.max(ext, s.vertpos + s.textheight)
    const baseV = m.segs[0]?.vertpos ?? 0
    for (const o of m.objs) {
      if (o.inline) {
        // 인라인 개체(중첩 표·treatAsChar 이미지)는 줄 위치에서 개체 높이만큼 아래로 뻗는다.
        // 이를 빼먹으면 중첩 표를 담은 셀 높이가 과소측정돼 표지 중첩표가 겹친다(리뷰: 셀 성장 누락).
        const h = o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el, memo)) : o.height
        ext = Math.max(ext, baseV + h)
        continue
      }
      const pos = findChildByLocalName(o.el, "pos")
      if ((pos?.getAttribute("vertRelTo") ?? "PARA") !== "PARA") continue
      const om = findChildByLocalName(o.el, "outMargin")
      const pushed = baseV - (num(om, "top") + o.height + num(om, "bottom"))
      const anchor = pushed >= -100 ? pushed : baseV
      ext = Math.max(ext, anchor + num(om, "top") + num(pos, "vertOffset") + o.height)
    }
  }
  memo?.cell.set(cell.el, ext)
  return ext
}

function edgeLine(x1: number, y1: number, x2: number, y2: number, e: RenderBorderEdge): string {
  const dash = /DASH|DOT/.test(e.type) ? ` stroke-dasharray="${e.type.includes("DOT") ? "1,1.5" : "3,1.5"}"` : ""
  return `<line x1="${pt(x1)}" y1="${pt(y1)}" x2="${pt(x2)}" y2="${pt(y2)}" stroke="${escapeXml(e.color)}" stroke-width="${e.widthPt.toFixed(2)}"${dash}/>`
}

/** tbl의 셀 모델 수집 — drawTable과 measureTableHeight가 같은 셀 해석을 공유 */
function collectCells(tbl: Element): CellModel[] {
  const inMargin = findChildByLocalName(tbl, "inMargin")
  const defL = num(inMargin, "left", 141), defR = num(inMargin, "right", 141)
  const defT = num(inMargin, "top", 141), defB = num(inMargin, "bottom", 141)

  const cells: CellModel[] = []
  for (const tr of elements(tbl)) {
    if (ln(tr) !== "tr") continue
    for (const tc of elements(tr)) {
      if (ln(tc) !== "tc") continue
      const addr = findChildByLocalName(tc, "cellAddr")
      const span = findChildByLocalName(tc, "cellSpan")
      const csz = findChildByLocalName(tc, "cellSz")
      const cm = findChildByLocalName(tc, "cellMargin")
      if (!addr || !csz) continue
      cells.push({
        el: tc,
        // 음수 주소(uint32 역변환·손상 입력) 방어 — colX/rowY 인덱스 이탈로 NaN 좌표 방지
        ca: Math.max(0, num(addr, "colAddr")), ra: Math.max(0, num(addr, "rowAddr")),
        cs: Math.max(1, num(span, "colSpan", 1)), rs: Math.max(1, num(span, "rowSpan", 1)),
        w: num(csz, "width"), h: num(csz, "height"),
        bfId: tc.getAttribute("borderFillIDRef"),
        sub: findChildByLocalName(tc, "subList"),
        marginL: cm ? num(cm, "left", defL) : defL, marginR: cm ? num(cm, "right", defR) : defR,
        marginT: cm ? num(cm, "top", defT) : defT, marginB: cm ? num(cm, "bottom", defB) : defB,
      })
    }
  }
  return cells
}

/**
 * 표 실효 높이(HWPUNIT) — drawTable의 rowH 모델(solveRowHeights + 셀 콘텐츠 성장) 그대로.
 * 선언 hp:sz는 셀 콘텐츠로 자란 높이를 모르므로, reflow가 표 뒤 문단을 실제 그려질
 * 표 바닥 아래로 배치할 때 이 값을 쓴다. 셀 lineseg가 있어야 성장분이 측정된다.
 */
export function measureTableHeight(tbl: Element, memo?: ExtentMemo): number {
  const hit = memo?.table.get(tbl)
  if (hit !== undefined) return hit
  const cells = collectCells(tbl)
  if (cells.length === 0 || cells.length > 4096) return 0
  const nRows = Math.max(...cells.map(c => c.ra + c.rs))
  const rowH = solveRowHeights(
    cells.map(c => ({ rowAddr: c.ra, rowSpan: c.rs, height: c.h, contentH: c.rs === 1 ? cellContentExtent(c, memo) : undefined })),
    nRows,
  )
  let sum = 0
  for (const h of rowH) sum += h
  memo?.table.set(tbl, sum)
  return sum
}

function drawTable(tbl: Element, tx: number, ty: number, ctx: Ctx, depth: number): void {
  if (depth > 16) { warnOnce(ctx, "depth", "중첩 깊이 16 초과 — 이하 생략"); return }
  ctx.stats.tables++
  const tblSz = findChildByLocalName(tbl, "sz")
  const cells = collectCells(tbl)
  if (cells.length === 0 || cells.length > 4096) return

  const nCols = Math.max(...cells.map(c => c.ca + c.cs))
  const nRows = Math.max(...cells.map(c => c.ra + c.rs))
  const colCons: SpanConstraint[] = cells.map(c => ({ a: c.ca, b: c.ca + c.cs, size: c.w }))
  const colX = solveBoundaries(colCons, nCols, num(tblSz, "width") || undefined)
  const rowH = solveRowHeights(
    cells.map(c => ({ rowAddr: c.ra, rowSpan: c.rs, height: c.h, contentH: c.rs === 1 ? cellContentExtent(c, ctx.extentMemo) : undefined })),
    nRows,
  )
  const rowY: number[] = [0]
  for (let r = 0; r < nRows; r++) rowY.push(rowY[r] + rowH[r])

  // 1패스: 배경 → 2패스: 콘텐츠 → 3패스: 테두리 (테두리가 배경/콘텐츠 위)
  const geom = cells.map(c => ({
    c,
    x: tx + colX[c.ca], y: ty + rowY[c.ra],
    w: colX[Math.min(c.ca + c.cs, nCols)] - colX[c.ca],
    h: rowY[Math.min(c.ra + c.rs, nRows)] - rowY[c.ra],
  }))
  for (const g of geom) {
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : undefined
    if (bf?.fill) emit(ctx, `<rect x="${pt(g.x)}" y="${pt(g.y)}" width="${pt(g.w)}" height="${pt(g.h)}" fill="${escapeXml(bf.fill)}"/>`)
  }
  for (const g of geom) {
    const { c } = g
    if (!c.sub) continue
    const innerH = g.h - c.marginT - c.marginB
    const extent = cellContentExtent(c, ctx.extentMemo)
    const va = c.sub.getAttribute("vertAlign") ?? "TOP"
    let yoff = 0
    if (va === "CENTER") yoff = Math.max(0, (innerH - extent) / 2)
    else if (va === "BOTTOM") yoff = Math.max(0, innerH - extent)
    for (const p of elements(c.sub)) {
      if (ln(p) !== "p") continue
      drawPara(p, g.x + c.marginL, g.y + c.marginT + yoff, g.w - c.marginL - c.marginR, ctx, depth + 1)
    }
  }
  for (const g of geom) {
    const bf = g.c.bfId != null ? ctx.styles.borderFill.get(g.c.bfId) : undefined
    if (!bf) continue
    if (bf.top) emit(ctx, edgeLine(g.x, g.y, g.x + g.w, g.y, bf.top))
    if (bf.bottom) emit(ctx, edgeLine(g.x, g.y + g.h, g.x + g.w, g.y + g.h, bf.bottom))
    if (bf.left) emit(ctx, edgeLine(g.x, g.y, g.x, g.y + g.h, bf.left))
    if (bf.right) emit(ctx, edgeLine(g.x + g.w, g.y, g.x + g.w, g.y + g.h, bf.right))
  }
}

// ─── 이미지 ───────────────────────────────────────

/**
 * 이미지 심볼 등록(바이너리당 1회) — dataURI를 defs에 한 번만 넣고 <use>로 참조한다.
 * occurrence마다 dataURI를 재emit하면 반복 참조 문서에서 SVG 문자열이 기하급수로
 * 커져 RangeError/OOM (소형 입력 DoS). viewBox 100×100 + preserveAspectRatio none
 * 이라 <use width/height>가 기존 <image width/height> stretch와 동일하게 스케일된다.
 */
function imageSymbol(loaded: { dataUri: string; symId?: string }, ctx: Ctx): string {
  if (!loaded.symId) {
    loaded.symId = `bin${ctx.defs.length}`
    ctx.defs.push(
      `<symbol id="${loaded.symId}" viewBox="0 0 100 100" preserveAspectRatio="none">` +
      `<image width="100" height="100" preserveAspectRatio="none" href="${loaded.dataUri}"/></symbol>`,
    )
  }
  return loaded.symId
}

function drawPic(pic: Element, x: number, y: number, ctx: Ctx): void {
  const sz = findChildByLocalName(pic, "sz")
  const w = num(sz, "width", 5669), h = num(sz, "height", 5669)
  const img = findFirst(pic, "img")
  const ref = img?.getAttribute("binaryItemIDRef")
  const loaded = ref != null ? ctx.images.get(ref) : undefined
  if (!loaded) {
    emit(ctx, `<rect x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" fill="#eee" stroke="#c00" stroke-width="0.5"/>`)
    warnOnce(ctx, `img:${ref}`, `이미지 바이너리 누락: ${ref ?? "(ref 없음)"}`)
    return
  }
  ctx.stats.images++
  // imgClip 좌표계는 imgDim(이미지 내용 상자) 기준이다 — orgSz(최초 삽입 크기)가 아니다.
  // 실측(데모 코퍼스 pic 267개): clip==dim 254개(크롭 없음)·실제 크롭 8개 모두 dim 기준.
  // orgSz 로 비교하면 리사이즈된 로고(dim<org)가 좌상단 코너로 잘못 잘려 로고가 깨진다.
  const clip = findChildByLocalName(pic, "imgClip")
  const imgDim = findChildByLocalName(pic, "imgDim")
  const orgSz = findChildByLocalName(pic, "orgSz")
  const dimW = num(imgDim, "dimwidth"), dimH = num(imgDim, "dimheight")
  // 참조(전체 내용) 공간: imgDim 우선, 없으면 orgSz 폴백
  const refW = dimW > 0 ? dimW : num(orgSz, "width")
  const refH = dimH > 0 ? dimH : num(orgSz, "height")
  const cl = num(clip, "left"), ct = num(clip, "top")
  const cr = num(clip, "right", refW), cb = num(clip, "bottom", refH)
  const cropped =
    refW > 0 && refH > 0 && clip != null && (cl > 0 || ct > 0 || cr < refW || cb < refH) && cr > cl && cb > ct
  const symId = imageSymbol(loaded, ctx)
  if (cropped) {
    // 참조 좌표계 viewBox로 크롭 창을 내고, 이미지는 전체 내용 크기로 깐다
    emit(ctx,
      `<svg x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}" viewBox="${pt(cl)} ${pt(ct)} ${pt(cr - cl)} ${pt(cb - ct)}" preserveAspectRatio="none">` +
      `<use href="#${symId}" x="0" y="0" width="${pt(refW)}" height="${pt(refH)}"/></svg>`,
    )
  } else {
    emit(ctx, `<use href="#${symId}" x="${pt(x)}" y="${pt(y)}" width="${pt(w)}" height="${pt(h)}"/>`)
  }
}

function sniffMime(name: string, bytes: Uint8Array): string {
  const lower = name.toLowerCase()
  if (lower.endsWith(".png") || (bytes.length > 4 && bytes[0] === 0x89 && bytes[1] === 0x50)) return "image/png"
  if (lower.endsWith(".bmp") || (bytes.length > 2 && bytes[0] === 0x42 && bytes[1] === 0x4d)) return "image/bmp"
  if (lower.endsWith(".gif") || (bytes.length > 3 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)) return "image/gif"
  if (lower.endsWith(".svg")) return "image/svg+xml"
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  return "image/jpeg"
}

// ─── 엔트리 ───────────────────────────────────────

/** 구역 하나의 페이지 지오메트리 (HWPUNIT) */
function readSectionGeom(root: Element): PageGeom {
  const pagePr = findFirst(root, "pagePr")
  const margin = pagePr ? findChildByLocalName(pagePr, "margin") : null
  let PW = num(pagePr, "width", 59528), PH = num(pagePr, "height", 84188)
  // 용지 방향 — width/height는 용지 원방향(세로) 치수로 저장되고 landscape="NARROWLY"가
  // 가로(90° 회전)를 뜻한다(WIDELY=세로). 무시하면 가로 문서의 오른쪽이 잘린다
  // (실측: 가로 A4 문서 lineseg 줄폭 78520 = 84188 − 좌우마진, 세로폭 59528 초과).
  if (pagePr?.getAttribute("landscape") === "NARROWLY" && PW < PH) {
    const t = PW; PW = PH; PH = t
  }
  const ML = num(margin, "left", 8504)
  const MT = num(margin, "top", 5668) + num(margin, "header", 0)
  const BODY_H = PH - MT - num(margin, "bottom", 4252) - num(margin, "footer", 0)
  const BODY_W = PW - ML - num(margin, "right", 8504)
  return { PW, PH, ML, MT, BODY_W, BODY_H }
}

/** 렌더된 구역 — 페이지 버퍼 + 페이지 크기(구역별 pagePr 상이 가능) */
interface RenderedSection { pages: string[][]; PW: number; pageH: number; clipId: string }

/**
 * 구역 하나를 렌더 → 페이지 버퍼. 공유 자원(styles/images/defs/warnings/stats)은 ctx로 넘겨
 * 이미지 심볼·통계·경고가 전 구역에 누적되게 한다(dataURI 중복·페이지 카운트 정합).
 */
function renderSectionToPages(
  root: Element,
  geom: PageGeom,
  ctxBase: Omit<Ctx, "pages" | "page" | "geom">,
  doReflow: boolean,
  reflowMode: WrapMode,
): { pages: string[][]; pageH: number } {
  const { PW, PH, ML, MT, BODY_W, BODY_H } = geom
  // Tier-2 reflow — 캐시 없는 문단에 linesegarray 합성 주입. 혼합 캐시 문서(한컴
  // 저장본을 프로그램 편집해 일부 문단만 캐시 없음)도 reflow 옵션이면 진입한다 —
  // 전량 캐시 문서는 전 문단 skip(Tier-1 무회귀)이라 no-op.
  if (doReflow) reflowSection(root, ctxBase.styles, { BODY_W, BODY_H }, reflowMode)

  // 페이지 분할 프리패스 — 최상위 lineseg vertpos는 페이지 로컬(페이지마다 0부터)이라
  // 역행 지점이 곧 페이지 경계다. 다단(colCount>1)은 단 이동도 vertpos가 리셋되지만
  // horzpos가 오른쪽으로 점프하므로, horzpos가 왼쪽으로 돌아올 때만 새 페이지로 본다.
  // vertpos "동일"도 문단 첫 seg + horzpos 비전진이면 경계다 — 페이지 전체가 표 하나인
  // 문단이 연속되면 vertpos가 매 페이지 0으로 같아서 strict 역행만으론 못 가른다
  // (의사일정표류: v0 문단 연속 → 뒤 페이지들이 전부 한 페이지에 겹침).
  // 문단 내부의 vertpos 동일 seg는 개체 좌우로 갈라진 같은 줄(h 우측 점프)이라 제외.
  const colPr = findFirst(root, "colPr")
  const multiCol = num(colPr, "colCount", 1) > 1
  const paraSegPages = new Map<Element, number[]>()
  let nPages = 1
  let maxTopV = 0
  {
    let prevV = Number.NEGATIVE_INFINITY
    let prevH = Number.NEGATIVE_INFINITY
    let cur = 0
    for (const p of elements(root)) {
      if (ln(p) !== "p") continue
      const lsa = findChildByLocalName(p, "linesegarray")
      const segEls = lsa ? elements(lsa).filter(s => ln(s) === "lineseg") : []
      const pagesOf: number[] = []
      let paraFirst = true
      for (const s of segEls) {
        const v = num(s, "vertpos")
        const h = num(s, "horzpos")
        const brk = v < prevV
          ? (!multiCol || h <= prevH)
          : (paraFirst && v === prevV && h <= prevH)
        if (brk) cur++
        paraFirst = false
        pagesOf.push(cur)
        maxTopV = Math.max(maxTopV, v + num(s, "textheight", 1000))
        prevV = v
        prevH = h
      }
      paraSegPages.set(p, pagesOf)
      nPages = Math.max(nPages, cur + 1)
    }
  }

  const ctx: Ctx = {
    ...ctxBase,
    pages: Array.from({ length: nPages }, () => []),
    page: 0,
    geom,
  }
  for (const p of elements(root)) {
    if (ln(p) !== "p") continue
    drawPara(p, ML, MT, BODY_W, ctx, 0, paraSegPages.get(p))
  }

  // 리셋이 없는데 본문이 페이지를 넘는 파일(누적 vertpos 기록본) 방어 —
  // 한 페이지로 두되 캔버스만 내용 끝까지 늘려 잘림을 막는다.
  const pageH = nPages === 1 ? Math.max(PH, MT + maxTopV + 2000) : PH
  return { pages: ctx.pages, pageH }
}

/**
 * HWPX(한컴 저장본) → 레이아웃 보존 SVG. **전 구역(section*)을 세로 스택으로** 렌더한다.
 * 조판 캐시(linesegarray)가 없는 구역은 reflow 옵션으로 합성 조판(없으면 그 구역 생략);
 * 렌더 가능한 구역이 하나도 없으면 KordocError.
 */
export async function renderHwpxToSvg(input: ArrayBuffer | Uint8Array, options?: RenderSvgOptions): Promise<RenderSvgResult> {
  const maxImg = options?.maxImageBytes ?? 40 * 1024 * 1024
  // 압축폭탄 가드 — 파서 진입점과 동일하게 압축해제 전 central directory 선언 크기를 검사한다.
  // 렌더 이미지 캡은 f.async 로 엔트리를 전량 압축해제한 뒤에야 크기를 보므로, 단일 BinData
  // 압축폭탄(수 GB 선언)이 캡을 우회해 OOM 을 유발하던 것을 원천 차단한다 (reflow-1).
  const ab = input instanceof Uint8Array
    ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer
    : input
  precheckZipSize(ab, MAX_DECOMPRESS_SIZE, MAX_ZIP_ENTRIES)
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(input)
  } catch {
    throw new KordocError("HWPX(ZIP) 형식이 아닙니다 — 렌더는 HWPX만 지원")
  }
  // 모든 구역 파일 (section0, section1, … — 이름 정렬)
  const secFiles = zip.file(/Contents\/section\d+\.xml$/i).sort((a, b) => a.name.localeCompare(b.name))
  if (secFiles.length === 0) throw new KordocError("Contents/section0.xml 없음 — HWPX가 아니거나 손상됨")

  const warnings: string[] = []
  const headFile = zip.file("Contents/header.xml") ?? zip.file("Contents/head.xml")
  const styles: RenderStyles = headFile
    ? parseRenderStyles(await headFile.async("string"))
    : { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map() }
  if (!headFile) warnings.push("header.xml 없음 — 기본 스타일로 렌더")

  // 구역 XML 선로딩 + 크기 가드
  const secXmls: string[] = []
  for (const f of secFiles) {
    const xml = await f.async("string")
    if (xml.length > MAX_DECOMPRESS_SIZE) throw new KordocError("섹션 XML이 허용 크기를 초과")
    secXmls.push(xml)
  }

  // BinData 매니페스트 (id → href) — content.hpf 우선, 파일명 휴리스틱 폴백
  const binmap = new Map<string, string>()
  const hpf = zip.file(/content\.hpf$/i)[0]
  if (hpf) {
    const man = await hpf.async("string")
    for (const m of man.matchAll(/<[^>]*\bid="([^"]+)"[^>]*\bhref="(BinData\/[^"]+)"[^>]*>/g)) binmap.set(m[1], m[2])
    for (const m of man.matchAll(/<[^>]*\bhref="(BinData\/[^"]+)"[^>]*\bid="([^"]+)"[^>]*>/g)) binmap.set(m[2], m[1])
  }
  // 참조된 이미지만 선로딩 — 전 구역 ref 합집합 (DOM 워크 전에 async 구간 종료).
  // 장당 캡(maxImg) 외에 개수·누적 바이트 캡 — distinct 다수/대형 반복 참조로
  // 렌더 경로에서만 OOM 가능하던 구멍(파서 경로의 ZIP bomb 가드에 상응)
  const MAX_IMAGE_REFS = 256
  const MAX_TOTAL_IMAGE_BYTES = 128 * 1024 * 1024
  const images: Ctx["images"] = new Map()
  const refs = new Set<string>()
  for (const xml of secXmls) for (const m of xml.matchAll(/binaryItemIDRef="([^"]+)"/g)) refs.add(m[1])
  let totalImgBytes = 0
  for (const ref of refs) {
    if (images.size >= MAX_IMAGE_REFS) {
      warnings.push(`이미지 ${refs.size}종 중 ${MAX_IMAGE_REFS}종만 로딩 — 개수 한도 초과분 생략`)
      break
    }
    let href = binmap.get(ref)
    if (!href) {
      const cand = zip.file(new RegExp(`BinData/.*${ref.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i"))[0]
      href = cand?.name
    }
    if (!href) continue
    const f = zip.file(href) ?? zip.file("Contents/" + href)
    if (!f) continue
    const bytes = await f.async("uint8array")
    if (bytes.length > maxImg) {
      warnings.push(`이미지 ${href} ${(bytes.length / 1048576).toFixed(1)}MB — 한도 초과로 생략`)
      continue
    }
    if (totalImgBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
      warnings.push(`이미지 누적 ${Math.round(MAX_TOTAL_IMAGE_BYTES / 1048576)}MB 한도 초과 — 이후 생략`)
      break
    }
    totalImgBytes += bytes.length
    images.set(ref, { dataUri: `data:${sniffMime(href, bytes)};base64,${Buffer.from(bytes).toString("base64")}` })
  }

  // 전 구역 공유 컨텍스트 자원 (이미지 심볼 defs·통계·경고를 누적)
  const ctxBase: Omit<Ctx, "pages" | "page" | "geom"> = {
    styles, images, defs: [],
    highlights: (options?.highlights ?? []).map(s => s.trim().toLowerCase()).filter(s => s.length > 0),
    warnings, warned: new Set(), stats: { texts: 0, images: 0, tables: 0 },
    extentMemo: { cell: new WeakMap(), table: new WeakMap() },
  }

  // 구역별 렌더
  const rendered: RenderedSection[] = []
  let noCacheSkipped = false
  for (let si = 0; si < secXmls.length; si++) {
    const secXml = secXmls[si]
    // 태그 마크업만 매치 — 본문 텍스트에 "linesegarray"가 있어도 캐시로 오판하지 않는다
    // (본문의 <는 XML에서 &lt;로 이스케이프되므로 리터럴 <…linesegarray는 태그뿐)
    const hasCache = /<(?:[A-Za-z][\w.-]*:)?linesegarray[\s/>]/.test(secXml)
    if (!hasCache && !options?.reflow) {
      noCacheSkipped = true
      warnings.push(`구역 ${si}: 조판 캐시 없음 — reflow 옵션 필요, 생략`)
      continue
    }
    const doc = createXmlParser().parseFromString(secXml, "text/xml")
    const root = doc.documentElement as unknown as Element
    if (!root) { warnings.push(`구역 ${si} XML 파싱 실패 — 생략`); continue }
    const geom = readSectionGeom(root)
    const { pages, pageH } = renderSectionToPages(root, geom, ctxBase, !!options?.reflow, options?.reflowMode ?? "keep")
    rendered.push({ pages, PW: geom.PW, pageH, clipId: `pgclip${si}` })
  }

  if (rendered.length === 0) {
    if (noCacheSkipped) {
      throw new KordocError("조판 캐시(linesegarray) 없음 — 한컴에서 저장한 HWPX만 렌더 가능 (reflow 옵션으로 합성 렌더 가능)")
    }
    throw new KordocError("렌더할 구역이 없습니다 — HWPX가 손상되었을 수 있습니다")
  }

  // 전 구역 페이지를 세로 스택으로 조립 (구역마다 page 크기 상이 가능 → 구역별 clip)
  const GAP = 2400 // 페이지 사이 시각 간격 (24pt)
  const clipDefs: string[] = []
  const groups: string[] = []
  let y = 0
  let maxPW = 0
  let pageNo = 0
  for (const rs of rendered) {
    maxPW = Math.max(maxPW, rs.PW)
    clipDefs.push(`<clipPath id="${rs.clipId}"><rect x="0" y="0" width="${pt(rs.PW)}" height="${pt(rs.pageH)}"/></clipPath>`)
    for (const buf of rs.pages) {
      pageNo++
      groups.push(
        `<g data-page="${pageNo}" transform="translate(0 ${pt(y)})">` +
        `<rect width="${pt(rs.PW)}" height="${pt(rs.pageH)}" fill="white" stroke="#c9c7c4" stroke-width="0.75"/>` +
        `<g clip-path="url(#${rs.clipId})">\n${buf.join("\n")}\n</g></g>`,
      )
      y += rs.pageH + GAP
    }
  }
  const totalH = Math.max(0, y - GAP)

  // width/height는 pt 단위 명시 — 단위 없는 px로 두면 A4 실물(96dpi 기준)보다 25% 작게 보인다 (v3.10.1)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${pt(maxPW)} ${pt(totalH)}" width="${pt(maxPW)}pt" height="${pt(totalH)}pt" font-family="'HCR Batang','함초롬바탕','Hancom Batang',AppleMyungjo,'Noto Serif CJK KR',serif" xml:space="preserve">\n` +
    `<defs>${clipDefs.join("")}${ctxBase.defs.join("")}</defs>\n` +
    `${groups.join("\n")}\n</svg>`
  return { svg, width: Math.round(maxPW) / 100, height: Math.round(totalH) / 100, pageCount: pageNo, warnings, stats: ctxBase.stats }
}
