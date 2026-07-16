/**
 * Office 포맷(XLSX/XLS/DOCX) 결함 회귀 테스트 — 담당 D
 *
 * 결함 목록 (수정 커밋과 1:1):
 *   #1  xlsx 셀 ref row 무검증 (A5000000000 → 그리드 폭주)
 *   #2  xlsx mergeCell 범위 무클램프
 *   #3  xls SST rgb가 CONTINUE 경계 정각 시작 시 grbit 미소비 → 인덱스 밀림
 *   #4  xlsx row/c의 r 속성 부재 시 무음 드롭 (ECMA-376: optional, 순차 암시)
 *   #5  docx w:ins/w:smartTag run 전량 소실
 *   #6  날짜 시리얼 → ISO 문자열 (XLSX styles.xml + XLS XF/Format)
 *   #7  omml \frac 분자 다중그룹 오판 ({x}^{2} 통짜 취급)
 *   #8  xls SST segments 선형 스캔 → 단조 커서 (#3 테스트로 동작 잠금)
 *   #9  xls MAX_ROWS 65536 하향 (BIFF8 실제 최대 행)
 *   #10 xls 공유수식 첫 셀 String 레코드 skip 탐색 (ShrFmla/Array 개재)
 *   #11 xls 시트 BOF 폴백 최근접(≥) 선택 (전부 시트1 복제 방지)
 *   #12 docx w:br/w:cr → \n, w:tab → 공백
 *   #13 docx 스타일 basedOn 체인 미해석
 *   #14 omml subHide/supHide "0"|"false"|"off" 모두 false
 *   #15 xlsx sharedStrings/inlineStr의 rPh(후리가나) 하위 t 혼입
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import JSZip from "jszip"
import { DOMParser } from "@xmldom/xmldom"
import { parseXlsx, parseDocx } from "../src/index.js"
import { classifyDateFormat, dateSerialToIso } from "../src/xlsx/parser.js"
import { decodeSST } from "../src/xls/sst.js"
import { extractSheetCells } from "../src/xls/cell.js"
import { findSheetBofIndex } from "../src/xls/parser.js"
import {
  OP_SST, OP_CONTINUE, OP_BOF, OP_EOF, OP_NUMBER, OP_FORMULA, OP_STRING, OP_SHRFMLA,
  type BiffRecord,
} from "../src/xls/record.js"
import { ommlElementToLatex } from "../src/docx/equation.js"

// ─── 합성 파일 빌더 ────────────────────────────────────

/** 최소 XLSX — sheet1 XML(sheetData+mergeCells)·sharedStrings·styles·workbookPr 직접 지정 */
async function buildXlsx(opts: {
  sheetXml: string
  sharedStrings?: string[]
  stylesXml?: string
  workbookPr?: string
}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${opts.workbookPr ?? ""}
  <sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`)
  if (opts.sharedStrings) {
    const entries = opts.sharedStrings.join("")
    zip.file("xl/sharedStrings.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${entries}</sst>`)
  }
  if (opts.stylesXml) zip.file("xl/styles.xml", opts.stylesXml)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${opts.sheetXml}</worksheet>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

/** 최소 DOCX (docx.test.ts createDocx 축약판) */
async function buildDocx(bodyXml: string, opts?: { styles?: string }): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>${bodyXml}</w:body>
</w:document>`)
  if (opts?.styles) zip.file("word/styles.xml", opts.styles)
  return await zip.generateAsync({ type: "arraybuffer" })
}

/** OMML 스니펫 → 최상위 Element (docx-equation.test.ts와 동일 방식) */
function parseOmml(xml: string): Element {
  const wrapped = `<root xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${xml}</root>`
  const doc = new DOMParser().parseFromString(wrapped, "text/xml")
  const root = doc.documentElement
  for (let i = 0; i < root.childNodes.length; i++) {
    const n = root.childNodes[i]
    if (n.nodeType === 1) return n as Element
  }
  throw new Error("no element child")
}

/** BiffRecord 손조립 헬퍼 — offset은 4바이트 헤더를 가정한 연속 배치 */
function biffRecords(specs: { opcode: number; data: Buffer }[]): BiffRecord[] {
  const out: BiffRecord[] = []
  let offset = 0
  for (const s of specs) {
    out.push({ opcode: s.opcode, data: s.data, offset })
    offset += 4 + s.data.length
  }
  return out
}

// ─── #1 · #2 · #4 · #15 — XLSX 파싱 견고성 ────────────

describe("regress-D #1: xlsx 셀 ref row 상한 검증", () => {
  it("A5000000000 셀 하나로 그리드가 폭주하지 않는다", async () => {
    const buffer = await buildXlsx({
      sheetXml: `<sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="A5000000000"><v>9</v></c></row>
      </sheetData>`,
      sharedStrings: ["<si><t>정상데이터</t></si>"],
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("정상데이터"))
  })
})

describe("regress-D #2: xlsx mergeCell 범위 클램프", () => {
  it("A1:B5000000000 병합이 MAX_ROWS로 클램프되어 완주한다", async () => {
    const buffer = await buildXlsx({
      sheetXml: `<sheetData>
        <row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
      </sheetData>
      <mergeCells count="1"><mergeCell ref="A1:B5000000000"/></mergeCells>`,
      sharedStrings: ["<si><t>병합시작</t></si>", "<si><t>우측</t></si>"],
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("병합시작"))
  })
})

describe("regress-D #4: xlsx r 속성 부재 시 순차 유도", () => {
  it("row/c에 r이 없어도 직전+1로 배치된다 (무음 드롭 금지)", async () => {
    const buffer = await buildXlsx({
      sheetXml: `<sheetData>
        <row><c t="s"><v>0</v></c><c t="s"><v>1</v></c></row>
        <row><c t="s"><v>2</v></c></row>
        <row r="4"><c r="B4" t="s"><v>3</v></c></row>
        <row><c t="s"><v>4</v></c></row>
      </sheetData>`,
      sharedStrings: [
        "<si><t>가</t></si>", "<si><t>나</t></si>", "<si><t>다</t></si>",
        "<si><t>라</t></si>", "<si><t>마</t></si>",
      ],
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    for (const s of ["가", "나", "다", "라", "마"]) {
      assert.ok(r.markdown.includes(s), `"${s}" 소실`)
    }
    // 순차 유도 위치 검증: r="4" 다음의 r 없는 row는 5행(0-based 4)
    const table = r.blocks.find(b => b.type === "table")?.table
    assert.ok(table)
    assert.equal(table.rows, 5)
    assert.equal(table.cells[0][0].text, "가")
    assert.equal(table.cells[0][1].text, "나")
    assert.equal(table.cells[1][0].text, "다")
    assert.equal(table.cells[3][1].text, "라")
    assert.equal(table.cells[4][0].text, "마")
  })
})

describe("regress-D #15: rPh(후리가나) 하위 t 제외", () => {
  it("sharedStrings와 inlineStr 모두 본문 t만 취한다", async () => {
    const buffer = await buildXlsx({
      sheetXml: `<sheetData>
        <row r="1">
          <c r="A1" t="s"><v>0</v></c>
          <c r="B1" t="inlineStr"><is><t>本文</t><rPh sb="0" eb="2"><t>ほんぶん</t></rPh></is></c>
        </row>
      </sheetData>`,
      sharedStrings: [
        `<si><r><t>漢字</t></r><rPh sb="0" eb="2"><t>かんじ</t></rPh><phoneticPr fontId="1"/></si>`,
      ],
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("漢字"))
    assert.ok(r.markdown.includes("本文"))
    assert.ok(!r.markdown.includes("かんじ"), "sharedStrings 후리가나 혼입")
    assert.ok(!r.markdown.includes("ほんぶん"), "inlineStr 후리가나 혼입")
  })
})

// ─── #6 — 날짜 시리얼 ─────────────────────────────────

describe("regress-D #6: 날짜 시리얼 → ISO (XLSX)", () => {
  it("내장 numFmtId 14(date)·22(datetime)·커스텀 y/m/d 포맷 판정", async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;년&quot; m&quot;월&quot; d&quot;일&quot;"/></numFmts>
  <cellXfs count="4">
    <xf numFmtId="0"/>
    <xf numFmtId="14"/>
    <xf numFmtId="22"/>
    <xf numFmtId="164"/>
  </cellXfs>
</styleSheet>`
    const buffer = await buildXlsx({
      sheetXml: `<sheetData>
        <row r="1">
          <c r="A1" s="1"><v>45306</v></c>
          <c r="B1" s="2"><v>45306.520833333336</v></c>
          <c r="C1" s="3"><v>45306</v></c>
          <c r="D1"><v>45306</v></c>
        </row>
      </sheetData>`,
      stylesXml,
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    const table = r.blocks.find(b => b.type === "table")?.table
    assert.ok(table)
    assert.equal(table.cells[0][0].text, "2024-01-15")            // numFmtId 14
    assert.equal(table.cells[0][1].text, "2024-01-15T12:30:00")   // numFmtId 22
    assert.equal(table.cells[0][2].text, "2024-01-15")            // 커스텀 yyyy년 m월 d일
    assert.equal(table.cells[0][3].text, "45306")                 // 서식 없음 — 숫자 유지
  })

  it("date1904 체계 반영", async () => {
    const stylesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs>
</styleSheet>`
    const buffer = await buildXlsx({
      sheetXml: `<sheetData><row r="1"><c r="A1" s="1"><v>100</v></c></row></sheetData>`,
      stylesXml,
      workbookPr: `<workbookPr date1904="1"/>`,
    })
    const r = await parseXlsx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("1904-04-10"))
  })

  it("dateSerialToIso — 1900 윤년 버그 보정·범위 밖 null", () => {
    assert.equal(dateSerialToIso(1, false, "date"), "1900-01-01")
    assert.equal(dateSerialToIso(59, false, "date"), "1900-02-28")
    assert.equal(dateSerialToIso(61, false, "date"), "1900-03-01")
    assert.equal(dateSerialToIso(45306, false, "date"), "2024-01-15")
    assert.equal(dateSerialToIso(0, true, "date"), "1904-01-01")
    assert.equal(dateSerialToIso(-5, false, "date"), null)
    assert.equal(dateSerialToIso(NaN, false, "date"), null)
  })

  it("classifyDateFormat — 리터럴·조건 제거 후 판정", () => {
    assert.equal(classifyDateFormat("yyyy-mm-dd"), "date")
    assert.equal(classifyDateFormat("yyyy-mm-dd hh:mm:ss"), "datetime")
    assert.equal(classifyDateFormat("mm:ss"), "datetime")
    assert.equal(classifyDateFormat("General"), null)
    assert.equal(classifyDateFormat("#,##0.00"), null)
    assert.equal(classifyDateFormat(`[Red]#,##0;"입금"#,##0`), null) // [Red]의 d, 리터럴은 비날짜
  })

  it("XLS: 날짜 xf의 숫자 셀이 convertNum 훅으로 변환된다", () => {
    // NUMBER 레코드: row(2) col(2) ixfe(2) double(8)
    const num = Buffer.alloc(14)
    num.writeUInt16LE(0, 0)
    num.writeUInt16LE(0, 2)
    num.writeUInt16LE(5, 4) // ixfe=5 → 날짜 xf 가정
    num.writeDoubleLE(45306, 6)
    const bof = Buffer.alloc(4)
    bof.writeUInt16LE(0x0600, 0)
    bof.writeUInt16LE(0x0010, 2)
    const records = biffRecords([
      { opcode: OP_BOF, data: bof },
      { opcode: OP_NUMBER, data: num },
      { opcode: OP_EOF, data: Buffer.alloc(0) },
    ])
    const convert = (n: number, ixfe: number) =>
      ixfe === 5 ? (dateSerialToIso(n, false, "date") ?? n) : n
    const { sheet } = extractSheetCells(records, 0, [], convert)
    assert.equal(sheet.cells.length, 1)
    assert.equal(sheet.cells[0].value, "2024-01-15")
  })
})

// ─── #3 · #8 — XLS SST CONTINUE 경계 ─────────────────

describe("regress-D #3/#8: SST rgb가 CONTINUE 경계 정각 시작", () => {
  /** SST 데이터: cstTotal·cstUnique 헤더 + 문자열 바이트 */
  function sstData(unique: number, body: Buffer): Buffer {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(unique, 0)
    head.writeUInt32LE(unique, 4)
    return Buffer.concat([head, body])
  }

  it("경계 정각 시작 rgb의 grbit를 선소비한다 (compressed)", () => {
    // str1 "abcd" 완결 + str2 헤더(cch=3, flags=0)가 SST 레코드 끝에 정확히 걸침
    const body = Buffer.concat([
      Buffer.from([4, 0, 0]), Buffer.from("abcd", "latin1"), // str1
      Buffer.from([3, 0, 0]),                                 // str2 헤더만
    ])
    // CONTINUE: [grbit=0][xyz] — rgb가 경계 정각에서 시작
    const cont = Buffer.concat([Buffer.from([0]), Buffer.from("xyz", "latin1")])
    const records = biffRecords([
      { opcode: OP_SST, data: sstData(2, body) },
      { opcode: OP_CONTINUE, data: cont },
    ])
    const strings = decodeSST(records)
    assert.deepEqual(strings, ["abcd", "xyz"]) // 미소비 시 "\x00xy" + 인덱스 밀림
  })

  it("경계 정각 시작 + 인코딩 전환 (compressed 선언 → utf16 CONTINUE)", () => {
    const body = Buffer.concat([
      Buffer.from([4, 0, 0]), Buffer.from("abcd", "latin1"),
      Buffer.from([2, 0, 0]), // str2: cch=2, flags=0 (compressed 선언)
    ])
    const cont = Buffer.concat([Buffer.from([1]), Buffer.from("한글", "utf16le")])
    const records = biffRecords([
      { opcode: OP_SST, data: sstData(2, body) },
      { opcode: OP_CONTINUE, data: cont },
    ])
    assert.deepEqual(decodeSST(records), ["abcd", "한글"])
  })

  it("rgb 중간 분할(기존 동작)과 후속 문자열 정렬 유지", () => {
    const body = Buffer.concat([
      Buffer.from([6, 0, 0]), Buffer.from("abc", "latin1"), // str1 전반부
    ])
    const cont = Buffer.concat([
      Buffer.from([0]), Buffer.from("def", "latin1"),       // str1 후반부
      Buffer.from([4, 0, 0]), Buffer.from("tail", "latin1"), // str2 완결
    ])
    const records = biffRecords([
      { opcode: OP_SST, data: sstData(2, body) },
      { opcode: OP_CONTINUE, data: cont },
    ])
    assert.deepEqual(decodeSST(records), ["abcdef", "tail"])
  })
})

// ─── #9 — XLS MAX_ROWS ────────────────────────────────

describe("regress-D #9: XLS 밀집 그리드 상한 = BIFF8 실제 최대 행", () => {
  it("MAX_ROWS 상수가 65536으로 고정되어 있다 (u16 주소 공간)", () => {
    const src = readFileSync(join(process.cwd(), "src/xls/parser.ts"), "utf8")
    assert.match(src, /const MAX_ROWS = 65536/)
  })
})

// ─── #10 · #11 — XLS 레코드 시퀀스 ────────────────────

describe("regress-D #10: 공유수식 첫 셀의 String 레코드 skip 탐색", () => {
  it("Formula(stringRef) + ShrFmla 개재 후 String을 찾는다", () => {
    // FORMULA: row(2) col(2) ixfe(2) val(8) — val[0]=0, val[6..8]=0xFFFF → stringRef
    const formula = Buffer.alloc(20)
    formula.writeUInt16LE(0, 0)
    formula.writeUInt16LE(0, 2)
    formula.writeUInt16LE(0, 4)
    formula.writeUInt8(0x00, 6)      // 결과 = 문자열
    formula.writeUInt16LE(0xffff, 12) // val[6..8]
    // STRING: cch(2) flags(1) rgb
    const str = Buffer.concat([Buffer.from([5, 0, 0]), Buffer.from("hello", "latin1")])
    const bof = Buffer.alloc(4)
    bof.writeUInt16LE(0x0600, 0)
    bof.writeUInt16LE(0x0010, 2)
    const records = biffRecords([
      { opcode: OP_BOF, data: bof },
      { opcode: OP_FORMULA, data: formula },
      { opcode: OP_SHRFMLA, data: Buffer.alloc(10) }, // 공유수식 정의 개재
      { opcode: OP_STRING, data: str },
      { opcode: OP_EOF, data: Buffer.alloc(0) },
    ])
    const { sheet } = extractSheetCells(records, 0, [])
    assert.equal(sheet.cells.length, 1)
    assert.equal(sheet.cells[0].value, "hello") // 기존엔 "" (records[i+1]만 확인)
  })
})

describe("regress-D #11: 시트 BOF 폴백 최근접(≥) 선택", () => {
  it("미매칭 lbPlyPos가 두 번째 시트 BOF로 정확히 폴백한다", () => {
    const bof = Buffer.alloc(4)
    bof.writeUInt16LE(0x0600, 0)
    bof.writeUInt16LE(0x0010, 2)
    const records: BiffRecord[] = [
      { opcode: OP_BOF, data: bof, offset: 0 },     // Globals
      { opcode: OP_EOF, data: Buffer.alloc(0), offset: 8 },
      { opcode: OP_BOF, data: bof, offset: 100 },   // 시트1
      { opcode: OP_EOF, data: Buffer.alloc(0), offset: 108 },
      { opcode: OP_BOF, data: bof, offset: 200 },   // 시트2
      { opcode: OP_EOF, data: Buffer.alloc(0), offset: 208 },
    ]
    assert.equal(findSheetBofIndex(records, 100), 2)  // 정확 매칭
    assert.equal(findSheetBofIndex(records, 195), 4)  // 미매칭 → 최근접(≥) = 시트2 (기존: 무조건 시트1)
    assert.equal(findSheetBofIndex(records, 300), -1) // ≥ 없음
  })
})

// ─── #5 · #12 · #13 — DOCX ───────────────────────────

describe("regress-D #5: w:ins/w:smartTag run 보존", () => {
  it("변경추적 삽입(w:ins) run이 본문에 나온다 (w:del은 계속 제외)", async () => {
    const buffer = await buildDocx(`
      <w:p>
        <w:r><w:t>기존 </w:t></w:r>
        <w:ins w:id="1" w:author="a"><w:r><w:t>삽입텍스트</w:t></w:r></w:ins>
        <w:del w:id="2" w:author="a"><w:r><w:delText>지워진텍스트</w:delText></w:r></w:del>
      </w:p>
    `)
    const r = await parseDocx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("기존 삽입텍스트"))
    assert.ok(!r.markdown.includes("지워진텍스트"))
  })

  it("w:smartTag 안 run이 본문에 나온다", async () => {
    const buffer = await buildDocx(`
      <w:p>
        <w:smartTag w:uri="urn:x" w:element="date"><w:r><w:t>2024년 1월</w:t></w:r></w:smartTag>
        <w:r><w:t> 정기회의</w:t></w:r>
      </w:p>
    `)
    const r = await parseDocx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("2024년 1월 정기회의"))
  })
})

describe("regress-D #12: w:br/w:cr/w:tab", () => {
  it("br·cr은 줄바꿈, tab은 공백으로 (텍스트 융합 방지)", async () => {
    const buffer = await buildDocx(`
      <w:p><w:r><w:t>첫줄</w:t><w:br/><w:t>둘째줄</w:t><w:cr/><w:t>셋째줄</w:t></w:r></w:p>
      <w:p><w:r><w:t>이름</w:t><w:tab/><w:t>값</w:t></w:r></w:p>
    `)
    const r = await parseDocx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    const paras = r.blocks.filter(b => b.type === "paragraph")
    assert.equal(paras[0].text, "첫줄\n둘째줄\n셋째줄")
    assert.equal(paras[1].text, "이름 값")
  })
})

describe("regress-D #13: 스타일 basedOn 체인 해석", () => {
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:style w:type="paragraph" w:styleId="Heading1">
    <w:name w:val="heading 1"/>
    <w:pPr><w:outlineLvl w:val="0"/></w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="MyTitle">
    <w:name w:val="내 제목"/>
    <w:basedOn w:val="Heading1"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="MyTitle2">
    <w:name w:val="내 제목 2"/>
    <w:basedOn w:val="MyTitle"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CycleA">
    <w:name w:val="사이클A"/>
    <w:basedOn w:val="CycleB"/>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CycleB">
    <w:name w:val="사이클B"/>
    <w:basedOn w:val="CycleA"/>
  </w:style>
</w:styles>`

  it("Heading 기반 사용자 스타일(2단 체인)이 헤딩으로 감지된다", async () => {
    const buffer = await buildDocx(`
      <w:p><w:pPr><w:pStyle w:val="MyTitle2"/></w:pPr><w:r><w:t>사용자 정의 제목</w:t></w:r></w:p>
    `, { styles })
    const r = await parseDocx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("# 사용자 정의 제목"))
  })

  it("basedOn 사이클은 무한 루프 없이 일반 단락 유지", async () => {
    const buffer = await buildDocx(`
      <w:p><w:pPr><w:pStyle w:val="CycleA"/></w:pPr><w:r><w:t>사이클 본문</w:t></w:r></w:p>
    `, { styles })
    const r = await parseDocx(buffer)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("사이클 본문"))
    assert.ok(!r.markdown.includes("# 사이클 본문"))
  })
})

// ─── #7 · #14 — OMML ─────────────────────────────────

describe("regress-D #7: \\frac 인자 다중그룹 오판", () => {
  it("분자가 {x}^{2}면 통짜 {}로 재감싼다", () => {
    const el = parseOmml(`
      <m:oMath>
        <m:f>
          <m:num>
            <m:sSup>
              <m:e><m:r><m:t>x</m:t></m:r></m:e>
              <m:sup><m:r><m:t>2</m:t></m:r></m:sup>
            </m:sSup>
          </m:num>
          <m:den><m:r><m:t>b</m:t></m:r></m:den>
        </m:f>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\frac{{x}^{2}}{b}") // 기존: \frac{x}^{2}{b}
  })

  it("단일 그룹 인자는 기존대로 그대로 (회귀 없음)", () => {
    const el = parseOmml(`
      <m:oMath>
        <m:f>
          <m:num><m:r><m:t>a</m:t></m:r></m:num>
          <m:den><m:r><m:t>b</m:t></m:r></m:den>
        </m:f>
      </m:oMath>
    `)
    assert.equal(ommlElementToLatex(el), "\\frac{a}{b}")
  })
})

describe("regress-D #14: subHide/supHide on/off 값", () => {
  function nary(subHideVal?: string): string {
    const attr = subHideVal === undefined ? "" : ` m:val="${subHideVal}"`
    return `
      <m:oMath>
        <m:nary>
          <m:naryPr><m:chr m:val="∑"/><m:subHide${attr}/></m:naryPr>
          <m:sub><m:r><m:t>i=1</m:t></m:r></m:sub>
          <m:sup><m:r><m:t>n</m:t></m:r></m:sup>
          <m:e><m:r><m:t>i</m:t></m:r></m:e>
        </m:nary>
      </m:oMath>
    `
  }

  it(`"0"·"false"·"off"는 숨김 아님 → 아래끝 표시`, () => {
    for (const v of ["0", "false", "off"]) {
      const out = ommlElementToLatex(parseOmml(nary(v)))
      assert.ok(out.includes("_{i=1}"), `subHide="${v}"에서 아래끝 소실: ${out}`)
    }
  })

  it("값 생략(존재만)은 숨김 유지", () => {
    const out = ommlElementToLatex(parseOmml(nary()))
    assert.ok(!out.includes("_{i=1}"), `subHide 존재 시 숨겨야 함: ${out}`)
  })
})
