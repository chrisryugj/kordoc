/**
 * 중앙부처 업무보고 프리셋(ministry / 업무보고) — 재경부 2차 업무보고(2026-07-15) 실측 골격.
 * 설계: docs/gongmunseo-engine-spec.md (j)장
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { resolveGongmun, PRESET_ALIAS } from "../src/hwpx/gongmun.js"
import { buildOutline } from "../src/hwpx/outline.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { pickScheme } from "../src/hwpx/gongmun-scheme.js"
import { lintMuncheText } from "../src/hwpx/munche-lint.js"
import { flatSec } from "./gen-xml.js"

const md = `# 재정경제부 업무보고

## 현장의견 수렴을 통한 제도 개선

□ (확실한 제도 개선) 국회·감사원 등의 지적사항을 **적극 반영**

ㅇ (세수추계) 정확도 제고를 위한 **민간자문단 운영**

- 세부 내용 하나

* 300억원 이상 매각시 국회 사전 보고의무 부과

## 상반기 주요 성과

### 경기회복 및 초혁신경제 가속화

> ▪ (성장률) 계엄 충격에서 반등 후 **'26.1분기 3.8%**
> * 물가상승률(전년동기비, %): (韓)2.8

#### 민생경제 안정화

##### (물가) 민생 최우선 과제로 **3% 이내 물가관리** 총력

ㅇ 항목 하나

##### (고용) 두 번째 항목 띠

➊ [매점매석 근절] 행정상 제재 신설

⇒ 재경부가 **총괄 조정**

## 별첨 경제·민생 입법 추진실적

| 구분 | 주요 법안 |
| --- | --- |
| 소위 상정 | 「전략수출금융지원법」 |
`

const unzip = async (buf: ArrayBuffer) => {
  const z = await JSZip.loadAsync(buf)
  return { head: await z.file("Contents/header.xml")!.async("text"), sec: await z.file("Contents/section0.xml")!.async("text").then(flatSec) }
}

describe("업무보고(ministry) 프리셋 — 해석", () => {
  it("별칭 3종이 ministry 로, 표지·목차·쪽번호 기본 켜짐, 여백 10/10/20/20 + 머리꼬리 10mm, 줄간격 145", () => {
    for (const a of ["업무보고", "부처업무보고", "중앙부처보고서", "ministry"]) assert.equal(PRESET_ALIAS[a], "ministry")
    const g = resolveGongmun({ preset: "업무보고" })
    assert.equal(g.preset, "ministry")
    assert.ok(g.cover && g.toc && g.pageNumbers)
    assert.deepEqual(g.margins, { top: 10, bottom: 10, left: 20, right: 20 })
    assert.equal(g.headerFooter, 2835)
    assert.equal(g.lineSpacing, 145)
    assert.equal(g.bodyHeight, 1500)
  })
  it("cover.label(대외주의) 이 해석에 남는다", () => {
    const g = resolveGongmun({ preset: "ministry", cover: { label: "대외주의", date: "2026. 7. 15." } })
    assert.equal(g.cover?.label, "대외주의")
    assert.equal(g.cover?.date, "2026. 7. 15.")
  })
  it("스킴 — 함초롬바탕 15 전 단계 동일, ㅇ 1타·- 3타, 각주 맑은 고딕 12, 표 맑은 고딕 12 #DFE6F7, 요약 #FFF7CC", () => {
    const s = pickScheme(resolveGongmun({ preset: "ministry" }), true)
    assert.equal(s.kind, "gaejosik")
    assert.equal(s.lineSp, 145)
    for (const l of s.levels) { assert.equal(l.font, "함초롬바탕"); assert.equal(l.pt, 15); assert.equal(l.bold, false) }
    assert.equal(s.levels[1].leadTa, 1)
    assert.equal(s.levels[2].leadTa, 3)
    assert.deepEqual([s.ref.font, s.ref.pt], ["맑은 고딕", 12])
    assert.deepEqual([s.table.font, s.table.pt, s.table.headerFill], ["맑은 고딕", 12, "#DFE6F7"])
    assert.equal(s.frame.summaryFill, "#FFF7CC")
    assert.equal(s.marker(1, 0), "ㅇ")
  })
})

describe("업무보고 — 아웃라인(headingFrames·quoteBox·keepMarkers)", () => {
  const o = buildOutline(parseMarkdownToBlocks(md), { gaejosik: true, consumeTitle: true, summaryFromQuote: true, quoteBox: true, headingFrames: true, keepMarkers: true })
  it("h3~h5 는 heading 노드(항목 아님), 인용문은 위치 무관 summary", () => {
    const heads = o.nodes.filter((n) => n.kind === "heading").map((n) => (n as { level: number }).level)
    assert.deepEqual(heads, [3, 4, 5, 5])
    assert.equal(o.nodes.filter((n) => n.kind === "summary").length, 1)
    assert.equal(o.nodes.filter((n) => n.kind === "chapter").length, 3)
  })
  it("부호 없는 '-' 리스트는 직전 ㅇ 아래 2단계, ❶·⇒ 는 부호 보존 0단계", () => {
    const items = o.nodes.filter((n): n is Extract<typeof n, { kind: "item" }> => n.kind === "item")
    const sub = items.find((n) => n.text.startsWith("세부 내용"))
    assert.equal(sub?.depth, 2)
    const nine = items.find((n) => n.text.startsWith("[매점매석"))
    assert.equal(nine?.marker, "➊"); assert.equal(nine?.depth, 0)
    const concl = items.find((n) => n.text.startsWith("재경부가"))
    assert.equal(concl?.marker, "⇒")
  })
  it("다른 프리셋 옵션(headingFrames 없음)에서는 종전대로 h3 가 항목이고 인용문은 제목 직후만 요약", () => {
    const p = buildOutline(parseMarkdownToBlocks(md), { gaejosik: true, consumeTitle: true, summaryFromQuote: true })
    assert.equal(p.nodes.filter((n) => n.kind === "heading").length, 0)
    assert.equal(p.nodes.filter((n) => n.kind === "summary").length, 0)
    const nine = p.nodes.find((n) => n.kind === "para" && n.text.startsWith("➊"))
    assert.ok(nine, "keepMarkers 없이는 ❶ 줄이 일반 문단")
  })
})

describe("업무보고 — 생성 XML", () => {
  it("표지(파란 바 2색·대외주의 박스)·목차·장 띠 그라데이션·절 숫자칸·소제목·항목 띠·요약박스·별첨 띠·키워드 파랑", async () => {
    const { head, sec } = await unzip(await markdownToHwpx(md, { gongmun: { preset: "업무보고", cover: { label: "대외주의", date: "2026. 7. 15." } } }))
    // 표지 바·라벨
    assert.ok(head.includes('faceColor="#0C3DCA"') && head.includes('faceColor="#0A33A9"'), "표지 파란 바 2색")
    assert.ok(/color="#FF0000"/.test(head), "대외주의 빨강")
    assert.ok(sec.includes(">대외주의<"))
    // 장 띠 — LINEAR 2색 + 파랑 이중선
    assert.ok(/<hc:gradation type="LINEAR" angle="90"[^>]*colorNum="2"[^>]*><hc:color value="#D6EAFE"\/><hc:color value="#FFFFFF"\/>/.test(head), "장 띠 그라데이션")
    assert.ok(/type="DOUBLE_SLIM" width="0.5 mm" color="#0000FF"/.test(head), "장 띠 파랑 이중선")
    // 절 숫자칸·소제목·항목 띠·요약·별첨 채움
    for (const c of ["#3057B9", "#203A7B", "#E8F7FC", "#FFF7CC", "#0066FF"]) assert.ok(head.includes(`faceColor="${c}"`), `채움 ${c}`)
    assert.ok(/color="#00ACFF"/.test(head), "항목 띠 하늘색 선")
    // 왕복 채널 이름
    for (const n of ["__kordoc_h1", "__kordoc_toc", "__kordoc_h2", "__kordoc_h3", "__kordoc_h4", "__kordoc_h5", "__kordoc_summary"]) assert.ok(sec.includes(`name="${n}"`), n)
    // 항목 띠 번호 ①②, 별첨 라벨, 9대 과제 ❶ 보존, 키워드 런
    assert.ok(sec.includes("① ") && sec.includes("② "), "항목 띠 원숫자 1부터")
    assert.ok(sec.includes(">별 첨<"))
    assert.ok(sec.includes("➊ "))
    assert.ok(/<hp:t>(□ )?\(확실한 제도 개선\) </.test(sec), "키워드 별도 런")
    // 키워드 파랑 bold charPr 존재 (함초롬바탕 15 bold #0000FF)
    assert.ok(/<hh:charPr[^>]*height="1500"[^>]*textColor="#0000FF"[^>]*>[\s\S]*?<hh:bold\/>/.test(head) || /textColor="#0000FF"/.test(head), "파랑 charPr")
    // 각주 * 마커, 쪽번호 숨김·리셋
    assert.ok(sec.includes(">* 300억원"))
    assert.ok(sec.includes("hidePageNum=\"1\""), "표지 쪽번호 숨김")
    assert.ok(sec.includes('<hp:newNum num="1" numType="PAGE"/>'), "본문 쪽번호 1 리셋")
    // 장·별첨 쪽 나눔 — 첫 장은 목차 뒤 pageBreak, 2·3장도 pageBreak
    assert.ok((sec.match(/pageBreak="1"/g) ?? []).length >= 4, "표지→목차→Ⅰ→Ⅱ→별첨 쪽 나눔")
  })
  it("표지·목차 끄면 제목만 가운데, 쪽 나눔은 장 사이만", async () => {
    const { sec } = await unzip(await markdownToHwpx(md, { gongmun: { preset: "ministry", cover: false, toc: false } }))
    assert.ok(!sec.includes("__kordoc_toc"))
    assert.ok(!sec.includes('<hp:newNum'))
    assert.ok(sec.includes("재정경제부 업무보고"))
  })
})

describe("업무보고 — 문체 검수", () => {
  it("▪ 부호 줄로 된 인용(성과 요약 박스)은 리드문 규칙(LEAD_ENDING·LEAD_LONG) 밖", () => {
    const f = lintMuncheText("> ▪ (성장률) 계엄 충격에서 반등('25.上 0.4% → 下 1.8%, 전년동기비) 후 '26.1분기 3.8% 성장하며 OECD 최상위권\n> ▪ (세입기반) 국세수입 변동(조원): △51.8 → △7.6 → +37.4\n")
    assert.equal(f.filter((x) => x.rule.startsWith("LEAD_")).length, 0)
    const g = lintMuncheText("> 물가 안정과 공급망 관리로 민생경제를 지키고 잠재성장률 반등 기반을 마련하는 하반기 경제정책 방향입니다.\n")
    assert.ok(g.some((x) => x.rule === "LEAD_ENDING"), "부호 없는 리드문은 종전대로 검수")
  })
})
