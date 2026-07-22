/**
 * #54 회귀 — applyCellEdit 빈 셀 분기: raw t-도메인이 공백만일 때 값을 채우면
 * buildParagraphSplices가 그 공백 t를 통째 교체해 요청 경계 밖 원문(공백 문자)을
 * 제거하던 문제. 공백은 보존하고 값은 t 맨 앞에 zero-length 삽입해야 한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { scanSectionXml, applySplices } from "../src/roundtrip/source-map.js"
import { applyCellEdit } from "../src/roundtrip/table-patch.js"
import type { IRTable } from "../src/types.js"

const SEC_OPEN = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">`

/** 라벨 셀(0,0)=성명 + 값 셀(0,1)=valuePara 로 표 XML 조립 */
function tableXml(valuePara: string): string {
  return `${SEC_OPEN}<hp:p id="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr>` +
    `<hp:tc><hp:subList id=""><hp:p id="1"><hp:run charPrIDRef="0"><hp:t>성명</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>` +
    `<hp:tc><hp:subList id="">${valuePara}</hp:subList><hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>` +
    `</hp:tr></hp:tbl></hp:run></hp:p></hs:sec>`
}

/** 값 셀(0,1)에 value를 채우고 결과 XML + 적용 여부 + skip 사유 반환 */
function fillValueCell(valuePara: string, value: string, origText = ""): { xml: string; applied: number; skipped: unknown[] } {
  const scan = scanSectionXml(tableXml(valuePara), 0)
  const scanTable = scan.tables[0]
  const table: IRTable = {
    rows: 1, cols: 2, hasHeader: false,
    cells: [[
      { text: "성명", colSpan: 1, rowSpan: 1 },
      { text: origText, colSpan: 1, rowSpan: 1 },
    ]],
  }
  const ctx = { scans: [scan], sectionSplices: [[]] as never[][], skipped: [] as unknown[] }
  const origLineCount = origText ? origText.split("\n").filter(Boolean).length : 0
  const applied = applyCellEdit(table, scanTable, 0, 1, [value], ctx as never, origText, value, origLineCount)
  return { xml: applySplices(scan.xml, ctx.sectionSplices[0] as never), applied, skipped: ctx.skipped }
}

/** 값 셀(id=2) 문단의 첫 hp:t 콘텐츠 */
function valueT(xml: string): string | undefined {
  return xml.match(/<hp:p id="2">[\s\S]*?<hp:t>([\s\S]*?)<\/hp:t>/)?.[1]
}

describe("#54 빈 셀 공백 보존 (applyCellEdit)", () => {
  it("공백 1자 t → 값 삽입 + 공백 suffix 보존 (경계 밖 원문 손실 금지)", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"><hp:t> </hp:t></hp:run></hp:p>`, "홍길동")
    assert.equal(applied, 1)
    assert.equal(valueT(xml), "홍길동 ", "기존 공백 1자 보존")
    assert.ok(xml.includes("성명"), "라벨 셀 무영향")
  })

  it("공백 여러 자 t → 전부 suffix로 보존", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"><hp:t>   </hp:t></hp:run></hp:p>`, "홍길동")
    assert.equal(applied, 1)
    assert.equal(valueT(xml), "홍길동   ", "공백 3자 전부 보존")
  })

  it("무회귀: 빈 t(<hp:t></hp:t>) → 값만 채움 (보존할 공백 없음)", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"><hp:t></hp:t></hp:run></hp:p>`, "홍길동")
    assert.equal(applied, 1)
    assert.equal(valueT(xml), "홍길동")
  })

  it("무회귀: 자기닫힘 <hp:t/> → 태그 펼쳐 값 삽입", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"><hp:t/></hp:run></hp:p>`, "홍길동")
    assert.equal(applied, 1)
    assert.equal(valueT(xml), "홍길동")
  })

  it("무회귀: 자기닫힘 <hp:run/> 빈 문단 → run 펼쳐 t 삽입", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"/></hp:p>`, "홍길동")
    assert.equal(applied, 1)
    assert.ok(xml.includes("홍길동"), "빈 run 문단에 값 삽입")
  })

  it("무회귀: non-whitespace 값 셀 → 기존 교체 경로 (empty 분기 아님)", () => {
    const { xml, applied } = fillValueCell(`<hp:p id="2"><hp:run charPrIDRef="0"><hp:t>기존값</hp:t></hp:run></hp:p>`, "홍길동", "기존값")
    assert.equal(applied, 1)
    assert.equal(valueT(xml), "홍길동", "기존값 교체")
    assert.ok(!xml.includes("기존값"))
  })
})
