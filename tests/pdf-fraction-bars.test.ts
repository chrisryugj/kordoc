/** 선으로 그은 분수 막대 → `$\frac{…}{…}$` (fraction-bars) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { foldFractionBars } from "../src/pdf/fraction-bars.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number, w: number, fontSize = 11): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "F", isHidden: false })
const hl = (x1: number, x2: number, y: number, lineWidth = 0.48): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth })
const texts = (items: NormItem[]) => [...items].sort((a, b) => b.y - a.y || a.x - b.x).map(i => i.text)

describe("foldFractionBars", () => {
  // 물환경보전법 시행규칙 [별표 8]: 막대 229.2~321.1 @626.4, 분자 기준선 628, 분모 616
  const eq = () => [item("배출량", 179, 623, 33), item("=", 215, 623, 11),
    item("할당", 234, 628, 22), item("오염부하량", 262, 628, 57), item("기준배출수질", 242, 616, 68), item("×10", 324, 623, 18)]

  it("막대 바로 위·아래의 가운데 글을 한 아이템 분수로 접고 막대를 돌려준다", () => {
    const bar = hl(229.2, 321.1, 626.4)
    const { items, bars } = foldFractionBars(eq(), [bar])
    assert.ok(bars.has(bar))
    assert.deepEqual(texts(items), ["배출량", "=", "$\\frac{\\text{할당 오염부하량}}{\\text{기준배출수질}}$", "×10"])
    assert.equal(items.find(i => i.text.startsWith("$"))!.y, 623, "기준선 = 막대 − 0.3em — 수식 앞뒤 글과 한 줄")
  })

  it("OCR 쪽은 양끝이 세로 괘선에 닿는 표 칸 rule 을 접지 않는다 — raster ruling 은 굵기로 막대와 못 가른다", () => {
    const vl = (x: number): LineSegment => ({ x1: x, y1: 600, x2: x, y2: 650, lineWidth: 0.48 })
    const md = (fontName: string, verticals: LineSegment[]) => extractPageBlocksWithLines(eq().map(i => ({ ...i, fontName })), 1, { fnArray: [], argsArray: [] }, 595, 842,
      { horizontals: [hl(229.2, 321.1, 626.4)], verticals }).map(b => b.text ?? "").join("\n")
    assert.ok(md("F", []).includes("\\frac"), md("F", []))
    assert.ok(!md("ocr", [vl(229.2), vl(321.1)]).includes("\\frac"), md("ocr", [vl(229.2), vl(321.1)]))
    // 칸 괘선에 닿지 않은 OCR 쪽 막대는 진짜 분수다(시험지 수식)
    assert.ok(md("ocr", []).includes("\\frac"), md("ocr", []))
  })

  it("분자 위첨자는 제 크기 창 밖이라도 분자로 — ｛…｝²", () => {
    const { items } = foldFractionBars([item("｛a｝", 217, 503, 160), item("2", 384, 508, 4, 7), item("측정횟수", 288, 490, 45)], [hl(212.9, 426.1, 500.5)])
    assert.deepEqual(texts(items), ["$\\frac{｛a｝^{2}}{\\text{측정횟수}}$"])
  })

  it("밑줄 아래 다음 줄(기준선 1.3em 넘게 아래)·가운데가 아닌 글·글보다 훨씬 긴 선은 분수가 아니다", () => {
    const under = [item("최종방류구별", 140, 721, 72, 12), item("다음 줄 글", 150, 703, 60, 12)]
    assert.equal(foldFractionBars(under, [hl(139.6, 313.6, 718.9)]).bars.size, 0)
    const offCenter = [item("위", 100, 628, 11), item("아래 글", 230, 616, 40)]
    assert.equal(foldFractionBars(offCenter, [hl(95, 300, 626.4)]).bars.size, 0)
    const longLine = [item("가", 200, 628, 11), item("나", 200, 616, 11)]
    assert.equal(foldFractionBars(longLine, [hl(150, 260, 626.4)]).bars.size, 0)
  })
})
