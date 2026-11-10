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
import { arrowGlyph, bracketFeatures, bracketShape, circledAt, edgeTrim, gapGlyphs, inkBounds, inkStats, ringBullet, serifOne, slantedPair, starRun, leaderRuns, leadingBullet, leadingTriangle, quoteHead, romanStems, splitRowBands, tallInkCount } from "../src/ocr/line-split.js"

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
  it("넓고 속 빈 꺾인 조각은 〔〕 — 실측 기록관리 지침 목차 〔 채움 0.37·폭 0.35배, 〕 0.43·0.35배(소괄호는 폭 0.22~0.25배)", () => {
    const tort = { top: 1, bottom: 1, taper: 0.235, fill: 0.37, cw: 12, ch: 34, charH: 34 }
    assert.equal(bracketShape(tort, false), "\u3014")
    assert.equal(bracketShape({ ...tort, fill: 0.43 }, true), "\u3015")
    assert.equal(bracketShape({ ...tort, cw: 8 }, false), "(")
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
  it("왼끝이 곧은 오른쪽 삼각형은 ‣, 줄기 달린 화살표는 아니다", () => {
    const w = 120, h = 40
    const tri = canvas(w, h)
    for (let y = 13; y < 28; y++) { const half = 7 - Math.abs(y - 20); rect(tri, w, 12, y, 12 + Math.max(1, Math.round(half * 1.7)), y + 1) }
    text(tri, w)
    assert.deepEqual(leadingBullet(tri, w, h, inkStats(tri), 18), { mark: "\u2023", covers: true })
    const arrow = canvas(w, h)
    rect(arrow, w, 8, 19, 30, 22) // 줄기
    for (let y = 13; y < 28; y++) { const half = 7 - Math.abs(y - 20); rect(arrow, w, 30 - half, y, 32, y + 1) } // 머리
    text(arrow, w)
    assert.notEqual(leadingBullet(arrow, w, h, inkStats(arrow), 18)?.mark, "\u2023")
  })
  it("오른쪽·위 변이 두꺼운 그림자 네모는 ❐ — 자모 ㅁ 으로 읽은 자리(covers)도 표시한다, 네 변이 고르면 □", () => {
    const w = 120, h = 40, g = canvas(w, h)
    rect(g, w, 10, 9, 34, 15); rect(g, w, 10, 29, 34, 31); rect(g, w, 10, 9, 12, 31); rect(g, w, 28, 9, 34, 31) // 위 6px·오른쪽 6px, 아래·왼쪽 2px
    text(g, w)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 22), { mark: "\u2750", covers: true })
    const low = canvas(w, h)
    rect(low, w, 10, 9, 34, 11); rect(low, w, 10, 25, 34, 31); rect(low, w, 10, 9, 12, 31); rect(low, w, 28, 9, 34, 31) // 아래·오른쪽이 두꺼우면 ❏
    text(low, w)
    assert.equal(leadingBullet(low, w, h, inkStats(low), 22)?.mark, "\u274f")
  })
  it("기울기 보정 뒤 남은 기울기로 가운데 줄 외곽 끝이 비어도 ❐ (끝 2px 안 빈 칸은 건너뛰고 잰다)", () => {
    const w = 120, h = 40, g = canvas(w, h)
    rect(g, w, 10, 9, 34, 15); rect(g, w, 28, 9, 34, 31) // 위 6px·오른쪽 6px
    rect(g, w, 10, 9, 12, 20); rect(g, w, 11, 20, 13, 31); rect(g, w, 11, 29, 34, 31) // 왼쪽 2px 가 아래 절반에서 1px 밀림, 아래 2px
    text(g, w)
    assert.equal(leadingBullet(g, w, h, inkStats(g), 22)?.mark, "\u2750")
  })
  it("속 찬 네모를 품은 네모는 ▣ — 인식에서 빠졌으면(첫 글자 자리가 뒤) covers 거짓", () => {
    const w = 120, h = 40, g = canvas(w, h)
    rect(g, w, 10, 9, 33, 11); rect(g, w, 10, 29, 33, 31); rect(g, w, 10, 9, 12, 31); rect(g, w, 31, 9, 33, 31) // 바깥 테두리 23×22
    rect(g, w, 16, 14, 27, 26) // 가운데 속 찬 네모
    text(g, w)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 85), { mark: "\u25a3", covers: false })
    const hollow = canvas(w, h)
    rect(hollow, w, 10, 9, 33, 11); rect(hollow, w, 10, 29, 33, 31); rect(hollow, w, 10, 9, 12, 31); rect(hollow, w, 31, 9, 33, 31); text(hollow, w)
    assert.equal(leadingBullet(hollow, w, h, inkStats(hollow), 85)?.mark, "\u25a1")
  })
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
  it("앞 글자가 한글이면 그 모음 세로획(ㅏ)은 세지 않는다", () => {
    const w = 110, h = 40, g = canvas(w, h)
    rect(g, w, 2, 10, 12, 30) // 앞 한글 자음 덩어리 (중심 10)
    rect(g, w, 18, 6, 21, 34); rect(g, w, 21, 18, 26, 21) // ㅏ 세로획 + 곁가지
    rect(g, w, 50, 6, 53, 34) // Ⅰ
    rect(g, w, 70, 6, 98, 34) // 뒤 한글
    assert.equal(romanStems(g, w, h, inkStats(g), 10, 84, true), 1)
    assert.equal(romanStems(g, w, h, inkStats(g), 10, 84), 2)
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
  it("앞 붙임표가 고리 옆구리에 붙어도 원문자다(\"-①\")", () => {
    const w = 80, h = 40, g = canvas(w, h)
    ring(g, w, 50, 20, 13); rect(g, w, 49, 12, 52, 28) // ①
    rect(g, w, 22, 19, 38, 22) // 고리 왼 변에 닿는 붙임표
    rect(g, w, 2, 6, 18, 34) // 한글 글자 (글자 높이 28)
    assert.deepEqual(circledAt(g, w, h, inkStats(g), [50]), [true])
  })
})

describe("gapGlyphs — 쉼표에 맞닿은 날짜 끝 마침표", () => {
  it("빈 열 없이 쉼표와 맞닿아도 x 가 겹치지 않는 아래쪽 점은 . 이다", () => {
    const w = 120, h = 40
    const g = canvas(w, h)
    rect(g, w, 10, 6, 24, 34) // 숫자
    rect(g, w, 26, 29, 30, 33) // 마침표
    rect(g, w, 30, 34, 33, 39) // 쉼표 — 마침표 끝 열 바로 다음 열부터(빈 열 없음), 픽셀은 떨어짐
    rect(g, w, 40, 6, 54, 34) // 숫자
    const { glyphs } = gapGlyphs(g, w, h, inkStats(g))
    assert.ok(glyphs.some(o => o.mark === "." && o.x0 === 26), JSON.stringify(glyphs))
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
  it("겹선(‖)은 두 선을 한 테두리로, 윗변 가로 괘선은 글로 보지 않는다 (통계표 \"0:36\" → \":36\")", () => {
    const w = 120, h = 50, g = canvas(w, h)
    rect(g, w, 0, 1, w, 2) // 칸 윗변
    rect(g, w, 3, 0, 4, h); rect(g, w, 6, 0, 7, h) // 겹선
    rect(g, w, 14, 12, 40, 38); rect(g, w, 50, 12, 80, 38)
    assert.equal(edgeTrim(g, w, h, inkStats(g))?.x0, 7)
  })
  it("점선 세로선과, 이웃 칸 글자 끝을 넘은 실선도 테두리 (\"60.5\" → \"(.5\")", () => {
    const w = 120, h = 50
    const dot = canvas(w, h)
    for (let y = 0; y < h; y += 4) rect(dot, w, 3, y, 4, y + 2)
    rect(dot, w, 14, 12, 40, 38); rect(dot, w, 50, 12, 80, 38)
    assert.equal(edgeTrim(dot, w, h, inkStats(dot))?.x0, 4)
    const nb = canvas(w, h)
    rect(nb, w, 0, 14, 3, 21) // 옆 칸 글자 끝
    rect(nb, w, 8, 0, 9, h) // 칸 괘선
    rect(nb, w, 18, 12, 40, 38); rect(nb, w, 50, 12, 80, 38)
    assert.equal(edgeTrim(nb, w, h, inkStats(nb))?.x0, 9)
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
  it("그림자 진 고리는 가는 쪽이 번져 폭 8% 를 넘어도 두꺼운 쪽의 2/3 이하면 ○", () => {
    const w = 120, h = 40, g = canvas(w, h)
    ring(g, w, 22, 20, 16, 3) // 가는 쪽 3px (폭 33 의 9%)
    for (let y = 4; y <= 36; y++) for (let x = 22; x <= 38; x++) { const d = Math.hypot(x - 22, y - 20); if (d <= 16 && d >= 11) g[y * w + x] = 0 } // 오른쪽 5px
    rect(g, w, 60, 6, 110, 34)
    assert.equal(ringBullet(g, w, h, inkStats(g), 22), "\u25cb")
  })
  it("속 찬 원·고리 아닌 글자는 null", () => {
    const w = 120, h = 40, g = canvas(w, h); ring(g, w, 22, 20, 10, 10); text(g, w)
    assert.equal(ringBullet(g, w, h, inkStats(g), 22), null)
  })
})

describe("slantedPair — II·I 로 읽은 평행 기호 ∥", () => {
  const glyph = (g: Uint8Array, w: number, x: number) => rect(g, w, x, 6, x + 20, 34) // 앞뒤 글자
  it("같은 쪽으로 기운 가는 두 획은 ∥, 곧은 세리프 Ⅱ 는 아니다", () => {
    const w = 120, h = 40
    const par = canvas(w, h); glyph(par, w, 5); glyph(par, w, 80)
    for (let y = 14; y < 32; y++) { const x = 48 - Math.round((y - 14) * 0.3); rect(par, w, x, y, x + 2, y + 1); rect(par, w, x + 8, y, x + 10, y + 1) }
    assert.equal(slantedPair(par, w, h, inkStats(par), 15, 90), true)
    const roman = canvas(w, h); glyph(roman, w, 5); glyph(roman, w, 80)
    rect(roman, w, 44, 8, 47, 32); rect(roman, w, 52, 8, 55, 32); rect(roman, w, 40, 8, 59, 10); rect(roman, w, 40, 30, 59, 32)
    assert.equal(slantedPair(roman, w, h, inkStats(roman), 15, 90), false)
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

describe("arrowGlyph — 홀로 선 화살표 모양", () => {
  // 사전에 → 만 있어 ➔·▶·⇨ 가 모두 → 로 읽혔다(서식 흐름도·업무계획)
  const W = 60, H = 40
  /** 대(x0..x1, 굵기 t) + 오른쪽 열린 꺾쇠 머리(획 굵기 s) */
  function arrow(t: number, s: number, hollow = false): Uint8Array {
    const g = canvas(W, H)
    const cy = 20, x0 = 6, x1 = 40
    if (hollow) { rect(g, W, x0, cy - t, x1, cy - t + 2); rect(g, W, x0, cy + t - 2, x1, cy + t); rect(g, W, x0, cy - t, x0 + 2, cy + t) }
    else rect(g, W, x0, cy - (t >> 1), x1 + 6, cy - (t >> 1) + t)
    for (let k = 0; k <= 14; k++) { rect(g, W, 30 + k, cy - 14 + k, 30 + k + s, cy - 14 + k + 1); rect(g, W, 30 + k, cy + 14 - k, 30 + k + s, cy + 15 - k) }
    return g
  }
  it("굵은 대 → ➔, 가는 대 → null", () => {
    const heavy = arrow(8, 6), thin = arrow(2, 2)
    assert.equal(arrowGlyph(heavy, W, H, inkStats(heavy)), "\u2794")
    assert.equal(arrowGlyph(thin, W, H, inkStats(thin)), null)
  })
  it("테두리만 있는 대 → ⇨", () => {
    const g = arrow(7, 2, true)
    assert.equal(arrowGlyph(g, W, H, inkStats(g)), "\u21e8")
  })
  it("속 찬 삼각형 → ▶", () => {
    const g = canvas(W, H)
    for (let x = 10; x < 40; x++) { const half = Math.round(15 * (40 - x) / 30); rect(g, W, x, 20 - half, x + 1, 20 + half + 1) }
    assert.equal(arrowGlyph(g, W, H, inkStats(g)), "\u25b6")
  })
})

describe("gapGlyphs — 1px 길어진 작은 마침표와 작은 쉼표", () => {
  // 글자 두 개(28px 높이) 뒤 바닥 쪽 3×4 조각 — 대칭이면 마침표, 아래 반쪽이 가늘고 치우치면 쉼표(넣지 않음)
  const W = 90, H = 40
  function line(dot: (g: Uint8Array) => void): Uint8Array {
    const g = canvas(W, H)
    for (const x0 of [5, 40]) { rect(g, W, x0, 6, x0 + 24, 8); rect(g, W, x0, 6, x0 + 2, 34); rect(g, W, x0 + 22, 6, x0 + 24, 34); rect(g, W, x0, 32, x0 + 24, 34) }
    dot(g)
    return g
  }
  it("3×4 대칭 점은 마침표", () => {
    const g = line((g) => rect(g, W, 72, 29, 75, 33))
    assert.equal(gapGlyphs(g, W, H, inkStats(g)).glyphs.filter((x) => x.mark === ".").length, 1)
  })
  it("아래로 가늘어지는 3×4 쉼표는 마침표가 아니다", () => {
    const g = line((g) => { rect(g, W, 72, 29, 75, 31); rect(g, W, 73, 31, 75, 32); rect(g, W, 74, 32, 75, 33) })
    assert.ok(!gapGlyphs(g, W, H, inkStats(g)).glyphs.some((x) => x.mark === "."))
  })
})

describe("leadingBullet — 글자 높이만 한 □ 의 크기 상한(squareMax)", () => {
  it("박스 안 기본 상한 0.92 는 글자만 한 □ 를 도형으로 보고 넘기고, 넓힌 상한 1.05 는 □ 로 본다", () => {
    const w = 140, h = 50, g = canvas(w, h)
    rect(g, w, 4, 4, 46, 5); rect(g, w, 4, 45, 46, 46); rect(g, w, 4, 4, 5, 46); rect(g, w, 45, 4, 46, 46)
    for (const x0 of [80, 110]) { rect(g, w, x0, 8, x0 + 22, 10); rect(g, w, x0 + 10, 8, x0 + 12, 46) }
    assert.equal(leadingBullet(g, w, h, inkStats(g), 80), null)
    assert.deepEqual(leadingBullet(g, w, h, inkStats(g), 80, 1.05), { mark: "□", covers: false })
  })
})

describe("gapGlyphs — 반각 홑낫표 ｢", () => {
  it("띠 위끝에서 조금 내려앉은 ｢ 도 「 로 본다", () => {
    // 글자 띠 y 10~33(높이 23) 두 자 사이, 위끝 y 14(띠의 17%)에서 시작하는 ｢ — 윗변 6px, 왼쪽 줄기 12px
    const W = 90, H = 40, g = canvas(W, H)
    for (const x0 of [5, 60]) { rect(g, W, x0, 10, x0 + 20, 12); rect(g, W, x0, 10, x0 + 2, 33); rect(g, W, x0 + 18, 10, x0 + 20, 33); rect(g, W, x0, 31, x0 + 20, 33) }
    rect(g, W, 40, 14, 46, 16); rect(g, W, 40, 14, 42, 26)
    assert.ok(gapGlyphs(g, W, H, inkStats(g)).glyphs.some((x) => x.mark === "「"))
  })
})

describe("leadingBullet — 마름모 ◆ ◇ ◈", () => {
  /** 마름모 — 중심 (cx, cy), 반지름 r, 두께 t (t ≥ r 이면 속 찬 마름모) */
  function rhomb(g: Uint8Array, w: number, cx: number, cy: number, r: number, t: number) {
    for (let y = cy - r; y <= cy + r; y++) for (let x = cx - r; x <= cx + r; x++) {
      const d = Math.abs(x - cx) + Math.abs(y - cy)
      if (d <= r && d >= r - t) g[y * w + x] = 0
    }
  }
  const W = 120, H = 40
  const page = (draw: (g: Uint8Array) => void) => { const g = canvas(W, H); draw(g); rect(g, W, 60, 6, 110, 34); return g }
  it("속 찬 ◆ · 속 빈 ◇ · 속 찬 마름모를 품은 ◈", () => {
    const solid = page(g => rhomb(g, W, 20, 20, 11, 11))
    assert.deepEqual(leadingBullet(solid, W, H, inkStats(solid), 50), { mark: "◆", covers: false })
    const hollow = page(g => rhomb(g, W, 20, 20, 11, 2))
    assert.equal(leadingBullet(hollow, W, H, inkStats(hollow), 50)?.mark, "◇")
    const nested = page(g => { rhomb(g, W, 20, 20, 11, 2); rhomb(g, W, 20, 20, 4, 4) })
    assert.equal(leadingBullet(nested, W, H, inkStats(nested), 50)?.mark, "◈")
  })
  it("원은 마름모가 아니다", () => {
    const g = page(g => { for (let y = 9; y <= 31; y++) for (let x = 9; x <= 31; x++) if (Math.hypot(x - 20, y - 20) <= 11) g[y * W + x] = 0 })
    assert.ok(!["◆", "◇", "◈"].includes(leadingBullet(g, W, H, inkStats(g), 50)?.mark ?? ""))
  })
})

describe("leadingBullet — 큰 속 찬 네모 ■", () => {
  it("글자 높이만 한 속 찬 정사각은 ■, 작은 것은 ▪", () => {
    const W = 120, H = 40
    const big = canvas(W, H); rect(big, W, 10, 9, 32, 31); rect(big, W, 60, 6, 110, 34)
    assert.deepEqual(leadingBullet(big, W, H, inkStats(big), 50), { mark: "■", covers: false })
    const small = canvas(W, H); rect(small, W, 14, 16, 24, 26); rect(small, W, 60, 6, 110, 34)
    assert.equal(leadingBullet(small, W, H, inkStats(small), 50)?.mark, "▪")
  })
})

describe("inkBounds 점선 칸 괘선 너머 이웃 칸 글자 끝자락", () => {
  // 폭 60·높이 40 흰 상자: 위 0~3행에 윗행 글자 끝자락(쉼표 꼬리), 8행에 점선(2px 잉크·2px 틈), 14~34행에 이 칸 글자
  const box = (withTail: boolean) => {
    const w = 60, h = 40, g = new Uint8Array(w * h).fill(255)
    if (withTail) for (let y = 0; y < 4; y++) for (let x = 20; x < 24; x++) g[y * w + x] = 0
    for (let x = 0; x < w; x++) if (x % 4 < 2) g[8 * w + x] = 0
    for (let y = 14; y < 34; y++) for (let x = 10; x < 50; x++) if ((x + y) % 3 === 0) g[y * w + x] = 0
    return g
  }
  it("점선 너머에 잉크가 있으면 점선과 너머를 빼고 칸 글자만 잰다", () => {
    const g = box(true)
    const b = inkBounds(g, 60, 40, inkStats(g))
    assert.equal(b.y0, 14)
  })
  it("작은 글자 줄(획이 위아래로 이어지는 짧고 고른 조각)은 점선으로 보지 않는다", () => {
    const w = 60, h = 40, g = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < 2; y++) for (let x = 20; x < 24; x++) g[y * w + x] = 0
    for (let y = 2; y < 10; y++) for (let x = 0; x < w; x++) if (x % 4 < 2) g[y * w + x] = 0
    for (let y = 14; y < 34; y++) for (let x = 10; x < 50; x++) if ((x + y) % 3 === 0) g[y * w + x] = 0
    assert.equal(inkBounds(g, w, h, inkStats(g)).y0, 0)
  })
  it("괘선 바로 옆 번진 잉크 점은 외곽에 넣지 않는다 (잡음 섞인 상자 테두리)", () => {
    const w = 60, h = 40, g = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < h; y++) g[y * w + 59] = 0
    for (const y of [5, 17, 30]) g[y * w + 58] = 0
    for (let y = 14; y < 34; y++) for (let x = 10; x < 40; x++) if ((x + y) % 3 === 0) g[y * w + x] = 0
    assert.equal(inkBounds(g, w, h, inkStats(g)).x1, 40)
  })
  it("괘선에 붙었어도 본문과 이어진 글자 획은 외곽에 남긴다", () => {
    const w = 60, h = 40, g = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < h; y++) g[y * w + 59] = 0
    for (let y = 14; y < 34; y++) for (let x = 10; x < 58; x++) if ((x + y) % 3 === 0) g[y * w + x] = 0
    assert.equal(inkBounds(g, w, h, inkStats(g)).x1, 58)
  })
  it("기울기 보정으로 옆 열로 번진 세로 괘선 가장자리는 괘선으로 뺀다 (세로 범위가 부풀지 않는다)", () => {
    const w = 60, h = 40, g = new Uint8Array(w * h).fill(255)
    for (let y = 0; y < h; y++) { g[y * w + 59] = 0; if (y % 3) g[y * w + 58] = 0 }
    for (let y = 14; y < 34; y++) for (let x = 10; x < 40; x++) if ((x + y) % 3 === 0) g[y * w + x] = 0
    const b = inkBounds(g, w, h, inkStats(g))
    assert.deepEqual([b.y0, b.y1, b.x1], [14, 34, 40])
  })
  it("점선 너머가 비면 종전대로 점선까지 잰다 (띄어 쓴 머리 칸 높이를 바꾸지 않는다)", () => {
    const g = box(false)
    const b = inkBounds(g, 60, 40, inkStats(g))
    assert.equal(b.y0, 8)
  })
})
