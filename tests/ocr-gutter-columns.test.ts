/** OCR 괘선 표의 빈칸 열 — 묶음 경계에만 세로선을 그은 통계표에서 묶음 안 열을 가상 세로선으로 가른다 (src/pdf/ocr-gutter-columns.ts) */

import { it } from "node:test"
import assert from "node:assert/strict"
import { ocrGutterVerticals, splitItemsAcrossColumns, splitItemsAtGutters } from "../src/pdf/ocr-gutter-columns.js"
import { rememberOcrTextGaps } from "../src/ocr/text-gaps.js"
import type { TableGrid } from "../src/pdf/line-types.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y: number, w: number, gaps: Array<[number, number, number]> = []): NormItem => {
  const it: NormItem = { text, x, y, w, h: 10, fontSize: 11, fontName: "ocr", isHidden: false }
  rememberOcrTextGaps(it, gaps.map(([at, left, right]) => ({ at, left, right })))
  return it
}

// 한 열(0~300) 격자: 머리 행(180~200)에 묶음 제목, 본문 행(0~180)에 세 값이 빈 구간으로 갈린 글줄 셋
const grid = (): TableGrid => ({ colXs: [0, 300], rowYs: [200, 180, 0], bbox: { x1: 0, y1: 0, x2: 300, y2: 200 }, vertexRadius: 1 })
const row = (y: number) => item("0.64 84.8 -107", 20, y, 260, [[4, 90, 120], [9, 190, 220]])

it("cuts the value gaps shared by body lines below a spanning group title (시도별 장래인구추계 가정치)", () => {
  const g = grid()
  const items = [item("중위 추계", 60, 185, 180), row(150), row(120), row(90)]
  const lines = ocrGutterVerticals([g], items).get(g) ?? []
  assert.deepEqual(lines.map(l => [Math.round(l.x1), l.y1, l.y2]).sort((a, b) => a[0] - b[0]), [[105, 0, 180], [205, 0, 180]])
  // 상자는 선 자리 빈 구간에서 쪼갠다
  assert.deepEqual(splitItemsAtGutters([row(150)], lines).map(it => it.text), ["0.64", "84.8", "-107"])
})

it("does not cut prose or a single numeric line", () => {
  const g = grid()
  const prose = [150, 120, 90].map(y => item("인구 성장 추이", 20, y, 260, [[2, 90, 120], [5, 190, 220]]))
  assert.equal(ocrGutterVerticals([g], prose).size, 0)
  assert.equal(ocrGutterVerticals([g], [row(150)]).size, 0)
})

it("skips a frame grid that holds another grid (쪽 테두리 상자)", () => {
  const inner = grid()
  const frame: TableGrid = { colXs: [-50, 350], rowYs: [400, -50], bbox: { x1: -50, y1: -50, x2: 350, y2: 400 }, vertexRadius: 1 }
  const items = [row(150), row(120), row(90)]
  const out = ocrGutterVerticals([frame, inner], items)
  assert.equal(out.has(frame), false)
  assert.equal(out.has(inner), true)
})

it("splits an OCR box spanning grid columns into one value per column (\"0.50.71.0\", \"7.4 10.3\")", () => {
  const g: TableGrid = { colXs: [0, 50, 100, 150], rowYs: [100, 0], bbox: { x1: 0, y1: 0, x2: 150, y2: 100 }, vertexRadius: 1 }
  const out = splitItemsAcrossColumns([item("0.50.71.0", 10, 50, 130), item("7.4 10.3", 60, 20, 80), item("합계 비율", 10, 80, 130)], [g])
  assert.deepEqual(out.map(it => it.text), ["0.5", "0.7", "1.0", "7.4", "10.3", "합계 비율"])
  // 값마다 그 열 안에 놓인다
  assert.deepEqual(out.slice(0, 3).map(it => Math.floor((it.x + it.w / 2) / 50)), [0, 1, 2])
})

it("cuts a value from its bracketed share beside it (\"3,193 (1.7)\" — 구성비·증감률 열)", () => {
  const g = grid()
  const share = (y: number) => item("3,193 (1.7)", 20, y, 260, [[5, 120, 170]])
  const items = [share(150), share(120), share(90)]
  const lines = ocrGutterVerticals([g], items).get(g) ?? []
  assert.equal(lines.length, 1)
  assert.deepEqual(splitItemsAtGutters([share(150)], lines).map(it => it.text), ["3,193", "(1.7)"])
})

it("a spaced header word over the value gap blocks the header row (\"자기 집\" 두 열 걸침 머리)", () => {
  const g = grid()
  const share = (y: number) => item("3,193 (1.7)", 20, y, 260, [[5, 120, 170]])
  const items = [item("자기 집", 100, 185, 100, [[2, 136, 145]]), share(150), share(120), share(90)]
  const lines = ocrGutterVerticals([g], items).get(g) ?? []
  assert.deepEqual(lines.map(l => [l.y1, l.y2]), [[0, 180]])
})

it("column headers standing apart over their own columns do not block the cut (\"제조업  서비스\")", () => {
  const g = grid()
  const share = (y: number) => item("3,193 (1.7)", 20, y, 260, [[5, 120, 170]])
  const items = [item("제조업 서비스", 40, 185, 220, [[3, 100, 190]]), share(150), share(120), share(90)]
  const lines = ocrGutterVerticals([g], items).get(g) ?? []
  assert.deepEqual(lines.map(l => [l.y1, l.y2]), [[0, 200]])
})

it("splits glued thousands-grouped integers across the columns they span (\"7,3022,6071,364\")", () => {
  const g: TableGrid = { colXs: [0, 50, 100, 150, 200], rowYs: [100, 0], bbox: { x1: 0, y1: 0, x2: 200, y2: 100 }, vertexRadius: 1 }
  const out = splitItemsAcrossColumns([item("7,3022,6071,36410,563", 10, 50, 180), item("1,364,123 5", 10, 20, 130)], [g])
  assert.deepEqual(out.map(it => it.text).slice(0, 4), ["7,302", "2,607", "1,364", "10,563"])
  // 쉼표 정수가 열 수와 맞지 않으면 그대로
  assert.equal(out[4].text, "1,364,123 5")
})

it("cuts a gap that both body lines of a two-row table share, but not one of two lines (연평균 증감률 도심 | 도시클러스터)", () => {
  const g = grid()
  const pair = (y: number) => item("1.3 -1.0", 20, y, 260, [[3, 90, 190]])
  assert.deepEqual((ocrGutterVerticals([g], [pair(150), pair(120)]).get(g) ?? []).map(l => Math.round(l.x1)), [140])
  // 두 줄 가운데 한 줄만 비운 틈은 우연이다
  assert.equal(ocrGutterVerticals([g], [pair(150), item("12.5", 20, 120, 60)]).size, 0)
})
