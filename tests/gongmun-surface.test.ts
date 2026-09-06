/**
 * 공문서 옵션 표면 SSOT (v4.0.4, 인벤토리 영역1-1) — CLI/MCP 공유 조립(buildGongmunOptions)
 * 의미론과 값 집합 상수의 드리프트 잠금.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  buildGongmunOptions, SIZE_KEYS, DOC_FOOT_KEYS, BODY_FONTS, H2_MARKERS, BULLET2_CHARS,
} from "../src/hwpx/gongmun-surface.js"
import { PRESET_ALIAS } from "../src/hwpx/gongmun.js"

describe("buildGongmunOptions — CLI/MCP 공유 조립", () => {
  it("cover 우선순위: false(끄기) > org/date(객체) > true(강제)", () => {
    assert.equal(buildGongmunOptions({ preset: "gaejosik", cover: false, org: "행안부" }).cover, false)
    assert.deepEqual(buildGongmunOptions({ preset: "gaejosik", cover: true, org: "행안부", date: "2026. 7. 1." }).cover,
      { org: "행안부", date: "2026. 7. 1." })
    assert.equal(buildGongmunOptions({ preset: "gaejosik", cover: true }).cover, true)
    // 미지정이면 프리셋 기본에 맡김 (undefined 미대입)
    assert.ok(!("cover" in buildGongmunOptions({ preset: "gaejosik" })))
  })

  it("명시된 것만 대입 — 프리셋 기본값을 undefined로 덮지 않는다", () => {
    const g = buildGongmunOptions({ preset: "official" })
    assert.deepEqual(Object.keys(g), ["preset"])
    const g2 = buildGongmunOptions({ preset: "official", toc: false, endMark: false, suppressSingle: true })
    assert.equal(g2.toc, false)
    assert.equal(g2.endMark, false)
    assert.equal(g2.suppressSingle, true)
  })

  it("빈 approval 배열은 미대입 (프리셋 기본 유지)", () => {
    assert.ok(!("approval" in buildGongmunOptions({ preset: "official", approval: [] })))
    assert.deepEqual(buildGongmunOptions({ preset: "official", approval: ["담당", "과장"] }).approval, ["담당", "과장"])
  })

  it("bodyTitleBox=false 전달 (표지 조합 끄기)", () => {
    assert.equal(buildGongmunOptions({ preset: "gaejosik", bodyTitleBox: false }).bodyTitleBox, false)
  })
})

describe("값 집합 상수 — 드리프트 잠금", () => {
  it("SIZE_KEYS가 개조식 크기 오버라이드 전 키를 담는다 (bodyTitle 누락 재발 방지)", () => {
    assert.ok(SIZE_KEYS.includes("bodyTitle"))
    assert.equal(SIZE_KEYS.length, 10)
  })
  it("DOC_FOOT_KEYS 15종·enum 상수 무결", () => {
    assert.equal(DOC_FOOT_KEYS.length, 15)
    assert.deepEqual([...BODY_FONTS], ["myeongjo", "gothic"])
    assert.deepEqual([...H2_MARKERS], ["band", "roman", "box", "number", "none"])
    assert.deepEqual([...BULLET2_CHARS], ["ㅇ", "○"])
  })
  it("PRESET_ALIAS 전 별칭이 내부 7프리셋으로 해석된다 (MCP preset enum 파생원)", () => {
    const presets = new Set(Object.values(PRESET_ALIAS))
    assert.equal(presets.size, 7)
    // MCP zod에 빠져 있던 별칭(v4.0.4에서 PRESET_ALIAS 파생으로 회복)
    for (const alias of ["시행문", "공문", "공문서", "계획", "알림", "안내"]) {
      assert.ok(PRESET_ALIAS[alias], `별칭 누락: ${alias}`)
    }
  })
})
