/**
 * Markdown → HWPX 역변환
 *
 * 지원: 헤딩(h1~h6), 단락, 볼드, 이탤릭, 인라인코드, 코드블록,
 *       순서/비순서 리스트, 수평선, 인용문, 테이블
 * jszip으로 HWPX ZIP 패키징.
 */

import JSZip from "jszip"

const NS_SECTION = "http://www.hancom.co.kr/hwpml/2011/section"
const NS_PARA = "http://www.hancom.co.kr/hwpml/2011/paragraph"
const NS_HEAD = "http://www.hancom.co.kr/hwpml/2011/head"
const NS_OPF = "http://www.idpf.org/2007/opf/"
const NS_HPF = "http://www.hancom.co.kr/schema/2011/hpf"
const NS_OCF = "urn:oasis:names:tc:opendocument:xmlns:container"

// ─── 스타일 ID 매핑 ─────────────────────────────────
// charPr: 0=본문, 1=볼드, 2=이탤릭, 3=볼드이탤릭, 4=인라인코드, 5=h1, 6=h2, 7=h3, 8=h4~h6
// paraPr: 0=본문, 1=h1, 2=h2, 3=h3, 4=h4~h6, 5=코드블록, 6=인용문, 7=리스트

const CHAR_NORMAL = 0
const CHAR_BOLD = 1
const CHAR_ITALIC = 2
const CHAR_BOLD_ITALIC = 3
const CHAR_CODE = 4
const CHAR_H1 = 5
const CHAR_H2 = 6
const CHAR_H3 = 7
const CHAR_H4 = 8

const PARA_NORMAL = 0
const PARA_H1 = 1
const PARA_H2 = 2
const PARA_H3 = 3
const PARA_H4 = 4
const PARA_CODE = 5
const PARA_QUOTE = 6
const PARA_LIST = 7

/**
 * 마크다운 텍스트를 HWPX (ArrayBuffer)로 변환.
 */
export async function markdownToHwpx(markdown: string): Promise<ArrayBuffer> {
  const blocks = parseMarkdownToBlocks(markdown)
  const sectionXml = blocksToSectionXml(blocks)

  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip", { compression: "STORE" })
  zip.file("META-INF/container.xml", generateContainerXml())
  zip.file("Contents/content.hpf", generateManifest())
  zip.file("Contents/header.xml", generateHeaderXml())
  zip.file("Contents/section0.xml", sectionXml)
  // Preview/ — 한글 프로그램의 일부 버전(특히 macOS)이 존재 여부를 확인함
  zip.file("Preview/PrvText.txt", buildPrvText(blocks))

  return await zip.generateAsync({ type: "arraybuffer" })
}

/** Preview/PrvText.txt — 문서 앞부분 텍스트 스냅샷 (최대 1KB) */
function buildPrvText(blocks: MdBlock[]): string {
  const lines: string[] = []
  let bytes = 0
  for (const b of blocks) {
    const text = b.text || (b.rows ? b.rows.map(r => r.join(" ")).join("\n") : "")
    if (!text) continue
    lines.push(text)
    bytes += text.length * 3
    if (bytes > 1024) break
  }
  return lines.join("\n").slice(0, 1024)
}

// ─── 마크다운 파싱 ───────────────────────────────────

interface MdBlock {
  type: "paragraph" | "heading" | "table" | "code_block" | "hr" | "blockquote" | "list_item"
  text?: string
  level?: number
  rows?: string[][]
  lang?: string
  ordered?: boolean
  indent?: number
}

function parseMarkdownToBlocks(md: string): MdBlock[] {
  const lines = md.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    // 빈 줄 스킵
    if (!line.trim()) { i++; continue }

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

function parseInlineMarkdown(text: string): InlineSpan[] {
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

// ─── XML 생성 헬퍼 ───────────────────────────────────

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function generateRuns(text: string, defaultCharPr: number = CHAR_NORMAL): string {
  const spans = parseInlineMarkdown(text)
  return spans.map(span => {
    const charId = span.code || span.bold || span.italic ? spanToCharPrId(span) : defaultCharPr
    return `<hp:run charPrIDRef="${charId}"><hp:t>${escapeXml(span.text)}</hp:t></hp:run>`
  }).join("")
}

function generateParagraph(text: string, paraPrId: number = PARA_NORMAL, charPrId: number = CHAR_NORMAL): string {
  if (paraPrId === PARA_CODE) {
    // 코드블록은 인라인 파싱 안 함
    return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:t>${escapeXml(text)}</hp:t></hp:run></hp:p>`
  }
  const runs = generateRuns(text, charPrId)
  return `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0">${runs}</hp:p>`
}

function headingParaPrId(level: number): number {
  if (level === 1) return PARA_H1
  if (level === 2) return PARA_H2
  if (level === 3) return PARA_H3
  return PARA_H4
}

function headingCharPrId(level: number): number {
  if (level === 1) return CHAR_H1
  if (level === 2) return CHAR_H2
  if (level === 3) return CHAR_H3
  return CHAR_H4
}

// ─── HWPX 구조 파일 생성 ─────────────────────────────

function generateContainerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </ocf:rootfiles>
</ocf:container>`
}

function generateManifest(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:opf="${NS_OPF}" xmlns:hpf="${NS_HPF}" xmlns:hh="${NS_HEAD}">
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="no"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`
}

// ─── charPr 생성 헬퍼 ───────────────────────────────

function charPr(id: number, height: number, bold: boolean, italic: boolean, fontId: number = 0): string {
  const boldAttr = bold ? ` bold="1"` : ""
  const italicAttr = italic ? ` italic="1"` : ""
  // 볼드면 fontfaces의 bold variant(id=2: HY견고딕/Arial Black, weight=9) 참조해
  // macOS 한컴에서 합성 굵기 안 되는 케이스 커버. 코드(fontId=1)는 bold 아닌 경우에만
  // 원본 id 유지 (Consolas/함초롬돋움).
  const effFont = bold ? 2 : fontId
  return `      <hh:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="0"${boldAttr}${italicAttr}>
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`
}

// ─── paraPr 생성 헬퍼 ───────────────────────────────

function paraPr(id: number, opts: { align?: string; spaceBefore?: number; spaceAfter?: number; lineSpacing?: number; indent?: number } = {}): string {
  const { align = "JUSTIFY", spaceBefore = 0, spaceAfter = 0, lineSpacing = 160, indent = 0 } = opts
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hh:margin indent="${indent}" left="0" right="0" prev="${spaceBefore}" next="${spaceAfter}"/>
        <hh:lineSpacing type="PERCENT" value="${lineSpacing}"/>
        <hh:border borderFillIDRef="0" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`
}

function generateHeaderXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:hh="${NS_HEAD}" xmlns:hp="${NS_PARA}" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
      <hh:fontface lang="HANGUL" fontCnt="3">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="1" face="함초롬돋움" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
        <hh:font id="2" face="HY견고딕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="LATIN" fontCnt="3">
        <hh:font id="0" face="Times New Roman" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_OLDSTYLE" weight="5" proportion="4" contrast="2" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="4"/>
        </hh:font>
        <hh:font id="1" face="Consolas" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_MODERN" weight="5" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
        <hh:font id="2" face="Arial Black" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="9" proportion="0" contrast="0" strokeVariation="0" armStyle="0" letterform="0" midline="0" xHeight="0"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="HANJA" fontCnt="1">
        <hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="JAPANESE" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="OTHER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="SYMBOL" fontCnt="1">
        <hh:font id="0" face="Symbol" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
      <hh:fontface lang="USER" fontCnt="1">
        <hh:font id="0" face="굴림" type="TTF" isEmbedded="0">
          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>
        </hh:font>
      </hh:fontface>
    </hh:fontfaces>
    <hh:borderFills itemCnt="2">
      <hh:borderFill id="0" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:rightBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:topBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:bottomBorder type="NONE" width="0.1 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
        <hh:fillInfo/>
      </hh:borderFill>
      <hh:borderFill id="1" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
        <hh:fillInfo/>
      </hh:borderFill>
    </hh:borderFills>
    <hh:charProperties itemCnt="9">
${charPr(0, 1000, false, false)}
${charPr(1, 1000, true, false)}
${charPr(2, 1000, false, true)}
${charPr(3, 1000, true, true)}
${charPr(4, 900, false, false, 1)}
${charPr(5, 1800, true, false, 1)}
${charPr(6, 1400, true, false, 1)}
${charPr(7, 1200, true, false, 1)}
${charPr(8, 1100, true, false, 1)}
    </hh:charProperties>
    <hh:tabProperties itemCnt="0"/>
    <hh:numberings itemCnt="0"/>
    <hh:bullets itemCnt="0"/>
    <hh:paraProperties itemCnt="8">
${paraPr(0)}
${paraPr(1, { align: "LEFT", spaceBefore: 800, spaceAfter: 200, lineSpacing: 180 })}
${paraPr(2, { align: "LEFT", spaceBefore: 600, spaceAfter: 150, lineSpacing: 170 })}
${paraPr(3, { align: "LEFT", spaceBefore: 400, spaceAfter: 100, lineSpacing: 160 })}
${paraPr(4, { align: "LEFT", spaceBefore: 300, spaceAfter: 100, lineSpacing: 160 })}
${paraPr(5, { align: "LEFT", lineSpacing: 130, indent: 400 })}
${paraPr(6, { align: "LEFT", lineSpacing: 150, indent: 600 })}
${paraPr(7, { align: "LEFT", lineSpacing: 160, indent: 600 })}
    </hh:paraProperties>
    <hh:styles itemCnt="1">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langIDRef="1042" lockForm="0"/>
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP2018"/>
</hh:head>`
}

// ─── 섹션 속성 (공문서 표준 여백) ────────────────────

function generateSecPr(): string {
  // A4: 210mm × 297mm → 59528 × 84188 HWPUNIT (1mm ≈ 283.46 HWPUNIT)
  // 공문서 표준: 위 30mm(8504), 아래 15mm(4252), 왼쪽 20mm(5670), 오른쪽 15mm(4252)
  // 머리말 10mm(2835), 꼬리말 10mm(2835)
  return `<hp:secPr textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" outlineShapeIDRef="0" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">` +
    `<hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>` +
    `<hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>` +
    `<hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>` +
    `<hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY">` +
      `<hp:margin header="2835" footer="2835" gutter="0" left="5670" right="4252" top="8504" bottom="4252"/>` +
    `</hp:pagePr>` +
    `<hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr>` +
    `<hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr>` +
  `</hp:secPr>`
}

// ─── 테이블 생성 ─────────────────────────────────────
//
// HWPX 스펙 완전 준수 버전 — 한글 프로그램(Windows/macOS)이 문서를 거부하지 않으려면
// <hp:tbl> 필수 속성 + <hp:sz>/<hp:pos>/<hp:outMargin>/<hp:inMargin> + 각 cell의
// <hp:subList> 래퍼, <hp:cellAddr>, <hp:cellSz>, <hp:cellMargin>이 전부 있어야 함.
// 또한 테이블은 paragraph 안의 <hp:run><hp:ctrl>... 로 감싸야 한다.
//
// 이슈 #4 참고: v2.4.1 이전엔 최소 스켈레톤만 내서 macOS 한글이 "파일이 깨졌다"며 거부.

// 기본 셀 크기 (HWPUnit) — A4 기준 적당한 기본값
const TABLE_ID_BASE = 1000
let tableIdCounter = TABLE_ID_BASE
function nextTableId(): number { return ++tableIdCounter }

function generateTable(rows: string[][]): string {
  const rowCnt = rows.length
  const colCnt = Math.max(...rows.map(r => r.length), 1)
  // A4 portrait: 폭 약 44000 HWPUnit 사용 가능 → colCnt로 균등 분배
  const cellW = Math.floor(44000 / colCnt)
  const cellH = 1500  // 기본 행 높이
  const tblW = cellW * colCnt
  const tblH = cellH * rowCnt

  const tblId = nextTableId()

  const trElements = rows.map((row, rowIdx) => {
    // 부족한 셀은 빈 문자열로 채워 colCnt 맞춤
    const cells = row.length < colCnt ? [...row, ...Array(colCnt - row.length).fill("")] : row
    const tdElements = cells.map((cell, colIdx) => {
      const runs = generateRuns(cell)
      const p = `<hp:p paraPrIDRef="0" styleIDRef="0">${runs}</hp:p>`
      // <hp:tc> 필수 속성 + subList + cellAddr + cellSpan + cellSz + cellMargin
      return `<hp:tc name="" header="${rowIdx === 0 ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="1">`
        + `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${p}</hp:subList>`
        + `<hp:cellAddr colAddr="${colIdx}" rowAddr="${rowIdx}"/>`
        + `<hp:cellSpan colSpan="1" rowSpan="1"/>`
        + `<hp:cellSz width="${cellW}" height="${cellH}"/>`
        + `<hp:cellMargin left="141" right="141" top="141" bottom="141"/>`
        + `</hp:tc>`
    }).join("")
    return `<hp:tr>${tdElements}</hp:tr>`
  }).join("")

  // <hp:tbl>에 필수 속성 + <hp:sz>/<hp:outMargin>/<hp:inMargin> (pos는 inline-level 기준)
  const tblInner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/>`
    + `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>`
    + `<hp:outMargin left="0" right="0" top="0" bottom="0"/>`
    + `<hp:inMargin left="510" right="510" top="141" bottom="141"/>`
    + trElements

  const tbl = `<hp:tbl id="${tblId}" zOrder="0" numberingType="TABLE" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="1" noShading="0">${tblInner}</hp:tbl>`

  // 테이블은 paragraph 안의 run → 가 아니라 별도 p로 감쌈 (block-level inline-anchored)
  return `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${tbl}</hp:run></hp:p>`
}

// ─── 섹션 XML 생성 ──────────────────────────────────

function blocksToSectionXml(blocks: MdBlock[]): string {
  const paraXmls: string[] = []
  let isFirst = true
  // 순서 있는 목록 카운터 — indent 레벨별 별도 유지. 다른 블록 만나면 해당 레벨 리셋.
  const orderedCounters: Record<number, number> = {}
  let prevWasOrdered = false

  for (const block of blocks) {
    let xml = ""

    // 순서 있는 list_item이 아니면 카운터 전부 리셋 (연속되지 않은 목록은 다시 1부터)
    if (block.type !== "list_item" || !block.ordered) {
      if (prevWasOrdered) {
        for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
      }
      prevWasOrdered = false
    }

    switch (block.type) {
      case "heading": {
        const pId = headingParaPrId(block.level || 1)
        const cId = headingCharPrId(block.level || 1)
        xml = generateParagraph(block.text || "", pId, cId)
        break
      }
      case "paragraph":
        xml = generateParagraph(block.text || "")
        break
      case "code_block": {
        const codeLines = (block.text || "").split("\n")
        xml = codeLines.map(line => generateParagraph(line || " ", PARA_CODE)).join("\n  ")
        break
      }
      case "blockquote":
        xml = generateParagraph(block.text || "", PARA_QUOTE)
        break
      case "list_item": {
        const indent = block.indent || 0
        let marker: string
        if (block.ordered) {
          // 러닝 카운터: indent 레벨별로 증가. 하위 레벨(더 깊은 indent)은 별도 세퀀스.
          orderedCounters[indent] = (orderedCounters[indent] || 0) + 1
          // 상위 레벨 번호가 바뀌면 하위는 자동 리셋되어야 함 — 한 레벨 위로 올라갈 때 하위 카운터 초기화
          for (const k of Object.keys(orderedCounters)) {
            if (+k > indent) delete orderedCounters[+k]
          }
          marker = `${orderedCounters[indent]}. `
          prevWasOrdered = true
        } else {
          marker = "· "
          if (prevWasOrdered) {
            for (const k of Object.keys(orderedCounters)) delete orderedCounters[+k]
          }
          prevWasOrdered = false
        }
        const indentPrefix = "  ".repeat(indent)
        xml = generateParagraph(indentPrefix + marker + (block.text || ""), PARA_LIST)
        break
      }
      case "hr":
        // 수평선 — 긴 대시로 대체
        xml = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>────────────────────────────────────────</hp:t></hp:run></hp:p>`
        break
      case "table":
        if (block.rows) {
          if (isFirst) {
            // 테이블이 첫 블록이면 빈 단락에 secPr
            const secRun = `<hp:run charPrIDRef="0">${generateSecPr()}<hp:t></hp:t></hp:run>`
            paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0">${secRun}</hp:p>`)
            isFirst = false
          }
          xml = generateTable(block.rows)
        }
        break
    }

    if (!xml) continue

    // 첫 번째 단락에 secPr 주입
    if (isFirst && block.type !== "table") {
      xml = xml.replace(
        /<hp:run charPrIDRef="(\d+)">/,
        `<hp:run charPrIDRef="$1">${generateSecPr()}`
      )
      isFirst = false
    }

    paraXmls.push(xml)
  }

  // 블록이 없으면 빈 단락
  if (paraXmls.length === 0) {
    paraXmls.push(`<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${generateSecPr()}<hp:t></hp:t></hp:run></hp:p>`)
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:hs="${NS_SECTION}" xmlns:hp="${NS_PARA}">
  ${paraXmls.join("\n  ")}
</hs:sec>`
}
