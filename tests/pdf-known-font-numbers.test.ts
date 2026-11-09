import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { OPS } from "../src/pdf/ops.js"
import { knownFontGlyph, knownFontPua, type GlyphOutline } from "../src/pdf/known-font-glyphs.js"
import { NO_UNICODE, readOutline, restoreUnmappedGlyphs } from "../src/pdf/symbol-glyphs.js"
import { outlineFont, outlineFontGlyphs } from "./helpers/outline-font.js"

// Haansoft Batang의 native cmap F02B1..6과 같은 수치 윤곽. 글꼴 파일은 포함하지 않는다.
const fixtures: Array<GlyphOutline & { pua: string; text: string; width: number }> = JSON.parse(readFileSync(new URL("fixtures/haansoft-number-outlines.json", import.meta.url), "utf8"))
describe("원본 문자표와 동일한 Haansoft Batang 번호", () => {
  for (const f of fixtures) it(`${f.pua}는 기존 공용 정책의 ${f.text}로 복원한다`, () => {
    const data = outlineFont(f.upm, f.contours), outline = readOutline(data, 0xe000)!
    assert.deepEqual(outline, { upm: f.upm, contours: f.contours })
    for (const name of ["Haansoft Batang", "Haansoft-Batang", "ABCDEF+Haansoft Batang"]) {
      assert.equal(knownFontGlyph(name, outline, f.width), f.text)
      const items = [{ str: NO_UNICODE, transform: [10, 0, 0, 10, 0, 0], width: 10, height: 10, fontName: "f1" }]
      restoreUnmappedGlyphs(items, [OPS.setFont, OPS.showText], [["f1", 10], [[{ unicode: NO_UNICODE, fontChar: "\ue000", width: f.width }]]], () => ({ name, data }))
      assert.equal(items[0].str, f.text)
    }
  })
  it("HCRBatang과 확인하지 않은 이름은 같은 윤곽이어도 거절한다", () => {
    for (const f of fixtures) for (const name of [undefined, "HCRBatang", "HCR Batang", "HaansoftBatang", "Haansoft Batang-Bold", "abcdef+Haansoft Batang"]) assert.equal(knownFontGlyph(name, f, f.width), null)
  })
  it("advance·upm·점 좌표·oncurve·contour 수가 달라지면 거절한다", () => {
    for (const f of fixtures) {
      assert.equal(knownFontGlyph("Haansoft Batang", f, 999), null)
      assert.equal(knownFontGlyph("Haansoft Batang", f, "1000"), null)
      for (const change of [
        (g: GlyphOutline) => { g.upm++ },
        (g: GlyphOutline) => { g.contours[0][0][0]++ },
        (g: GlyphOutline) => { g.contours[0][0][2] = !g.contours[0][0][2] },
        (g: GlyphOutline) => { g.contours.pop() },
      ]) {
        const modified = structuredClone(f); change(modified)
        assert.equal(knownFontGlyph("Haansoft Batang", modified, f.width), null)
      }
    }
  })
})

// HCRDotum 의 native cmap F02B1·F02B4·F02B9(①·④·⑨)와 같은 수치 윤곽. 글꼴 파일은 포함하지 않는다.
const dotum: Array<GlyphOutline & { pua: string; text: string; width: number }> = JSON.parse(readFileSync(new URL("fixtures/hcrdotum-number-outlines.json", import.meta.url), "utf8"))
describe("원본 문자표와 동일한 HCRDotum 번호", () => {
  for (const f of dotum) it(`${f.pua}는 기존 공용 정책의 ${f.text}로 복원한다`, () => {
    const data = outlineFont(f.upm, f.contours), outline = readOutline(data, 0xe000)!
    // HCRDotum-Bold(HANDotumB.ttf) cmap 의 번호도 윤곽·폭이 같다
    for (const name of ["HCRDotum", "ABCDEF+HCRDotum", "HCRDotum-Bold"]) {
      assert.equal(knownFontGlyph(name, outline, f.width), f.text)
      const items = [{ str: NO_UNICODE, transform: [10, 0, 0, 10, 0, 0], width: 10, height: 10, fontName: "f1" }]
      restoreUnmappedGlyphs(items, [OPS.setFont, OPS.showText], [["f1", 10], [[{ unicode: NO_UNICODE, fontChar: "\ue000", width: f.width }]]], () => ({ name, data }))
      assert.equal(items[0].str, f.text)
    }
  })
  it("다른 글꼴 이름·폭·upm·윤곽이면 거절한다", () => {
    for (const f of dotum) {
      for (const name of [undefined, "HCRDotumExt", "HCR Dotum", "HCRBatang", "Haansoft Batang"]) assert.equal(knownFontGlyph(name, f, f.width), null)
      assert.equal(knownFontGlyph("HCRDotum", f, f.width === 970 ? 959 : 970), null)
      for (const change of [
        (g: GlyphOutline) => { g.upm++ },
        (g: GlyphOutline) => { g.contours[0][0][0]++ },
        (g: GlyphOutline) => { g.contours.pop() },
      ]) {
        const modified = structuredClone(f); change(modified)
        assert.equal(knownFontGlyph("HCRDotum", modified, f.width), null)
      }
    }
  })
})

// 다른 한컴 글꼴의 native cmap 과 같은 수치 윤곽 — HCRBatang ①, Haansoft Batang ⓪·반각 │, Haansoft Dotum ③. 글꼴 파일은 포함하지 않는다.
const others: Array<GlyphOutline & { face: string; pua: string; text: string; width: number }> = JSON.parse(readFileSync(new URL("fixtures/hancom-pua-outlines.json", import.meta.url), "utf8"))
describe("원본 문자표와 동일한 다른 한컴 글꼴 기호", () => {
  for (const f of others) it(`${f.face} ${f.pua}는 기존 공용 정책의 ${f.text}로 복원한다`, () => {
    const outline = readOutline(outlineFont(f.upm, f.contours), 0xe000)!
    assert.equal(knownFontGlyph(f.face, outline, f.width), f.text)
  })
  it("굵은 글꼴은 원본 cmap 윤곽이 같은 것만 받는다", () => {
    assert.equal(knownFontGlyph("HCRBatang-Bold", others[0], others[0].width), "①")
    assert.equal(knownFontGlyph("Haansoft Dotum", others[3], others[3].width), "│") // HDotum 반각 괘선도 같은 윤곽
  })
  it("지문이 그 글꼴 cmap 에 없으면 다른 확인 글꼴 이름이어도 거절한다", () => {
    assert.equal(knownFontGlyph("HCRDotum", others[0], others[0].width), null)
    assert.equal(knownFontGlyph("Haansoft Dotum", others[1], others[1].width), null)
    assert.equal(knownFontGlyph("Haansoft Batang", others[2], others[2].width), null)
    assert.equal(knownFontGlyph("HCRBatang", others[3], others[3].width), null)
  })
})

// HCRDotum native cmap F02BA(왼쪽 "1" 네모)·F02C3(일의 자리 "0") — 원본 문서는 둘을 글자 겹치기로 ⑩ 을 만든다
const pieces: Array<GlyphOutline & { pua: string; width: number }> = JSON.parse(readFileSync(new URL("fixtures/hcrdotum-compose-pieces.json", import.meta.url), "utf8"))
describe("두 자리 번호 겹치기 조각", () => {
  it("조각을 글꼴 사설 코드로 식별한다 — 홀로 쓰이면 보이는 글(왼쪽 1 네모 ①, 일의 자리 0)", () => {
    assert.equal(knownFontPua("HCRDotum", pieces[0], pieces[0].width), 0xf02ba)
    assert.equal(knownFontGlyph("HCRDotum", pieces[0], pieces[0].width), "①")
    // 일의 자리 숫자는 원·네모 두 벌(F0292·F02C3)이 같은 윤곽이고 같은 숫자다
    assert.equal(knownFontGlyph("HCRDotum", pieces[1], pieces[1].width), "0")
  })
  it("같은 글꼴에 이어 찍힌 십의 자리 조각과 일의 자리 숫자는 한 번호로 되살린다", () => {
    const data = outlineFontGlyphs(pieces[0].upm, [pieces[0].contours, pieces[1].contours])
    const items = [{ str: NO_UNICODE + NO_UNICODE, transform: [10, 0, 0, 10, 0, 0], width: 20, height: 10, fontName: "f1" }]
    const glyphs = [{ unicode: NO_UNICODE, fontChar: "\ue000", width: pieces[0].width }, { unicode: NO_UNICODE, fontChar: "\ue001", width: pieces[1].width }]
    restoreUnmappedGlyphs(items, [OPS.setFont, OPS.showText], [["f1", 10], [glyphs]], () => ({ name: "HCRDotum", data }))
    assert.equal(items[0].str, "⑩")
  })
})
