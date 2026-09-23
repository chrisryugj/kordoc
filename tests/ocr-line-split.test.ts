/**
 * 검출 박스 픽셀 분석 (line-split.ts) — 잉크 대비·행 밴드 분할.
 *
 * 잠근 계약:
 *  1. inkStats: 흰 바탕 검은 획은 darkInk·고대비, 연한 바탕의 흰 도안은 저대비(환각 거름 근거)
 *  2. splitRowBands: 세로로 쌓인 글자 → 글자마다 밴드, 칸 경계 세로선(행 85%+ 잉크 열)은
 *     투영에서 빠지고 밴드 x 구간에도 안 들어간다(부천 예산서 "국/균/도/시" 실측 회귀)
 *  3. 글자 안 빈 행(“업”의 어/ㅂ 사이)은 한 밴드로 합쳐진다
 *  4. 박스 끝에 걸린 이웃 줄 조각은 버린다
 *  5. 박스 폭이 글자보다 훨씬 넓어도(unclip 여백) 글자 밴드가 합쳐지지 않는다 — 글자 크기는
 *     밴드별 잉크 폭 중앙값 (함평 목차 ◎ 열 회귀)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { inkStats, splitRowBands } from "../src/ocr/line-split.js"

function canvas(w: number, h: number, bg = 255): Uint8Array {
  return new Uint8Array(w * h).fill(bg)
}
function rect(g: Uint8Array, w: number, x0: number, y0: number, x1: number, y1: number, v = 0) {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * w + x] = v
}
/** 30×30 "글자": 테두리 3px 사각 (안은 비어 있음) */
function glyph(g: Uint8Array, w: number, x0: number, y0: number, size = 30) {
  rect(g, w, x0, y0, x0 + size, y0 + 3)
  rect(g, w, x0, y0 + size - 3, x0 + size, y0 + size)
  rect(g, w, x0, y0, x0 + 3, y0 + size)
  rect(g, w, x0 + size - 3, y0, x0 + size, y0 + size)
}

describe("inkStats — Otsu 극성·대비", () => {
  it("흰 바탕 검은 획", () => {
    const w = 60, h = 40, g = canvas(w, h)
    glyph(g, w, 15, 5)
    const s = inkStats(g)
    assert.equal(s.darkInk, true)
    assert.ok(s.contrast > 200, `contrast=${s.contrast}`)
  })
  it("연한 파랑 바탕(233)의 흰 도안(255)은 저대비", () => {
    const w = 60, h = 40, g = canvas(w, h, 233)
    rect(g, w, 10, 10, 50, 14, 255)
    rect(g, w, 28, 5, 32, 35, 255)
    const s = inkStats(g)
    assert.ok(s.contrast < 35, `contrast=${s.contrast}`)
  })
})

describe("splitRowBands — 세로로 쌓인 글자", () => {
  it("4글자 + 칸 경계 세로선 → 4밴드, x 구간은 괘선 제외", () => {
    const w = 50, h = 160, g = canvas(w, h)
    rect(g, w, 1, 0, 3, h) // 관통 세로선
    for (let i = 0; i < 4; i++) glyph(g, w, 15, 5 + i * 38)
    const bands = splitRowBands(g, w, h, inkStats(g), 0.45)
    assert.equal(bands.length, 4)
    for (const b of bands) {
      assert.ok(b.x0 >= 15 && b.x1 <= 45, `x ${b.x0}-${b.x1}`)
      assert.ok(b.y1 - b.y0 >= 28 && b.y1 - b.y0 <= 32, `h ${b.y1 - b.y0}`)
    }
  })
  it("글자 안 2px 빈 행은 한 밴드", () => {
    const w = 50, h = 110, g = canvas(w, h)
    glyph(g, w, 10, 5)
    // "업"처럼 위(14px)/아래(14px) 조각 사이 2px 빈 행
    rect(g, w, 10, 45, 40, 59)
    rect(g, w, 10, 61, 40, 75)
    const bands = splitRowBands(g, w, h, inkStats(g), 0.45)
    assert.equal(bands.length, 2, JSON.stringify(bands))
    assert.ok(bands[1].y0 <= 45 && bands[1].y1 >= 75)
  })
  it("박스 위 끝에 걸린 이웃 줄 조각은 버림", () => {
    const w = 50, h = 120, g = canvas(w, h)
    rect(g, w, 5, 0, 45, 4) // 윗줄 글자 끝자락
    glyph(g, w, 10, 20)
    glyph(g, w, 10, 70)
    const bands = splitRowBands(g, w, h, inkStats(g), 0.45)
    assert.equal(bands.length, 2)
    assert.ok(bands[0].y0 >= 18, `첫 밴드 y0=${bands[0].y0}`)
  })
  it("박스 폭(92)이 글자(30)보다 넓어도 글자 밴드 유지", () => {
    const w = 92, h = 200, g = canvas(w, h)
    for (let i = 0; i < 5; i++) glyph(g, w, 5, 5 + i * 40)
    const bands = splitRowBands(g, w, h, inkStats(g), 0.45)
    assert.equal(bands.length, 5)
  })
  it("빈 행 없는 박스는 한 밴드 (전체 폭)", () => {
    const w = 40, h = 100, g = canvas(w, h)
    rect(g, w, 15, 5, 25, 95)
    const bands = splitRowBands(g, w, h, inkStats(g), 0.45)
    assert.equal(bands.length, 1)
    assert.deepEqual([bands[0].x0, bands[0].x1], [0, w])
  })
})
