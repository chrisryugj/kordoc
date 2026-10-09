/**
 * 암호 HWPX 복호의 누적 압축 해제 상한 — 평문을 다 모았다가 반영하므로 엔트리별 상한만으로는 N × 상한이
 * 메모리에 오른다 (rhwp 보안 통합 linked-xml: 암호 선처리에도 누적 XML 예산).
 * 상한은 모듈 적재 때 정해지므로 env 를 먼저 두고 동적 import 한다 (테스트 파일마다 별도 프로세스).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "crypto"
import { deflateRawSync } from "zlib"
import JSZip from "jszip"

process.env.KORDOC_MAX_UNZIP_MB = "1"
const { decryptHwpxInPlace } = await import("../src/hwpx/crypto.js")

const PASSWORD = "1234"

/** 한컴과 같은 꼴 — deflate 스트림을 패딩 없이 16 배수로 채워 AES-256-CBC */
function encrypt(path: string, plain: Buffer): { cipher: Buffer; entry: string } {
  const salt = randomBytes(16), iv = randomBytes(16)
  const key = pbkdf2Sync(createHash("sha256").update(PASSWORD).digest(), salt, 1024, 32, "sha1")
  const z = deflateRawSync(plain)
  const padded = Buffer.concat([z, Buffer.alloc((16 - (z.length % 16)) % 16)])
  const c = createCipheriv("aes-256-cbc", key, iv)
  c.setAutoPadding(false)
  const cipher = Buffer.concat([c.update(padded), c.final()])
  const checksum = createHash("sha256").update(plain.subarray(0, 1024)).digest("base64")
  const entry = `<odf:file-entry full-path="${path}" media-type="application/xml" size="${plain.length}">` +
    `<odf:encryption-data checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" checksum="${checksum}">` +
    `<odf:algorithm algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" initialisation-vector="${iv.toString("base64")}"/>` +
    `<odf:key-derivation key-derivation-name="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#pbkdf2" key-size="32" iteration-count="1024" salt="${salt.toString("base64")}"/>` +
    `<odf:start-key-generation start-key-generation-name="http://www.w3.org/2000/09/xmldsig#sha256" key-size="32"/>` +
    `</odf:encryption-data></odf:file-entry>`
  return { cipher, entry }
}

function encryptedZip(count: number, bytes: number): { zip: JSZip; manifest: string } {
  const zip = new JSZip()
  let entries = ""
  for (let k = 0; k < count; k++) {
    const path = `Contents/section${k}.xml`
    const { cipher, entry } = encrypt(path, Buffer.alloc(bytes, "가"))
    zip.file(path, cipher)
    entries += entry
  }
  const manifest = `<?xml version="1.0"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">${entries}</odf:manifest>`
  return { zip, manifest }
}

describe("암호 HWPX 복호 — 누적 압축 해제 상한", () => {
  it("상한 안이면 복호한다", async () => {
    const { zip, manifest } = encryptedZip(1, 600 * 1024)
    assert.equal(await decryptHwpxInPlace(zip, manifest, PASSWORD), 1)
    assert.equal((await zip.file("Contents/section0.xml")!.async("uint8array")).length, 600 * 1024)
  })
  it("엔트리마다는 상한 안이어도 합이 넘으면 ZIP bomb 으로 거부하고 문서를 건드리지 않는다", async () => {
    const { zip, manifest } = encryptedZip(3, 600 * 1024)
    const before = await zip.file("Contents/section0.xml")!.async("uint8array")
    await assert.rejects(decryptHwpxInPlace(zip, manifest, PASSWORD), /ZIP bomb/)
    assert.deepEqual(await zip.file("Contents/section0.xml")!.async("uint8array"), before)
  })
})
