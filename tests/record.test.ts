import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { deflateSync, deflateRawSync } from "zlib"
import { extractText, extractTextWithControls, extractEquationText, readRecords, decompressStream, parseFileHeader } from "../src/hwp5/record.js"

describe("extractText", () => {
  function toUtf16Buffer(text: string): Buffer {
    const buf = Buffer.alloc(text.length * 2)
    for (let i = 0; i < text.length; i++) {
      buf.writeUInt16LE(text.charCodeAt(i), i * 2)
    }
    return buf
  }

  it("기본 한글 텍스트 추출", () => {
    const result = extractText(toUtf16Buffer("안녕하세요"))
    assert.equal(result, "안녕하세요")
  })

  it("탭 문자(0x0009) 처리", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf.writeUInt16LE(0x0009, 2) // tab
    buf.writeUInt16LE("B".charCodeAt(0), 4)
    assert.equal(extractText(buf), "A\tB")
  })

  it("줄바꿈(0x0000) 처리", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf.writeUInt16LE(0x0000, 2) // line break
    buf.writeUInt16LE("B".charCodeAt(0), 4)
    assert.equal(extractText(buf), "A\nB")
  })

  it("하이픈(0x001E)과 NBSP(0x001F) 처리", () => {
    const buf = Buffer.alloc(6)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf.writeUInt16LE(0x001e, 2) // hyphen
    buf.writeUInt16LE(0x001f, 4) // nbsp
    assert.equal(extractText(buf), "A- ")
  })

  it("확장 제어문자(14바이트 페이로드) 스킵", () => {
    // 제어문자 0x0002 (ext) + 14바이트 payload + 'A'
    const buf = Buffer.alloc(2 + 14 + 2)
    buf.writeUInt16LE(0x0002, 0)
    // 14 bytes payload (zeros)
    buf.writeUInt16LE("A".charCodeAt(0), 16)
    assert.equal(extractText(buf), "A")
  })

  it("인라인 제어문자(14바이트 페이로드) 스킵", () => {
    const buf = Buffer.alloc(2 + 14 + 2)
    buf.writeUInt16LE(0x0004, 0) // inline control
    buf.writeUInt16LE("X".charCodeAt(0), 16)
    assert.equal(extractText(buf), "X")
  })

  it("인라인 수식 컨트롤을 콜백 결과로 치환", () => {
    const buf = Buffer.alloc(2 + 2 + 14 + 2)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf.writeUInt16LE(0x000b, 2)
    buf.write("deqe", 4, "ascii")
    buf.writeUInt16LE(0x000b, 16)
    buf.writeUInt16LE("B".charCodeAt(0), 18)

    const result = extractTextWithControls(buf, ctrlId => ctrlId === "deqe" ? "$x+1$" : null)
    assert.equal(result, "A$x+1$B")
  })

  it("0x000a 래퍼가 붙은 인라인 수식 컨트롤을 치환", () => {
    const buf = Buffer.alloc(2 + 2 + 16 + 2)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf.writeUInt16LE(0x000a, 2)
    buf.writeUInt16LE(0x000b, 4)
    buf.write("deqe", 6, "ascii")
    buf.writeUInt16LE(0x000b, 18)
    buf.writeUInt16LE("B".charCodeAt(0), 20)

    const result = extractTextWithControls(buf, ctrlId => ctrlId === "deqe" ? "$x^2$" : null)
    assert.equal(result, "A$x^2$B")
  })

  it("빈 버퍼는 빈 문자열 반환", () => {
    assert.equal(extractText(Buffer.alloc(0)), "")
  })

  it("홀수 바이트는 마지막 바이트 무시", () => {
    const buf = Buffer.alloc(3)
    buf.writeUInt16LE("A".charCodeAt(0), 0)
    buf[2] = 0xff
    assert.equal(extractText(buf), "A")
  })
})

describe("extractEquationText", () => {
  it("EQEDIT 레코드에서 수식 스크립트 추출", () => {
    const equation = "m(a+b)`=`ma+mb"
    const buf = Buffer.alloc(6 + equation.length * 2 + 16)
    buf.writeUInt16LE(equation.length, 4)
    buf.write(equation, 6, "utf16le")

    assert.equal(extractEquationText(buf), equation)
  })

  it("잘린 EQEDIT 레코드는 null 반환", () => {
    const buf = Buffer.alloc(8)
    buf.writeUInt16LE(10, 4)

    assert.equal(extractEquationText(buf), null)
  })
})

describe("readRecords", () => {
  it("단일 레코드 파싱", () => {
    // tagId=0x42, level=0, size=4 → header = 0x42 | (0 << 10) | (4 << 20)
    const header = 0x42 | (0 << 10) | (4 << 20)
    const buf = Buffer.alloc(8)
    buf.writeUInt32LE(header, 0)
    buf.writeUInt32LE(0xdeadbeef, 4)

    const records = readRecords(buf)
    assert.equal(records.length, 1)
    assert.equal(records[0].tagId, 0x42)
    assert.equal(records[0].level, 0)
    assert.equal(records[0].size, 4)
  })

  it("확장 크기(0xFFF) 레코드 파싱", () => {
    // size=0xFFF 이면 다음 4바이트에 실제 크기
    // unsigned 32-bit: (0xfff << 20) | 0x42 = 0xFFF00042
    const realSize = 8
    const buf = Buffer.alloc(4 + 4 + realSize)
    buf.writeUInt32LE(0xfff00042, 0) // tagId=0x42, level=0, size=0xFFF
    buf.writeUInt32LE(realSize, 4)
    buf.fill(0xab, 8, 8 + realSize)

    const records = readRecords(buf)
    assert.equal(records.length, 1)
    assert.equal(records[0].size, 8)
  })

  it("빈 버퍼는 빈 배열 반환", () => {
    assert.deepEqual(readRecords(Buffer.alloc(0)), [])
  })

  it("잘린 데이터는 안전하게 중단", () => {
    const header = 0x42 | (0 << 10) | (100 << 20) // size=100인데 데이터 부족
    const buf = Buffer.alloc(8) // 4 header + 4 data only
    buf.writeUInt32LE(header, 0)

    const records = readRecords(buf)
    assert.equal(records.length, 0) // 데이터 부족으로 스킵
  })
})

describe("decompressStream", () => {
  it("zlib 헤더(0x78)가 있으면 inflate 시도", () => {
    const original = Buffer.from("Hello HWP5 world!")
    const compressed = deflateSync(original)

    const result = decompressStream(compressed)
    assert.equal(result.toString(), "Hello HWP5 world!")
  })

  it("raw deflate 데이터 처리", () => {
    const original = Buffer.from("Raw deflate test")
    const compressed = deflateRawSync(original)

    const result = decompressStream(compressed)
    assert.equal(result.toString(), "Raw deflate test")
  })
})

describe("parseFileHeader", () => {
  it("시그니처, 버전, 플래그 파싱", () => {
    const buf = Buffer.alloc(40)
    const sig = "HWP Document File"
    buf.write(sig, 0, "utf8")
    buf[35] = 5 // version major
    buf.writeUInt32LE(0x01, 36) // compressed flag

    const header = parseFileHeader(buf)
    assert.equal(header.signature, "HWP Document File")
    assert.equal(header.versionMajor, 5)
    assert.equal(header.flags, 1)
  })
})
