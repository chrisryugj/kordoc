import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { restoreGlyphs, ringAsks, ringGlyph } from "../src/ocr/glyph-restore.js"

// 160×40 상자 흰 바탕. 글자 칸 20px(stepPx 10, 칸 k 가운데 = steps 2k+1 → x 20k+15) — ocr-ring-digit 과 같은 틀
const W = 160, H = 40
function page(draw: (set: (x: number, y: number) => void) => void): Uint8Array {
  const rgba = new Uint8Array(W * H * 4).fill(255)
  draw((x, y) => { const p = (Math.round(y) * W + Math.round(x)) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 0 })
  return rgba
}
const rect = (set: (x: number, y: number) => void, x0: number, y0: number, x1: number, y1: number) => {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) set(x, y)
}
/** 칸 0 고리(가운데 15, 반지름 13) */
const ring = (set: (x: number, y: number) => void) => {
  for (let y = 7; y <= 33; y++) for (let x = 2; x <= 28; x++) { const d = Math.hypot(x - 15, y - 20); if (d <= 13 && d >= 11.5) set(x, y) }
}
/** 칸 1~3 한글 글자(높이 28) */
const hangul = (set: (x: number, y: number) => void) => { for (const k of [1, 2, 3]) rect(set, 20 * k + 10, 6, 20 * k + 28, 34) }
const box = { x: 0, y: 0, w: W, h: H }
const steps = [1, 3, 5, 7]

describe("원문자 자모·영문 — 사전에 없는 ㉠·ⓐ (수능 국어)", () => {
  it("고리 속 글자만 읽은 홀로 선 영문·자모를 원문자로", () => {
    const rgba = page(set => { ring(set); rect(set, 10, 14, 20, 26); hangul(set) })
    assert.equal(restoreGlyphs(rgba, W, box, "a방패연", steps, 10), "ⓐ방패연")
    assert.equal(restoreGlyphs(rgba, W, box, "C방패연", steps, 10), "ⓒ방패연")
    assert.equal(restoreGlyphs(rgba, W, box, "ㄴ방패연", steps, 10), "㉡방패연")
  })
  it("옅은 1px 고리도 고리다(Otsu 문턱에선 끊기는 회색 선, 수능 \"㉡그러나\")", () => {
    const rgba = page(set => { rect(set, 10, 14, 20, 26); hangul(set) })
    for (let y = 7; y <= 33; y++) for (let x = 2; x <= 28; x++) {
      const d = Math.hypot(x - 15, y - 20)
      if (d <= 13 && d >= 11.5) { const p = (y * W + x) * 4; rgba[p] = rgba[p + 1] = rgba[p + 2] = 110 }
    }
    assert.equal(restoreGlyphs(rgba, W, box, "ㄴ그러나", steps, 10), "㉡그러나")
  })
  it("고리가 없으면 그대로", () => {
    const rgba = page(set => { rect(set, 10, 14, 20, 26); hangul(set) })
    assert.equal(restoreGlyphs(rgba, W, box, "a방패연", steps, 10), "a방패연")
  })
  it("고리 자리에 글자가 없거나 ①~⑨ 로 읽힌 고리만 다시 읽고, 속 홀자모는 획 자리로 가른다", () => {
    const rgba = page(set => { ring(set); rect(set, 9, 13, 21, 15); rect(set, 19, 13, 21, 27); hangul(set) })
    const none = ringAsks(rgba, W, box, "방패연", [3, 5, 7], 10)
    assert.equal(none.length, 1)
    assert.equal(none[0].jamo, "ㄱ")
    assert.equal(ringAsks(rgba, W, box, "②방패연", steps, 10).length, 1)
    assert.equal(ringAsks(rgba, W, box, "가방패연", steps, 10).length, 0)
  })
  it("다시 읽은 원문자를 고리 자리 ①~⑨ 와 바꾸고, 빠진 자리엔 넣는다", () => {
    const rgba = page(set => { hangul(set) })
    assert.equal(restoreGlyphs(rgba, W, box, "②방패연", steps, 10, {}, [{ x0: 2, x1: 28, glyph: "ⓐ" }]), "ⓐ방패연")
    assert.equal(restoreGlyphs(rgba, W, box, "방패연", [3, 5, 7], 10, {}, [{ x0: 2, x1: 28, glyph: "㉠" }]), "㉠방패연")
  })
  it("붙은 두 원문자 — 빠진 ㉠ 을 앞 ① 뒤에 넣고, ① 고리가 그 칸을 덮어쓰지 않는다(\"①㉠:\")", () => {
    const rgba = page(set => { hangul(set) })
    const rings = [{ x0: 30, x1: 50, glyph: "㉠" }, { x0: 2, x1: 28, glyph: "①" }]
    assert.equal(restoreGlyphs(rgba, W, box, "①:다른", [1, 7, 9, 11], 10, {}, rings), "①㉠:다른")
  })
})

describe("ringGlyph — 고리 속 글자 → 원문자", () => {
  it("숫자·자모·가나다·영문", () => {
    assert.equal(ringGlyph("2"), "②")
    assert.equal(ringGlyph("ㄷ"), "㉢")
    assert.equal(ringGlyph("나"), "㉯")
    assert.equal(ringGlyph("e"), "ⓔ")
    assert.equal(ringGlyph("S"), "ⓢ")
    assert.equal(ringGlyph("B"), "Ⓑ")
  })
  it("음절·네모로 읽은 홀자모는 획 자리 판정을 쓴다(신뢰도와 상관없이)", () => {
    assert.equal(ringGlyph("그", "ㄱ", 0.3), "㉠")
    assert.equal(ringGlyph("□", "ㅁ", 0.4), "㉤")
    assert.equal(ringGlyph("그"), null)
  })
  it("이중 원 속 o·0·ㅇ 과 낮은 신뢰도는 버린다", () => {
    assert.equal(ringGlyph("o"), null)
    assert.equal(ringGlyph("0"), null)
    assert.equal(ringGlyph("x", null, 0.3), null)
  })
})
