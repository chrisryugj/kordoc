/**
 * 왕복 채널 run-span 판독 (section-walker.ts에서 분리) — 인라인 강조 span·인용 paraPr·gongmun
 * 들여쓰기 depth 역산. 자사 생성 파일(content.hpf kordoc-layout) + 외래 실속성 볼드/이탤릭.
 */

import type { IRSpan } from "../types.js"
import { extractTextFromNode, type WalkCtx } from "./parser-shared.js"

/** kordoc 생성 default 레이아웃의 인라인 코드 charPr id (gen-ids CHAR_CODE와 동기) */
const KORDOC_CHAR_CODE = "4"
/** kordoc 생성 default 레이아웃의 인용문 paraPr id (gen-ids PARA_QUOTE와 동기) */
export const KORDOC_PARA_QUOTE = "6"

/**
 * run-span 채널 모드 (v4.0.5 확장) — kordoc: 자사 default 레이아웃(고정 id 규약 전부),
 * gongmun: 자사 공문서 레이아웃(기본 charPr 0~10 블록은 default와 동일 — id4 code 유효.
 * 단 구조 볼드(report 1단계 □ 전체 CHAR_BOLD 등)가 있어 혼합 가드 필수),
 * foreign: 메타 없는 외래 한컴 문서(실속성 볼드/이탤릭만 — id 규약 없음).
 * 미지의 자사 레이아웃 값은 null — 채널 꺼짐 (id 재배치 오검출 가드).
 */
export type SpanMode = "kordoc" | "gongmun" | "foreign"

export function spanModeOf(layout: string | null | undefined): SpanMode | null {
  if (layout === "default") return "kordoc"
  if (layout === "gongmun") return "gongmun"
  if (!layout) return "foreign"
  return null
}

/**
 * 문단 직계 run들의 인라인 강조 span 추출. 볼드/이탤릭은 charPr id가
 * 아니라 styleMap 실속성(<hh:bold/> 등)으로 읽고, 코드만 고정 id로 식별한다(자사 한정).
 * 개체(표·이미지·수식 등)나 run 외 요소가 섞인 문단, 서식 span이 하나도 없는 문단은
 * null — 평문 경로 유지 (마커 재방출 이득이 없으면 켜지 않는다).
 * requireMixed: 무서식 span과 서식 span이 공존할 때만 인정 — 전체가 서식인 문단은
 * 구조적 서식(gongmun 1단계 볼드, 표 헤더행 볼드 등)일 개연성이 높아 마커를 억제한다.
 */
export function extractRunSpans(para: Element, ctx: WalkCtx, mode: SpanMode, requireMixed: boolean): IRSpan[] | null {
  const styleMap = ctx.styleMap
  if (!styleMap) return null
  const spans: IRSpan[] = []
  let styled = false
  const kids = para.childNodes
  if (!kids) return null
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag === "linesegarray") continue // 조판 캐시 — 텍스트 무관
    if (tag !== "run" && tag !== "r") return null
    let text = ""
    const rkids = child.childNodes
    for (let j = 0; j < (rkids?.length ?? 0); j++) {
      const rc = rkids![j] as Element
      if (rc.nodeType !== 1) continue
      const rtag = (rc.tagName || rc.localName || "").replace(/^[^:]+:/, "")
      if (rtag === "t") {
        const tkids = rc.childNodes
        for (let k = 0; k < (tkids?.length ?? 0); k++) {
          const tk = tkids![k]
          if (tk.nodeType === 3 || tk.nodeType === 4) text += tk.textContent || ""
          else if (tk.nodeType === 1) {
            // 탭·빈칸 컨트롤은 공백(평문 경로와 같은 모델 — 항목부호 뒤 탭 run 이 강조 복원을 막지 않게),
            // 줄바꿈 등 나머지는 평문 경로
            const ttag = ((tk as Element).tagName || (tk as Element).localName || "").replace(/^[^:]+:/, "")
            if (ttag === "tab" || ttag === "fwSpace" || ttag === "hwSpace" || ttag === "nbSpace") text += " "
            else return null
          }
        }
      } else if (rtag === "secPr" || rtag === "colPr") {
        // 첫 run이 나르는 섹션 속성 — 텍스트 무관
      } else if (rtag === "ctrl") {
        if (extractTextFromNode(rc)) return null
      } else {
        return null // 표·이미지·수식 등 개체 동반 문단
      }
    }
    if (!text) continue
    const prId = child.getAttribute("charPrIDRef") ?? ""
    const cp = styleMap.charProperties.get(prId)
    const span: IRSpan = { text }
    if (mode !== "foreign" && prId === KORDOC_CHAR_CODE) span.code = true
    else {
      if (cp?.bold) span.bold = true
      if (cp?.italic) span.italic = true
      if (cp?.strike) span.strike = true
      if (cp?.underline) span.underline = true
    }
    if (span.bold || span.italic || span.strike || span.underline || span.code) styled = true
    spans.push(span)
  }
  if (!styled || spans.length === 0) return null
  // 인접 동일 서식 span 병합 — 한컴은 편집 이력 경계에서 같은 서식 run을 임의 분할
  // 하므로(외래 문서) 그대로 두면 run마다 마커 쌍이 생긴다('**안****녕**' 오염)
  const merged: IRSpan[] = []
  for (const s of spans) {
    const last = merged[merged.length - 1]
    if (last && !!last.bold === !!s.bold && !!last.italic === !!s.italic && !!last.strike === !!s.strike && !!last.underline === !!s.underline && !!last.code === !!s.code) {
      last.text += s.text
    } else {
      merged.push(s)
    }
  }
  // requireMixed(구조적 서식 억제)는 bold/italic 에만 적용 — 취소선·밑줄은 전체 문단이
  // 통째로 그어진 경우(법령 개정문 삭제 조문·개정 표시)가 정상 패턴이라 억제하지 않는다
  if (requireMixed && !merged.some((s) => s.strike || s.underline) && !merged.some((s) => !(s.bold || s.italic || s.code))) return null
  return merged
}

/**
 * gongmun levelIndent 역산 (v4.0.5) — left = depth × 본문크기(standard/report) 또는
 * 개조식 반계단(1.0/1.5/2.0, 이후 +0.5/단계) × 본문크기 HWPUNIT. 단위는 문단 첫 run의
 * charPr 글자크기(pt×100 = HWPUNIT)로 도출 — 생성기 levelIndent가 bodyHeight를 쓰는
 * 것의 미러. 부호 시퀀스상 md 충돌 부호('-'·'*'·'N)')는 전부 법정 2단계에서만 나오므로
 * 역산 결과는 사실상 2 — 그래도 파일 자체가 정본이 되게 지문으로 산출한다.
 */
export function gongmunDepthFromIndent(para: Element, left: number, ctx: WalkCtx): number | null {
  const styleMap = ctx.styleMap
  if (!styleMap) return null
  let unit = 0
  const kids = para.childNodes
  for (let i = 0; i < (kids?.length ?? 0); i++) {
    const child = kids[i] as Element
    if (child.nodeType !== 1) continue
    const tag = (child.tagName || child.localName || "").replace(/^[^:]+:/, "")
    if (tag !== "run" && tag !== "r") continue
    const size = styleMap.charProperties.get(child.getAttribute("charPrIDRef") ?? "")?.fontSize
    if (size) unit = size * 100
    break
  }
  if (!unit) return null
  const r = left / unit
  const nearInt = Math.round(r)
  // 정수배 = standard/report(depth=r), x.5 계단 = 개조식(depth = 2r-1: 1.5→2, 2.5→4)
  const depth = Math.abs(r - nearInt) < 0.2 ? nearInt : Math.round(2 * r - 1)
  return depth >= 1 && depth < 8 ? depth : null
}
