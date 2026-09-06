/**
 * 생성용 charPr/paraPr/글꼴 동적 레지스트리 (v5).
 *
 * 종전에는 charPr·paraPr id를 모듈마다 손계산(정적 블록 + variant×4 + 프로필 + docframe +
 * levels …)으로 이어 써서 한 칸 밀리면 무음 서식 오염이 났다(P0-1). 여기서는 필요한
 * 스타일을 스펙으로 요청하면 같은 스펙은 같은 id를 돌려주고, header.xml 조립 때 방출
 * 순서 = id 순서로 일괄 붙인다. 시작 id는 호출자가 정적 블록 크기에서 넘긴다.
 */

import { charPr as charPrXml, paraPr as paraPrXml } from "./gen-ids.js"

export interface CharSpec {
  font: string
  pt: number
  bold?: boolean
  italic?: boolean
  /** 장평 % (기본 100) */
  ratio?: number
  /** 자간 % (기본 0) */
  spacing?: number
  color?: string
}

export interface ParaSpec {
  align?: "LEFT" | "CENTER" | "RIGHT" | "JUSTIFY" | "DISTRIBUTE"
  left?: number
  /** 오른쪽 여백(HWPUNIT) — 요약박스 등 셀 안 문단 좌우 여백 */
  right?: number
  indent?: number
  before?: number
  after?: number
  lineSp?: number
  keepWithNext?: boolean
  /** 어절 단위 줄바꿈(공문서 기본 true) */
  keepWord?: boolean
}

export class StyleRegistry {
  private chars = new Map<string, number>()
  private charXmls: string[] = []
  private paras = new Map<string, number>()
  private paraXmls: string[] = []
  private fonts = new Map<string, number>()
  private fontList: string[] = []

  /**
   * @param charBase  첫 charPr id (정적 charPr 블록 다음)
   * @param paraBase  첫 paraPr id
   * @param fontBase  첫 append 글꼴 id (정적 fontface 다음 — HANGUL·LATIN에만 append)
   * @param staticFonts 정적 fontface 목록 (id 순) — 같은 이름이면 정적 id 재사용
   */
  constructor(private charBase: number, private paraBase: number, private fontBase: number, staticFonts: string[] = []) {
    staticFonts.forEach((f, i) => { if (!this.fonts.has(f)) this.fonts.set(f, i) })
  }

  font(face: string): number {
    const hit = this.fonts.get(face)
    if (hit !== undefined) return hit
    const id = this.fontBase + this.fontList.length
    this.fonts.set(face, id)
    this.fontList.push(face)
    return id
  }

  char(spec: CharSpec): number {
    const key = `${spec.font}|${spec.pt}|${spec.bold ? 1 : 0}|${spec.italic ? 1 : 0}|${spec.ratio ?? 100}|${spec.spacing ?? 0}|${spec.color ?? "#000000"}`
    const hit = this.chars.get(key)
    if (hit !== undefined) return hit
    const id = this.charBase + this.charXmls.length
    const fontId = this.font(spec.font)
    // 한글·라틴만 지정 글꼴, 그 외 언어는 0 (HANJA 이하 fontface는 1종만 있어 append id가 없다)
    // 나머지 언어 슬롯도 같은 글꼴 — 7슬롯이 같아야 한컴 툴바가 글꼴명을 보여준다(전 언어 목록 동일, gen-header)
    this.charXmls.push(charPrXml(id, Math.round(spec.pt * 100), !!spec.bold, !!spec.italic, fontId, spec.color ?? "#000000", spec.ratio ?? 100, fontId, spec.spacing ?? 0))
    this.chars.set(key, id)
    return id
  }

  para(spec: ParaSpec): number {
    const key = `${spec.align ?? "JUSTIFY"}|${spec.left ?? 0}|${spec.right ?? 0}|${spec.indent ?? 0}|${spec.before ?? 0}|${spec.after ?? 0}|${spec.lineSp ?? 160}|${spec.keepWithNext ? 1 : 0}|${spec.keepWord === false ? 0 : 1}`
    const hit = this.paras.get(key)
    if (hit !== undefined) return hit
    const id = this.paraBase + this.paraXmls.length
    this.paraXmls.push(paraPrXml(id, {
      align: spec.align ?? "JUSTIFY", left: spec.left ?? 0, right: spec.right ?? 0, indent: spec.indent ?? 0,
      spaceBefore: spec.before ?? 0, spaceAfter: spec.after ?? 0, lineSpacing: spec.lineSp ?? 160,
      keepWithNext: !!spec.keepWithNext, keepWord: spec.keepWord !== false,
    }))
    this.paras.set(key, id)
    return id
  }

  get charPrXmls(): string[] { return this.charXmls }
  get paraPrXmls(): string[] { return this.paraXmls }
  /** append 글꼴(정적 목록 제외) — fontBase부터 순서대로 */
  get extraFonts(): string[] { return this.fontList }
}
