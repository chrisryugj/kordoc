/**
 * v4.14.3 — HWPX 미기입 누름틀 안내문: 값 자리 글이 안내문 그대로(CLICK_HERE·dirty="0")면 한컴은 화면에만
 * 흐리게 보이고 인쇄하지 않는다. IR 글에는 남기고(양식 채우기·패치가 원문 자리와 맞대도록) placeholder span
 * 으로 표시해 마크다운에서만 뺀다. rhwp form-01·form-02·issue1893 이 한컴 PDF 에 없는 안내문을 본문으로 냈다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { fillHwpx } from "../src/form/filler-hwpx.js"

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

/** 누름틀 필드 — form-01 실파일 구조 (Command·Direction 매개변수, dirty 속성) */
function clickHere(guide: string, value: string, dirty: "0" | "1"): string {
  return `<hp:ctrl><hp:fieldBegin id="7" type="CLICK_HERE" name="f" editable="1" dirty="${dirty}" zorder="-1" fieldid="9">` +
    `<hp:parameters cnt="3" name=""><hp:integerParam name="Prop">9</hp:integerParam>` +
    `<hp:stringParam name="Command" xml:space="preserve">Clickhere:set:48:Direction:wstring:${guide.length}:${guide} HelpState:wstring:0:  </hp:stringParam>` +
    `<hp:stringParam name="Direction">${guide}</hp:stringParam></hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>` +
    `<hp:run charPrIDRef="0"><hp:t>${value}</hp:t></hp:run>` +
    `<hp:run charPrIDRef="0"><hp:ctrl><hp:fieldEnd beginIDRef="7" fieldid="9"/></hp:ctrl>`
}
const para = (inner: string) => `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p>`

async function build(body: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`)
  return zip.generateAsync({ type: "arraybuffer" })
}
const parse = async (body: string) => parseHwpxDocument(await build(body))

describe("HWPX 미기입 누름틀 안내문 — IR 에 표시, 마크다운에서 뺀다", () => {
  it("dirty=0 + 값이 안내문 그대로: 블록 글엔 남고 마크다운에는 없다", async () => {
    const r = await parse(para(`<hp:t>성명: </hp:t>${clickHere("여기에 입력", "여기에 입력", "0")}<hp:t> (서명)</hp:t>`))
    const [b] = r.blocks.filter(x => x.type === "paragraph")
    assert.equal(b.text, "성명: 여기에 입력 (서명)")
    assert.deepEqual(b.spans?.filter(s => s.placeholder).map(s => s.text), ["여기에 입력"])
    assert.ok(!r.markdown.includes("여기에 입력"), r.markdown)
    assert.ok(r.markdown.includes("성명:") && r.markdown.includes("(서명)"), r.markdown)
  })

  it("수정된 필드(dirty=1)·안내문과 다른 값은 그대로", async () => {
    const r1 = await parse(para(`<hp:t>성명: </hp:t>${clickHere("여기에 입력", "여기에 입력", "1")}`))
    assert.ok(r1.markdown.includes("여기에 입력"), r1.markdown)
    const r2 = await parse(para(`<hp:t>성명: </hp:t>${clickHere("여기에 입력", "홍길동", "0")}`))
    assert.ok(r2.markdown.includes("홍길동"), r2.markdown)
    assert.equal(r2.blocks[0].spans, undefined)
  })

  it("채우기가 값을 넣으면 수정 표시(dirty=1)를 켜 안내문과 같은 값도 본문으로 읽힌다 (#3380)", async () => {
    const filled = await fillHwpx(await build(para(`<hp:t>성명: </hp:t>${clickHere("여기에 입력", "", "0")}`)), { f: "여기에 입력" })
    const xml = await (await JSZip.loadAsync(filled.buffer)).file("Contents/section0.xml")!.async("string")
    assert.match(xml, /fieldBegin[^>]*dirty="1"/)
    const r = await parseHwpxDocument(filled.buffer)
    assert.ok(r.markdown.includes("여기에 입력"), r.markdown)
    const empty = await fillHwpx(await build(para(clickHere("여기에 입력", "", "0"))), { f: "" })
    const xml2 = await (await JSZip.loadAsync(empty.buffer)).file("Contents/section0.xml")!.async("string")
    assert.match(xml2, /fieldBegin[^>]*dirty="0"/, "빈 값은 미수정 유지")
  })

  it("표 칸 안 누름틀도 칸 마크다운에서 뺀다", async () => {
    const cell = (c: number, inner: string) =>
      `<hp:tc><hp:subList><hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p></hp:subList>` +
      `<hp:cellAddr colAddr="${c}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`
    const tbl = `<hp:tbl rowCnt="1" colCnt="2"><hp:tr>${cell(0, "<hp:t>소속</hp:t>")}${cell(1, clickHere("소속관서", "소속관서", "0"))}</hp:tr></hp:tbl>`
    const r = await parse(para(tbl))
    assert.ok(r.markdown.includes("소속"), r.markdown)
    assert.ok(!r.markdown.includes("소속관서"), r.markdown)
    const t = r.blocks.find(x => x.type === "table")?.table
    assert.ok(t, "표 블록")
    assert.equal(t!.cells[0][1].text, "소속관서", "IR 칸 글에는 남는다")
  })

  it("병합 칸이 있는 표(HTML 방출)에서도 뺀다", async () => {
    const cell = (c: number, r: number, inner: string, cs = 1) =>
      `<hp:tc><hp:subList><hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run></hp:p></hp:subList>` +
      `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="1"/></hp:tc>`
    const tbl = `<hp:tbl rowCnt="2" colCnt="2"><hp:tr>${cell(0, 0, "<hp:t>제목</hp:t>", 2)}</hp:tr>` +
      `<hp:tr>${cell(0, 1, "<hp:t>일자</hp:t>")}${cell(1, 1, clickHere("0000.00.00.", "0000.00.00.", "0"))}</hp:tr></hp:tbl>`
    const r = await parse(para(tbl))
    assert.ok(r.markdown.includes("<table>") && r.markdown.includes("일자"), r.markdown)
    assert.ok(!r.markdown.includes("0000.00.00."), r.markdown)
  })
})
