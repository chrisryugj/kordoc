/** 밑줄 빈칸 — 서식 채움 빈칸을 공백 아이템으로 메워 줄이 빈칸에서 갈리지 않게 (src/pdf/blank-fills.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "../src/pdf/ops.js"
import { fillBlanks } from "../src/pdf/blank-fills.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number, w: number): NormItem => ({ text, x, y, w, h: 11, fontSize: 11, fontName: "F", isHidden: false }) as NormItem
const seg = (x1: number, x2: number, y: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 0.5 })

describe("fillBlanks", () => {
  it("widens the run before an underlined blank to its end, not a run over an underline", () => {
    const items = [item("的著作权人（Proprietor）", 92, 379, 290), item("，与海外", 479, 379, 44), item("Ganada", 146, 640, 37)]
    const out = fillBlanks(items, [seg(387.85, 478.25, 377.4), seg(145.55, 182.65, 638.8)])
    assert.deepEqual(out.items.map(b => [b.text, b.x, b.x + b.w]), [["的著作权人（Proprietor） ", 92, 478.25], ["，与海外", 479, 523], ["Ganada", 146, 183]])
    assert.deepEqual(out.horizontals.map(h => h.x1), [145.55])
  })

  it("keeps the two runs of a blank-filled line in one paragraph (kpipa 계약서 중문 실측)", () => {
    // 두 줄의 빈칸이 같은 x 띠(440~478)에 걸쳐 XY-Cut 이 그 띠를 단 사이로 잘랐다
    const items = [
      item("上述著作物（以下称“本著作物”）的著作权人（", 92, 379, 230),
      item("Proprietor", 323, 379, 48),
      item("）", 371, 379, 11),
      item("，与海外", 479, 379, 44),
      item("出版社", 72, 351, 33),
      item("(Publisher)", 105, 351, 53),
      item("对本著作物", 263, 351, 55),
      item("授权", 318, 351, 22),
      item("事宜", 340, 351, 22),
      item("达", 362, 351, 11),
      item("成如下", 373, 351, 33),
      item("协议", 406, 351, 22),
      item("：", 428, 351, 11),
      item("第一条（出版权与信息网络传播权的授予）", 72, 295, 209),
      item("①", 72, 267, 11),
      item("著作权人授予出版社有关本著作物的专有权利，其中包括：翻译成", 92, 267, 319),
      item("（语言）", 450, 267, 44),
      item("并使用", 494, 267, 33),
      item("的权力；根据合同明示的条款与方法，可在", 92, 239, 210),
      item("（国家或语言区）", 347, 239, 88),
      item("的线上、线下书店", 435, 239, 88),
      item("、", 523, 239, 11),
    ]
    const fnArray: number[] = [OPS.setLineWidth]
    const argsArray: unknown[][] = [[0.5]]
    for (const sg of [[387.85, 377.4, 478.25, 377.4], [158.25, 349.4, 262.75, 349.4], [416.5, 265.2, 449.5, 265.2], [302.1, 237.2, 346.5, 237.2]]) {
      fnArray.push(OPS.constructPath, OPS.stroke)
      argsArray.push([[OPS.moveTo, OPS.lineTo], sg], [])
    }
    const texts = extractPageBlocksWithLines(items, 1, { fnArray, argsArray }, 595, 842).map(b => b.text)
    assert.ok(texts.includes("上述著作物（以下称“本著作物”）的著作权人（Proprietor） ，与海外"), texts.join("\n"))
    assert.ok(texts.some(t => t?.includes("翻译成 （语言）并使用")), texts.join("\n"))
  })
})
