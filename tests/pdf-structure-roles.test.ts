import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { isChartTable, isProseTable, isTableOfContents, tocBlock, TOC_BLOCKS } from "../src/pdf/table-roles.js"
import { demoteNonHeadingRoles } from "../src/pdf/heading-demote.js"
import { xyCutOrder } from "../src/pdf/xy-cut.js"
import { splitSingleCellTables } from "../src/pdf/text-clean.js"
import type { IRBlock, IRTable } from "../src/types.js"
import type { NormItem } from "../src/pdf/text-line.js"

const table = (rows: string[][]): IRTable => ({
  rows: rows.length, cols: rows[0].length, hasHeader: true,
  cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
})

const heading = (text: string, y: number, extra: Partial<IRBlock> = {}): IRBlock => ({
  type: "heading", level: 2, text, pageNumber: 1,
  bbox: { page: 1, x: 72, y, width: 300, height: 11 }, style: { fontSize: 11, fontName: "Title" }, ...extra,
})
const paragraph = (text: string, y: number): IRBlock => ({
  type: "paragraph", text, pageNumber: 1,
  bbox: { page: 1, x: 72, y, width: 450, height: 11 }, style: { fontSize: 11, fontName: "Body" },
})

describe("PDF table roles", () => {
  it("reads entries with growing page labels as a table of contents", () => {
    assert.equal(isTableOfContents(table([["Preface", "v"], ["About", "viii"], ["Introduction", "1"], ["Methods", "7"]])), true)
    // Numbers that fall down the column are data, not page labels.
    assert.equal(isTableOfContents(table([["Seoul", "31"], ["Busan", "12"], ["Daegu", "9"], ["Incheon", "8"]])), false)
  })

  it("takes a row holding two entries' page labels (교육청 학교 매뉴얼 목차 \"51 65\")", () => {
    assert.equal(isTableOfContents(table([["3. 사전의견 수렴", "48"], ["4. 설명회 추진 5. 추진위원회 구성", "51 65"], ["6. 학부모 설문조사", "69"]])), true)
    // 갈라 읽어도 쪽 번호가 줄면 목차가 아니다
    assert.equal(isTableOfContents(table([["가", "48"], ["나 다", "65 51"], ["라", "69"]])), false)
  })

  it("keeps contents lines in reading order", () => {
    const block = tocBlock(table([["Introduction", "1"], ["Methods", "7"], ["Results", "12"]]), 1,
      { page: 1, x: 0, y: 0, width: 100, height: 40 })
    assert.equal(block.type, "paragraph")
    assert.equal(block.text, "Introduction 1\nMethods 7\nResults 12")
    assert.ok(TOC_BLOCKS.has(block))
  })

  it("rejects wrapped prose cells but keeps a table with a short label column", () => {
    const sentence = "This sentence keeps going across the whole column because it is ordinary body prose text."
    assert.equal(isProseTable(table([[sentence, ""], [sentence, ""], [sentence, ""], ["short end", ""]])), true)
    assert.equal(isProseTable(table([
      ["procs", sentence], ["memory", sentence], ["page", sentence], ["disk", "short"],
    ])), false)
  })

  it("recognizes a value axis or a sparse grid of quantities as a chart", () => {
    assert.equal(isChartTable(table([["90\n80\n70\n60\n50", "81"], ["", "56"], ["", "47"]])), true)
    assert.equal(isChartTable(table([["2.5%", "", ""], ["", "-3.1%", ""], ["", "", "-6.4%"]])), true)
    // Phone numbers in a sparse grid are identifiers, not plotted values.
    assert.equal(isChartTable(table([["", "", "(044-201-3823)"], ["", "", "(044-201-4770)"], ["", "", "(044-201-3813)"]])), false)
    assert.equal(isChartTable(table([["Year", "Rate"], ["2012", "10%"], ["2013", "6%"], ["2014", "7%"]])), false)
    // 축 눈금 칸에 막대 값이 붙고("80 45") 아래에 가로 축 라벨이 와도 값 축이다 (ODL 038)
    assert.equal(isChartTable(table([["80 45", "1", "1"], ["60", "5", ""], ["40", "81", "73"], ["20", "51", ""], ["0", "", ""],
      ["July 2020", "October 2020", "January 2021"]])), true)
    // OCR 이 눈금 둘을 한 줄로 읽고("100% 90%"), 가로 축 연도 칸("2014 2015 …")은 눈금 위의 값이 아니다 (ODL 059)
    assert.equal(isChartTable(table([["100% 90%", "", "8%"], ["80% 70%", "", ""], ["60%", "", ""], ["50% 40%", "98%", "33%"],
      ["30% 20%", "", ""], ["10%", "", "31%"], ["0%", "", ""]])), true)
    assert.equal(isChartTable(table([["600", "", "", "506"], ["400", "232", "347", ""], ["200", "97", "", ""], ["0", "", "", ""],
      ["", "", "2014 2015 2016 2017 2018", ""], ["", "China", "", "Viet Nam Malaysia"]])), true)
  })

  it("keeps the looser axis test for a grid read by OCR from a chart image (보도자료 주택통계 그래프)", () => {
    // OCR 이 눈금과 막대 값을 한 칸에 섞고 가로 축 날짜를 한 칸에 몰았다 — 눈금 "20 15 10 5" 만 한 걸음씩 준다
    const ocrChart = table([["지역별전월세거래량", "수도권지방전국"], ["(만건)", ""], ["30", "28.0 24.4 23.1 25.4 25.3 25.3 23.4 25"],
      ["21.4 20.0 20.8 20", "21.0 21.9 2.1"], ["15", ""], ["10", ""], ["5", ""], ["", "0 25.10 25.1 ‘25.12 26.1 ’26.2 ’26.3"]])
    assert.equal(isChartTable(ocrChart, true), true)
  })

  it("does not read a data table's falling numbers as a value axis", () => {
    // 월별 건수 열 끝의 "3 2 1 0" — 열의 일부일 뿐 (korean-publang-2015)
    assert.equal(isChartTable(table([["구분", "맞춤법", "띄어쓰기"], ["4월", "7", "9"], ["5월", "4", "5"], ["6월", "2", "1"],
      ["7월", "3", "6"], ["8월", "2", "10"], ["9월", "1", "8"], ["10월", "0", "7"]])), false)
    // 내림차순 연도 열 옆 금액은 그 눈금 위의 값이 아니다 (khs-budget-2014 계속비)
    assert.equal(isChartTable(table([["연도", "예산액"], ["2018", "612,868,300"], ["2017", "1,544,362,400"],
      ["2016", "2,789,535,800"], ["2015", "3,101,587,500"]])), false)
    // 배점 열 "10.0 9.0 8.0 7.0 6.0" 옆 비율·업체 수 (hwp3-sample16 별표2)
    assert.equal(isChartTable(table([["등급", "비율", "1점", "10점"], ["탁월", "10", "1.0", "10.0"], ["우수", "20", "0.9", "9.0"],
      ["보통", "40", "0.8", "8.0"], ["다소미흡", "20", "0.7", "7.0"], ["미흡", "10", "0.6", "6.0"]])), false)
    // 빈 칸이 많아도 행마다 줄 맞춘 값은 표다 (hwpx_sample2 호봉표 — 한글 라벨에 텍스트층이 없다)
    const empty = ["", "", "", "", "", "", "", ""]
    assert.equal(isChartTable(table([["", "", "1", "2,669,354", "3,050,690", "3,432,027", "", ""],
      ["", "", "2", "4,106,389", "4,693,016", "5,279,643", "", ""], ["", "", "3", "5,717,900", "6,534,743", "7,351,586", "", ""],
      empty, empty, empty, empty, empty])), false)
  })
})

describe("PDF heading demotion", () => {
  it("returns running heads, footers, captions, numbers and sentence fragments to prose", () => {
    const blocks = [
      heading("MOHAVE COMMUNITY COLLEGE\tBIO181", 760, { bbox: { page: 1, x: 48, y: 760, width: 530, height: 14 } }),
      heading("Methods", 600),
      paragraph("Body text follows the section title and continues for a while.", 580),
      heading("Table 2: Evaluation results", 400),
      heading("responses with degrees from the survey", 380),
      heading("S = k ln W,\t(2)", 360),
      heading("14.3%", 340),
      paragraph("More body text.", 300),
      heading("Project No: 2021-2-FR02", 40),
    ]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "heading", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph", "paragraph"])
  })

  it("joins a bare section number with the title after it", () => {
    const blocks = [heading("6.", 500), heading("ECO CIRCLE FRAMEWORK", 485), paragraph("Body.", 460)]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].text, "6. ECO CIRCLE FRAMEWORK")
  })

  it("joins a widely spaced lowercase second title line still promoted as a heading (ODL 199)", () => {
    const blocks = [heading("Upstage universal OCR model E2E performance", 275), heading("evaluation1", 253), paragraph("Body.", 200)]
    demoteNonHeadingRoles(blocks, new Map([[1, 405]]))
    assert.deepEqual(blocks.map(b => [b.type, b.text]), [["heading", "Upstage universal OCR model E2E performance evaluation1"], ["paragraph", "Body."]])
  })

  it("rechecks a value label after joining the number beside it (ODL 199)", () => {
    const label = (text: string, x: number): IRBlock => ({ ...paragraph(text, 95), bbox: { page: 1, x, y: 95, width: 10, height: 6 }, style: { fontSize: 6, fontName: "Body" } })
    const blocks = [label("9", 560), heading("82.65", 95, { bbox: { page: 1, x: 579, y: 95, width: 16, height: 6 }, style: { fontSize: 6, fontName: "Body" } })]
    demoteNonHeadingRoles(blocks, new Map([[1, 405]]))
    assert.deepEqual(blocks.map(b => [b.type, b.text]), [["paragraph", "9 82.65"]])
  })

  it("treats a part title between contents entries as an entry", () => {
    const toc = (y: number) => tocBlock(table([["Section 1.1", "3"], ["Section 1.2", "5"], ["Section 1.3", "8"]]), 1,
      { page: 1, x: 72, y, width: 300, height: 40 })
    const blocks = [toc(600), heading("Part II. Chapter Two", 550), toc(480)]
    demoteNonHeadingRoles(blocks, new Map([[1, 792]]))
    assert.equal(blocks[1].type, "paragraph")
  })
})

describe("PDF narrow prose gutter", () => {
  it("splits justified columns separated by a narrow gutter", () => {
    const item = (text: string, x: number, y: number, w: number): NormItem =>
      ({ text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false })
    const items: NormItem[] = []
    for (let row = 0; row < 6; row++) {
      items.push(item(`Left column sentence number ${row} keeps going to the edge`, 95, 530 - row * 12, 226))
      items.push(item(`Right column sentence number ${row} keeps going to the edge`, 329, 530 - row * 12, 226))
    }
    const groups = xyCutOrder(items, 21.8)
    assert.equal(groups.length, 2)
    assert.ok(groups[0].every(i => i.x === 95))
    assert.ok(groups[1].every(i => i.x === 329))
  })
})

describe("PDF columns under a spanning caption", () => {
  it("sets apart a caption below both columns and reads left then right", () => {
    const item = (text: string, x: number, y: number, w: number): NormItem =>
      ({ text, x, y, w, h: 10, fontSize: 10, fontName: "Body", isHidden: false })
    const items: NormItem[] = []
    for (let row = 0; row < 6; row++) {
      items.push(item(`Left column sentence number ${row} keeps going to the edge`, 95, 710 - row * 12, 226))
      items.push(item(`Right column sentence number ${row} keeps going to the edge`, 329, 710 - row * 12, 226))
    }
    const caption = item("Figure 3.1.1: Status of operations during each survey phase (%)", 94, 630, 283)
    items.push(caption)
    const groups = xyCutOrder(items, 20)
    assert.deepEqual(groups.map(g => g.length), [6, 6, 1])
    assert.equal(groups[2][0], caption)
  })
})

describe("PDF one-cell table split", () => {
  it("keeps the caption attached to a one-cell table", () => {
    const blocks: IRBlock[] = [{ type: "table", pageNumber: 1, table: {
      rows: 1, cols: 1, hasHeader: false, caption: "Figure 6.1.2: Survey phases",
      cells: [[{ text: "80 45\n60", colSpan: 1, rowSpan: 1 }]],
    } }]
    assert.deepEqual(splitSingleCellTables(blocks).map(b => b.text), ["Figure 6.1.2: Survey phases", "80 45", "60"])
  })
})

describe("PDF staggered right-aligned lines", () => {
  it("reads a heading and the unit line under its right end in turn, not as two columns (hwpx-02)", () => {
    const item = (text: string, x: number, y: number, w: number, h: number): NormItem =>
      ({ text, x, y, w, h, fontSize: h, fontName: "Body", isHidden: false })
    const items = [
      item("1. 분기별 동향", 85, 694, 102, 15), item("(단위 : 억불)", 360, 674, 150, 10),
      item("□ 업종별 동향", 85, 620, 170, 15), item("(단위 : 억불)", 360, 601, 150, 10),
      item("□ 국가별 동향", 85, 547, 170, 15), item("(단위 : 억불)", 360, 527, 150, 10),
    ]
    const order = xyCutOrder(items, 20).flat().map(i => i.y)
    assert.deepEqual(order, [694, 674, 620, 601, 547, 527])
  })

  it("keeps a spaced-out label line whole instead of cutting between its syllables (issue1948)", () => {
    const item = (text: string, x: number, y: number, w: number): NormItem =>
      ({ text, x, y, w, h: 13, fontSize: 13, fontName: "Body", isHidden: false })
    const items = [
      item("가", 72.9, 453, 12.6), item(".", 85.5, 453, 4.1), item("일", 96.1, 453, 12.6), item("시", 134.6, 453, 12.6), item(":", 147.2, 453, 4.1), item("*****", 157.8, 453, 207),
      item("나", 72.9, 425, 12.6), item(".", 85.5, 425, 4.1), item("대", 96.1, 425, 12.6), item("상", 134.6, 425, 12.6), item(":", 147.2, 425, 4.1), item("*****", 157.6, 425, 227),
    ]
    const groups = xyCutOrder(items, 20)
    assert.ok(groups.every(g => new Set(g.map(i => i.y)).size === 1 || g.length === items.length))
    assert.ok(groups.some(g => g.some(i => i.text === "일") && g.some(i => i.text === "시")))
  })
})
