/** #75 Task 3·4·6·8 — 페이지별 SVG·HTML·통합 renderDocument·페이지 선택·미지원 형식·PDF(환경 게이트) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { renderDocument, renderDocumentToScene, renderSceneToHtml } from "../src/render/index.js"
import { findChromiumPath } from "../src/print/renderer.js"
import { KordocError } from "../src/utils.js"
import { buildRenderFixture } from "./fixtures/render-fixture.js"

describe("render document: 페이지별 독립 SVG", () => {
  it("2쪽 문서 → scene.pages 2, 페이지 SVG 2, 2쪽 좌표는 페이지 로컬(translate 없음)", async () => {
    const { scene, pageSvgs } = await renderDocumentToScene(await buildRenderFixture())
    assert.equal(scene.format, "hwpx")
    assert.deepEqual(scene.pages.map(p => p.page), [1, 2])
    assert.equal(pageSvgs.size, 2)
    const p2 = pageSvgs.get(2)!
    assert.ok(/^<svg /.test(p2) && p2.includes('data-page="2"'))
    assert.ok(!p2.includes("translate("), "페이지 SVG 는 세로 스택 오프셋이 없다")
    const y = Number(/<text x="[\d.]+" y="([\d.]+)"/.exec(p2)![1])
    assert.ok(y < 200, `2쪽 텍스트 y=${y}`)
    assert.ok(Math.abs(scene.pages[0].width - 595.28) < 0.1)
  })
  it("pages 선택 시 비선택 페이지 SVG 는 만들지 않는다 — region 은 전체 유지", async () => {
    const { scene, pageSvgs } = await renderDocumentToScene(await buildRenderFixture(), { pages: "2" })
    assert.deepEqual([...pageSvgs.keys()], [2])
    assert.equal(scene.pages.length, 2)
    assert.ok(scene.regions.some(r => r.page === 1))
  })
  it("페이지 SVG defs 에는 그 페이지가 쓰는 이미지 심볼만", async () => {
    const { pageSvgs } = await renderDocumentToScene(await buildRenderFixture())
    assert.ok(pageSvgs.get(1)!.includes("<symbol id=\"bin0\""))
    assert.ok(!pageSvgs.get(2)!.includes("<symbol"))
  })
  it("범위 밖 페이지 → KordocError", async () => {
    await assert.rejects(renderDocumentToScene(await buildRenderFixture(), { pages: [9] }), KordocError)
  })
})

describe("render document: HTML", () => {
  it(".kordoc-page[data-page] 페이지 컨테이너, 인라인 SVG, 크기 보존, 제목 이스케이프", async () => {
    const { scene, pageSvgs } = await renderDocumentToScene(await buildRenderFixture())
    const html = renderSceneToHtml(scene, pageSvgs, { title: "a<b>&\"c\"" })
    assert.ok(html.startsWith("<!doctype html>"))
    assert.ok(html.includes('<div class="kordoc-page" data-page="1"') && html.includes('data-page="2"'))
    assert.equal((html.match(/<svg /g) ?? []).length, 2)
    assert.ok(html.includes("width:595.28pt;height:841.88pt"))
    assert.ok(html.includes("<title>a&lt;b&gt;&amp;&quot;c&quot;</title>"))
    assert.ok(!/https?:\/\//.test(html.replace(/xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, "")), "외부 자원 없음")
    assert.ok(html.includes("@page { size: 595.28pt 841.88pt; margin: 0; }"))
  })
})

describe("render document: renderDocument 통합", () => {
  it("svg → 페이지별 자산, html → 문서 1건, png/jpeg → 선택 페이지만 래스터(scale 보고)", async () => {
    const buf = await buildRenderFixture()
    const svg = await renderDocument(buf, { format: "svg" })
    assert.deepEqual(svg.assets.map(a => a.page), [1, 2])
    assert.equal(svg.assets[0].mimeType, "image/svg+xml")
    const html = await renderDocument(buf, { format: "html" })
    assert.equal(html.assets.length, 1)
    assert.equal(html.assets[0].page, undefined)
    const png = await renderDocument(buf, { format: "png", pages: [2], maxWidthPx: 600 })
    assert.equal(png.assets.length, 1)
    assert.equal(png.assets[0].page, 2)
    assert.ok(png.assets[0].scale! > 0 && Math.abs(png.assets[0].width! - 595.28 * png.assets[0].scale!) <= 1)
    const jpg = await renderDocument(buf, { format: "jpeg", pages: "1" })
    assert.equal(jpg.assets[0].mimeType, "image/jpeg")
  })
  it("Buffer·Uint8Array·경로 입력, 미지원 형식·HWP5·없는 파일은 KordocError", async () => {
    const u8 = await buildRenderFixture({ singlePage: true })
    const viaBuffer = await renderDocument(Buffer.from(u8), { format: "svg" })
    assert.equal(viaBuffer.assets.length, 1)
    await assert.rejects(renderDocument(Buffer.from("%PDF-1.4\n%%EOF"), { format: "svg" }), /미지원 형식/)
    await assert.rejects(renderDocument("/nonexistent/x.hwpx", { format: "svg" }), /찾을 수 없습니다/)
    // OLE2 시그니처(HWP5) → 후속 안내
    const ole = Buffer.alloc(600); ole.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    await assert.rejects(renderDocument(ole, { format: "svg" }), /HWP5/)
  })
  it("pdf — Chromium 있으면 %PDF, 없으면 조치 안내 KordocError", { skip: !existsSync("/Applications/Google Chrome.app") && !findChromiumPath() && !process.env.PUPPETEER_EXECUTABLE_PATH }, async () => {
    const r = await renderDocument(await buildRenderFixture(), { format: "pdf" })
    assert.equal(r.assets.length, 1)
    assert.equal((r.assets[0].data as Buffer).subarray(0, 4).toString(), "%PDF")
  })
  it("pdf — 실행 파일 경로가 틀리면 에러가 난다(무음 실패 금지)", async () => {
    await assert.rejects(renderDocument(await buildRenderFixture({ singlePage: true }), { format: "pdf", browserExecutablePath: "/nonexistent/chrome" }))
  })
})
