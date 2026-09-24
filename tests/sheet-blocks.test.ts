/**
 * 시트 → 표 (XLSX·XLS 공용 src/xlsx/sheet-blocks.ts) 회귀.
 *   - XLS 셀 하나가 먼 좌표를 주장해도 밀집 격자를 깔지 않는다 (프로덕션 리뷰 P2: 65535행·999열 → 6,553만 칸·500MB)
 *   - 열이 적은 긴 시트는 1만 행에서 잘리지 않는다 (칸 예산 = 1만 행 × 200 열) — 4열 명단 15,212행이 1만 행으로 잘리던 것
 *   - 병합은 펼칠 행 범위로 자른다 (끝 빈 행으로 뻗은 rowSpan, 글 없는 행에 머리가 있는 병합)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import JSZip from "jszip"
import { parseXls, parseXlsx } from "../src/index.js"
import { sheetRowCap, sheetToBlocks } from "../src/xlsx/sheet-blocks.js"
import type { ParseWarning } from "../src/types.js"

interface CfbDoc { [key: string]: unknown }
const require = createRequire(import.meta.url)
const CFB: {
  utils: { cfb_new(): CfbDoc; cfb_add(cfb: CfbDoc, path: string, data: Buffer): void }
  write(cfb: CfbDoc, opts: { type: "buffer" }): Buffer
} = require("cfb")

// ─── 합성 BIFF8 ────────────────────────────────────

function rec(opcode: number, data: Buffer): Buffer {
  const h = Buffer.alloc(4)
  h.writeUInt16LE(opcode, 0)
  h.writeUInt16LE(data.length, 2)
  return Buffer.concat([h, data])
}
function bof(dt: number): Buffer {
  const d = Buffer.alloc(16)
  d.writeUInt16LE(0x0600, 0)
  d.writeUInt16LE(dt, 2)
  return rec(0x0809, d)
}
/** LABEL(0x0204) — row col ixfe cch flags(1=UTF-16) 글 */
function label(row: number, col: number, text: string): Buffer {
  const d = Buffer.alloc(9)
  d.writeUInt16LE(row, 0)
  d.writeUInt16LE(col, 2)
  d.writeUInt16LE(text.length, 6)
  d.writeUInt8(1, 8)
  return rec(0x0204, Buffer.concat([d, Buffer.from(text, "utf16le")]))
}
/** 시트 하나짜리 XLS — Globals(BOF·BoundSheet8·EOF) + Worksheet(BOF·셀·EOF) */
function buildXls(cells: Buffer[]): ArrayBuffer {
  const name = "S1"
  const boundSheet = (pos: number) => {
    const d = Buffer.alloc(8 + name.length)
    d.writeUInt32LE(pos, 0)
    d.writeUInt8(name.length, 6)
    d.write(name, 8, "latin1")
    return rec(0x0085, d)
  }
  const head = bof(0x0005)
  const eof = rec(0x000a, Buffer.alloc(0))
  const sheetPos = head.length + boundSheet(0).length + eof.length
  const wb = Buffer.concat([head, boundSheet(sheetPos), eof, bof(0x0010), ...cells, eof])
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/Workbook", wb)
  const out = CFB.write(cfb, { type: "buffer" })
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

async function buildXlsx(sheetXml: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${sheetXml}</worksheet>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("XLS — 먼 좌표 셀 하나로 밀집 격자를 깔지 않는다", () => {
  it("65535행·999열 셀 하나: 큰 할당 없이 끝난다 (표 열 상한 밖이라 표 없음)", async () => {
    const before = process.memoryUsage().heapUsed
    const t0 = performance.now()
    const r = await parseXls(buildXls([label(0, 0, "머리"), label(65535, 999, "먼칸")]))
    const ms = performance.now() - t0
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(ms < 1000, `${ms.toFixed(0)}ms`)
    assert.ok(process.memoryUsage().heapUsed - before < 100 * 1024 * 1024, "힙 100MB 이상 증가")
    assert.ok(r.markdown.includes("머리"))
  })

  it("65535행·150열 셀 하나만: 그 행 하나짜리 표 (앞 빈 행·빈 열을 격자로 선할당하지 않음)", async () => {
    const r = await parseXls(buildXls([label(65535, 150, "먼칸")]))
    assert.equal(r.success, true)
    if (!r.success) return
    const t = r.blocks.find(b => b.type === "table")?.table
    assert.ok(t)
    assert.equal(t.rows, 1)
    assert.equal(t.cells[0][150].text, "먼칸")
  })
})

describe("긴 시트는 칸 예산 안에서 1만 행을 넘는다", () => {
  it("행 상한 = 칸 예산 ÷ 열 수 (200열이면 종전 1만 행 그대로)", () => {
    assert.equal(sheetRowCap(200), 10_000)
    assert.equal(sheetRowCap(59), 33_898)
    assert.equal(sheetRowCap(4), 500_000)
  })

  it("2열 12,000행 XLSX 가 전부 표로 나온다 (종전 1만 행에서 무경고 절단)", async () => {
    const rows: string[] = []
    for (let r = 1; r <= 12_000; r++) rows.push(`<row r="${r}"><c r="A${r}"><v>${r}</v></c><c r="B${r}" t="inlineStr"><is><t>행${r}</t></is></c></row>`)
    const res = await parseXlsx(await buildXlsx(`<sheetData>${rows.join("")}</sheetData>`))
    assert.equal(res.success, true)
    if (!res.success) return
    const t = res.blocks.find(b => b.type === "table")?.table
    assert.ok(t)
    assert.equal(t.rows, 12_000)
    assert.equal(t.cells[11_999][1].text, "행12000")
    assert.equal(res.warnings, undefined)
  })
})

describe("XLSX 시트 XML 을 행 묶음으로 나눠 DOM 을 만든다 (134만 칸 시트 RSS 4.4GB → 0.7~0.9GB)", () => {
  // 묶음 경계(약 26만 자)를 여러 번 넘는 크기 + r 없는 행이 경계를 넘어도 순번이 이어지고, sheetData 뒤 병합 목록도 읽는다
  const rows = (prefix: string, n: number) => Array.from({ length: n }, (_, i) =>
    i % 2 ? `<${prefix}row><${prefix}c t="inlineStr"><${prefix}is><${prefix}t>행${i + 1} 가나다라마바사아자차카타파하</${prefix}t></${prefix}is></${prefix}c><${prefix}c><${prefix}v>${i}</${prefix}v></${prefix}c></${prefix}row>`
      : `<${prefix}row r="${i + 1}"><${prefix}c r="A${i + 1}" t="inlineStr"><${prefix}is><${prefix}t>행${i + 1} 가나다라마바사아자차카타파하</${prefix}t></${prefix}is></${prefix}c><${prefix}c r="B${i + 1}"><${prefix}v>${i}</${prefix}v></${prefix}c></${prefix}row>`,
  ).join("")

  it("sheetData 안 CDATA 에 든 \"</row>\" 에서는 자르지 않는다 (통째 파싱으로 물러섬)", async () => {
    // 묶음 경계(26만 자)를 처음 넘는 "</row>" 가 CDATA 안의 것이 되게 그 자리 행에 CDATA 를 넣는다 — 가드가 없으면 CDATA 한가운데서 잘려 깨진다
    const plain = rows("", 3000)
    const cut = plain.lastIndexOf("<row ", 1 << 18)
    const k = Number(/<row r="(\d+)"/.exec(plain.slice(cut))![1])
    const open = `<row r="${k}"><c r="A${k}" t="inlineStr"><is><t><![CDATA[`
    const filler = "가".repeat((1 << 18) - (cut + open.length) + 10)
    const body = plain.slice(0, cut) + open + filler + "</row>뒤]]></t></is></c></row>" + plain.slice(plain.indexOf("</row>", cut) + 6)
    const zip = new JSZip()
    zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
    zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
    zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`)
    const res = await parseXlsx(await zip.generateAsync({ type: "arraybuffer" }))
    assert.equal(res.success, true)
    if (!res.success) return
    const t = res.blocks.find(b => b.type === "table")?.table
    assert.ok(t)
    assert.equal(t.rows, 3000)
    assert.equal(t.cells[k - 1][0].text, filler + "</row>뒤")
  })

  it("mergeCells 가 sheetData 앞에 있어도(스키마 순서 위반 생성기) 병합을 읽는다 — 통째 파싱하던 종전과 같이", async () => {
    const res = await parseXlsx(await buildXlsx(`<mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells>` +
      `<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>머리</t></is></c></row>` +
      `<row r="2"><c r="A2" t="inlineStr"><is><t>가</t></is></c><c r="B2" t="inlineStr"><is><t>나</t></is></c></row></sheetData>`))
    assert.equal(res.success, true)
    if (!res.success) return
    assert.equal(res.blocks.find(b => b.type === "table")?.table?.cells[0][0].colSpan, 2)
  })

  for (const prefix of ["", "x:"]) {
    it(`행 9,000개${prefix ? " (접두어 x: — 한셀)" : ""}: 행 수·끝 행·병합이 통째 파싱과 같다`, async () => {
      const ns = prefix ? `xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"` : `xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"`
      const sheet = `<?xml version="1.0" encoding="UTF-8"?><${prefix}worksheet ${ns}><${prefix}sheetData>${rows(prefix, 9000)}</${prefix}sheetData>` +
        `<${prefix}mergeCells count="1"><${prefix}mergeCell ref="A1:B1"/></${prefix}mergeCells></${prefix}worksheet>`
      assert.ok(sheet.length > 3 * (1 << 18), `묶음 경계를 여러 번 넘어야 한다 (${sheet.length}자)`)
      const zip = new JSZip()
      zip.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S1" sheetId="1" r:id="rId1"/></sheets></workbook>`)
      zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)
      zip.file("xl/worksheets/sheet1.xml", sheet)
      const res = await parseXlsx(await zip.generateAsync({ type: "arraybuffer" }))
      assert.equal(res.success, true)
      if (!res.success) return
      const t = res.blocks.find(b => b.type === "table")?.table
      assert.ok(t)
      assert.equal(t.rows, 9000)
      assert.equal(t.cells[0][0].colSpan, 2)
      assert.equal(t.cells[8999][0].text, "행9000 가나다라마바사아자차카타파하")
      assert.equal(t.cells[8999][1].text, "8999")
    })
  }
})

describe("병합은 펼칠 행 범위로 자른다", () => {
  it("끝 빈 행으로 뻗은 병합은 표 안에서 끝난다", () => {
    const rows = new Map<number, string[]>([[0, ["머리", "값"]], [1, ["가", "나"]]])
    const warnings: ParseWarning[] = []
    const blocks = sheetToBlocks("S", rows, 1, [{ r1: 1, c1: 0, r2: 3, c2: 0 }], 0, warnings)
    const t = blocks.find(b => b.type === "table")!.table!
    assert.equal(t.rows, 2)
    assert.equal(t.cells[1][0].rowSpan, 1)
  })

  it("글 없는 행에 머리가 있는 병합은 첫 행으로 머리를 옮겨 칸이 밀리지 않는다", () => {
    // 0행은 비어 있고(표에서 빠짐) A1:A3 병합이 1~2행의 A 칸을 덮는다 — 종전엔 덮인 A 칸만 빠져 "값" 이 A 열로 밀렸다
    const rows = new Map<number, string[]>([[0, ["", ""]], [1, ["", "값1"]], [2, ["", "값2"]]])
    const blocks = sheetToBlocks("S", rows, 1, [{ r1: 0, c1: 0, r2: 2, c2: 0 }], 0, [])
    const t = blocks.find(b => b.type === "table")!.table!
    assert.equal(t.rows, 2)
    assert.equal(t.cells[0][0].rowSpan, 2)
    assert.equal(t.cells[0][1].text, "값1")
    assert.equal(t.cells[1][1].text, "값2")
  })
})
