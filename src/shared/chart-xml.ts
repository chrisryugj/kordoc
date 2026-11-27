/**
 * DrawingML 차트(c:chartSpace)와 SmartArt 데이터(dgm:dataModel) 읽기: PPTX·DOCX·XLSX·HWPX 공통.
 *
 * 차트는 계열 값 캐시(c:strCache·c:numCache)를 표로 옮긴다: 첫 열이 항목(c:cat, 분산형은 x 값), 그 뒤가 계열(c:tx 이름).
 * 캡션은 「차트: 제목 (종류)」. 종전에는 네 형식 모두 차트 글을 버렸다(PPTX 는 UNSUPPORTED_ELEMENT 경고만).
 * SmartArt 는 데이터 파트의 노드 글(dgm:pt 의 dgm:t)을 연결(dgm:cxn parOf)대로 중첩 목록으로 옮긴다.
 */
import { DOMParser } from "../xml/dom.js"
import { localName, elementChildren, findChildByLocalName, childrenByLocalName } from "./xml.js"
import { buildTable } from "../table/builder.js"
import { stripDtd } from "../utils.js"
import type { IRBlock } from "../types.js"

export interface ChartData {
  title?: string
  kinds: string[]
  categories: string[]
  series: Array<{ name: string; values: string[] }>
}

const KIND_LABEL: Record<string, string> = {
  barChart: "막대형", bar3DChart: "3차원 막대형", lineChart: "꺾은선형", line3DChart: "3차원 꺾은선형",
  pieChart: "원형", pie3DChart: "3차원 원형", ofPieChart: "원형", doughnutChart: "도넛형",
  areaChart: "영역형", area3DChart: "3차원 영역형", scatterChart: "분산형", radarChart: "방사형",
  bubbleChart: "거품형", stockChart: "주식형", surfaceChart: "표면형", surface3DChart: "3차원 표면형",
}

const parse = (xml: string): Document | null => {
  try {
    return new DOMParser().parseFromString(stripDtd(xml), "text/xml")
  } catch {
    return null
  }
}

/** 하위에서 이름이 name 인 첫 요소(깊이 우선) */
function findDeep(el: Element, name: string): Element | null {
  for (const c of elementChildren(el)) {
    if (localName(c) === name) return c
    const hit = findDeep(c, name)
    if (hit) return hit
  }
  return null
}
const textOf = (el: Element | null): string => (el?.textContent ?? "").replace(/\s+/g, " ").trim()

/** 값 캐시(c:strCache·c:numCache·c:multiLvlStrCache) → idx 자리 값. 다단 항목은 단을 「 / 」로 잇는다 */
function cacheValues(ref: Element | null): string[] {
  if (!ref) return []
  const direct = findChildByLocalName(ref, "v")
  if (direct && !findDeep(ref, "pt")) return [textOf(direct)]
  const levels = childrenByLocalName(findDeep(ref, "multiLvlStrCache") ?? ref, "lvl")
  const groups = levels.length ? levels : [findDeep(ref, "strCache") ?? findDeep(ref, "numCache") ?? findDeep(ref, "strLit") ?? findDeep(ref, "numLit") ?? ref]
  const count = Math.max(0, ...groups.map(g => Number(findChildByLocalName(g, "ptCount")?.getAttribute("val") ?? 0)))
  const cols: string[][] = groups.map(g => {
    const out: string[] = []
    for (const pt of childrenByLocalName(g, "pt")) out[Number(pt.getAttribute("idx") ?? out.length)] = fmtNum(textOf(findChildByLocalName(pt, "v")))
    return out
  })
  const n = Math.max(count, ...cols.map(c => c.length))
  // 다단 항목: 첫 lvl 이 가장 안쪽 단이다. 바깥 단 이름은 그 묶음의 첫 칸에만 있어 앞 값을 이어 쓴다
  const filled = cols.map(c => { let last = ""; return Array.from({ length: n }, (_, i) => (c[i] ? (last = c[i]) : levels.length ? last : "")) })
  return Array.from({ length: n }, (_, i) => filled.slice().reverse().map(c => c[i]).filter(Boolean).join(" / "))
}

/** 0.52000000000000002 같은 부동소수 꼬리를 12자리로 정리. 숫자가 아니면 그대로 */
function fmtNum(v: string): string {
  if (!/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(v)) return v
  const n = Number(v)
  return Number.isFinite(n) ? String(Number(n.toPrecision(12))) : v
}

/** c:chartSpace XML → 제목·종류·항목·계열. 계열이 없으면 null */
export function parseChartXml(xml: string): ChartData | null {
  const doc = parse(xml)
  const chart = doc?.documentElement ? findDeep(doc.documentElement, "chart") : null
  if (!chart) return null
  const titleEl = findChildByLocalName(chart, "title")
  let title = titleEl ? [...titleEl.getElementsByTagName("*")].filter(e => localName(e) === "t" || localName(e) === "v").map(textOf).join("").trim() : ""
  const plot = findChildByLocalName(chart, "plotArea")
  if (!plot) return null
  const kinds: string[] = []
  let categories: string[] = []
  const series: Array<ChartData["series"][number] & { named: boolean }> = []
  for (const group of elementChildren(plot)) {
    const kind = localName(group)
    if (!/Chart$/.test(kind)) continue
    const barDir = findChildByLocalName(group, "barDir")?.getAttribute("val")
    kinds.push(kind === "barChart" || kind === "bar3DChart" ? `${barDir === "bar" ? "가로" : "세로"} ${KIND_LABEL[kind]}` : KIND_LABEL[kind] ?? kind)
    for (const ser of childrenByLocalName(group, "ser")) {
      const scatter = kind === "scatterChart" || kind === "bubbleChart"
      const cat = cacheValues(findChildByLocalName(ser, scatter ? "xVal" : "cat"))
      const values = cacheValues(findChildByLocalName(ser, scatter ? "yVal" : "val"))
      if (cat.length > categories.length) categories = cat
      // c:tx 는 c:strRef(c:f 수식 + 캐시) 또는 c:v 다. textContent 로 읽으면 수식 「Sheet1!$B$1」까지 붙는다
      const name = cacheValues(findChildByLocalName(ser, "tx")).filter(Boolean).join(" ")
      series.push({ name: name || `계열 ${series.length + 1}`, values, named: !!name })
    }
  }
  if (!series.length) return null
  // 글 없는 c:title 은 자동 제목이다: 계열이 하나면 그 계열 이름을 제목으로 그린다
  if (!title && titleEl && !findChildByLocalName(titleEl, "tx") && series.length === 1 && series[0].named) title = series[0].name
  return { title: title || undefined, kinds: [...new Set(kinds)], categories, series: series.map(({ name, values }) => ({ name, values })) }
}

/** 차트 → 캡션 달린 표 블록. 항목이 없으면 1, 2, 3 … */
export function chartBlock(c: ChartData, pageNumber?: number): IRBlock {
  const n = Math.max(c.categories.length, ...c.series.map(s => s.values.length))
  const head = [{ text: "항목", colSpan: 1, rowSpan: 1 }, ...c.series.map(s => ({ text: s.name, colSpan: 1, rowSpan: 1 }))]
  // 항목도 값도 없는 자리(캐시의 빈 pt)는 뺀다
  const rows = Array.from({ length: n }, (_, i) => i)
    .filter(i => c.categories[i] || c.series.some(s => s.values[i]))
    .map(i => [
      { text: c.categories[i] || String(i + 1), colSpan: 1, rowSpan: 1 },
      ...c.series.map(s => ({ text: s.values[i] ?? "", colSpan: 1, rowSpan: 1 })),
    ])
  const table = buildTable([head, ...rows])
  table.caption = `차트${c.title ? `: ${c.title}` : ""}${c.kinds.length ? ` (${c.kinds.join("·")})` : ""}`
  return { type: "table", table, ...(pageNumber ? { pageNumber } : {}) }
}

/** SmartArt 데이터 파트(dgm:dataModel) → 중첩 목록 블록들. 글 있는 노드가 없으면 빈 배열 */
export function smartArtBlocks(xml: string, pageNumber?: number): IRBlock[] {
  const doc = parse(xml)
  const root = doc?.documentElement
  if (!root) return []
  const ptList = findDeep(root, "ptLst")
  const pts = ptList ? childrenByLocalName(ptList, "pt") : []
  const text = new Map<string, string>()
  let docId = ""
  for (const pt of pts) {
    const type = pt.getAttribute("type") ?? "node"
    const id = pt.getAttribute("modelId") ?? ""
    if (type === "doc") docId = id
    if (type !== "node" && type !== "asst") continue
    const t = findChildByLocalName(pt, "t")
    const body = t ? childrenByLocalName(t, "p").map(textOf).filter(Boolean).join(" ") : ""
    if (body) text.set(id, body)
  }
  const kids = new Map<string, Array<{ id: string; ord: number }>>()
  const cxnList = findDeep(root, "cxnLst")
  for (const cxn of cxnList ? childrenByLocalName(cxnList, "cxn") : []) {
    if ((cxn.getAttribute("type") ?? "parOf") !== "parOf") continue
    const src = cxn.getAttribute("srcId") ?? ""
    kids.set(src, [...(kids.get(src) ?? []), { id: cxn.getAttribute("destId") ?? "", ord: Number(cxn.getAttribute("srcOrd") ?? 0) }])
  }
  const seen = new Set<string>()
  const build = (id: string, depth: number): IRBlock[] => {
    if (depth > 20) return []
    const out: IRBlock[] = []
    for (const k of (kids.get(id) ?? []).sort((a, b) => a.ord - b.ord)) {
      if (seen.has(k.id)) continue
      seen.add(k.id)
      const children = build(k.id, depth + 1)
      const t = text.get(k.id)
      if (t) out.push({ type: "list", text: t, listType: "unordered", ...(children.length ? { children } : {}), ...(pageNumber ? { pageNumber } : {}) })
      else out.push(...children)
    }
    return out
  }
  const tree = docId ? build(docId, 0) : []
  // 연결이 없거나 끊긴 노드는 나온 차례대로 덧붙인다
  for (const [id, t] of text) if (!seen.has(id)) tree.push({ type: "list", text: t, listType: "unordered", ...(pageNumber ? { pageNumber } : {}) })
  return tree
}
