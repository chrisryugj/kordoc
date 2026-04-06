/**
 * 배포용 HWP 복호화 테스트 — AES-128 ECB + MSVC LCG + ViewText 파이프라인
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { aes128EcbDecrypt } from "../src/hwp5/aes.js"
import { decryptViewText, _MsvcLcg, _decryptDistributePayload, _extractAesKey } from "../src/hwp5/crypto.js"

// ── AES-128 ECB 테스트 ──

describe("aes128EcbDecrypt", () => {
  it("NIST 테스트 벡터 — AES-128 ECB", () => {
    // NIST FIPS-197 Appendix B: AES-128 테스트 벡터
    // Key: 2b7e151628aed2a6abf7158809cf4f3c
    // Plaintext: 3243f6a8885a308d313198a2e0370734
    // Ciphertext: 3925841d02dc09fbdc118597196a0b32
    const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex")
    const ciphertext = Buffer.from("3925841d02dc09fbdc118597196a0b32", "hex")
    const expected = Buffer.from("3243f6a8885a308d313198a2e0370734", "hex")

    const result = aes128EcbDecrypt(new Uint8Array(ciphertext), new Uint8Array(key))
    assert.deepEqual(Buffer.from(result), expected)
  })

  it("두 블록 연속 복호화", () => {
    const key = Buffer.from("2b7e151628aed2a6abf7158809cf4f3c", "hex")
    const cipher1 = Buffer.from("3925841d02dc09fbdc118597196a0b32", "hex")
    const expected1 = Buffer.from("3243f6a8885a308d313198a2e0370734", "hex")

    // 동일 블록 2회 반복
    const twoBlocks = Buffer.concat([cipher1, cipher1])
    const result = aes128EcbDecrypt(new Uint8Array(twoBlocks), new Uint8Array(key))
    assert.deepEqual(Buffer.from(result).subarray(0, 16), expected1)
    assert.deepEqual(Buffer.from(result).subarray(16, 32), expected1)
  })

  it("키 길이 16 아니면 에러", () => {
    assert.throws(
      () => aes128EcbDecrypt(new Uint8Array(16), new Uint8Array(15)),
      /16바이트/,
    )
  })

  it("입력이 16의 배수 아니면 에러", () => {
    assert.throws(
      () => aes128EcbDecrypt(new Uint8Array(17), new Uint8Array(16)),
      /16바이트의 배수/,
    )
  })

  it("빈 입력 → 빈 출력", () => {
    const key = new Uint8Array(16)
    const result = aes128EcbDecrypt(new Uint8Array(0), key)
    assert.equal(result.length, 0)
  })
})

// ── MSVC LCG 테스트 ──

describe("MsvcLcg", () => {
  it("시퀀스 재현 가능", () => {
    const lcg1 = new _MsvcLcg(12345)
    const lcg2 = new _MsvcLcg(12345)
    for (let i = 0; i < 100; i++) {
      assert.equal(lcg1.rand(), lcg2.rand())
    }
  })

  it("범위: 0 ~ 0x7FFF", () => {
    const lcg = new _MsvcLcg(42)
    for (let i = 0; i < 1000; i++) {
      const v = lcg.rand()
      assert.ok(v >= 0 && v <= 0x7fff, `값이 범위 밖: ${v}`)
    }
  })

  it("seed 0에서도 동작", () => {
    const lcg = new _MsvcLcg(0)
    const v = lcg.rand()
    assert.ok(v >= 0 && v <= 0x7fff)
  })

  it("MSVC CRT rand() 호환 검증 — 알려진 시퀀스", () => {
    // seed=1일 때 MSVC CRT rand() 첫 5개 값
    // 참고: https://learn.microsoft.com/en-us/cpp/c-runtime-library/reference/rand
    const lcg = new _MsvcLcg(1)
    // seed=1 → seed = 1*214013+2531011 = 2745024 → (2745024>>16)&0x7FFF = 41
    assert.equal(lcg.rand(), 41)
  })
})

// ── 배포용 payload 복호화 테스트 ──

describe("decryptDistributePayload", () => {
  it("256바이트 미만이면 에러", () => {
    assert.throws(
      () => _decryptDistributePayload(new Uint8Array(100)),
      /256바이트/,
    )
  })

  it("256바이트 payload 처리 — 결과도 256바이트", () => {
    // 합성 payload: seed=0x12345678 + 252바이트 데이터
    const payload = new Uint8Array(256)
    payload[0] = 0x78; payload[1] = 0x56; payload[2] = 0x34; payload[3] = 0x12
    for (let i = 4; i < 256; i++) payload[i] = i & 0xff

    const result = _decryptDistributePayload(payload)
    assert.equal(result.length, 256)
    // seed 부분(0-3)은 그대로 보존
    assert.equal(result[0], 0x78)
    assert.equal(result[1], 0x56)
    assert.equal(result[2], 0x34)
    assert.equal(result[3], 0x12)
  })
})

// ── AES 키 추출 테스트 ──

describe("extractAesKey", () => {
  it("offset 계산: 4 + (byte[0] & 0x0F)", () => {
    const payload = new Uint8Array(256)
    payload[0] = 0x03  // offset = 4 + 3 = 7
    // bytes[7..23]에 키 값 설정
    for (let i = 7; i < 23; i++) payload[i] = i

    const key = _extractAesKey(payload)
    assert.equal(key.length, 16)
    assert.equal(key[0], 7)
    assert.equal(key[15], 22)
  })

  it("byte[0] 상위 비트 무시 (마스크 0x0F)", () => {
    const payload = new Uint8Array(256)
    payload[0] = 0xF5  // 0xF5 & 0x0F = 5, offset = 4 + 5 = 9

    const key = _extractAesKey(payload)
    assert.equal(key.length, 16)
  })
})

// ── ViewText 통합 복호화 테스트 ──

describe("decryptViewText", () => {
  it("잘못된 첫 레코드 태그면 에러", () => {
    // DISTRIBUTE_DOC_DATA 태그가 아닌 레코드 헤더 구성
    // tagId = 0x0042 (PARA_HEADER), level=0, size=256
    const header = (0x0042 & 0x3ff) | (0 << 10) | (256 << 20)
    const buf = Buffer.alloc(4 + 256)
    buf.writeUInt32LE(header, 0)

    assert.throws(
      () => decryptViewText(buf, false),
      /DISTRIBUTE_DOC_DATA/,
    )
  })

  it("payload 크기 부족이면 에러", () => {
    // TAG_DISTRIBUTE_DOC_DATA = 28 (HWPTAG_BEGIN + 12), size = 100 (< 256)
    const tagId = 28
    const header = (tagId & 0x3ff) | (0 << 10) | (100 << 20)
    const buf = Buffer.alloc(4 + 100)
    buf.writeUInt32LE(header, 0)

    assert.throws(
      () => decryptViewText(buf, false),
      /유효하지 않/,
    )
  })
})
