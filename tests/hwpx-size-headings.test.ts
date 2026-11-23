/**
 * HWPX 글자 크기 제목: 문단 대표 글자 모양을 hp:run 의 charPrIDRef 에서 읽는다. 종전엔 hp:r 만 읽어 한글 저장 HWPX(hp:run)
 * 문단에 글자 크기가 없었고, 같은 문서의 HWP 는 "Ⅰ. 개요"가 제목인데 HWPX 는 문단이었다(한컴 HWP·HWPX 짝 1,120개 중 154개).
 * 블록으로 넘어가는 칸 문단(강조 span·각주·중첩 구조가 있는 칸)도 글자 크기를 갖고, 본문 크기는 HWP 와 같이 글자 수 가중 최빈값으로 정한다.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parse } from "../src/index.js"

const NS = 'xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"'
const REF = `<hh:borderFills itemCnt="1"><hh:borderFill id="1">${["leftBorder", "rightBorder", "topBorder", "bottomBorder"].map(n => `<hh:${n} type="NONE" width="0.12 mm" color="#000000"/>`).join("")}</hh:borderFill></hh:borderFills>` +
  `<hh:charProperties itemCnt="3"><hh:charPr id="0" height="1000"/><hh:charPr id="1" height="1600"/><hh:charPr id="2" height="1000"><hh:bold/></hh:charPr></hh:charProperties>`
const p = (s: string, cp = 0) => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="${cp}"><hp:t>${s}</hp:t></hp:run></hp:p>`
const frame = (inner: string) => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:tbl rowCnt="1" colCnt="1"><hp:tr><hp:tc borderFillIDRef="1"><hp:subList>${inner}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl></hp:run></hp:p>`

async function hwpx(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("META-INF/container.xml", '<?xml version="1.0"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf"/></ocf:rootfiles></ocf:container>')
  zip.file("Contents/content.hpf", '<?xml version="1.0"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/"><opf:manifest><opf:item id="header" href="Contents/header.xml"/><opf:item id="section0" href="Contents/section0.xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>')
  zip.file("Contents/header.xml", `<?xml version="1.0"?><hh:head ${NS} version="1.4" secCnt="1"><hh:refList>${REF}</hh:refList></hh:head>`)
  zip.file("Contents/section0.xml", `<?xml version="1.0"?><hs:sec ${NS}>${body}</hs:sec>`)
  return zip.generateAsync({ type: "arraybuffer" })
}

const body = [p("본문 첫 문장은 보통 크기로 길게 씁니다(합성)."), p("본문 둘째 문장도 같은 크기로 이어 씁니다(합성).")]

test("hp:run 문단의 큰 글자 줄은 제목이 된다", async () => {
  const r = await parse(await hwpx([p("Ⅰ. 개요", 1), ...body].join("")))
  assert.ok(r.success)
  assert.deepEqual(r.blocks.filter(b => b.type === "heading").map(b => [b.text, b.level]), [["Ⅰ. 개요", 1]])
})

test("보이지 않는 틀 표 칸의 큰 글자 줄도 틀을 푼 뒤 제목이 된다", async () => {
  const mixed = '<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>칸 안 설명 </hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>굵은 말</hp:t></hp:run></hp:p>'
  const r = await parse(await hwpx([frame(p("Ⅱ. 추진 목표", 1) + mixed), ...body].join("")))
  assert.ok(r.success)
  assert.ok(!r.blocks.some(b => b.type === "table"))
  assert.deepEqual(r.blocks.filter(b => b.type === "heading").map(b => b.text), ["Ⅱ. 추진 목표"])
})

test("본문 크기는 문단 수가 아니라 글자 수로 정한다. 짧은 큰 줄이 많아도 긴 본문 크기가 기준", async () => {
  const shortBig = ["가", "나", "다"].map(s => p(`${s}. 항목`, 1))
  const r = await parse(await hwpx([...shortBig, p("본문 문장은 보통 크기로 아주 길게 이어서 씁니다. 글자 수로 보면 이쪽이 훨씬 많습니다(합성).")].join("")))
  assert.ok(r.success)
  assert.equal(r.blocks.filter(b => b.type === "heading").length, 3)
})
