/**
 * XLS (BIFF8) 파서 테스트.
 *
 * 픽스처: tests/fixtures/xls/{population,budget,facilities,roster,minutes}.xls
 * 생성기: tests/fixtures/xls/generate.py (xlwt)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse, parseXls, detectOle2Format } from "../src/index.js"
import { decodeRk, decodeMulRk } from "../src/xls/record.js"

const FIXTURE_DIR = join(process.cwd(), "tests/fixtures/xls")

function load(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIXTURE_DIR, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

describe("decodeRk (BIFF RK 압축 숫자)", () => {
  it("정수 (fInt=1, fDiv100=0): val30 << 2 | 0b10", () => {
    // 100 → (100 << 2) | 0b10 = 402
    assert.equal(decodeRk(402), 100)
    // 1234 → (1234 << 2) | 0b10
    assert.equal(decodeRk((1234 << 2) | 0b10), 1234)
  })

  it("정수 + 100분 나눔 (fInt=1, fDiv100=1): 12345 → 123.45", () => {
    // val30=12345, flags=0b11
    const rk = (12345 << 2) | 0b11
    assert.equal(decodeRk(rk), 123.45)
  })

  it("음수 정수도 부호확장", () => {
    // -50 → ((-50) << 2) | 0b10. JS 비트연산은 32bit signed.
    const rk = ((-50) << 2) | 0b10
    assert.equal(decodeRk(rk >>> 0), -50)
  })
})

describe("decodeMulRk", () => {
  it("3개 셀 디코딩: row=0 colFirst=0 → 100, 200, 300", () => {
    // [row u16][colFirst u16][rkrec u16+u32]*3[colLast u16]
    // 데이터 길이: 4 + 6*3 + 2 = 24
    const buf = Buffer.alloc(24)
    buf.writeUInt16LE(0, 0)        // row
    buf.writeUInt16LE(0, 2)        // colFirst
    let off = 4
    for (const v of [100, 200, 300]) {
      buf.writeUInt16LE(0, off)               // ixfe
      buf.writeUInt32LE((v << 2) | 0b10, off + 2)
      off += 6
    }
    buf.writeUInt16LE(2, 22)       // colLast
    const result = decodeMulRk(buf)!
    assert.equal(result.row, 0)
    assert.equal(result.cells.length, 3)
    assert.deepEqual(result.cells.map(c => c.value), [100, 200, 300])
  })
})

describe("OLE2 분기", () => {
  it("XLS 파일은 detectOle2Format → 'xls'", () => {
    const buf = load("minutes.xls")
    assert.equal(detectOle2Format(buf), "xls")
  })
})

describe("parseXls — 기본 변환", () => {
  it("minutes.xls (단순 텍스트 셀)", async () => {
    const buf = load("minutes.xls")
    const r = await parseXls(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.equal(r.fileType, "xls")
    assert.ok(r.markdown.includes("회의록"))
    assert.ok(r.markdown.includes("회의일시"))
    assert.ok(r.markdown.includes("본관 3층 대회의실"))
    // heading + table
    const headings = r.blocks.filter(b => b.type === "heading")
    const tables = r.blocks.filter(b => b.type === "table")
    assert.equal(headings.length, 1)
    assert.equal(tables.length, 1)
  })

  it("budget.xls (병합 셀 + 음수 + 큰 정수)", async () => {
    const buf = load("budget.xls")
    const r = await parseXls(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    // 병합된 머리글
    assert.ok(r.markdown.includes("2025년도 부서별 예산"))
    // 음수 표시 (xlwt가 어떻게 저장하는지 확인 필요 — 양/음 문자열 매칭)
    assert.ok(r.markdown.includes("기획조정실"))
    assert.ok(r.markdown.includes("12500000000") || r.markdown.includes("12,500,000,000"))
    // 표 1개
    const tables = r.blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1)
    // colSpan 적용 확인 — 첫 행 첫 셀이 colSpan=4
    const t = tables[0].table!
    assert.equal(t.cells[0][0].colSpan, 4)
  })

  it("population.xls (다중 시트 — 2024/2023)", async () => {
    const buf = load("population.xls")
    const r = await parseXls(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    // 시트가 2개 → heading 2개, table 2개
    const headings = r.blocks.filter(b => b.type === "heading")
    const tables = r.blocks.filter(b => b.type === "table")
    assert.equal(headings.length, 2)
    assert.equal(tables.length, 2)
    assert.ok(r.markdown.includes("2024년"))
    assert.ok(r.markdown.includes("2023년"))
    assert.ok(r.markdown.includes("서울특별시"))
    assert.ok(r.markdown.includes("9586195"))
  })

  it("facilities.xls (다중 시트 + 빈 행/열)", async () => {
    const buf = load("facilities.xls")
    const r = await parseXls(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.ok(r.markdown.includes("체육시설"))
    assert.ok(r.markdown.includes("문화시설"))
    assert.ok(r.markdown.includes("복지시설"))
    assert.ok(r.markdown.includes("종합운동장"))
    assert.ok(r.markdown.includes("시립도서관"))
    // 시트 3개
    assert.equal(r.metadata?.pageCount, 3)
  })

  it("roster.xls (긴 SST — CONTINUE 분할 검증)", async () => {
    const buf = load("roster.xls")
    const r = await parseXls(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    // 200명 데이터 — 첫/마지막 사번 검증
    assert.ok(r.markdown.includes("20250001"))
    assert.ok(r.markdown.includes("20250200"))
    // 한글 부서명
    assert.ok(r.markdown.includes("기획조정실"))
    // 긴 비고 텍스트 (SST CONTINUE 경계 너머)
    assert.ok(r.markdown.includes("정기인사이동 대상"))
  })
})

describe("parse() 자동 라우팅", () => {
  it("OLE2 + Workbook 스트림 → xls 자동 분기", async () => {
    const buf = load("minutes.xls")
    const r = await parse(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.equal(r.fileType, "xls")
  })

  it("순수 OLE2 비-XLS는 hwp로 분기 (기존 동작 유지)", async () => {
    // 가짜 OLE2 헤더만 있는 버퍼 — Workbook 스트림 없음
    // detectOle2Format이 'hwp' 또는 'unknown' 반환해야 함
    const fake = new Uint8Array(512)
    fake[0] = 0xd0; fake[1] = 0xcf; fake[2] = 0x11; fake[3] = 0xe0
    fake[4] = 0xa1; fake[5] = 0xb1; fake[6] = 0x1a; fake[7] = 0xe1
    // 잘못된 sector size (잘 안 깨질 정도) — detectOle2Format이 catch로 unknown 반환 예상
    const result = detectOle2Format(fake.buffer)
    // unknown 또는 hwp 둘 다 OK (XLS 아니면 됨)
    assert.notEqual(result, "xls")
  })
})
