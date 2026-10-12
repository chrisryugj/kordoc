/**
 * reflow 한컴 조판 규칙 — 한컴독스 웹 한글 조판 엔진에서 읽어 낸 규칙을 kordoc 코드로 다시 쓴 것.
 *  1. 글자 폭은 글자마다 4 HWPUNIT 단위(hancomCharWidth) — 공백은 4·⌊크기/8⌋, 자간은 ⌊폭/4⌋ 의 %를 4 단위로
 *  2. 폭표 없는 한글 글꼴은 한글 1em(faceClassForReflow) — 함초롬만 함초롬 폭, 옛 HFT 명조·고딕은 고정폭
 *  3. KoPub 바탕·돋움 실측 폭표(한글 0.936em·0.872em, 굵기끼리 같음)
 *  4. 공백 최소값(condense): 줄 가용폭 + 그 줄 공백 폭 합 × condense%
 *  5. 한컴 기본 금칙 집합 — 닫는 작은따옴표(’)는 줄머리 금지
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { hancomCharWidth, faceClassForReflow, simulateWrap } from "../src/hwpx/text-metrics.js"
import { fontAdvanceEm1000 } from "../src/hwpx/font-metrics.js"

describe("reflow 한컴 조판 규칙", () => {
  it("글자 폭은 글자마다 4 단위로 양자화한다", () => {
    assert.equal(hancomCharWidth("가", 1000, 100, 0, "hcr"), 972) // 4·MulDiv(970, 250, 1000) — 실수 폭 970
    assert.equal(hancomCharWidth(" ", 1100, 100, 0, "hcr"), 548) // 4·⌊1100/8⌋ — 0.5em(550) 이 아니다
    assert.equal(hancomCharWidth("가", 1300, 98, -2, "fixedPitch"), 1248) // 4·⌊1000·325·98/10⁵⌋ = 1272, 자간 4·MulDiv(318, −2, 100) = −24
    for (const [ch, h] of [["가", 1000], ["A", 1100], [" ", 1300]] as const) assert.equal(hancomCharWidth(ch, h, 100, 0, "hcr") % 4, 0)
  })

  it("폭표 없는 한글 글꼴은 한글 1em, 함초롬은 함초롬 폭, 명조·고딕은 고정폭", () => {
    assert.equal(faceClassForReflow("HY견명조"), "cjk")
    assert.equal(faceClassForReflow("신명조"), "cjk")
    assert.equal(faceClassForReflow("바탕"), "font:바탕") // 한컴 저장본 역추정 폭표
    assert.equal(faceClassForReflow("명조"), "fixedPitch") // 옛 HFT 기본 글꼴은 고정폭
    assert.equal(faceClassForReflow("고딕"), "fixedPitch")
    assert.equal(faceClassForReflow("함초롬바탕"), "hcr")
    assert.equal(faceClassForReflow("돋움체"), "fixedPitch")
    assert.equal(faceClassForReflow("KoPub바탕체 Light"), "font:KoPub바탕체 Light")
    assert.equal(hancomCharWidth("가", 1000, 100, 0, "cjk"), 1000)
    assert.equal(hancomCharWidth("A", 1000, 100, 0, "cjk"), hancomCharWidth("A", 1000, 100, 0, "hcr"))
  })

  it("KoPub 실측 폭표 — 굵기끼리 같은 표", () => {
    const ga = "가".codePointAt(0)!
    for (const w of ["Light", "Medium", "Bold"]) {
      assert.equal(fontAdvanceEm1000(`KoPub바탕체 ${w}`, ga), 936)
      assert.equal(fontAdvanceEm1000(`KoPub돋움체 ${w}`, ga), 872)
    }
    assert.equal(fontAdvanceEm1000("KoPubWorld돋움체_Pro Light", ga), 872)
  })

  it("실측 폭표 없는 주요 글꼴은 한컴 저장본 역추정 폭표", () => {
    const ga = "가".codePointAt(0)!
    for (const f of ["바탕", "한양신명조", "한컴바탕", "돋움"]) assert.ok(fontAdvanceEm1000(f, ga) !== null, f)
  })

  it("공백 최소값만큼 줄에 더 들어간다", () => {
    const text = "가가 가가 가가"
    const widths = [...text].map(c => (c === " " ? 50 : 100)) // 700
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths }).starts, [0, 6])
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths, condensePct: 50 }).starts, [0]) // 680 + 100·50% ≥ 700
    assert.deepEqual(simulateWrap(text, 680, 680, 1000, 100, "keep", { widths, condensePct: 10 }).starts, [0, 6]) // 680 + 10 < 700
  })

  it("한컴 금칙 — 닫는 작은따옴표는 줄머리에 오지 않는다", () => {
    const text = "가가가’"
    const widths = [100, 100, 100, 100]
    assert.deepEqual(simulateWrap(text, 300, 300, 1000, 100, "charAll", { widths }).starts, [0, 3])
    assert.deepEqual(simulateWrap(text, 300, 300, 1000, 100, "charAll", { widths, kinsoku: "hancom" }).starts, [0, 2])
  })
})

import { simulateWrap as wrap } from "../src/hwpx/text-metrics.js"
import { reflowSection } from "../src/render/reflow.js"
import { parseRenderStyles } from "../src/render/head-styles.js"
import { createXmlParser } from "../src/hwpx/parser-shared.js"

const NS = 'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"'
const HEAD = `<hh:head ${NS}><hh:refList><hh:fontfaces><hh:fontface lang="HANGUL"><hh:font id="0" face="바탕"/></hh:fontface><hh:fontface lang="LATIN"><hh:font id="0" face="바탕"/></hh:fontface></hh:fontfaces>
<hh:charProperties><hh:charPr id="0" height="1000"><hh:fontRef hangul="0" latin="0"/></hh:charPr><hh:charPr id="1" height="1000"><hh:fontRef hangul="0" latin="0"/><hh:supscript/></hh:charPr></hh:charProperties>
<hh:paraProperties><hh:paraPr id="0"><hh:align horizontal="LEFT"/><hh:breakSetting breakNonLatinWord="KEEP_WORD"/></hh:paraPr></hh:paraProperties></hh:refList></hh:head>`
/** 구역 XML 을 reflow 해 문단마다 lineseg [textpos, horzsize, horzpos] 목록을 돌려준다 */
function reflowed(body: string, bodyW = 42000, head = HEAD): number[][][] {
  const doc = createXmlParser().parseFromString(`<hs:sec ${NS}>${body}</hs:sec>`, "text/xml")
  const root = doc.documentElement as unknown as Element
  reflowSection(root, parseRenderStyles(head), { BODY_W: bodyW, BODY_H: 80000 })
  return Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).map(p => {
    const lsa = Array.from(p.childNodes as unknown as Element[]).find(c => c.nodeName === "hp:linesegarray")
    return lsa ? Array.from(lsa.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => [Number(s.getAttribute("textpos")), Number(s.getAttribute("horzsize")), Number(s.getAttribute("horzpos"))]) : []
  })
}
const tbl = (w: number) => `<hp:tbl rowCnt="1" colCnt="1"><hp:sz width="${w}" height="2000"/><hp:pos treatAsChar="1"/><hp:outMargin left="283" right="283" top="283" bottom="283"/><hp:tr><hp:tc><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>칸</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSz width="${w}" height="2000"/></hp:tc></hp:tr></hp:tbl>`

describe("reflow 한컴 조판 규칙 — 개체·컨트롤·다단·하위 목록", () => {
  it("본문 폭 인라인 표 둘은 한 줄에 하나씩 — 표는 그 폭의 글자다", () => {
    const [p] = reflowed(`<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${tbl(41700)}${tbl(41700)}<hp:t/></hp:run></hp:p>`)
    assert.deepEqual(p.map(s => s[0]), [0, 8])
  })
  it("쪽 번호 컨트롤 뒤 넓은 표는 다음 줄 — 구역·단 정의가 아닌 컨트롤은 줄의 내용", () => {
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:secPr/><hp:ctrl><hp:colPr colCount="1"/></hp:ctrl></hp:run><hp:run charPrIDRef="0"><hp:ctrl><hp:pageNum/></hp:ctrl>${tbl(41700)}<hp:t/></hp:run></hp:p>`
    assert.deepEqual(reflowed(body)[0].map(s => s[0]), [0, 24])
  })
  it("2단 구역은 단 폭으로 채운다", () => {
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:colPr colCount="2" sameSz="1" sameGap="2000"/></hp:ctrl><hp:t>${"가".repeat(30)}</hp:t></hp:run></hp:p>`
    const [p] = reflowed(body)
    assert.equal(p[0][1], 20000) // (42000 − 2000) ÷ 2
    assert.deepEqual(p.map(s => s[0]), [0, 28]) // 컨트롤 8칸 + 20자(1000 씩)
  })
  it("미주 안 문단도 줄 정보를 만든다", () => {
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:endNote><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(50)}</hp:t></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>`
    const ps = reflowed(body)
    assert.deepEqual(ps[1].map(s => s[0]), [0, 42])
  })
  it("강제 줄바꿈(lineBreak) 뒤는 새 줄 — 줄바꿈은 앞 줄 끝 한 칸", () => {
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>가나다<hp:lineBreak/>라마<hp:lineBreak/><hp:lineBreak/>바</hp:t></hp:run></hp:p>`
    assert.deepEqual(reflowed(body)[0].map(s => s[0]), [0, 4, 7, 8])
  })
  it("글머리표 문단은 글머리표 폭 + 간격(글자 크기의 textOffset%)만큼 좁게 채운다 — autoIndent 면 둘째 줄부터도", () => {
    const head = HEAD.replace("</hh:paraProperties>", `<hh:paraPr id="1"><hh:align horizontal="LEFT"/><hh:heading type="BULLET" idRef="1" level="0"/><hh:breakSetting breakNonLatinWord="KEEP_WORD"/></hh:paraPr></hh:paraProperties>`)
      .replace("<hh:charProperties>", `<hh:bullets itemCnt="1"><hh:bullet id="1" char="가" useImage="0"><hh:paraHead level="0" autoIndent="1" textOffsetType="PERCENT" textOffset="50" charPrIDRef="4294967295"/></hh:bullet></hh:bullets><hh:charProperties>`)
    const para = (pp: number) => `<hp:p paraPrIDRef="${pp}"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(90)}</hp:t></hp:run></hp:p>`
    assert.deepEqual(reflowed(para(0), 42000, head)[0].map(s => s[0]), [0, 42, 84])
    assert.deepEqual(reflowed(para(1), 42000, head)[0].map(s => s[0]), [0, 40, 80]) // 42000 − (1000 + 500) → 40자
    assert.deepEqual([...new Set(reflowed(para(1), 42000, head)[0].map(s => s[1]))], [42000]) // lineseg 폭은 그대로
  })
  it("미주는 구역 끝의 단 폭, 머리 번호(autoNum \"1)\")는 그 글 폭을 차지한다", () => {
    const note = (num: boolean) => `<hp:endNote><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${num ? `<hp:ctrl><hp:autoNum num="1" numType="ENDNOTE"><hp:autoNumFormat type="DIGIT" suffixChar=")"/></hp:autoNum></hp:ctrl>` : ""}<hp:t>${"가".repeat(20)}</hp:t></hp:run></hp:p></hp:subList></hp:endNote>`
    const body = (num: boolean) => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:colPr colCount="1"/></hp:ctrl><hp:ctrl>${note(num)}</hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>` +
      `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:colPr colCount="2" sameSz="1" sameGap="2000"/></hp:ctrl><hp:t>둘째 단</hp:t></hp:run></hp:p>`
    const plain = reflowed(body(false))[1], numbered = reflowed(body(true))[1]
    assert.deepEqual(plain.map(s => s[1]), [20000]) // (42000 − 2000) ÷ 2 — 미주가 걸린 1단 폭(42000)이 아니다
    assert.deepEqual(plain.map(s => s[0]), [0]) // 20자 × 1000 = 20000 에 꼭 찬다
    assert.equal(numbered.length, 2) // "1)" 몫만큼 넘친다
  })
  it("줄 간격 몫은 4 단위로 0에서 먼 쪽 반올림 — 100% 미만이면 음수로 겹쳐 올라온다", () => {
    const head = HEAD.replace("</hh:paraProperties>", `<hh:paraPr id="1"><hh:align horizontal="LEFT"/><hh:lineSpacing type="PERCENT" value="155"/></hh:paraPr><hh:paraPr id="2"><hh:align horizontal="LEFT"/><hh:lineSpacing type="PERCENT" value="90"/></hh:paraPr></hh:paraProperties>`)
      .replace(`<hh:charPr id="1" height="1000">`, `<hh:charPr id="2" height="1400"><hh:fontRef hangul="0" latin="0"/></hh:charPr><hh:charPr id="3" height="1500"><hh:fontRef hangul="0" latin="0"/></hh:charPr><hh:charPr id="1" height="1000">`)
    const vert = (pp: number, cpr: number) => {
      const doc = createXmlParser().parseFromString(`<hs:sec ${NS}><hp:p paraPrIDRef="${pp}"><hp:run charPrIDRef="${cpr}"><hp:t>${"가".repeat(60)}</hp:t></hp:run></hp:p><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>다음</hp:t></hp:run></hp:p></hs:sec>`, "text/xml")
      const root = doc.documentElement as unknown as Element
      reflowSection(root, parseRenderStyles(head), { BODY_W: 42000, BODY_H: 80000 })
      return Array.from(root.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => [Number(s.getAttribute("vertpos")), Number(s.getAttribute("spacing"))])
    }
    assert.deepEqual(vert(1, 2).slice(0, 2), [[0, 772], [2172, 772]]) // 1400 × 55% = 770 → 772
    const v90 = vert(2, 3)
    assert.deepEqual(v90[0], [0, -152]) // 1500 × −10% = −150 → −152
    assert.equal(v90[v90.length - 1][0], v90[v90.length - 2][0] + 1500 - 152) // 다음 문단도 음수 몫만큼 올라온다
  })
  it("줄 높이·기준선은 그 줄의 가장 큰 글자·개체로 — 수식은 baseLine%, 세로 가운데 정렬은 줄 가운데", () => {
    const head = HEAD.replace("</hh:paraProperties>", `<hh:paraPr id="1"><hh:align horizontal="LEFT" vertical="CENTER"/></hh:paraPr></hh:paraProperties>`)
      .replace(`<hh:charPr id="1" height="1000">`, `<hh:charPr id="2" height="1500"><hh:fontRef hangul="0" latin="0"/></hh:charPr><hh:charPr id="1" height="1000">`)
    const segs = (body: string) => {
      const doc = createXmlParser().parseFromString(`<hs:sec ${NS}>${body}</hs:sec>`, "text/xml")
      const root = doc.documentElement as unknown as Element
      reflowSection(root, parseRenderStyles(head), { BODY_W: 42000, BODY_H: 80000 })
      return Array.from(root.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => ["vertsize", "baseline", "spacing"].map(a => Number(s.getAttribute(a))))
    }
    // 글자 1000 run + 문단 끝 빈 1500 run → 줄 높이 1500, 간격 몫도 1500 기준(160% → 900)
    assert.deepEqual(segs(`<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>가나</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t/></hp:run></hp:p>`), [[1500, 1275, 900]])
    const eq = (h: number, bl: number) => `<hp:equation baseLine="${bl}"><hp:sz width="1000" height="${h}"/><hp:pos treatAsChar="1"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:script>x</hp:script></hp:equation>`
    // 수식 1650@51·1050@88: 높이는 1650(합 아님), 기준선은 윗부분 최대 round(1050 × 0.88) = 924
    assert.deepEqual(segs(`<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${eq(1650, 51)}${eq(1050, 88)}<hp:t/></hp:run></hp:p>`)[0].slice(0, 2), [1650, 924])
    assert.deepEqual(segs(`<hp:p paraPrIDRef="1"><hp:run charPrIDRef="0"><hp:t>가나</hp:t></hp:run></hp:p>`)[0].slice(0, 2), [1000, 500]) // 세로 가운데
  })
  it("쪽 넘김은 줄 단위 — 넘친 줄부터 새 쪽 0, 문단째 넘길 땐 문단 위 간격을 남기고, 외톨이줄 보호면 첫 줄만 남기지 않는다", () => {
    const head = HEAD.replace("</hh:paraProperties>", `<hh:paraPr id="1"><hh:align horizontal="LEFT"/><hh:breakSetting breakNonLatinWord="KEEP_WORD" widowOrphan="1"/></hh:paraPr><hh:paraPr id="2"><hh:align horizontal="LEFT"/><hh:breakSetting breakNonLatinWord="KEEP_WORD"/><hh:margin><hc:prev value="800"/></hh:margin></hh:paraPr></hh:paraProperties>`)
    const vps = (body: string) => {
      const doc = createXmlParser().parseFromString(`<hs:sec ${NS}>${body}</hs:sec>`, "text/xml")
      const root = doc.documentElement as unknown as Element
      reflowSection(root, parseRenderStyles(head), { BODY_W: 42000, BODY_H: 10000 })
      return Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).map(p => Array.from(p.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => Number(s.getAttribute("vertpos"))))
    }
    const para = (pp: number, n: number) => `<hp:p paraPrIDRef="${pp}"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(42 * n)}</hp:t></hp:run></hp:p>`
    // 줄 pitch 1600: 앞 문단 5줄(0~6400) 뒤 3줄 문단 — 8000·9600(+1000 > 10000) → 9600 줄부터 새 쪽
    assert.deepEqual(vps(para(0, 5) + para(0, 3))[1], [8000, 0, 1600])
    assert.deepEqual(vps(para(0, 5) + para(1, 3))[1], [0, 1600, 3200]) // 외톨이줄 보호 — 첫 줄 하나만 남기지 않는다
    assert.deepEqual(vps(para(0, 6) + para(2, 1))[1], [800]) // 9600 + 800 넘침 → 새 쪽, 문단 위 간격 800 은 남는다
  })
  it("2단 구역의 각주는 단 폭으로 채운다", () => {
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:colPr colCount="2" sameSz="1" sameGap="2000"/></hp:ctrl><hp:ctrl><hp:footNote><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(30)}</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>`
    const ps = reflowed(body)
    assert.deepEqual(ps[1].map(s => s[1]), [20000, 20000])
  })
  it("어울림 그림 옆 줄은 그림 폭 + 바깥 여백만큼 좁아지고, 그림 아래부터는 본문 폭", () => {
    const pic = `<hp:pic textWrap="SQUARE" textFlow="BOTH_SIDES"><hp:sz width="12000" height="5000"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="COLUMN" horzAlign="LEFT" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="1000" top="0" bottom="0"/></hp:pic>`
    const body = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0">${pic}<hp:t>${"가".repeat(90)}</hp:t></hp:run></hp:p><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>${"가".repeat(50)}</hp:t></hp:run></hp:p>`
    const [p1, p2] = reflowed(body)
    // 줄 간격 1600 — 0·1600·3200·4800 줄이 그림(0~5000)과 겹친다: 4줄 × 29자 > 90자
    assert.deepEqual(p1.map(s => [s[1], s[2]]), [[29000, 13000], [29000, 13000], [29000, 13000], [29000, 13000]].slice(0, p1.length))
    assert.ok(p1.length >= 3)
    assert.deepEqual([...new Set(p2.map(s => s[1]))], [42000])
  })
  it("위첨자는 크기 16/25 로 잰다", () => {
    const sup = (n: number) => `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="1"><hp:t>${"가".repeat(n)}</hp:t></hp:run></hp:p>`
    assert.deepEqual(reflowed(sup(70))[0].map(s => s[0]), [0, 65]) // 4·MulDiv(1000, ⌊640/4⌋, 1000) = 640 → 42000 ÷ 640 = 65자
  })
  it("공백에서 이미 줄 폭에 닿았으면 줄이 끝나고, 공백은 두 칸까지만 남는다", () => {
    const text = "가가 " + "나".repeat(3) + "      다다"
    const widths = [...text].map(c => (c === " " ? 50 : 100))
    // "가가 나나나" = 550 ≥ 550 → 첫 공백에서 줄 끝, 공백 둘은 남고 셋째부터 다음 줄
    assert.deepEqual(wrap(text, 550, 550, 1000, 100, "charAll", { widths, kinsoku: "hancom" }).starts, [0, 8])
    // condense 로 남는 폭이 있어도 다음 낱말은 새로 시작하지 못한다
    const t2 = "가가 나나 다다"
    const w2 = [...t2].map(c => (c === " " ? 50 : 100))
    assert.deepEqual(wrap(t2, 440, 440, 1000, 100, "charAll", { widths: w2, condensePct: 100, kinsoku: "hancom" }).starts, [0, 6])
  })
  it("마지막 글자의 자간은 넘침 판정에 넣지 않는다", () => {
    const text = "가가가가"
    const widths = [96, 96, 96, 96], spacings = [-4, -4, -4, -4] // 100 에 자간 −4
    assert.deepEqual(wrap(text, 384, 384, 1000, 100, "charAll", { widths, spacings, kinsoku: "hancom" }).starts, [0, 3]) // 288 + 100(자간 전) > 384
    assert.deepEqual(wrap(text, 384, 384, 1000, 100, "charAll", { widths, kinsoku: "hancom" }).starts, [0]) // 자간 몫을 안 주면 384 에 든다
  })
})
