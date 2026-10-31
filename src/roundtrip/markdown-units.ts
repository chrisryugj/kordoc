/**
 * 라운드트립 마크다운 유닛 — blocksToMarkdown 출력과 호환되는 블록 단위 분할.
 *
 * 원본 마크다운(=blocksToMarkdown 출력)과 편집된 마크다운을 같은 규칙으로
 * 분할해 유닛 단위 diff를 수행한다. 표는 builder.ts의 GFM/HTML 렌더링을
 * 좌표 추적(provenance) 버전으로 재현해, 편집된 셀 → IRTable 격자 좌표를
 * 역산한다. 재현 결과가 원본 마크다운과 다르면 해당 표는 graceful skip
 * 대상이 된다 (builder와의 드리프트 자기 검증).
 */

import type { IRTable } from "../types.js"
import { MAX_COLS, MAX_ROWS, cellToMarkdown, escapeGfm, escapeHtmlCellText, hasInlineCellBlocks, noteSuffix, noteTableHtml, sanitizeText, visibleText } from "../table/builder.js"
import { escapeHtml, unescapeHtml } from "../utils.js"
import { clampSpan } from "../hwpx/parser-shared.js"
import { normalizedSimilarity } from "../diff/text-diff.js"

// ─── 유닛 분할 ───────────────────────────────────────

export type UnitKind = "text" | "gfm-table" | "html-table" | "separator" | "image"

export interface MdUnit {
  kind: UnitKind
  /** 원문 그대로 (트림된 라인 조인) */
  raw: string
  /** 라인 배열 */
  lines: string[]
}

/** blocksToMarkdown 출력 호환 마크다운 블록 분할 */
export function splitMarkdownUnits(md: string): MdUnit[] {
  const lines = md.split("\n")
  const units: MdUnit[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]
    if (!line.trim()) { i++; continue }

    // HTML 표 — <table> ~ 짝이 맞는 </table>
    if (line.trim().startsWith("<table>")) {
      const collected: string[] = []
      let depth = 0
      while (i < lines.length) {
        const l = lines[i]
        collected.push(l)
        depth += (l.match(/<table>/g) || []).length
        depth -= (l.match(/<\/table>/g) || []).length
        i++
        if (depth <= 0) break
      }
      units.push({ kind: "html-table", raw: collected.join("\n"), lines: collected })
      continue
    }

    // GFM 표 — 연속된 | 시작 라인
    if (line.trimStart().startsWith("|")) {
      const collected: string[] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        collected.push(lines[i])
        i++
      }
      units.push({ kind: "gfm-table", raw: collected.join("\n"), lines: collected })
      continue
    }

    // 구분선
    if (/^-{3,}\s*$/.test(line.trim())) {
      units.push({ kind: "separator", raw: line.trim(), lines: [line.trim()] })
      i++
      continue
    }

    // 이미지 단독 라인
    if (/^!\[image\]\([^)]*\)\s*$/.test(line.trim())) {
      units.push({ kind: "image", raw: line.trim(), lines: [line.trim()] })
      i++
      continue
    }

    // 일반 텍스트 — 연속 비공백 라인 묶음 (1x1/1열 표 청크 포함)
    const collected: string[] = []
    while (i < lines.length && lines[i].trim()
      && !lines[i].trimStart().startsWith("|")
      && !lines[i].trim().startsWith("<table>")) {
      collected.push(lines[i].trim())
      i++
    }
    units.push({ kind: "text", raw: collected.join("\n"), lines: collected })
  }

  return units
}

// ─── 정렬 (정확 일치 LCS + 갭 유사도 페어링) ─────────
// 유닛(블록)과 표 행 양쪽에서 공용 — patcher.ts에서 이동 (v3.7)

export type AlignedPair = [number | null, number | null]

export function alignUnits(a: string[], b: string[]): AlignedPair[] {
  const m = a.length, n = b.length
  if (m * n > 4_000_000) {
    // 대형 문서 보호 — dense LCS 불가. 공통 prefix/suffix만 정확 일치로 페어링하고
    // 가운데 구간은 길이가 같을 때만 인덱스 페어링, 다르면(블록 추가/삭제) 전부
    // 추가/삭제로 보고해 시프트 오적용(전 문단이 한 칸씩 밀려 덮어써짐)을 차단한다.
    const result: AlignedPair[] = []
    let pre = 0
    while (pre < m && pre < n && a[pre] === b[pre]) { result.push([pre, pre]); pre++ }
    let suf = 0
    while (suf < m - pre && suf < n - pre && a[m - 1 - suf] === b[n - 1 - suf]) suf++
    const aMid = m - pre - suf, bMid = n - pre - suf
    if (aMid === bMid) {
      for (let i = 0; i < aMid; i++) result.push([pre + i, pre + i])
    } else {
      for (let i = 0; i < aMid; i++) result.push([pre + i, null])
      for (let j = 0; j < bMid; j++) result.push([null, pre + j])
    }
    for (let s = suf - 1; s >= 0; s--) result.push([m - 1 - s, n - 1 - s])
    return result
  }

  // 정확 일치 LCS
  const dp: Int32Array[] = Array.from({ length: m + 1 }, () => new Int32Array(n + 1))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }
  const matches: [number, number][] = []
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      matches.push([i - 1, j - 1]); i--; j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) i--
    else if (dp[i - 1][j] < dp[i][j - 1]) j--
    // 비기면 a 를 먼저 당기되, 두 목록의 어긋남(i−j)이 끝의 어긋남(m−n)보다 작아졌으면 b 를 당겨 되돌린다 — 늘 a 를 먼저
    // 당기면 같은 글 단위가 떨어져 여럿일 때 b 의 단위가 앞쪽 같은 글과 짝지어져 멀쩡한 고침이 추가·삭제로 보였다
    else if (i - j >= m - n) i--
    else j--
  }
  matches.reverse()

  // 갭 구간 페어링 — 양쪽 갭 크기가 같으면 위치 기반(전면 재작성 인정),
  // 다르면 유사도 기반으로 수정/추가/삭제 구분
  const result: AlignedPair[] = []
  let ai = 0, bi = 0
  const flushGap = (aEnd: number, bEnd: number) => {
    if (aEnd - ai === bEnd - bi) {
      while (ai < aEnd) result.push([ai++, bi++])
      return
    }
    while (ai < aEnd && bi < bEnd) {
      const sim = normalizedSimilarity(a[ai], b[bi])
      if (sim >= 0.4) {
        // 갭이 긴 쪽에 더 나은 후보가 있으면 현재 항목은 삭제/추가로 밀어낸다 —
        // 비슷한 두 문단 중 하나를 지운 편집에서 남은 문단이 덮어써지는 것을 방지
        if (aEnd - ai > bEnd - bi && bestSimInRange(a, ai + 1, ai + (aEnd - ai) - (bEnd - bi), b[bi]) > sim) {
          result.push([ai++, null])
        } else if (bEnd - bi > aEnd - ai && bestSimInRange(b, bi + 1, bi + (bEnd - bi) - (aEnd - ai), a[ai]) > sim) {
          result.push([null, bi++])
        } else {
          result.push([ai++, bi++])
        }
      } else if (aEnd - ai >= bEnd - bi) result.push([ai++, null])
      else result.push([null, bi++])
    }
    while (ai < aEnd) result.push([ai++, null])
    while (bi < bEnd) result.push([null, bi++])
  }
  for (const [pi, pj] of matches) {
    flushGap(pi, pj)
    result.push([ai++, bi++])
  }
  flushGap(m, n)
  return result
}

/** [from, to] 범위에서 target과의 최고 유사도 */
function bestSimInRange(arr: string[], from: number, to: number, target: string): number {
  let best = 0
  for (let k = from; k <= to && k < arr.length; k++) {
    const s = normalizedSimilarity(arr[k], target)
    if (s > best) best = s
  }
  return best
}

// ─── builder.ts 텍스트 변환 재현 (드리프트 시 자기 검증으로 skip) ─────

/** GFM 특수문자 이스케이프 — builder.ts escapeGfm 이 SSOT (재현 드리프트 방지, 사본 두지 않음) */
export { escapeGfm }

/** 표 글 정리(PUA 매핑 + 대체텍스트 제거 + 균등배분 정리) — builder.ts sanitizeText 가 SSOT. 사본을 두었더니 날짜 칸 규칙(v4.12.1
 *  "년 월 일" 은 균등배분이 아님)이 빠져 별지 서식 표가 무수정이어도 "표 좌표 재현 불일치" 로 건너뛰었다(#144) */
export { sanitizeText }

/** 매칭용 정규화 — sanitize + 공백 붕괴. 스캔 텍스트(IR 변환 전)와 IR 텍스트 양쪽에 적용.
 *  IR 은 리터럴 $ 를 \$ 로(escapeLiteralDollar), 태그 꼴 글자 "<sub>" 를 \<sub> 로(escapeLiteralTags) 담으므로 원문 쪽과 같게 푼다 */
export function normForMatch(text: string): string {
  return sanitizeText(text.replace(/\\\$/g, "$").replace(/\\(?=<\/?(?:u|sup|sub)>)/g, "")).replace(/\s+/g, " ").trim()
}

/** 편집된 마크다운 텍스트 → 평문 (escapeGfm 역변환 — \| \# \< \$ \\ 포함, 없으면 hp:t 에 백슬래시가 샌다) */
export function unescapeGfm(text: string): string {
  return text.replace(/\\([~*_`|#<$\\])/g, "$1")
}

/** 스킵 보고용 내용 요약 (최대 80자) */
export function summarize(text: string): string {
  const t = text.replace(/\s+/g, " ").trim()
  return t.length > 80 ? t.slice(0, 77) + "..." : t
}

// ─── GFM 표 — 좌표 추적 렌더 재현 + 파서 ────────────

export interface MappedCell {
  text: string
  gridR: number
  gridC: number
}

/**
 * builder.ts tableToMarkdown의 GFM 경로 재현 — 출력 셀마다 격자 좌표 기록.
 * (병합/중첩 표는 HTML 경로이므로 여기 오지 않음. 1x1/1열 표는 별도 처리)
 * 반환 null이면 GFM 경로가 아니라는 뜻.
 */
export function replicateGfmTable(table: IRTable): MappedCell[][] | null {
  const { cells, rows: numRows, cols: numCols } = table
  if (numRows === 0 || numCols === 0) return null
  if (numRows === 1 && numCols === 1) return null
  if (numCols === 1) return null

  const display: MappedCell[][] = Array.from({ length: numRows }, (_, r) =>
    Array.from({ length: numCols }, (_, c) => ({ text: "", gridR: r, gridC: c })))
  const skip = new Set<string>()

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = cells[r]?.[c]
      if (!cell) continue
      // builder pipeTable 과 같은 칸 글 — 칸 블록의 강조 표지·그림·미기입 누름틀 안내문(뺌)까지 builder 함수 그대로
      display[r][c] = {
        text: cellToMarkdown(cell, "<br>").replace(/\r\n|\r|\n/g, "<br>").replace(/(?<!\\)\|/g, "\\|"),
        gridR: r,
        gridC: c,
      }
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`)
        }
      }
      c += cell.colSpan - 1
    }
  }

  // builder.ts pipeTable 과 같은 빈 행 규칙 — 병합에 덮인 칸만 있는 빈 행만 뺀다. 앵커 칸이 다 빈 진짜 빈 행(서식 입력 행)은 남기고,
  // 첫 열만 값인 행을 다음 행에 합치던 옛 규칙은 builder 에서 빠졌다(#91). 종전 재현이 빈 행을 빼 머리 행 + 빈 행 표를
  // 무수정이어도 "표 좌표 재현 불일치" 로 건너뛰었다(#144)
  const uniqueRows: MappedCell[][] = []
  for (let r = 0; r < display.length; r++) {
    const row = display[r]
    if (row.every(cell => cell.text === "") && row.some((_, c) => skip.has(`${r},${c}`))) continue
    uniqueRows.push(row)
  }
  return uniqueRows.length > 0 ? uniqueRows : null
}

/** builder 가 칸 블록 마크다운으로 내는 1열 표인가 — 칸에 인라인 블록(강조 span·그림)이 있으면 1×1·1열 평문 경로보다 먼저 탄다 */
export function isInlineColumnTable(table: IRTable): boolean {
  return table.cols === 1 && table.cells.some(row => !!row[0] && hasInlineCellBlocks(row[0]))
}

/**
 * builder 1열 표(텍스트 청크) 재현 — 줄마다 격자 행. 인라인 블록 표는 칸 블록 마크다운(cellToMarkdown), 그 밖은 칸 글(칸 안 줄바꿈도
 * 줄로, v4.12.1). 1×1 평문 표는 줄 장식(번호 줄 굵게·가. 들여쓰기)이 달라 호출자가 따로 한다
 */
export function replicateColumnTable(table: IRTable): Array<{ line: string; gridR: number }> {
  const inline = isInlineColumnTable(table)
  const out: Array<{ line: string; gridR: number }> = []
  for (let r = 0; r < table.rows; r++) {
    const cell = table.cells[r]?.[0]
    if (!cell) continue
    const md = inline ? cellToMarkdown(cell, "\n") : escapeGfm(sanitizeText(cell.text))
    for (const line of md.split("\n").map(l => l.trim()).filter(Boolean)) out.push({ line, gridR: r })
  }
  return out
}

/** GFM 표 유닛 파싱 — 구분 행 제거, 이스케이프된 파이프 보존 분할 */
export function parseGfmTable(lines: string[]): string[][] {
  const rows: string[][] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("|")) continue
    // 이스케이프되지 않은 | 로만 분할
    const cells = trimmed.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim())
    if (cells.length === 0) continue
    // 구분 행 — builder는 셀당 '---'만 방출. '| - | - |' 같은 단일 대시 데이터 행
    // ('해당없음' 표기)을 구분 행으로 오인하지 않도록 셀 패턴으로 판정
    if (cells.every(c => /^:?-{3,}:?$/.test(c))) continue
    rows.push(cells)
  }
  return rows
}

/** GFM 셀 텍스트 → 평문 */
export function unescapeGfmCell(text: string): string {
  return text.replace(/(?<!\\)<br\s*\/?>/gi, "\n").replace(/\\\|/g, "|").replace(/\\([~*_`#<$\\])/g, "$1")
}

// ─── HTML 표 — 좌표 추적 렌더 재현 + 파서 ───────────

export interface HtmlCellInfo {
  /** 태그 안 콘텐츠 원문 */
  inner: string
  colSpan: number
  rowSpan: number
  /** 재현 시에만: 격자 좌표 */
  gridR?: number
  gridC?: number
}

/** 셀 내부 콘텐츠 → HTML — builder.ts cellInnerHtml과 동일 */
function replicateCellInnerHtml(cell: IRTable["cells"][number][number]): string {
  if (cell.blocks?.length) {
    return cell.blocks
      .map(b => {
        if (b.type === "table" && b.table) {
          const cap = b.table.caption ? sanitizeText(b.table.caption) : ""
          return (cap ? escapeHtmlCellText(cap) + "<br>" : "") + replicateTableToHtml(b.table)
        }
        if (b.type === "image" && b.text) return `<img src="${escapeHtml(b.text, true)}" alt="image">`
        const note = noteTableHtml(b)
        const t = (sanitizeText(visibleText(b)) + (note ? "" : noteSuffix(b))).trim()
        return ((t ? escapeHtmlCellText(t).replace(/\n/g, "<br>") : "") + note).trim()
      })
      .filter(Boolean)
      .join("<br>")
  }
  return escapeHtmlCellText(sanitizeText(cell.text)).replace(/\n/g, "<br>")
}

/** builder.ts tableToHtml과 동일한 문자열 출력 (자기 검증용) */
export function replicateTableToHtml(table: IRTable): string {
  const rows = replicateHtmlTable(table)
  const lines: string[] = ["<table>"]
  for (let r = 0; r < rows.length; r++) {
    const tag = rows[r].tag
    const rowHtml = rows[r].cells.map(cell => {
      const attrs: string[] = []
      if (cell.colSpan > 1) attrs.push(`colspan="${cell.colSpan}"`)
      if (cell.rowSpan > 1) attrs.push(`rowspan="${cell.rowSpan}"`)
      const attrStr = attrs.length ? " " + attrs.join(" ") : ""
      return `<${tag}${attrStr}>${cell.inner}</${tag}>`
    })
    lines.push(`<tr>${rowHtml.join("")}</tr>`) // 덮인 행도 빈 <tr></tr> (builder tableToHtml 동일)
  }
  lines.push("</table>")
  return lines.join("\n")
}

export interface HtmlRowInfo {
  tag: "th" | "td"
  cells: HtmlCellInfo[]
}

/** builder.ts tableToHtml의 셀 방출 순서 재현 — 좌표 포함 */
export function replicateHtmlTable(table: IRTable): HtmlRowInfo[] {
  const { cells, rows: numRows, cols: numCols } = table
  const skip = new Set<string>()
  const result: HtmlRowInfo[] = []

  for (let r = 0; r < numRows; r++) {
    const tag = r === 0 ? "th" : "td"
    const rowCells: HtmlCellInfo[] = []
    for (let c = 0; c < numCols; c++) {
      if (skip.has(`${r},${c}`)) continue
      const cell = cells[r]?.[c]
      if (!cell) continue
      for (let dr = 0; dr < cell.rowSpan; dr++) {
        for (let dc = 0; dc < cell.colSpan; dc++) {
          if (dr === 0 && dc === 0) continue
          if (r + dr < numRows && c + dc < numCols) skip.add(`${r + dr},${c + dc}`)
        }
      }
      rowCells.push({
        inner: replicateCellInnerHtml(cell),
        colSpan: cell.colSpan,
        rowSpan: cell.rowSpan,
        gridR: r,
        gridC: c,
      })
    }
    result.push({ tag, cells: rowCells }) // 덮인 행도 빈 행 (builder tableToHtml·parseHtmlTable 과 행 수 정합)
  }
  return result
}

/**
 * HTML 표 유닛 파싱 — 중첩 <table> 인지 토크나이저.
 * 최상위 표의 <tr>/<td|th>만 행/셀로 취급하고 중첩 표는 셀 inner에 원문 보존.
 */
export function parseHtmlTable(raw: string): HtmlRowInfo[] | null {
  const re = /<(\/?)(table|tr|td|th)((?:"[^"]*"|'[^']*'|[^>"'])*?)>/gi
  let depth = 0
  let currentRow: HtmlCellInfo[] | null = null
  let cellStart = -1
  let cellInfo: { colSpan: number; rowSpan: number } | null = null
  const rows: HtmlRowInfo[] = []
  let m: RegExpExecArray | null

  while ((m = re.exec(raw)) !== null) {
    const isClose = m[1] === "/"
    const tag = m[2].toLowerCase()
    const attrs = m[3] || ""

    if (tag === "table") {
      depth += isClose ? -1 : 1
      if (depth < 0) return null
      continue
    }
    if (depth !== 1) continue // 중첩 표 내부는 inner 원문으로 흡수

    if (tag === "tr") {
      if (!isClose) currentRow = []
      else if (currentRow) {
        rows.push({ tag: rows.length === 0 ? "th" : "td", cells: currentRow })
        currentRow = null
      }
    } else { // td | th
      if (!isClose) {
        // 속성값은 큰따옴표·작은따옴표·무따옴표 모두 허용, 파서 쪽(clampSpan)과 동일 한도로 클램핑
        const cs = parseInt(attrs.match(/colspan\s*=\s*["']?(\d+)/i)?.[1] || "1", 10)
        const rs = parseInt(attrs.match(/rowspan\s*=\s*["']?(\d+)/i)?.[1] || "1", 10)
        cellStart = m.index + m[0].length
        cellInfo = { colSpan: clampSpan(isNaN(cs) ? 1 : cs, MAX_COLS), rowSpan: clampSpan(isNaN(rs) ? 1 : rs, MAX_ROWS) }
      } else if (cellStart >= 0 && cellInfo && currentRow) {
        currentRow.push({ inner: raw.slice(cellStart, m.index), colSpan: cellInfo.colSpan, rowSpan: cellInfo.rowSpan })
        cellStart = -1
        cellInfo = null
      }
    }
  }
  if (depth !== 0) return null
  return rows
}

/**
 * 자동번호/글머리 접두 형식 — 끝 구두점 필수("1." "가)" "(2)") 또는 단일 원문자/로마자.
 * 맨 단어 오인 방지. patcher/hwp5-patch/session이 공유한다 (편집 텍스트에서 접두 제거 판별).
 */
export const AUTONUM_PREFIX_RE =
  /^(?:[0-9０-９a-zA-Z가-힣]{1,6}[.)\]:]|[([][0-9０-９a-zA-Z가-힣]{1,6}[)\]][.:]?|[ⅰ-ⅹⅠ-Ⅹ①-⑮][.)\]:]?)$/u

/** HTML 셀 inner → 평문 라인 — <br> 분리, <img>/중첩표 토큰 제외, 엔티티 복원(builder escapeHtmlCellText 의 역) */
export function htmlCellInnerToLines(inner: string): { lines: string[]; hadNonText: boolean; imgSrcs: string[] } {
  let hadNonText = false
  let work = inner
  const imgSrcs: string[] = []
  if (/<table[\s>]/i.test(work)) {
    hadNonText = true
    // 중첩 표 통째 제거 (짝 맞는 닫힘까지)
    work = removeNestedTables(work)
  }
  if (/<img\s/i.test(work)) {
    hadNonText = true
    // src는 걷어 반환 — 생성기가 placeholder <hp:pic>로 이미지 존재를 보존 (v4.0.5).
    // 종전 무흔적 제거는 이미지 열이 빈 열이 되어 재파싱 후행 열 트림을 유발했다
    work = work.replace(/<img\s(?:"[^"]*"|'[^']*'|[^>"'])*?>/gi, (tag) => {
      const m = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
      const src = m?.[1] ?? m?.[2]
      if (src) imgSrcs.push(unescapeHtml(src))
      return ""
    })
  }
  const lines = work.split(/<br\s*\/?>/gi).map(s => unescapeHtml(s).trim()).filter(s => s.length > 0)
  return { lines, hadNonText, imgSrcs }
}

/**
 * 셀 inner를 최상위 표 경계로 분할 — texts[i]는 i번째 표 앞 텍스트, 마지막은 뒤 텍스트
 * (texts.length === tables.length + 1). 표·텍스트가 번갈아 놓인 셀의 원문 배치 순서를
 * 생성기가 보존할 수 있게 한다 (#49 — 표 뒤 텍스트가 표 앞으로 역전되던 것 수정)
 */
export function splitCellByTopLevelTables(html: string): { texts: string[]; tables: string[] } {
  const tables = extractTopLevelTables(html)
  const texts: string[] = []
  let rest = html
  for (const t of tables) {
    const i = rest.indexOf(t)
    texts.push(rest.slice(0, i))
    rest = rest.slice(i + t.length)
  }
  texts.push(rest)
  return { texts, tables }
}

/** 셀 inner의 최상위 <table>...</table> 부분문자열들 (문서 순서, 짝 맞는 닫힘까지) */
export function extractTopLevelTables(html: string): string[] {
  const result: string[] = []
  let depth = 0
  let start = -1
  const re = /<(\/?)table(?:[\s>]|>)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== "/") {
      if (depth === 0) start = m.index
      depth++
    } else {
      depth--
      if (depth === 0 && start >= 0) {
        result.push(html.slice(start, m.index + m[0].length))
        start = -1
      }
      if (depth < 0) depth = 0
    }
  }
  return result
}

function removeNestedTables(html: string): string {
  let result = ""
  let depth = 0
  const re = /<(\/?)table(?:[\s>]|>)/gi
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== "/") {
      if (depth === 0) result += html.slice(last, m.index)
      depth++
    } else {
      depth--
      if (depth === 0) last = m.index + m[0].length
      if (depth < 0) depth = 0
    }
  }
  if (depth === 0) result += html.slice(last)
  return result
}

/** 패치 원본 파싱과 다른 출력 모드로 뽑은 편집본 안내 — 원본 표 서수로 위치를 찾으므로 keep 출력이 필요하다 (v4.17.0) */
export const LAYOUT_MODE_MISMATCH = "편집 마크다운이 기본(보이는 대로) 출력에서 나왔습니다. 이 문서에는 테두리가 안 보이는 틀 표가 있어 그 출력으로는 원본 위치를 찾을 수 없습니다 — "
  + "`kordoc <원본> --keep-layout-tables`(API: parse(원본, { layoutTables: \"keep\" }))로 뽑은 마크다운을 고쳐 다시 패치하세요"

/**
 * 편집본이 보이는 대로(visual) 출력에서 나왔나 — 틀 표를 푼 visual 출력과 원본 구조 그대로인 keep 출력이 다를 때만 본다.
 * 편집되지 않은 단위(문단·표)는 뽑은 쪽 출력과 글자까지 같으니, 편집본 단위가 어느 쪽에 더 많이 그대로 있는지로 가른다
 */
/** 편집본이 끝 빈 열 보존(keepTrailingEmptyCols) 추출에서 나왔나 — 채운 표는 어느 추출 원문과도 같지 않으니 칸 글을 비운
 *  표 뼈대(행·칸 수·병합)로 견준다 (#144) */
export function editedFromWideCols(trimmedMarkdown: string, wideMarkdown: string, editedMarkdown: string): boolean {
  if (trimmedMarkdown === wideMarkdown) return false
  const skeleton = (raw: string): string | null => {
    if (raw.startsWith("<table")) return raw.replace(/<(t[dh])((?:"[^"]*"|[^>"])*)>[\s\S]*?<\/\1>/g, "<$1$2></$1>")
    if (raw.startsWith("|")) return raw.split("\n").map(l => l.split(/(?<!\\)\|/).map(() => "").join("|")).join("\n")
    return null
  }
  const shapes = (md: string) => new Set(splitMarkdownUnits(md).map(u => skeleton(u.raw)).filter((s): s is string => s !== null))
  const trimmed = shapes(trimmedMarkdown), wide = shapes(wideMarkdown)
  let t = 0, w = 0
  for (const u of splitMarkdownUnits(editedMarkdown)) {
    const s = skeleton(u.raw)
    if (s === null) continue
    if (trimmed.has(s)) t++
    if (wide.has(s)) w++
  }
  return w > t
}

export function editedFromVisual(keepMarkdown: string, visualMarkdown: string, editedMarkdown: string): boolean {
  if (keepMarkdown === visualMarkdown) return false
  const keep = new Set(splitMarkdownUnits(keepMarkdown).map(u => u.raw))
  const visual = new Set(splitMarkdownUnits(visualMarkdown).map(u => u.raw))
  let k = 0, v = 0
  for (const u of splitMarkdownUnits(editedMarkdown)) {
    if (keep.has(u.raw)) k++
    if (visual.has(u.raw)) v++
  }
  return v > k
}

