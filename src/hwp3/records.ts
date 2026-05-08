/**
 * HWP3 fixed-size record definitions.
 *
 * 모두 little-endian. 구조는 rhwp/src/parser/hwp3/records.rs 와 1:1 대응.
 * 텍스트 추출에 필요한 필드만 명시적으로 노출하고, 레이아웃 전용 필드 (margins,
 * tab stops 등) 는 단순 skip 한다.
 */

import { Reader } from "./reader.js"
import { decodeHcharString } from "./johab.js"

// HWP3 file signature: "HWP Document File V3.00 " (24 bytes) + 6-byte tail (\x1A\x01\x02\x03\x04\x05)
// 총 30 byte. 일부 실제 파일은 첫 30 byte 이내에 NUL pad 가 끼어있는 경우가 있어
// 앞 23 byte 의 ASCII signature 만 strict 비교하고 나머지 7 byte 는 advisory.
export const SIGNATURE_PREFIX = Buffer.from("HWP Document File V3.00", "ascii")
export const SIGNATURE_LEN = 30

/** rhwp 와 같은 고정 byte size. cursor 가 정확히 이 만큼 advance 한다. */
export const DOC_INFO_SIZE = 128
export const DOC_SUMMARY_SIZE = 9 * 112 // 9 fields × 112 bytes (56 hchar each)

export interface Hwp3Header {
  /** DocInfo의 압축 플래그 (0이 아니면 InfoBlock 이후 raw deflate 압축). */
  compressed: number
  /** DocInfo 의 encrypted 플래그 (0 이 아니면 본문 암호화 → 복호화 못함). */
  encrypted: number
  /** InfoBlock 길이 (DocSummary 뒤 가변 길이 metadata). */
  infoBlockLength: number
  /** DocSummary 에서 추출한 메타데이터. */
  title: string
  subject: string
  author: string
  date: string
}

/**
 * 헤더 파싱: 30 byte signature + 128 byte DocInfo + 1008 byte DocSummary.
 * 호출 시 reader 위치는 0 이어야 하고, 반환 후엔 InfoBlock 시작점.
 */
export function readHeader(reader: Reader): Hwp3Header {
  // signature 30 byte — strict prefix check
  const sig = reader.readBytes(SIGNATURE_LEN)
  if (!sig.subarray(0, SIGNATURE_PREFIX.length).equals(SIGNATURE_PREFIX)) {
    throw new Error("HWP3: invalid file signature")
  }

  // DocInfo 128 byte — 텍스트 추출에 필요한 3개 필드 외엔 skip.
  // 절대 offset 기준 (DocInfo 시작점 = docInfoStart):
  //   encrypted          : offset 96..97  (u16)  — 0 이 아니면 본문 암호 보호
  //   compressed         : offset 124    (u8)   — 0 이 아니면 InfoBlock 이후 raw deflate
  //   info_block_length  : offset 126..127 (u16) — 가변 InfoBlock 길이
  const docInfoStart = reader.position()
  reader.skip(96)
  const encrypted = reader.readU16() // 96..97
  reader.skip(124 - 98) // → 124
  const compressed = reader.readU8() // 124
  reader.skip(1) // sub_revision (125)
  const infoBlockLength = reader.readU16() // 126..127
  // DocInfo 끝까지 정확히 advance — sanity
  if (reader.position() !== docInfoStart + DOC_INFO_SIZE) {
    throw new Error(
      `HWP3: DocInfo size mismatch (got ${reader.position() - docInfoStart}, expected ${DOC_INFO_SIZE})`,
    )
  }

  // DocSummary 1008 byte — title/subject/author/date 만 추출, 나머지 (keywords, etc) skip.
  // DocSummary 의 string 은 56 hchar × 2 byte 로 구성 — byte 단위가 아닌 u16 hchar 단위로
  // 디코딩해야 ASCII 문자가 high byte 0 padding 으로 인해 잘리지 않는다.
  const summaryStart = reader.position()
  const title = decodeHcharString(reader.readBytes(112))
  const subject = decodeHcharString(reader.readBytes(112))
  const author = decodeHcharString(reader.readBytes(112))
  const date = decodeHcharString(reader.readBytes(112))
  // 나머지 (keywords ×2 + etc ×3 = 5 × 112 = 560 byte) skip
  reader.skip(5 * 112)
  if (reader.position() !== summaryStart + DOC_SUMMARY_SIZE) {
    throw new Error("HWP3: DocSummary size mismatch")
  }

  return { compressed, encrypted, infoBlockLength, title, subject, author, date }
}
