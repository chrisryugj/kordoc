/**
 * 서울 보고서 계열(보고서·계획서·서울방침) 전면부 — 표지·목차.
 * 실측: bench/corpus-gen/seoul-bangchim 실결재 16건 표지(기관명 3자 「경 제 실」「복 지 실」 띄움, 6자 이상 5건 붙여 씀,
 * 부서명 HY견명조 22 자간 20% 12건 중 8), 서울시 보고서 양식 목차(열 3650·39336·4464, 붙임 행 한컴돋움 15 굵게·쪽 HY견고딕 17).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, renderDocument } from "../src/index.js"
import { coverOrgName } from "../src/hwpx/gen-frame-seoul.js"
import { flatSec } from "./gen-xml.js"

const md = `# 서울시 AI 정책 추진 현황

> 서울시 AI 정책 추진 기반과 청년 AI 성장권 수요조사 결과를 보고드림

## 현황과 대책

- 공공부문 AI 확산 제도적 기반과 중소기업 지원 산학협력체계 정리
  - 샌프란시스코·뉴욕은 공공부문 AI 도입이 개별 시범사업 중심으로 분산

## 기대 효과

- 청년 AI 성장권 수요조사 결과를 정책에 반영
`

async function gen(preset: string, extra: Record<string, unknown> = {}) {
  const buf = await markdownToHwpx(md, { gongmun: { preset, ...extra } as never })
  const z = await JSZip.loadAsync(buf)
  return { buf, sec: flatSec(await z.file("Contents/section0.xml")!.async("text")), head: await z.file("Contents/header.xml")!.async("text") }
}

describe("서울 보고서 계열 — 표지", () => {
  it("표지 기관명은 5자 이하만 한 칸씩 띄우고(경 제 실), 6자 이상이나 ○ 자리표시면 그대로", () => {
    assert.equal(coverOrgName("경제실"), "경 제 실")
    assert.equal(coverOrgName("서울특별시"), "서 울 특 별 시")
    assert.equal(coverOrgName("도시공간본부"), "도시공간본부")
    assert.equal(coverOrgName("○○실"), "○○실")
    assert.equal(coverOrgName("주택실·미래공간기획관"), "주택실·미래공간기획관")
  })

  it("표지 쪽에는 쪽번호를 찍지 않는다", async () => {
    const { sec } = await gen("보고서", { cover: { date: "2026. 11.", org: "경제실" } })
    const first = sec.slice(0, sec.indexOf("</hp:p>"))
    assert.match(first, /<hp:pageHiding [^>]*hidePageNum="1"/)
  })

  it("문서정보표 이름칸은 「문서번호」가 한 줄에 든다(보고서 프리셋 12pt 굵게)", async () => {
    const { buf } = await gen("보고서", { cover: { date: "2026. 11.", org: "경제실", dept: "일자리정책과" }, docInfo: {}, approval: ["주무관", "팀장", "과장"] })
    const r = await renderDocument(Buffer.from(buf), { format: "svg" } as never) as unknown as { assets: { data: string | Uint8Array }[] }
    const p1 = String(typeof r.assets[0].data === "string" ? r.assets[0].data : Buffer.from(r.assets[0].data).toString("utf8"))
    const texts = [...p1.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
    assert.ok(texts.includes("문서번호"), `문서번호가 한 덩어리로 그려져야 함: ${texts.slice(0, 8).join("|")}`)
  })

  it("표지가 한 쪽에 든다 — 서울방침 표지의 부서명이 첫 쪽에 그려진다", async () => {
    const { buf } = await gen("서울방침", { cover: { date: "2026. 11.", org: "경제실", dept: "일자리정책과" }, docInfo: {}, approval: ["주무관", "팀장", "과장"] })
    const r = await renderDocument(Buffer.from(buf), { format: "svg" } as never) as unknown as { assets: { data: string | Uint8Array }[] }
    const page = (i: number) => String(typeof r.assets[i].data === "string" ? r.assets[i].data : Buffer.from(r.assets[i].data).toString("utf8"))
    assert.match(page(0), /일자리정책과/)
    assert.doesNotMatch(page(1), /일자리정책과/)
  })

  it("서울방침 부서명은 HY견명조 22 자간 20%", async () => {
    const { sec, head } = await gen("서울방침", { cover: { date: "2026. 11.", org: "경제실", dept: "일자리정책과" } })
    const id = /<hp:run charPrIDRef="(\d+)"><hp:t>\(일자리정책과\)<\/hp:t>/.exec(sec)?.[1]
    assert.ok(id)
    const cp = new RegExp(`<hh:charPr id="${id}" height="2200"[\\s\\S]*?<hh:spacing hangul="20"`).test(head)
    assert.ok(cp)
  })
})

describe("서울 보고서 계열 — 목차", () => {
  const pageTexts = async (buf: ArrayBuffer) => {
    const r = await renderDocument(Buffer.from(buf), { format: "svg" } as never) as unknown as { assets: { data: string | Uint8Array }[] }
    return r.assets.map((a) => [...String(typeof a.data === "string" ? a.data : Buffer.from(a.data).toString("utf8")).matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]).join(""))
  }
  const cell = (sec: string, i: number) => new RegExp(`<hp:tc name="__kordoc_tocpage_${i}"[\\s\\S]*?<hp:t>([^<]*)</hp:t>`).exec(sec)?.[1]

  it("목차 쪽 칸에 장이 시작하는 쪽(본문 첫 쪽 = 1)을, 장 아래에 붙임 줄과 그 쪽을 넣는다", async () => {
    const items = Array.from({ length: 14 }, (_, i) => `- 공공부문 AI 확산 제도적 기반과 중소기업 지원 산학협력체계 정리 ${i + 1}\n  - 샌프란시스코·뉴욕은 공공부문 AI 도입이 개별 시범사업 중심으로 분산`).join("\n")
    const long = `# 서울시 AI 정책 추진 현황\n\n> 서울시 AI 정책 추진 현황을 보고드림\n\n## 현황과 대책\n\n${items}\n\n## 청년 수요조사\n\n${items}\n\n## 기대 효과\n\n- 정책 반영\n\n붙임  1. 서울시 보도자료(2026. 10. 22.) 1부.\n      2. 서울시 보도자료(2026. 10. 27.) 1부.  끝.\n`
    const buf = await markdownToHwpx(long, { gongmun: { preset: "보고서", cover: { date: "2026. 11.", org: "경제실" }, toc: true } as never })
    const sec = flatSec(await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text"))
    assert.doesNotMatch(sec, /kordoc-toc/)
    assert.match(sec, /<hp:t>붙임   1\. 서울시 보도자료\(2026\. 10\. 22\.\) 1부\.<\/hp:t>[\s\S]*<hp:t> {7}2\. 서울시 보도자료\(2026\. 10\. 27\.\) 1부\.<\/hp:t>/)
    // 렌더한 쪽에서 장 제목이 처음 나오는 쪽(목차 쪽 뒤)을 본문 첫 쪽 기준 번호로
    const pages = await pageTexts(buf)
    const tocPage = pages.findIndex((t) => t.includes("목차") || t.includes("목    차"))
    const body = pages.findIndex((t, i) => i > tocPage && t.includes("서울시 AI 정책 추진 현황"))
    const at = (s: string) => pages.findIndex((t, i) => i > tocPage && t.includes(s)) - body + 1
    assert.equal(cell(sec, 0), "1")
    assert.equal(cell(sec, 1), String(at("청년 수요조사")))
    assert.equal(cell(sec, 2), String(at("기대 효과")))
    assert.ok(Number(cell(sec, 1)) > 1, "둘째 장은 본문 둘째 쪽 이후")
    assert.equal(cell(sec, 3), String(at("붙임")))
    assert.equal(cell(sec, 4), cell(sec, 3))
  })

  for (const preset of ["보고서", "계획서"]) {
    it(`${preset} 프리셋도 toc 를 켜면 목차 쪽을 만든다`, async () => {
      const { sec } = await gen(preset, { cover: { date: "2026. 11.", org: "경제실" }, toc: true })
      assert.match(sec, /<hp:t>목    차<\/hp:t>[\s\S]*<hp:t>현황과 대책<\/hp:t>[\s\S]*<hp:t>기대 효과<\/hp:t>/)
    })
  }
})
