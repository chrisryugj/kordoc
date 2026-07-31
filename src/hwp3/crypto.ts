/**
 * 비밀번호로 보호된 HWP3 문서 복호화.
 *
 * HWP3 은 CFB 컨테이너가 아니라 단일 스트림이라, 고정 헤더 뒤 전체가 **DES-ECB** 로
 * 암호화되어 있다.
 *
 *   [0..30)     시그니처
 *   [30..158)   문서 정보 128B — +96 암호 여부(u16), +124 압축 여부(u8), +126 정보블록 길이(u16)
 *   [158..1166) 문서 요약 1008B
 *   [1166..)    정보 블록(가변) → **여기서부터 끝까지가 암호문**
 *
 * 복호하면 raw deflate 스트림이 나오고, 압축을 풀면 선두 256바이트가 암호 확인용
 * prefix, 그 뒤가 실제 본문이다. 별도 검증 해시가 없어 **압축 무결성이 곧 인증**이다
 * (inflate 성공 + CRC32 + ISIZE 일치).
 *
 * 알고리즘 참조: rhwp (MIT) src/parser/hwp3/crypto.rs
 */

import { createDecipheriv } from "crypto"
import { inflateRawSync } from "zlib"
import { KordocError } from "../utils.js"
import { SIGNATURE_LEN, DOC_INFO_SIZE, DOC_SUMMARY_SIZE } from "./records.js"

const FIXED_HEADER_BYTES = SIGNATURE_LEN + DOC_INFO_SIZE + DOC_SUMMARY_SIZE
const PASSWORD_FLAG_OFFSET = SIGNATURE_LEN + 96
const COMPRESSION_FLAG_OFFSET = SIGNATURE_LEN + 124
const INFO_BLOCK_LENGTH_OFFSET = SIGNATURE_LEN + 126
/** 복호·압축 해제한 본문 선두의 암호 확인 블록 — 파서에 넘기면 글꼴 테이블이 어긋난다 */
const PASSWORD_PREFIX_BYTES = 256
/** 압축 해제 결과 상한 — deflate bomb 방어 (hwp3/parser.ts 와 같은 정책) */
const MAX_DECOMPRESSED_BYTES = 100 * 1024 * 1024

/** 암호 문서 여부 — 문서 정보의 암호 플래그(u16) */
export function isEncryptedHwp3(data: Uint8Array): boolean {
  if (data.length < FIXED_HEADER_BYTES) return false
  return (data[PASSWORD_FLAG_OFFSET] | (data[PASSWORD_FLAG_OFFSET + 1] << 8)) !== 0
}

/**
 * 비밀번호 → DES 키 8바이트.
 *
 * 비밀번호를 UTF-16LE 바이트열로 펼쳐 7바이트 링 버퍼에 `slot = ROL1(slot ^ byte)` 로
 * 누적한 뒤, 그 56비트를 7비트씩 잘라 각 키 바이트의 상위 7비트에 배치한다
 * (최하위 비트는 DES 패리티 자리라 0으로 남는다).
 */
export function deriveDesKey(password: string): Buffer {
  const rolling = new Uint8Array(7)
  let index = 0
  for (let i = 0; i < password.length; i++) {
    const unit = password.charCodeAt(i) // UTF-16 코드 유닛 (서로게이트도 유닛 단위로 흐른다)
    for (const byte of [unit & 0xff, (unit >> 8) & 0xff]) {
      const slot = index % rolling.length
      const mixed = rolling[slot] ^ byte
      rolling[slot] = ((mixed << 1) | (mixed >> 7)) & 0xff // ROL 1
      index++
    }
  }

  const key = Buffer.alloc(8)
  for (let bit = 0; bit < 56; bit++) {
    const sourceBit = (rolling[Math.floor(bit / 8)] >> (7 - (bit % 8))) & 1
    key[Math.floor(bit / 7)] |= sourceBit << (7 - (bit % 7))
  }
  return key
}

/**
 * DES-ECB 복호.
 *
 * Node 는 OpenSSL 3 에서 단일 DES 가 legacy provider 로 빠져 `des-ecb` 를 제공하지 않는다.
 * 3DES 에 같은 키를 세 번 넣으면 EDE 구조상 단일 DES 와 결과가 같다(K1=K2=K3 → E-D-E = E).
 */
function desEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("des-ede3-ecb", Buffer.concat([key, key, key]), null)
  decipher.setAutoPadding(false)
  return Buffer.concat([decipher.update(data), decipher.final()])
}

/** 문서 정보에서 본문(암호문) 시작 위치와 압축 여부를 읽는다 */
function readLayout(data: Uint8Array): { payloadOffset: number; compressed: boolean } {
  if (data.length < FIXED_HEADER_BYTES) {
    throw new KordocError("HWP3 암호 문서: 헤더가 잘렸습니다")
  }
  const infoBlockLength =
    data[INFO_BLOCK_LENGTH_OFFSET] | (data[INFO_BLOCK_LENGTH_OFFSET + 1] << 8)
  const payloadOffset = FIXED_HEADER_BYTES + infoBlockLength
  if (payloadOffset >= data.length) {
    throw new KordocError("HWP3 암호 문서: 본문이 없습니다")
  }
  return { payloadOffset, compressed: data[COMPRESSION_FLAG_OFFSET] !== 0 }
}

/**
 * 암호 HWP3 → 평문 HWP3 바이트.
 *
 * 반환값은 암호·압축 플래그를 0으로 지우고 본문을 평문으로 바꾼 것이라, 기존 HWP3
 * 파서에 그대로 넣을 수 있다.
 */
export function decryptHwp3Document(input: Uint8Array, password: string): Buffer<ArrayBuffer> {
  const { payloadOffset, compressed } = readLayout(input)
  if (!compressed) {
    // 실물 표본이 없어 검증할 수 없다 — 지어내기보다 명시적으로 거부한다
    throw new KordocError("지원하지 않는 HWP3 암호화 방식입니다 (압축되지 않은 암호 본문)")
  }

  const source = Buffer.from(input)
  const payload = source.subarray(payloadOffset)
  // DES 는 8바이트 블록 — 끝의 정렬 패딩은 잘라낸다
  const aligned = payload.subarray(0, payload.length - (payload.length % 8))
  if (aligned.length === 0) {
    throw new KordocError("HWP3 암호 문서: 본문이 너무 짧습니다")
  }

  const decrypted = desEcbDecrypt(aligned, deriveDesKey(password))

  let inflated: Buffer
  try {
    inflated = inflateRawSync(decrypted, { maxOutputLength: MAX_DECOMPRESSED_BYTES })
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ERR_BUFFER_TOO_LARGE") {
      throw new KordocError(
        `HWP3 암호 본문의 압축 해제 결과가 최대 허용 크기(${MAX_DECOMPRESSED_BYTES / 1024 / 1024}MB)를 초과했습니다`,
      )
    }
    // 비밀번호가 틀리면 복호 결과가 난수라 inflate 가 깨진다 — 압축 무결성이 곧 인증
    throw new KordocError("비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다.")
  }

  if (inflated.length <= PASSWORD_PREFIX_BYTES) {
    throw new KordocError("비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다.")
  }

  const body = inflated.subarray(PASSWORD_PREFIX_BYTES)
  const out = Buffer.concat([source.subarray(0, payloadOffset), body])
  out.writeUInt16LE(0, PASSWORD_FLAG_OFFSET) // 암호 플래그 해제
  out[COMPRESSION_FLAG_OFFSET] = 0 // 본문을 이미 풀었으므로 압축 플래그도 해제
  return out
}
