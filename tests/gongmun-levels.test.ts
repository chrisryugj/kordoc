/**
 * 항목부호 단계별 위계 타이포(levels 옵션, v4.12.3) — 해석·검증·표면 파싱·XML 방출.
 * 실측 근거: docs/gongmunseo-reference.md 2.7 (실결재 기안문 206 + 보고서 337건).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { resolveGongmun, levelIndent, levelMarkerHeight, markerWidth } from "../src/hwpx/gongmun.js"
import { buildGongmunOptions, parseLevelsSpec, levelFontRecord } from "../src/hwpx/gongmun-surface.js"
import { levelCharIds, levelFontFaces } from "../src/hwpx/gen-levels.js"

const MD = `# 제목

- 첫째 항목
  - 둘째 **강조** 항목
    - 셋째 항목
- 첫째 둘
`

async function unzipText(buf: Uint8Array, name: string): Promise<string> {
  const zip = await JSZip.loadAsync(buf)
  return zip.file(name)!.async("string")
}

describe("levels — 해석·검증", () => {
  it("지정한 단계만 해석되고 셋 다 빈 항목은 버린다", () => {
    const g = resolveGongmun({ preset: "official", levels: { 0: { font: "HY견고딕", pt: 17, bold: true }, 1: { bold: true }, 2: {} } })
    assert.deepEqual(g.levels, {
      0: { font: "HY견고딕", height: 1700, bold: true },
      1: { font: null, height: 1200, bold: true }, // pt 미지정 → 본문(기안문 12pt)
    })
    assert.equal(levelMarkerHeight(g, 0), 1700)
    assert.equal(levelMarkerHeight(g, 1), 1200)
    assert.equal(levelMarkerHeight(g, 5), 1200)
  })

  it("levels 미지정이면 null — 기존 산출물 불변 경로", () => {
    assert.equal(resolveGongmun({ preset: "official" }).levels, null)
    assert.equal(resolveGongmun({ preset: "official", levels: {} }).levels, null)
  })

  it("depth 범위·pt 범위·글꼴명 검증", () => {
    assert.throws(() => resolveGongmun({ preset: "official", levels: { 8: { bold: true } } }), /depth must be/)
    assert.throws(() => resolveGongmun({ preset: "official", levels: { x: { bold: true } } }), /depth must be/)
    assert.throws(() => resolveGongmun({ preset: "official", levels: { 0: { pt: 3 } } }), /levels\.0\.pt/)
    assert.throws(() => resolveGongmun({ preset: "official", levels: { 0: { font: " " } } }), /font must be/)
  })

  it("내어쓰기 폭은 단계 글자 크기 기준 — 17pt '1.' 부호폭이 12pt 본문보다 넓다", () => {
    const base = levelIndent(0, 1200, "standard")
    const big = levelIndent(0, 1200, "standard", {}, "○", false, 1700)
    assert.equal(base.left, big.left)
    assert.equal(big.indent, -markerWidth("1.", 1700))
    assert.ok(Math.abs(big.indent) > Math.abs(base.indent))
  })

  it("charPr id 는 base 부터 depth 순 2개씩, 글꼴은 중복 제거", () => {
    const g = resolveGongmun({ preset: "official", levels: { 2: { font: "휴먼명조" }, 0: { font: "HY견고딕", bold: true }, 1: { font: "HY견고딕", bold: true } } })
    assert.deepEqual(levelCharIds(g, 40), { 0: { normal: 40, bold: 41 }, 1: { normal: 42, bold: 43 }, 2: { normal: 44, bold: 45 } })
    assert.deepEqual(levelFontFaces(g), ["HY견고딕", "휴먼명조"])
  })
})

describe("levels — CLI/MCP 표면", () => {
  it("--levels 문법: depth=글꼴/pt/bold, plain 은 굵게 해제", () => {
    assert.deepEqual(parseLevelsSpec("0=HY견고딕/17/bold, 1=한컴돋움/15/b,2=휴먼명조/14,3=plain"), {
      "0": { font: "HY견고딕", pt: 17, bold: true },
      "1": { font: "한컴돋움", pt: 15, bold: true },
      "2": { font: "휴먼명조", pt: 14 },
      "3": { bold: false },
    })
    assert.throws(() => parseLevelsSpec("HY견고딕/17"), /--levels/)
  })

  it("buildGongmunOptions 는 빈 levels 를 대입하지 않는다", () => {
    assert.ok(!("levels" in buildGongmunOptions({ preset: "official", levels: {} })))
    assert.deepEqual(buildGongmunOptions({ preset: "official", levels: { 0: { bold: true } } }).levels, { 0: { bold: true } })
  })

  it("levelFontRecord — 폰트 경고용 역할 이름은 levels.<depth>", () => {
    assert.deepEqual(levelFontRecord({ 0: { font: "HY견고딕" }, 1: { bold: true } }), { "levels.0": "HY견고딕", "levels.1": undefined })
  })
})

describe("levels — HWPX 방출", () => {
  it("비실측 프리셋: 글꼴은 HANGUL·LATIN 에 append, charPr 는 한글·라틴만 참조·그 외 언어 본문(0)", async () => {
    const buf = await markdownToHwpx(MD, { gongmun: { preset: "notice", levels: { 0: { font: "HY견고딕", pt: 17, bold: true }, 1: { font: "한컴돋움", bold: true } } } })
    const header = await unzipText(buf, "Contents/header.xml")
    const section = await unzipText(buf, "Contents/section0.xml")
    // append 글꼴 id 3·4 (정적 3종 뒤)
    assert.match(header, /<hh:fontface lang="HANGUL" fontCnt="5">[\s\S]*?<hh:font id="3" face="HY견고딕"[\s\S]*?<hh:font id="4" face="한컴돋움"/)
    assert.match(header, /<hh:fontface lang="LATIN" fontCnt="5">[\s\S]*?<hh:font id="4" face="한컴돋움"/)
    assert.match(header, /<hh:fontface lang="HANJA" fontCnt="1">/)
    // 단계 charPr — 1단계 17pt bold HY견고딕(3), 2단계 본문 15pt bold 한컴돋움(4)
    const lv0 = header.match(/<hh:charPr id="(\d+)" height="1700"[^>]*bold="1">\s*<hh:fontRef hangul="3" latin="3" hanja="0" japanese="0" other="0" symbol="0" user="0"\/>/)
    assert.ok(lv0, "1단계 전용 charPr")
    const lv1 = header.match(/<hh:charPr id="(\d+)" height="1500"[^>]*bold="1">\s*<hh:fontRef hangul="4" latin="4" hanja="0"/)
    assert.ok(lv1, "2단계 전용 charPr")
    const id0 = lv0![1], id1 = lv1![1]
    // 리스트 문단이 전용 charPr 를 참조 — 인라인 **강조** 는 같은 단계의 bold 짝
    assert.match(section, new RegExp(`<hp:run charPrIDRef="${id0}"><hp:t>1\\. 첫째 항목</hp:t>`))
    assert.match(section, new RegExp(`<hp:run charPrIDRef="${id1}"><hp:t>가\\. 둘째 </hp:t></hp:run><hp:run charPrIDRef="${Number(id1) + 1}"><hp:t>강조</hp:t>`))
    // 지정 안 한 3단계는 본문 charPr(0)
    assert.match(section, /<hp:run charPrIDRef="0"><hp:t>1\) 셋째 항목<\/hp:t>/)
    // 1단계 paraPr 내어쓰기 = 17pt '1.' 부호폭
    const w = markerWidth("1.", 1700)
    assert.match(header, new RegExp(`<hh:paraPr id="8"[\\s\\S]*?<hc:intent value="-${w}"`))
  })

  it("실측 프리셋(보고서): 명시 levels 가 □ HY헤드라인M 실측값보다 우선, 글꼴은 8종 뒤 append", async () => {
    const buf = await markdownToHwpx(MD, { gongmun: { preset: "report", levels: { 0: { font: "HY견고딕", pt: 17, bold: true } } } })
    const header = await unzipText(buf, "Contents/header.xml")
    const section = await unzipText(buf, "Contents/section0.xml")
    assert.match(header, /<hh:font id="8" face="HY견고딕"/)
    const lv0 = header.match(/<hh:charPr id="(\d+)" height="1700"[^>]*bold="1">\s*<hh:fontRef hangul="8" latin="8" hanja="4"/)
    assert.ok(lv0, "보고서 1단계 전용 charPr(그 외 언어는 본문 휴먼명조 4)")
    assert.match(section, new RegExp(`<hp:run charPrIDRef="${lv0![1]}"><hp:t>□ 첫째 항목</hp:t>`))
    assert.doesNotMatch(section, /<hp:run charPrIDRef="11"><hp:t>□ 첫째 항목/)
  })

  it("levels 없는 생성은 charPr·fontface 가 늘지 않는다 (기존 산출물 불변)", async () => {
    const a = await unzipText(await markdownToHwpx(MD, { gongmun: { preset: "notice" } }), "Contents/header.xml")
    const b = await unzipText(await markdownToHwpx(MD, { gongmun: { preset: "notice", levels: {} } }), "Contents/header.xml")
    assert.equal(a, b)
    assert.match(a, /<hh:fontface lang="HANGUL" fontCnt="3">/)
  })
})
