/**
 * HWP3 rhwp 업스트림 정합 회귀 테스트 (2026-07-17 반영분).
 *
 * 잠근 결함 (rhwp 커밋 → kordoc 반영):
 *  1. d89b689 (#929): 탭(ch=9)은 8 byte 구조 — 2 byte만 소비하면 탭마다 6 byte desync로
 *     이후 텍스트 오염 (업스트림 실측: sample19 파싱 실패 원인)
 *  2. dcf64b4 (#877): ch=5(필드코드)는 헤더 뒤 header_val1 byte, ch=6(책갈피)은 34 byte
 *     추가 소비 — 미소비 시 stream desync (업스트림 실측: sample16 77→1058 문단 복구)
 *  3. e184718~aa8b47c: 사적 graphic char 영역(0x0080~0x7FFF) 매핑 — 로마숫자·원문자·
 *     따옴표·글머리 등이 통째로 증발하던 것 (kordoc은 한컴 표시값 직행 방출)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseHwp3Document } from "../src/hwp3/parser.js"
import { decodeJohab, JOHAB_UNMAPPED } from "../src/hwp3/johab.js"

/** 합성 HWP3 파일: 30B 시그니처 + 128B DocInfo + 1008B DocSummary + body (비압축) */
function buildHwp3(body: Buffer): ArrayBuffer {
  const sig = Buffer.alloc(30)
  Buffer.from("HWP Document File V3.00", "ascii").copy(sig)
  const docInfo = Buffer.alloc(128) // encrypted=0, compressed=0, infoBlockLength=0
  const docSummary = Buffer.alloc(1008)
  const file = Buffer.concat([sig, docInfo, docSummary, body])
  return new Uint8Array(file).buffer
}

/** body 선두의 font face(언어 7종 × u16 count=0) + style(u16 count=0) 프리앰블 */
const PREAMBLE = Buffer.alloc(16)

/** 단일 paragraph + 종료 sentinel 로 이루어진 body 구성.
 *  charCount 는 hchar 단위 — 호출자가 스트림 구조에 맞게 계산해서 넘긴다. */
function buildBody(charStream: Buffer, charCount: number): Buffer {
  const header = Buffer.alloc(43)
  header[0] = 1 // followPrev=1 → ParaShape 없음
  header.writeUInt16LE(charCount, 1)
  header.writeUInt16LE(0, 3) // lineCount=0
  header[5] = 0 // includeCharShape=0
  const terminator = Buffer.alloc(43) // followPrev+charCount(0)+잔여 40
  return Buffer.concat([PREAMBLE, header, charStream, terminator])
}

function u16seq(codes: number[]): Buffer {
  const buf = Buffer.alloc(codes.length * 2)
  codes.forEach((c, i) => buf.writeUInt16LE(c, i * 2))
  return buf
}

const A = "A".charCodeAt(0)
const B = "B".charCodeAt(0)

describe("회귀 rhwp-1: 탭(ch=9) 8 byte 구조 정합 (d89b689 #929)", () => {
  it("hchar 9 + 탭폭 + 점끌기 + hchar 9 닫기 소비 후 뒤 텍스트 보존", () => {
    // A, [9, hunit(600), word(0), 9], B — 탭은 4 hchar
    const stream = u16seq([A, 9, 600, 0, 9, B])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "A\tB")
    assert.ok(!r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "desync 없이 파싱돼야 함")
  })

  it("탭 2개 연속에도 desync 없음 (구현 전: 탭마다 6 byte 어긋남)", () => {
    const stream = u16seq([A, 9, 600, 0, 9, 9, 600, 0, 9, B])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 10)))
    assert.equal(r.markdown, "A\t\tB")
  })
})

describe("회귀 rhwp-2: ch=5 필드코드 / ch=6 책갈피 스트림 소비 (dcf64b4 #877)", () => {
  it("ch=5: 8 byte 헤더 + header_val1 byte 세부정보 소비", () => {
    // A, [5, len(u32)=10, ch2=5, 세부 10 byte], B — 헤더는 4 hchar
    const head = u16seq([A, 5])
    const lenAndClose = Buffer.alloc(6)
    lenAndClose.writeUInt32LE(10, 0)
    lenAndClose.writeUInt16LE(5, 4)
    const fieldData = Buffer.alloc(10, 0xee) // 소비 안 되면 hchar 로 오독됨
    const tail = u16seq([B])
    const stream = Buffer.concat([head, lenAndClose, fieldData, tail])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
  })

  it("ch=6: 8 byte 헤더 + 이름 32 + 종류 2 = 34 byte 추가 소비", () => {
    const head = u16seq([A, 6])
    const lenAndClose = Buffer.alloc(6)
    lenAndClose.writeUInt32LE(34, 0)
    lenAndClose.writeUInt16LE(6, 4)
    const bookmarkExtra = Buffer.alloc(34, 0xee)
    const tail = u16seq([B])
    const stream = Buffer.concat([head, lenAndClose, bookmarkExtra, tail])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
  })
})

describe("회귀 rhwp-3: 사적 graphic char 매핑 (e184718~aa8b47c)", () => {
  it("로마숫자 장 제목이 증발하지 않는다 (Ⅰ~Ⅹ)", () => {
    // "Ⅰ. 사업개요"의 로마숫자 부분 — 0x3590~0x3599
    const stream = u16seq([0x3590, ".".charCodeAt(0), " ".charCodeAt(0), 0x3593])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 4)))
    assert.equal(r.markdown, "Ⅰ. Ⅳ")
  })

  it("원문자·따옴표·화살표·글머리 매핑", () => {
    const stream = u16seq([0x36e7, 0x0081, A, 0x0082, 0x3446, 0x3366, 0x3441])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 7)))
    assert.equal(r.markdown, "①“A”→□■")
  })

  it("미매핑 사적영역은 종전대로 조용히 skip (? 노이즈 금지)", () => {
    const stream = u16seq([A, 0x0100, B]) // 0x0100: 매핑 없는 사적영역
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 3)))
    assert.equal(r.markdown, "AB")
  })
})

/** 8 byte 헤더(u32 header_val1 + u16 ch2) — default 분기가 소비하는 부분. */
function objHeader(ch: number, headerVal1: number): Buffer {
  const buf = Buffer.alloc(6)
  buf.writeUInt32LE(headerVal1, 0)
  buf.writeUInt16LE(ch, 4)
  return buf
}

describe("회귀 rhwp-4: 날짜 형식(ch=7)·날짜 코드(ch=8) 가변폭 구조 (#2844)", () => {
  it("ch=7: 84 byte total — 8 byte 헤더 + 76 byte 소비 후 뒤 텍스트 보존", () => {
    // 종전엔 simple 6 byte 로 처리해 76 byte 가 hchar 로 오독 → 문단 전체 오염.
    const stream = Buffer.concat([
      u16seq([A, 7]),
      objHeader(7, 0),
      Buffer.alloc(76, 0xee), // 소비 안 되면 조합형 hchar 로 오독됨
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
    assert.ok(!r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "desync 없이 파싱돼야 함")
  })

  it("ch=8: 96 byte total — 8 byte 헤더 + 88 byte 소비 후 뒤 텍스트 보존", () => {
    const stream = Buffer.concat([
      u16seq([A, 8]),
      objHeader(8, 0),
      Buffer.alloc(88, 0xee),
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
    assert.ok(!r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "desync 없이 파싱돼야 함")
  })

  it("날짜 2개 연속에도 desync 없음", () => {
    const date = (ch: number, extra: number) =>
      Buffer.concat([u16seq([ch]), objHeader(ch, 0), Buffer.alloc(extra, 0xee)])
    const stream = Buffer.concat([u16seq([A]), date(7, 76), date(8, 88), u16seq([B])])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 10)))
    assert.equal(r.markdown, "AB")
  })
})

describe("회귀 rhwp-5: 차례 표시(ch=25)는 비가시 표식 (#2765)", () => {
  it("ch=25 는 하이픈을 방출하지 않는다", () => {
    // [25, hunit(0=제목차례), 25] — 6 byte = 3 hchar
    const stream = u16seq([A, 25, 0, 25, B])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 5)))
    assert.equal(r.markdown, "AB")
  })

  it("하이픈(ch=24)은 종전대로 '-' 를 방출한다 (대조군)", () => {
    const stream = u16seq([A, 24, 0, 24, B])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 5)))
    assert.equal(r.markdown, "A-B")
  })

  it("차례 표식이 붙은 제목에 잉여 '-' 가 섞이지 않는다", () => {
    // 차례 표식 + "AB" — 종전엔 "-AB"
    const stream = u16seq([25, 0, 25, A, B])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 5)))
    assert.equal(r.markdown, "AB")
  })
})

describe("회귀 rhwp-7: ch=12 는 '선' 이 아니라 예약 코드 (spec 표 31)", () => {
  it("ch=12 는 8 byte 헤더만 소비한다 — 84 byte 추가 소비 금지", () => {
    // 종전엔 선(14)의 info 84 byte 를 12 에도 적용해 84 byte 를 과소비했다.
    const stream = Buffer.concat([u16seq([A, 12]), objHeader(12, 0), u16seq([B])])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
  })

  it("선(ch=14)은 종전대로 84 byte info 를 소비한다 (대조군)", () => {
    const stream = Buffer.concat([
      u16seq([A, 14]),
      objHeader(14, 0),
      Buffer.alloc(84, 0xee),
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
  })
})

describe("회귀 rhwp-6: 조합형 무효 종성 인덱스 (#2924)", () => {
  // ch = 0x8000 | cho<<10 | jung<<5 | jong. cho=2('ㄱ'), jung=3('ㅏ').
  const johab = (cho: number, jung: number, jong: number) =>
    0x8000 | (cho << 10) | (jung << 5) | jong

  it("예약/무효 종성(인덱스 0·18·30·31)으로 완성형 음절을 합성하지 않는다", () => {
    for (const jongIdx of [0, 18, 30, 31]) {
      const cp = decodeJohab(johab(2, 3, jongIdx))
      assert.notEqual(cp, 0xac00, `jongIdx=${jongIdx} 가 '가'로 합성되면 안 됨`)
      // 심볼 테이블에 없으면 unmapped — 어느 쪽이든 한글 음절 영역은 아니어야 한다.
      assert.ok(
        cp === JOHAB_UNMAPPED || cp < 0xac00 || cp > 0xd7a3,
        `jongIdx=${jongIdx} 결과가 한글 음절 영역(U+AC00~U+D7A3)이면 안 됨: ${cp}`,
      )
    }
  })

  it("받침 없음(인덱스 1)·정상 받침(인덱스 2)은 종전대로 합성된다", () => {
    assert.equal(decodeJohab(johab(2, 3, 1)), 0xac00) // '가'
    assert.equal(decodeJohab(johab(2, 3, 2)), 0xac01) // '각'
  })
})

describe("회귀 rhwp-8: 그림(ch=11) 뒤 캡션 문단 리스트 소비 (spec §10.7)", () => {
  // 스펙 §10.7 그림 구조 = 식별정보(8) → 그림정보(348+n) → **캡션 문단 리스트**.
  // 캡션이 없어도 빈 문단 sentinel(43 byte)이 항상 뒤따른다. 이걸 안 읽으면 그림
  // 하나당 최소 43 byte 가 어긋나고, 어긋난 자리가 char_count=0 으로 읽히면
  // 리스트가 "정상 종료"로 판정돼 **경고 없이** 본문 나머지를 통째로 버린다.
  // (실측: rhwp samples/hwp3-sample10 본문 4MB 중 99.7% 무증상 유실)
  it("캡션 없는 그림 뒤 텍스트가 보존된다", () => {
    const stream = Buffer.concat([
      u16seq([A, 11]),
      objHeader(11, 0),
      Buffer.alloc(348), // 그림 정보 — 선두 u32 = nExt = 0
      Buffer.alloc(43), // 캡션 리스트: 빈 문단 sentinel
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
    assert.ok(!r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "desync 없이 파싱돼야 함")
  })

  it("캡션 텍스트도 결과에 수집된다", () => {
    const caption = Buffer.concat([
      (() => {
        const h = Buffer.alloc(43)
        h[0] = 1 // followPrev=1
        h.writeUInt16LE(1, 1) // charCount=1
        return h
      })(),
      u16seq(["C".charCodeAt(0)]),
      Buffer.alloc(43), // 캡션 리스트 종료 sentinel
    ])
    const stream = Buffer.concat([
      u16seq([A, 11]),
      objHeader(11, 0),
      Buffer.alloc(348),
      caption,
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.match(r.markdown, /C/)
    assert.match(r.markdown, /AB/)
  })
})

describe("회귀 rhwp-9: 표 cell_count 고정 상한(256) 제거", () => {
  // 종전 `cellCount > 256` 가드는 실존 문서를 죽였다 — rhwp samples/hwp3-sample16 에
  // 367 셀 표가 실재한다. rhwp 는 개수 상한 없이 버퍼 크기 캡만 둔다.
  it("300 셀 표 뒤 텍스트가 보존된다", () => {
    const cells = 300
    const info = Buffer.alloc(84)
    info.writeUInt16LE(cells, 80)
    const stream = Buffer.concat([
      u16seq([A, 10]),
      objHeader(10, 0),
      info,
      Buffer.alloc(27 * cells), // 셀 정보
      Buffer.concat(Array.from({ length: cells + 1 }, () => Buffer.alloc(43))), // 셀 리스트 n개 + 캡션
      u16seq([B]),
    ])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.equal(r.markdown, "AB")
    assert.ok(!r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "정상 표를 죽이면 안 됨")
  })

  it("잔여 스트림을 넘는 cell_count 는 여전히 거부한다", () => {
    const info = Buffer.alloc(84)
    info.writeUInt16LE(60000, 80) // 27 × 60000 = 1.6MB ≫ 잔여
    const stream = Buffer.concat([u16seq([A, 10]), objHeader(10, 0), info, u16seq([B])])
    const r = parseHwp3Document(buildHwp3(buildBody(stream, 6)))
    assert.ok(r.warnings?.some(w => w.code === "PARTIAL_PARSE"), "손상 헤더는 걸러야 함")
  })
})
