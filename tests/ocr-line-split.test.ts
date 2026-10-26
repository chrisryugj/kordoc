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
import { bracketFeatures, bracketShape, circledAt, edgeTrim, gapGlyphs, inkStats, ringBullet, serifOne, starRun, leaderRuns, leadingBullet, leadingTriangle, quoteHead, romanStems, splitRowBands, tallInkCount } from "../src/ocr/line-split.js"

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

describe("bracketFeatures·bracketShape — 사전 밖 괄호 「」【】", () => {
  // 인식 사전에 「」·【】 가 없어 모두 [ ] 로 읽힌다 (코퍼스 정답 「」·｢｣ 67쌍·【】 41쌍). 괄호 자리 잉크 조각 모양으로 되살린다
  /** ASCII 조각을 캔버스 (x0, y0) 에 찍는다 ("#" = 잉크) */
  function art(g: Uint8Array, w: number, x0: number, y0: number, rows: string[]) {
    rows.forEach((r, y) => [...r].forEach((c, x) => { if (c === "#") g[(y0 + y) * w + x0 + x] = 0 }))
  }
  const sq = ["#######", ...Array(24).fill("###...."), "#######"]
  const lens = ["#########", "########.", "########.", "#######..", "#######..", ...Array(16).fill("######..."), "#######..", "#######..", "########.", "########.", "#########"]
  const corner = ["##########", "##########", ...Array(11).fill("##........")]
  const setup = (glyph: string[], y0 = 4) => {
    const w = 80, h = 36, g = canvas(w, h)
    art(g, w, 10, y0, glyph)
    rect(g, w, 30, 4, 56, 30) // 이웃 한글 글자 (글자 높이 기준)
    return { g, w, h }
  }
  it("윗·아랫변 뒤 한 번에 획 폭으로 떨어지면 [ 그대로", () => {
    const { g, w, h } = setup(sq)
    const f = bracketFeatures(g, w, h, inkStats(g), 13)!
    assert.equal(bracketShape(f, false), null)
  })
  it("위아래에서 가운데로 폭이 줄어들면 【", () => {
    const { g, w, h } = setup(lens)
    const f = bracketFeatures(g, w, h, inkStats(g), 13)!
    assert.ok(f.taper >= 0.16, `taper=${f.taper}`)
    assert.equal(bracketShape(f, false), "\u3010")
  })
  it("위아래로 휜 좁은 조각(모서리 둥근 소괄호)은 ( — 【 는 폭이 글자 높이 0.28배 넘는 속 찬 조각이다", () => {
    const round = ["#####", "####.", "###..", "###..", ...Array(18).fill("##..."), "###..", "###..", "####.", "#####"]
    const { g, w, h } = setup(round)
    const f = bracketFeatures(g, w, h, inkStats(g), 12)!
    assert.ok(f.taper >= 0.16 && f.cw < f.ch * 0.28, `taper=${f.taper} cw=${f.cw} ch=${f.ch}`)
    assert.equal(bracketShape(f, false), "(")
  })
  it("윗변 가로 획만 있는 글자 높이 절반의 조각은 「, 뒤집으면 」", () => {
    const { g, w, h } = setup(corner)
    assert.equal(bracketShape(bracketFeatures(g, w, h, inkStats(g), 14)!, false), "\u300c")
    const { g: g2 } = setup([...corner].reverse().map(r => [...r].reverse().join("")), 17)
    assert.equal(bracketShape(bracketFeatures(g2, w, h, inkStats(g2), 14)!, true), "\u300d")
  })
  it("자리에 괄호 조각이 없으면 null", () => {
    const { g, w, h } = setup([])
    assert.equal(bracketFeatures(g, w, h, inkStats(g), 13), null)
  })
})

describe("leadingBullet — 사전 밖·작은 점으로 읽히거나 빠지는 글머리 ◎ ● ▪ □", () => {
  /** 원(속 빈·찬) — 중심 (cx, cy), 반지름 r, 두께 t (t ≥ r 이면 속 찬 원) */
  function disc(g: Uint8Array, w: number, cx: number, cy: number, r: number, t: number) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r && d >= r - t) g[y * w + x] = 0
    }
  }
  const text = (g: Uint8Array, w: number) => rect(g, w, 60, 6, 110, 34) // 뒤 글자 (글자 높이 28)
  it("안팎으로 겹친 두 고리는 ◎", () => {
    const w = 120, h = 40, g = canvas(w, h)
    disc(g, w, 22, 20, 12, 2); disc(g, w, 22, 20, 6, 2); text(g, w)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 23), { mark: "\u25ce", covers: true })
  })
  it("글자 높이 절반이 넘는 속 찬 원은 ●, 작은 속 찬 네모는 ▪ — 첫 글자 앞에 따로 있으면 누락(covers false)", () => {
    const w = 120, h = 40, g = canvas(w, h)
    disc(g, w, 22, 20, 8, 8); text(g, w)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 80), { mark: "\u25cf", covers: false })
    const g2 = canvas(w, h)
    rect(g2, w, 16, 15, 26, 25); text(g2, w)
    assert.equal(leadingBullet(g2, w, h, inkStats(g2), 80)?.mark, "\u25aa")
  })
  it("글자 높이 0.6~0.92배 속 빈 정사각(윗·아랫변이 차고 가운데 줄은 양끝 두 획)은 □", () => {
    const w = 120, h = 40, g = canvas(w, h)
    rect(g, w, 12, 9, 34, 11); rect(g, w, 12, 29, 34, 31); rect(g, w, 12, 9, 14, 31); rect(g, w, 32, 9, 34, 31); text(g, w)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 80), { mark: "\u25a1", covers: false })
  })
  it("가운뎃점 크기(글자 높이 0.2배)·속 빈 원(○·ㅇ)·원문자(안쪽이 숫자)는 null", () => {
    const w = 120, h = 40
    const dot = canvas(w, h); rect(dot, w, 18, 18, 24, 24); text(dot, w)
    assert.equal(leadingBullet(dot, w, h, inkStats(dot), 80), null)
    const ring = canvas(w, h); disc(ring, w, 22, 20, 12, 2); text(ring, w)
    assert.equal(leadingBullet(ring, w, h, inkStats(ring), 23), null)
    const circled = canvas(w, h); disc(circled, w, 22, 20, 12, 2); rect(circled, w, 21, 13, 24, 27); text(circled, w)
    assert.equal(leadingBullet(circled, w, h, inkStats(circled), 23), null)
  })
})

describe("romanStems — 로마 숫자 세로 획 수 (모델이 Ⅲ 을 II·I 로 줄여 읽음)", () => {
  const text = (g: Uint8Array, w: number) => rect(g, w, 70, 6, 98, 34) // 뒤 한글 글자 (글자 높이 28, 중심 84)
  /** 세리프 로마 숫자 — n 개 세로 획을 위아래 가로대로 이은 한 성분 */
  function roman(g: Uint8Array, w: number, n: number) {
    for (let k = 0; k < n; k++) rect(g, w, 12 + k * 8, 8, 15 + k * 8, 32)
    rect(g, w, 10, 8, 17 + (n - 1) * 8, 10); rect(g, w, 10, 30, 17 + (n - 1) * 8, 32)
    rect(g, w, 17 + (n - 1) * 8 + 3, 29, 17 + (n - 1) * 8 + 6, 32) // 뒤 마침표 (작은 성분, 셈에서 빠진다)
  }
  it("가로대로 이어진 Ⅲ 은 가운데 줄 세 토막 → 3, Ⅱ → 2", () => {
    for (const n of [3, 2]) {
      const w = 110, h = 40, g = canvas(w, h)
      roman(g, w, n); text(g, w)
      assert.equal(romanStems(g, w, h, inkStats(g), -Infinity, 84), n)
    }
  })
  it("굵은 획(한글 글자 덩어리)은 세로 획이 아니다 → null", () => {
    const w = 110, h = 40, g = canvas(w, h)
    rect(g, w, 10, 8, 34, 32); text(g, w)
    assert.equal(romanStems(g, w, h, inkStats(g), -Infinity, 84), null)
  })
})

describe("circledAt — 원문자 숫자 (모델이 고리를 버리고 숫자만 읽음)", () => {
  function ring(g: Uint8Array, w: number, cx: number, cy: number, r: number) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r && d >= r - 2) g[y * w + x] = 0
    }
  }
  it("고리 안에 숫자 획이 있으면 원문자, 고리 없는 숫자·괄호 숫자는 아니다", () => {
    const w = 140, h = 40, g = canvas(w, h)
    ring(g, w, 20, 20, 13); rect(g, w, 19, 12, 22, 28) // ①
    rect(g, w, 60, 8, 63, 32) // 맨 숫자 1
    rect(g, w, 90, 6, 92, 34); rect(g, w, 99, 10, 102, 30); rect(g, w, 109, 6, 111, 34) // ( 1 )
    rect(g, w, 120, 6, 138, 34) // 한글 글자 (글자 높이 28)
    assert.deepEqual(circledAt(g, w, h, inkStats(g), [20, 61, 100]), [true, false, false])
  })
})

describe("quoteHead — 따옴표 머리 위치 (‘ 는 머리가 아래, ’ 는 위)", () => {
  /** 따옴표 — 머리(3×4)와 꼬리(1×4) */
  function quote(g: Uint8Array, w: number, x: number, headLow: boolean) {
    if (headLow) { rect(g, w, x + 2, 6, x + 3, 10); rect(g, w, x, 10, x + 3, 14) }
    else { rect(g, w, x, 6, x + 3, 10); rect(g, w, x, 10, x + 1, 14) }
  }
  it("머리 무게중심이 아래면 크고(여는), 위면 작다(닫는)", () => {
    const w = 80, h = 40
    const open = canvas(w, h); quote(open, w, 10, true); rect(open, w, 30, 6, 58, 34)
    const close = canvas(w, h); quote(close, w, 10, false); rect(close, w, 30, 6, 58, 34)
    assert.ok(quoteHead(open, w, h, inkStats(open), 11)! >= 0.49)
    assert.ok(quoteHead(close, w, h, inkStats(close), 11)! < 0.45)
  })
})

describe("tallInkCount — 키 큰 잉크 덩어리 수 (채운 자리 글자 거름)", () => {
  it("빗금 하나 → 1, 숫자 두 자 + 점 → 2", () => {
    const w = 60, h = 40
    const slash = canvas(w, h)
    for (let y = 6; y < 34; y++) rect(slash, w, 30 - (y >> 2), y, 33 - (y >> 2), y + 1)
    assert.equal(tallInkCount(slash, w, h, inkStats(slash)), 1)
    const two = canvas(w, h)
    rect(two, w, 8, 6, 24, 34); rect(two, w, 30, 6, 46, 34); rect(two, w, 50, 30, 53, 33)
    assert.equal(tallInkCount(two, w, h, inkStats(two)), 2)
  })
})

describe("edgeTrim — 한 줄 박스에 걸린 이웃 줄 끝자락·상자 테두리 (인식기가 받침·\"|\" 로 읽음)", () => {
  it("위아래 끝에 닿은 얇은 띠는 빈 행 가운데까지 잘라내고, 좌우 끝 세로 괘선은 안쪽으로", () => {
    const w = 120, h = 50, g = canvas(w, h)
    rect(g, w, 10, 12, 40, 38); rect(g, w, 50, 12, 80, 38) // 글자 두 자
    rect(g, w, 12, 0, 78, 4) // 윗줄 글자 아랫끝
    rect(g, w, 12, 46, 78, 50) // 아랫줄 글자 윗끝
    rect(g, w, 112, 0, 114, 50) // 상자 오른쪽 테두리
    assert.deepEqual(edgeTrim(g, w, h, inkStats(g)), { x0: 0, x1: 112, y0: 8, y1: 42 })
  })
  it("남는 띠가 글자 한 덩어리(아이콘·큰 번호 한 자)면 위아래는 건드리지 않는다", () => {
    const w = 60, h = 50, g = canvas(w, h)
    rect(g, w, 15, 0, 45, 4); rect(g, w, 15, 10, 45, 44)
    assert.equal(edgeTrim(g, w, h, inkStats(g)), null)
  })
  it("끝에 닿은 조각이 없으면 null", () => {
    const w = 120, h = 50, g = canvas(w, h)
    rect(g, w, 10, 12, 40, 38); rect(g, w, 50, 12, 80, 38)
    assert.equal(edgeTrim(g, w, h, inkStats(g)), null)
  })
})

describe("gapGlyphs — 두 글자 사이에서 빠진 기호 · ▲ 「 」 □", () => {
  const glyphs = (g: Uint8Array, w: number) => { rect(g, w, 10, 6, 38, 34); rect(g, w, 90, 6, 118, 34) } // 앞뒤 한글 글자 (띠 6~34)
  it("가운데 높이 작은 둥근 점은 ·, 아래에 붙은 ㄴ 꼴은 」, 위에 붙은 ㄱ 꼴은 「", () => {
    const w = 130, h = 40
    const dot = canvas(w, h); glyphs(dot, w); rect(dot, w, 60, 18, 65, 23)
    assert.deepEqual(gapGlyphs(dot, w, h, inkStats(dot)).glyphs.map(x => x.mark), ["\u00b7"])
    const close = canvas(w, h); glyphs(close, w); rect(close, w, 64, 18, 67, 34); rect(close, w, 55, 31, 67, 34)
    assert.deepEqual(gapGlyphs(close, w, h, inkStats(close)).glyphs.map(x => x.mark), ["\u300d"])
    const open = canvas(w, h); glyphs(open, w); rect(open, w, 55, 6, 58, 22); rect(open, w, 55, 6, 67, 9)
    assert.deepEqual(gapGlyphs(open, w, h, inkStats(open)).glyphs.map(x => x.mark), ["\u300c"])
  })
  it("다음 글자와 빈 열 없이 맞닿은 「 도 잡고, x 가 겹치면 잡지 않는다", () => {
    const w = 130, h = 40
    // 「 끝 열(89) 바로 다음 열(90)에서 글자가 시작한다 — 「 는 위에, 글자는 아래쪽이 넓어 픽셀은 닿지 않는다
    const abut = canvas(w, h); rect(abut, w, 10, 6, 38, 34); rect(abut, w, 90, 12, 118, 34); rect(abut, w, 78, 6, 81, 22); rect(abut, w, 78, 6, 90, 9)
    assert.deepEqual(gapGlyphs(abut, w, h, inkStats(abut)).glyphs.map(x => x.mark), ["\u300c"])
    const overlap = canvas(w, h); rect(overlap, w, 10, 6, 38, 34); rect(overlap, w, 86, 12, 118, 34); rect(overlap, w, 78, 6, 81, 22); rect(overlap, w, 78, 6, 90, 9)
    assert.deepEqual(gapGlyphs(overlap, w, h, inkStats(overlap)).glyphs.map(x => x.mark), [])
  })
  it("속 찬 삼각형은 ▲, 속 빈 정사각은 □", () => {
    const w = 130, h = 40
    const tri = canvas(w, h); glyphs(tri, w)
    for (let y = 8; y < 32; y++) { const half = Math.round((y - 8) * 0.55); rect(tri, w, 64 - half, y, 65 + half, y + 1) }
    assert.deepEqual(gapGlyphs(tri, w, h, inkStats(tri)).glyphs.map(x => x.mark), ["\u25b2"])
    const sq = canvas(w, h); glyphs(sq, w)
    rect(sq, w, 54, 9, 76, 11); rect(sq, w, 54, 29, 76, 31); rect(sq, w, 54, 9, 56, 31); rect(sq, w, 74, 9, 76, 31)
    assert.deepEqual(gapGlyphs(sq, w, h, inkStats(sq)).glyphs.map(x => x.mark), ["\u25a1"])
  })
  it("한글 글자·ㄱ·칸 경계 세로선·글자와 x 가 겹친 조각은 기호가 아니다", () => {
    const w = 130, h = 40, g = canvas(w, h); glyphs(g, w)
    rect(g, w, 64, 2, 66, 38) // 칸 경계 세로선
    rect(g, w, 36, 18, 41, 23) // 앞 글자와 x 가 겹친 점
    rect(g, w, 70, 6, 82, 9); rect(g, w, 79, 6, 82, 22) // 한글 ㄱ (줄기가 오른쪽)
    assert.deepEqual(gapGlyphs(g, w, h, inkStats(g)).glyphs, [])
  })
})

describe("ringBullet — 줄 머리 고리 ○ / ㅇ (모델이 같은 글리프를 O·ㅇ 로 오락가락 읽음)", () => {
  function ring(g: Uint8Array, w: number, cx: number, cy: number, r: number, t: number) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.hypot(x - cx, y - cy)
      if (d <= r && d >= r - t) g[y * w + x] = 0
    }
  }
  const text = (g: Uint8Array, w: number) => rect(g, w, 60, 6, 110, 34) // 뒤 글자 (글줄 띠 6~34, 높이 28)
  it("띠 높이만 한 가는 고리는 ○, 띠 절반 크기 굵은 고리는 ㅇ", () => {
    const w = 120, h = 40
    const big = canvas(w, h); ring(big, w, 22, 20, 14, 1.5); text(big, w)
    assert.equal(ringBullet(big, w, h, inkStats(big), 22), "\u25cb")
    const small = canvas(w, h); ring(small, w, 22, 20, 7, 3); text(small, w)
    assert.equal(ringBullet(small, w, h, inkStats(small), 22), "\u3147")
  })
  it("속 찬 원·고리 아닌 글자는 null", () => {
    const w = 120, h = 40, g = canvas(w, h); ring(g, w, 22, 20, 10, 10); text(g, w)
    assert.equal(ringBullet(g, w, h, inkStats(g), 22), null)
  })
})

describe("serifOne — 숫자 1 로 읽은 로마 숫자 Ⅰ (세리프가 좌우 대칭)", () => {
  const text = (g: Uint8Array, w: number) => rect(g, w, 60, 6, 110, 34)
  it("위아래 머리가 줄기 양쪽으로 뻗으면 Ⅰ, 윗머리가 왼쪽으로만 뻗으면(깃) 숫자 1", () => {
    const w = 120, h = 40
    const roman = canvas(w, h); rect(roman, w, 20, 8, 24, 32); rect(roman, w, 16, 8, 28, 11); rect(roman, w, 16, 29, 28, 32); text(roman, w)
    assert.equal(serifOne(roman, w, h, inkStats(roman), 22), true)
    const one = canvas(w, h); rect(one, w, 20, 8, 24, 32); rect(one, w, 15, 8, 24, 12); text(one, w)
    assert.equal(serifOne(one, w, h, inkStats(one), 22), false)
  })
})

describe("starRun — CTC 가 하나로 합친 겹 별표 **", () => {
  it("글자 옆 별표 꼴 조각 둘이 붙어 있으면 2, 하나면 1", () => {
    const w = 120, h = 40
    const star = (g: Uint8Array, x: number) => { rect(g, w, x, 10, x + 8, 12); rect(g, w, x + 3, 7, x + 5, 16); rect(g, w, x + 1, 9, x + 7, 14) }
    const two = canvas(w, h); rect(two, w, 10, 6, 38, 34); star(two, 42); star(two, 52)
    assert.equal(starRun(two, w, h, inkStats(two), 46), 2)
    const one = canvas(w, h); rect(one, w, 10, 6, 38, 34); star(one, 42)
    assert.equal(starRun(one, w, h, inkStats(one), 46), 1)
  })
})

describe("gapGlyphs — 분수 칸 빗금 / 과 꼬리말 막대 -", () => {
  it("숫자 사이 가는 사선은 /, 가운데 높이 짧은 가로 막대는 -", () => {
    const w = 120, h = 40
    const g = canvas(w, h); rect(g, w, 10, 6, 28, 34); rect(g, w, 80, 6, 98, 34)
    for (let y = 6; y < 34; y++) { const x = 60 - Math.round((y - 6) * 0.45); rect(g, w, x, y, x + 2, y + 1) }
    assert.deepEqual(gapGlyphs(g, w, h, inkStats(g)).glyphs.map(x => x.mark), ["/"])
    const d = canvas(w, h); rect(d, w, 10, 6, 28, 34); rect(d, w, 80, 6, 98, 34); rect(d, w, 45, 19, 57, 21)
    assert.deepEqual(gapGlyphs(d, w, h, inkStats(d)).glyphs.map(x => x.mark), ["-"])
  })
})
