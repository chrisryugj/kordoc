/**
 * 스캔 기울기 보정 (deskew.ts).
 *
 * 잠근 계약:
 *  1. estimateSkew: 가로 줄 무늬 페이지를 rotateRgba 로 기울이면 그 각도를 ±0.1° 로 되찾는다
 *     (양수 = 시계 방향 기울기 = rotateRgba 음수 각)
 *  2. deskewPage: 바로 선 페이지는 그대로(같은 버퍼, angle 0) — 클린 렌더 무보정
 *  3. deskewPage: 기울어진 페이지를 보정하면 재추정 각이 0 근처
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { estimateSkew, deskewPage, rotateRgba } from "../src/ocr/deskew.js"

/** 흰 페이지에 "글줄"(짧은 검은 막대 열) 여러 줄 */
function textPage(w = 600, h = 800): Uint8Array {
  const rgba = new Uint8Array(w * h * 4).fill(255)
  for (let line = 0; line < 20; line++) {
    const y0 = 60 + line * 34
    for (let x = 60; x < w - 60; x++) {
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
  it("보정 후 재추정 각 ≈ 0", () => {
    const w = 600, h = 800
    const tilted = rotateRgba(textPage(w, h), w, h, -2)
    const r = deskewPage(tilted, w, h)
    assert.ok(Math.abs(r.angle - 2) <= 0.1, `angle=${r.angle}`)
    const again = estimateSkew(r.rgba, w, h)
    assert.ok(Math.abs(again.angle) <= 0.1, `residual=${again.angle}`)
  })
})
