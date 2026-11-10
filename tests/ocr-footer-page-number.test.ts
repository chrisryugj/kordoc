import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { closingParens, footerInkBox, joinGapLeaders, midBlankRow, placeholderSquares, rowHeadBoxes, rowHeadDashes, rowTailBoxes, valleyRow } from "../src/ocr/engine.js"
import { inkStats, stackedGlyphBands } from "../src/ocr/line-split.js"

const W = 400, H = 600
function page(): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  const rect = (x0: number, y0: number, x1: number, y1: number) => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
  }
  rect(170, 572, 182, 574); rect(198, 566, 200, 580); rect(216, 572, 228, 574) // "-   1   -" (높이 14px = 쪽의 2.3%)
  return rgba
}

describe("footerInkBox — 검출기가 놓친 쪽 번호", () => {
  it("쪽 아래 가운데 띠의 상자 밖 잉크 외곽을 낸다", () => {
    assert.deepEqual(footerInkBox(page(), W, H, []), { x: 166, y: 562, w: 66, h: 22 })
  })
  it("이미 검출 상자에 든 잉크는 보지 않는다", () => {
    assert.equal(footerInkBox(page(), W, H, [{ x: 160, y: 560, w: 80, h: 25 }]), null)
  })
})

describe("closingParens — 서식 칸에서 멀리 떨어진 닫는 괄호", () => {
  const W2 = 300, H2 = 60
  function line(paren: boolean, rule: boolean): Uint8Array {
    const rgba = new Uint8Array(W2 * H2 * 4).fill(255)
    const dot = (x: number, y: number) => { const p = (y * W2 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    if (paren) for (let y = 20; y < 40; y++) { const x = 200 + Math.round(3 * Math.sin(((y - 20) / 19) * Math.PI)); dot(x, y); dot(x + 1, y) }
    if (rule) for (let y = 0; y < H2; y++) { dot(250, y); dot(251, y) }
    return rgba
  }
  const it0 = { text: "(전화 :", x: 20, y: 18, w: 80, h: 24, confidence: 0.99 }
  it("휜 조각 하나면 ) 를 낸다", () => {
    assert.deepEqual(closingParens(line(true, false), W2, [it0]).map(i => i.text), [")"])
  })
  it("띠 밖으로 이어지는 칸 테두리는 괄호가 아니다", () => {
    assert.deepEqual(closingParens(line(false, true), W2, [it0]), [])
  })
  it("한글 상자보다 몇 px 삐져나온 괄호도 ) 다", () => {
    const rgba = new Uint8Array(W2 * H2 * 4).fill(255)
    const dot = (x: number, y: number) => { const p = (y * W2 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    for (let y = 15; y < 45; y++) { const x = 200 + Math.round(3 * Math.sin(((y - 15) / 29) * Math.PI)); dot(x, y); dot(x + 1, y) }
    assert.deepEqual(closingParens(rgba, W2, [it0]).map(i => i.text), [")"])
  })
  it("괄호 뒤 칸 테두리·상자가 문 위 칸 가로 괘선이 있어도 ) 를 낸다", () => {
    const rgba = line(true, false)
    for (let y = 0; y < H2; y++) for (const x of [215, 216]) { const p = (y * W2 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 } // 바로 뒤 테두리
    for (let x = 0; x < 217; x++) { const p = (18 * W2 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 } // 상자 윗줄 가로 괘선
    assert.deepEqual(closingParens(rgba, W2, [it0]).map(i => i.text), [")"])
  })
})

describe("placeholderSquares — 검출기가 놓친 서식 빈칸 네모", () => {
  const W3 = 300, H3 = 80
  function page(): Uint8Array {
    const rgba = new Uint8Array(W3 * H3 * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W3 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    const box = (x: number, y: number, s: number) => { rect(x, y, x + s, y + 2); rect(x, y + s - 2, x + s, y + s); rect(x, y, x + 2, y + s); rect(x + s - 2, y, x + s, y + s) }
    box(20, 20, 20); box(44, 20, 20); rect(68, 29, 76, 32); box(80, 20, 20) // □□-□
    box(200, 20, 20) // 검출 상자 안(이미 읽은 글)
    box(150, 60, 8) // 작은 표시 네모
    return rgba
  }
  it("같은 줄 네모를 이어 □ 무리로, 막대는 - 로", () => {
    const got = placeholderSquares(page(), W3, H3, [{ text: "가", x: 195, y: 15, w: 30, h: 30, confidence: 1 }])
    assert.deepEqual(got.map(i => i.text), ["□□-□"])
  })
  it("잡티가 붙어 막대 꼴이 아닌 막대도 틈 가운데 가로 줄이면 - 로", () => {
    const rgba = page()
    for (let y = 32; y < 40; y++) { const p = (y * W3 + 70) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 } // 막대 아래로 늘어진 잡티
    assert.deepEqual(placeholderSquares(rgba, W3, H3, [{ text: "가", x: 195, y: 15, w: 30, h: 30, confidence: 1 }]).map(i => i.text), ["□□-□"])
  })
})

describe("rowTailBoxes — 줄 끝 홑 쪽 번호", () => {
  const W4 = 400, H4 = 60
  function page(extra: boolean): Uint8Array {
    const rgba = new Uint8Array(W4 * H4 * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W4 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    rect(340, 12, 343, 32) // 가는 "1"
    if (extra) rect(250, 12, 270, 32) // 다른 무리(표 칸 글)
    return rgba
  }
  const row = [{ text: "1. 사업 개요", x: 20, y: 10, w: 150, h: 24, confidence: 1 }]
  it("한글 줄 오른쪽 끝 잉크 무리 하나면 상자를 낸다", () => {
    assert.equal(rowTailBoxes(page(false), W4, row).length, 1)
  })
  it("무리가 둘이면·한글 없는 줄이면 내지 않는다", () => {
    assert.equal(rowTailBoxes(page(true), W4, row).length, 0)
    assert.equal(rowTailBoxes(page(false), W4, [{ ...row[0], text: "1. Overview" }]).length, 0)
  })
})

describe("rowHeadBoxes — 줄 머리 장 번호", () => {
  const W6 = 400, H6 = 60
  function page(rule: boolean): Uint8Array {
    const rgba = new Uint8Array(W6 * H6 * 4).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W6 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    }
    rect(60, 14, 63, 34); rect(68, 14, 71, 34); rect(76, 30, 79, 34) // "Ⅱ."
    if (rule) rect(60, 0, 63, 60) // 띠 밖으로 이어지는 세로 테두리
    return rgba
  }
  const row = [{ text: "군정 여건 및 과제", x: 120, y: 12, w: 200, h: 24, confidence: 1 }]
  it("한글 줄 앞 상자 밖 잉크 무리 하나면 높이 0.3배 여백으로 상자를 낸다", () => {
    assert.deepEqual(rowHeadBoxes(page(false), W6, row), [{ x: 54, y: 8, w: 31, h: 32 }])
  })
  it("띠 밖으로 이어지는 테두리·한글 없는 줄·이미 상자에 든 잉크는 내지 않는다", () => {
    assert.equal(rowHeadBoxes(page(true), W6, row).length, 0)
    assert.equal(rowHeadBoxes(page(false), W6, [{ ...row[0], text: "Overview" }]).length, 0)
    assert.equal(rowHeadBoxes(page(false), W6, [...row, { text: "Ⅱ.", x: 58, y: 12, w: 24, h: 24, confidence: 1 }]).length, 0)
  })
})

describe("joinGapLeaders — 상자 사이 리더로 갈린 목차 줄", () => {
  const W8 = 400, H8 = 40
  function page(dots: boolean): Uint8Array {
    const rgba = new Uint8Array(W8 * H8 * 4).fill(255)
    // 잉크 40 — 0/255 두 값뿐이면 Otsu 문턱이 0 이 되어 성분이 안 잡힌다
    const rect = (x0: number, y0: number, x1: number, y1: number) => {
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const p = (y * W8 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 40 }
    }
    rect(10, 8, 60, 32); rect(340, 8, 350, 32) // 제목·쪽 번호 글자
    if (dots) for (let x = 70; x < 330; x += 10) rect(x, 28, x + 3, 31) // 리더 점
    return rgba
  }
  const row = () => [{ text: "개요", x: 10, y: 8, w: 50, h: 24, confidence: 1 }, { text: "2", x: 340, y: 8, w: 10, h: 24, confidence: 1 }]
  it("틈을 리더 점이 덮으면 탭으로 이은 한 아이템", () => {
    assert.deepEqual(joinGapLeaders(page(true), W8, row()).map(i => i.text), ["개요\t2"])
  })
  it("틈이 비어 있으면 그대로", () => {
    assert.deepEqual(joinGapLeaders(page(false), W8, row()).map(i => i.text), ["개요", "2"])
  })
})

describe("midBlankRow — 두 줄 상자 가운데 빈 행", () => {
  const W7 = 120, H7 = 60
  function crop(gapInk: boolean): Uint8Array {
    const g = new Uint8Array(W7 * H7).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * W7 + x] = 0 }
    for (let x = 10; x < 110; x += 8) rect(x, 6, x + 3, 26) // 윗줄 글자 획
    for (let x = 10; x < 90; x += 8) rect(x, 34, x + 3, 54) // 아랫줄
    rect(2, 0, 4, 60) // 칸 세로 테두리 — 세지 않는다
    if (gapInk) rect(40, 26, 44, 34) // 두 줄을 잇는 획
    return g
  }
  it("두 줄 사이 빈 행 구간을 낸다", () => {
    const g = crop(false)
    assert.deepEqual(midBlankRow(g, W7, H7, inkStats(g)), [26, 34])
  })
  it("빈 행이 없거나 낮은 상자는 null", () => {
    const g = crop(true)
    assert.equal(midBlankRow(g, W7, H7, inkStats(g)), null)
    assert.equal(midBlankRow(g.subarray(0, W7 * 20), W7, 20, inkStats(g.subarray(0, W7 * 20))), null)
  })
})

describe("valleyRow — 맞닿은 두 줄 상자의 가를 자리", () => {
  const W = 120, H = 60
  it("빈 행 없이 획 하나만 두 줄을 이어도 잉크가 가장 적은 가운데 행을 낸다", () => {
    const g = new Uint8Array(W * H).fill(255)
    const rect = (x0: number, y0: number, x1: number, y1: number) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) g[y * W + x] = 0 }
    for (let x = 10; x < 110; x += 8) rect(x, 6, x + 3, 29)
    for (let x = 10; x < 90; x += 8) rect(x, 31, x + 3, 54)
    rect(40, 29, 42, 31)
    const cut = valleyRow(g, W, H, inkStats(g))
    assert.ok(cut && cut[0] >= 29 && cut[0] <= 30, String(cut))
  })
  it("한 줄짜리 상자(가운데도 잉크가 많음)는 null", () => {
    const g = new Uint8Array(W * H).fill(255)
    for (let y = 10; y < 50; y++) for (let x = 10; x < 110; x += 8) for (let k = 0; k < 3; k++) g[y * W + x + k] = 0
    assert.equal(valleyRow(g, W, H, inkStats(g)), null)
  })
})

describe("stackedGlyphBands — 세로로 쌓인 글자 상자", () => {
  // 여백 붙은 검출 상자 49x65 안에 21x21 글자 둘이 4px 띄워 쌓였다(표 머리 "서/울")
  const W8 = 49, H8 = 65
  function crop(glyphs: Array<[number, number, number, number]>): Uint8Array {
    const g = new Uint8Array(W8 * H8).fill(230)
    for (const [x0, y0, x1, y1] of glyphs) for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if ((x + y) % 3) g[y * W8 + x] = 0
    return g
  }
  it("글자마다 띠를 낸다", () => {
    const g = crop([[14, 10, 35, 31], [14, 35, 35, 56]])
    const bands = stackedGlyphBands(g, W8, H8, inkStats(g))
    assert.deepEqual(bands?.map(b => [b.y0, b.y1]), [[10, 31], [35, 56]])
  })
  it("한 글자·가로로 긴 잉크는 null", () => {
    const one = crop([[14, 20, 35, 41]])
    assert.equal(stackedGlyphBands(one, W8, H8, inkStats(one)), null)
    const wide = crop([[2, 10, 47, 31], [2, 35, 47, 56]])
    assert.equal(stackedGlyphBands(wide, W8, H8, inkStats(wide)), null)
  })
})

describe("rowHeadDashes — 줄 머리 대시", () => {
  const W5 = 300, H5 = 60
  function page(): Uint8Array {
    const rgba = new Uint8Array(W5 * H5 * 4).fill(255)
    for (let y = 26; y < 29; y++) for (let x = 40; x < 60; x++) { const p = (y * W5 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 }
    return rgba
  }
  it("한글로 여는 줄 앞 짧은 가로 막대는 - 아이템", () => {
    const got = rowHeadDashes(page(), W5, [{ text: "영농지원과", x: 80, y: 15, w: 120, h: 28, confidence: 1 }])
    assert.deepEqual(got.map(i => i.text), ["-"])
  })
  it("상자 테두리에 닿는 조직도 연결선은 대시가 아니다", () => {
    const rgba = page()
    for (let y = 5; y < 55; y++) for (const x of [62, 63]) { const p = (y * W5 + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 200 }
    assert.deepEqual(rowHeadDashes(rgba, W5, [{ text: "감사관", x: 80, y: 15, w: 120, h: 28, confidence: 1 }]), [])
  })
  it("한글로 열지 않는 제목(【목차】) 앞 장식 막대는 넣지 않는다", () => {
    assert.deepEqual(rowHeadDashes(page(), W5, [{ text: "【목차】", x: 80, y: 15, w: 120, h: 28, confidence: 1 }]), [])
  })
})
