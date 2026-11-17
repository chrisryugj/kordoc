/**
 * 개조식 — 표지 없는 문서의 제목 상자, 장 안 번호 절 띠, 표 캡션·단위·자료 줄.
 * 실측(코퍼스 보고서): 표지 없는 □ 문서 139건 중 73건이 제목을 상자 표에 / 로마 장 보고서 34건 중 11건이 번호칸 띠 절
 * (번호칸 진한 채움·흰 글자 HY헤드라인M 16, 제목칸 채움 없음·아래 실선) / 「< 제목 >」 캡션 202건(가운데 149) /
 * 「(단위: …)」 183건(오른쪽 180).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parse } from "../src/index.js"

async function parts(buf: ArrayBuffer): Promise<{ sec: string; head: string }> {
  const z = await JSZip.loadAsync(buf)
  return { sec: await z.file("Contents/section0.xml")!.async("string"), head: await z.file("Contents/header.xml")!.async("string") }
}
const charPrOf = (head: string, id: string) => head.match(new RegExp(`<hh:charPr id="${id}"[\\s\\S]*?</hh:charPr>`))![0]
const runCharOf = (sec: string, text: string) => new RegExp(`<hp:run charPrIDRef="(\\d+)"><hp:t>${text}</hp:t>`).exec(sec)?.[1]
const paraOf = (sec: string, text: string) => sec.slice(sec.lastIndexOf("<hp:p ", sec.indexOf(text)), sec.indexOf(text))

const doc = `# 서울시 AI 정책 추진 현황

## 주요 내용

### 1. AI 도시지수 평가 결과

### 서울 종합 3위, AI 도입·활용 분야 1위

- 36개국 57개 도시, 3개 분야 50개 지표 종합 평가

< AI 도시지수 종합 순위 >

(단위: 위)

| 순위 | 1위 | 2위 |
| --- | --- | --- |
| 도시 | 샌프란시스코 | 뉴욕 |

자료 : 서울시 보도자료(2026. 10. 22.)

### 2. 서울시 AI 정책 추진 현황

- AI 인재 연 1만명 양성
`

describe("개조식 — 표지 없는 문서", () => {
  it("맨 앞 h1 하나는 장이 아니라 첫 쪽 제목 상자, 목차 없음, 첫 ## 이 장 Ⅰ", async () => {
    const { sec } = await parts(await markdownToHwpx(doc, { gongmun: { preset: "개조식", cover: false } }))
    assert.match(sec, /name="__kordoc_h1"[\s\S]*?<hp:t>서울시 AI 정책 추진 현황<\/hp:t>/)
    assert.ok(!sec.includes("목  차"), "목차 쪽 없음")
    assert.match(sec, /<hp:t>Ⅰ<\/hp:t>[\s\S]*?<hp:t> 주요 내용<\/hp:t>/)
    assert.ok(!sec.includes("<hp:t>Ⅱ</hp:t>"), "제목이 장으로 세어지지 않는다")
    assert.ok(!sec.includes('pageBreak="1"'), "한 쪽에서 시작")
  })

  it("h1 이 여럿이면 종전대로 h1 도 장", async () => {
    const { sec } = await parts(await markdownToHwpx("# 첫 장\n\n- 가\n\n# 둘째 장\n\n- 나\n", { gongmun: { preset: "개조식", cover: false } }))
    assert.match(sec, /<hp:t>Ⅰ<\/hp:t>[\s\S]*<hp:t>Ⅱ<\/hp:t>/)
  })

  it("다시 읽으면 # 제목 으로 돌아온다", async () => {
    const r = await parse(await markdownToHwpx(doc, { gongmun: { preset: "개조식", cover: false } }))
    assert.ok(r.success && /^# 서울시 AI 정책 추진 현황$/m.test(r.markdown), r.success ? r.markdown : "")
  })
})

describe("개조식 — 절 띠", () => {
  it("'### 1. 제목' 은 번호칸 띠(#193AAA 채움·흰 HY헤드라인M □ 크기 번호 + 밑줄 제목칸), 번호 없는 ### 은 □", async () => {
    const { sec, head } = await parts(await markdownToHwpx(doc, { gongmun: { preset: "개조식", cover: false } }))
    const num = runCharOf(sec, "1")
    assert.ok(num, "번호칸 글")
    assert.match(charPrOf(head, num!), /height="1600" textColor="#FFFFFF"/)
    const numCell = sec.slice(sec.lastIndexOf("<hp:tc ", sec.indexOf(`<hp:run charPrIDRef="${num}"><hp:t>1</hp:t>`)))
    const bf = /borderFillIDRef="(\d+)"/.exec(numCell)![1]
    assert.match(head.match(new RegExp(`<hh:borderFill id="${bf}"[\\s\\S]*?</hh:borderFill>`))![0], /faceColor="#193AAA"/)
    assert.match(sec, /name="__kordoc_h3n"[\s\S]*?<hp:t> AI 도시지수 평가 결과<\/hp:t>/)
    assert.match(sec, /<hp:t>□<hp:tab [^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="\d+"><hp:t>서울 종합 3위/)
  })

  it("다시 읽으면 '### 1. 제목' 으로 돌아온다", async () => {
    const r = await parse(await markdownToHwpx(doc, { gongmun: { preset: "개조식", cover: false } }))
    assert.ok(r.success && /^### 1\. AI 도시지수 평가 결과$/m.test(r.markdown) && /^### 2\. 서울시 AI 정책 추진 현황$/m.test(r.markdown), r.success ? r.markdown : "")
  })
})

describe("개조식 — 표 캡션·단위·자료 줄", () => {
  it("캡션 가운데 표 글꼴 13pt, 단위 오른쪽 10pt, 표 바로 뒤 자료 줄은 출처행 서식", async () => {
    const { sec, head } = await parts(await markdownToHwpx(doc, { gongmun: { preset: "개조식", cover: false } }))
    assert.match(charPrOf(head, runCharOf(sec, "&lt; AI 도시지수 종합 순위 &gt;")!), /height="1300"/)
    assert.match(charPrOf(head, runCharOf(sec, "\\(단위: 위\\)")!), /height="1000"/)
    const src = /<hp:run charPrIDRef="(\d+)"><hp:t>자료 : 서울시 보도자료/.exec(sec)?.[1]
    assert.ok(src && Number(charPrOf(head, src).match(/height="(\d+)"/)![1]) < 1500, "본문보다 작은 출처행 글자")
    assert.notEqual(paraOf(sec, "&lt; AI 도시지수"), paraOf(sec, "(단위: 위)"))
  })

  it("원고에 절 띠·캡션·단위 줄이 없으면 추가 글자 모양을 내지 않는다", async () => {
    const plain = "# 보고\n\n## 장\n\n- 항목\n"
    const a = (await parts(await markdownToHwpx(plain, { gongmun: { preset: "개조식", cover: false } }))).head
    assert.ok(!/textColor="#FFFFFF"[^>]*>\s*<hh:fontRef hangul="3"/.test(a), "흰 HY헤드라인M 번호 글자 없음")
  })
})
