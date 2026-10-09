/**
 * HWP3 그림 — 그림 제어(ch=11)의 내부 이름과 본문 뒤 추가 정보 블록 #1(포함 그림)의 바이트를 짝지어 image 블록으로.
 * 종전엔 추가 정보 블록을 읽지 않아 그림이 경고 없이 사라졌다(그림만 붙인 스캔 보고서 36쪽이 블록 0개).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseHwp3Document } from "../src/hwp3/parser.js"
import { parse } from "../src/index.js"

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c90000000049454e44ae426082", "hex")

// 합성 HWP3 (hwp3-structure.test.ts 와 같은 골격)
function buildHwp3(body: Buffer): ArrayBuffer {
  const sig = Buffer.alloc(30)
  Buffer.from("HWP Document File V3.00", "ascii").copy(sig)
  return new Uint8Array(Buffer.concat([sig, Buffer.alloc(128), Buffer.alloc(1008), body])).buffer
}
const PREAMBLE = Buffer.alloc(16) // 글꼴 7종 × 0 + 스타일 0
const END = Buffer.alloc(43) // 문단 리스트 끝 (char_count 0)
const text = (s: string) => {
  const b = Buffer.alloc(s.length * 2)
  ;[...s].forEach((c, i) => b.writeUInt16LE(c.charCodeAt(0), i * 2))
  return { bytes: b, hchars: s.length }
}
/** ch=11 그림 — 8 byte 헤더 + 348 byte 정보(74 종류, 83 이름) + 캡션 문단 리스트 */
function picture(name: string, picType = 2) {
  const head = Buffer.alloc(8)
  head.writeUInt16LE(11, 0)
  head.writeUInt16LE(11, 6)
  const info = Buffer.alloc(348)
  info[74] = picType
  Buffer.from(name, "ascii").copy(info, 83)
  return { bytes: Buffer.concat([head, info, END]), hchars: 4 }
}
function para(...pieces: Array<{ bytes: Buffer; hchars: number }>): Buffer {
  const header = Buffer.alloc(43)
  header[0] = 1
  header.writeUInt16LE(pieces.reduce((s, p) => s + p.hchars, 0), 1)
  return Buffer.concat([header, ...pieces.map(p => p.bytes)])
}
/** 추가 정보 블록 #1 — 이름 16 byte + 16 byte + 그림 바이트 */
function embedded(name: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32LE(1, 0)
  head.writeUInt32LE(32 + data.length, 4)
  const meta = Buffer.alloc(32)
  Buffer.from(name, "ascii").copy(meta)
  return Buffer.concat([head, meta, data])
}
const doc = (paras: Buffer[], extra: Buffer[] = []) =>
  buildHwp3(Buffer.concat([PREAMBLE, ...paras, END, ...extra, Buffer.alloc(4)]))

describe("HWP3 그림", () => {
  it("포함 그림 바이트를 이름으로 짝지어 image 블록·result.images 로", async () => {
    const buf = doc([para(text("보고")), para(picture("E$$00000.png"))], [embedded("E$$00000.png", PNG)])
    const r = parseHwp3Document(buf)
    assert.equal(r.images?.length, 1)
    assert.equal(r.images![0].mimeType, "image/png")
    assert.ok(Buffer.from(r.images![0].data).equals(PNG))
    assert.match(r.markdown, /!\[image\]\(image_001\.png\)/)
    assert.equal(r.warnings, undefined)
    const p = await parse(buf)
    assert.ok(p.success && p.images?.length === 1, "parse() 결과에도 images")
  })

  it("같은 그림을 두 번 쓰면 한 파일을 함께 가리킨다", () => {
    const r = parseHwp3Document(doc([para(picture("E$$00001.png")), para(picture("E$$00001.png"))], [embedded("E$$00001.png", PNG)]))
    assert.equal(r.images?.length, 1)
    assert.equal((r.markdown.match(/!\[image\]\(image_001\.png\)/g) ?? []).length, 2)
  })

  it("바이트가 없는 그림(외부 연결)은 글 없이 이름으로 경고한다", () => {
    const r = parseHwp3Document(doc([para(text("본문")), para(picture("D:\\images\\oracle.gif", 0))]))
    assert.equal(r.images, undefined)
    assert.doesNotMatch(r.markdown, /image|이미지/)
    assert.ok(r.warnings?.some(w => w.code === "SKIPPED_IMAGE" && w.message.includes("oracle.gif")), JSON.stringify(r.warnings))
  })
})
