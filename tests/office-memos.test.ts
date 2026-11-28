/** DOCX·XLSX 메모 → 결과 memos(HWP·HWPX 메모와 같은 꼴), memos 옵션의 끝 "메모" 절 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"

const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`

async function docx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/></Relationships>`)
  zip.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>`
    + `<w:p><w:r><w:t>예산은 </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>3억 원</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r><w:r><w:t>이다.</w:t></w:r></w:p>`
    + `<w:p><w:r><w:t>둘째 문단</w:t></w:r></w:p></w:body></w:document>`)
  zip.file("word/comments.xml", `<?xml version="1.0"?><w:comments ${W}><w:comment w:id="0" w:author="김주무관" w:date="2026-11-28T10:30:00Z"><w:p><w:r><w:t>금액 다시 확인</w:t></w:r></w:p></w:comment></w:comments>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

async function xlsx(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`)
  zip.file("_rels/.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`)
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${REL}"><sheets><sheet name="현황" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>입사일</t></is></c><c r="B1" t="inlineStr"><is><t>퇴사일</t></is></c></row></sheetData></worksheet>`)
  zip.file("xl/worksheets/_rels/sheet1.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/comments" Target="../comments1.xml"/></Relationships>`)
  zip.file("xl/comments1.xml", `<?xml version="1.0"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>국세청</author></authors><commentList>`
    + `<comment ref="A1" authorId="0"><text><r><rPr><b/></rPr><t>국세청:</t></r><r><t xml:space="preserve">\n근로를 시작한 날</t></r></text></comment>`
    + `<comment ref="C9" authorId="0"><text><t>빈 칸 메모</t></text></comment></commentList></comments>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("DOCX·XLSX 메모", () => {
  it("DOCX: 범위 글·문단·작성자·시각, 본문 마크다운엔 안 섞고 memos 옵션이면 끝 절", async () => {
    const r = await parse(await docx())
    assert.ok(r.success)
    if (!r.success) return
    assert.deepEqual(r.memos, [{ text: "금액 다시 확인", anchor: "3억 원", paragraph: "예산은 3억 원이다.", offset: 4, blockIndex: 0, author: "김주무관", createdAt: "2026-11-28T10:30:00Z" }])
    assert.doesNotMatch(r.markdown, /금액 다시 확인/)
    const on = await parse(await docx(), { memos: true })
    assert.ok(on.success && /\*\*메모\*\*[\s\S]*「3억 원」 — 금액 다시 확인/.test(on.markdown))
  })

  it("XLSX: 칸 글이 붙은 글, 작성자 머리(\"국세청:\")는 뗀다, 빈 칸은 칸 주소", async () => {
    const r = await parse(await xlsx())
    assert.ok(r.success)
    if (!r.success) return
    assert.equal(r.memos?.length, 2)
    assert.deepEqual(r.memos![0], { text: "근로를 시작한 날", anchor: "입사일", paragraph: "입사일", offset: 0, blockIndex: 1, author: "국세청" })
    assert.equal(r.memos![1].anchor, "C9")
    assert.doesNotMatch(r.markdown, /근로를 시작한 날/)
  })
})

import { sheetNotes } from "../src/xls/notes.js"

describe("XLS(BIFF8) 칸 메모", () => {
  const rec = (opcode: number, data: Buffer) => ({ opcode, data, offset: 0 })
  const obj = (ot: number, id: number) => { const d = Buffer.alloc(22); d.writeUInt16LE(0x15, 0); d.writeUInt16LE(0x12, 2); d.writeUInt16LE(ot, 4); d.writeUInt16LE(id, 6); return d }
  const txo = (cch: number) => { const d = Buffer.alloc(18); d.writeUInt16LE(cch, 10); return d }
  const cont = (s: string, wide: boolean) => Buffer.concat([Buffer.from([wide ? 1 : 0]), Buffer.from(s, wide ? "utf16le" : "latin1")])
  const note = (row: number, col: number, id: number, author: string) => {
    const a = Buffer.from(author, "utf16le"), d = Buffer.alloc(11 + a.length)
    d.writeUInt16LE(row, 0); d.writeUInt16LE(col, 2); d.writeUInt16LE(id, 6); d.writeUInt16LE(author.length, 8); d[10] = 1; a.copy(d, 11)
    return d
  }
  it("OBJ(메모)·TXO·CONTINUE 글과 NOTE 칸·작성자를 개체 id 로 잇는다 — 작성자 머리 떼기, 빈 칸은 칸 주소, 하위 흐름 건너뜀", () => {
    const records = [
      rec(0x0809, Buffer.alloc(16)),
      rec(0x005d, obj(0x19, 1)), rec(0x01b6, txo(10)), rec(0x003c, cont("김:\n", true)), rec(0x003c, cont("확인하세요", true)),
      rec(0x0809, Buffer.alloc(16)), rec(0x005d, obj(0x19, 9)), rec(0x000a, Buffer.alloc(0)),  // 하위 흐름(차트) 안 개체는 무시
      rec(0x005d, obj(0x19, 2)), rec(0x01b6, txo(3)), rec(0x003c, cont("빈칸", true)),
      rec(0x001c, note(0, 0, 1, "김")), rec(0x001c, note(4, 2, 2, "")),
      rec(0x000a, Buffer.alloc(0)),
    ]
    const memos = sheetNotes(records as never, 0, [{ row: 0, col: 0, value: "입사일" }])
    assert.deepEqual(memos, [
      { text: "확인하세요", anchor: "입사일", paragraph: "입사일", offset: 0, author: "김" },
      { text: "빈칸", anchor: "C5", paragraph: "", offset: 0 },
    ])
  })
})

import { sheetTextObjects } from "../src/xls/notes.js"

describe("XLS 글상자·도형 글", () => {
  it("글상자·체크 상자 글은 읽고, 매크로 단추·메모 개체 글은 뺀다", () => {
    const rec = (opcode: number, data: Buffer) => ({ opcode, data, offset: 0 })
    const obj = (ot: number) => { const d = Buffer.alloc(22); d.writeUInt16LE(0x15, 0); d.writeUInt16LE(0x12, 2); d.writeUInt16LE(ot, 4); return d }
    const txo = (cch: number) => { const d = Buffer.alloc(18); d.writeUInt16LE(cch, 10); return d }
    const cont = (s: string) => Buffer.concat([Buffer.from([1]), Buffer.from(s, "utf16le")])
    const records = [rec(0x0809, Buffer.alloc(16)),
      rec(0x005d, obj(6)), rec(0x01b6, txo(4)), rec(0x003c, cont("안내 글")),
      rec(0x005d, obj(7)), rec(0x01b6, txo(2)), rec(0x003c, cont("조회")),
      rec(0x005d, obj(0x0b)), rec(0x01b6, txo(2)), rec(0x003c, cont("동의")),
      rec(0x005d, obj(0x19)), rec(0x01b6, txo(2)), rec(0x003c, cont("메모")),
      rec(0x000a, Buffer.alloc(0))]
    assert.deepEqual(sheetTextObjects(records as never, 0), ["안내 글", "동의"])
  })
})
