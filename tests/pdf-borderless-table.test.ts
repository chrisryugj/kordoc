import { strict as assert } from "node:assert"
import { describe, it } from "node:test"
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
