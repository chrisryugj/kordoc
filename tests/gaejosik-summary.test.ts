/**
 * 개조식 요약 상자 — 표지 제목(h1) 바로 뒤, 첫 장(Ⅰ) 앞 인용문(또는 summary 옵션)을 1×1 요약 상자로.
 * 실측: 서울 실결재 553건 제목 아래 요약 상자 53개 전부 1×1, 3줄 이하 98%·2줄 75%, #DFE6F7 67%, 한컴돋움 15 굵게 72%.
 * 다른 자리 인용문은 종전대로 ※ 참고, 요약이 없는 개조식·다른 프리셋 산출물은 그대로.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"

const SUMMARY = "청년 고용 둔화에 대응해 일자리 회복 방안을 마련하고 관계 부처 협업 과제를 보고하고자 함"
const LONG = "청년 고용이 둔화되고 있어 관계 부처가 함께 일자리 회복 방안을 마련하였으며 주요 과제별 추진 일정과 소요 예산, 부처별 역할 분담을 보고드립니다. "
  + "아울러 향후 점검 계획과 성과 지표를 함께 검토하여 하반기 추진 상황을 정기적으로 공유하고자 함"
const doc = (quote: string) => `# 청년 일자리 회복 방안\n\n> ${quote}\n\n## 추진 배경\n\n- 청년 고용률 하락\n  - 전년 대비 1.2%p\n`

async function parts(buf: ArrayBuffer): Promise<{ sec: string; head: string }> {
  const z = await JSZip.loadAsync(buf)
  return { sec: await z.file("Contents/section0.xml")!.async("string"), head: await z.file("Contents/header.xml")!.async("string") }
}
/** 요약 상자 표 — __kordoc_summary 칸을 품은 <hp:tbl> */
function summaryTable(sec: string): string | null {
  const at = sec.indexOf('name="__kordoc_summary"')
  if (at < 0) return null
  return sec.slice(sec.lastIndexOf("<hp:tbl ", at), sec.indexOf("</hp:tbl>", at))
}
const charPrOf = (head: string, id: string) => head.match(new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?</hh:charPr>`))![0]
const bfOf = (head: string, id: string) => head.match(new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`))![0]

describe("개조식 요약 상자", () => {
  it("제목 직후 인용문 → 본문 첫 쪽 제목 상자 아래 1×1 상자 (#DFE6F7·0.4mm·한컴돋움 15 굵게)", async () => {
    const warnings: string[] = []
    const { sec, head } = await parts(await markdownToHwpx(doc(SUMMARY), { gongmun: { preset: "개조식" }, warnings }))
    const t = summaryTable(sec)
    assert.ok(t, "요약 상자")
    assert.ok(t.includes('rowCnt="1" colCnt="1"'))
    assert.ok(t.includes(`<hp:t>${SUMMARY}</hp:t>`))
    // 제목 상자(__kordoc_skip) 뒤, 첫 장 헤더 앞
    const box = sec.indexOf('name="__kordoc_summary"')
    assert.ok(sec.indexOf('name="__kordoc_skip"') < box && box < sec.lastIndexOf("추진 배경"), "목차 뒤 본문 장 헤더 앞")
    const bf = bfOf(head, t.match(/<hp:tc [^>]*borderFillIDRef="(\d+)"/)![1])
    assert.ok(bf.includes('faceColor="#DFE6F7"'), bf)
    assert.equal((bf.match(/width="0\.4 mm"/g) ?? []).length, 4, bf)
    const cp = charPrOf(head, t.match(/<hp:run charPrIDRef="(\d+)"><hp:t>청년/)![1])
    assert.ok(cp.includes('height="1500"') && cp.includes("<hh:bold/>"), cp)
    const fontId = cp.match(/hangul="(\d+)"/)![1]
    assert.ok(new RegExp(`<hh:font id="${fontId}" face="한컴돋움"`).test(head))
    // ※ 참고로 새지 않는다
    assert.ok(!sec.includes(`※`), "※ 참고 문단 없음")
    assert.deepEqual(warnings.filter((w) => w.includes("요약")), [])
  })

  it("3줄을 넘거나 두 문장이면 보고서와 같은 경고", async () => {
    const warnings: string[] = []
    await markdownToHwpx(doc(LONG), { gongmun: { preset: "개조식" }, warnings })
    assert.ok(warnings.some((w) => /요약박스가 4줄입니다/.test(w)), warnings.join(" / "))
    assert.ok(warnings.some((w) => /요약박스가 2문장입니다/.test(w)), warnings.join(" / "))
  })

  it("보고서 프리셋도 두 문장이면 경고 (날짜 마침표는 문장 끝이 아님)", async () => {
    const warnings: string[] = []
    await markdownToHwpx(doc("2026. 10. 9. 기준 현황을 점검하였음. 후속 과제를 보고하고자 함"), { gongmun: { preset: "보고서" }, warnings })
    assert.ok(warnings.some((w) => /2문장/.test(w)), warnings.join(" / "))
    const ok: string[] = []
    await markdownToHwpx(doc("2026. 10. 9. 기준 현황을 점검하고 후속 과제를 보고하고자 함"), { gongmun: { preset: "보고서" }, warnings: ok })
    assert.ok(!ok.some((w) => /문장입니다/.test(w)), ok.join(" / "))
  })

  it("오탐 없음 — 두 줄로 나눠 쓴 한 문장·목록 부호 가./나.·링크 든 요약", async () => {
    for (const quote of [
      "청년 고용 둔화에 대응해 일자리 회복 방안을\n> 마련하고 관계 부처 협업 과제를 보고하고자 함",
      "가. 일자리 확충, 나. 주거 지원을 추진하고자 함",
      `[청년 일자리 대책](https://example.go.kr/${"a".repeat(200)})의 추진 상황을 보고하고자 함`,
    ]) {
      const warnings: string[] = []
      await markdownToHwpx(doc(quote), { gongmun: { preset: "개조식" }, warnings })
      assert.deepEqual(warnings.filter((w) => w.includes("요약")), [], quote)
    }
  })

  it("다른 자리 인용문은 ※ 참고 그대로, 요약 상자 없음", async () => {
    const md = `# 청년 일자리 회복 방안\n\n## 추진 배경\n\n> ${SUMMARY}\n\n- 청년 고용률 하락\n`
    const { sec } = await parts(await markdownToHwpx(md, { gongmun: { preset: "개조식" } }))
    assert.equal(summaryTable(sec), null)
    assert.ok(sec.includes("※"))
  })

  it("summary 옵션도 같은 상자 — 그때 제목 뒤 인용문은 ※ 참고", async () => {
    const { sec } = await parts(await markdownToHwpx(doc("인용문은 참고로 남는다"), { gongmun: { preset: "개조식", summary: SUMMARY } }))
    assert.ok(summaryTable(sec)?.includes(`<hp:t>${SUMMARY}</hp:t>`))
    assert.ok(sec.includes("※"))
  })

  it("표지 없는 개조식은 첫 h1 이 장 헤더라 인용문은 ※ 참고, summary 옵션은 본문 맨 앞 상자", async () => {
    const { sec } = await parts(await markdownToHwpx(doc(SUMMARY), { gongmun: { preset: "개조식", cover: false } }))
    assert.equal(summaryTable(sec), null)
    assert.ok(sec.includes("※"))
    const opt = (await parts(await markdownToHwpx(doc("참고 인용"), { gongmun: { preset: "개조식", cover: false, toc: false, summary: SUMMARY } }))).sec
    const box = opt.indexOf('name="__kordoc_summary"')
    assert.ok(box > 0 && box < opt.indexOf("<hp:t>Ⅰ</hp:t>"), "장 헤더 앞")
    assert.ok(opt.indexOf("<hp:secPr") < box, "첫 문단이 secPr 를 진다")
  })

  it("다시 읽으면 요약 글이 남는다", async () => {
    const r = await parse(await markdownToHwpx(doc(SUMMARY), { gongmun: { preset: "개조식" } }))
    assert.ok(r.success && r.markdown.includes(SUMMARY), r.success ? r.markdown : "")
  })

  it("왕복 md→hwpx→md→hwpx — 요약 상자는 `>` 인용문으로 다시 읽혀 다시 상자가 된다 (개조식·보고서, 문단 여럿)", async () => {
    for (const [preset, quote] of [["개조식", SUMMARY], ["보고서", SUMMARY], ["개조식", `${SUMMARY}\n> 관계 부처 협업 과제를 함께 보고함`]] as const) {
      const first = await parse(await markdownToHwpx(doc(quote), { gongmun: { preset } }))
      assert.ok(first.success)
      if (!first.success) continue
      for (const line of quote.split("\n> ")) assert.match(first.markdown, new RegExp(`^> ${line}$`, "m"), `${preset}: ${first.markdown.slice(0, 400)}`)
      const t = summaryTable((await parts(await markdownToHwpx(first.markdown, { gongmun: { preset } }))).sec)
      assert.ok(t, `${preset}: 두 번째 생성에도 요약 상자`)
      for (const line of quote.split("\n> ")) assert.ok(t.includes(`<hp:t>${line}</hp:t>`), `${preset}: ${line}`)
    }
  })

  it("왕복 — 다시 읽은 표지 날짜·기관명 문단은 표지가 받아 본문에 두 번 찍히지 않는다", async () => {
    const org = "광진구 기획예산과"
    const first = await parse(await markdownToHwpx(doc(SUMMARY), { gongmun: { preset: "개조식", cover: { date: "2026. 9. 30.", org } } }))
    assert.ok(first.success)
    if (!first.success) return
    assert.match(first.markdown, /^2026\. 9\. 30\.$/m)
    // 날짜 사이 빈칸은 묶음 빈칸(<hp:nbSpace/>)으로 나간다
    const flat = (xml: string) => xml.replace(/<hp:nbSpace\/>/g, " ")
    const sec = flat((await parts(await markdownToHwpx(first.markdown, { gongmun: { preset: "개조식" } }))).sec)
    assert.equal(sec.split("<hp:t>2026. 9. 30.</hp:t>").length - 1, 1, "날짜 한 번 — 표지")
    assert.equal(sec.split(`<hp:t>${org}</hp:t>`).length - 1, 1, "기관명 한 번 — 표지")
    assert.ok(summaryTable(sec)?.includes(`<hp:t>${SUMMARY}</hp:t>`), "요약 상자")
    // 옵션으로 준 날짜가 있으면 본문 날짜 문단은 그대로 본문이다
    const kept = flat((await parts(await markdownToHwpx(first.markdown, { gongmun: { preset: "개조식", cover: { date: "2026. 10. 1." } } }))).sec)
    assert.equal(kept.split("<hp:t>2026. 10. 1.</hp:t>").length - 1, 1, "옵션 날짜가 표지")
    // 마크다운 날짜 줄은 본문에 남는다("2026. " 은 번호 목록 표지로 읽힌다 — 종전 동작)
    assert.match(kept, /<hp:t>(?:2026\. )?9\. 30\.<\/hp:t>/, "마크다운 날짜 줄은 본문에 남는다")
  })
})
