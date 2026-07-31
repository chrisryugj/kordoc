/**
 * 비밀번호로 보호된 문서 열기 (#59) — HWPX·HWP3·HWP5.
 *
 * 세 포맷의 암호화 방식이 전부 다르다:
 *  - HWPX: ODF 표준 (AES-256-CBC + PBKDF2, **NoPadding**)
 *  - HWP3: 단일 DES-ECB (압축 무결성이 곧 인증)
 *  - HWP5: EncryptVersion 4, AES-128 비트 단위 CFB
 *
 * 픽스처(암호 `123456`)는 rhwp(MIT) samples 에서 가져왔다 — tests/fixtures/password/README.md
 * 참조. HWP5(CFB) 암호본은 2.9MB라 저장소에 넣지 않았고, `KORDOC_PW_FIXTURES` 로 rhwp
 * samples 경로를 주면 함께 돈다(없으면 그 케이스만 skip).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import { parse, parseHwp, parseHwp3, parseHwpx } from "../src/index.js"
import { deriveDesKey } from "../src/hwp3/crypto.js"
import { derivePasswordKey, readEncryptVersion } from "../src/hwp5/pw-crypto.js"
import { parseEncryptionManifest, stripEncryptionData } from "../src/hwpx/crypto.js"

const BUNDLED = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/password")
const EXTERNAL = process.env.KORDOC_PW_FIXTURES ?? resolve(process.env.HOME ?? "", "workspace/rhwp/samples")
/** 저장소 픽스처 우선, 없으면 외부(rhwp samples) */
const fixture = (name: string) =>
  existsSync(resolve(BUNDLED, name)) ? resolve(BUNDLED, name) : resolve(EXTERNAL, name)
const has = (name: string) => existsSync(fixture(name))

describe("HWP3 키 유도 (rhwp known-answer)", () => {
  it("'123456' → c434b20ccc6000d0", () => {
    assert.equal(deriveDesKey("123456").toString("hex"), "c434b20ccc6000d0")
  })

  it("비밀번호가 다르면 키도 다르다", () => {
    assert.notEqual(deriveDesKey("123456").toString("hex"), deriveDesKey("123457").toString("hex"))
  })
})

describe("HWP5 키 유도", () => {
  it("SHA-1 인터리브 — 길이 16바이트", () => {
    const key = derivePasswordKey(Buffer.from("123456", "utf8"))
    assert.equal(key.length, 16)
    assert.equal(key.toString("hex"), "4471ba5269ac43d4917f7e442f9b22fc")
  })

  it("EncryptVersion은 FileHeader [44..48)", () => {
    const fh = Buffer.alloc(48)
    fh.writeUInt32LE(4, 44)
    assert.equal(readEncryptVersion(fh), 4)
    assert.equal(readEncryptVersion(Buffer.alloc(40)), 0) // 짧으면 0
  })
})

describe("HWPX manifest 파싱", () => {
  const manifest = `<?xml version="1.0"?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">` +
    `<odf:file-entry full-path="Contents/section0.xml" media-type="application/xml" size="100">` +
    `<odf:encryption-data checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" checksum="${Buffer.alloc(32).toString("base64")}">` +
    `<odf:algorithm algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" initialisation-vector="${Buffer.alloc(16).toString("base64")}"/>` +
    `<odf:key-derivation key-derivation-name="…#pbkdf2" key-size="32" iteration-count="1024" salt="${Buffer.alloc(16).toString("base64")}"/>` +
    `<odf:start-key-generation start-key-generation-name="http://www.w3.org/2000/09/xmldsig#sha256" key-size="32"/>` +
    `</odf:encryption-data></odf:file-entry></odf:manifest>`

  it("암호 엔트리를 뽑는다", () => {
    const entries = parseEncryptionManifest(manifest)
    assert.equal(entries.length, 1)
    assert.equal(entries[0].path, "Contents/section0.xml")
    assert.equal(entries[0].iterations, 1024)
  })

  it("모르는 알고리즘은 조용히 넘기지 않고 던진다", () => {
    const other = manifest.replace("#aes256-cbc", "#aes128-cbc")
    assert.throws(() => parseEncryptionManifest(other), /지원하지 않는/)
  })

  it("반복 횟수 상한을 넘기면 거부한다 (CPU 소모 방어)", () => {
    const huge = manifest.replace('iteration-count="1024"', 'iteration-count="99999999"')
    assert.throws(() => parseEncryptionManifest(huge), /반복 횟수/)
  })

  it("encryption-data를 제거하면 평문 manifest가 된다", () => {
    const stripped = stripEncryptionData(manifest)
    assert.ok(!stripped.includes("encryption-data"))
    assert.ok(stripped.includes("full-path=\"Contents/section0.xml\""))
  })
})

describe("암호 문서 열기 (실물 픽스처)", () => {
  const cases = [
    { name: "HWP5-password-123456.hwpx", label: "HWPX", parser: parseHwpx },
    { name: "HWP3-password-123456.hwp", label: "HWP3", parser: parseHwp3 },
    { name: "hwp3-sample16-hwp5-2024-password-123456.hwp", label: "HWP5", parser: parseHwp },
  ] as const

  for (const { name, label, parser } of cases) {
    it(`${label}: 올바른 비밀번호로 본문이 나온다`, async (t) => {
      if (!has(name)) return t.skip(`픽스처 없음: ${name}`)
      const r = await parser(readFileSync(fixture(name)) as never, { password: "123456" })
      assert.equal(r.success, true)
      assert.ok(r.markdown.length > 100, `본문이 너무 짧다 (${r.markdown.length}자)`)
    })

    it(`${label}: 비밀번호 없이 열면 ENCRYPTED로 실패한다`, async (t) => {
      if (!has(name)) return t.skip(`픽스처 없음: ${name}`)
      const r = await parser(readFileSync(fixture(name)) as never, {})
      assert.equal(r.success, false)
      assert.equal((r as { code?: string }).code, "ENCRYPTED")
    })

    it(`${label}: 틀린 비밀번호는 성공으로 위장하지 않는다`, async (t) => {
      if (!has(name)) return t.skip(`픽스처 없음: ${name}`)
      const r = await parser(readFileSync(fixture(name)) as never, { password: "wrong-password" })
      // 오답으로 나온 난수를 파싱해 "성공했는데 내용이 쓰레기"가 되는 것이 최악의 실패다
      assert.equal(r.success, false)
      assert.equal((r as { code?: string }).code, "ENCRYPTED")
    })
  }

  it("HWPX 복호 결과가 평문 대조본과 일치한다", async (t) => {
    if (!has("HWP5-password-123456.hwpx") || !has("HWP5-nopassword-123456.hwpx")) {
      return t.skip("픽스처 없음")
    }
    const enc = await parseHwpx(readFileSync(fixture("HWP5-password-123456.hwpx")), { password: "123456" })
    const plain = await parseHwpx(readFileSync(fixture("HWP5-nopassword-123456.hwpx")))
    assert.equal(enc.markdown, plain.markdown)
  })

  it("parse() 자동 라우팅에도 password가 전달된다", async (t) => {
    if (!has("HWP3-password-123456.hwp")) return t.skip("픽스처 없음")
    const r = await parse(readFileSync(fixture("HWP3-password-123456.hwp")), { password: "123456" })
    assert.equal(r.success, true)
    assert.ok(r.markdown.length > 100)
  })
})
