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
import { inkStats, leaderRuns, leadingTriangle, splitRowBands } from "../src/ocr/line-split.js"

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

/** 속이 빈(또는 찬) 삼각형 — 밑변 전폭, 꼭짓점 가운데 */
function triangle(g: Uint8Array, w: number, x0: number, y0: number, size: number, filled = false) {
  for (let r = 0; r < size; r++) {
    const half = Math.round((r / (size - 1)) * (size / 2))
    const cx = x0 + Math.floor(size / 2)
    const lo = cx - half, hi = cx + half
    if (filled || r >= size - 2) rect(g, w, lo, y0 + r, hi + 1, y0 + r + 1)
    else { rect(g, w, lo, y0 + r, lo + 2, y0 + r + 1); rect(g, w, hi - 1, y0 + r, hi + 1, y0 + r + 1) }
  }
}

describe("leaderRuns — 목차 리더 점 무리", () => {
  // 검출기는 쪽번호를 앞 리더 점과 한 박스로 묶고, 인식기는 점 뒤 숫자를 망친다("·····141" → "…11", changwon 목차)
  it("글자 두 개 사이 점 8개 → 무리 하나 (점 구간만)", () => {
    const w = 400, h = 40, g = canvas(w, h)
    glyph(g, w, 5, 5)
    for (let i = 0; i < 8; i++) rect(g, w, 60 + i * 30, 26, 64 + i * 30, 30)
    glyph(g, w, 330, 5)
    const runs = leaderRuns(g, w, h, inkStats(g), 4)
    assert.equal(runs.length, 1, JSON.stringify(runs))
    assert.ok(runs[0][0] >= 55 && runs[0][1] <= 300, JSON.stringify(runs))
  })
  it("말줄임표(점 3개)는 무리가 아니다", () => {
    const w = 200, h = 40, g = canvas(w, h)
    glyph(g, w, 5, 5)
    for (let i = 0; i < 3; i++) rect(g, w, 50 + i * 12, 26, 54 + i * 12, 30)
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 0)
  })
  it("박스 위 여백에 걸친 점선 괘선 조각(글자 띠 밖)은 리더가 아니다", () => {
    const w = 300, h = 50, g = canvas(w, h)
    for (let x = 0; x < w; x += 6) rect(g, w, x, 1, x + 3, 3) // 윗변 점선 괘선
    glyph(g, w, 100, 12)
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 0)
  })
  it("여러 조각 한 글자(\"소\" = ㅅ+ㅗ) 뒤의 굵은 리더 점(9px)도 무리로 잡는다 (yeosu 목차)", () => {
    const w = 400, h = 60, g = canvas(w, h)
    rect(g, w, 10, 10, 40, 36) // 윗 조각(ㅅ)
    rect(g, w, 10, 38, 40, 50) // 아랫 조각(ㅗ) — 성분 하나 높이(26)로 재면 9px 점이 "작지" 않다
    for (let i = 0; i < 8; i++) rect(g, w, 60 + i * 14, 26, 69 + i * 14, 35)
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 1)
  })
  it("두 행 사이 점선 괘선을 문 박스(위아래 행 글자)는 리더가 아니다 (changwon 정원표 칸)", () => {
    const w = 300, h = 80, g = canvas(w, h)
    rect(g, w, 10, 2, 40, 22) // 윗 행 글자
    rect(g, w, 10, 50, 40, 72) // 아랫 행 글자
    for (let x = 45; x < 290; x += 6) rect(g, w, x, 34, x + 3, 37) // 행 사이 점선
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 0)
  })
  it("크기·간격이 고르지 않은 잔조각(작은 글꼴 획)은 리더가 아니다", () => {
    const w = 300, h = 50, g = canvas(w, h)
    rect(g, w, 10, 5, 30, 40)
    const pieces = [[40, 2, 2], [44, 6, 3], [58, 2, 2], [62, 3, 6], [80, 2, 2], [83, 6, 2]]
    for (const [x, pw, ph] of pieces) rect(g, w, x, 30, x + pw, 30 + ph)
    rect(g, w, 100, 5, 120, 40)
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 0)
  })
  it("박스를 관통하는 칸 경계 세로선이 있어도 숫자는 점이 아니다 (goesan \"8,000 │ 1,000\")", () => {
    const w = 300, h = 70, g = canvas(w, h)
    rect(g, w, 150, 0, 152, h) // 관통 세로선 — 가장 큰 성분이 되면 글자 높이가 부풀어 숫자(14×18)가 "점"이 된다
    for (let i = 0; i < 4; i++) rect(g, w, 20 + i * 22, 26, 34 + i * 22, 44)
    for (let i = 0; i < 4; i++) rect(g, w, 170 + i * 22, 26, 184 + i * 22, 44)
    assert.equal(leaderRuns(g, w, h, inkStats(g), 4).length, 0)
  })
})

describe("leadingTriangle — 숫자 앞 △·▲", () => {
  // 인식 사전에 △ 가 없어 "△400,352" 가 "400,352" 로 부호를 잃었다 (부천 예산서 38개)
  it("속 빈 삼각형 + 숫자 → △", () => {
    const w = 200, h = 40, g = canvas(w, h)
    triangle(g, w, 10, 12, 19)
    for (let i = 0; i < 3; i++) rect(g, w, 40 + i * 20, 10, 52 + i * 20, 32)
    assert.equal(leadingTriangle(g, w, h, inkStats(g)), "\u25b3")
  })
  it("속 찬 삼각형 → ▲", () => {
    const w = 200, h = 40, g = canvas(w, h)
    triangle(g, w, 10, 12, 19, true)
    rect(g, w, 40, 10, 52, 32)
    assert.equal(leadingTriangle(g, w, h, inkStats(g)), "\u25b2")
  })
  it("숫자로 시작하면(속 찬 네모·세로 획) null", () => {
    const w = 200, h = 40, g = canvas(w, h)
    rect(g, w, 10, 10, 22, 32)
    rect(g, w, 30, 10, 33, 32)
    assert.equal(leadingTriangle(g, w, h, inkStats(g)), null)
  })
  it("맨 앞이 칸 경계 세로선이면 그 뒤 글자로 판단", () => {
    const w = 200, h = 40, g = canvas(w, h)
    rect(g, w, 2, 0, 4, h)
    triangle(g, w, 10, 12, 19)
    rect(g, w, 40, 10, 52, 32)
    assert.equal(leadingTriangle(g, w, h, inkStats(g)), "\u25b3")
  })
})
