/**
 * 벡터로 그린 막대 차트 — 막대 변이 만든 격자를 차트로 보고 값 글자를 위→아래 줄 글로 낸다(table-roles isChartTable).
 * ODL 077(ASEAN Migration Outlook 그림 1.9b) 기하 그대로: 막대 10개(fill), 눈금선 9개, 격자 왼쪽 값 축 0~400.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { chartBandGap } from "../src/pdf/xy-cut.js"
import type { NormItem } from "../src/pdf/text-line.js"

type Ops = { fn: number[]; args: unknown[][] }
const fillRect = (x: number, y: number, w: number, h: number): Ops => ({ fn: [OPS.constructPath, OPS.fill], args: [[[OPS.rectangle], [x, y, w, h]], []] })
const strokeLine = (x1: number, y1: number, x2: number, y2: number): Ops => ({ fn: [OPS.constructPath, OPS.stroke], args: [[[OPS.moveTo, OPS.lineTo], [x1, y1, x2, y2]], []] })
const concat = (...parts: Ops[]) => ({ fnArray: parts.flatMap(p => p.fn), argsArray: parts.flatMap(p => p.args) })
let seq = 0
const item = (text: string, x: number, y: number, w: number, fontSize = 10.81): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "f", isHidden: false, seq: seq++ }) as NormItem

describe("PDF 벡터 막대 차트", () => {
  const page = (extra: NormItem[] = []) => {
    const ops = concat(
      ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map(k => strokeLine(139.56, 541.9 + k * 18.03, 524.15, 541.9 + k * 18.03)),
      ...[[165.2, 68.1], [194.9, 46.6], [223.8, 36.8], [253.5, 36.8], [283.2, 8.1], [357.1, 135.4], [386.8, 119.2], [416.5, 115.6], [446.2, 121], [476, 20.6]]
        .map(([x, h]) => fillRect(x, 541.9, 23.4, h)),
    )
    const items = [
      item("Figure 1.9b. Deployment of Overseas Foreign Workers by sex, new hires only", 113.39, 721.45, 411, 12),
      item("(in thousands)", 181.41, 707.05, 75.13, 12),
      item("187", 168.59, 618.34, 17.9), item("374", 361.02, 685.69, 17.9), item("128", 198.14, 597.12, 17.9), item("331", 390.58, 670.12, 17.9),
      item("102", 227.7, 587.66, 17.9), item("319", 420.14, 665.71, 17.9), item("102", 257.26, 587.56, 17.9), item("335", 449.68, 671.72, 17.9),
      item("22", 289.52, 558.95, 12.02), item("55", 481.93, 570.84, 12.02),
      item("0", 124.09, 539.51, 6.01), item("50", 118.63, 557.53, 12.02),
      ...["100", "150", "200", "250", "300", "350", "400"].map((t, k) => item(t, 113.14, 575.56 + k * 18.025, 17.9)),
      item("Male", 224.67, 525.55, 23.41), item("Female", 412.23, 525.55, 35.39),
      item("2016", 198.87, 501.7, 23.84), item("2017", 240.58, 501.7, 23.84), item("2018", 282.3, 501.7, 23.84), item("2019", 324.01, 501.7, 23.84),
      item("2020 (to September)", 365.73, 501.7, 99.13),
      item("Source: Philippine Statistics Authority (2022)", 113.39, 480, 230, 12),
      ...extra,
    ]
    // normalizeItems(text-line.ts)가 넘기는 순서 — 위→아래, 왼→오
    return extractPageBlocksWithLines(items.sort((a, b) => b.y - a.y || a.x - b.x), 1, ops, 595.3, 841.9)
  }

  it("격자 위 끝에 걸친 막대 값(374)을 한 번만, 왼쪽 값 축과 함께 줄 순서대로 범례·출처보다 먼저 낸다 (ODL 077)", () => {
    const texts = page().map(b => b.text ?? "")
    const all = texts.join("\n")
    assert.equal(all.match(/\b374\b/g)?.length, 1, all)
    const chart = texts.findIndex(t => t.includes("331"))
    assert.equal(texts[chart], "400 374 331 335 350 319 300 250 187 200 128 150 102 102 100 55 50 22 0")
    assert.ok(chart < texts.findIndex(t => t.includes("Male")), all)
  })

  it("차트 아래 짧은 띠(축 이름·범례·출처)는 쪽 XY-Cut 틈 문턱으로 읽는다 — 띠 높이로 문턱을 다시 재면 범례 줄이 18pt 틈에서 두 단으로 갈렸다 (ODL 077)", () => {
    // 쪽 머리·꼬리 줄이 쪽 높이를 실제(31~762pt)처럼 벌려 쪽 문턱이 21.9pt 가 된다
    const texts = page([item("decline in 2020 in absolute numbers and as a percentage of 2019 deployment", 113.39, 761.59, 411, 12),
      item("ASEAN Migration Outlook", 85.04, 30.72, 173.93, 12)]).map(b => b.text ?? "")
    const order = ["Male", "Female", "2016 2017", "2020 (to September)", "Source:"].map(w => texts.findIndex(t => t.includes(w)))
    assert.ok(order.every((k, i) => k >= 0 && (i === 0 || k >= order[i - 1])), JSON.stringify(texts))
  })

  it("쪽 문턱은 차트 바로 밑 짧은 띠에만 — 차트 없는 쪽·차트에서 먼 띠·다섯 줄 넘는 무리는 종전대로 제 높이로 잰다 (rhwp 서명란·한 줄 제목)", () => {
    const chart = [{ x1: 113, x2: 524.15, y1: 541.9 }]
    const band = [item("Male", 224.67, 525.55, 23.41), item("Female", 412.23, 525.55, 35.39), item("2016", 198.87, 501.7, 23.84), item("2020 (to September)", 365.73, 501.7, 99.13)]
    assert.equal(chartBandGap(band, 21.9, chart), 21.9)
    assert.equal(chartBandGap(band, 21.9, []), 0)
    const heading = [item("타법사례", 73, 534, 58, 15), item("신용정보법", 111, 503, 73, 15), item("조의", 287, 503, 29, 15)]
    assert.equal(chartBandGap(heading, 22.2, [{ x1: 60, x2: 540, y1: 700 }]), 0)
    const tall = Array.from({ length: 5 }, (_, k) => item(`line ${k}`, 120, 525 - k * 14, 200))
    assert.equal(chartBandGap(tall, 21.9, chart), 0)
  })
})
