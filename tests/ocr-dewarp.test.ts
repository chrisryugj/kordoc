/**
 * 원근 펴기 (deskew.ts estimateSkewField·dewarpRows·deskewPage) — 휴대폰으로 비스듬히 찍어 글줄 기울기가 위아래로 다른 쪽.
 *
 * 잠근 계약:
 *  1. 위아래 기울기가 다른 글줄이면 기준점을 내고, 편 뒤에는 띠마다 기울기가 0 근처다
 *  2. 고르게 기운 쪽·기울지 않은 쪽은 기준점이 없다 — 기존 회전 보정이 그대로 맡는다(deskewPage 출력 불변)
 *  3. 되돌리는 식 y₀ = y + (x − cx)·tanθ(y) 가 편 래스터 좌표를 입력 좌표로 돌린다
 *  4. 띠 각이 위→아래로 오르내리면(한 띠만 튄 쪽) 펴지 않는다 — 원근은 한쪽으로만 변한다
 *  5. 쪽 줄 묶음(pageLines)은 편 쪽에만 dewarp 를 싣는다
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { deskewPage, dewarpRows, estimateSkew, estimateSkewField, fieldAngle, linearSkewField, rotateRgba } from "../src/ocr/deskew.js"
import { pageLines } from "../src/ocr/pdf-ocr.js"

const W = 1200, H = 1600

/** 글줄 흉내 — 줄마다 굵기 6px 의 점선 막대(글자 덩어리)를 기울기 θ(y)(°, 양수 = 시계 방향으로 기움)로 긋는다 */
function page(theta: (y: number) => number): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  for (let base = 60; base < H - 60; base += 40) {
    const t = Math.tan((theta(base) * Math.PI) / 180)
    for (let x = 80; x < W - 80; x++) {
      if (x % 30 > 22) continue // 글자 사이 틈
      const yc = base + (x - (W - 1) / 2) * t
      for (let dy = 0; dy < 6; dy++) {
        const y = Math.round(yc + dy)
        if (y < 0 || y >= H) continue
        const o = (y * W + x) * 4
        rgba[o] = rgba[o + 1] = rgba[o + 2] = 0
      }
    }
  }
  return rgba
}

/** 띠(쪽 높이 1/4)마다 기울기 */
const bandAngles = (rgba: Uint8Array) => [0, 1, 2, 3].map(k => {
  const y0 = Math.floor((k * H) / 4), bh = Math.floor(H / 4)
  return estimateSkew(rgba.subarray(y0 * W * 4, (y0 + bh) * W * 4), W, bh).angle
})

describe("원근 펴기", () => {
  // 위 +2.5° 에서 아래 −1° 로 — 실측 사진(위 띠 +2.6°·아래 띠 −0.7°)과 같은 꼴
  const keystone = (y: number) => 2.5 - 3.5 * (y / H)

  it("위아래 기울기가 다른 글줄이면 기준점을 내고, 편 뒤에는 띠마다 0 근처", () => {
    const rgba = page(keystone)
    const before = bandAngles(rgba)
    assert.ok(Math.max(...before) - Math.min(...before) > 2, `펴기 전 띠 각 ${before}`)
    const f = estimateSkewField(rgba, W, H)
    assert.ok(f, "기준점")
    assert.ok(f!.knots.length >= 2)
    for (const [y, a] of f!.knots) assert.ok(Math.abs(a - keystone(y)) < 0.5, `y ${y} 의 각 ${a} ≈ ${keystone(y).toFixed(2)}`)
    const after = bandAngles(dewarpRows(rgba, W, H, f!))
    for (const a of after) assert.ok(Math.abs(a) <= 0.4, `편 뒤 띠 각 ${after}`)
  })

  it("기울기가 높이에 따라 고르게 변하면 한 직선 펴기는 쪽 위아래 끝까지 맞는다(끝 띠 각에 머물지 않는다)", () => {
    // 오른쪽 변을 8% 줄인 사다리꼴과 같은 꼴. 위 +3.2° 에서 아래 −3.2°
    const steep = (y: number) => 3.2 - 6.4 * (y / H)
    const pw = estimateSkewField(page(steep), W, H)
    assert.ok(pw, "기준점")
    const f = linearSkewField(pw!, H)
    assert.ok(f, "한 직선")
    for (const y of [0, H - 1]) assert.ok(Math.abs(fieldAngle(f!, y) - steep(y)) < 0.5, `y ${y} 의 각 ${fieldAngle(f!, y).toFixed(2)} ≈ ${steep(y).toFixed(2)}`)
  })

  it("고르게 기운 쪽·기울지 않은 쪽은 기준점이 없고 deskewPage 는 종전대로 회전(또는 그대로)", () => {
    const flat = page(() => 0)
    assert.equal(estimateSkewField(flat, W, H), null)
    const d0 = deskewPage(flat, W, H)
    assert.equal(d0.rgba, flat)
    assert.equal(d0.angle, 0)
    assert.equal(d0.dewarp, undefined)
    const tilted = page(() => 1.5)
    assert.equal(estimateSkewField(tilted, W, H), null)
    const d1 = deskewPage(tilted, W, H)
    assert.equal(d1.dewarp, undefined)
    assert.ok(Math.abs(d1.angle - 1.5) < 0.2, `회전각 ${d1.angle}`)
    assert.deepEqual(d1.rgba, rotateRgba(tilted, W, H, d1.angle))
  })

  it("deskewPage 는 원근 쪽을 회전 대신 펴고 기준점을 싣는다 — 되돌리는 식으로 입력 좌표가 나온다", () => {
    const rgba = page(keystone)
    const d = deskewPage(rgba, W, H)
    assert.equal(d.angle, 0)
    assert.ok(d.dewarp)
    // 입력에서 막대 위 한 점(줄 기준선 y=460, x=200)이 편 래스터의 어디로 갔는지 찾고, 되돌리는 식으로 다시 입력 좌표를 구한다
    const f = d.dewarp!, x = 200, base = 460, yIn = Math.round(base + (x - (W - 1) / 2) * Math.tan((keystone(base) * Math.PI) / 180)) + 3
    let yOut = -1
    for (let y = 0; y < H && yOut < 0; y++) if (Math.abs(y + (x - f.cx) * Math.tan((fieldAngle(f, y) * Math.PI) / 180) - yIn) < 0.5) yOut = y
    assert.ok(yOut >= 0)
    const o = (yOut * W + x) * 4
    assert.ok(d.rgba[o] < 128, "편 래스터의 그 자리도 잉크")
  })

  it("원근에 회전이 겹친 쪽은 먼저 돌리고 남은 원근을 편다(deskewAngle 과 dewarp 둘 다 싣는다)", () => {
    // 원근 쪽을 4° 더 돌린 꼴. 행마다 세로로 미는 펴기만으로는 4° 넘는 기울기에서 글자 획이 비스듬히 남는다
    const rgba = rotateRgba(page(keystone), W, H, -4)
    const d = deskewPage(rgba, W, H)
    assert.ok(Math.abs(d.angle - 4.75) < 0.5, `회전각 ${d.angle}`)
    assert.ok(d.dewarp, "남은 원근 펴기")
    for (const a of bandAngles(d.rgba)) assert.ok(Math.abs(a) <= 0.5, `편 뒤 띠 각 ${bandAngles(d.rgba)}`)
  })

  it("띠 각이 위→아래로 오르내리면 펴지 않는다", () => {
    // 위·아래는 0°, 가운데 띠만 2° — 도장·큰 제목 띠 하나가 튄 꼴
    const zigzag = page(y => (y > H * 0.35 && y < H * 0.65 ? 2 : 0))
    assert.equal(estimateSkewField(zigzag, W, H), null)
  })

  it("쪽 줄 묶음은 편 쪽에만 dewarp 를 싣는다", () => {
    const dewarp = { cx: 599.5, knots: [[100, 1.5], [900, -0.5]] as Array<[number, number]> }
    assert.deepEqual(pageLines(1, W, H, 3, 0, [], [], false, dewarp).dewarp, dewarp)
    assert.equal("dewarp" in pageLines(1, W, H, 3, 0, []), false)
  })
})
