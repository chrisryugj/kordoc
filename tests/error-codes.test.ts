/** 에러 코드 체계 테스트 — classifyError + 통합 에러코드 검증 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { classifyError, KordocError } from "../src/utils.js"
import { parse } from "../src/index.js"

describe("classifyError", () => {
  it("암호화 → ENCRYPTED", () => {
    assert.equal(classifyError(new KordocError("암호화된 HWP는 지원하지 않습니다")), "ENCRYPTED")
  })

  it("DRM → DRM_PROTECTED", () => {
    assert.equal(classifyError(new KordocError("DRM 보호된 HWP는 지원하지 않습니다")), "DRM_PROTECTED")
  })

  it("ZIP bomb (비압축 크기) → ZIP_BOMB", () => {
    assert.equal(classifyError(new KordocError("ZIP 비압축 크기 초과 (ZIP bomb 의심)")), "ZIP_BOMB")
  })

  it("ZIP bomb (엔트리 수) → ZIP_BOMB", () => {
    assert.equal(classifyError(new KordocError("ZIP 엔트리 수 초과 (ZIP bomb 의심)")), "ZIP_BOMB")
  })

  it("압축 해제 크기 초과 → DECOMPRESSION_BOMB", () => {
    assert.equal(classifyError(new KordocError("총 압축 해제 크기 초과 (decompression bomb 의심)")), "DECOMPRESSION_BOMB")
  })

  it("이미지 기반 PDF → IMAGE_BASED_PDF", () => {
    assert.equal(classifyError(new KordocError("이미지 기반 PDF")), "IMAGE_BASED_PDF")
  })

  it("섹션 없음 → NO_SECTIONS", () => {
    assert.equal(classifyError(new KordocError("섹션 스트림을 찾을 수 없습니다")), "NO_SECTIONS")
  })

  it("시그니처 불일치 → CORRUPTED", () => {
    assert.equal(classifyError(new KordocError("HWP 시그니처 불일치")), "CORRUPTED")
  })

  it("복구 불가 → CORRUPTED", () => {
    assert.equal(classifyError(new KordocError("손상된 HWPX에서 섹션 데이터를 복구할 수 없습니다")), "CORRUPTED")
  })

  it("일반 에러 → PARSE_ERROR", () => {
    assert.equal(classifyError(new Error("알 수 없는 에러")), "PARSE_ERROR")
  })

  it("non-Error → PARSE_ERROR", () => {
    assert.equal(classifyError("문자열 에러"), "PARSE_ERROR")
  })

  it("입력 파일 없음(ENOENT) → FILE_NOT_FOUND — 문서 파싱 실패로 덮지 않는다", () => {
    // 파일시스템 오류는 code 로, 래핑된 오류는 메시지로 온다 — 둘 다 같은 코드
    const byCode = Object.assign(new Error("ENOENT: no such file or directory, stat 'x.hwpx'"), { code: "ENOENT" })
    const byMessage = new Error("ENOENT: no such file, open 'x.hwpx'")
    for (const err of [byCode, byMessage]) {
      assert.equal(classifyError(err), "FILE_NOT_FOUND")
    }
    // EACCES 같은 다른 fs 오류는 경로 문제지만 ENOENT 와 구분해 기존 분류를 유지한다
    assert.equal(classifyError(Object.assign(new Error("EACCES"), { code: "EACCES" })), "PARSE_ERROR")
  })
})

describe("통합 에러코드", () => {
  it("빈 버퍼 → code: EMPTY_INPUT", async () => {
    const result = await parse(new ArrayBuffer(0))
    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(result.code, "EMPTY_INPUT")
    }
  })

  it("랜덤 바이트 → code: UNSUPPORTED_FORMAT", async () => {
    const buf = new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08])
    const result = await parse(buf.buffer)
    assert.equal(result.success, false)
    if (!result.success) {
      assert.equal(result.code, "UNSUPPORTED_FORMAT")
    }
  })
})
