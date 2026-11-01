/** 세로쓰기 글상자 — 한 자씩 쌓은 기둥을 오른쪽부터 한 줄씩 (rhwp tbox-v-flow-01) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { joinVerticalColumns } from "../src/pdf/vertical-text.js"
import type { NormItem } from "../src/pdf/text-line.js"

const ch = (text: string, x: number, y: number): NormItem => ({ text, x, y, w: 10, h: 10, fontSize: 10, fontName: "f", isHidden: false })
const column = (text: string, x: number) => {
  const out: NormItem[] = []
  let y = 727
  for (const c of text) { if (c === " ") { y -= 5; continue } out.push(ch(c, x, y)); y -= 10 }
  return out
}

describe("joinVerticalColumns", () => {
  it("reads stacked columns right to left, keeping word gaps", () => {
    const items = [...column("죽는 날까지", 258), ...column("한 점 부끄럼", 242)]
    assert.deepEqual(joinVerticalColumns(items).map(i => i.text), ["죽는 날까지", "한 점 부끄럼"])
  })

  it("turns vertical 、。 back into the comma and period of Hangul text", () => {
    const items = [...column("한 점 없기를、", 258), ...column("나는 괴로워했다。", 242)]
    assert.deepEqual(joinVerticalColumns(items).map(i => i.text), ["한 점 없기를,", "나는 괴로워했다."])
  })

  it("keeps 、。 in non-Hangul columns", () => {
    const items = [...column("春眠 不覺曉、", 258), ...column("處處 聞啼鳥。", 242)]
    assert.deepEqual(joinVerticalColumns(items).map(i => i.text), ["春眠 不覺曉、", "處處 聞啼鳥。"])
  })

  it("leaves table columns of stacked short labels alone (row pitch wider than the letters)", () => {
    const rows = ["팀장", "대리", "팀장", "대리"]
    const items = rows.flatMap((t, r) => [...t].map((c, k) => ch(c, 400 + k * 12, 700 - r * 22)))
    assert.equal(joinVerticalColumns(items), items)
  })

  it("joins a lone spine column at the page edge, split at wide gaps (표지 책등 \"제9차 의료혁신위원회 안건\")", () => {
    const spine = [...column("제9차 의료혁신", 585), ...[..."2026․8"].map((c, k) => ch(c, 585, 300 - k * 10))]
    const out = joinVerticalColumns(spine).map(i => i.text).sort()
    assert.deepEqual(out, ["2026․8", "제9차 의료혁신"])
  })

  it("leaves a stacked number column between other text (표 번호 열)", () => {
    const nums = [..."123456"].map((c, k) => ch(c, 60, 700 - k * 14))
    const rows = nums.map(n => ({ ...ch("내용", 120, n.y), w: 20 }))
    assert.equal(joinVerticalColumns([...nums, ...rows]).length, 12)
  })
})
