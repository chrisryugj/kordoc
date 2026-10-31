/**
 * 좌표 매핑으로 못 고친 편집의 대체 경로 — 원문 글을 문단에서 글로 찾아 그 문단들의 바뀐 낱말 자리만 고친다.
 *
 * 패치는 IR 블록·표 좌표를 소스맵에 맞대 고치는데, 틀 표·위첨자 섞인 문단·셀 안 글상자처럼 좌표 재현이 어긋나면 편집을
 * 통째로 건너뛰었다(사용자는 "수정 불가"만 받음). 여기는 좌표 없이 글로 찾는다:
 * - 글 편집: 문서 문단을 차례로 이어 원문 글(공백 무시)과 같은 문단 묶음을 찾고, 낱말 diff 덩어리마다 그 자리만 쓴다.
 *   문단·글자 모양·칸·줄바꿈은 그대로다. 같은 글이 여러 곳이면 IR 에서 몇 번째 등장인지로 고른다.
 * - 표 칸 편집: 표의 행을 칸 글로 맞대(행 순서·칸 수가 같아야) 칸을 짚는다 — 빈 칸 채우기도 된다. 행을 못 맞대면 칸 글로 찾는다.
 */

import { buildParagraphSplices, type SectionScan, type ScanCell, type ScanParagraph, type ScanTable, type SpliceEdit } from "./source-map.js"
import { paraTokens, tokenSplices, type TextTok } from "./line-break-edit.js"
import { wordHunks, type RawEdit } from "./inline-edit.js"
import { AUTONUM_PREFIX_RE } from "./markdown-units.js"

const isWs = (c: string | undefined): boolean => c !== undefined && /\s/.test(c)
const key = (s: string): string => s.replace(/\s+/g, "")

export interface FallbackCtx {
  scans: SectionScan[]
  sectionSplices: SpliceEdit[][]
}

function tableParagraphs(table: ScanTable, out: ScanParagraph[]): void {
  for (const row of table.rows) for (const cell of row) {
    out.push(...cell.paragraphs)
    for (const t of cell.tables) tableParagraphs(t, out)
  }
}

/** 섹션의 모든 문단 (본문·표 칸·글상자·캡션 등, 문서 순서) */
export function sectionParagraphs(scan: SectionScan): ScanParagraph[] {
  const out: ScanParagraph[] = [...scan.bodyParagraphs, ...scan.excludedParagraphs]
  for (const t of scan.tables) tableParagraphs(t, out)
  for (const t of scan.orphanTables) tableParagraphs(t, out)
  return [...new Set(out)].sort((a, b) => a.start - b.start)
}

export function scanTableParagraphs(table: ScanTable): ScanParagraph[] {
  const out: ScanParagraph[] = []
  tableParagraphs(table, out)
  return out.sort((a, b) => a.start - b.start)
}

/** 줄 머리 부호(문단 번호·글머리가 그린 "- " "1." 등) — 원문 hp:t 에 없을 수 있다 */
const LEAD_RE = /^[-•·◦○□■▪▶►※*ㅇ❍➊-➓①-⑳]$/u

/** 줄("\n")별 머리 부호 글자 표시 + 줄을 공백으로 이은 글 */
function withOptionalLeads(plain: string): { text: string; opt: boolean[] } {
  const opt: boolean[] = new Array(plain.length).fill(false)
  let at = 0
  for (const line of plain.split("\n")) {
    const w = line.match(/^(\S+)\s/)?.[1]
    if (w && (LEAD_RE.test(w) || AUTONUM_PREFIX_RE.test(w))) for (let k = 0; k < w.length; k++) opt[at + k] = true
    at += line.length + 1
  }
  return { text: plain.replace(/\n/g, " "), opt }
}

/** 이어 붙인 글(공백 무시)이 target 과 같은 문단 묶음들 — target 의 머리 부호 글자는 원문에 없어도 된다. 빈 문단으로 시작하지 않는다 */
export function findRuns(texts: string[], target: string, opt: boolean[]): Array<[number, number]> {
  const tch: string[] = [], topt: boolean[] = []
  for (let k = 0; k < target.length; k++) if (!isWs(target[k])) { tch.push(target[k]); topt.push(opt[k]) }
  const keys = texts.map(key)
  /** 문단 글 k 를 target 위치 t 부터 맞대 다음 위치 (못 맞추면 -1) */
  const eat = (k: string, t: number): number => {
    for (const c of k) {
      while (t < tch.length && tch[t] !== c && topt[t]) t++
      if (tch[t] !== c) return -1
      t++
    }
    return t
  }
  const done = (t: number): boolean => { while (t < tch.length && topt[t]) t++; return t === tch.length }
  const out: Array<[number, number]> = []
  for (let i = 0; i < texts.length; i++) {
    if (!keys[i]) continue
    let t = eat(keys[i], 0)
    let j = i
    while (t >= 0 && !done(t) && j + 1 < texts.length && j - i < 60) t = eat(keys[++j], t)
    if (t >= 0 && done(t)) out.push([i, j])
  }
  return out
}

/** norm[i] 의 원문 위치. 원문 여분 공백은 건너뛰고, 원문에 없는 IR 공백·머리 부호는 폭 0 으로 둔다. 못 맞추면 null */
function align(raw: string, norm: string, opt?: boolean[]): { pos: number[]; zw: boolean[] } | null {
  const pos: number[] = new Array(norm.length)
  const zw: boolean[] = new Array(norm.length).fill(false)
  let j = 0
  for (let i = 0; i < norm.length; i++) {
    const a = norm[i]
    for (;;) {
      const b = raw[j]
      if (b !== undefined && (a === b || (isWs(a) && isWs(b)))) { pos[i] = j++; break }
      if (isWs(b)) { j++; continue }
      if (isWs(a) || opt?.[i]) { pos[i] = j; zw[i] = true; break }
      return null
    }
  }
  if (raw.slice(j).trim() !== "") return null
  return { pos, zw }
}

/** 원문 글 T 와 IR 평문을 맞대 낱말 diff 덩어리를 T 좌표 편집으로 (못 맞대면 null) */
function mapHunks(T: string, origPlain: string, newPlain: string, opt?: boolean[]): RawEdit[] | null {
  const al = align(T, origPlain, opt)
  if (!al) return null
  const { pos, zw } = al
  const n = origPlain.length
  const endOf = (k: number): number => pos[k] + (zw[k] ? 0 : 1)
  const tail = n > 0 ? endOf(n - 1) : 0
  return wordHunks(origPlain, newPlain).map(h => {
    const start = h.s < n ? pos[h.s] : tail
    return { start, end: h.e > h.s ? Math.max(start, endOf(h.e - 1)) : start, text: h.text }
  })
}

/** 줄 머리 부호 표시를 붙인 평문 — fallbackTextEdit 와 같은 꼴(줄은 "\n") 입력 */
export function prepareFallback(origLines: string, newLines: string): { origPlain: string; newPlain: string; opt: boolean[] } {
  const { text, opt } = withOptionalLeads(origLines)
  return { origPlain: text, newPlain: newLines.replace(/\n/g, " "), opt }
}

/**
 * 문단 묶음(texts, 문서 순서)의 편집을 문단별 글 좌표 편집으로 나눈다 — 문단 경계에 걸친 덩어리는 첫 문단에 새 글, 나머지 문단의
 * 겹친 글은 지운다. 못 맞대면 null
 */
export function planRunEdits(texts: string[], origPlain: string, newPlain: string, opt?: boolean[]): RawEdit[][] | null {
  const edits = mapHunks(texts.join("\n"), origPlain, newPlain, opt)
  if (!edits || edits.length === 0) return null
  const offs: number[] = []
  let o = 0
  for (const t of texts) { offs.push(o); o += t.length + 1 }
  const out: RawEdit[][] = texts.map(() => [])
  for (const e of edits) {
    let placed = false
    for (let k = 0; k < texts.length && e.end > e.start; k++) {
      const a = Math.max(e.start, offs[k]), b = Math.min(e.end, offs[k] + texts[k].length)
      if (a >= b) continue
      out[k].push({ start: a - offs[k], end: b - offs[k], text: placed ? "" : e.text })
      placed = true
    }
    if (placed) continue
    // 넣기(또는 문단 경계만 덮은 덩어리) — 시작 자리를 담은 문단에
    const k = offs.findIndex((off, i) => e.start >= off && e.start <= off + texts[i].length)
    if (k < 0) return null
    out[k].push({ start: e.start - offs[k], end: e.start - offs[k], text: e.text })
  }
  return out
}

function overlaps(a: SpliceEdit, b: SpliceEdit): boolean {
  if (a.start < b.end && b.start < a.end) return true
  return (a.start === a.end && a.start > b.start && a.start < b.end) || (b.start === b.end && b.start > a.start && b.start < a.end)
}

function pushSplices(ctx: FallbackCtx, section: number, splices: SpliceEdit[]): boolean {
  const cur = ctx.sectionSplices[section]
  if (splices.some(s => cur.some(c => overlaps(s, c)))) return false
  cur.push(...splices)
  return true
}

/** 문단 묶음 글(origPlain)을 newPlain 으로 — 바뀐 낱말 자리만 */
function editRun(ctx: FallbackCtx, paras: ScanParagraph[], origPlain: string, newPlain: string, opt?: boolean[]): boolean {
  const section = paras[0].sectionIndex
  const xml = ctx.scans[section]?.xml
  if (!xml) return false
  let T = ""
  let br = ""
  const toks: TextTok[] = []
  for (const p of paras) {
    if (T) T += "\n" // 문단 경계 — 낱자가 아니라 고치는 범위에 들어도 남는다
    const pt = paraTokens(p, xml, T.length)
    if (!pt) return false
    T += pt.text
    toks.push(...pt.toks)
    br ||= pt.br
  }
  const edits = mapHunks(T, origPlain, newPlain, opt)
  if (!edits || edits.length === 0) return false
  const splices = tokenSplices(toks, edits, br || "<hp:lineBreak/>")
  return !!splices && pushSplices(ctx, section, splices)
}

/**
 * 글 편집 하나를 원문에서 글로 찾아 고친다. occ = 같은 글의 IR 등장 순번(0부터), total = IR 등장 수.
 * scope 를 주면 그 문단들(한 섹션)에서만 찾는다. 고쳤으면 true
 */
export function fallbackTextEdit(ctx: FallbackCtx, origLines: string, newLines: string, occ = 0, total = 1, scope?: ScanParagraph[]): boolean {
  const { origPlain, newPlain, opt } = prepareFallback(origLines, newLines)
  if (!key(origPlain) || origPlain === newPlain) return false
  const runsIn = (paras: ScanParagraph[]) => findRuns(paras.map(p => p.text), origPlain, opt).map(([i, j]) => paras.slice(i, j + 1))
  const runs = scope ? runsIn(scope) : ctx.scans.flatMap(s => runsIn(sectionParagraphs(s)))
  // 같은 글이 여러 곳이면 등장 순번으로 — 짧은 글("1" "계")은 순번이 어긋나기 쉬워 하나뿐일 때만
  const run = runs.length === 1 ? runs[0] : runs.length === total && key(origPlain).length >= 4 ? runs[occ] : undefined
  return !!run && editRun(ctx, run, origPlain, newPlain, opt)
}

const cellKey = (c: ScanCell): string => key(c.paragraphs.map(p => p.text).join(""))

/** 빈 칸에 글 넣기 — 첫 문단에 쓴다. 줄은 줄바꿈 요소로 */
function fillEmptyCell(ctx: FallbackCtx, cell: ScanCell, text: string): boolean {
  const para = cell.paragraphs[0]
  const xml = para && ctx.scans[para.sectionIndex]?.xml
  if (!xml) return false
  const sp = buildParagraphSplices(para, text, xml)
  if (!sp) return false
  const prefix = para.runPrefix ?? para.tRanges[0]?.prefix ?? "hp"
  const br = prefix ? `<${prefix}:lineBreak/>` : "<lineBreak/>"
  // 태그를 만든 쪽은 줄바꿈 글자를 넣지 않으므로 남은 "\n" 은 글의 줄
  return pushSplices(ctx, para.sectionIndex, sp.map(s => ({ ...s, replacement: s.replacement.replace(/\n/g, br) })))
}

/**
 * 표 칸 편집들 — grid 는 IR 표 유닛의 행별 칸 글(원본·편집, 모양 같음). 행을 칸 글로 맞대 칸을 짚고, 못 맞대면 칸 글로 찾는다.
 * 고친 칸 수와 못 고친 칸 목록을 돌려준다
 */
export function fallbackTableEdits(
  ctx: FallbackCtx, table: ScanTable | undefined, origRows: string[][], newRows: string[][],
): { applied: number; failed: Array<{ before: string; after: string }> } {
  let applied = 0
  const failed: Array<{ before: string; after: string }> = []
  const scope = table ? scanTableParagraphs(table) : undefined
  // 칸 글 등장 순번 (표 안에서)
  const allOrig = origRows.flat().map(key)
  const seen = new Map<string, number>()
  const occOf = allOrig.map(k => { const c = seen.get(k) ?? 0; seen.set(k, c + 1); return c })
  // 행 맞대기: 칸 글을 이은 열쇠가 같은 행, 같은 열쇠 행이 여럿이면 순번으로
  const scanRowKeys = table?.rows.map(r => r.map(cellKey).join("|")) ?? []
  const rowSeen = new Map<string, number>()
  let flat = 0
  for (let r = 0; r < origRows.length; r++) {
    const o = origRows[r], e = newRows[r]
    const rk = o.map(key).join("|")
    const ro = rowSeen.get(rk) ?? 0
    rowSeen.set(rk, ro + 1)
    const hits = scanRowKeys.flatMap((k, i) => (k === rk ? [i] : []))
    const irHits = origRows.filter(x => x.map(key).join("|") === rk).length
    const scanRow = table && (hits.length === 1 ? table.rows[hits[0]] : hits.length === irHits ? table.rows[hits[ro]] : undefined)
    for (let c = 0; c < o.length; c++, flat++) {
      if (o[c] === e[c] || key(o[c]) === key(e[c])) continue
      const cell = scanRow && scanRow.length === o.length ? scanRow[c] : undefined
      let ok = false
      if (cell) {
        if (!key(o[c])) ok = fillEmptyCell(ctx, cell, e[c])
        else ok = editRun(ctx, cell.paragraphs, o[c], e[c])
      }
      if (!ok && key(o[c])) {
        const k = allOrig[flat]
        ok = fallbackTextEdit(ctx, o[c], e[c], occOf[flat], allOrig.filter(x => x === k).length, scope)
      }
      if (ok) applied++
      else failed.push({ before: o[c], after: e[c] })
    }
  }
  return { applied, failed }
}
