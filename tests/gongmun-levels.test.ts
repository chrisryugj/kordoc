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
  it("법정형(통지): levels 글꼴은 전 언어 목록에 append, charPr 7슬롯이 같은 글꼴 (v5 — 한컴 툴바 글꼴명 표시 조건)", async () => {
    const buf = await markdownToHwpx(MD, { gongmun: { preset: "notice", levels: { 0: { font: "HY견고딕", pt: 17, bold: true }, 1: { font: "한컴돋움", bold: true } } } })
    const header = await unzipText(buf, "Contents/header.xml")
    const section = await unzipText(buf, "Contents/section0.xml")
    const fid = (face: string) => header.match(new RegExp(`<hh:fontface lang="HANGUL"[\\s\\S]*?<hh:font id="(\\d+)" face="${face}"`))![1]
    const gyeon = fid("HY견고딕"), dotum = fid("한컴돋움")
    assert.equal(gyeon, "2", "HY견고딕은 정적 3종(id 2) 재사용")
    assert.ok(Number(dotum) >= 3, "한컴돋움은 정적 3종 뒤 append")
    assert.match(header, new RegExp(`<hh:fontface lang="LATIN"[\\s\\S]*?<hh:font id="${dotum}" face="한컴돋움"`))
    const hangulCnt = header.match(/<hh:fontface lang="HANGUL" fontCnt="(\d+)">/)![1]
    assert.match(header, new RegExp(`<hh:fontface lang="HANJA" fontCnt="${hangulCnt}">[\\s\\S]*?<hh:font id="${dotum}" face="한컴돋움"`), "한자 목록도 동일")
    // 단계 charPr — 1단계 17pt bold HY견고딕, 2단계 본문(12pt) bold 한컴돋움, 7슬롯 동일
    const lv0 = header.match(new RegExp(`<hh:charPr id="(\\d+)" height="1700"[^>]*bold="1">\\s*<hh:fontRef hangul="${gyeon}" latin="${gyeon}" hanja="${gyeon}" japanese="${gyeon}" other="${gyeon}" symbol="${gyeon}" user="${gyeon}"/>`))
    assert.ok(lv0, "1단계 전용 charPr")
    const lv1 = header.match(new RegExp(`<hh:charPr id="(\\d+)" height="1200"[^>]*bold="1">\\s*<hh:fontRef hangul="${dotum}" latin="${dotum}" hanja="${dotum}"`))
    assert.ok(lv1, "2단계 전용 charPr")
    assert.match(section, new RegExp(`<hp:run charPrIDRef="${lv0![1]}"><hp:t>1\\. 첫째 항목</hp:t>`))
    // 2단계는 이미 굵은 단계라 인라인 **강조**도 같은 스펙 → 같은 charPr(레지스트리 dedupe). 자동장평 변형이 붙을 수 있어 id는 조회
    const run1 = section.match(/<hp:run charPrIDRef="(\d+)"><hp:t>가\. 둘째 <\/hp:t><\/hp:run><hp:run charPrIDRef="(\d+)"><hp:t>강조<\/hp:t>/)
    assert.ok(run1, "가. 둘째 + 강조 run")
    for (const id of [run1![1], run1![2]]) assert.match(header, new RegExp(`<hh:charPr id="${id}" height="1200"[^>]*bold="1">\\s*<hh:fontRef hangul="${dotum}"`))
    // 1단계 문단 내어쓰기 = 17pt '1.' 부호폭
    const pid = section.slice(section.lastIndexOf("<hp:p ", section.indexOf("1. 첫째 항목"))).match(/paraPrIDRef="(\d+)"/)![1]
    assert.match(header, new RegExp(`<hh:paraPr id="${pid}"[\\s\\S]*?<hc:intent value="-${markerWidth("1.", 1700)}"`))
  })

  it("보고서: 명시 levels 가 서울 실측 □(HY견고딕 17b)보다 우선 (v5)", async () => {
    const buf = await markdownToHwpx(MD, { gongmun: { preset: "report", levels: { 0: { font: "나눔고딕", pt: 18, bold: false } } } })
    const header = await unzipText(buf, "Contents/header.xml")
    const section = await unzipText(buf, "Contents/section0.xml")
    const fid = header.match(/<hh:fontface lang="HANGUL"[\s\S]*?<hh:font id="(\d+)" face="나눔고딕"/)![1]
    const lv0 = header.match(new RegExp(`<hh:charPr id="(\\d+)" height="1800"[^>]*>\\s*<hh:fontRef hangul="${fid}"`))
    assert.ok(lv0, "보고서 1단계 전용 charPr(나눔고딕 18pt)")
    assert.match(section, new RegExp(`<hp:run charPrIDRef="${lv0![1]}"><hp:t>□ 첫째 항목</hp:t>`))
  })

  it("levels 없는 생성은 charPr·fontface 가 늘지 않는다 (빈 levels = 미지정)", async () => {
    const a = await unzipText(await markdownToHwpx(MD, { gongmun: { preset: "notice" } }), "Contents/header.xml")
    const b = await unzipText(await markdownToHwpx(MD, { gongmun: { preset: "notice", levels: {} } }), "Contents/header.xml")
    assert.equal(a, b)
    assert.match(a, /<hh:fontface lang="HANGUL" fontCnt="\d+">/)
  })
})
