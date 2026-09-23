/**
 * HWP5 문서 요약 정보(\005HwpSummaryInformation) → DocumentMetadata.
 *
 * 한컴은 코드 페이지 속성 없이 문자열을 전부 VT_LPWSTR(0x1F)로 쓴다(코퍼스 1,435건 전부) — 종전 파서는 VT_LPSTR 만
 * 읽어 제목·지은이가 한 번도 나오지 않았다. 합성 속성 집합(MS-OLEPS)으로 VT_LPWSTR·VT_LPSTR(코드 페이지)·VT_FILETIME 고정.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { parseHwp5Document, extractHwp5MetadataOnly } from "../src/hwp5/parser.js"
import { TAG_PARA_HEADER, TAG_PARA_TEXT } from "../src/hwp5/record.js"

interface CfbDoc { [key: string]: unknown }
const require = createRequire(import.meta.url)
const CFB: {
  utils: { cfb_new(): CfbDoc; cfb_add(cfb: CfbDoc, path: string, data: Buffer): void }
  write(cfb: CfbDoc, opts: { type: "buffer" }): Buffer
} = require("cfb")

// ─── 합성 속성 값 (type u32 + 본체, 4바이트 정렬) ───────

const pad4 = (b: Buffer): Buffer => Buffer.concat([b, Buffer.alloc((4 - (b.length % 4)) % 4)])
const u32 = (v: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b }
/** VT_LPWSTR — 글자 수(NUL 포함) + UTF-16LE */
const lpwstr = (s: string): Buffer => pad4(Buffer.concat([u32(0x1f), u32(s.length + 1), Buffer.from(s + "\0", "utf16le")]))
/** VT_LPSTR — 바이트 수(NUL 포함) + 코드 페이지 바이트 */
const lpstr = (bytes: Buffer): Buffer => pad4(Buffer.concat([u32(0x1e), u32(bytes.length + 1), bytes, Buffer.alloc(1)]))
/** VT_I2 (PID_CODEPAGE) */
const i2 = (v: number): Buffer => { const b = Buffer.alloc(8); b.writeUInt32LE(0x02, 0); b.writeUInt16LE(v, 4); return b }
/** VT_FILETIME — ISO 시각 → 1601 기준 100ns */
const filetime = (iso: string | null): Buffer => {
  const b = Buffer.alloc(12)
  b.writeUInt32LE(0x40, 0)
  if (iso) b.writeBigUInt64LE((BigInt(Date.parse(iso)) + 11644473600000n) * 10000n, 4)
  return b
}

/** 속성 집합 스트림 — 헤더(28) + FMTID·오프셋(20) + [크기·개수·(ID,오프셋)×N] + 값 */
function summaryStream(props: Array<[number, Buffer]>): Buffer {
  const header = Buffer.alloc(48)
  header.writeUInt16LE(0xfffe, 0)
  header.writeUInt32LE(1, 24)
  Buffer.from("60b6a29f6110d411b4c6006097c09d8c", "hex").copy(header, 28) // 한컴 FMTID {9FA2B660-1061-11D4-B4C6-006097C09D8C}
  header.writeUInt32LE(48, 44)
  const table = Buffer.alloc(8 + props.length * 8)
  let off = table.length
  props.forEach(([id, value], i) => {
    table.writeUInt32LE(id, 8 + i * 8)
    table.writeUInt32LE(off, 12 + i * 8)
    off += value.length
  })
  table.writeUInt32LE(off, 0)
  table.writeUInt32LE(props.length, 4)
  return Buffer.concat([header, table, ...props.map(([, v]) => v)])
}

function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}

/** 비압축 HWP5 (FileHeader + 본문 1문단 + 요약 정보) */
function buildHwp5(summary: Buffer): Buffer {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "utf8")
  fileHeader[35] = 5
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/\x05HwpSummaryInformation", summary)
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", Buffer.concat([rec(TAG_PARA_HEADER, 0, Buffer.alloc(12)), rec(TAG_PARA_TEXT, 1, Buffer.from("본문", "utf16le"))]))
  return Buffer.from(CFB.write(cfb, { type: "buffer" }))
}

describe("HWP5 요약 정보 메타데이터", () => {
  it("VT_LPWSTR (한컴 실측 배치: 코드 페이지 없음, 14개 속성) → 제목·지은이·설명·키워드·날짜", () => {
    const buf = buildHwp5(summaryStream([
      [2, lpwstr("통계청 공고  제 2020 ")], // 뒤 공백 — xml:space="preserve" 로 content.hpf 에도 있음
      [3, lpwstr("주제")],
      [4, lpwstr("홍길동")],
      [20, lpwstr("2020년 2월 24일 월요일 오후 8:37:33")],
      [5, lpwstr("예산, 결산;회계")],
      [6, lpwstr("")],
      [8, lpwstr("user")],
      [9, lpwstr("10, 0, 0, 7511 WIN32LEWindows_8")],
      [12, filetime("2008-09-16T00:00:00.000Z")], // 정각 — double 변환이면 1초 앞당겨질 수 있는 값
      [13, filetime("2020-02-24T12:07:30.365Z")],
      [11, filetime(null)], // 인쇄한 적 없음 = 0
      [14, Buffer.concat([u32(0x03), u32(0)])],
      [21, Buffer.concat([u32(0x03), u32(0)])],
    ]))
    const expected = {
      title: "통계청 공고  제 2020",
      author: "홍길동",
      description: "주제", // 설명(6)이 비면 주제(3)
      keywords: ["예산", "결산", "회계"],
      createdAt: "2008-09-16T00:00:00Z",
      modifiedAt: "2020-02-24T12:07:30Z", // 초 단위로 자름 (content.hpf ModifiedDate 꼴)
    }
    const md = parseHwp5Document(buf).metadata
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(md[k as keyof typeof md], v, k)
    const only = extractHwp5MetadataOnly(buf)
    for (const [k, v] of Object.entries(expected)) assert.deepEqual(only[k as keyof typeof only], v, `only.${k}`)
  })

  it("설명(6)이 있으면 주제(3)보다 먼저", () => {
    const md = parseHwp5Document(buildHwp5(summaryStream([[3, lpwstr("주제")], [6, lpwstr("설명")]]))).metadata
    assert.equal(md.description, "설명")
  })

  it("VT_LPSTR 는 PID_CODEPAGE 로 해석 — 949 = EUC-KR(코드 페이지가 뒤에 와도), 1200 = UTF-16LE, 없으면 UTF-8", () => {
    const euckr = parseHwp5Document(buildHwp5(summaryStream([
      [2, lpstr(Buffer.from("c7d1b1db20c1a6b8f1", "hex"))], // "한글 제목"
      [1, i2(949)],
    ]))).metadata
    assert.equal(euckr.title, "한글 제목")
    const utf16Lpstr = Buffer.concat([u32(0x1e), u32(8), Buffer.from("김철수\0", "utf16le")]) // 크기 = 바이트 수(NUL 2바이트 포함)
    const unicode = parseHwp5Document(buildHwp5(summaryStream([[1, i2(1200)], [4, utf16Lpstr]]))).metadata
    assert.equal(unicode.author, "김철수")
    const noCp = parseHwp5Document(buildHwp5(summaryStream([[4, lpstr(Buffer.from("김철수", "utf8"))]]))).metadata
    assert.equal(noCp.author, "김철수")
  })

  it("잘린 값·모르는 형식·빈 문자열은 건너뛰고 나머지는 읽는다", () => {
    const truncated = Buffer.concat([u32(0x1f), u32(5000), Buffer.from("짧", "utf16le")]) // 글자 수가 스트림보다 큼
    const md = parseHwp5Document(buildHwp5(summaryStream([
      [2, truncated],
      [3, Buffer.concat([u32(0x41), u32(4), u32(0)])], // VT_BLOB — 문자열 아님
      [6, lpwstr("   ")],
      [4, lpwstr("지은이")],
    ]))).metadata
    assert.equal(md.title, undefined)
    assert.equal(md.description, undefined)
    assert.equal(md.author, "지은이")
    assert.equal(md.createdAt, undefined)
  })
})
