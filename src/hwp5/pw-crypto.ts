/**
 * 비밀번호로 보호된 HWP5 문서 복호화 (EncryptVersion 4).
 *
 * 배포용(ViewText) 문서와는 완전히 다른 방식이다 — 이쪽은 사용자가 지정한 열기 암호로
 * `DocInfo`·`BodyText/Section*`·`BinData/*`·`Scripts/*` 스트림을 각각 복호한다.
 *
 *   키    = SHA-1(인터리브(비밀번호))[0..16]
 *   본문  = AES-128 **비트 단위 CFB**(CFB-1) 복호 — IV 0, 레지스터는 스트림 전역
 *
 * CFB-1 이라 16바이트마다 AES 블록 연산을 128회 수행한다(바이트당 8회). 표준 AES 대비
 * 128배 연산량이라, 블록 암호기 객체를 스트림당 하나만 만들어 재사용한다.
 *
 * 알고리즘 참조: rhwp (MIT) src/parser/crypto.rs — 원 출처는 volexity/hwp-extract
 * (BSD-3-Clause) 의 encrypt.py.
 */

import { createCipheriv, createHash } from "crypto"
import { KordocError } from "../utils.js"

/** FileHeader 의 EncryptVersion(u32 LE) 위치 */
const ENCRYPT_VERSION_OFFSET = 44
/** 우리가 아는 유일한 비밀번호 암호화 버전 */
const SUPPORTED_ENCRYPT_VERSION = 4
/** 키 유도 인터리브의 첫 "이전 바이트" 시드 */
const KEY_SEED = 236

/** FileHeader 에서 EncryptVersion 을 읽는다. 짧으면 0. */
export function readEncryptVersion(fileHeader: Uint8Array): number {
  if (fileHeader.length < ENCRYPT_VERSION_OFFSET + 4) return 0
  return (
    (fileHeader[ENCRYPT_VERSION_OFFSET] |
      (fileHeader[ENCRYPT_VERSION_OFFSET + 1] << 8) |
      (fileHeader[ENCRYPT_VERSION_OFFSET + 2] << 16) |
      (fileHeader[ENCRYPT_VERSION_OFFSET + 3] << 24)) >>>
    0
  )
}

/**
 * 비밀번호 → AES-128 키 16바이트.
 *
 * 각 비밀번호 바이트 앞에 "이전 바이트를 1비트 왼쪽 회전한 값"을 끼워 넣어 길이 2배의
 * 버퍼를 만들고, 그 SHA-1 다이제스트 앞 16바이트를 키로 쓴다. 첫 바이트의 "이전 값"은
 * 시드 상수 236.
 */
export function derivePasswordKey(password: Uint8Array): Buffer {
  const buf = Buffer.alloc(password.length * 2)
  for (let i = 0; i < password.length; i++) {
    const prev = i === 0 ? KEY_SEED : password[i - 1]
    buf[i * 2] = ((prev << 1) | (prev >> 7)) & 0xff // ROL 1
    buf[i * 2 + 1] = password[i]
  }
  return createHash("sha1").update(buf).digest().subarray(0, 16)
}

/** 16바이트 배수로 패드. 이미 배수면 그대로(참조 구현과 동일). */
function padToBlock(data: Uint8Array): Buffer {
  const rem = data.length % 16
  if (rem === 0) return Buffer.from(data)
  const amount = 16 - rem
  return Buffer.concat([Buffer.from(data), Buffer.alloc(amount, amount)])
}

/** 128비트 레지스터를 1비트 왼쪽 시프트하고 최하위 비트에 feedback 을 넣는다 */
function shiftRegister(reg: Uint8Array, feedbackBit: number): void {
  for (let i = 0; i < 15; i++) {
    reg[i] = ((reg[i] << 1) | (reg[i + 1] >> 7)) & 0xff
  }
  reg[15] = ((reg[15] << 1) | (feedbackBit & 1)) & 0xff
}

/**
 * AES-128 비트 단위 CFB 복호.
 *
 * 복호에도 AES 는 **암호화 방향**을 쓴다(CFB 의 정의). 레지스터는 블록마다 리셋하지 않고
 * 스트림 전체에서 이어진다. IV 는 0.
 */
function decryptAesCfb1(data: Buffer, key: Buffer): Buffer {
  // ECB 는 블록 간 체이닝이 없어 Cipher 객체 하나를 계속 재사용해도 안전하다.
  // 매 블록 새로 만들면 128배 호출이라 감당이 안 된다.
  const cipher = createCipheriv("aes-128-ecb", key, null)
  cipher.setAutoPadding(false)

  const register = new Uint8Array(16)
  const registerBuf = Buffer.alloc(16)
  const out = Buffer.alloc(data.length)

  for (let offset = 0; offset < data.length; offset += 16) {
    const len = Math.min(16, data.length - offset)
    const chunk = Buffer.alloc(16)
    data.copy(chunk, 0, offset, offset + len)

    for (let i = 0; i < 128; i++) {
      registerBuf.set(register)
      const keystreamMsb = cipher.update(registerBuf)[0]

      const byteIdx = i >> 3
      const bitInByte = i & 7
      // 되먹임은 **암호문** 비트 — XOR 로 평문이 되기 전 값을 넣어야 한다
      const cipherBit = (chunk[byteIdx] >> (7 - bitInByte)) & 1
      shiftRegister(register, cipherBit)

      chunk[byteIdx] ^= (keystreamMsb & 0x80) >> bitInByte
    }

    chunk.copy(out, offset, 0, len)
  }

  return out
}

/**
 * 암호 스트림 복호 (압축 해제는 하지 않음).
 * CFB 는 길이를 보존하므로 정렬용으로 덧붙인 패딩은 결과에서 잘라낸다.
 */
export function decryptPasswordStream(raw: Uint8Array, password: string): Buffer {
  const key = derivePasswordKey(Buffer.from(password, "utf8"))
  return decryptAesCfb1(padToBlock(raw), key).subarray(0, raw.length)
}

/** DocInfo 선두에 반드시 오는 레코드 (HWPTAG_BEGIN + 0 / + 1) */
const TAG_DOCUMENT_PROPERTIES = 0x0010
const TAG_ID_MAPPINGS = 0x0011

/**
 * 복호한 DocInfo 가 실제 HWP 문서인지 확인한다.
 *
 * 비밀번호가 틀리면 복호 결과가 난수인데, 파서의 DocInfo·섹션 경로는 실패를 경고로
 * 흡수하도록 되어 있어 **"성공했는데 내용이 쓰레기"** 인 결과가 나온다. 압축 문서는
 * inflate 가 곧 무결성 검사지만 비압축 문서는 그것도 없으므로, DocInfo 가 반드시
 * 갖는 선두 레코드 두 종으로 확인한다.
 *
 * @param readRecords 레코드 리더 (순환 import 회피용 주입)
 */
export function assertDecryptedDocInfo(
  data: Buffer,
  readRecords: (buf: Buffer) => Array<{ tagId: number }>,
): void {
  const wrong = () =>
    new KordocError("비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다.")
  let records: Array<{ tagId: number }>
  try {
    records = readRecords(data)
  } catch {
    throw wrong()
  }
  if (records[0]?.tagId !== TAG_DOCUMENT_PROPERTIES) throw wrong()
  if (!records.some(r => r.tagId === TAG_ID_MAPPINGS)) throw wrong()
}

/** EncryptVersion 을 검사하고 미지원이면 던진다 */
export function assertSupportedEncryptVersion(version: number): void {
  if (version !== SUPPORTED_ENCRYPT_VERSION) {
    // 구버전(1~3)을 같은 알고리즘으로 풀면 결과가 쓰레기인데도 "비밀번호 오답"으로
    // 보고돼 사용자가 암호를 계속 다시 입력하게 된다 — 방식이 다르다고 분명히 알린다.
    throw new KordocError(
      `지원하지 않는 HWP 암호화 버전입니다 (EncryptVersion=${version}, 지원: ${SUPPORTED_ENCRYPT_VERSION})`,
    )
  }
}
