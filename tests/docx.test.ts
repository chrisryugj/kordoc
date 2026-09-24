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
  /** word/_rels/document.xml.rels 안에 넣을 <Relationship> 항목들 */
  relationships?: string
  /** ZIP에 추가할 부가 파일 (예: word/media/image1.png) */
  files?: Record<string, string | Uint8Array>
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
${opts?.relationships ?? ""}
</Relationships>`)

  if (opts?.styles) zip.file("word/styles.xml", opts.styles)
  if (opts?.numbering) zip.file("word/numbering.xml", opts.numbering)
  if (opts?.footnotes) zip.file("word/footnotes.xml", opts.footnotes)
  if (opts?.files) {
    for (const [path, data] of Object.entries(opts.files)) zip.file(path, data)
  }

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

  it("테이블 gridBefore — 행 앞 스킵 그리드로 셀이 왼쪽으로 밀리지 않고 올바른 열 배치", async () => {
    // 자료손상 회귀: w:trPr/w:gridBefore 미처리 시 D가 A열로 무음 오배치되던 버그
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>C</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:trPr><w:gridBefore w:val="1"/></w:trPr>
          <w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>E</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    const dataRow = result.markdown.split("\n").find(l => l.includes("D") && l.includes("E"))
    assert.ok(dataRow, `D·E 행을 찾지 못함: ${result.markdown}`)
    const cells = dataRow.split("|").map(s => s.trim())
    // "|  | D | E |" → ["", "", "D", "E", ""]. gridBefore=1이라 첫 열은 빔.
    assert.equal(cells[1], "", `첫 열은 비어야 함(gridBefore=1): ${dataRow}`)
    assert.equal(cells[2], "D", `D는 둘째 열이어야 함: ${dataRow}`)
    assert.equal(cells[3], "E", `E는 셋째 열이어야 함: ${dataRow}`)
  })

  it("hwp5-5: 음수 gridBefore(기형 docx)는 클램프돼 첫 셀이 소실되지 않는다", async () => {
    // 2fffadd 가 연 신규 경로: gridBefore 음수 → colAddr=-1 → 첫 셀이 무음 탈락하던 회귀
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc>
        </w:tr>
        <w:tr>
          <w:trPr><w:gridBefore w:val="-1"/></w:trPr>
          <w:tc><w:p><w:r><w:t>D</w:t></w:r></w:p></w:tc>
          <w:tc><w:p><w:r><w:t>E</w:t></w:r></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.match(result.markdown, /D/, "음수 gridBefore 여도 첫 셀 D 가 보존돼야 함(col 0 클램프)")
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

  it("sdt(콘텐츠 컨트롤) 안의 인라인 run 텍스트 추출 — Google Docs 익스포트", async () => {
    // <w:p><w:sdt><w:sdtContent><w:r><w:t>...</w:t></w:r></w:sdtContent></w:sdt></w:p>
    const buffer = await createDocx(`
      <w:p><w:sdt><w:sdtPr><w:tag w:val="goog_rdk_6"/></w:sdtPr><w:sdtContent>
        <w:r><w:t>콘텐츠 컨트롤 안의 텍스트</w:t></w:r>
      </w:sdtContent></w:sdt></w:p>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("콘텐츠 컨트롤 안의 텍스트"), `markdown: ${result.markdown}`)
  })

  it("블록 sdt로 감싼 문단/표 추출", async () => {
    const buffer = await createDocx(`
      <w:sdt><w:sdtContent>
        <w:p><w:r><w:t>블록 컨트롤 문단</w:t></w:r></w:p>
      </w:sdtContent></w:sdt>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("블록 컨트롤 문단"), `markdown: ${result.markdown}`)
  })

  it("sdt 안의 표 셀 텍스트 추출", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr>
          <w:tc><w:p><w:sdt><w:sdtContent><w:r><w:t>성명</w:t></w:r></w:sdtContent></w:sdt></w:p></w:tc>
          <w:tc><w:p><w:sdt><w:sdtContent><w:r><w:t>홍길동</w:t></w:r></w:sdtContent></w:sdt></w:p></w:tc>
        </w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("성명"), `markdown: ${result.markdown}`)
    assert.ok(result.markdown.includes("홍길동"), `markdown: ${result.markdown}`)
  })

  it("깨진 styles.xml — 무시 대신 PARTIAL_PARSE 경고 + 본문 파싱 계속", async () => {
    const buffer = await createDocx(
      `<w:p><w:r><w:t>본문은 살아있다</w:t></w:r></w:p>`,
      { styles: `<w:styles xmlns:w="x"><w:style` },
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("본문은 살아있다"), "본문 파싱 계속")
    assert.ok(result.warnings?.some(w => w.code === "PARTIAL_PARSE" && w.message.includes("styles.xml")),
      `경고 목록: ${JSON.stringify(result.warnings)}`)
  })
})

describe("DOCX vMerge continue 셀 내용 보존 (리뷰 #18)", () => {
  it("위 셀이 있는 continue 셀 내용은 시작 셀로 합류한다", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>고아내용</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("고아내용"), `continue 셀 내용 소실: ${result.markdown}`)
  })

  it("첫 행 고아 continue 셀은 일반 셀로 승격한다", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p><w:r><w:t>첫행고아</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("첫행고아"), `고아 continue 셀 소실: ${result.markdown}`)
  })

  it("정상 병합(restart + 빈 continue)은 기존대로 rowSpan 흡수", async () => {
    const buffer = await createDocx(`
      <w:tbl>
        <w:tr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr><w:p><w:r><w:t>병합시작</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
        <w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr><w:p></w:p></w:tc><w:tc><w:p><w:r><w:t>B2</w:t></w:r></w:p></w:tc></w:tr>
      </w:tbl>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("병합시작"))
    assert.ok(result.markdown.includes('rowspan="2"'), `rowSpan 병합 깨짐: ${result.markdown}`)
  })
})

describe("DOCX 하이퍼링크 (손실 수정)", () => {
  const REL = (id: string, target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>`

  it("외부 하이퍼링크(w:hyperlink r:id) → [text](url)", async () => {
    const buffer = await createDocx(
      `<w:p><w:hyperlink r:id="rId100"><w:r><w:t>외부링크</w:t></w:r></w:hyperlink></w:p>`,
      { relationships: REL("rId100", "https://example.com/ext") },
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("[외부링크](https://example.com/ext)"), `markdown: ${result.markdown}`)
  })

  it("한 문단 안 하이퍼링크 여러 개 — 모두 보존(문단당 1개 붕괴 수정)", async () => {
    const buffer = await createDocx(
      `<w:p>
        <w:hyperlink r:id="rId100"><w:r><w:t>링크A</w:t></w:r></w:hyperlink>
        <w:r><w:t> 그리고 </w:t></w:r>
        <w:hyperlink r:id="rId101"><w:r><w:t>링크B</w:t></w:r></w:hyperlink>
      </w:p>`,
      { relationships: REL("rId100", "https://a.example") + REL("rId101", "https://b.example") },
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("[링크A](https://a.example)"), `링크A 손실: ${result.markdown}`)
    assert.ok(result.markdown.includes("[링크B](https://b.example)"), `링크B 손실: ${result.markdown}`)
  })

  it("필드코드 HYPERLINK (w:fldSimple) → [text](url)", async () => {
    const buffer = await createDocx(
      `<w:p><w:fldSimple w:instr=' HYPERLINK &quot;https://example.com/simple&quot; '><w:r><w:t>심플링크</w:t></w:r></w:fldSimple></w:p>`,
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("[심플링크](https://example.com/simple)"), `markdown: ${result.markdown}`)
  })

  it("필드코드 HYPERLINK (w:fldChar begin/separate/end) → [text](url)", async () => {
    const buffer = await createDocx(
      `<w:p>
        <w:r><w:fldChar w:fldCharType="begin"/></w:r>
        <w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/field" </w:instrText></w:r>
        <w:r><w:fldChar w:fldCharType="separate"/></w:r>
        <w:r><w:t>필드링크</w:t></w:r>
        <w:r><w:fldChar w:fldCharType="end"/></w:r>
      </w:p>`,
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("[필드링크](https://example.com/field)"), `markdown: ${result.markdown}`)
  })

  it("내부 앵커 하이퍼링크(w:anchor) → [text](#anchor)", async () => {
    const buffer = await createDocx(
      `<w:p><w:hyperlink w:anchor="_Toc123"><w:r><w:t>목차항목</w:t></w:r></w:hyperlink></w:p>`,
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("[목차항목](#_Toc123)"), `markdown: ${result.markdown}`)
  })
})

describe("DOCX 이미지 본문 링크 (누락 수정)", () => {
  const IMG_REL = `<Relationship Id="rId200" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>`
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  it("문단 내 이미지가 본문에 ![image](...)로 삽입되고 파일도 반환", async () => {
    const buffer = await createDocx(
      `<w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId200"/></w:drawing></w:r></w:p>`,
      { relationships: IMG_REL, files: { "word/media/image1.png": PNG } },
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.match(result.markdown, /!\[image\]\(image_001\.png\)/, `이미지 링크 누락: ${result.markdown}`)
    assert.ok(result.images && result.images.length === 1, `이미지 반환 안 됨: ${JSON.stringify(result.images?.length)}`)
  })

  it("텍스트 문단 뒤 이미지 — 순서 보존 링크", async () => {
    const buffer = await createDocx(
      `<w:p><w:r><w:t>그림 설명</w:t></w:r></w:p>
       <w:p><w:r><w:drawing><a:blip xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" r:embed="rId200"/></w:drawing></w:r></w:p>`,
      { relationships: IMG_REL, files: { "word/media/image1.png": PNG } },
    )
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("그림 설명"), `텍스트 손실: ${result.markdown}`)
    assert.ok(result.markdown.indexOf("그림 설명") < result.markdown.indexOf("![image]"), `이미지가 텍스트 앞에 옴: ${result.markdown}`)
  })
})

describe("DOCX 텍스트박스 수식 이중 방출 방지 (리뷰 #19)", () => {
  it("텍스트박스 안 수식은 텍스트박스 블록에서 1회만 나온다", async () => {
    const math = `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><m:r><m:t>E=mc</m:t></m:r></m:oMath>`
    const buffer = await createDocx(`
      <w:p>
        <w:r>
          <mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
            <mc:Choice Requires="wps">
              <w:drawing><wps:txbx xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">
                <w:txbxContent><w:p><w:r><w:t>박스텍스트</w:t></w:r>${math}</w:p></w:txbxContent>
              </wps:txbx></w:drawing>
            </mc:Choice>
            <mc:Fallback>
              <w:pict><v:textbox xmlns:v="urn:schemas-microsoft-com:vml">
                <w:txbxContent><w:p><w:r><w:t>박스텍스트</w:t></w:r>${math}</w:p></w:txbxContent>
              </v:textbox></w:pict>
            </mc:Fallback>
          </mc:AlternateContent>
        </w:r>
      </w:p>
    `)
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    const count = (result.markdown.match(/E=mc/g) ?? []).length
    assert.equal(count, 1, `수식이 ${count}회 방출됨 (기대 1): ${result.markdown}`)
  })
})

describe("DOCX 머리글·바닥글 1회 방출 (HWPX 머리말 정책)", () => {
  const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`
  const part = (tag: "hdr" | "ftr", inner: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:${tag} ${W}>${inner}</w:${tag}>`
  const p = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`
  /** "앞말" + PAGE 필드(캐시 표시값 cached) + "뒷말" */
  const pageField = (before: string, cached: string, after: string) =>
    `<w:p><w:r><w:t xml:space="preserve">${before}</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r>` +
    `<w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>` +
    `<w:r><w:t>${cached}</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t xml:space="preserve">${after}</w:t></w:r></w:p>`
  const rel = (id: string, kind: "header" | "footer", target: string) =>
    `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${kind}" Target="${target}"/>`

  it("머리글은 본문 앞·바닥글은 끝에 한 번, 쪽 번호만 남는 바닥글은 뺀다", async () => {
    const body = `<w:p><w:r><w:t>본문</w:t></w:r></w:p>` +
      `<w:sectPr><w:headerReference w:type="default" r:id="rH1"/><w:headerReference w:type="first" r:id="rH2"/>` +
      `<w:footerReference w:type="default" r:id="rF1"/><w:footerReference w:type="first" r:id="rF2"/></w:sectPr>`
    const buf = await createDocx(body, {
      relationships: rel("rH1", "header", "header1.xml") + rel("rH2", "header", "header2.xml") +
        rel("rF1", "footer", "footer1.xml") + rel("rF2", "footer", "footer2.xml"),
      files: {
        // 첫 쪽 판도 같은 회사명 — 한 번만
        "word/header1.xml": part("hdr", p("Kintetsu World Express(Korea), Inc.")),
        "word/header2.xml": part("hdr", p("Kintetsu World Express(Korea), Inc.")),
        "word/footer1.xml": part("ftr", pageField("페이지 ", "1", " / 19")),
        "word/footer2.xml": part("ftr", pageField("- ", "7", " -")),
      },
    })
    const r = await parse(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    const texts = r.blocks.map(b => b.text)
    assert.deepEqual(texts, ["Kintetsu World Express(Korea), Inc.", "본문", "페이지 / 19"])
  })
})
