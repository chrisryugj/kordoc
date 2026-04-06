/**
 * Lenient CFB (Compound File Binary / OLE2) 파서.
 *
 * 표준 cfb 모듈이 FAT 검증 실패로 거부하는 손상된 HWP 파일을 열기 위한 폴백.
 * 직접 헤더/FAT/디렉토리를 파싱하여 스트림 데이터를 추출.
 *
 * 참조: rhwp (MIT) src/parser/cfb_reader.rs (LenientCfbReader)
 * 참조: MS-CFB spec (https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-cfb)
 */

import { decompressStream } from "./record.js"

// ── 상수 ──

const CFB_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const END_OF_CHAIN = 0xfffffffe
const FREE_SECT = 0xffffffff

/** 순환 감지용 최대 체인 길이 */
const MAX_CHAIN_LENGTH = 1_000_000
/** 최대 디렉토리 엔트리 수 */
const MAX_DIR_ENTRIES = 100_000
/** 최대 스트림 크기 (100MB) */
const MAX_STREAM_SIZE = 100 * 1024 * 1024

// ── 디렉토리 엔트리 ──

interface DirEntry {
  name: string
  type: number  // 0=unknown, 1=storage, 2=stream, 5=root
  startSector: number
  size: number
}

// ── CFB 컨테이너 ──

export interface LenientCfbContainer {
  /** 이름 기반 스트림 탐색 */
  findStream(path: string): Buffer | null
  /** 디렉토리 엔트리 목록 */
  entries(): DirEntry[]
}

// ── 구현 ──

export function parseLenientCfb(data: Buffer): LenientCfbContainer {
  if (data.length < 512) throw new Error("CFB 파일이 너무 짧습니다 (최소 512바이트)")
  if (!data.subarray(0, 8).equals(CFB_MAGIC)) throw new Error("CFB 매직 바이트 불일치")

  // ── 헤더 파싱 ──

  const sectorSizeShift = data.readUInt16LE(30)
  if (sectorSizeShift < 7 || sectorSizeShift > 16) throw new Error("유효하지 않은 섹터 크기 시프트: " + sectorSizeShift)
  const sectorSize = 1 << sectorSizeShift  // 보통 512
  const miniSectorSizeShift = data.readUInt16LE(32)
  if (miniSectorSizeShift > 16) throw new Error("유효하지 않은 미니 섹터 크기 시프트: " + miniSectorSizeShift)
  const miniSectorSize = 1 << miniSectorSizeShift  // 보통 64

  const fatSectorCount = data.readUInt32LE(44)
  const firstDirSector = data.readUInt32LE(48)
  const miniStreamCutoff = data.readUInt32LE(56)  // 보통 4096
  const firstMiniFatSector = data.readUInt32LE(60)
  const miniFatSectorCount = data.readUInt32LE(64)
  const firstDifatSector = data.readUInt32LE(68)
  const difatSectorCount = data.readUInt32LE(72)

  // ── 유틸 ──

  function sectorOffset(id: number): number {
    return 512 + id * sectorSize
  }

  function readSectorData(id: number): Buffer {
    const off = sectorOffset(id)
    if (off + sectorSize > data.length) return Buffer.alloc(0)
    return data.subarray(off, off + sectorSize)
  }

  // ── DIFAT → FAT 섹터 목록 ──

  const fatSectors: number[] = []

  // 헤더 내 DIFAT (최대 109개)
  for (let i = 0; i < 109 && fatSectors.length < fatSectorCount; i++) {
    const sid = data.readUInt32LE(76 + i * 4)
    if (sid === FREE_SECT || sid === END_OF_CHAIN) break
    fatSectors.push(sid)
  }

  // 추가 DIFAT 섹터 체인
  let difatSector = firstDifatSector
  const visitedDifat = new Set<number>()
  for (let d = 0; d < difatSectorCount && difatSector !== END_OF_CHAIN && difatSector !== FREE_SECT; d++) {
    if (visitedDifat.has(difatSector)) break
    visitedDifat.add(difatSector)

    const buf = readSectorData(difatSector)
    const entriesPerSector = (sectorSize / 4) - 1  // 마지막 4바이트는 다음 DIFAT 포인터
    for (let i = 0; i < entriesPerSector && fatSectors.length < fatSectorCount; i++) {
      const sid = buf.readUInt32LE(i * 4)
      if (sid === FREE_SECT || sid === END_OF_CHAIN) continue
      fatSectors.push(sid)
    }
    difatSector = buf.readUInt32LE(entriesPerSector * 4)
  }

  // ── FAT 테이블 구축 ──

  const entriesPerFatSector = sectorSize / 4
  const fatTable = new Uint32Array(fatSectors.length * entriesPerFatSector)

  for (let fi = 0; fi < fatSectors.length; fi++) {
    const buf = readSectorData(fatSectors[fi])
    for (let i = 0; i < entriesPerFatSector; i++) {
      fatTable[fi * entriesPerFatSector + i] = i * 4 + 3 < buf.length
        ? buf.readUInt32LE(i * 4)
        : FREE_SECT
    }
  }

  // ── 체인 리더 (순환 방지) ──

  function readChain(startSector: number, maxBytes: number): Buffer {
    if (startSector === END_OF_CHAIN || startSector === FREE_SECT) return Buffer.alloc(0)
    if (maxBytes > MAX_STREAM_SIZE) throw new Error("스트림이 너무 큽니다")

    const chunks: Buffer[] = []
    let current = startSector
    let totalRead = 0
    const visited = new Set<number>()

    while (current !== END_OF_CHAIN && current !== FREE_SECT && totalRead < maxBytes) {
      if (visited.has(current)) break  // 순환 감지
      if (visited.size > MAX_CHAIN_LENGTH) break
      visited.add(current)

      const buf = readSectorData(current)
      const remaining = maxBytes - totalRead
      chunks.push(remaining < sectorSize ? buf.subarray(0, remaining) : buf)
      totalRead += Math.min(buf.length, remaining)

      current = current < fatTable.length ? fatTable[current] : END_OF_CHAIN
    }

    return Buffer.concat(chunks)
  }

  // ── Mini-FAT 테이블 ──

  let miniFatTable: Uint32Array | null = null

  function getMiniFatTable(): Uint32Array {
    if (miniFatTable) return miniFatTable

    if (miniFatSectorCount === 0 || firstMiniFatSector === END_OF_CHAIN) {
      miniFatTable = new Uint32Array(0)
      return miniFatTable
    }

    const miniFatData = readChain(firstMiniFatSector, miniFatSectorCount * sectorSize)
    const entries = miniFatData.length / 4
    miniFatTable = new Uint32Array(entries)
    for (let i = 0; i < entries; i++) {
      miniFatTable[i] = miniFatData.readUInt32LE(i * 4)
    }
    return miniFatTable
  }

  // ── 디렉토리 엔트리 파싱 ──

  const dirData = readChain(firstDirSector, MAX_DIR_ENTRIES * 128)
  const dirEntries: DirEntry[] = []

  for (let offset = 0; offset + 128 <= dirData.length && dirEntries.length < MAX_DIR_ENTRIES; offset += 128) {
    const nameLen = dirData.readUInt16LE(offset + 64)  // 바이트 수 (null 포함)
    if (nameLen <= 0 || nameLen > 64) {
      dirEntries.push({ name: "", type: 0, startSector: 0, size: 0 })
      continue
    }

    const nameBytes = nameLen - 2  // null terminator 제외
    const name = nameBytes > 0
      ? dirData.subarray(offset, offset + nameBytes).toString("utf16le")
      : ""

    const type = dirData[offset + 66]
    const startSector = dirData.readUInt32LE(offset + 116)
    // CFBv3에서는 size가 u32 (offset 120), v4에서는 u64
    const size = dirData.readUInt32LE(offset + 120)

    dirEntries.push({ name, type, startSector, size })
  }

  // ── Root 엔트리에서 미니 스트림 추출 ──

  let miniStreamData: Buffer | null = null

  function getMiniStream(): Buffer {
    if (miniStreamData) return miniStreamData
    const root = dirEntries[0]
    if (!root || root.type !== 5) {
      miniStreamData = Buffer.alloc(0)
      return miniStreamData
    }
    miniStreamData = readChain(root.startSector, root.size || MAX_STREAM_SIZE)
    return miniStreamData
  }

  // ── 미니 스트림에서 읽기 ──

  function readMiniStream(startSector: number, size: number): Buffer {
    const mft = getMiniFatTable()
    const ms = getMiniStream()
    if (mft.length === 0 || ms.length === 0) return Buffer.alloc(0)

    const chunks: Buffer[] = []
    let current = startSector
    let totalRead = 0
    const visited = new Set<number>()

    while (current !== END_OF_CHAIN && current !== FREE_SECT && totalRead < size) {
      if (visited.has(current)) break
      if (visited.size > MAX_CHAIN_LENGTH) break
      visited.add(current)

      const off = current * miniSectorSize
      const remaining = size - totalRead
      const chunkSize = Math.min(miniSectorSize, remaining)
      if (off + chunkSize <= ms.length) {
        chunks.push(ms.subarray(off, off + chunkSize))
      }
      totalRead += chunkSize

      current = current < mft.length ? mft[current] : END_OF_CHAIN
    }

    return Buffer.concat(chunks)
  }

  // ── 스트림 읽기 (일반/미니 자동 분기) ──

  function readStreamData(entry: DirEntry): Buffer {
    if (entry.size === 0) return Buffer.alloc(0)
    if (entry.size < miniStreamCutoff) {
      const miniResult = readMiniStream(entry.startSector, entry.size)
      // 미니스트림이 비어있으면 일반 체인으로 폴백 (lenient)
      if (miniResult.length > 0) return miniResult
    }
    return readChain(entry.startSector, entry.size)
  }

  // ── 경로 기반 탐색 ──

  // 전체 경로 맵 구축 (간이: 이름 기반 flat lookup)
  // HWP 파일의 디렉토리 구조는 보통 1~2 depth이므로 이름 매칭으로 충분
  function findEntryByPath(path: string): DirEntry | null {
    // "/FileHeader" → "FileHeader"
    // "/BodyText/Section0" → path component matching
    const parts = path.replace(/^\//, "").split("/")

    if (parts.length === 1) {
      // 단일 이름 매칭
      return dirEntries.find(e => e.name === parts[0] && e.type === 2) ?? null
    }

    // 2-depth: storage/stream
    // HWP 구조: Root/BodyText/Section0, Root/DocInfo, Root/BinData/BIN0001 등
    const storageName = parts[0]
    const streamName = parts.slice(1).join("/")

    // 디렉토리 구조 대신 이름 패턴으로 찾기 (lenient)
    for (const e of dirEntries) {
      if (e.type === 2 && e.name === streamName) {
        // 부모 확인은 생략 (lenient) — 중복 이름 시 첫 번째 반환
        return e
      }
    }

    // 정확한 이름이 아닌 경우 (ViewText/Section0 등)
    const lastPart = parts[parts.length - 1]
    return dirEntries.find(e => e.type === 2 && e.name === lastPart) ?? null
  }

  // ── 공개 API ──

  return {
    findStream(path: string): Buffer | null {
      // \005 prefix 처리 (SummaryInformation)
      const normalized = path.replace(/^\//, "")
      const entry = findEntryByPath(normalized)
      if (!entry || entry.type !== 2) return null
      const stream = readStreamData(entry)
      return stream.length > 0 ? stream : null
    },

    entries(): DirEntry[] {
      return dirEntries.filter(e => e.type === 2)  // stream만
    },
  }
}
