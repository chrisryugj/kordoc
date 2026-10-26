import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { renderHwpxPages } from "../src/render/svg-render.js"

const ns = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"'
// "쪽 번호" 스타일 글자 모양(id 1)의 크기 — 없으면 본문 run 글자 모양과 무관하게 10pt
async function numberSize(styleHeight: number | null): Promise<string | undefined> {
  const head = `<hh:head ${ns}><hh:fontfaces><hh:fontface lang="HANGUL"><hh:font id="0" face="함초롬바탕" type="TTF"/></hh:fontface></hh:fontfaces>` +
    `<hh:charProperties><hh:charPr id="0" height="1500"><hh:fontRef hangul="0"/></hh:charPr>` +
    (styleHeight ? `<hh:charPr id="1" height="${styleHeight}"><hh:fontRef hangul="0"/></hh:charPr>` : "") + `</hh:charProperties>` +
    `<hh:paraProperties><hh:paraPr id="0"><hh:align horizontal="LEFT"/></hh:paraPr></hh:paraProperties>` +
    (styleHeight ? `<hh:styles><hh:style id="10" type="PARA" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="1"/></hh:styles>` : "") + `</hh:head>`
  const sec = `<hs:sec ${ns}><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr><hp:pagePr width="20000" height="40000"><hp:margin header="0" footer="0" left="2000" right="2000" top="500" bottom="500"/></hp:pagePr></hp:secPr>` +
    `<hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl><hp:t>가</hp:t></hp:run>` +
    `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1500" textheight="1500" baseline="1275" spacing="900" horzpos="0" horzsize="16000"/></hp:linesegarray></hp:p></hs:sec>`
  const z = new JSZip()
  z.file("Contents/header.xml", head); z.file("Contents/section0.xml", sec)
  const svg = (await renderHwpxPages(await z.generateAsync({ type: "uint8array" }))).pageSvgs.get(1) ?? ""
  return svg.match(/<text [^>]*font-size="([\d.]+)"[^>]*>- 1 -<\/text>/)?.[1]
}

describe("render: 쪽 번호 글자 크기", () => {
  it("\"쪽 번호\" 스타일 크기를 따른다 (12pt 스타일 → 12pt)", async () => {
    assert.equal(await numberSize(1200), "12")
  })
  it("스타일이 없으면 run 크기(15pt)와 무관하게 10pt", async () => {
    assert.equal(await numberSize(null), "10")
  })
})
