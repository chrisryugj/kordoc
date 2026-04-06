/**
 * Lenient CFB 파서 테스트 — 합성 CFB 컨테이너 생성 + 파싱 검증
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseLenientCfb } from "../src/hwp5/cfb-lenient.js"

/** 최소 유효 CFB 파일 생성 (헤더 + 1 FAT 섹터 + 1 디렉토리 섹터 + 1 데이터 섹터) */
function buildMinimalCfb(entries: { name: string; data: Buffer; type?: number }[]): Buffer {
  const sectorSize = 512
  const headerSize = 512

  // 섹터 배치:
  // Sector 0: FAT
  // Sector 1: Directory
  // Sector 2+: Data streams

  const dataSectors: Buffer[] = []
  const dirEntries: { name: string; type: number; startSector: number; size: number }[] = []

  // Root entry (type 5)
  dirEntries.push({ name: "Root Entry", type: 5, startSector: 0xfffffffe, size: 0 })

  for (const entry of entries) {
    const startSector = 2 + dataSectors.length
    // 데이터를 섹터 크기로 패딩
    const padded = Buffer.alloc(Math.ceil(entry.data.length / sectorSize) * sectorSize)
    entry.data.copy(padded)
    for (let off = 0; off < padded.length; off += sectorSize) {
      dataSectors.push(padded.subarray(off, off + sectorSize))
    }
    dirEntries.push({ name: entry.name, type: entry.type ?? 2, startSector, size: entry.data.length })
  }

  const totalSectors = 2 + dataSectors.length  // FAT + Dir + Data
  const buf = Buffer.alloc(headerSize + totalSectors * sectorSize, 0xff)

  // ── 헤더 ──
  // Magic
  Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]).copy(buf, 0)
  // Minor version
  buf.writeUInt16LE(0x003e, 24)
  // Major version (3 = CFBv3)
  buf.writeUInt16LE(3, 26)
  // Byte order
  buf.writeUInt16LE(0xfffe, 28)
  // Sector size shift (9 = 512)
  buf.writeUInt16LE(9, 30)
  // Mini sector size shift (6 = 64)
  buf.writeUInt16LE(6, 32)
  // Total FAT sectors
  buf.writeUInt32LE(1, 44)
  // First directory sector
  buf.writeUInt32LE(1, 48)
  // Mini stream cutoff
  buf.writeUInt32LE(4096, 56)
  // First mini-FAT sector (없음)
  buf.writeUInt32LE(0xfffffffe, 60)
  // Mini-FAT sector count
  buf.writeUInt32LE(0, 64)
  // First DIFAT sector (없음)
  buf.writeUInt32LE(0xfffffffe, 68)
  // DIFAT sector count
  buf.writeUInt32LE(0, 72)
  // DIFAT[0] = FAT는 sector 0
  buf.writeUInt32LE(0, 76)
  // 나머지 DIFAT = FREE
  for (let i = 1; i < 109; i++) buf.writeUInt32LE(0xffffffff, 76 + i * 4)

  // ── Sector 0: FAT ──
  const fatOffset = headerSize
  // Sector 0 (FAT itself) = FATSECT (0xFFFFFFFD)
  buf.writeUInt32LE(0xfffffffd, fatOffset + 0)
  // Sector 1 (Dir) = END_OF_CHAIN
  buf.writeUInt32LE(0xfffffffe, fatOffset + 4)
  // Data sectors: 각 1섹터짜리 → END_OF_CHAIN
  for (let i = 0; i < dataSectors.length; i++) {
    buf.writeUInt32LE(0xfffffffe, fatOffset + (2 + i) * 4)
  }

  // ── Sector 1: Directory ──
  const dirOffset = headerSize + sectorSize
  for (let di = 0; di < dirEntries.length && di < 4; di++) {
    const entryOffset = dirOffset + di * 128
    const de = dirEntries[di]

    // Name (UTF-16LE)
    const nameUtf16 = Buffer.from(de.name + "\0", "utf16le")
    nameUtf16.copy(buf, entryOffset, 0, Math.min(nameUtf16.length, 64))
    // Name size (bytes including null terminator)
    buf.writeUInt16LE(Math.min(nameUtf16.length, 64), entryOffset + 64)
    // Type
    buf[entryOffset + 66] = de.type
    // Color (black = 1)
    buf[entryOffset + 67] = 1
    // Left/Right/Child sibling IDs = 0xFFFFFFFF (none)
    buf.writeUInt32LE(0xffffffff, entryOffset + 68)
    buf.writeUInt32LE(0xffffffff, entryOffset + 72)
    buf.writeUInt32LE(0xffffffff, entryOffset + 76)
    // Start sector
    buf.writeUInt32LE(de.startSector, entryOffset + 116)
    // Size
    buf.writeUInt32LE(de.size, entryOffset + 120)
  }

  // ── Data sectors ──
  for (let i = 0; i < dataSectors.length; i++) {
    dataSectors[i].copy(buf, headerSize + (2 + i) * sectorSize)
  }

  return buf
}

describe("parseLenientCfb", () => {
  it("매직 바이트 불일치 시 에러", () => {
    assert.throws(
      () => parseLenientCfb(Buffer.alloc(1024)),
      /매직/,
    )
  })

  it("512바이트 미만이면 에러", () => {
    assert.throws(
      () => parseLenientCfb(Buffer.alloc(100)),
      /짧습니다/,
    )
  })

  it("합성 CFB에서 스트림 읽기", () => {
    const testData = Buffer.from("Hello, HWP World! This is test stream data.")
    const cfb = buildMinimalCfb([
      { name: "FileHeader", data: testData },
    ])

    const container = parseLenientCfb(cfb)
    const stream = container.findStream("FileHeader")
    assert.ok(stream, "FileHeader 스트림을 찾아야 함")
    assert.equal(stream.subarray(0, testData.length).toString(), testData.toString())
  })

  it("없는 스트림은 null 반환", () => {
    const cfb = buildMinimalCfb([
      { name: "FileHeader", data: Buffer.from("test") },
    ])
    const container = parseLenientCfb(cfb)
    assert.equal(container.findStream("NonExistent"), null)
  })

  it("entries()는 stream 타입만 반환", () => {
    const cfb = buildMinimalCfb([
      { name: "FileHeader", data: Buffer.from("header") },
      { name: "DocInfo", data: Buffer.from("docinfo") },
    ])
    const container = parseLenientCfb(cfb)
    const entries = container.entries()
    assert.ok(entries.length >= 2, `엔트리가 2개 이상이어야 함 (실제: ${entries.length})`)
    assert.ok(entries.some(e => e.name === "FileHeader"))
    assert.ok(entries.some(e => e.name === "DocInfo"))
  })
})
