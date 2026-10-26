/**
 * 마크다운 블록 → 공문서 의미 아웃라인 (v5).
 *
 * 입력이 #/##/###·리스트 깊이·명시 부호(□ ㅇ - ㆍ ※ 1. 가.) 어느 꼴이든 하나의 depth로
 * 정규화한다 — 같은 내용이면 같은 결과. 규칙:
 *   - 첫 h1 → 제목.  h2 → 장(chapter).  h3~h6 → 항목 depth (level-3).
 *   - 리스트 항목 depth = (현재 장 안의 마지막 h3+ 항목 depth + 1) + 리스트 들여쓰기.
 *     h3+가 없으면 리스트 들여쓰기 그대로 (□부터).
 *   - 문단·항목 선두의 명시 부호는 depth를 강제한다(□0 ㅇ○1 -2 ㆍ3 / 1.→0 가.→1 1)→2 …).
 *     개조식 스킴에서 법정 부호는 "소제목(sub)"으로 남긴다(실측: ○ 아래 '가. 기술인력' 한컴돋움 13).
 *   - ※·'* ' 선두 → 참고(ref). 붙임 → attach. 제목 직후 인용문 → 요약 박스(summary), 그 외 인용 → ref.
 *   - <center>/<right> 문단은 정렬만 붙여 para.
 */

import type { MdBlock } from "./md-runs.js"
import { stripChapterNumber } from "./gaejosik.js"

export type OutlineNode =
  | { kind: "title"; text: string }
  | { kind: "chapter"; text: string; index: number; /** 작성자가 쓴 장 번호("Ⅰ"·"1"·"가") — 서울 방침서 장 상자 번호칸 */ label?: string }
  | { kind: "item"; depth: number; text: string; /** 명시 법정 부호(개조식 문서 안 소제목) */ legalMarker?: string; /** 헤딩(h3+)에서 온 항목 — 사이 문단이 번호를 끊지 않는다 */ fromHeading?: boolean; /** 보존할 선두 부호(❶➊⇒↳ — 업무보고 9대 과제·결론 줄) */ marker?: string }
  /** h3~h6 헤딩을 항목이 아니라 서식 틀(절 띠·소제목 박스·항목 띠)로 남긴 것 — headingFrames 옵션 */
  | { kind: "heading"; level: number; text: string }
  | { kind: "ref"; depth: number; text: string }
  | { kind: "para"; depth: number; text: string; align?: "CENTER" | "RIGHT" }
  | { kind: "attach"; text: string }
  | { kind: "summary"; text: string }
  | { kind: "block"; depth: number; block: MdBlock }

// 부호 → 단계. ❑❏ㅁ(0)·◎(1)·ㅡ‣▪▫(2)는 실무 문서(교육청·학교 결재문)에 섞여 쓰이는 변형 —
// 영문 `o`/`O`/`0`은 영문 문장 선두 오탐이라 넣지 않는다 (v4.13.0)
const BOX_MARKERS: Record<string, number> = {
  "□": 0, "■": 0, "❑": 0, "❏": 0, "ㅁ": 0,
  "○": 1, "ㅇ": 1, "◦": 1, "●": 1, "❍": 1, "◎": 1,
  "-": 2, "–": 2, "―": 2, "—": 2, "ㅡ": 2, "‣": 2, "▪": 2, "▫": 2,
  "ㆍ": 3, "·": 3, "•": 3, "∙": 3,
}
const LEGAL_RE = /^(\d{1,2}\.|[가-힣]\.|\d{1,2}\)|[가-힣]\)|\(\d{1,2}\)|\([가-힣]\)|[①-⑳]|[㉮-㉻])\s+/u
/**
 * 부호를 그대로 남기는 선두 글리프 — 중앙부처 업무보고 실측: 9대 과제 ❶~❿(U+2776~)·➊~➓(U+278A~) 0단계,
 * ⇒ 결론 0단계, ↳ 부연 1단계. 스킴 marker 로 바꾸지 않고 depth 만 강제한다(keepMarkers 옵션).
 */
const KEEP_MARKERS: Record<string, number> = { "⇒": 0, "↳": 1, "☞": 0, "▸": 3 }
/** ▸ — 서울 방침서 4단계(- 아래 사례·수치 나열, 한컴돋움 13) */
const KEEP_RE = /^([❶-❿➊-➓⇒↳☞▸])\s*/u
const BOX_RE = /^([□■❑❏ㅁ○ㅇ◦●❍◎\-–―—ㅡ‣▪▫ㆍ·•∙])\s+/u
/** 부호에 여는 부호가 바로 붙은 항목("ㅇ『2024 …』에 따르면", "ㅇ「법」") — 자모 ㅇ 뒤에 낫표·괄호·따옴표가 오면 낱말일 수 없다 */
const BOX_TIGHT_RE = /^([□■ㅇ○])(?=[「『‘“(（[【])/u
/** ※·＊ 선두, 또는 '* ' (별표 뒤 공백). `**굵게**:` 로 시작하는 항목의 `**` 는 참고 부호가 아니다 */
const REF_RE = /^(※|＊|\*(?=\s))\s*/u
const BUNIM_RE = /^붙\s*임(?:\s|:|$)/
/** 출처·자료·근거 표기 항목 — 본문 항목이 아니라 ※ 참고(작은 글씨)로 */
const SOURCE_RE = /^(출처|자료|근거|참고)\s*[:：]/
/** 법령 인용 뒤 붙는 법제처 MST·ID 코드 "(282791)" — 공문에 쓰지 않는 내부 식별자라 벗긴다 */
/** 장 제목 선두 번호 "Ⅰ. " "1. " "가. " — 서울 방침서 장 상자 번호는 작성자마다 다르다(상자 있는 15건: 로마 숫자 8·아라비아 숫자 6·가나다 1) */
export const CHAPTER_LABEL_RE = /^([ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]+|\d{1,2}|[가-하])[.)]\s+/u
const LAW_CODE_RE = /((?:법률|기본법|특별법|법|령|규칙|조례|규정|고시|훈령|예규|지침)[」』]?)\s*\((\d{5,8})\)/gu

/**
 * 공문에 남으면 안 되는 내부 식별자·도구 흔적: 법령 코드 "(282791)", KOSIS 표 ID "DT_1YL21161",
 * "(법정동코드 11215-10700)", "…, 통계 MCP 조회"류 도구 언급. 출처는 기관·자료명만 남긴다.
 */
export function stripLawCodes(text: string): string {
  return text
    .replace(LAW_CODE_RE, "$1")
    .replace(/[,，]?\s*\(?\bDT_[A-Z0-9_]+\)?/g, "")
    .replace(/\s*\((?:법정동|행정동|시군구|지역)?\s*코드\s*[\d-]+\)/g, "")
    .replace(/[,，]?\s*[가-힣A-Za-z·]*\s*MCP\s*(?:조회|호출|응답)?/g, "")
    .replace(/\s+([,，.])/g, "$1")
    .replace(/[,，]\s*$/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
}

export function legalMarkerDepth(marker: string): number {
  if (/^\d{1,2}\.$/.test(marker)) return 0
  if (/^[가-힣]\.$/.test(marker)) return 1
  if (/^\d{1,2}\)$/.test(marker)) return 2
  if (/^[가-힣]\)$/.test(marker)) return 3
  if (/^\(\d{1,2}\)$/.test(marker)) return 4
  if (/^\([가-힣]\)$/.test(marker)) return 5
  if (/^[①-⑳]$/u.test(marker)) return 6
  return 7
}

/** 선두 명시 부호 해석 — {kind, depth, marker, rest}. keep = ❶⇒↳ 등 글리프 보존 부호(keepMarkers 옵션일 때만) */
export function parseLeadingMarker(text: string, keepMarkers = false): { kind: "box" | "legal" | "ref" | "keep" | null; depth: number; marker: string; rest: string } {
  // 굵게가 부호를 감싼 줄("**ㅇ 전문가 자문회의** (4회)") — 부호를 굵게 밖으로 꺼낸다(항목 굵기는 스킴이 정한다)
  const t = text.replace(/^[\s　]+/, "")
    .replace(/^(\*\*|__)([□■ㅇ○◦●❍◎▸※-])\1(?=\s|$)/u, "$2")
    .replace(/^(\*\*|__)([□■ㅇ○◦●❍◎▸※-])\s*(?=\S)/u, "$2 $1")
  const ref = REF_RE.exec(t)
  if (ref) return { kind: "ref", depth: 0, marker: ref[1], rest: t.slice(ref[0].length).trim() }
  if (keepMarkers) {
    const keep = KEEP_RE.exec(t)
    if (keep) return { kind: "keep", depth: KEEP_MARKERS[keep[1]] ?? 0, marker: keep[1], rest: t.slice(keep[0].length).trim() }
  }
  const box = BOX_RE.exec(t) ?? BOX_TIGHT_RE.exec(t)
  if (box) return { kind: "box", depth: BOX_MARKERS[box[1]] ?? 3, marker: box[1], rest: t.slice(box[0].length).trim() }
  const legal = LEGAL_RE.exec(t)
  if (legal) return { kind: "legal", depth: legalMarkerDepth(legal[1]), marker: legal[1], rest: t.slice(legal[0].length).trim() }
  return { kind: null, depth: 0, marker: "", rest: t }
}

/** 숫자 부호 갈래 — "3." → "1.", "2)" → "1)", "②" → "①", "나." → "가.", "(나)" → "(가)" */
function numberClass(marker: string): string {
  return marker.replace(/\d{1,2}/, "1").replace(/[가-힣]/, "가").replace(/[①-⑳]/u, "①").replace(/[㉮-㉻]/u, "㉮")
}

/**
 * 숫자 위계 원고(서울 방침서 16건 중 1: "1." → "1)" → "①" → "-") — □·ㅇ 부호가 없고 숫자 부호 갈래가 둘 이상이면
 * 갈래가 처음 나온 순서를 단계로 삼는다(1.→0 1)→1 ①→2). 한 갈래뿐인 번호 목록은 위계가 아니라 목록이라 null.
 */
function numberRanks(blocks: MdBlock[]): Map<string, number> | null {
  const order: string[] = []
  for (const b of blocks) {
    if (b.type !== "list_item" && b.type !== "paragraph") continue
    const lm = parseLeadingMarker((b.text ?? "").trim())
    if (lm.kind === "box" && lm.depth <= 1) return null
    const m = b.type === "list_item" && b.ordered ? b.marker : lm.kind === "legal" ? lm.marker : null
    if (m && !order.includes(numberClass(m))) order.push(numberClass(m))
  }
  return order.length >= 2 ? new Map(order.map((c, i) => [c, i])) : null
}

export interface OutlineOptions {
  /** 개조식 스킴이면 명시 법정 부호를 소제목으로 보존, 법정 스킴이면 항목으로 재부호 */
  gaejosik: boolean
  /** 제목(h1)을 아웃라인에서 소비할지 — 기안문은 두문 제목으로 쓴다 */
  consumeTitle: boolean
  /** 제목 직후 인용문을 요약 박스로 (보고서형) */
  summaryFromQuote: boolean
  /** 인용문을 위치와 무관하게 전부 요약 박스로 (업무보고형 — 장·절마다 성과 요약 박스) */
  quoteBox?: boolean
  /** h3~h6 을 항목이 아니라 heading 노드로 남기고 리스트 깊이에도 영향을 주지 않는다 (업무보고형 절·소제목·항목 띠) */
  headingFrames?: boolean
  /** ❶➊⇒↳ 선두 글리프를 보존한 항목으로 (업무보고형) */
  keepMarkers?: boolean
  /** 부호 없는 마크다운 리스트를 직전 명시 부호 항목의 한 단계 아래로 ("ㅇ …" 뒤 "- …" → -) — 서울 방침서.
   *  업무보고(headingFrames)는 이 동작을 늘 켠다 */
  listUnderMarker?: boolean
  /** 숫자 위계 원고(numberRanks)면 숫자 부호를 보존한 항목으로 — 서울 방침서 */
  numbered?: boolean
}

export interface Outline {
  title: string | null
  nodes: OutlineNode[]
  /** 본문에 □/ㅇ 명시 부호가 있었는지 — 기안문 개조식형 자동감지 */
  hasBoxMarkers: boolean
  /** 숫자 위계 원고(1. → 1) → ①) — numbered 옵션일 때만 */
  numbered: boolean
  /** 장(h2) 수 */
  chapters: number
}

export function buildOutline(blocks: MdBlock[], opts: OutlineOptions): Outline {
  const nodes: OutlineNode[] = []
  let title: string | null = null
  let chapters = 0
  let headingDepth = -1   // 현재 장 안의 마지막 h3+ 항목 depth (-1 = 없음)
  let lastItemDepth = -1  // 마지막 항목 depth (참고·표 들여쓰기 기준)
  let seenBody = false    // 제목·요약 이후 본문(항목·장) 시작 여부
  let hasBoxMarkers = false

  /**
   * 업무보고(headingFrames): 부호 없는 마크다운 리스트는 직전 명시 부호 항목의 한 단계 아래에서 시작한다
   * ("ㅇ (먹거리) …" 문단 뒤 "- 신선란 …" → -(2단계)). 명시 부호·문단·헤딩이 나오면 리셋. 값 -1 = 미확정
   */
  let listBase = -1
  /** 부호 항목 아래 목록의 첫 항목 들여쓰기 — 원고가 "ㅇ …" 아래 목록을 들여 써도("    - 세부") 단계는 listBase 부터 센다 */
  let listIndent = 0
  let lastExplicitDepth = -1
  const pushItem = (depth: number, text: string, legalMarker?: string, fromHeading = false, marker?: string, explicit = true) => {
    nodes.push({ kind: "item", depth, text, ...(legalMarker ? { legalMarker } : {}), ...(fromHeading ? { fromHeading: true } : {}), ...(marker ? { marker } : {}) })
    lastItemDepth = depth
    seenBody = true
    if (explicit) { lastExplicitDepth = depth; listBase = -1 }
  }
  const keep = !!opts.keepMarkers
  const ranks = opts.numbered ? numberRanks(blocks) : null

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    switch (b.type) {
      case "heading": {
        const lvl = b.level ?? 1
        const raw = stripLawCodes((b.text ?? "").trim())
        if (lvl === 1 && title === null && opts.consumeTitle) { title = stripChapterNumber(raw) || raw; break }
        if (lvl <= 2) {
          const label = CHAPTER_LABEL_RE.exec(raw)?.[1]
          nodes.push({ kind: "chapter", text: stripChapterNumber(raw) || raw, index: ++chapters, ...(label ? { label } : {}) })
          lastExplicitDepth = -1; listBase = -1
          // 법정 스킴: h2가 1단계(1.)를 차지하므로 아래 리스트는 가.부터 (개조식은 장이 별도 층)
          headingDepth = opts.gaejosik ? -1 : 0; lastItemDepth = opts.gaejosik ? -1 : 0; seenBody = true
          break
        }
        // 업무보고형: h3~h6 은 서식 틀(절 띠·소제목 박스·항목 띠) — 리스트 깊이는 그대로 □부터
        if (opts.headingFrames) {
          const lm = parseLeadingMarker(raw, keep)
          nodes.push({ kind: "heading", level: lvl, text: lm.kind === "legal" || lm.kind === "keep" ? lm.rest : raw })
          lastItemDepth = -1; lastExplicitDepth = -1; listBase = -1; seenBody = true
          break
        }
        // h3+ → 항목. 선두 법정 부호("가. ")는 벗긴다 — 스킴이 부호를 다시 붙인다
        const depth = Math.min(lvl - 3, 7)
        const lm = parseLeadingMarker(raw)
        pushItem(depth, lm.kind ? lm.rest : raw, undefined, true)
        headingDepth = depth
        break
      }
      case "list_item": {
        const text = stripLawCodes((b.text ?? "").trim())
        const lm = parseLeadingMarker(text, keep)
        if (SOURCE_RE.test(lm.kind === "box" || lm.kind === "legal" ? lm.rest : text)) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.kind ? lm.rest : text }); break }
        if (b.marker === "*" && !/^\*/.test(text) && opts.gaejosik) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text }); break }
        if (lm.kind === "ref") { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.rest }); break }
        if (ranks && b.ordered && b.marker) { pushItem(Math.min(ranks.get(numberClass(b.marker)) ?? 0, 7), text, undefined, false, b.marker); break }
        if (lm.kind === "box") { hasBoxMarkers = true; pushItem(lm.depth, lm.rest); break }
        if (lm.kind === "keep") { pushItem(lm.depth, lm.rest, undefined, false, lm.marker); break }
        if (lm.kind === "legal" && opts.gaejosik) { pushItem(Math.max(lastItemDepth, 0), lm.rest, lm.marker); break }
        let base = headingDepth >= 0 ? headingDepth + 1 : 0
        let indent = b.indent ?? 0
        if (opts.headingFrames || opts.listUnderMarker) {
          if (listBase < 0) { listBase = lastExplicitDepth + 1; listIndent = lastExplicitDepth >= 0 ? indent : 0 }
          base = listBase
          indent = Math.max(0, indent - listIndent)
        }
        pushItem(Math.min(base + indent, 7), lm.kind === "legal" ? lm.rest : text, undefined, false, undefined, false)
        break
      }
      case "paragraph": {
        // 줄 전체를 굵게로 감싼 붙임("**붙임 운영기준 1부.  끝.**") — 붙임 서식이 굵기를 정한다
        const text = stripLawCodes((b.text ?? "").trim()).replace(/^\*\*(붙\s*임[^*]*)\*\*$/, "$1")
        if (!text) break
        if (BUNIM_RE.test(text) || (nodes.length && nodes[nodes.length - 1].kind === "attach" && /^\s/.test(b.text ?? ""))) {
          nodes.push({ kind: "attach", text: b.text ?? "" }); break
        }
        const ctr = /^<center>([\s\S]*)<\/center>$/i.exec(text)
        if (ctr) { nodes.push({ kind: "para", depth: 0, text: ctr[1].trim(), align: "CENTER" }); break }
        const rgt = /^<right>([\s\S]*)<\/right>$/i.exec(text)
        if (rgt) { nodes.push({ kind: "para", depth: 0, text: rgt[1].trim(), align: "RIGHT" }); break }
        const lm = parseLeadingMarker(text, keep)
        if (lm.kind === "ref") { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.rest }); break }
        if (SOURCE_RE.test(lm.kind ? lm.rest : text)) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.kind ? lm.rest : text }); break }
        if (lm.kind === "box") { hasBoxMarkers = true; pushItem(lm.depth, lm.rest); break }
        if (lm.kind === "keep") { pushItem(lm.depth, lm.rest, undefined, false, lm.marker); break }
        if (lm.kind === "legal") {
          if (ranks) pushItem(Math.min(ranks.get(numberClass(lm.marker)) ?? 0, 7), lm.rest, undefined, false, lm.marker)
          else if (opts.gaejosik) pushItem(Math.max(lastItemDepth, 0), lm.rest, lm.marker)
          else pushItem(lm.depth, lm.rest)
          break
        }
        nodes.push({ kind: "para", depth: 0, text })
        seenBody = true
        lastExplicitDepth = -1; listBase = -1
        break
      }
      case "blockquote": {
        const lines = stripLawCodes(b.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
        if (!lines.length) break
        // 요약박스는 줄 경계 보존(3줄 개조식 요약), 참고는 한 문단. quoteBox(업무보고)는 위치 무관 전부 박스
        if (opts.quoteBox || (opts.summaryFromQuote && !seenBody)) nodes.push({ kind: "summary", text: lines.join("\n") })
        else nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lines.join(" ").replace(/^※\s*/, "") })
        break
      }
      default:
        nodes.push({ kind: "block", depth: lastItemDepth, block: b })
        seenBody = true
    }
  }
  return { title, nodes, hasBoxMarkers, numbered: !!ranks, chapters }
}
