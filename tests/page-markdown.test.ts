/**
 * 페이지별 마크다운 사영 (src/page-markdown.ts, #68) 검증.
 *
 * - 페이지 번호로 그룹핑, 페이지 순서대로 방출
 * - 번호 없는 블록은 직전 페이지에 이어붙임 (유실 금지)
 * - 관측 범위 중간의 빈 페이지도 항목으로 유지 (여러 페이지 걸친 표)
 * - 페이지 번호가 아예 없는 문서는 undefined (없는 사실을 만들지 않음)
 * - parse() 왕복: pages 합집합 = 전체 블록, pages 길이 = pageCount
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { blocksToPages } from "../src/page-markdown.js"
import type { IRBlock } from "../src/types.js"
import { markdownToHwpx, parse } from "../src/index.js"

const para = (text: string, pageNumber?: number): IRBlock =>
  pageNumber === undefined ? { type: "paragraph", text } : { type: "paragraph", text, pageNumber }

describe("blocksToPages", () => {
  it("페이지 번호로 묶고 번호 오름차순으로 낸다", () => {
    const pages = blocksToPages([para("가", 1), para("나", 2), para("다", 1)])
    assert.ok(pages)
    assert.deepEqual(pages.map(p => p.pageNumber), [1, 2])
    assert.match(pages[0].markdown, /가/)
    assert.match(pages[0].markdown, /다/)
    assert.match(pages[1].markdown, /나/)
  })

  it("번호 없는 블록은 직전 페이지에 붙어 유실되지 않는다", () => {
    const pages = blocksToPages([para("첫", 3), para("무번호"), para("둘", 4)])
    assert.ok(pages)
    assert.match(pages[0].markdown, /무번호/)
    assert.equal(pages[0].pageNumber, 3)
  })

  it("선두의 번호 없는 블록은 첫 실번호 페이지로 간다", () => {
    const pages = blocksToPages([para("머리말"), para("본문", 5)])
    assert.ok(pages)
    assert.deepEqual(pages.map(p => p.pageNumber), [5])
    assert.match(pages[0].markdown, /머리말[\s\S]*본문/)
  })

  it("관측 범위 중간의 빈 페이지도 항목으로 남긴다", () => {
    // 여러 페이지에 걸친 표는 시작 페이지 한 블록이라 중간 페이지가 실제로 빈다.
    const pages = blocksToPages([para("1쪽", 1), para("3쪽", 3)])
    assert.ok(pages)
    assert.deepEqual(pages.map(p => p.pageNumber), [1, 2, 3])
    assert.equal(pages[1].markdown, "")
  })

  it("페이지 번호가 하나도 없으면 undefined", () => {
    assert.equal(blocksToPages([para("가"), para("나")]), undefined)
    assert.equal(blocksToPages([]), undefined)
  })
})

describe("parse() 의 pages 필드", () => {
  it("생성 hwpx 왕복에서 pages 가 붙고 블록이 하나도 안 빠진다", async () => {
    const md = ["# 제목", "", "본문 문단입니다.", "", "## 소제목", "", "두 번째 문단."].join("\n")
    const hwpx = await markdownToHwpx(md)
    const result = await parse(Buffer.from(hwpx))
    assert.equal(result.success, true)
    if (!result.success) return

    assert.ok(result.pages, "pages 가 있어야 한다")
    assert.equal(result.pages.length, result.pageCount)

    // 페이지 마크다운을 합치면 전체 마크다운의 문자가 그대로 남아 있어야 한다
    const squeeze = (s: string) => s.replace(/\s+/g, "")
    assert.equal(
      squeeze(result.pages.map(p => p.markdown).join("\n\n")),
      squeeze(result.markdown),
    )
  })
})
