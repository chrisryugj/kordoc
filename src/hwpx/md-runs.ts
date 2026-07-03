/**
 * 마크다운 파싱 + hwpx run/문단 XML 생성 (generator.ts에서 분리).
 * 블록 분해(parseMarkdownToBlocks), 인라인 span, run/문단 조립, PrvText.
 */

import {
  CHAR_NORMAL, CHAR_BOLD, CHAR_ITALIC, CHAR_BOLD_ITALIC, CHAR_CODE,
  PARA_NORMAL, PARA_CODE,
  escapeXml,
} from "./gen-ids.js"


/** Preview/PrvText.txt — 문서 앞부분 텍스트 스냅샷 (최대 1KB) */
export function buildPrvText(blocks: MdBlock[]): string {
  const lines: string[] = []
  let bytes = 0
  for (const b of blocks) {
    let text = b.text || (b.rows ? b.rows.map(r => r.join(" ")).join("\n") : "")
    if (b.type === "html_table") text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()
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
}

export function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // Display math block: $$ ... $$
    const mathStart = line.trimStart().match(/^\$\$(.*)$/)
    if (mathStart) {
      const first = mathStart[1]
      const singleLine = first.match(/^(.*?)\$\$\s*$/)
      if (singleLine) {
        const text = singleLine[1].trim()
        if (text) blocks.push({ type: "equation", text })
        i++
        continue
      }

      const mathLines: string[] = []
      if (first.trim()) mathLines.push(first)
      i++
      while (i < lines.length) {
        const end = lines[i].indexOf("$$")
        if (end >= 0) {
          const before = lines[i].slice(0, end)
          if (before.trim()) mathLines.push(before)
          i++
          break
        }
        mathLines.push(lines[i])
        i++
      }
      const text = mathLines.join("\n").trim()
      if (text) blocks.push({ type: "equation", text })
      continue
    }

    // 코드블록
    const fenceMatch = line.match(/^(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const fence = fenceMatch[1]
      const lang = fenceMatch[2].trim()
      const codeLines: string[] = []
      i++
      while (i < lines.length && !lines[i].startsWith(fence)) {
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
    if (/^<table[\s>]/i.test(line.trimStart())) {
      const htmlLines: string[] = []
      let depth = 0
      while (i < lines.length) {
        const l = lines[i]
        htmlLines.push(l)
        depth += (l.match(/<table[\s>]/gi) ?? []).length
        depth -= (l.match(/<\/table>/gi) ?? []).length
        i++
        if (depth <= 0) break
      }
      blocks.push({ type: "html_table", text: htmlLines.join("\n") })
      continue
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        if (/^[\s|:\-]+$/.test(row)) { i++; continue }
        const cells = row.split("|").slice(1, -1).map(c => c.trim())
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) blocks.push({ type: "table", rows: tableRows })
      continue
    }

    // 인용문
    if (line.trimStart().startsWith("> ")) {
      const quoteLines: string[] = []
      while (i < lines.length && (lines[i].trimStart().startsWith("> ") || lines[i].trimStart().startsWith(">"))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""))
        i++
      }
      for (const ql of quoteLines) {
        blocks.push({ type: "blockquote", text: ql.trim() || "" })
      }
      continue
    }

    // 리스트
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)]) (.+)$/)
    if (listMatch) {
      const indent = Math.floor(listMatch[1].length / 2)
      const ordered = /\d/.test(listMatch[2])
      blocks.push({ type: "list_item", text: listMatch[3].trim(), ordered, indent })
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
}

export function parseInlineMarkdown(text: string): InlineSpan[] {
  // 전처리: 마크다운 링크/이미지 → 텍스트만 추출
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")   // ![alt](url) → alt
  text = text.replace(/\[([^\]]*)\]\(([^)]*)\)/g, (_, t, u) => t || u) // [text](url) → text or url
  // 전처리: ~~취소선~~ → 텍스트만
  text = text.replace(/~~([^~]+)~~/g, "$1")

  const spans: InlineSpan[] = []
  // 패턴: `code`, ***bolditalic***, **bold**, *italic*, __bold__, _italic_
  const regex = /(`[^`]+`|\*{3}[^*]+\*{3}|\*{2}[^*]+\*{2}|\*[^*]+\*|_{2}[^_]+_{2}|_[^_]+_)/g
  let lastIdx = 0

  for (const match of text.matchAll(regex)) {
    const idx = match.index!
    if (idx > lastIdx) {
      spans.push({ text: text.slice(lastIdx, idx), bold: false, italic: false, code: false })
    }
    const raw = match[0]
    if (raw.startsWith("`")) {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: false, code: true })
    } else if (raw.startsWith("***") || raw.startsWith("___")) {
      spans.push({ text: raw.slice(3, -3), bold: true, italic: true, code: false })
    } else if (raw.startsWith("**") || raw.startsWith("__")) {
      spans.push({ text: raw.slice(2, -2), bold: true, italic: false, code: false })
    } else {
      spans.push({ text: raw.slice(1, -1), bold: false, italic: true, code: false })
    }
    lastIdx = idx + raw.length
  }
  if (lastIdx < text.length) {
    spans.push({ text: text.slice(lastIdx), bold: false, italic: false, code: false })
  }
  if (spans.length === 0) {
    spans.push({ text, bold: false, italic: false, code: false })
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


export function generateRuns(text: string, defaultCharPr: number = CHAR_NORMAL, mapCharId?: (id: number) => number): string {
  const spans = parseInlineMarkdown(text)
  return spans.map(span => {
    let charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr
    if (mapCharId) charId = mapCharId(charId)
    return `<hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`
  }).join("")
}

export function generateParagraph(text: string, paraPrId: number = PARA_NORMAL, charPrId: number = CHAR_NORMAL, mapCharId?: (id: number) => number): string {
  if (paraPrId === PARA_CODE) {
    // 코드블록은 인라인 파싱 안 함
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
  }
  const runs = generateRuns(text, charPrId, mapCharId)
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${runs}</hp:p>`
}
