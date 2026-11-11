/** 패치 구조 편집 — 문단 추가·삭제, 항목 부호에 맞춘 견본 문단 복제 (견본 서식 그대로 새 문서 쓰기) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { markerClass, pairTablesInGaps } from "../src/roundtrip/structure-edit.js"

const REPORT_MD = [
  "# 점검 결과보고", "",
  "□ 추진근거", "  - 2026년 점검계획", "    - 세부 일정 확정", "",
  "□ 점검개요", "  - 점검기간 : 6. 15.∼6. 26.", "  - 점검대상 : 냉방설비", "",
  "※ 참고 사항",
].join("\n")

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function makeReport(): Promise<{ original: Uint8Array; markdown: string }> {
  const original = new Uint8Array(await markdownToHwpx(REPORT_MD, { gongmun: { preset: "report" } }))
  const parsed = await parseHwpx(toAB(original), { layoutTables: "keep" })
  assert.ok(parsed.success)
  return { original, markdown: parsed.markdown }
}

async function sectionXml(data: Uint8Array): Promise<string> {
  const zip = await JSZip.loadAsync(data)
  return zip.file("Contents/section0.xml")!.async("string")
}

/** 글이 든 최상위 문단의 여는 태그 + run 글자 모양 순서 (서식 지문) */
function paraShape(xml: string, text: string): string {
  const at = xml.indexOf(text)
  assert.ok(at > 0, `문단 없음: ${text}`)
  const start = xml.lastIndexOf("<hp:p ", at)
  const end = xml.indexOf("</hp:p>", at)
  const p = xml.slice(start, end)
  const pr = /paraPrIDRef="(\d+)"/.exec(p)![1]
  const runs = [...p.matchAll(/charPrIDRef="(\d+)"/g)].map(m => m[1]).join(",")
  return `${pr}|${runs}`
}

describe("patchHwpx 구조 편집: 추가", () => {
  it("○ 줄 추가 → 옆 ○ 문단을 복제해 같은 문단·글자 모양", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("ㅇ 점검대상 : 냉방설비", "ㅇ 점검대상 : 냉방설비\n\nㅇ 점검방법 : 합동 현장점검")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.deepEqual(res.skipped, [])
    assert.deepEqual(res.verification?.stats, { added: 0, removed: 0, modified: 0, unchanged: res.verification!.stats.unchanged })
    const before = await sectionXml(original), after = await sectionXml(res.data!)
    assert.equal(paraShape(after, "점검방법 : 합동 현장점검"), paraShape(before, "점검대상 : 냉방설비"))
    // 새 문단은 줄 배치 캐시 없이 (한컴이 다시 조판) — 원본 문단 자체는 남는다
    const p = after.slice(after.lastIndexOf("<hp:p ", after.indexOf("점검방법")), after.indexOf("</hp:p>", after.indexOf("점검방법")))
    assert.ok(!p.includes("linesegarray"))
    assert.ok(after.includes("점검대상 : 냉방설비"))
  })

  it("- 줄 추가 → 멀리 있어도 같은 부호(-) 문단을 견본으로", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("ㅇ 점검대상 : 냉방설비", "ㅇ 점검대상 : 냉방설비\n\n- 기계실·자료실 포함")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const before = await sectionXml(original), after = await sectionXml(res.data!)
    assert.equal(paraShape(after, "기계실·자료실 포함"), paraShape(before, "세부 일정 확정"))
    const r2 = await parseHwpx(toAB(res.data!), { layoutTables: "keep" })
    const lines = r2.markdown.split("\n").filter(l => l.trim())
    assert.equal(lines[lines.findIndex(l => l.includes("점검대상")) + 1].trim(), "\\- 기계실·자료실 포함", "추가 위치 — 공문 '-' 부호는 이스케이프한 글자 부호로 나간다")
  })

  it("이스케이프한 공문 '-' 줄(\\- …)을 고쳐도 문서 글에 역슬래시가 새지 않는다", async () => {
    const { original, markdown } = await makeReport()
    assert.match(markdown, /^\\- 세부 일정 확정$/m, "공문 '-' 는 4칸 들여쓰기(코드 블록) 대신 이스케이프 부호")
    const res = await patchHwpx(original, markdown.replace("\\- 세부 일정 확정", "\\- 세부 일정 변경"))
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.ok(after.includes("세부 일정 변경") && !after.includes("\\"), "글 치환·역슬래시 없음(부호 뒤는 탭)")
  })

  it("□ 묶음 통째로 추가 — 부호마다 견본 서식", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("※ 참고 사항", "□ 행정사항\n\nㅇ 결과 공유\n\n※ 참고 사항")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.equal(res.applied, 2)
    const before = await sectionXml(original), after = await sectionXml(res.data!)
    assert.equal(paraShape(after, "행정사항"), paraShape(before, "점검개요"))
    assert.equal(paraShape(after, "결과 공유"), paraShape(before, "점검대상 : 냉방설비"))
  })
})

describe("patchHwpx 구조 편집: 견본 강조 run", () => {
  // 질문지 꼴 — "○ (현황)" 은 부호 보통 + 소제목 굵게, "- 안내" 는 통째로 굵은 파랑(글자 모양 9 = 굵게 0 + 파랑)
  const FORM_MD = ["# 사전 질문지", "", "○ **(현황)**", "", "1) 현재 구동 형태는?", "", "**- 아래 내용 중 다른 부분이 있으면 수정**", "", "끝 문단"].join("\n")

  async function makeForm(): Promise<{ original: Uint8Array; markdown: string; plain: string }> {
    const zip = await JSZip.loadAsync(new Uint8Array(await markdownToHwpx(FORM_MD)))
    let header = await zip.file("Contents/header.xml")!.async("string")
    const bold = /<hh:charPr id="1"[\s\S]*?<\/hh:charPr>/.exec(header)![0]
    header = header.replace("</hh:charProperties>", bold.replace('id="1"', 'id="99"').replace('textColor="#000000"', 'textColor="#0000FF"') + "</hh:charProperties>")
    zip.file("Contents/header.xml", header)
    const xml = await zip.file("Contents/section0.xml")!.async("string")
    zip.file("Contents/section0.xml", xml.replace('<hp:run charPrIDRef="1"><hp:t>- 아래', '<hp:run charPrIDRef="99"><hp:t>- 아래'))
    const original = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    const markdown = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    assert.ok(markdown.includes("○ **(현황)**") && markdown.includes("**- 아래 내용"), markdown)
    const plain = /<hp:run charPrIDRef="(\d+)"><hp:t>끝 문단/.exec(xml)![1]
    return { original, markdown, plain }
  }

  const runsOf = (xml: string, text: string): string[] => {
    const at = xml.indexOf(text)
    assert.ok(at > 0, `문단 없음: ${text}`)
    const p = xml.slice(xml.lastIndexOf("<hp:p ", at), xml.indexOf("</hp:p>", at))
    return [...p.matchAll(/<hp:run charPrIDRef="(\d+)"><hp:t>([^<]*)<\/hp:t>/g)].filter(m => m[2]).map(m => `${m[1]}:${m[2]}`)
  }

  it("평문 ○ 줄 추가 → 견본 굵은 소제목 글자 모양이 아니라 굵지 않은 본문 글자 모양", async () => {
    const { original, markdown, plain } = await makeForm()
    const edited = markdown.replace("○ **(현황)**", "○ **(현황)**\n\n○ 서버 없음, 이용자 PC에 설치해 실행")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.deepEqual(runsOf(after, "서버 없음"), [`${plain}:○ `, `${plain}:서버 없음, 이용자 PC에 설치해 실행`])
    assert.equal((await parseHwpx(toAB(res.data!), { layoutTables: "keep" })).markdown, edited)
  })

  it("평문 - 줄 추가 → 굵은 파랑 견본의 강조를 뺀 짝 글자 모양(같은 크기·글꼴)", async () => {
    const { original, markdown, plain } = await makeForm()
    const edited = markdown.replace(/(\*\*- 아래 내용[^\n]*)/, "$1\n\n- 업로드 화면과 처리 API")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.deepEqual(runsOf(after, "업로드 화면"), [`${plain}:- 업로드 화면과 처리 API`])
    assert.equal((await parseHwpx(toAB(res.data!), { layoutTables: "keep" })).markdown, edited)
  })

  it("강조 표지가 견본과 다르게 놓인 새 글 → 강조 조각만 견본 강조 글자 모양", async () => {
    const { original, markdown, plain } = await makeForm()
    const edited = markdown.replace("○ **(현황)**", "○ **(현황)**\n\n○ **(목적)** 시범 운영 전 기능 범위 파악")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.deepEqual(runsOf(after, "시범 운영"), [`${plain}:○ `, "1:(목적)", `${plain}: 시범 운영 전 기능 범위 파악`])
    assert.equal((await parseHwpx(toAB(res.data!), { layoutTables: "keep" })).markdown, edited)
  })

  it("강조 자리가 견본과 같으면 종전대로 조각마다 제 run", async () => {
    const { original, markdown, plain } = await makeForm()
    const edited = markdown.replace("○ **(현황)**", "○ **(현황)**\n\n○ **(대상 서비스)**")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.deepEqual(runsOf(after, "대상 서비스"), [`${plain}:○ `, "1:(대상 서비스)"])
  })
})

describe("patchHwpx 구조 편집: 삭제·갈아입히기", () => {
  it("문단 삭제 → 문단째 사라지고 앞뒤는 그대로", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("ㅇ 점검기간 : 6. 15.∼6. 26.\n\n", "")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.deepEqual(res.skipped, [])
    assert.equal(res.verification?.stats.removed, 0)
    const after = await sectionXml(res.data!)
    assert.ok(!after.includes("점검기간"))
    assert.ok(after.includes("점검대상 : 냉방설비") && after.includes("점검개요"))
  })

  it("부호가 바뀐 수정 → 새 부호 견본 문단으로 갈아입힘", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("※ 참고 사항", "ㅇ 결과 공유")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const before = await sectionXml(original), after = await sectionXml(res.data!)
    assert.equal(paraShape(after, "결과 공유"), paraShape(before, "점검대상 : 냉방설비"))
    assert.ok(!after.includes("참고 사항"))
  })

  it("부호가 같은 수정은 제자리 글 치환 (문단 유지)", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("ㅇ 점검대상 : 냉방설비", "ㅇ 점검대상 : 공조설비")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    const before = await sectionXml(original), after = await sectionXml(res.data!)
    // 글만 바뀌었으면 줄 배치 캐시 외 태그 수가 같다
    const tags = (x: string) => (x.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "").match(/<[^>]+>/g) ?? []).length
    assert.equal(tags(after), tags(before))
  })

  it("구조 편집 뒤 최상위 문단 캐시는 비우고, 앞 문단 캐시는 둔다", async () => {
    // 생성본엔 줄 배치 캐시가 없다 — 한컴 저장본처럼 문단마다 캐시를 단다
    const { original: gen, markdown } = await makeReport()
    const zip = await JSZip.loadAsync(gen)
    const seg = '<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1500" textheight="1500" baseline="1275" spacing="900" horzpos="0" horzsize="48000" flags="393216"/></hp:linesegarray>'
    zip.file("Contents/section0.xml", (await zip.file("Contents/section0.xml")!.async("string")).replace(/<\/hp:p>/g, seg + "</hp:p>"))
    const original = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    const edited = markdown.replace("ㅇ 2026년 점검계획\n\n", "")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    const cut = after.indexOf("세부 일정 확정")
    assert.ok(!after.slice(cut).includes("linesegarray"), "편집 뒤 캐시 잔존")
    assert.ok(after.slice(0, after.indexOf("추진근거")).includes("linesegarray"), "편집 앞 캐시까지 지움")
  })

  it("structure: false → 종전처럼 추가·삭제 건너뜀", async () => {
    const { original, markdown } = await makeReport()
    const edited = markdown.replace("ㅇ 점검기간 : 6. 15.∼6. 26.\n\n", "") + "\n\nㅇ 새 줄"
    const res = await patchHwpx(original, edited, { structure: false })
    assert.ok(res.success)
    assert.ok(res.skipped.some(s => s.reason.includes("삭제")))
    assert.ok(res.skipped.some(s => s.reason.includes("추가")))
    const after = await sectionXml(res.data!)
    assert.ok(after.includes("점검기간") && !after.includes("새 줄"))
  })
})

describe("patchHwpx 구조 편집: 표", () => {
  const TABLE_MD = "앞 문단.\n\n| 항목 | 값 |\n| --- | --- |\n| 예산 | 1억 |\n\n뒤 문단."

  it("표 삭제 → 표만 담은 문단째 사라진다", async () => {
    const original = new Uint8Array(await markdownToHwpx(TABLE_MD))
    const md = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    const edited = md.replace(/\| 항목[\s\S]*?\| 1억 \|\n\n/, "")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.deepEqual(res.skipped, [])
    const after = await sectionXml(res.data!)
    assert.ok(!after.includes("<hp:tbl") && after.includes("뒤 문단."))
  })

  it("GFM 표 추가 → 그 자리에 새 표", async () => {
    const original = new Uint8Array(await markdownToHwpx("앞 문단.\n\n뒤 문단."))
    const md = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    const edited = md.replace("앞 문단.", "앞 문단.\n\n| 항목 | 값 |\n| --- | --- |\n| 예산 | 1억 |")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    const r2 = await parseHwpx(toAB(res.data!), { layoutTables: "keep" })
    assert.equal(r2.markdown, edited)
  })
})

describe("patchHwpx 구조 편집: 틀 표 칸 안", () => {
  it("칸 안 ㅇ 줄 끼우기 → 칸 안 ㅇ 문단 복제, 뒤 줄은 제 문단 그대로", async () => {
    const gen = new Uint8Array(await markdownToHwpx("<table>\n<tr><th>구분</th><th>내용</th></tr>\n<tr><td>점검</td><td>□ 개요<br>ㅇ 첫째 항목<br>ㅇ 둘째 항목<br>※ 참고</td></tr>\n</table>"))
    // 한컴 저장본처럼 부호마다 문단 모양을 다르게 (ㅇ = 7, ※ = 8)
    const zip = await JSZip.loadAsync(gen)
    let xml = await zip.file("Contents/section0.xml")!.async("string")
    xml = xml.replace(/(<hp:p\b[^>]*?paraPrIDRef=")\d+("[^>]*>(?:(?!<\/hp:p>)[\s\S])*?<hp:t>)(ㅇ|※)/g, (_m, a, b, mk) => `${a}${mk === "ㅇ" ? 7 : 8}${b}${mk}`)
    zip.file("Contents/section0.xml", xml)
    const original = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    const md = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    assert.ok(md.includes("ㅇ 첫째 항목<br>ㅇ 둘째 항목"), md)
    const edited = md.replace("ㅇ 첫째 항목<br>", "ㅇ 첫째 항목<br>ㅇ 끼운 항목<br>")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.deepEqual(res.skipped, [])
    const after = await sectionXml(res.data!)
    const pr = (t: string) => /paraPrIDRef="(\d+)"/.exec(after.slice(after.lastIndexOf("<hp:p ", after.indexOf(t))))![1]
    assert.equal(pr("끼운 항목"), "7")
    assert.equal(pr("둘째 항목"), "7")
    assert.equal(pr("참고"), "8")
    assert.equal((await parseHwpx(toAB(res.data!), { layoutTables: "keep" })).markdown, edited)
  })
})

describe("patchHwpx 구조 편집: 지킬 것", () => {
  it("쪽 나눔 문단의 부호를 바꿔도 쪽 나눔은 남는다", async () => {
    const { original: gen, markdown } = await makeReport()
    const zip = await JSZip.loadAsync(gen)
    const xml = await zip.file("Contents/section0.xml")!.async("string")
    const at = xml.lastIndexOf("<hp:p ", xml.indexOf("참고 사항"))
    zip.file("Contents/section0.xml", xml.slice(0, at) + xml.slice(at).replace(/^<hp:p /, '<hp:p pageBreak="1" '))
    const original = new Uint8Array(await zip.generateAsync({ type: "uint8array" }))
    const res = await patchHwpx(original, markdown.replace("※ 참고 사항", "ㅇ 결과 공유"))
    assert.ok(res.success, res.error)
    const after = await sectionXml(res.data!)
    assert.match(after.slice(after.lastIndexOf("<hp:p ", after.indexOf("결과 공유"))), /^<hp:p [^>]*pageBreak="1"/)
  })

  it("빈 칸에 여러 줄 → 빈 문단 없이 줄마다 문단", async () => {
    const original = new Uint8Array(await markdownToHwpx("<table>\n<tr><th>항목</th><th>내용</th></tr>\n<tr><td>비고</td><td></td></tr>\n</table>"))
    const md = (await parseHwpx(toAB(original), { layoutTables: "keep" })).markdown
    const edited = md.replace("| 비고 |  |", "| 비고 | 첫줄<br>둘째줄 |")
    assert.notEqual(edited, md)
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.equal((await parseHwpx(toAB(res.data!), { layoutTables: "keep" })).markdown, edited)
  })
})

describe("구조 편집 보조", () => {
  it("markerClass — 부호 부류", () => {
    assert.equal(markerClass("ㅇ 점검"), "○")
    assert.equal(markerClass(" ○ 점검"), "○")
    assert.equal(markerClass("- 세부"), "-")
    assert.equal(markerClass("□ 개요"), "□")
    assert.equal(markerClass("1. 목적"), "N.")
    assert.equal(markerClass("가) 세부"), "K)")
    assert.equal(markerClass("(1) 항"), "(N)")
    assert.equal(markerClass("① 첫째"), "①")
    assert.equal(markerClass("붙임  자료 1부."), "붙임")
    assert.equal(markerClass("*******"), "", "가림 글은 부호 아님")
    assert.equal(markerClass("일반 문장"), "")
    assert.equal(markerClass("개요", 2), "h2:")
    assert.equal(markerClass("(주) 광진건설"), "", "괄호 음절은 부호 아님")
    assert.equal(markerClass("(가) 세부"), "(K)")
  })

  it("pairTablesInGaps — 갭 안 같은 꼴 표를 수정으로 짝짓는다", () => {
    const a = [{ kind: "text" }, { kind: "html-table" }, { kind: "text" }]
    const b = [{ kind: "text" }, { kind: "text" }, { kind: "html-table" }]
    const out = pairTablesInGaps([[0, 0], [1, null], [2, null], [null, 1], [null, 2]], a, b)
    assert.deepEqual(out, [[0, 0], [null, 1], [1, 2], [2, null]])
  })
})
