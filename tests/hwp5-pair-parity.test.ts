/**
 * HWP5 ↔ HWPX 쌍 대칭 회귀 — 같은 문서를 두 포맷으로 읽었을 때 IR 이 갈라지던 HWP5 쪽 원인들 (bench HWP5 쌍 트랙).
 *
 * 표 계약(후행 빈 열 트림·span 절단)·캡션 안 표의 TABLE 레벨·손상 표(행·열 0, 앵커 겹침)·머리말/각주 안 표·
 * 글자처럼 취급 표 앞뒤 글 순서·채움(리더) 탭 절단·미기입 누름틀 안내문·셀 각주 접기·WMF/TIFF 이미지 판별.
 * 합성 레코드 버퍼 기반 (hwp5-v3.test.ts 와 같은 빌더).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseSection, createHwp5DocState } from "../src/hwp5/parser.js"
import {
  readRecords, TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE, TAG_SHAPE_COMPONENT_PICTURE,
} from "../src/hwp5/record.js"
import { detectImageMime, extractHwp5Images } from "../src/hwp5/images.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock, ParseWarning } from "../src/types.js"

// ─── 합성 레코드 빌더 ────────────────────────────────

function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}
const utf16 = (s: string): Buffer => Buffer.from(s, "utf16le")
function paraHeaderData(): Buffer { return Buffer.alloc(12) }
/** 확장 컨트롤 문자 (16B): ch + ctrlId(on-disk 4B) + 8B + ch */
function extCtrlChar(ch: number, diskAscii: string): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt16LE(ch, 0)
  buf.write(diskAscii, 2, "ascii")
  buf.writeUInt16LE(ch, 14)
  return buf
}
/** 탭 (16B) — 확장 u16[2] 하위 바이트 = 채움 모양, 상위 = 종류+1 (한컴 목차 실측 0x0203 = 오른쪽·점선) */
function tabChar(fill: number): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt16LE(0x09, 0)
  buf.writeUInt16LE(0x91fe, 2)
  buf.writeUInt16LE((fill ? 0x0200 : 0x0100) | fill, 6)
  buf.writeUInt16LE(0x09, 14)
  return buf
}
/** 표 CTRL_HEADER 데이터 — attr bit 0 = 글자처럼 취급 */
function tblCtrl(inline = false): Buffer {
  const buf = Buffer.alloc(8)
  buf.write(" lbt", 0, "ascii")
  buf.writeUInt32LE(inline ? 1 : 0, 4)
  return buf
}
function cellLH(col: number, row: number, colSpan = 1, rowSpan = 1): Buffer {
  const buf = Buffer.alloc(34)
  buf.writeUInt16LE(1, 0)
  buf.writeUInt16LE(col, 8)
  buf.writeUInt16LE(row, 10)
  buf.writeUInt16LE(colSpan, 12)
  buf.writeUInt16LE(rowSpan, 14)
  return buf
}
function tableRecData(rows: number, cols: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt16LE(rows, 4)
  buf.writeUInt16LE(cols, 6)
  return buf
}
/** 셀 (level L = 표 CTRL_HEADER 레벨 + 1): LIST_HEADER + 문단 */
function cell(L: number, col: number, row: number, text: string, cs = 1, rs = 1): Buffer[] {
  return [rec(TAG_LIST_HEADER, L, cellLH(col, row, cs, rs)), rec(TAG_PARA_HEADER, L, paraHeaderData()), ...(text ? [rec(TAG_PARA_TEXT, L + 1, utf16(text))] : [])]
}
/** 누름틀(%clk) CTRL_HEADER — ctrl_id + 속성(4) + 기타(1) + command 길이(2) + command + id(4) */
function clkCtrlData(guide: string, modified: boolean): Buffer {
  const command = `Clickhere:set:${guide.length + 38}:Direction:wstring:${guide.length}:${guide} HelpState:wstring:0:  `
  const head = Buffer.alloc(7)
  head.writeUInt32LE(modified ? 1 << 15 : 1, 0)
  head.writeUInt16LE(command.length, 5)
  return Buffer.concat([Buffer.from("klc%", "ascii"), head, utf16(command), Buffer.alloc(4)])
}

function parse(buffers: Buffer[], doc = createHwp5DocState()) {
  const warnings: ParseWarning[] = []
  const blocks = parseSection(readRecords(Buffer.concat(buffers)), null, warnings, 1, doc)
  return { blocks, doc }
}
const tables = (blocks: IRBlock[]) => blocks.filter(b => b.type === "table").map(b => b.table!)

// ─── 표 계약 ─────────────────────────────────────────

describe("좌표 셀 표 — builder 계약(후행 빈 열 트림) — HWPX 와 같은 모양", () => {
  const body = (): Buffer[] => [
    rec(TAG_PARA_HEADER, 0, paraHeaderData()),
    rec(TAG_CTRL_HEADER, 1, tblCtrl()),
    rec(TAG_TABLE, 2, tableRecData(2, 3)),
    ...cell(2, 0, 0, "제목", 3),        // 3열 병합 제목행
    ...cell(2, 0, 1, "성명"), ...cell(2, 1, 1, "홍길동"), ...cell(2, 2, 1, ""), // 빈 입력란 열
  ]

  it("글 없는 마지막 열은 잘리고, 그 열에 걸친 병합은 표 폭 안으로 줄인다", () => {
    const [t] = tables(parse(body()).blocks)
    assert.equal(t.rows, 2)
    assert.equal(t.cols, 2)
    assert.equal(t.cells[0][0].colSpan, 2)
    assert.equal(t.cells[1][1].text, "홍길동")
  })

  it("keepTrailingEmptyCols 면 앵커 있는 빈 열 보존 (#47 — 종전 좌표 경로는 옵션과 무관하게 항상 보존)", () => {
    const doc = createHwp5DocState()
    doc.keepTrailingEmptyCols = true
    const [t] = tables(parse(body(), doc).blocks)
    assert.equal(t.cols, 3)
    assert.equal(t.cells[0][0].colSpan, 3)
  })

  it("셀 blocks(중첩표)·제목 셀은 좌표로 재부착", () => {
    const hdr = cellLH(0, 0)
    hdr.writeUInt16LE(0x04, 6) // 제목 셀
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_TABLE, 2, tableRecData(1, 2)),
      rec(TAG_LIST_HEADER, 2, hdr), rec(TAG_PARA_HEADER, 2, paraHeaderData()), rec(TAG_PARA_TEXT, 3, utf16("머리")),
      rec(TAG_LIST_HEADER, 2, cellLH(1, 0)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, tblCtrl()),
      rec(TAG_TABLE, 4, tableRecData(1, 1)),
      ...cell(4, 0, 0, "안"),
    ])
    const [t] = tables(blocks)
    assert.equal(t.cells[0][0].isHeader, true)
    assert.equal(t.cells[0][1].blocks?.find(b => b.type === "table")?.table?.cells[0][0].text, "안")
  })
})

describe("캡션 안 표 — 직계 레벨 TABLE 레코드만 (rhwp #3528)", () => {
  it("캡션 문단의 표가 먼저 방출해도 바깥 표 행/열·캡션이 온전하다", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)), // 캡션
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("표 1. 캡션")),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, tblCtrl()),
      rec(TAG_TABLE, 4, tableRecData(1, 1)),       // 캡션 안 표 — 바깥 TABLE 보다 앞
      ...cell(4, 0, 0, "캡션표"),
      rec(TAG_TABLE, 2, tableRecData(1, 2)),       // 바깥 표
      ...cell(2, 0, 0, "가"), ...cell(2, 1, 0, "나"),
    ])
    const [t] = tables(blocks)
    assert.equal(t.rows, 1)
    assert.equal(t.cols, 2)
    assert.deepEqual([t.cells[0][0].text, t.cells[0][1].text], ["가", "나"])
    assert.equal(t.caption, "표 1. 캡션 캡션표")
  })
})

describe("손상 표 — 글을 버리지 않는다", () => {
  it("TABLE 행·열 수 0 → 셀 좌표로 경계", () => {
    const [t] = tables(parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_TABLE, 2, tableRecData(0, 0)),
      ...cell(2, 0, 0, "하나"), ...cell(2, 1, 0, "둘"), ...cell(2, 0, 1, "셋"), ...cell(2, 1, 1, "넷"),
    ]).blocks)
    assert.equal(t.rows, 2)
    assert.equal(t.cols, 2)
    assert.equal(t.cells[1][1].text, "넷")
  })

  it("앵커 겹침 — 먼저 나온 셀이 칸을 갖고 뒤 셀 글은 이어 붙는다, 겹치는 병합은 줄인다", () => {
    const [t] = tables(parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_TABLE, 2, tableRecData(2, 2)),
      ...cell(2, 0, 0, "앞"), ...cell(2, 0, 0, "뒤"),   // 같은 앵커
      ...cell(2, 1, 0, "우", 1, 2),                     // 오른쪽 열 2행 병합
      ...cell(2, 0, 1, "아래", 2, 1),                   // 오른쪽 병합 영역을 덮는 병합 → 1열로
    ]).blocks)
    assert.equal(t.cells[0][0].text, "앞\n뒤")
    assert.equal(t.cells[0][1].rowSpan, 2)
    assert.equal(t.cells[1][0].text, "아래")
    assert.equal(t.cells[1][0].colSpan, 1)
  })
})

// ─── 머리말·각주 안 표 ───────────────────────────────

describe("머리말·각주 안 표 — 평탄화로 보존 (종전 통째 유실)", () => {
  it("머리말 표 → 셀 ' / ' · 행 줄바꿈 (HWPX buildSubListTable 대칭)", () => {
    const { doc } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([extCtrlChar(0x10, "daeh"), utf16("본문")])),
      rec(TAG_CTRL_HEADER, 1, Buffer.from("daeh", "ascii")),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, tblCtrl()),
      rec(TAG_TABLE, 4, tableRecData(2, 2)),
      ...cell(4, 0, 0, "수능 모의고사"), ...cell(4, 1, 0, "22-09 교육"),
      ...cell(4, 0, 1, "홀수형"), ...cell(4, 1, 1, ""),
    ])
    assert.equal(doc.headerBlocks[0]?.text, "수능 모의고사 / 22-09 교육\n홀수형")
  })

  it("각주 안 표도 각주 글에 남는다", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("본문"), extCtrlChar(17, "  nf")])),
      rec(TAG_CTRL_HEADER, 1, Buffer.concat([Buffer.from("  nf", "ascii"), Buffer.alloc(12)])),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("출처")),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, tblCtrl()),
      rec(TAG_TABLE, 4, tableRecData(1, 2)),
      ...cell(4, 0, 0, "기관"), ...cell(4, 1, 0, "연도"),
    ])
    assert.equal(blocks[0].footnoteText, "1) 출처 기관 / 연도")
  })
})

// ─── 글자처럼 취급 표 ────────────────────────────────

describe("글자처럼 취급 표 — 앞뒤 글을 표 자리에서 나눈다 (#49/#50 HWPX 대칭)", () => {
  const inlinePara = (L: number, inline: boolean): Buffer[] => [
    rec(TAG_PARA_HEADER, L, paraHeaderData()),
    rec(TAG_PARA_TEXT, L + 1, Buffer.concat([utf16("앞 글"), extCtrlChar(0x0b, " lbt"), utf16("뒤 글")])),
    rec(TAG_CTRL_HEADER, L + 1, tblCtrl(inline)),
    rec(TAG_TABLE, L + 2, tableRecData(1, 2)),
    ...cell(L + 2, 0, 0, "가"), ...cell(L + 2, 1, 0, "나"),
  ]

  it("본문 — [앞 글, 표, 뒤 글] 순서 (종전 [앞 글뒤 글, 표])", () => {
    const { blocks } = parse(inlinePara(0, true))
    assert.deepEqual(blocks.map(b => b.type === "table" ? "표" : b.text), ["앞 글", "표", "뒤 글"])
  })

  it("떠 있는 표는 종전대로 문단 글 뒤", () => {
    const { blocks } = parse(inlinePara(0, false))
    assert.deepEqual(blocks.map(b => b.type === "table" ? "표" : b.text), ["앞 글뒤 글", "표"])
  })

  it("셀 안 — 평탄화 텍스트는 한 줄(공백 이음), blocks 는 원문 순서", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_TABLE, 2, tableRecData(1, 1)),
      rec(TAG_LIST_HEADER, 2, cellLH(0, 0)),
      ...inlinePara(2, true),
    ])
    const c = tables(blocks)[0].cells[0][0]
    assert.equal(c.text, "앞 글 가 / 나 뒤 글")
    assert.deepEqual(c.blocks?.map(b => b.type === "table" ? "표" : b.text), ["앞 글", "표", "뒤 글"])
  })
})

// ─── 채움 탭 · 누름틀 · 셀 각주 ───────────────────────

describe("채움(리더) 탭 — 뒤 목차 쪽번호 절단 (HWPX leader-tab-cut 대칭)", () => {
  it("채움 모양 ≠ 0 탭 뒤는 버리고, 보통 탭은 남긴다", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("Ⅰ. 개요"), tabChar(3), utf16(" 12")])),
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("성명"), tabChar(0), utf16("홍길동")])),
    ])
    assert.deepEqual(blocks.map(b => b.text), ["Ⅰ. 개요", "성명\t홍길동"])
  })
})

describe("누름틀 안내문 — 미기입(수정 비트 0) + 안내문과 같은 글이면 값이 아니다 (한컴 PDF 에 없음)", () => {
  const clkPara = (value: string, guide: string, modified: boolean): Buffer[] => [
    rec(TAG_PARA_HEADER, 0, paraHeaderData()),
    rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("근거 "), extCtrlChar(0x03, "klc%"), utf16(value), extCtrlChar(0x04, "klc%"), utf16(" 끝")])),
    rec(TAG_CTRL_HEADER, 1, clkCtrlData(guide, modified)),
  ]

  it("미기입 안내문 run 제거", () => {
    assert.equal(parse(clkPara("적용이면 O표시", "적용이면 O표시", false)).blocks[0].text, "근거  끝")
  })
  it("수정된 필드·안내문과 다른 값은 그대로", () => {
    assert.equal(parse(clkPara("적용이면 O표시", "적용이면 O표시", true)).blocks[0].text, "근거 적용이면 O표시 끝")
    assert.equal(parse(clkPara("해당없음", "적용이면 O표시", false)).blocks[0].text, "근거 해당없음 끝")
  })
})

describe("셀 문단 각주 — 문단 글에 접는다 (HWPX 셀 블록 대칭, HTML 병합표에서 각주 유실 수정)", () => {
  it("병합 셀 HTML 경로에서도 각주가 남는다", () => {
    const footPara = (L: number): Buffer[] => [
      rec(TAG_PARA_HEADER, L, paraHeaderData()),
      rec(TAG_PARA_TEXT, L + 1, Buffer.concat([utf16("법령"), extCtrlChar(17, "  nf")])),
      rec(TAG_CTRL_HEADER, L + 1, Buffer.concat([Buffer.from("  nf", "ascii"), Buffer.alloc(12)])),
      rec(TAG_LIST_HEADER, L + 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, L + 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, L + 3, utf16("CFR 설명")),
    ]
    const pic = Buffer.alloc(73)
    pic.writeUInt16LE(1, 71)
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, tblCtrl()),
      rec(TAG_TABLE, 2, tableRecData(2, 2)),
      ...cell(2, 0, 0, "병합", 1, 2),
      rec(TAG_LIST_HEADER, 2, cellLH(1, 0)), ...footPara(2),
      // 그림을 품은 셀 — blocks 가 달리는 경로
      rec(TAG_LIST_HEADER, 2, cellLH(1, 1)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, Buffer.from(" osg", "ascii")),
      rec(TAG_SHAPE_COMPONENT_PICTURE, 4, pic),
    ])
    const t = tables(blocks)[0]
    assert.equal(t.cells[0][1].text, "법령1) (주: 1) CFR 설명)")
    assert.equal(t.cells[0][1].blocks, undefined, "각주만으로는 구조 blocks 를 달지 않는다 (HWPX 와 같음)")
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("(주: 1) CFR 설명)"), md)
  })
})

describe("머리말·각주 표를 편 글의 이미지 — 추출 파일명으로 (HWPX 머리말 표 \"… / ![image](…)\" 대칭)", () => {
  it("본문 image 블록이 없는 그림은 스윕 파일명으로 sentinel 을 편다", () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const blocks: IRBlock[] = [{ type: "paragraph", text: "수능 모의고사 / ![image](hwp5bin:3)\n22-09 교육" }, { type: "paragraph", text: "본문" }]
    const images = extractHwp5Images([{ name: "BIN0003.png", content: png }], blocks, [], true)
    assert.equal(images.length, 1)
    assert.equal(blocks[0].text, `수능 모의고사 / ![image](${images[0].filename})\n22-09 교육`)
  })
})

describe("이미지 형식 판별 — 한컴 BinData WMF(배치 헤더 없음)·TIFF", () => {
  it("표준 WMF 헤더·TIFF 리틀/빅 엔디언", () => {
    assert.equal(detectImageMime(Buffer.from([0x01, 0x00, 0x09, 0x00, 0x00, 0x03])), "image/wmf")
    assert.equal(detectImageMime(Buffer.from([0x49, 0x49, 0x2a, 0x00])), "image/tiff")
    assert.equal(detectImageMime(Buffer.from([0x4d, 0x4d, 0x00, 0x2a])), "image/tiff")
    assert.equal(detectImageMime(Buffer.from([0x01, 0x00, 0x00, 0x00])), "image/emf")
  })
})
