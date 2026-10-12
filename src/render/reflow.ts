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

import { buildPara, measureTableHeight, tabAdvance, captionExtra, OBJ_TAGS, type ParaObj } from "./para-model.js"
import { nextParaNumber, type NumberCounters } from "./para-number.js"
import { simulateWrap, hancomCharWidth, faceClassForReflow, mulDiv, type WrapMode } from "../hwpx/text-metrics.js"
import { DEFAULT_CHAR, DEFAULT_PARA_GEOM, type RenderCharStyle, type RenderStyles, type RenderParaGeom } from "./head-styles.js"
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

/** 조합형 자모 — 첫소리(L)·가운뎃소리(V)·끝소리(T) */
const isJamoL = (cp: number): boolean => (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0xa960 && cp <= 0xa97c)
const isJamoV = (cp: number): boolean => (cp >= 0x1160 && cp <= 0x11a7) || (cp >= 0xd7b0 && cp <= 0xd7c6)
const isJamoT = (cp: number): boolean => (cp >= 0x11a8 && cp <= 0x11ff) || (cp >= 0xd7cb && cp <= 0xd7fb)
const isJamoLV = (cp: number): boolean => isJamoL(cp) || isJamoV(cp)
const isJamoVT = (cp: number): boolean => isJamoV(cp) || isJamoT(cp)

/** 한컴 언어 분류 '영문'(U+0250 미만·U+1E00~1FFF·‘’“” 등 U+2018~201F) — 그 글자는 영문 글꼴·장평·자간·상대크기로 잰다 */
const isLatinCp = (cp: number): boolean => cp < 0x250 || (cp >= 0x1e00 && cp < 0x2000) || (cp >= 0x2018 && cp < 0x2020)

/**
 * 한컴 조판의 글자 폭과 그 중 자간 몫(HWPUNIT). 글자는 제 언어(한글/영문)의 글꼴·장평·상대크기로, 첨자는 크기 16/25 로 잰다.
 * 공백은 한글 크기·장평으로 재고 자간만 영문 값을 쓴다(한컴 조판 엔진과 같은 규칙)
 */
function glyphWidth(ch: string, st: RenderCharStyle): { w: number; sp: number } {
  const cp = ch.codePointAt(0)!
  const space = cp === 0x20 || cp === 0xa0
  const L = !space && st.latin && isLatinCp(cp) ? st.latin : undefined
  const rel = space ? st.rel ?? 100 : L ? L.rel : st.rel ?? 100
  let h = rel !== 100 ? mulDiv(st.height, rel, 100) : st.height
  if (!space && st.script) h = mulDiv(h, 16, 25)
  const ratio = L ? L.ratio : st.ratio
  const spacing = space ? st.latin?.spacing ?? st.spacing : L ? L.spacing : st.spacing
  const fc = faceClassForReflow(L?.face ?? st.face)
  const base = hancomCharWidth(ch, h, ratio, 0, fc)
  const w = spacing ? hancomCharWidth(ch, h, ratio, spacing, fc) : base
  return { w, sp: w - base }
}

/** 어울림(SQUARE·TIGHT·THROUGH) 개체가 글 흐름에서 차지하는 영역 — 그 흐름(본문·칸) 좌표 */
interface WrapZone { top: number; bottom: number; left: number; right: number; flow: string }

/** 줄 pitch(다음 줄 vertpos 증분, HWPUNIT) — lineSpacing type별 */
function pitchFor(height: number, geom: RenderParaGeom): number {
  const v = geom.lineSpacingValue
  switch (geom.lineSpacingType) {
    // 줄 간격 몫(spacing)을 4 HWPUNIT 단위로, 0에서 먼 쪽으로 반올림한다 — 한컴 저장 lineseg 9만 줄 실측:
    // 1400 × 155% → spacing 770 아닌 772, 1500 × 90% → −150 아닌 −152. 100% 미만이면 spacing 은 음수다
    case "PERCENT": { const e = (height * (v - 100)) / 400; return height + 4 * Math.sign(e) * Math.floor(Math.abs(e) + 0.5) }
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
  zones: WrapZone[] = [],
  nums: NumberCounters = new Map(),
  /** 본문 흐름인가 — 표 칸 등 하위 목록에서는 떠 있는 위아래 배치 개체가 글을 밀지 않는다 */
  bodyFlow = true,
): { paraBottom: number; spaceAfter: number } | null {
  const m = buildPara(p)
  const geom = styles.paraGeom.get(m.paraPrId ?? "") ?? DEFAULT_PARA_GEOM
  // 문단 번호는 조판 캐시가 있는 문단도 센다(뒤 문단 번호가 밀리지 않게)
  const numText = nextParaNumber(nums, geom)
  if (m.segs.length > 0) return null // 이미 캐시 있음 — Tier-1 무회귀

  // 실텍스트 + UTF-16 유닛 → chars 슬롯 인덱스 매핑 (서로게이트 쌍은 슬롯 1개, 유닛 2개).
  // 폭은 글자마다 제 charPr(글꼴·크기·장평·자간)로 — 부호 run 과 압축된 내용 run 이 섞인 문단도 한컴과 같게.
  // 탭은 "\t" 한 글자로 넣고 폭 = 탭 전진폭(첫 줄 기준 — 항목부호 뒤 내어쓰기용 자동 탭).
  // 묶음 빈칸은 U+00A0 — 공백 폭이지만 줄을 끊지 않는다("2026. 9. 23."·"3억 원")
  const realIdx: number[] = []
  const widths: number[] = []
  const spacings: number[] = []
  let text = ""
  let x = Math.max(geom.marginIntent, 0) // 탭 정지점은 왼쪽 여백 기준 — 첫 줄 들여쓰기만큼 들어가서 시작
  // 글자처럼 취급하는 개체(treatAsChar 표·그림)는 폭(outMargin 좌우 포함)을 가진 글자 하나로 줄 채우기에 넣는다 —
  // 한컴도 개체를 그 폭의 글자로 줄에 채운다. 넓은 표 두 개는 줄을 하나씩 차지한다(정답 lineseg textpos 0·8)
  const inlineAt = new Map<number, ParaObj>()
  for (const o of m.objs) if (o.inline) inlineAt.set(o.index, o)
  for (let i = 0; i < m.chars.length; i++) {
    const c = m.chars[i]
    const io = inlineAt.get(i)
    if (io) {
      const adv = io.omL + io.width + io.omR
      realIdx.push(i); widths.push(adv); spacings.push(0); text += "\ufffc"; x += adv
      continue
    }
    if (c.tab) {
      const adv = tabAdvance(x, true, geom, c.tabW)
      realIdx.push(i); widths.push(adv); spacings.push(0); text += "\t"; x += adv
      continue
    }
    if (c.ctrl) {
      // 컨트롤 — 줄의 내용으로 친다(뒤에서 넘치는 개체는 다음 줄로). 주석 머리 번호("1)")처럼 글을 그리는 컨트롤은
      // 그 글 폭의 한 덩어리(미주 lineseg 실측: 8.0pt 문단이 "1) " 몫만큼 일찍 꺾인다), 쪽 번호·필드 등은 폭 0
      let w = 0
      if (c.ctrlText) {
        const st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
        for (const ch of c.ctrlText) w += glyphWidth(ch, st).w
      }
      realIdx.push(i); widths.push(w); spacings.push(0); text += w > 0 ? "\ufffc" : "\u2060"; x += w
      continue
    }
    if (c.br) {
      // 강제 줄바꿈 — 그 뒤 글은 새 줄(simulateWrap 이 \n 에서 끊는다)
      realIdx.push(i); widths.push(0); spacings.push(0); text += "\n"; x = Math.max(0, -geom.marginIntent)
      continue
    }
    if (c.ch === "") continue
    const st = (c.prId != null ? styles.charPr.get(c.prId) : undefined) ?? DEFAULT_CHAR
    // 폭 테이블: 고정폭 글꼴(굴림체류)은 전용 클래스 — 함초롬 테이블(한글 0.97em)로 재면 줄당 1~2자
    // 과대적재로 wrap 이 어긋난다 (seoul 코퍼스 3건 실측). 폭표 없는 한글 글꼴은 한글 1em(faceClassForReflow).
    // 글자 폭은 한컴처럼 글자마다 4 단위로 양자화하고, 언어별 글꼴·장평·자간·상대크기와 첨자 크기를 따른다(glyphWidth)
    // 옛한글: 첫소리 자모 뒤의 가운뎃소리·끝소리 자모는 한 글자로 합쳐진다 — 폭은 첫소리 자리의 한 글자 몫뿐(ᄒ+ᆞ+ᆫ = 1em)
    const cp = c.ch.codePointAt(0)!
    const joins = isJamoVT(cp) && isJamoLV(text.codePointAt(text.length - 1) ?? 0)
    const { w, sp } = joins ? { w: 0, sp: 0 } : glyphWidth(c.ch, st)
    for (let u = 0; u < c.ch.length; u++) { realIdx.push(i); widths.push(u === 0 ? w : 0); spacings.push(u === 0 ? sp : 0) }
    text += c.nb ? "\u00a0" : c.ch
    x += w
  }

  // 문단 지배 charPr — 첫 실문자 우선(줄 높이·기준선. 가로 폭은 위 widths 가 글자별로 잰다)
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

  const marginL = geom.marginLeft
  // 한컴은 줄 폭을 4 HWPUNIT 단위로 내리고, 1440(0.5 cm) 보다 좁히지 않는다(저장 lineseg horzsize 실측: 48190 → 48188, 칸 폭 200~1400 → 1440)
  const avail = Math.max(1440, Math.floor((areaW - marginL - geom.marginRight) / 4) * 4)
  // hanging(intent<0): 둘째 줄부터 |intent| 더 들어감 → contWidth 축소·contHorz 우측 이동.
  // 들여쓰기(intent>0)는 첫 줄을 그만큼 좁혀 채운다 — lineseg horzsize 는 한컴처럼 들여쓰기를 빼지 않은 폭으로 둔다
  const firstWidth = avail
  // 글머리표: 글자 폭 + 간격(textOffset — % 면 글자 크기의 %)만큼 첫 줄이, autoIndent 면 둘째 줄부터도 좁게 찬다
  // (한컴 저장 lineseg 260문단: 맞는 문단 65 → 235. 간격을 글머리표 폭의 % 로 보면 224)
  // 문단 번호도 같다 — 머리 글("1."·"가)") 폭 + 간격 (한컴 저장본 번호 문단 대조)
  const bu = geom.bullet ?? (numText && geom.number ? { ch: numText, ...geom.number } : undefined)
  let headW = 0
  if (bu) { const bst = (bu.charPrId != null ? styles.charPr.get(bu.charPrId) : undefined) ?? domChar; for (const ch of bu.ch) headW += glyphWidth(ch, bst).w }
  const bulletW = bu ? headW + (bu.offsetPct ? Math.trunc(height * bu.offset / 100) : bu.offset) : 0
  const contBullet = bu?.autoIndent ? bulletW : 0
  const firstWrapWidth = Math.max(500, avail - Math.max(0, geom.marginIntent) - bulletW)
  // 내어쓰기(intent<0)는 둘째 줄부터 그만큼 좁게 채우되, lineseg 의 horzpos·horzsize 는 들여쓰기처럼 바꾸지 않는다
  // (한컴 저장본 내어쓰기 문단 수천 개 전부 둘째 줄 horzpos = 왼쪽 여백 — 그리기가 내어쓰기만큼 민다)
  const contSegWidth = avail
  const contWidth = Math.max(500, avail + Math.min(0, geom.marginIntent) - contBullet)
  const contHorz = marginL

  // 문단 paraPr의 breakSetting이 있으면 그 선언(어절/글자)을 따르고, 없으면 호출자 모드
  const paraMode = geom.wrapMode ?? mode
  const pitch = pitchFor(height, geom)

  // ── 떠 있는 개체(treatAsChar=0)의 세로 흐름 (Phase 3 — 한컴 실측 모델, 36264961) ──
  // · TOP_AND_BOTTOM + PARA 앵커: 개체가 문단 상단을 차지하고 텍스트는 outTop+개체높이+outBottom 아래부터 흐른다
  //   (두문 결재표 실측: 140+16653+852=17645 정확 일치)
  // · SQUARE·TIGHT·THROUGH(어울림) + PARA 앵커: 글이 개체 둘레로 흐른다 — 개체 영역(위 = 문단 시작 + vertOffset,
  //   아래 = 위 + 높이 + outBottom, 옆 = horzOffset − outLeft ~ + 폭 + outRight)과 세로로 겹치는 줄은 남는 폭으로 줄고
  //   (정답 lineseg horzpos 12994 = 그림 폭 12144 + outRight 850), 개체는 다음 문단을 밀지 않는다
  // · BEHIND_TEXT/IN_FRONT_OF_TEXT 또는 PAGE/PAPER 앵커: 본문 흐름에 불참 (페이지 하단 직인 스탬프가 커서를 밀던 것 제거)
  let floatBelow = 0 // 텍스트 시작을 아래로 미는 float 개체 바닥 (문단 로컬)
  let objBottom = startV
  const effHOf = (o: ParaObj): number => (o.tag === "tbl" ? Math.max(o.height, measureTableHeight(o.el)) : o.height) + (o.tag === "tbl" || o.tag === "pic" ? captionExtra(o.el) : 0)
  for (const o of m.objs) {
    if (o.inline) continue
    const pos = findChildByLocalName(o.el, "pos")
    const om = findChildByLocalName(o.el, "outMargin")
    const outT = num(om, "top"), outB = num(om, "bottom")
    const wrapAttr = o.el.getAttribute("textWrap") ?? ""
    if (wrapAttr === "BEHIND_TEXT" || wrapAttr === "IN_FRONT_OF_TEXT") continue
    const vertRel = pos?.getAttribute("vertRelTo") ?? "PARA"
    if (vertRel === "PAGE" || vertRel === "PAPER") continue
    const vo = Math.max(0, num(pos, "vertOffset"))
    const effH = effHOf(o)
    if (wrapAttr === "TOP_AND_BOTTOM") {
      // 표 칸 안에서는 글을 밀지 않는다(한컴 저장본: 칸 안 떠 있는 위아래 개체 문단 202개 중 201개가 첫 줄 vertpos 0)
      if (bodyFlow) floatBelow = Math.max(floatBelow, vo + outT + effH + outB)
      continue
    }
    const hRel = pos?.getAttribute("horzRelTo") ?? "COLUMN", hAlign = pos?.getAttribute("horzAlign") ?? "LEFT"
    const ho = num(pos, "horzOffset"), base = hRel === "PARA" ? marginL : 0, span = hRel === "PARA" ? avail : areaW
    const x0 = base + (hAlign === "RIGHT" ? span - ho - o.width : hAlign === "CENTER" ? (span - o.width) / 2 + ho : ho)
    const top = startV + vo
    zones.push({ top, bottom: top + effH + outB, left: x0 - num(om, "left"), right: x0 + o.width + num(om, "right"), flow: o.el.getAttribute("textFlow") ?? "BOTH_SIDES" })
  }
  // 글 없는 문단(개체·컨트롤만)은 줄이 제자리에 남고 개체가 문단 바닥을 민다 — 한컴 저장본: 두문 표만 있는 첫 문단 줄 vertpos 0, 다음 문단 17645
  const hasText = m.chars.some(c => c.ch !== "")
  if (!hasText) { objBottom = startV + floatBelow; floatBelow = 0 }
  const textStartV = startV + floatBelow

  /** 줄 i 의 [horzpos, horzsize] — 어울림 개체와 세로로 겹치면 남는 폭(넓은 쪽, LEFT_ONLY/RIGHT_ONLY 는 그쪽) */
  const lineBox: Array<[number, number] | undefined> = []
  const boxAt = (i: number): [number, number] | undefined => {
    if (!zones.length) return undefined
    if (i in lineBox) return lineBox[i]
    const y0 = textStartV + i * pitch, y1 = y0 + height
    let free: Array<[number, number]> = [[marginL, marginL + avail]], hit = false, flow = "BOTH_SIDES"
    for (const z of zones) {
      if (!(y1 > z.top && y0 < z.bottom)) continue
      hit = true; flow = z.flow
      free = free.flatMap(([a, b]): Array<[number, number]> => {
        const parts: Array<[number, number]> = z.right <= a || z.left >= b ? [[a, b]] : [[a, Math.max(a, z.left)], [Math.min(b, z.right), b]]
        return parts.filter(([c, d]) => d - c > 0)
      })
    }
    let box: [number, number] | undefined
    if (hit) {
      const pick = flow === "LEFT_ONLY" ? free[0] : flow === "RIGHT_ONLY" ? free[free.length - 1] : free.reduce((x, y) => (y[1] - y[0] > x[1] - x[0] ? y : x), free[0] ?? [marginL, marginL])
      box = pick ? [pick[0], pick[1] - pick[0]] : [marginL, 0]
    }
    lineBox[i] = box
    return box
  }
  const lineWidth = zones.length
    ? (i: number): number => {
        const b = boxAt(i)
        const w = b ? b[1] : avail
        return Math.max(500, i === 0 ? w - Math.max(0, geom.marginIntent) - bulletW : w + Math.min(0, geom.marginIntent) - contBullet)
      }
    : undefined
  const wrap = text.length === 0
    ? { lines: 1, starts: [0], lastLineWidth: 0 }
    : simulateWrap(text, firstWrapWidth, contWidth, height, 100, paraMode, { widths, spacings, condensePct: geom.condense, kinsoku: "hancom", lineWidth, latinBreak: geom.latinBreak })

  // · inline(treatAsChar=1): 그 줄의 높이가 된다 — outMargin 포함 높이
  /** 줄마다 인라인 개체 높이(outMargin 위아래 포함)의 최대 — 그 줄 높이가 된다 */
  const lineObjH = new Array<number>(wrap.starts.length).fill(0)
  /** 줄마다 인라인 개체의 기준선 위 높이(윗부분) 최대 — 수식은 높이 × baseLine%, 그 밖의 개체는 85% */
  const lineObjAsc = new Array<number>(wrap.starts.length).fill(0)
  const lineOf = (slot: number): number => {
    let li = 0
    for (let k = 1; k < wrap.starts.length; k++) if ((wrap.starts[k] < realIdx.length ? realIdx[wrap.starts[k]] : Infinity) <= slot) li = k
    return li
  }
  for (const o of m.objs) {
    if (!o.inline) continue
    const om = findChildByLocalName(o.el, "outMargin")
    const li = lineOf(o.index)
    const h = num(om, "top") + effHOf(o) + num(om, "bottom")
    lineObjH[li] = Math.max(lineObjH[li], h)
    // 수식 기준선: 한컴 저장 lineseg 631줄 전부 일치(높이 900·baseLine 86 → 774)
    const bl = o.tag === "equation" ? Number(o.el.getAttribute("baseLine")) : NaN
    lineObjAsc[li] = Math.max(lineObjAsc[li], Math.round(h * (Number.isFinite(bl) ? bl / 100 : BASELINE_RATIO)))
  }

  const lsa = doc.createElement("hp:linesegarray")
  let v = textStartV
  // 실텍스트 없는 문단(인라인 표·개체만)의 textpos는 0 — chars.length로 폴백하면
  // planLines의 plan.start가 개체 index보다 커져 advanceTo 가로 전진에서 개체가
  // 전부 빠지고 같은 x에 겹쳐 그려진다 (공문 결재란 라벨표∩스탬프표 겹침의 원인)
  // 첫 줄은 늘 0 — 문단 앞 컨트롤(구역·단 정의, 개체) 슬롯도 첫 줄에 속한다(한컴 저장 lineseg)
  const textposOf = wrap.starts.map((startReal, li) => (li === 0 ? 0 : startReal < realIdx.length ? realIdx[startReal] : 0))
  const heightOf = (prId: string | null): number => (prId != null ? styles.charPr.get(prId)?.height : undefined) || 0
  /** 줄 li 의 글자 높이 — 그 줄 슬롯의 글자와 그 자리 run(마지막 줄은 문단 끝 빈 run 까지) 중 가장 큰 글자 크기.
   *  한컴 저장 lineseg 실측: 표 run 1200 + 문단 끝 빈 run 1500 → 줄간격 180% 의 spacing 1200(1500 기준) */
  const lineTextH = (li: number): number => {
    const s = textposOf[li], last = li === wrap.starts.length - 1, e = last ? m.chars.length : textposOf[li + 1]
    let h = 0
    for (let k = s; k < e; k++) h = Math.max(h, heightOf(m.chars[k].prId))
    for (const r of m.runs) if (r.at >= s && (last ? r.at <= e : r.at < e)) h = Math.max(h, heightOf(r.prId))
    return h || height
  }
  for (let li = 0; li < wrap.starts.length; li++) {
    const textpos = textposOf[li]
    // 개체가 있는 줄은 개체 높이가 줄 높이·글자 높이, 기준선은 그 85% (한컴 저장 lineseg 실측: 표 h 3679 + 여백 566 = 4245, 기준선 3608).
    // 줄 간격 몫은 그 줄 글자 높이로 정한다(개체 줄도 — 표 줄 spacing −600 = 1500 × (60% − 100%))
    const textH = lineTextH(li)
    const lineH = Math.max(textH, lineObjH[li])
    const spacing = pitchFor(textH, geom) - textH // 줄간격 100% 미만이면 음수 — 다음 줄·문단이 그만큼 겹쳐 올라온다
    const vertpos = v
    v += lineH + spacing
    const isFirst = li === 0
    const seg = doc.createElement("hp:lineseg")
    seg.setAttribute("textpos", String(textpos))
    seg.setAttribute("vertpos", String(vertpos))
    seg.setAttribute("vertsize", String(lineH))
    seg.setAttribute("textheight", String(lineH))
    // 기준선 = 글자(높이의 85%)와 개체 윗부분 중 가장 높은 것 — 줄 높이는 그 둘의 합이 아니라 가장 큰 높이다(수식 1650·1050 줄 → 1650, 기준선 924).
    // 문단 세로 정렬이 가운데면 기준선이 줄 가운데(개체 줄 2817 → 1408, 글 줄 1100 → 550)
    seg.setAttribute("baseline", String(geom.vertAlign === "CENTER" ? Math.floor(lineH / 2) : Math.max(Math.round(textH * BASELINE_RATIO), lineObjAsc[li])))
    seg.setAttribute("spacing", String(spacing))
    const box = boxAt(li)
    seg.setAttribute("horzpos", String(box ? box[0] : isFirst ? marginL : contHorz))
    seg.setAttribute("horzsize", String(box ? box[1] : isFirst ? firstWidth : contSegWidth))
    seg.setAttribute("flags", LINESEG_FLAGS)
    lsa.appendChild(seg)
  }
  p.appendChild(lsa)

  // 문단 바닥 = 텍스트 줄 흐름(float 개체 아래부터)과 개체 바닥 중 큰 쪽.
  // 표는 셀 콘텐츠 성장으로 선언 sz보다 커질 수 있어 drawTable과 같은 실효 높이를 쓴다
  // (셀 lineseg 필요 — reflowBlockFlow가 reflowTablesIn을 먼저 돌린다).
  const textBottom = v
  return { paraBottom: Math.max(textBottom, objBottom), spaceAfter: geom.spaceAfter }
}

/** 문단에 앵커된, 쪽 아래에 붙은 위아래 배치 개체가 본문 바닥에서 차지하는 높이(바깥 여백·vertOffset 포함). 없으면 0 */
function pageBottomReserve(p: Element): number {
  let r = 0
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const o of elements(run)) {
      if (!OBJ_TAGS.has(ln(o)) || o.getAttribute("textWrap") !== "TOP_AND_BOTTOM") continue
      const pos = findChildByLocalName(o, "pos")
      if (pos?.getAttribute("treatAsChar") === "1" || pos?.getAttribute("vertRelTo") !== "PAGE" || pos?.getAttribute("vertAlign") !== "BOTTOM") continue
      const om = findChildByLocalName(o, "outMargin"), sz = findChildByLocalName(o, "sz")
      const h = ln(o) === "tbl" ? Math.max(num(sz, "height"), measureTableHeight(o)) : num(sz, "height")
      r = Math.max(r, num(pos, "vertOffset") + num(om, "top") + h + num(om, "bottom"))
    }
  }
  return r
}

/** 문단 run 의 단 정의(ctrl>colPr) → 단 폭. 같은 폭이면 (본문 폭 − 간격×(단 수−1)) ÷ 단 수, 아니면 첫 단(colSz) 폭. 없으면 undefined */
function columnWidthIn(p: Element, bodyW: number): number | undefined {
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const ch of elements(run)) {
      if (ln(ch) !== "ctrl") continue
      const col = findChildByLocalName(ch, "colPr")
      if (!col) continue
      const n = Math.max(1, num(col, "colCount", 1))
      if (n === 1) return bodyW
      if (col.getAttribute("sameSz") !== "0") return Math.trunc((bodyW - num(col, "sameGap") * (n - 1)) / n)
      const first = findChildByLocalName(col, "colSz")
      return first ? num(first, "width", bodyW) : bodyW
    }
  }
  return undefined
}

/**
 * 문단 run 안 표 칸 밖의 하위 목록 reflow — 머리말·꼬리말은 구역 본문 폭, 각주는 noteW(본문 흐름이면 그 단 폭 —
 * 2단 문서의 미주 lineseg 폭 = 단 폭), 미주는 구역 끝의 단 폭(counter.endNoteW, 없으면 noteW),
 * 도형 글상자(drawText)와 표 캡션은 저장된 글 영역 폭(lastWidth, 글상자는 안 여백을 뺀다).
 * 종전엔 건너뛰어 캐시 없는 문서에서 이 안의 글이 줄 정보 없이 남았다
 */
function reflowSubListsIn(p: Element, doc: Document, styles: RenderStyles, mode: WrapMode, counter: { n: number; bodyW?: number; endNoteW?: number; nums?: NumberCounters }, noteW = counter.bodyW): void {
  const visit = (el: Element): void => {
    for (const ch of elements(el)) {
      const t = ln(ch)
      if (t === "footNote" || t === "endNote" || t === "header" || t === "footer") {
        const sub = findChildByLocalName(ch, "subList"), w = t === "endNote" ? counter.endNoteW ?? noteW : t === "footNote" ? noteW : counter.bodyW
        if (sub && w) reflowBlockFlow(sub, doc, styles, w, mode, counter, 0)
        continue
      }
      if (t === "drawText" || t === "caption") {
        // 글상자는 안 여백(textMargin 좌우)을 뺀 폭 — 한컴 저장 lineseg 실측: lastWidth 30907 − 283×2 → 30340
        const sub = findChildByLocalName(ch, "subList"), tm = findChildByLocalName(ch, "textMargin")
        const w = num(ch, "lastWidth") - num(tm, "left") - num(tm, "right")
        if (sub && w > 0) reflowBlockFlow(sub, doc, styles, w, mode, counter, 0)
        continue
      }
      if (t === "tr" || t === "subList" || t === "linesegarray") continue
      visit(ch)
    }
  }
  for (const run of elements(p)) if (ln(run) === "run") visit(run)
}

/** 문단 run 안의 표를 찾아 각 셀 subList를 셀 로컬로 reflow (중첩 재귀) */
function reflowTablesIn(p: Element, doc: Document, styles: RenderStyles, mode: WrapMode, counter: { n: number; bodyW?: number; endNoteW?: number; nums?: NumberCounters }): void {
  for (const run of elements(p)) {
    if (ln(run) !== "run") continue
    for (const obj of elements(run)) {
      if (ln(obj) !== "tbl") continue
      const inM = findChildByLocalName(obj, "inMargin")
      for (const tr of elements(obj)) {
        if (ln(tr) !== "tr") continue
        for (const tc of elements(tr)) {
          if (ln(tc) !== "tc") continue
          const csz = findChildByLocalName(tc, "cellSz")
          // hasMargin="0" 이면 표 안 여백(inMargin) — collectCells 와 같은 해석
          const cm = tc.getAttribute("hasMargin") === "0" ? null : findChildByLocalName(tc, "cellMargin")
          const cellW = num(csz, "width")
          const mL = num(cm ?? inM, "left", 141)
          const mR = num(cm ?? inM, "right", 141)
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
  counter: { n: number; bodyW?: number; endNoteW?: number; nums?: NumberCounters },
  bodyH: number,
): void {
  let cursorV = 0
  let prevSpaceAfter = 0
  /** 이 흐름에 앵커된 어울림 개체 영역 — 뒤 문단의 줄도 피해 간다 */
  const zones: WrapZone[] = []
  /** 이 쪽에서 글이 내려갈 수 있는 바닥 — 쪽 아래에 붙은 위아래 배치 개체(결재란 표 등)가 있으면 그만큼 올라온다 */
  let pageLimit = bodyH
  /** 바로 앞에 놓은 문단(쪽에 걸치지 않고 제자리에 놓인 경우만) — '다음 문단과 함께' 처리용 */
  let prevPlaced: { p: Element; startV: number; top: number; h: number; spaceAfter: number; keepWithNext: boolean } | undefined
  // 구역 본문의 다단(colPr colCount>1) — 단 정의가 나온 문단부터 단 폭으로 채운다(한컴 다단 편집 lineseg horzsize 실측)
  const bodyFlow = areaW === counter.bodyW && bodyH > 0
  for (const p of elements(container)) {
    if (ln(p) !== "p") continue
    if (bodyFlow) { const colW = columnWidthIn(p, counter.bodyW!); if (colW !== undefined) areaW = colW }
    // 문단 안 표 셀을 먼저 셀 로컬 좌표로 reflow (본문 세로 흐름과 무관) —
    // reflowPara의 표 실효높이 측정이 셀 lineseg를 읽으므로 호스트 문단보다 앞서야 한다
    reflowTablesIn(p, doc, styles, mode, counter)
    reflowSubListsIn(p, doc, styles, mode, counter, bodyFlow ? areaW : undefined)
    const g = styles.paraGeom.get(p.getAttribute("paraPrIDRef") ?? "")
    const startV = cursorV + prevSpaceAfter + (g?.spaceBefore ?? 0)
    const numsBefore: NumberCounters = new Map([...(counter.nums ?? [])].map(([k, v]) => [k, v.slice()]))
    const res = reflowPara(p, doc, styles, areaW, startV, mode, zones, counter.nums, bodyH > 0)
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
    // 페이지 넘김은 줄 단위다: 줄 vertpos + vertsize 가 본문 높이를 넘으면 그 줄부터 다음 쪽 맨 위(0)에서 이어진다
    // (간격 몫은 넣지 않는다 — 한컴 저장본에서 쪽에 걸친 문단 97개 중 86개, 나머지는 칸 안 쪽 나눔). 쪽보다 높은 줄은 옮기지 않는다.
    // 명시적 쪽 나눔(hp:p pageBreak="1" — 한컴 '쪽 나누기' 저장 속성)과 첫 줄부터 넘치는 문단은 문단째 다음 쪽으로.
    const explicitBreak = bodyH > 0 && startV > 0 && (p.getAttribute("pageBreak") === "1" || !!g?.pageBreakBefore)
    const lines = bodyH > 0 ? elements(findChildByLocalName(p, "linesegarray") ?? p).filter(e => ln(e) === "lineseg") : []
    // 쪽 아래에 붙은 위아래 배치 개체(vertRelTo=PAGE·vertAlign=BOTTOM)는 그 쪽 바닥을 개체 몫만큼 올린다 — 앵커 문단이 그 위에 못 들어가면
    // 문단째(개체와 함께) 다음 쪽으로(한컴 저장본: 결재란 표 26793 이 붙은 끝 문단이 새 쪽 0 에서 시작)
    const reserve = bodyH > 0 ? pageBottomReserve(p) : 0
    const lim = reserve > 0 ? Math.min(pageLimit, bodyH - reserve) : pageLimit
    const lineBottom = (seg: Element): number => num(seg, "vertpos") + num(seg, "vertsize") + (reserve > 0 ? num(seg, "spacing") : 0)
    const firstOver = lines.length > 0 && startV > 0 && lineBottom(lines[0]) > lim && num(lines[0], "vertsize") <= bodyH
    /** 줄 단위 쪽 넘김으로 뒤 줄들이 옮겨 간 양(음수) — 0 이면 쪽이 안 나뉘었다 */
    let off = 0
    // 넘치는 첫 줄 번호 — 외톨이줄 보호면 쪽 끝 첫 줄 하나만 남기지 않고(문단째), 다음 쪽에 마지막 줄 하나만 보내지 않는다(한 줄 앞에서)
    let cut = -1
    if (!explicitBreak && !firstOver && lines.length > 1) {
      cut = lines.findIndex((seg, i) => i > 0 && lineBottom(seg) > lim && num(seg, "vertsize") <= bodyH)
      if (cut > 0 && g?.widowOrphan && lines.length >= 3 && cut === lines.length - 1) cut--
    }
    // 외톨이줄 보호로 첫 줄만 남거나, 문단 보호(keepLines)면 쪽에 걸치지 않고 문단째 넘긴다
    const orphan = (cut === 1 && !!g?.widowOrphan) || (cut > 0 && !!g?.keepLines)
    if (cut > 0 && !orphan) {
      for (let i = cut; i < lines.length; i++) {
        const seg = lines[i]
        let vp = num(seg, "vertpos") + off
        const vs = num(seg, "vertsize")
        if (i === cut || (vp > 0 && vp + vs > bodyH && vs <= bodyH)) { off -= vp; vp = 0; zones.length = 0 }
        seg.setAttribute("vertpos", String(vp))
      }
    }
    if (explicitBreak || firstOver || orphan || (bodyH > 0 && startV > 0 && lines.length === 0 && res.paraBottom > bodyH && paraH <= bodyH)) {
      if (zones.length) {
        // 앞 쪽의 어울림 개체는 새 쪽 줄을 좁히지 않는다 — 비우고 새 쪽 상단에서 다시 조판
        zones.length = 0
        const lsa = findChildByLocalName(p, "linesegarray")
        if (lsa) p.removeChild(lsa)
        cursorV = reflowPara(p, doc, styles, areaW, 0, mode, zones, numsBefore)!.paraBottom // 번호는 이미 셌다 — 센 직전 상태로 다시
      } else {
        // 새 페이지 상단으로 이동 → 프리패스가 vertpos 역행 감지. 문단 위 간격은 새 쪽에서도 남는다(한컴 저장본: 새 쪽 첫 줄 vertpos = prev 1200)
        const top = g?.spaceBefore ?? 0
        shiftParaVert(p, top - startV)
        cursorV = paraH + top
        // 앞 문단이 '다음 문단과 함께'면 그 문단도 새 쪽으로 — 앞 문단을 새 쪽 위에 두고 이 문단을 그 아래로
        if (prevPlaced?.keepWithNext && prevPlaced.startV > prevPlaced.top) {
          shiftParaVert(prevPlaced.p, prevPlaced.top - prevPlaced.startV)
          const base = prevPlaced.top + prevPlaced.h + prevPlaced.spaceAfter
          shiftParaVert(p, base)
          cursorV += base
        }
      }
    } else {
      cursorV = res.paraBottom + off
    }
    prevPlaced = off === 0 && !(explicitBreak || firstOver || orphan) ? { p, startV, top: g?.spaceBefore ?? 0, h: paraH, spaceAfter: res.spaceAfter, keepWithNext: !!g?.keepWithNext } : undefined
    // 새 쪽으로 넘어갔으면 바닥을 되돌리고, 이 문단의 쪽 아래 개체가 있는 쪽이면 그 몫을 남긴다
    const moved = explicitBreak || firstOver || orphan || off !== 0
    pageLimit = reserve > 0 ? bodyH - reserve : moved ? bodyH : lim
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
  // 미주는 구역 끝에 모여 놓인다 — 폭은 구역 끝의 단 폭(중간에 2단으로 바뀐 구역의 미주 lineseg 폭 = 그 단 폭)
  let endNoteW: number | undefined
  for (const p of elements(root)) if (ln(p) === "p") endNoteW = columnWidthIn(p, geom.BODY_W) ?? endNoteW
  const counter = { n: 0, bodyW: geom.BODY_W, endNoteW, nums: new Map() as NumberCounters }
  reflowBlockFlow(root, doc, styles, geom.BODY_W, mode, counter, geom.BODY_H)
  return counter.n
}
