/**
 * 스캔 기울기 보정 (deskew.ts).
 *
 * 잠근 계약:
 *  1. estimateSkew: 가로 줄 무늬 페이지를 rotateRgba 로 기울이면 그 각도를 ±0.1° 로 되찾는다
 *     (양수 = 시계 방향 기울기 = rotateRgba 음수 각)
 *  2. deskewPage: 바로 선 페이지는 그대로(같은 버퍼, angle 0) — 클린 렌더 무보정
 *  3. deskewPage: 기울어진 페이지를 보정하면 재추정 각이 0 근처
 *  4. deskewPage: 글줄이 셋 미만이면 뾰족함 하한을 1.05 로 올린다 (#233)
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { estimateSkew, deskewPage, rotateRgba, rotateQuarter } from "../src/ocr/deskew.js"

/** 흰 페이지에 "글줄"(짧은 검은 막대 열) 여러 줄 */
function textPage(w = 600, h = 800, lines = 20, len = 1): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (let line = 0; line < lines; line++) {
    const y0 = 60 + line * 34
    for (let x = 60; x < 60 + (w - 120) * len; x++) {
      if (x % 14 > 10) continue // 글자 사이 틈
      for (let y = y0; y < y0 + 14; y++) {
        const i = (y * w + x) * 4
        rgba[i] = rgba[i + 1] = rgba[i + 2] = 0
      }
    }
  }
  return rgba
}

describe("estimateSkew / deskewPage", () => {
  it("rotateRgba 로 기울인 각을 되찾는다", () => {
    const w = 600, h = 800
    const base = textPage(w, h)
    for (const deg of [1, -2, 3]) {
      // rotateRgba 양수 = 반시계 → 페이지는 시계 방향 −deg 만큼 기운 것
      const tilted = rotateRgba(base, w, h, deg)
      const est = estimateSkew(tilted, w, h)
      assert.ok(Math.abs(est.angle - -deg) <= 0.1, `deg=${deg} est=${est.angle}`)
      assert.ok(est.gain > 1.03)
    }
  })
  it("바로 선 페이지는 무보정", () => {
    const w = 600, h = 800
    const base = textPage(w, h)
    const r = deskewPage(base, w, h)
    assert.equal(r.angle, 0)
    assert.equal(r.rgba, base, "같은 버퍼 그대로")
  })
  it("글줄 수를 센다", () => {
    assert.equal(estimateSkew(textPage(), 600, 800).lines, 20)
  })
  it("글줄이 셋 미만이면 뾰족함이 더 뚜렷해야 보정한다 (#233: 기울지 않은 두 줄 그림의 우연한 봉우리 1.03 대를 거른다)", () => {
    const w = 600, h = 800
    // 짧은 두 줄을 0.4° 기울이면 뾰족함 1.036 — 줄이 많으면 보정하는 크기지만 두 줄이면 1.05 에 못 미쳐 그대로 둔다
    const few = rotateRgba(textPage(w, h, 2, 0.5), w, h, -0.4)
    const est = estimateSkew(few, w, h)
    assert.equal(est.lines, 2)
    assert.ok(est.gain > 1.03 && est.gain < 1.05 && Math.abs(est.angle) >= 0.25, JSON.stringify(est))
    assert.equal(deskewPage(few, w, h).angle, 0)
    // 크게 기운 두 줄은 뾰족함이 뚜렷해 보정한다
    const tilted = rotateRgba(textPage(w, h, 2), w, h, -2)
    assert.ok(Math.abs(deskewPage(tilted, w, h).angle - 2) <= 0.1)
  })
  it("보정 후 재추정 각 ≈ 0", () => {
    const w = 600, h = 800
    const tilted = rotateRgba(textPage(w, h), w, h, -2)
    const r = deskewPage(tilted, w, h)
    assert.ok(Math.abs(r.angle - 2) <= 0.1, `angle=${r.angle}`)
    const again = estimateSkew(r.rgba, w, h)
    assert.ok(Math.abs(again.angle) <= 0.1, `residual=${again.angle}`)
  })
})

it("rotateQuarter turns the page a quarter like the rec crop (90 = counter-clockwise) and swaps width and height", () => {
  // 2×1 래스터: 왼쪽 검정(0), 오른쪽 흰색(255)
  const px = (v: number) => [v, v, v, 255]
  const src = new Uint8Array([...px(0), ...px(255)])
  const ccw = rotateQuarter(src, 2, 1, 90)
  assert.deepEqual([ccw.width, ccw.height], [1, 2])
  // 반시계로 돌리면 오른쪽(흰색)이 위로 간다
  assert.deepEqual([ccw.rgba[0], ccw.rgba[4]], [255, 0])
  const cw = rotateQuarter(src, 2, 1, 270)
  assert.deepEqual([cw.rgba[0], cw.rgba[4]], [0, 255])
})
