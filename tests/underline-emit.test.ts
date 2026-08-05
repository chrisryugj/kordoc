import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { hasRealUnderline } from "../src/hwp5/parser.js"
import { extractHwpxStyles } from "../src/hwpx/styles.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { IRBlock } from "../src/types.js"

// 밑줄 판별자는 종류(type/bit 2-3) — 한컴은 밑줄 없는 charPr 에도
// <hh:underline type="NONE" shape="SOLID"/> 를 넣는다 (코퍼스 352파일 실측:
// NONE 15,603 / BOTTOM 156). BOTTOM 만 인정, 윗줄·미지 값은 fail-closed.

describe("hasRealUnderline — HWP5 CharShape 밑줄 판정 (bit 2-3)", () => {
  it("종류 1(글자 아래)은 밑줄", () => {
    assert.equal(hasRealUnderline(0b0100), true)
  })

  it("종류 0(없음)은 밑줄 아님", () => {
    assert.equal(hasRealUnderline(0), false)
  })

  it("종류 3(글자 위)은 fail-closed", () => {
    assert.equal(hasRealUnderline(0b1100), false)
  })

  it("bold/italic 비트와 무간섭", () => {
    assert.equal(hasRealUnderline(0b0100 | 0x03), true)
    assert.equal(hasRealUnderline(0x03), false)
  })
})

describe("extractHwpxStyles — charPr underline 파싱", () => {
  const headerXml = (underlineAttr: string) => `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4">
  <hh:refList>
    <hh:charProperties>
      <hh:charPr id="0" height="1000"><hh:underline ${underlineAttr}/></hh:charPr>
      <hh:charPr id="1" height="1000"/>
    </hh:charProperties>
  </hh:refList>
</hh:head>`

  const makeZip = async (xml: string) => {
    const zip = new JSZip()
    zip.file("Contents/header.xml", xml)
    return zip
  }

  it('type="BOTTOM"은 underline=true', async () => {
    const styles = await extractHwpxStyles(await makeZip(headerXml('type="BOTTOM" shape="SOLID" color="#000000"')))
    assert.equal(styles.charProperties.get("0")?.underline, true)
    assert.equal(styles.charProperties.get("1")?.underline, undefined)
  })

  it('type="NONE"은 underline 미설정 (한컴 기본 잡음)', async () => {
    const styles = await extractHwpxStyles(await makeZip(headerXml('type="NONE" shape="SOLID" color="#000000"')))
    assert.equal(styles.charProperties.get("0")?.underline, undefined)
  })

  it('type="TOP"(윗줄)·type 없음은 fail-closed', async () => {
    const top = await extractHwpxStyles(await makeZip(headerXml('type="TOP" shape="SOLID"')))
    assert.equal(top.charProperties.get("0")?.underline, undefined)
    const noType = await extractHwpxStyles(await makeZip(headerXml('shape="SOLID"')))
    assert.equal(noType.charProperties.get("0")?.underline, undefined)
  })
})

describe("blocksToMarkdown — 밑줄 span 방출", () => {
  it("underline span은 <u>…</u>로 감싼다", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "제3조 개정",
      spans: [{ text: "제3조 " }, { text: "개정", underline: true }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "제3조 <u>개정</u>")
  })

  it("underline+bold 조합은 <u>**…**</u>", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "중요 개정",
      spans: [{ text: "중요 " }, { text: "개정", underline: true, bold: true }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "중요 <u>**개정**</u>")
  })

  it("underline+strike 조합은 <u>~~…~~</u>", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "이관 조문",
      spans: [{ text: "이관 " }, { text: "조문", underline: true, strike: true }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "이관 <u>~~조문~~</u>")
  })

  it("가장자리 공백은 마커 밖으로", () => {
    const blocks: IRBlock[] = [{
      type: "paragraph",
      text: "a b",
      spans: [{ text: "a" }, { text: " 개정 ", underline: true }, { text: "b" }],
    }]
    assert.equal(blocksToMarkdown(blocks).trim(), "a <u>개정</u> b")
  })
})
