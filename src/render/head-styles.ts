/**
 * 레이아웃 보존 렌더 — header.xml 스타일 테이블 (charPr/paraPr/borderFill).
 * 파서 IR과 무관하게 렌더에 필요한 속성만 추출한다.
 */

import { createXmlParser, findChildByLocalName } from "../hwpx/parser-shared.js"

/** 언어 칸(영문·한자·일어·기호) 하나의 글꼴·장평·자간·상대크기 */
export interface RenderLangStyle { face?: string; ratio: number; spacing: number; rel: number; hft?: boolean }

export interface RenderCharStyle {
  /** 글자 크기 (1/100pt — 1000 = 10pt) */
  height: number
  bold: boolean
  italic: boolean
  underline: boolean
  /** #RRGGBB — 검정이면 undefined */
  color?: string
  /** 장평 % */
  ratio: number
  /** 자간 % */
  spacing: number
  /** CSS font-family 스택 — charPr fontRef(hangul)에서 해석. 없으면 root 기본 폴백 */
  fontFamily?: string
  /** HWP 원본 글꼴명 (fontfaces face) — reflow 폭 테이블 선택용 */
  face?: string
  /** 한글 상대크기 % (relSz hangul) — reflow 폭. 100 이면 생략 */
  rel?: number
  /** 영문 글자(한컴 언어 분류 '영문')의 글꼴·장평·자간·상대크기 — reflow 폭. 한글과 같으면 생략 */
  latin?: { face?: string; ratio: number; spacing: number; rel: number; hft?: boolean }
  /** 한자·일어·기호 글자(한컴 언어 분류)의 글꼴·장평·자간·상대크기 — reflow 폭. 한글과 같으면 생략 */
  hanja?: RenderLangStyle
  japanese?: RenderLangStyle
  symbol?: RenderLangStyle
  /** 한글 글꼴 항목이 한컴 HFT 글꼴(fontface font type="HFT") — 같은 이름의 TTF 와 조판이 다를 수 있다 */
  hft?: boolean
  /** 빈칸을 글꼴의 빈칸 폭으로 잰다(charPr useFontSpace="1") — 아니면 반각 */
  fontSpace?: boolean
  /** 위/아래 첨자 — 한컴은 글자 폭을 크기 16/25 로 잰다 */
  script?: "sup" | "sub"
  /** 글자 음영(charPr shadeColor) #RRGGBB — 없음·흰색은 생략 */
  shade?: string
  /** 글자 테두리·배경(charPr borderFillIDRef) — 테두리 위·아래 굵기만큼 줄이 높아진다 */
  borderFill?: string
  /** 한글 2024 이전 판으로 저장된 문서(version.xml appVersion 13 미만) — 조판 규칙 일부가 2024 와 다르다 */
  before2024?: boolean
  /** 큰따옴표 “ ” 를 반각으로 재는 새 빌드 저장본(한글 2022 4605·2024 3901 이상, hwpxQuoteHalf) */
  halfQuote?: boolean
}

export type ParaAlign = "JUSTIFY" | "LEFT" | "RIGHT" | "CENTER" | "DISTRIBUTE" | "DISTRIBUTE_SPACE"

/** reflow(Tier-2)용 문단 기하 — 줄간격·여백. paraPr `<hh:margin>`·`<hh:lineSpacing>`은
 *  `<hp:switch>/<hp:case>` 안(손자)이라 재귀 탐색으로 뽑는다. 단위 HWPUNIT. */
export interface RenderParaGeom {
  /** PERCENT(기본 160=160%) / FIXED / BETWEEN_LINES / AT_LEAST */
  lineSpacingType: string
  lineSpacingValue: number
  /** 왼쪽 들여쓰기(HWPUNIT) */
  marginLeft: number
  marginRight: number
  /** 첫 줄 들여쓰기/내어쓰기 — 음수=둘째 줄부터 더 들어감(hanging) */
  marginIntent: number
  /** 문단 위 간격(prev) */
  spaceBefore: number
  /** 문단 아래 간격(next) */
  spaceAfter: number
  /** breakSetting의 한글 줄나눔 — 'keep'(어절)/'charAll'(글자). 없으면 호출자 모드.
   *  주의: 저장 속성 의미는 이름과 반대 — breakNonLatinWord "BREAK_WORD"=어절,
   *  "KEEP_WORD"=글자 (한글 COM 실렌더 실측) */
  wrapMode?: "keep" | "charAll"
  /** 탭 정의(tabPrIDRef)가 내어쓰기용 자동 탭(autoTabLeft) — 첫 줄 탭이 내어쓰기 위치에 선다 */
  autoTabLeft?: boolean
  /** 공백 최소값(paraPr condense, %) — 줄 안 공백이 그만큼 줄어들 수 있어 줄 가용폭이 공백 폭 합 × condense% 늘어난다 */
  condense?: number
  /** 영문 단어를 글자 단위로 끊는다(breakLatinWord="BREAK_WORD" — 한글 설정과 달리 이름 그대로. 한컴 저장본 좁은 칸 "Unit P|rice") */
  latinBreak?: boolean
  /** 한 줄로 입력(breakSetting lineWrap="SQUEEZE") — 글이 넘쳐도 줄을 바꾸지 않는다(명시적 줄 나눔만) */
  squeeze?: boolean
  /** 외톨이줄 보호(breakSetting widowOrphan) — 쪽 끝에 첫 줄만 남기거나 다음 쪽에 마지막 줄만 넘기지 않는다 */
  widowOrphan?: boolean
  /** 문단 보호(keepLines) — 쪽에 걸치면 문단째 다음 쪽으로 / 다음 문단과 함께(keepWithNext) / 문단 앞에서 쪽 나눔(pageBreakBefore) */
  keepLines?: boolean
  keepWithNext?: boolean
  pageBreakBefore?: boolean
  /** 문단 세로 정렬(align vertical) — 줄 기준선: BASELINE 은 높이의 85%, CENTER 는 50%(한컴 저장 lineseg 실측) */
  vertAlign?: string
  /** 글꼴에 어울리는 줄 높이(paraPr fontLineHeight="1") — 글이 있는 줄의 높이·기준선을 글꼴의 위·아래 높이로 정한다 */
  fontLineHeight?: boolean
  /** 글머리표(heading BULLET) — 첫 줄 앞에 글머리표 글자와 간격(textOffset)이 놓인다. autoIndent 면 둘째 줄부터도 그만큼 들어간다.
   *  lineseg horzpos·horzsize 는 바뀌지 않는다(한컴 저장 lineseg 실측: ◦ 1100 + 50% → 1650 만큼 좁게 채움) */
  bullet?: { ch: string; charPrId?: string; offset: number; offsetPct: boolean; autoIndent: boolean; useInstWidth?: boolean }
  /** 문단 번호(heading NUMBER) — 번호 정의 id·수준(1부터)과 그 수준의 머리 형식(`^1.` 의 ^N 자리에 N 수준 번호). 앞머리 폭은 글머리표와 같다 */
  number?: { id: string; level: number; heads: Map<number, NumberHead>; charPrId?: string; offset: number; offsetPct: boolean; autoIndent: boolean }
}

/** 번호 정의 한 수준(hh:paraHead) */
export interface NumberHead { text: string; format: string; start: number }

export const DEFAULT_PARA_GEOM: RenderParaGeom = {
  lineSpacingType: "PERCENT", lineSpacingValue: 160,
  marginLeft: 0, marginRight: 0, marginIntent: 0, spaceBefore: 0, spaceAfter: 0,
}

export interface RenderBorderEdge {
  /** SOLID/DASH/DOT… — NONE은 edge 자체를 생략 */
  type: string
  /** pt 단위 굵기 */
  widthPt: number
  color: string
}

export interface RenderBorderFill {
  left?: RenderBorderEdge
  right?: RenderBorderEdge
  top?: RenderBorderEdge
  bottom?: RenderBorderEdge
  /** 배경색 #RRGGBB (없으면 undefined) */
  fill?: string
}

export interface RenderStyles {
  charPr: Map<string, RenderCharStyle>
  paraAlign: Map<string, ParaAlign>
  /** reflow용 문단 기하 (줄간격·여백) — id별 */
  paraGeom: Map<string, RenderParaGeom>
  borderFill: Map<string, RenderBorderFill>
  /** "쪽 번호"(Page Number) 스타일의 글자 모양 id — 한컴은 쪽 번호를 이 글꼴로 찍는다 */
  pageNumCharPr?: string
  /** 한글 2024 이전 판으로 저장된 문서 — 판을 모르면(생성 문서 등) 2024 규칙 */
  before2024?: boolean
  /** 한글 2024 초기 빌드(3622 미만) 저장본 — 번호·글머리표 문단도 공백 압축(condense)으로 채운다 */
  early2024?: boolean
}

/** kordoc 이 쓴 version.xml — appVersion 이 kordoc 판(4.x)이라 한글 판 번호가 아니다. 한글 판을 모르는 문서로(2024 규칙) */
const madeByKordoc = (versionXml: string | null | undefined) => !!versionXml && /\bapplication="kordoc"/.test(versionXml)

/** version.xml 의 저장 빌드(appVersion 넷째 수). 없거나 못 읽으면 undefined */
export function hwpxAppBuild(versionXml: string | null | undefined): number | undefined {
  if (madeByKordoc(versionXml)) return undefined
  const m = versionXml?.match(/appVersion="\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*(\d+)/)
  return m ? Number(m[1]) : undefined
}

/** version.xml 의 저장 판 번호(appVersion 첫 수 — 12 = 한글 2022, 13 = 2024). 없거나 못 읽으면 undefined */
export function hwpxAppMajor(versionXml: string | null | undefined): number | undefined {
  if (madeByKordoc(versionXml)) return undefined
  const m = versionXml?.match(/appVersion="\s*(\d+)/)
  return m ? Number(m[1]) : undefined
}

/** 문서에서 온 색 값 — #RRGGBB 만 통과(나머지는 fallback). SVG 속성에 그대로 들어가므로 url(…) 같은 임의 값을 막는다 */
export function docColor(v: string | null | undefined, fallback?: string): string | undefined {
  return v != null && /^#[0-9A-Fa-f]{6}$/.test(v) ? v : fallback
}

export const DEFAULT_CHAR: RenderCharStyle = { height: 1000, bold: false, italic: false, underline: false, ratio: 100, spacing: 0 }

// ─── 글꼴 매핑 (HWP fontfaces face → CSS font-family 스택) ──────────────
//
// HWPX charPr 는 <hh:fontRef hangul="N">으로 fontfaces 테이블의 실제 글꼴명을 가리킨다.
// 렌더는 이 글꼴명을 SVG <text font-family>로 내보내 뷰어(WebView2/브라우저)가 원본과
// 같은 글꼴로 그리게 한다. 미설치 글꼴은 계열(명조=serif / 고딕=sans) 폴백으로 수렴시켜
// 최소한 획 계열(바탕↔돋움)은 원본과 일치시킨다 — 공문서 제목 고딕이 바탕체로 나오던 회귀 해소.

/** 자주 쓰는 글꼴의 별칭 스택 (한글명↔영문 시스템명 병기 — 뷰어 OS별 등록명 차이 흡수) */
const FONT_ALIASES: Record<string, string> = {
  "함초롬바탕": "'HCR Batang','함초롬바탕','한컴바탕'",
  "한컴바탕": "'HCR Batang','함초롬바탕','한컴바탕'",
  "함초롬돋움": "'HCR Dotum','함초롬돋움','한컴돋움'",
  "한컴돋움": "'HCR Dotum','함초롬돋움','한컴돋움'",
  "맑은 고딕": "'Malgun Gothic','맑은 고딕'",
  "맑은고딕": "'Malgun Gothic','맑은 고딕'",
  "굴림": "'Gulim','굴림'",
  "굴림체": "'GulimChe','굴림체','Gulim'",
  "돋움": "'Dotum','돋움'",
  "돋움체": "'DotumChe','돋움체','Dotum'",
  "바탕": "'Batang','바탕'",
  "바탕체": "'BatangChe','바탕체','Batang'",
  "궁서": "'Gungsuh','궁서'",
  "궁서체": "'GungsuhChe','궁서체','Gungsuh'",
  "나눔고딕": "'NanumGothic','나눔고딕'",
  "나눔명조": "'NanumMyeongjo','나눔명조'",
  "맑은 고딕 Semilight": "'Malgun Gothic Semilight','맑은 고딕'",
}

/** 명조/바탕 계열(serif) 여부 — 아니면 고딕/돋움(sans)으로 본다 */
function isSerifFace(face: string): boolean {
  return /바탕|명조|Batang|Myeong|Mincho|궁서|Gungsuh|Serif|신명|순명|Song|송/i.test(face)
}

/** CSS font-family 토큰 인용 — 영숫자·하이픈만이면 무인용, 그 외(공백·한글)는 작은따옴표 */
function cssQuote(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : `'${name.replace(/['"\\]/g, "")}'`
}

/**
 * HWP 글꼴명 → CSS font-family 스택. 정확한 글꼴 먼저, 이어서 계열 폴백(명조=serif /
 * 고딕=sans, 각 한국어 렌더 가능 글꼴 포함)을 붙여 미설치 시에도 획 계열을 보존한다.
 */
export function hwpFaceToCssStack(face: string | null | undefined): string {
  const trimmed = (face ?? "").trim()
  if (!trimmed) return ""
  const generic = isSerifFace(trimmed)
    ? "'HCR Batang','Batang','Noto Serif KR',serif"
    : "'Malgun Gothic','HCR Dotum','Noto Sans KR',sans-serif"
  const head = FONT_ALIASES[trimmed] ?? cssQuote(trimmed)
  return `${head},${generic}`
}

/** fontfaces 테이블에서 HANGUL 그룹의 font id → 글꼴명 맵 (없으면 첫 그룹) */
function collectHangulFonts(root: Element, lang = "HANGUL", hftIds?: Set<string>, substKoPub = false): Map<string, string> {
  const map = new Map<string, string>()
  const findFaces = (el: Element, depth: number): Element | null => {
    if (depth > 24) return null
    for (const ch of Array.from(el.childNodes)) {
      if (ch.nodeType !== 1) continue
      const e = ch as Element
      if ((e.tagName || "").replace(/^[^:]+:/, "") === "fontfaces") return e
      const f = findFaces(e, depth + 1)
      if (f) return f
    }
    return null
  }
  const faces = findFaces(root, 0)
  if (!faces) return map
  let group: Element | null = null
  let firstGroup: Element | null = null
  for (const ch of Array.from(faces.childNodes)) {
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "fontface") continue
    if (!firstGroup) firstGroup = e
    if ((e.getAttribute("lang") ?? "").toUpperCase() === lang) { group = e; break }
  }
  group = group ?? firstGroup
  if (!group) return map
  for (const ch of Array.from(group.childNodes)) {
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") !== "font") continue
    const id = e.getAttribute("id")
    let face = e.getAttribute("face")
    let type = e.getAttribute("type")
    // 한양 글꼴은 HFT 로만 있다 — 글꼴 항목이 TTF 면 한컴은 그 이름의 TTF 를 못 찾아 대체 글꼴(substFont)로 조판한다
    // (한컴 저장 lineseg: 한양중고딕 TTF → HY중고딕·한컴바탕 등. 두 줄 이상 문단 줄 시작 +53)
    // KoPub 글꼴이 없는 PC 에서 작성·인쇄한 문서는 대체 글꼴로 조판됐다 — 렌더가 저장 줄 나눔으로 판정해 substKoPub 를 켠다(kopubSubstituted)
    if (face && type === "TTF" && (/^한양/.test(face) || (substKoPub && /^KoPub/.test(face)))) {
      const sub = Array.from(e.childNodes).find(c => c.nodeType === 1 && ((c as Element).tagName || "").replace(/^[^:]+:/, "") === "substFont") as Element | undefined
      const sf = sub?.getAttribute("face")
      if (sf) { face = sf; type = sub!.getAttribute("type") }
    }
    if (id != null && face) map.set(id, face)
    if (id != null && hftIds && type === "HFT") hftIds.add(id)
  }
  return map
}

/** "0.12 mm" / "0.5 mm" → pt */
function borderWidthPt(v: string | null | undefined): number {
  const n = parseFloat(v ?? "")
  if (!Number.isFinite(n)) return 0.34
  return n * 2.834645 // mm → pt
}

function parseEdge(el: Element | null): RenderBorderEdge | undefined {
  if (!el) return undefined
  const type = el.getAttribute("type") ?? "NONE"
  if (type === "NONE") return undefined
  return { type, widthPt: borderWidthPt(el.getAttribute("width")), color: docColor(el.getAttribute("color"), "#000000")! }
}

/** 서브트리에서 localName이 일치하는 첫 요소를 재귀 탐색 (switch/case 래핑 대응) */
function findDeep(el: Element, name: string, depth = 0): Element | null {
  if (depth > 32) return null
  const children = el.childNodes
  if (!children) return null
  for (let i = 0; i < children.length; i++) {
    const ch = children[i]
    if (ch.nodeType !== 1) continue
    const e = ch as Element
    if ((e.tagName || "").replace(/^[^:]+:/, "") === name) return e
    const found = findDeep(e, name, depth + 1)
    if (found) return found
  }
  return null
}

/** paraPr 요소 → 문단 기하 (margin·lineSpacing은 hp:switch/case 안이라 재귀 탐색) */
function parseParaGeom(el: Element, oldUnit = false): RenderParaGeom {
  const g: RenderParaGeom = { ...DEFAULT_PARA_GEOM }
  const condense = Number(el.getAttribute("condense")) || 0
  if (condense > 0) g.condense = condense
  if (el.getAttribute("fontLineHeight") === "1") g.fontLineHeight = true
  const ls = findDeep(el, "lineSpacing")
  if (ls) {
    g.lineSpacingType = ls.getAttribute("type") ?? "PERCENT"
    // 0% 도 저장값 그대로(줄 간격 몫 = −글자 높이) — `|| 160` 이면 0 이 160% 로 바뀐다
    const lv = Number(ls.getAttribute("value"))
    g.lineSpacingValue = Number.isFinite(lv) && ls.getAttribute("value") !== null ? lv : 160
  }
  const margin = findDeep(el, "margin")
  if (margin) {
    // head version 1.4 미만 문서에서 hp:switch 밖에 바로 놓인 margin 은 옛 단위(HWPUNIT 의 2배) — 한컴은 절반으로 조판한다
    // (한컴 저장 lineseg: 1.2·1.3 문서의 그런 문단 첫 줄 horzpos = left/2 가 262개 중 243개. hp:case 안·1.4 이상(생성기 포함)은 값 그대로)
    const plain = oldUnit && ((margin.parentNode as Element | null)?.tagName ?? "").replace(/^[^:]+:/, "") === "paraPr"
    const v = (n: string): number => {
      const c = findDeep(margin, n)
      // unit="CHAR" 값은 5배가 HWPUNIT 이다(한컴 저장 lineseg: 왼쪽 400 → horzpos 2000, 100 → 500, 위 간격 53 → 첫 줄 265 — 글자 크기 1000~1200 모두)
      const x = c ? (Number(c.getAttribute("value")) || 0) * (c.getAttribute("unit") === "CHAR" ? 5 : 1) : 0
      return plain ? Math.trunc(x / 2) : x
    }
    g.marginLeft = v("left")
    g.marginRight = v("right")
    g.marginIntent = v("intent")
    g.spaceBefore = v("prev")
    g.spaceAfter = v("next")
  }
  const va = findDeep(el, "align")?.getAttribute("vertical")
  if (va && va !== "BASELINE") g.vertAlign = va
  const bs = findDeep(el, "breakSetting")
  if (bs) {
    // 속성 의미 역전 주의(위 RenderParaGeom.wrapMode 주석): BREAK_WORD=어절, KEEP_WORD=글자
    if (bs.getAttribute("breakLatinWord") === "BREAK_WORD") g.latinBreak = true
    if (bs.getAttribute("lineWrap") === "SQUEEZE") g.squeeze = true
    if (bs.getAttribute("widowOrphan") === "1") g.widowOrphan = true
    if (bs.getAttribute("keepLines") === "1") g.keepLines = true
    if (bs.getAttribute("keepWithNext") === "1") g.keepWithNext = true
    if (bs.getAttribute("pageBreakBefore") === "1") g.pageBreakBefore = true
    const nl = bs.getAttribute("breakNonLatinWord")
    if (nl === "BREAK_WORD") g.wrapMode = "keep"
    else if (nl === "KEEP_WORD") g.wrapMode = "charAll"
  }
  return g
}

/** header.xml(구버전 head.xml) → 렌더용 스타일 맵. appMajor = 저장 판(hwpxAppMajor) */
export function parseRenderStyles(headXml: string, opts?: { appMajor?: number; appBuild?: number; substKoPub?: boolean }): RenderStyles {
  const before2024 = opts?.appMajor !== undefined && opts.appMajor > 0 && opts.appMajor < 13
  // 새 빌드는 휴먼명조 “ ” 를 반각으로 잰다 — 한컴 저장본: 2024 3901·2022 4605 문단은 반각이라야 줄 나눔이 맞고, 2024 3050·2022 4426 이하는 전각
  const major = opts?.appMajor ?? 0, build = opts?.appBuild ?? 0
  const halfQuote = (major === 12 && build >= 4605) || (major === 13 && build >= 3901) || major > 13
  // 2024 초기 빌드는 번호·글머리표 문단도 공백을 압축해 채운다 — 한컴 저장본: 2024 3050 글머리표 부제(압축 50%)가 공백을 줄여 한 줄,
  // 3622·3901 저장본은 압축 없이 채워야 줄 나눔이 맞다(그 사이 빌드는 표본 없음)
  const early2024 = major === 13 && build > 0 && build < 3622
  const styles: RenderStyles = { charPr: new Map(), paraAlign: new Map(), paraGeom: new Map(), borderFill: new Map(), ...(before2024 ? { before2024 } : {}), ...(early2024 ? { early2024 } : {}) }
  const doc = createXmlParser().parseFromString(headXml, "text/xml")
  const root = doc.documentElement as unknown as Element | null
  if (!root) return styles

  const hv = Number.parseFloat(root.getAttribute("version") ?? "")
  const oldUnit = Number.isFinite(hv) && hv < 1.4
  // fontfaces(HANGUL) 선파싱 — charPr fontRef 해석에 쓴다
  const hftHangul = new Set<string>(), hftLatin = new Set<string>()
  const sk = !!opts?.substKoPub
  const hangulFonts = collectHangulFonts(root, "HANGUL", hftHangul, sk)
  const latinFonts = collectHangulFonts(root, "LATIN", hftLatin, sk)
  const hftHanja = new Set<string>(), hftJapanese = new Set<string>(), hftSymbol = new Set<string>()
  const langFonts = { hanja: [collectHangulFonts(root, "HANJA", hftHanja, sk), hftHanja], japanese: [collectHangulFonts(root, "JAPANESE", hftJapanese, sk), hftJapanese], symbol: [collectHangulFonts(root, "SYMBOL", hftSymbol, sk), hftSymbol] } as const
  // 탭 정의 — 문단의 tabPrIDRef 는 워크가 끝난 뒤 해석(순서 무관)
  const autoTabPr = new Set<string>()
  const paraTabRef = new Map<string, string>()
  const paraBullet = new Map<string, string>()
  const bullets = new Map<string, NonNullable<RenderParaGeom["bullet"]>>()
  const paraNumber = new Map<string, { id: string; level: number }>()
  /** 번호 정의 id → 수준 → { 머리, 앞머리 속성 } */
  const numberings = new Map<string, Map<number, { head: NumberHead; charPrId?: string; offset: number; offsetPct: boolean; autoIndent: boolean }>>()

  const walk = (el: Element): void => {
    const tag = (el.tagName || "").replace(/^[^:]+:/, "")
    if (tag === "charPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const ratioEl = findChildByLocalName(el, "ratio")
        const spacingEl = findChildByLocalName(el, "spacing")
        const underlineEl = findChildByLocalName(el, "underline")
        const textColor = el.getAttribute("textColor")
        const shadeColor = el.getAttribute("shadeColor")
        const fontRef = findChildByLocalName(el, "fontRef")
        const fontId = fontRef?.getAttribute("hangul") ?? fontRef?.getAttribute("latin")
        const face = fontId != null ? hangulFonts.get(fontId) : undefined
        const relEl = findChildByLocalName(el, "relSz")
        const num = (e: Element | null, a: string, d: number): number => { const v = e?.getAttribute(a); return v == null || v === "" ? d : Number(v) }
        const latinFace = latinFonts.get(fontRef?.getAttribute("latin") ?? "")
        const latinHft = hftLatin.has(fontRef?.getAttribute("latin") ?? "")
        const latin = { face: latinFace ?? face, ratio: num(ratioEl, "latin", 100), spacing: num(spacingEl, "latin", 0), rel: num(relEl, "latin", 100), ...(latinHft ? { hft: true } : {}) }
        const rel = num(relEl, "hangul", 100)
        const hangulRatio = Number(ratioEl?.getAttribute("hangul")) || 100, hangulSpacing = Number(spacingEl?.getAttribute("hangul")) || 0, hangulHft = hftHangul.has(fontRef?.getAttribute("hangul") ?? "")
        // 한자·일어·기호 칸 — 한글 칸과 다를 때만(글꼴 칸이 목록에 없으면 한글 칸 글꼴)
        const langs: Partial<Record<"hanja" | "japanese" | "symbol", RenderLangStyle>> = {}
        for (const lang of ["hanja", "japanese", "symbol"] as const) {
          const ref = fontRef?.getAttribute(lang) ?? "", [fonts, hfts] = langFonts[lang]
          const ls: RenderLangStyle = { face: fonts.get(ref) ?? face, ratio: num(ratioEl, lang, 100), spacing: num(spacingEl, lang, 0), rel: num(relEl, lang, 100), ...((fonts.has(ref) ? hfts.has(ref) : hangulHft) ? { hft: true } : {}) }
          if (ls.face !== face || ls.ratio !== hangulRatio || ls.spacing !== hangulSpacing || ls.rel !== rel || !!ls.hft !== hangulHft) langs[lang] = ls
        }
        styles.charPr.set(id, {
          height: Number(el.getAttribute("height")) || 1000,
          bold: findChildByLocalName(el, "bold") != null,
          italic: findChildByLocalName(el, "italic") != null,
          underline: underlineEl != null && (underlineEl.getAttribute("type") ?? "NONE") !== "NONE",
          color: textColor !== "#000000" ? docColor(textColor) : undefined,
          ratio: Number(ratioEl?.getAttribute("hangul")) || 100,
          spacing: Number(spacingEl?.getAttribute("hangul")) || 0,
          fontFamily: face ? hwpFaceToCssStack(face) : undefined,
          face,
          ...(rel !== 100 ? { rel } : {}),
          // 흰 음영은 흰 바탕에서 보이지 않고 색 칸 위에서만 흰 상자가 된다 — 확인 전이라 그리지 않는다
          ...(shadeColor && /^#[0-9A-Fa-f]{6}$/.test(shadeColor) && shadeColor.toUpperCase() !== "#FFFFFF" ? { shade: shadeColor } : {}),
          ...(el.getAttribute("borderFillIDRef") ? { borderFill: el.getAttribute("borderFillIDRef")! } : {}),
          ...(hftHangul.has(fontRef?.getAttribute("hangul") ?? "") ? { hft: true } : {}),
          ...(latin.face !== face || latin.ratio !== (Number(ratioEl?.getAttribute("hangul")) || 100) || latin.spacing !== (Number(spacingEl?.getAttribute("hangul")) || 0) || latin.rel !== rel ? { latin } : {}),
          ...langs,
          ...(el.getAttribute("useFontSpace") === "1" ? { fontSpace: true } : {}),
          ...(findChildByLocalName(el, "supscript") ? { script: "sup" as const } : findChildByLocalName(el, "subscript") ? { script: "sub" as const } : {}),
        })
      }
    } else if (tag === "tabPr") {
      const id = el.getAttribute("id")
      if (id != null && el.getAttribute("autoTabLeft") === "1") autoTabPr.add(id)
    } else if (tag === "paraPr") {
      const id = el.getAttribute("id")
      if (id != null) {
        const align = findChildByLocalName(el, "align")
        styles.paraAlign.set(id, (align?.getAttribute("horizontal") as ParaAlign) || "JUSTIFY")
        styles.paraGeom.set(id, parseParaGeom(el, oldUnit))
        const tab = el.getAttribute("tabPrIDRef")
        if (tab != null) paraTabRef.set(id, tab)
        const heading = findDeep(el, "heading")
        if (heading?.getAttribute("type") === "BULLET") paraBullet.set(id, heading.getAttribute("idRef") ?? "")
        else if (heading?.getAttribute("type") === "NUMBER") paraNumber.set(id, { id: heading.getAttribute("idRef") ?? "", level: (Number(heading.getAttribute("level")) || 0) + 1 })
      }
    } else if (tag === "bullet") {
      const id = el.getAttribute("id"), head = findChildByLocalName(el, "paraHead")
      if (id != null && el.getAttribute("useImage") !== "1") {
        const cpr = head?.getAttribute("charPrIDRef")
        bullets.set(id, {
          ch: el.getAttribute("char") ?? "",
          ...(cpr != null && cpr !== "4294967295" ? { charPrId: cpr } : {}),
          offset: Number(head?.getAttribute("textOffset")) || 0,
          offsetPct: (head?.getAttribute("textOffsetType") ?? "PERCENT") === "PERCENT",
          autoIndent: head?.getAttribute("autoIndent") !== "0",
          ...(head?.hasAttribute("useInstWidth") ? { useInstWidth: head.getAttribute("useInstWidth") !== "0" } : {}),
        })
      }
    } else if (tag === "numbering") {
      const id = el.getAttribute("id")
      if (id != null) {
        const levels = new Map<number, { head: NumberHead; charPrId?: string; offset: number; offsetPct: boolean; autoIndent: boolean }>()
        for (let i = 0; i < el.childNodes.length; i++) {
          const h = el.childNodes[i] as Element
          if (h.nodeType !== 1 || (h.tagName || "").replace(/^[^:]+:/, "") !== "paraHead") continue
          const cpr = h.getAttribute("charPrIDRef")
          levels.set(Number(h.getAttribute("level")) || 1, {
            head: { text: h.textContent ?? "", format: h.getAttribute("numFormat") ?? "DIGIT", start: Number(h.getAttribute("start") ?? 1) },
            ...(cpr != null && cpr !== "4294967295" ? { charPrId: cpr } : {}),
            offset: Number(h.getAttribute("textOffset")) || 0,
            offsetPct: (h.getAttribute("textOffsetType") ?? "PERCENT") === "PERCENT",
            autoIndent: h.getAttribute("autoIndent") !== "0",
          })
        }
        numberings.set(id, levels)
      }
    } else if (tag === "borderFill") {
      const id = el.getAttribute("id")
      if (id != null) {
        const bf: RenderBorderFill = {
          left: parseEdge(findChildByLocalName(el, "leftBorder")),
          right: parseEdge(findChildByLocalName(el, "rightBorder")),
          top: parseEdge(findChildByLocalName(el, "topBorder")),
          bottom: parseEdge(findChildByLocalName(el, "bottomBorder")),
        }
        const fillBrush = findChildByLocalName(el, "fillBrush")
        const winBrush = fillBrush ? findChildByLocalName(fillBrush, "winBrush") : null
        const face = winBrush?.getAttribute("faceColor")
        const fill = docColor(face)
        if (fill) bf.fill = fill
        styles.borderFill.set(id, bf)
      }
    }
    if (tag === "style" && (el.getAttribute("engName") === "Page Number" || el.getAttribute("name") === "쪽 번호")) {
      const cp = el.getAttribute("charPrIDRef")
      if (cp != null && styles.pageNumCharPr == null) styles.pageNumCharPr = cp
    }
    const children = el.childNodes
    for (let i = 0; i < children.length; i++) {
      const ch = children[i]
      if (ch.nodeType === 1) walk(ch as Element)
    }
  }
  walk(root)
  for (const [id, tab] of paraTabRef) {
    const g = styles.paraGeom.get(id)
    if (g && autoTabPr.has(tab)) g.autoTabLeft = true
  }
  for (const [id, n] of paraNumber) {
    const g = styles.paraGeom.get(id), levels = numberings.get(n.id), lv = levels?.get(n.level)
    if (g && levels && lv) g.number = { id: n.id, level: n.level, heads: new Map([...levels].map(([k, v]) => [k, v.head])), ...(lv.charPrId != null ? { charPrId: lv.charPrId } : {}), offset: lv.offset, offsetPct: lv.offsetPct, autoIndent: lv.autoIndent }
  }
  for (const [id, b] of paraBullet) {
    const g = styles.paraGeom.get(id), bu = bullets.get(b)
    if (g && bu?.ch) g.bullet = bu
  }
  if (before2024) for (const st of styles.charPr.values()) st.before2024 = true
  if (halfQuote) for (const st of styles.charPr.values()) st.halfQuote = true
  return styles
}
