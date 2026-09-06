/** v4.13.0 — outline 항목 부호 확장(❑❏ㅁ→0, ◎→1, ㅡ‣▪▫→2), 영문 o/O/0 은 부호 아님 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { buildOutline } from "../src/hwpx/outline.js"

const outlineOf = (md: string) => buildOutline(parseMarkdownToBlocks(md), { gaejosik: true, consumeTitle: true, summaryFromQuote: false })
const items = (md: string) => outlineOf(md).nodes.filter((n) => n.kind === "item").map((n) => n.kind === "item" ? [n.depth, n.text] : [])

describe("outline 부호 확장", () => {
  it("❑·❏·ㅁ 는 depth 0, ◎ 는 1, ㅡ·‣·▪·▫ 는 2 — 부호는 벗겨진다", () => {
    const md = "# 제목\n\n❑ 대항목\n\n◎ 중항목\n\nㅡ 세부\n\n❏ 대항목2\n\nㅁ 대항목3\n\n‣ 세부2\n\n▪ 세부3\n\n▫ 세부4"
    assert.deepEqual(items(md), [[0, "대항목"], [1, "중항목"], [2, "세부"], [0, "대항목2"], [0, "대항목3"], [2, "세부2"], [2, "세부3"], [2, "세부4"]])
    assert.equal(outlineOf(md).hasBoxMarkers, true, "새 부호로도 개조식 자동감지")
  })
  it("기존 □/ㅇ/ㆍ 회귀 (`- ` 는 마크다운 리스트라 depth 0 항목)", () => {
    assert.deepEqual(items("# 제목\n\n□ 가\n\nㅇ 나\n\nㆍ 라"), [[0, "가"], [1, "나"], [3, "라"]])
    assert.deepEqual(items("# 제목\n\n- 다"), [[0, "다"]])
  })
  it("`- **라벨**: 값` 의 `**` 는 '* ' 참고 부호가 아니다 — 굵게 표시를 지닌 depth 0 항목", () => {
    const o = outlineOf("# 제목\n\n- **개요**: 시각 오라클 하네스 검증\n  - 세부 항목 하나\n- **일정**: 2026년 7월")
    assert.equal(o.nodes.filter((n) => n.kind === "ref").length, 0, "※ 참고로 오인 금지")
    assert.deepEqual(items("# 제목\n\n- **개요**: 시각 오라클 하네스 검증\n  - 세부 항목 하나\n- **일정**: 2026년 7월"),
      [[0, "**개요**: 시각 오라클 하네스 검증"], [1, "세부 항목 하나"], [0, "**일정**: 2026년 7월"]])
    assert.deepEqual(outlineOf("# 제목\n\n* 별표 뒤 공백은 참고").nodes.filter((n) => n.kind === "ref").map((n) => n.kind === "ref" ? n.text : ""), ["별표 뒤 공백은 참고"])
  })
  it("영문 o/O/0 선두는 부호가 아니라 서술 문단", () => {
    const o = outlineOf("# 제목\n\no 항목\n\nO 항목\n\n0 항목")
    assert.equal(o.nodes.filter((n) => n.kind === "item").length, 0)
    assert.equal(o.nodes.filter((n) => n.kind === "para").length, 3)
    assert.equal(o.hasBoxMarkers, false)
  })
})
