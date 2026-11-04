// 합성 원본 HWPX: 글상자(사각형 drawText) 안 결재표, 그 칸들에 작은 표(서명·체크 칸) — 마지막 열은 빈 작은 표만 든 칸.
// 사용: npm run build 뒤 node tests/fixtures/textbox-nested/make-source.mjs <출력.hwpx>
// 이 HWPX 를 한/글로 열어 HWP 로 저장한 것이 textbox-nested.hwp, 그 HWP 를 다시 HWPX 로 저장한 것이 textbox-nested.hwpx(정답)
import { writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { markdownToHwpx } from "../../../dist/index.js"

const JSZip = createRequire(import.meta.url)("jszip")
const SUB = '<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">'
const run = (inner) => `<hp:run charPrIDRef="0">${inner}</hp:run>`
const para = (...inner) => `<hp:p paraPrIDRef="0" styleIDRef="0">${inner.join("")}</hp:p>`
const text = (t) => run(`<hp:t>${t}</hp:t>`)
let nextId = 2001

/** 칸: { c, r, cs?, rs?, w, h, body: 문단 XML[] } */
function tc({ c, r, cs = 1, rs = 1, w, h, body }) {
  return `<hp:tc name="" header="0" hasMargin="0" protect="0" editable="0" dirty="0" borderFillIDRef="2">${SUB}${body.join("")}</hp:subList>` +
    `<hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/><hp:cellSz width="${w}" height="${h}"/>` +
    `<hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`
}
/** 표: rows = 칸 목록의 행 배열. inline 이면 글자처럼 취급(칸 안 작은 표) */
function tbl(rowCnt, colCnt, w, h, rows, inline) {
  const pos = inline
    ? '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
    : '<hp:pos treatAsChar="0" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>'
  return `<hp:tbl id="${nextId++}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="2" noShading="0">` +
    `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>${pos}` +
    '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="141" bottom="141"/>' +
    rows.map((cells) => `<hp:tr>${cells.map(tc).join("")}</hp:tr>`).join("") + "</hp:tbl>"
}
// 칸 안 작은 표: 1×1 빈 칸, 2×1 빈 칸(위·아래), 글 있는 2×2(병합 칸 포함)
const box1 = () => tbl(1, 1, 2400, 1200, [[{ c: 0, r: 0, w: 2400, h: 1200, body: [para(text(" "))] }]], true)
const box2 = () => tbl(2, 1, 2400, 1800, [
  [{ c: 0, r: 0, w: 2400, h: 900, body: [para(text(" "))] }],
  [{ c: 0, r: 1, w: 2400, h: 900, body: [para(text(" "))] }],
], true)
const sign = (a, b, c) => tbl(2, 2, 5000, 2000, [
  [{ c: 0, r: 0, cs: 2, w: 5000, h: 1000, body: [para(text(a))] }],
  [{ c: 0, r: 1, w: 2500, h: 1000, body: [para(text(b))] }, { c: 1, r: 1, w: 2500, h: 1000, body: [para(text(c))] }],
], true)
const inl = (...t) => para(run(t.join("")))

// 바깥 결재표 4행 × 6열 — 마지막 열(5)은 빈 작은 표만 든 칸
const W = 7000, H = 3000
const outer = tbl(4, 6, 6 * W, 4 * H, [
  [
    { c: 0, r: 0, cs: 2, w: 2 * W, h: H, body: [para(text("결재 구분"))] },
    { c: 2, r: 0, cs: 2, w: 2 * W, h: H, body: [para(text("1차 검토"))] },
    { c: 4, r: 0, w: W, h: H, body: [para(text("2차 검토"))] },
    { c: 5, r: 0, w: W, h: H, body: [inl(box2(), box1())] },
  ],
  [
    { c: 0, r: 1, rs: 2, w: W, h: 2 * H, body: [para(text("담당 부서"))] },
    { c: 1, r: 1, w: W, h: H, body: [para(text("기안"))] },
    { c: 2, r: 1, cs: 2, w: 2 * W, h: H, body: [inl(sign("검토자 서명", "가람", "나래"))] },
    { c: 4, r: 1, w: W, h: H, body: [inl(box2(), box1())] },
    { c: 5, r: 1, w: W, h: H, body: [inl(box2(), box1())] },
  ],
  [
    { c: 1, r: 2, w: W, h: H, body: [para(text("협조"))] },
    { c: 2, r: 2, cs: 2, w: 2 * W, h: H, body: [inl(box2()), para(text("협조 의견란"))] },
    { c: 4, r: 2, w: W, h: H, body: [para(text(" "))] },
    { c: 5, r: 2, w: W, h: H, body: [inl(box1()), inl(box2())] },
  ],
  [
    { c: 0, r: 3, cs: 5, w: 5 * W, h: H, body: [para(text("결재 비고 사항"))] },
    { c: 5, r: 3, w: W, h: H, body: [inl(box2(), box1())] },
  ],
], false)

const RECT = '<hp:rect id="3001" zOrder="1" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="3002" ratio="0">' +
  '<hp:offset x="0" y="0"/><hp:orgSz width="46000" height="18000"/><hp:curSz width="46000" height="18000"/><hp:flip horizontal="0" vertical="0"/>' +
  '<hp:rotationInfo angle="0" centerX="23000" centerY="9000" rotateimage="0"/><hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/>' +
  '<hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
  '<hp:lineShape color="#000000" width="33" style="SOLID" endCap="FLAT" headStyle="NORMAL" tailStyle="NORMAL" headfill="1" tailfill="1" headSz="MEDIUM_MEDIUM" tailSz="MEDIUM_MEDIUM" outlineStyle="NORMAL" alpha="0"/>' +
  '<hp:shadow type="NONE" color="#000000" offsetX="0" offsetY="0" alpha="0"/>' +
  `<hp:drawText lastWidth="46000" name="" editable="0">${SUB}` +
  para(text("글상자 첫 문단 안내")) + para(run(outer)) + para(text("글상자 끝 문단 안내")) +
  '</hp:subList><hp:textMargin left="283" right="283" top="283" bottom="283"/></hp:drawText>' +
  '<hc:pt0 x="0" y="0"/><hc:pt1 x="46000" y="0"/><hc:pt2 x="46000" y="18000"/><hc:pt3 x="0" y="18000"/>' +
  '<hp:sz width="46000" widthRelTo="ABSOLUTE" height="18000" heightRelTo="ABSOLUTE" protect="0"/>' +
  '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
  '<hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:rect>'

const zip = await JSZip.loadAsync(await markdownToHwpx("글상자 앞 본문\n\n자리\n\n글상자 뒤 본문\n"))
let xml = await zip.file("Contents/section0.xml").async("string")
xml = xml.replace('xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"', '$& xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"')
xml = xml.replace("<hp:t>자리</hp:t>", RECT + "<hp:t/>")
zip.file("Contents/section0.xml", xml)
writeFileSync(process.argv[2], await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", mimeType: "application/hwp+zip" }))
