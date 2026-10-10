/**
 * 라벨탭 상자 — 상자 윗변에 걸친 제목 칩("목 차")의 세로변이 가짜 열 경계가 돼, 짧은 줄만 든 목차 상자가 3×2 표로 짜이고 칸 순서가
 * 뒤섞였다(벼·고추 재배면적조사 보도자료 목차: "□ 통계표" 가 맨 앞 칸). 칩 아래가 통째로 전폭이고 칩 줄 글이 짧은 제목뿐이면 글이다
 * (page-blocks isLabelTabBox)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
import type { LineSegment } from "../src/pdf/line-types.js"

const item = (text: string, x: number, y: number, w: number, fontSize = 15): NormItem =>
  ({ text, x, y, w, h: fontSize, fontSize, fontName: "F", isHidden: false })
const line = (x1: number, y1: number, x2: number, y2: number, lineWidth = 0.84): LineSegment => ({ x1, y1, x2, y2, lineWidth })

describe("라벨탭 상자", () => {
  it("제목 칩이 윗변에 걸친 목차 상자는 표가 아니라 위→아래 글이다", () => {
    // 벼·고추 재배면적조사 보도자료 3쪽 선 그대로 — 상자 62~533 × 60~762(윗변은 칩 좌우로 끊김), 칩 225~379 × 740.6~783.9(칠한 사각형+획)
    const horizontals = [line(224.9, 740.6, 378.9, 740.6, 1), line(224.9, 783.9, 378.9, 783.9, 1), line(224.5, 783.9, 379.3, 783.9), line(224.5, 740.6, 379.3, 740.6),
      line(61.8, 60.4, 533.5, 60.4, 1.14), line(61.8, 762.3, 225.1, 762.3, 1.14), line(378.7, 762.3, 533.5, 762.3, 1.14)]
    const verticals = [line(378.9, 740.6, 378.9, 783.9, 1), line(224.9, 740.6, 224.9, 783.9, 1), line(224.9, 740.6, 224.9, 783.9), line(378.9, 740.6, 378.9, 783.9),
      line(62.3, 59.8, 62.3, 740, 1.14), line(532.9, 59.8, 532.9, 740, 1.14), line(62.3, 740.7, 62.3, 762.8, 1.14), line(532.9, 740.7, 532.9, 762.8, 1.14)]
    const toc: Array<[string, number, number, string]> = [["□ 2026년 벼, 고추 재배면적조사 결과(요약)", 77.3, 659, "1"], ["□ 2026년 벼, 고추 재배면적조사 결과", 77.3, 587, "2"],
      ["1. 벼 재배면적", 92.5, 552, "2"], ["2. 고추 재배면적", 92.5, 518, "4"], ["□ 통계표", 77.3, 448, "6"], ["1. 연도별 벼, 고추 재배면적", 92.5, 413, "6"],
      ["2. 시도별 벼 재배면적", 92.5, 379, "7"], ["◇ 부 록", 80, 242, ""], ["◎ 7월 작물재배면적조사 개요", 85, 202, "17"], ["◎ 주요 작물재배면적 공표 일정", 85, 156, "18"]]
    const items = [item("목", 271.9, 755, 20, 20), item("차", 311.9, 755, 20, 20),
      ...toc.flatMap(([t, x, y, p]) => [item(t, x, y, t.length * 12), ...(p ? [item(p, 523 - p.length * 8, y, p.length * 8)] : [])])]
    const blocks = extractPageBlocksWithLines(items, 3, { fnArray: [], argsArray: [] }, 595, 842, { horizontals, verticals })
    assert.ok(!blocks.some(b => b.type === "table"), JSON.stringify(blocks.map(b => b.type)))
    const text = blocks.map(b => b.text ?? "").join("\n")
    const at = (s: string) => text.indexOf(s)
    assert.ok(at("목") >= 0 && at("목") < at("결과(요약)") && at("결과(요약)") < at("통계표") && at("통계표") < at("공표 일정"), text)
  })

  it("칩 줄에 열 머리가 여럿이면 그대로 표다", () => {
    const horizontals = [line(62, 783.9, 534, 783.9), line(62, 740.6, 534, 740.6), line(62, 60.4, 534, 60.4)]
    const verticals = [line(62.8, 60.4, 62.8, 783.9), line(533.3, 60.4, 533.3, 783.9), line(300, 740.6, 300, 783.9)]
    const items = [item("구분", 100, 755, 40), item("내용", 400, 755, 40), ...Array.from({ length: 5 }, (_, k) => item(`가나다라마바사아자차카타파하 항목 ${k + 1} 설명입니다`, 77, 700 - 100 * k, 440))]
    const blocks = extractPageBlocksWithLines(items, 3, { fnArray: [], argsArray: [] }, 595, 842, { horizontals, verticals })
    assert.ok(blocks.some(b => b.type === "table"), JSON.stringify(blocks.map(b => b.type)))
  })
})
