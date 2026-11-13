import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
import { readFileSync } from "node:fs"
import { detectClusterTables, type ClusterItem } from "../src/pdf/cluster-detector.js"

const item = (text: string, x: number, y: number): ClusterItem => ({
  text, x, y, w: text.length * 4, h: 8, fontSize: 8, fontName: "body",
})

describe("borderless two-column tables", () => {
  it("recovers repeated aligned cells when their gap is below the generic threshold", () => {
    const items = [
      item("Fish species on IUCN Red List", 60, 651),
      item("Potosi Pupfish", 60, 635), item("Cyprinodon alvarezi", 132, 635),
      item("La Palma Pupfish", 60, 619), item("Cyprinodon longidorsalis", 132, 619),
      item("Butterfly Splitfin", 60, 603), item("Ameca splendens", 132, 603),
      item("Golden Skiffia", 60, 587), item("Skiffia francesae", 132, 587),
    ]
    const [result] = detectClusterTables(items, 1)
    assert.ok(result)
    assert.equal(result.table.rows, 5)
    assert.equal(result.table.cells[0][0].colSpan, 2)
    assert.equal(result.table.cells[2][1].text, "Cyprinodon longidorsalis")
  })

  it("preserves deliberately empty cells below a two-column header", () => {
    const items = [
      item("Added cation", 60, 641), item("Relative Size & Settling Rates of Floccules", 118, 641),
      item("K+", 60, 625), item("Na+", 60, 609), item("Ca2+", 60, 593),
      item("Al3+", 60, 577), item("Check", 60, 561),
    ]
    const [result] = detectClusterTables(items, 1)
    assert.ok(result)
    assert.equal(result.table.rows, 6)
    assert.equal(result.table.cells[1][0].text, "K+")
    assert.equal(result.table.cells[1][1].text, "")
  })

  it("does not turn a numeric chart axis into a table", () => {
    const items = [item("400", 113, 700), item("374", 356, 700)]
    for (let n = 350, y = 684; n >= 100; n -= 50, y -= 16) items.push(item(String(n), 113, y))
    assert.deepEqual(detectClusterTables(items, 1), [])
  })
})

describe("각주 목록", () => {
  it("쪽 아래 \"78) 제19장 … 참조\" 줄들(번호가 차례로 느는 각주)은 표가 아니다 — 본문 각주 잇기가 받는다 (task1725 209쪽)", () => {
    const items: ClusterItem[] = JSON.parse(readFileSync(new URL("./fixtures/footnote-list-items.json", import.meta.url), "utf8"))
    assert.deepEqual(detectClusterTables(items, 209), [])
  })
})

describe("borderless two-column label/value tables split into items", () => {
  it("joins item fragments into the label and value cells (LibreOffice 사업 개요 표, 쪽 전체 아이템)", () => {
    const items: ClusterItem[] = JSON.parse(readFileSync(new URL("./fixtures/label-value-borderless-items.json", import.meta.url), "utf8"))
    const table = detectClusterTables(items, 6).find(r => r.table.cols === 2)?.table
    assert.ok(table)
    assert.deepEqual(table.cells.map(r => r.map(c => c.text)), [
      ["1) 사업 방식", "학부생들의 유대감과 결속력을 위해 MT를 진행함"],
      ["2) 사업 준비 기간", "2022.10.17~2022.10.28"],
      ["3) 사업 일시", "2022.10.29~2022.10.30"],
      ["4) 사업 결산", "\\487,960"],
      ["5) 담당부서/담당자", "기획국/고은서"],
    ])
  })

  it("does not read two-column prose or a dash-filled revision column as label/value rows", () => {
    const at = (text: string, x: number, y: number, w: number): ClusterItem => ({ text, x, y, w, h: 10, fontSize: 10, fontName: "body" })
    const prose: ClusterItem[] = []
    for (let r = 0, y = 600; r < 5; r++, y -= 12) {
      prose.push(at("ing merged model", 70, y, 70), at("retains the high scores for", 143, y, 120), at("for GSM8K is 58.83, which", 310, y, 110), at("is lower than", 423, y, 60))
    }
    assert.ok(!detectClusterTables(prose, 1).some(r => r.table.cols === 2))
    const revision: ClusterItem[] = []
    for (let r = 0, y = 600; r < 4; r++, y -= 18) revision.push(at("정한 사항 외에 벤처", 70, y, 90), at("투자조합의", 163, y, 50), at("------------------------", 320, y, 150))
    assert.ok(!detectClusterTables(revision, 1).some(r => r.table.cols === 2))
  })

  it("does not split '이름표 : 값' lines at an evenly spaced label (장흥 계획 \"❍ 기    간 : 연중\")", () => {
    const at = (text: string, x: number, y: number, w: number): ClusterItem => ({ text, x, y, w, h: 12, fontSize: 12, fontName: "body" })
    const items = [
      at("❍", 70, 600, 10), at("기", 84, 600, 12), at("간", 120, 600, 12), at(": 연중", 136, 600, 40),
      at("❍", 70, 580, 10), at("대", 84, 580, 12), at("상", 120, 580, 12), at(": 산업단지 입주기업", 136, 580, 110),
      at("❍", 70, 560, 10), at("위", 84, 560, 12), at("치", 120, 560, 12), at(": 장흥농공단지 일원", 136, 560, 110),
    ]
    assert.ok(!detectClusterTables(items, 1).some(r => r.table.cols === 2))
  })
})

describe("compact statistical tables", () => {
  it("keeps two aligned rows with several labeled numeric columns as a table", () => {
    const xs = [77, 112, 150, 190, 230, 270]
    const headers = ["Accuracy", "Recall", "Precision", "F1", "Loss", "Speed"]
    const values = ["0.92", "0.88", "0.91", "0.89", "N/A", "12.4"]
    const items = xs.flatMap((x, i) => [item(headers[i], x, 442), item(values[i], x + 1, 429)])
    const [result] = detectClusterTables(items, 1)
    assert.ok(result)
    assert.equal(result.table.rows, 2)
    assert.equal(result.table.cols, 6)
    assert.equal(result.table.cells[0][0].text, "Accuracy")
    assert.equal(result.table.cells[1][5].text, "12.4")
  })

  it("leaves numbered metadata lines as prose", () => {
    const items = [
      item("2)", 78, 210), item("Preparation period", 104, 210), item("2", 220, 210), item("022.03.21-2022.04.06", 238, 210),
      item("3)", 78, 195), item("Event date", 104, 195), item("2", 220, 195), item("022.04.07", 238, 195),
    ]
    assert.deepEqual(detectClusterTables(items, 1), [])
  })
})
