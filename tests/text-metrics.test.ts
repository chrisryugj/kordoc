/**
 * 텍스트 폭·줄바꿈 시뮬레이션 — 함초롬바탕 실측 테이블 + 한컴 조판 규칙
 * (규칙 출처: bench/verify-linebreak.mjs — 실제 결재문서 linesegarray 98% 일치 검증)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  charWidthEm1000,
  measureTextWidth,
  simulateWrap,
  fitRatioForFewerLines,
  faceClassOf,
  SPACE_EM_FIXED,
} from "../src/hwpx/text-metrics.js"
import { markerWidth, levelIndent } from "../src/hwpx/gongmun.js"

describe("charWidthEm1000 — 함초롬바탕 실측 advance", () => {
  it("한글 음절 = 970 (전수 균일)", () => {
    for (const ch of "가힣검불준") assert.equal(charWidthEm1000(ch.codePointAt(0)!), 970)
  })
  it("숫자 550 / 온점·괄호 320 / 한자 1000 / 원문자 970", () => {
    assert.equal(charWidthEm1000("0".codePointAt(0)!), 550)
    assert.equal(charWidthEm1000(".".codePointAt(0)!), 320)
    assert.equal(charWidthEm1000("(".codePointAt(0)!), 320)
    assert.equal(charWidthEm1000("漢".codePointAt(0)!), 1000)
    assert.equal(charWidthEm1000("①".codePointAt(0)!), 970)
    assert.equal(charWidthEm1000("□".codePointAt(0)!), 970)
  })
})

describe("measureTextWidth", () => {
  it("한글 3자, 15pt, 장평 100 = 3×0.97×1500", () => {
    assert.equal(measureTextWidth("가나다", 1500, 100), 3 * 0.97 * 1500)
  })
  it("공백은 기본 0.5em 고정(useFontSpace=0 모델), 장평 적용", () => {
    assert.equal(measureTextWidth(" ", 1000, 100), 500)
    assert.equal(measureTextWidth(" ", 1000, 90), 450)
  })
})

describe("simulateWrap — 어절(keep)·글자(charAll) 모델", () => {
  it("keep: 어절이 통째로 다음 줄로 (h=1000, W=3000)", () => {
    // 가가가=2910, +공백500+나나나2910 → 2줄, 둘째 줄 = 나나나
    const r = simulateWrap("가가가 나나나", 3000, 3000, 1000, 100, "keep")
    assert.equal(r.lines, 2)
    assert.deepEqual(r.starts, [0, 4])
    assert.equal(r.lastLineWidth, 2910)
  })
  it("charAll: 글자 단위로 채움", () => {
    // W=2500: 가나(1940)+다(970)→2910>2500 → '다'부터 다음 줄
    const r = simulateWrap("가나다라", 2500, 2500, 1000, 100, "charAll")
    assert.deepEqual(r.starts, [0, 2])
  })
  it("금칙(끝): 줄 끝의 여는 괄호는 다음 줄로 내린다", () => {
    // W=2500: '가나(' 까지 2260 들어가지만 '다'가 넘치는 순간 '('도 함께 내림
    const r = simulateWrap("가나(다라", 2500, 2500, 1000, 100, "charAll")
    assert.deepEqual(r.starts, [0, 2])
  })
  it("금칙(시작): 줄머리 금지 문자는 직전 글자 1개를 동반해 내린다", () => {
    // W=2910(한글 3자): '가나다'는 차지만 ','가 줄머리에 못 오므로 '다'와 함께 내림
    const r = simulateWrap("가나다,라", 2910, 2910, 1000, 100, "charAll")
    assert.deepEqual(r.starts, [0, 2])
  })
  it("초장 어절은 keep에서도 글자 분해 (한컴 동일)", () => {
    const r = simulateWrap("가가가가가가", 2910, 2910, 1000, 100, "keep")
    assert.equal(r.lines, 2)
    assert.deepEqual(r.starts, [0, 3])
  })
})

describe("fitRatioForFewerLines — 자동 장평(orphan 축소)", () => {
  it("장평 1% 축소로 한 줄이 줄면 가장 큰 장평을 반환", () => {
    // 100%: 6320 > 6300 → 2줄. 99%: 6256.8 ≤ 6300 → 1줄
    const r = fitRatioForFewerLines("가가가 나나나", 6300, 6300, 1000, 100, 90)
    assert.equal(r, 99)
  })
  it("minRatio까지 줄여도 안 되면 null", () => {
    const r = fitRatioForFewerLines("가가가 나나나", 4000, 4000, 1000, 100, 90)
    assert.equal(r, null)
  })
  it("이미 한 줄이면 null", () => {
    assert.equal(fitRatioForFewerLines("가나다", 10000, 10000, 1000, 100, 90), null)
  })
})

describe("faceClass — 고정폭 글꼴 폭 테이블 (v4.0.6 회귀)", () => {
  it("실측 폭표 글꼴은 font:이름, 나머지 '체' 고정폭은 fixedPitch, 그 외·미지정은 hcr", () => {
    for (const f of ["굴림체", "굴림", "HY견고딕", "맑은 고딕", "한컴돋움", "휴먼명조"]) assert.equal(faceClassOf(f), `font:${f}`)
    for (const f of ["돋움체", "바탕체", "궁서체"]) assert.equal(faceClassOf(f), "fixedPitch")
    for (const f of ["함초롬바탕", "나눔고딕", "", undefined, null]) assert.equal(faceClassOf(f), "hcr")
  })
  it("fixedPitch: 한글 1.0em·ASCII 0.5em (함초롬 0.97em·비례폭과 구분)", () => {
    assert.equal(measureTextWidth("가나다라", 1000, 100, { faceClass: "fixedPitch" }), 4000)
    assert.equal(measureTextWidth("가나다라", 1000, 100), 3880)
    assert.equal(measureTextWidth("W", 1000, 100, { faceClass: "fixedPitch" }), 500)
  })
  it("simulateWrap: 함초롬 폭으론 들어가는 줄이 고정폭에선 wrap (줄당 과대적재 회귀)", () => {
    // 한글 10자, 폭 9800: hcr 9700 ≤ 9800 → 1줄 / fixedPitch 10000 > 9800 → 2줄
    const text = "가나다라마바사아자차"
    assert.equal(simulateWrap(text, 9800, 9800, 1000, 100, "charAll").lines, 1)
    assert.equal(simulateWrap(text, 9800, 9800, 1000, 100, "charAll", { faceClass: "fixedPitch" }).lines, 2)
  })
})

describe("markerWidth·levelIndent — 실측 폭 기반 내어쓰기", () => {
  it("markerWidth = 부호 실측폭 + 1타(0.5em)", () => {
    assert.equal(markerWidth("1.", 1500), Math.round(((550 + 320 + SPACE_EM_FIXED) / 1000) * 1500))
  })
  it("levelIndent.intent = -markerWidth(대표 부호)", () => {
    const d0 = levelIndent(0, 1500, "standard")
    assert.equal(d0.indent, -markerWidth("1.", 1500))
    const d1 = levelIndent(1, 1500, "standard")
    assert.equal(d1.indent, -markerWidth("가.", 1500))
  })
})
