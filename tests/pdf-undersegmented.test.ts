import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { normalizeUndersegmentedTable } from "../src/pdf/undersegmented.js"
import type { TextItem } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number): TextItem => ({
  text, x, y, w: 35, h: 8, fontSize: 8, fontName: "test",
})

describe("PDF 표의 긴 본문 행 복원", () => {
  it("3행 표의 머리글과 첫 자료 행은 보존하고 선 없는 본문만 줄별 행으로 나눈다", () => {
    const columns = [0, 100, 200, 300]
    const original = [
      [{ text: "연도" }, { text: "2025년\n(A)" }, { text: "2026년\n(B)" }],
      [{ text: "전국" }, { text: "100" }, { text: "110" }],
      [{ text: "서울\n부산\n대구\n인천\n광주\n대전\n울산\n세종" }, { text: "1\n2\n3\n4\n5\n6\n7\n8" }, { text: "11\n12\n13\n14\n15\n16\n17\n18" }],
    ]
    const body = Array.from({ length: 8 }, (_, i) => [
      item(`지역${i}`, 10, 140 - i * 15),
      item(String(i + 1), 110, 140 - i * 15),
      item(String(i + 11), 210, 140 - i * 15),
    ]).flat()
    const result = normalizeUndersegmentedTable(original, columns, body, [200, 180, 160, 20])
    assert.equal(result?.length, 10)
    assert.deepEqual(result?.slice(0, 2), original.slice(0, 2).map(row => row.map(cell => cell.text)))
    assert.deepEqual(result?.[2], ["지역0", "1", "11"])
    assert.deepEqual(result?.[9], ["지역7", "8", "18"])
  })

  it("5행 표의 여러 긴 본문 칸을 각각 복원하고 사이의 지역 행은 보존한다", () => {
    const columns = [0, 100, 200, 300]
    const original = [
      [{ text: "지역" }, { text: "2025" }, { text: "2026" }],
      [{ text: "강원" }, { text: "20" }, { text: "21" }],
      [{ text: "춘천\n원주\n강릉\n홍천\n횡성\n철원\n양구\n고성" }, { text: "1\n2\n3\n4\n5\n6\n7\n8" }, { text: "2\n3\n4\n5\n6\n7\n8\n9" }],
      [{ text: "충북" }, { text: "30" }, { text: "31" }],
      [{ text: "청주\n충주\n제천\n보은\n옥천\n영동\n진천\n괴산" }, { text: "9\n10\n11\n12\n13\n14\n15\n16" }, { text: "10\n11\n12\n13\n14\n15\n16\n17" }],
    ]
    const body = [2, 4].flatMap((r, group) => Array.from({ length: 8 }, (_, i) => [
      item(`지역${group}-${i}`, 10, (r === 2 ? 365 : 175) - i * 15),
      item(String(i + 1), 110, (r === 2 ? 365 : 175) - i * 15),
      item(String(i + 11), 210, (r === 2 ? 365 : 175) - i * 15),
    ]).flat())
    const result = normalizeUndersegmentedTable(original, columns, body, [500, 470, 450, 230, 210, 20])
    assert.equal(result?.length, 19)
    assert.deepEqual(result?.[1], ["강원", "20", "21"])
    assert.deepEqual(result?.[10], ["충북", "30", "31"])
    assert.deepEqual(result?.at(-1), ["지역1-7", "8", "18"])
  })
})
