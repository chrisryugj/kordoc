import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { detectRulingLines } from "../src/ocr/ruling-lines.js"
import { verticalsStraightened } from "../src/ocr/deskew.js"

// 원근을 편 사진은 가는 가로 괘선이 쪽 폭에 걸쳐 몇 화소 기운 채 남는다(괴산 예산서 원근 판 1,200px 에 4~6px).
// scale 3 이면 두께 상한은 7px. 3px 선이 1,000px 에 5px 기울면 첫 행~끝 행 높이가 8px 라 종전에는 버렸다
const W = 1200, H = 200, SCALE = 3
function canvas(): Uint8Array { return new Uint8Array(W * H * 4).fill(255) }
function dot(g: Uint8Array, x: number, y: number) { const p = (y * W + x) * 4; g[p] = g[p + 1] = g[p + 2] = 0 }
/** x0~x1 에서 y0 부터 rise 화소 기울어 내려가는 두께 thick 선 */
function slopedLine(g: Uint8Array, x0: number, x1: number, y0: number, rise: number, thick: number) {
  for (let x = x0; x <= x1; x++) {
    const y = Math.round(y0 + ((x - x0) * rise) / (x1 - x0))
    for (let t = 0; t < thick; t++) dot(g, x, y + t)
  }
}
const longH = (g: Uint8Array, opts?: { slopeTolerant?: boolean }) =>
  detectRulingLines(g, W, H, SCALE, opts).horizontals.filter(h => h.x2 - h.x1 > 900)

describe("detectRulingLines. 원근을 편 쪽의 조금 기운 가는 괘선", () => {
  it("slopeTolerant 이면 1,000px 에 5px 기운 3px 선을 가로 괘선 하나로 낸다(두께 = 넓이 ÷ 길이)", () => {
    const g = canvas()
    slopedLine(g, 100, 1100, 80, 5, 3)
    assert.equal(longH(g).length, 0, "종전(기본값)은 높이 8px 라 버린다")
    const hs = longH(g, { slopeTolerant: true })
    assert.equal(hs.length, 1)
    assert.ok(hs[0].thicknessPx <= 3, `두께 ${hs[0].thicknessPx}`)
  })

  it("행마다 길이를 다 채운 굵은 띠(8px)는 slopeTolerant 여도 버린다", () => {
    const g = canvas()
    for (let y = 80; y < 88; y++) for (let x = 100; x <= 1100; x++) dot(g, x, y)
    assert.equal(longH(g, { slopeTolerant: true }).length, 0)
  })

  it("기울기 한도(길이의 1%)를 넘는 선은 slopeTolerant 여도 버린다", () => {
    const g = canvas()
    slopedLine(g, 100, 1100, 40, 30, 2)
    assert.equal(longH(g, { slopeTolerant: true }).length, 0)
  })
})

describe("verticalsStraightened. 편 쪽의 세로 괘선이 섰나", () => {
  it("펴기 평균각이 1° 미만일 때만 참, 펴지 않은 쪽은 거짓", () => {
    assert.equal(verticalsStraightened(undefined, 1000), false)
    assert.equal(verticalsStraightened({ cx: 500, knots: [[0, 3.5], [999, -3.3]] }, 1000), true)
    assert.equal(verticalsStraightened({ cx: 500, knots: [[0, 4.3], [999, 0.6]] }, 1000), false)
  })
})
