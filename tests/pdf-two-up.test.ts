/** 가로 쪽 두 쪽 모아찍기(2-up) — 왼쪽 쪽 전부 → 오른쪽 쪽 (src/pdf/two-up.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { orderTwoUpPage } from "../src/pdf/two-up.js"
import type { IRBlock } from "../src/types.js"

const W = 754, H = 555
const b = (text: string, x: number, y: number, width: number, height: number, table = false): IRBlock => table
  ? { type: "table", pageNumber: 1, table: { rows: 1, cols: 1, cells: [[{ text, colSpan: 1, rowSpan: 1 }]] }, bbox: { page: 1, x, y, width, height } }
  : { type: "paragraph", text, pageNumber: 1, bbox: { page: 1, x, y, width, height } }
const name = (x: IRBlock) => x.text ?? x.table!.cells[0][0].text

describe("orderTwoUpPage", () => {
  it("reads the left sheet before the right sheet of a landscape 2-up page", () => {
    // 오른쪽 서식 표의 윗변(y+height)이 왼쪽 서식 제목보다 높아 y 순서로는 오른쪽 표가 먼저 나왔다 (행정업무운영 편람 381쪽)
    const blocks = [b("R표", 400, 60, 330, 470, true), b("L제목", 30, 490, 330, 30), b("L표", 30, 60, 330, 420, true), b("－ 373 －", 360, 20, 40, 10)]
    assert.deepEqual(orderTwoUpPage(blocks, W, H).map(name), ["L제목", "L표", "R표", "－ 373 －"])
  })

  it("keeps blocks without a box with their neighbour and needs only one sheet to fill half the page", () => {
    // 오른쪽 쪽이 그림 위주인 보도자료 2-up — 그림·합친 문단은 자리가 없고, 오른쪽 자리 블록은 머리 표 하나뿐이다
    const img: IRBlock = { type: "image", text: "image_001.png", pageNumber: 1 }
    const merged: IRBlock = { type: "paragraph", text: "L본문", pageNumber: 1 }
    const blocks = [b("R머리", 400, 470, 330, 25, true), b("L머리", 30, 470, 330, 25, true), merged, b("L끝", 30, 60, 330, 40), img]
    assert.deepEqual(orderTwoUpPage(blocks, W, H).map(x => x.text ?? name(x)), ["L머리", "L본문", "L끝", "image_001.png", "R머리"])
  })

  it("leaves portrait pages and pages with content across the middle alone", () => {
    const blocks = [b("R", 400, 300, 300, 100), b("L", 30, 200, 300, 100)]
    assert.deepEqual(orderTwoUpPage(blocks, 595, 842).map(name), ["R", "L"])
    const wide = [...blocks, b("가로지르는 제목", 30, 500, 690, 30)]
    assert.deepEqual(orderTwoUpPage(wide, W, H).map(name), ["R", "L", "가로지르는 제목"])
  })
})
