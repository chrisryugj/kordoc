/**
 * ZIP in-place 패치 — 지정 엔트리만 교체하고 나머지는 원본 바이트 그대로 보존.
 *
 * JSZip generateAsync는 전 엔트리를 재압축/재직렬화하므로 바이트 보존이 깨진다.
 * 여기서는 Central Directory를 직접 파싱해 변경 엔트리의 로컬 레코드만 재작성하고,
 * 나머지 로컬 레코드·CD 엔트리·EOCD는 원본 바이트를 복사(오프셋 필드만 패치)한다.
 * mimetype 첫 엔트리 + 무압축(STORE) 같은 HWPX/OPC 규약은 원본 순서·메서드를
 * 그대로 따르므로 자동 보존된다.
 */

import { deflateRawSync } from "zlib"
import { KordocError } from "../utils.js"

const EOCD_SIG = 0x06054b50
const CD_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_EOCD_LOC_SIG = 0x07064b50

interface CdEntry {
  /** CD 레코드 원본 바이트 범위 [start, end) */
  cdStart: number
  cdEnd: number
  name: string
  flags: number
  method: number
  crc: number
  compSize: number
  uncompSize: number
  localOffset: number
}

/** ZIP 내 엔트리별 압축 해제 데이터 읽기 (검증용) */
export function readZipEntries(buf: Uint8Array): Map<string, { method: number; compData: Uint8Array }> {
  const { entries } = parseCentralDirectory(buf)
  const result = new Map<string, { method: number; compData: Uint8Array }>()
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  for (const e of entries) {
    const dataStart = localDataStart(view, e.localOffset)
    result.set(e.name, { method: e.method, compData: buf.subarray(dataStart, dataStart + e.compSize) })
  }
  return result
}

function localDataStart(view: DataView, localOffset: number): number {
  if (view.getUint32(localOffset, true) !== LOCAL_SIG) {
    throw new KordocError("ZIP 로컬 헤더 시그니처 불일치")
  }
  const nameLen = view.getUint16(localOffset + 26, true)
  const extraLen = view.getUint16(localOffset + 28, true)
  return localOffset + 30 + nameLen + extraLen
}

/** Buffer.prototype.slice는 view를 반환하므로 (Uint8Array와 달리) 명시적 복사 */
function copyBytes(buf: Uint8Array, start: number, end?: number): Uint8Array {
  return new Uint8Array(buf.subarray(start, end))
}

function parseCentralDirectory(buf: Uint8Array): { entries: CdEntry[]; cdOffset: number; cdSize: number; eocdOffset: number } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  // EOCD 탐색 (뒤에서부터, 주석 최대 64KB) — comment 길이가 파일 끝과 일치해야
  // 진짜 EOCD (엔트리 데이터/comment 안 가짜 시그니처 배제)
  const minEocd = Math.max(0, buf.length - 22 - 65535)
  let eocdOffset = -1
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (view.getUint32(i, true) === EOCD_SIG && i + 22 + view.getUint16(i + 20, true) === buf.length) {
      eocdOffset = i
      break
    }
  }
  if (eocdOffset < 0) {
    // 폴백: EOCD 뒤 trailing 정크가 붙은 파일 (parse()는 수용) — comment 길이가
    // 파일 끝에 못 미치더라도 CD 시그니처가 검증되는 첫 후보를 채택
    for (let i = buf.length - 22; i >= minEocd; i--) {
      if (view.getUint32(i, true) !== EOCD_SIG) continue
      if (i + 22 + view.getUint16(i + 20, true) > buf.length) continue
      const cand = view.getUint32(i + 16, true)
      if (cand < buf.length - 4 && view.getUint32(cand, true) === CD_SIG) { eocdOffset = i; break }
    }
  }
  if (eocdOffset < 0) throw new KordocError("ZIP EOCD를 찾을 수 없습니다")

  const totalEntries = view.getUint16(eocdOffset + 10, true)
  const cdSize = view.getUint32(eocdOffset + 12, true)
  const cdOffset = view.getUint32(eocdOffset + 16, true)
  if (cdOffset === 0xffffffff || totalEntries === 0xffff) throw new KordocError("ZIP64는 지원하지 않습니다")
  // ZIP64 EOCD locator 존재 여부
  if (eocdOffset >= 20 && view.getUint32(eocdOffset - 20, true) === ZIP64_EOCD_LOC_SIG) {
    throw new KordocError("ZIP64는 지원하지 않습니다")
  }

  const decoder = new TextDecoder("utf-8")
  const entries: CdEntry[] = []
  let pos = cdOffset
  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(pos, true) !== CD_SIG) throw new KordocError("ZIP Central Directory 손상")
    const flags = view.getUint16(pos + 8, true)
    const method = view.getUint16(pos + 10, true)
    const crc = view.getUint32(pos + 16, true)
    const compSize = view.getUint32(pos + 20, true)
    const uncompSize = view.getUint32(pos + 24, true)
    const nameLen = view.getUint16(pos + 28, true)
    const extraLen = view.getUint16(pos + 30, true)
    const commentLen = view.getUint16(pos + 32, true)
    const localOffset = view.getUint32(pos + 42, true)
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new KordocError("ZIP64는 지원하지 않습니다")
    }
    const name = decoder.decode(buf.subarray(pos + 46, pos + 46 + nameLen))
    const cdEnd = pos + 46 + nameLen + extraLen + commentLen
    entries.push({ cdStart: pos, cdEnd, name, flags, method, crc, compSize, uncompSize, localOffset })
    pos = cdEnd
  }
  return { entries, cdOffset, cdSize, eocdOffset }
}

// ─── CRC-32 ─────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ─── 재조립 ──────────────────────────────────────────

/**
 * ZIP에서 replacements에 지정된 엔트리만 새 데이터로 교체하고 나머지는
 * 원본 로컬 레코드 바이트를 그대로 복사하여 재조립한다.
 *
 * @param original 원본 ZIP 바이트
 * @param replacements 엔트리 이름 → 새 압축 전 데이터
 * @param additions 신규 엔트리 이름 → 데이터 (기존 로컬 레코드 뒤·CD 앞에 추가 —
 *   도장 이미지 등 BinData 파트 추가용. 기존 엔트리와 이름 충돌 시 에러)
 */
export function patchZipEntries(
  original: Uint8Array,
  replacements: Map<string, Uint8Array>,
  additions?: Map<string, Uint8Array>,
): Uint8Array {
  const { entries, cdOffset, eocdOffset } = parseCentralDirectory(original)
  const view = new DataView(original.buffer, original.byteOffset, original.byteLength)

  for (const name of replacements.keys()) {
    if (!entries.some(e => e.name === name)) throw new KordocError(`ZIP에 없는 엔트리: ${name}`)
  }
  if (additions) {
    for (const name of additions.keys()) {
      if (entries.some(e => e.name === name)) throw new KordocError(`ZIP에 이미 있는 엔트리: ${name}`)
    }
  }

  // 로컬 레코드 순서 = 원본 로컬 오프셋 순서 (mimetype 첫 엔트리 보존)
  const byLocal = [...entries].sort((a, b) => a.localOffset - b.localOffset)
  const segments: Uint8Array[] = []
  const newLocalOffset = new Map<CdEntry, number>()
  const newMeta = new Map<CdEntry, { crc: number; compSize: number; uncompSize: number; flags: number }>()
  let offset = 0

  for (let i = 0; i < byLocal.length; i++) {
    const e = byLocal[i]
    const segEnd = i + 1 < byLocal.length ? byLocal[i + 1].localOffset : cdOffset
    newLocalOffset.set(e, offset)

    const newData = replacements.get(e.name)
    if (newData === undefined) {
      // 원본 로컬 레코드 (데이터 디스크립터 포함) 바이트 그대로
      const seg = original.subarray(e.localOffset, segEnd)
      segments.push(seg)
      offset += seg.length
      continue
    }

    // 교체 엔트리 — 원본 로컬 헤더를 복사한 뒤 crc/size/flags만 패치
    if (view.getUint32(e.localOffset, true) !== LOCAL_SIG) throw new KordocError("ZIP 로컬 헤더 시그니처 불일치")
    const nameLen = view.getUint16(e.localOffset + 26, true)
    const extraLen = view.getUint16(e.localOffset + 28, true)
    const headerLen = 30 + nameLen + extraLen
    const header = copyBytes(original, e.localOffset, e.localOffset + headerLen)
    const hview = new DataView(header.buffer, header.byteOffset, header.byteLength)

    const method = e.method
    if (method !== 0 && method !== 8) {
      throw new KordocError(`지원하지 않는 ZIP 압축 방식(method=${method}): ${e.name} — STORE(0)/DEFLATE(8)만 교체 가능`)
    }
    const compData = method === 0 ? newData : new Uint8Array(deflateRawSync(newData))
    const crc = crc32(newData)
    const flags = e.flags & ~0x0008 // 데이터 디스크립터 비트 해제 (사이즈를 헤더에 기록)

    hview.setUint16(6, flags, true)
    hview.setUint32(14, crc, true)
    hview.setUint32(18, compData.length, true)
    hview.setUint32(22, newData.length, true)

    segments.push(header, compData)
    offset += headerLen + compData.length
    newMeta.set(e, { crc, compSize: compData.length, uncompSize: newData.length, flags })
  }

  // 신규 엔트리 — 기존 로컬 레코드 뒤에 UTF-8 이름·고정 타임스탬프로 기록.
  // PNG 등 기압축 데이터는 deflate가 오히려 커질 수 있어 작아질 때만 압축(STORE 폴백).
  const added: Array<{
    nameBytes: Uint8Array
    crc: number
    compSize: number
    uncompSize: number
    method: number
    localOffset: number
  }> = []
  if (additions) {
    const encoder = new TextEncoder()
    for (const [name, data] of additions) {
      const nameBytes = encoder.encode(name)
      const deflated = new Uint8Array(deflateRawSync(data))
      const method = deflated.length < data.length ? 8 : 0
      const compData = method === 8 ? deflated : data
      const crc = crc32(data)
      const header = new Uint8Array(30 + nameBytes.length)
      const hv = new DataView(header.buffer)
      hv.setUint32(0, LOCAL_SIG, true)
      hv.setUint16(4, 20, true) // version needed
      hv.setUint16(6, 0x0800, true) // UTF-8 이름 플래그
      hv.setUint16(8, method, true)
      hv.setUint16(10, 0, true) // time
      hv.setUint16(12, 0x21, true) // date 1980-01-01 (결정적 출력)
      hv.setUint32(14, crc, true)
      hv.setUint32(18, compData.length, true)
      hv.setUint32(22, data.length, true)
      hv.setUint16(26, nameBytes.length, true)
      hv.setUint16(28, 0, true)
      header.set(nameBytes, 30)
      added.push({ nameBytes, crc, compSize: compData.length, uncompSize: data.length, method, localOffset: offset })
      segments.push(header, compData)
      offset += header.length + compData.length
    }
  }

  // Central Directory — 원본 CD 엔트리 순서 유지, 오프셋/메타 패치
  const newCdOffset = offset
  for (const e of entries) {
    const cd = copyBytes(original, e.cdStart, e.cdEnd)
    const cview = new DataView(cd.buffer, cd.byteOffset, cd.byteLength)
    cview.setUint32(42, newLocalOffset.get(e)!, true)
    const meta = newMeta.get(e)
    if (meta) {
      cview.setUint16(8, meta.flags, true)
      cview.setUint32(16, meta.crc, true)
      cview.setUint32(20, meta.compSize, true)
      cview.setUint32(24, meta.uncompSize, true)
    }
    segments.push(cd)
    offset += cd.length
  }

  // 신규 엔트리 CD 레코드 (원본 CD 뒤)
  for (const a of added) {
    const cd = new Uint8Array(46 + a.nameBytes.length)
    const cv = new DataView(cd.buffer)
    cv.setUint32(0, CD_SIG, true)
    cv.setUint16(4, 20, true) // version made by
    cv.setUint16(6, 20, true) // version needed
    cv.setUint16(8, 0x0800, true) // UTF-8 이름 플래그
    cv.setUint16(10, a.method, true)
    cv.setUint16(12, 0, true) // time
    cv.setUint16(14, 0x21, true) // date 1980-01-01
    cv.setUint32(16, a.crc, true)
    cv.setUint32(20, a.compSize, true)
    cv.setUint32(24, a.uncompSize, true)
    cv.setUint16(28, a.nameBytes.length, true)
    cv.setUint32(42, a.localOffset, true)
    cd.set(a.nameBytes, 46)
    segments.push(cd)
    offset += cd.length
  }
  const newCdSize = offset - newCdOffset

  // EOCD — 원본 복사 후 CD 오프셋/크기 패치 (신규 엔트리만큼 카운트 증가)
  const eocd = copyBytes(original, eocdOffset)
  const eview = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength)
  if (added.length > 0) {
    eview.setUint16(8, view.getUint16(eocdOffset + 8, true) + added.length, true)
    eview.setUint16(10, view.getUint16(eocdOffset + 10, true) + added.length, true)
  }
  eview.setUint32(12, newCdSize, true)
  eview.setUint32(16, newCdOffset, true)
  segments.push(eocd)
  offset += eocd.length

  const result = new Uint8Array(offset)
  let pos = 0
  for (const seg of segments) {
    result.set(seg, pos)
    pos += seg.length
  }
  return result
}
