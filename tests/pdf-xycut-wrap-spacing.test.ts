import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { xyCutOrder, XY_WRAP_BANDS } from "../src/pdf/xy-cut.js"
import { groupByY, mergeLineSimple, type NormItem } from "../src/pdf/text-line.js"
import { pushLineParagraphs } from "../src/pdf/paragraph-lines.js"
import { extractPageBlocksFallback, extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { IRBlock } from "../src/types.js"

const item = (text: string, x: number, y: number, w: number, fs = 10): NormItem =>
  ({ text, x, y, w, h: fs, fontSize: fs, fontName: "F1", isHidden: false })
const paragraphs = (items: NormItem[]) => {
  const out: IRBlock[] = []
  for (const group of xyCutOrder(items, 15)) pushLineParagraphs(out, groupByY(group), 1)
  return out.map(b => b.text)
}

describe("XY-cut preserves the paragraph assembler's supported wide line pitch", () => {
  it("keeps Japanese full lines at the measured 30/31pt pitch together", () => {
    // Actual body coordinates: 10pt text at x68..538; 20/21pt empty bands are line spacing.
    const rows = [
      item("はe-フラットフォームを含めた出版市場に上記著作物を上記の言語で翻訳し出版したり、 e-Book(電子書", 68, 278, 470),
      item("籍)及びオーディオブックなどのデジタルコンテンツとして製作し、頒布及び公衆配信で販売する独占的", 68, 248, 469),
      item("な権利を付与する。", 68, 217, 100),
    ]
    assert.deepEqual(paragraphs(rows), [rows.map(r => r.text).join("")])
  })

  it("does not assemble wrap text when every horizontal gap is below the cut threshold", () => {
    let reads = 0
    const rows = [700, 678, 656].map(y => {
      const row = item("Ordinary body prose filling the line", 72, y, 450)
      Object.defineProperty(row, "text", { enumerable: true, get: () => { reads++; return "Ordinary body prose filling the line" } })
      return row
    })
    assert.equal(xyCutOrder(rows, 15).length, 1)
    assert.equal(reads, 0)
  })

  it("protects a supported wrap when the horizontal gap equals the threshold", () => {
    const rows = [item("The publisher must provide the completed", 72, 700, 450),
      item("documents and the original translation", 72, 675, 450), item("for review.", 72, 650, 100)]
    assert.deepEqual(paragraphs(rows), [rows.map(r => r.text).join(" ")])
  })

  it("retains validated parent proof even when a second cut has a higher threshold", () => {
    const rows = [item("出版社需提供完整译本并按照合同要求履行", 72, 742, 451, 11), item("约定。", 72, 714, 40, 11),
      item("本合同根据双方完整协商达成，任何合同修改、免除义务等相", 72, 602, 451, 11), item("关内容，未经双方书面同意，均不具备法律效力。", 72, 574, 242, 11)]
    const group = xyCutOrder(rows, 15)[0]
    xyCutOrder(group, 100)
    const out: IRBlock[] = []
    pushLineParagraphs(out, groupByY(group), 1)
    assert.deepEqual(out.map(b => b.text), [rows[0].text + rows[1].text])
  })

  it("preserves English word boundaries when evenly spaced prose wraps", () => {
    const rows = [item("The publisher must provide the completed", 72, 700, 450), item("documents and the original translation", 72, 670, 450), item("for review.", 72, 640, 100)]
    assert.deepEqual(paragraphs(rows), [rows.map(r => r.text).join(" ")])
  })

  it("retains measured pitch when a two-line paragraph is separated from other prose", () => {
    const first = [item("出版社需提供完整译本并按照合同要求履行", 72, 742, 451, 11), item("约定。", 72, 714, 40, 11)]
    const second = [item("本合同根据双方完整协商达成，仅对合同中的代理人具备效力。任何合同修改、免除义务等相", 72, 602, 451, 11), item("关内容，未经双方书面同意，均不具备法律效力。", 72, 574, 242, 11)]
    assert.deepEqual(paragraphs([...first, ...second]), [first.map(r => r.text).join(""), second.map(r => r.text).join("")])
  })

  it("does not advance the wrap-band cursor inside a mixed-height source row", () => {
    const tall = { ...item("先", 72, 700, 10), h: 100 }
    const rows = [tall, item("前の行の内容が右余白まで続いている", 82, 700, 440),
      item("次の行も同じ幅で続く内容である", 72, 670, 450), item("末尾の文章。", 72, 640, 100)]
    assert.equal(xyCutOrder(rows, 15).length, 1)
  })

  it("retains parent pitch through the production fallback's second XY-cut", () => {
    const rows = [item("出版社需提供完整译本并按照合同要求履行", 72, 742, 451, 11), item("约定。", 72, 714, 40, 11),
      item("本合同根据双方完整协商达成，任何合同修改、免除义务等相", 72, 602, 451, 11), item("关内容，未经双方书面同意，均不具备法律效力。", 72, 574, 242, 11)]
    const blocks = xyCutOrder(rows, 15).flatMap(group => extractPageBlocksFallback(group, 1, false, false))
    assert.deepEqual(blocks.map(b => b.text), [rows[0].text + rows[1].text, rows[2].text + rows[3].text])
  })

  it("retains parent pitch through table-first extraction and its fallback", () => {
    const rows = [item("出版社需提供完整译本并按照合同要求履行", 72, 742, 451, 11), item("约定。", 72, 714, 40, 11),
      item("本合同根据双方完整协商达成，任何合同修改、免除义务等相", 72, 602, 451, 11), item("关内容，未经双方书面同意，均不具备法律效力。", 72, 574, 242, 11),
      item("表头甲", 90, 270, 60, 11), item("表头乙", 200, 270, 60, 11),
      item("内容甲", 90, 220, 60, 11), item("内容乙", 200, 220, 60, 11)]
    const extraLines = {
      horizontals: [200, 250, 300].map(y => ({ x1: 72, y1: y, x2: 300, y2: y, lineWidth: 0.5 })),
      verticals: [72, 180, 300].map(x => ({ x1: x, y1: 200, x2: x, y2: 300, lineWidth: 0.5 })),
    }
    const blocks = extractPageBlocksWithLines(rows, 1, { fnArray: [], argsArray: [] }, 600, 800, extraLines, true)
    assert.ok(blocks.some(b => b.type === "table"))
    assert.ok(blocks.some(b => b.text === rows[0].text + rows[1].text))
    assert.ok(blocks.some(b => b.text === rows[2].text + rows[3].text))
  })

  it("rejects inherited proof after source geometry or content changes", () => {
    for (const mutation of ["position", "width", "text", "font", "extra-item"] as const) {
      const rows = [item("出版社需提供完整译本并按照合同要求履行", 72, 742, 451, 11), item("约定。", 72, 714, 40, 11),
        item("本合同根据双方完整协商达成，任何合同修改、免除义务等相", 72, 602, 451, 11), item("关内容，未经双方书面同意，均不具备法律效力。", 72, 574, 242, 11)]
      const group = xyCutOrder(rows, 15)[0]
      assert.ok(XY_WRAP_BANDS.has(group[0]))
      if (mutation === "position") group[1].y -= 10
      if (mutation === "width") group[0].w = 100
      if (mutation === "text") group[1].text = "2. New independent item"
      if (mutation === "font") group[1].fontSize = 16
      if (mutation === "extra-item") group.push(item("added", 20, 742, 40, 11))
      xyCutOrder(group, 15)
      assert.equal(XY_WRAP_BANDS.has(group[0]), false, mutation)
    }
  })

  it("keeps independent aligned TOC records across the parent wrap-band path", () => {
    const records = ["2. Complete inventory", "【Account A】", "가. Revenue inventory", "나. Expense inventory", "【Account B】"]
    const rows = records.flatMap((label, k) => {
      const x = k === 2 || k === 3 ? 92 : 78
      const y = 600 - k * 31
      return [item(label, x, y, 220, 14), item("\t", x + 224, y, 510 - x - 225, 14), item(String(11 + k * 2), 510, y, 14, 14)]
    })
    assert.deepEqual(paragraphs(rows), records.map((label, k) => label + " \t" + (11 + k * 2)))
  })

  it("keeps independent TOC records in a short-pitch leaf without fresh parent bands", () => {
    const rows = [700, 677].flatMap((y, k) => [item("Independent account " + k, 78, y, 220, 14),
      item("\t", 302, y, 207, 14), item(String(21 + k * 2), 510, y, 14, 14)])
    const blocks = extractPageBlocksFallback(rows, 1, false, false)
    assert.deepEqual(blocks.map(b => b.text), ["Independent account 0 \t21", "Independent account 1 \t23"])
  })

  it("does not reinterpret one isolated numeric suffix as a repeated TOC column", () => {
    const rows = [item("An ordinary full line of prose ending in", 72, 700, 400), item("2026", 500, 700, 24),
      item("a continuation without its own page reference", 72, 670, 452), item("and the final sentence.", 72, 640, 100)]
    const out = paragraphs(rows)
    assert.equal(out.length, 1)
    assert.ok(out[0]?.includes("2026 a continuation"))
  })

  it("keeps a wrapped TOC label that reaches its page reference on the following line", () => {
    const rows = [item("A long entry filling the available reading region", 72, 700, 452, 14),
      item("continued label", 72, 677, 210, 14), item("\t", 286, 677, 223, 14), item("31", 510, 677, 14, 14),
      item("A separate complete entry", 72, 654, 210, 14), item("\t", 286, 654, 223, 14), item("33", 510, 654, 14, 14)]
    assert.deepEqual(paragraphs(rows), ["A long entry filling the available reading region continued label \t31", "A separate complete entry \t33"])
  })

  it("keeps a completed TOC entry separate from the next wrapped label", () => {
    const rows = [item("A complete preceding entry", 78, 700, 220, 14), item("\t", 302, 700, 207, 14), item("31", 510, 700, 14, 14),
      item("A long entry filling the available reading region", 72, 677, 452, 14),
      item("continued label", 72, 654, 210, 14), item("\t", 286, 654, 223, 14), item("33", 510, 654, 14, 14),
      item("A separate complete entry", 72, 631, 210, 14), item("\t", 286, 631, 223, 14), item("35", 510, 631, 14, 14)]
    assert.deepEqual(paragraphs(rows), ["A complete preceding entry \t31", "A long entry filling the available reading region continued label \t33", "A separate complete entry \t35"])
  })

  it("does not join repeated standalone CJK labels", () => {
    const rows = [700, 672, 644, 616].map(y => item("（著作权人60% - 出版社40%）", 322, y, 159, 11))
    assert.deepEqual(paragraphs(rows), rows.map(r => r.text))
  })

  it("keeps independent numbered items and short slide titles separate", () => {
    const rows = [item("1. First independent requirement", 72, 700, 450), item("2. Second independent requirement", 72, 670, 450), item("3. Third independent requirement", 72, 640, 450)]
    assert.deepEqual(paragraphs(rows), rows.map(r => r.text))
    const titles = [item("Scope", 72, 700, 60), item("Method", 72, 670, 70), item("Results", 72, 640, 80)]
    assert.deepEqual(paragraphs(titles), titles.map(r => r.text))
  })

  it("keeps left and right columns in column order", () => {
    const rows = [700, 670, 640].flatMap((y, k) => [item("Left column line " + k, 72, y, 180), item("Right column line " + k, 330, y, 180)])
    const groups = xyCutOrder(rows, 15)
    const texts = groups.flatMap(g => groupByY(g).map(mergeLineSimple))
    assert.deepEqual(texts, ["Left column line 0", "Left column line 1", "Left column line 2", "Right column line 0", "Right column line 1", "Right column line 2"])
  })
})

describe("XY-cut narrow-element filter", () => {
  it("does not split a one-line title at a short word between its neighbours ('1-2) 폭력 대비 및 대응의 적절성')", () => {
    // 응급의료기관 평가 기준집 64쪽 실측 좌표 — "및"(11pt)을 쪽번호류로 빼면 "대비"~"대응의" 사이가 23pt 틈으로 보였다
    const row = [item("1-2)", 71, 748, 26, 13), item("폭력", 103, 748, 23, 13), item("대비", 133, 748, 23, 13),
      item("및", 162, 748, 11, 13), item("대응의", 179, 748, 34, 13), item("적절성", 220, 748, 34, 13)]
    assert.equal(xyCutOrder(row, 21).length, 1)
  })

  it("still cuts a two-column gutter blocked only by a page number on its own row", () => {
    const left = [700, 680, 660].map(y => item("왼쪽 단 본문 글줄입니다 이어지는 내용", 72, y, 200))
    const right = [700, 680, 660].map(y => item("오른쪽 단 본문 글줄입니다 이어지는 내용", 320, y, 200))
    const pageNo = item("12", 285, 620, 10)
    const groups = xyCutOrder([...left, ...right, pageNo], 15)
    assert.ok(groups.some(g => g.length === 3 && g.every(i => i.x === 72)))
  })
})

describe("side index tab glyphs leave the page text flow", () => {
  it("emits each tab glyph as its own located block and keeps the body paragraphs whole (#112)", () => {
    const tab = [..."응급의료기관평가기준집"].map((ch, k) => item(ch, 37, 700 - k * 12, 9, 9))
    const body = [
      item("○ (목 적) 기존의 응급의료기관 평가와 재지정 평가를 통합 평가 체계로 일원화함으로써", 77, 700, 460),
      item("응급의료기관", 96, 676, 71), item("평가부터", 171, 676, 47), item("시행", 222, 676, 24), item(")", 246, 676, 4),
      item("○ (평가체계)", 77, 652, 70),
      item("- 1차 년도 : 서면평가", 90, 628, 125),
      item("- 2차 년도 : 서면평가", 90, 604, 125),
    ]
    const blocks = extractPageBlocksWithLines([...tab, ...body], 1, { fnArray: [], argsArray: [] }, 595, 842, undefined, true)
    assert.deepEqual(blocks.slice(0, tab.length).map(b => [b.text, b.bbox?.x]), tab.map(t => [t.text, 37]))
    const rest = blocks.slice(tab.length)
    assert.ok(rest.every(b => b.type !== "table"))
    assert.ok(rest.every(b => !tab.some(t => b.text?.includes(t.text) && b.text.length === 1)))
  })
})

describe("XY-cut splits a far-apart pair", () => {
  it("keeps a page title and a lone bottom note in separate groups", () => {
    // 처방전 서식: 표를 뺀 나머지가 제목과 맨 아래 한 줄뿐 — 한 잎이면 그 사이 표보다 먼저 읽힌다
    const title = item("처방전", 249, 774, 91, 20), note = item("사용기간: 교부일부터 3일간", 44, 431, 304)
    assert.deepEqual(xyCutOrder([note, title], 22).map(g => g.map(i => i.text)), [["처방전"], ["사용기간: 교부일부터 3일간"]])
  })
})
