/**
 * DOCX 파서 단위 테스트
 *
 * jszip으로 합성 DOCX 파일 생성 → 파싱 검증
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse, detectZipFormat } from "../src/index.js"

/** 최소 DOCX 파일 생성 */
async function createDocx(bodyXml: string, opts?: {
  styles?: string
  numbering?: string
  footnotes?: string
}): Promise<ArrayBuffer> {
  const zip = new JSZip()

  // [Content_Types].xml
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`)

  // _rels/.rels
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`)

  // word/document.xml
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyXml}</w:body>
</w:document>`)

  // word/_rels/document.xml.rels
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`)

  if (opts?.styles) zip.file("word/styles.xml", opts.styles)
  if (opts?.numbering) zip.file("word/numbering.xml", opts.numbering)
  if (opts?.footnotes) zip.file("word/footnotes.xml", opts.footnotes)

  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("DOCX 파서", () => {
  it("기본 단락 파싱", async () => {
    const buffer = await createDocx(`
      <w:p><w:r><w:t>안녕하세요 DOCX 테스트입니다.</w:t></w:r></w:p>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.fileType, "docx")
    assert.ok(result.markdown.includes("안녕하세요 DOCX 테스트입니다."))
  })

  it("여러 단락 파싱", async () => {
    const buffer = await createDocx(`
      <w:p><w:r><w:t>첫 번째 문단</w:t></w:r></w:p>
      <w:p><w:r><w:t>두 번째 문단</w:t></w:r></w:p>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("첫 번째 문단"))
    assert.ok(result.markdown.includes("두 번째 문단"))
  })

  it("헤딩 스타일 감지 (outlineLvl)", async () => {
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Heading2">
    <w:name w:val="heading 2"/>
    <w:pPr><w:outlineLvl w:val="1"/></w:pPr>
  </w:style>
</w:styles>`

    const buffer = await createDocx(`
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>제1장 총칙</w:t></w:r></w:p>
      <w:p><w:r><w:t>본문 텍스트</w:t></w:r></w:p>
      <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>제1절 목적</w:t></w:r></w:p>
    `, { styles })

    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("# 제1장 총칙"))
    assert.ok(result.markdown.includes("## 제1절 목적"))
    assert.ok(result.outline && result.outline.length >= 2)
  })

  it("테이블 파싱", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>이름</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>나이</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>홍길동</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>30</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("이름"))
    assert.ok(result.markdown.includes("홍길동"))
    assert.ok(result.markdown.includes("|"))
  })

  it("테이블 셀 병합 (gridSpan)", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr>
          <w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>병합됨</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("병합됨"))
  })

  it("볼드/이탤릭 스타일 추출", async () => {
    const buffer = await createDocx(`
      <w:p>
        <w:r><w:rPr><w:b/></w:rPr><w:t>굵은 텍스트</w:t></w:r>
        <w:r><w:rPr><w:i/></w:rPr><w:t>기울인 텍스트</w:t></w:r>
      </w:p>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("굵은 텍스트"))
    assert.ok(result.markdown.includes("기울인 텍스트"))
    // blocks에 스타일 정보 있는지 확인
    const styledBlock = result.blocks.find(b => b.style?.bold || b.style?.italic)
    assert.ok(styledBlock, "스타일 정보가 있어야 함")
  })

  it("포맷이 docx로 감지", async () => {
    const buffer = await createDocx(`<w:p><w:r><w:t>test</w:t></w:r></w:p>`)
    const format = await detectZipFormat(buffer)
    assert.equal(format, "docx")
  })

  it("메타데이터 추출", async () => {
    const buffer = await createDocx(`<w:p><w:r><w:t>test</w:t></w:r></w:p>`)
    const zip = await JSZip.loadAsync(buffer)
    zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/">
  <dc:title>보고서</dc:title>
  <dc:creator>김철수</dc:creator>
</cp:coreProperties>`)
    const newBuffer = await zip.generateAsync({ type: "arraybuffer" })
    const result = await parse(newBuffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.metadata?.title, "보고서")
    assert.equal(result.metadata?.author, "김철수")
  })

  it("빈 DOCX는 에러 없이 처리", async () => {
    const buffer = await createDocx("")
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.markdown, "")
  })
})
