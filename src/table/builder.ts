/** 2-pass colSpan/rowSpan 테이블 빌더 및 Markdown 변환 */

import type { CellContext, IRBlock, IRCell, IRSpan, IRTable } from "../types.js"
import { sanitizeHref } from "../utils.js"
import { mapPuaText } from "../shared/pua.js"

/** 테이블 열 수 상한 — 한국 공공문서 기준 충분한 값 */
export const MAX_COLS = 200
/** 테이블 행 수 상한 — 메모리 폭주 방지 */
export const MAX_ROWS = 10000

export interface BuildTableOptions {
  /** 실제 셀 앵커가 있는 빈 후행 열(서식 문서의 입력란)을 보존한다 (#47).
   *  앵커 없는 유령 열(span 인플레이션)은 이 옵션과 무관하게 트림.
   *  기본 false: 종전대로 텍스트 기준 전부 트림 (마크다운 가독성·벤치 계약). */
  keepAnchoredEmptyCols?: boolean
}

export function buildTable(rows: CellContext[][], options?: BuildTableOptions): IRTable {
  if (rows.length > MAX_ROWS) rows = rows.slice(0, MAX_ROWS)
  const numRows = rows.length

  // colAddr/rowAddr가 있으면 직접 배치 (HWPX cellAddr, HWP5 colAddr/rowAddr)
  const hasAddr = rows.some(row => row.some(c => c.colAddr !== undefined && c.rowAddr !== undefined))
  if (hasAddr) return buildTableDirect(rows, numRows, options)

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
  const anchorCols = new Set<number>()

  for (let rowIdx = 0; rowIdx < numRows; rowIdx++) {
    let colIdx = 0
    let cellIdx = 0

    while (colIdx < maxCols && cellIdx < rows[rowIdx].length) {
      while (colIdx < maxCols && occupied[rowIdx][colIdx]) colIdx++
      if (colIdx >= maxCols) break

      const cell = rows[rowIdx][cellIdx]
      anchorCols.add(colIdx)
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

  return trimAndReturn(grid, numRows, maxCols, anchorCols, options)
}

/** colAddr/rowAddr 절대 좌표 기반 직접 배치 */
function buildTableDirect(rows: CellContext[][], numRows: number, options?: BuildTableOptions): IRTable {
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

  const anchorCols = new Set<number>()
  for (const row of rows) {
    for (const cell of row) {
      const r = cell.rowAddr ?? 0
      const c = cell.colAddr ?? 0
      if (r >= numRows || c >= maxCols || r < 0 || c < 0) continue

      anchorCols.add(c)
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

  return trimAndReturn(grid, numRows, maxCols, anchorCols, options)
}

/** 빈 후행 열 제거 후 IRTable 반환 — 기본 텍스트 기준 전부, keepAnchoredEmptyCols면 앵커 없는 유령 열만 (#47) */
function trimAndReturn(grid: IRCell[][], numRows: number, maxCols: number, anchorCols: Set<number>, options?: BuildTableOptions): IRTable {
  let effectiveCols = maxCols
  while (effectiveCols > 0) {
    const colEmpty = grid.every(row => !row[effectiveCols - 1]?.text?.trim())
    if (!colEmpty) break
    // 실제 셀 앵커가 있는 빈 열은 서식 문서의 입력란 — 옵션 시 트림하지 않는다 (#47)
    if (options?.keepAnchoredEmptyCols && anchorCols.has(effectiveCols - 1)) break
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
  // ~ → \~ (GFM strikethrough 방지), * → \* (emphasis/HR·마스킹 별표 "******" 방지),
  // _ → \_ (emphasis 방지), ` → \` (inline code 방지).
  // 단 $...$ / $$...$$ 수식 스팬은 KaTeX 문법이라 이스케이프하면 파스 에러가 나므로 보호한다
  // (스팬을 임시 필러로 가린 뒤 escape → 복원). NUL 필러는 마크다운 본문에 등장하지 않는다.
  // ![image](image_001.png) 이미지 참조 스팬과 링크 URL부 `](스킴...)`(sanitizeHref 허용
  // 스킴 한정 — 우연한 "[라벨](식별자)" 평문은 제외)도 동일 보호 — _ 이스케이프 시 문법 파괴.
  const NUL = String.fromCharCode(0) // 마크다운 본문에 없는 안전한 필러 (소스에 raw NUL 미기입)
  const spans: string[] = []
  const masked = text.replace(/!\[[^\]]*\]\([^)\n]*\)|\]\((?:https?:|mailto:|tel:|#)[^)\n]*\)|\$\$[^$]*\$\$|\$[^$\n]*\$/gi, (m) => {
    spans.push(m)
    return NUL + (spans.length - 1) + NUL
  })
  const escaped = masked.replace(/([~*_`])/g, "\\$1")
  return escaped.replace(new RegExp(NUL + "(\\d+)" + NUL, "g"), (_, n) => spans[Number(n)])
}

/** HWP 자동생성 도형/개체 대체텍스트 정규식 — 한컴오피스가 삽입하는 모든 알려진 패턴.
 *  행 전체 일치(^…$m)로 한정 — 무앵커면 "붙임 문서는 표 입니다." 같은 본문 중간을 오삭제한다 */
const HWP_SHAPE_ALT_TEXT_RE = /^(?:모서리가 둥근 |둥근 )?(?:사각형|직사각형|정사각형|원|타원|삼각형|이등변 삼각형|직각 삼각형|선|직선|곡선|화살표|굵은 화살표|이중 화살표|오각형|육각형|팔각형|별|[4-8]점별|십자|십자형|구름|구름형|마름모|도넛|평행사변형|사다리꼴|부채꼴|호|반원|물결|번개|하트|빗금|블록 화살표|수식|표|그림|개체|그리기\s?개체|묶음\s?개체|글상자|수식\s?개체|OLE\s?개체)\s?입니다\.?$/gm

/** HWP PUA 특수문자 및 도형 대체텍스트 제거 — 모든 포맷 공통 */
function sanitizeText(text: string): string {
  // 한컴 PUA → 표준 유니코드 매핑 (rhwp 검증 테이블) — 제거 regex보다 먼저 적용
  let result = mapPuaText(text)
    // Supplementary Private Use Area (U+F0000-U+FFFFD) — HWP 전용 기호 (매핑 안 된 잔여분)
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
 *
 * 호출 정책(의도): HWP5 파서만 호출한다. 구형 HWP5 문서는 제목/본문을 표로
 * 감싼 레이아웃 표가 흔하지만, HWPX는 그 관행이 드물고 무엇보다 patchHwpx/
 * fillHwpx 무손실 라운드트립이 "파서 렌더 = 소스맵 표 서수" 대응에 의존하므로
 * HWPX에서 표를 문단으로 해체하면 표 매핑이 깨진다. HWPX 적용은 코퍼스
 * 전/후 정량 비교 + 라운드트립 e2e 검증이 선행되어야 한다.
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
      // 단, 열이 4개 이상이면 헤더-값 구조의 데이터 표일 가능성이 높아 해체하지 않는다
      // (실증: 2×10 모집프로그램 표가 문단으로 해체되어 헤더↔값 연결 파괴)
      if (numCols < 4 && (totalNewlines > 5 || (numRows <= 2 && totalTextLen > 300))) {
        // 레이아웃 테이블 → 각 셀을 paragraph 블록으로 분해
        for (let r = 0; r < numRows; r++) {
          for (let c = 0; c < numCols; c++) {
            const cell = cells[r]?.[c]
            if (!cell) continue
            // 셀에 구조화 블록(중첩표·이미지·다중문단)이 있으면 재귀 해체로 구조 보존.
            // 중첩 spec 표(numRows>3)는 해체되지 않고 실제 table 블록으로 살아남는다
            // (text의 " / " 평탄화 폴백으로만 남아 유실되던 버그 수정). 셀 blocks는
            // 이미 같은 pageNumber로 생성되므로 그대로 보존된다.
            if (cell.blocks?.length) {
              result.push(...flattenLayoutTables(cell.blocks))
              continue
            }
            const cellText = cell.text?.trim()
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

/** 러닝 헤더 후보 판정 최대 길이 — 긴 본문 문단을 헤더로 오인하지 않도록 */
const RUNNING_HEADER_MAX_LEN = 40
/** 러닝 헤더로 판정할 최소 반복 횟수 — 페이지마다 재삽입되는 노이즈만 제거 */
const RUNNING_HEADER_MIN_FREQ = 3

/** 러닝 헤더 후보 여부 — 짧은 번호매김 섹션 제목("2. 과제 구축 내용")만 */
function isRunningHeaderCandidate(block: IRBlock): boolean {
  if (block.type !== "paragraph" && block.type !== "heading") return false
  const text = block.text?.trim()
  if (!text || text.length > RUNNING_HEADER_MAX_LEN) return false
  return /^\d+\.\s/.test(text)
}

/**
 * 페이지 레이아웃 표에서 유래한 반복 러닝 헤더 문단 중복 제거 — IRBlock 레벨.
 *
 * 배경: 구형 HWP5 문서(군 제안서 등)는 본문 전체를 "페이지 = N×1 표" 사슬로
 * 구성하고 각 표의 cell(0,0)에 동일한 섹션 헤더("2. 과제 구축 내용")를 반복
 * 배치한다. flattenLayoutTables가 이 표들을 문단으로 해체하면 같은 헤더가
 * 페이지마다 1회씩 독립 문단으로 남아 본문 사이에 노이즈로 흩어진다. HWP
 * 머리말/꼬리말(CTRL_HEAD/CTRL_FOOT)은 applyHeaderFooterEffect에서 이미
 * dedupe되지만, 본문 레이아웃 표의 러닝 헤더는 그 대상이 아니다.
 *
 * 정책(보수적): "짧은 번호매김 섹션 제목"이 정확히 동일 텍스트로 3회 이상
 * 반복될 때만 최초 1회를 남기고 이후 중복을 제거한다. 비후보 블록과 3회 미만
 * 후보는 원형 그대로 통과시킨다(본문 삭제 위험 최소화). 위치 무관 — 평탄화된
 * 블록 스트림 전체를 대상으로 하며, 입력 블록을 변형하지 않고 새 배열을 반환한다.
 */
export function dedupeRunningHeaders(blocks: IRBlock[]): IRBlock[] {
  // Pass 1: 후보 텍스트 빈도 집계
  const freq = new Map<string, number>()
  for (const block of blocks) {
    if (!isRunningHeaderCandidate(block)) continue
    const text = block.text!.trim()
    freq.set(text, (freq.get(text) ?? 0) + 1)
  }

  // Pass 2: 빈도 ≥ 임계값인 후보는 최초 1회만 유지, 이후 중복 제거
  const seen = new Set<string>()
  const result: IRBlock[] = []
  for (const block of blocks) {
    if (isRunningHeaderCandidate(block)) {
      const text = block.text!.trim()
      if ((freq.get(text) ?? 0) >= RUNNING_HEADER_MIN_FREQ) {
        if (seen.has(text)) continue // 이후 중복 — 제거
        seen.add(text)
      }
    }
    result.push(block)
  }

  return result
}

/**
 * 왕복 채널 run-span → 강조 마커 재방출. 마커는 텍스트에 밀착해야 유효하므로
 * span 가장자리 공백은 마커 밖으로 옮긴다. 코드 span 내부는 이스케이프 없이 원문.
 */
function spansToMarkdown(spans: IRSpan[]): string {
  let out = ""
  for (const s of spans) {
    if (!s.text) continue
    const marker = s.code ? "`" : s.bold && s.italic ? "***" : s.bold ? "**" : s.italic ? "*" : ""
    if (!marker) {
      out += escapeGfm(s.text)
      continue
    }
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s.text)!
    const core = m[2]
    if (!core) {
      out += s.text
      continue
    }
    out += m[1] + marker + (s.code ? core : escapeGfm(core)) + marker + m[3]
  }
  return out
}

export function blocksToMarkdown(blocks: IRBlock[]): string {
  const lines: string[] = []

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]

    // 헤딩 블록 — escapeGfm 필수: 마스킹 별표("홍**")가 볼드로 소비·삭제되는 것 방지
    if (block.type === "heading" && block.text) {
      const prefix = "#".repeat(Math.min(block.level || 2, 6))
      const headingText = sanitizeText(block.text)
      if (headingText) lines.push("", `${prefix} ${escapeGfm(headingText)}`, "")
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
      lines.push(`${prefix}${escapeGfm(listText)}`)
      if (block.children) {
        for (const child of block.children) {
          const childPrefix = child.listType === "ordered" ? "1." : "-"
          lines.push(`  ${childPrefix} ${escapeGfm(child.text || "")}`)
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
          lines.push("", `## ${escapeGfm(text)} ${escapeGfm(nextBlock.text)}`, "")
          i++
        } else {
          lines.push("", `## ${escapeGfm(text)}`, "")
        }
        continue
      }

      if (/^\([^)]*조[^)]*관련\)$/.test(text)) {
        lines.push(`*${escapeGfm(text)}*`, "")
        continue
      }

      // gongmun 리스트 depth 선행 공백 (v4.0.5) — sanitizeText가 선두 공백을 지우므로
      // 텍스트가 아니라 방출 시점에 붙인다. 2칸/단계 = md-runs 리스트 그리드와 동일
      const listIndent = block.listDepth ? "  ".repeat(block.listDepth) : ""

      // 인라인 강조 run-span (왕복 채널 — 자사 생성 파일 + 외래 실속성 복원) → 마커 재방출.
      // 마커 자체는 이스케이프 대상이 아니므로 span 내부 텍스트만 escapeGfm 후 감싼다
      if (block.spans?.length) {
        let rendered = spansToMarkdown(block.spans)
        if (block.href) {
          const href = sanitizeHref(block.href)
          if (href) rendered = `[${rendered}](${href})`
        }
        if (block.footnoteText) rendered += ` (주: ${block.footnoteText})`
        lines.push(block.quote ? "> " + rendered : listIndent + rendered, "")
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

      lines.push(block.quote ? "> " + escapeGfm(text) : listIndent + escapeGfm(text), "")
    } else if (block.type === "table" && block.table) {
      // 테이블 앞에 빈 줄 보장 (마크다운 렌더링 필수)
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("")
      }
      // 표 캡션 — 표 위에 강조 문단으로 출력 (v3.0)
      if (block.table.caption) {
        const caption = sanitizeText(block.table.caption)
        if (caption) lines.push(`**${escapeGfm(caption)}**`, "")
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

/** 셀 내부에 중첩 표 블록 존재 여부 — v3.0 */
function hasNestedTables(table: IRTable): boolean {
  for (const row of table.cells) {
    for (const cell of row) {
      if (cell.blocks?.some(b => b.type === "table" && b.table)) return true
    }
  }
  return false
}

/** 셀 내부 콘텐츠 → HTML — blocks(중첩표/다중문단) 있으면 구조 보존 재귀 렌더링 */
function cellInnerHtml(cell: IRCell): string {
  if (cell.blocks?.length) {
    return cell.blocks
      .map(b => {
        if (b.type === "table" && b.table) {
          // 중첩표 캡션도 보존 — 표 위에 텍스트로
          const cap = b.table.caption ? sanitizeText(b.table.caption) : ""
          return (cap ? cap + "<br>" : "") + tableToHtml(b.table)
        }
        if (b.type === "image" && b.text) return `<img src="${b.text}" alt="image">`
        const t = sanitizeText(b.text ?? "")
        return t ? t.replace(/\n/g, "<br>") : ""
      })
      .filter(Boolean)
      .join("<br>")
  }
  return sanitizeText(cell.text).replace(/\n/g, "<br>")
}

function containsInlineMath(text: string): boolean {
  // 교대 중복 금지: [^$\n\\]가 백슬래시를 제외해 \\.와 겹치지 않는다 —
  // 겹치면 "$"+백슬래시 연속 입력에서 지수 백트래킹(ReDoS)
  return /(^|[^\\])\$(?=\S)(?:[^$\n\\]|\\.)+?\S\$/.test(text)
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

      const text = cellInnerHtml(cell)
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

  // 병합 셀·중첩표가 있으면 HTML 테이블로 출력하되, 수식이 있으면 GFM 표로 출력한다.
  // 많은 Markdown 렌더러가 raw HTML table 내부의 $...$를 수식으로 다시 처리하지 않는다.
  if ((hasMergedCells(table) || hasNestedTables(table)) && !tableContainsInlineMath(table)) {
    return tableToHtml(table)
  }

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
      // 왕복 채널 셀 spans (v4.0.4) — 강조 마커 재방출 (문단별, 개행은 <br> 규약)
      display[r][c] = (cell.blocks?.some(b => b.spans)
        ? cell.blocks
          .map(b => b.type === "image" && b.text
            ? `![image](${b.text})`
            : b.spans ? spansToMarkdown(b.spans) : escapeGfm(sanitizeText(b.text ?? "")))
          .filter(Boolean)
          .join("<br>")
        : escapeGfm(sanitizeText(cell.text)).replace(/\n/g, "<br>")
      ).replace(/\|/g, "\\|")

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
  let pendingLabelRow: string[] | null = null
  for (let r = 0; r < display.length; r++) {
    const row = display[r]
    if (row.every(cell => cell === "")) {
      // rowSpan 잔류 행(병합 커버 셀 포함 — 병합+수식 GFM 경로)만 제거.
      // 앵커 셀이 전부 빈 텍스트인 진짜 빈 행은 문서 구조 — 보존해야 왕복이 성립한다.
      if (row.some((_, c) => skip.has(`${r},${c}`))) continue
      if (pendingLabelRow) { uniqueRows.push(pendingLabelRow); pendingLabelRow = null }
      uniqueRows.push(row)
      continue
    }

    // 첫 열만 값이 있고 나머지 모두 빈 행 → 다음 데이터 행의 첫 열에 전파
    // 단, colSpan으로 인한 빈 열(skip 셀)은 "진짜 빈"이 아니므로 제외
    const nonEmptyCols = row.filter(cell => cell !== "")
    const hasSkipInRow = row.some((_, c) => skip.has(`${r},${c}`))
    if (!hasSkipInRow && nonEmptyCols.length === 1 && row[0] !== "" && row.slice(1).every(c => c === "")) {
      if (pendingLabelRow) uniqueRows.push(pendingLabelRow) // 연속 보류 — 앞 행 소실 방지
      pendingLabelRow = row
      continue
    }

    // 보류한 첫 열 값을 현재 행의 빈 첫 열에 전파, 전파 불가면 보류 행 그대로 출력
    if (pendingLabelRow) {
      if (row[0] === "") row[0] = pendingLabelRow[0]
      else uniqueRows.push(pendingLabelRow)
      pendingLabelRow = null
    }
    uniqueRows.push(row)
  }
  if (pendingLabelRow) uniqueRows.push(pendingLabelRow) // 표 끝 보류 행 소실 방지

  if (uniqueRows.length === 0) return ""

  const md: string[] = []
  md.push("| " + uniqueRows[0].join(" | ") + " |")
  md.push("| " + uniqueRows[0].map(() => "---").join(" | ") + " |")
  for (let i = 1; i < uniqueRows.length; i++) {
    md.push("| " + uniqueRows[i].join(" | ") + " |")
  }
  return md.join("\n")
}
