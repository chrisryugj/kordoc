/** HWPX 양식 채우기 — 빈 run 처리 회귀 테스트 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { fillHwpx } from "../src/form/filler-hwpx.js"

/**
 * 한컴오피스가 HWP→HWPX 변환 시 빈 셀을 self-closing <hp:run/>으로
 * 만들면서 <hp:t>를 생략하는 케이스를 재현한다.
 */
async function makeMinimalHwpxWithEmptyValueCell(): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")

  const sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:tbl>
        <hp:tr>
          <hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0">
            <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
              <hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
                <hp:run charPrIDRef="0"><hp:t>성명</hp:t></hp:run>
              </hp:p>
            </hp:subList>
            <hp:cellAddr colAddr="0" rowAddr="0"/>
            <hp:cellSpan colSpan="1" rowSpan="1"/>
            <hp:cellSz width="2000" height="500"/>
            <hp:cellMargin left="0" right="0" top="0" bottom="0"/>
          </hp:tc>
          <hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="0">
            <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
              <hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
                <hp:run charPrIDRef="0"/>
              </hp:p>
            </hp:subList>
            <hp:cellAddr colAddr="1" rowAddr="0"/>
            <hp:cellSpan colSpan="1" rowSpan="1"/>
            <hp:cellSz width="2000" height="500"/>
            <hp:cellMargin left="0" right="0" top="0" bottom="0"/>
          </hp:tc>
        </hp:tr>
      </hp:tbl>
    </hp:run>
  </hp:p>
</hs:sec>`

  zip.file("Contents/section0.xml", sectionXml)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("fillHwpx — empty run handling", () => {
  it("값 셀의 <hp:run>이 <hp:t> 없이 self-closing이어도 값이 삽입된다", async () => {
    const buffer = await makeMinimalHwpxWithEmptyValueCell()
    const result = await fillHwpx(buffer, { 성명: "홍길동" })

    assert.equal(result.filled.length, 1, `filled count: ${result.filled.length}`)
    assert.equal(result.filled[0].label, "성명")
    assert.equal(result.filled[0].value, "홍길동")

    const zip = await JSZip.loadAsync(result.buffer)
    const section = await zip.file("Contents/section0.xml")!.async("text")

    assert.ok(
      section.includes("홍길동"),
      "출력 XML에 삽입한 값이 실제로 들어있어야 한다 (regression: 이전엔 filled로 보고만 되고 XML엔 안 들어갔음)",
    )
  })
})
