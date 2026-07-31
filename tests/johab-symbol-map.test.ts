/**
 * HWP3 johab 사적 graphic char 매핑 회귀 테스트.
 *
 * 미매핑 코드는 JOHAB_UNMAPPED 로 빠지고 파서가 조용히 건너뛰므로, 글머리표·머리말
 * 글자가 경고 없이 사라진다. rhwp 대조로 확정된 매핑을 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decodeJohab, JOHAB_UNMAPPED } from "../src/hwp3/johab.js"

const decoded = (ch: number) => {
  const cp = decodeJohab(ch)
  return cp === JOHAB_UNMAPPED ? null : String.fromCodePoint(cp)
}

describe("hwp3/johab — 사적 graphic char", () => {
  it("표 셀 삼각 글머리표 0x2F67 → ▸ (rhwp 16db8260)", () => {
    assert.equal(decoded(0x2f67), "▸")
  })

  it("머리말 회사명 0x37C0~0x37C5 → '한글과컴퓨터' (rhwp 44cabad9)", () => {
    let s = ""
    for (let ch = 0x37c0; ch <= 0x37c5; ch++) s += decoded(ch) ?? "?"
    assert.equal(s, "한글과컴퓨터")
  })

  it("기존 매핑 회귀 없음", () => {
    assert.equal(decoded(0x3479), "▷")
    assert.equal(decoded(0x347a), "▶")
    assert.equal(decoded(0x3366), "□")
    assert.equal(decoded(0x36e7), "①")
    assert.equal(decoded(0x3590), "Ⅰ")
  })

  it("근거 없는 인접 코드는 매핑하지 않는다", () => {
    assert.equal(decoded(0x37bf), null)
    assert.equal(decoded(0x37c6), null)
  })
})
