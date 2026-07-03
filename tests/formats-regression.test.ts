/** formats 코퍼스에서 발굴된 회귀 케이스 — 한셀 xlsx 네임스페이스 접두, HML 표 소실 */
import { describe, it } from "node:test"
import assert from "node:assert"
import JSZip from "jszip"
import { parse } from "../src/index.js"

/** 한셀(HCell) 스타일: spreadsheetml을 x: 접두사로 선언한 최소 xlsx */
async function makePrefixedXlsx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><x:workbook xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><x:sheets><x:sheet name="현황" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>`)
  zip.file("xl/sharedStrings.xml", `<?xml version="1.0"?><x:sst xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2"><x:si><x:t>기관명</x:t></x:si><x:si><x:t>수원지원청</x:t></x:si></x:sst>`)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData><x:row r="1"><x:c r="A1" t="s"><x:v>0</x:v></x:c><x:c r="B1"><x:v>42</x:v></x:c></x:row><x:row r="2"><x:c r="A2" t="s"><x:v>1</x:v></x:c><x:c r="B2"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>`)
  return Buffer.from(await zip.generateAsync({ type: "uint8array" }))
}

describe("한셀(HCell) xlsx — 접두사 네임스페이스", () => {
  it("x:sheet/x:row/x:c 를 인식해 셀 텍스트를 추출한다", async () => {
    const buf = await makePrefixedXlsx()
    const res = await parse(buf, { filename: "hcell.xlsx" })
    assert.equal(res.success, true, `파싱 실패: ${res.success === false ? res.error : ""}`)
    if (res.success) {
      assert.ok(res.markdown.includes("기관명"), "공유 문자열 셀")
      assert.ok(res.markdown.includes("수원지원청"), "두 번째 행")
      assert.ok(res.markdown.includes("42"), "숫자 셀")
    }
  })
})

/** HML: P 안에 앵커된 표 + 셀 안 중첩표(안내 박스) */
function makeHml(): Buffer {
  const cellP = (text: string) =>
    `<PARALIST><P ParaShape="0"><TEXT CharShape="0"><CHAR>${text}</CHAR></TEXT></P></PARALIST>`
  const nested = `<TABLE RowCount="1" ColCount="1"><ROW><CELL ColAddr="0" RowAddr="0" ColSpan="1" RowSpan="1"><PARALIST><P ParaShape="0"><TEXT CharShape="0"><CHAR>박스 안내문</CHAR></TEXT></P></PARALIST></CELL></ROW></TABLE>`
  const table = `<TABLE RowCount="1" ColCount="2"><ROW>` +
    `<CELL ColAddr="0" RowAddr="0" ColSpan="1" RowSpan="1">${cellP("셀A")}</CELL>` +
    `<CELL ColAddr="1" RowAddr="0" ColSpan="1" RowSpan="1"><PARALIST><P ParaShape="0"><TEXT CharShape="0"><CHAR>셀B</CHAR></TEXT>${nested}</P></PARALIST></CELL>` +
    `</ROW></TABLE>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.9" SubVersion="10.0.0.0" Style="embed">` +
    `<HEAD><MAPPINGTABLE></MAPPINGTABLE></HEAD>` +
    `<BODY><SECTION Id="0"><P ParaShape="0"><TEXT CharShape="0"><CHAR>본문 문단</CHAR></TEXT>${table}</P></SECTION></BODY></HWPML>`
  return Buffer.from("﻿" + xml, "utf8")
}

describe("HWPML — P 앵커 표와 중첩표 평탄화", () => {
  it("P 안의 표 셀 텍스트와 셀 내 중첩표 텍스트가 모두 출력된다", async () => {
    const res = await parse(makeHml(), { filename: "box.hml" })
    assert.equal(res.success, true, `파싱 실패: ${res.success === false ? res.error : ""}`)
    if (res.success) {
      assert.ok(res.markdown.includes("본문 문단"), "본문")
      assert.ok(res.markdown.includes("셀A"), "P 앵커 표의 셀")
      assert.ok(res.markdown.includes("박스 안내문"), "셀 내 중첩표 텍스트 평탄화")
      assert.ok(!res.markdown.includes("[중첩 테이블]"), "구 마커 미사용")
    }
  })
})
