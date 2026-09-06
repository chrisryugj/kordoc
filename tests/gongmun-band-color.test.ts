/** 띠 제목 색 옵션 bandColor/bandTextColor (설계안 .claude/plans/2026-09-06-chapter-band-design.md) — 기본 #003366/#FFFFFF, 교육청형 밝은 띠, 검증 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { resolveGongmun } from "../src/hwpx/gongmun.js"
import { buildGongmunOptions } from "../src/hwpx/gongmun-surface.js"
import { KordocError } from "../src/utils.js"

const md = `# 문서 제목\n\n## 개요\n\n내용임\n\n## 추진 성과\n\n내용임`
const headerXml = async (buf: Uint8Array) => (await JSZip.loadAsync(buf)).file("Contents/header.xml")!.async("text")

describe("띠 제목 색 옵션", () => {
  it("기본 — 번호칸 #003366 채움 + 흰 글자", async () => {
    const head = await headerXml(await markdownToHwpx(md, { gongmun: { preset: "계획서" } }))
    assert.ok(/faceColor="#003366"/.test(head))
    assert.ok(/textColor="#FFFFFF"/.test(head))
  })
  it("교육청형 밝은 띠 — bandColor #DFE6F7 + bandTextColor #000000 (소문자 입력도 대문자 정규화)", async () => {
    const head = await headerXml(await markdownToHwpx(md, { gongmun: { preset: "계획서", bandColor: "#dfe6f7", bandTextColor: "#000000" } }))
    assert.ok(/faceColor="#DFE6F7"/.test(head), "번호칸 채움")
    assert.ok(!/faceColor="#003366"/.test(head), "기본 남색이 남지 않음")
    const r = resolveGongmun({ preset: "plan", bandColor: "#dfe6f7" })
    assert.equal(r.bandColor, "#DFE6F7")
    assert.equal(r.bandTextColor, "#FFFFFF")
  })
  it("#RRGGBB 아니면 KordocError, surface 는 두 옵션을 통과시킨다", () => {
    assert.throws(() => resolveGongmun({ preset: "plan", bandColor: "navy" }), KordocError)
    assert.throws(() => resolveGongmun({ preset: "plan", bandTextColor: "#FFF" }), KordocError)
    const g = buildGongmunOptions({ preset: "plan", bandColor: "#DFE6F7", bandTextColor: "#000000" })
    assert.equal(g.bandColor, "#DFE6F7")
    assert.equal(g.bandTextColor, "#000000")
  })
})
