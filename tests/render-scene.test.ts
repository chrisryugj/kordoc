/** #75 Task 1 — RenderScene 계약: 1-based 페이지, 페이지 로컬 bbox, 결정적 id, 다중 페이지 조각 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { regionId, unionBBox, RegionCollector, type RenderScene, type PageBBox } from "../src/render/scene.js"

describe("render scene: id·bbox 계약", () => {
  it("regionId 는 유형-6자리 일련번호", () => {
    assert.equal(regionId("table", 17), "table-000017")
    assert.equal(regionId("paragraph", 1), "paragraph-000001")
    assert.equal(regionId("image", 123456), "image-123456")
  })
  it("RegionCollector — 유형별 카운터, 같은 순서면 같은 id", () => {
    const mk = () => { const c = new RegionCollector(); c.add("paragraph", { page: 1, x: 0, y: 0, width: 10, height: 10 }); c.add("table", { page: 1, x: 0, y: 20, width: 100, height: 50 }); c.add("paragraph", { page: 2, x: 0, y: 0, width: 10, height: 10 }); return c.regions.map(r => r.id) }
    assert.deepEqual(mk(), ["paragraph-000001", "table-000001", "paragraph-000002"])
    assert.deepEqual(mk(), mk())
  })
  it("한 논리 개체가 두 페이지에 걸치면 regions 조각 2개 — 페이지 로컬 좌표 그대로", () => {
    const c = new RegionCollector()
    const id = c.add("table", { page: 3, x: 72, y: 610, width: 450, height: 180 })
    c.addFragment(id, { page: 4, x: 72, y: 55, width: 450, height: 300 })
    const r = c.regions[0]
    assert.equal(r.page, 3)
    assert.equal(r.regions.length, 2)
    assert.deepEqual(r.regions[1], { page: 4, x: 72, y: 55, width: 450, height: 300 })
    assert.ok(r.regions.every(b => b.page >= 1), "1-based")
  })
  it("같은 페이지 조각은 합집합으로 합쳐진다", () => {
    const c = new RegionCollector()
    const id = c.add("paragraph", { page: 1, x: 10, y: 10, width: 100, height: 10 })
    c.addFragment(id, { page: 1, x: 10, y: 22, width: 80, height: 10 })
    assert.deepEqual(c.regions[0].regions, [{ page: 1, x: 10, y: 10, width: 100, height: 22 }])
    const u = unionBBox({ page: 1, x: 5, y: 5, width: 5, height: 5 }, { page: 1, x: 20, y: 0, width: 5, height: 5 } as PageBBox)
    assert.deepEqual(u, { page: 1, x: 5, y: 0, width: 20, height: 10 })
  })
  it("scene 형태 — pages 1-based·stats 4축", () => {
    const scene: RenderScene = { format: "hwpx", pages: [{ page: 1, width: 595.28, height: 841.88 }], regions: [], warnings: [], stats: { texts: 0, tables: 0, images: 0, shapes: 0 } }
    assert.equal(scene.pages[0].page, 1)
  })
})
