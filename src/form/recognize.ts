/** 양식(서식) 필드 인식 — 테이블 기반 label-value 패턴 매칭 */

import type { IRBlock, IRTable, FormField, FormResult } from "../types.js"
import { scanInlineSegments, normalizeLabel } from "./match.js"

/** 한국 공문서 필드 라벨 키워드 */
export const LABEL_KEYWORDS = new Set([
  "성명", "이름", "주소", "전화", "전화번호", "휴대폰", "핸드폰", "연락처",
  "생년월일", "주민등록번호", "소속", "직위", "직급", "부서",
  "이메일", "팩스", "학교", "학년", "반", "번호",
  "신청인", "대표자", "담당자", "작성자", "확인자", "승인자",
  "일시", "날짜", "기간", "장소", "목적", "사유", "비고",
  "금액", "수량", "단가", "합계", "계", "소계",
  "등록기준지", "본적", "위임인", "청구사유", "소명자료",
])

/** 콜론 없는 영문 라벨로 인정하는 단어 (한국 공문서 병기 관행) */
const ENGLISH_LABEL_WORDS = new Set([
  "name", "date", "address", "tel", "phone", "mobile", "fax", "email", "e-mail",
  "dept", "department", "division", "title", "position", "grade", "rank",
  "birth", "nationality", "sex", "gender", "signature", "sign", "seal",
  "remarks", "note", "period", "place", "purpose", "reason", "amount", "total",
  "sum", "qty", "quantity", "unit", "no", "id", "passport",
])
const ENGLISH_STOPWORDS = new Set(["of", "the", "and", "or", "in"])

/** 수량/단위 값 형태 — "6개월"·"1억원"·"5백만원"·"2026년" 등은 라벨이 아님 */
const NUMERIC_VALUE_RE = /^제?\d+(?:[.,]\d+)*[십백천만억조]*(?:원|명|건|개|회|부|매|장|점|호|번|년|월|일|시|분|초|개월|주년|차례|퍼센트)?$/

/** 서술형 문장 어미 — 셀에 든 안내 문구를 라벨로 오인하지 않기 위한 컷 */
const SENTENCE_ENDING_RE = /(?:입니다|합니다|습니다|하세요|십시오|시오|바랍니다|바람|할 것|할것|하며|하고|한다|된다|됨|음|임)$/

/** 라벨처럼 보이는 셀인지 판별 */
export function isLabelCell(text: string): boolean {
  // 각주 번호/특수문자 제거 후 판별 (예: "등록기준지²" → "등록기준지")
  const trimmed = text.trim().replace(/[¹²³⁴⁵⁶⁷⁸⁹⁰*※]+$/g, "").trim()
  if (!trimmed || trimmed.length > 30) return false
  // 키워드 매칭
  for (const kw of LABEL_KEYWORDS) {
    if (trimmed.includes(kw)) return true
  }
  // 짧은 한글 텍스트 (2-12자, 공백/괄호/특수기호 허용) — 숫자는 낄 수 있으나
  // ("연번1"·"제1항목"·"1차소속") 수량/단위 값·서술형 문구·법인명은 라벨이 아님.
  // 9자 이상 확장 구간은 3어절 이상 제목성 문구를 컷 (자간 공백 라벨
  // "업 체 명"류가 있는 8자 이하 기존 구간에는 어절 제한을 걸지 않는다)
  const compact = trimmed.replace(/\s/g, "")
  if (/^[가-힣0-9()（）·:：\-]+$/.test(compact)
    && compact.length >= 2 && compact.length <= 12
    && (compact.match(/[가-힣]/g) ?? []).length >= 2
    && (compact.length <= 8 || trimmed.split(/\s+/).length <= 2)
    && !NUMERIC_VALUE_RE.test(compact)
    && !SENTENCE_ENDING_RE.test(trimmed)
    && !/^[(（]주[)）]|^주식회사/.test(compact)) {
    return true
  }
  // "라벨:" 패턴
  if (/^[가-힣A-Za-z\s]+[:：]$/.test(trimmed)) return true
  // 콜론 없는 영문 라벨 ("Name"·"Date of Birth") — 관행 단어 목록으로 한정
  if (/^[A-Za-z][A-Za-z\s./&-]*$/.test(trimmed) && trimmed.length <= 20) {
    const words = trimmed.toLowerCase().split(/[\s/&]+/).filter(w => w && !ENGLISH_STOPWORDS.has(w))
    if (words.length >= 1 && words.length <= 3 && words.every(w => ENGLISH_LABEL_WORDS.has(w.replace(/\.$/, "")))) {
      return true
    }
  }
  return false
}

/**
 * IRBlock[]에서 양식 필드를 인식하여 추출.
 * 테이블의 label-value 패턴을 감지.
 */
export function extractFormFields(blocks: IRBlock[]): FormResult {
  const fields: FormField[] = []
  let totalTables = 0
  let formTables = 0

  for (const block of blocks) {
    if (block.type !== "table" || !block.table) continue
    totalTables++

    const tableFields = extractFromTable(block.table)
    if (tableFields.length > 0) {
      formTables++
      fields.push(...tableFields)
    }
  }

  // 인라인 "라벨: 값" 패턴도 검사 (paragraph만 — heading/list는 양식 필드가 아님)
  for (const block of blocks) {
    if (block.type === "paragraph" && block.text) {
      const inlineFields = extractInlineFields(block.text)
      fields.push(...inlineFields)
    }
  }

  const confidence = totalTables > 0 ? formTables / totalTables : (fields.length > 0 ? 0.3 : 0)
  return { fields, confidence: Math.min(confidence, 1) }
}

function extractFromTable(table: IRTable): FormField[] {
  const fields: FormField[] = []

  // 전략 1: 인접셀 label-value (2열 이상 테이블)
  if (table.cols >= 2) {
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols - 1; c++) {
        const labelCell = table.cells[r]?.[c]
        const valueCell = table.cells[r]?.[c + 1]
        if (!labelCell || !valueCell) continue
        if (isLabelCell(labelCell.text)) {
          fields.push({
            label: labelCell.text.trim().replace(/[:：]\s*$/, ""),
            value: valueCell.text.trim(),
            row: r,
            col: c,
          })
        }
      }
    }
  }

  // 전략 2: 헤더+데이터 행 (첫 행이 전부 라벨이면)
  if (fields.length === 0 && table.rows >= 2 && table.cols >= 2) {
    const headerRow = table.cells[0]
    const allLabels = headerRow?.every(cell => {
      const t = cell?.text.trim() ?? ""
      return t.length > 0 && t.length <= 20
    }) ?? false
    if (allLabels) {
      for (let r = 1; r < table.rows; r++) {
        for (let c = 0; c < table.cols; c++) {
          const label = headerRow[c]?.text.trim() ?? ""
          const value = table.cells[r]?.[c]?.text.trim() ?? ""
          if (label && value) {
            fields.push({ label, value, row: r, col: c })
          }
        }
      }
    }
  }

  return fields
}

function extractInlineFields(text: string): FormField[] {
  // "라벨: 값" — 한 줄 다중 라벨("성명:  작성일자: ")은 세그먼트 단위로 분해.
  // 값이 빈 라벨은 여기선 제외 (기존 계약 유지) — extractFormSchema가 수집한다.
  const fields: FormField[] = []
  for (const seg of scanInlineSegments(text)) {
    if (seg.value) {
      fields.push({ label: seg.label, value: seg.value, row: -1, col: -1 })
    }
  }
  return fields
}

// ─── 필드 스키마 (타입 추론) — v3.1 ─────────────────

/** 양식 필드 타입 — 폼 UI 위젯 선택의 근거 (데이트피커/체크박스 등) */
export type FormFieldType = "text" | "date" | "phone" | "email" | "amount" | "checkbox" | "idnum"

/** 타입이 추론된 양식 필드 */
export interface FormFieldSchema extends FormField {
  type: FormFieldType
  /** 라벨에 필수 표시(※·*·★·"(필수)")가 있을 때만 true */
  required?: boolean
  /** 값이 비어 있거나 플레이스홀더(밑줄/괄호 빈칸)뿐 — 채움 대상 */
  empty: boolean
}

export interface FormSchemaResult {
  fields: FormFieldSchema[]
  /** 양식 확신도 (0-1, extractFormFields와 동일) */
  confidence: number
}

/** 라벨 키워드 → 타입 (값 패턴이 우선, 라벨은 폴백) */
const LABEL_TYPE_RULES: Array<[RegExp, FormFieldType]> = [
  [/주민등록번호|외국인등록번호/, "idnum"],
  [/생년월일|일시|날짜|일자|기간|연월일|년월일|신청일|작성일|발급일|접수일/, "date"],
  [/전화|연락처|휴대폰|핸드폰|팩스/, "phone"],
  [/이메일|전자우편|email/i, "email"],
  [/금액|단가|수량|합계|소계|예산|비용|인원|급여|연봉/, "amount"],
]

/** 필드 타입 추론 — 기존 값의 패턴 우선, 없으면 라벨 키워드 */
export function inferFieldType(label: string, value: string): FormFieldType {
  if (/[□☑✓✔]/.test(value) || /[□☑✓✔]/.test(label)) return "checkbox"

  const v = value.trim()
  if (v) {
    if (/^\d{6}[-\s]?[1-4]\d{6}$/.test(v)) return "idnum"
    if (/^\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}\s*일?\s*\.?$/.test(v)) return "date"
    if (/^0\d{1,2}[-.)\s]?\d{3,4}[-.\s]?\d{4}$/.test(v)) return "phone"
    if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(v)) return "email"
    // 단위 접미사 또는 천단위 콤마가 있을 때만 값 기반 amount — 맨 숫자
    // (우편번호/접수번호/연도 등)는 라벨 폴백으로 넘긴다
    if (/^[\d,.\s]+(?:원|명|건|개|회|부|매|%)$/.test(v) && /\d/.test(v)) return "amount"
    if (/^\d{1,3}(?:,\d{3})+$/.test(v)) return "amount"
  }

  const norm = label.replace(/\s/g, "")
  for (const [re, type] of LABEL_TYPE_RULES) {
    if (re.test(norm)) return type
  }
  return "text"
}

/** 라벨의 필수 표시 감지 (※·*·★·"(필수)") */
function isRequiredLabel(label: string): boolean {
  return /[*※★]|\(\s*필수\s*\)|（\s*필수\s*）/.test(label)
}

/** 값이 비어 있거나 플레이스홀더(밑줄·괄호 빈칸·대시)뿐인지 */
function isEmptyValue(value: string): boolean {
  const v = value.trim()
  if (!v) return true
  return /^[\s_()（）\-—–~.·,]*$/.test(v)
}

/**
 * 양식 필드 인식 + 타입/필수/빈값 추론 — 폼 UI 자동 생성용 (v3.1).
 * extractFormFields 결과에 type(date/phone/amount/checkbox/...)·required·empty를 부여한다.
 */
export function extractFormSchema(blocks: IRBlock[]): FormSchemaResult {
  const { fields, confidence } = extractFormFields(blocks)
  const schemaFields: FormFieldSchema[] = fields.map(f => ({
    ...f,
    type: inferFieldType(f.label, f.value),
    required: isRequiredLabel(f.label) || undefined,
    empty: isEmptyValue(f.value),
  }))

  // 값이 빈 인라인 라벨("작성일자:")도 채움 대상으로 노출 —
  // extractFormFields는 값 있는 필드만 수집하므로 여기서 보충한다
  const seen = new Set(schemaFields.map(f => normalizeLabel(f.label)))
  for (const block of blocks) {
    if (block.type !== "paragraph" || !block.text) continue
    for (const seg of scanInlineSegments(block.text)) {
      if (seg.value) continue
      const key = normalizeLabel(seg.label)
      if (seen.has(key)) continue
      seen.add(key)
      schemaFields.push({
        label: seg.label,
        value: "",
        row: -1,
        col: -1,
        type: inferFieldType(seg.label, ""),
        required: isRequiredLabel(seg.label) || undefined,
        empty: true,
      })
    }
  }

  return { confidence, fields: schemaFields }
}
