/**
 * 섹션 워커(section-walker.ts)가 쓰는 말단 판독 도우미 — 재귀 클러스터(walkSection ↔ extractParagraphInfo …)를 다시 부르지 않는
 * 요소 판정(kordoc 마커 칸·쪽 번호 autoNum·개체 하위·인라인 표)·fieldBegin 매개변수(누름틀 안내문·하이퍼링크)·양식 단추 글.
 */

import { sanitizeHref } from "../utils.js"
import type { IRSpan } from "../types.js"
import { findChildByLocalName, MAX_XML_DEPTH, type WalkCtx } from "./parser-shared.js"

/** tbl 하위에서 __kordoc_ 마커 셀 탐색 (중첩표 안까지는 내려가지 않음) */
export function findKordocMarkedCell(el: Node, depth: number): { cell: Element; name: string } | null {
  if (depth > 6) return null
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "tc") {
      const name = ch.getAttribute("name") || ""
      if (name.startsWith("__kordoc_")) return { cell: ch, name }
      continue // 셀 내부(중첩표)는 탐색하지 않음 — 최상위 표의 셀만
    }
    if (tag === "tbl" && depth > 0) continue // 중첩표 진입 금지
    const found = findKordocMarkedCell(ch, depth + 1)
    if (found) return found
  }
  return null
}

/** 머리말/꼬리말 subList에 페이지 번호 autoNum(numType=PAGE)이 있는지 검사 */
export function hasPageAutoNum(el: Node, depth = 0): boolean {
  if (depth > 10) return false
  const children = el.childNodes
  if (!children) return false
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag === "autoNum" && ch.getAttribute?.("numType") === "PAGE") return true
    if (hasPageAutoNum(ch, depth + 1)) return true
  }
  return false
}

/** 개체 요소 태그 — 빈 문단 보존(#57) 제외 판정용. walkParagraphChildren이 별도 방출하는 것들 */
export const OBJECT_TAGS = new Set(["tbl", "pic", "shape", "drawingObject", "drawText"])

/** 문단 하위에 표·그림·글상자 등 개체가 있는지 — 있으면 "빈 문단"이 아니라 개체 문단 (#57) */
export function hasObjectDescendant(node: Node, depth = 0): boolean {
  if (depth > MAX_XML_DEPTH) return false
  const kids = node.childNodes
  if (!kids) return false
  for (let i = 0; i < kids.length; i++) {
    const ch = kids[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (OBJECT_TAGS.has(tag)) return true
    if (hasObjectDescendant(ch, depth + 1)) return true
  }
  return false
}

/**
 * 글자취급(treatAsChar) 인라인 표 여부 — <hp:pos treatAsChar="1"> (#49/#50).
 * inline 표만 같은 줄 텍스트와 문서 순서로 읽는다 (reflow 개체 흐름 모델과 동일 구분)
 */
export function isInlineTbl(tbl: Element): boolean {
  return findChildByLocalName(tbl, "pos")?.getAttribute("treatAsChar") === "1"
}

/** 양식 단추 캡션을 그리는 최소 개체 폭 (HWPUNIT) — 상자(≈1,300)에 글자 한 자 이상이 들어갈 때만 한컴이 캡션을 인쇄한다.
 *  폭 1,297 인 선택 상자는 기본 캡션 "선택 상자"가 PDF 에 안 나온다(rhwp issue2470), 폭 4,000 이상은 캡션이 나온다(form-002·서울 결재) */
export const FORM_CAPTION_MIN_WIDTH = 2300

/** 양식 선택 상자(☐/☑)·라디오 단추(○/●)의 보이는 글 — bench/ref/hwpx-ref.mjs 와 같은 규칙 */
export function formButtonText(el: Element, radio: boolean): string {
  const checked = el.getAttribute("value") === "CHECKED"
  const mark = radio ? (checked ? "●" : "○") : (checked ? "☑" : "☐")
  const width = Number(findChildByLocalName(el, "sz")?.getAttribute("width") ?? 0)
  const caption = (el.getAttribute("caption") ?? "").trim()
  return caption && width >= FORM_CAPTION_MIN_WIDTH ? `${mark} ${caption}` : mark
}

/** 누름틀 안내문 구간 표지 — 문단 글 정리(공백 붕괴·링크 삽입·절단)를 거친 뒤 span 으로 가른다 */
export const PH_OPEN = "\x1C"
export const PH_CLOSE = "\x1D"

/**
 * 미기입 누름틀의 안내문 — CLICK_HERE 이고 수정 안 됨(dirty≠1)일 때만. 이런 필드의 값 자리 글이 안내문과
 * 같으면 한컴은 화면에만 흐리게 보이고 인쇄하지 않는다(한컴 PDF 실측, HWP5 body.ts 수정 비트 규칙과 같은 판정).
 * 안내문은 stringParam Direction, 없으면 Command 의 "Direction:wstring:<N>:" 뒤 N자.
 */
export function clickHereGuide(fieldBegin: Element): string | undefined {
  if ((fieldBegin.getAttribute("type") || "").toUpperCase() !== "CLICK_HERE") return undefined
  if (fieldBegin.getAttribute("dirty") === "1") return undefined
  const children = findChildByLocalName(fieldBegin, "parameters")?.childNodes
  if (!children) return undefined
  let fromCommand: string | undefined
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag !== "stringParam") continue
    const name = ch.getAttribute("name")
    if (name === "Direction") return ch.textContent || undefined
    if (name === "Command") {
      const cmd = ch.textContent || ""
      const m = /Direction:wstring:(\d+):/.exec(cmd)
      if (m) fromCommand = cmd.slice(m.index + m[0].length, m.index + m[0].length + Number(m[1])) || undefined
    }
  }
  return fromCommand
}

/** fieldBegin이 HYPERLINK면 stringParam name="Path"에서 URL 추출 (살균 포함) */
export function extractHyperlinkHref(fieldBegin: Element): string | undefined {
  if ((fieldBegin.getAttribute("type") || "").toUpperCase() !== "HYPERLINK") return undefined
  const params = findChildByLocalName(fieldBegin, "parameters")
  if (!params) return undefined
  const children = params.childNodes
  if (!children) return undefined
  for (let i = 0; i < children.length; i++) {
    const ch = children[i] as Element
    if (ch.nodeType !== 1) continue
    const tag = (ch.tagName || ch.localName || "").replace(/^[^:]+:/, "")
    if (tag !== "stringParam" || ch.getAttribute("name") !== "Path") continue
    let url = (ch.textContent || "").trim()
    if (!url) continue
    // 한컴이 중복 스킴을 저장하는 경우 정리 ("http://https://..." → "https://...")
    url = url.replace(/^https?:\/\/(?=https?:\/\/)/i, "")
    const safe = sanitizeHref(url)
    if (safe) return safe
  }
  return undefined
}

/** 변경추적 삭제 구간 내부 여부 */
export function isInDeletedRange(ctx?: WalkCtx): boolean {
  return (ctx?.shared.track.deleteDepth ?? 0) > 0
}

/** run 의 자식이 글(hp:t)·조판 캐시뿐인지 — 첨자 감싸기 대상 */
export function runHasOnlyText(run: Element): boolean {
  const kids = run.childNodes
  for (let i = 0; i < (kids?.length ?? 0); i++) {
    const k = kids![i] as Element
    if (k.nodeType !== 1) continue
    const t = (k.tagName || k.localName || "").replace(/^[^:]+:/, "")
    if (t !== "t" && t !== "linesegarray") return false
  }
  return true
}

/** 자동번호 접두가 붙은 문단이면 접두를 평문 span 으로 앞에 — span 을 이으면 블록 글과 같다 */
export function withPrefixSpan(spans: IRSpan[], prefix?: string): IRSpan[] {
  return prefix ? [{ text: prefix + " " }, ...spans] : spans
}

export function stripPlaceholderMarks(s: string): string {
  return s.includes(PH_OPEN) || s.includes(PH_CLOSE) ? s.replace(/[\x1C\x1D]/g, "") : s
}
