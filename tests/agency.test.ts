/**
 * 기관 서식(agency) — 중앙행정기관 보도자료 실측값을 공문서 옵션의 기본값으로 깔고, 명시 옵션이 이긴다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, agencyNames, agencyStyle, incompatibleGongmunWarnings } from "../src/index.js"
import { resolveGongmun } from "../src/hwpx/gongmun.js"
import { AGENCY_STYLES } from "../src/hwpx/agency-styles.js"

const MD = "# 추진계획\n\n## 추진 배경\n\n- 개방 확대로 분석 수요가 늘어남\n  - 부처별 분석 인력 부족\n    - 전문 인력 23명 수준\n\n| 구분 | 2025 |\n|---|---|\n| 예산 | 10 |\n"

async function header(buf: ArrayBuffer): Promise<string> {
  return (await JSZip.loadAsync(buf)).file("Contents/header.xml")!.async("string")
}

describe("agency 데이터", () => {
  it("현행 52개 기관, 공통과 없는 이름", () => {
    assert.equal(agencyNames().length, 52)
    assert.ok(agencyNames().includes("국세청"))
    assert.equal(agencyStyle("공통").report?.levels[0].font, "휴먼명조")
    assert.throws(() => agencyStyle("국세처"), /실측 서식이 없는 기관.*국세청/)
  })
  it("하위 단계 글자가 상위보다 크지 않다 (원 저장소 렌더러 보정)", () => {
    for (const [name, st] of Object.entries(AGENCY_STYLES)) {
      for (const lv of [st.report?.levels, st.press?.levels]) {
        if (!lv) continue
        assert.ok(lv[0].pt >= lv[1].pt && lv[1].pt >= lv[2].pt, `${name} ${JSON.stringify(lv)}`)
      }
    }
  })
})

describe("agency 옵션 해석", () => {
  it("보고서: 보고서형 실측 단계·2단계 부호·표 머리·기관 색", () => {
    const g = resolveGongmun({ preset: "report", agency: "국세청" })
    const rs = AGENCY_STYLES["국세청"].report!
    assert.deepEqual(g.levels?.[0], { font: rs.levels[0].font, height: rs.levels[0].pt * 100, bold: false })
    assert.equal(g.bullet2, rs.bullet2)
    assert.equal(g.bandColor, AGENCY_STYLES["국세청"].band!.fill)
    assert.deepEqual(g.agency?.table, { pt: rs.table.pt, headerFill: rs.table.fill })
    assert.equal(g.fonts.table, rs.table.font)
  })
  it("명시 옵션이 이긴다 — 그 단계·부호·띠 색·글꼴 역할", () => {
    const g = resolveGongmun({
      preset: "report", agency: "국세청", levels: { 0: { font: "HY견고딕", pt: 17, bold: true } },
      bullet2: "○", bandColor: "#123456", fonts: { table: "한컴돋움" },
    })
    assert.deepEqual(g.levels?.[0], { font: "HY견고딕", height: 1700, bold: true })
    assert.equal(g.levels?.[1]?.font, AGENCY_STYLES["국세청"].report!.levels[1].font)
    assert.equal(g.bullet2, "○")
    assert.equal(g.bandColor, "#123456")
    assert.equal(g.fonts.table, "한컴돋움")
  })
  it("보도자료: 본문 글꼴·크기, 본문과 같은 단계는 지정하지 않음(장평 맞춤 유지), * 는 각주 크기", () => {
    const ps = AGENCY_STYLES["교육부"].press!
    const g = resolveGongmun({ preset: "press", agency: "교육부" })
    assert.equal(g.fonts.body, ps.p.font)
    assert.equal(g.bodyHeight, ps.p.pt * 100)
    assert.equal(g.levels?.[0], undefined) // □ = 본문과 같은 글꼴·크기
    assert.equal(g.levels?.[2]?.font, ps.note.font)
    assert.equal(g.bullet2, "◦")
    assert.equal(g.agency?.pressStyle, "para")
  })
  it("받지 않는 프리셋은 무시하고 경고, 보고서형 표본이 없는 기관은 공통값", () => {
    assert.equal(resolveGongmun({ preset: "official", agency: "국세청" }).agency, null)
    assert.match(incompatibleGongmunWarnings({ preset: "official", agency: "국세청" }).join(), /agency.*무시/)
    const g = resolveGongmun({ preset: "report", agency: "통일부" })
    assert.equal(g.levels?.[0]?.font, agencyStyle("공통").report!.levels[0].font)
    assert.match(incompatibleGongmunWarnings({ preset: "report", agency: "통일부" }).join(), /공통 서식/)
  })
  it("없는 기관은 생성 전에 오류", async () => {
    await assert.rejects(markdownToHwpx(MD, { gongmun: { preset: "report", agency: "없는부" } }), /실측 서식이 없는 기관/)
  })
})

describe("agency 생성 결과", () => {
  it("보고서 HWPX 에 기관 글꼴·표 머리 음영·기관 색이 실린다", async () => {
    const h = await header(await markdownToHwpx(MD, { gongmun: { preset: "report", agency: "국세청" } }))
    const rs = AGENCY_STYLES["국세청"].report!
    assert.ok(h.includes(`face="${rs.levels[0].font}"`))
    assert.ok(h.includes(`faceColor="${rs.table.fill}"`))
    assert.ok(h.includes(`faceColor="${AGENCY_STYLES["국세청"].band!.fill}"`))
  })
  it("보도자료: 기관 2단계 부호, 문단식 기관의 □ 원고 경고", async () => {
    const warnings: string[] = []
    const buf = await markdownToHwpx(MD, { gongmun: { preset: "press", agency: "교육부" }, warnings })
    const sec = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("string")
    assert.ok(sec.includes("◦"))
    assert.ok(warnings.some(w => w.includes("문단식")), warnings.join(" / "))
    const box: string[] = []
    await markdownToHwpx(MD, { gongmun: { preset: "press", agency: "국세청" }, warnings: box })
    assert.ok(!box.some(w => w.includes("문단식")))
  })
})

describe("보도자료 담당 표 사람별 행", () => {
  it("담당 부서 행 병합 + 사람마다 구분·직급·이름·전화", async () => {
    const buf = await markdownToHwpx("# 제목\n\n본문입니다.\n", { gongmun: { preset: "press", press: { contact: {
      dept: "데이터정책과",
      people: [{ role: "책임자", title: "과장", name: "이○○", phone: "044-000-0000" }, { role: "담당자", title: "사무관", name: "김○○", phone: "044-000-0001" }],
    } } } })
    const { parse } = await import("../src/index.js")
    const r = await parse(buf)
    assert.ok(r.success)
    const row = r.markdown.split("\n").filter(l => l.includes("데이터정책과") || l.includes("김○○"))
    assert.ok(row.some(l => /담당 부서.*데이터정책과.*책임자.*과장.*이○○.*044-000-0000/.test(l)), r.markdown)
    assert.ok(row.some(l => /담당자.*사무관.*김○○.*044-000-0001/.test(l)), r.markdown)
  })
})

describe("미실측 글꼴 폭 (생성)", () => {
  it("함초롬 계열만 0.97em, 폭표 없는 다른 글꼴은 1em 쪽(gothic)으로 넉넉히", async () => {
    const { faceClassForGen } = await import("../src/hwpx/text-metrics.js")
    assert.equal(faceClassForGen("함초롬바탕"), "hcr")
    assert.equal(faceClassForGen("바탕"), "gothic")
    assert.equal(faceClassForGen("한양신명조"), "gothic")
    assert.equal(faceClassForGen("휴먼명조"), "font:휴먼명조")
    assert.equal(faceClassForGen("바탕체"), "fixedPitch")
  })
})

describe("agency 명시 옵션 우선 — 스킴까지", () => {
  it("fonts.heading 은 □, fonts.body 는 ㅇ·- 글꼴을 정한다", async () => {
    const { pickScheme } = await import("../src/hwpx/gongmun-scheme.js")
    const s = pickScheme(resolveGongmun({ preset: "report", agency: "국세청", fonts: { heading: "HY견고딕", body: "맑은 고딕" } }), true)
    assert.equal(s.levels[0].font, "HY견고딕")
    assert.equal(s.levels[1].font, "맑은 고딕")
    assert.equal(s.levels[2].font, "맑은 고딕")
  })
  it("bodyFont 를 주면 기관 본문 글꼴을 깔지 않는다", () => {
    const g = resolveGongmun({ preset: "press", agency: "국세청", bodyFont: "gothic" })
    assert.equal(g.fonts.body, undefined)
  })
  it("levels 는 단계 안에서 속성별로 덮는다", () => {
    const rs = AGENCY_STYLES["국세청"].report!
    const g = resolveGongmun({ preset: "report", agency: "국세청", levels: { 0: { bold: true } } })
    assert.deepEqual(g.levels?.[0], { font: rs.levels[0].font, height: rs.levels[0].pt * 100, bold: true })
  })
  it("명시 bodyPt 면 단계·※·표 크기는 프리셋 비례 (각주 * 만 절대 크기)", async () => {
    const { pickScheme } = await import("../src/hwpx/gongmun-scheme.js")
    const g = resolveGongmun({ preset: "report", agency: "국세청", bodyPt: 13 })
    assert.equal(g.agency?.refPt, null)
    const s = pickScheme(g, true)
    assert.equal(s.levels[1].pt, 13) // 서울 스킴 ㅇ = bodyPt
    const p = resolveGongmun({ preset: "press", agency: "국세청", bodyPt: 12 })
    assert.equal(p.levels?.[2]?.height, AGENCY_STYLES["국세청"].press!.note.pt * 100)
  })
  it("받지 않는 프리셋이어도 없는 기관명은 오류", () => {
    assert.throws(() => resolveGongmun({ preset: "official", agency: "국세처" }), /실측 서식이 없는 기관/)
  })
})
