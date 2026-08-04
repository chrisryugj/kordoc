/**
 * XLSX 파서 단위 테스트
 *
 * jszip으로 합성 XLSX 파일 생성 → 파싱 검증
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse, detectZipFormat } from "../src/index.js"

/** 최소 XLSX 파일 생성 */
async function createXlsx(opts?: {
  sheets?: { name: string; rows: string[][] }[]
  merges?: string[]
  sharedStrings?: string[]
}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  const sheets = opts?.sheets ?? [{ name: "Sheet1", rows: [["A", "B"], ["1", "2"]] }]
  const allStrings = opts?.sharedStrings ?? [...new Set(sheets.flatMap(s => s.rows.flat()))]

  // [Content_Types].xml
  const sheetTypes = sheets.map((_, i) =>
    `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  ).join("")
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${sheetTypes}
</Types>`)

  // _rels/.rels
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`)

  // xl/workbook.xml
  const sheetDefs = sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetDefs}</sheets>
</workbook>`)

  // xl/_rels/workbook.xml.rels
  const sheetRels = sheets.map((_, i) =>
    `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
  ).join("")
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`)

  // xl/sharedStrings.xml
  const ssEntries = allStrings.map(s => `<si><t>${s}</t></si>`).join("")
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${allStrings.length}" uniqueCount="${allStrings.length}">
  ${ssEntries}
</sst>`)

  // xl/worksheets/sheetN.xml
  const colLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
  for (let si = 0; si < sheets.length; si++) {
    const { rows } = sheets[si]
    const rowsXml = rows.map((row, ri) => {
      const cells = row.map((val, ci) => {
        const ref = `${colLetters[ci]}${ri + 1}`
        const strIdx = allStrings.indexOf(val)
        if (strIdx >= 0) return `<c r="${ref}" t="s"><v>${strIdx}</v></c>`
        // 숫자인 경우
        if (!isNaN(Number(val))) return `<c r="${ref}"><v>${val}</v></c>`
        return `<c r="${ref}" t="s"><v>${strIdx}</v></c>`
      }).join("")
      return `<row r="${ri + 1}">${cells}</row>`
    }).join("")

    const mergesXml = opts?.merges?.length
      ? `<mergeCells>${opts.merges.map(m => `<mergeCell ref="${m}"/>`).join("")}</mergeCells>`
      : ""

    zip.file(`xl/worksheets/sheet${si + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowsXml}</sheetData>
  ${mergesXml}
</worksheet>`)
  }

  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("XLSX 파서", () => {
  it("기본 2x2 시트 파싱", async () => {
    const buffer = await createXlsx()
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.fileType, "xlsx")
    assert.ok(result.markdown.includes("A"))
    assert.ok(result.markdown.includes("B"))
    assert.ok(result.markdown.includes("1"))
    assert.ok(result.markdown.includes("2"))
  })

  it("시트명이 헤딩으로 출력", async () => {
    const buffer = await createXlsx({ sheets: [{ name: "매출현황", rows: [["항목", "금액"]] }] })
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("## 매출현황"))
  })

  it("다중 시트 파싱", async () => {
    const buffer = await createXlsx({
      sheets: [
        { name: "시트1", rows: [["가", "나"]] },
        { name: "시트2", rows: [["다", "라"]] },
      ],
    })
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("## 시트1"))
    assert.ok(result.markdown.includes("## 시트2"))
    assert.ok(result.markdown.includes("가"))
    assert.ok(result.markdown.includes("다"))
  })

  it("병합 셀 처리", async () => {
    const buffer = await createXlsx({
      sheets: [{ name: "Sheet1", rows: [["병합됨", "", "C"], ["D", "E", "F"]] }],
      merges: ["A1:B1"],
    })
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(result.markdown.includes("병합됨"))
  })

  it("빈 XLSX은 적절히 처리", async () => {
    const buffer = await createXlsx({ sheets: [{ name: "빈시트", rows: [] }] })
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    // 헤딩만 있고 테이블은 없어야 함
    assert.ok(result.markdown.includes("빈시트"))
  })

  it("포맷이 xlsx로 감지", async () => {
    const buffer = await createXlsx()
    const format = await detectZipFormat(buffer)
    assert.equal(format, "xlsx")
  })

  it("메타데이터 추출 (docProps/core.xml)", async () => {
    const buffer = await createXlsx()
    const zip = await JSZip.loadAsync(buffer)
    zip.file("docProps/core.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/">
  <dc:title>테스트 문서</dc:title>
  <dc:creator>작성자</dc:creator>
</cp:coreProperties>`)
    const newBuffer = await zip.generateAsync({ type: "arraybuffer" })
    const result = await parse(newBuffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.metadata?.title, "테스트 문서")
    assert.equal(result.metadata?.author, "작성자")
  })
})

describe("BOM 선행 XML 파트 (#63)", () => {
  /** 모든 .xml/.rels 파트 앞에 UTF-8 BOM 을 붙여 재압축 — 일부 OpenXML 라이터 실사례 */
  async function prependBom(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const zip = await JSZip.loadAsync(buffer)
    for (const path of Object.keys(zip.files)) {
      if (!/\.(xml|rels)$/i.test(path)) continue
      zip.file(path, "﻿" + await zip.files[path].async("text"))
    }
    return await zip.generateAsync({ type: "arraybuffer" })
  }

  it("BOM + <?xml?> 조합이 PARSE_ERROR 로 거부되지 않는다", async () => {
    const buffer = await prependBom(await createXlsx({
      sheets: [{ name: "매출", rows: [["항목", "금액"], ["가", "100"]] }],
    }))
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.equal(result.fileType, "xlsx")
    assert.ok(result.markdown.includes("## 매출"))
    assert.ok(result.markdown.includes("항목"))
    assert.ok(result.markdown.includes("100"))
  })

  it("BOM 이 시트명·셀 텍스트로 새어나오지 않는다", async () => {
    const buffer = await prependBom(await createXlsx())
    const result = await parse(buffer)
    assert.equal(result.success, true)
    if (!result.success) return
    assert.ok(!result.markdown.includes("﻿"), "본문에 BOM 잔류")
  })
})
