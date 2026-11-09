import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { mapTextToCells, cellTextToString } from "../src/pdf/cell-text.js"
import type { ExtractedCell, TextItem } from "../src/pdf/line-types.js"

const cell = (col: number, x1: number, x2: number, row = 0, rowSpan = 1): ExtractedCell => ({ row, col, rowSpan, colSpan: 1, bbox: { x1, x2, y1: 100, y2: 120 } })
const glyph = (text: string, x: number, w = 11): TextItem => ({ text, x, y: 104, w, h: 11, fontSize: 11, fontName: "f" })
function mapped(items: TextItem[], a = cell(0, 86.473, 97.268), b = cell(1, 97.268, 168.869)) {
  const m = mapTextToCells(items, [a, b])
  return [cellTextToString(m.get(a)!), cellTextToString(m.get(b)!)]
}
describe("표의 독립 글머리 칸", () => {
  it("가운데점의 폭이 경계를 조금 넘쳐도 오른쪽 본문으로 옮기지 않는다", () => {
    assert.deepEqual(mapped([glyph("․", 88), glyph("중", 99), glyph("앙", 110), glyph("정", 121)]), ["․", "중앙정"])
  })
  it("폭이 같은 짧은 본문의 첫 글자도 글머리 칸으로 끌어오지 않는다", () => {
    assert.deepEqual(mapped([glyph("․", 88), glyph("공", 99), { ...glyph("공단체", 115, 33), hasSpaceBefore: true }]), ["․", "공 공단체"])
  })
  it("다른 점 모양도 독립 칸일 때 보존한다", () => {
    assert.deepEqual(mapped([glyph("•", 88), glyph("가나", 99, 22)]), ["•", "가나"])
  })
  it("실제 경계를 걸친 한글 낱말의 응집은 유지한다", () => {
    assert.deepEqual(mapped([glyph("사", 92), glyph("회", 103), glyph("적", 114)]), ["", "사회적"])
  })
  it("한 칸 안의 글머리와 본문은 같이 둔다", () => {
    assert.deepEqual(mapped([glyph("․", 100), glyph("가나", 111, 22)]), ["", "․가나"])
  })
  it("행 병합의 들여쓰기 경계에 걸친 글머리는 본문과 함께 복구한다", () => {
    const a = cell(0, 86.473, 97.268, 0, 2), b = cell(1, 97.268, 168.869, 1)
    assert.deepEqual(mapped([glyph("․", 92), glyph("가나", 103, 22)], a, b), ["", "․가나"])
  })
})

describe("따로 검출된 OCR 값 상자", () => {
  const ocr = (text: string, x: number, w: number): TextItem => ({ text, x, y: 104, w, h: 11, fontSize: 11, fontName: "ocr" })
  it("칸 경계를 조금 넘쳐도 이웃 칸 값과 한 낱말로 잇지 않는다 (연도별 비율 표 \"18.43.55.27.5\")", () => {
    const a = cell(0, 292, 317), b = cell(1, 317, 341)
    assert.deepEqual(mapped([ocr("18.4", 296, 24), ocr("3.5", 320.5, 19)], a, b), ["18.4", "3.5"])
  })

  it("시각 값도 잇지 않는다 (생활시간 표 \"0:340:32\")", () => {
    const a = cell(0, 494.8, 516.8), b = cell(1, 516.8, 538.2)
    assert.deepEqual(mapped([ocr("0:34", 497, 19), ocr("0:32", 518, 22)], a, b), ["0:34", "0:32"])
  })
})
