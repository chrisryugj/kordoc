/**
 * CDATA 텍스트 보존 회귀 테스트.
 *
 * `<hp:t><![CDATA[본문]]></hp:t>` 처럼 CDATA 로 저장된 텍스트가 경고 없이 통째로
 * 사라지던 결함(rhwp f4c7de75 와 같은 뿌리)의 고정점. 한컴 저장본은 CDATA 를 쓰지
 * 않지만 제3자 도구 산출물에서는 유효한 XML 표현이라 파서가 받아들여야 한다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { DOMParser } from "@xmldom/xmldom"
import JSZip from "jszip"
import { parseHwpx } from "../src/index.js"
import { extractTextFromNode, rawTextContent } from "../src/shared/xml.js"

const parseXml = (xml: string) => new DOMParser().parseFromString(xml, "text/xml")

describe("shared/xml — CDATA", () => {
  it("extractTextFromNode가 CDATA 섹션 텍스트를 포함한다", () => {
    const doc = parseXml(`<r><t><![CDATA[가나다]]></t></r>`)
    assert.equal(extractTextFromNode(doc.documentElement as unknown as Node), "가나다")
  })

  it("extractTextFromNode가 CDATA와 일반 텍스트를 순서대로 잇는다", () => {
    const doc = parseXml(`<r><t>앞<![CDATA[중간]]>뒤</t></r>`)
    assert.equal(extractTextFromNode(doc.documentElement as unknown as Node), "앞중간뒤")
  })

  it("rawTextContent가 CDATA의 공백을 원형대로 보존한다", () => {
    const doc = parseXml(`<CHAR><![CDATA[  들여쓰기  ]]></CHAR>`)
    assert.equal(rawTextContent(doc.documentElement as unknown as Node), "  들여쓰기  ")
  })
})

/** CDATA 런을 담은 최소 HWPX 생성 */
async function buildCdataHwpx(): Promise<Buffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0" encoding="UTF-8"?><ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`,
  )
  zip.file(
    "Contents/content.hpf",
    `<?xml version="1.0" encoding="UTF-8"?><opf:package xmlns:opf="http://www.idpf.org/2007/opf/" version=""><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="section0"/></opf:spine></opf:package>`,
  )
  zip.file(
    "Contents/header.xml",
    `<?xml version="1.0" encoding="UTF-8"?><hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4" secCnt="1"></hh:head>`,
  )
  zip.file(
    "Contents/section0.xml",
    `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
  <hp:p><hp:run charPrIDRef="0"><hp:t><![CDATA[CDATA로 저장된 문단]]></hp:t></hp:run></hp:p>
  <hp:p><hp:run charPrIDRef="0"><hp:t>일반 텍스트 문단</hp:t></hp:run></hp:p>
  <hp:p><hp:run charPrIDRef="0"><hp:t>앞<![CDATA[섞인]]>뒤</hp:t></hp:run></hp:p>
</hs:sec>`,
  )
  return zip.generateAsync({ type: "nodebuffer" })
}

describe("HWPX 파싱 — CDATA 런", () => {
  it("CDATA 런의 텍스트가 마크다운에 남는다", async () => {
    const result = await parseHwpx(await buildCdataHwpx())
    assert.ok(result.success, "파싱 성공")
    assert.match(result.markdown, /CDATA로 저장된 문단/)
    assert.match(result.markdown, /일반 텍스트 문단/)
    assert.match(result.markdown, /앞섞인뒤/)
  })
})
