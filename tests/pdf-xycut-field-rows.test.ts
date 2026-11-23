/**
 * 값이 빈 입력란 줄이 두 칸으로 늘어선 서식은 두 단이 아니다 — 줄 단위(왼쪽 칸 → 오른쪽 칸)로 읽는다 (위험물 반입 신청서 web070)
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { xyCutOrder } from "../src/pdf/xy-cut.js"
import type { NormItem } from "../src/pdf/text-line.js"

const item = (text: string, x: number, y: number, w: number, fs = 10): NormItem =>
  ({ text, x, y, w, h: fs, fontSize: fs, fontName: "F1", isHidden: false })
const order = (items: NormItem[]) => xyCutOrder(items, 15).flat().map(i => i.text)

describe("PDF XY-cut 빈 입력란 두 칸", () => {
  it("쌍점으로 끝나는 왼쪽 줄과 같은 기준선의 오른쪽 입력란을 줄마다 읽는다", () => {
    const rows = [
      item("▶참가업체", 43, 752, 58), item(":", 106, 752, 3), item("▶", 271, 752, 12), item("전화번호", 283, 752, 46), item(":", 335, 752, 3),
      item("▶반입일시", 43, 735, 58), item(":", 106, 735, 3), item("▶", 271, 735, 12), item("반출일시", 283, 735, 46), item(":", 335, 735, 3),
      item("▶반입(반출)목적", 43, 718, 98), item(":", 138, 718, 3),
      item("◇ 물 품 내 역 ◇", 240, 699, 116),
    ]
    const got = order(rows)
    assert.ok(got.indexOf("전화번호") < got.indexOf("▶반입일시"), got.join("|"))
    assert.ok(got.indexOf("반출일시") < got.indexOf("▶반입(반출)목적"), got.join("|"))
  })

  it("오른쪽이 글 단이면 종전대로 두 단으로 읽는다", () => {
    const rows = [
      item("▶참가업체", 43, 752, 58), item(":", 106, 752, 3), item("Right column prose line one", 271, 752, 200),
      item("▶반입일시", 43, 735, 58), item(":", 106, 735, 3), item("Right column prose line two", 271, 735, 200),
      item("▶반입목적", 43, 718, 58), item(":", 106, 718, 3), item("Right column prose line three", 271, 718, 200),
    ]
    const got = order(rows)
    assert.ok(got.indexOf("▶반입목적") < got.indexOf("Right column prose line one"), got.join("|"))
  })
})
