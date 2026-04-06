/**
 * HWP 배포용(distribution) 문서 복호화.
 *
 * 배포용 HWP는 ViewText/Section{N} 스트림에 암호화된 본문을 저장.
 * 첫 레코드(HWPTAG_DISTRIBUTE_DOC_DATA)의 256바이트 payload에서 AES 키를 추출한 뒤
 * 나머지 데이터를 AES-128 ECB로 복호화.
 *
 * 알고리즘 참조: rhwp (MIT) src/parser/crypto.rs
 * 포맷 참조: HWP 5.0 바이너리 스펙 — 배포용 문서 구조
 */

import { aes128EcbDecrypt } from "./aes.js"
import { decompressStream } from "./record.js"

// ── MSVC LCG (Linear Congruential Generator) ──

/** MSVC CRT rand() 호환 LCG */
class MsvcLcg {
  private seed: number

  constructor(seed: number) {
    this.seed = seed >>> 0  // u32로 강제
  }

  /** 0 ~ 0x7FFF 범위 난수 반환 (MSVC rand() 호환) */
  rand(): number {
    // MSVC LCG: seed = seed * 214013 + 2531011
    // JS에서 32bit 정수 오버플로우를 정확히 재현하기 위해 Math.imul 사용
    this.seed = (Math.imul(this.seed, 214013) + 2531011) >>> 0
    return (this.seed >>> 16) & 0x7fff
  }
}

// ── 배포용 문서 256바이트 payload 복호화 ──

/**
 * DISTRIBUTE_DOC_DATA 레코드의 256바이트 payload를 LCG+XOR로 복호화.
 *
 * 구조:
 * - bytes[0..4]: LCG seed (u32 LE)
 * - bytes[4..256]: XOR 암호화된 데이터
 *
 * XOR 규칙: LCG에서 키 바이트를 뽑고, n = (lcg.rand() & 0xF) + 1 바이트마다 키 교체
 */
function decryptDistributePayload(payload: Uint8Array): Uint8Array {
  if (payload.length < 256) throw new Error("배포용 payload가 256바이트 미만입니다")

  const seed = (payload[0] | (payload[1] << 8) | (payload[2] << 16) | (payload[3] << 24)) >>> 0
  const lcg = new MsvcLcg(seed)

  const result = new Uint8Array(payload.subarray(0, 256))  // 원본 복사

  // rhwp 호환: i=0부터 시작하여 n 카운터를 소비하되, i<4는 XOR 스킵 (seed 보존)
  // i=4부터 시작하면 LCG 시퀀스가 어긋남 — i=0~3에서도 n을 소비해야 정확함
  let i = 0
  let n = 0
  let key = 0

  while (i < 256) {
    if (n === 0) {
      key = lcg.rand() & 0xff
      n = (lcg.rand() & 0x0f) + 1
    }
    if (i >= 4) {
      result[i] ^= key
    }
    i++
    n--
  }

  return result
}

// ── AES 키 추출 ──

/**
 * 복호화된 256바이트 payload에서 AES-128 키(16바이트) 추출.
 * offset = 4 + (decrypted[0] & 0x0F)
 */
function extractAesKey(decryptedPayload: Uint8Array): Uint8Array {
  const offset = 4 + (decryptedPayload[0] & 0x0f)
  if (offset + 16 > decryptedPayload.length) {
    throw new Error("AES 키 추출 실패: 오프셋이 payload 범위를 초과합니다")
  }
  return decryptedPayload.slice(offset, offset + 16)
}

// ── 레코드 헤더 파싱 ──

/** HWP 레코드 헤더에서 tag_id와 size 추출 */
function parseRecordHeader(data: Uint8Array, offset: number): { tagId: number; size: number; headerSize: number } {
  if (offset + 4 > data.length) throw new Error("레코드 헤더 파싱 실패: 데이터 부족")

  const header = (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0
  const tagId = header & 0x3ff
  let size = (header >>> 20) & 0xfff
  let headerSize = 4

  if (size === 0xfff) {
    if (offset + 8 > data.length) throw new Error("확장 레코드 크기 파싱 실패: 데이터 부족")
    size = (data[offset + 4] | (data[offset + 5] << 8) | (data[offset + 6] << 16) | (data[offset + 7] << 24)) >>> 0
    headerSize = 8
  }

  return { tagId, size, headerSize }
}

// ── 공개 API ──

/** HWPTAG_DISTRIBUTE_DOC_DATA 태그 ID (HWPTAG_BEGIN + 12 = 0x10 + 12 = 0x1C = 28) */
const TAG_DISTRIBUTE_DOC_DATA = 0x10 + 12  // = 28

/**
 * ViewText 스트림을 복호화하여 일반 BodyText 레코드 데이터로 변환.
 *
 * @param viewTextRaw ViewText/Section{N} 스트림의 원본 바이트
 * @param compressed FileHeader의 compressed 플래그
 * @returns 복호화된 레코드 데이터 (readRecords()로 파싱 가능)
 */
export function decryptViewText(viewTextRaw: Buffer, compressed: boolean): Buffer {
  const data = new Uint8Array(viewTextRaw)

  // 1. 첫 레코드 파싱 (DISTRIBUTE_DOC_DATA)
  const rec = parseRecordHeader(data, 0)
  if (rec.tagId !== TAG_DISTRIBUTE_DOC_DATA) {
    throw new Error(`배포용 문서의 첫 레코드가 DISTRIBUTE_DOC_DATA(${TAG_DISTRIBUTE_DOC_DATA})가 아닙니다 (실제: ${rec.tagId})`)
  }

  const payloadStart = rec.headerSize
  const payloadEnd = payloadStart + rec.size
  if (payloadEnd > data.length || rec.size < 256) {
    throw new Error("배포용 payload가 유효하지 않습니다")
  }

  // 2. 256바이트 payload 복호화 (LCG + XOR)
  const payload = data.subarray(payloadStart, payloadStart + 256)
  const decryptedPayload = decryptDistributePayload(payload)

  // 3. AES-128 키 추출
  const aesKey = extractAesKey(decryptedPayload)

  // 4. 나머지 데이터를 AES-128 ECB 복호화
  const encryptedStart = payloadEnd
  const encryptedData = data.subarray(encryptedStart)

  if (encryptedData.length === 0) {
    throw new Error("배포용 문서에 암호화된 본문 데이터가 없습니다")
  }

  // AES ECB는 16바이트 블록 단위 — 패딩 처리
  const alignedLen = encryptedData.length - (encryptedData.length % 16)
  if (alignedLen === 0) {
    throw new Error("암호화된 데이터가 너무 짧습니다 (16바이트 미만)")
  }

  const alignedData = encryptedData.subarray(0, alignedLen)
  const decrypted = aes128EcbDecrypt(alignedData, aesKey)

  // 5. 압축 해제 (compressed 플래그가 설정된 경우)
  if (compressed) {
    try {
      return decompressStream(Buffer.from(decrypted))
    } catch {
      // 압축이 아닐 수도 있음 — 그대로 반환
      return Buffer.from(decrypted)
    }
  }

  return Buffer.from(decrypted)
}

// 테스트용 내부 함수 export
export { MsvcLcg as _MsvcLcg, decryptDistributePayload as _decryptDistributePayload, extractAesKey as _extractAesKey }
