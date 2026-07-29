/**
 * HWP5 v3.0 업그레이드 테스트 — 합성 레코드 버퍼 기반.
 *
 * 검증 항목: ctrl_id 바이트 순서 정규화, 각주/미주, 하이퍼링크 필드(FIELD_BEGIN/END),
 * 표 캡션/셀 구분, 중첩표 재귀, 이미지(BIN_DATA + PICTURE offset 71),
 * NUMBERING/BULLET 문단번호, 머리말/꼬리말, STYLE off-by-one, 자동번호.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseSection, createHwp5DocState } from "../src/hwp5/parser.js"
import {
  parseDocInfo, readRecords,
  TAG_PARA_HEADER, TAG_PARA_TEXT, TAG_CTRL_HEADER, TAG_LIST_HEADER, TAG_TABLE,
  TAG_SHAPE_COMPONENT, TAG_SHAPE_COMPONENT_PICTURE,
  TAG_BIN_DATA, TAG_NUMBERING, TAG_BULLET, TAG_DOC_PARA_SHAPE, TAG_DOC_STYLE,
  type HwpDocInfo,
} from "../src/hwp5/record.js"
import { NumberingState, formatNumber, expandNumberingFormat } from "../src/hwp5/numbering.js"
import { extractHwp5Images } from "../src/hwp5/images.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock, ParseWarning } from "../src/types.js"

// ─── 합성 레코드 빌더 ────────────────────────────────

/** 레코드 1개 직렬화: 4바이트 헤더(tagId 10bit | level 10bit | size 12bit) + data */
function rec(tagId: number, level: number, data: Buffer): Buffer {
  const header = Buffer.alloc(4)
  header.writeUInt32LE((tagId & 0x3ff) | ((level & 0x3ff) << 10) | (data.length << 20), 0)
  return Buffer.concat([header, data])
}

function utf16(s: string): Buffer {
  const buf = Buffer.alloc(s.length * 2)
  for (let i = 0; i < s.length; i++) buf.writeUInt16LE(s.charCodeAt(i), i * 2)
  return buf
}

/** PARA_HEADER 데이터 (12B) — paraShapeId @8 */
function paraHeaderData(paraShapeId = 0): Buffer {
  const buf = Buffer.alloc(12)
  buf.writeUInt16LE(paraShapeId, 8)
  return buf
}

/** 확장 컨트롤 문자 (16B): ch + ctrlId(on-disk 4B) + 8B + ch */
function extCtrlChar(ch: number, diskAscii: string): Buffer {
  const buf = Buffer.alloc(16)
  buf.writeUInt16LE(ch, 0)
  buf.write(diskAscii, 2, "ascii")
  buf.writeUInt16LE(ch, 14)
  return buf
}

/** 셀 LIST_HEADER 데이터 (34B): widthRef @6, colAddr @8, rowAddr @10, colSpan @12, rowSpan @14 */
function cellListHeaderData(col: number, row: number, colSpan = 1, rowSpan = 1, isHeader = false): Buffer {
  const buf = Buffer.alloc(34)
  buf.writeUInt16LE(1, 0) // paraCount
  if (isHeader) buf.writeUInt16LE(0x04, 6) // widthRef bit2 = 제목 셀
  buf.writeUInt16LE(col, 8)
  buf.writeUInt16LE(row, 10)
  buf.writeUInt16LE(colSpan, 12)
  buf.writeUInt16LE(rowSpan, 14)
  return buf
}

/** TABLE 레코드 데이터: attr(4) + rows(2) + cols(2) */
function tableRecData(rows: number, cols: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeUInt16LE(rows, 4)
  buf.writeUInt16LE(cols, 6)
  return buf
}

/** 빈 DocInfo 골격 */
function emptyDocInfo(): HwpDocInfo {
  return { charShapes: [], paraShapes: [], styles: [], binData: [], numberings: [], bullets: [] }
}

function parse(buffers: Buffer[], docInfo: HwpDocInfo | null = null, doc = createHwp5DocState()) {
  const warnings: ParseWarning[] = []
  const records = readRecords(Buffer.concat(buffers))
  const blocks = parseSection(records, docInfo, warnings, 1, doc)
  return { blocks, warnings, doc }
}

// ─── ctrl_id 정규화 + 각주/미주 ──────────────────────

describe("ctrl_id 바이트 순서 정규화", () => {
  it("각주 ctrl_id '  nf'(on-disk LE)를 인식해 footnoteText 연결", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("본문"), extCtrlChar(17, "  nf")])),
      rec(TAG_CTRL_HEADER, 1, Buffer.concat([Buffer.from("  nf", "ascii"), Buffer.alloc(12)])),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("각주 내용")),
    ])
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].footnoteText, "1) 각주 내용")
    // 본문 위치에 인라인 마커
    assert.equal(blocks[0].text, "본문1)")
  })

  it("미주 ctrl_id '  ne' 인식 + 미주 카운터는 각주와 독립", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("끝"), extCtrlChar(17, "  ne")])),
      rec(TAG_CTRL_HEADER, 1, Buffer.concat([Buffer.from("  ne", "ascii"), Buffer.alloc(12)])),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("미주 내용")),
    ])
    assert.equal(blocks[0].footnoteText, "1) 미주 내용")
  })

  it("비표준 BE 저장 ctrl_id('tbl ' ascii 그대로)도 스왑 정규화로 표 인식", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from("tbl ", "ascii")), // BE 순서 (비표준)
      rec(TAG_TABLE, 2, tableRecData(1, 1)),
      rec(TAG_LIST_HEADER, 2, cellListHeaderData(0, 0)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("셀")),
    ])
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1)
    assert.equal(tables[0].table!.cells[0][0].text, "셀")
  })
})

// ─── 하이퍼링크 필드 ─────────────────────────────────

describe("필드 구조 파싱 (FIELD_BEGIN/END + %hlk)", () => {
  /** %hlk CTRL_HEADER 데이터: ctrl_id + 속성(4) + 기타(1) + command_len(2) + command + id(4) */
  function hlkCtrlData(command: string): Buffer {
    const head = Buffer.alloc(7)
    head.writeUInt16LE(command.length, 5)
    return Buffer.concat([Buffer.from("klh%", "ascii"), head, utf16(command), Buffer.alloc(4)])
  }

  it("FIELD_BEGIN(0x03)/END(0x04) 스택 페어링으로 anchor 범위 복원 + URL 마크다운 링크", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([
        utf16("전 "),
        extCtrlChar(0x03, "klh%"),
        utf16("링크"),
        extCtrlChar(0x04, "klh%"),
        utf16(" 후"),
      ])),
      rec(TAG_CTRL_HEADER, 1, hlkCtrlData("https://example.com;1;0")),
    ])
    assert.equal(blocks[0].text, "전 [링크](https://example.com) 후")
  })

  it("mailto 링크도 추출 (기존 'http' 시그니처 스캔으로는 불가)", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([
        extCtrlChar(0x03, "klh%"),
        utf16("문의"),
        extCtrlChar(0x04, "klh%"),
      ])),
      rec(TAG_CTRL_HEADER, 1, hlkCtrlData("mailto:a@b.kr;1;0")),
    ])
    assert.equal(blocks[0].text, "[문의](mailto:a@b.kr)")
  })

  it("위험 스킴(javascript:)은 링크 미생성, anchor 텍스트는 보존", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([
        extCtrlChar(0x03, "klh%"),
        utf16("클릭"),
        extCtrlChar(0x04, "klh%"),
      ])),
      rec(TAG_CTRL_HEADER, 1, hlkCtrlData("javascript:alert(1);0")),
    ])
    assert.equal(blocks[0].text, "클릭")
  })
})

// ─── 표 캡션/셀 구분 + 중첩표 ────────────────────────

describe("표 캡션/셀 구분 (TABLE 전후 LIST_HEADER)", () => {
  it("TABLE 레코드 이전 LIST_HEADER는 캡션 → IRTable.caption, 그리드는 셀만으로 구성", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from(" lbt", "ascii")),
      // 캡션 리스트 (TABLE 이전)
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("표 1. 예산 현황")),
      // TABLE + 셀 2개
      rec(TAG_TABLE, 2, tableRecData(1, 2)),
      rec(TAG_LIST_HEADER, 2, cellListHeaderData(0, 0, 1, 1, true)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("항목")),
      rec(TAG_LIST_HEADER, 2, cellListHeaderData(1, 0)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("금액")),
    ])
    const table = blocks.find(b => b.type === "table")!.table!
    assert.equal(table.caption, "표 1. 예산 현황")
    assert.equal(table.rows, 1)
    assert.equal(table.cols, 2)
    assert.equal(table.cells[0][0].text, "항목")
    assert.equal(table.cells[0][0].isHeader, true) // widthRef bit2 = 제목 셀
    assert.equal(table.cells[0][1].text, "금액")
    assert.equal(table.cells[0][1].isHeader, undefined)
  })
})

describe("중첩표 level 기반 재귀", () => {
  it("셀 안의 표는 IRCell.blocks에 IRBlock(type:'table')로 보존, 마커 없음", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from(" lbt", "ascii")),
      rec(TAG_TABLE, 2, tableRecData(1, 1)),
      rec(TAG_LIST_HEADER, 2, cellListHeaderData(0, 0)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("바깥")),
      // 셀 문단의 자식 컨트롤로 중첩표
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 3, Buffer.from(" lbt", "ascii")),
      rec(TAG_TABLE, 4, tableRecData(1, 2)),
      rec(TAG_LIST_HEADER, 4, cellListHeaderData(0, 0)),
      rec(TAG_PARA_HEADER, 4, paraHeaderData()),
      rec(TAG_PARA_TEXT, 5, utf16("안1")),
      rec(TAG_LIST_HEADER, 4, cellListHeaderData(1, 0)),
      rec(TAG_PARA_HEADER, 4, paraHeaderData()),
      rec(TAG_PARA_TEXT, 5, utf16("안2")),
    ])
    const outer = blocks.find(b => b.type === "table")!.table!
    const cell = outer.cells[0][0]
    assert.equal(cell.text.includes("중첩 테이블"), false)
    assert.ok(cell.blocks, "셀에 blocks 보존")
    const nested = cell.blocks!.find(b => b.type === "table")
    assert.ok(nested?.table, "중첩표 IRBlock 존재")
    assert.equal(nested!.table!.cells[0][0].text, "안1")
    assert.equal(nested!.table!.cells[0][1].text, "안2")
    // HTML 렌더링에서 중첩 <table> 출력
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<table>"), "중첩표는 HTML 표로 렌더링")
    assert.ok(md.includes("안1") && md.includes("안2"))
  })
})

// ─── 이미지 ──────────────────────────────────────────

describe("이미지 추출 (BIN_DATA + SHAPE_COMPONENT_PICTURE)", () => {
  it("DocInfo BIN_DATA: embed → storageId(16진)/확장자, link → kind link", () => {
    const embed = Buffer.alloc(4 + 2 + 6)
    embed.writeUInt16LE(0x0001, 0) // attr: embedding
    embed.writeUInt16LE(0x000a, 2) // storageId 10 → "BIN000A"
    embed.writeUInt16LE(3, 4)
    embed.write("jpg", 6, "utf16le")
    const link = Buffer.alloc(2)
    link.writeUInt16LE(0x0000, 0) // attr: link

    const docInfo = parseDocInfo(readRecords(Buffer.concat([
      rec(TAG_BIN_DATA, 0, embed),
      rec(TAG_BIN_DATA, 0, link),
    ])))
    assert.equal(docInfo.binData.length, 2)
    assert.deepEqual(docInfo.binData[0], { kind: "embed", storageId: 10, extension: "jpg" })
    assert.equal(docInfo.binData[1].kind, "link")
  })

  it("PICTURE 고정 오프셋 71의 binDataId → BIN_DATA 매핑 → image 블록(storageId)", () => {
    const pic = Buffer.alloc(80)
    pic.writeUInt16LE(1, 71) // binDataId = 1 (1-based)
    const docInfo = emptyDocInfo()
    docInfo.binData = [{ kind: "embed", storageId: 10, extension: "jpg" }]

    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from(" osg", "ascii")),
      rec(TAG_SHAPE_COMPONENT, 2, Buffer.alloc(4)),
      rec(TAG_SHAPE_COMPONENT_PICTURE, 3, pic),
    ], docInfo)
    const img = blocks.find(b => b.type === "image")
    assert.ok(img, "이미지 블록 생성")
    assert.equal(img!.text, "10") // binDataId 1 → storageId 10 (스트림 BIN000A)
  })

  it("같은 BinData를 참조하는 다수 image 블록 — 1회만 추출·데이터 공유 (대량 참조 메모리 폭발 방지)", () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)])
    const fileIndex = [{ name: "Root Entry/BinData/BIN000A.jpg", content: jpeg }]
    const blocks: IRBlock[] = [1, 2, 3].map(() => ({ type: "image" as const, text: "10" }))
    const warnings: ParseWarning[] = []
    const images = extractHwp5Images(fileIndex, blocks, warnings)
    assert.equal(images.length, 1, "같은 BinData는 1건만 추출")
    for (const b of blocks) assert.equal(b.text, "image_001.jpg", "모든 블록이 같은 파일명 참조")
    assert.equal(blocks[0].imageData!.data, blocks[1].imageData!.data, "데이터 버퍼 공유 (복사 1벌)")
    assert.equal(images[0].data, blocks[2].imageData!.data)
    assert.equal(warnings.length, 0)
  })

  it("link 타입 binDataId는 SKIPPED_IMAGE 경고 + 블록 미생성", () => {
    const pic = Buffer.alloc(80)
    pic.writeUInt16LE(1, 71)
    const docInfo = emptyDocInfo()
    docInfo.binData = [{ kind: "link", storageId: 0, extension: "" }]
    const { blocks, warnings } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from(" osg", "ascii")),
      rec(TAG_SHAPE_COMPONENT, 2, Buffer.alloc(4)),
      rec(TAG_SHAPE_COMPONENT_PICTURE, 3, pic),
    ], docInfo)
    assert.equal(blocks.filter(b => b.type === "image").length, 0)
    assert.equal(warnings.some(w => w.code === "SKIPPED_IMAGE"), true)
  })

  it("글상자(SHAPE_COMPONENT 이후 LIST_HEADER) 텍스트 추출", () => {
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.from(" osg", "ascii")),
      rec(TAG_SHAPE_COMPONENT, 2, Buffer.alloc(4)),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("글상자 내용")),
    ])
    assert.ok(blocks.some(b => b.type === "paragraph" && b.text === "글상자 내용"))
  })
})

// ─── 문단번호/글머리표 ───────────────────────────────

describe("글머리표/문단번호 (NUMBERING/BULLET + headType)", () => {
  it("DocInfo NUMBERING/BULLET 레코드 파싱", () => {
    // NUMBERING: 7수준 × (머리정보 12B + 형식 문자열) + 시작번호
    const levels: Buffer[] = []
    for (let lv = 0; lv < 7; lv++) {
      const head = Buffer.alloc(12)
      head.writeUInt32LE(8 << 5, 0) // numberFormat 8 = 가나다
      const fmt = lv === 0 ? "^1." : `^${lv + 1})`
      const fmtBuf = Buffer.alloc(2 + fmt.length * 2)
      fmtBuf.writeUInt16LE(fmt.length, 0)
      fmtBuf.write(fmt, 2, "utf16le")
      levels.push(head, fmtBuf)
    }
    const start = Buffer.alloc(2)
    start.writeUInt16LE(1, 0)
    const bullet = Buffer.alloc(14)
    bullet.writeUInt16LE(0x25cf, 12) // ●

    const docInfo = parseDocInfo(readRecords(Buffer.concat([
      rec(TAG_NUMBERING, 0, Buffer.concat([...levels, start])),
      rec(TAG_BULLET, 0, bullet),
    ])))
    assert.equal(docInfo.numberings.length, 1)
    assert.equal(docInfo.numberings[0].levelFormats[0], "^1.")
    assert.equal(docInfo.numberings[0].numberFormats[0], 8)
    assert.equal(docInfo.bullets[0].char, "●")
  })

  it("번호 문단: 7수준 카운터 + ^N 치환으로 접두 재현 (1. → 2.)", () => {
    const docInfo = emptyDocInfo()
    docInfo.paraShapes = [{ headType: 2, paraLevel: 0, numberingId: 1 }]
    docInfo.numberings = [{
      levelFormats: ["^1.", "", "", "", "", "", ""],
      numberFormats: [0, 0, 0, 0, 0, 0, 0],
      startNumbers: [1, 1, 1, 1, 1, 1, 1],
    }]
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData(0)),
      rec(TAG_PARA_TEXT, 1, utf16("첫째 항목")),
      rec(TAG_PARA_HEADER, 0, paraHeaderData(0)),
      rec(TAG_PARA_TEXT, 1, utf16("둘째 항목")),
    ], docInfo)
    assert.equal(blocks[0].text, "1. 첫째 항목")
    assert.equal(blocks[1].text, "2. 둘째 항목")
  })

  it("글머리표 문단: BULLET 문자 접두", () => {
    const docInfo = emptyDocInfo()
    docInfo.paraShapes = [{ headType: 3, paraLevel: 0, numberingId: 1 }]
    docInfo.bullets = [{ char: "●" }]
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData(0)),
      rec(TAG_PARA_TEXT, 1, utf16("항목")),
    ], docInfo)
    assert.equal(blocks[0].text, "● 항목")
  })

  it("개요(headType=1) 문단은 heading + headType=0이면 paraLevel이 있어도 본문 유지", () => {
    const docInfo = emptyDocInfo()
    docInfo.paraShapes = [
      { headType: 1, paraLevel: 0, numberingId: 0 },
      { headType: 0, paraLevel: 3, numberingId: 0 },
    ]
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData(0)),
      rec(TAG_PARA_TEXT, 1, utf16("개요 제목")),
      rec(TAG_PARA_HEADER, 0, paraHeaderData(1)),
      rec(TAG_PARA_TEXT, 1, utf16("일반 본문")),
    ], docInfo)
    assert.equal(blocks[0].type, "heading")
    assert.equal(blocks[0].level, 1)
    assert.equal(blocks[1].type, "paragraph")
  })
})

describe("번호 포맷터 (rhwp format_number 포팅)", () => {
  it("원문자/로마자/가나다/ㄱㄴㄷ/일이삼/一二三", () => {
    assert.equal(formatNumber(3, "circled"), "③")
    assert.equal(formatNumber(4, "romanUpper"), "IV")
    assert.equal(formatNumber(4, "romanLower"), "iv")
    assert.equal(formatNumber(2, "latinUpper"), "B")
    assert.equal(formatNumber(3, "ganada"), "다")
    assert.equal(formatNumber(2, "jamo"), "ㄴ")
    assert.equal(formatNumber(12, "hangulNum"), "십이")
    assert.equal(formatNumber(3, "hanjaNum"), "三")
    assert.equal(formatNumber(21, "circled"), "㉑") // 정본(shared/numbering)은 ㊿(50)까지
    assert.equal(formatNumber(51, "circled"), "(51)") // 50 초과 → 괄호수 폴백 (gongmun 규칙)
    assert.equal(formatNumber(15, "ganada"), "거") // 14 초과 → 단모음 연속 (편람 규칙)
  })

  it("NumberingState: 하위 수준 리셋 + numberingId 히스토리 복원", () => {
    const st = new NumberingState()
    assert.deepEqual(st.advance(1, 0).slice(0, 2), [1, 0])
    assert.deepEqual(st.advance(1, 1).slice(0, 2), [1, 1])
    assert.deepEqual(st.advance(1, 1).slice(0, 2), [1, 2])
    assert.deepEqual(st.advance(1, 0).slice(0, 2), [2, 0]) // 상위 전진 → 하위 리셋
    st.advance(2, 0) // 다른 번호 목록
    assert.deepEqual(st.advance(1, 0).slice(0, 2), [3, 0]) // 히스토리 복원 (이전 번호 이어)
  })

  it("expandNumberingFormat: ^N 치환 + 시작번호 보정", () => {
    const numbering = {
      levelFormats: ["제^1장", "^1.^2", "", "", "", "", ""],
      numberFormats: [0, 0, 0, 0, 0, 0, 0],
      startNumbers: [5, 1, 1, 1, 1, 1, 1],
    }
    assert.equal(expandNumberingFormat("제^1장", [3, 0, 0, 0, 0, 0, 0], numbering), "제7장") // (5-1)+3
    assert.equal(expandNumberingFormat("^1.^2", [1, 2, 0, 0, 0, 0, 0], numbering), "5.2")
  })
})

// ─── 머리말/꼬리말 + 자동번호 ────────────────────────

describe("머리말/꼬리말", () => {
  it("'head' 컨트롤의 문단을 docState.headerBlocks에 1회 수집 (중복 제거)", () => {
    const doc = createHwp5DocState()
    const headerRecs = [
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("본문"), extCtrlChar(16, "daeh")])),
      rec(TAG_CTRL_HEADER, 1, Buffer.concat([Buffer.from("daeh", "ascii"), Buffer.alloc(4)])),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("문서번호 2026-1")),
    ]
    parse(headerRecs, null, doc)
    parse(headerRecs, null, doc) // 두 번째 섹션에 같은 머리말
    assert.equal(doc.headerBlocks.length, 1)
    assert.equal(doc.headerBlocks[0].text, "문서번호 2026-1")
  })

  it("'foot' 컨트롤은 footerBlocks로", () => {
    const doc = createHwp5DocState()
    parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_CTRL_HEADER, 1, Buffer.concat([Buffer.from("toof", "ascii"), Buffer.alloc(4)])),
      rec(TAG_LIST_HEADER, 2, Buffer.alloc(8)),
      rec(TAG_PARA_HEADER, 2, paraHeaderData()),
      rec(TAG_PARA_TEXT, 3, utf16("- 끝 -")),
    ], null, doc)
    assert.equal(doc.footerBlocks.length, 1)
    assert.equal(doc.footerBlocks[0].text, "- 끝 -")
  })
})

describe("자동번호 (atno/nwno)", () => {
  it("atno는 종류별 카운터로 번호 삽입, nwno는 카운터 재설정", () => {
    // atno: attr(u32: type=4 표) + number(u16) + 기호/장식 3 WCHAR
    const atnoData = (): Buffer => {
      const b = Buffer.alloc(16)
      b.write("onta", 0, "ascii")
      b.writeUInt32LE(4, 4) // type 4 = 표
      return b
    }
    const nwnoData = (num: number): Buffer => {
      const b = Buffer.alloc(10)
      b.write("onwn", 0, "ascii")
      b.writeUInt32LE(4, 4)
      b.writeUInt16LE(num, 8)
      return b
    }
    const doc = createHwp5DocState()
    const { blocks } = parse([
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([utf16("표 "), extCtrlChar(18, "onta")])),
      rec(TAG_CTRL_HEADER, 1, atnoData()),
      // 새 번호 10 지정 후 다음 atno는 10
      rec(TAG_PARA_HEADER, 0, paraHeaderData()),
      rec(TAG_PARA_TEXT, 1, Buffer.concat([extCtrlChar(21, "onwn"), utf16("표 "), extCtrlChar(18, "onta")])),
      rec(TAG_CTRL_HEADER, 1, nwnoData(10)),
      rec(TAG_CTRL_HEADER, 1, atnoData()),
    ], null, doc)
    assert.equal(blocks[0].text, "표 1")
    assert.equal(blocks[1].text, "표 10")
  })
})

// ─── STYLE off-by-one ────────────────────────────────

describe("STYLE 레코드 off-by-one 수정", () => {
  it("nextStyleId는 BYTE — paraShapeId=12/charShapeId=6 정확 추출 (실측 hex 재현)", () => {
    // 진단 실측: 바탕글 tail hex '00 00 12 04 0c00 0600'
    //   = type(0) + nextStyleId(0) + langId(0x0412=1042) + paraShapeId(12) + charShapeId(6)
    const name = "바탕글"
    const data = Buffer.concat([
      (() => { const b = Buffer.alloc(2); b.writeUInt16LE(0, 0); return b })(),       // name (영문) 없음
      (() => { const b = Buffer.alloc(2 + name.length * 2); b.writeUInt16LE(name.length, 0); b.write(name, 2, "utf16le"); return b })(),
      Buffer.from([0x00, 0x00, 0x12, 0x04, 0x0c, 0x00, 0x06, 0x00]),
    ])
    const docInfo = parseDocInfo(readRecords(rec(TAG_DOC_STYLE, 0, data)))
    assert.equal(docInfo.styles.length, 1)
    assert.equal(docInfo.styles[0].nameKo, "바탕글")
    assert.equal(docInfo.styles[0].paraShapeId, 12)
    assert.equal(docInfo.styles[0].charShapeId, 6)
  })

  it("PARA_SHAPE: headType(bits23-24)/paraLevel(bits25-27)/numberingId(@30) 추출", () => {
    const data = Buffer.alloc(34)
    data.writeUInt32LE((2 << 23) | (1 << 25), 0) // headType=2(번호), paraLevel=1
    data.writeUInt16LE(3, 30) // numberingId
    const docInfo = parseDocInfo(readRecords(rec(TAG_DOC_PARA_SHAPE, 0, data)))
    assert.deepEqual(docInfo.paraShapes[0], { headType: 2, paraLevel: 1, numberingId: 3 })
  })
})
