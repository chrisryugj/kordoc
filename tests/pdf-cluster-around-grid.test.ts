/**
 * 선 격자 표를 사이에 둔 정렬 글 — 흐름도 상자 넷(머리띠 "[KAIST] 선발 공고" · 본문 · 바닥 날짜)에서 선 격자가 본문 줄을 가져가자,
 * 남은 머리띠 행과 바닥 날짜 행이 한 클러스터 표로 묶이고 같은 열 수라 격자 표와 이어 붙어 날짜가 본문 앞 3행에 섰다(사이버브릿지
 * 선발 절차, 쪽 그림상 날짜는 상자 맨 아래). 격자 표를 세로로 통째 품은 클러스터 후보는 표가 아니다 (page-blocks extractBlocksWithGrids)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number, w: number, fontSize = 7): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "F", isHidden: false })
const line = (x1: number, y1: number, x2: number, y2: number): LineSegment => ({ x1, y1, x2, y2, lineWidth: 0.5 })

describe("선 격자 표를 품은 클러스터 후보", () => {
  it("격자 위 머리띠와 아래 날짜 줄은 격자 표 앞뒤 글로 남는다", () => {
    const colXs = [77, 175, 275, 376, 476]
    const horizontals = [215, 204, 99].map(y => line(77, y, 476, y))
    const verticals = colXs.map(x => line(x, 99, x, 215))
    const heads = [["[KAIST]", 111], ["[학생]", 217], ["[교사]", 316], ["[KAIST]", 414]].map(([t, x]) => item(t as string, x as number, 242, 25, 6.3))
    const titles = [["선발 공고", 109], ["온라인 지원서 작성", 195], ["교사추천서 &", 302], ["심사 및 결과 공지", 398]].map(([t, x]) => item(t as string, x as number, 229, 55, 7.6))
    const body = [191.7, 182.1, 172.5].flatMap((y, r) => colXs.slice(0, 4).map((x, c) => item(`본문${r + 1}-${c + 1}`, x + 13, y, 40)))
    const dates = [["′24. 5. 13(월) 예정", 100], ["′24. 5. 13(월) ~ 6. 7(금)", 193], ["′24. 5. 13(월) ~ 6. 7(금)", 293], ["′24. 6. 10(월) ~ 6. 14(금)", 393]]
      .map(([t, x]) => item(t as string, x as number, 88, 60, 6.3))
    const blocks = extractPageBlocksWithLines([...heads, ...titles, ...body, ...dates], 2, { fnArray: [], argsArray: [] }, 595, 842, { horizontals, verticals })
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1, JSON.stringify(blocks.map(b => b.type)))
    const cellText = tables[0].table!.cells.flat().map(c => c.text).join(" ")
    assert.ok(!cellText.includes("′24"), cellText)
    // 날짜는 표 뒤에 온다
    const order = blocks.map(b => b.type === "table" ? "T" : (b.text ?? "").includes("′24") ? "D" : "P").join("")
    assert.ok(order.indexOf("T") < order.indexOf("D"), order)
  })
})
