/**
 * PDF 보고서 모양 재기 — 공개 보고서 PDF 에서 쪽 여백·본문 줄간격·글머리 단계(□ ㅇ - ※)의 글꼴·크기·들여쓰기·장 머리 번호칸 색을 잰다.
 * layoutToGongmun 이 이 값을 공문서 생성 옵션(margins·lineSpacing·levels·fonts.ref·bandColor·bullet2)으로 바꾼다.
 *
 * 잴 수 없는 것: 굵기(한컴 PDF 는 굵은 글자를 획을 덧그려 만들어 글꼴 이름에 남지 않는다 — 프리셋 값을 쓴다), 글자색,
 * 이름 없는 글꼴(Type3·「TTD…」). 한글 이름 글꼴은 엔진이 CP949 이름을 UTF-8 로 풀어 깨진 꼴로 오므로 알려진 이름의 깨진 꼴과 맞춰 되찾는다.
 */

import { openHayro } from "./hayro.js"
import { hayroTextPage, hayroFontInfo, EV, eventLength } from "./hayro-text.js"
import { hayroOps, hayroFontData } from "./hayro-ops.js"
import { restoreUnmappedGlyphs, spaceMappedDots } from "./symbol-glyphs.js"
import { restoreNamedGlyphs } from "./glyph-names.js"

// ─── 쪽 표본 ─────────────────────────────────────

export interface LayoutTextItem { str: string; x: number; y: number; w: number; size: number; font: string | null; pdfFont: string }
export interface LayoutFill { color: string; x1: number; y1: number; x2: number; y2: number }
/** 한 쪽 — 좌표는 쪽 왼쪽 아래 기준 pt, y 는 기준선 */
export interface LayoutPageSample { width: number; height: number; items: LayoutTextItem[]; fills: LayoutFill[] }

export interface PdfLayoutLevel {
  /** 공문서 단계(0 □, 1 ㅇ·○, 2 -, 3 ㆍ) */
  depth: number
  marker: string
  /** 한컴 글꼴 이름(못 찾으면 null — 프리셋 글꼴을 쓴다) */
  font: string | null
  pdfFont: string
  pt: number
  /** 쪽 왼쪽 끝에서 부호·글 시작까지(mm) */
  markerMm: number
  textMm: number
  lines: number
}

export interface PdfLayoutSpec {
  pageCount: number
  /** 글머리 줄이 있어 잰 쪽(1부터) */
  measuredPages: number[]
  page: { widthMm: number; heightMm: number }
  /** 글이 놓인 범위로 잰 쪽 가장자리 여백(mm) — 머리말·꼬리말 영역을 포함한다 */
  edges: { top: number; bottom: number; left: number; right: number } | null
  /** 줄이 꺾인 글머리 문단의 줄 간격(글자 크기 대비 %) — 단계별 중앙값의 최빈 */
  lineSpacing: number | null
  levels: PdfLayoutLevel[]
  /** ※ 참고 */
  ref: { font: string | null; pdfFont: string; pt: number } | null
  /** 로마 숫자 장 번호칸 채움색 */
  chapterFill: string | null
  warnings: string[]
}

const mm = (pt: number) => Math.round((pt / 72) * 25.4 * 2) / 2
const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : NaN }
function mode<T>(xs: T[]): T | undefined {
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return [...m].sort((a, b) => b[1] - a[1])[0]?.[0]
}
/** 한컴 PDF 글자 크기는 15.943 처럼 떨어진다 — 0.5pt 눈금에 맞춘다 */
const snapPt = (v: number) => Math.round(v * 2) / 2

// ─── 글꼴 이름 ─────────────────────────────────────

/** 한컴이 PDF 에 적는 영문 글꼴 이름 → 한컴 글꼴 이름 */
const PDF_FONT_FACES: Record<string, string> = {
  H2hdrM: "HY헤드라인M", H2gtrE: "HY견고딕", H2gtrM: "HY중고딕", H2mjrE: "HY견명조", H2mjsM: "HY신명조", H2gsrB: "HY그래픽",
  "Haansoft Batang": "한컴바탕", "Haansoft Dotum": "한컴돋움", HCRBatang: "함초롬바탕", HCRDotum: "함초롬돋움",
  HaanYGodic23: "한컴 윤고딕 230", HaanYGodic24: "한컴 윤고딕 240", HaanYGodic25: "한컴 윤고딕 250",
  MalgunGothic: "맑은 고딕", Batang: "바탕", Dotum: "돋움", Gulim: "굴림", GulimChe: "굴림체", Gungsuh: "궁서",
  HYwulM: "HY울릉도M", HanSantteutDotum: "한컴 산뜻돋움",
  "NanumGothic": "나눔고딕", "NanumMyeongjo": "나눔명조",
}
/** 한글 이름으로만 실리는 한컴 글꼴 — CP949 이름이 깨진 꼴로 와서 이 목록과 맞춘다 */
const KOREAN_FACES = ["휴먼명조", "휴먼고딕", "휴먼옛체", "한양신명조", "한양중고딕", "한양견명조", "한양견고딕", "신명 신명조", "신명 중고딕", "양재튼튼체B", "HY울릉도M", "한컴돋움", "한컴바탕", "맑은 고딕", "바탕", "굴림", "돋움", "궁서"]

let cp949: Map<string, number[]> | null = null
/** 글자 → CP949 바이트 (euc-kr 풀기 표를 뒤집는다, 처음 쓸 때 한 번) */
function cp949Bytes(text: string): number[] | null {
  if (!cp949) {
    cp949 = new Map()
    const dec = new TextDecoder("euc-kr")
    for (let a = 0x81; a <= 0xfe; a++) for (let b = 0x41; b <= 0xfe; b++) {
      const ch = dec.decode(new Uint8Array([a, b]))
      if (ch.length === 1 && ch !== "�" && !cp949.has(ch)) cp949.set(ch, [a, b])
    }
  }
  const out: number[] = []
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c < 0x80) { out.push(c); continue }
    const b = cp949.get(ch)
    if (!b) return null
    out.push(...b)
  }
  return out
}
let mangled: Map<string, string> | null = null

/** PDF 글꼴 이름(BaseFont) → 한컴 글꼴 이름. 부분집합 접두(ABCDEF+)·굵기 접미는 뗀다. 모르면 null */
export function pdfFontFace(base: string): string | null {
  const name = base.replace(/^[A-Z]{6}\+/, "").replace(/,(Bold|Italic|BoldItalic)$/, "").replace(/-?(Bold|Regular)$/, "")
  if (PDF_FONT_FACES[name]) return PDF_FONT_FACES[name]
  if (/[가-힣]/.test(name)) return name
  if (name.includes("�")) {
    if (!mangled) {
      mangled = new Map()
      const dec = new TextDecoder("utf-8")
      for (const face of KOREAN_FACES) { const b = cp949Bytes(face); if (b) mangled.set(dec.decode(new Uint8Array(b)), face) }
    }
    return mangled.get(name) ?? null
  }
  return null
}

// ─── PDF → 쪽 표본 ───────────────────────────────

/** PDF 의 쪽마다 글 조각(글머리표 글리프 복원 포함)·채움 사각형을 읽는다 */
export async function samplePdfLayout(buf: Uint8Array | ArrayBuffer, maxPages = 40): Promise<LayoutPageSample[]> {
  const doc = await openHayro(buf instanceof Uint8Array ? buf : new Uint8Array(buf))
  try {
    const fontObjs = new Map<string, { name?: string; data?: Uint8Array; differences?: string[] } | null>()
    const fontObj = (key: string) => {
      if (!key.startsWith("hy_")) return undefined
      if (!fontObjs.has(key)) {
        try {
          const info = hayroFontInfo(doc, key)
          const differences: string[] = []
          if (info) for (const [c, n] of info.differences) differences[c] = n
          fontObjs.set(key, info ? { name: info.name, differences, data: hayroFontData(doc.fontFile(key)) } : null)
        } catch { fontObjs.set(key, null) }
      }
      return fontObjs.get(key)
    }
    const pages: LayoutPageSample[] = []
    const n = Math.min(doc.pageCount(), maxPages)
    for (let p = 1; p <= n; p++) {
      const view = doc.pageView(p - 1)
      const page = hayroTextPage(doc, p)
      const items = page.items
      const ops = hayroOps(page.events, page.strings)
      restoreNamedGlyphs(items, ops.fnArray, ops.argsArray, (k) => fontObj(k)?.differences, (k) => fontObj(k)?.name)
      restoreUnmappedGlyphs(items, ops.fnArray, ops.argsArray, (k) => fontObj(k))
      items.push(...spaceMappedDots(ops.fnArray, ops.argsArray, (k) => fontObj(k)))
      const texts: LayoutTextItem[] = []
      for (const it of items) {
        if (!it.str.trim()) continue
        const t = it.transform
        const base = (page.fontNames.get(it.fontName ?? "") ?? fontObj(it.fontName ?? "")?.name ?? "").replace(/^[A-Z]{6}\+/, "")
        texts.push({ str: it.str, x: t[4] - view[0], y: t[5] - view[1], w: it.width, size: Math.hypot(t[2], t[3]), font: pdfFontFace(base), pdfFont: base })
      }
      pages.push({ width: view[2] - view[0], height: view[3] - view[1], items: texts, fills: pageFills(page.events, view) })
    }
    return pages
  } finally { doc.close() }
}

/** 채움 경로(사각형 위주)의 색·외곽 — 흰색·아주 얇은 괘선은 뺀다 */
function pageFills(ev: ArrayLike<number>, view: number[]): LayoutFill[] {
  const out: LayoutFill[] = []
  for (let i = 0; i < ev.length; i += eventLength(ev, i)) {
    if (ev[i] !== EV.PATH) continue
    const code = ev[i + 1], r = ev[i + 2], g = ev[i + 3], b = ev[i + 4]
    if (code === 3 || code === 6 || r < 0) continue // 긋기만·무늬
    const t = [ev[i + 7], ev[i + 8], ev[i + 9], ev[i + 10], ev[i + 11], ev[i + 12]]
    const at = i + 13, cnt = ev[at]
    const pts: number[] = []
    if (cnt === -1) { const x = ev[at + 1], y = ev[at + 2], w = ev[at + 3], h = ev[at + 4]; pts.push(x, y, x + w, y + h) }
    else {
      let k = at + 1
      for (let s = 0; s < cnt; s++) {
        const op = ev[k++]
        const take = op === 0 || op === 1 || op === 5 ? 2 : op === 2 ? 4 : op === 3 ? 6 : 0
        for (let q = 0; q < take; q++) pts.push(ev[k++])
      }
    }
    if (pts.length < 4) continue
    const xs: number[] = [], ys: number[] = []
    for (let q = 0; q + 1 < pts.length; q += 2) { xs.push(t[0] * pts[q] + t[2] * pts[q + 1] + t[4]); ys.push(t[1] * pts[q] + t[3] * pts[q + 1] + t[5]) }
    const fill = { color: "#" + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("").toUpperCase(),
      x1: Math.min(...xs) - view[0], y1: Math.min(...ys) - view[1], x2: Math.max(...xs) - view[0], y2: Math.max(...ys) - view[1] }
    if (fill.color === "#FFFFFF" || fill.x2 - fill.x1 < 1.6 || fill.y2 - fill.y1 < 1.6) continue
    out.push(fill)
  }
  return out
}

// ─── 쪽 표본 → 모양 ──────────────────────────────

/** 글머리 부호 → 공문서 단계(□ 0 / ㅇ·○ 1 / - 2 / ㆍ·▸ 3, ※·* 참고 -1) */
const MARKER_DEPTH: Record<string, number> = { "□": 0, "■": 0, "◻": 0, "ㅇ": 1, "○": 1, "◦": 1, "❍": 1, "-": 2, "–": 2, "―": 2, "ㆍ": 3, "·": 3, "▸": 3, "※": -1, "*": -1 }

interface Line { y: number; size: number; items: LayoutTextItem[] }

function pageLines(items: LayoutTextItem[]): Line[] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Line[] = []
  for (const it of sorted) {
    const l = lines[lines.length - 1]
    if (l && Math.abs(l.y - it.y) <= Math.max(1.5, it.size * 0.15)) { l.items.push(it); l.size = Math.max(l.size, it.size) }
    else lines.push({ y: it.y, size: it.size, items: [it] })
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x)
  return lines
}

/** 줄 머리 글머리 — 첫 글자가 부호이고 그 뒤에 글이 띄어(또는 다른 조각으로) 이어질 때 */
function lineMarker(l: Line): { marker: string; depth: number; markerX: number; text: LayoutTextItem } | null {
  const first = l.items[0]
  const s = first.str.trimStart()
  const mk = [...s][0]
  if (!mk || !(mk in MARKER_DEPTH)) return null
  const rest = s.slice(mk.length)
  if (rest.trim()) {
    // 한 조각 안 "□ 제목" — 부호 뒤가 공백이어야 글머리(「-1」 같은 음수는 아니다)
    if (!/^\s/.test(rest)) return null
    return { marker: mk, depth: MARKER_DEPTH[mk], markerX: first.x, text: { ...first, x: first.x + (first.w * (s.length - rest.trimStart().length)) / Math.max(1, s.length) } }
  }
  const text = l.items[1]
  if (!text) return null
  return { marker: mk, depth: MARKER_DEPTH[mk], markerX: first.x, text }
}

/** 쪽 번호·머리 표시처럼 짧은 가운데 줄 */
function isFolio(l: Line, pageW: number): boolean {
  const s = l.items.map((i) => i.str).join("").replace(/\s+/g, "")
  if (!/^[-–]?\d{1,3}[-–]?$/.test(s)) return false
  const x1 = l.items[0].x, x2 = l.items[l.items.length - 1].x + l.items[l.items.length - 1].w
  return Math.abs((x1 + x2) / 2 - pageW / 2) < pageW * 0.15
}

export function measureLayoutFromPages(pages: LayoutPageSample[]): PdfLayoutSpec {
  const warnings: string[] = []
  type Hit = { page: number; depth: number; marker: string; markerX: number; textX: number; size: number; font: string | null; pdfFont: string; next?: Line; line: Line }
  const hits: Hit[] = []
  const measured: number[] = []
  const edges = { top: [] as number[], bottom: [] as number[], left: [] as number[], right: [] as number[] }
  pages.forEach((pg, idx) => {
    const lines = pageLines(pg.items).filter((l) => !isFolio(l, pg.width))
    const own: Hit[] = []
    // 본문 왼쪽 끝 — 이보다 30mm 넘게 오른쪽인 글머리는 표 칸 안 글(중앙부처 보고서 표 안 「-」「▸」 줄이 단계로 섞였다)
    const left = Math.min(...lines.map((l) => l.items[0].x))
    lines.forEach((l, k) => {
      const m = lineMarker(l)
      if (!m || m.markerX - left > 85) return
      own.push({ page: idx + 1, depth: m.depth, marker: m.marker, markerX: m.markerX, textX: m.text.x, size: m.text.size, font: m.text.font, pdfFont: m.text.pdfFont, next: lines[k + 1], line: l })
    })
    // 글머리 줄이 셋 이상인 쪽만 본문 쪽(표지·목차·별첨 서식은 뺀다)
    if (own.length < 3) return
    measured.push(idx + 1)
    hits.push(...own)
    edges.top.push(pg.height - Math.max(...lines.map((l) => l.y + l.size * 0.8)))
    edges.bottom.push(Math.min(...lines.map((l) => l.y - l.size * 0.2)))
    edges.left.push(Math.min(...lines.map((l) => l.items[0].x)))
    edges.right.push(pg.width - Math.max(...lines.map((l) => { const e = l.items[l.items.length - 1]; return e.x + e.w })))
  })
  const levels: PdfLayoutLevel[] = []
  const spacings: number[] = []
  for (const depth of [0, 1, 2, 3]) {
    const hs = hits.filter((h) => h.depth === depth)
    if (hs.length < 3) continue // 단계마다 3줄 이상(levels 추출과 같은 표본 하한)
    const pt = snapPt(median(hs.map((h) => h.size)))
    const font = mode(hs.map((h) => h.font).filter((f): f is string => !!f)) ?? null
    const pdfFont = mode(hs.map((h) => h.pdfFont)) ?? ""
    if (!font && pdfFont) warnings.push(`${mode(hs.map((h) => h.marker))} 단계 글꼴(PDF 이름 ${JSON.stringify(pdfFont)})을 알아보지 못해 프리셋 글꼴을 씁니다`)
    // 줄 간격 — 다음 줄이 부호 없이 글 시작 자리에서 이어지는 꺾인 줄
    const gaps = hs.filter((h) => h.next && !lineMarker(h.next) && Math.abs(h.next.items[0].x - h.textX) < 3 && Math.abs(h.next.size - h.size) < 0.6)
      .map((h) => ((h.line.y - h.next!.y) / h.size) * 100)
    if (gaps.length) spacings.push(Math.round(median(gaps) / 5) * 5)
    levels.push({ depth, marker: mode(hs.map((h) => h.marker))!, font, pdfFont, pt,
      markerMm: mm(median(hs.map((h) => h.markerX))), textMm: mm(median(hs.map((h) => h.textX))), lines: hs.length })
  }
  const refs = hits.filter((h) => h.depth === -1)
  const ref = refs.length >= 2 ? { font: mode(refs.map((h) => h.font).filter((f): f is string => !!f)) ?? null, pdfFont: mode(refs.map((h) => h.pdfFont)) ?? "", pt: snapPt(median(refs.map((h) => h.size))) } : null
  // 장 번호칸 — 로마 숫자 글자를 품은 작은 채움 사각형의 색
  const chapterColors: string[] = []
  pages.forEach((pg) => {
    for (const it of pg.items) {
      if (!/^\s*[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩ]\s*$/.test(it.str)) continue
      const box = pg.fills.find((f) => f.x1 <= it.x + 1 && it.x + it.w <= f.x2 + 1 && f.y1 <= it.y && it.y <= f.y2 && f.x2 - f.x1 < 80 && f.y2 - f.y1 < 60)
      if (box) chapterColors.push(box.color)
    }
  })
  if (!measured.length) warnings.push("글머리(□·ㅇ·-) 줄이 셋 이상인 쪽이 없어 단계·여백을 재지 못했습니다")
  const first = pages[0]
  return {
    pageCount: pages.length,
    measuredPages: measured,
    page: { widthMm: first ? mm(first.width) : 210, heightMm: first ? mm(first.height) : 297 },
    edges: measured.length ? { top: mm(median(edges.top)), bottom: mm(Math.min(...edges.bottom)), left: mm(median(edges.left)), right: mm(median(edges.right)) } : null,
    lineSpacing: mode(spacings) ?? null,
    levels,
    ref,
    chapterFill: mode(chapterColors) ?? null,
    warnings,
  }
}

/** PDF 를 재서 모양 명세로 */
export async function measurePdfLayout(buf: Uint8Array | ArrayBuffer): Promise<PdfLayoutSpec> {
  return measureLayoutFromPages(await samplePdfLayout(buf))
}

