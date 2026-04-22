/** 2-pass colSpan/rowSpan 테이블 빌더 및 Markdown 변환 */

import type { CellContext, IRBlock, IRCell, IRTable } from "../types.js"
import { sanitizeHref } from "../utils.js"

/** 테이블 열 수 상한 — 한국 공공문서 기준 충분한 값 */
export const MAX_COLS = 200
/** 테이블 행 수 상한 — 메모리 폭주 방지 */
export const MAX_ROWS = 10000

export function buildTable(rows: CellContext[][]): IRTable {
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS)
  const numRows = rows.length

  // colAddr/rowAddr가 있으면 직접 배치 (HWPX cellAddr, HWP5 colAddr/rowAddr)
  const hasAddr = rows.some(row => row.some(c => c.colAddr !== undefined && c.rowAddr !== undefined))
  if (hasAddr) return buildTableDirect(rows, numRows)

  // Pass 1: maxCols 계산 — 2D 배열 사용 (동적 확장)
  let maxCols = 0
  const tempOccupied: boolean[][] = Array.from({ length: numRows }, () => [])

  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    for (const cell of rows[rowIdx]) {
      while (colIdx < MAX_COLS && tempOccupied[rowIdx][colIdx]) colIdx++
      if (colIdx >= MAX_COLS) break

      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, MAX_COLS); c++) {
          tempOccupied[r][c] = true
        }
      }
      colIdx += cell.colSpan
      if (colIdx > maxCols) maxCols = colIdx
    }
  }

  if (maxCols === 0) return { rows: 0, cols: 0, cells: [], hasHeader: false }

  // Pass 2: 실제 배치
  const grid: IRCell[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: maxCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  )
  const occupied: boolean[][] = Array.from({ length: numRows }, () => Array(maxCols).fill(false))

  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    let cellIdx = 0

    while (colIdx < maxCols && cellIdx < rows[rowIdx].length) {
      while (colIdx < maxCols && occupied[rowIdx][colIdx]) colIdx++
      if (colIdx >= maxCols) break

      const cell = rows[rowIdx][cellIdx]
      grid[rowIdx][colIdx] = {
        text: cell.text.trim(),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
      }

      for (let r = rowIdx; r < Math.min(rowIdx + cell.rowSpan, numRows); r++) {
        for (let c = colIdx; c < Math.min(colIdx + cell.colSpan, maxCols); c++) {
          occupied[r][c] = true
        }
      }

      colIdx += cell.colSpan
      cellIdx++
    }
  }

  return trimAndReturn(grid, numRows, maxCols)
}

/** colAddr/rowAddr 절대 좌표 기반 직접 배치 */
function buildTableDirect(rows: CellContext[][], numRows: number): IRTable {
  // 전체 셀에서 maxCols 계산 (MAX_COLS 상한 적용)
  let maxCols = 0
  for (const row of rows) {
    for (const cell of row) {
      const end = (cell.colAddr ?? 0) + cell.colSpan
      if (end > maxCols) maxCols = end
    }
  }
  if (maxCols > MAX_COLS) maxCols = MAX_COLS
  if (maxCols === 0) return { rows: 0, cols: 0, cells: [], hasHeader: false }

  const grid: IRCell[][] = Array.from({ length: numRows }, () =>
    Array.from({ length: maxCols }, () => ({ text: "", colSpan: 1, rowSpan: 1 }))
  )

  for (const row of rows) {
    for (const cell of row) {
      const r = cell.rowAddr ?? 0
      const c = cell.colAddr ?? 0
      if (r >= numRows || c >= maxCols || r < 0 || c < 0) continue

      grid[r][c] = { text: cell.text.trim(), colSpan: cell.colSpan, rowSpan: cell.rowSpan }

      // 병합 영역 마킹
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < maxCols) {
            grid[r + dr][c + dc] = { text: "", colSpan: 1, rowSpan: 1 }
          }
        }
      }
    }
  }

  return trimAndReturn(grid, numRows, maxCols)
}

/** 빈 후행 열 제거 후 IRTable 반환 */
function trimAndReturn(grid: IRCell[][], numRows: number, maxCols: number): IRTable {
  let effectiveCols = maxCols
  while (effectiveCols > 0) {
    const colEmpty = grid.every(row => !row[effectiveCols - 1]?.text?.trim())
    if (!colEmpty) break
    effectiveCols--
  }
  if (effectiveCols < maxCols && effectiveCols > 0) {
    const trimmed = grid.map(row => row.slice(0, effectiveCols))
    return { rows: numRows, cols: effectiveCols, cells: trimmed, hasHeader: numRows > 1 }
  }
  return { rows: numRows, cols: maxCols, cells: grid, hasHeader: numRows > 1 }
}

export function convertTableToText(rows: CellContext[][]): string {
  return rows
    .map(row =>
      row
        .map(c => c.text.trim().replace(/\n/g, " ").replace(/\|/g, "\\|"))
        .filter(Boolean)
        .join(" / ")
    )
    .filter(Boolean)
    .join("\n")
}

/** 마크다운 GFM 특수문자 이스케이프 — remark-gfm 오해석 방지 */
function escapeGfm(text: string): string {
  // ~ → \~ (GFM strikethrough 방지)
  return text.replace(/~/g, "\\~")
}

/** HWP 자동생성 도형/개체 대체텍스트 정규식 — 한컴오피스가 삽입하는 모든 알려진 패턴 */
const HWP_SHAPE_ALT_TEXT_RE = /(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?/g

/** HWP PUA 특수문자 및 도형 대체텍스트 제거 — 모든 포맷 공통 */
function sanitizeText(text: string): string {
  let result = text
    // Supplementary Private Use Area (U+F0000-U+FFFFD) — HWP 전용 기호
    .replace(/[\u{F0000}-\u{FFFFD}]/gu, "")
    // HWP 도형/개체 자동생성 대체텍스트 제거
    .replace(HWP_SHAPE_ALT_TEXT_RE, "")
    .replace(/  +/g, " ")
    .trim()
  // 균등배분 스페이스 정리 ("현 장 대 응 단 장" → "현장대응단장")
  // 짧은 텍스트(30자 이하)에서 70%+ 토큰이 한글 1글자면 균등배분으로 판단
  if (result.length <= 30 && result.includes(" ")) {
    const tokens = result.split(" ")
    // 한글 1글자 토큰만 카운트 — ASCII 특수문자(< > & 등)는 균등배분이 아님
    const koreanSingleCharCount = tokens.filter(t => t.length === 1 && /[\uAC00-\uD7AF\u3131-\u318E]/.test(t)).length
    if (tokens.length >= 3 && koreanSingleCharCount / tokens.length >= 0.7) {
      result = tokens.join("")
    }
  }
  return result
}

/**
 * 레이아웃 테이블 감지 및 해체 — IRBlock 레벨에서 수행
 * 적은 행(≤3) + 셀 내 줄바꿈 다량 → table 블록을 paragraph 블록들로 분해
 * heading 감지 전에 호출해야 해체된 텍스트에 heading 감지 적용 가능
 */
export function flattenLayoutTables(blocks: IRBlock[]): IRBlock[] {
  const result: IRBlock[] = []

  for (const block of blocks) {
    if (block.type !== "table" || !block.table) {
      result.push(block)
      continue
    }

    const { rows: numRows, cols: numCols, cells } = block.table

    // 1x1 테이블은 기존 로직(tableToMarkdown)에서 처리
    if (numRows === 1 && numCols === 1) {
      result.push(block)
      continue
    }

    // 레이아웃 테이블 휴리스틱
    if (numRows <= 3) {
      let totalNewlines = 0
      let totalTextLen = 0
      for (let r = 0; r < numRows; r++) {
        for (let c = 0; c < numCols; c++) {
          const t = cells[r]?.[c]?.text || ""
          totalNewlines += (t.match(/\n/g) || []).length
          totalTextLen += t.length
        }
      }

      // 레이아웃 테이블 판정: 많은 줄바꿈(>5), 또는 적은 행에 비해 총 텍스트 과다(>300)
      if (totalNewlines > 5 || (numRows <= 2 && totalTextLen > 300)) {
        // 레이아웃 테이블 → 각 셀을 paragraph 블록으로 분해
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const cellText = cells[r]?.[c]?.text?.trim()
            if (!cellText) continue
            // 셀 내 줄바꿈을 별도 paragraph로 분리
            for (const line of cellText.split("\n")) {
              const trimmed = line.trim()
              if (!trimmed) continue
              result.push({ type: "paragraph", text: trimmed, pageNumber: block.pageNumber })
            }
          }
        }
        continue
      }
    }

    result.push(block)
  }

  return result
}

export function blocksToMarkdown(blocks: IRBlock[]): string {
  const lines: string[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // 헤딩 블록
    if (block.type === "heading" && block.text) {
      const prefix = "#".repeat(Math.min(block.level || 2, 6))
      const headingText = sanitizeText(block.text)
      if (headingText) lines.push("", `${prefix} ${headingText}`, "")
      continue
    }

    // 이미지 블록 — ![alt](filename) 참조
    if (block.type === "image" && block.text) {
      lines.push("", `![image](${block.text})`, "")
      continue
    }

    // 구분선 블록
    if (block.type === "separator") {
      lines.push("", "---", "")
      continue
    }

    // 리스트 블록
    if (block.type === "list" && block.text) {
      const listText = sanitizeText(block.text)
      if (!listText) continue
      // 텍스트가 이미 번호로 시작하면 그대로 출력 (원래 번호 보존)
      const alreadyNumbered = block.listType === "ordered" && /^\d+\.\s/.test(listText)
      const prefix = alreadyNumbered ? "" : block.listType === "ordered" ? "1. " : "- "
      lines.push(`${prefix}${listText}`)
      if (block.children) {
        for (const child of block.children) {
          const childPrefix = child.listType === "ordered" ? "1." : "-"
          lines.push(`  ${childPrefix} ${child.text || ""}`)
        }
      }
      continue
    }

    if (block.type === "paragraph" && block.text) {
      let text = sanitizeText(block.text)
      if (!text) continue

      // 별표 패턴 (기존 호환)
      if (/^\[별표\s*\d+/.test(text)) {
        const nextBlock = blocks[i + 1]
        if (nextBlock?.type === "paragraph" && nextBlock.text && /관련\)?$/.test(nextBlock.text)) {
          lines.push("", `## ${text} ${nextBlock.text}`, "")
          i++
        } else {
          lines.push("", `## ${text}`, "")
        }
        continue
      }

      if (/^\([^)]*조[^)]*관련\)$/.test(text)) {
        lines.push(`*${text}*`, "")
        continue
      }

      // 하이퍼링크가 있으면 텍스트에 링크 삽입 (javascript: 등 위험 스킴 제거)
      if (block.href) {
        const href = sanitizeHref(block.href)
        if (href) text = `[${text}](${href})`
      }

      // 각주가 있으면 괄호로 인라인 삽입
      if (block.footnoteText) {
        text += ` (주: ${block.footnoteText})`
      }

      lines.push(escapeGfm(text), "")
    } else if (block.type === "table" && block.table) {
      // 테이블 앞에 빈 줄 보장 (마크다운 렌더링 필수)
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("")
      }
      const tableMd = tableToMarkdown(block.table)
      if (tableMd) {
        lines.push(tableMd)
        lines.push("")
      }
    }
  }

  return lines.join("\n").trim()
}

/** 병합 셀 존재 여부 확인 */
function hasMergedCells(table: IRTable): boolean {
  for (const row of table.cells) {
    for (const cell of row) {
      if (cell.colSpan > 1 || cell.rowSpan > 1) return true
    }
  }
  return false
}

function containsInlineMath(text: string): boolean {
  return /(^|[^\\])\$(?=\S)(?:\\.|[^$\n])+?\S\$/.test(text)
}

function tableContainsInlineMath(table: IRTable): boolean {
  for (const row of table.cells) {
    for (const cell of row) {
      if (containsInlineMath(cell.text)) return true
    }
  }
  return false
}

/** 병합 테이블 → HTML <table> 출력 (rowspan/colspan 보존) */
function tableToHtml(table: IRTable): string {
  const { cells, rows: numRows, cols: numCols } = table
  const skip = new Set<string>()
  const lines: string[] = ["<table>"]

  for (let r = 0; r < numRows; r++) {
    const tag = r === 0 ? "th" : "td"
    const rowHtml: string[] = []
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = cells[r]?.[c]
      if (!cell) continue

      // 병합 영역 skip 마킹
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`)
        }
      }

      const text = sanitizeText(cell.text).replace(/\n/g, "<br>")
      const attrs: string[] = []
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`)
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`)
      const attrStr = attrs.length ? " " + attrs.join(" ") : ""
      rowHtml.push(`<${tag}${attrStr}>${text}</${tag}>`)
    }
    if (rowHtml.length) lines.push(`<tr>${rowHtml.join("")}</tr>`)
  }

  lines.push("</table>")
  return lines.join("\n")
}

function tableToMarkdown(table: IRTable): string {
  if (table.rows === 0 || table.cols === 0) return ""

  const { cells, rows: numRows, cols: numCols } = table

  // 병합 셀이 있으면 HTML 테이블로 출력하되, 수식이 있으면 GFM 표로 출력한다.
  // 많은 Markdown 렌더러가 raw HTML table 내부의 $...$를 수식으로 다시 처리하지 않는다.
  if (hasMergedCells(table) && !tableContainsInlineMath(table)) return tableToHtml(table)

  // 1행 1열 → 구조화된 텍스트 (빈 셀이면 스킵)
  if (numRows === 1 && numCols === 1) {
    const content = sanitizeText(cells[0][0].text)
    if (!content) return ""
    return content
      .split(/\n/)
      .map(line => {
        const trimmed = line.trim()
        if (!trimmed) return ""
        if (/^\d+\.\s/.test(trimmed)) return `**${escapeGfm(trimmed)}**`
        if (/^[가-힣]\.\s/.test(trimmed)) return `  ${escapeGfm(trimmed)}`
        return escapeGfm(trimmed)
      })
      .filter(Boolean)
      .join("\n")
  }

  // 1열 다행 테이블 → 각 행을 별도 라인으로 출력 (목록성 데이터)
  if (numCols === 1 && numRows >= 2) {
    return cells
      .map(row => escapeGfm(sanitizeText(row[0].text)).replace(/\n/g, " "))
      .filter(Boolean)
      .join("\n")
  }

  // 병합 셀: 행/열 병합된 셀은 빈 칸으로
  const display: string[][] = Array.from({ length: numRows }, () => Array(numCols).fill(""))
  const skip = new Set<string>()

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = cells[r]?.[c]
      if (!cell) continue
      display[r][c] = escapeGfm(sanitizeText(cell.text)).replace(/\|/g, "\\|").replace(/\n/g, "<br>")

      // colSpan/rowSpan: 병합된 열은 빈 칸으로 유지 (텍스트 중복 방지)
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < numCols) {
            skip.add(`${r + dr},${c + dc}`)
          }
        }
      }
      // colSpan > 1이면 display 열 인덱스를 건너뜀
      c += cell.colSpan - 1
    }
  }

  // rowSpan 잔류 처리:
  // 1) 완전 빈 행 제거
  // 2) "첫 열만 값, 나머지 빈" 행 → 다음 데이터 행의 첫 열에 값을 전파
  //    단, colSpan으로 인한 빈 열(skip 셀)은 이 대상이 아님
  const uniqueRows: string[][] = []
  let pendingFirstCol = ""
  for (let r = 0; r < display.length; r++) {
    const row = display[r]
    const isEmptyPlaceholder = row.every(cell => cell === "")
    if (isEmptyPlaceholder) continue

    // 첫 열만 값이 있고 나머지 모두 빈 행 → 다음 데이터 행의 첫 열에 전파
    // 단, colSpan으로 인한 빈 열(skip 셀)은 "진짜 빈"이 아니므로 제외
    const nonEmptyCols = row.filter(cell => cell !== "")
    const hasSkipInRow = row.some((_, c) => skip.has(`${r},${c}`))
    if (!hasSkipInRow && nonEmptyCols.length === 1 && row[0] !== "" && row.slice(1).every(c => c === "")) {
      pendingFirstCol = row[0]
      continue
    }

    // 저장된 첫 열 값을 현재 행의 빈 첫 열에 전파
    if (pendingFirstCol && row[0] === "") {
      row[0] = pendingFirstCol
      pendingFirstCol = ""
    } else {
      pendingFirstCol = ""
    }
    uniqueRows.push(row)
  }

  if (uniqueRows.length === 0) return ""

  const md: string[] = []
  md.push("| " + uniqueRows[0].join(" | ") + " |")
  md.push("| " + uniqueRows[0].map(() => "---").join(" | ") + " |")
  for (let i = 1; i < uniqueRows.length; i++) {
    md.push("| " + uniqueRows[i].join(" | ") + " |")
  }
  return md.join("\n")
}
