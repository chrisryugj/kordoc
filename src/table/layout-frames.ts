/**
 * 보이지 않는 틀 표 풀기 — 한글 문서는 테두리를 없앤 표로 쪽을 짜는 일이 흔하다. 법령 별표 272건 중 103건이 본문 전체를
 * 안 보이는 틀 표에 담았고 표 381개 중 95개는 보이는 변이 하나도 없다(2026-09-29 실측). 구조대로 표로 내면 화면·LLM 이
 * 원본에 없는 격자를 본다(할부거래법 시행령 [별표 1]: 원본은 글과 분수뿐인데 5열 표 한 장).
 *
 * 칸마다 보이는 변(`CELL_EDGES` — HWPX borderFill·HWP5 BORDER_FILL·PDF 획)으로 두 가지를 한다.
 *  ① 분수 — 위아래로 붙은 두 칸 사이 가로선만 보이고 두 칸의 다른 변이 모두 안 보이는 짧은 한 줄 칸 쌍은 분수를 칸으로
 *     조립한 것이다(할부거래법 "A=P×r× (1+r)ⁿ / (1+r)ⁿ-1"). 한 칸 `$\frac{위}{아래}$` 로 합친다.
 *  ② 행 띠 — 세로선이 보이는 행과, 위아래 가로선이 온 폭에 그어진 사이에 칸이 둘 이상인 행(가로선만 긋는 표)은 표 띠다.
 *     이어진 표 띠만 새 표로 다시 짜고(띠 안에서 쓰지 않는 행·열 경계와 선 밖 빈 칸은 접음) 나머지 행은 칸 글을 문단으로
 *     푼다. 칸 안 블록(중첩표)은 재귀로 같은 처리. 표 띠 칸 안의 중첩표도 본다.
 * 테두리 정보가 하나도 없는 표(다른 포맷)는 손대지 않는다. 호출자는 파서가 마크다운을 만들기 직전 — 왕복 패치·양식 채우기처럼
 * 원 구조가 필요한 경로는 `layoutTables: "keep"` 으로 건너뛴다.
 */

import type { IRBlock, IRCell, IRTable } from "../types.js"
import { visibleText } from "./builder.js"

/** 칸의 보이는 변 */
export interface Edges { t: boolean; b: boolean; l: boolean; r: boolean }

/** IR 칸 → 보이는 변. 공개 IR 에는 나가지 않는 곁정보 (파서가 채움) */
export const CELL_EDGES = new WeakMap<IRCell, Edges>()
/** 쪽 넘김으로 이은 표에서 첫 쪽 뒤에 놓인 칸 → 그 쪽 번호 (PDF 쪽 넘김 잇기가 채움, #136). 표를 풀어 낸 문단과 쪽별 마크다운이
 *  칸이 놓인 쪽을 따른다. 표시가 없는 칸은 표 블록의 쪽이다 */
export const CELL_PAGES = new WeakMap<IRCell, number>()
/** 글·블록 없이도 내용이 있는 칸 — PDF 는 칸 그림을 칸 글과 따로 뽑아 그림 칸의 text·blocks 가 빈다. 빈 여백 행 접기가 그림 행을
 *  접지 않게 파서가 표시한다 (경찰복제 [별표] 특수복식 도면 행) */
export const CONTENT_CELLS = new WeakSet<IRCell>()

/** 분수 칸 글 상한(자) — 분자·분모는 식 조각이다. 문장 칸이 가로선 하나로 나뉜 것과 가른다 */
const FRACTION_MAX_CHARS = 40

interface Anchor { r: number; c: number; rs: number; cs: number; cell: IRCell }

function anchorsOf(t: IRTable): Anchor[] {
  const out: Anchor[] = []
  const covered = new Set<number>()
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
    if (covered.has(r * t.cols + c)) continue
    const cell = t.cells[r]?.[c]
    if (!cell) continue
    const rs = Math.max(1, Math.min(cell.rowSpan, t.rows - r)), cs = Math.max(1, Math.min(cell.colSpan, t.cols - c))
    for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) covered.add((r + dr) * t.cols + c + dc)
    out.push({ r, c, rs, cs, cell })
  }
  return out
}

/** 단위 격자의 보이는 가로선 H[r][c](행 r 윗변)·세로선 V[r][c](열 c 왼변) — 맞닿은 두 칸 가운데 하나라도 그으면 보인다 */
function ruleGrids(t: IRTable, anchors: Anchor[]): { H: boolean[][]; V: boolean[][] } {
  const H = Array.from({ length: t.rows + 1 }, () => new Array<boolean>(t.cols).fill(false))
  const V = Array.from({ length: t.rows }, () => new Array<boolean>(t.cols + 1).fill(false))
  for (const a of anchors) {
    // 테두리 정보가 없는 칸은 보이는 칸으로 둔다 — 모르면 표를 지키는 쪽이다
    const e = CELL_EDGES.get(a.cell) ?? { t: true, b: true, l: true, r: true }
    for (let c = a.c; c < a.c + a.cs; c++) { if (e.t) H[a.r][c] = true; if (e.b) H[a.r + a.rs][c] = true }
    for (let r = a.r; r < a.r + a.rs; r++) { if (e.l) V[r][a.c] = true; if (e.r) V[r][a.c + a.cs] = true }
  }
  return { H, V }
}

/** 분자·분모 글 → LaTeX. 첨자 태그는 ^{}·_{}, 한글 낱말은 \text{} */
function toTex(s: string): string {
  // IR 이스케이프(리터럴 \$, 태그 꼴 글자 \<sub>)는 먼저 원래 글자로 — 그대로 두면 역슬래시가 다시 이스케이프돼 "\\\$5"(LaTeX 줄바꿈)가
  // 되고, 글자 "<sub>" 가 아래첨자가 됐다. 태그 꼴 글자는 첨자 변환이 끝난 뒤 되돌린다
  return s
    .replace(/\\\$/g, "$")
    .replace(/\\</g, "\u0001")
    .replace(/<\/?u>/g, "")
    .replace(/([\\{}%#&_$])/g, "\\$1")
    .replace(/<sup>(.*?)<\/sup>/g, "^{$1}")
    .replace(/<sub>(.*?)<\/sub>/g, "_{$1}")
    .replace(/\u0001/g, "<")
    .replace(/[가-힣ㄱ-ㅎㅏ-ㅣ][가-힣ㄱ-ㅎㅏ-ㅣ\s·ㆍ]*/g, m => `\\text{${m.trim()}}`)
    .trim()
}

/** 분수 조각 칸 — 한 줄 짧은 글, 블록 없음 */
function fractionPart(cell: IRCell): boolean {
  const t = cell.text.trim()
  return !!t && !t.includes("\n") && !cell.blocks?.length && t.replace(/<\/?(?:u|sup|sub)>/g, "").length <= FRACTION_MAX_CHARS
    && !/(?<!\\)\$/.test(t)
}

/** ① 칸으로 조립한 분수를 한 칸으로 합친다. 합친 쌍이 있으면 true (anchors·격자는 새로 만들어야 함) */
function mergeFractions(t: IRTable, anchors: Anchor[], H: boolean[][], V: boolean[][]): boolean {
  const at = new Map<number, Anchor>()
  for (const a of anchors) at.set(a.r * t.cols + a.c, a)
  let merged = false
  for (const u of anchors) {
    const d = at.get((u.r + u.rs) * t.cols + u.c)
    if (!d || d.cs !== u.cs || u.rs !== 1 || d.rs !== 1 || !fractionPart(u.cell) || !fractionPart(d.cell)) continue
    // 표 온 폭을 차지하는 두 칸은 칸 두 개짜리 표(2×1 분수 표)일 때만 — 서식 끝 "…귀하"·"210mm×297mm" 칸, 제목과 본문 줄이
    // 가로선 하나로 나뉜 모양이 분수로 잡혔다 (정답 그림 대조: 오탐 10건 → 0, 진짜 분수 9개 유지)
    // 옆 열이 빈 여백 칸뿐이어도 온 폭과 같다 (임금채권보장법 시행규칙 재산목록: 왼쪽 빈 열 하나 때문에 "…장 귀하"·"210mm×297mm" 가 분수로)
    const besideText = anchors.some(a => a !== u && a !== d && a.r <= d.r && a.r + a.rs > u.r && a.cell.text.trim())
    if (!besideText && anchors.filter(a => a.cell.text.trim()).length !== 2) continue
    const bar = d.r, c1 = u.c, c2 = u.c + u.cs
    // 막대: 두 칸 사이 가로선이 두 칸 폭에만 — 옆 칸까지 이어지면 가로선만 긋는 표의 행 구분이다
    let ok = true
    for (let c = c1; c < c2 && ok; c++) if (!H[bar][c]) ok = false
    if (!ok || (c1 > 0 && H[bar][c1 - 1]) || (c2 < t.cols && H[bar][c2])) continue
    // 두 칸의 나머지 변은 모두 안 보여야 한다 (위·아래·좌·우)
    for (let c = c1; c < c2 && ok; c++) if (H[u.r][c] || H[d.r + d.rs][c]) ok = false
    for (let r = u.r; r < d.r + d.rs && ok; r++) if (V[r][c1] || V[r][c2]) ok = false
    if (!ok) continue
    u.cell.text = `$\\frac{${toTex(u.cell.text)}}{${toTex(d.cell.text)}}$`
    u.cell.rowSpan = u.rs + d.rs
    t.cells[d.r][d.c] = { text: "", colSpan: 1, rowSpan: 1 }
    at.delete(d.r * t.cols + d.c)
    merged = true
  }
  return merged
}

/** 표 띠 행 — 세로선이 보이거나, 온 폭 가로선 사이에 칸이 둘 이상 */
function ruledRows(t: IRTable, anchors: Anchor[], H: boolean[][], V: boolean[][]): boolean[] {
  const inRow = new Array<number>(t.rows).fill(0)
  for (const a of anchors) for (let r = a.r; r < a.r + a.rs; r++) inRow[r]++
  return Array.from({ length: t.rows }, (_, r) =>
    V[r].some(Boolean) || (inRow[r] >= 2 && H[r].every(Boolean) && H[r + 1].every(Boolean)))
}

/** 표 띠 [r0, r1] → 새 표. 띠 안에서 시작하는 칸만, 띠 밖으로 나가는 병합은 자른다. 선 밖 빈 칸·안 쓰는 경계는 접는다 */
function bandTable(t: IRTable, anchors: Anchor[], V: boolean[][], H: boolean[][], r0: number, r1: number, keepEmptyCols: boolean): IRTable | null {
  let list = anchors.filter(a => a.r >= r0 && a.r <= r1).map(a => ({ ...a, rs: Math.min(a.rs, r1 - a.r + 1) }))
  const blank = (a: Anchor): boolean => {
    if (CONTENT_CELLS.has(a.cell)) return false
    if (!a.cell.blocks?.length) return !a.cell.text.trim()
    return a.cell.blocks.every(b => (b.type === "paragraph" || b.type === "heading") && !visibleText(b).trim() && !b.footnoteText)
  }
  // 선이 닿는 열 범위 — 선 밖 빈 들여쓰기 칸부터 빼야 그 칸을 표 행의 시작으로 세지 않는다.
  let lo = Infinity, hi = -Infinity
  for (let r = r0; r <= r1; r++) {
    for (let c = 0; c <= t.cols; c++) if (V[r][c]) { lo = Math.min(lo, c); hi = Math.max(hi, c) }
    for (const rr of [r, r + 1]) for (let c = 0; c < t.cols; c++) if (H[rr][c]) { lo = Math.min(lo, c); hi = Math.max(hi, c + 1) }
  }
  // 한쪽 세로선만 있는 입력 항목도 경계가 알려져 있다(lo === hi). 선 밖 글·그림은 보존한다.
  if (Number.isFinite(lo)) list = list.filter(a => a.c < hi && a.c + a.cs > lo || !blank(a))
  if (!list.length) return null
  // 선 없이 붙은 빈 여백 행 — 그 행에서 시작하는 칸이 모두 비었고 윗선이나 아랫선이 표 폭 어디에도 없으면 그림에서 이웃 행과
  // 한 행이다. 접는다 (양곡관리법·에너지이용 합리화법 별표 여백 행, 근로기준법 [별표 6] 여백 행 10개 — 정답 그림 대조 42→48/50.
  // 윗선·아랫선 둘 다 없을 때만 접으면 에너지이용 합리화법 두 표가 안 접힌다)
  const drop: number[] = []
  for (let r = r0; r <= r1; r++) {
    const starts = list.filter(a => a.r === r)
    // 시작 칸이 없는 행은 위 칸의 병합 덮개다. 실제 빈 여백 칸이 있는 행만 접는다.
    if (starts.length && (!H[r].some(Boolean) || !H[r + 1].some(Boolean)) && starts.every(blank)) drop.push(r)
  }
  if (drop.length) {
    const shift = (y: number): number => y - drop.filter(d => d < y).length
    list = list.filter(a => !drop.includes(a.r))
      .map(a => ({ ...a, r: shift(a.r), rs: shift(a.r + a.rs) - shift(a.r) }))
      .filter(a => a.rs > 0)
  }
  // 후행 빈 열 — 띠에서 오른쪽 끝 열이 비면 자른다. 원래 표를 만들 때 builder 가 하는 트림(마크다운 가독성)을 띠 표에도 똑같이:
  // 표 전체로는 글이 있어 남은 열이 한 띠에서만 비는 경우다(결재문서 점검표 "□ | ■ | (빈 칸)" — 생성 → 재파싱 왕복이 어긋났다).
  // keepTrailingEmptyCols(#47 서식 입력란)면 builder 처럼 두고
  // 빈 띠도 HTML로 남긴다. 후행 열 정리는 마지막 앵커를 지우기 전에 멈춘다.
  const emptyBand = list.every(blank)
  for (let right = keepEmptyCols ? 0 : Math.max(...list.map(a => a.c + a.cs)); right > 1;) {
    const starts = list.filter(a => a.c === right - 1)
    if (!starts.length || !starts.every(blank) || starts.length === list.length) break
    list = list.filter(a => a.c !== right - 1).map(a => (a.c + a.cs === right ? { ...a, cs: a.cs - 1 } : a))
    right--
  }
  const colB = new Set<number>(), rowB = new Set<number>()
  for (const a of list) { colB.add(a.c); colB.add(a.c + a.cs); rowB.add(a.r); rowB.add(a.r + a.rs) }
  const cx = [...colB].sort((x, y) => x - y), rx = [...rowB].sort((x, y) => x - y)
  const cols = cx.length - 1, rows = rx.length - 1
  if (cols < 1 || rows < 1) return null
  const cells: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  for (const a of list) {
    const r = rx.indexOf(a.r), c = cx.indexOf(a.c)
    a.cell.rowSpan = rx.indexOf(a.r + a.rs) - r
    a.cell.colSpan = cx.indexOf(a.c + a.cs) - c
    cells[r][c] = a.cell
  }
  return { rows, cols, cells, hasHeader: t.hasHeader, ...(emptyBand ? { renderAsTable: true } : {}) }
}

/** 글 띠 행 → 문단. 칸이 하나면 칸 안 줄마다, 여럿이면 칸 글을 공백으로 이은 한 문단. 칸 블록은 재귀로 푼다 */
function textRow(row: Anchor[], out: IRBlock[], pageNumber: number | undefined, keepEmptyCols: boolean): void {
  const parts: string[] = []
  const flush = (): void => {
    if (!parts.length) return
    if (parts.length === 1) {
      for (const line of parts[0].split("\n")) if (line.trim()) out.push({ type: "paragraph", text: line.trim(), pageNumber })
    } else {
      const text = parts.map(p => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean).join(" ")
      if (text) out.push({ type: "paragraph", text, pageNumber })
    }
    parts.length = 0
  }
  for (const a of row) {
    if (a.cell.blocks?.length) {
      flush()
      out.push(...unframeLayoutTables(a.cell.blocks, keepEmptyCols))
      continue
    }
    if (a.cell.text.trim()) parts.push(a.cell.text.trim())
  }
  flush()
}

/** 표 하나 → 풀어낸 블록. 바꿀 게 없으면 null (원래 표 그대로) */
function unframeTable(t: IRTable, pageNumber: number | undefined, keepEmptyCols: boolean): IRBlock[] | null {
  let anchors = anchorsOf(t)
  if (!anchors.some(a => CELL_EDGES.has(a.cell))) return null
  let { H, V } = ruleGrids(t, anchors)
  if (mergeFractions(t, anchors, H, V)) {
    anchors = anchorsOf(t)
    ;({ H, V } = ruleGrids(t, anchors))
  }
  const ruled = ruledRows(t, anchors, H, V)
  if (ruled.every(Boolean)) {
    // 표 전체가 표 띠여도 안 쓰는 격자선·선 밖 빈 칸·빈 여백 행은 접는다(한글 편집기 격자에만 있는 선, 86712 규제영향분석서 10×8 → 10×5).
    // 모양이 그대로면 원래 표 객체(sourceId·캡션·곁정보)를 둔다
    const whole = bandTable(t, anchors, V, H, 0, t.rows - 1, keepEmptyCols)
    if (!whole) return null
    if (whole.rows === t.rows && whole.cols === t.cols) {
      if (whole.renderAsTable) t.renderAsTable = true
      return null
    }
    return [{ type: "table", table: { ...t, rows: whole.rows, cols: whole.cols, cells: whole.cells,
      ...(whole.renderAsTable ? { renderAsTable: true } : {}) }, pageNumber }]
  }
  const out: IRBlock[] = []
  if (t.captionBlocks?.length) out.push(...t.captionBlocks)
  else if (t.caption) out.push({ type: "paragraph", text: t.caption, pageNumber })
  // 쪽 넘김으로 이은 표는 행이 놓인 쪽을 칸 표시로 안다 (CELL_PAGES) — 풀어 낸 띠·문단도 그 쪽에
  const rowPage = (r: number): number | undefined => {
    const marks = anchors.filter(a => a.r === r).map(a => CELL_PAGES.get(a.cell)).filter((p): p is number => p !== undefined)
    return marks.length ? Math.max(...marks) : pageNumber
  }
  for (let r = 0; r < t.rows;) {
    if (ruled[r]) {
      let r1 = r
      while (r1 + 1 < t.rows && ruled[r1 + 1]) r1++
      const sub = bandTable(t, anchors, V, H, r, r1, keepEmptyCols)
      if (sub) out.push({ type: "table", table: sub, pageNumber: rowPage(r) })
      r = r1 + 1
      continue
    }
    textRow(anchors.filter(a => a.r === r).sort((x, y) => x.c - y.c), out, rowPage(r), keepEmptyCols)
    r++
  }
  return out
}

/** 블록 목록의 보이지 않는 틀 표를 푼다 (표 띠에 남은 칸 안 블록까지). 새 배열을 돌려준다.
 *  keepEmptyCols = ParseOptions.keepTrailingEmptyCols (띠 표의 후행 빈 열을 자르지 않는다) */
export function unframeLayoutTables(blocks: IRBlock[], keepEmptyCols = false): IRBlock[] {
  const out: IRBlock[] = []
  for (const b of blocks) {
    if (b.type !== "table" || !b.table) { out.push(b); continue }
    if (b.table.captionBlocks?.length) b.table.captionBlocks = unframeLayoutTables(b.table.captionBlocks, keepEmptyCols)
    const flat = unframeTable(b.table, b.pageNumber, keepEmptyCols)
    const kept = flat ?? [b]
    for (const k of kept) {
      if (k.type === "table" && k.table) {
        for (const row of k.table.cells) for (const cell of row) if (cell.blocks?.length) cell.blocks = unframeLayoutTables(cell.blocks, keepEmptyCols)
      }
      out.push(k)
    }
  }
  return out
}
