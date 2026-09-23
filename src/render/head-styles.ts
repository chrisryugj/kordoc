/**
 * 레이아웃 보존 렌더 — header.xml 스타일 테이블 (charPr/paraPr/borderFill).
 * 파서 IR과 무관하게 렌더에 필요한 속성만 추출한다.
 */

import { createXmlParser, findChildByLocalName } from "../hwpx/parser-shared.js"

export interface RenderCharStyle {
  /** 글자 크기 (1/100pt — 1000 = 10pt) */
  height: number
  bold: boolean
  italic: boolean
  underline: boolean
  /** #RRGGBB — 검정이면 undefined */
  color?: string
  /** 장평 % */
  ratio: number
  /** 자간 % */
  spacing: number
  /** CSS font-family 스택 — charPr fontRef(hangul)에서 해석. 없으면 root 기본 폴백 */
  fontFamily?: string
  /** HWP 원본 글꼴명 (fontfaces face) — reflow 폭 테이블 선택용 */
  face?: string
}

export type ParaAlign = "JUSTIFY" | "LEFT" | "RIGHT" | "CENTER" | "DISTRIBUTE" | "DISTRIBUTE_SPACE"

/** reflow(Tier-2)용 문단 기하 — 줄간격·여백. paraPr `<hh:margin>`·`<hh:lineSpacing>`은
 *  `<hp:switch>/<hp:case>` 안(손자)이라 재귀 탐색으로 뽑는다. 단위 HWPUNIT. */
export interface RenderParaGeom {
  /** PERCENT(기본 160=160%) / FIXED / BETWEEN_LINES / AT_LEAST */
  lineSpacingType: string
  lineSpacingValue: number
  /** 왼쪽 들여쓰기(HWPUNIT) */
  marginLeft: number
  marginRight: number
  /** 첫 줄 들여쓰기/내어쓰기 — 음수=둘째 줄부터 더 들어감(hanging) */
  marginIntent: number
  /** 문단 위 간격(prev) */
  spaceBefore: number
  /** 문단 아래 간격(next) */
  spaceAfter: number
  /** breakSetting의 한글 줄나눔 — 'keep'(어절)/'charAll'(글자). 없으면 호출자 모드.
   *  주의: 저장 속성 의미는 이름과 반대 — breakNonLatinWord "BREAK_WORD"=어절,
   *  "KEEP_WORD"=글자 (한글 COM 실렌더 실측) */
  wrapMode?: "keep" | "charAll"
  /** 탭 정의(tabPrIDRef)가 내어쓰기용 자동 탭(autoTabLeft) — 첫 줄 탭이 내어쓰기 위치에 선다 */
  autoTabLeft?: boolean
}

export const DEFAULT_PARA_GEOM: RenderParaGeom = {
  lineSpacingType: "PERCENT", lineSpacingValue: 160,
  marginLeft: 0, marginRight: 0, marginIntent: 0, spaceBefore: 0, spaceAfter: 0,
}

export interface RenderBorderEdge {
  /** SOLID/DASH/DOT… — NONE은 edge 자체를 생략 */
  type: string
  /** pt 단위 굵기 */
  widthPt: number
  color: string
}

export interface RenderBorderFill {
  left?: RenderBorderEdge
  right?: RenderBorderEdge
  top?: RenderBorderEdge
  bottom?: RenderBorderEdge
  /** 배경색 #RRGGBB (없으면 undefined) */
  fill?: string
}

export interface RenderStyles {
  charPr: Map<string, RenderCharStyle>
  paraAlign: Map<string, ParaAlign>
  /** reflow용 문단 기하 (줄간격·여백) — id별 */
  paraGeom: Map<string, RenderParaGeom>
  borderFill: Map<string, RenderBorderFill>
}

export const DEFAULT_CHAR: RenderCharStyle = { height: 1000, bold: false, italic: false, underline: false, ratio: 100, spacing: 0 }

// ─── 글꼴 매핑 (HWP fontfaces face → CSS font-family 스택) ──────────────
//
// HWPX charPr 는 <hh:fontRef hangul="N">으로 fontfaces 테이블의 실제 글꼴명을 가리킨다.
// 렌더는 이 글꼴명을 SVG <text font-family>로 내보내 뷰어(WebView2/브라우저)가 원본과
// 같은 글꼴로 그리게 한다. 미설치 글꼴은 계열(명조=serif / 고딕=sans) 폴백으로 수렴시켜
// 최소한 획 계열(바탕↔돋움)은 원본과 일치시킨다 — 공문서 제목 고딕이 바탕체로 나오던 회귀 해소.

/** 자주 쓰는 글꼴의 별칭 스택 (한글명↔영문 시스템명 병기 — 뷰어 OS별 등록명 차이 흡수) */
const FONT_ALIASES: Record<string, string> = {
  "함초롬바탕": "'HCR Batang','함초롬바탕','한컴바탕'",
  "한컴바탕": "'HCR Batang','함초롬바탕','한컴바탕'",
  "함초롬돋움": "'HCR Dotum','함초롬돋움','한컴돋움'",
  "한컴돋움": "'HCR Dotum','함초롬돋움','한컴돋움'",
  "맑은 고딕": "'Malgun Gothic','맑은 고딕'",
  "맑은고딕": "'Malgun Gothic','맑은 고딕'",
  "굴림": "'Gulim','굴림'",
  "굴림체": "'GulimChe','굴림체','Gulim'",
  "돋움": "'Dotum','돋움'",
  "돋움체": "'DotumChe','돋움체','Dotum'",
  "바탕": "'Batang','바탕'",
  "바탕체": "'BatangChe','바탕체','Batang'",
  "궁서": "'Gungsuh','궁서'",
  "궁서체": "'GungsuhChe','궁서체','Gungsuh'",
  "나눔고딕": "'NanumGothic','나눔고딕'",
  "나눔명조": "'NanumMyeongjo','나눔명조'",
  "맑은 고딕 Semilight": "'Malgun Gothic Semilight','맑은 고딕'",
}

/** 명조/바탕 계열(serif) 여부 — 아니면 고딕/돋움(sans)으로 본다 */
function isSerifFace(face: string): boolean {
  return /바탕|명조|Batang|Myeong|Mincho|궁서|Gungsuh|Serif|신명|순명|Song|송/i.test(face)
}

/** CSS font-family 토큰 인용 — 영숫자·하이픈만이면 무인용, 그 외(공백·한글)는 작은따옴표 */
function cssQuote(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `'${name.replace(/['"\\]/g, "")}'`
}

/**
 * HWP 글꼴명 → CSS font-family 스택. 정확한 글꼴 먼저, 이어서 계열 폴백(명조=serif /
 * 고딕=sans, 각 한국어 렌더 가능 글꼴 포함)을 붙여 미설치 시에도 획 계열을 보존한다.
 */
export function hwpFaceToCssStack(face: string | null | undefined): string {
  const trimmed = (face ?? "").trim()
  if (!trimmed) return ""
  const generic = isSerifFace(trimmed)
    ? "'HCR Batang','Batang','Noto Serif KR',serif"
    : "'Malgun Gothic','HCR Dotum','Noto Sans KR',sans-serif"
  const head = FONT_ALIASES[trimmed] ?? cssQuote(trimmed)
  return `${head},${generic}`
}

/** fontfaces 테이블에서 HANGUL 그룹의 font id → 글꼴명 맵 (없으면 첫 그룹) */
function collectHangulFonts(root: Element): Map<string, string> {
  const map = new Map<string, string>()
  const findFaces = (el: Element, depth: number): Element | null => {
    if (depth > 24) return null
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType !== 1) continue
      const e = ch as Element
      if ((e.tagName || "").replace(/^[^:]+:/, "") === "fontfaces") return e
      const f = findFaces(e, depth + 1)
      if (f) return f
    }
    return null
  }
  const faces = findFaces(root, 0)
  if (!faces) return map
  let group: Element | null = null
  let firstGroup: Element | null = null
  for (const ch of Array.from(faces.childNodes)) {
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "fontface") continue
    if (!firstGroup) firstGroup = e
    if ((e.getAttribute("lang") ?? "").toUpperCase() === "HANGUL") { group = e; break }
  }
  group = group ?? firstGroup
  if (!group) return map
  for (const ch of Array.from(group.childNodes)) {
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "font") continue
    const id = e.getAttribute("id")
    const face = e.getAttribute("face")
    if (id != null && face) map.set(id, face)
  }
  return map
}

/** "0.12 mm" / "0.5 mm" → pt */
function borderWidthPt(v: string | null | undefined): number {
  const n = parseFloat(v ?? "")
  if (!Number.isFinite(n)) return 0.34
  return n * 2.834645 // mm → pt
}

function parseEdge(el: Element | null): RenderBorderEdge | undefined {
  if (!el) return undefined
  const type = el.getAttribute("type") ?? "NONE"
  if (type === "NONE") return undefined
  return { type, widthPt: borderWidthPt(el.getAttribute("width")), color: el.getAttribute("color") ?? "#000000" }
}

/** 서브트리에서 localName이 일치하는 첫 요소를 재귀 탐색 (switch/case 래핑 대응) */
function findDeep(el: Element, name: string, depth = 0): Element | null {
  if (depth > 32) return null
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i]
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") === name) return e
    const found = findDeep(e, name, depth + 1)
    if (found) return found
  }
  return null
}

/** paraPr 요소 → 문단 기하 (margin·lineSpacing은 hp:switch/case 안이라 재귀 탐색) */
function parseParaGeom(el: Element): RenderParaGeom {
  const g: RenderParaGeom = { ...DEFAULT_PARA_GEOM }
  const ls = findDeep(el, "lineSpacing")
  if (ls) {
    g.lineSpacingType = ls.getAttribute("type") ?? "PERCENT"
    g.lineSpacingValue = Number(ls.getAttribute("value")) || 160
  }
  const margin = findDeep(el, "margin")
  if (margin) {
    const v = (n: string): number => {
      const c = findDeep(margin, n)
      return c ? Number(c.getAttribute("value")) || 0 : 0
    }
    g.marginLeft = v("left")
    g.marginRight = v("right")
    g.marginIntent = v("intent")
    g.spaceBefore = v("prev")
    g.spaceAfter = v("next")
  }
  const bs = findDeep(el, "breakSetting")
  if (bs) {
    // 속성 의미 역전 주의(위 RenderParaGeom.wrapMode 주석): BREAK_WORD=어절, KEEP_WORD=글자
    const nl = bs.getAttribute("breakNonLatinWord")
    if (nl === "BREAK_WORD") g.wrapMode = "keep"
    else if (nl === "KEEP_WORD") g.wrapMode = "charAll"
  }
  return g
}

/** header.xml(구버전 head.xml) → 렌더용 스타일 맵 */
export function parseRenderStyles(headXml: string): RenderStyles {
  const styles: RenderStyles = { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map() }
  const doc = createXmlParser().parseFromString(headXml, "text/xml")
  const root = doc.documentElement as unknown as Element | null
  if (!root) return styles

  // fontfaces(HANGUL) 선파싱 — charPr fontRef 해석에 쓴다
  const hangulFonts = collectHangulFonts(root)
  // 탭 정의 — 문단의 tabPrIDRef 는 워크가 끝난 뒤 해석(순서 무관)
  const autoTabPr = new Set<string>()
  const paraTabRef = new Map<string, string>()

  const walk = (el: Element): void => {
    const tag = (el.tagName || "").replace(/^[^:]+:/, "")
    if (tag === "charPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const ratioEl = findChildByLocalName(el, "ratio")
        const spacingEl = findChildByLocalName(el, "spacing")
        const underlineEl = findChildByLocalName(el, "underline")
        const textColor = el.getAttribute("textColor")
        const fontRef = findChildByLocalName(el, "fontRef")
        const fontId = fontRef?.getAttribute("hangul") ?? fontRef?.getAttribute("latin")
        const face = fontId != null ? hangulFonts.get(fontId) : undefined
        styles.charPr.set(id, {
          height: Number(el.getAttribute("height")) || 1000,
          bold: findChildByLocalName(el, "bold") != null,
          italic: findChildByLocalName(el, "italic") != null,
          underline: underlineEl != null && (underlineEl.getAttribute("type") ?? "NONE") !== "NONE",
          color: textColor && textColor !== "#000000" && textColor.toLowerCase() !== "none" ? textColor : undefined,
          ratio: Number(ratioEl?.getAttribute("hangul")) || 100,
          spacing: Number(spacingEl?.getAttribute("hangul")) || 0,
          fontFamily: face ? hwpFaceToCssStack(face) : undefined,
          face,
        })
      }
    } else if (tag === "tabPr") {
      const id = el.getAttribute("id")
      if (id != null && el.getAttribute("autoTabLeft") === "1") autoTabPr.add(id)
    } else if (tag === "paraPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const align = findChildByLocalName(el, "align")
        styles.paraAlign.set(id, (align?.getAttribute("horizontal") as ParaAlign) || "JUSTIFY")
        styles.paraGeom.set(id, parseParaGeom(el))
        const tab = el.getAttribute("tabPrIDRef")
        if (tab != null) paraTabRef.set(id, tab)
      }
    } else if (tag === "borderFill") {
      const id = el.getAttribute("id")
      if (id != null) {
        const bf: RenderBorderFill = {
          left: parseEdge(findChildByLocalName(el, "leftBorder")),
          right: parseEdge(findChildByLocalName(el, "rightBorder")),
          top: parseEdge(findChildByLocalName(el, "topBorder")),
          bottom: parseEdge(findChildByLocalName(el, "bottomBorder")),
        }
        const fillBrush = findChildByLocalName(el, "fillBrush")
        const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null
        const face = winBrush?.getAttribute("faceColor")
        if (face && face.toLowerCase() !== "none") bf.fill = face
        styles.borderFill.set(id, bf)
      }
    }
    const children = el.childNodes
    for (let i = 0; i < children.length; i++) {
      const ch = children[i]
      if (ch.nodeType === 1) walk(ch as Element)
    }
  }
  walk(root)
  for (const [id, tab] of paraTabRef) {
    const g = styles.paraGeom.get(id)
    if (g && autoTabPr.has(tab)) g.autoTabLeft = true
  }
  return styles
}
