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
  | { kind: "chapter"; text: string; index: number }
  | { kind: "item"; depth: number; text: string; /** 명시 법정 부호(개조식 문서 안 소제목) */ legalMarker?: string; /** 헤딩(h3+)에서 온 항목 — 사이 문단이 번호를 끊지 않는다 */ fromHeading?: boolean }
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
const BOX_RE = /^([□■❑❏ㅁ○ㅇ◦●❍◎\-–―—ㅡ‣▪▫ㆍ·•∙])\s+/u
/** ※·＊ 선두, 또는 '* ' (별표 뒤 공백). `**굵게**:` 로 시작하는 항목의 `**` 는 참고 부호가 아니다 */
const REF_RE = /^(※|＊|\*(?=\s))\s*/u
const BUNIM_RE = /^붙\s*임(?:\s|:|$)/
/** 출처·자료·근거 표기 항목 — 본문 항목이 아니라 ※ 참고(작은 글씨)로 */
const SOURCE_RE = /^(출처|자료|근거|참고)\s*[:：]/
/** 법령 인용 뒤 붙는 법제처 MST·ID 코드 "(282791)" — 공문에 쓰지 않는 내부 식별자라 벗긴다 */
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

/** 선두 명시 부호 해석 — {kind, depth, marker, rest} */
export function parseLeadingMarker(text: string): { kind: "box" | "legal" | "ref" | null; depth: number; marker: string; rest: string } {
  const t = text.replace(/^[\s　]+/, "")
  const ref = REF_RE.exec(t)
  if (ref) return { kind: "ref", depth: 0, marker: ref[1], rest: t.slice(ref[0].length).trim() }
  const box = BOX_RE.exec(t)
  if (box) return { kind: "box", depth: BOX_MARKERS[box[1]] ?? 3, marker: box[1], rest: t.slice(box[0].length).trim() }
  const legal = LEGAL_RE.exec(t)
  if (legal) return { kind: "legal", depth: legalMarkerDepth(legal[1]), marker: legal[1], rest: t.slice(legal[0].length).trim() }
  return { kind: null, depth: 0, marker: "", rest: t }
}

export interface OutlineOptions {
  /** 개조식 스킴이면 명시 법정 부호를 소제목으로 보존, 법정 스킴이면 항목으로 재부호 */
  gaejosik: boolean
  /** 제목(h1)을 아웃라인에서 소비할지 — 기안문은 두문 제목으로 쓴다 */
  consumeTitle: boolean
  /** 제목 직후 인용문을 요약 박스로 (보고서형) */
  summaryFromQuote: boolean
}

export interface Outline {
  title: string | null
  nodes: OutlineNode[]
  /** 본문에 □/ㅇ 명시 부호가 있었는지 — 기안문 개조식형 자동감지 */
  hasBoxMarkers: boolean
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

  const pushItem = (depth: number, text: string, legalMarker?: string, fromHeading = false) => {
    nodes.push({ kind: "item", depth, text, ...(legalMarker ? { legalMarker } : {}), ...(fromHeading ? { fromHeading: true } : {}) })
    lastItemDepth = depth
    seenBody = true
  }

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    switch (b.type) {
      case "heading": {
        const lvl = b.level ?? 1
        const raw = stripLawCodes((b.text ?? "").trim())
        if (lvl === 1 && title === null && opts.consumeTitle) { title = stripChapterNumber(raw) || raw; break }
        if (lvl <= 2) {
          nodes.push({ kind: "chapter", text: stripChapterNumber(raw) || raw, index: ++chapters })
          // 법정 스킴: h2가 1단계(1.)를 차지하므로 아래 리스트는 가.부터 (개조식은 장이 별도 층)
          headingDepth = opts.gaejosik ? -1 : 0; lastItemDepth = opts.gaejosik ? -1 : 0; seenBody = true
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
        const lm = parseLeadingMarker(text)
        if (SOURCE_RE.test(lm.kind === "box" || lm.kind === "legal" ? lm.rest : text)) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.kind ? lm.rest : text }); break }
        if (b.marker === "*" && !/^\*/.test(text) && opts.gaejosik) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text }); break }
        if (lm.kind === "ref") { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.rest }); break }
        if (lm.kind === "box") { hasBoxMarkers = true; pushItem(lm.depth, lm.rest); break }
        if (lm.kind === "legal" && opts.gaejosik) { pushItem(Math.max(lastItemDepth, 0), lm.rest, lm.marker); break }
        const base = headingDepth >= 0 ? headingDepth + 1 : 0
        pushItem(Math.min(base + (b.indent ?? 0), 7), lm.kind === "legal" ? lm.rest : text)
        break
      }
      case "paragraph": {
        const text = stripLawCodes((b.text ?? "").trim())
        if (!text) break
        if (BUNIM_RE.test(text) || (nodes.length && nodes[nodes.length - 1].kind === "attach" && /^\s/.test(b.text ?? ""))) {
          nodes.push({ kind: "attach", text: b.text ?? "" }); break
        }
        const ctr = /^<center>([\s\S]*)<\/center>$/i.exec(text)
        if (ctr) { nodes.push({ kind: "para", depth: 0, text: ctr[1].trim(), align: "CENTER" }); break }
        const rgt = /^<right>([\s\S]*)<\/right>$/i.exec(text)
        if (rgt) { nodes.push({ kind: "para", depth: 0, text: rgt[1].trim(), align: "RIGHT" }); break }
        const lm = parseLeadingMarker(text)
        if (lm.kind === "ref") { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.rest }); break }
        if (SOURCE_RE.test(lm.kind ? lm.rest : text)) { nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lm.kind ? lm.rest : text }); break }
        if (lm.kind === "box") { hasBoxMarkers = true; pushItem(lm.depth, lm.rest); break }
        if (lm.kind === "legal") {
          if (opts.gaejosik) pushItem(Math.max(lastItemDepth, 0), lm.rest, lm.marker)
          else pushItem(lm.depth, lm.rest)
          break
        }
        nodes.push({ kind: "para", depth: 0, text })
        seenBody = true
        break
      }
      case "blockquote": {
        const lines = stripLawCodes(b.text ?? "").split("\n").map((l) => l.trim()).filter(Boolean)
        if (!lines.length) break
        // 요약박스는 줄 경계 보존(3줄 개조식 요약), 참고는 한 문단
        if (opts.summaryFromQuote && !seenBody) nodes.push({ kind: "summary", text: lines.join("\n") })
        else nodes.push({ kind: "ref", depth: lastItemDepth + 1, text: lines.join(" ").replace(/^※\s*/, "") })
        break
      }
      default:
        nodes.push({ kind: "block", depth: lastItemDepth, block: b })
        seenBody = true
    }
  }
  return { title, nodes, hasBoxMarkers, chapters }
}
