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

  // META-INF/container.xml — 루트파일 위치 지정
  zip.file("META-INF/container.xml", generateContainerXml())

  // 매니페스트 (HWPX 네이티브 포맷)
  zip.file("Contents/content.hpf", generateManifest())

  // 헤더 (페이지 레이아웃, 폰트 정의)
  zip.file("Contents/header.xml", generateHeaderXml())

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

// ─── HWPX 구조 파일 생성 ────────────────────────────

/** A4 페이지 기본 크기 (HWPX 단위) */
const PAGE_WIDTH = 59528
const PAGE_HEIGHT = 84188

/** A4 기본 여백 (HWPX 단위) */
const MARGIN_LEFT = 8504
const MARGIN_RIGHT = 8504
const MARGIN_TOP = 5668
const MARGIN_BOTTOM = 4252
const MARGIN_HEADER = 4252
const MARGIN_FOOTER = 4252

/** 기본 폰트 크기 (HWPX 단위, 10pt = 1000) */
const DEFAULT_FONT_SIZE = 1000

/** 기본 폰트 이름 */
const DEFAULT_FONT_FACE = "바탕"

function generateContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0">
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwp+zip"/>
  </rootfiles>
</container>`
}

function generateManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hpf:package xmlns:hpf="${HWPML_NS}">
  <hpf:manifest>
    <hpf:item id="header" href="header.xml" media-type="application/xml"/>
    <hpf:item id="s0" href="section0.xml" media-type="application/xml"/>
  </hpf:manifest>
  <hpf:spine>
    <hpf:itemref idref="header"/>
    <hpf:itemref idref="s0"/>
  </hpf:spine>
</hpf:package>`
}

function generateHeaderXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hs:header xmlns:hs="${HWPML_NS}"
           xmlns:hp="${HWPML_NS}">
  <hp:beginNum page="1"/>
  <hp:refList>
    <hp:fontfaces>
      <hp:fontface lang="HANGUL">
        <hp:font face="${DEFAULT_FONT_FACE}" type="TTF"/>
      </hp:fontface>
      <hp:fontface lang="LATIN">
        <hp:font face="${DEFAULT_FONT_FACE}" type="TTF"/>
      </hp:fontface>
    </hp:fontfaces>
    <hp:charProperties>
      <hp:charPr id="0">
        <hp:sz val="${DEFAULT_FONT_SIZE}"/>
      </hp:charPr>
    </hp:charProperties>
  </hp:refList>
  <hp:secDef>
    <hp:pageDef landscape="NARROWLY" width="${PAGE_WIDTH}" height="${PAGE_HEIGHT}"
      gutterType="LEFT_ONLY"
      marginLeft="${MARGIN_LEFT}" marginRight="${MARGIN_RIGHT}"
      marginTop="${MARGIN_TOP}" marginBottom="${MARGIN_BOTTOM}"
      marginHeader="${MARGIN_HEADER}" marginFooter="${MARGIN_FOOTER}"/>
  </hp:secDef>
</hs:header>`
}
