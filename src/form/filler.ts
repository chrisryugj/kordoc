/** 양식 서식 필드 값 채우기 — IRBlock[] 기반 in-place 교체 */

import type { IRBlock, IRCell, IRTable, FormField } from "../types.js"
import { isLabelCell } from "./recognize.js"
import { normalizeLabel, findMatchingKey, normalizeValues, resolveUnmatched, isKeywordLabel, fillInCellPatterns, scanInlineSegments, matchInlineSegment, clampSegmentEnd, padInsertion, ValueCursor, type FillInput } from "./match.js"

/** 필드 채우기 결과 */
export interface FillResult {
  /** 값이 교체된 IRBlock[] */
  blocks: IRBlock[]
  /** 실제 채워진 필드 목록 */
  filled: FormField[]
  /** 매칭 실패한 라벨 (입력에는 있지만 서식에서 못 찾은 것) */
  unmatched: string[]
  /** 비치명 경고 (입력 라벨 정규화 충돌 등) — 없으면 생략 */
  warnings?: string[]
}

/**
 * IRBlock[]에서 양식 필드를 찾아 값을 교체.
 *
 * @param blocks 원본 IRBlock[] (변경하지 않음 — deep clone)
 * @param values 채울 값 맵 (라벨 → 새 값). 라벨은 접두사 매칭 지원.
 *   값이 배열이면 같은 라벨의 등장 순서대로 하나씩 소진(반복 양식·명부형 표),
 *   문자열이면 모든 등장에 동일값.
 * @returns FillResult
 *
 * @example
 * ```ts
 * const result = await parse("신청서.hwp")
 * if (!result.success) throw new Error(result.error)
 * const { blocks, filled } = fillFormFields(result.blocks, {
 *   "성명": "홍길동",
 *   "전화번호": "010-1234-5678",
 *   "주소": "서울시 강남구",
 * })
 * ```
 */
export function fillFormFields(
  blocks: IRBlock[],
  values: Record<string, FillInput>,
  /** require_unique 2차에서 거부된 라벨 셀 차단 (sfill-2) — hwpx 경로와 동일 계약 */
  blockedLabels?: Set<string>,
): FillResult {
  // deep clone — 원본 불변
  const cloned = structuredClone(blocks)
  const filled: FormField[] = []
  const matchedLabels = new Set<string>()
  const warnings: string[] = []

  const normalizedValues = normalizeValues(values, warnings)
  const cursor = new ValueCursor(normalizedValues)

  // 표 수집 — 중첩표 포함 DFS (hwpx 경로 collectTables와 동일하게 depth 16)
  const allTables = collectIRTables(cloned, 0)

  // 1) 인셀 패턴 먼저 (체크박스, 괄호 빈칸, 어노테이션) — 전략 2가 덮어쓰기 전에
  const patternFilledCells = new Set<IRCell>()
  for (const table of allTables) {
    for (let r = 0; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        const cell = table.cells[r]?.[c]
        if (!cell) continue
        const result = fillInCellPatterns(cell.text, cursor, matchedLabels, blockedLabels)
        if (result) {
          cell.text = result.text
          patternFilledCells.add(cell)
          for (const m of result.matches) {
            filled.push({ label: m.label, value: m.value, row: r, col: c, key: m.key })
          }
        }
      }
    }
  }

  // 2) 테이블 기반 필드 교체 (라벨-값 셀 패턴)
  for (const table of allTables) {
    fillTable(table, cursor, filled, matchedLabels, patternFilledCells, blockedLabels)
  }

  // 3) 인라인 "라벨: 값" 패턴 교체
  for (const block of cloned) {
    if (block.type !== "paragraph" || !block.text) continue
    const newText = fillInlineFields(block.text, cursor, filled, matchedLabels, blockedLabels)
    if (newText !== block.text) block.text = newText
  }

  const unmatched = resolveUnmatched(normalizedValues, matchedLabels, values)
  return { blocks: cloned, filled, unmatched, ...(warnings.length > 0 ? { warnings } : {}) }
}

/** 중첩표 포함 표 수집 — 문서 순서 DFS (hwpx 경로 collectTables와 동일 규칙) */
function collectIRTables(blocks: IRBlock[], depth: number): IRTable[] {
  if (depth > 16) return []
  const out: IRTable[] = []
  for (const block of blocks) {
    if (block.type !== "table" || !block.table) continue
    out.push(block.table)
    for (const row of block.table.cells) {
      for (const cell of row) {
        if (cell?.blocks?.length) out.push(...collectIRTables(cell.blocks, depth + 1))
      }
    }
  }
  return out
}

/**
 * 병합으로 덮인 격자 좌표("r,c") — 앵커가 아닌 플레이스홀더 위치.
 * builder 렌더는 이 칸을 그리지 않으므로 여기 쓴 값은 조용히 사라진다.
 */
function coveredPositions(table: IRTable): Set<string> {
  const covered = new Set<string>()
  for (let r = 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(`${r},${c}`)) continue
      const cell = table.cells[r]?.[c]
      if (!cell) continue
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < table.rows && c + dc < table.cols) covered.add(`${r + dr},${c + dc}`)
        }
      }
      c += cell.colSpan - 1
    }
  }
  return covered
}

/**
 * 헤더+데이터 표 판별 — 첫 행이 전부 라벨이고 둘째 행 첫 앵커 셀이 라벨이 아니면
 * 첫 행은 열 헤더(전략 2 대상)다. 둘째 행도 라벨로 시작하면 라벨-값 서식
 * (플레이스홀더 "미기재"류 포함)으로 보고 전략 1이 기존대로 채운다.
 */
function isHeaderDataTable(table: IRTable, covered: Set<string>): boolean {
  if (table.rows < 2) return false
  const headerRow = table.cells[0]
  if (!headerRow?.length) return false
  const allLabels = headerRow.every(cell => {
    const t = cell?.text.trim() ?? ""
    return t.length > 0 && t.length <= 20 && isLabelCell(t)
  })
  if (!allLabels) return false
  for (let c = 0; c < table.cols; c++) {
    if (covered.has(`1,${c}`)) continue
    const cell = table.cells[1]?.[c]
    if (!cell) break
    return !isLabelCell(cell.text)
  }
  return true
}

/** 테이블 셀에서 라벨-값 패턴을 찾아 값 교체 */
function fillTable(
  table: IRTable,
  values: ValueCursor,
  filled: FormField[],
  matchedLabels: Set<string>,
  patternFilledCells?: Set<IRCell>,
  blockedLabels?: Set<string>,
): void {
  if (table.cols < 2) return
  const covered = coveredPositions(table)

  // 전략 1: 인접 라벨-값 셀 패턴 — 값 셀은 라벨 span 뒤 같은 행의 다음 앵커
  // (hwpx 경로의 '다음 tc'와 동일. 병합 플레이스홀더에 쓰면 렌더에서 사라짐)
  // 헤더+데이터 표의 헤더 행은 제외 — 헤더 이웃 셀("품명"→"규격")을 값으로 덮는 오염 방지
  const skipHeaderRow = isHeaderDataTable(table, covered)
  for (let r = skipHeaderRow ? 1 : 0; r < table.rows; r++) {
    for (let c = 0; c < table.cols; c++) {
      if (covered.has(`${r},${c}`)) continue
      const labelCell = table.cells[r]?.[c]
      if (!labelCell) continue

      if (!isLabelCell(labelCell.text)) continue

      let vc = c + labelCell.colSpan
      while (vc < table.cols && covered.has(`${r},${vc}`)) vc++
      if (vc >= table.cols) continue
      const valueCell = table.cells[r][vc]
      if (!valueCell) continue

      if (isKeywordLabel(valueCell.text)) continue

      const normalizedCellLabel = normalizeLabel(labelCell.text)
      if (!normalizedCellLabel) continue
      if (blockedLabels?.has(normalizedCellLabel)) continue

      const matchKey = findMatchingKey(normalizedCellLabel, values)
      if (matchKey === undefined) continue

      const newValue = values.consume(matchKey)
      if (newValue === undefined) continue // 배열 값 소진 — 이후 등장은 채우지 않음
      // 이미 인셀 패턴이 처리된 셀이면 앞에 삽입 (어노테이션 보존)
      if (patternFilledCells?.has(valueCell)) {
        valueCell.text = newValue + " " + valueCell.text
      } else {
        valueCell.text = newValue
      }
      matchedLabels.add(matchKey)
      filled.push({
        label: labelCell.text.trim().replace(/[:：]\s*$/, ""),
        value: newValue,
        row: r,
        col: c,
        key: matchKey,
      })
    }
  }

  // 전략 2: 헤더+데이터 행 패턴 (첫 행이 전부 라벨이면)
  // 전략 1에서 이미 채운 필드는 스킵 (matchedLabels 검사)
  if (table.rows >= 2 && table.cols >= 2) {
    const headerRow = table.cells[0]
    const allLabels = headerRow?.every(cell => {
      const t = cell?.text.trim() ?? ""
      return t.length > 0 && t.length <= 20 && isLabelCell(t)
    }) ?? false
    if (!allLabels) return

    for (let r = 1; r < table.rows; r++) {
      for (let c = 0; c < table.cols; c++) {
        // 병합 플레이스홀더에 쓰면 사라지고 값만 소진됨 — 앵커만 채움
        if (covered.has(`${r},${c}`)) continue
        const headerCell = headerRow[c]
        const valueCell = table.cells[r]?.[c]
        if (!headerCell || !valueCell) continue
        const headerLabel = normalizeLabel(headerCell.text)
        if (blockedLabels?.has(headerLabel)) continue
        const matchKey = findMatchingKey(headerLabel, values)
        if (matchKey === undefined) continue
        // 스칼라: 첫 데이터 행만(기존 동작). 배열: 행마다 다음 값 소진(명부형 표)
        if (!values.isArray(matchKey) && matchedLabels.has(matchKey)) continue

        const newValue = values.consume(matchKey)
        if (newValue === undefined) continue // 배열 값 소진
        // 전략 0(인셀 패턴)이 편집한 셀은 폐기하지 않고 앞에 삽입 (전략 1과 동일 계약)
        if (patternFilledCells?.has(valueCell)) {
          valueCell.text = newValue + " " + valueCell.text
        } else {
          valueCell.text = newValue
        }
        matchedLabels.add(matchKey)
        filled.push({
          label: headerCell.text.trim(),
          value: newValue,
          row: r,
          col: c,
          key: matchKey,
        })
      }
    }
  }
}

/** 인라인 "라벨: 값" 패턴 교체 — 한 줄 다중 라벨은 세그먼트 단위로 처리 */
function fillInlineFields(
  text: string,
  values: ValueCursor,
  filled: FormField[],
  matchedLabels: Set<string>,
  blockedLabels?: Set<string>,
): string {
  const segments = scanInlineSegments(text)
  if (segments.length === 0) return text

  // 확장 라벨("신청인 성명") 정확 매칭 우선 — "성명" 붕괴 방지 (blockedLabels 포함 판정).
  // 매칭을 선계산해 다음 세그먼트가 확장 매칭이면 이전 값 끝을 그 어절 앞으로 당긴다.
  const matches = segments.map(seg => matchInlineSegment(seg, values, blockedLabels))

  let out = ""
  let pos = 0
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]
    const matched = matches[i]
    if (matched === undefined) continue
    const matchKey = matched.key

    const newValue = values.consume(matchKey)
    if (newValue === undefined) continue // 배열 값 소진
    matchedLabels.add(matchKey)
    filled.push({ label: matched.label.trim(), value: newValue, row: -1, col: -1, key: matchKey })
    const ve = clampSegmentEnd(text, seg, segments[i + 1], matches[i + 1]?.viaExt ?? false)
    out += text.slice(pos, seg.valueStart)
    // 빈 자리 삽입은 콜론·다음 라벨과 붙지 않게 공백 부착
    out += seg.valueStart === ve
      ? padInsertion(text, seg.valueStart, newValue)
      : newValue
    pos = ve
  }
  out += text.slice(pos)
  return out
}
