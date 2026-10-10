/**
 * HWPX 원본 서식 유지 채우기 — section XML 오프셋 splice (v3.1, 바이트 보존)
 *
 * v3.0까지는 xmldom 전체 재직렬화 방식이라 변경하지 않은 영역도 속성 순서·
 * 공백·자기닫힘 표기가 바뀔 수 있었다. v3.1부터 patchHwpx와 동일한
 * source-map splice + ZIP in-place 재조립을 사용해, 변경 문단 외 XML과
 * 비변경 ZIP 엔트리를 1바이트도 건드리지 않는다.
 *
 * 전략 (v3.0과 동일, 적용 순서 보존):
 * 0. 인셀 패턴 — 체크박스 □→☑, 괄호 빈칸 (  )→(값), 어노테이션 (한자：)→(한자：값)
 * 1. 인접 라벨-값 셀 — label | value (패턴 적용 셀은 값을 앞에 삽입해 어노테이션 보존)
 * 2. 헤더+데이터 행 — 첫 행이 전부 라벨이면 열 단위 매칭 (나중 쓰기 우선 — v3.0 동일)
 * 3. 인라인 "라벨: 값" — 표 밖 본문/글상자/머리말·꼬리말·각주 문단
 *
 * 적용 범위는 v3.0과 동일하게 머리말/꼬리말 등 ctrl 내부 표·문단을 포함하고
 * (scan.orphanTables/excludedParagraphs), 셀 라벨 판정은 v3.0과 동일하게
 * 글상자(drawText) 문단을 제외한다. 패턴 매칭·범위 치환은 hp:t 연결 텍스트
 * (t-도메인) 좌표로 수행해 사이에 끼인 tab/br 요소를 건드리지 않는다.
 *
 * v3.0과의 의도적 차이: 인셀 패턴(전략 0)은 문단 단위로 매칭한다 — 문단
 * 경계에 걸친 패턴(극히 드묾)은 채우지 않는다.
 */

import JSZip from "jszip"
import { isLabelCell, isColumnHeaderRow, isBlankValue } from "./recognize.js"
import { fillClickHereInXml } from "./click-here.js"
import { KordocError, precheckZipSize } from "../utils.js"
import { normalizeLabel, findMatchingKey, normalizeValues, resolveUnmatched, isKeywordLabel, fillInCellPatterns, scanInlineSegments, matchInlineSegment, clampSegmentEnd, padInsertion, ValueCursor, type FillValue , type FillInput } from "./match.js"
import type { FormField } from "../types.js"
import {
  scanSectionXml, buildParagraphSplices, buildRangeSplices, applySplices, paraTText, paraTextPureT,
  changedLinesegRemovalSplices,
  type ScanParagraph, type ScanCell, type ScanTable, type SectionScan, type SpliceEdit,
} from "../roundtrip/source-map.js"
import { patchZipEntries } from "../roundtrip/zip-patch.js"

/** 어노테이션 빈칸 "(한자： )"·"(전화번호:  )": 라벨처럼 보여도 값을 받는 자리 */
const ANNOTATION_BLANK_RE = /[(（][^)）]*[:：]\s*[)）]/

/** 채우기 결과 */
export interface HwpxFillResult {
  /** 채워진 HWPX 바이너리 */
  buffer: ArrayBuffer
  /** 실제 채워진 필드 목록 */
  filled: FormField[]
  /** 매칭 실패한 라벨 */
  unmatched: string[]
  /** 비치명 경고 (입력 라벨 정규화 충돌 등) — 없으면 생략 */
  warnings?: string[]
}

/** 문단별 편집 원장 — 전략들이 의도를 누적하고 마지막에 splice로 변환 */
interface ParaEditLedger {
  /** 문단 전체 재작성 (우선 — 설정되면 ranges 무시, 나중 쓰기 우선) */
  fullText?: string
  /** 매칭 도메인(paraTText ?? para.text) 좌표의 부분 치환 (start===end는 삽입) */
  ranges: Array<{ start: number; end: number; replacement: string }>
  /** 이 문단 편집과 연결된 filled 레코드 인덱스 — splice 실패 시 회수 */
  filledIdx: number[]
  /** 이 문단 편집과 연결된 매칭 키 — splice 실패 시 unmatched 복원용 */
  matchKeys: string[]
}

/**
 * HWPX 원본을 직접 수정하여 서식 필드를 채움 — 스타일 100% 보존.
 *
 * @param hwpxBuffer 원본 HWPX 파일 버퍼
 * @param values 채울 값 맵 (라벨 → 값). 값이 배열이면 같은 라벨의 등장 순서대로
 *   하나씩 소진된다 — 2~30장 반복 양식·명부형 표(헤더+여러 데이터 행) 채우기용.
 *   문자열이면 모든 등장에 동일값 (두 번째 이후 등장은 빈 칸·첫 등장과 같은 견본 글일 때만, 열 머리 표는 첫 데이터 행만).
 * @returns HwpxFillResult
 */
export async function fillHwpx(
  hwpxBuffer: ArrayBuffer,
  values: Record<string, FillInput>,
  /** 이 정규화 라벨의 셀은 어떤 키로도 채우지 않음 — require_unique 2차에서 거부된
   *  라벨 셀이 접두사 매칭으로 남의 값에 오염되는 것을 차단 (sfill-2) */
  blockedLabels?: Set<string>,
): Promise<HwpxFillResult> {
  const u8 = new Uint8Array(hwpxBuffer)
  precheckZipSize(hwpxBuffer) // 파싱 경로와 같은 ZIP bomb 가드 — fill 은 parse 없이 직행할 수 있다
  const zip = await JSZip.loadAsync(hwpxBuffer)
  // v3.0과 동일한 글롭 — filler 매칭은 라벨 기반(국소적)이라 manifest 비등재
  // 섹션을 포함해도 안전하고, 빼면 그 섹션의 양식이 조용히 누락된다
  const sectionPaths = Object.keys(zip.files)
    .filter(name => /[Ss]ection\d+\.xml$/i.test(name))
    .sort()
  if (sectionPaths.length === 0) {
    throw new KordocError("HWPX에서 섹션 파일을 찾을 수 없습니다")
  }

  const warnings: string[] = []
  const normalizedValues = normalizeValues(values, warnings)
  const cursor = new ValueCursor(normalizedValues)
  const matchedLabels = new Set<string>()
  /** splice 실패 회수를 위해 null 자리표시 허용 — 마지막에 filter */
  const filled: Array<FormField | null> = []
  /** splice 실패로 회수된 키 / 성공 적용된 키 — unmatched 복원 판단용 */
  const failedKeys = new Set<string>()
  const succeededKeys = new Set<string>()
  const replacements = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()

  // ── 전략 F: 누름틀(CLICK_HERE) 우선 매칭 — 표준 서식(기안문 등) 지원 ──
  // 필드 name과 정규화 정확 일치한 키는 여기서 채워지고 라벨 매칭에서 제외된다
  // (누름틀은 서식 제작자의 명시적 계약이라 라벨 추정보다 우선).
  // 모든 섹션을 먼저 훑은 뒤에 키를 제거해야 섹션2+의 동명 누름틀이 굶지 않는다.
  const sectionXmls = new Map<string, string>()
  /** 누름틀을 채운 섹션 → 고친 자리(채운 xml 좌표) */
  const fieldModified = new Map<string, number[]>()
  const fieldMatchedKeys = new Set<string>()
  for (const p of sectionPaths) {
    const xml = await zip.file(p)!.async("text")
    const outcome = fillClickHereInXml(xml, cursor, blockedLabels)
    sectionXmls.set(p, outcome.xml ?? xml)
    if (outcome.xml !== null) fieldModified.set(p, outcome.changedAt)
    for (const f of outcome.filled) filled.push(f)
    for (const k of outcome.matchedKeys) fieldMatchedKeys.add(k)
  }
  for (const k of fieldMatchedKeys) {
    matchedLabels.add(k)
    normalizedValues.delete(k)
  }

  const scans = sectionPaths.map((p, si) => scanSectionXml(sectionXmls.get(p)!, si))
  // 문서 어딘가에 제 칸(표 라벨 칸·인라인 "라벨:")이 있는 스칼라 키는 어노테이션 빈칸 "(전화번호: )" 으로 채우지 않는다.
  // 법령 서식은 설계자·시공자·감리자 칸마다 "(전화번호: )" 를 두어 신고인 전화번호가 남의 칸 네 곳에 들어갔다 (착공신고서)
  const annotationSkip = new Set<string>()
  for (let si = 0; si < scans.length; si++) {
    const xml = sectionXmls.get(sectionPaths[si])!
    for (const table of collectAllTables(scans[si])) {
      for (const row of table.rows) {
        for (const cell of row) {
          const t = cell.paragraphs.filter(p => !p.inTextbox).map(p => paraTText(p, xml) ?? p.text).join("")
          if (!isLabelCell(t) || ANNOTATION_BLANK_RE.test(t)) continue // 어노테이션 빈칸 칸 자신은 제 칸이 아니다
          const key = findMatchingKey(normalizeLabel(t), cursor)
          if (key !== undefined && !cursor.isArray(key)) annotationSkip.add(key)
        }
      }
    }
    for (const para of scans[si].bodyParagraphs) {
      for (const seg of scanInlineSegments(paraTText(para, xml) ?? para.text)) {
        const key = matchInlineSegment(seg, cursor, blockedLabels)?.key
        if (key !== undefined && !cursor.isArray(key)) annotationSkip.add(key)
      }
    }
  }
  /** 스칼라 키를 처음 쓴 칸의 원래 글: 두 번째 이후 등장은 빈 칸·같은 견본 글에만 쓴다 */
  const firstTarget = new Map<string, string>()

  for (let si = 0; si < sectionPaths.length; si++) {
    const xml = sectionXmls.get(sectionPaths[si])!
    const scan = scans[si]

    const ledger = new Map<ScanParagraph, ParaEditLedger>()
    const led = (p: ScanParagraph): ParaEditLedger => {
      let l = ledger.get(p)
      if (!l) ledger.set(p, (l = { ranges: [], filledIdx: [], matchKeys: [] }))
      return l
    }

    /** 매칭/치환 좌표 도메인 텍스트 — t-도메인 우선, 엔티티 포함 시 para.text */
    const matchText = (p: ScanParagraph): string => paraTText(p, xml) ?? p.text
    /** 라벨/값 판정용 셀 텍스트 — v3.0 extractCellText와 동일하게 글상자 제외,
     *  문단 경계 구분자 없이 연결 */
    const cellLabelText = (cell: ScanCell): string =>
      cell.paragraphs.filter(p => !p.inTextbox).map(p => matchText(p)).join("")

    // 표 수집 — 문서 순서 DFS (중첩표 + 머리말 등 ctrl 내부 고아 표 포함)
    const allTables = collectAllTables(scan)

    // ── 전략 0: 인셀 패턴 (전략 1보다 먼저 — 어노테이션 보존 순서) ──
    const patternApplied = new Set<ScanCell>()
    for (const table of allTables) {
      for (const row of table.rows) {
        for (const cell of row) {
          for (const para of cell.paragraphs) {
            const text = matchText(para)
            const result = fillInCellPatterns(text, cursor, matchedLabels, blockedLabels, annotationSkip)
            if (!result) continue
            const l = led(para)
            if (l.fullText !== undefined) continue
            // 최소 diff 범위만 치환 — 나머지 run 서식 보존
            const newT = result.text
            let s = 0
            while (s < text.length && s < newT.length && text[s] === newT[s]) s++
            let eo = text.length
            let en = newT.length
            while (eo > s && en > s && text[eo - 1] === newT[en - 1]) { eo--; en-- }
            l.ranges.push({ start: s, end: eo, replacement: newT.slice(s, en) })
            patternApplied.add(cell)
            for (const m of result.matches) {
              l.filledIdx.push(filled.length)
              l.matchKeys.push(m.key)
              filled.push({ label: m.label, value: m.value, row: -1, col: -1, key: m.key })
            }
          }
        }
      }
    }

    /** 남의 라벨 칸(값으로 덮으면 안 되는 칸): 키워드 라벨·다른 입력 키의 라벨("허가일자"·"전 공")·①번호 라벨("① 지번") */
    const isForeignLabel = (text: string): boolean => {
      if (isKeywordLabel(text)) return true
      const t = text.trim()
      if (/^[①-⑳]/.test(t) && t.length <= 20) return true
      if (ANNOTATION_BLANK_RE.test(t)) return false // "(한자： )" 어노테이션 빈칸 칸은 값 자리
      const n = normalizeLabel(t)
      return !!n && cursor.has(n) // 정확 일치만: 접두 매칭이면 값 "수신자 참조" 가 키 "수신자" 의 라벨로 오인된다
    }
    /** 스칼라 키의 두 번째 이후 등장: 빈 칸이거나 첫 등장과 같은 견본 글일 때만 쓴다 (끝의 수신자 명단 같은 남의 글 보호) */
    const laterOk = (key: string, current: string): boolean =>
      cursor.isArray(key) || !firstTarget.has(key) || isBlankValue(current) || current.trim() === firstTarget.get(key)
    const markFirst = (key: string, current: string): void => {
      if (!cursor.isArray(key) && !firstTarget.has(key)) firstTarget.set(key, current.trim())
    }
    /** 칸 안 라벨(법령 서식 "건축주"·"전화번호" 넓은 칸): 옆이 값 칸이 아니면 라벨 칸 안, 라벨 뒤에 값을 적는다.
     *  스칼라는 첫 등장만 (설계자·시공자 칸의 같은 라벨은 남의 칸) */
    const fillInLabelCell = (cell: ScanCell, labelText: string, key: string, rowIdx: number, colIdx: number): void => {
      if (cell.colSpan < 2) return
      if (!cursor.isArray(key) && matchedLabels.has(key)) return
      const paras = cell.paragraphs.filter(p => !p.inTextbox && matchText(p).trim())
      if (paras.length !== 1 || cell.tables.length > 0) return
      const l = led(paras[0])
      if (l.fullText !== undefined || l.ranges.length > 0) return
      const value = cursor.consume(key)
      if (value === undefined) return
      const text = matchText(paras[0])
      l.ranges.push({ start: text.trimEnd().length, end: text.length, replacement: " " + value })
      l.filledIdx.push(filled.length)
      l.matchKeys.push(key)
      matchedLabels.add(key)
      markFirst(key, labelText)
      filled.push({ label: labelText.trim().replace(/[:：]\s*$/, ""), value, row: rowIdx, col: colIdx, key })
    }

    // ── 전략 1 + 2: 표 단위 인터리브 (v3.0 DOM 버전과 동일 순서) ──
    for (const table of allTables) {
      const firstRowAllLabels = table.rows.length >= 2 && table.rows[0].length > 0 && table.rows[0].every(cell => {
        const t = cellLabelText(cell).trim()
        return t.length > 0 && t.length <= 20 && isLabelCell(t)
      })
      // 열 머리 행: 라벨이 위, 값이 아래 (표 가운데 구역마다 머리 행이 다시 나오는 신청서·왼쪽 구역 라벨 rowSpan 포함).
      // 인식(extractFormSchema)과 같은 규칙. 이 행은 옆 칸으로 채우지 않는다: 옆 칸은 다음 머리다
      const headerRows = new Set<number>()
      for (let r = 0; r + 1 < table.rows.length; r++) {
        const heads = table.rows[r].filter(c => c.rowSpan <= 1)
        const below = heads.map(h => table.rows[r + 1].find(c => c.colAddr === h.colAddr))
        if (isColumnHeaderRow(heads.map(cellLabelText), below.map(b => (b ? cellLabelText(b) : undefined)))) headerRows.add(r)
      }
      // 첫 행이 전부 라벨 + 둘째 행 첫 셀이 라벨 아님: 헤더 이웃 셀("품명"→"규격") 오염 방지 (IR 경로 isHeaderDataTable과 동일 규칙)
      const skipRows = new Set(headerRows)
      if (firstRowAllLabels) {
        const d0 = table.rows[1][0]
        if (d0 === undefined || !isLabelCell(cellLabelText(d0))) skipRows.add(0)
      }

      // 전략 1: 인접 라벨-값 셀
      for (let rowIdx = 0; rowIdx < table.rows.length; rowIdx++) {
        if (skipRows.has(rowIdx)) continue
        const cells = table.rows[rowIdx]
        for (let colIdx = 0; colIdx < cells.length; colIdx++) {
          const labelText = cellLabelText(cells[colIdx])
          if (!isLabelCell(labelText)) continue

          const normalizedCellLabel = normalizeLabel(labelText)
          if (!normalizedCellLabel) continue
          if (blockedLabels?.has(normalizedCellLabel)) continue
          const matchKey = findMatchingKey(normalizedCellLabel, cursor)
          if (matchKey === undefined) continue

          const valueCell = cells[colIdx + 1] as ScanCell | undefined
          const valueText = valueCell ? cellLabelText(valueCell) : ""
          if (!valueCell || isForeignLabel(valueText)) {
            fillInLabelCell(cells[colIdx], labelText, matchKey, rowIdx, colIdx)
            continue
          }
          if (!laterOk(matchKey, valueText)) continue

          if (patternApplied.has(valueCell)) {
            // 전략 0이 이미 어노테이션을 채움 — 값을 앞에 삽입 (어노테이션 보존)
            const target = valueCell.paragraphs.find(p => p.tRanges.length > 0) ?? valueCell.paragraphs[0]
            if (!target) continue
            const l = led(target)
            if (l.fullText !== undefined) continue
            const newValue = cursor.consume(matchKey)
            if (newValue === undefined) continue // 배열 값 소진 — 이후 등장은 채우지 않음
            l.ranges.push({ start: 0, end: 0, replacement: newValue + " " })
            l.filledIdx.push(filled.length)
            l.matchKeys.push(matchKey)
            matchedLabels.add(matchKey)
            markFirst(matchKey, valueText)
            filled.push({
              label: labelText.trim().replace(/[:：]\s*$/, ""),
              value: newValue,
              row: rowIdx,
              col: colIdx,
              key: matchKey,
            })
          } else {
            const paras = valueCell.paragraphs
            if (paras.length === 0) continue
            const newValue = cursor.consume(matchKey)
            if (newValue === undefined) continue // 배열 값 소진
            // 나중 쓰기 우선 (v3.0 replaceCellText와 동일) — 기존 원장 덮어쓰기
            const l0 = led(paras[0])
            l0.fullText = newValue
            l0.ranges = []
            l0.filledIdx.push(filled.length)
            l0.matchKeys.push(matchKey)
            for (let k = 1; k < paras.length; k++) {
              const lk = led(paras[k])
              lk.fullText = ""
              lk.ranges = []
            }
            matchedLabels.add(matchKey)
            markFirst(matchKey, valueText)
            filled.push({
              label: labelText.trim().replace(/[:：]\s*$/, ""),
              value: newValue,
              row: rowIdx,
              col: colIdx,
              key: matchKey,
            })
          }
        }
      }

      // 전략 2: 열 머리 행 + 그 아래 데이터 행 (첫 행이 전부 라벨인 표 포함). 값 칸은 행 순번이 아니라 칸 좌표로 맞춘다.
      // 왼쪽에 구역 라벨 rowSpan 칸이 있으면 데이터 행 칸이 하나 적어 순번 대응은 값이 한 칸씩 밀린다.
      // 배열은 다음 머리 행 전까지 행마다, 스칼라는 첫 데이터 행만
      const verticalRows = new Set(headerRows)
      if (firstRowAllLabels) verticalRows.add(0)
      for (const h of [...verticalRows].sort((a, b) => a - b)) {
        const headerCells = table.rows[h]
        /** 스칼라 키가 이미 첫 데이터 칸을 본 열: 그 칸이 줄 이름표("고등학교")라 못 썼어도 아래 행으로 내려가지 않는다 */
        const scalarSeen = new Set<number>()
        for (let rowIdx = h + 1; rowIdx < table.rows.length && !verticalRows.has(rowIdx); rowIdx++) {
          const dataCells = table.rows[rowIdx]
          for (let colIdx = 0; colIdx < headerCells.length; colIdx++) {
            const dataCell = dataCells.find(c => c.colAddr === headerCells[colIdx].colAddr)
            if (!dataCell) continue
            const headerLabel = normalizeLabel(cellLabelText(headerCells[colIdx]))
            if (!headerLabel || blockedLabels?.has(headerLabel)) continue
            const matchKey = findMatchingKey(headerLabel, cursor)
            if (matchKey === undefined) continue
            // 스칼라: 첫 데이터 행만(기존 동작). 배열: 행마다 다음 값 소진(명부형 표)
            if (!cursor.isArray(matchKey) && (matchedLabels.has(matchKey) || scalarSeen.has(colIdx))) continue
            if (!cursor.isArray(matchKey)) scalarSeen.add(colIdx)
            if (isForeignLabel(cellLabelText(dataCell))) continue

            if (patternApplied.has(dataCell)) {
              // 전략 0이 이미 인셀 패턴을 채움: fullText로 폐기하지 않고 값을 앞에 삽입
              // (전략 1의 patternApplied 분기와 동일 계약: filled 기록·소비값 보존)
              const target = dataCell.paragraphs.find(p => p.tRanges.length > 0) ?? dataCell.paragraphs[0]
              if (!target) continue
              const l = led(target)
              if (l.fullText !== undefined) continue
              const newValue = cursor.consume(matchKey)
              if (newValue === undefined) continue // 배열 값 소진
              l.ranges.push({ start: 0, end: 0, replacement: newValue + " " })
              l.filledIdx.push(filled.length)
              l.matchKeys.push(matchKey)
              matchedLabels.add(matchKey)
              markFirst(matchKey, cellLabelText(dataCell))
              filled.push({
                label: cellLabelText(headerCells[colIdx]).trim(),
                value: newValue,
                row: rowIdx,
                col: colIdx,
                key: matchKey,
              })
              continue
            }

            const newValue = cursor.consume(matchKey)
            if (newValue === undefined) continue // 배열 값 소진

            const paras = dataCell.paragraphs
            if (paras.length === 0) continue
            // 나중 쓰기 우선 (v3.0과 동일)
            const l0 = led(paras[0])
            l0.fullText = newValue
            l0.ranges = []
            l0.filledIdx.push(filled.length)
            l0.matchKeys.push(matchKey)
            for (let k = 1; k < paras.length; k++) {
              const lk = led(paras[k])
              lk.fullText = ""
              lk.ranges = []
            }
            matchedLabels.add(matchKey)
            markFirst(matchKey, cellLabelText(dataCell))
            filled.push({
              label: cellLabelText(headerCells[colIdx]).trim(),
              value: newValue,
              row: rowIdx,
              col: colIdx,
              key: matchKey,
            })
          }
        }
      }
    }

    // ── 전략 3: 인라인 "라벨: 값" (표 밖 본문/글상자 + 머리말·꼬리말 등) ──
    // 세그먼트 단위 분해 — 한 문단 다중 라벨("성명:  작성일자: ") 지원.
    // 좌표는 전부 원본 도메인이라 문단당 여러 range를 안전하게 누적할 수 있다
    // (겹침은 원장 변환 단계에서 앞선 전략 우선으로 제거).
    for (const para of [...scan.bodyParagraphs, ...scan.excludedParagraphs]) {
      const existing = ledger.get(para)
      if (existing?.fullText !== undefined) continue
      const text = matchText(para)
      // 확장 라벨("신청인 성명") 정확 매칭 우선 — "성명" 붕괴 방지 (blockedLabels 포함 판정).
      // 매칭을 선계산해 다음 세그먼트가 확장 매칭이면 이전 값 끝을 그 어절 앞으로 당긴다.
      const segments = scanInlineSegments(text)
      const matches = segments.map(seg => matchInlineSegment(seg, cursor, blockedLabels))
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i]
        const matched = matches[i]
        if (matched === undefined) continue
        const matchKey = matched.key
        const ve = clampSegmentEnd(text, seg, segments[i + 1], matches[i + 1]?.viaExt ?? false)
        if (!laterOk(matchKey, text.slice(seg.valueStart, ve))) continue
        const newValue = cursor.consume(matchKey)
        if (newValue === undefined) continue // 배열 값 소진
        markFirst(matchKey, text.slice(seg.valueStart, ve))
        // 빈 자리 삽입은 콜론·다음 라벨과 붙지 않게 공백 부착
        const replacement = seg.valueStart === ve
          ? padInsertion(text, seg.valueStart, newValue)
          : newValue
        const l = led(para)
        l.ranges.push({ start: seg.valueStart, end: ve, replacement })
        matchedLabels.add(matchKey)
        l.filledIdx.push(filled.length)
        l.matchKeys.push(matchKey)
        filled.push({ label: matched.label.trim(), value: newValue, row: -1, col: -1, key: matchKey })
      }
    }

    // ── 원장 → splice 변환 ──
    const splices: SpliceEdit[] = []
    for (const [para, l] of ledger) {
      let paraSplices: SpliceEdit[] | null = null

      if (l.fullText !== undefined) {
        paraSplices = buildParagraphSplices(para, l.fullText, xml)
      } else if (l.ranges.length > 0) {
        // 겹침 제거 (앞선 전략 우선)
        const sorted = [...l.ranges].sort((a, b) => a.start - b.start || a.end - b.end)
        const merged: typeof sorted = []
        for (const r of sorted) {
          const prev = merged[merged.length - 1]
          if (prev && r.start < prev.end) continue
          merged.push(r)
        }
        if (paraTText(para, xml) !== null) {
          // t-도메인 정밀 치환 — tab/br 요소를 건드리지 않고 run 서식 보존
          const precise: SpliceEdit[] = []
          let ok = true
          for (const r of merged) {
            const sp = buildRangeSplices(para, xml, r.start, r.end, r.replacement)
            if (!sp) { ok = false; break }
            precise.push(...sp)
          }
          paraSplices = ok ? precise : null
        } else if (paraTextPureT(para, xml)) {
          // 엔티티 포함 문단 — para.text 좌표로 기록했으므로 문자열 적용 후
          // 전체 재작성 폴백 (tab/br 등 비-t 기여가 없을 때만 안전)
          let text = para.text
          for (let k = merged.length - 1; k >= 0; k--) {
            const r = merged[k]
            text = text.slice(0, r.start) + r.replacement + text.slice(r.end)
          }
          paraSplices = buildParagraphSplices(para, text, xml)
        } else {
          // 엔티티 + tab/br 동시 포함 — 안전한 치환 경로 없음, 채우기 포기
          paraSplices = null
        }
      }

      if (paraSplices === null) {
        // 적용할 수 없는 문단 — filled 레코드와 매칭 키를 회수해 unmatched로 복원
        for (const idx of l.filledIdx) filled[idx] = null
        for (const k of l.matchKeys) failedKeys.add(k)
        continue
      }
      for (const k of l.matchKeys) succeededKeys.add(k)
      splices.push(...paraSplices)
    }

    const fieldAt = fieldModified.get(sectionPaths[si])
    if (splices.length > 0 || fieldAt) {
      // 글이 바뀐 문단(누름틀 채움 포함)의 줄 레이아웃 캐시(linesegarray)만 비운다: 어긋난 캐시는 한컴 변조
      // 경고·옛 줄배치 렌더를 낳고, 손대지 않은 문단까지 지우면 자체 조판이 없는 뷰어가 쪽 전체를 다시 짠다 (patchHwpx와 동일)
      const marks = (fieldAt ?? []).map(at => ({ start: at, end: at, replacement: "" }))
      splices.push(...changedLinesegRemovalSplices(xml, [...splices, ...marks]))
      replacements.set(sectionPaths[si], encoder.encode(applySplices(xml, splices)))
    }
  }

  // splice 실패로만 쓰인 키는 unmatched로 복원 (다른 곳에 성공 적용됐으면 유지).
  // 배열 값은 실패분의 커서가 이미 전진해 그 값이 무음 소실되므로,
  // 부분 성공이어도 unmatched로 보고해 호출자가 유실을 알 수 있게 한다.
  for (const k of failedKeys) {
    if (!succeededKeys.has(k) || cursor.isArray(k)) matchedLabels.delete(k)
  }

  const cleanFilled = filled.filter((f): f is FormField => f !== null)
  const unmatched = resolveUnmatched(normalizedValues, matchedLabels, values)
  const out = replacements.size > 0 ? patchZipEntries(u8, replacements) : new Uint8Array(u8)
  return {
    buffer: out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer,
    filled: cleanFilled,
    unmatched,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** 섹션의 표: 문서 순서 DFS (중첩표 + 머리말 등 ctrl 내부 고아 표 포함) */
function collectAllTables(scan: SectionScan): ScanTable[] {
  const out: ScanTable[] = []
  const walk = (tables: ScanTable[], depth: number): void => {
    if (depth > 16) return
    for (const t of tables) {
      out.push(t)
      for (const row of t.rows) {
        for (const cell of row) walk(cell.tables, depth + 1)
      }
    }
  }
  walk(scan.tables, 0)
  walk(scan.orphanTables, 0)
  return out
}
