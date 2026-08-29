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

  it("회사명 인접 코드는 완성형 좌표 규칙(가타카나 행)으로 떨어진다", () => {
    // 0x37C0~0x37C5 하드코딩은 규칙보다 먼저 보므로 회사명이 유지되고, 그 밖의 인접
    // 코드는 KS X 1001 좌표 규칙이 담당한다 (rhwp decode_hwp3_extra 와 같은 순서).
    assert.equal(decoded(0x37c6), "ウ")
    assert.equal(decoded(0x37c7), "ェ")
    // 0x37BF 는 규칙상 셀 좌표가 0xFF 라 완성형에 없는 자리 — 미매핑 유지
    assert.equal(decoded(0x37bf), null)
  })

  it("규칙 정의역 밖의 사적 코드는 여전히 미매핑", () => {
    // rhwp #5860 이 "실측 근거 없는 값은 매핑하지 않는다"로 고정한 코드들.
    for (const ch of [0x0085, 0x2059, 0x2f09]) assert.equal(decoded(ch), null)
    // 한자 규칙(0xFD 행)의 끝을 넘는 코드
    assert.equal(decoded(0x5318), null)
  })
})

describe("hwp3/johab — KS X 1001 완성형 좌표 규칙 (rhwp 포팅)", () => {
  it("기호행(행 간격 96)으로 기호를 푼다", () => {
    // 하드코딩으로 확정돼 있던 매핑이 이 식에서 그대로 유도된다
    assert.equal(decoded(0x3441), "■")
    assert.equal(decoded(0x3446), "→")
    assert.equal(decoded(0x35e1), "─")
    // 종전엔 표에 없어 사라지던 기호들 (hwp3-sample11/16 ↔ 한컴 변환본 실측)
    assert.equal(decoded(0x3438), "※")
    assert.equal(decoded(0x343b), "○")
    assert.equal(decoded(0x341c), "【")
    assert.equal(decoded(0x341d), "】")
    assert.equal(decoded(0x3425), "∴")
    assert.equal(decoded(0x3491), "☞")
    assert.equal(decoded(0x34fc), "￦")
    assert.equal(decoded(0x35ec), "━")
    assert.equal(decoded(0x36f5), "⑮")
  })

  it("한자행(행 간격 94)으로 한자를 푼다", () => {
    // 종전엔 `채권(債權)조서` → `채권()조서` 처럼 괄호 안이 통째로 비었다
    assert.equal(decoded(0x4f5d), "債")
    assert.equal(decoded(0x4222), "權")
    assert.equal(decoded(0x4388), "代")
    assert.equal(decoded(0x4507), "理")
    assert.equal(decoded(0x4cac), "人")
  })

  it("한컴 표기 보정 — 표준 매핑과 갈리는 두 자리", () => {
    assert.equal(decoded(0x340d), "～") // 표준 ∼(U+223C) → 한컴 전각 ～
    assert.equal(decoded(0x3481), "◉") // 표준 ⊙(U+2299) → 한컴 ◉
  })
})

describe("hwp3/johab — 사적 코드 실측 표 (rhwp #5555/#5860 + kordoc 실측)", () => {
  it("라틴 확장은 유니코드 값 그대로 — 종전엔 \"für\"→\"fr\" 로 글자가 삭제됐다", () => {
    assert.equal(decoded(0x00fc), "ü")
    assert.equal(decoded(0x00e4), "ä")
    assert.equal(decoded(0x00df), "ß")
    assert.equal(decoded(0x00e9), "é")
    // 사적 따옴표는 구간 밖 — 종전 매핑 유지
    assert.equal(decoded(0x0081), "\u201C")
    assert.equal(decoded(0x0082), "\u201D")
  })

  it("따옴표·글머리표·구두점", () => {
    assert.equal(decoded(0x0083), "\u2018")
    assert.equal(decoded(0x0084), "\u2019")
    assert.equal(decoded(0x2f11), "◦")
    assert.equal(decoded(0x2f14), "◦")
    assert.equal(decoded(0x2f08), "▪")
    assert.equal(decoded(0x205a), "○")
    assert.equal(decoded(0x2058), "△")
    assert.equal(decoded(0x2024), "・")
    assert.equal(decoded(0x203b), "※")
    assert.equal(decoded(0x2219), "∙")
    assert.equal(decoded(0x2022), "•")
    assert.equal(decoded(0x2f17), "•")
  })

  it("원문자·괄호문자 계열", () => {
    assert.equal(decoded(0x2e01), "①")
    assert.equal(decoded(0x2e07), "⑦")
    assert.equal(decoded(0x2e00), "⓪")
    assert.equal(decoded(0x2e0a), "①")
    assert.equal(decoded(0x2e12), "⑨")
    assert.equal(decoded(0x2c21), "ⓐ")
    assert.equal(decoded(0x2c26), "ⓕ")
    assert.equal(decoded(0x2c40), "㉠")
    assert.equal(decoded(0x2c42), "㉢")
  })

  it("괘선 조각 — 기호 규칙 정의역 밖의 사적 코드", () => {
    assert.equal(decoded(0x3013), "┌")
    assert.equal(decoded(0x3014), "┬")
    assert.equal(decoded(0x3015), "┐")
    assert.equal(decoded(0x3019), "└")
    assert.equal(decoded(0x301b), "┘")
    assert.equal(decoded(0x301d), "│")
    assert.equal(decoded(0x301c), "━")
    assert.equal(decoded(0x3048), "═")
    assert.equal(decoded(0x37ed), "═") // 규칙으로는 가타카나 ネ 가 되는 자리
  })

  it("도장 기호는 한컴 PUA 로 — shared/pua 검증표가 (인) 으로 편다", () => {
    assert.equal(decoded(0x2bce), "\u{F012B}")
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

  it("초성이 '채움'이면 아래아 자모만 남긴다", () => {
    // hwp3-sample16 의 0x87C1 — 한컴 변환본도 U+119E 한 글자로 보존한다.
    // 종전엔 초성 무효로 보고 통째로 버려 글자가 사라졌다.
    assert.equal(decodeJohabText(0x87c1), "\u119E")
  })

  it("매핑 없는 코드는 null (호출자가 건너뛴다)", () => {
    assert.equal(decodeJohabText(0x0100), null)
  })
})
