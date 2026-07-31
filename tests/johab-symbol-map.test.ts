/**
 * HWP3 johab 사적 graphic char 매핑 회귀 테스트.
 *
 * 미매핑 코드는 JOHAB_UNMAPPED 로 빠지고 파서가 조용히 건너뛰므로, 글머리표·머리말
 * 글자가 경고 없이 사라진다. rhwp 대조로 확정된 매핑을 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { decodeJohab, decodeJohabText, JOHAB_UNMAPPED } from "../src/hwp3/johab.js"

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

describe("hwp3/johab — 아래아(옛한글) 음절", () => {
  // HWP3은 'ᄒᆞᆫ글 97'의 첫 음절을 hchar 하나로 저장하는데 완성형에는 대응 음절이 없다.
  // decodeJohab이 UNMAPPED를 반환하면 파서가 조용히 건너뛰어 글자가 사라졌다.
  // 한컴의 HWP5/HWPX 변환본도 자모열로 보존하므로 같은 표현을 쓴다.
  it("아래아 음절을 초성+ㆍ+종성 자모열로 푼다", () => {
    assert.equal(decodeJohabText(0xd3c5), "ᄒᆞᆫ") // ᄒ + ᆞ + ᆫ
  })

  it("종성 없는 아래아 음절은 자모 2개", () => {
    const decoded = decodeJohabText(0xd3c1)
    assert.ok(decoded && decoded.startsWith("ᄒᆞ"), `받침 없는 아래아: ${JSON.stringify(decoded)}`)
  })

  it("아래아가 아닌 음절은 종전대로 완성형 한 글자", () => {
    assert.equal(decodeJohabText(0x8861), "가")
    assert.equal(decodeJohabText("A".charCodeAt(0)), "A")
  })

  it("매핑 없는 코드는 null (호출자가 건너뛴다)", () => {
    assert.equal(decodeJohabText(0x0100), null)
  })
})
