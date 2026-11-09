/** 프리셋 정규화는 별칭 표의 자기 키만 본다 — 프로토타입 이름("toString"·"constructor")이 함수로 새어 나가 생성·검수가 죽지 않게 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { lintBlocks, markdownToHwpx, normalizeGongmunPreset } from "../src/index.js"

const PROTO = ["toString", "constructor", "hasOwnProperty", "__proto__", "valueOf"]

describe("normalizeGongmunPreset — 자기 키만", () => {
  it("프로토타입 이름은 기본(official)으로", () => {
    for (const p of PROTO) assert.equal(normalizeGongmunPreset(p), "official", p)
  })

  it("별칭·영문 키·앞뒤 공백은 그대로 맞춘다", () => {
    assert.equal(normalizeGongmunPreset("보고서"), "report")
    assert.equal(normalizeGongmunPreset(" press "), "press")
    assert.equal(normalizeGongmunPreset(undefined), "official")
    assert.equal(normalizeGongmunPreset(""), "official")
  })

  it("문자열이 아닌 값이 들어와도 죽지 않는다 (타입 밖 JS 호출)", () => {
    assert.equal(normalizeGongmunPreset(123 as unknown as string), "official")
  })

  it("HWPX 생성·검수가 프로토타입 이름 프리셋에서 죽지 않는다", async () => {
    for (const p of PROTO) {
      const buf = await markdownToHwpx("# 제목\n\n본문", { gongmun: { preset: p as never } })
      assert.ok(buf.byteLength > 0, p)
      assert.doesNotThrow(() => lintBlocks([{ id: "p1", text: "금번 회의를 개최함" }], { preset: p as never }), p)
    }
  })
})
