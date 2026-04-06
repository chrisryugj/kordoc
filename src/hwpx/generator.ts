/**
 * Markdown → HWPX 역변환 (MVP)
 *
 * 지원: 단락, 헤딩, 테이블 (텍스트+구조만, 스타일 없음)
 * jszip으로 HWPX ZIP 패키징.
 */

import JSZip from "jszip"
import type { IRBlock, IRTable, IRCell } from "../types.js"

const HWPML_NS = "http://www.hancom.co.kr/hwpml/2016/HwpMl"

/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 *
 * @example
 * ```ts
 * import { markdownToHwpx } from "kordoc"
 * const hwpxBuffer = await markdownToHwpx("# 제목\n\n본문 텍스트")
 * writeFileSync("output.hwpx", Buffer.from(hwpxBuffer))
 * ```
 */
export async function markdownToHwpx(markdown: string): Promise<ArrayBuffer> {
  const blocks = parseMarkdownToBlocks(markdown)
  const sectionXml = blocksToSectionXml(blocks)

  const zip = new JSZip()

  // mimetype (압축 없이)
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })

  // 매니페스트
  zip.file("Contents/content.hpf", generateManifest())

  // 섹션 콘텐츠
  zip.file("Contents/section0.xml", sectionXml)

  return await zip.generateAsync({ type: "arraybuffer" })
}

// ─── 마크다운 파싱 (간이) ────────────────────────────

interface MdBlock {
  type: "paragraph" | "heading" | "table"
  text?: string
  level?: number // heading level
  rows?: string[][] // table rows
}

function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

    // 헤딩
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/)
    if (headingMatch) {
      blocks.push({ type: "heading", text: headingMatch[2].trim(), level: headingMatch[1].length })
      i++; continue
    }

    // 테이블
    if (line.trimStart().startsWith("|")) {
      const tableRows: string[][] = []
      while (i < lines.length && lines[i].trimStart().startsWith("|")) {
        const row = lines[i]
        // 구분선(| --- | --- |) 스킵
        if (/^[\s|:\-]+$/.test(row)) {
          i++; continue
        }
        const cells = row.split("|").slice(1, -1).map(c => c.trim())
        if (cells.length > 0) tableRows.push(cells)
        i++
      }
      if (tableRows.length > 0) {
        blocks.push({ type: "table", rows: tableRows })
      }
      continue
    }

    // 일반 단락
    blocks.push({ type: "paragraph", text: line.trim() })
    i++
  }

  return blocks
}

// ─── HWPX XML 생성 ──────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function generateParagraph(text: string): string {
  return `<hp:p><hp:run><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
}

function generateTable(rows: string[][]): string {
  const trElements = rows.map(row => {
    const tdElements = row.map(cell =>
      `<hp:tc><hp:cellSpan colSpan="1" rowSpan="1"/>${generateParagraph(cell)}</hp:tc>`
    ).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")
  return `<hp:tbl>${trElements}</hp:tbl>`
}

function blocksToSectionXml(blocks: MdBlock[]): string {
  const body = blocks.map(block => {
    switch (block.type) {
      case "heading":
        return generateParagraph(block.text || "")
      case "table":
        return block.rows ? generateTable(block.rows) : ""
      case "paragraph":
        return generateParagraph(block.text || "")
      default:
        return ""
    }
  }).join("\n  ")

  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="${HWPML_NS}" xmlns:hp="${HWPML_NS}">
  ${body}
</hs:sec>`
}

function generateManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf">
  <opf:manifest>
    <opf:item id="s0" href="section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="s0"/>
  </opf:spine>
</opf:package>`
}
