/**
 * 마크다운 파싱 + hwpx run/문단 XML 생성 (generator.ts에서 분리).
 * 블록 분해(parseMarkdownToBlocks), 인라인 span, run/문단 조립, PrvText.
 */

import {
  CHAR_NORMAL, CHAR_BOLD, CHAR_ITALIC, CHAR_BOLD_ITALIC, CHAR_CODE,
  PARA_NORMAL, PARA_CODE,
  escapeXml,
} from "./gen-ids.js"
import { sanitizeHref } from "../utils.js"

// ─── 인라인 문서 컨텍스트 — 하이퍼링크·각주 (v4.5.0) ──
//
// markdownToHwpx가 문서 시작에 beginInlineDoc으로 열고 끝에 endInlineDoc으로 닫는다.
// 컨텍스트가 없으면(직접 호출 경로) 종전 동작 그대로 — 링크는 anchor 텍스트로,
// [^id]는 리터럴로 남는다. 카운터는 문서마다 리셋돼 출력이 결정적이다.

/** HYPERLINK 필드 공통 fieldid — 실측 저장본 공통값 (nrich·seoul2) */
const HYPERLINK_FIELDID = 627600491
const FIELD_ID_BASE = 1_800_000_000
const FOOTNOTE_INST_BASE = 1_850_000_000

interface InlineDocCtx {
  footnotes: Map<string, string>
  fieldSeq: number
  noteSeq: number
  /** 각주 본문 렌더 중 — 중첩 각주 마커는 리터럴 유지 (자기참조 재귀 차단) */
  inNote: boolean
}

let inlineDoc: InlineDocCtx | null = null

/** 문서 단위 인라인 채널 시작 — 각주 정의 주입 + 필드/각주 카운터 리셋 */
export function beginInlineDoc(footnotes: Map<string, string>): void {
  inlineDoc = { footnotes, fieldSeq: 0, noteSeq: 0, inNote: false }
}

export function endInlineDoc(): void {
  inlineDoc = null
}

/**
 * 각주 정의 수집 — `[^id]: 본문` 줄을 걷어내고 map으로 반환.
 * 본문 마커 `[^id]`는 parseInlineMarkdown이 footNote 개체로 방출한다.
 */
export function extractFootnoteDefs(md: string): { md: string; defs: Map<string, string> } {
  const defs = new Map<string, string>()
  const out = md.replace(/\r\n?/g, "\n").split("\n").filter(line => {
    const m = /^\[\^([^\]\s]+)\]:\s?(.*)$/.exec(line)
    if (!m) return true
    defs.set(m[1], m[2].trim())
    return false
  }).join("\n")
  return { md: defs.size > 0 ? out : md, defs }
}


/** Preview/PrvText.txt — 문서 앞부분 텍스트 스냅샷 (최대 1KB) */
export function buildPrvText(blocks: MdBlock[]): string {
  const lines: string[] = []
  let bytes = 0
  for (const b of blocks) {
    let text = b.text || (b.rows ? b.rows.map(r => r.join(" ")).join("\n") : "")
    if (b.type === "code_block" && (b.lang || "").toLowerCase() === "chart") text = "[차트]" // DSL 원문 노출 방지
    else if (b.type === "html_table") text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
    if (!text) continue
    lines.push(text)
    bytes += text.length * 3
    if (bytes > 1024) break
  }
  return lines.join("\n").slice(0, 1024)
}



export interface MdBlock {
  type: "paragraph" | "heading" | "table" | "html_table" | "code_block" | "equation" | "hr" | "blockquote" | "list_item"
  text?: string
  level?: number
  rows?: string[][]
  lang?: string
  ordered?: boolean
  indent?: number
  /** 리스트 원본 마커 ("2." "3)" "-" "*" 등) — 왕복 시 번호 재시작·기호 변형 방지 */
  marker?: string
}

/** 이스케이프(\$$) 아닌 "$$" 위치 탐색 — 백슬래시 홀수 개 선행이면 이스케이프로 본다 */
function findMathDelim(s: string, from: number): number {
  let i = s.indexOf("$$", from)
  while (i > 0) {
    let backslashes = 0
    for (let j = i - 1; j >= 0 && s[j] === "\\"; j--) backslashes++
    if (backslashes % 2 === 0) break
    i = s.indexOf("$$", i + 1)
  }
  return i
}

export function parseMarkdownToBlocks(md: string): MdBlock[] {
  // CRLF/CR(Windows·구 Mac 작성 .md) → LF 정규화 — \r 잔류 시 fence/heading/list 정규식이
  // 줄 끝에서 매치 실패해 전멸한다 (chart-3: ```chart 원문이 본문으로 인쇄되는 광역 결함)
  const lines = md.replace(/\r\n?/g, "\n").split("\n")
  const blocks: MdBlock[] = []
  let i = 0
  // 리스트 들여쓰기 스택 — depth별 물리 들여쓰기(칸 수)를 보관. 리스트 run이 끊기면 초기화 (v4.0.5)
  const listStack: number[] = []

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // Display math block: $$ ... $$ — 같은 줄 닫힘/멀티라인/닫는 $$ 뒤 잔여 텍스트를
    // 모두 처리하고, 미종결이면 아래 일반 파이프라인으로 폴백한다 (문서 통삼킴 방지,
    // 리뷰 #39 ·1/·6). 이스케이프된 \$$ 는 여닫이로 세지 않는다 (escapeGfm 접점).
    const mathOpen = /^\s*\$\$/.exec(line)
    if (mathOpen) {
      const afterOpen = line.slice(mathOpen[0].length)
      const closeSame = findMathDelim(afterOpen, 0)
      if (closeSame >= 0) {
        const inner = afterOpen.slice(0, closeSame).trim()
        const trailing = afterOpen.slice(closeSame + 2).trim()
        if (inner) blocks.push({ type: "equation", text: inner })
        if (trailing) blocks.push({ type: "paragraph", text: trailing })
        i++
        continue
      }
      // 멀티라인 수집 — 빈 줄/코드펜스를 만나면 미종결로 판정 (거리 무제한 삼킴 방지)
      const mathLines: string[] = []
      if (afterOpen.trim()) mathLines.push(afterOpen)
      let closed = false
      let trailing = ""
      let j = i + 1
      for (; j < lines.length; j++) {
        const l = lines[j]
        if (!l.trim() || /^\s*(`{3,}|~{3,})/.test(l)) break
        const end = findMathDelim(l, 0)
        if (end >= 0) {
          const before = l.slice(0, end)
          if (before.trim()) mathLines.push(before)
          trailing = l.slice(end + 2).trim()
          closed = true
          j++
          break
        }
        mathLines.push(l)
      }
      if (closed) {
        const text = mathLines.join("\n").trim()
        if (text) blocks.push({ type: "equation", text })
        if (trailing) blocks.push({ type: "paragraph", text: trailing })
        i = j
        continue
      }
      // 미종결 — 수식 아님. 이 줄부터 일반 블록으로 처리 (통과)
    }

    // 코드블록
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2].trim()
      const codeLines: string[] = []
      i++
      // 여는·닫는 펜스 모두 ≤3칸 들여쓰기 허용 (CommonMark — 리스트 하위 차트 관행)
      while (i < lines.length && !lines[i].replace(/^ {0,3}/, "").startsWith(fence)) {
        codeLines.push(lines[i])
        i++
      }
      if (i < lines.length) i++ // 닫는 fence
      blocks.push({ type: "code_block", text: codeLines.join("\n"), lang })
      continue
    }

    // 수평선
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: "hr" })
      i++; continue
    }

    // 헤딩
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length })
      i++; continue
    }

    // HTML 표 (병합·중첩 — kordoc parse가 병합/중첩표를 내보내는 형식)
    // 짝이 안 맞으면(닫는 </table> 부재) 수식 블록 관례처럼 일반 파이프라인으로
    // 폴백 — 문서 잔여 전체가 EOF까지 통째로 삼켜지는 것 방지
    if (/^<table[\s>]/i.test(line.trimStart())) {
      const htmlLines: string[] = []
      let depth = 0
      let closed = false
      let j = i
      while (j < lines.length) {
        const l = lines[j]
        htmlLines.push(l)
        depth += (l.match(/<table[\s>]/gi) ?? []).length
        depth -= (l.match(/<\/table>/gi) ?? []).length
        j++
        if (depth <= 0) { closed = true; break }
      }
      if (closed) {
        blocks.push({ type: "html_table", text: htmlLines.join("\n") })
        i = j
        continue
      }
      // 미종결 — HTML 표 아님. 이 줄부터 일반 블록으로 처리 (통과)
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      let sepSeen = false
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        // 구분행 판정 — GFM처럼 헤더 직후(2행째) 1회만 인정. 각 구분 셀은 `:?-+:?` 꼴
        // (- 최소 1개 — `:-:` 정렬 표기 허용). 전부 빈 데이터 행 `|  |  |` 오인 방지는
        // 유지되고(- 필수), 본문 위치의 `| - | - |`('해당없음' 표기)는 데이터 행으로 보존
        if (tableRows.length === 1 && !sepSeen) {
          const sepCells = row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|")
          if (sepCells.every(c => /^\s*:?-+:?\s*$/.test(c))) { sepSeen = true; i++; continue }
        }
        // 이스케이프되지 않은 | 로만 분할 + 셀 내 \| → | 복원 (parseGfmTable과 동일)
        const cells = row.split(/(?<!\\)\|/).slice(1, -1).map(c => c.trim().replace(/\\\|/g, "|"))
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) blocks.push({ type: "table", rows: tableRows })
      continue
    }

    // 인용문 — 공백줄 없는 연속 > 라인은 한 블록으로 조인(개행 결합 — 줄 경계 보존),
    // 빈 > 줄에서만 분리. 개조식 프리셋에서 줄마다 ※ 참고로 쪼개지는 것 방지 (v4.0.5).
    // 렌더가 분기: 실측 프리셋은 ※ 1문단(공백 결합), 기본은 줄별 문단(종전 시각 유지)
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, "").trim())
        i++
      }
      let joined: string[] = []
      for (const ql of quoteLines) {
        if (ql) { joined.push(ql); continue }
        if (joined.length) blocks.push({ type: "blockquote", text: joined.join("\n") })
        joined = []
      }
      if (joined.length) blocks.push({ type: "blockquote", text: joined.join("\n") })
      continue
    }

    // 리스트 — 선두 탭은 2칸 상당으로 확장(이 코드베이스 그리드가 2칸 — CommonMark 4칸과 다름).
    // depth는 절대 그리드(÷2)가 아니라 들여쓰기 스택으로 산출: 물리 들여쓰기 증가=한 단계
    // down, 감소=매칭 조상 레벨로 복귀. 4칸 한 단계가 depth 2로 튀거나 탭 자식이
    // 형제로 붕괴하는 것 방지, 2칸 그리드 입력의 depth는 종전과 동일 (v4.0.5)
    const listLine = line.replace(/^[\t ]+/, ws => ws.replace(/\t/g, "  "))
    const listMatch = listLine.match(/^(\s*)([-*+]|\d+[.)]) (.+)$/)
    if (listMatch) {
      // 리스트 run이 끊겼으면(직전 블록이 리스트 아님) 스택 초기화 — 빈 줄은 run 유지
      if (blocks.length === 0 || blocks[blocks.length - 1].type !== "list_item") listStack.length = 0
      const phys = listMatch[1].length
      let indent: number
      if (listStack.length === 0) {
        // run 첫 항목 — 기존 2칸 그리드로 시드 (들여쓰고 시작하는 입력의 depth 종전 유지)
        indent = Math.floor(phys / 2)
        for (let d = 0; d < indent; d++) listStack.push(d * 2)
        listStack.push(phys)
      } else {
        while (listStack.length > 1 && phys < listStack[listStack.length - 1]) listStack.pop()
        if (phys > listStack[listStack.length - 1]) listStack.push(phys)
        indent = listStack.length - 1
      }
      const ordered = /\d/.test(listMatch[2])
      blocks.push({ type: "list_item", text: listMatch[3].trim(), ordered, indent, marker: listMatch[2] })
      i++; continue
    }

    // 일반 단락
    blocks.push({ type: "paragraph", text: line.trim() })
    i++
  }

  return blocks
}

// ─── 인라인 마크다운 → 멀티 run ─────────────────────

interface InlineSpan {
  text: string
  bold: boolean
  italic: boolean
  code: boolean
  /** 하이퍼링크 대상 (살균 후) — 연속 동일 href span이 한 필드 extent */
  href?: string
  /** 각주 본문 — 이 위치에 footNote 개체 방출 (text는 빈 문자열) */
  note?: string
}

export function parseInlineMarkdown(text: string): InlineSpan[] {
  // 마크다운 백슬래시 이스케이프(\* \~ \| 등 — kordoc 파서 escapeGfm 출력 포함)를
  // 센티널로 마스킹 — 강조/링크 정규식이 이스케이프된 문자를 델리미터로 오인해
  // 소비하는 것을 차단. span 조립 후 리터럴로 복원한다.
  const literals: string[] = []
  text = text.replace(/\x00/g, "").replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, (_, c: string) => {
    literals.push(c)
    return `\x00${literals.length - 1}\x00`  // 인덱스 내장 — 전처리가 일부 구간을 버려도 정렬 유지
  })
  // 전처리: 이미지 → alt 텍스트 (블록 단위 이미지는 gen-section이 pic으로 방출)
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  // 전처리: ~~취소선~~ → 텍스트만
  text = text.replace(/~~([^~]+)~~/g, "$1")
  // 전처리: <u>밑줄</u> → 텍스트만 (취소선과 동일 정책 — 서식 마커는 생성 시 평문화)
  text = text.replace(/<u>([^<]*)<\/u>/g, "$1")

  let spans: InlineSpan[]
  if (inlineDoc) {
    // 링크·각주 채널 (v4.5.0) — [text](url)은 href span 그룹으로, [^id]는 note span으로.
    // 세그먼트 단위로 강조를 파싱하므로 링크 경계를 걸치는 강조(**a [b](u)**)는 리터럴 유지.
    spans = []
    const re = /\[\^([^\]\s]+)\]|\[([^\]]*)\]\(([^)]*)\)/g
    let last = 0
    for (const m of text.matchAll(re)) {
      const idx = m.index!
      if (idx > last) spans.push(...emphasisSpans(text.slice(last, idx)))
      if (m[1] !== undefined) {
        const def = inlineDoc.inNote ? undefined : inlineDoc.footnotes.get(m[1])
        if (def !== undefined) spans.push({ text: "", bold: false, italic: false, code: false, note: def })
        else spans.push(...emphasisSpans(m[0])) // 정의 없는 마커 — 리터럴 보존
      } else {
        const anchor = m[2] || m[3]
        const href = sanitizeHref(m[3].trim()) ?? undefined
        const sub = emphasisSpans(anchor)
        if (href) for (const s of sub) s.href = href
        spans.push(...sub)
      }
      last = idx + m[0].length
    }
    if (last < text.length) spans.push(...emphasisSpans(text.slice(last)))
    if (spans.length === 0) spans.push({ text, bold: false, italic: false, code: false })
  } else {
    // 종전 경로 — 링크는 텍스트만 추출
    text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => t || u)
    spans = emphasisSpans(text)
    if (spans.length === 0) spans.push({ text, bold: false, italic: false, code: false })
  }
  // 센티널 → 리터럴 복원. 인라인 코드 안은 CommonMark처럼 이스케이프 처리가
  // 없으므로 백슬래시까지 원문 그대로 되살린다.
  for (const span of spans) {
    if (!span.text.includes("\x00")) continue
    span.text = span.text.replace(/\x00(\d+)\x00/g, (_, i) => {
      const c = literals[+i] ?? ""
      return span.code ? "\\" + c : c
    })
  }
  return spans
}

// 패턴: `code`, ***bolditalic***, **bold**, *italic*, __bold__, _italic_
// **/***/* 는 안쪽에 더 짧은 별 run 을 허용 — **굵게 *기울임*** 같은 중첩 강조가
// 매칭에서 통째로 탈락해 별 하나짜리 두 개로 오인되던 것을 방지 (#61). 중첩 내용은
// emphasisSpans 재귀로 분해해 겉 강조 플래그를 OR 한다.
// 언더스코어 강조는 GFM처럼 단어 내부 비활성 (post_id·__init__ 오염 방지, v4.0.5):
// 여는 _ 는 앞이 공백/구두점/문두 + 뒤가 비공백, 닫는 _ 는 앞이 비공백 + 뒤가
// 공백/구두점/문미일 때만. (?<!_)/(?!_)는 _ run을 원자로 취급(_init_ 부분매칭 방지),
// \x00 은 이스케이프 센티널(마스킹된 구두점)이라 경계로 인정.
const INLINE_REGEX = /(`[^`]+`|\*{3}(?:[^*]|\*(?!\*\*))+\*{3}|\*{2}(?:[^*]|\*(?!\*))+\*{2}|\*(?:[^*]|\*{2}(?:[^*]|\*(?!\*))+\*{2})+\*|(?<![^\s\p{P}\p{S}\x00])(?<!_)_{2}(?=\S)[^_]+(?<=\S)_{2}(?!_)(?![^\s\p{P}\p{S}\x00])|(?<![^\s\p{P}\p{S}\x00])(?<!_)_(?=\S)[^_]+(?<=\S)_(?!_)(?![^\s\p{P}\p{S}\x00]))/gu

/**
 * 강조(`code` ** * __ _) 토크나이즈 — 마스킹된 세그먼트 텍스트 전용.
 * 강조 중첩은 한 단계씩 재귀로 벗긴다 — depth 는 병리적 입력 폭주 방지용 상한.
 */
function emphasisSpans(text: string, depth = 0): InlineSpan[] {
  const spans: InlineSpan[] = []
  let lastIdx = 0

  for (const match of text.matchAll(INLINE_REGEX)) {
    const idx = match.index!
    if (idx > lastIdx) {
      spans.push({ text: text.slice(lastIdx, idx), bold: false, italic: false, code: false })
    }
    const raw = match[0]
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: false, code: true })
    } else {
      let inner: string
      let bold = false
      let italic = false
      if (raw.startsWith("***") || raw.startsWith("___")) {
        inner = raw.slice(3, -3); bold = true; italic = true
      } else if (raw.startsWith("**") || raw.startsWith("__")) {
        inner = raw.slice(2, -2); bold = true
      } else {
        inner = raw.slice(1, -1); italic = true
      }
      if (depth < 3 && /[`*_]/.test(inner)) {
        for (const child of emphasisSpans(inner, depth + 1)) {
          spans.push(child.code ? child : { ...child, bold: child.bold || bold, italic: child.italic || italic })
        }
      } else {
        spans.push({ text: inner, bold, italic, code: false })
      }
    }
    lastIdx = idx + raw.length
  }
  if (lastIdx < text.length) {
    spans.push({ text: text.slice(lastIdx), bold: false, italic: false, code: false })
  }
  return spans
}

function spanToCharPrId(span: InlineSpan): number {
  if (span.code) return CHAR_CODE
  if (span.bold && span.italic) return CHAR_BOLD_ITALIC
  if (span.bold) return CHAR_BOLD
  if (span.italic) return CHAR_ITALIC
  return CHAR_NORMAL
}


/** HYPERLINK fieldBegin ctrl — 실측 저장본(seoul2 36266445) 6-param 형상 미러 */
function hyperlinkBeginXml(fid: number, href: string): string {
  // Command의 ':'는 '\:' 이스케이프 (실측: "http\://www.nrich.go.kr;1;0;0;")
  const cmd = escapeXml(href.replace(/:/g, "\\:"))
  const path = escapeXml(href)
  return `<hp:ctrl><hp:fieldBegin id="${fid}" type="HYPERLINK" name="" editable="0" dirty="0" zorder="-1" fieldid="${HYPERLINK_FIELDID}">` +
    `<hp:parameters cnt="6" name=""><hp:integerParam name="Prop">0</hp:integerParam>` +
    `<hp:stringParam name="Command">${cmd};1;0;0</hp:stringParam>` +
    `<hp:stringParam name="Path">${path}</hp:stringParam>` +
    `<hp:stringParam name="Category">HWPHYPERLINK_TYPE_URL</hp:stringParam>` +
    `<hp:stringParam name="TargetType">HWPHYPERLINK_TARGET_BOOKMARK</hp:stringParam>` +
    `<hp:stringParam name="DocOpenType">HWPHYPERLINK_JUMP_CURRENTTAB</hp:stringParam>` +
    `</hp:parameters></hp:fieldBegin></hp:ctrl>`
}

/** footNote ctrl — rhwp render_note_sublist 형상 (suffixChar 41=')' 상시 방출 계약) */
function footnoteXml(note: string, mapCharId?: (id: number) => number): string {
  const d = inlineDoc!
  const n = ++d.noteSeq
  d.inNote = true
  let body: string
  try {
    body = generateRuns(note, CHAR_NORMAL, mapCharId)
  } finally {
    d.inNote = false
  }
  return `<hp:ctrl><hp:footNote number="${n}" suffixChar="41" instId="${FOOTNOTE_INST_BASE + n}">` +
    `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
    `<hp:p paraPrIDRef="0" styleIDRef="0">${body}</hp:p>` +
    `</hp:subList></hp:footNote></hp:ctrl>`
}

export function generateRuns(text: string, defaultCharPr: number = CHAR_NORMAL, mapCharId?: (id: number) => number): string {
  const spans = parseInlineMarkdown(text)
  const mapped = (id: number) => (mapCharId ? mapCharId(id) : id)
  const out: string[] = []
  // 연속 동일 href span 묶음을 fieldBegin/fieldEnd ctrl-run으로 감싼다 (extent = anchor)
  let openHref: string | null = null
  let openFid = 0
  const closeField = () => {
    if (openHref === null) return
    out.push(`<hp:run charPrIDRef="${mapped(defaultCharPr)}"><hp:ctrl><hp:fieldEnd beginIDRef="${openFid}" fieldid="${HYPERLINK_FIELDID}"/></hp:ctrl></hp:run>`)
    openHref = null
  }
  for (const span of spans) {
    if (span.note !== undefined && inlineDoc) {
      closeField()
      out.push(`<hp:run charPrIDRef="${mapped(defaultCharPr)}">${footnoteXml(span.note, mapCharId)}</hp:run>`)
      continue
    }
    const href = inlineDoc ? (span.href ?? null) : null
    if (href !== openHref) {
      closeField()
      if (href !== null) {
        openFid = FIELD_ID_BASE + ++inlineDoc!.fieldSeq
        openHref = href
        out.push(`<hp:run charPrIDRef="${mapped(defaultCharPr)}">${hyperlinkBeginXml(openFid, href)}</hp:run>`)
      }
    }
    const charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr
    out.push(`<hp:run charPrIDRef="${mapped(charId)}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`)
  }
  closeField()
  return out.join("")
}

export function generateParagraph(text: string, paraPrId: number = PARA_NORMAL, charPrId: number = CHAR_NORMAL, mapCharId?: (id: number) => number, styleId: number = 0): string {
  if (paraPrId === PARA_CODE) {
    // 코드블록은 인라인 파싱 안 함
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
  }
  const runs = generateRuns(text, charPrId, mapCharId)
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="${styleId}">${runs}</hp:p>`
}
