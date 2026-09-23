/**
 * 각주·미주 번호 표기 (v4.14.3) — 본문 참조 부호("1)"·"문1）"·"*")와 주석 본문 머리 번호.
 *
 * 한컴은 각주/미주 개체 자리에 참조 부호를 그리고, 주석 영역 첫머리에는 주석 본문 안의
 * hp:autoNum(numType=FOOTNOTE|ENDNOTE)이 같은 부호를 그린다. hp:t 원문엔 둘 다 없다
 * (한컴 PDF 실렌더: footnote-01 "플라스틱 액체1)와 …" / 주석 "1) 플라스틱 액체란",
 * 3-09월_교육_통합 본문 "문1）" / 미주 "문1） ④"). HWP5 파서(body.ts applyNoteEffect)와
 * 같은 표기라 hwp↔hwpx 쌍 대조가 맞는다.
 *
 * 파서(section-walker)와 패치 매퍼(roundtrip)가 같은 규칙을 쓰도록 DOM 비의존 순수 함수로 둔다 —
 * 매퍼는 파서가 끼운 부호를 문단 텍스트에서 되빼야 소스맵 대조가 된다.
 */

import { formatHeadNumber } from "./para-heading.js"
import { findChildByLocalName } from "../shared/xml.js"

/** secPr footNotePr/endNotePr > autoNumFormat 또는 hp:autoNum > autoNumFormat — 리터럴 문자 속성 */
export interface NoteNumberFormat {
  /** DIGIT·USER_CHAR·CIRCLED_DIGIT 등 (para-heading numFormat 과 같은 이름) */
  type: string
  userChar: string
  prefixChar: string
  suffixChar: string
}

/** hp:footNote/hp:endNote 여는 태그 속성 — 코드포인트 10진 문자열 그대로 (없으면 null) */
export interface NoteAttrs {
  number?: string | null
  prefixChar?: string | null
  suffixChar?: string | null
  userChar?: string | null
}

/** 코드포인트 10진 속성 → 문자. 속성 없음은 undefined(구역 기본값으로), 0 은 "" */
function codePointAttr(v: string | null | undefined): string | undefined {
  if (v == null || v === "") return undefined
  const n = parseInt(v, 10)
  if (!Number.isFinite(n) || n < 0 || n > 0x10ffff) return undefined
  return n === 0 ? "" : String.fromCodePoint(n)
}

/** 속성 조회 함수로 autoNumFormat 읽기 — DOM(getAttribute)·정규식 스캐너 공용 */
export function noteFormatFrom(get: (name: string) => string | null | undefined): NoteNumberFormat {
  return {
    type: get("type") || "DIGIT",
    userChar: get("userChar") ?? "",
    prefixChar: get("prefixChar") ?? "",
    suffixChar: get("suffixChar") ?? "",
  }
}

/** 번호 본체 — USER_CHAR 는 사용자 문자, 나머지는 자동번호 서식 */
function noteCore(num: number, fmt: NoteNumberFormat, userChar?: string): string {
  if (fmt.type === "USER_CHAR") return userChar ?? fmt.userChar
  return formatHeadNumber(num, fmt.type)
}

/**
 * 본문 참조 부호 — 개체 속성(number·prefixChar·suffixChar·userChar)이 우선, 없으면 구역
 * 번호 모양(secPr footNotePr/endNotePr). 둘 다 없으면 한컴 기본 "N)".
 * (한컴은 기본값과 같은 장식 속성을 생략해 저장한다 — USER_CHAR "*" 각주는 suffixChar 없이
 * 구역 모양 suffixChar="" 만 가진다, issue6044)
 */
export function noteRefMark(attrs: NoteAttrs, fmt?: NoteNumberFormat): string {
  const f = fmt ?? { type: "DIGIT", userChar: "", prefixChar: "", suffixChar: ")" }
  const n = parseInt(attrs.number ?? "", 10)
  const prefix = codePointAttr(attrs.prefixChar) ?? f.prefixChar
  const suffix = codePointAttr(attrs.suffixChar) ?? f.suffixChar
  return prefix + noteCore(Number.isFinite(n) ? n : 1, f, codePointAttr(attrs.userChar)) + suffix
}

/** 주석 본문 안 hp:autoNum(FOOTNOTE|ENDNOTE) 표기 — autoNumFormat 리터럴 그대로 */
export function noteAutoNumText(num: string | null | undefined, fmt: NoteNumberFormat): string {
  const n = parseInt(num ?? "", 10)
  return fmt.prefixChar + noteCore(Number.isFinite(n) ? n : 1, fmt) + fmt.suffixChar
}

/**
 * 본문에 그리는 자동번호 종류 — 주석 머리 번호(FOOTNOTE·ENDNOTE)와 캡션 번호(PICTURE·TABLE·EQUATION,
 * "<그림 1>" — 한컴 실렌더·HWP5 파서 모두 방출). 쪽번호(PAGE·TOTAL_PAGE)는 머리말·꼬리말 쪽번호
 * 크롬이라 종전대로 미방출
 */
export function isRenderedAutoNum(numType: string | null | undefined): boolean {
  return numType === "FOOTNOTE" || numType === "ENDNOTE" || numType === "PICTURE" || numType === "TABLE" || numType === "EQUATION"
}

// ─── DOM 어댑터 (파서 전용) ───────────────────────────

/** hp:footNote/hp:endNote 요소 → 속성 묶음 */
export function noteAttrsOf(el: Element): NoteAttrs {
  return {
    number: el.getAttribute("number"),
    prefixChar: el.getAttribute("prefixChar"),
    suffixChar: el.getAttribute("suffixChar"),
    userChar: el.getAttribute("userChar"),
  }
}

/** 구역 첫 secPr 의 footNotePr/endNotePr > autoNumFormat */
export function readSectionNoteFormats(root: Element): { footnote?: NoteNumberFormat; endnote?: NoteNumberFormat } {
  const out: { footnote?: NoteNumberFormat; endnote?: NoteNumberFormat } = {}
  const pick = (names: string[]): NoteNumberFormat | undefined => {
    for (const name of names) {
      const els = root.getElementsByTagName(name)
      if (els.length === 0) continue
      const f = findChildByLocalName(els[0], "autoNumFormat")
      return f ? noteFormatFrom(n => f.getAttribute(n)) : undefined
    }
    return undefined
  }
  out.footnote = pick(["hp:footNotePr", "footNotePr"])
  out.endnote = pick(["hp:endNotePr", "endNotePr"])
  return out
}

/** hp:autoNum 요소 → 표기 (주석·캡션 번호), 쪽번호 등 다른 종류면 "" */
export function noteAutoNumOf(el: Element): string {
  if (!isRenderedAutoNum(el.getAttribute("numType"))) return ""
  const f = findChildByLocalName(el, "autoNumFormat")
  return noteAutoNumText(el.getAttribute("num"), noteFormatFrom(n => f?.getAttribute(n)))
}
