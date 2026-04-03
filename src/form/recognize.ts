/** 양식(서식) 필드 인식 — 테이블 기반 label-value 패턴 매칭 */

import type { IRBlock, IRTable, FormField, FormResult } from "../types.js"

/** 한국 공문서 필드 라벨 키워드 */
const LABEL_KEYWORDS = new Set([
  "성명", "이름", "주소", "전화", "전화번호", "휴대폰", "핸드폰", "연락처",
  "생년월일", "주민등록번호", "소속", "직위", "직급", "부서",
  "이메일", "팩스", "학교", "학년", "반", "번호",
  "신청인", "대표자", "담당자", "작성자", "확인자", "승인자",
  "일시", "날짜", "기간", "장소", "목적", "사유", "비고",
  "금액", "수량", "단가", "합계", "계", "소계",
])

/** 라벨처럼 보이는 셀인지 판별 */
function isLabelCell(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed || trimmed.length > 30) return false
  // 키워드 매칭
  for (const kw of LABEL_KEYWORDS) {
    if (trimmed.includes(kw)) return true
  }
  // 짧은 한글 텍스트 (2-8자) + 숫자 없음
  if (/^[가-힣\s()·:]{2,8}$/.test(trimmed) && !/\d/.test(trimmed)) return true
  // "라벨:" 패턴
  if (/^[가-힣A-Za-z\s]+[:：]$/.test(trimmed)) return true
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
        const labelCell = table.cells[r][c]
        const valueCell = table.cells[r][c + 1]
        if (isLabelCell(labelCell.text) && valueCell.text.trim()) {
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
    const allLabels = headerRow.every(cell => {
      const t = cell.text.trim()
      return t.length > 0 && t.length <= 20
    })
    if (allLabels) {
      for (let r = 1; r < table.rows; r++) {
        for (let c = 0; c < table.cols; c++) {
          const label = headerRow[c].text.trim()
          const value = table.cells[r][c].text.trim()
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
  const fields: FormField[] = []
  // "라벨: 값" 또는 "라벨 : 값" 패턴
  const pattern = /([가-힣A-Za-z]{2,10})\s*[:：]\s*([^\n,;]{1,100})/g
  let match
  let iterations = 0
  const MAX_FORM_MATCHES = 1000
  while ((match = pattern.exec(text)) !== null && ++iterations < MAX_FORM_MATCHES) {
    const label = match[1].trim()
    const value = match[2].trim()
    if (value) {
      fields.push({ label, value, row: -1, col: -1 })
    }
  }
  return fields
}
