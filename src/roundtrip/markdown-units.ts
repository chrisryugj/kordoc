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
import { MAX_COLS, MAX_ROWS, cellToMarkdown, escapeGfm, gfmCellMarkdown, escapeHtmlCellText, hasInlineCellBlocks, noteSuffix, noteTableHtml, sanitizeText, visibleText } from "../table/builder.js"
import { escapeHtml, gfmUrlEnd, gfmUrlHref, sanitizeHref, unescapeHtml } from "../utils.js"
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
  return alignUnitsEx(a, b).pairs
}

/** Myers 차이의 편집 수 상한 — 큰 문서에서 이만큼 넘게 다르면 거친 정렬로 (흔적 메모리 상한² 정수) */
const MYERS_MAX_D = 1000

/**
 * 정렬 + 거친 정렬 여부. 대형 문서(유닛 수 곱 > 4백만)는 앞뒤 공통 구간을 걷어낸 가운데를 Myers O((m+n)·D) 차이로 정확 일치 짝을
 * 찾는다. 편집이 MYERS_MAX_D 를 넘으면 종전처럼 가운데를 길이가 같으면 자리대로, 다르면 전부 추가·삭제로 내고 coarse=true —
 * 이때 추가·삭제는 실제 편집이 아닐 수 있으니 문단을 더하고 지우는 경로(HWP 5.x 본문)는 손대지 않는다
 */
export function alignUnitsEx(a: string[], b: string[]): { pairs: AlignedPair[]; coarse: boolean } {
  const m = a.length, n = b.length
  if (m * n > 4_000_000) {
    let pre = 0
    while (pre < m && pre < n && a[pre] === b[pre]) pre++
    let suf = 0
    while (suf < m - pre && suf < n - pre && a[m - 1 - suf] === b[n - 1 - suf]) suf++
    const mid = myersMatches(a, b, pre, m - suf, pre, n - suf, MYERS_MAX_D)
    if (mid) {
      const matches: [number, number][] = []
      for (let k = 0; k < pre; k++) matches.push([k, k])
      matches.push(...mid)
      for (let s = suf; s > 0; s--) matches.push([m - s, n - s])
      return { pairs: pairGaps(a, b, matches), coarse: false }
    }
    // 대형 문서 보호 — dense LCS 불가. 공통 prefix/suffix만 정확 일치로 페어링하고
    // 가운데 구간은 길이가 같을 때만 인덱스 페어링, 다르면(블록 추가/삭제) 전부
    // 추가/삭제로 보고해 시프트 오적용(전 문단이 한 칸씩 밀려 덮어써짐)을 차단한다.
    const result: AlignedPair[] = []
    for (let k = 0; k < pre; k++) result.push([k, k])
    const aMid = m - pre - suf, bMid = n - pre - suf
    if (aMid === bMid) {
      for (let i = 0; i < aMid; i++) result.push([pre + i, pre + i])
    } else {
      for (let i = 0; i < aMid; i++) result.push([pre + i, null])
      for (let j = 0; j < bMid; j++) result.push([null, pre + j])
    }
    for (let s = suf - 1; s >= 0; s--) result.push([m - 1 - s, n - 1 - s])
    return { pairs: result, coarse: true }
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
  return { pairs: pairGaps(a, b, matches), coarse: false }
}

/** 정확 일치 짝 사이 갭 구간 페어링 — 양쪽 갭 크기가 같으면 위치 기반(전면 재작성 인정), 다르면 유사도 기반으로 수정/추가/삭제 구분 */
function pairGaps(a: string[], b: string[], matches: [number, number][]): AlignedPair[] {
  const m = a.length, n = b.length
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

/**
 * Myers O((N+M)·D) 차이 — a[a0..a1) 와 b[b0..b1) 의 정확 일치 짝(전역 좌표, 오름차순). 편집 수가 maxD 를 넘으면 null
 */
function myersMatches(a: string[], b: string[], a0: number, a1: number, b0: number, b1: number, maxD: number): [number, number][] | null {
  const N = a1 - a0, M = b1 - b0, off = maxD + 1
  const v = new Int32Array(2 * maxD + 3)
  const trace: Int32Array[] = []
  for (let d = 0; d <= maxD; d++) {
    trace.push(v.slice())
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1
      let y = x - k
      while (x < N && y < M && a[a0 + x] === b[b0 + y]) { x++; y++ }
      v[off + k] = x
      if (x >= N && y >= M) {
        // 거꾸로 따라가며 대각선(일치) 구간을 모은다 — trace[dd] 는 dd 번째 편집 직전 상태
        const out: [number, number][] = []
        let cx = N, cy = M
        for (let dd = d; dd > 0; dd--) {
          const pv = trace[dd], kk = cx - cy
          const prevK = kk === -dd || (kk !== dd && pv[off + kk - 1] < pv[off + kk + 1]) ? kk + 1 : kk - 1
          const px = pv[off + prevK], py = px - prevK
          while (cx > px && cy > py) { out.push([a0 + cx - 1, b0 + cy - 1]); cx--; cy-- }
          cx = px; cy = py
        }
        while (cx > 0 && cy > 0) { out.push([a0 + cx - 1, b0 + cy - 1]); cx--; cy-- }
        return out.reverse()
      }
    }
  }
  return null
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
/** IR 글의 첨자 태그(<sup>·<sub> — 파서 표기, 원문 글엔 없다)를 뗀다. 이스케이프된 원문 글자 "\\<sup>" 는 둔다 */
export function noScriptTags(text: string): string {
  return text.replace(/(?<!\\)<\/?su[bp]>/g, "")
}

export function normForMatch(text: string): string {
  return sanitizeText(unescapeItemHead(text).replace(/\\\$/g, "$").replace(/\\(?=<\/?(?:u|sup|sub)>)/g, "")).replace(/\s+/g, " ").trim()
}

/** 편집된 마크다운 텍스트 → 평문 (escapeGfm 역변환 — \| \# \< \$ \\ 포함, 없으면 hp:t 에 백슬래시가 샌다) */
export function unescapeGfm(text: string): string {
  return unescapeItemHead(text).replace(AUTOLINK, "$1").replace(/\\([~*_`|#<$\\>=-])/g, "$1")
}

/** 줄머리 목록 부호 이스케이프 풀기 — builder escapeItemHead 역(공문 "\- 소항목"·"1\) 세부", 목록 항목 글 "\- …") */
export function unescapeItemHead(text: string): string {
  return text.replace(/^([ \t]*)\\([-+*])(?=\s|$)/gm, "$1$2").replace(/^([ \t]*)(\d{1,9})\\([.)])(?=\s|$)/gm, "$1$2$3")
}

/** 자동 링크 <http(s) 주소> — 마크다운에는 꺾쇠 없이 주소로 보인다 (QR 값은 <주소> 로 나간다) */
const AUTOLINK = /(?<!\\)<(https?:\/\/[^\s<>]*)>/gi

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
        text: gfmCellMarkdown(cellToMarkdown(cell, "<br>")),
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
  return text.replace(/(?<!\\)<br\s*\/?>/gi, "\n").replace(AUTOLINK, "$1").replace(/\\\|/g, "|").replace(/\\([~*_`#<$\\>=-])/g, "$1")
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

/**
 * 편집 글에서 문단 머리 기호(자동 번호·글머리표 — 원문 글에 없고 파서가 IR 글 앞에 붙인 것)를 뗀다. 기호는 마크다운에 보이는 꼴
 * (PUA 글머리표는 표시값)로 맞댄다 — 원문 꼴로만 맞대면 표시값 "•" 를 못 알아봐 기호가 본문 글로 들어가 두 번 찍혔다(#179).
 * note 는 글만 적용하고 알릴 것. 기호는 문단 모양이라 바꾸거나 지울 수 없고, 기호 앞에 넣은 글은 기호 뒤로 간다. 마크다운에 안
 * 보이는 기호(표시값 없는 PUA)면 편집 글 그대로. patcher·hwp5-patch·session 이 같이 쓴다
 */
export function stripHeadMarker(blockText: string, edited: string): { text: string; note?: string } {
  const raw = blockText.split(" ", 1)[0]
  const shown = sanitizeText(raw)
  if (!shown) return { text: edited }
  const toks = edited.split(" ")
  if (toks[0] === shown || toks[0] === raw) return { text: toks.slice(1).join(" ") }
  // 기호 앞에 글을 넣은 줄("[표시] • 본문") — 번호 꼴 판정보다 먼저 ("[표시]" 도 번호 꼴이다)
  const k = toks.findIndex(t => t === shown || t === raw)
  if (k > 0) return { text: [...toks.slice(0, k), ...toks.slice(k + 1)].join(" "), note: "문단 머리 기호(글머리표·자동 번호) 앞에 넣은 글은 기호 뒤에 넣음 — 기호는 문단 모양" }
  if (AUTONUM_PREFIX_RE.test(toks[0])) return { text: toks.slice(1).join(" "), note: "자동 번호는 문단 모양이라 바꾼 번호는 반영하지 않음 — 글만 적용" }
  return { text: edited, note: "문단 머리 기호(글머리표·자동 번호)는 문단 모양이라 지우지 않음 — 글만 적용" }
}

/** 원본 단위 평문(마크다운 꼴)에서 문단 머리 기호를 뗀다 — 편집 글과 같은 꼴로 바뀐 자리를 잡게 (stripHeadMarker 짝) */
export function stripShownHeadMarker(blockText: string, plain: string): string {
  const shown = sanitizeText(blockText.split(" ", 1)[0])
  return shown && plain.startsWith(shown + " ") ? plain.slice(shown.length + 1) : plain
}

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
  // htmlCellLinks 가 낸 링크 <a href="H">T</a> → 원래 셀 텍스트: URL 그대로 링크한 것이면 T, 아니면 [T](H).
  // URL 로 링크하면 끝의 ) . 등은 링크 밖이라, T 가 그런 문자로 끝나면 원래 [T](H) 였다
  work = work.replace(/<a href="([^"]*)">([\s\S]*?)<\/a>/g, (_, h: string, t: string) => {
    const text = unescapeHtml(t)
    return gfmUrlEnd(text) === text.length && sanitizeHref(gfmUrlHref(text)) === unescapeHtml(h) ? t : `[${t}](${h})`
  })
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

/**
 * 편집 텍스트에서 각주·미주 참조 부호를 뺀다 — 부호는 앞 낱말에 붙어 나오므로(“액체1)와”) 앞 글자가
 * 공백이 아닌 등장을 우선하고, 문단 첫머리 부호(“문1）”)는 0 위치로 인정. 못 찾은 부호는 사용자가
 * 지운 것 — 주석 개체는 XML 에 그대로 남는다(삭제 미지원)
 */
export function removeNoteMarks(text: string, marks: string[]): { text: string; missing: string[] } {
  let out = text
  let cursor = 0
  const missing: string[] = []
  for (const mark of marks) {
    if (!mark) continue
    let at = -1
    for (let p = out.indexOf(mark, cursor); p !== -1; p = out.indexOf(mark, p + 1)) {
      if (p === 0 || !/\s/.test(out[p - 1])) { at = p; break }
      if (at === -1) at = p
    }
    if (at === -1) { missing.push(mark); continue }
    out = out.slice(0, at) + out.slice(at + mark.length)
    cursor = at
  }
  return { text: out, missing }
}

/** 각주 글("1) 본문…; 2) …")에서 번호 표기를 순서대로. 파서는 각주마다 번호 표기로 시작하는 글을 "; " 로 잇는다 (ir-assemble) */
export function noteMarksOf(footnoteText?: string): string[] {
  return footnoteText ? footnoteText.split("; ").map(s => s.match(/^(\S+)\s/)?.[1] ?? "").filter(Boolean) : []
}

/**
 * 칸 글 한 문단의 각주 표기("이름2) (주: 2) 각주 글)"). 파서가 각주 글을 문단 끝에 붙이고 각주 자리에 번호를 끼운다(ir-assemble).
 * 둘 다 떼고 본문만 맞댄다. 각주 글을 고치거나 지운 편집은 알리고 본문만 적용한다 (문단 경로와 같다)
 */
export function splitCellNote(
  before: string, after: string, skipped: Array<{ reason: string; before?: string; after?: string }>,
  /** 각주 글을 고친 편집을 맡을 곳 — 처리했으면(적용했거나 제 이유로 알렸으면) true. 없거나 false 면 미지원으로 알린다 */
  editNote?: (origNote: string, newNote: string) => boolean,
): { before: string; after: string; noted: boolean } {
  const re = /\s*\(주: ([\s\S]*)\)$/
  const bm = before.match(re)
  if (!bm) return { before, after, noted: false }
  const marks = noteMarksOf(bm[1])
  const am = after.match(re)
  let body = after
  if (am) {
    body = after.slice(0, am.index).trimEnd()
    if (normForMatch(am[1]) !== normForMatch(bm[1]) && !editNote?.(bm[1], am[1])) skipped.push({ reason: NOTE_TEXT_UNSUPPORTED, before: bm[1], after: am[1] })
  } else skipped.push({ reason: "각주 표기 삭제는 미지원 — 각주 유지, 본문만 적용", before: `(주: ${bm[1]})` })
  const r = removeNoteMarks(body, marks)
  if (r.missing.length) skipped.push({ reason: "각주 참조 부호 삭제는 미지원 — 각주 유지, 본문만 적용", before: r.missing.join(" ") })
  return { before: removeNoteMarks(before.slice(0, bm.index).trimEnd(), marks).text, after: r.text, noted: true }
}

/** 각주 글을 고친 편집을 각주 문단에 옮기지 못할 때의 이유 (주석 안 표, 원문 각주와 못 맞댄 글) */
export const NOTE_TEXT_UNSUPPORTED = "각주 텍스트 수정은 미지원 — 본문만 적용"

/**
 * 각주 글 편집("1) 가; 2) 나" → "1) 가; 2) 다")을 각주마다의 본문 편집으로 가른다. 마크다운의 각주 글은 각주마다 번호 표기로
 * 시작하는 글을 "; " 로 이은 것이라(파서), 소스맵의 각주 본문(bodies, 각주 순서)을 원문 각주 글에서 차례로 찾아 그 사이 글(번호 표기·
 * 구분)을 머리로 잡고, 편집 글을 같은 머리로 가른다. 머리가 달라진 편집(번호 고치기, 각주 추가·삭제)은 이유 문자열로 돌려준다
 */
export function planNoteEdits(origNote: string, newNote: string, bodies: string[]): Array<{ index: number; before: string; after: string }> | string {
  const orig = normForMatch(origNote)
  const heads: string[] = []
  let pos = 0
  for (const body of bodies) {
    const key = normForMatch(body)
    const at = key ? orig.indexOf(key, pos) : -1
    if (at < 0) return NOTE_TEXT_UNSUPPORTED
    heads.push(orig.slice(pos, at))
    pos = at + key.length
  }
  if (!bodies.length || pos !== orig.length || heads.some((h, k) => k > 0 && !h.startsWith("; "))) return NOTE_TEXT_UNSUPPORTED
  const split = (text: string): string[] | null => {
    const out: string[] = []
    let p = 0
    for (let k = 0; k < heads.length; k++) {
      if (!text.startsWith(heads[k], p)) return null
      p += heads[k].length
      const next = k + 1 < heads.length ? text.indexOf(heads[k + 1], p) : text.length
      if (next < 0) return null
      out.push(text.slice(p, next))
      p = next
    }
    return out
  }
  const before = split(orig)
  if (!before || before.some((b, k) => b !== normForMatch(bodies[k]))) return NOTE_TEXT_UNSUPPORTED
  const after = split(newNote.replace(/\s+/g, " ").trim())
  if (!after) return "각주 번호 수정·각주 추가·삭제는 미지원 — 각주 글 수정 미적용"
  const edits: Array<{ index: number; before: string; after: string }> = []
  for (let k = 0; k < before.length; k++) {
    if (normForMatch(after[k]) === before[k]) continue
    if (!after[k].trim()) return "각주 글 비우기는 미지원 — 각주 글 수정 미적용"
    if (sanitizeText(after[k]) !== after[k]) return "공백 정규화 불안정 텍스트 — 각주 글 수정 미적용"
    edits.push({ index: k, before: before[k], after: after[k] })
  }
  return edits
}

/**
 * 각주 본문 편집을 그 각주의 문단 하나에 싣는다. 파서는 각주 문단들을 공백으로 이어 한 글로 내므로, 바뀐 자리(앞뒤 공통 글을 뺀 구간)가
 * 한 문단 안에 들 때만 그 문단의 새 글을 낸다. 문단 경계에 걸친 편집은 null
 */
export function noteParaEdit(paraTexts: string[], before: string, after: string): { index: number; before: string; after: string } | null {
  if (paraTexts.length === 1) return { index: 0, before, after }
  if (!paraTexts.length || before !== paraTexts.join(" ")) return null
  let p = 0
  while (p < before.length && p < after.length && before[p] === after[p]) p++
  let s = 0
  while (s < before.length - p && s < after.length - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++
  let off = 0
  for (let i = 0; i < paraTexts.length; i++) {
    const end = off + paraTexts[i].length
    if (off <= p && before.length - s <= end) return { index: i, before: paraTexts[i], after: after.slice(off, after.length - (before.length - end)) }
    off = end + 1
  }
  return null
}
