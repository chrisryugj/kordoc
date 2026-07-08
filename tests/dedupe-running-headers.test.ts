import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { dedupeRunningHeaders } from "../src/table/builder.js"
import { parseHwp5Document } from "../src/hwp5/parser.js"
import { TAG_PARA_HEADER, TAG_PARA_TEXT } from "../src/hwp5/record.js"
import type { IRBlock } from "../src/types.js"

// ─── 합성 HWP5(OLE2) 버퍼 빌더 — parseHwp5Document 옵션 게이팅 검증용 ───

interface CfbDoc { [key: string]: unknown }
const require = createRequire(import.meta.url)
const CFB: {
  utils: { cfb_new(): CfbDoc; cfb_add(cfb: CfbDoc, path: string, data: Buffer): void }
  write(cfb: CfbDoc, opts: { type: "buffer" }): Buffer
} = require("cfb")

/** 레코드 직렬화: 4바이트 헤더(tagId 10bit | level 10bit | size 12bit) + data */
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

/** 문단 1개 = PARA_HEADER(문단 헤더) + PARA_TEXT(본문) */
function paraRecords(text: string): Buffer {
  return Buffer.concat([rec(TAG_PARA_HEADER, 0, Buffer.alloc(12)), rec(TAG_PARA_TEXT, 1, utf16(text))])
}

/** 문단 텍스트 배열 → 비압축 HWP5 버퍼 (FileHeader + BodyText/Section0) */
function buildSyntheticHwp5(texts: string[]): Buffer {
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "utf8")
  fileHeader[35] = 5 // versionMajor
  fileHeader.writeUInt32LE(0, 36) // flags: 비압축·비암호화·비배포
  const section0 = Buffer.concat(texts.map(paraRecords))
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", section0)
  return Buffer.from(CFB.write(cfb, { type: "buffer" }))
}

/** "붙임/별지별 재번호" 시나리오 — 서로 다른 본문 사이 '1. 목적' 3회(freq 3) */
const BUNDLED_APPENDICES_TEXTS = [
  "1. 목적",
  "가. 첫째 붙임 본문",
  "1. 목적",
  "나. 둘째 붙임 본문",
  "1. 목적",
  "다. 셋째 붙임 본문",
]

describe("dedupeRunningHeaders", () => {
  it("4회 반복 러닝 헤더는 최초 1회만 남고 본문은 순서대로 모두 보존", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "2. 과제 구축 내용" },
      { type: "paragraph", text: "본문 문단 A" },
      { type: "paragraph", text: "2. 과제 구축 내용" },
      { type: "paragraph", text: "본문 문단 B" },
      { type: "paragraph", text: "2. 과제 구축 내용" },
      { type: "paragraph", text: "본문 문단 C" },
      { type: "paragraph", text: "2. 과제 구축 내용" },
      { type: "paragraph", text: "본문 문단 D" },
    ]

    const result = dedupeRunningHeaders(blocks)
    const texts = result.map(b => b.text)

    // 러닝 헤더는 정확히 1회
    assert.equal(texts.filter(t => t === "2. 과제 구축 내용").length, 1)
    // 본문 문단은 개수·순서 그대로 보존
    assert.deepEqual(
      texts.filter(t => t?.startsWith("본문")),
      ["본문 문단 A", "본문 문단 B", "본문 문단 C", "본문 문단 D"]
    )
    // 전체 결과 순서: 최초 헤더 → 본문 A~D
    assert.deepEqual(texts, [
      "2. 과제 구축 내용",
      "본문 문단 A",
      "본문 문단 B",
      "본문 문단 C",
      "본문 문단 D",
    ])
  })

  it("2회만 반복되는 헤더는 임계값 미만이라 제거하지 않음", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "1. 과제 개요" },
      { type: "paragraph", text: "본문" },
      { type: "paragraph", text: "1. 과제 개요" },
    ]

    const result = dedupeRunningHeaders(blocks)
    assert.equal(result.length, 3)
    assert.equal(result.filter(b => b.text === "1. 과제 개요").length, 2)
  })

  it("번호매김이 아닌 짧은 반복 문단은 후보가 아니므로 보존 (보수적 판정)", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "개요" },
      { type: "paragraph", text: "본문 1" },
      { type: "paragraph", text: "개요" },
      { type: "paragraph", text: "본문 2" },
      { type: "paragraph", text: "개요" },
    ]

    const result = dedupeRunningHeaders(blocks)
    // "개요"는 번호매김 시그니처가 없어 후보가 아님 → 3회 모두 유지
    assert.equal(result.filter(b => b.text === "개요").length, 3)
    assert.equal(result.length, 5)
  })

  it("입력 배열과 블록을 변형하지 않고 새 배열을 반환", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "3. 과제 추진전략" },
      { type: "paragraph", text: "본문" },
      { type: "paragraph", text: "3. 과제 추진전략" },
      { type: "paragraph", text: "3. 과제 추진전략" },
    ]
    const before = JSON.stringify(blocks)

    const result = dedupeRunningHeaders(blocks)

    // 새 배열 (참조 다름)
    assert.notEqual(result, blocks)
    // 입력 배열 원형 유지 (길이·내용 불변)
    assert.equal(blocks.length, 4)
    assert.equal(JSON.stringify(blocks), before)
    // 결과는 헤더 1회 + 본문 = 2개
    assert.equal(result.length, 2)
  })

  it("번들 붙임(붙임별 재번호) — raw 함수는 2·3번째 '1. 목적'을 오삭제 (알려진 휴리스틱 한계)", () => {
    // 세 붙임이 각각 독립적으로 '1. 목적'으로 시작(freq 3)하지만, raw 함수는
    // 페이지 위치 정보가 없어 이를 러닝 헤더와 구분하지 못하고 2·3번째를 삭제한다.
    // 이 실제 콘텐츠 오삭제가 파이프라인 기본값이 아닌 opt-in으로 게이팅하는 근거다.
    const blocks: IRBlock[] = BUNDLED_APPENDICES_TEXTS.map(text => ({ type: "paragraph", text }))
    const result = dedupeRunningHeaders(blocks)
    const texts = result.map(b => b.text)

    // '1. 목적'은 최초 1회만 남음 — 2·3번째 붙임 헤더 소실 (정당한 콘텐츠 삭제)
    assert.equal(texts.filter(t => t === "1. 목적").length, 1)
    // 본문 3개는 순서대로 보존 — 동작이 결정론적·예측가능함을 고정
    assert.deepEqual(
      texts.filter(t => t !== "1. 목적"),
      ["가. 첫째 붙임 본문", "나. 둘째 붙임 본문", "다. 셋째 붙임 본문"]
    )
    // 전체 결과: 최초 '1. 목적' + 본문 3개 = 4블록
    assert.deepEqual(texts, ["1. 목적", "가. 첫째 붙임 본문", "나. 둘째 붙임 본문", "다. 셋째 붙임 본문"])
  })
})

describe("parseHwp5Document — dedupeRunningHeaders 옵션 게이팅", () => {
  it("기본값(옵션 없음) — 아무것도 제거하지 않음: 반복 '1. 목적' 3회 모두 보존, 경고 없음", () => {
    const buffer = buildSyntheticHwp5(BUNDLED_APPENDICES_TEXTS)
    const result = parseHwp5Document(buffer)

    // 기본 파이프라인은 flattenLayoutTables만 적용 — dedupe 미수행
    assert.equal(result.blocks.filter(b => b.text === "1. 목적").length, 3)
    const filtered = (result.warnings ?? []).filter(w => w.code === "HIDDEN_TEXT_FILTERED")
    assert.equal(filtered.length, 0)
  })

  it("dedupeRunningHeaders:true — 최초 1회만 남기고 제거 + HIDDEN_TEXT_FILTERED 경고", () => {
    const buffer = buildSyntheticHwp5(BUNDLED_APPENDICES_TEXTS)
    const result = parseHwp5Document(buffer, { dedupeRunningHeaders: true })

    assert.equal(result.blocks.filter(b => b.text === "1. 목적").length, 1)
    const filtered = (result.warnings ?? []).filter(w => w.code === "HIDDEN_TEXT_FILTERED")
    assert.equal(filtered.length, 1)
    assert.match(filtered[0].message, /반복 러닝 헤더 2개 제거/)
  })
})
