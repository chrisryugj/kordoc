/**
 * HWPX 파서 공유 상수/타입/유틸 (parser.ts에서 분리).
 * ZIP 한도, 섹션 공유 상태(SectionShared), walk 컨텍스트(WalkCtx), XML 유틸.
 */

import { DOMParser } from "@xmldom/xmldom"
import { KordocError } from "../utils.js"
import type { CellContext, IRBlock, ParseWarning } from "../types.js"
// WalkCtx.styleMap 타입 참조 — 타입 전용이라 styles.ts와의 순환은 컴파일 시 소거됨
import type { HwpxStyleMap } from "./styles.js"

export const MAX_DECOMPRESS_SIZE = 100 * 1024 * 1024
/** 손상 ZIP 복구 시 최대 엔트리 수 */
export const MAX_ZIP_ENTRIES = 500

/** colSpan/rowSpan을 안전한 범위로 클램핑 */
export function clampSpan(val: number, max: number): number {
  return Math.max(1, Math.min(val, max))
}

/** XML DOM 재귀 최대 깊이 — 악성 파일의 스택 오버플로 방지.
 *  좌표계가 다른 hwp5 MAX_NEST_DEPTH(8, 표 중첩 단계)·filler/소스맵 16
 *  (표 중첩 단계)과 달리 이건 "XML 요소" 깊이라 표 1단이 여러 depth를
 *  소모한다 — 상수 통일 금지 (의미가 다름) */
export const MAX_XML_DEPTH = 200

/** 셀 컨텍스트 확장 — 중첩표/이미지/다중문단 블록과 제목셀 여부를 IRCell로 전달 (v3.0) */
export interface CellCtxEx extends CellContext {
  blocks?: IRBlock[]
  /** 중첩표/이미지 등 구조 콘텐츠 존재 — true일 때만 IRCell.blocks로 attach */
  hasStructure?: boolean
  isHeader?: boolean
}

export interface TableState {
  rows: CellContext[][]
  currentRow: CellContext[]
  cell: CellCtxEx | null
  /** hp:caption 텍스트 — IRTable.caption으로 전달 (v3.0) */
  caption?: string
}

/** 섹션 간 공유 상태 — 자동번호 카운터, 머리말/꼬리말, 변경추적 */
export interface SectionShared {
  /** numbering id → 레벨별(1..10) 카운터. 0 = 미사용(start값으로 초기화) */
  numState: Map<string, number[]>
  pageText: { headers: string[]; footers: string[] }
  track: { deleteDepth: number; warned: boolean }
}

export function createSectionShared(): SectionShared {
  return { numState: new Map(), pageText: { headers: [], footers: [] }, track: { deleteDepth: 0, warned: false } }
}

/** walk 함수들이 공유하는 파싱 컨텍스트 — 개별 optional 파라미터를 하나로 묶어 시그니처 안정화 */
export interface WalkCtx {
  styleMap?: HwpxStyleMap
  warnings?: ParseWarning[]
  sectionNum?: number
  shared: SectionShared
  /** secPr outlineShapeIDRef — 개요(OUTLINE) 문단이 사용하는 numbering id */
  outlineNumId?: string
}

/** xmldom DOMParser 생성 — onError 콜백으로 malformed XML 경고 수집 */
export function createXmlParser(warnings?: ParseWarning[]): DOMParser {
  return new DOMParser({
    onError(level: "warning" | "error" | "fatalError", msg: string) {
      if (level === "fatalError") throw new KordocError(`XML 파싱 실패: ${msg}`)
      warnings?.push({ code: "MALFORMED_XML", message: `XML ${level === "warning" ? "경고" : "오류"}: ${msg}` })
    },
  })
}

/** 수집된 머리말/꼬리말을 본문 앞/뒤 문단으로 배치 */
export function applyPageText(blocks: IRBlock[], shared: SectionShared): void {
  const { headers, footers } = shared.pageText
  if (headers.length > 0) {
    blocks.unshift(...headers.map(t => ({ type: "paragraph" as const, text: t, pageNumber: 1 })))
  }
  if (footers.length > 0) {
    blocks.push(...footers.map(t => ({ type: "paragraph" as const, text: t })))
  }
}

/** 자식 중 지정된 localName(접두사 제거)을 가진 첫 번째 Element 반환 */
export function findChildByLocalName(parent: Element, name: string): Element | null {
  const children = parent.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === name) return ch
  }
  return null
}

/** 노드 내 모든 텍스트를 재귀적으로 추출 */
export function extractTextFromNode(node: Node): string {
  let result = ""
  const children = node.childNodes
  if (!children) return result
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    if (child.nodeType === 3) result += child.textContent || ""
    else if (child.nodeType === 1) result += extractTextFromNode(child)
  }
  return result.trim()
}
