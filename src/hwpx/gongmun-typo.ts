/**
 * 공문서 v5 문자 다듬기 — 조판(폭 계산) 전에 본문 문자열에 적용한다.
 *
 * 1) 묶음 빈칸: 날짜(2026. 9. 23.)·연월(2026. 9.)·월일(9. 23.)·시각 범위(14:00 ~ 16:00)·금액의 "원" 앞
 *    공백(3억 원)을 U+00A0 으로 바꾼다. 생성기가 `<hp:nbSpace/>`(한글 묶음 빈칸)로 방출해 줄 끝에서
 *    "2026. 1. / 22." 처럼 갈라지지 않는다(한글 2024 실렌더 참조 PDF의 날짜 분리 4건).
 * 2) 따옴표: 곧은따옴표 ' " → ‘ ’ “ ” — 한글 입력 자동 고침과 같은 꼴. 휴먼명조·HY 글꼴의 곧은따옴표는
 *    여닫음 구분 없이 ’ 로 그려진다. 연도 약식 '26 은 ’26.
 *
 * 인라인 코드(`…`)·링크 URL(](…))은 건드리지 않는다. 순수 함수 — XML 은 모른다.
 */

import type { MdBlock } from "./md-runs.js"

export const NBSP = "\u00a0"

/** 앞 글자가 이 중 하나(또는 문두)면 여는 따옴표 — ">" 는 `<center>"…"` 같은 태그 뒤 */
const OPENER_BEFORE = /[\s(\[{>「『〈《【〔‘“·/:,~—–-]/u

function bindSpaces(s: string): string {
  return s
    // 연월일 — 연도는 4자리 또는 약식('26·’26)
    .replace(/(\d{4}|['’]\d{2})\. (\d{1,2})\. (\d{1,2})\.(?!\d)/g, `$1.${NBSP}$2.${NBSP}$3.`)
    // 연월 (위에서 연월일은 이미 묶였으므로 일반 공백이 남은 것만)
    .replace(/(\d{4}|['’]\d{2})\. (\d{1,2})\.(?!\d)/g, `$1.${NBSP}$2.`)
    // 월일 — 앞이 숫자·마침표가 아닐 때만(소수·버전 번호 제외)
    .replace(/(?<![\d.])(\d{1,2})\. (\d{1,2})\.(?!\d)/g, `$1.${NBSP}$2.`)
    // 시각 범위
    .replace(/(\d{1,2}:\d{2}) ([~∼-]) (\d{1,2}:\d{2})/g, `$1${NBSP}$2${NBSP}$3`)
    // 금액 — 숫자(+조·억·만·천) 뒤 " 원"
    .replace(/(\d(?:조|억|만|천)?) 원/g, `$1${NBSP}원`)
}

/** 강조 부호(* _ ~)를 건너뛴 앞뒤 실글자 */
function neighbor(s: string, i: number, dir: -1 | 1): string {
  for (let k = i + dir; k >= 0 && k < s.length; k += dir) if (!/[*_~]/.test(s[k])) return s[k]
  return ""
}

/** @param before 앞 구간(코드·링크)의 끝 글자 — 구간 첫머리 따옴표의 여닫음을 이어서 판정 */
function curlQuotes(s: string, before = ""): string {
  let out = ""
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c !== "'" && c !== '"') { out += c; continue }
    const prev = neighbor(s, i, -1) || before
    const opening = prev === "" || OPENER_BEFORE.test(prev)
    if (c === "'") {
      // 연도 약식 '26 — 숫자 두 자리 뒤에 닫는 따옴표가 없으면 아포스트로피
      if (opening && /^\d{2}(?![\d'])/.test(s.slice(i + 1))) { out += "’"; continue }
      out += opening ? "‘" : "’"
    } else {
      out += opening ? "“" : "”"
    }
  }
  return out
}

/** 본문 문자열 다듬기 — 코드·링크 URL 구간은 그대로 */
export function polishGongmunText(text: string): string {
  if (!text) return text
  let out = ""
  for (const [i, seg] of text.split(/(`[^`]*`|\]\([^)]*\))/).entries()) {
    // "'[링크](url)'" 의 닫는 따옴표처럼 구간 첫머리 따옴표는 앞 구간 끝 글자로 판정한다
    out += i % 2 === 1 ? seg : curlQuotes(bindSpaces(seg), out.replace(/[*_~]+$/, "").slice(-1))
  }
  return out
}

/** 마크다운 블록 다듬기 — 문단·헤딩·항목·인용·GFM 표 셀만(코드·수식·HTML 표 원문은 그대로). 개조식·보도자료 경로용 */
export function polishGongmunBlock(b: MdBlock): MdBlock {
  if (b.type === "table") return b.rows ? { ...b, rows: b.rows.map((r) => r.map(polishGongmunText)) } : b
  if (b.type === "paragraph" || b.type === "heading" || b.type === "list_item" || b.type === "blockquote") return b.text ? { ...b, text: polishGongmunText(b.text) } : b
  return b
}
