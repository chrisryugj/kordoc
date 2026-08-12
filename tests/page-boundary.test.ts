/**
 * 실제 페이지 경계 복원 (#66) 테스트.
 *
 * 신호 4종(vertpos 역행·명시 쪽나눔·셀 흐름 리셋·분할 표 직후 억제)과
 * 폴백(조판 캐시 없음 → 섹션 근사 + 경고)을 고정한다.
 * 실코퍼스 검증은 bench/corpus/pairs hwp↔hwpx↔pdf 대조로 수행(개발 시 6/6 일치).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DOMParser } from "@xmldom/xmldom"
import JSZip from "jszip"
import { parseHwpx } from "../src/index.js"
import { detectHwpxSectionPages } from "../src/hwpx/page-boundary.js"
import { detectHwp5SectionPages } from "../src/hwp5/page-boundary.js"
import { parseSection } from "../src/hwp5/parser.js"
import type { HwpRecord } from "../src/hwp5/record.js"

// ─── HWPX 유닛 ──────────────────────────────────────

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function secRoot(body: string): Element {
  const xml = `<?xml version="1.0" encoding="UTF-8"?><hs:sec ${SEC_NS}>${body}</hs:sec>`
  const doc = new DOMParser().parseFromString(xml, "text/xml")
  return doc.documentElement as unknown as Element
}

const para = (segs: Array<[number, number]>, opts?: { pageBreak?: string; text?: string; tbl?: string }) => {
  const lsa = segs.length
    ? `<hp:linesegarray>${segs.map(([v, h]) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="${h}" horzsize="42520" flags="393216"/>`).join("")}</hp:linesegarray>`
    : ""
  const pb = opts?.pageBreak ? ` pageBreak="${opts.pageBreak}"` : ""
  return `<hp:p${pb} paraPrIDRef="0">${lsa}<hp:run charPrIDRef="0">${opts?.tbl ?? ""}<hp:t>${opts?.text ?? "본문"}</hp:t></hp:run></hp:p>`
}

describe("detectHwpxSectionPages — 신호별", () => {
  it("vertpos 역행이 페이지 경계다", () => {
    const root = secRoot([
      para([[0, 0]]), para([[2000, 0]]), para([[64000, 0]]),
      para([[0, 0]]), para([[3000, 0]]),
    ].join(""))
    const d = detectHwpxSectionPages(root)
    assert.equal(d.pages, 2)
    assert.deepEqual([...d.paraPage.values()], [0, 0, 0, 1, 1])
    assert.equal(d.usable, true)
  })

  it("명시 쪽나눔(pageBreak=1)은 역행 없이도 경계 — 첫 seg 역행과 중복 시 1회만", () => {
    const root = secRoot([
      para([[0, 0]]), para([[2000, 0]]),
      para([[0, 0]], { pageBreak: "1" }), // 역행+명시 동시 → +1만
      para([[3000, 0]], { pageBreak: "1" }), // 역행 없는 명시 → +1
    ].join(""))
    const d = detectHwpxSectionPages(root)
    assert.equal(d.pages, 3)
    assert.deepEqual([...d.paraPage.values()], [0, 0, 1, 2])
  })

  it("동일 vertpos + 문단 첫 seg + horzpos 비전진도 경계 (전면 표 연속)", () => {
    const root = secRoot([para([[0, 0]]), para([[0, 0]]), para([[0, 0]])].join(""))
    const d = detectHwpxSectionPages(root)
    assert.equal(d.pages, 3)
  })

  it("섹션 첫 문단의 pageBreak=1은 세지 않는다", () => {
    const root = secRoot([para([[0, 0]], { pageBreak: "1" }), para([[2000, 0]])].join(""))
    assert.equal(detectHwpxSectionPages(root).pages, 1)
  })

  it("linesegarray 없는 문단이 있으면 usable=false", () => {
    const root = secRoot([para([[0, 0]]), para([])].join(""))
    const d = detectHwpxSectionPages(root)
    assert.equal(d.usable, false)
  })

  it("페이지 걸침 표: 셀 직접 문단 흐름의 리셋을 행별 max로 합산", () => {
    // 1×1 표 — 셀 내부 v열 [0,60000,0(리셋),5000] → 표가 1페이지 더 차지
    const tbl = `<hp:tbl rowCnt="1" colCnt="1" pageBreak="CELL"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:subList>${
      para([[0, 0]], { text: "셀1" })}${para([[60000, 0]], { text: "셀2" })}${para([[0, 0]], { text: "셀3" })}${para([[5000, 0]], { text: "셀4" })
    }</hp:subList></hp:tc></hp:tr></hp:tbl>`
    const root = secRoot([
      para([[0, 0]], { tbl, text: "" }),
      para([[30000, 0]], { text: "표 다음" }), // 표 꼬리(중간높이) 아래 재개 — 역행 아님
    ].join(""))
    const d = detectHwpxSectionPages(root)
    assert.equal(d.pages, 2)
    assert.deepEqual([...d.paraPage.values()], [0, 1])
  })

  it("분할 표 직후 중간높이 역행은 같은 경계로 1회 억제, 페이지 상단 역행은 정상 카운트", () => {
    const cell = (vs: number[]) => `<hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc><hp:cellAddr colAddr="0" rowAddr="0"/><hp:subList>${
      vs.map(v => para([[v, 0]], { text: "c" })).join("")}</hp:subList></hp:tc></hp:tr></hp:tbl>`
    // 호스트(v20000) → 표 셀 리셋 1회 → 다음 문단 v26000<prev(중간높이 역행) = 같은 경계
    const suppressed = secRoot([
      para([[20000, 0]], { tbl: cell([0, 50000, 0, 20000]), text: "" }),
      para([[26000, 0]], { text: "표 아래" }),
    ].join(""))
    assert.equal(detectHwpxSectionPages(suppressed).pages, 2)
    // 반면 페이지 상단(v0) 역행은 새 페이지
    const newPage = secRoot([
      para([[20000, 0]], { tbl: cell([0, 50000, 0, 20000]), text: "" }),
      para([[0, 0]], { text: "새 페이지" }),
    ].join(""))
    assert.equal(detectHwpxSectionPages(newPage).pages, 3)
  })
})

// ─── HWPX 통합 (parseHwpx) ──────────────────────────

async function buildHwpx(sectionBody: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
  )
  zip.file(
    "Contents/content.hpf",
    `<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version=""><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>`,
  )
  zip.file(
    "Contents/header.xml",
    `<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4" secCnt="1"></hh:head>`,
  )
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8"?><hs:sec ${SEC_NS}>${sectionBody}</hs:sec>`)
  const buf = await zip.generateAsync({ type: "nodebuffer" })
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

describe("parseHwpx — 실제 페이지 메타데이터·필터 (#66)", () => {
  it("조판 캐시 문서: pageMode=layout, 실제 pageCount, 블록별 실제 페이지", async () => {
    const buf = await buildHwpx([
      para([[0, 0]], { text: "1쪽 문단" }),
      para([[3000, 0]], { text: "1쪽 둘째" }),
      para([[0, 0]], { text: "2쪽 문단" }),
    ].join(""))
    const r = await parseHwpx(buf)
    assert.equal(r.success, true)
    if (!r.success) return
    assert.equal(r.metadata?.pageMode, "layout")
    assert.equal(r.pageCount, 2)
    assert.deepEqual(r.blocks?.map(b => b.pageNumber), [1, 1, 2])
  })

  it("pages 필터가 실제 페이지 기준으로 동작한다", async () => {
    const buf = await buildHwpx([
      para([[0, 0]], { text: "1쪽 문단" }),
      para([[0, 0]], { text: "2쪽 문단" }),
      para([[0, 0]], { text: "3쪽 문단" }),
    ].join(""))
    const r = await parseHwpx(buf, { pages: "2" })
    assert.equal(r.success, true)
    if (!r.success) return
    assert.equal(r.pageCount, 3)
    assert.deepEqual(r.blocks?.map(b => [b.text, b.pageNumber]), [["2쪽 문단", 2]])
    assert.ok(!r.warnings?.some(w => w.code === "PAGE_BOUNDARY_APPROXIMATE"))
  })

  it("조판 캐시 없는 문서: pageMode=section + pages 필터 시 근사 경고", async () => {
    const buf = await buildHwpx([
      para([], { text: "캐시 없는 문단" }),
      para([], { text: "둘째 문단" }),
    ].join(""))
    const r = await parseHwpx(buf, { pages: "1" })
    assert.equal(r.success, true)
    if (!r.success) return
    assert.equal(r.metadata?.pageMode, "section")
    assert.equal(r.pageCount, 1) // 섹션 수
    assert.equal(r.blocks?.length, 2) // 섹션1 전체
    assert.ok(r.warnings?.some(w => w.code === "PAGE_BOUNDARY_APPROXIMATE"))
  })
})

// ─── HWP5 유닛 (합성 레코드) ─────────────────────────

function rec(tagId: number, level: number, data: Buffer): HwpRecord {
  return { tagId, level, size: data.length, data }
}

/** PARA_HEADER 데이터 — offset 11 = 문단 나눔 종류(bit2 쪽나눔) */
function paraHeader(divideSort = 0): Buffer {
  const b = Buffer.alloc(16)
  b.writeUInt8(divideSort, 11)
  return b
}

/** PARA_LINE_SEG 데이터 — 36B 엔트리(v@+4, h@+24) */
function lineSeg(entries: Array<[number, number]>): Buffer {
  const b = Buffer.alloc(entries.length * 36)
  entries.forEach(([v, h], i) => {
    b.writeInt32LE(v, i * 36 + 4)
    b.writeInt32LE(h, i * 36 + 24)
  })
  return b
}

/** PARA_TEXT 데이터 — UTF-16LE */
function paraText(s: string): Buffer {
  return Buffer.from(s, "utf16le")
}

const topPara = (segs: Array<[number, number]>, opts?: { divideSort?: number; text?: string }): HwpRecord[] => [
  rec(0x42, 0, paraHeader(opts?.divideSort ?? 0)),
  rec(0x43, 1, paraText(opts?.text ?? "본문")),
  ...(segs.length ? [rec(0x45, 1, lineSeg(segs))] : []),
]

describe("detectHwp5SectionPages — 신호별", () => {
  it("vertpos 역행이 페이지 경계다", () => {
    const records = [
      ...topPara([[0, 0]]), ...topPara([[60000, 0]]), ...topPara([[0, 0]]),
    ]
    const d = detectHwp5SectionPages(records)
    assert.equal(d.pages, 2)
    assert.deepEqual(d.pageAtPara, [0, 0, 1])
    assert.equal(d.usable, true)
  })

  it("PARA_HEADER 쪽나눔 비트(0x04)는 역행 없이도 경계 — 역행과 중복 시 1회만", () => {
    const records = [
      ...topPara([[0, 0]]), ...topPara([[2000, 0]]),
      ...topPara([[0, 0]], { divideSort: 0x04 }),
      ...topPara([[3000, 0]], { divideSort: 0x04 }),
    ]
    const d = detectHwp5SectionPages(records)
    assert.equal(d.pages, 3)
    assert.deepEqual(d.pageAtPara, [0, 0, 1, 2])
  })

  it("LINE_SEG 없는 문단이 있으면 usable=false", () => {
    const d = detectHwp5SectionPages([...topPara([[0, 0]]), ...topPara([])])
    assert.equal(d.usable, false)
  })

  it("표 셀 흐름 리셋을 복원하고 직후 중간높이 역행을 억제한다", () => {
    // CTRL_HEADER('tbl ') L1 → LIST_HEADER L2(row 0) → 셀 문단 L2 + LINE_SEG L3
    const ctrlTbl = Buffer.alloc(8)
    ctrlTbl.writeUInt32LE(0x74626c20, 0)
    const listHeader = Buffer.alloc(16) // paraCount u32, flags u32, col u16@8, row u16@10
    const records = [
      rec(0x42, 0, paraHeader()),
      rec(0x43, 1, paraText("표 호스트")),
      rec(0x45, 1, lineSeg([[20000, 0]])),
      rec(0x47, 1, ctrlTbl),
      rec(0x48, 2, listHeader),
      rec(0x42, 2, paraHeader()), rec(0x45, 3, lineSeg([[0, 0], [50000, 0]])),
      rec(0x42, 2, paraHeader()), rec(0x45, 3, lineSeg([[0, 0]])), // 리셋 — 표가 다음 페이지로
      ...topPara([[26000, 0]], { text: "표 꼬리 아래" }), // 중간높이 역행 → 억제
      ...topPara([[0, 0]], { text: "진짜 새 페이지" }),
    ]
    const d = detectHwp5SectionPages(records)
    assert.equal(d.pages, 3)
    assert.deepEqual(d.pageAtPara, [0, 1, 2])
  })
})

describe("parseSection — pageMap 배선", () => {
  it("pageMap이 있으면 블록 pageNumber가 실제 페이지, 없으면 섹션 번호", () => {
    const records = [
      ...topPara([[0, 0]], { text: "첫 문단" }),
      ...topPara([[0, 0]], { text: "둘째 문단" }),
    ]
    const withMap = parseSection(records, null, [], 1, undefined, { base: 0, pageAtPara: [0, 1] })
    assert.deepEqual(withMap.map(b => b.pageNumber), [1, 2])
    const withoutMap = parseSection(records, null, [], 3)
    assert.deepEqual(withoutMap.map(b => b.pageNumber), [3, 3])
  })
})
