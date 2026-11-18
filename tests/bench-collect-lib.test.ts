/**
 * 코퍼스 수집기 공용 검사(bench/collect-lib.mjs) — 이슈 #218(오류 HTML 을 문서로 저장)·#222(이미 풀린 한글 이름을 다시 읽어 깨짐).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isDocBytes, dispositionName } from "../bench/collect-lib.mjs"

const pad = (head: Buffer | string) => Buffer.concat([Buffer.from(head as string), Buffer.alloc(1200, 0x20)])

describe("isDocBytes: 확장자에 맞는 파일 머리", () => {
  it("오류·안내 HTML 은 DOCTYPE 대소문자와 관계없이 문서가 아니다", () => {
    for (const html of ["<!doctype html><html><head><title>err", "<!DOCTYPE html>", "<html><body>로그인", "\n\n<script>location.href='/'</script>"]) {
      assert.equal(isDocBytes(pad(html), "doc.pdf"), false, html)
      assert.equal(isDocBytes(pad(html), "doc.hwp"), false, html)
      assert.equal(isDocBytes(pad(html), "doc.hwpx"), false, html)
    }
  })

  it("PDF·HWP 5.x·HWP 3.x·HWPX(zip)·HML", () => {
    assert.equal(isDocBytes(pad("%PDF-1.7\n"), "a.pdf"), true)
    assert.equal(isDocBytes(pad(Buffer.from("d0cf11e0a1b11ae1", "hex")), "a.hwp"), true)
    assert.equal(isDocBytes(pad("HWP Document File V3.00 \x1a"), "a.hwp"), true)
    assert.equal(isDocBytes(pad(Buffer.from("504b0304", "hex")), "a.HWPX"), true)
    assert.equal(isDocBytes(pad('<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8">'), "a.hml"), true)
    assert.equal(isDocBytes(pad("%PDF-1.7\n"), "a.hwpx"), false, "확장자와 머리가 다르면 거른다")
  })
})

describe("dispositionName: Content-Disposition 파일 이름", () => {
  it("% 인코딩된 UTF-8 이름은 한 번만 푼다", () => {
    assert.equal(dispositionName('attachment; filename="%EB%B3%B4%EA%B3%A0%EC%84%9C.pdf"', "x.bin"), "보고서.pdf")
  })

  it("헤더에 날 UTF-8 바이트로 온 이름(latin1 글자)은 UTF-8 로 다시 읽는다", () => {
    const raw = Buffer.from("보고서.pdf", "utf8").toString("latin1")
    assert.equal(dispositionName(`attachment; filename="${raw}"`, "x.bin"), "보고서.pdf")
  })

  it("UTF-8 로 읽히지 않는 latin1 이름·이름 없는 헤더", () => {
    assert.equal(dispositionName('attachment; filename="caf%C3%A9.pdf"', "x.bin"), "café.pdf")
    assert.equal(dispositionName("attachment", "123.bin"), "123.bin")
  })
})
