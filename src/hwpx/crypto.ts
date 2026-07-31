/**
 * 비밀번호로 보호된 HWPX 문서 복호화.
 *
 * HWPX 암호화는 ECMA-376(MS Office) 방식이 아니라 **ODF(OpenDocument) 표준**을 따른다.
 * 각 ZIP 엔트리를 raw deflate 로 압축한 **뒤** AES-256-CBC 로 암호화하고, 평문으로 남는
 * `META-INF/manifest.xml` 의 `<odf:encryption-data>` 에 복호에 필요한 값을 적어 둔다.
 *
 *   키   = PBKDF2(SHA-256(비밀번호), salt, iteration-count) → key-size 바이트
 *   본문 = inflateRaw(AES-256-CBC-복호(엔트리))
 *   검증 = SHA-256(평문 앞 1024바이트) == manifest 의 checksum
 *
 * 알고리즘 참조: rhwp (MIT) src/parser/hwpx/crypto.rs
 * 포맷 참조: OASIS OpenDocument v1.2 §3.4 Encryption
 */

import { createDecipheriv, createHash, pbkdf2Sync, timingSafeEqual } from "crypto"
import { inflateRawSync } from "zlib"
import type JSZip from "jszip"
import { KordocError } from "../utils.js"
import { MAX_DECOMPRESS_SIZE } from "./parser-shared.js"

/** PBKDF2 반복 횟수 상한 — 악성 manifest 가 CPU 를 무한히 태우는 것을 막는다.
 *  한컴 저장본의 실제 값은 1024. */
const MAX_ITERATION_COUNT = 1_000_000

const AES256_CBC = "http://www.w3.org/2001/04/xmlenc#aes256-cbc"
const START_KEY_SHA256 = "http://www.w3.org/2000/09/xmldsig#sha256"
const CHECKSUM_SHA256_1K = "sha256-1k"
/** 체크섬 대상 — 평문 선두 1KB (checksum-type `…#sha256-1k`) */
const CHECKSUM_PREFIX_BYTES = 1024

/** manifest 의 `<encryption-data>` 한 건 */
interface EntryCrypto {
  path: string
  checksum: Buffer
  iv: Buffer
  salt: Buffer
  iterations: number
  keySize: number
}

/** 암호 HWPX 여부 — manifest 에 encryption-data 가 하나라도 있으면 참 */
export function isEncryptedManifest(manifestXml: string): boolean {
  return manifestXml.includes("encryption-data")
}

const attrOf = (xml: string, name: string): string | undefined =>
  xml.match(new RegExp(`${name}="([^"]*)"`))?.[1]

/**
 * manifest.xml 에서 암호화된 엔트리 목록을 뽑는다.
 * 선언된 알고리즘이 우리가 아는 조합과 다르면 조용히 건너뛰지 않고 던진다 —
 * 모르는 방식을 무시하면 "복호 성공했는데 내용이 깨진" 결과가 나온다.
 */
export function parseEncryptionManifest(manifestXml: string): EntryCrypto[] {
  const entries: EntryCrypto[] = []
  // 네임스페이스 접두사는 문서마다 다를 수 있어 `[^:>\s]*:?file-entry` 로 받는다
  const entryRe = /<[^:>\s]*:?file-entry\b([^>]*)>([\s\S]*?)<\/[^:>\s]*:?file-entry>/g
  let m: RegExpExecArray | null
  while ((m = entryRe.exec(manifestXml)) !== null) {
    const [, attrs, inner] = m
    if (!inner.includes("encryption-data")) continue

    const path = attrOf(attrs, "full-path")
    if (!path) continue

    const algorithm = attrOf(inner, "algorithm-name")
    const startKey = attrOf(inner, "start-key-generation-name")
    const checksumType = attrOf(inner, "checksum-type")
    if (algorithm !== AES256_CBC) {
      throw new KordocError(`지원하지 않는 HWPX 암호화 방식입니다: ${algorithm ?? "(미상)"}`)
    }
    if (startKey !== START_KEY_SHA256) {
      throw new KordocError(`지원하지 않는 HWPX 시작키 생성 방식입니다: ${startKey ?? "(미상)"}`)
    }
    if (!checksumType?.endsWith(CHECKSUM_SHA256_1K)) {
      throw new KordocError(`지원하지 않는 HWPX 체크섬 방식입니다: ${checksumType ?? "(미상)"}`)
    }

    const iterations = parseInt(attrOf(inner, "iteration-count") ?? "", 10)
    const keySize = parseInt(attrOf(inner, "key-size") ?? "", 10)
    const iv = Buffer.from(attrOf(inner, "initialisation-vector") ?? "", "base64")
    const salt = Buffer.from(attrOf(inner, "salt") ?? "", "base64")
    const checksum = Buffer.from(attrOf(inner, "checksum") ?? "", "base64")

    if (!(iterations > 0 && iterations <= MAX_ITERATION_COUNT)) {
      throw new KordocError(`HWPX 암호화 반복 횟수가 허용 범위를 벗어났습니다: ${iterations}`)
    }
    if (keySize !== 32 || iv.length !== 16 || salt.length === 0 || checksum.length !== 32) {
      throw new KordocError(`HWPX 암호화 파라미터가 올바르지 않습니다 (${path})`)
    }

    entries.push({ path, checksum, iv, salt, iterations, keySize })
  }
  return entries
}

/** manifest 에서 `<encryption-data>` 서브트리만 제거 — 복호 후에는 평문 문서이므로 */
export function stripEncryptionData(manifestXml: string): string {
  return manifestXml.replace(/<([^:>\s]*:?)encryption-data\b[\s\S]*?<\/\1encryption-data>/g, "")
}

/**
 * 엔트리 하나를 복호 + 압축 해제.
 * PBKDF2 의 PRF 는 manifest 에 적히지 않는다 — ODF 1.2 기본인 HMAC-SHA1 을 먼저 쓰고,
 * 실패하면 1.3+ 의 HMAC-SHA256 으로 재시도한다.
 * 체크섬이 맞지 않으면 undefined (비밀번호 오답 또는 손상).
 */
function decryptEntry(cipher: Buffer, entry: EntryCrypto, startKey: Buffer): Buffer | undefined {
  if (cipher.length === 0 || cipher.length % 16 !== 0) return undefined

  for (const prf of ["sha1", "sha256"] as const) {
    try {
      const key = pbkdf2Sync(startKey, entry.salt, entry.iterations, entry.keySize, prf)
      const decipher = createDecipheriv("aes-256-cbc", key, entry.iv)
      // 한컴은 PKCS#7 패딩을 붙이지 않고 전 블록을 그대로 deflate 스트림으로 넘긴다.
      // 표준대로 패딩을 벗기면 정상 문서가 손상된다.
      decipher.setAutoPadding(false)
      const raw = Buffer.concat([decipher.update(cipher), decipher.final()])
      const plain = inflateRawSync(raw, { maxOutputLength: MAX_DECOMPRESS_SIZE })

      const sum = createHash("sha256")
        .update(plain.subarray(0, Math.min(CHECKSUM_PREFIX_BYTES, plain.length)))
        .digest()
      if (sum.length === entry.checksum.length && timingSafeEqual(sum, entry.checksum)) return plain
    } catch {
      // 이 PRF 로는 복호·압축 해제가 안 됨 — 다음 후보로
    }
  }
  return undefined
}

/**
 * 암호 HWPX 를 제자리에서 평문으로 되돌린다.
 * 복호한 내용을 같은 JSZip 인스턴스에 덮어써서, 이후 파싱 경로는 평문 문서와 완전히 같아진다.
 *
 * @returns 복호한 엔트리 수. 암호 엔트리가 없으면 0 (문서 불변).
 * @throws 비밀번호 불일치·손상, 미지원 암호화 방식
 */
export async function decryptHwpxInPlace(
  zip: JSZip,
  manifestXml: string,
  password: string,
): Promise<number> {
  const entries = parseEncryptionManifest(manifestXml)
  if (entries.length === 0) return 0

  const startKey = createHash("sha256").update(Buffer.from(password, "utf8")).digest()
  const decrypted: Array<{ path: string; plain: Buffer }> = []

  for (const entry of entries) {
    const file = zip.file(entry.path)
    if (!file) {
      throw new KordocError(`암호 목록에 있는 파일이 문서에 없습니다: ${entry.path}`)
    }
    const plain = decryptEntry(await file.async("nodebuffer"), entry, startKey)
    if (!plain) {
      // 오답과 손상을 구분해 알리지 않는다 — 구분해 주면 비밀번호 추측의 신호가 된다
      throw new KordocError("비밀번호가 일치하지 않거나 암호화 데이터가 손상되었습니다.")
    }
    decrypted.push({ path: entry.path, plain })
  }

  // 전부 복호에 성공한 뒤에 한꺼번에 반영 — 중간 실패로 반쪽짜리 문서가 남지 않게
  for (const { path, plain } of decrypted) zip.file(path, plain)
  zip.file("META-INF/manifest.xml", stripEncryptionData(manifestXml))
  return decrypted.length
}
