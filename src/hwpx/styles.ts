/**
 * HWPX 스타일 정보 파싱 + 스타일 기반 헤딩 감지 (parser.ts에서 분리).
 * head.xml/header.xml의 charPr/style/numbering/bullet/paraHead 추출.
 */

import type JSZip from "jszip"
import { KordocError, stripDtd } from "../utils.js"
import type { IRBlock, ParseWarning } from "../types.js"
import { HEADING_RATIO_H1, HEADING_RATIO_H2, HEADING_RATIO_H3 } from "../types.js"
import { createXmlParser, findChildByLocalName, MAX_DECOMPRESS_SIZE } from "./parser-shared.js"

// ─── HWPX 스타일 정보 ──────────────────────────────

export interface HwpxCharProperty {
  fontSize?: number  // 단위: pt (hwpx는 centi-pt → /100)
  bold?: boolean
  italic?: boolean
  strike?: boolean
  underline?: boolean
  fontName?: string
}

/**
 * 취소선 모양이 실제 선 종류(OWPML LineSym2, 표 27)인지 whitelist 판정.
 * 한컴 익스포터가 취소선 없는 charPr 에도 `<hh:strikeout shape="3D"/>` 류
 * placeholder 를 넣으므로, 존재 여부·비트만 믿으면 본문 전체가 취소선이 된다
 * (rhwp #154/0a967e0d 실측). 알 수 없는 값은 fail-closed 로 no-strike.
 */
export function isRealStrikeShape(shape: string): boolean {
  switch (shape) {
    case "SOLID": case "DASH": case "DOT": case "DASH_DOT": case "DASH_DOT_DOT":
    case "LONG_DASH": case "CIRCLE": case "DOUBLE_SLIM": case "SLIM_THICK":
    case "THICK_SLIM": case "SLIM_THICK_SLIM": case "WAVE": case "DOUBLE_WAVE":
      return true
    default:
      return false
  }
}

/** hh:numbering > hh:paraHead 한 수준의 정의 */
export interface ParaHeadDef {
  numFormat: string  // DIGIT, HANGUL_SYLLABLE, CIRCLED_DIGIT 등
  text: string       // "^1." 같은 치환 형식 문자열
  start: number
}

/** hh:numbering 정의 — 레벨(1..10) → paraHead */
export interface NumberingDef {
  heads: Map<number, ParaHeadDef>
}

/** hh:paraPr > hh:heading — 문단의 자동번호/글머리표/개요 연결 정보 */
export interface ParaHeadingRef {
  type: "NUMBER" | "BULLET" | "OUTLINE"
  idRef: string
  level: number  // 0-based (level="0" → paraHead level 1)
}

export interface HwpxStyleMap {
  charProperties: Map<string, HwpxCharProperty>  // id → property
  styles: Map<string, { name: string; charPrId?: string; paraPrId?: string }>  // id → style
  numberings: Map<string, NumberingDef>  // numbering id → 정의
  bullets: Map<string, string>           // bullet id → 글머리 문자
  paraHeadings: Map<string, ParaHeadingRef>  // paraPr id → heading 참조
  paraIndents: Map<string, { left: number; intent: number }>  // paraPr id → 들여쓰기(HWPUNIT, v4.0.4)
}

/** head.xml 또는 header.xml에서 스타일 정보 추출 */
export async function extractHwpxStyles(zip: JSZip, decompressed?: { total: number }): Promise<HwpxStyleMap> {
  const result: HwpxStyleMap = {
    charProperties: new Map(),
    styles: new Map(),
    numberings: new Map(),
    bullets: new Map(),
    paraHeadings: new Map(),
    paraIndents: new Map(),
  }

  const headerPaths = ["Contents/header.xml", "header.xml", "Contents/head.xml", "head.xml"]
  for (const hp of headerPaths) {
    const hpLower = hp.toLowerCase()
    const file = zip.file(hp) || Object.values(zip.files).find(f => f.name.toLowerCase() === hpLower) || null
    if (!file) continue

    try {
      const xml = await file.async("text")
      if (decompressed) {
        decompressed.total += xml.length * 2
        if (decompressed.total > MAX_DECOMPRESS_SIZE) throw new KordocError("ZIP 압축 해제 크기 초과 (ZIP bomb 의심)")
      }
      const parser = createXmlParser()
      const doc = parser.parseFromString(stripDtd(xml), "text/xml")
      if (!doc.documentElement) continue
      const domDoc = doc as unknown as Document

      // charProperties 파싱
      parseCharProperties(domDoc, result.charProperties)
      // styles 파싱
      parseStyleElements(domDoc, result.styles)
      // 자동번호/글머리표/개요 정의 파싱 (v3.0)
      parseNumberings(domDoc, result.numberings)
      parseBullets(domDoc, result.bullets)
      parseParaHeadings(domDoc, result.paraHeadings)
      parseParaIndents(domDoc, result.paraIndents)
      break
    } catch { continue }
  }

  return result
}

function parseCharProperties(doc: Document, map: Map<string, HwpxCharProperty>): void {
  // <hh:charPr> 또는 <charPr> 요소 탐색
  const tagNames = ["hh:charPr", "charPr", "hp:charPr"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || ""
      if (!id) continue

      const prop: HwpxCharProperty = {}

      // height 속성 (centi-pt 단위)
      const height = el.getAttribute("height")
      if (height) {
        const parsedHeight = parseInt(height, 10)
        if (!isNaN(parsedHeight) && parsedHeight > 0) {
          prop.fontSize = parsedHeight / 100
        }
      }

      // bold/italic — 정본은 자식 요소(<hh:bold/>) 존재. 속성형(bold="1")은 구버전
      // HWPML 계열 잔재라 둘 다 인정한다 (실측 한컴 HWPX는 요소만 씀)
      const bold = el.getAttribute("bold")
      if (bold === "true" || bold === "1") prop.bold = true
      const italic = el.getAttribute("italic")
      if (italic === "true" || italic === "1") prop.italic = true
      const kids = el.childNodes
      for (let j = 0; j < (kids?.length ?? 0); j++) {
        const k = kids[j] as Element
        if (k.nodeType !== 1) continue
        const localTag = (k.tagName || "").replace(/^[^:]+:/, "")
        if (localTag === "bold") prop.bold = true
        else if (localTag === "italic") prop.italic = true
        else if (localTag === "strikeout") {
          // shape whitelist — placeholder("3D"/"NONE" 등)는 취소선 아님
          const shape = k.getAttribute("shape") || ""
          if (isRealStrikeShape(shape)) prop.strike = true
        }
        else if (localTag === "underline") {
          // 판별자는 type — 한컴은 밑줄 없는 charPr 에도 type="NONE" 요소를 넣는다
          // (코퍼스 352파일 실측: NONE 15,603 / BOTTOM 156, TOP·CENTER 미관측).
          // BOTTOM 만 인정 — TOP(윗줄)·미지 값은 fail-closed
          if (k.getAttribute("type") === "BOTTOM") prop.underline = true
        }
      }

      // 하위 요소에서 fontface 탐색
      const fontFaces = el.getElementsByTagName("*")
      for (let j = 0; j < fontFaces.length; j++) {
        const ff = fontFaces[j]
        const localTag = (ff.tagName || "").replace(/^[^:]+:/, "")
        if (localTag === "fontface" || localTag === "fontRef") {
          const face = ff.getAttribute("face") || ff.getAttribute("FontFace")
          if (face) { prop.fontName = face; break }
        }
      }

      map.set(id, prop)
    }
  }
}

function parseStyleElements(doc: Document, map: Map<string, { name: string; charPrId?: string; paraPrId?: string }>): void {
  const tagNames = ["hh:style", "style", "hp:style"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || el.getAttribute("IDRef") || String(i)
      const name = el.getAttribute("name") || el.getAttribute("engName") || ""
      const charPrId = el.getAttribute("charPrIDRef") || undefined
      const paraPrId = el.getAttribute("paraPrIDRef") || undefined
      map.set(id, { name, charPrId, paraPrId })
    }
  }
}

/** header.xml의 hh:numbering(paraHead 7수준) 파싱 */
function parseNumberings(doc: Document, map: Map<string, NumberingDef>): void {
  const tagNames = ["hh:numbering", "numbering"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || ""
      if (!id) continue
      const def: NumberingDef = { heads: new Map() }
      const children = el.childNodes
      for (let j = 0; j < children.length; j++) {
        const ch = children[j] as Element
        if (ch.nodeType !== 1) continue
        const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
        if (tag !== "paraHead") continue
        const level = parseInt(ch.getAttribute("level") || "", 10)
        if (isNaN(level) || level < 1 || level > 10) continue
        const start = parseInt(ch.getAttribute("start") || "1", 10)
        def.heads.set(level, {
          numFormat: ch.getAttribute("numFormat") || "DIGIT",
          text: ch.textContent || "",
          start: isNaN(start) ? 1 : start,
        })
      }
      if (def.heads.size > 0) map.set(id, def)
    }
    if (map.size > 0) break
  }
}

/** header.xml의 hh:bullet 파싱 — id → 글머리 문자 (PUA는 builder의 mapPuaText가 치환) */
function parseBullets(doc: Document, map: Map<string, string>): void {
  const tagNames = ["hh:bullet", "bullet"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || ""
      const char = el.getAttribute("char") || ""
      if (id && char) map.set(id, char)
    }
    if (map.size > 0) break
  }
}

/**
 * header.xml의 hh:paraPr > hh:margin 파싱 — 문단 속성 id → 들여쓰기(HWPUNIT) (v4.0.4).
 * hc:left(단계 들여쓰기 누적)와 hc:intent(첫 줄 — 음수=내어쓰기)를 자식요소형에서 읽는다
 * (속성형 indent="…"는 한컴이 무시하는 형식이라 여기서도 읽지 않음 — 생성기 규약과 동일).
 * IRBlock.indent 슬롯의 원료 — gongmun 리스트 depth 재유도 등 소비자 몫.
 */
function parseParaIndents(doc: Document, map: Map<string, { left: number; intent: number }>): void {
  const tagNames = ["hh:paraPr", "paraPr"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || ""
      if (!id) continue
      const margin = findChildByLocalName(el, "margin")
      if (!margin) continue
      const readHu = (name: string): number => {
        const child = findChildByLocalName(margin, name)
        const v = parseInt(child?.getAttribute("value") || child?.textContent || "", 10)
        return Number.isFinite(v) ? v : 0
      }
      const left = readHu("left")
      const intent = readHu("intent")
      if (left !== 0 || intent !== 0) map.set(id, { left, intent })
    }
    if (map.size > 0) break
  }
}

/** header.xml의 hh:paraPr > hh:heading 파싱 — 문단 속성 id → NUMBER/BULLET/OUTLINE 참조 */
function parseParaHeadings(doc: Document, map: Map<string, ParaHeadingRef>): void {
  const tagNames = ["hh:paraPr", "paraPr"]
  for (const tagName of tagNames) {
    const elements = doc.getElementsByTagName(tagName)
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i]
      const id = el.getAttribute("id") || ""
      if (!id) continue
      const heading = findChildByLocalName(el, "heading")
      if (!heading) continue
      const type = heading.getAttribute("type") || "NONE"
      if (type !== "NUMBER" && type !== "BULLET" && type !== "OUTLINE") continue
      const level = parseInt(heading.getAttribute("level") || "0", 10)
      map.set(id, {
        type,
        idRef: heading.getAttribute("idRef") || "0",
        level: isNaN(level) ? 0 : Math.max(0, Math.min(level, 9)),
      })
    }
    if (map.size > 0) break
  }
}


// ─── 헤딩 감지 (스타일 기반) ────────────────────────

/** HWPX 스타일 기반 헤딩 감지 */
export function detectHwpxHeadings(blocks: IRBlock[], styleMap: HwpxStyleMap): void {
  // outline(개요) 기반 헤딩이 이미 감지된 문서는 폰트크기 휴리스틱 생략 — outline이 권위 정보
  if (blocks.some(b => b.type === "heading")) return

  // 본문 폰트 크기 결정
  let baseFontSize = 0
  const sizeFreq = new Map<number, number>()
  for (const b of blocks) {
    if (b.style?.fontSize) {
      sizeFreq.set(b.style.fontSize, (sizeFreq.get(b.style.fontSize) || 0) + 1)
    }
  }
  let maxCount = 0
  for (const [size, count] of sizeFreq) {
    if (count > maxCount) { maxCount = count; baseFontSize = size }
  }

  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) continue
    const text = block.text.trim()
    if (text.length === 0 || text.length > 200 || /^\d+$/.test(text)) continue

    let level = 0

    // 폰트 크기 기반
    if (baseFontSize > 0 && block.style?.fontSize) {
      const ratio = block.style.fontSize / baseFontSize
      if (ratio >= HEADING_RATIO_H1) level = 1
      else if (ratio >= HEADING_RATIO_H2) level = 2
      else if (ratio >= HEADING_RATIO_H3) level = 3
    }

    // "제N조/장/절" 패턴 — 균등배분 공백 허용 ("제 1 장" → "제1장")
    const compactText = text.replace(/\s+/g, "")
    if (/^제\d+[조장절편]/.test(compactText) && text.length <= 50) {
      if (level === 0) level = 3
    }

    if (level > 0) {
      block.type = "heading"
      block.level = level
    }
  }
}
