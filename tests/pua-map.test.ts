/**
 * 한컴 PUA → 표준 유니코드 매핑 회귀 테스트.
 *
 * 매핑 없는 Supplementary PUA는 sanitizeText가 삭제하므로, 매핑 누락은 곧 글자 증발이다
 * (결재란 "(인)"이 통째로 사라지는 식). 한컴 PDF 대조로 확정된 것만 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapPuaText } from "../src/shared/pua.js"

describe("mapPuaText — 한컴 검증 PUA (rhwp 44cabad9)", () => {
  it("결재·서명란 기호를 '(인)'으로", () => {
    assert.equal(mapPuaText("\u{F012B}"), "(인)")
  })

  it("행정업무운영 편람 글머리표", () => {
    assert.equal(mapPuaText("\u{F02FC}"), "►")
    assert.equal(mapPuaText("\u{F031C}"), "■")
  })

  it("Enter 키 픽토그램을 줄바꿈 화살표로", () => {
    assert.equal(mapPuaText("\u{F03A0}"), "↵")
  })

  it("머리말 회사명 6자", () => {
    assert.equal(mapPuaText("\u{F03EF}\u{F03F0}\u{F03F1}\u{F03F2}\u{F03F3}\u{F03F4}"), "한글과컴퓨터")
  })
})

describe("mapPuaText — 사각 안 숫자 (rhwp b74b5098 / #3385)", () => {
  it("U+F02B1~F02C4를 ①~⑳으로", () => {
    assert.equal(mapPuaText("\u{F02B1}"), "①")
    assert.equal(mapPuaText("\u{F02B2}"), "②")
    assert.equal(mapPuaText("\u{F02C4}"), "⑳")
  })

  it("대역 밖은 건드리지 않는다", () => {
    assert.equal(mapPuaText("\u{F02B0}"), "\u{F02B0}")
    assert.equal(mapPuaText("\u{F02C5}"), "\u{F02C5}")
  })
})

describe("mapPuaText — 기존 동작 유지", () => {
  it("종전 매핑 회귀 없음", () => {
    assert.equal(mapPuaText("\u{F03C5}"), "□")
    assert.equal(mapPuaText("\u{F0827}"), "■")
    assert.equal(mapPuaText("\u{F00DA}"), "▸")
  })

  it("근거 없는 미등록 PUA는 추정하지 않는다 (호출부 제거 로직에 위임)", () => {
    assert.equal(mapPuaText("\u{F03E0}"), "\u{F03E0}")
  })

  it("일반 텍스트는 그대로 통과", () => {
    assert.equal(mapPuaText("일반 텍스트 123"), "일반 텍스트 123")
  })
})
