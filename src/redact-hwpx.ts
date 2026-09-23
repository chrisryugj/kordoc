/**
 * HWPX 컨테이너 PII 수술 — ZIP 안 모든 글자 저장소를 같은 길이 글자 치환으로 가린다.
 *
 * 1) XML 문단(<hp:p>) — 본문·표·중첩표·글상자·머리말/꼬리말·각주/미주·캡션·메모. 문단의 <hp:t> 조각을
 *    파서처럼 이어 붙여(run 경계·필드·조판 제어·떠 있는 개체는 투명, 탭·줄바꿈·글자처럼 취급한 표·수식·
 *    각주 표지·변경 추적 표지는 공백) 탐지하므로 run 이 갈라 놓은 번호도 잡고, 지운 글자와 넣은 글자가
 *    붙어 번호가 안 보이는 일(변경 추적)도 없다. 가린 글자 자리만 splice (한 번호 안 이어진 글자는 splice
 *    하나, 엔트리마다 한 번에 적용) — run·charPr·탭은 그대로 (patchHwpx 의 문단 통째 재작성과 다름)
 * 2) 문단에 속하지 않은 텍스트 노드(주석으로 갈린 조각은 이어서)·주석·처리 지시·모든 속성값 — 필드 명령
 *    (하이퍼링크 mailto·누름틀 안내문), 개체 설명, content.hpf 메타데이터 등. 서식 데이터 연결 경로
 *    ("./DataArea/…@code.Name")·줄 배치 캐시 속성은 건너뛴다
 * 3) Preview/PrvText.txt(첫 쪽 텍스트 캐시)·Scripts(BOM 없는 UTF-16LE) 등 텍스트 엔트리 — 인코딩 보존
 * 4) Preview/PrvImage.*(첫 쪽 렌더 724×1024) — PII 를 가린 문서면 같은 크기 흰 이미지로 교체
 * 5) BinData — 그림 메타데이터(XMP·JPEG 주석·PNG 텍스트)는 가리고, SVG 는 XML 로, 삽입 OLE 개체(차트
 *    XML·삽입 문서·엑셀 포함)와 EMF 글자는 재검사에서 보고(가릴 수 없음 → 잔존), 화소는 미검사로 알린다
 * 글자를 바꾼 XML 은 linesegarray(줄 배치 캐시)를 지운다 — patchHwpx 와 같은 이유(한컴 변조 경고 방지).
 * 바꾼 엔트리만 교체하고 나머지 ZIP 엔트리는 원본 바이트 그대로 (patchZipEntries).
 */

import JSZip from "jszip"
import {
  scanSectionXml, findElementEnd, allLinesegRemovalSplices,
  type ScanParagraph, type ScanTable, type SpliceEdit,
} from "./roundtrip/source-map.js"
import { patchZipEntries } from "./roundtrip/zip-patch.js"
import {
  findPii, findLiterals, blankPreviewImage, isBindingPath, looksUtf16le, scrubImageMeta, scrubUtf16Runs,
  checkEmbeddedOle, isOleBin, isMetaImage, isEmf,
  type ScrubCtx, type ScrubResult, type RedactFileHit, type RedactWhere,
} from "./redact-scrub.js"
import { normalizeForDetect, type RedactHit } from "./redact.js"

type Pos = [number, number] | null

/** 글자별 XML 위치가 붙은 텍스트 — pos[i] = text[i] 가 나온 원문 범위(엔티티면 &…; 전체), 가상 공백은 null */
interface Mapped { text: string; pos: Pos[] }

/** 공백처럼 읽히는 인라인 요소 (파서도 공백으로 본다) */
const WS_TAGS = new Set(["tab", "lineBreak", "br", "fwSpace", "hwSpace", "nbSpace"])

/**
 * 문단 t 조각 사이에서 글자를 끊는 요소 — 파서가 공백·줄바꿈·표 경계·수식을 내는 요소와 변경 추적 표지
 * (지운 글과 넣은 글을 둘 다 가리므로 둘이 붙으면 안 된다). 그 밖(run 경계·필드·책갈피·쪽 번호 등 조판
 * 제어·그림·각주처럼 따로 흐르는 개체)은 파서처럼 투명 — 파서 본문과 같은 글자열을 봐야 본문에서 찾은
 * 값을 파일에서도 찾는다
 */
const GAP_SEPARATORS = new Set([...WS_TAGS, "deleteBegin", "deleteEnd", "insertBegin", "insertEnd"])

/**
 * 문단 흐름 밖 개체 — 속 글자(표 셀·글상자·각주 문단)는 따로 본다. 파서처럼 문단 글자를 끊지 않되,
 * 글자처럼 취급한 표(treatAsChar="1" — 파서가 경계 표지를 낸다)·수식(LaTeX 를 낸다)·각주/미주(번호
 * 표지 "1)" 을 낸다)는 끊는다
 */
const FLOW_OBJECTS = new Set([
  "tbl", "pic", "rect", "ellipse", "line", "arc", "polygon", "curve", "connectLine", "container", "ole", "chart",
  "textart", "video", "equation", "footNote", "endNote", "header", "footer", "hiddenComment", "memo", "memogroup",
])

/** <hp:t> 안에서 글자를 끊지 않는 요소 — 형광펜·소프트 하이픈·제목 차례 표시. 그 밖(변경 추적 등)은 구분자 */
const T_INNER_TRANSPARENT = new Set(["markpenBegin", "markpenEnd", "hyphen", "titleMark", "indexmark"])

const ENTITY_RE = /&(?:#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/y

function decodeEntity(ent: string): string {
  switch (ent) {
    case "&lt;": return "<"
    case "&gt;": return ">"
    case "&amp;": return "&"
    case "&quot;": return '"'
    case "&apos;": return "'"
  }
  const m = /^&#(x?)([0-9a-fA-F]+);$/.exec(ent)
  if (m) {
    const code = parseInt(m[2], m[1] ? 16 : 10)
    if (code >= 0 && code <= 0x10ffff) return String.fromCodePoint(code)
  }
  return ent
}

/** 원문 [start,end) 텍스트(태그 없음)를 엔티티 풀어 글자별 위치와 함께 out 에 붙인다 */
function appendDecoded(xml: string, start: number, end: number, out: Mapped): void {
  let i = start
  while (i < end) {
    if (xml[i] === "&") {
      ENTITY_RE.lastIndex = i
      const m = ENTITY_RE.exec(xml)
      if (m && i + m[0].length <= end) {
        const dec = decodeEntity(m[0])
        for (let k = 0; k < dec.length; k++) {
          out.text += dec[k]
          out.pos.push(k === 0 && dec.length === 1 ? [i, i + m[0].length] : null)
        }
        i += m[0].length
        continue
      }
    }
    out.text += xml[i]
    out.pos.push([i, i + 1])
    i++
  }
}

/** 원문 [start,end) 를 엔티티 해석 없이 글자 그대로 (주석·처리 지시·CDATA) */
function appendRaw(xml: string, start: number, end: number, out: Mapped): void {
  for (let i = start; i < end; i++) {
    out.text += xml[i]
    out.pos.push([i, i + 1])
  }
}

const localName = (qname: string): string => qname.slice(qname.indexOf(":") + 1)

/**
 * <hp:t> 콘텐츠(내부 태그 가능) → 글자별 위치. 공백류·변경 추적 등은 가상 공백, 형광펜·하이픈은 투명,
 * CDATA 는 글자 그대로, 주석·처리 지시는 글자가 아니라 투명 (안쪽 글자는 느슨한 검사가 따로 본다)
 */
function appendTContent(xml: string, start: number, end: number, out: Mapped): void {
  const tokRe = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<\/?([^\s/>!?]+)[^>]*>/g
  tokRe.lastIndex = start
  let cursor = start
  let m: RegExpExecArray | null
  while ((m = tokRe.exec(xml)) !== null && m.index < end) {
    appendDecoded(xml, cursor, m.index, out)
    if (m[1] !== undefined) appendRaw(xml, m.index + 9, m.index + 9 + m[1].length, out)
    else if (m[2] !== undefined && !T_INNER_TRANSPARENT.has(localName(m[2]))) { out.text += " "; out.pos.push(null) }
    cursor = m.index + m[0].length
  }
  appendDecoded(xml, cursor, end, out)
}

/** 같은 문단 두 t 조각 사이 원문에 글자를 끊는 요소(탭·줄바꿈·글자처럼 취급한 표·수식·변경 추적)가 있는가 */
function gapSeparates(gap: string): boolean {
  const tagRe = /<(\/?)([^\s/>!?]+)(?:"[^"]*"|'[^']*'|[^>"'])*>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(gap)) !== null) {
    const l = localName(m[2])
    if (m[1] === "" && FLOW_OBJECTS.has(l) && !m[0].endsWith("/>")) {
      if (l === "equation" || l === "footNote" || l === "endNote") return true
      const end = findElementEnd(gap, m.index)
      if (end < 0) return true
      const pos = l === "tbl" ? /<(?:[\w]+:)?pos\b[^>]*>/.exec(gap.slice(m.index, end))?.[0] : undefined
      if (pos && /\btreatAsChar="1"/.test(pos)) return true
      tagRe.lastIndex = end // 개체 속(셀·글상자·각주 문단)은 건너뛴다
      continue
    }
    if (GAP_SEPARATORS.has(l)) return true
  }
  return false
}

function paragraphText(xml: string, para: ScanParagraph): Mapped {
  const out: Mapped = { text: "", pos: [] }
  let prevEnd = -1
  for (const t of para.tRanges) {
    if (prevEnd >= 0 && gapSeparates(xml.slice(prevEnd, t.contentStart))) { out.text += " "; out.pos.push(null) }
    if (!t.selfClosing) appendTContent(xml, t.contentStart, t.contentEnd, out)
    prevEnd = t.contentEnd
  }
  return out
}

/** 스캔 결과의 모든 문단 (본문·글상자·머리말류·표 셀·중첩표) */
function allParagraphs(scan: ReturnType<typeof scanSectionXml>): ScanParagraph[] {
  const out = [...scan.bodyParagraphs, ...scan.excludedParagraphs]
  const walk = (t: ScanTable, depth: number): void => {
    if (depth > 32) return
    for (const row of t.rows) for (const cell of row) {
      out.push(...cell.paragraphs)
      for (const n of cell.tables) walk(n, depth + 1)
    }
  }
  for (const t of [...scan.tables, ...scan.orphanTables]) walk(t, 0)
  return out
}

const CONTAINER_WHERE: Record<string, RedactWhere> = {
  header: "header", footer: "footer", footNote: "footnote", endNote: "endnote", fn: "footnote", en: "endnote",
  caption: "caption", memo: "memo", memogroup: "memo", hiddenComment: "hidden",
}

/** 머리말·각주 등 컨테이너 범위 목록 — excluded 문단 위치 분류용 */
function containerRanges(xml: string): Array<{ start: number; end: number; where: RedactWhere }> {
  const out: Array<{ start: number; end: number; where: RedactWhere }> = []
  for (const m of xml.matchAll(/<((?:[\w]+:)?(header|footer|footNote|endNote|caption|memogroup|memo|hiddenComment))[\s>]/g)) {
    const end = findElementEnd(xml, m.index as number)
    if (end > 0) out.push({ start: m.index as number, end, where: CONTAINER_WHERE[m[2]] ?? "other" })
  }
  return out
}

function paragraphWhere(para: ScanParagraph, ranges: ReturnType<typeof containerRanges>): RedactWhere {
  if (para.kind === "body") return "body"
  if (para.kind === "draw") return "textbox"
  if (para.kind === "cell") return para.inTextbox ? "textbox" : "table"
  let best: { start: number; where: RedactWhere } | undefined
  for (const r of ranges) {
    if (r.start < para.start && para.start < r.end && (!best || r.start > best.start)) best = r
  }
  return best?.where ?? "other"
}

/**
 * 텍스트 한 단위 탐지 → 리포트 + splice. 한 번호 안에서 원문이 이어진 글자들은 splice 하나로 묶는다
 * (명단 2,000행에서 글자마다 splice 하던 것이 이차 시간이었다).
 */
function maskMapped(m: Mapped, ctx: ScrubCtx, onHit: (h: RedactHit) => void, splices: SpliceEdit[] | null): void {
  for (const h of findPii(m.text, ctx)) {
    onHit(h)
    if (!splices) continue
    let run: SpliceEdit | null = null
    for (let k = 0; k < h.length; k++) {
      const p = m.pos[h.index + k]
      if (!p || h.masked[k] === m.text[h.index + k]) { run = null; continue }
      if (run && run.end === p[0]) { run.end = p[1]; run.replacement += ctx.maskChar }
      else { run = { start: p[0], end: p[1], replacement: ctx.maskChar }; splices.push(run) }
    }
  }
}

/** splice 일괄 적용 — 정렬 후 한 번에 이어 붙인다 (선형 시간). 겹치면 내부 오류 */
function applySplicesLinear(src: string, splices: SpliceEdit[]): string {
  const sorted = [...splices].sort((a, b) => a.start - b.start || a.end - b.end)
  const parts: string[] = []
  let cursor = 0
  for (const s of sorted) {
    if (s.start < cursor) throw new Error("마스킹 splice 범위 겹침 — 내부 오류")
    parts.push(src.slice(cursor, s.start), s.replacement)
    cursor = s.end
  }
  parts.push(src.slice(cursor))
  return parts.join("")
}

/** 줄 배치 캐시 등 구조 속성만 있는 요소 — 속성값 검사를 건너뛴다 */
const STRUCTURAL_ELEMENTS = new Set(["lineseg", "linesegarray"])

/**
 * 문단이 소유하지 않은 텍스트·속성값 탐지. owned = 문단 t 콘텐츠 범위(이미 문단 단위로 처리).
 * 요소 태그 사이 텍스트 노드는 주석·처리 지시로 갈려도 이어서 본다(tel:010-2345<!--x-->-6789).
 * 주석·처리 지시·DOCTYPE 의 안쪽 글자도 따로 본다. 위치 분류는 가장 가까운 여는 요소 이름으로.
 */
function scrubLooseText(
  xml: string, owned: Array<[number, number]>, ctx: ScrubCtx, partWhere: RedactWhere | null,
  report: (h: RedactHit, where: RedactWhere) => void, splices: SpliceEdit[] | null,
): void {
  const tokenRe = /<!--([\s\S]*?)-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?([\s\S]*?)\?>|<!((?:"[^"]*"|'[^']*'|[^>"'])*)>|<(\/?)([^\s/>!?]+)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|([^<]+)/g
  const stack: string[] = []
  let oi = 0
  let pending: Mapped | null = null
  let pendingWhere: RedactWhere = "other"
  const whereOf = (fallback: RedactWhere): RedactWhere => {
    if (partWhere) return partWhere
    for (let i = stack.length - 1; i >= 0; i--) {
      const l = stack[i]
      if (l === "stringParam" || l === "fieldBegin" || l === "parameters") return "field"
      if (l === "shapeComment") return "attribute"
      if (CONTAINER_WHERE[l]) return CONTAINER_WHERE[l]
    }
    return fallback
  }
  const flush = (): void => {
    if (pending && pending.text.length >= 5 && !isBindingPath(pending.text)) {
      const where = pendingWhere
      maskMapped(pending, ctx, (h) => report(h, where), splices)
    }
    pending = null
  }
  const addText = (fill: (out: Mapped) => void): void => {
    if (!pending) { pending = { text: "", pos: [] }; pendingWhere = whereOf("other") }
    fill(pending)
  }
  const scanInner = (start: number, text: string): void => {
    const mapped: Mapped = { text: "", pos: [] }
    appendRaw(xml, start, start + text.length, mapped)
    maskMapped(mapped, ctx, (h) => report(h, partWhere ?? "other"), splices)
  }
  const isOwned = (at: number): boolean => {
    while (oi < owned.length && owned[oi][1] <= at) oi++
    return oi < owned.length && owned[oi][0] <= at && at < owned[oi][1]
  }
  for (const m of xml.matchAll(tokenRe)) {
    const at = m.index as number
    if (m[9] !== undefined || m[2] !== undefined) {
      // 텍스트 노드·CDATA — 문단 소유 범위(<hp:t> 안)면 문단 단위로 이미 봤다: 그 앞에서 끊고 건너뜀
      if (isOwned(at)) { flush(); continue }
      if (m[9] !== undefined) addText((out) => appendDecoded(xml, at, at + m[9].length, out))
      else addText((out) => appendRaw(xml, at + 9, at + 9 + m[2].length, out))
      continue
    }
    if (m[1] !== undefined) { scanInner(at + 4, m[1]); continue } // 주석 — 안쪽 글자 따로, 텍스트는 이어 봄
    if (m[3] !== undefined) { scanInner(at + 2, m[3]); continue } // 처리 지시
    if (m[4] !== undefined) { flush(); scanInner(at + 2, m[4]); continue } // DOCTYPE·ENTITY 선언
    if (m[6] === undefined) continue
    flush()
    const local = localName(m[6])
    if (m[5] === "/") {
      const i = stack.lastIndexOf(local)
      if (i >= 0) stack.length = i
      continue
    }
    // 속성값 — 정수만인 값도 본다(누름틀 이름 "01023456789"). 데이터 연결 경로·줄 배치 캐시는 건너뜀
    const attrs = m[7] ?? ""
    if (attrs.includes("=") && !STRUCTURAL_ELEMENTS.has(local)) {
      const attrBase = at + 1 + m[6].length
      for (const a of attrs.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
        const val = a[2] ?? a[3] ?? ""
        if (val.length < 5 || !/[0-9A-Za-z]/.test(val) || isBindingPath(val)) continue
        const valStart = attrBase + (a.index as number) + a[0].length - val.length - 1
        const mapped: Mapped = { text: "", pos: [] }
        appendDecoded(xml, valStart, valStart + val.length, mapped)
        maskMapped(mapped, ctx, (h) => report(h, partWhere ?? "attribute"), splices)
      }
    }
    if (m[8] !== "/") stack.push(local)
  }
  flush()
}

/** XML 한 엔트리 수술 — 문단 단위 + 느슨한 텍스트/속성. 바뀐 게 없으면 null */
function scrubXml(
  xml: string, part: string, ctx: ScrubCtx, mode: "mask" | "check", hits: RedactFileHit[],
): string | null {
  const splices: SpliceEdit[] | null = mode === "mask" ? [] : null
  const partWhere: RedactWhere | null = /content\.hpf$/i.test(part) ? "metadata" : null
  const owned: Array<[number, number]> = []
  if (/<(?:[\w]+:)?p[\s>]/.test(xml) && /<(?:[\w]+:)?t[\s>/]/.test(xml)) {
    const scan = scanSectionXml(xml, 0)
    const ranges = containerRanges(xml)
    for (const para of allParagraphs(scan)) {
      for (const t of para.tRanges) owned.push([t.contentStart, t.contentEnd])
      const where = paragraphWhere(para, ranges)
      maskMapped(paragraphText(xml, para), ctx, (h) => hits.push({ rule: h.rule, masked: h.masked, part, where }), splices)
    }
    owned.sort((a, b) => a[0] - b[0])
  }
  scrubLooseText(xml, owned, ctx, partWhere, (h, where) => hits.push({ rule: h.rule, masked: h.masked, part, where }), splices)
  if (!splices || splices.length === 0) return null
  if (xml.includes("linesegarray")) splices.push(...allLinesegRemovalSplices(xml))
  return applySplicesLinear(xml, splices)
}

/** 텍스트 엔트리(Preview/PrvText.txt·Scripts 등) — 줄 단위 탐지 */
function scrubPlainText(text: string, part: string, ctx: ScrubCtx, mode: "mask" | "check", hits: RedactFileHit[]): string | null {
  const where: RedactWhere = /^Preview\//i.test(part) ? "preview" : "other"
  let changed = false
  const lines = text.split("\n").map((line) => {
    const found = findPii(line, ctx)
    if (found.length === 0) return line
    let out = ""
    let cursor = 0
    for (const h of found) {
      hits.push({ rule: h.rule, masked: h.masked, part, where })
      out += line.slice(cursor, h.index) + h.masked
      cursor = h.index + h.length
    }
    changed = true
    return out + line.slice(cursor)
  })
  return mode === "mask" && changed ? lines.join("\n") : null
}

const isXmlName = (n: string): boolean => /\.(xml|hpf|rdf)$/i.test(n)
const isTextName = (n: string): boolean => /\.(txt|js|json|csv|html?)$/i.test(n) || /^Scripts\//i.test(n)
const isPreviewImage = (n: string): boolean => /^Preview\/PrvImage\./i.test(n)
const nameList = (names: string[]): string => names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} 외 ${names.length - 5}개`

/** 태그를 걷어 이은 글자에 리터럴(본문에서 찾은 값)이 남았는가 — 재검사 안전망 (문단 조립과 독립) */
function literalLeftovers(xml: string, part: string, ctx: ScrubCtx, hits: RedactFileHit[]): void {
  if (ctx.literals.length === 0) return
  const stripped = normalizeForDetect(xml.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
  for (const { lit } of findLiterals(stripped, ctx.literals)) {
    if (!hits.some((x) => x.part === part && x.masked === lit.masked)) hits.push({ rule: lit.rule, masked: lit.masked, part, where: "other" })
  }
}

/**
 * HWPX 한 파일을 훑는다. mask: 가린 파일 + 가린 곳 목록, check: 찾은 곳만 (data 는 입력 그대로 —
 * 가릴 수 없는 삽입 OLE 개체·압축 메타데이터 속 PII 도 여기서 잔존으로 드러난다).
 */
export async function scrubHwpx(original: Uint8Array, ctx: ScrubCtx, mode: "mask" | "check"): Promise<ScrubResult> {
  const zip = await JSZip.loadAsync(original)
  const hits: RedactFileHit[] = []
  const warnings: string[] = []
  const unscanned: string[] = []
  const replacements = new Map<string, Uint8Array>()
  const encoder = new TextEncoder()
  const previews: string[] = []
  const pictures: string[] = []
  const embedded: string[] = []

  /** 글자 엔트리 해독 — UTF-8, BOM 붙은 UTF-16LE, BOM 없는 UTF-16LE(한컴 Scripts). 모르면 null. 되쓸 때 같은 인코딩 */
  const decode = (bytes: Buffer): { text: string; encode: (s: string) => Uint8Array } | null => {
    if ((bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.includes(0) && looksUtf16le(bytes))) {
      return { text: bytes.toString("utf16le"), encode: (x) => Buffer.from(x, "utf16le") }
    }
    return bytes.includes(0) ? null : { text: bytes.toString("utf8"), encode: (x) => encoder.encode(x) }
  }

  for (const [name, entry] of Object.entries(zip.files)) {
    if (entry.dir || name === "mimetype") continue
    if (isPreviewImage(name)) { previews.push(name); continue }
    const bytes = Buffer.from(await entry.async("uint8array"))
    if (isXmlName(name) || /^BinData\/.*\.svg$/i.test(name)) {
      const dec = decode(bytes)
      if (!dec) { unscanned.push(name); continue }
      const next = scrubXml(dec.text, name, ctx, mode, hits)
      if (next !== null) replacements.set(name, dec.encode(next))
      if (mode === "check") literalLeftovers(dec.text, name, ctx, hits)
      continue
    }
    if (/^BinData\//i.test(name)) {
      const report = (where: RedactWhere) => (h: RedactHit): void => { hits.push({ rule: h.rule, masked: h.masked, part: name, where }) }
      if (isOleBin(bytes) || isEmf(bytes)) {
        // 삽입 OLE 개체(차트·삽입 문서·엑셀)·EMF — 제자리에서 못 가린다. 재검사에서 안의 글자를 보고해 잔존으로 드러낸다
        embedded.push(name)
        if (mode === "check") {
          if (isOleBin(bytes)) await checkEmbeddedOle(bytes, ctx, report("other"))
          else scrubUtf16Runs(bytes, ctx, "check", report("other"))
        }
      } else {
        pictures.push(name)
        if (isMetaImage(bytes) && scrubImageMeta(bytes, ctx, mode, report("metadata"))) replacements.set(name, bytes)
      }
      continue
    }
    // 텍스트 엔트리(Preview/PrvText.txt·Scripts 등) — 같은 인코딩으로 되쓴다
    const dec = decode(bytes)
    if (dec) {
      const next = scrubPlainText(dec.text, name, ctx, mode, hits)
      if (next !== null) replacements.set(name, dec.encode(next))
    } else if (isTextName(name)) {
      unscanned.push(name) // 글자가 들어 있을 자리인데 인코딩을 몰라 못 읽음 — 잔존급 실패
    } else {
      warnings.push(`알 수 없는 바이너리 엔트리 ${name} 는 검사하지 못했습니다`)
    }
  }

  if (mode === "mask") {
    if (hits.length > 0 || ctx.literals.length > 0) {
      for (const name of previews) {
        const blank = blankPreviewImage(await zip.file(name)!.async("uint8array"))
        if (blank) replacements.set(name, blank)
        else warnings.push(`${name}: 형식을 몰라 미리보기 이미지를 지우지 못했습니다 — 첫 쪽 렌더에 PII 가 보일 수 있습니다`)
      }
      if (previews.length > 0) warnings.push(`미리보기 이미지(${previews.join(", ")})를 같은 크기의 흰 이미지로 바꿨습니다 — 한컴에서 저장하면 다시 만들어집니다`)
    }
    if (pictures.length > 0) warnings.push(`삽입 그림 ${pictures.length}개(${nameList(pictures)})는 화소 속 글자(스캔 문서 등)를 탐지하지 못합니다 — JPEG·PNG 메타데이터만 검사했습니다`)
    if (embedded.length > 0) warnings.push(`삽입 개체 ${embedded.length}개(${nameList(embedded)} — OLE·EMF)는 가리지 못합니다 — 안의 글자에 PII 가 있으면 재검사 잔존으로 보고됩니다`)
    if (unscanned.length > 0) warnings.push(`인코딩을 몰라 검사하지 못한 글자 엔트리: ${unscanned.join(", ")}`)
  }

  // ZIP 원시 바이트는 따로 훑지 않는다 — 엔트리는 전부 압축 해제본으로 봤고, 압축 데이터를 1바이트
  // 조각으로 훑으면 "8@F.eq" 같은 난수 이메일 모양이 걸린다(실코퍼스 실측). 엔트리 사이 틈은 미검사.
  const data = mode === "mask" && replacements.size > 0 ? patchZipEntries(original, replacements) : original
  return { data, hits, warnings, unscanned }
}
