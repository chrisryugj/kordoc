/**
 * 바이너리 경로 결함 회귀 테스트 (담당 C).
 *
 * 잠근 결함:
 *  1. hwp3/parser.ts inflateRawSync decompression bomb 무가드 (100MB 캡)
 *  2. hwp5/record.ts 제어문자 스왑 — 스펙 코드 24(0x18)=하이픈, 30(0x1e)=묶음빈칸, 31(0x1f)=고정폭빈칸
 *  3. roundtrip/ole-surgeon.ts replace() 후 해제 섹터에 삭제 전 데이터 잔존(remanence)
 *  4. hwp5/cfb-lenient.ts 헤더 fatSectorCount 뻥튀기로 fatTable 할당 증폭 (~130KB 파일 → 655MB)
 *  5. hwp5/cfb-lenient.ts 파일 범위 밖 DIFAT 섹터(빈 버퍼) readUInt32LE RangeError
 *  6. roundtrip/zip-patch.ts method 0/8 외 압축 방식 엔트리 교체 시 무검증 (깨진 출력 생성)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "module"
import { deflateRawSync } from "zlib"
import JSZip from "jszip"
import { parseHwp3Document } from "../src/hwp3/parser.js"
import { extractText } from "../src/hwp5/record.js"
import { parseLenientCfb } from "../src/hwp5/cfb-lenient.js"
import { replaceOleStream } from "../src/roundtrip/ole-surgeon.js"
import { patchZipEntries, readZipEntries } from "../src/roundtrip/zip-patch.js"

const require = createRequire(import.meta.url)
const CFB = require("cfb")

const NBSP = String.fromCharCode(0x00a0)

// ─── 헬퍼 ────────────────────────────────────────────

/** 합성 HWP3 파일: 30B 시그니처 + 128B DocInfo + 1008B DocSummary + body */
function buildHwp3(body: Buffer, compressed: boolean): ArrayBuffer {
  const sig = Buffer.alloc(30)
  Buffer.from("HWP Document File V3.00", "ascii").copy(sig)
  const docInfo = Buffer.alloc(128) // encrypted=0 @96, infoBlockLength=0 @126
  docInfo[124] = compressed ? 1 : 0
  const docSummary = Buffer.alloc(1008)
  const file = Buffer.concat([sig, docInfo, docSummary, body])
  return new Uint8Array(file).buffer
}

/** 합성 CFB 헤더(512B) — 필드만 지정, 나머지 기본값 */
function cfbHeader(opts: {
  sectorShift: number
  fatSectorCount: number
  firstDifatSector: number
  difatSectorCount: number
}): Buffer {
  const h = Buffer.alloc(512)
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(h, 0)
  h.writeUInt16LE(3, 26) // major version
  h.writeUInt16LE(0xfffe, 28) // byte order
  h.writeUInt16LE(opts.sectorShift, 30)
  h.writeUInt16LE(6, 32) // mini sector shift
  h.writeUInt32LE(opts.fatSectorCount, 44)
  h.writeUInt32LE(0xfffffffe, 48) // first dir sector = END (디렉토리 없음)
  h.writeUInt32LE(4096, 56) // mini stream cutoff
  h.writeUInt32LE(0xfffffffe, 60) // first mini-FAT
  h.writeUInt32LE(0, 64) // mini-FAT count
  h.writeUInt32LE(opts.firstDifatSector, 68)
  h.writeUInt32LE(opts.difatSectorCount, 72)
  for (let i = 0; i < 109; i++) h.writeUInt32LE(0xffffffff, 76 + i * 4) // 헤더 DIFAT 전부 FREE
  return h
}

// ─── 1. HWP3 decompression bomb ──────────────────────

describe("회귀 C-1: HWP3 압축 해제 100MB 캡", () => {
  it("100MB 초과 bomb은 명확한 에러로 거부", () => {
    // 120MB 제로를 raw deflate — 압축본은 ~120KB지만 해제 시 100MB 캡 초과
    const bomb = deflateRawSync(Buffer.alloc(120 * 1024 * 1024))
    assert.throws(
      () => parseHwp3Document(buildHwp3(bomb, true)),
      /최대 허용 크기.*초과/,
    )
  })

  it("캡 이하 압축 본문은 기존대로 처리 (throw 없음)", () => {
    const small = deflateRawSync(Buffer.alloc(1024))
    const result = parseHwp3Document(buildHwp3(small, true))
    assert.ok(result.metadata)
  })
})

// ─── 2. HWP5 제어문자 재매핑 ─────────────────────────

describe("회귀 C-2: HWP5 제어문자 스펙 매핑 (24=하이픈, 30=묶음빈칸, 31=고정폭빈칸)", () => {
  function u16buf(codes: number[]): Buffer {
    const buf = Buffer.alloc(codes.length * 2)
    codes.forEach((c, i) => buf.writeUInt16LE(c, i * 2))
    return buf
  }

  it("0x18(24)=하이픈, 0x1e(30)=NBSP, 0x1f(31)=공백", () => {
    const buf = u16buf(["A".charCodeAt(0), 0x0018, 0x001e, 0x001f, "B".charCodeAt(0)])
    assert.equal(extractText(buf), "A-" + NBSP + " B")
  })

  it("예약 코드 0x19(25)는 출력 없이 2바이트만 소비 — 뒤 텍스트 보존", () => {
    const buf = u16buf(["A".charCodeAt(0), 0x0019, "B".charCodeAt(0)])
    assert.equal(extractText(buf), "AB")
  })
})

// ─── 3. OLE surgeon 데이터 remanence ─────────────────

describe("회귀 C-3: ole-surgeon replace() 후 삭제 전 데이터 잔존 제거", () => {
  const MARKER = "REMANENCE-SECRET-"

  function buildOle(streamData: Buffer): Buffer {
    const cfb = CFB.utils.cfb_new()
    CFB.utils.cfb_add(cfb, "/FileHeader", Buffer.alloc(256))
    CFB.utils.cfb_add(cfb, "/BodyText/Section0", streamData)
    return CFB.write(cfb, { type: "buffer" }) as Buffer
  }

  it("일반(FAT) 체인: 교체 후 출력물에 이전 스트림 바이트가 없다", () => {
    const secret = Buffer.from(MARKER.repeat(1000)) // 17KB ≥ 4096 → 일반 섹터 체인
    const file = buildOle(secret)
    assert.ok(file.includes(Buffer.from(MARKER)), "전제: 원본엔 마커 존재")

    const patched = replaceOleStream(file, "BodyText/Section0", Buffer.from("x"))
    assert.ok(!patched.includes(Buffer.from(MARKER)), "패치 출력물에 삭제 전 텍스트 잔존")

    // 교체 결과 무결성 — 표준 파서로 재확인
    const reparsed = CFB.parse(patched)
    const entry = CFB.find(reparsed, "/BodyText/Section0")
    assert.ok(entry)
    assert.equal(Buffer.from(entry.content).toString(), "x")
  })

  it("mini(FAT) 체인: 교체 후 출력물에 이전 스트림 바이트가 없다", () => {
    const secret = Buffer.from(MARKER.repeat(100)) // 1.7KB < 4096 → mini 체인
    const file = buildOle(secret)
    assert.ok(file.includes(Buffer.from(MARKER)), "전제: 원본엔 마커 존재")

    const patched = replaceOleStream(file, "BodyText/Section0", Buffer.from("y"))
    assert.ok(!patched.includes(Buffer.from(MARKER)), "패치 출력물에 삭제 전 텍스트 잔존 (mini)")

    const reparsed = CFB.parse(patched)
    const entry = CFB.find(reparsed, "/BodyText/Section0")
    assert.ok(entry)
    assert.equal(Buffer.from(entry.content).toString(), "y")
    // 비대상 스트림은 보존
    const other = CFB.find(reparsed, "/FileHeader")
    assert.equal(other!.content.length, 256)
  })
})

// ─── 4. cfb-lenient FAT 할당 증폭 ────────────────────

describe("회귀 C-4: cfb-lenient FAT 엔트리 실 파일크기 sanity", () => {
  it("헤더 fatSectorCount 뻥튀기(10000) + 64KB 섹터 파일이 거대 할당 없이 파싱", () => {
    // sectorShift=16(64KB), DIFAT 섹터 1개에 FAT sid 16383개 채움 → 수정 전 fatTable 655MB 할당
    const sectorSize = 65536
    const header = cfbHeader({ sectorShift: 16, fatSectorCount: 10000, firstDifatSector: 0, difatSectorCount: 1 })
    const difat = Buffer.alloc(sectorSize)
    for (let i = 0; i < sectorSize / 4 - 1; i++) difat.writeUInt32LE(1, i * 4) // 전부 sid=1
    difat.writeUInt32LE(0xfffffffe, sectorSize - 4) // 다음 DIFAT 없음
    const file = Buffer.concat([header, difat]) // ~64.5KB

    const before = process.memoryUsage().arrayBuffers
    const container = parseLenientCfb(file)
    const after = process.memoryUsage().arrayBuffers
    assert.ok(container.entries().length === 0)
    // 수정 전 fatTable만 655MB — 실 파일크기 대비 캡 이후엔 수 MB 미만이어야 함
    assert.ok(after - before < 100 * 1024 * 1024, `할당 증폭: ${((after - before) / 1024 / 1024).toFixed(1)}MB`)
  })
})

// ─── 5. cfb-lenient DIFAT 빈 버퍼 RangeError ─────────

describe("회귀 C-5: cfb-lenient 파일 범위 밖 DIFAT 섹터", () => {
  it("빈 버퍼 readUInt32LE RangeError 없이 lenient 복구 지속", () => {
    // firstDifatSector가 파일 밖(sid=100) → readSectorData 빈 버퍼 → 수정 전 RangeError
    const header = cfbHeader({ sectorShift: 9, fatSectorCount: 1, firstDifatSector: 100, difatSectorCount: 1 })
    const file = Buffer.concat([header, Buffer.alloc(512)])
    const container = parseLenientCfb(file)
    assert.deepEqual(container.entries(), [])
  })
})

// ─── 6. zip-patch 미지원 압축 방식 검증 ──────────────

describe("회귀 C-6: zip-patch method 0/8 외 엔트리 교체 거부", () => {
  it("method=12(bzip2) 엔트리 교체 시도 → 명확한 예외", async () => {
    const zip = new JSZip()
    zip.file("a.xml", "<a>원본</a>")
    const orig = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))

    // 로컬 헤더(+8)와 CD(+10)의 method를 12로 변조
    const dv = new DataView(orig.buffer, orig.byteOffset, orig.byteLength)
    let eocd = -1
    for (let i = orig.length - 22; i >= 0; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break }
    }
    assert.ok(eocd >= 0)
    const cdOffset = dv.getUint32(eocd + 16, true)
    const localOffset = dv.getUint32(cdOffset + 42, true)
    dv.setUint16(cdOffset + 10, 12, true)
    dv.setUint16(localOffset + 8, 12, true)

    assert.throws(
      () => patchZipEntries(orig, new Map([["a.xml", new TextEncoder().encode("<a>수정</a>")]])),
      /지원하지 않는 ZIP 압축 방식.*method=12/,
    )
  })

  it("method=8(DEFLATE) 엔트리 교체는 기존대로 동작", async () => {
    const zip = new JSZip()
    zip.file("a.xml", "<a>원본원본원본원본원본</a>", { compression: "DEFLATE" })
    const orig = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    const patched = patchZipEntries(orig, new Map([["a.xml", new TextEncoder().encode("<a>수정</a>")]]))
    const entry = readZipEntries(patched).get("a.xml")
    assert.ok(entry)
  })
})
