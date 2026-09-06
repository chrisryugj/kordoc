/** #75 Task 2·5 — HWPX region 메타(페이지 로컬·결정적 id·parentId·SVG data 속성) + crop 픽셀 환산 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { renderHwpxToSvg } from "../src/render/index.js"
import { cropRect, extractRenderedRegions } from "../src/render/regions.js"
import { buildRenderFixture } from "./fixtures/render-fixture.js"

describe("render regions: HWPX 개체 region", () => {
  it("문단·표·이미지 region 이 페이지 로컬 pt 좌표로 나온다", async () => {
    const buf = await buildRenderFixture()
    const r = await renderHwpxToSvg(buf)
    assert.equal(r.pageCount, 2)
    const types = new Set(r.regions.map(x => x.type))
    assert.ok(types.has("paragraph") && types.has("table") && types.has("image"), [...types].join(","))
    // 2쪽 문단은 페이지 로컬 y(여백 근처) — 세로 스택 y(841.88+…) 가 아니다
    const p2 = r.regions.filter(x => x.type === "paragraph" && x.page === 2)
    assert.equal(p2.length, 1)
    assert.ok(p2[0].regions[0].y < 200, `2쪽 문단 y=${p2[0].regions[0].y}`)
    for (const reg of r.regions) for (const b of reg.regions) {
      assert.ok(b.page >= 1 && b.x >= 0 && b.y >= 0 && b.width >= 0 && b.height >= 0, JSON.stringify(b))
      assert.ok(b.y + b.height <= 842, `페이지 높이 초과 ${JSON.stringify(b)}`)
    }
  })
  it("표 bbox 가 셀 이미지를 감싸고, 이미지→문단→표 parentId 사슬·sourceId(hp:tbl id)", async () => {
    const r = await renderHwpxToSvg(await buildRenderFixture())
    const tbl = r.regions.find(x => x.type === "table")!
    const img = r.regions.find(x => x.type === "image")!
    assert.equal(tbl.sourceId, "777")
    const tb = tbl.regions[0], ib = img.regions[0]
    assert.ok(ib.x >= tb.x - 0.01 && ib.y >= tb.y - 0.01 && ib.x + ib.width <= tb.x + tb.width + 0.01 && ib.y + ib.height <= tb.y + tb.height + 0.01, `표 ${JSON.stringify(tb)} 이미지 ${JSON.stringify(ib)}`)
    // 셀 안 이미지 문단은 실문자가 없어 문단 region 이 없다 → 이미지의 부모는 표
    assert.equal(img.parentId, tbl.id)
    // 표 왼칸 텍스트 문단의 부모는 표
    const cellPara = r.regions.find(x => x.type === "paragraph" && x.parentId === tbl.id)
    assert.ok(cellPara, "셀 문단 parentId=표")
    // 표 호스트 문단은 실문자 없음 → 표의 부모 없음(최상위)
    assert.equal(tbl.parentId, undefined)
  })
  it("같은 문서 두 번 렌더 → id·bbox 동일 (결정성)", async () => {
    const buf = await buildRenderFixture()
    const a = (await renderHwpxToSvg(buf)).regions, b = (await renderHwpxToSvg(buf)).regions
    assert.deepEqual(a, b)
    assert.deepEqual(a.map(x => x.id), [...new Set(a.map(x => x.id))], "id 중복 없음")
  })
  it("SVG 에 data-kordoc-id/type/page 가 region 과 1:1", async () => {
    const r = await renderHwpxToSvg(await buildRenderFixture())
    for (const reg of r.regions) {
      const re = new RegExp(`<g data-kordoc-id="${reg.id}" data-kordoc-type="${reg.type}" data-kordoc-page="(\\d+)">`)
      const m = re.exec(r.svg)
      assert.ok(m, `${reg.id} 래퍼 없음`)
      assert.equal(Number(m![1]), reg.page)
    }
    // 열고 닫음 균형
    assert.equal((r.svg.match(/<g /g) ?? []).length, (r.svg.match(/<\/g>/g) ?? []).length)
  })
  it("이미지 없는 표·1쪽 문서도 region 은 일관", async () => {
    const r = await renderHwpxToSvg(await buildRenderFixture({ singlePage: true, noImage: true }))
    assert.equal(r.pageCount, 1)
    assert.ok(!r.regions.some(x => x.type === "image"))
    assert.equal(r.regions.filter(x => x.type === "table").length, 1)
  })
})

describe("render regions: cropRect 픽셀 환산", () => {
  it("72pt bbox @scale 2 → 144px, 원점은 floor·끝은 ceil", () => {
    assert.deepEqual(cropRect({ page: 1, x: 10, y: 20, width: 72, height: 36 }, 2, 2000, 2000), { left: 20, top: 40, width: 144, height: 72 })
  })
  it("padding 은 페이지 안으로 클램프", () => {
    assert.deepEqual(cropRect({ page: 1, x: 2, y: 2, width: 10, height: 10 }, 1, 100, 100, 5), { left: 0, top: 0, width: 17, height: 17 })
    assert.deepEqual(cropRect({ page: 1, x: 95, y: 95, width: 4, height: 4 }, 1, 100, 100, 5), { left: 90, top: 90, width: 10, height: 10 })
  })
  it("음수·페이지 밖 bbox 도 범위 안 1×1 이상", () => {
    const r = cropRect({ page: 1, x: -50, y: -50, width: 10, height: 10 }, 2, 100, 100)
    assert.ok(r.left >= 0 && r.top >= 0 && r.width >= 1 && r.height >= 1 && r.left + r.width <= 100 && r.top + r.height <= 100, JSON.stringify(r))
    const o = cropRect({ page: 1, x: 500, y: 500, width: 10, height: 10 }, 1, 100, 100)
    assert.ok(o.left + o.width <= 100 && o.top + o.height <= 100 && o.width >= 1 && o.height >= 1, JSON.stringify(o))
    const z = cropRect({ page: 1, x: 10, y: 10, width: 0, height: 0 }, 1, 100, 100)
    assert.ok(z.width >= 1 && z.height >= 1)
  })
})

describe("render regions: extractRenderedRegions (sharp)", () => {
  it("표만 자르면 표 crop 1개, 2쪽 선택은 2쪽 좌표로 자른다, png/jpeg 같은 픽셀 크기", async () => {
    const buf = await buildRenderFixture()
    const tables = await extractRenderedRegions(buf, { types: ["table"], format: "png" })
    assert.equal(tables.length, 1)
    assert.equal(tables[0].page, 1)
    assert.equal(tables[0].mimeType, "image/png")
    assert.ok(tables[0].data.length > 0 && tables[0].widthPx >= 1 && tables[0].heightPx >= 1)
    assert.equal(tables[0].data[0], 0x89, "PNG 매직")
    const p2 = await extractRenderedRegions(buf, { types: ["paragraph"], pages: [2] })
    assert.equal(p2.length, 1)
    assert.equal(p2[0].page, 2)
    assert.ok(p2[0].bbox.y < 200, "2쪽 로컬 y")
    const jpg = await extractRenderedRegions(buf, { types: ["table"], format: "jpeg" })
    assert.equal(jpg[0].mimeType, "image/jpeg")
    assert.equal(jpg[0].data[0], 0xff, "JPEG 매직")
    assert.deepEqual([jpg[0].widthPx, jpg[0].heightPx], [tables[0].widthPx, tables[0].heightPx])
  })
  it("해당 유형 없음 → 빈 배열", async () => {
    const out = await extractRenderedRegions(await buildRenderFixture({ noImage: true }), { types: ["image"] })
    assert.deepEqual(out, [])
  })
})
