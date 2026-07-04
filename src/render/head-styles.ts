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
  return g
}

/** header.xml(구버전 head.xml) → 렌더용 스타일 맵 */
export function parseRenderStyles(headXml: string): RenderStyles {
  const styles: RenderStyles = { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map() }
  const doc = createXmlParser().parseFromString(headXml, "text/xml")
  const root = doc.documentElement as unknown as Element | null
  if (!root) return styles

  const walk = (el: Element): void => {
    const tag = (el.tagName || "").replace(/^[^:]+:/, "")
    if (tag === "charPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const ratioEl = findChildByLocalName(el, "ratio")
        const spacingEl = findChildByLocalName(el, "spacing")
        const underlineEl = findChildByLocalName(el, "underline")
        const textColor = el.getAttribute("textColor")
        styles.charPr.set(id, {
          height: Number(el.getAttribute("height")) || 1000,
          bold: findChildByLocalName(el, "bold") != null,
          italic: findChildByLocalName(el, "italic") != null,
          underline: underlineEl != null && (underlineEl.getAttribute("type") ?? "NONE") !== "NONE",
          color: textColor && textColor !== "#000000" && textColor.toLowerCase() !== "none" ? textColor : undefined,
          ratio: Number(ratioEl?.getAttribute("hangul")) || 100,
          spacing: Number(spacingEl?.getAttribute("hangul")) || 0,
        })
      }
    } else if (tag === "paraPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const align = findChildByLocalName(el, "align")
        styles.paraAlign.set(id, (align?.getAttribute("horizontal") as ParaAlign) || "JUSTIFY")
        styles.paraGeom.set(id, parseParaGeom(el))
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
  return styles
}
