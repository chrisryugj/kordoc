/**
 * 서울 방침서 프리셋(bangchim / 서울방침) — 정보소통광장 시장방침 편집형 계획서 정답지 5건 실측 골격.
 * 정본: 「청년취업사관학교 2.0」 추진계획(서울특별시장 제81호). 재현율: bench/gen-repro.mjs
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { resolveGongmun, PRESET_ALIAS, incompatibleGongmunWarnings } from "../src/hwpx/gongmun.js"
import { buildOutline, parseLeadingMarker } from "../src/hwpx/outline.js"
import { parseMarkdownToBlocks } from "../src/hwpx/md-runs.js"
import { pickScheme } from "../src/hwpx/gongmun-scheme.js"
import { flatSec } from "./gen-xml.js"

const md = `# 「청년취업사관학교 2.0」추진계획

- AI 인재양성 1089(십중팔구) 프로젝트 -

일자리정책과장 : 김덕환☎2133-5445 담당 : 이훈영☎5448

> AI 대전환 시기에 청년들의 미래형 일자리 진입을 촉진하기 위한 추진계획을 수립하고자 함

## 청년취업사관학교 1.0 운영성과

□ 기업의 AI 도입 수요 증가

ㅇ 제조·금융 등 산업 전반에 걸쳐 인공지능 전환 가속화

- 국내 제조업체 AI 기술 도입비율 확대

▸ 연도별 조성(누적) : ’21년 2개 → ’25년 25개

※ 취업대상자 : 수료자 중 진학 제외 인원

## 세부 추진계획

### 현장수요 대응형 교육체계 구축

#### 글로벌 빅테크 전담 캠퍼스 운영 : ’30년 10개소

#### 지역 산업거점별 특화 과정 운영

### 취업, 창업 프로그램 강화

#### 기업 연계 인턴십 프로그램 운영
`

const sec = async (m: string) => {
  const z = await JSZip.loadAsync(await markdownToHwpx(m, { gongmun: { preset: "서울방침" } }))
  return { sec: flatSec(await z.file("Contents/section0.xml")!.async("text")), head: await z.file("Contents/header.xml")!.async("text") }
}

describe("서울 방침서(bangchim) 프리셋 — 해석", () => {
  it("별칭 서울방침·방침서·방침 → bangchim, 서울 보고서 여백·장 상자·줄간격 190%", () => {
    for (const a of ["서울방침", "방침서", "방침", "bangchim"]) assert.equal(PRESET_ALIAS[a], "bangchim")
    const g = resolveGongmun({ preset: "서울방침" })
    assert.deepEqual(g.margins, { top: 13, bottom: 13, left: 18, right: 18 })
    assert.equal(g.h2Marker, "square")
    assert.equal(g.lineSpacing, 190)
  })

  it("스킴 — □ HY견고딕 17 보통 · ㅇ 한컴돋움 15 굵게 양쪽 · - 휴먼명조 14 · ▸ 한컴돋움 13 · ※ 한컴돋움 13", () => {
    const s = pickScheme(resolveGongmun({ preset: "bangchim" }), true)
    assert.deepEqual([s.levels[0].font, s.levels[0].pt, s.levels[0].bold], ["HY견고딕", 17, false])
    assert.deepEqual([s.levels[1].font, s.levels[1].pt, s.levels[1].bold, s.levels[1].align ?? "JUSTIFY"], ["한컴돋움", 15, true, "JUSTIFY"])
    assert.deepEqual([s.levels[2].font, s.levels[2].pt], ["휴먼명조", 14])
    assert.deepEqual([s.levels[3].font, s.levels[3].pt, s.marker(3, 0)], ["한컴돋움", 13, "▸"])
    assert.deepEqual([s.ref.font, s.ref.pt], ["한컴돋움", 13])
    assert.equal(s.lineSp, 190)
  })

  it("숫자 위계 스킴 — 1. □ 글꼴 · 1) ㅇ 글꼴 · ① 와 그 아래 - 는 휴먼명조 14, 넷째 단계 부호 -", () => {
    const s = pickScheme(resolveGongmun({ preset: "bangchim" }), false, true)
    assert.deepEqual([s.levels[0].font, s.levels[0].pt], ["HY견고딕", 17])
    assert.deepEqual([s.levels[1].font, s.levels[1].pt, s.levels[1].bold], ["한컴돋움", 15, true])
    assert.deepEqual([s.levels[2].font, s.levels[2].pt, s.levels[3].font, s.levels[3].pt], ["휴먼명조", 14, "휴먼명조", 14])
    assert.ok(s.levels[3].leadTa > s.levels[2].leadTa)
    assert.equal(s.marker(3, 0), "-")
  })
})

describe("서울 방침서 — 아웃라인", () => {
  it("부호 없는 목록은 직전 명시 부호의 한 단계 아래 (ㅇ 뒤 '- …' → -)", () => {
    const o = buildOutline(parseMarkdownToBlocks("ㅇ 항목\n\n- 세부\n"), { gaejosik: true, consumeTitle: true, summaryFromQuote: true, listUnderMarker: true })
    assert.deepEqual(o.nodes.map((n) => n.kind === "item" ? n.depth : -1), [1, 2])
  })

  it("숫자 위계 원고(□·ㅇ 없이 1. → 1) → ①) — 갈래가 처음 나온 순서가 단계, 부호는 그대로", () => {
    const src = "1. 추진근거\n\n1) 청년기본법 제4조\n\n① 전국 청년 고용률 하락\n\n- 체감실업률 15.6%\n\n2. 그간 추진경과\n"
    const o = buildOutline(parseMarkdownToBlocks(src), { gaejosik: true, consumeTitle: true, summaryFromQuote: true, headingFrames: true, keepMarkers: true, numbered: true })
    assert.equal(o.numbered, true)
    assert.deepEqual(o.nodes.map((n) => n.kind === "item" ? [n.depth, n.marker ?? ""] : null), [[0, "1."], [1, "1)"], [2, "①"], [3, ""], [0, "2."]])
  })

  it("□·ㅇ 부호가 있거나 번호 갈래가 하나뿐이면 숫자 위계가 아니다", () => {
    const opts = { gaejosik: true, consumeTitle: true, summaryFromQuote: true, headingFrames: true, keepMarkers: true, numbered: true }
    assert.equal(buildOutline(parseMarkdownToBlocks("□ 추진배경\n\n1. 단계\n\n1) 세부\n"), opts).numbered, false)
    assert.equal(buildOutline(parseMarkdownToBlocks("1. 첫째\n2. 둘째\n"), opts).numbered, false)
  })

  it("굵게가 부호를 감싼 줄·낫표가 붙은 ㅇ 도 항목 부호로 읽는다", () => {
    assert.deepEqual([parseLeadingMarker("**ㅇ 전문가 자문회의** (4회)").kind, parseLeadingMarker("**ㅇ 전문가 자문회의** (4회)").rest], ["box", "**전문가 자문회의** (4회)"])
    assert.equal(parseLeadingMarker("ㅇ『2024 인공지능산업 실태조사』에 따르면").depth, 1)
    assert.equal(parseLeadingMarker("**※ 필요시 타운홀 미팅 개최**").kind, "ref")
    // 한글 낱말은 부호가 아니다
    assert.equal(parseLeadingMarker("ㅇ영희").kind, null)
  })
})

describe("서울 방침서 — 골격", () => {
  it("제목표: 제목 HY헤드라인M 26 굵게 + 파랑 부제 18 + 담당 휴먼명조 12 균등배분, 요약박스 1×1", async () => {
    const { sec: s, head } = await sec(md)
    assert.match(s, /「청년취업사관학교 2\.0」추진계획/)
    assert.match(s, /- AI 인재양성 1089\(십중팔구\) 프로젝트 -/)
    assert.match(s, /일자리정책과장 : 김덕환☎2133-5445/)
    assert.ok(s.includes('name="__kordoc_summary"'), "요약박스")
    // 부제·담당은 본문 항목으로 새지 않는다
    assert.ok(!/<hp:t>AI 인재양성[^<]*<\/hp:t>/.test(s.replace(/- AI 인재양성 1089\(십중팔구\) 프로젝트 -/, "")))
    assert.match(head, /textColor="#0000FF"/)
    assert.match(head, /horizontal="DISTRIBUTE"/)
    // 제목 줄간격 120%·요약 양쪽 — 정본이 아니라 방침서 16건 문서별 값 (제목 120% 4/8, 요약 양쪽 8/10)
    const prOf = (text: string) => {
      const i = s.indexOf(text), id = s.slice(s.lastIndexOf("<hp:p ", i), i).match(/paraPrIDRef="(\d+)"/)![1]
      return head.match(new RegExp(`<hh:paraPr id="${id}"[\\s\\S]*?</hh:paraPr>`))![0]
    }
    const title = prOf("「청년취업사관학교 2.0」추진계획")
    assert.match(title, /horizontal="CENTER"/)
    assert.match(title, /<hh:lineSpacing type="PERCENT" value="120"/)
    const summary = s.slice(s.indexOf('name="__kordoc_summary"'))
    const sumId = summary.match(/<hp:p [^>]*paraPrIDRef="(\d+)"/)![1]
    assert.match(head.match(new RegExp(`<hh:paraPr id="${sumId}"[\\s\\S]*?</hh:paraPr>`))![0], /horizontal="JUSTIFY"/)
  })

  it("장은 [Ⅰ] 상자(1×3), 절은 번호 띠(#437FC1), 과제 소제목은 장 안에서 ❶❷❸ 로 이어 센다", async () => {
    const { sec: s, head } = await sec(md)
    assert.equal((s.match(/name="__kordoc_h2"/g) ?? []).length, 2)
    assert.match(s, /<hp:t>Ⅰ<\/hp:t>[\s\S]*<hp:t>Ⅱ<\/hp:t>/)
    assert.equal((s.match(/name="__kordoc_h3"/g) ?? []).length, 2)
    assert.match(head, /faceColor="#437FC1"/)
    assert.match(s, /<hp:t>❶ <\/hp:t>[\s\S]*<hp:t>❷ <\/hp:t>[\s\S]*<hp:t>❸ <\/hp:t>/)
  })

  it("장 상자 번호칸은 작성자 번호 — '## 1. ' → 1, '## 가. ' → 가 (제목칸과 같은 HY견고딕 20), 번호 없으면 Ⅰ", async () => {
    const { sec: s } = await sec(md.replace("## 청년취업사관학교 1.0 운영성과", "## 가. 청년취업사관학교 1.0 운영성과").replace("## 세부 추진계획", "## 2. 세부 추진계획"))
    assert.match(s, /<hp:t>가<\/hp:t>[\s\S]*<hp:t>청년취업사관학교 1\.0 운영성과<\/hp:t>[\s\S]*<hp:t>2<\/hp:t>[\s\S]*<hp:t>세부 추진계획<\/hp:t>/)
    assert.ok(!s.includes("<hp:t>가. 청년취업사관학교"), "제목칸에 번호가 남지 않는다")
    assert.ok(!/<hp:t>Ⅰ<\/hp:t>/.test(s))
  })

  it("숫자 위계 원고는 1. · 1) · ① 부호를 그대로 쓴다", async () => {
    const { sec: s } = await sec("# 계획\n\n> 목적\n\n## 가. 추진개요\n\n1. 추진근거\n\n1) 청년기본법 제4조\n\n① 전국 청년 고용률 하락\n\n- 체감실업률 15.6%\n")
    for (const t of ["1. 추진근거", "1) 청년기본법", "① 전국", "- 체감실업률"]) assert.ok(s.includes(`<hp:t>${t}`), t)
    assert.ok(!/<hp:t>[□ㅇ] /.test(s))
  })

  it("사전 검토항목 점검표 — 14문항 고정 서식, na 문항만 해당없음 ■·나머지 검토완료 ■, true 는 빈 서식", async () => {
    const gen = async (checklist: unknown) => {
      const z = await JSZip.loadAsync(await markdownToHwpx(md, { gongmun: { preset: "서울방침", cover: true, checklist } as never }))
      return flatSec(await z.file("Contents/section0.xml")!.async("text"))
    }
    const s = await gen({ na: [6, 7], notes: { 7: "교육" } })
    assert.match(s, /사전 검토항목 점검 사항/)
    assert.equal((s.match(/◆/g) ?? []).length, 14)
    assert.equal((s.match(/<hp:t>■<\/hp:t>/g) ?? []).length, 14)
    assert.match(s, /<hp:t>교육<\/hp:t>/)
    assert.match(s, /<hp:t>단순지원\/사다리지원<\/hp:t>/, "비고 안내 글은 그대로")
    // 표지 → 점검표 → 제목표 가 쪽을 넘긴다
    assert.ok(/<hp:p pageBreak="1"[^>]*><hp:run[^>]*>(?:(?!<\/hp:run>)[\s\S])*?사전 검토항목|<hp:p pageBreak="1"[\s\S]*?☑ 사전 검토항목/.test(s))
    const blank = await gen(true)
    assert.equal((blank.match(/<hp:t>■<\/hp:t>/g) ?? []).length, 0)
    assert.equal((blank.match(/<hp:t>□<\/hp:t>/g) ?? []).length, 28)
  })

  it("목차(toc) — '목    차' + 장마다 번호·제목·빈 쪽 칸, 표지 글꼴은 간이기안 실측(굴림체·HY견명조 21 날짜·그라데이션 띠)", async () => {
    const z = await JSZip.loadAsync(await markdownToHwpx(md, { gongmun: { preset: "서울방침", cover: { date: "2025. 11.", org: "경제실", dept: "일자리정책과" }, docInfo: { docNum: "일자리정책과-1" }, toc: true } }))
    const s = flatSec(await z.file("Contents/section0.xml")!.async("text"))
    const head = await z.file("Contents/header.xml")!.async("text")
    assert.match(s, /<hp:t>목    차<\/hp:t>[\s\S]*<hp:t>Ⅰ\.<\/hp:t>[\s\S]*<hp:t>청년취업사관학교 1\.0 운영성과<\/hp:t>[\s\S]*<hp:t>Ⅱ\.<\/hp:t>/)
    assert.match(head, /face="굴림체"/)
    assert.match(head, /<hc:color value="#3057B9"\/><hc:color value="#A0B4E6"\/>/)
  })

  it("점검표 옵션 검증 — 문항 번호 범위, 서울 보고서형 밖 프리셋은 경고 후 무시", () => {
    assert.throws(() => resolveGongmun({ preset: "bangchim", checklist: { na: [15] } }), /between 1 and 14/)
    assert.equal(resolveGongmun({ preset: "official", checklist: true }).checklist, null)
    assert.ok(incompatibleGongmunWarnings({ preset: "official", checklist: true }).some((w) => w.includes("checklist")))
    const c = resolveGongmun({ preset: "bangchim", checklist: { na: [6] } }).checklist!
    assert.deepEqual([c.marks.get(1), c.marks.get(6), c.marks.size], ["done", "na", 14])
  })

  it("▸ 는 부호 그대로 4단계, 캡션 줄 '< … >' 은 가운데", async () => {
    const { sec: s } = await sec(md + "\n< AI 과정 재편 전후 주요 변화 >\n")
    assert.match(s, /▸/)
    assert.match(s, /&lt; AI 과정 재편 전후 주요 변화 &gt;/)
  })
})
