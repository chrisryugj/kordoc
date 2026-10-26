/**
 * 채움(점선 리더) 탭 뒤 글 보존 회귀 테스트.
 *
 * 문의: 환경부 굴뚝 원격감시체계 업무편람 목차 "1. 추진배경 및 목적·····3" 처럼 점선 채움 탭을 만나면 그 뒤 글이 잘린다.
 * HWPX·HWP5·HWP3 파서가 채움 탭 뒤를 목차 쪽 번호로 보고 문단 끝까지 잘라, 쪽 번호만이 아니라 일정표의 일정
 * (gate-fill 36646162 "사용자 의견조사 ····· '26년 8~9월"), 줄바꿈 뒤 다음 목차 항목(rhwp issue6044
 * "<참고2> 직종별사업체노동력조사 개요 ···· 20")까지 사라졌다. 채움 탭도 보통 탭으로 — 채움선(점)은 글이 아니라 내지 않고
 * 뒤 글은 남긴다(PDF tab-leaders 가 점 채움을 탭 하나로 바꾸고 쪽 번호를 남기는 것과 같다).
 * HWPML 은 <TAB/> 을 통째로 빠뜨려 쪽 번호가 글에 붙었다("추진체계3"). DOCX 는 종전부터 남긴다(고정점).
 * 아래 문단 XML 은 코퍼스 실파일 구조를 줄인 합성본이다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"
import type { IRBlock } from "../src/types.js"

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`
const tab = (leader: number, width = 15000) => `<hp:tab width="${width}" leader="${leader}" type="2"/>`
const p = (runs: string) => `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${runs}</hp:t></hp:run></hp:p>`

async function makeHwpx(body: string): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`)
  return zip.generateAsync({ type: "nodebuffer" })
}

async function parseOk(buf: Buffer, filename: string): Promise<{ markdown: string; blocks: IRBlock[] }> {
  const r = await parse(buf, { filename })
  assert.ok(r.success, `파싱 실패: ${r.success ? "" : r.error}`)
  return { markdown: r.markdown, blocks: r.blocks }
}

const texts = (blocks: IRBlock[]) => blocks.filter(b => b.type === "paragraph" && b.text).map(b => b.text)

describe("HWPX 채움 탭 — 뒤 글을 남긴다", () => {
  it("목차 쪽 번호가 글과 한 줄에 남는다 (쪽 번호가 같은 run·따로 선 run 모두)", async () => {
    const body =
      p(`1. 추진배경 및 목적${tab(3)}3`) +
      // 행정업무운영 편람 꼴 — 탭 run · 고정폭 빈칸 run · 쪽 번호 run
      `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>2. 관련법령 및 규정${tab(3)}</hp:t></hp:run>` +
      `<hp:run charPrIDRef="1"><hp:t><hp:fwSpace/></hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>4</hp:t></hp:run></hp:p>` +
      p(`Ⅱ. 굴뚝 원격감시체계의 운영·관리`) +
      p(`1. 굴뚝 원격감시체계 관제센터의 설치·운영${tab(1)}23`)
    const r = await parseOk(await makeHwpx(body), "toc.hwpx")
    assert.deepEqual(texts(r.blocks), [
      "1. 추진배경 및 목적 3",
      "2. 관련법령 및 규정 4",
      "Ⅱ. 굴뚝 원격감시체계의 운영·관리",
      "1. 굴뚝 원격감시체계 관제센터의 설치·운영 23",
    ])
    assert.ok(r.markdown.includes("관제센터의 설치·운영 23"), r.markdown)
  })

  it("줄바꿈 뒤 다음 목차 항목·일정표의 일정이 사라지지 않는다", async () => {
    const body =
      p(`&lt;참고1&gt; (통계표) 주요 항목별 동향${tab(3)}19<hp:lineBreak/>&lt;참고2&gt; 직종별사업체노동력조사 개요${tab(3)}20`) +
      `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t> ㅇ 시스템 개선을 위한 사용자 의견조사${tab(3)}</hp:t></hp:run>` +
      `<hp:run charPrIDRef="1"><hp:t>'26년 8~9월</hp:t></hp:run></hp:p>`
    const r = await parseOk(await makeHwpx(body), "plan.hwpx")
    assert.deepEqual(texts(r.blocks), [
      "<참고1> (통계표) 주요 항목별 동향 19\n<참고2> 직종별사업체노동력조사 개요 20",
      "ㅇ 시스템 개선을 위한 사용자 의견조사 '26년 8~9월",
    ])
  })

  it("채움 없는 탭과 같은 결과 — 채움선(점)은 글로 내지 않는다", async () => {
    const withLeader = await parseOk(await makeHwpx(p(`제1장 개요${tab(3)}1`)), "a.hwpx")
    const plain = await parseOk(await makeHwpx(p(`제1장 개요${tab(0)}1`)), "b.hwpx")
    assert.deepEqual(withLeader.blocks.map(b => b.text), plain.blocks.map(b => b.text))
    // 채움 탭 + 쪽 번호 줄은 목차 항목이라 제목으로 올리지 않는다 (#121) — 채움 없는 탭 줄은 종전대로 "제N장" 제목
    assert.deepEqual([withLeader.blocks[0].type, plain.blocks[0].type], ["paragraph", "heading"])
    assert.ok(!/[·.]{2,}/.test(withLeader.markdown), withLeader.markdown)
  })
})

describe("HWPML <TAB/> — 쪽 번호가 글에 붙지 않는다", () => {
  it("목차 \"추진체계<TAB/>3\" 이 \"추진체계3\" 이 아니라 탭으로 갈린다", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.9" SubVersion="10.0.0.0" Style="embed">` +
      `<HEAD><MAPPINGTABLE></MAPPINGTABLE></HEAD><BODY><SECTION Id="0">` +
      `<P ParaShape="0"><TEXT CharShape="0"><CHAR>Ⅰ. 사업 개요 및 추진체계<TAB/>3</CHAR></TEXT></P>` +
      `</SECTION></BODY></HWPML>`
    const r = await parseOk(Buffer.from(xml, "utf8"), "toc.hml")
    assert.deepEqual(texts(r.blocks), ["Ⅰ. 사업 개요 및 추진체계\t3"])
  })
  it("묶음·고정폭 빈칸은 빈칸, 강제 줄바꿈은 줄바꿈, 하이픈은 내지 않는다", async () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.9" SubVersion="10.0.0.0" Style="embed">` +
      `<HEAD><MAPPINGTABLE></MAPPINGTABLE></HEAD><BODY><SECTION Id="0">` +
      `<P ParaShape="0"><TEXT CharShape="0"><CHAR>추진<NBSPACE/>배경<FWSPACE/>및<LINEBREAK/>목적<HYPEN/>안</CHAR></TEXT></P>` +
      `</SECTION></BODY></HWPML>`
    const r = await parseOk(Buffer.from(xml, "utf8"), "spaces.hml")
    assert.deepEqual(texts(r.blocks), ["추진 배경 및\n목적안"])
  })
})

describe("DOCX 목차 채움 탭 — 쪽 번호(PAGEREF 표시값)가 남는다 (고정점)", () => {
  it("w:tab leader=dot 뒤 쪽 번호", async () => {
    const zip = new JSZip()
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`)
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`)
    const tocPara = `<w:p><w:pPr><w:tabs><w:tab w:val="right" w:leader="dot" w:pos="9016"/></w:tabs></w:pPr>` +
      `<w:r><w:t>1. 추진배경 및 목적</w:t></w:r><w:r><w:tab/></w:r>` +
      `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGEREF _Toc1 \\h </w:instrText></w:r>` +
      `<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>`
    zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${tocPara}</w:body></w:document>`)
    const r = await parseOk(await zip.generateAsync({ type: "nodebuffer" }), "toc.docx")
    assert.deepEqual(texts(r.blocks), ["1. 추진배경 및 목적 3"])
  })
})
