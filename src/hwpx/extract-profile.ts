/**
 * 서식 프로필 추출 (hwpx → FormatProfile) — 이슈 #41 / PR #42 Part B.
 *
 * 원본 hwpx에서 표의 borderFill(테두리·음영)·열너비·셀 글꼴을 읽어
 * FormatProfile JSON으로 뽑는다. 이 프로필을 `markdownToHwpx(md, { profile })`에
 * 넘기면 원본 없이 같은 시각 서식을 재현한다(진짜 라운드트립).
 *
 * render 경로(head-styles/svg-render)는 mm→pt·font→family 손실 변환이라
 * 프로필 충실 추출엔 부적합. 여기서는 header/section XML을 원문 그대로 읽는
 * 얇은 전용 파서를 쓴다.
 */

import JSZip from "jszip"
import { createXmlParser, findChildByLocalName } from "./parser-shared.js"
import { toArrayBuffer } from "../utils.js"
import { normalizeAnchor } from "./gen-profile.js"
import type { FormatProfile, TableProfile, CellProfile, BorderFillDef, BorderDef, CharPrDef } from "./gen-profile.js"

/** localName(접두사 제거)으로 자손 요소 전부 — 문서 순서 보존 */
function elemsByLocal(root: Element | Document, name: string): Element[] {
  const all = root.getElementsByTagName("*")
  const out: Element[] = []
  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element
    const tag = (el.tagName || el.localName || "").replace(/^[^:]+:/, "")
    if (tag === name) out.push(el)
  }
  return out
}

function borderDefOf(el: Element | null): BorderDef | undefined {
  if (!el) return undefined
  const type = el.getAttribute("type") || "NONE"
  const width = el.getAttribute("width") || "0.1 mm"
  const color = el.getAttribute("color") || "#000000"
  return { type, width, color }
}

/** header.xml → borderFill id → 정의 (원문 그대로) */
function parseBorderFills(headerDoc: Document): Map<string, BorderFillDef> {
  const map = new Map<string, BorderFillDef>()
  for (const bf of elemsByLocal(headerDoc, "borderFill")) {
    const id = bf.getAttribute("id")
    if (!id) continue
    const def: BorderFillDef = {
      leftBorder: borderDefOf(findChildByLocalName(bf, "leftBorder")),
      rightBorder: borderDefOf(findChildByLocalName(bf, "rightBorder")),
      topBorder: borderDefOf(findChildByLocalName(bf, "topBorder")),
      bottomBorder: borderDefOf(findChildByLocalName(bf, "bottomBorder")),
    }
    const fillBrush = findChildByLocalName(bf, "fillBrush")
    const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null
    const face = winBrush?.getAttribute("faceColor")
    if (face && face !== "none") def.fill = { faceColor: face }
    map.set(id, def)
  }
  return map
}

/** header.xml → charPr id → 정의 */
function parseCharPrs(headerDoc: Document): Map<string, CharPrDef> {
  const map = new Map<string, CharPrDef>()
  for (const cp of elemsByLocal(headerDoc, "charPr")) {
    const id = cp.getAttribute("id")
    if (!id) continue
    const def: CharPrDef = {}
    const h = cp.getAttribute("height")
    if (h) def.height_hwpunit = h
    const color = cp.getAttribute("textColor")
    if (color) def.textColor = color
    if (cp.getAttribute("bold") === "1") def.bold = true
    if (cp.getAttribute("italic") === "1") def.italic = true
    if (findChildByLocalName(cp, "underline")) def.underline = true
    const fontRef = findChildByLocalName(cp, "fontRef")
    const hangul = fontRef?.getAttribute("hangul")
    if (hangul) def.fontRef_hangul = hangul
    map.set(id, def)
  }
  return map
}

/** tbl 조상에 다른 tbl이 있으면 중첩표 — top-level만 문서 표로 센다(generate tableSeq와 정합) */
function isTopLevelTable(tbl: Element): boolean {
  let p = tbl.parentNode as Element | null
  while (p) {
    const tag = ((p as Element).tagName || (p as Element).localName || "").replace(/^[^:]+:/, "")
    if (tag === "tbl") return false
    p = p.parentNode as Element | null
  }
  return true
}

function num(s: string | null | undefined): number | undefined {
  if (s == null) return undefined
  const n = parseInt(s, 10)
  return Number.isFinite(n) ? n : undefined
}

/** 한 <hp:tbl> → TableProfile. 셀이 참조하는 borderFill/charPr만 used_*에 담는다. */
function parseTable(
  tbl: Element,
  tableIndex: number,
  borderFills: Map<string, BorderFillDef>,
  charPrs: Map<string, CharPrDef>,
): TableProfile {
  const rows = num(tbl.getAttribute("rowCnt")) ?? 0
  const cols = num(tbl.getAttribute("colCnt")) ?? 0
  const sz = findChildByLocalName(tbl, "sz")
  const width = sz?.getAttribute("width") || undefined

  const cells: CellProfile[] = []
  const usedBf = new Set<string>()
  const usedCp = new Set<string>()
  // 첫 행 셀 폭으로 col_widths 근사 (span-1 셀만)
  const colWidths: (string | undefined)[] = new Array(cols).fill(undefined)

  let anchorText = ""

  for (const tc of elemsByLocal(tbl, "tc")) {
    // 중첩표 셀 제외 — 이 tbl 직속 tc만
    if (nearestTable(tc) !== tbl) continue
    const addr = findChildByLocalName(tc, "cellAddr")
    const span = findChildByLocalName(tc, "cellSpan")
    const csz = findChildByLocalName(tc, "cellSz")
    const row = num(addr?.getAttribute("rowAddr")) ?? 0
    const col = num(addr?.getAttribute("colAddr")) ?? 0
    if (row === 0 && col === 0 && !anchorText) anchorText = directCellText(tc)
    const colSpan = num(span?.getAttribute("colSpan")) ?? 1
    const rowSpan = num(span?.getAttribute("rowSpan")) ?? 1
    const bfId = tc.getAttribute("borderFillIDRef") || undefined
    const cpId = firstRunCharPr(tc)

    const cell: CellProfile = { row, col, rowSpan, colSpan }
    const w = csz?.getAttribute("width")
    const hh = csz?.getAttribute("height")
    if (w) cell.width_hwpunit = w
    if (hh) cell.height_hwpunit = hh
    if (bfId) { cell.borderFillIDRef = bfId; usedBf.add(bfId) }
    if (cpId) { cell.charPrIDRef = cpId; usedCp.add(cpId) }
    cells.push(cell)

    if (row === 0 && colSpan === 1 && col < cols && w) colWidths[col] = w
  }

  const table: TableProfile = {
    table_index: tableIndex,
    rows, cols,
    cells,
    used_border_fills: pick(borderFills, usedBf),
  }
  const anchor = normalizeAnchor(anchorText)
  if (anchor) table.anchor_text = anchor
  if (width) table.width_hwpunit = width
  if (colWidths.every(w => w != null)) table.col_widths_hwpunit = colWidths as string[]
  const cp = pick(charPrs, usedCp)
  if (Object.keys(cp).length) table.used_char_prs = cp
  return table
}

/** tc를 감싸는 가장 가까운 tbl (중첩 구분용) */
function nearestTable(tc: Element): Element | null {
  let p = tc.parentNode as Element | null
  while (p) {
    const tag = ((p as Element).tagName || (p as Element).localName || "").replace(/^[^:]+:/, "")
    if (tag === "tbl") return p
    p = p.parentNode as Element | null
  }
  return null
}

/** 셀 내부(중첩표 제외) 첫 run의 charPrIDRef */
function firstRunCharPr(tc: Element): string | undefined {
  for (const run of elemsByLocal(tc, "run")) {
    // 중첩표 안 run 건너뛰기 — run의 조상 tc가 이 tc여야
    if (nearestCell(run) !== tc) continue
    const id = run.getAttribute("charPrIDRef")
    if (id) return id
  }
  return undefined
}

function nearestCell(el: Element): Element | null {
  let p = el.parentNode as Element | null
  while (p) {
    const tag = ((p as Element).tagName || (p as Element).localName || "").replace(/^[^:]+:/, "")
    if (tag === "tc") return p
    p = p.parentNode as Element | null
  }
  return null
}

/** 셀 직속(중첩표 제외) hp:t 텍스트 연결 — anchor_text 원료 */
function directCellText(tc: Element): string {
  let out = ""
  for (const t of elemsByLocal(tc, "t")) {
    if (nearestCell(t) !== tc) continue
    out += t.textContent ?? ""
    if (out.length >= 64) break // 정규화 후 24자 절단 — 원료도 적당히서 끊는다
  }
  return out
}

function pick<T>(map: Map<string, T>, keys: Set<string>): Record<string, T> {
  const out: Record<string, T> = {}
  for (const k of keys) {
    const v = map.get(k)
    if (v !== undefined) out[k] = v
  }
  return out
}

/**
 * hwpx → FormatProfile. 문서 내 top-level 표를 등장 순서대로 추출한다.
 * @param input hwpx ArrayBuffer 또는 Buffer
 */
export async function hwpxToProfile(input: ArrayBuffer | Buffer): Promise<FormatProfile> {
  const buf = input instanceof ArrayBuffer ? input : toArrayBuffer(input)
  const zip = await JSZip.loadAsync(buf)
  const parser = createXmlParser()

  const headerFile = zip.file("Contents/header.xml") ?? zip.file(/[Hh]eader\.xml$/)?.[0]
  let headerXml = "<root/>"
  if (headerFile) headerXml = await headerFile.async("text")
  const headerDoc = parser.parseFromString(headerXml, "text/xml") as unknown as Document
  const borderFills = parseBorderFills(headerDoc)
  const charPrs = parseCharPrs(headerDoc)

  // section*.xml 을 번호 순서로
  const sectionFiles = zip.file(/[Ss]ection\d+\.xml$/)
    .sort((a, b) => (num(a.name.match(/(\d+)\.xml$/)?.[1] ?? null) ?? 0) - (num(b.name.match(/(\d+)\.xml$/)?.[1] ?? null) ?? 0))

  const tables: TableProfile[] = []
  let tableIndex = 0
  for (const f of sectionFiles) {
    const doc = parser.parseFromString(await f.async("text"), "text/xml") as unknown as Document
    for (const tbl of elemsByLocal(doc, "tbl")) {
      if (!isTopLevelTable(tbl)) continue
      tables.push(parseTable(tbl, tableIndex++, borderFills, charPrs))
    }
  }

  return { schema_version: "0.2.0", tables }
}
