import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import type { PdfTextItem } from "../src/pdf/text-line.js"
import { NO_UNICODE, readOutline, restoreUnmappedGlyphs } from "../src/pdf/symbol-glyphs.js"
import { outlineFont } from "./helpers/outline-font.js"

// HCRDotum 원본 cmap F02EF와 PDF의 미지 CID8이 같은 네 점이다.
const contours: Array<Array<[number, number, boolean]>> = [[[485, 181, true], [346, 319, true], [485, 458, true], [624, 319, true]]]
const font = outlineFont(1000, contours)
const item = (str: string): PdfTextItem => ({ str, transform: [10, 0, 0, 10, 0, 0], width: 10, height: 10, fontName: "f1" })
function restore(name: string | undefined, widths: unknown[] = [970], data = font, text = NO_UNICODE.repeat(widths.length)) {
  const items = [item(text)]
  restoreUnmappedGlyphs(items, [OPS.setFont, OPS.showText], [["f1", 10], [widths.map(width => ({ unicode: NO_UNICODE, fontChar: "\ue000", width }))]], () => ({ name, data }))
  return items[0].str
}
describe("원본 문자표와 동일한 HCRDotum의 미지 기호", () => {
  it("실제 글꼴을 배포하지 않는 최소 TTF에서도 재현 윤곽을 정확히 읽는다", () => {
    assert.deepEqual(readOutline(font, 0xe000), { upm: 1000, contours })
  })
  it("정확한 글꼴·윤곽·advance로 F02EF를 식별하고 기존 공용 가운데점 정책을 따른다", () => {
    // HCRDotum-Bold(HANDotumB.ttf) cmap F02EF 도 같은 네 점 · advance 970 이다
    for (const name of ["HCRDotum", "ABCDEF+HCRDotum", "HCRDotum-Bold"]) assert.equal(restore(name), "·")
  })
  for (const name of [undefined, "MalgunGothic", "HCRDotumExt", "HCRDotumOther", "abcdef+HCRDotum"]) it(`${name ?? "글꼴명 없음"}은 추정으로 복원하지 않는다`, () => {
    assert.equal(restore(name), NO_UNICODE)
  })
  it("같은 fontChar라도 다른 advance에는 앞선 복원 캐시를 재사용하지 않는다", () => {
    assert.equal(restore("HCRDotum", [970, 971]), "·" + NO_UNICODE)
    assert.equal(restore("HCRDotum", [970, "970"]), "·" + NO_UNICODE)
  })
  it("upm나 한 점 좌표·곡선 위 표시가 다르면 원본 문자로 식별하지 않는다", () => {
    const moved = structuredClone(contours); moved[0][0][0]++
    const curve = structuredClone(contours); curve[0][0][2] = false
    for (const data of [outlineFont(1001, contours), outlineFont(1000, moved), outlineFont(1000, curve)]) assert.equal(restore("HCRDotum", [970], data), NO_UNICODE)
  })
  it("두 흐름의 미지 글자 수가 다르면 전체 글꼴을 보존한다", () => {
    assert.equal(restore("HCRDotum", [970], font, NO_UNICODE.repeat(2)), NO_UNICODE.repeat(2))
  })
  it("유효한 유니코드가 있는 아이템은 새 복원 경로에 넣지 않는다", () => {
    assert.equal(restore("HCRDotum", [970], font, "§Ÿ·①"), "§Ÿ·①")
  })
})
