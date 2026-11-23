/**
 * 목차 항목(#121) — 줄마다 "글 + 채움 탭 + 쪽 번호"뿐인 문단은 제목으로 올리지 않는다. 채움 탭 뒤 글은 그대로 남긴다(4.17.0).
 * 4.17.0~4.18.1 은 "제1장 총칙 1" 이 heading·outline·breadcrumb 에 본문 제목 "제1장 총칙" 과 다른 제목으로 들어갔다.
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"
import { takeTocLeaders, TOC_LEADER } from "../src/toc-entry.js"
import { appendParaText, createParaTextState } from "../src/hwp5/record.js"

describe("takeTocLeaders", () => {
  it("줄마다 글 + 채움 탭 + 쪽 번호면 목차 항목, 채움 탭은 보통 탭이 된다", () => {
    assert.deepEqual(takeTocLeaders(`제1장 총칙${TOC_LEADER}1`), { text: "제1장 총칙\t1", tocEntry: true })
    assert.deepEqual(takeTocLeaders(`<붙임1> 세부 일정${TOC_LEADER}10\n<붙임2> 관련 법령${TOC_LEADER}12`).tocEntry, true)
    for (const page of ["iv", "3-12", "- 5 -", " 120"]) assert.equal(takeTocLeaders(`제2절 기준${TOC_LEADER}${page}`).tocEntry, true, page)
  })

  it("쪽 번호가 아닌 채움 탭 뒤 글·채움 탭 없는 줄이 섞이면 목차가 아니다", () => {
    assert.deepEqual(takeTocLeaders(`의견 조사${TOC_LEADER}10~11월`), { text: "의견 조사\t10~11월", tocEntry: false })
    assert.equal(takeTocLeaders(`목 차\n제1장 총칙${TOC_LEADER}1`).tocEntry, false)
    assert.equal(takeTocLeaders(`${TOC_LEADER}1`).tocEntry, false)
    assert.deepEqual(takeTocLeaders("제1장 총칙\t1"), { text: "제1장 총칙\t1", tocEntry: false })
  })
})

/** 한컴 보고서 손 목차를 흉내 낸 최소 HWPX (#121 제보 재현 구조) */
async function tocHwpx(): Promise<ArrayBuffer> {
  const NS = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'
  const TAB = '<hp:tab width="30000" leader="3" type="2"/>'
  const p = (inner: string, cp = 1) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="${cp}"><hp:t>${inner}</hp:t></hp:run></hp:p>`
  const chapters = [["제1장 총칙", "1"], ["제1절 목적", "2"], ["제2장 운영 기준", "5"]]
  const body = [p("○○공사 업무 개선 추진계획(합성)"), p("목 차"), ...chapters.map(([t, n]) => p(`${t}${TAB}${n}`)),
    p(`&lt;붙임1&gt; 세부 일정${TAB}10<hp:lineBreak/>&lt;붙임2&gt; 관련 법령${TAB}12`, 0),
    ...chapters.flatMap(([t]) => [p(t), p(`${t.split(" ")[1]} 관련 본문 문장입니다(합성).`, 0)]),
    p(`의견 조사${TAB}10~11월`, 0)]
  const font = (id: number, h: number) => `<hh:charPr id="${id}" height="${h}"/>`
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("META-INF/container.xml", '<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf"/></ocf:rootfiles></ocf:container>')
  zip.file("Contents/content.hpf", '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml"/><opf:item id="section0" href="Contents/section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>')
  zip.file("Contents/header.xml", `<?xml version="1.0"?><hh:head ${NS} version="1.4" secCnt="1"><hh:refList><hh:charProperties itemCnt="2">${font(0, 1000)}${font(1, 1200)}</hh:charProperties></hh:refList></hh:head>`)
  zip.file("Contents/section0.xml", `<?xml version="1.0"?><hs:sec ${NS}>${body.join("")}</hs:sec>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

describe("HWPX 목차 줄 (#121)", () => {
  it("목차 항목은 문단으로, 본문 제목만 heading·outline 에 — 채움 탭 뒤 글(쪽 번호·일정)은 남는다", async () => {
    const r = await parse(await tocHwpx())
    assert.ok(r.success)
    const headings = r.blocks.filter(b => b.type === "heading").map(b => b.text)
    // 문서 제목과 "목 차"는 12pt(본문 10pt)라 글자 크기로 제목이 된다
    assert.deepEqual(headings, ["○○공사 업무 개선 추진계획(합성)", "목 차", "제1장 총칙", "제1절 목적", "제2장 운영 기준"])
    assert.deepEqual(r.outline?.map(o => o.text), headings)
    assert.ok(r.blocks.some(b => b.type === "paragraph" && b.text === "제1장 총칙 1"))
    assert.match(r.markdown, /<붙임2> 관련 법령 12/)
    assert.match(r.markdown, /의견 조사 10\\~11월/)
  })
})

describe("HWP5 채움 탭 (#121)", () => {
  // 탭 확장 u16[7] 중 [2] 하위 바이트 = 채움 모양 (0 없음·3 점선)
  const tab = (leader: number) => {
    const b = Buffer.alloc(16)
    b.writeUInt16LE(9, 0); b.writeUInt16LE(3000, 2); b.writeUInt16LE(leader | (3 << 8), 6); b.writeUInt16LE(9, 14)
    return b
  }
  const text = (s: string) => Buffer.from(s, "utf16le")

  it("본문 파서(tocLeaders)만 채움 탭을 표지로 받는다 — 채움 없는 탭·표지 끈 경로는 보통 탭", () => {
    const data = Buffer.concat([text("제1장 총칙"), tab(3), text("1"), text(" "), tab(0), text("x")])
    const on = createParaTextState()
    on.tocLeaders = true
    appendParaText(on, data)
    assert.equal(on.text, `제1장 총칙${TOC_LEADER}1 \tx`)
    const off = createParaTextState()
    appendParaText(off, data)
    assert.equal(off.text, "제1장 총칙\t1 \tx")
  })
})
