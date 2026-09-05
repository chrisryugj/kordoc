/**
 * 항목부호 단계별 위계 타이포(levels 옵션, v4.12.3) — 단계 전용 charPr·fontface 계획.
 *
 * 실측 근거(docs/gongmunseo-reference.md 2.7): 실결재 기안문의 □/ㅇ/- 계열은 □=HY견고딕
 * +2~3pt bold, ㅇ=한컴돋움 bold, -=휴먼명조 본문이 지배 관행이지만 법정 8단계(1. 가. 1))는
 * 본문과 동일이 90%다. 그래서 기본값은 손대지 않고, 지정한 단계만 전용 charPr 한 쌍
 * (보통·굵게)을 docframe charPr 뒤 id 에 방출한다. 글꼴은 정적 fontface 뒤에 append 하고
 * 한글·라틴만 참조(그 외 언어는 본문 글꼴) — 비실측 프리셋의 HANJA 이하 1종 언어 테이블에
 * 없는 id 를 가리키지 않는다(프로필 append 글꼴과 같은 규약).
 */

import { charPr, GONGMUN_BODY_RATIO } from "./gen-ids.js"
import type { ResolvedGongmun } from "./gongmun.js"

/** depth → 전용 charPr id (보통·굵게) */
export type LevelCharIds = Record<number, { normal: number; bold: number }>

/** levels 가 지정된 depth 오름차순 목록 */
export function levelDepths(g: ResolvedGongmun): number[] {
  return g.levels ? Object.keys(g.levels).map(Number).sort((a, b) => a - b) : []
}

/** append 할 글꼴명(중복 제거, depth 순) — fontface id = fontBase + 인덱스 */
export function levelFontFaces(g: ResolvedGongmun): string[] {
  const out: string[] = []
  for (const d of levelDepths(g)) {
    const f = g.levels![d].font
    if (f && !out.includes(f)) out.push(f)
  }
  return out
}

/** depth → charPr id 배정 — base 부터 depth 순으로 2개씩 */
export function levelCharIds(g: ResolvedGongmun, base: number): LevelCharIds | null {
  const depths = levelDepths(g)
  if (depths.length === 0) return null
  const ids: LevelCharIds = {}
  depths.forEach((d, i) => { ids[d] = { normal: base + i * 2, bold: base + i * 2 + 1 } })
  return ids
}

/**
 * 단계 전용 charPr XML — levelCharIds 와 같은 순서. bodyFontId 는 본문 글꼴(비실측 0·rich 4),
 * fontBase 는 append 글꼴 첫 id. 장평은 본문 항목과 같은 95%(bold 만 바꿔도 줄 길이 불변).
 */
export function levelCharPrXmls(g: ResolvedGongmun, base: number, fontBase: number, bodyFontId: number): string[] {
  const ids = levelCharIds(g, base)
  if (!ids) return []
  const faces = levelFontFaces(g)
  const out: string[] = []
  for (const d of levelDepths(g)) {
    const st = g.levels![d]
    const fontId = st.font ? fontBase + faces.indexOf(st.font) : bodyFontId
    // 굵기 오버라이드가 없는 단계도 인라인 **강조** 용 bold 짝을 낸다
    out.push(charPr(ids[d].normal, st.height, st.bold, false, fontId, undefined, GONGMUN_BODY_RATIO, bodyFontId))
    out.push(charPr(ids[d].bold, st.height, true, false, fontId, undefined, GONGMUN_BODY_RATIO, bodyFontId))
  }
  return out
}
