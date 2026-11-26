/**
 * 라운드트립 패치 — 각주 참조 부호·리터럴 이스케이프 (v4.14.3).
 *
 * 파서가 본문에 각주·미주 참조 부호("1)"·"문1）")를 끼우면서 IR 문단 텍스트가 hp:t 와 달라졌다 —
 * 매핑(resolveParagraphMappings)이 부호를 XML 속성에서 재구성해 되빼고, 패치는 부호를 hp:t 에
 * 쓰지 않는다 (주석 개체 XML 은 그대로). 각주 글을 고친 편집은 각주 본문 문단에 싣는다 (#240, patch-footnote-text.test.ts).
 * escapeGfm 이 리터럴 | · < 를 \| · \< 로 내므로 패치 역변환(unescapeGfm)이 백슬래시를 hp:t 에
 * 남기지 않아야 한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { openHwpxDocument } from "../src/roundtrip/session.js"

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

async function sectionXml(data: Uint8Array | ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(data)
  return await zip.file("Contents/section0.xml")!.async("string")
}

/** 문서의 hp:t 글만 이어 붙임 (주석 본문 subList 포함 — 주석 개체 보존 확인용) */
const tTexts = (xml: string) => [...xml.matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map(m => m[1])
const noteXml = (xml: string) => xml.match(/<hp:footNote\b[\s\S]*?<\/hp:footNote>/)?.[0]

async function makeNoted(): Promise<{ original: Uint8Array; markdown: string }> {
  const buf = await markdownToHwpx("플라스틱 액체[^n]와 같은 원료를 쓴다\n\n[^n]: 플라스틱 액체란\n\n다른 문단")
  const parsed = await parseHwpx(buf)
  assert.ok(parsed.success)
  return { original: new Uint8Array(buf), markdown: parsed.markdown }
}

describe("patchHwpx — 각주 참조 부호가 있는 문단", () => {
  it("파서 출력: 본문에 부호 \"1)\" 가 끼워진다 (hp:t 에는 없다)", async () => {
    const { original, markdown } = await makeNoted()
    assert.ok(markdown.includes("플라스틱 액체1)와 같은 원료를 쓴다 (주: 1) 플라스틱 액체란)"), markdown)
    assert.ok(!tTexts(await sectionXml(original)).some(t => t.includes("1)")))
  })

  it("부호 앞 글 수정 — hp:t 에 부호 없이 반영, 주석 개체 XML 은 그대로", async () => {
    const { original, markdown } = await makeNoted()
    const edited = markdown.replace("플라스틱 액체1)와", "투명한 플라스틱 액체1)와")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success, res.error)
    assert.equal(res.applied, 1, JSON.stringify(res.skipped))
    const before = await sectionXml(original)
    const after = await sectionXml(res.data!)
    assert.equal(noteXml(after), noteXml(before), "주석 개체 XML 보존")
    const ts = tTexts(after)
    assert.ok(ts.some(t => t.includes("투명한 플라스틱 액체")), JSON.stringify(ts))
    assert.ok(!ts.some(t => /액체1\)/.test(t)), `부호가 hp:t 에 새면 안 된다: ${JSON.stringify(ts)}`)
    const re = await parseHwpx(toAB(res.data!))
    assert.ok(re.success && re.markdown.includes("투명한 플라스틱 액체"), re.success ? re.markdown : "")
  })

  it("부호 뒤 글 수정도 반영 (부호는 앞 낱말에 붙은 등장만 뺀다)", async () => {
    const { original, markdown } = await makeNoted()
    const edited = markdown.replace("같은 원료를 쓴다", "같은 원료 1) 를 쓴다")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const ts = tTexts(await sectionXml(res.data!))
    // 본문 부호 "액체1)" 만 빠지고, 사용자가 띄어 쓴 리터럴 "1)" 은 남는다. 바뀐 자리만 고치므로 주석 개체 앞뒤
    // hp:t 가 각자 제 글을 지킨다: 주석 자리("액체" 뒤)가 문단 끝으로 밀리지 않는다
    assert.ok(ts.includes("플라스틱 액체") && ts.includes("와 같은 원료 1) 를 쓴다"), JSON.stringify(ts))
    assert.ok(!ts.some(t => /액체1\)/.test(t)), JSON.stringify(ts))
  })

  it("주석 글 수정은 주석 본문 문단에, 본문 수정은 본문에 — 주석 개체의 글 밖 XML 은 그대로 (#240)", async () => {
    const { original, markdown } = await makeNoted()
    const edited = markdown.replace("(주: 1) 플라스틱 액체란)", "(주: 1) 바뀐 주석)").replace("같은 원료를", "같은 재료를")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.applied === 1)
    assert.deepEqual(res.skipped, [])
    const after = await sectionXml(res.data!)
    // 주석 개체는 고친 글과 줄 나눔 캐시(고친 문단은 한글이 다시 짜도록 지운다)만 다르다
    const noLineseg = (xml?: string) => xml?.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
    assert.equal(noLineseg(noteXml(after)), noLineseg(noteXml(await sectionXml(original)))?.replace("플라스틱 액체란", "바뀐 주석"))
    assert.ok(tTexts(after).some(t => t.includes("같은 재료를")))
  })

  it("주석 번호를 고친 편집은 사유로 보고하고 본문만 적용, 주석 XML 은 그대로", async () => {
    const { original, markdown } = await makeNoted()
    const edited = markdown.replace("(주: 1) 플라스틱 액체란)", "(주: 7) 플라스틱 액체란)").replace("같은 원료를", "같은 재료를")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.applied === 1)
    assert.ok(res.skipped.some(s => s.reason.includes("각주 번호 수정")), JSON.stringify(res.skipped))
    const after = await sectionXml(res.data!)
    assert.equal(noteXml(after), noteXml(await sectionXml(original)))
    assert.ok(tTexts(after).some(t => t.includes("같은 재료를")))
  })

  it("주석 안 표(#149) 문단 — HTML 격자 표기를 주석 수정으로 오인하지 않는다, 표 칸을 고치면 미지원 보고", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("표 기준\n\n| A | B |\n| --- | --- |\n| C | D |\n"))
    const xml = await zip.file("Contents/section0.xml")!.async("string")
    const tblAt = xml.indexOf("<hp:tbl")
    const pStart = xml.lastIndexOf("<hp:p ", tblAt)
    const pEnd = xml.indexOf("</hp:p>", xml.indexOf("</hp:tbl>", tblAt)) + "</hp:p>".length
    const host = `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>미주 본문</hp:t>` +
      `<hp:ctrl><hp:endNote number="1" instId="1"><hp:subList>${xml.slice(pStart, pEnd)}</hp:subList></hp:endNote></hp:ctrl></hp:run></hp:p>`
    zip.file("Contents/section0.xml", xml.slice(0, pStart) + host + xml.slice(pEnd))
    const original = await zip.generateAsync({ type: "uint8array" })
    const parsed = await parseHwpx(toAB(original), { layoutTables: "keep" })
    assert.ok(parsed.success && parsed.markdown.includes("미주 본문1) (주: <table>"), parsed.success ? parsed.markdown : "")
    const res = await patchHwpx(original, parsed.markdown.replace("미주 본문", "고친 미주 본문"))
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    assert.deepEqual(res.skipped, [])
    assert.ok(tTexts(await sectionXml(res.data!)).includes("고친 미주 본문"))
    const cellEdit = await patchHwpx(original, parsed.markdown.replace("미주 본문", "고친 미주 본문").replace("<td>D</td>", "<td>E</td>"))
    assert.ok(cellEdit.success && cellEdit.applied === 1)
    assert.ok(cellEdit.skipped.some(s => s.reason.includes("각주 텍스트 수정은 미지원")), JSON.stringify(cellEdit.skipped))
  })

  it("세션 API 도 부호를 뺀다 (patcher 와 같은 매핑)", async () => {
    const { original } = await makeNoted()
    const session = await openHwpxDocument(original)
    const idx = session.blocks.findIndex(b => b.text?.includes("액체1)"))
    assert.ok(idx >= 0)
    const res = await session.patchBlocks([{ blockIndex: idx, newText: "고체 플라스틱 액체1)와 같은 원료를 쓴다" }])
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const ts = tTexts(await sectionXml(res.data!))
    assert.ok(ts.some(t => t.includes("고체 플라스틱 액체")) && !ts.some(t => /액체1\)/.test(t)), JSON.stringify(ts))
  })
})

describe("patchHwpx — 리터럴 | · <Table 이 든 문단", () => {
  it("마크다운엔 \\| · \\< 로 나가고, 패치된 hp:t 에는 백슬래시가 남지 않는다", async () => {
    const buf = await markdownToHwpx("특수 \\| 파이프 \\<Table 18-4: X> 문단\n\n끝 문단")
    const parsed = await parseHwpx(buf)
    assert.ok(parsed.success)
    assert.ok(parsed.markdown.includes("특수 \\| 파이프 \\<Table 18-4: X> 문단"), parsed.markdown)
    const original = new Uint8Array(buf)
    assert.ok(tTexts(await sectionXml(original)).some(t => t.includes("특수 | 파이프 &lt;Table 18-4: X&gt; 문단")), "생성기 역이스케이프")
    const edited = parsed.markdown.replace("특수 \\| 파이프", "수정 \\| 파이프")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success && res.applied === 1, JSON.stringify(res.skipped))
    const ts = tTexts(await sectionXml(res.data!))
    assert.ok(ts.some(t => t.includes("수정 | 파이프 &lt;Table 18-4: X&gt; 문단")), JSON.stringify(ts))
    assert.ok(!ts.some(t => t.includes("\\")), `백슬래시 누출: ${JSON.stringify(ts)}`)
  })
})
