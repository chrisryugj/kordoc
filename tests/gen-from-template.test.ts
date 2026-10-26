/**
 * 부서 서식 견본으로 새 문서 만들기 (generate --template) — 견본은 kordoc 이 직접 만든 합성 문서(서울방침 프리셋:
 * 제목표·담당 줄·요약 상자·장 상자·□ㅇ-▸※·데이터 표·참고 띠). 실제 부서 문서는 저장소에 두지 않는다.
 */

import { describe, it, before } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx } from "../src/index.js"
import { validateHwpx } from "../src/validate.js"
import { scanTemplate } from "../src/hwpx/gen-from-template.js"
import { lineRole } from "../src/hwpx/template-scan.js"
import { registerGenerateTools } from "../src/mcp/tools-generate.js"

const TEMPLATE_MD = `# 견본 사업 추진계획

일자리정책과장 : 김견본 ☎1111 담당 : 이견본 ☎2222

> 견본 사업을 체계적으로 추진하기 위한 계획을 수립하고자 함

## 추진배경

□ 견본 현황

ㅇ 견본 제도 시행에 따른 후속 조치 필요

- 견본 지침 개정

▸ 견본 세부 지침

※ 견본 참고 문구

| 구분 | 견본내용 | 비고 |
| --- | --- | --- |
| 가 | 견본 하나 | 1 |
| 나 | 견본 둘 | 2 |
| 다 | 견본 셋 | 3 |

| 참고1 | 견본 참고 자료 |

ㅇ 견본 참고 항목
`

const NEW_MD = `# 스마트 행정 시범사업 계획

2026. 10. 21.(수) 스마트정보과장 : 홍길동 ☎1234 담당 : 김담당 ☎5678

> 시범사업으로 행정 업무를 개선하고자 함

## 현황

□ 새 현황

ㅇ 새 첫째 항목

- 새 세부 내용

· 새 넷째 단계

※ 새 참고 문구

| 항목 | 1분기 | 2분기 | 3분기 | 비고 |
| --- | --- | --- | --- | --- |
| 준비 | 계획 | 계약 | - | 내부 |
| 운영 | - | 시범 | 확대 | 외부 |

## 참고2 관련 법령

ㅇ 새 참고 항목
`

const entry = async (buf: ArrayBuffer | Uint8Array, name: string) => (await JSZip.loadAsync(buf)).file(name)!.async("text")
/** 새 글이 든 최상위 문단 — 문단 여는 태그와 그 글을 담은 run 의 charPr */
function paraOf(sec: string, text: string): { paraPr: string; charPr: string } {
  const i = sec.indexOf(text)
  assert.ok(i >= 0, `본문에 "${text}" 없음`)
  const pOpen = sec.lastIndexOf("<hp:p ", i)
  const run = sec.lastIndexOf("<hp:run ", i)
  return { paraPr: /paraPrIDRef="(\d+)"/.exec(sec.slice(pOpen))![1], charPr: /charPrIDRef="(\d+)"/.exec(sec.slice(run))![1] }
}

describe("generate --template (부서 서식 견본)", () => {
  let tpl: ArrayBuffer
  let out: ArrayBuffer
  let tplSec: string, outSec: string, tplHead: string, outHead: string
  const warnings: string[] = []

  before(async () => {
    tpl = await markdownToHwpx(TEMPLATE_MD, { gongmun: { preset: "서울방침" } })
    out = await markdownToHwpx(NEW_MD, { template: tpl, warnings })
    tplSec = await entry(tpl, "Contents/section0.xml")
    outSec = await entry(out, "Contents/section0.xml")
    tplHead = await entry(tpl, "Contents/header.xml")
    outHead = await entry(out, "Contents/header.xml")
  })

  it("견본 역할 판정 — 제목표(담당 줄 칸 포함)·요약 상자·장 띠·참고 띠·데이터 표·□ㅇ-▸·※", () => {
    const scan = scanTemplate(tplSec, tplHead)
    for (const role of ["title", "summary", "chapter", "band", "table", "L0", "L1", "L2", "L3", "ref"]) {
      assert.ok(scan.protos.has(role as never), `역할 ${role} 없음 — ${[...scan.protos.keys()].join(",")}`)
    }
    assert.equal(scan.contactInTitle, true)
    assert.match(scan.head, /<hp:secPr\b/)
    // 한컴 PUA 글머리(󰏚)도 □ 로 본다
    assert.equal(lineRole("\u{F03DA} 현   황"), "L0")
    assert.equal(lineRole("  ○ 내용"), "L1")
    assert.equal(lineRole("▶ 관련 법령"), "sym:▶")
    assert.equal(lineRole("ㅇ이응으로 시작하는 낱말"), null)
  })

  it("검증 통과 — mimetype 무압축 첫 엔트리, 구역 정의 하나, 줄 배치 캐시 없음, header 그대로", async () => {
    const v = await validateHwpx(out)
    assert.ok(v.ok, JSON.stringify(v.issues))
    const b = new Uint8Array(out)
    assert.deepEqual([...b.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04])
    assert.equal(b[8] | (b[9] << 8), 0, "mimetype 은 STORE")
    assert.equal(new TextDecoder().decode(b.slice(30, 30 + (b[26] | (b[27] << 8)))), "mimetype")
    assert.equal(outSec.match(/<hp:secPr\b/g)?.length, 1)
    assert.doesNotMatch(outSec, /linesegarray/)
    // 견본 header 의 글자·문단 모양·테두리는 순서·id 그대로 — 덧붙이기만 한다(담당 칸 균등 분할 → 가운데 정렬 문단 모양)
    const blocks = (x: string, tag: string) => [...x.matchAll(new RegExp(`<hh:${tag}\\b[\\s\\S]*?</hh:${tag}>`, "g"))].map((m) => m[0])
    for (const tag of ["charPr", "borderFill"]) assert.deepEqual(blocks(outHead, tag), blocks(tplHead, tag), tag)
    const p0 = blocks(tplHead, "paraPr"), p1 = blocks(outHead, "paraPr")
    assert.deepEqual(p1.slice(0, p0.length), p0, "기존 paraPr 순서·내용 그대로")
    for (const extra of p1.slice(p0.length)) assert.doesNotMatch(extra, /DISTRIBUTE/)
  })

  it("견본 글은 남지 않고 새 내용만", () => {
    assert.doesNotMatch(outSec, /견본|김견본|☎1111/)
    for (const t of ["스마트 행정 시범사업 계획", "시범사업으로 행정 업무를 개선하고자 함", "새 첫째 항목", "관련 법령", "참고2"]) assert.ok(outSec.includes(t), t)
  })

  it("단계별 문단 모양·글자 모양이 견본과 같다 (□ ㅇ - ▸ ※)", () => {
    const pairs: Array<[string, string]> = [["견본 현황", "새 현황"], ["견본 제도 시행에 따른 후속 조치 필요", "새 첫째 항목"],
      ["견본 지침 개정", "새 세부 내용"], ["견본 세부 지침", "새 넷째 단계"], ["견본 참고 문구", "새 참고 문구"]]
    for (const [a, b] of pairs) assert.deepEqual(paraOf(outSec, b), paraOf(tplSec, a), `${a} ↔ ${b}`)
    // 부호 글자는 견본 것 (원고의 · 대신 견본 4단계 ▸)
    assert.match(outSec, /▸[^<]*<hp:tab[^>]*\/><\/hp:t><\/hp:run><hp:run charPrIDRef="\d+"><hp:t>새 넷째 단계/)
  })

  it("제목표 — 제목 칸 글자 모양 유지, 담당 줄 칸에 새 ☎ 줄", () => {
    assert.deepEqual(paraOf(outSec, "스마트 행정 시범사업 계획"), paraOf(tplSec, "견본 사업 추진계획"))
    assert.match(outSec, /2026\. 10\.(?: |<hp:nbSpace\/>)21\.\(수\) {1,2}스마트정보과장 : 홍길동 ☎1234 {1,2}담당 : 김담당 ☎5678/)
  })

  it("표 — 원고 열 수(5)로 짜고 머리행·본문 칸 테두리는 견본 표 칸 것, 열 너비 합 = 견본 표 폭", async () => {
    const tbl = /<hp:tbl\b[^>]*rowCnt="3" colCnt="5"[^>]*>[\s\S]*?<\/hp:tbl>/.exec(outSec)?.[0]
    assert.ok(tbl, "3×5 표 없음")
    const tplTbl = /<hp:tbl\b[^>]*rowCnt="4" colCnt="3"[^>]*>[\s\S]*?<\/hp:tbl>/.exec(tplSec)![0]
    const bf = (x: string) => [...x.matchAll(/<hp:tc\b[^>]*borderFillIDRef="(\d+)"/g)].map((m) => m[1])
    const tplBf = bf(tplTbl), outBf = bf(tbl!)
    assert.equal(outBf[0], tplBf[0], "머리행 첫 칸")
    assert.equal(outBf[4], tplBf[2], "머리행 끝 칸")
    assert.equal(outBf[5], tplBf[3], "본문 첫 칸")
    const width = (x: string) => Number(/<hp:sz width="(\d+)"/.exec(x)![1])
    assert.equal(width(tbl!), width(tplTbl))
    const row0 = [...tbl!.split("</hp:tr>")[0].matchAll(/<hp:cellSz width="(\d+)"/g)].reduce((a, m) => a + Number(m[1]), 0)
    assert.equal(row0, width(tplTbl))
  })

  it("장 띠·참고 띠 — 견본 띠 표를 복제해 번호·제목만 바꾼다", () => {
    assert.match(outSec, /<hp:t>Ⅰ<\/hp:t>[\s\S]*?<hp:t>현황<\/hp:t>/)
    assert.match(outSec, /<hp:t>참고2<\/hp:t>[\s\S]*?<hp:t>관련 법령<\/hp:t>/)
  })

  it("개체 id·instid 는 문서 안에서 유일하다", () => {
    const ids = [...outSec.matchAll(/<hp:(?:tbl|pic|rect|container)\b[^>]*\bid="(\d+)"/g)].map((m) => m[1])
    assert.ok(ids.length >= 5)
    assert.equal(new Set(ids).size, ids.length)
  })

  it("원고에 담당 줄이 없으면 견본 담당 칸은 비운다 (견본 담당자 정보가 새 문서에 남지 않게)", async () => {
    const buf = await markdownToHwpx("# 제목만\n\n□ 항목\n", { template: tpl })
    const sec = await entry(buf, "Contents/section0.xml")
    assert.doesNotMatch(sec, /☎|김견본/)
    assert.ok(sec.includes("제목만"))
  })

  it("표 원형이 없는 견본 — header 에 실선 테두리 하나만 덧붙여 기본 표", async () => {
    const plainTpl = await markdownToHwpx("# 표 없는 견본\n\n□ 견본 항목\n\nㅇ 견본 둘째\n", { gongmun: { preset: "서울방침" } })
    const w: string[] = []
    const buf = await markdownToHwpx("# 새 문서\n\n□ 항목\n\n| 가 | 나 |\n| --- | --- |\n| 1 | 2 |\n", { template: plainTpl, warnings: w })
    assert.ok((await validateHwpx(buf)).ok)
    const head0 = await entry(plainTpl, "Contents/header.xml"), head1 = await entry(buf, "Contents/header.xml")
    assert.equal((head1.match(/<hh:borderFill\b/g)?.length ?? 0) - (head0.match(/<hh:borderFill\b/g)?.length ?? 0), 1)
    assert.ok(w.some((x) => x.includes("데이터 표")), w.join(" / "))
  })

  it("합계 행 — 견본 모드 기본도 머리행 바로 아래(top, 공문 관행), keep 이면 원고 그대로", async () => {
    const md = "# 표\n\n| 구분 | 금액 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |\n| 합계 | 3 |\n"
    const order = async (o: { totalRow?: "keep" }) => {
      const sec = await entry(await markdownToHwpx(md, { template: tpl, ...o }), "Contents/section0.xml")
      return [...sec.matchAll(/<hp:t>(가|나|합계)<\/hp:t>/g)].map((m) => m[1]).join(",")
    }
    assert.equal(await order({}), "합계,가,나")
    assert.equal(await order({ totalRow: "keep" }), "가,나,합계")
  })

  it("합계 행 서식 — 견본 표에 합계 행이 있으면 옮긴 원고 합계 행에 그 행 칸 서식, 마지막 데이터 행엔 본문 서식", async () => {
    const tplT = await markdownToHwpx(TEMPLATE_MD.replace("| 다 | 견본 셋 | 3 |", "| 다 | 견본 셋 | 3 |\n| 합계 | 견본 합 | 6 |"), { gongmun: { preset: "서울방침" } })
    const sec0 = await entry(tplT, "Contents/section0.xml")
    const tplTbl = /<hp:tbl\b[^>]*rowCnt="5" colCnt="3"[^>]*>[\s\S]*?<\/hp:tbl>/.exec(sec0)![0]
    const firstBf = (rowXml: string) => /<hp:tc\b[^>]*borderFillIDRef="(\d+)"/.exec(rowXml)![1]
    const tplRows = tplTbl.split("</hp:tr>")
    // 견본(kordoc 생성)도 합계 행을 머리행 아래로 옮겨 둔다 — 본문 서식은 합계 아닌 첫 데이터 행
    const totalBf = firstBf(tplRows.find((r) => r.includes(">합계<"))!), bodyBf = firstBf(tplRows.slice(1).find((r) => !r.includes(">합계<"))!)
    assert.notEqual(totalBf, bodyBf, "견본 합계 행 서식이 본문과 달라야 시험이 된다")
    const md = "# 표\n\n| 구분 | 금액 |\n| --- | --- |\n| 가 | 1 |\n| 나 | 2 |\n| 합계 | 3 |\n"
    const sec = await entry(await markdownToHwpx(md, { template: tplT }), "Contents/section0.xml")
    const rows = /<hp:tbl\b[^>]*rowCnt="4" colCnt="2"[^>]*>[\s\S]*?<\/hp:tbl>/.exec(sec)![0].split("</hp:tr>")
    assert.ok(rows[1].includes(">합계<"))
    assert.equal(firstBf(rows[1]), totalBf, "합계 행(맨 위로 옮김)은 견본 합계 행 서식")
    // 마지막 데이터 행은 합계가 아닌 본문 서식 — 자리가 같은 견본 마지막 본문 행 칸(바깥 아랫변)을 쓴다
    const tplLastBf = firstBf(tplRows.filter((r) => r.includes("<hp:tc")).pop()!)
    assert.notEqual(firstBf(rows[3]), totalBf, "마지막 데이터 행은 합계 서식이 아니다")
    assert.equal(firstBf(rows[3]), tplLastBf, "마지막 데이터 행은 견본 마지막 본문 행 서식")
    assert.equal(firstBf(rows[2]), bodyBf, "가운데가 없는 견본이면 첫 본문 행 서식")
  })

  it("구역이 둘인 견본 — 첫 구역만 쓰고 manifest·spine·secCnt 를 함께 맞춘다", async () => {
    const z = await JSZip.loadAsync(tpl)
    z.file("Contents/section1.xml", tplSec)
    let hpf = await z.file("Contents/content.hpf")!.async("text")
    hpf = hpf.replace(/(<opf:item\b[^>]*\bid="section0"[^>]*\/>)/, `$1<opf:item id="section1" href="Contents/section1.xml" media-type="application/xml"/>`)
      .replace(/(<opf:itemref\b[^>]*\bidref="section0"[^>]*\/>)/, `$1<opf:itemref idref="section1" linear="yes"/>`)
    z.file("Contents/content.hpf", hpf)
    z.file("Contents/header.xml", tplHead.replace(/\bsecCnt="\d+"/, "secCnt=\"2\""))
    z.file("META-INF/container.rdf", `<?xml version="1.0" encoding="UTF-8"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">`
      + ["section0", "section1"].map((s) => `<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/${s}.xml"/></rdf:Description><rdf:Description rdf:about="Contents/${s}.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>`).join("")
      + `</rdf:RDF>`)
    assert.match(hpf, /idref="section1"/, "견본 조립 확인")
    const w: string[] = []
    const buf = await markdownToHwpx("# 새 문서\n\n□ 항목\n", { template: await z.generateAsync({ type: "uint8array" }), warnings: w })
    assert.ok((await validateHwpx(buf)).ok)
    const outHpf = await entry(buf, "Contents/content.hpf")
    assert.doesNotMatch(outHpf, /section1/)
    assert.match(outHpf, /idref="section0"/)
    assert.match(await entry(buf, "Contents/header.xml"), /secCnt="1"/)
    const rdf = await entry(buf, "META-INF/container.rdf")
    assert.doesNotMatch(rdf, /section1/, "패키지 목록(rdf)도 뺀 구역을 가리키지 않는다")
    assert.match(rdf, /Contents\/section0\.xml/)
    assert.ok(w.some((x) => x.includes("첫 구역")))
  })

  it("서식 옵션과 함께 쓰면 오류 (라이브러리·MCP)", async () => {
    await assert.rejects(markdownToHwpx("# x", { template: tpl, gongmun: { preset: "보고서" } }), /template.*gongmun/)
    let callback: any
    registerGenerateTools({ tool(name: string, ...args: any[]) { if (name === "generate_document") callback = args.at(-1) } } as any)
    const r = await callback({ markdown: "# x", output_path: "C:/nowhere/x.hwpx", template_path: "C:/nowhere/t.hwpx", preset: "보고서" })
    assert.ok(r.isError)
    assert.match(r.content[0].text, /견본\(template\)은 preset/)
  })
})

describe("generate --template — 표지·목차 쪽이 앞에 있는 견본", () => {
  const COVER_MD = `# 견본 디지털 행정 추진계획

> 견본 요약 문장으로 상자를 채움

## 추진 배경

□ 견본 대항목
  ㅇ 견본 중항목
    - 견본 세부

## 추진 계획

□ 견본 계획 항목
`

  it("목차 상자는 요약 상자로 쓰지 않는다 (본문 첫 쪽의 요약 상자)", async () => {
    const tpl = await markdownToHwpx(COVER_MD, { gongmun: { preset: "gaejosik", cover: { org: "견본시 견본과", date: "2026. 10. 1." }, toc: true } })
    const tplSec = await entry(tpl, "Contents/section0.xml")
    const scan = scanTemplate(tplSec, await entry(tpl, "Contents/header.xml"))
    assert.match(scan.protos.get("summary") ?? "", /견본 요약 문장/, "요약 상자 = 본문 첫 쪽 상자")
    assert.doesNotMatch(scan.protos.get("summary") ?? "", /추진 계획/, "목차 상자가 아니다")
    const warnings: string[] = []
    const out = await markdownToHwpx("# 새 계획\n\n> 새 요약\n\n## 현황\n\n□ 새 대항목\n  ㅇ 새 중항목\n    - 새 세부\n", { template: tpl, warnings })
    assert.ok((await validateHwpx(out)).ok)
    const outSec = await entry(out, "Contents/section0.xml")
    assert.ok(!warnings.some((w) => w.includes("4단계")), "네 칸 들여 쓴 - 세부는 3단계")
    assert.ok(!warnings.some((w) => w.includes("요약 상자")), warnings.join(" / "))
    assert.equal(paraOf(outSec, "새 세부").paraPr, paraOf(tplSec, "견본 세부").paraPr)
  })
})

describe("견본 표 본문 행 테두리 — 머리 구분선·바깥선을 행마다 긋지 않는다", () => {
  it("본문 1행 견본으로 8행 표를 만들면 이중선은 머리 아래 한 번, 굵은 바깥선은 마지막 행 아래에만", async () => {
    const template = new Uint8Array(await markdownToHwpx("# 견본\n\n| 구분 | 내용 |\n| --- | --- |\n| 가 | 나 |\n", { gongmun: { preset: "official" } }))
    const md = "# 결과\n\n| 구분 | 내용 |\n| --- | --- |\n" + Array.from({ length: 8 }, (_, i) => `| 항목${i + 1} | 내용${i + 1} |`).join("\n") + "\n"
    const out = await markdownToHwpx(md, { template })
    const zip = await JSZip.loadAsync(out)
    const header = await zip.file("Contents/header.xml")!.async("string")
    const section = await zip.file("Contents/section0.xml")!.async("string")
    const side = (id: string, s: string) => {
      const m = header.match(new RegExp(`<hh:borderFill id="${id}"[\\s\\S]*?</hh:borderFill>`))![0].match(new RegExp(`<hh:${s}Border type="(\\w+)" width="([^"]+)"`))!
      return `${m[1]} ${m[2]}`
    }
    const rows = [...section.matchAll(/<hp:tr>[\s\S]*?<\/hp:tr>/g)].map(tr => tr[0].match(/<hp:tc [^>]*borderFillIDRef="(\d+)"/)![1])
    assert.equal(rows.length, 9)
    assert.match(side(rows[1], "top"), /^DOUBLE_SLIM/)
    for (let i = 2; i < 9; i++) assert.equal(side(rows[i], "top"), "SOLID 0.12 mm", `${i}행 윗변`)
    for (let i = 1; i < 8; i++) assert.equal(side(rows[i], "bottom"), "SOLID 0.12 mm", `${i}행 아랫변`)
    assert.equal(side(rows[8], "bottom"), "SOLID 0.4 mm")
    const ids = [...header.matchAll(/<hh:borderFill id="(\d+)"/g)].map(m => Number(m[1]))
    assert.deepEqual(ids, ids.map((_, i) => i + 1)) // 새 정의도 번호가 빈틈없이 이어진다
    assert.equal(Number(header.match(/<hh:borderFills itemCnt="(\d+)"/)![1]), ids.length)
  })
})
