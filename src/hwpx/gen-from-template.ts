/**
 * 부서 서식 견본 HWPX 로 새 문서 만들기 (generate --template).
 *
 * 견본 고쳐 쓰기(patch_document)는 같은 문서의 편집본을 원본과 줄 맞춤해 제자리 치환하므로, 표 열 수·표 개수가 다른
 * 새 내용에선 견본 표·띠·그림이 옛 글로 남는다(열/병합 변경·개체 문단 삭제 미지원). 여기는 줄 맞춤 없이 역할 원형만
 * 빌려 새로 짠다 — 부호 갈래(markerClass)·문단 범위·splice·기본 표는 패치와 같은 부품을 쓴다.
 *
 * 견본의 header.xml(글자·문단 모양·테두리, 순서·id 그대로)·쪽 설정(secPr)·설정·BinData 를 두고 section0 본문만 새로 짠다.
 * 본문은 template-scan 이 고른 역할별 원형 문단을 복제해 글만 바꾼 것이다 — 마크다운 아웃라인(outline.ts)의
 *   # 제목 → 제목표(담당 줄 칸은 ☎ 줄 조각을 직위 낱말로 맞춰 채우고 없으면 비운다) · > 요약 → 요약 상자
 *   · ## 장 → 장 띠(참고N 이면 참고 띠 — 그 아래 부호 없는 항목은 견본 참고 쪽 항목 서식, 장 띠가 없는 견본이면
 *     □ 문단으로 내리고 그 아래를 한 단계씩 내린다) · □ ○ - · → L0~L3 · ※ → ref · ▶【 → 같은 기호 원형
 *   · 표 → 견본 데이터 표(머리행·본문·합계행 × 첫 열·가운데·끝 열 칸 서식, 견본 표 폭 안에서 내용 비례 열 너비).
 * 원형이 없는 역할은 가까운 원형(단계는 이웃 단계 + 부호 바꿈)이나 견본 바탕글(paraPr·charPr 0)로 쓴다.
 * header 는 덧붙이기만 한다(기존 id·순서 불변): 표 원형이 없을 때 실선 테두리 하나, 담당 칸의 균등 분할 정렬을 가운데로
 * 바꾼 문단 모양 — 짧은 글이 칸 너비로 흩어지지 않게.
 * 복제한 표·그림·도형은 id·instid·zOrder 를 새로 매긴다 — 견본 id 를 그대로 두면 한글이 개체를 잘못 집는다.
 */

import { appendBorderFills, createBorderVariants, type BorderVariants } from "../roundtrip/border-variants.js"
import { parseMarkdownToBlocks, buildPrvText, beginInlineDoc, endInlineDoc, extractFootnoteDefs, parseInlineMarkdown, type MdBlock } from "./md-runs.js"
import { buildOutline, type OutlineNode } from "./outline.js"
import { polishGongmunBlock } from "./gongmun-typo.js"
import { cleanPastedMarkdown } from "./paste-clean.js"
import { computeColWidths, colRoles, placeTotalRow, resolveTotalRow, TOTAL_LABEL_RE, type TotalRowPosition } from "./gen-table.js"
import { measureTextWidth } from "./text-metrics.js"
import { escapeTextXml } from "./gen-ids.js"
import { parseHtmlTable, htmlCellInnerToLines } from "../roundtrip/markdown-units.js"
import { injectCellBorderFill, buildTableParagraphXml } from "../roundtrip/table-insert.js"
import { applySplices } from "../roundtrip/source-map.js"
import { topLevelParagraphs } from "../roundtrip/structure-edit.js"
import { KordocError } from "../utils.js"
import { loadTemplateZip, packTemplateZip } from "./template-zip.js"
import {
  scanTemplate, fillParagraph, tableInfo, hostTable, elementAt, resetBreaks, lineRole, removeElements, dropNonChars, bodyText,
  BAND_LABEL_RE, SUBTITLE_RE, type TemplateScan, type CellInfo, type TableInfo, type RoleKey,
} from "./template-scan.js"

export { scanTemplate, type TemplateScan, type RoleKey } from "./template-scan.js"

const GLYPH = ["□", "○", "-", "·"]
const DATE_RE = /^\(?\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?(?:\s*\([^)]{0,20}\))?\)?$/u
const DATE_IN_RE = /\d{4}\.\s*\d{1,2}\./
/** 원고 담당 줄 — 전화 기호나 '담당:' 이 있어야 한다(날짜만 든 본문 줄을 훔치지 않게) */
const CONTACT_LINE_RE = /☎|담당자?\s*[:：]/u
/** 담당 칸 직위 낱말 — 조각과 견본 칸을 이 낱말로 맞춘다 */
const ROLE_KW_RE = /(담당|주무관|팀장|과장|국장|실장|센터장|소장|부장|계장)/u
const ROMAN = ["Ⅰ", "Ⅱ", "Ⅲ", "Ⅳ", "Ⅴ", "Ⅵ", "Ⅶ", "Ⅷ", "Ⅸ", "Ⅹ", "Ⅺ", "Ⅻ"]
/** 참고 장 제목 — "참고1 제목" "참고 2. 제목" "별첨 제목" */
const BAND_TITLE_RE = /^[<＜\[［]?(참고|별첨|붙임)\s*(\d{0,3})[>＞\]］]?[.:：)]?\s*(.*)$/u
const OBJ_TAG_RE = /<hp:(tbl|pic|rect|ellipse|arc|polygon|curve|line|connectLine|container|textart|ole|equation|chart|video)\b[^>]{0,4096}>/g
/** 생성 section 상한 — 원형 복제가 폭주하지 않게 */
const MAX_OUTPUT = 64 * 1024 * 1024

const maxOf = (xs: number[], floor = 0): number => xs.reduce((a, b) => (b > a ? b : a), floor)

/** 인라인 마크다운 → 평문 (견본 header 에 굵게·기울임 짝 글자 모양이 없어 서식은 버린다) */
function plainInline(text: string): string {
  return dropNonChars(parseInlineMarkdown(text).map((s) => s.text).join(""))
}

interface GCell { r: number; c: number; rs: number; cs: number; lines: string[] }
interface Grid { rowCnt: number; colCnt: number; cells: GCell[] }

function gridFromRows(rows: string[][]): Grid {
  const colCnt = maxOf(rows.map((r) => r.length), 1)
  const cells: GCell[] = []
  rows.forEach((row, r) => {
    for (let c = 0; c < colCnt; c++) cells.push({ r, c, rs: 1, cs: 1, lines: (row[c] ?? "").split(/<br\s*\/?>/i).map((l) => plainInline(l.trim())) })
  })
  return { rowCnt: rows.length, colCnt, cells }
}

/** HTML 표(병합) → 격자. 점유 칸을 건너뛰며 놓고(위 행 rowspan 과 겹치는 colspan 은 줄인다), 빈 자리는 빈 칸으로 메운다 */
function gridFromHtml(html: string): Grid | null {
  const rows = parseHtmlTable(html)
  if (!rows || rows.length === 0) return null
  const taken = new Set<string>()
  const cells: GCell[] = []
  let colCnt = 0
  rows.forEach((row, r) => {
    let c = 0
    for (const cell of row.cells) {
      while (taken.has(`${r},${c}`)) c++
      const rs = Math.min(Math.max(1, cell.rowSpan), rows.length - r)
      let cs = Math.max(1, cell.colSpan)
      for (let dc = 1; dc < cs; dc++) if (taken.has(`${r},${c + dc}`)) { cs = dc; break }
      const lines = htmlCellInnerToLines(cell.inner).lines.map(plainInline)
      cells.push({ r, c, rs, cs, lines: lines.length ? lines : [""] })
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) taken.add(`${r + dr},${c + dc}`)
      c += cs
      colCnt = Math.max(colCnt, c)
    }
  })
  if (!colCnt) return null
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < colCnt; c++) {
    if (!taken.has(`${r},${c}`)) cells.push({ r, c, rs: 1, cs: 1, lines: [""] })
  }
  cells.sort((a, b) => a.r - b.r || a.c - b.c)
  return { rowCnt: rows.length, colCnt, cells }
}

/** 담당 줄 → 조각 — "|" 구분이 있으면 그것, 없으면 앞 날짜와 ☎번호 뒤 빈칸에서 나눈다 (☎번호는 한 조각에) */
function splitContact(line: string): string[] {
  const out: string[] = []
  let rest = line.trim()
  // 맨 앞 작성일은 "|" 구분 원고에서도 따로 한 조각("2026. 10. 21.(수) 과장: … | 담당: …")
  const d = /^\(?\d{4}\.\s*\d{1,2}\.\s*\d{1,2}\.?(?:\s*\([^)]{0,20}\))?\)?[,，]?/u.exec(rest)
  if (d) { out.push(d[0].replace(/[,，]$/, "")); rest = rest.slice(d[0].length).replace(/^\s*[|｜]?\s*/, "").trim() }
  if (/[|｜]/.test(rest)) return [...out, ...rest.split(/\s*[|｜]\s*/).map((s) => s.trim()).filter(Boolean)]
  out.push(...rest.split(/(?<=☎\s{0,3}[\d-]{1,20})[\s,，]+/u).map((s) => s.trim()).filter(Boolean))
  return out
}

interface CellEdit {
  cell: CellInfo
  lines: string[]
  post?: (p: string) => string
  /** 칸 첫 문단 XML 을 받아 직접 고친 문단 — 있으면 lines 로 다시 짜지 않는다(견본 run·인라인 요소 보존) */
  raw?: (first: string) => string | null
}

/** 칸 문단을 줄마다 첫 문단 원형으로 다시 짠 표 XML 조각 (편집은 표 문자열 좌표) */
function fillCells(xml: string, edits: CellEdit[]): string {
  return applySplices(xml, edits.filter((e) => e.cell.paras.length).map(({ cell, lines, post, raw }) => {
    const first = xml.slice(cell.paras[0].start, cell.paras[0].end)
    const direct = raw?.(first)
    return {
      start: cell.paras[0].start, end: cell.paras[cell.paras.length - 1].end,
      replacement: direct ?? (lines.length ? lines : [""]).map((l) => (post ? post(fillParagraph(first, l)) : fillParagraph(first, l))).join(""),
    }
  }))
}

/**
 * 견본 칸 문단에서 값 글만 바꾼다 — "직위<고정폭 빈칸>:<고정폭 빈칸>값" 의 직위·구분자 요소와 run 글자 모양은 그대로
 * 두어야 견본처럼 한 줄에 들어간다(글로 다시 짜면 고정폭 빈칸이 다른 폭의 빈칸이 되어 넘쳤다, 2026-10-21 실측).
 * 옛 값이 문단 글(태그 밖)에 정확히 한 번 있을 때만, 아니면 null(→ 글로 다시 짠다).
 */
export function replaceCellValue(pXml: string, oldValue: string, newValue: string): string | null {
  const needle = escapeTextXml(oldValue)
  const at = pXml.indexOf(needle)
  if (!oldValue || at < 0 || pXml.indexOf(needle, at + 1) >= 0) return null
  // 태그 안(속성 값)이 아니라 글 안이어야 한다
  if (pXml.lastIndexOf("<", at) > pXml.lastIndexOf(">", at)) return null
  return pXml.slice(0, at) + bodyText(newValue) + pXml.slice(at + needle.length)
}

interface EmitCtx {
  scan: TemplateScan
  headerXml: string
  warnings: string[]
  /** 표 원형이 없어 header 에 덧붙일 실선 테두리 id (필요할 때 한 번 정한다) */
  fallbackBf: { id: number; used: boolean }
  /** 균등 분할 정렬 문단 모양 → 가운데 정렬로 덧붙인 문단 모양 id */
  centered: Map<string, string>
  nextParaPr: number
  /** 원형이 없어 가까운 서식으로 대신한 역할 — 경고 한 줄로 모은다 */
  missing: Set<string>
  /** 한 번만 낼 경고 */
  notes: Set<string>
  /** 표 합계 행 위치 */
  totalRow: TotalRowPosition
  /** 본문 행 테두리를 자리에 맞게 고친 변형 (header 에 덧붙임) */
  borders: BorderVariants
}

/** 견본 바탕글 문단 — 본문 원형이 없을 때 */
function defaultPara(text: string): string {
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${text ? `<hp:t>${bodyText(text)}</hp:t>` : ""}</hp:run></hp:p>`
}

function bodyPara(ctx: EmitCtx, text: string): string {
  const body = ctx.scan.protos.get("body")
  return body ? fillParagraph(body, text) : defaultPara(text)
}

function levelPara(ctx: EmitCtx, depth: number, text: string, glyph?: string): string {
  if (depth > 3) ctx.notes.add("template: 견본 항목은 4단계(·)까지 — 더 깊은 항목은 4단계 서식으로 썼습니다")
  const d = Math.max(0, Math.min(depth, 3))
  for (const k of [d, d - 1, d + 1, d - 2, d + 2, d - 3, d + 3]) {
    const proto = k >= 0 && k <= 3 ? ctx.scan.protos.get(`L${k}` as RoleKey) : undefined
    if (!proto) continue
    if (k !== d) ctx.missing.add(`${GLYPH[d]} 항목`)
    return fillParagraph(proto, text, { marker: true, glyph: glyph ?? (k === d ? undefined : GLYPH[d]) })
  }
  ctx.missing.add(`${GLYPH[d]} 항목`)
  return bodyPara(ctx, `${glyph ?? GLYPH[d]} ${text}`)
}

/** 역할 원형으로 항목 문단 (기호 원형이면 그 기호, 단계면 그 단계) */
function rolePara(ctx: EmitCtx, role: RoleKey, text: string): string {
  if (/^L[0-3]$/.test(role)) return levelPara(ctx, Number(role[1]), text)
  const proto = ctx.scan.protos.get(role)
  return proto ? fillParagraph(proto, text, { marker: true }) : levelPara(ctx, 1, text)
}

/** 기호로 시작하는 문단(▶ 【 ⇒ …) — 같은 기호 원형이 있으면 그 서식 */
function symbolPara(ctx: EmitCtx, text: string): string | null {
  const role = lineRole(text)
  if (!role?.startsWith("sym:")) return null
  const proto = ctx.scan.protos.get(role)
  if (!proto) return null
  const ch = role.slice(4)
  return fillParagraph(proto, text.replace(/^\s+/, "").slice(ch.length).trim(), { marker: true })
}

/** 장·참고 띠 — 첫 칸 번호, 가장 넓은 칸 제목, 나머지 칸 비움 */
function bandXml(proto: string, label: string, title: string): string {
  const el = hostTable(proto)!
  const info = tableInfo(proto, el, new Map())
  const first = info.cells.find((c) => c.row === 0 && c.col === 0)!
  const titleCell = info.cells.filter((c) => c !== first).sort((a, b) => b.width - a.width)[0]
  // 견본 번호 칸 꼴 따르기 — "Ⅰ." 처럼 마침표, "[Ⅰ]" 처럼 괄호
  const m = /^(\s{0,8}[\[［<＜]?)(?:[^\s\]］>＞.)]{1,20})([.)]?[\]］>＞]?\s{0,8})$/u.exec(first.text)
  const lab = m ? `${m[1]}${label}${m[2]}` : label
  const lead = /^\s*/.exec(titleCell?.text ?? "")?.[0] ?? ""
  return fillCells(proto, info.cells.map((c) => ({ cell: c, lines: [c === first ? lab : c === titleCell ? lead + title : ""] })))
}

function chapterPara(ctx: EmitCtx, node: Extract<OutlineNode, { kind: "chapter" }>): { xml: string; shift: boolean; band: boolean } {
  const text = plainInline(node.text)
  const band = BAND_TITLE_RE.exec(text)
  const { protos } = ctx.scan
  if (band) {
    const proto = protos.get("band") ?? protos.get("chapter")
    return { xml: proto ? bandXml(proto, `${band[1]}${band[2]}`, band[3]) : levelPara(ctx, 0, text), shift: false, band: true }
  }
  const chap = protos.get("chapter")
  if (chap) {
    if (!node.label && node.index > ROMAN.length) ctx.notes.add(`template: 장이 ${ROMAN.length}개를 넘어 번호(Ⅰ~Ⅻ)가 다시 돕니다 — ## 제목에 번호를 직접 쓰세요`)
    return { xml: resetBreaks(bandXml(chap, node.label ?? ROMAN[(node.index - 1) % ROMAN.length], text)), shift: false, band: false }
  }
  return { xml: levelPara(ctx, 0, text), shift: true, band: false }
}

const isTotalLabel = (s: string) => TOTAL_LABEL_RE.test(s.replace(/[*_`]/g, "").trim())

/** 견본 데이터 표 원형으로 표 짜기 */
function tableXml(ctx: EmitCtx, grid: Grid): string {
  const proto = ctx.scan.protos.get("table")
  if (!proto) { ctx.missing.add("데이터 표"); return fallbackTable(ctx, grid) }
  const el = hostTable(proto)!
  const info = tableInfo(proto, el, ctx.scan.heights)
  const byRow = new Map<number, CellInfo[]>()
  for (const c of info.cells) byRow.set(c.row, [...(byRow.get(c.row) ?? []), c])
  // 견본 합계 행(첫 칸 합계·총계·계) — 있으면 원고 합계 행에 그 행 서식(음영·굵게)을 옮겨 쓴다(자리는 원고 합계 행 자리)
  const tplTotalRow = [...byRow].find(([r, cells]) => r > 0 && isTotalLabel(cells.find((c) => c.col === 0)?.text ?? ""))?.[0]
  const gByRow = new Map<number, GCell[]>()
  for (const g of grid.cells) gByRow.set(g.r, [...(gByRow.get(g.r) ?? []), g])
  const mdTotal = (r: number) => r > 0 && isTotalLabel((gByRow.get(r) ?? []).find((g) => g.lines.join("").trim())?.lines.join("") ?? "")
  const rowKind = (r: number) => (r === 0 ? "header" : tplTotalRow !== undefined && mdTotal(r) ? "total" : "body")
  const colKind = (c: number, cs: number) => (c === 0 ? "first" : c + cs === grid.colCnt ? "last" : "middle")
  const fits: Record<string, (c: CellInfo) => boolean> = {
    first: (c) => c.col === 0,
    last: (c) => c.col + c.colSpan === info.colCnt && c.col > 0,
    middle: (c) => c.col > 0 && c.col + c.colSpan < info.colCnt,
  }
  const memo = new Map<string, CellInfo>()
  // 본문 행은 자리(첫 행·가운데·마지막)가 같은 견본 행을 먼저 — 첫 본문 행 칸을 모든 행에 쓰면 윗변 머리 구분선이 행마다 그어졌다
  const pick = (rk: string, ck: string, pos: "first" | "mid" | "last" = "first"): CellInfo => {
    const key = `${rk}|${ck}|${pos}`
    const hit = memo.get(key)
    if (hit) return hit
    const n = info.rowCnt
    const body = [...Array(n).keys()].slice(1).filter((r) => r !== tplTotalRow)
    const prefer = pos === "mid" ? body.filter((r) => r > 1 && r < n - 1) : pos === "last" ? body.filter((r) => r === n - 1) : []
    const rows = rk === "header" ? [...Array(n).keys()] : rk === "total" ? [tplTotalRow!, ...body] : [...prefer, ...body, 0]
    const order = ck === "middle" ? ["middle", "last", "first"] : ck === "last" ? ["last", "middle", "first"] : ["first", "middle", "last"]
    let found: CellInfo | undefined
    for (const k of order) {
      for (const r of rows) { found = byRow.get(r)?.find(fits[k]); if (found) break }
      if (found) break
    }
    memo.set(key, found ?? info.cells[0])
    return found ?? info.cells[0]
  }
  const bodyCell = pick("body", "middle")
  const charH = ctx.scan.heights.get(/\bcharPrIDRef="(\d+)"/.exec(proto.slice(bodyCell.el.start, bodyCell.el.end))?.[1] ?? "") ?? 1000
  // 열 너비 — 견본 표 폭 안에서 gen-table 과 같은 내용 비례 배분
  const colMax = Array<number>(grid.colCnt).fill(0)
  const colMinWord = Array<number>(grid.colCnt).fill(0)
  for (const g of grid.cells) {
    const w = maxOf(g.lines.map((l) => measureTextWidth(l, charH, 100))) / g.cs
    for (let c = g.c; c < g.c + g.cs; c++) colMax[c] = Math.max(colMax[c], w)
    if (g.cs === 1) colMinWord[g.c] = maxOf(g.lines.flatMap((l) => l.split(/[ \t]+/)).map((wd) => measureTextWidth(wd, charH, 100)), colMinWord[g.c])
  }
  const headers = Array.from({ length: grid.colCnt }, (_, c) => (gByRow.get(0) ?? []).find((g) => g.c === c)?.lines.join("") ?? "")
  const widths = computeColWidths(colMax, info.width || 42000, colMinWord, colRoles(headers, false))
  const rowH = Array.from({ length: grid.rowCnt }, (_, r) => pick(rowKind(r), "first").height || 1500)

  const trs = Array.from({ length: grid.rowCnt }, (_, r) => (gByRow.get(r) ?? []).map((g) => {
    const pc = pick(rowKind(g.r), colKind(g.c, g.cs), g.r <= 1 ? "first" : g.r + g.rs - 1 === grid.rowCnt - 1 ? "last" : "mid")
    const tcXml = proto.slice(pc.el.start, pc.el.end)
    let tc = applySplices(tcXml, pc.paras.length ? [{
      start: pc.paras[0].start - pc.el.start, end: pc.paras[pc.paras.length - 1].end - pc.el.start,
      replacement: g.lines.map((l) => fillParagraph(proto.slice(pc.paras[0].start, pc.paras[0].end), l)).join(""),
    }] : [])
    const w = widths.slice(g.c, g.c + g.cs).reduce((a, b) => a + b, 0)
    const h = rowH.slice(g.r, g.r + g.rs).reduce((a, b) => a + b, 0)
    if (g.r > 0) tc = placeRowBorders(ctx, proto, tc, info, byRow, g.r, g.r + g.rs - 1 === grid.rowCnt - 1, colKind(g.c, g.cs), fits)
    tc = tc.replace(/<hp:cellAddr\b[^>]{0,1024}\/>/, `<hp:cellAddr colAddr="${g.c}" rowAddr="${g.r}"/>`)
      .replace(/<hp:cellSpan\b[^>]{0,1024}\/>/, `<hp:cellSpan colSpan="${g.cs}" rowSpan="${g.rs}"/>`)
      .replace(/<hp:cellSz\b[^>]{0,1024}\/>/, `<hp:cellSz width="${w}" height="${h}"/>`)
    return tc
  }).join(""))
  const tblXml = proto.slice(info.el.start, info.el.end)
  const firstTr = info.trs[0].start - info.el.start, lastTr = info.trs[info.trs.length - 1].end - info.el.start
  const tblW = widths.reduce((a, b) => a + b, 0), tblH = rowH.reduce((a, b) => a + b, 0)
  // 견본 표의 칸 영역 서식(cellzoneList)·캡션·개체 설명은 견본 행·열 좌표라 새 표에 맞지 않는다
  const headPart = removeElements(tblXml.slice(0, firstTr), ["cellzoneList", "caption", "shapeComment"])
    .replace(/\browCnt="\d+"/, `rowCnt="${grid.rowCnt}"`).replace(/\bcolCnt="\d+"/, `colCnt="${grid.colCnt}"`)
    .replace(/(<hp:sz\b[^>]{0,1024}?)\bwidth="\d+"/, `$1width="${tblW}"`).replace(/(<hp:sz\b[^>]{0,1024}?)\bheight="\d+"/, `$1height="${tblH}"`)
  const tbl = headPart + trs.map((t) => `<hp:tr>${t}</hp:tr>`).join("") + tblXml.slice(lastTr)
  return resetBreaks(proto.slice(0, info.el.start) + tbl + proto.slice(info.el.end))
}

/**
 * 본문 행 칸 테두리를 자리에 맞게 — 원형 칸은 견본 첫 본문 행(윗변 = 머리 구분선)이나 마지막 행(아랫변 = 바깥선)에서 오므로 그대로 쓰면
 * 모든 행에 이중선·굵은 바깥선이 그어졌다. 첫 본문 행만 윗변에 견본 머리 구분선을, 마지막 행만 아랫변에 견본 바깥선을 두고 나머지는
 * 안쪽 가로선(견본 셋째 행부터의 윗변 → 원형 칸이 마지막 행이 아니면 그 아랫변 → 같은 칸 안쪽 세로선)으로
 */
function placeRowBorders(ctx: EmitCtx, proto: string, tc: string, info: TableInfo, byRow: Map<number, CellInfo[]>, row: number, isLast: boolean,
  ck: string, fits: Record<string, (c: CellInfo) => boolean>): string {
  const m = /^<hp:tc\b[^>]{0,4096}?\bborderFillIDRef="(\d+)"/.exec(tc)
  if (!m) return tc
  const id = Number(m[1])
  const bfOf = (r: number) => {
    const c = byRow.get(r)?.find(fits[ck]) ?? byRow.get(r)?.[0]
    const b = c && /^<hp:tc\b[^>]{0,4096}?\bborderFillIDRef="(\d+)"/.exec(proto.slice(c.el.start, c.el.end))
    return b ? ctx.borders.sides(Number(b[1])) : null
  }
  const own = ctx.borders.sides(id)
  if (!own) return tc
  const lastTpl = info.rowCnt - 1
  let inner: string | undefined
  for (let r = 2; r <= lastTpl && !inner; r++) inner = bfOf(r)?.top
  if (!inner) inner = info.rowCnt > 2 ? bfOf(1)?.bottom : ck === "last" ? own.left : own.right
  if (!inner) return tc
  const top = row === 1 ? bfOf(1)?.top ?? own.top : inner
  const bottom = isLast ? bfOf(lastTpl)?.bottom ?? own.bottom : inner
  const nid = ctx.borders.variant(id, { top, bottom })
  return nid === id ? tc : tc.slice(0, m.index + m[0].length - m[1].length - 1) + nid + tc.slice(m.index + m[0].length - 1)
}

/** 견본에 표 원형이 없을 때 — 실선 테두리 기본 표 (header 에 borderFill 하나 덧붙임) */
function fallbackTable(ctx: EmitCtx, grid: Grid): string {
  ctx.fallbackBf.used = true
  const at = new Map(grid.cells.map((g) => [`${g.r},${g.c}`, g.lines.join(" ")]))
  const rows = Array.from({ length: grid.rowCnt }, (_, r) => Array.from({ length: grid.colCnt }, (_, c) => at.get(`${r},${c}`) ?? ""))
  return buildTableParagraphXml(rows, { borderFillId: ctx.fallbackBf.id, outerParaPrId: 0, cellParaPrId: 0, cellCharPrId: 0, tableId: 0 })
}

/** 균등 분할(DISTRIBUTE) 칸 문단은 가운데 정렬 문단 모양으로 — 견본보다 짧은 글이 칸 너비로 흩어지지 않게 */
function undistribute(ctx: EmitCtx, pXml: string): string {
  const id = /\bparaPrIDRef="(\d+)"/.exec(pXml.slice(0, pXml.indexOf(">")))?.[1]
  if (!id || !/^DISTRIBUTE/.test(ctx.scan.aligns.get(id) ?? "")) return pXml
  let alt = ctx.centered.get(id)
  if (!alt) { alt = String(ctx.nextParaPr++); ctx.centered.set(id, alt) }
  return pXml.replace(/\bparaPrIDRef="\d+"/, `paraPrIDRef="${alt}"`)
}

/** 제목표 — 제목 칸(가장 큰 글자)에 제목, 담당 줄 칸에 ☎ 조각(없으면 비움) */
function titleXml(ctx: EmitCtx, title: string, contact: string | null): string {
  const proto = ctx.scan.protos.get("title")!
  const el = hostTable(proto)
  if (!el) return fillParagraph(proto, title)
  const info = tableInfo(proto, el, ctx.scan.heights)
  const isContact = (c: CellInfo) => /☎|담당자?\s*[:：]/.test(c.text) || DATE_IN_RE.test(c.text)
  const contactCells = info.cells.filter(isContact)
  const titleCell = info.cells.filter((c) => !contactCells.includes(c) && c.text).sort((a, b) => b.maxH - a.maxH)[0] ?? info.cells[0]
  // 담당 줄 행의 나머지 칸도 담당 줄 칸 (날짜만 든 칸 등)
  const contactRows = new Set(contactCells.map((c) => c.row))
  const slots = info.cells.filter((c) => c !== titleCell && contactRows.has(c.row)).sort((a, b) => a.row - b.row || a.col - b.col)
  const edits: CellEdit[] = [{ cell: titleCell, lines: [title] }, ...assignContacts(ctx, slots, contact)]
  return resetBreaks(fillCells(proto, edits))
}

/**
 * 담당 줄 조각을 칸에 — 날짜 조각은 날짜 칸, 직위 낱말(과장·팀장·담당 …)이 있는 조각은 같은 낱말 칸에 견본 칸의 꼴
 * ("직위 : 이름 ☎번호", 쌍점 앞뒤 빈칸·전각 빈칸까지 견본 그대로)로 넣는다. 칸마다 견본의 글자·문단 모양을 그대로 쓴다
 * — 결재선 칸은 견본 글 길이에 맞춰 글자 모양(자간)이 잡혀 있다. 원고에 없는 직위 칸은 견본 글을 그대로 두고 알린다
 * (같은 부서 견본이면 과장·팀장이 같다). 원고에 담당 줄이 아예 없으면 모두 비운다(견본 사람 정보가 새 문서에 남지 않게).
 */
function assignContacts(ctx: EmitCtx, slots: CellInfo[], contact: string | null): CellEdit[] {
  const texts = matchContactPieces(slots.map((c) => c.text), contact)
  const kept = slots.filter((c, i) => contact && texts[i] && texts[i] === c.text).map((c) => c.text.trim())
  if (kept.length) ctx.warnings.push(`template: 원고에 없는 담당 줄 칸은 견본 그대로 둠 — ${kept.join(", ")}`)
  // 칸이 하나뿐인 담당 줄(여러 조각을 한 칸에)은 글 길이가 견본과 달라 균등 분할이면 흩어진다 — 가운데 정렬로
  if (slots.length === 1) return [{ cell: slots[0], lines: [texts[0]], post: (p: string) => undistribute(ctx, p) }]
  return slots.flatMap((cell, i): CellEdit[] => {
    const next = texts[i]
    // 견본 그대로 두는 칸은 손대지 않는다(견본 XML 그대로)
    if (next === cell.text) return []
    const before = LABELLED_RE.exec(cell.text.trim()), after = LABELLED_RE.exec(next.trim())
    // 같은 직위면 값 글만 바꾼다, 날짜 칸은 날짜 글만
    const swap = before && after && before[1].trim() === after[1].trim() ? [before[3], after[3]]
      : !before && !after && DATE_IN_RE.test(cell.text) && next ? [cell.text.trim(), next.trim()] : null
    return [{ cell, lines: [next], ...(swap ? { raw: (first: string) => replaceCellValue(first, swap[0], swap[1]) } : {}) }]
  })
}

/** "직위 : 값" 칸 글 → 직위·구분자·값 (구분자는 쌍점과 그 앞뒤 빈칸·전각 빈칸 그대로) */
const LABELLED_RE = /^(.+?)([\s　]*[:：][\s　]*)(\S.*)$/u
/** 담당 줄 조각 → 직위 낱말·직위 글·값. 쌍점이 없으면 직위 낱말 뒤에서 나눈다("스마트정보과 담당 홍길동 ☎7215") */
function parseContactPiece(piece: string): { kw: string; label: string; value: string } | null {
  const m = LABELLED_RE.exec(piece.trim())
  if (m) {
    const kw = ROLE_KW_RE.exec(m[1])?.[1]
    return kw ? { kw, label: m[1].trim(), value: m[3].trim() } : null
  }
  const k = ROLE_KW_RE.exec(piece)
  if (!k) return null
  const end = (k.index ?? 0) + k[1].length
  const value = piece.slice(end).trim()
  return value ? { kw: k[1], label: piece.slice(0, end).trim(), value } : null
}
/** 담당·주무관 칸 직위 글은 견본 것을 쓴다 — 원고의 부서 이름("스마트정보과 담당")은 과장 칸 몫이라 담당 칸에 넣지 않는다 */
const STAFF_KW = new Set(["담당", "주무관"])

/** 견본 담당 칸 글 → 칸마다 넣을 새 글 (원고에 담당 줄이 없으면 모두 빈 글) */
export function matchContactPieces(slotTexts: string[], contact: string | null): string[] {
  const out = slotTexts.map(() => "")
  if (!contact || !slotTexts.length) return out
  if (slotTexts.length > 1) {
    const done = matchRoleSlots(slotTexts, splitContact(contact))
    if (done) return done
  }
  const pieces = slotTexts.length === 1 ? [splitContact(contact).join("  ")] : splitContact(contact)
  const free = slotTexts.map((_, i) => i)
  const take = (pred: (i: number) => boolean) => { const k = free.findIndex(pred); return k >= 0 ? free.splice(k, 1)[0] : undefined }
  const kw = (s: string) => ROLE_KW_RE.exec(s)?.[1] ?? ""
  const isDate = (i: number) => DATE_IN_RE.test(slotTexts[i])
  // 다른 조각이 직위 낱말로 차지할 칸은 남겨 둔다
  const claimed = new Set(pieces.map(kw).filter(Boolean))
  let last: number | undefined
  for (const piece of pieces) {
    const k = kw(piece)
    const at = (DATE_RE.test(piece) ? take(isDate) : k ? take((i) => kw(slotTexts[i]) === k) : undefined)
      ?? take((i) => !isDate(i) && !claimed.has(kw(slotTexts[i])))
      ?? take(() => true)
    if (at !== undefined) { out[at] = piece; last = at } else if (last !== undefined) out[last] += `  ${piece}`
  }
  return out
}

/**
 * 결재선 칸(날짜 | 과장 | 팀장 | 담당 꼴) 맞추기 — 견본 칸마다 직위 낱말이 있어야 쓴다(아니면 null → 차례 채우기).
 * 원고 조각을 직위 낱말로 칸에 넣고, 값만 바꾼 "직위 + 견본 구분자 + 새 값". 원고에 없는 직위 칸은 견본 글 그대로.
 */
function matchRoleSlots(slotTexts: string[], pieces: string[]): string[] | null {
  const slots = slotTexts.map((t) => {
    const date = DATE_IN_RE.test(t) && !ROLE_KW_RE.test(t)
    const m = LABELLED_RE.exec(t.trim())
    return { date, kw: m ? ROLE_KW_RE.exec(m[1])?.[1] ?? null : null, label: m?.[1].trim() ?? "", sep: m?.[2] ?? " : " }
  })
  if (slots.some((s) => !s.date && !s.kw)) return null
  const out = slotTexts.slice()
  for (const piece of pieces) {
    if (DATE_RE.test(piece)) {
      const i = slots.findIndex((s) => s.date)
      if (i >= 0) out[i] = piece
      continue
    }
    const entry = parseContactPiece(piece)
    if (!entry) return null
    const i = slots.findIndex((s) => s.kw === entry.kw)
    if (i < 0) return null
    out[i] = `${STAFF_KW.has(entry.kw) ? slots[i].label : entry.label}${slots[i].sep}${entry.value}`
  }
  return out
}

function contactXml(ctx: EmitCtx, contact: string): string {
  const proto = ctx.scan.protos.get("contact")
  if (!proto) return bodyPara(ctx, contact)
  const el = hostTable(proto)
  if (!el) return undistribute(ctx, fillParagraph(proto, contact))
  const info = tableInfo(proto, el, ctx.scan.heights)
  return resetBreaks(fillCells(proto, assignContacts(ctx, info.cells.filter((c) => c.text || info.cells.length === 1), contact)))
}

function summaryXml(ctx: EmitCtx, text: string): string {
  const proto = ctx.scan.protos.get("summary")
  const lines = text.split("\n").map((l) => plainInline(l.trim())).filter(Boolean)
  if (!proto) ctx.missing.add("요약 상자")
  if (!proto) return ctx.scan.protos.get("ref") ? fillParagraph(ctx.scan.protos.get("ref")!, lines.join(" "), { marker: true }) : bodyPara(ctx, lines.join(" "))
  const info = tableInfo(proto, hostTable(proto)!, ctx.scan.heights)
  return resetBreaks(fillCells(proto, [{ cell: info.cells[0], lines }]))
}

/** 마크다운 블록 → 견본 원형 문단들 */
function emitBody(ctx: EmitCtx, blocks: MdBlock[], head: { contact: string | null; sub: string | null }): string[] {
  const outline = buildOutline(blocks, { gaejosik: true, consumeTitle: true, summaryFromQuote: true, listUnderMarker: true, keepMarkers: true })
  const out: string[] = []
  const { protos } = ctx.scan
  const title = outline.title
  if (title && !protos.get("title")) ctx.missing.add("제목표")
  if (title) out.push(protos.get("title") ? titleXml(ctx, plainInline(title), ctx.scan.contactInTitle ? head.contact : null) : levelPara(ctx, 0, plainInline(title)))
  if (head.sub) {
    const sub = protos.get("subtitle")
    out.push(sub ? fillParagraph(sub, plainInline(head.sub)) : bodyPara(ctx, plainInline(head.sub)))
  }
  if (head.contact && !(title && protos.get("title") && ctx.scan.contactInTitle)) out.push(contactXml(ctx, plainInline(head.contact)))
  // 장 띠가 없는 견본에서 ## 장을 □ 로 내렸으면 그 아래 항목을 한 단계 내린다 (명시 □ 부호를 쓴 원고는 그대로)
  let shift = 0
  // 참고 띠 아래 — 부호 없이 쓴 첫 단계 항목은 견본 참고 쪽 항목 서식(▶ 등, 없으면 ○)
  let inBand = false
  for (const node of outline.nodes) {
    switch (node.kind) {
      case "title": break
      case "summary": out.push(summaryXml(ctx, node.text)); break
      case "chapter": {
        const r = chapterPara(ctx, node)
        out.push(r.xml)
        shift = r.shift && !outline.hasBoxMarkers ? 1 : 0
        inBand = r.band
        break
      }
      case "item": {
        const text = plainInline(node.text)
        const depth = node.depth + shift
        if (node.legalMarker) { out.push(levelPara(ctx, depth + 1, text, node.legalMarker)); break }
        if (node.marker && node.marker !== "▸") {
          out.push(symbolPara(ctx, `${node.marker} ${text}`) ?? levelPara(ctx, depth, text, node.marker))
          break
        }
        if (inBand && !node.fromHeading && node.marker !== "▸") {
          const base = ctx.scan.bandItem ?? "L1"
          const k = /^L[0-3]$/.test(base) ? Number(base[1]) : 0
          out.push(depth === 0 ? rolePara(ctx, base, text) : levelPara(ctx, Math.max(1, k + depth), text))
          break
        }
        out.push(levelPara(ctx, node.marker === "▸" ? 3 : depth, text))
        break
      }
      case "ref": {
        const text = plainInline(node.text)
        const ref = protos.get("ref")
        out.push(ref ? fillParagraph(ref, text, { marker: true }) : bodyPara(ctx, `※ ${text}`))
        break
      }
      case "heading": out.push(levelPara(ctx, node.level - 3 + shift, plainInline(node.text))); break
      case "para": {
        const text = plainInline(node.text)
        if (node.align) ctx.notes.add("template: <center>·<right> 정렬은 견본 모드에서 견본 문단 정렬을 따릅니다")
        out.push(symbolPara(ctx, text) ?? bodyPara(ctx, text))
        break
      }
      case "attach": out.push(bodyPara(ctx, plainInline(node.text))); break
      case "block": {
        const b = node.block
        if (b.type === "table" && b.rows?.length) {
          const g = gridFromRows(placeTotalRow(b.rows, ctx.totalRow))
          const first = g.cells[0]?.lines.join("").replace(/\s+/g, "") ?? ""
          if (g.rowCnt === 1 && g.colCnt >= 2 && g.colCnt <= 4 && BAND_LABEL_RE.test(first) && (protos.get("band") ?? protos.get("chapter"))) {
            const rest = g.cells.slice(1).map((c) => c.lines.join(" ")).join(" ").trim()
            out.push(bandXml((protos.get("band") ?? protos.get("chapter"))!, first.replace(/[<＜>＞\[［\]］]/g, ""), rest))
            inBand = true
          } else out.push(tableXml(ctx, g))
        } else if (b.type === "html_table") {
          const g = gridFromHtml(b.text ?? "")
          if (g) out.push(tableXml(ctx, g))
        } else if (b.type === "code_block") {
          if ((b.lang ?? "").toLowerCase() === "chart") { ctx.notes.add("template: 차트(```chart)는 견본 모드에서 그리지 않습니다 — 건너뜀"); break }
          for (const line of (b.text ?? "").split("\n")) out.push(bodyPara(ctx, line))
        } else if (b.type === "equation") {
          ctx.notes.add("template: 수식은 견본 모드에서 글자 그대로 둡니다")
          out.push(bodyPara(ctx, b.text ?? ""))
        } else if (b.type === "hr") {
          ctx.notes.add("template: 구분선(---)은 견본 모드에서 넣지 않습니다")
        }
        break
      }
    }
  }
  return out
}

/**
 * 제목 바로 뒤 담당 줄(☎·담당:)·작성일(날짜만 든 줄)·부제(- … -)를 빼 둔다 — 아웃라인 전에 빼야 뒤 인용문이 요약 상자가 된다.
 * 항목 부호로 시작하는 줄("□ 2026. 1. 1.부터 시행")과 날짜로 시작하는 본문 줄은 본문이다.
 */
function takeHeadLines(blocks: MdBlock[]): { blocks: MdBlock[]; contact: string | null; sub: string | null } {
  const h1 = blocks.findIndex((b) => b.type === "heading" && (b.level ?? 1) === 1)
  let contact: string | null = null, date: string | null = null, sub: string | null = null
  const drop = new Set<number>()
  // 제목(#)이 없는 원고는 첫 줄이 날짜·☎ 로 시작해도 본문이다 — 담당 줄로 빼지 않는다
  if (h1 < 0) return { blocks, contact, sub }
  for (let k = h1 + 1; k < blocks.length && k <= h1 + 4; k++) {
    const b = blocks[k]
    if (b.type !== "paragraph" && b.type !== "list_item" && b.type !== "blockquote") break
    if (b.type === "blockquote") continue
    // "2026. 10. 21.(수) …" 는 마크다운에서 번호 목록("2026.")으로 읽힌다 — 부호를 되붙여 원문 줄로
    const t = (b.type === "list_item" ? `${b.marker ?? "-"} ${b.text ?? ""}` : b.text ?? "").trim()
    const marked = lineRole(t) !== null && !/^\d/.test(t)
    if (!sub && SUBTITLE_RE.test(t) && t.length < 60) sub = t
    else if (!contact && !marked && CONTACT_LINE_RE.test(t)) contact = t
    else if (!date && DATE_RE.test(t)) date = t
    else break
    drop.add(k)
  }
  // 따로 쓴 작성일은 담당 줄 앞 조각으로 — "|" 구분 원고면 같은 구분으로 잇는다
  if (date) contact = !contact ? date : /[|｜]/.test(contact) ? `${date} | ${contact}` : `${date} ${contact}`
  return { blocks: blocks.filter((_, i) => !drop.has(i)), contact, sub }
}

/** 덧붙일 header 정의 — 가운데 정렬 문단 모양(균등 분할 대신)·기본 표 테두리. 기존 정의는 순서·id 그대로 */
function appendHeader(ctx: EmitCtx): string {
  let headerXml = ctx.headerXml
  if (ctx.fallbackBf.used) {
    const inj = injectCellBorderFill(headerXml, ctx.fallbackBf.id)
    if (inj) headerXml = applySplices(headerXml, inj.headerSplices)
  }
  headerXml = appendBorderFills(headerXml, ctx.borders.added())
  if (ctx.centered.size) {
    let added = ""
    for (const [from, to] of [...ctx.centered].sort((a, b) => Number(a[1]) - Number(b[1]))) {
      const m = new RegExp(`<hh:paraPr\\b[^>]{0,4096}?\\bid="${from}"`).exec(headerXml)
      const close = m ? headerXml.indexOf("</hh:paraPr>", m.index) : -1
      if (!m || close < 0) continue
      added += headerXml.slice(m.index, close + "</hh:paraPr>".length)
        .replace(/\bid="\d+"/, `id="${to}"`).replace(/(<hh:align\b[^>]{0,512}?\bhorizontal=")DISTRIBUTE(?:_SPACE)?"/, "$1CENTER\"")
    }
    const end = headerXml.indexOf("</hh:paraProperties>")
    if (added && end >= 0) {
      const n = (added.match(/<hh:paraPr\b/g) ?? []).length
      headerXml = headerXml.slice(0, end) + added + headerXml.slice(end)
      headerXml = headerXml.replace(/(<hh:paraProperties\b[^>]{0,1024}?\bitemCnt=")(\d+)"/, (_, a: string, c: string) => `${a}${Number(c) + n}"`)
    }
  }
  return headerXml
}

/**
 * 마크다운 + 견본 HWPX → HWPX. markdownToHwpx({ template }) 의 구현.
 */
export async function markdownToHwpxFromTemplate(markdown: string, template: Uint8Array | ArrayBuffer, warnings: string[] = [], totalRow?: TotalRowPosition): Promise<ArrayBuffer> {
  const tz = await loadTemplateZip(template)
  const { sectionXml, headerXml, sections } = tz
  const scan = scanTemplate(sectionXml, headerXml)

  const pasted = cleanPastedMarkdown(markdown)
  if (pasted.removed > 0) warnings.push(`붙여넣기 흔적 ${pasted.removed}개 정리 (보이지 않는 글자·인용 표시·이스케이프된 굵게)`)
  const { md, defs } = extractFootnoteDefs(pasted.md)
  if (defs.size) warnings.push(`template: 각주 ${defs.size}개는 견본 모드에서 넣지 않습니다`)
  const parsed = parseMarkdownToBlocks(md).map(polishGongmunBlock)
  const imageOnly = parsed.filter((b) => b.type === "paragraph" && /^!\[[^\]]*\]\([^)]*\)$/.test((b.text ?? "").trim()))
  if (imageOnly.length) warnings.push(`template: 그림 ${imageOnly.length}개는 견본 모드에서 넣지 않습니다`)
  const inlineImages = parsed.filter((b) => !imageOnly.includes(b) && /!\[[^\]]*\]\([^)]*\)/.test(b.text ?? "")).length
  if (inlineImages) warnings.push(`template: 글 줄 안 그림 ${inlineImages}개는 대체 글(alt)로 넣었습니다`)
  const { blocks, contact, sub } = takeHeadLines(parsed.filter((b) => !imageOnly.includes(b)))

  const maxId = (re: RegExp) => maxOf([...headerXml.matchAll(re)].map((m) => Number(m[1])))
  const fallbackBfId = maxId(/<hh:borderFill\b[^>]{0,4096}?\bid="(\d{1,10})"/g) + 1
  // 테두리 변형은 견본 표 원형이 있을 때만 생기고, 그때는 대체 테두리(fallbackBf)를 쓰지 않는다 — 같은 번호부터 잇는다
  let nextBf = fallbackBfId
  const ctx: EmitCtx = {
    scan, headerXml, warnings,
    fallbackBf: { id: fallbackBfId, used: false },
    borders: createBorderVariants(headerXml, () => nextBf++),
    centered: new Map(), nextParaPr: maxId(/<hh:paraPr\b[^>]{0,4096}?\bid="(\d{1,10})"/g) + 1,
    missing: new Set(), notes: new Set(),
    // 합계 행은 맨 위가 공문 관행 — 견본은 머리행·본문행 서식(칸 좌표 서식이 아님)이라 프로필과 달리 옮겨도 된다
    totalRow: resolveTotalRow(totalRow, false),
  }
  beginInlineDoc(new Map())
  let paras: string[]
  try {
    paras = emitBody(ctx, blocks, { contact, sub })
  } finally {
    endInlineDoc()
  }
  if (!paras.length) paras.push(defaultPara(""))
  if (ctx.missing.size) warnings.push(`template: 견본에 ${[...ctx.missing].join("·")} 서식이 없어 가까운 서식으로 대신했습니다`)
  warnings.push(...ctx.notes)

  // 구역 정의·쪽 컨트롤은 첫 문단 첫 run 에 한 번만
  const first = elementAt(paras[0], 0)!
  paras[0] = paras[0].slice(0, first.openEnd) + `<hp:run charPrIDRef="${scan.headCharPr}">${scan.head}</hp:run>` + paras[0].slice(first.openEnd)

  // 개체 id·instid·zOrder 새로 매기기 — 견본 본문·머리말·꼬리말·바탕쪽 개체와 겹치지 않게 견본 최댓값 다음부터
  const objIds = [sectionXml, ...tz.masterXmls].flatMap((xml) => [...xml.matchAll(OBJ_TAG_RE)])
    .flatMap((m) => [/\bid="(\d{1,10})"/.exec(m[0])?.[1], /\binstid="(\d{1,10})"/.exec(m[0])?.[1]]).map((v) => Number(v ?? 0))
  let nextId = 1 + maxOf(objIds)
  let z = 1 + maxOf([...scan.head.matchAll(OBJ_TAG_RE)].map((m) => Number(/\bzOrder="(\d{1,10})"/.exec(m[0])?.[1] ?? -1)), -1)
  const body = paras.join("").replace(OBJ_TAG_RE, (tag) => tag
    .replace(/\bid="\d*"/, () => `id="${nextId++}"`)
    .replace(/\binstid="\d*"/, () => `instid="${nextId++}"`)
    .replace(/\bzOrder="-?\d+"/, () => `zOrder="${z++}"`))
  if (body.length > MAX_OUTPUT) throw new KordocError(`생성 본문이 너무 큽니다 (${(body.length / 1048576).toFixed(1)}MB) — 원고를 나눠 만드세요`)
  const tops = topLevelParagraphs(sectionXml)
  const newSection = sectionXml.slice(0, tops[0]?.start ?? sectionXml.lastIndexOf("</")) + body + sectionXml.slice(tops.at(-1)?.end ?? sectionXml.lastIndexOf("</"))

  let newHeader = appendHeader(ctx)
  if (sections.length > 1) {
    warnings.push(`template: 견본의 구역 ${sections.length}개 중 첫 구역 서식만 씁니다`)
    newHeader = newHeader.replace(/(<(?:\w+:)?head\b[^>]{0,4096}?\bsecCnt=")\d+"/, (_, open: string) => `${open}1"`)
  }
  const title = blocks.find((b) => b.type === "heading" && (b.level ?? 1) === 1)?.text ?? null
  return packTemplateZip(tz, { newSection, headerXml: newHeader, title: title && plainInline(title), prvText: buildPrvText(blocks) })
}
