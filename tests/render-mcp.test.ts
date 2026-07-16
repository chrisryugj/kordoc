/** render_document MCP 경로 — rasterize + 생성→렌더→PNG e2e (killer feature #1) */
import { describe, it } from "node:test"
import assert from "node:assert"
import { markdownToHwpx } from "../src/index.js"
import { renderHwpxToSvg } from "../src/render/index.js"
import { rasterizeSvg } from "../src/render/rasterize.js"

const PNG_MAGIC = "89504e47"

describe("rasterizeSvg", () => {
  it("단순 SVG → PNG 매직·크기", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100pt" height="50pt"><rect width="100%" height="100%" fill="#fff"/><text x="10" y="30">테스트</text></svg>`
    const r = await rasterizeSvg(svg, 100, 50)
    assert.equal(r.png.subarray(0, 4).toString("hex"), PNG_MAGIC)
    assert.equal(r.widthPx, 200) // scale 2 상한 (100pt × 2)
    assert.equal(r.heightPx, 100)
  })

  it("대형 캔버스는 maxWidthPx/maxHeightPx로 축소", async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="2000pt" height="20000pt"><rect width="100%" height="100%" fill="#fff"/></svg>`
    const r = await rasterizeSvg(svg, 2000, 20000, { maxWidthPx: 1400, maxHeightPx: 8000 })
    assert.ok(r.widthPx <= 1400)
    assert.ok(r.heightPx <= 8000)
  })

  it("잘못된 크기는 KordocError", async () => {
    await assert.rejects(() => rasterizeSvg("<svg/>", 0, 0), /잘못된 SVG 크기/)
  })
})

describe("render_document e2e (생성 → reflow 렌더 → PNG)", () => {
  it("markdownToHwpx 산출물이 조판 캐시 없이 렌더·래스터된다", async () => {
    const md = "# 시험 보고서\n\n1. 개요\n 가. 목적: 렌더 검증\n\n| 항목 | 값 |\n| --- | --- |\n| 상태 | 정상 |\n"
    const hwpx = await markdownToHwpx(md)
    const r = await renderHwpxToSvg(hwpx, { reflow: true, highlights: ["정상"] })
    assert.ok(r.pageCount >= 1)
    assert.ok(r.width > 0 && r.height > 0)
    assert.ok(r.svg.includes("<svg"))
    const png = await rasterizeSvg(r.svg, r.width, r.height)
    assert.equal(png.png.subarray(0, 4).toString("hex"), PNG_MAGIC)
    assert.ok(png.widthPx > 100)
  })
})
