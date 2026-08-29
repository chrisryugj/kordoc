/**
 * 한컴 PUA → 표준 유니코드 매핑 회귀 테스트.
 *
 * 매핑 없는 Supplementary PUA는 sanitizeText가 삭제하므로, 매핑 누락은 곧 글자 증발이다
 * (결재란 "(인)"이 통째로 사라지는 식). 한컴 PDF 대조로 확정된 것만 고정한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapPuaText } from "../src/shared/pua.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

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

describe("mapPuaText — rhwp 검증표 동기화분", () => {
  it("텍스트 다이어그램 괘선 조각 6종", () => {
    assert.equal(mapPuaText("\u{F0806}\u{F0807}\u{F0808}\u{F080C}\u{F080E}\u{F0810}"), "┌┬┐└┘│")
  })

  it("별도 글리프 원숫자 — ③(F028B)는 근거 문서가 리터럴을 써 표에 없다", () => {
    assert.equal(mapPuaText("\u{F0288}\u{F0289}\u{F028A}"), "⓪①②")
    assert.equal(mapPuaText("\u{F028C}\u{F0291}"), "④⑨")
    assert.equal(mapPuaText("\u{F028B}"), "\u{F028B}")
  })

  it("괘선·글머리 잔여 항목", () => {
    assert.equal(mapPuaText("\u{F081C}"), "┈")
    assert.equal(mapPuaText("\u{F0832}"), "═")
    assert.equal(mapPuaText("\u{F0848}"), "━")
    assert.equal(mapPuaText("\u{F02EC}"), "◇")
    assert.equal(mapPuaText("\u{F03A7}\u{F03A8}"), "⊟⊞")
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

describe("blocksToMarkdown — 서식 run(span) 도 PUA 계약을 탄다", () => {
  it("span 텍스트의 PUA를 표시값으로 바꾸고 미매핑 잔여는 지운다", () => {
    // 종전엔 spans 경로만 sanitize 를 건너뛰어, 굵게/밑줄이 걸린 글머리표·괘선
    // 조각이 원시 PUA 그대로 마크다운에 실렸다 (hwp3-sample10 변환본 116자).
    const blocks: IRBlock[] = [
      {
        type: "paragraph",
        text: "\u{F0810}가로 \u{F03E0}줄",
        spans: [
          { text: "\u{F0810}가로 ", bold: true },
          { text: "\u{F03E0}줄" },
        ],
      },
    ]
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("│가로"), `괘선 조각이 표시값으로: ${JSON.stringify(md)}`)
    assert.ok(!/[\u{F0000}-\u{FFFFD}]/u.test(md), `미매핑 PUA 잔여 없음: ${JSON.stringify(md)}`)
  })

  it("서식 마커와 공백 접합은 종전대로", () => {
    const blocks: IRBlock[] = [
      { type: "paragraph", text: "굵게 보통", spans: [{ text: "굵게", bold: true }, { text: " 보통" }] },
    ]
    assert.ok(blocksToMarkdown(blocks).includes("**굵게** 보통"))
  })
})
