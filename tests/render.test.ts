/**
 * 레이아웃 보존 렌더 (src/render/) — 단위 + 실파일 e2e.
 * 실파일 검증은 bench/corpus (gitignore) 존재 시에만.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { toInt32, solveBoundaries, solveRowHeights } from "../src/render/layout.js"
import { renderHwpxPages, renderHwpxToSvg } from "../src/render/index.js"
import { latexToPlain } from "../src/render/equation-text.js"
import { hwpEquationToLatex } from "../src/hwp5/equation.js"
import { buildPara, escapeXml } from "../src/render/svg-render.js"
import { markdownToHwpx } from "../src/hwpx/generator.js"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import JSZip from "jszip"

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "corpus")

describe("render: toInt32 (uint32 음수)", () => {
  it("4294967103 → -193 (사진대지 vertOffset 실측)", () => {
    assert.equal(toInt32("4294967103"), -193)
  })
  it("일반 양수·음수 문자열·결측", () => {
    assert.equal(toInt32("17645"), 17645)
    assert.equal(toInt32("-850"), -850)
    assert.equal(toInt32(undefined, 7), 7)
    assert.equal(toInt32("abc", 3), 3)
  })
})

describe("render: 열 경계 전파 솔버", () => {
  it("span-1 셀 없는 그리드도 제약 전파로 풀림 (트레일러 축소판)", () => {
    // 3경계 그리드: |0..2|=30, |2..3|=10, 전체=40 → x=[0,?,30,40], 첫 제약으로 x2=30
    const x = solveBoundaries([
      { a: 0, b: 2, size: 30 },
      { a: 2, b: 3, size: 10 },
    ], 3, 40)
    assert.equal(x[0], 0)
    assert.equal(x[2], 30)
    assert.equal(x[3], 40)
  })
  it("역방향 전파 — 오른쪽 끝에서 왼쪽으로", () => {
    // x4=100 확정, |3..4|=20 → x3=80, |1..3|=50 → x1=30
    const x = solveBoundaries([
      { a: 3, b: 4, size: 20 },
      { a: 1, b: 3, size: 50 },
    ], 4, 100)
    assert.equal(x[3], 80)
    assert.equal(x[1], 30)
  })
  it("미해결 경계는 균등 보간", () => {
    const x = solveBoundaries([], 4, 100)
    assert.deepEqual(x, [0, 25, 50, 75, 100])
  })
})

describe("render: 행 높이 솔버", () => {
  it("엇갈려 병합한 행은 미확정 행 하나짜리 칸부터 풀어 정해진다 — 앞선 여러 행 칸이 균등 분배로 못 박지 않는다", () => {
    // 행 1: 3879 · 행 1~2: 5578 · 행 1~4 칸(먼저 나와도) 11046 · 행 2~3: 5011 · 행 3~4: 5468
    const h = solveRowHeights([
      { rowAddr: 1, rowSpan: 1, height: 3879 },
      { rowAddr: 1, rowSpan: 4, height: 11046 },
      { rowAddr: 1, rowSpan: 2, height: 5578 },
      { rowAddr: 2, rowSpan: 2, height: 5011 },
      { rowAddr: 3, rowSpan: 2, height: 5468 },
    ], 5)
    assert.deepEqual(h.slice(1), [3879, 1699, 3312, 2156])
  })
  it("h=1 더미(헤어라인 장식 셀)가 섞여도 rs=1 max가 이김", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 2700 },
      { rowAddr: 0, rowSpan: 1, height: 1 },
    ], 1)
    assert.equal(h[0], 2700)
  })
  it("rowSpan 잔여 균등분배 + 콘텐츠 초과 성장 (사진대지 실측 모델)", () => {
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 1, height: 16441, contentH: 22209 }, // 사진이 설계보다 큼
      { rowAddr: 1, rowSpan: 1, height: 3042 },
    ], 2)
    assert.equal(h[0], 22209)
    assert.equal(h[1], 3042)
    assert.equal(h[0] + h[1], 25251) // 표 sz 실측 일치
  })
  it("내용으로 자란 행은 여러 행 칸의 잔여 분배보다 먼저 — 병합 칸 마지막 행이 자란 만큼 준다", () => {
    // 4행 병합 칸 17749(행 2~5) · 행 3 사진 칸 10419 → 내용 10703 · 행 5~6 병합 칸 882 · 행 6 칸 782
    const h = solveRowHeights([
      { rowAddr: 0, rowSpan: 4, height: 17749 },
      { rowAddr: 0, rowSpan: 1, height: 2182 },
      { rowAddr: 1, rowSpan: 1, height: 10419, contentH: 10703 },
      { rowAddr: 2, rowSpan: 1, height: 4764 },
      { rowAddr: 3, rowSpan: 2, height: 882 },
      { rowAddr: 4, rowSpan: 1, height: 782 },
    ], 5)
    assert.deepEqual(h, [2182, 10703, 4764, 100, 782]) // 한컴 PDF 행 5~6 합 8.8pt — 먼저 나누면 384 + 782
  })
})

describe("render: 조판 캐시 없는 파일 거부", () => {
  it("markdownToHwpx 산출물(lineseg 없음) → KordocError", async () => {
    const hwpx = await markdownToHwpx("# 제목\n\n본문 문단입니다.")
    await assert.rejects(
      renderHwpxToSvg(hwpx),
      (err: Error) => err.message.includes("조판 캐시"),
    )
  })

  it('본문 텍스트에 "linesegarray" 단어가 있어도 캐시로 오판하지 않는다 (리뷰 #11)', async () => {
    const hwpx = await markdownToHwpx("본문에 linesegarray 라는 단어가 나오는 문서입니다.")
    // 캐시 없음으로 정확히 거부돼야 한다 (오판 시 무음 백지 렌더)
    await assert.rejects(
      renderHwpxToSvg(hwpx),
      (err: Error) => err.message.includes("조판 캐시"),
    )
    // reflow 옵션으로는 텍스트가 실제로 렌더된다
    const r = await renderHwpxToSvg(hwpx, { reflow: true })
    assert.ok(r.svg.includes("linesegarray"), "본문 텍스트가 백지로 생략됨")
  })
})

describe("render: 문단별 줄나눔 wrapMode (breakSetting 이름 역전 매핑)", () => {
  it("parseRenderStyles — BREAK_WORD→keep(어절) / KEEP_WORD→charAll(글자) / 없음→undefined", async () => {
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const head = `<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core">
      <hh:paraPr id="0"><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="BREAK_WORD"/></hh:paraPr>
      <hh:paraPr id="1"><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD"/></hh:paraPr>
      <hh:paraPr id="2"><hh:align horizontal="LEFT"/></hh:paraPr>
    </hh:head>`
    const styles = parseRenderStyles(head)
    assert.equal(styles.paraGeom.get("0")?.wrapMode, "keep")
    assert.equal(styles.paraGeom.get("1")?.wrapMode, "charAll")
    assert.equal(styles.paraGeom.get("2")?.wrapMode, undefined)
  })

  it("reflow — 문단 breakSetting 선언이 reflowMode 옵션보다 우선", async () => {
    // 생성 문서는 전 문단 BREAK_WORD(어절) 선언 → charAll 옵션을 줘도 선언이 이겨
    // 두 렌더가 동일해야 한다 (선언 파싱이 깨지면 줄바꿈점이 달라져 SVG가 달라짐)
    const md = "대한민국 헌법에 따라 보장되는 기본권과 자유민주적 기본질서를 확인하는 문장을 반복한다. ".repeat(6)
    const hwpx = await markdownToHwpx(md)
    const keep = await renderHwpxToSvg(hwpx, { reflow: true, reflowMode: "keep" })
    const charAll = await renderHwpxToSvg(hwpx, { reflow: true, reflowMode: "charAll" })
    assert.equal(charAll.svg, keep.svg)
  })
})

describe("render: 탭 슬롯 (리뷰 #16)", () => {
  it("hp:tab은 inline 컨트롤 8슬롯 — 1슬롯로 세면 lineseg textpos가 밀린다", () => {
    const xml = `<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" paraPrIDRef="0">` +
      `<hp:run charPrIDRef="0"><hp:t>a<hp:tab/>b</hp:t></hp:run></hp:p>`
    const doc = createXmlParser().parseFromString(xml, "text/xml")
    const m = buildPara(doc.documentElement as unknown as Element)
    assert.equal(m.chars.length, 10) // a(1) + tab(8) + b(1)
    assert.equal(m.chars[0].ch, "a")
    assert.equal(m.chars[9].ch, "b")
    assert.ok(m.chars.slice(1, 9).every(c => c.ch === ""), "탭 필러 슬롯은 폭 0")
  })
})

describe("render: 이미지 dataURI 1회 참조 (리뷰 #10)", () => {
  it("같은 바이너리 2회 그려도 dataURI는 defs에 1번만, 본문은 <use> 2개", async () => {
    const base = await markdownToHwpx("이미지 중복 참조 테스트")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const pic = (id: number) =>
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:pic id="${id}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None">` +
      `<hp:sz width="5000" widthRelTo="ABSOLUTE" height="5000" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      `<hp:img binaryItemIDRef="dupimg"/></hp:pic></hp:run></hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${pic(9001)}${pic(9002)}${m}`)
    zip.file(secName, sec)
    // PNG 매직바이트만 있는 최소 바이너리 — 파일명 휴리스틱(BinData/*dupimg*)으로 매칭
    zip.file("BinData/dupimg.png", new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    const dataUris = (r.svg.match(/data:image/g) ?? []).length
    const uses = (r.svg.match(/<use href="#bin0"/g) ?? []).length
    assert.equal(dataUris, 1, `dataURI가 ${dataUris}회 중복 emit됨`)
    assert.equal(uses, 2, `<use> 참조가 ${uses}개 (기대 2)`)
  })
})

describe("render: 첫 줄 들여쓰기·글머리표 (한컴 lineseg horzpos 는 둘 다 빼지 않는다)", () => {
  it("양수 들여쓰기 문단의 첫 줄은 그만큼 들어가 그리고, 글머리표 문단은 글머리표 글자를 앞에 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("기본문단입니다.\n\n들여쓰기문단입니다.\n\n글머리문단입니다."))
    let head = await zip.file("Contents/header.xml")!.async("string")
    const pp0 = head.match(/<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/)![0]
    const indented = pp0.replace('id="0"', 'id="900"').replace('<hc:intent value="0"', '<hc:intent value="2000"')
    const bulleted = pp0.replace('id="0"', 'id="901"').replace('<hh:heading type="NONE" idRef="0" level="0"/>', '<hh:heading type="BULLET" idRef="900" level="0"/>')
    head = head.replace("</hh:paraProperties>", indented + bulleted + "</hh:paraProperties>")
      .replace(/<hh:bullets itemCnt="\d+"\s*\/>/, '<hh:bullets itemCnt="1"><hh:bullet id="900" char="◦" useImage="0"><hh:paraHead level="0" autoIndent="1" textOffsetType="PERCENT" textOffset="50" charPrIDRef="4294967295"/></hh:bullet></hh:bullets>')
    zip.file("Contents/header.xml", head)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/(<hp:p [^>]*?)paraPrIDRef="\d+"([^>]*>(?:(?!<\/hp:p>)[\s\S])*?들여쓰기문단)/, '$1paraPrIDRef="900"$2')
      .replace(/(<hp:p [^>]*?)paraPrIDRef="\d+"([^>]*>(?:(?!<\/hp:p>)[\s\S])*?글머리문단)/, '$1paraPrIDRef="901"$2')
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const xOf = (needle: string) => parseFloat([...r.svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].find(m => m[2].includes(needle))![1])
    assert.ok(Math.abs(xOf("들여쓰기") - xOf("기본문단") - 20) < 0.5, `들여쓰기 2000 HWPUNIT = 20pt: ${xOf("들여쓰기") - xOf("기본문단")}`)
    assert.ok(Math.abs(xOf("◦") - xOf("기본문단")) < 0.5, "글머리표는 줄 첫머리")
    assert.ok(xOf("글머리") > xOf("◦") + 5, "글은 글머리표 + 간격 뒤에서 시작")
  })
  it("내어쓰기 문단은 둘째 줄부터 그만큼 들어가 그린다 (lineseg horzpos 는 왼쪽 여백 그대로)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("가" + "나".repeat(60) + "끝줄"))
    let head = await zip.file("Contents/header.xml")!.async("string")
    const pp0 = head.match(/<hh:paraPr id="0"[\s\S]*?<\/hh:paraPr>/)![0]
    head = head.replace("</hh:paraProperties>", pp0.replace('id="0"', 'id="902"').replace('<hc:intent value="0"', '<hc:intent value="-3000"') + "</hh:paraProperties>")
    zip.file("Contents/header.xml", head)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/(<hp:p [^>]*?)paraPrIDRef="\d+"([^>]*>(?:(?!<\/hp:p>)[\s\S])*?끝줄)/, '$1paraPrIDRef="902"$2')
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const xs = [...r.svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].filter(m => /[가나끝]/.test(m[2])).map(m => parseFloat(m[1]))
    assert.ok(xs.length >= 2, String(xs.length))
    assert.ok(Math.abs(xs[1] - xs[0] - 30) < 0.5, `둘째 줄은 30pt 들어간다: ${xs[1] - xs[0]}`)
  })
})

describe("render: 표 캡션 (위·아래 캡션은 표 줄 높이에 든다)", () => {
  it("아래 캡션 글을 표 바닥 아래에 그리고, 뒤 문단은 캡션 아래로 내려간다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 가 | 나 |\n| --- | --- |\n| 1 | 2 |\n\n표뒤문단입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const cap = `<hp:caption side="BOTTOM" fullSz="0" width="8504" gap="850" lastWidth="40000"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>캡션글입니다</hp:t></hp:run></hp:p></hp:subList></hp:caption>`
    sec = sec.replace(/(<hp:tbl [^>]*>)/, `$1${cap}`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const yOf = (needle: string) => parseFloat([...r.svg.matchAll(/<text [^>]*y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].find(m => m[2].includes(needle))?.[1] ?? "NaN")
    const borderYs = [...r.svg.matchAll(/<line x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g)].filter(m => m[1] === m[2]).map(m => parseFloat(m[1]))
    assert.ok(yOf("캡션글") > Math.max(...borderYs), `캡션 ${yOf("캡션글")} 이 표 바닥 ${Math.max(...borderYs)} 아래`)
    assert.ok(yOf("표뒤문단") > yOf("캡션글"), "뒤 문단은 캡션 아래")
  })
})

describe("render: 쪽 아래 각주", () => {
  it("각주는 구분선 아래 쪽 바닥에 그리고, 본문 참조 번호는 위첨자로·각주 머리 번호는 각주 앞에 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const fn = `<hp:ctrl><hp:footNote number="1"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="FOOTNOTE"><hp:autoNumFormat type="DIGIT" suffixChar=")"/></hp:autoNum></hp:ctrl><hp:t> 각주내용</hp:t></hp:run></hp:p></hp:subList></hp:footNote></hp:ctrl>`
    sec = sec.replace("본문입니다.</hp:t>", `본문입니다.</hp:t>${fn}`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const texts = [...r.svg.matchAll(/<text [^>]*y="([\d.-]+)"[^>]*font-size="([\d.]+)"[^>]*>([^<]*)<\/text>/g)].map(m => ({ y: parseFloat(m[1]), size: parseFloat(m[2]), t: m[3] }))
    const body = texts.find(t => t.t.includes("본문입니다"))!, note = texts.find(t => t.t.includes("각주내용"))!
    assert.ok(body && note, "본문·각주 글이 렌더에 있음")
    assert.ok(note.y > body.y + 300, `각주(${note.y})가 쪽 아래(본문 ${body.y} 보다 한참 아래)`)
    const marks = texts.filter(t => t.t === "1)")
    assert.ok(marks.some(t => t.size < body.size && t.y < body.y), "본문 참조 번호 1) 은 위첨자(작게·위로)")
    assert.ok(marks.some(t => Math.abs(t.y - note.y) < 0.01), "각주 머리 번호 1) 은 각주 줄에")
    const rules = [...r.svg.matchAll(/<line x1="([\d.-]+)" y1="([\d.-]+)" x2="([\d.-]+)" y2="([\d.-]+)"/g)].filter(m => m[2] === m[4] && Math.abs(parseFloat(m[3]) - parseFloat(m[1]) - 141.73) < 0.01)
    assert.equal(rules.length, 1) // 구분선 5cm
    assert.ok(parseFloat(rules[0][2]) < note.y && parseFloat(rules[0][2]) > body.y, "구분선은 본문과 각주 사이")
  })
})

describe("render: 수식 대체 글", () => {
  it("수식 스크립트를 한 줄 유니코드 글로 — 분수 a/b, 제곱근 √, 숫자 첨자, 그리스 문자", () => {
    const t = (sc: string) => latexToPlain(hwpEquationToLatex(sc))
    assert.equal(t("x ^{3} -3x ^{2} +k"), "x³-3x²+k")
    assert.equal(t("LEFT [ - {pi } over {6} ,~b RIGHT ]"), "[-π/6, b]")
    assert.equal(t("a_{n}"), "a_n") // 문자 아래 첨자는 글꼴에 없어 _ 로
    assert.equal(t("sqrt {x ^{2} -2}"), "√(x²-2)")
  })
  it("수식 개체를 상자 폭에 맞춘 글로 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("본문입니다.</hp:t>", `본문입니다.</hp:t><hp:equation baseLine="86" baseUnit="1000" textColor="#000000"><hp:sz width="3000" height="1100"/><hp:pos treatAsChar="1"/><hp:outMargin left="56" right="56" top="0" bottom="0"/><hp:script>x ^{2} +1</hp:script></hp:equation>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.ok(/<text [^>]*textLength="30"[^>]*>x²\+1<\/text>/.test(r.svg), "수식 글 x²+1 이 상자 폭 30pt 로")
  })
})

describe("render: 쪽 테두리·단 구분선", () => {
  it("pageBorderFill 은 용지에서 오프셋만큼 안쪽에, colLine 은 단 사이 가운데에 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("</hp:endNotePr>", `</hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="9" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1984" right="1984" top="5669" bottom="1984"/></hp:pageBorderFill>`)
    sec = sec.replace(`colCount="1" sameSz="1" sameGap="0"/>`, `colCount="2" sameSz="1" sameGap="850"><hp:colLine type="SOLID" width="0.12 mm" color="#000000"/></hp:colPr>`)
    zip.file(secName, sec)
    let head = await zip.file("Contents/header.xml")!.async("string")
    const edge = (k: string) => `<hh:${k} type="SOLID" width="0.12 mm" color="#000000"/>`
    head = head.replace(/<hh:borderFills itemCnt="(\d+)">/, (_m, n) => `<hh:borderFills itemCnt="${Number(n) + 1}"><hh:borderFill id="9" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">${edge("leftBorder")}${edge("rightBorder")}${edge("topBorder")}${edge("bottomBorder")}</hh:borderFill>`)
    zip.file("Contents/header.xml", head)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.ok(r.svg.includes(`x1="19.84" y1="56.69" x2="575.44" y2="56.69"`), "위 테두리")
    assert.ok(r.svg.includes(`x1="19.84" y1="56.69" x2="19.84" y2="822.04"`), "왼쪽 테두리")
    // 단 구분선 x = 왼 여백 5670 + 단 폭 (49606 − 850) / 2 + 간격 / 2 = 30473, 본문 위(위 여백 + 머리말 = 11339)부터
    assert.ok(r.svg.includes(`<line x1="304.73" y1="113.39" x2="304.73"`), "단 구분선")
  })
})

describe("render: 개체 자리", () => {
  it("줄을 채우는 인라인 표는 줄 위 + 바깥 위 여백에 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 가 | 나 |\n|---|---|\n| 다 | 라 |"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(`<hp:pos treatAsChar="0"`, `<hp:pos treatAsChar="1"`).replace(`<hp:outMargin left="0" right="0" top="0" bottom="1600"/>`, `<hp:outMargin left="0" right="0" top="283" bottom="283"/>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.ok(r.svg.includes(`<line x1="56.7" y1="132.22"`), "표 위 선 = 줄 위 129.39 + 위 여백 2.83") // 종전엔 129.39
  })
})

describe("render: 쪽 감지", () => {
  it("줄간격이 음수라 다음 문단이 같은 vertpos 0 에서 시작해도 새 쪽이 아니다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n둘째 문단"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    let k = 0
    sec = sec.replace(/<\/hp:p>/g, () => (k++ === 0
      ? `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1500" textheight="1500" baseline="1275" spacing="-1500" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`
      : `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`) + "</hp:p>")
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 1)
  })
  it("쪽 위쪽에서 앞 줄 끝보다 위에 시작한 줄이 앞 줄과 합쳐 본문 높이를 넘으면 새 쪽이다", async () => {
    const at = async (v2: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n둘째 문단"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      let k = 0
      zip.file(secName, (await zip.file(secName)!.async("string")).replace(/<\/hp:p>/g, () => (k++ === 0
        ? `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="60000" textheight="60000" baseline="51000" spacing="0" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`
        : `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v2}" vertsize="60000" textheight="60000" baseline="51000" spacing="0" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`) + "</hp:p>"))
      return (await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))).pageSvgs.size
    }
    // 한컴은 쪽을 채우는 줄 둘을 vertpos 0·700 으로 저장한다 — 둘째 줄은 다음 쪽
    assert.equal(await at("700"), 2)
  })
})

describe("render: 쪽을 넘는 표 행 조각 (planTableRows)", () => {
  const tbl = (pageBreak: string, segs: number[], cellH = 1000) => {
    const ls = segs.map(v => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/>`).join("")
    const xml = `<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" pageBreak="${pageBreak}" rowCnt="1" colCnt="1"><hp:sz width="10000" height="${cellH}"/><hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${ls}</hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="${cellH}"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc></hp:tr></hp:tbl>`
    return createXmlParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
  }
  it("CELL 표는 행을 칸 줄 경계에서 갈라 다음 쪽에 잇고, 한컴이 저장한 나눔(줄 vertpos 되돌아감)은 그대로 따른다", async () => {
    const { planTableRows } = await import("../src/render/table-pages.js")
    const { collectCells, measureTableRowHeights } = await import("../src/render/para-model.js")
    const show = (t: Element, ty: number) => planTableRows(t, collectCells(t), measureTableRowHeights(t), ty, 0, 7000).map(ps => ps.map(p => [p.page, p.y, p.h]))
    // 줄 0·1600·…·14400(10줄), 표 위 0, 쪽 7000: 141 + 바닥 ≤ 7000 − 141 인 4줄 → 다음 쪽 6400 부터 4줄 → 12800 부터 2줄
    const ten = Array.from({ length: 10 }, (_, i) => i * 1600)
    assert.deepEqual(show(tbl("CELL", ten), 0), [[[0, 0, 7000], [1, 0, 7000], [2, 0, 2882]]])
    // 행 단위(TABLE) 표는 가르지 않는다(쪽 맨 위 행은 넘치게 둔다)
    assert.deepEqual(show(tbl("TABLE", ten), 0), [[[0, 0, 15682]]])
    // 행 단위 표는 행 바닥 + 표 바깥 아래 여백이 쪽 바닥을 넘으면 그 행부터 다음 쪽(행 바닥만 들어도) — 칸 안 나눔 표는 이 판정을 쓰지 않는다
    const rowsT = (pageBreak: string) => createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" pageBreak="${pageBreak}" rowCnt="3" colCnt="1"><hp:sz width="10000" height="9000"/><hp:outMargin left="0" right="0" top="0" bottom="141"/>` +
      [0, 1, 2].map(r => `<hp:tr><hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="3000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr>`).join("") + `</hp:tbl>`, "text/xml").documentElement as unknown as Element
    assert.deepEqual(show(rowsT("TABLE"), 900), [[[0, 900, 3000]], [[1, 0, 3000]], [[1, 3000, 3000]]]) // 3900 + 3000 = 6900 ≤ 7000 이지만 + 141 > 7000
    assert.deepEqual(show(rowsT("TABLE"), 800), [[[0, 800, 3000]], [[0, 3800, 3000]], [[1, 0, 3000]]]) // 3800 + 3000 + 141 = 6941 ≤ 7000
    // 저장본이 3줄 뒤 0 으로 되돌아가면(한컴이 거기서 갈랐다) 그 자리에서 가른다 — 칸 높이는 갈린 행 전체(한컴 저장 cellSz), 2번째 조각은 3줄 + 칸 여백
    assert.deepEqual(show(tbl("CELL", [0, 1600, 3200, 0, 1600, 3200], 8000), 2000), [[[0, 2000, 5000], [1, 0, 4482]]])
    // 칸 글은 다 들어가고 행 높이만 넘치면 행은 이 쪽 바닥까지
    assert.deepEqual(show(tbl("CELL", [0], 9000), 3000), [[[0, 3000, 4000]]])
    // 이어진 쪽은 본문 위 + 표 바깥 위 여백(283)에서 다시 시작한다
    const om = tbl("CELL", ten); om.insertBefore(createXmlParser().parseFromString(`<hp:outMargin xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" left="0" right="0" top="283" bottom="0"/>`, "text/xml").documentElement as never, om.firstChild)
    assert.deepEqual(show(om, 0)[0].map(p => p[1]), [0, 283, 283])
    // 겹치지 않는(allowOverlap=0) 칸 안 그림이 쪽을 넘게 쌓이면 그림째 다음 쪽 맨 위 — 조각은 그림 바닥 + 칸 아래 여백, 음수 위 오프셋은 버린다
    const pics = [0, 4294963936, 4294964356].map(vo => `<hp:pic textWrap="SQUARE"><hp:sz width="9000" height="5000"/><hp:pos treatAsChar="0" allowOverlap="0" vertRelTo="PARA" vertOffset="${vo}"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`).join("")
    const stackT = createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" pageBreak="CELL" rowCnt="1" colCnt="1"><hp:sz width="10000" height="5282"/><hp:tr><hp:tc><hp:subList><hp:p><hp:run>${pics}<hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="5282"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc></hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element
    const sp = planTableRows(stackT, collectCells(stackT), measureTableRowHeights(stackT), 1000, 0, 7000)[0]
    assert.deepEqual(sp.map(p => [p.page, p.y, p.h, [...(p.place ?? new Map()).values()]]), [[0, 1000, 5282, [1141]], [1, 0, 5282, [141]], [2, 0, 5282, [141]]])
    // 갈린 칸 부분의 첫 줄이 그 줄에 앵커한 쪽을 넘는 표의 끝 쪽 기준이면(표 아래로 밀린 줄) 표는 부분 시작 쪽 맨 위, 줄은 표가 끝나는 쪽
    const leadT = tbl("CELL", [0, 1600, 3200, 4800, 0, 1600])
    const firstOfPart1 = Array.from(leadT.getElementsByTagName("hp:lineseg") as unknown as Element[])[4]
    const fake = leadT.getElementsByTagName("hp:p")[0] as unknown as Element
    const lp = planTableRows(leadT, collectCells(leadT), measureTableRowHeights(leadT), 0, 0, 7000, 0, (seg) => seg === firstOfPart1 ? { pages: 2, endY: 141, el: fake } : undefined)[0]
    assert.deepEqual(lp.map(p => p.page), [0, 1, 2, 3])
    assert.deepEqual([...(lp[1].place ?? new Map())], [[fake, 141]])
    // 갈린 칸 안의 표(nested)는 남는 행 높이를 다음 쪽 맨 위에 잇고, 아래 여백(slack)으로 넘치지 않는다
    const nestedPlan = (t: Element, ty: number, h: number, slack = 0) => planTableRows(t, collectCells(t), measureTableRowHeights(t), ty, 0, h, slack, undefined, true).map(ps => ps.map(p => [p.page, p.y, p.h]))
    assert.deepEqual(nestedPlan(tbl("CELL", [0], 9000), 3000, 7000), [[[0, 3000, 4000], [1, 0, 5000]]])
    assert.deepEqual(nestedPlan(tbl("CELL", ten), 0, 15000, 1000), [[[0, 0, 15000], [1, 0, 1282]]]) // 마지막 줄(14400~15400)만 다음 쪽
    // 표 전체가 아래 여백(slack) 안에서 끝나면 가르지 않는다 — 쪽보다 조금 큰 서식 표 하나짜리 문서
    const plan = planTableRows(tbl("CELL", ten), collectCells(tbl("CELL", ten)), measureTableRowHeights(tbl("CELL", ten)), 0, 0, 15000, 1000)
    assert.deepEqual(plan.map(ps => ps.map(p => [p.page, p.y, p.h])), [[[0, 0, 15682]]])
    // 첫 줄부터 이 쪽에 못 놓는 칸(높은 그림 줄)이 있으면 다른 칸 글이 들어가도 행을 가르지 않고 행째 다음 쪽
    const cell = (col: number, segs: string) => `<hp:tc><hp:subList><hp:p><hp:run><hp:t>가</hp:t></hp:run><hp:linesegarray>${segs}</hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="${col}" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="1000"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc>`
    const seg = (v: number, h: number) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="${h}" textheight="${h}" baseline="850" spacing="600" horzpos="0" horzsize="9000"/>`
    const twoT = createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" pageBreak="CELL" rowCnt="2" colCnt="2"><hp:sz width="20000" height="7000"/><hp:tr>${cell(0, seg(0, 1000))}${cell(1, seg(0, 1000))}</hp:tr><hp:tr>${cell(0, [0, 1600, 3200, 4800, 6400].map(v => seg(v, 1000)).join("")).replace(/rowAddr="0"/, 'rowAddr="1"')}${cell(1, seg(0, 5000)).replace(/rowAddr="0"/, 'rowAddr="1"')}</hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element
    assert.deepEqual(show(twoT, 1000).map(ps => ps.map(p => p[0])), [[0], [1, 2]]) // 행째 1쪽, 거기서 넘치는 글 칸 줄은 2쪽
    // 글자처럼 취급하는 표는 가르지 않는다 — 쪽 맨 위면 그 쪽에(잘린다), 아니면 표째 다음 쪽 맨 위(넘침은 저장된 표 높이 sz 로 판정)
    const tac = (pb: string) => { const t = tbl(pb, ten, 15682); t.getElementsByTagName("hp:tr")[0].parentNode!.insertBefore(createXmlParser().parseFromString(`<hp:pos xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" treatAsChar="1"/>`, "text/xml").documentElement as never, t.firstChild); return t }
    assert.deepEqual(show(tac("CELL"), 0), [[[0, 0, 15682]]])
    assert.deepEqual(show(tac("CELL"), 3000), [[[1, 0, 15682]]])
    // 한컴이 칸을 갈라 저장한 표(줄 vertpos 되돌아감)는 칸 높이를 이어 잰다 — 쪽 하나 분량으로 작게 재면 여백 규칙에 한 쪽으로 접힌다
    // 0·1600·3200 다음 0 은 앞 줄 끝 4800 에 이어 4800·6400·8000 → 내용 9000 + 칸 여백 282
    assert.equal(measureTableRowHeights(tbl("CELL", [0, 1600, 3200, 0, 1600, 3200], 1000))[0], 9282)
    // 갈린 뒤 부분의 원점은 저장 좌표 0 — 다음 쪽 첫 줄 vertpos 1000(앞 간격)을 살려 조각 높이 = 1000 + 2줄 + 칸 여백
    assert.deepEqual(show(tbl("CELL", [0, 1600, 3200, 1000, 2600], 8000), 2000), [[[0, 2000, 5000], [1, 0, 3882]]])
    // 첫 쪽 조각 높이는 저장된 표 sz 높이(한컴이 첫 쪽 높이를 담는다), 가운데 쪽은 다음 쪽 첫 줄 위까지 + 칸 여백, 마지막 쪽은 내용 + 칸 여백
    const three = tbl("CELL", [0, 1600, 1000, 1600, 1000], 3500)
    assert.deepEqual(planTableRows(three, collectCells(three), measureTableRowHeights(three), 0, 0, 6000).map(ps => ps.map(p => [p.page, p.y, p.h])), [[[0, 0, 3500], [1, 0, 3482], [2, 0, 2282]]])
    // 칸 글은 다 들어가도 떠 있는 그림 칸이 남은 높이보다 크면 행째 다음 쪽(가를 수 없는 그림) — 그림 없으면 이 쪽 바닥에서 갈라 남는 1500 은 다음 쪽 맨 위
    const twoRows = (pic: boolean) => createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" pageBreak="CELL" rowCnt="2" colCnt="1"><hp:sz width="10000" height="7500"/>` +
      [3000, 4500].map((h, r) => `<hp:tr><hp:tc><hp:subList><hp:p><hp:run>${pic && r === 1 ? `<hp:pic><hp:sz width="5000" height="4000"/><hp:pos treatAsChar="0" vertRelTo="PARA" vertOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>` : ""}<hp:t>가</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="${h}"/><hp:cellMargin left="0" right="0" top="141" bottom="141"/></hp:tc></hp:tr>`).join("") + `</hp:tbl>`, "text/xml").documentElement as unknown as Element
    const plan2 = (pic: boolean) => { const t = twoRows(pic); return planTableRows(t, collectCells(t), measureTableRowHeights(t), 0, 0, 6000).map(ps => ps.map(p => [p.page, p.y, p.h])) }
    assert.deepEqual(plan2(true)[1], [[1, 0, 4500]])
    assert.deepEqual(plan2(false)[1], [[0, 3000, 3000], [1, 0, 1500]])
  })

  it("한컴이 갈라 저장한 세로 가운데 칸은 조각마다 그 조각 내용을 조각 안에서 가운데 맞추고, 쪽 첫 줄 저장 vertpos 를 살린다", async () => {
    const build = async (va: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 가나다 |"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      let sec = await zip.file(secName)!.async("string")
      const segs = [[0, 1000], [1, 40000], [2, 1000]].map(([tp, v]) => `<hp:lineseg textpos="${tp}" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000" flags="393216"/>`).join("")
      sec = sec.replace(/(<hp:tbl\b[^>]*?)pageBreak="\w+"/, '$1pageBreak="CELL"')
        .replace(/(<hp:t>가나다<\/hp:t><\/hp:run>)/, `$1<hp:linesegarray>${segs}</hp:linesegarray>`)
      const k = sec.indexOf("가나다"), j = sec.lastIndexOf("<hp:subList", k)
      sec = sec.slice(0, j) + sec.slice(j).replace(/vertAlign="\w+"/, `vertAlign="${va}"`)
      sec = sec.replace(/(<hp:t>가나다<\/hp:t>[\s\S]*?<hp:cellSz width="\d+" height=")\d+/, "$1200000")
        .replace(/(<hp:tbl\b[\s\S]*?<hp:sz width="\d+" widthRelTo="\w+" height=")\d+/, "$150000") // 한컴은 갈라 저장한 표 sz 에 첫 쪽 높이를 담는다
      zip.file(secName, sec)
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
      const ys = (n: number) => [...r.pageSvgs.get(n)!.matchAll(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>([^<]+)</g)].map(m => [m[2], Number(m[1])] as const)
      return { pages: r.pageSvgs.size, p1: ys(1), p2: ys(2), sec }
    }
    const top = await build("TOP"), mid = await build("CENTER")
    assert.equal(top.pages, 2)
    const ga = (d: typeof top) => d.p1.find(([t]) => t === "가")![1], da = (d: typeof top) => d.p2.find(([t]) => t === "다")![1]
    // 다음 쪽 첫 줄은 조각 위 + 칸 위 여백 + 저장 vertpos 1000 + 기준선 850 (저장 앞 간격을 버리면 10pt 위)
    const mg = top.sec.match(/<hp:margin [^>]*>/)![0], at = (a: string) => Number(mg.match(new RegExp(`${a}="(\\d+)"`))![1])
    const MT = (at("top") + at("header")) / 100
    const cm = top.sec.slice(top.sec.indexOf("가나다")).match(/<hp:cellMargin [^>]*top="(\d+)"/)!
    assert.ok(da(top) > MT + Number(cm[1]) / 100 + 18.5 - 0.05, `다음 쪽 첫 줄 ${da(top)}`)
    // 가운데 칸: 첫 조각은 내용(41000)이 조각보다 작아 아래로 내려오고, 마지막 조각(내용 그대로 높이)은 같은 자리
    assert.ok(ga(mid) - ga(top) > 1, `첫 조각 가운데 ${ga(mid)} vs ${ga(top)}`)
    assert.ok(Math.abs(da(mid) - da(top)) < 0.05, `마지막 조각 ${da(mid)} vs ${da(top)}`)
  })

  it("세 쪽에 갈라 저장한 세로 가운데 칸의 가운데 조각은 다시 맞추지 않고 저장 vertpos 자리에 그린다", async () => {
    // 한컴 PDF(같은 판이 저장·인쇄): 둘째 쪽부터 칸 글이 저장 자리 — 조각 끝 줄 간격만큼 비는 몫을 가운데로 나누면 3pt 내려온다
    const build = async (va: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 가나다라마 |"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      let sec = await zip.file(secName)!.async("string")
      const segs = [[0, 1000], [1, 40000], [2, 1000], [3, 40000], [4, 1000]].map(([tp, v]) => `<hp:lineseg textpos="${tp}" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="9000" flags="393216"/>`).join("")
      sec = sec.replace(/(<hp:tbl\b[^>]*?)pageBreak="\w+"/, '$1pageBreak="CELL"')
        .replace(/(<hp:t>가나다라마<\/hp:t><\/hp:run>)/, `$1<hp:linesegarray>${segs}</hp:linesegarray>`)
      const k = sec.indexOf("가나다라마"), j = sec.lastIndexOf("<hp:subList", k)
      sec = sec.slice(0, j) + sec.slice(j).replace(/vertAlign="\w+"/, `vertAlign="${va}"`)
      sec = sec.replace(/(<hp:t>가나다라마<\/hp:t>[\s\S]*?<hp:cellSz width="\d+" height=")\d+/, "$1200000")
        .replace(/(<hp:tbl\b[\s\S]*?<hp:sz width="\d+" widthRelTo="\w+" height=")\d+/, "$150000")
      zip.file(secName, sec)
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
      const y = (n: number, ch: string) => Number([...r.pageSvgs.get(n)!.matchAll(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>([^<]+)</g)].find(m => m[2] === ch)![1])
      return { pages: r.pageSvgs.size, ga: y(1, "가"), da: y(2, "다"), ra: y(2, "라") }
    }
    const top = await build("TOP"), mid = await build("CENTER")
    assert.equal(top.pages, 3)
    assert.ok(mid.ga - top.ga > 1, `첫 조각은 가운데 ${mid.ga} vs ${top.ga}`)
    assert.ok(Math.abs(mid.da - top.da) < 0.05 && Math.abs(mid.ra - top.ra) < 0.05, `가운데 조각 ${mid.da}·${mid.ra} vs ${top.da}·${top.ra}`)
  })
})

describe("render: 칸 안 떠 있는 그림의 음수 오프셋", () => {
  it("문단 기준 음수 vertOffset 은 문단 위에서 멈춰, 행은 그림 높이 + 칸 여백까지 자란다", async () => {
    const { measureTableRowHeights } = await import("../src/render/para-model.js")
    const pic = (vo: number) => `<hp:pic textWrap="IN_FRONT_OF_TEXT"><hp:sz width="7375" height="12338"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="COLUMN" vertAlign="TOP" horzAlign="LEFT" vertOffset="${vo >>> 0}" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/></hp:pic>`
    const tbl = (vo: number) => createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" rowCnt="1" colCnt="1"><hp:sz width="10000" height="282"/><hp:tr><hp:tc><hp:subList><hp:p><hp:run>${pic(vo)}<hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="600" textheight="600" baseline="510" spacing="360" horzpos="0" horzsize="9476"/></hp:linesegarray></hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="10000" height="282"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc></hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element
    assert.equal(measureTableRowHeights(tbl(-167))[0], 12338 + 282)
    assert.equal(measureTableRowHeights(tbl(500))[0], 12338 + 500 + 282)
  })
})

describe("render: 맞쪽", () => {
  it("gutterType LEFT_RIGHT 면 짝수 쪽 본문을 오른쪽 여백 − 왼쪽 여백만큼 옮긴다 — 홀수 쪽은 그대로", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫쪽\n\n둘째쪽"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="38000" flags="393216"/></hp:linesegarray>`
    const sec = (await zip.file(secName)!.async("string"))
      .replace(/<hp:pagePr ([^>]*)>/, (_m, a) => `<hp:pagePr ${a.replace(/gutterType="[^"]*"/, "")} gutterType="LEFT_RIGHT">`)
      .replace(/<hp:margin ([^>]*)\/>/, (_m, a) => `<hp:margin ${a.replace(/left="\d+"/, 'left="7086"').replace(/right="\d+"/, 'right="14173"')}/>`)
      .replace("첫쪽</hp:t></hp:run>", `첫쪽</hp:t></hp:run>${seg(1000)}`).replace("둘째쪽</hp:t></hp:run>", `둘째쪽</hp:t></hp:run>${seg(0)}`)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 2)
    assert.ok(!r.pageSvgs.get(1)!.includes("translate(70.87 0)"))
    const p2 = r.pageSvgs.get(2)!
    assert.ok(p2.indexOf('<g transform="translate(70.87 0)">') >= 0 && p2.indexOf('<g transform="translate(70.87 0)">') < p2.indexOf(">둘째쪽<"), "짝수 쪽 본문이 이동 묶음 안")
  })
})

describe("render: 제본 여백", () => {
  it("gutter 는 왼쪽(LEFT_ONLY) 여백에 더하고, 위(TOP_BOTTOM)면 위 여백에 더한다", async () => {
    const at = async (type: string, gutter: number) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const sec = (await zip.file(secName)!.async("string"))
        .replace(/<hp:pagePr ([^>]*)>/, (_m, a) => `<hp:pagePr ${a.replace(/gutterType="[^"]*"/, "")} gutterType="${type}">`)
        .replace(/<hp:margin ([^>]*)\/>/, (_m, a) => `<hp:margin ${a.replace(/gutter="\d+"/, "")} gutter="${gutter}"/>`)
        .replace("본문</hp:t></hp:run>", `본문</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>`)
      zip.file(secName, sec)
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const m = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>본문</)!
      return [Number(m[1]), Number(m[2])]
    }
    const [x0, y0] = await at("LEFT_ONLY", 0), [x1, y1] = await at("LEFT_ONLY", 500), [x2, y2] = await at("TOP_BOTTOM", 500)
    assert.ok(Math.abs(x1 - x0 - 5) < 0.02 && y1 === y0, `${x0},${y0} → ${x1},${y1}`)
    assert.ok(x2 === x0 && Math.abs(y2 - y0 - 5) < 0.02, `${x0},${y0} → ${x2},${y2}`)
  })
})

describe("render: 구역 순서", () => {
  it("구역은 번호 순으로 그린다 — section10 이 section2 뒤", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("구역0"))
    const sec0 = (await zip.file("Contents/section0.xml")!.async("string")).replace("구역0</hp:t></hp:run>", `구역0</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`)
    zip.file("Contents/section0.xml", sec0)
    for (let i = 1; i <= 10; i++) zip.file(`Contents/section${i}.xml`, sec0.replace("구역0", `구역${i}`))
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const order = [...r.pageSvgs].map(([, svg]) => /구역(\d+)/.exec(svg)?.[1])
    assert.deepEqual(order, ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"])
  })
})

describe("render: 저장 vertpos 가 안 되돌아간 쪽 나누기", () => {
  it("쪽 나누기 문단은 vertpos 가 앞 줄보다 커도 쪽 위쪽 절반이면 새 쪽 — 쪽 바닥 근처면 그대로", async () => {
    const pages = async (v2: number) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n둘째"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`
      let sec = await zip.file(secName)!.async("string")
      sec = sec.replace("첫 문단</hp:t></hp:run></hp:p>", `첫 문단</hp:t></hp:run>${seg(0)}</hp:p>`)
        .replace(/<hp:p ([^>]*)>(<hp:run[^>]*><hp:t>둘째<\/hp:t><\/hp:run>)<\/hp:p>/, (_m, a, r) => `<hp:p ${a.replace(/pageBreak="0"/, "")} pageBreak="1">${r}${seg(v2)}</hp:p>`)
      zip.file(secName, sec)
      return (await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))).pageSvgs.size
    }
    assert.equal(await pages(1500), 2)
    assert.equal(await pages(60000), 1)
  })
})

describe("render: 갈린 칸 안의 쪽을 넘는 표", () => {
  it("칸 안 떠 있는 표가 쪽을 넘으면 표를 쪽마다 가르고, 칸의 다음 부분은 그 표가 끝나는 쪽(표 끝보다 위에 저장돼 있으면 그다음 쪽)에 그린다", async () => {
    const seg = (v: number, vs = 1000) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="${vs}" textheight="${vs}" baseline="${Math.round(vs * 0.85)}" spacing="600" horzpos="0" horzsize="40000" flags="393216"/></hp:linesegarray>`
    const cell = (body: string, w: number, h: number, r = 0) => `<hp:tc hasMargin="0"><hp:subList vertAlign="TOP">${body}</hp:subList><hp:cellAddr colAddr="0" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${w}" height="${h}"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc>`
    const tbl = (rows: string[], w: number, h: number) => `<hp:tbl textWrap="TOP_AND_BOTTOM" pageBreak="CELL" rowCnt="${rows.length}" colCnt="1"><hp:sz width="${w}" height="${h}"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="PARA" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="141" bottom="141"/>${rows.map(r => `<hp:tr>${r}</hp:tr>`).join("")}</hp:tbl>`
    const para = (inner: string, v: number) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${inner}</hp:run>${seg(v)}</hp:p>`
    const render = async (afterV: number) => {
      // 안쪽 표 6행 × 30000 — 쪽 셋에 걸친다(셋째 쪽 표 끝 < 쪽 위 + 60000)
      const inner = tbl(Array.from({ length: 6 }, (_, i) => cell(para(`<hp:t>행${i}</hp:t>`, 0), 40000, 30000, i)), 40000, 180000)
      // 바깥 1칸 틀: 앵커 줄(5000)·채움 줄(78000) 뒤 칸 글이 한컴이 가른 다음 부분(vertpos 가 되돌아감)
      const frame = tbl([cell(para(`${inner}<hp:t>앵커</hp:t>`, 5000) + para("<hp:t>채움</hp:t>", 78000) + para("<hp:t>뒤글</hp:t>", afterV), 42000, 1000)], 42000, 1000)
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      zip.file(secName, (await zip.file(secName)!.async("string")).replace(/<hp:t>본문<\/hp:t><\/hp:run>/, `<hp:t>본문</hp:t>${frame}</hp:run>${seg(0)}`))
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const pageOf = (t: string) => [...r.pageSvgs].filter(([, svg]) => svg.includes(`>${t}<`)).map(([n]) => n)
      return { rows: Array.from({ length: 6 }, (_, i) => pageOf(`행${i}`)[0]), after: pageOf("뒤글") }
    }
    const below = await render(72000)
    assert.deepEqual(below.rows, [1, 1, 2, 2, 2, 3]) // 행4 글은 2쪽 바닥에 들고 남는 행 높이가 3쪽 맨 위로 이어진다
    assert.deepEqual(below.after, [3]) // 표 끝(60000) 아래에 저장 — 표가 끝나는 쪽
    assert.deepEqual((await render(2000)).after, [4]) // 표 끝보다 위 — 그다음 쪽
  })
})

describe("render: 쪽을 넘는 떠 있는 표 아래 같은 문단 줄", () => {
  it("칸 글로 쪽을 넘는 틀 표 앵커 문단의 쪽 리셋 뒤 줄은 표가 끝나는 쪽 다음부터", async () => {
    const seg = (v: number, tp = 0) => `<hp:lineseg textpos="${tp}" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="40000" flags="393216"/>`
    // 1칸 틀(sz 2000) 칸에 한컴이 두 번 가른 칸 글 — 틀은 쪽 셋. 틀 위는 앞 문단 끝(1600)이 아니라 앵커 줄 − sz(2000)
    const cellP = (t: string, v: number) => `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run><hp:linesegarray>${seg(v)}</hp:linesegarray></hp:p>`
    const frame = `<hp:tbl textWrap="TOP_AND_BOTTOM" pageBreak="CELL" rowCnt="1" colCnt="1"><hp:sz width="42000" height="2000"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="PARA" vertOffset="0" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="141" right="141" top="141" bottom="141"/><hp:tr><hp:tc hasMargin="0"><hp:subList vertAlign="TOP">${cellP("틀1", 0)}${cellP("틀2", 78000)}${cellP("틀3", 30000)}${cellP("틀4", 0)}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="42000" height="2000"/><hp:cellMargin left="141" right="141" top="141" bottom="141"/></hp:tc></hp:tr></hp:tbl>`
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    // 둘째 문단: 앵커 줄은 틀 sz 바닥 아래 4000(앞 문단 줄 2000 + 틀 2000), 뒤 줄(글자 "뒤", 틀 컨트롤 8칸 + "앞" 뒤)은 다음 쪽 리셋 0
    const sec = (await zip.file(secName)!.async("string")).replace(/<hp:t>본문<\/hp:t><\/hp:run>/, `<hp:t>본문</hp:t></hp:run><hp:linesegarray>${seg(0)}</hp:linesegarray>`)
      .replace("</hs:sec>", `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0">${frame}<hp:t>앞뒤</hp:t></hp:run><hp:linesegarray>${seg(4000)}${seg(0, 9)}</hp:linesegarray></hp:p></hs:sec>`)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const pageOf = (t: string) => [...r.pageSvgs].filter(([, svg]) => svg.includes(t)).map(([n]) => n)
    assert.deepEqual([pageOf(">틀1<"), pageOf(">틀3<"), pageOf(">틀4<")], [[1], [2], [3]])
    assert.deepEqual(pageOf(">앞"), [1]) // 앵커 줄(과 틀)은 제 쪽
    assert.deepEqual(pageOf("뒤<"), [4]) // 리셋 줄은 표가 끝나는 쪽(3) 다음 — 종전엔 2쪽(앵커 쪽 + 1)
  })
})

describe("render: 쪽 바닥을 넘친 줄", () => {
  it("넘친 줄 다음 쪽 리셋이 그 줄을 새 쪽 맨 위에 둔 자리면(줄 높이 + 간격) 넘친 줄도 새 쪽 맨 위에 그린다", async () => {
    const render = async (nextV: number) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("영\n\n첫줄\n\n둘줄"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`
      const sec = (await zip.file(secName)!.async("string")).replace("영</hp:t></hp:run>", `영</hp:t></hp:run>${seg(0)}`)
        .replace("첫줄</hp:t></hp:run>", `첫줄</hp:t></hp:run>${seg(90000)}`).replace("둘줄</hp:t></hp:run>", `둘줄</hp:t></hp:run>${seg(nextV)}`)
      zip.file(secName, sec)
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      return [...r.pageSvgs].filter(([, svg]) => svg.includes(">첫줄<")).map(([n]) => n)
    }
    assert.deepEqual(await render(1600), [2]) // 둘줄이 1000 + 600 — 첫줄이 새 쪽 맨 위
    assert.deepEqual(await render(0), [1]) // 둘줄이 맨 위면 첫줄은 앞 쪽 바닥 아래(감춘 빈 줄 등)
  })
})

describe("render: 문단 안 같은 vertpos 줄", () => {
  it("문단 안 둘째 줄이 앞 줄과 같은 vertpos(0)에 저장되면 새 쪽이다 — 쪽만 한 인라인 그림 둘을 담은 문단", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("가나"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const seg = (tp: number) => `<hp:lineseg textpos="${tp}" vertpos="0" vertsize="60000" textheight="60000" baseline="51000" spacing="600" horzpos="0" horzsize="42520" flags="393216"/>`
    zip.file(secName, (await zip.file(secName)!.async("string")).replace("가나</hp:t></hp:run>", `가나</hp:t></hp:run><hp:linesegarray>${seg(0)}${seg(1)}</hp:linesegarray>`))
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 2)
  })
})

describe("render: 문서 끝 빈 구역", () => {
  it("글·개체 없는 구역이 문서 끝에 붙으면 찍지 않는다 — 사이에 낀 빈 구역은 찍는다", async () => {
    const build = async (texts: string[]) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const sec0 = await zip.file("Contents/section0.xml")!.async("string")
      texts.forEach((t, i) => zip.file(`Contents/section${i}.xml`, sec0.replace("본문</hp:t>", `${t}</hp:t>`)))
      return (await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).pageSvgs.size
    }
    assert.equal(await build(["본문", "", ""]), 1)
    assert.equal(await build(["본문", "", "끝"]), 3)
  })

  it("바탕쪽을 단 빈 구역은 문서 끝이어도 찍는다(바탕쪽 머리글만 든 쪽)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const sec0 = await zip.file("Contents/section0.xml")!.async("string")
    zip.file("Contents/section1.xml", sec0.replace("본문</hp:t>", "</hp:t>").replace(/(<hp:secPr\b[^>]*>)/, '$1<hp:masterPage idRef="mp0"/>'))
    zip.file("Contents/masterpage0.xml", '<?xml version="1.0" encoding="UTF-8"?><hm:masterPage xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" id="mp0" type="BOTH" pageNumber="0" pageDuplicate="0" pageFront="0"><hp:subList></hp:subList></hm:masterPage>')
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.equal(r.pageSvgs.size, 2)
  })
})

describe("render: 한컴 기호 PUA 표시", () => {
  it("Wingdings 계열 PUA(U+F0E8)는 파서와 같은 표로 표준 기호(➔)로 그린다", async () => {
    const r = await renderHwpxToSvg(new Uint8Array(await markdownToHwpx("가\uf0e8나")), { reflow: true })
    assert.ok(r.svg.includes("➔") && !r.svg.includes("\uf0e8"), "➔ 로 그림")
  })
})

describe("render: 칸 안 다단", () => {
  it("칸 첫 문단 colPr 가 2단이면 줄 vertpos 되돌아감은 다음 단 — 행은 단 중 가장 긴 높이, 오른쪽 단 줄은 단 폭 + 간격만큼 오른쪽", async () => {
    const { measureTableRowHeights } = await import("../src/render/para-model.js")
    const segs = [0, 1000, 0, 1000].map((v, i) => `<hp:lineseg textpos="${i}" vertpos="${v}" vertsize="800" textheight="800" baseline="680" spacing="200" horzpos="0" horzsize="9000"/>`).join("")
    // 다단 정의(colPr)는 칸 첫 문단에, 글은 다음 문단에
    const colP = `<hp:p><hp:run><hp:ctrl><hp:colPr type="NEWSPAPER" colCount="2" sameSz="1" sameGap="1000"/></hp:ctrl></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="800" textheight="800" baseline="680" spacing="200" horzpos="0" horzsize="9000"/></hp:linesegarray></hp:p>`
    const cell = `<hp:subList>${colP}<hp:p><hp:run><hp:t>가나다라</hp:t></hp:run><hp:linesegarray>${segs}</hp:linesegarray></hp:p></hp:subList>`
    const tbl = createXmlParser().parseFromString(`<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" rowCnt="1" colCnt="1"><hp:sz width="20000" height="282"/><hp:tr><hp:tc>${cell}<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="20000" height="282"/><hp:cellMargin left="500" right="500" top="141" bottom="141"/></hp:tc></hp:tr></hp:tbl>`, "text/xml").documentElement as unknown as Element
    // 단마다 2줄(0·1000, 바닥 1800) — 쪽 나눔으로 이으면 3800
    assert.equal(measureTableRowHeights(tbl)[0], 1800 + 282)
    const zip = await JSZip.loadAsync(await markdownToHwpx("| 머리 |\n|---|\n| 가나다라 |"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/<hp:run charPrIDRef="(\d+)"><hp:t>가나다라<\/hp:t><\/hp:run>/, `<hp:run charPrIDRef="$1"><hp:t>가나다라</hp:t></hp:run><hp:linesegarray>${segs}</hp:linesegarray>`)
      .replace(/(<hp:subList [^>]*>)(<hp:p [^>]*>)(?=<hp:run charPrIDRef="\d+"><hp:t>가나다라)/, `$1${colP.replace("<hp:p>", "$2").replace("<hp:run>", '<hp:run charPrIDRef="0">')}$2`)
    zip.file(secName, sec)
    const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
    const x = (t: string) => Number(svg.match(new RegExp(`<text x="([\\d.]+)"[^>]*>${t}<`))![1])
    // 칸 안쪽 폭 = 44000 − 1020(칸 여백 510×2) → 단 폭 (42980 − 1000)/2 = 20990, 오른쪽 단은 + 21990
    assert.ok(Math.abs(x("다") - x("가") - 219.9) < 0.05, `${x("가")} ${x("다")}`)
  })
})

describe("reflow: 줄 폭은 영역 폭을 4 단위로 내린 뒤 여백을 뺀다", () => {
  it("본문 39686 · 왼쪽 여백 1850 → horzsize 37834", async () => {
    const { reflowSection } = await import("../src/render/reflow.js")
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const src = await JSZip.loadAsync(await markdownToHwpx("가나다"))
    const secName = Object.keys(src.files).find(n => /section0\.xml$/.test(n))!
    const head = (await src.file("Contents/header.xml")!.async("string")).replace(/(<hh:paraPr id="0"[\s\S]*?<hc:left value=")0"/, '$11850"')
    const root = createXmlParser().parseFromString(await src.file(secName)!.async("string"), "text/xml").documentElement as unknown as Element
    reflowSection(root, parseRenderStyles(head), { BODY_W: 39686, BODY_H: 0 })
    const p = Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).find(e => (e.textContent ?? "").includes("가나다"))!
    assert.equal((p.getElementsByTagName("hp:lineseg")[0] as unknown as Element).getAttribute("horzsize"), "37834")
  })
})

describe("reflow: 칸 줄 폭은 그 열에서 가장 넓은 칸 기준", () => {
  it("열 1 칸 22393 은 같은 열 다른 행 22396 기준 — 여백 566×2 → horzsize 21264", async () => {
    const { reflowSection } = await import("../src/render/reflow.js")
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const src = await JSZip.loadAsync(await markdownToHwpx("| 가 | 나 |\n| --- | --- |\n| 다 | 라 |"))
    const secName = Object.keys(src.files).find(n => /section0\.xml$/.test(n))!
    let k = 0
    const sec = (await src.file(secName)!.async("string"))
      .replace(/<hp:cellSz width="22000"/g, () => `<hp:cellSz width="${k++ === 3 ? 22396 : 22393}"`)
      .replace(/<hp:cellMargin left="141" right="141"/g, '<hp:cellMargin left="566" right="566"').replace(/hasMargin="0"/g, 'hasMargin="1"')
    const root = createXmlParser().parseFromString(sec, "text/xml").documentElement as unknown as Element
    reflowSection(root, parseRenderStyles(await src.file("Contents/header.xml")!.async("string")), { BODY_W: 48188, BODY_H: 0 })
    const w = (t: string) => (Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).find(e => e.textContent === t)!.getElementsByTagName("hp:lineseg")[0] as unknown as Element).getAttribute("horzsize")
    assert.deepEqual([w("가"), w("나"), w("라")], ["21260", "21264", "21264"])
  })

  it("모든 열에 걸친 칸은 표 폭 기준 — 칸 47899 · 표 47943 · 여백 141×2 → horzsize 47660", async () => {
    const { reflowSection } = await import("../src/render/reflow.js")
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const src = await JSZip.loadAsync(await markdownToHwpx("| 가 | 나 |\n| --- | --- |\n| 다 | 라 |"))
    const secName = Object.keys(src.files).find(n => /section0\.xml$/.test(n))!
    let sec = await src.file(secName)!.async("string")
    // 둘째 행을 두 열 병합 한 칸("다")으로 — 칸 폭은 표 폭보다 44 좁게 저장
    sec = sec.replace(/(<hp:tr>(?:(?!<hp:tr>)[\s\S])*?<hp:t>다<\/hp:t>[\s\S]*?<hp:cellSpan colSpan=)"1"( rowSpan="1"\/><hp:cellSz width=)"\d+"([\s\S]*?<\/hp:tc>)<hp:tc\b[\s\S]*?<\/hp:tc>/, '$1"2"$2"47899"$3')
      .replace(/(<hp:tbl\b[^>]*>\s*<hp:sz width=)"\d+"/, '$1"47943"').replace(/hasMargin="0"/g, 'hasMargin="1"')
    assert.match(sec, /colSpan="2"/)
    const root = createXmlParser().parseFromString(sec, "text/xml").documentElement as unknown as Element
    reflowSection(root, parseRenderStyles(await src.file("Contents/header.xml")!.async("string")), { BODY_W: 48188, BODY_H: 0 })
    const p = Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).find(e => e.textContent === "다")!
    assert.equal((p.getElementsByTagName("hp:lineseg")[0] as unknown as Element).getAttribute("horzsize"), "47660")
  })
})

describe("render: 쪽을 넘는 표 뒤 문단", () => {
  it("표가 쪽을 넘으면 뒤 문단은 표가 끝나는 쪽에 — 표 끝보다 위에 저장돼 있으면(쪽 나누기 등) 그다음 쪽", async () => {
    const { reflowSection } = await import("../src/render/reflow.js")
    const { parseRenderStyles } = await import("../src/render/head-styles.js")
    const rows = Array.from({ length: 130 }, (_, i) => `| 행${i} | 값 |`).join("\n")
    const src = await JSZip.loadAsync(await markdownToHwpx(`| 머리 | 값 |\n| --- | --- |\n${rows}\n\n뒤문단`))
    const secName = Object.keys(src.files).find(n => /section0\.xml$/.test(n))!
    const secXml = await src.file(secName)!.async("string"), head = await src.file("Contents/header.xml")!.async("string")
    // 표가 세 쪽에 걸친다 — 쪽 리셋 하나만 세면 뒤 문단이 둘째 쪽 표 위에 겹친다. 칸·본문 lineseg 를 채워 한컴 저장본처럼 만든 뒤 뒤 문단 vertpos 를 고친다
    const render = async (lastV: number) => {
      const doc = createXmlParser().parseFromString(secXml, "text/xml")
      const root = doc.documentElement as unknown as Element
      reflowSection(root, parseRenderStyles(head), { BODY_W: 48188, BODY_H: 0 })
      const tops = Array.from(root.childNodes as unknown as Element[]).filter(c => c.nodeName === "hp:p")
      ;(tops[tops.length - 1].getElementsByTagName("hp:lineseg")[0] as unknown as Element).setAttribute("vertpos", String(lastV))
      const zip = await JSZip.loadAsync(await src.generateAsync({ type: "nodebuffer" }))
      zip.file(secName, String(doc))
      const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const pagesWith = (needle: string) => [...r.pageSvgs].filter(([, svg]) => svg.includes(needle)).map(([n]) => n)
      return { lastRow: pagesWith(">행129<")[0], after: pagesWith(">뒤문단<") }
    }
    const below = await render(65000)
    assert.ok(below.lastRow >= 3, `표가 세 쪽 이상 (${below.lastRow})`)
    assert.deepEqual(below.after, [below.lastRow])
    const top = await render(0)
    assert.deepEqual(top.after, [top.lastRow + 1])
  })
})

describe("render: 문단 세로 정렬 기준선", () => {
  it("세로 가운데 정렬 문단 글자는 저장 baseline(줄 가운데)보다 글자 크기 0.35 만큼 아래에 찍힌다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("가나다라"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
    let head = await zip.file(headName)!.async("string")
    head = head.replace(/(<hh:align [^>]*vertical=")BASELINE(")/g, "$1CENTER$2")
    zip.file(headName, head)
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "")
      .replace(/(<hp:t>가나다라<\/hp:t><\/hp:run>)/, `$1<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="500" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const m = r.svg.match(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>가나다라</)
    assert.ok(m, "글 조각")
    const base = Number(m![1])
    // 같은 문서를 BASELINE 으로 그리면 0.35·10pt = 3.5pt 위
    const zip2 = await JSZip.loadAsync(await zip.generateAsync({ type: "nodebuffer" }))
    zip2.file(headName, head.replace(/(<hh:align [^>]*vertical=")CENTER(")/g, "$1BASELINE$2"))
    const r2 = await renderHwpxToSvg(new Uint8Array(await zip2.generateAsync({ type: "nodebuffer" })))
    const base2 = Number(r2.svg.match(/<text x="[-\d.]+" y="([-\d.]+)"[^>]*>가나다라</)![1])
    assert.ok(Math.abs(base - base2 - 3.5) < 0.05, `가운데 ${base} 기준 ${base2}`)
  })
})

describe("render: 강제 줄바꿈 줄 정렬", () => {
  it("양쪽 정렬 문단에서 강제 줄바꿈으로 끝난 줄은 늘이지 않는다(마지막 줄처럼)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n가나 다라"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("<hp:t>가나 다라</hp:t></hp:run>", `<hp:t>가나 </hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>다라<hp:lineBreak/>마바</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/><hp:lineseg textpos="6" vertpos="1600" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`)
    zip.file(secName, sec)
    const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
    const xs = [...svg.matchAll(/<text x="([-\d.]+)"[^>]*>([^<]+)</g)].map(m => [m[2], Number(m[1])] as const)
    const da = xs.find(([t]) => t === "다라")!, ga = xs.find(([t]) => t.startsWith("가나"))!
    // 늘이지 않으면 "다라" 는 "가나 "(10pt 2자 + 공백 5pt) 바로 뒤 — 늘이면 줄 끝(425pt 폭) 쪽으로 밀린다
    assert.ok(da[1] - ga[1] < 30, `다라 ${da[1]} 가나 ${ga[1]}`)
  })
})

describe("render: 왼쪽·가운데 정렬 중간 줄", () => {
  it("가운데 정렬 문단은 중간 줄도 늘이지 않고 줄마다 가운데에, 왼쪽 정렬은 왼쪽에 둔다", async () => {
    const render = async (align: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n가나 다라"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
      zip.file(headName, (await zip.file(headName)!.async("string")).replace(/(<hh:align horizontal=")\w+(")/g, `$1${align}$2`))
      let sec = await zip.file(secName)!.async("string")
      sec = sec.replace("<hp:t>가나 다라</hp:t></hp:run>", `<hp:t>가나 </hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>다라마바</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/><hp:lineseg textpos="5" vertpos="1600" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`)
      zip.file(secName, sec)
      const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
      const xs = [...svg.matchAll(/<text x="([-\d.]+)"[^>]*>([^<]+)</g)].map(m => [m[2], Number(m[1])] as const)
      return { ga: xs.find(([t]) => t.startsWith("가나"))![1], da: xs.find(([t]) => t === "다라")![1] }
    }
    // 첫 줄 "가나 다라"(25pt) — 가운데면 425pt 줄의 가운데 근처에서 시작하고 늘이지 않는다, 왼쪽이면 줄 왼쪽에서 늘이지 않고
    const c = await render("CENTER"), l = await render("LEFT")
    assert.ok(c.ga > l.ga + 150, `가운데 ${c.ga} 왼쪽 ${l.ga}`)
    assert.ok(c.da - c.ga < 30 && l.da - l.ga < 30, `가운데 ${c.da - c.ga} 왼쪽 ${l.da - l.ga}`)
  })
})

describe("render: 양쪽 정렬 늘임", () => {
  it("양쪽 정렬 중간 줄은 남는 폭을 빈칸에만 준다 — 글자는 늘이지 않는다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n가나 다라"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
    zip.file(headName, (await zip.file(headName)!.async("string")).replace(/(<hh:align horizontal=")\w+(")/g, "$1JUSTIFY$2"))
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("<hp:t>가나 다라</hp:t></hp:run>", `<hp:t>가나 </hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>다라마바</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/><hp:lineseg textpos="5" vertpos="1600" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`)
    zip.file(secName, sec)
    const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
    const xs = [...svg.matchAll(/<text x="([-\d.]+)"[^>]*>([^<]+)</g)].map(m => [m[2], Number(m[1])] as const)
    const ga = xs.find(([t]) => t.startsWith("가나"))![1], da = xs.find(([t]) => t === "다라")![1]
    // 425pt 줄: "가나" 는 제 폭, 빈칸 하나가 남는 폭을 다 받아 "다라" 가 줄 오른쪽 끝(425 − 20)에 붙는다
    assert.ok(Math.abs(da - ga - (425.2 - 20)) < 1, `가나 ${ga} 다라 ${da}`)
  })
})

describe("render: 고정폭 빈칸 폭", () => {
  it("measureTextWidth 는 고정폭 빈칸(U+2005)을 글꼴과 무관하게 1/4em 으로 잰다", async () => {
    const { measureTextWidth, faceClassOf } = await import("../src/hwpx/text-metrics.js")
    for (const fc of ["hcr", "fixedPitch", "gothic", "cjk", faceClassOf("HY헤드라인M"), faceClassOf("한컴 윤고딕 230")] as const)
      assert.equal(measureTextWidth("\u2005", 1000, 100, { faceClass: fc }), 250, String(fc))
  })
})

describe("render: 위첨자", () => {
  it("위첨자 글자 모양은 크기 16/25 로 그리고 기준선을 0.44·크기 올리며, 뒤 글은 줄인 폭만큼만 밀린다", async () => {
    const build = async (sup: boolean) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("가나다라"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
      let head = await zip.file(headName)!.async("string")
      if (sup) head = head.replace(/(<hh:charPr id="2"[^>]*>)/, "$1<hh:supscript/>")
      zip.file(headName, head)
      zip.file(secName, (await zip.file(secName)!.async("string")).replace("<hp:t>가나다라</hp:t></hp:run>", `<hp:t>가나</hp:t></hp:run><hp:run charPrIDRef="2"><hp:t>AB</hp:t></hp:run><hp:run charPrIDRef="0"><hp:t>다라</hp:t></hp:run>`))
      const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
      const at = (t: string) => svg.match(new RegExp(`<text x="([-\\d.]+)" y="([-\\d.]+)" font-size="([-\\d.]+)"[^>]*>${t}<`))!.slice(1).map(Number)
      return { ga: at("가나"), ab: at("AB"), da: at("다라") }
    }
    const plain = await build(false), sup = await build(true)
    assert.equal(sup.ab[2], 6.4, "크기 10pt × 16/25")
    assert.ok(Math.abs(sup.ga[1] - sup.ab[1] - 4.4) < 0.02, `올림 ${sup.ga[1] - sup.ab[1]}`)
    // "AB" 폭이 16/25 로 줄어 뒤 글이 그만큼 앞으로
    const wPlain = plain.da[0] - plain.ab[0], wSup = sup.da[0] - sup.ab[0]
    assert.ok(Math.abs(wSup - wPlain * 16 / 25) < 0.2, `첨자 폭 ${wSup} vs ${wPlain}`)
  })
})

describe("render: 글자 음영", () => {
  it("charPr shadeColor 는 글자 상자(기준선 위 0.85·크기, 높이 = 크기)에 칠하고, 흰색은 칠하지 않는다", async () => {
    const build = async (shade: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("가나다라"))
      const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
      zip.file(headName, (await zip.file(headName)!.async("string")).replace(/shadeColor="[^"]*"/g, `shadeColor="${shade}"`))
      return (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })).svg
    }
    const svg = await build("#3E7AA6")
    const rect = svg.match(/<rect x="([-\d.]+)" y="([-\d.]+)" width="[-\d.]+" height="([-\d.]+)" fill="#3E7AA6"\/>/)
    const text = svg.match(/<text x="([-\d.]+)" y="([-\d.]+)" font-size="([-\d.]+)"[^>]*>가나다라</)
    assert.ok(rect && text, "음영 상자와 글")
    assert.equal(rect![1], text![1])
    assert.ok(Math.abs(Number(text![2]) - 0.85 * Number(text![3]) - Number(rect![2])) < 0.02, `상자 위 ${rect![2]} 기준선 ${text![2]}`)
    assert.equal(rect![3], text![3])
    assert.ok(!/fill="#FFFFFF"\/>/i.test(await build("#FFFFFF")), "흰 음영 없음")
  })
})

describe("render: 글자처럼 취급한 그림의 기준선", () => {
  it("그림은 높이의 85% 를 줄 기준선 위에, 15% 를 아래에 둔다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const pic = `<hp:pic><hp:sz width="4000" height="2000"/><hp:pos treatAsChar="1"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hc:img xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" binaryItemIDRef="none"/></hp:pic>`
    sec = sec.replace("본문</hp:t>", `본문</hp:t>${pic}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="3000" textheight="3000" baseline="2550" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const ty = Number(r.svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>본문/)![1]), py = Number(r.svg.match(/<rect x="[\d.]+" y="([\d.]+)" width="40" height="20"/)![1])
    assert.ok(Math.abs(py - (ty - 25.5 + 8.5)) < 0.02, `그림 위 ${py} 기준선 ${ty}`) // 줄 위 + (2550 − 0.85 × 2000)
  })
})

describe("render: 칸 잘림", () => {
  it("칸보다 넓은 인라인 그림은 칸 경계에서 잘린다(clip-path)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("| a | b |\n|---|---|\n| c | d |"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const pic = `<hp:pic><hp:sz width="40000" height="2000"/><hp:pos treatAsChar="1"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hc:img xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" binaryItemIDRef="none"/></hp:pic>`
    sec = sec.replace(/(<hp:t>c<\/hp:t>)/, `$1${pic}`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.ok(/<g clip-path="url\(#cclip\d+\)">/.test(r.svg), "칸 잘림 그룹")
    assert.ok(/<clipPath id="cclip\d+"><rect /.test(r.svg), "칸 잘림 틀")
  })
})

describe("render: 글상자", () => {
  const box = (margin: string, vo: string) => `<hp:rect textWrap="IN_FRONT_OF_TEXT"><hp:sz width="20000" height="5000"/><hp:pos treatAsChar="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="${vo}" horzOffset="0"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:drawText lastWidth="20000"><hp:textMargin left="${margin}" right="${margin}" top="${margin}" bottom="${margin}"/><hp:subList><hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>상자글</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="19000" flags="393216"/></hp:linesegarray></hp:p></hp:subList></hp:drawText><hp:pt0 x="0" y="0"/><hp:pt1 x="20000" y="0"/><hp:pt2 x="20000" y="5000"/><hp:pt3 x="0" y="5000"/></hp:rect>`
  const render = async (margin: string, vo: string) => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("본문</hp:t>", `본문</hp:t>${box(margin, vo)}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const m = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>상자글</)!
    return [Number(m[1]), Number(m[2])]
  }
  it("글상자 글은 안 여백(textMargin)만큼 들어가고, 문단 기준 위로 올린 오프셋은 문단 위에서 멈춘다", async () => {
    const [x0, y0] = await render("0", "0"), [x1, y1] = await render("283", "0")
    assert.ok(Math.abs(x1 - x0 - 2.83) < 0.02 && Math.abs(y1 - y0 - 2.83) < 0.02, `${x0},${y0} → ${x1},${y1}`)
    const [, yUp] = await render("0", "4294955170") // −12126 — 문단 위(0)에서 멈춘다
    assert.equal(yUp, y0)
  })
  it("글 앞 배치 개체는 바깥 위·왼쪽 여백만큼 안쪽에 놓인다", async () => {
    const [x0, y0] = await render("0", "0")
    const withOm = async () => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const b = box("0", "0").replace('<hp:outMargin left="0" right="0" top="0" bottom="0"/>', '<hp:outMargin left="850" right="850" top="850" bottom="850"/>')
      zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문</hp:t>", `본문</hp:t>${b}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`))
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const m = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>상자글</)!
      return [Number(m[1]), Number(m[2])]
    }
    const [x1, y1] = await withOm()
    assert.ok(Math.abs(x1 - x0 - 8.5) < 0.02 && Math.abs(y1 - y0 - 8.5) < 0.02, `${x0},${y0} → ${x1},${y1}`)
  })
  it("같은 문단의 위아래 배치 개체 둘은 문단 위부터 차례로 쌓인다", async () => {
    const tb = (t: string, h: number) => box("0", "0").replace('textWrap="IN_FRONT_OF_TEXT"', 'textWrap="TOP_AND_BOTTOM"').replace('height="5000"', `height="${h}"`).replaceAll('y="5000"', `y="${h}"`).replace("상자글", t)
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    // 첫 줄은 두 개체 아래(3000 + 2000)에 저장
    zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문</hp:t></hp:run>", `본문</hp:t>${tb("첫상자", 3000)}${tb("둘상자", 2000)}</hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="5000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`))
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const y = (t: string) => Number(r.svg.match(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${t}<`))![1])
    assert.ok(Math.abs(y("둘상자") - y("첫상자") - 30) < 0.02, `${y("첫상자")} ${y("둘상자")}`)
    // 겹침 허용(allowOverlap=1) 개체는 쌓지 않는다
    const ov = (t: string, h: number) => tb(t, h).replace('treatAsChar="0"', 'treatAsChar="0" allowOverlap="1"')
    const zip2 = await JSZip.loadAsync(await markdownToHwpx("본문"))
    zip2.file(secName, (await zip2.file(secName)!.async("string")).replace("본문</hp:t></hp:run>", `본문</hp:t>${ov("첫상자", 3000)}${ov("둘상자", 3000)}</hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>`))
    const r2 = await renderHwpxToSvg(new Uint8Array(await zip2.generateAsync({ type: "nodebuffer" })))
    const y2 = (t: string) => Number(r2.svg.match(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${t}<`))![1])
    assert.equal(y2("둘상자"), y2("첫상자"))
  })
  it("첫 줄 뒤에 앵커한 위아래 개체가 오프셋으로 앵커 줄보다 아래면 줄을 밀지 않고 앵커 줄 위 + 오프셋에 놓인다", async () => {
    const at = async (vo: string) => {
      const tb = box("0", vo).replace('textWrap="IN_FRONT_OF_TEXT"', 'textWrap="TOP_AND_BOTTOM"')
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문</hp:t>", `본문</hp:t>${tb}`).replace(/<\/hp:p>(?![\s\S]*<\/hp:p>)/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/><hp:lineseg textpos="18" vertpos="10000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`))
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const y = (t: string) => Number(r.svg.match(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${t}<`))![1])
      return y("상자글") - y("본문")
    }
    // 둘째 줄(10000) + 오프셋 4000 → 상자 위 = 첫 줄보다 110pt 아래(글 기준선 둘 다 8.5pt)
    assert.ok(Math.abs(await at("4000") - 110) < 0.02, String(await at("4000")))
    // 오프셋 0 이면 상자가 둘째 줄을 밀어낸 것 — 상자 바닥 = 둘째 줄 위(10000 − 5000)
    assert.ok(Math.abs(await at("0") - 20) < 0.02, String(await at("0")))
  })
  it("칸 안 글 뒤 앵커 어울림 개체가 첫 줄을 덮어 줄이 아래로 저장돼도 개체는 문단 위 기준이다", async () => {
    const sq = box("0", "0").replace('textWrap="IN_FRONT_OF_TEXT"', 'textWrap="SQUARE"')
    const cellP = `<hp:p paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>칸글</hp:t>${sq}<hp:t/></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="5000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="20000" flags="393216"/></hp:linesegarray></hp:p>`
    const tbl = `<hp:tbl rowCnt="1" colCnt="1"><hp:sz width="20000" height="7000"/><hp:pos treatAsChar="1" vertRelTo="PARA" horzRelTo="PARA"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:tr><hp:tc><hp:subList>${cellP}</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="20000" height="7000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/></hp:tc></hp:tr></hp:tbl>`
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문</hp:t>", `본문</hp:t>${tbl}`).replace(/<\/hp:p>(?![\s\S]*<\/hp:p>)/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="7000" textheight="7000" baseline="5950" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`))
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const y = (s: string) => Number(r.svg.match(new RegExp(`<text x="[\\d.]+" y="([\\d.]+)"[^>]*>${s}<`))![1])
    // 상자는 칸 위(문단 위 0), 글 줄은 그 아래 5000 — 상자글이 칸글보다 50pt 위(종전엔 상자를 내려간 줄 5000 에 붙여 0)
    assert.ok(Math.abs(y("상자글") - y("칸글") + 50) < 0.02, String(y("상자글") - y("칸글")))
  })
  it("용지 기준 위 정렬 개체는 세로도 바깥 위 여백만큼 내려간다", async () => {
    const at = async (om: string) => {
      const paper = box("0", "5720").replace('vertRelTo="PARA" horzRelTo="PARA"', 'vertRelTo="PAPER" horzRelTo="PAPER"').replace('<hp:outMargin left="0" right="0" top="0" bottom="0"/>', `<hp:outMargin left="${om}" right="${om}" top="${om}" bottom="${om}"/>`)
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문</hp:t>", `본문</hp:t>${paper}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`))
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      const m = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)"[^>]*>상자글</)!
      return [Number(m[1]), Number(m[2])]
    }
    const [x0, y0] = await at("0"), [x1, y1] = await at("852")
    assert.ok(Math.abs(x1 - x0 - 8.52) < 0.02 && Math.abs(y1 - y0 - 8.52) < 0.02, `${x0},${y0} → ${x1},${y1}`)
  })
  it("글상자 세로 가운데·아래 정렬은 안쪽 높이에서 내용 높이를 뺀 절반·전부만큼 글을 내린다", async () => {
    const withVa = async (va: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      let sec = await zip.file(secName)!.async("string")
      sec = sec.replace("본문</hp:t>", `본문</hp:t>${box("0", "0").replace("<hp:subList>", `<hp:subList vertAlign="${va}">`)}`).replace(/<\/hp:p>(?![\s\S]*<\/hp:p>)/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
      zip.file(secName, sec)
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
      return Number(r.svg.match(/<text x="[\d.]+" y="([\d.]+)"[^>]*>상자글</)![1])
    }
    // 상자 5000, 내용 1000 → 가운데 +20pt, 아래 +40pt
    const yTop = await withVa("TOP"), yc = await withVa("CENTER")
    assert.ok(Math.abs(yc - yTop - 20) < 0.02, `${yTop} → ${yc}`)
    assert.ok(Math.abs(await withVa("BOTTOM") - yTop - 40) < 0.02)
  })
  it("글상자 안 문단에 조판 캐시가 없으면 그 문단만 다시 조판해 그린다(본문 캐시는 그대로)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const noCache = box("283", "0").replace(/<hp:linesegarray>.*?<\/hp:linesegarray>/, "")
    sec = sec.replace("본문</hp:t>", `본문</hp:t>${noCache}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="3000" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.ok(/>상자글</.test(r.svg), "캐시 없는 글상자 글도 그린다")
  })
})

describe("render: 떠 있는 개체 가로 자리", () => {
  it("왼쪽 정렬 떠 있는 표는 가로 오프셋 + 바깥 왼쪽 여백에 그린다", async () => {
    const leftX = async (om: string) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("| a | b |\n|---|---|\n| c | d |"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      const sec = (await zip.file(secName)!.async("string")).replace(`<hp:outMargin left="0" right="0" top="0" bottom="1600"/>`, `<hp:outMargin left="${om}" right="0" top="0" bottom="1600"/>`)
      zip.file(secName, sec)
      const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
      return Number(r.svg.match(/<line x1="([\d.]+)" y1="[\d.]+" x2="[\d.]+"/)?.[1])
    }
    const a = await leftX("0"), b = await leftX("283")
    assert.ok(Math.abs(b - a - 2.83) < 0.02, `${a} → ${b}`)
  })
})

describe("render: 줄 아래 위아래 배치 표의 기준", () => {
  it("글을 밀지 않은 첫 줄 앵커 표는 앞 문단 끝(위 간격 앞) + vertOffset 에 놓인다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫 문단\n\n| a | b |\n|---|---|\n| c | d |"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const seg = (v: number) => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${v}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`
    let sec = await zip.file(secName)!.async("string")
    // 표 문단 줄 3000 = 앞 문단 끝 1600 + 위 간격 1400 (문단 모양 0 의 위 간격 — 첫 문단은 쪽 맨 위라 줄 0 그대로)
    const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
    zip.file(headName, (await zip.file(headName)!.async("string")).replace(/(<hh:paraPr id="0"[\s\S]*?<hc:prev value=")0"/, '$11400"'))
    sec = sec.replace("첫 문단</hp:t></hp:run></hp:p>", `첫 문단</hp:t></hp:run>${seg(0)}</hp:p>`)
      .replace(/(<hp:tbl\b[\s\S]*?vertOffset=")0"/, '$12000"')
      .replace(/<\/hp:tbl><\/hp:run><\/hp:p>/, `</hp:tbl><hp:t>글</hp:t></hp:run>${seg(3000)}</hp:p>`)
    zip.file(secName, sec)
    const svg = (await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))).svg
    const top = Number(svg.match(/y="([\d.]+)"[^>]*>첫 문단</)![1]) - 8.5
    const tableTop = Math.min(...[...svg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1"/g)].map(m => Number(m[1])))
    // 앞 문단 끝 1600 + vertOffset 2000 = 36pt (줄 3000 기준이면 50pt)
    assert.ok(Math.abs(tableTop - top - 36) < 0.05, `${tableTop - top}`)
  })
})

describe("render: 글 없는 문단의 떠 있는 표", () => {
  it("글 없는 문단(위아래 개체 하나)의 표는 그 문단 줄 위치에서 시작한다 — 앞 문단 위로 올라가지 않는다", async () => {
    const r = await renderHwpxToSvg(new Uint8Array(await markdownToHwpx("가\n\n나\n\n다\n\n라라라\n\n| a | b |\n|---|---|\n| c | d |")), { reflow: true })
    const textY = Number(r.svg.match(/y="([\d.]+)"[^>]*>라라라</)?.[1])
    const firstLine = Math.min(...[...r.svg.matchAll(/<line x1="[\d.]+" y1="([\d.]+)" x2="[\d.]+" y2="\1"/g)].map(m => Number(m[1])))
    assert.ok(firstLine > textY, `표 위 선 ${firstLine} 이 앞 문단 글 ${textY} 아래`)
  })
})

describe("render: 캐시가 섞인 문서", () => {
  it("lineseg 없는 문단이 섞여 있으면 그 문단만 흐름 위치에 다시 조판한다(쪽 맨 위에 겹치지 않는다)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫째 문단\n\n둘째 문단"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    let k = 0
    sec = sec.replace(/<\/hp:p>/g, m => (k++ === 0 ? `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray>` : "") + m)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    const y = (t: string) => Number(r.pageSvgs.get(1)!.match(new RegExp(`y="([\\d.]+)"[^>]*>${t}<`))?.[1])
    assert.ok(y("둘째 문단") > y("첫째 문단"), `${y("첫째 문단")} → ${y("둘째 문단")}`)
  })
})

describe("render: 문서 끝 빈 쪽", () => {
  it("문서 끝에 빈 문단만 든 쪽(쪽 나누기 걸린 빈 끝 문단)은 찍지 않는다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문\n\n끝"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    let k = 0
    sec = sec.replace(/<\/hp:p>/g, () => `<hp:linesegarray><hp:lineseg textpos="0" vertpos="${k++ === 0 ? 0 : 1600}" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
    sec = sec.replace("</hs:sec>", `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="1"><hp:run charPrIDRef="0"/><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p></hs:sec>`)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 1)
  })
})

describe("render: 문서 끝 빈 쪽 — 쪽을 채운 개체 뒤", () => {
  it("쪽 나누기 없이 넘어간 빈 끝 문단은 앞 쪽 개체가 본문 안에 들면 그 쪽을 찍고, 본문보다 크면 찍지 않는다", async () => {
    const pages = async (picH: number) => {
      const zip = await JSZip.loadAsync(await markdownToHwpx("본문"))
      const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
      let sec = await zip.file(secName)!.async("string")
      const pic = `<hp:pic><hp:sz width="20000" height="${picH}"/><hp:pos treatAsChar="1"/><hp:outMargin left="0" right="0" top="0" bottom="0"/><hc:img xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" binaryItemIDRef="none"/></hp:pic>`
      sec = sec.replace("본문</hp:t>", `본문</hp:t>${pic}`).replace(/<\/hp:p>/, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
      sec = sec.replace("</hs:sec>", `<hp:p paraPrIDRef="0" styleIDRef="0" pageBreak="0"><hp:run charPrIDRef="0"/><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p></hs:sec>`)
      zip.file(secName, sec)
      return (await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))).pageSvgs.size
    }
    assert.equal(await pages(60000), 2) // 본문 안에 든 그림 뒤 빈 문단 — 빈 둘째 쪽을 찍는다
    assert.equal(await pages(90000), 1) // 본문보다 큰 그림 — 빈 쪽 없이 끝난다
  })
})

describe("render: 망가진 조판 캐시", () => {
  it("쪽 나누기 없는 최상위 문단이 잇달아 모두 vertpos 0 이면 캐시를 버리고 다시 조판한다(문단마다 새 쪽 금지)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("하나\n\n둘\n\n셋\n\n넷\n\n다섯"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/<\/hp:p>/g, `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="48188" flags="393216"/></hp:linesegarray></hp:p>`)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })))
    assert.equal(r.pageSvgs.size, 1)
    const ys = ["하나", "둘", "셋"].map(t => Number(r.pageSvgs.get(1)!.match(new RegExp(`y="([\\d.]+)"[^>]*>${t}<`))?.[1]))
    assert.ok(ys[0] < ys[1] && ys[1] < ys[2], `다시 조판해 차례로 아래 (${ys})`)
  })
})

describe("render: 쪽 번호", () => {
  it("pageNum 컨트롤은 쪽 아래 가운데에 '기호 N 기호' 를 10pt 로 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace("본문입니다.</hp:t>", `본문입니다.</hp:t><hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>`)
    zip.file(secName, sec)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const m = r.svg.match(/<text x="([\d.]+)" y="([\d.]+)" font-size="10"[^>]*>- 1 -<\/text>/)
    assert.ok(m, "쪽 번호 - 1 - 이 10pt 로 그려짐")
    assert.ok(Math.abs(parseFloat(m![1]) - (595.28 / 2 - 14)) < 10, `가운데 x ${m![1]}`)
  })
  it("쪽 번호 글꼴은 '쪽 번호' 스타일의 글자 모양을 따른다(컨트롤이 든 글자 모양과 무관)", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("본문입니다."))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
    zip.file(secName, (await zip.file(secName)!.async("string")).replace("본문입니다.</hp:t>", `본문입니다.</hp:t><hp:ctrl><hp:pageNum pos="BOTTOM_CENTER" formatType="DIGIT" sideChar="-"/></hp:ctrl>`))
    let head = await zip.file(headName)!.async("string")
    // 글자 모양 2 를 함초롬돋움으로 바꾸고 '쪽 번호' 스타일이 그것을 가리키게 한다
    head = head.replace(/(<hh:charPr id="2"[\s\S]*?<hh:fontRef )hangul="0" latin="0"/, '$1hangul="1" latin="1"')
      .replace(/(<hh:style id="0"[^>]*\/>)/, `$1<hh:style id="9" type="PARA" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="2" nextStyleIDRef="9" langID="1042" lockForm="0"/>`)
    zip.file(headName, head)
    const r = await renderHwpxToSvg(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const m = r.svg.match(/<text [^>]*font-family="([^"]*)"[^>]*>- 1 -<\/text>/)
    assert.ok(m && m[1].includes("HCR Dotum"), `쪽 번호 글꼴 ${m?.[1]}`)
  })
})

describe("render: 쪽을 넘는 표", () => {
  it("본문 바닥을 넘는 행부터 다음 쪽에 이어 그리고, 머리 행 반복이면 이어진 쪽 맨 위에 머리 행을 다시 그린다", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| 행${i} | 값${i} |`).join("\n")
    const zip = await JSZip.loadAsync(await markdownToHwpx(`| 머리열 | 머리값 |\n| --- | --- |\n${rows}`))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    // 머리 행 반복 + 첫 행 칸 모두 header="1"
    sec = sec.replace(/<hp:tbl ([^>]*)repeatHeader="\d"/, '<hp:tbl $1repeatHeader="1"')
    sec = sec.replace(/<hp:tr>[\s\S]*?<\/hp:tr>/, tr => tr.replace(/(<hp:tc [^>]*)header="0"/g, '$1header="1"'))
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    assert.ok(r.pageSvgs.size >= 2, `60행 표가 ${r.pageSvgs.size}쪽 — 다음 쪽으로 이어져야`)
    const p2 = r.pageSvgs.get(2)!
    assert.ok(/행\d+/.test(p2), "둘째 쪽에 이어진 행")
    assert.ok(p2.includes("머리열"), "둘째 쪽 맨 위에 머리 행 반복")
    const p1Last = Math.max(...[...r.pageSvgs.get(1)!.matchAll(/>행(\d+)</g)].map(m => Number(m[1])))
    const p2First = Math.min(...[...p2.matchAll(/>행(\d+)</g)].map(m => Number(m[1])))
    assert.equal(p2First, p1Last + 1) // 빠진 행 없이 이어진다
  })
})

describe("render: 다단·미주", () => {
  it("단 지역 좌표 다단은 vertpos 리셋마다 다음 단(오른쪽), 쪽 나누기는 새 쪽 — 미주는 본문 끝 뒤 구분선 아래에 그린다", async () => {
    const zip = await JSZip.loadAsync(await markdownToHwpx("첫단문단\n\n둘째단문단\n\n새쪽문단"))
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/colCount="1"/, 'colCount="2"').replace(/sameGap="\d+"/, 'sameGap="1000"')
    const ps = [...sec.matchAll(/<hp:p [^>]*>/g)].map(m => m[0])
    const en = `<hp:ctrl><hp:endNote number="1"><hp:subList><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl><hp:autoNum num="1" numType="ENDNOTE"><hp:autoNumFormat type="DIGIT" suffixChar=")"/></hp:autoNum></hp:ctrl><hp:t> 미주내용</hp:t></hp:run></hp:p></hp:subList></hp:endNote></hp:ctrl>`
    sec = sec.replace("첫단문단</hp:t>", `첫단문단</hp:t>${en}`)
    const iSecond = sec.indexOf("둘째단문단"), iThird = sec.indexOf("새쪽문단")
    const pOpen = (i: number) => sec.lastIndexOf("<hp:p ", i)
    const a = pOpen(iThird); sec = sec.slice(0, a) + sec.slice(a).replace(/^<hp:p /, '<hp:p pageBreak="1" ').replace(/pageBreak="0" /, "")
    const b = pOpen(iSecond); sec = sec.slice(0, b) + sec.slice(b).replace(/^<hp:p /, '<hp:p columnBreak="1" ').replace(/columnBreak="0" /, "")
    assert.ok(ps.length >= 3)
    zip.file(secName, sec)
    const r = await renderHwpxPages(new Uint8Array(await zip.generateAsync({ type: "nodebuffer" })), { reflow: true })
    const find = (needle: string) => { for (const [n, svg] of r.pageSvgs) { const m = [...svg.matchAll(/<text x="([\d.-]+)" y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].find(x => x[3].includes(needle)); if (m) return { page: n, x: parseFloat(m[1]), y: parseFloat(m[2]) } } return undefined }
    const a1 = find("첫단문단")!, a2 = find("둘째단문단")!, a3 = find("새쪽문단")!, note = find("미주내용")!
    assert.equal(a2.page, a1.page) // 단 나누기 — 같은 쪽 오른쪽 단
    assert.ok(a2.x > a1.x + 100, `둘째 단 x ${a2.x} 가 첫 단 x ${a1.x} 보다 오른쪽`)
    assert.equal(a3.page, a1.page + 1) // 쪽 나누기 — 남은 단을 건너 새 쪽
    assert.equal(note.page, a3.page) // 미주는 구역 본문 끝 뒤
    assert.ok(note.y > a3.y, "미주는 본문 끝 줄 아래")
  })
})

describe("render: 주석 머리 줄 기준선", () => {
  it("baseline 0 으로 저장된 줄(미주·각주 머리 줄)은 줄 높이의 85% 를 기준선으로 쓴다", () => {
    const p = createXmlParser().parseFromString(`<hp:p xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:run><hp:t>문1)</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="900" textheight="900" baseline="0" spacing="452" horzpos="0" horzsize="20000"/></hp:linesegarray></hp:p>`, "text/xml").documentElement as unknown as Element
    assert.equal(buildPara(p).segs[0].baseline, 765)
  })
})

describe("render: 미주 단 넘김", () => {
  it("미주 줄 vertpos 가 되돌아가면(단을 넘긴 문단을 제 첫 줄 기준으로 다시 센 것) 앞 줄 뒤에 잇고, 단 바닥에 닿으면 다음 단으로", async () => {
    const { endNoteLayout } = await import("../src/render/page-stories.js")
    const seg = (v: number) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="900" textheight="900" baseline="765" spacing="452" horzpos="0" horzsize="20000"/>`
    const xml = `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:secPr><hp:endNotePr><hp:noteLine type="NONE"/><hp:noteSpacing betweenNotes="0" belowLine="0" aboveLine="0"/></hp:endNotePr></hp:secPr><hp:ctrl><hp:colPr colCount="2" sameGap="1000"/></hp:ctrl><hp:ctrl><hp:endNote><hp:subList><hp:p><hp:run><hp:t>미주</hp:t></hp:run><hp:linesegarray>${seg(0)}${seg(1352)}${seg(0)}${seg(1352)}</hp:linesegarray></hp:p></hp:subList></hp:endNote></hp:ctrl><hp:t>본문</hp:t></hp:run><hp:linesegarray>${seg(0)}</hp:linesegarray></hp:p></hs:sec>`
    const root = createXmlParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
    const body = root.getElementsByTagName("hp:p")[0] as unknown as Element
    const out = endNoteLayout(root, new Map([[body, [0]]]), { ML: 0, MT: 0, BODY_W: 41000, BODY_H: 60000 })!
    const segs = Array.from(out.paras[0].p.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => [Number(s.getAttribute("vertpos")), Number(s.getAttribute("horzpos"))])
    // 본문 줄(900) 아래 0·1352 → 900·2252, 되돌아간 0 은 앞 줄 끝(+간격 452) 3604 에 잇는다
    assert.deepEqual(segs, [[900, 0], [2252, 0], [3604, 0], [4956, 0]])
    // 단 바닥에 닿으면 넘긴다 — 본문 높이 4000 이면 되돌아간 줄(3604 + 900 > 4000)부터 오른쪽 단(단 폭 20000 + 간격 1000) 맨 위
    const root2 = createXmlParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
    const body2 = root2.getElementsByTagName("hp:p")[0] as unknown as Element
    const out2 = endNoteLayout(root2, new Map([[body2, [0]]]), { ML: 0, MT: 0, BODY_W: 41000, BODY_H: 4000 })!
    const segs2 = Array.from(out2.paras[0].p.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => [Number(s.getAttribute("vertpos")), Number(s.getAttribute("horzpos"))])
    assert.deepEqual(segs2, [[900, 0], [2252, 0], [0, 21000], [1352, 21000]])
  })

  it("1단으로 시작해 2단으로 바뀐 구역의 미주는 구역 끝의 단(2단)으로 흐른다", async () => {
    const { endNoteLayout } = await import("../src/render/page-stories.js")
    const seg = (v: number) => `<hp:lineseg textpos="0" vertpos="${v}" vertsize="900" textheight="900" baseline="765" spacing="452" horzpos="0" horzsize="20000"/>`
    const xml = `<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:secPr><hp:endNotePr><hp:noteLine type="NONE"/><hp:noteSpacing betweenNotes="0" belowLine="0" aboveLine="0"/></hp:endNotePr></hp:secPr><hp:ctrl><hp:colPr colCount="1"/></hp:ctrl><hp:t>머리</hp:t></hp:run><hp:linesegarray>${seg(0)}</hp:linesegarray></hp:p><hp:p><hp:run><hp:ctrl><hp:colPr colCount="2" sameGap="1000"/></hp:ctrl><hp:ctrl><hp:endNote><hp:subList><hp:p><hp:run><hp:t>미주</hp:t></hp:run><hp:linesegarray>${seg(0)}${seg(1352)}</hp:linesegarray></hp:p></hp:subList></hp:endNote></hp:ctrl><hp:t>본문</hp:t></hp:run><hp:linesegarray>${seg(1352)}</hp:linesegarray></hp:p></hs:sec>`
    const root = createXmlParser().parseFromString(xml, "text/xml").documentElement as unknown as Element
    const ps = Array.from(root.getElementsByTagName("hp:p") as unknown as Element[]).filter(p => p.parentNode === root)
    const out = endNoteLayout(root, new Map([[ps[0], [0]], [ps[1], [0]]]), { ML: 0, MT: 0, BODY_W: 41000, BODY_H: 3500 })!
    const segs = Array.from(out.paras[0].p.getElementsByTagName("hp:lineseg") as unknown as Element[]).map(s => [Number(s.getAttribute("vertpos")), Number(s.getAttribute("horzpos"))])
    // 본문 끝 2252 아래 첫 줄 2252, 둘째 줄(3604 + 900 > 3500)은 같은 쪽 오른쪽 단 맨 위 — 첫 단 정의(1단)를 따르면 다음 쪽
    assert.deepEqual(segs, [[2252, 0], [0, 21000]])
    assert.equal(out.pageCount, 1)
  })
})

describe("render: reflow 표 밀어내기 (셀 콘텐츠 성장)", () => {
  it("긴 셀로 자란 표 뒤 문단이 표 바닥 아래에 온다 (리뷰#6 겹침)", async () => {
    // 셀 폭(약 22000HWPUNIT)을 여러 줄로 감는 긴 텍스트 — 선언 행높이 1500을 훌쩍 넘긴다
    const long = "서울특별시 도시기반시설 관리 실태 전수조사 결과에 따라 노후 시설물의 안전등급 재산정과 보수보강 우선순위 조정이 필요하며 연차별 투자계획을 수립하여 시행한다."
    const hwpx = await markdownToHwpx(`| 항목 | 내용 |\n| --- | --- |\n| 개요 | ${long} |\n\n표뒤문단입니다.`)
    const r = await renderHwpxToSvg(hwpx, { reflow: true })
    // 표 바닥 = 수평 border(<line y1==y2>) 최대 y, 뒤 문단 = 해당 <text>의 y
    const borderYs = [...r.svg.matchAll(/<line x1="[\d.-]+" y1="([\d.-]+)" x2="[\d.-]+" y2="([\d.-]+)"/g)]
      .filter(m => m[1] === m[2]).map(m => parseFloat(m[1]))
    const tableBottom = Math.max(...borderYs)
    const after = [...r.svg.matchAll(/<text [^>]*y="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
      .find(m => m[2].includes("표뒤문단"))
    assert.ok(after, "표 뒤 문단 텍스트가 렌더에 없음")
    assert.ok(parseFloat(after[1]) > tableBottom,
      `표 뒤 문단(y=${after[1]})이 표 바닥(y=${tableBottom}) 위에 겹침`)
    // 성장 자체가 일어났는지 — 선언 표높이(행 1500×2=3000u=30pt)보다 실제 표가 크다
    const tableTop = Math.min(...borderYs)
    assert.ok(tableBottom - tableTop > 30, "재현 전제(셀 성장) 자체가 깨짐 — 테스트 입력 확인 필요")
  })
})

describe("render: reflow 인라인 표 나란히 배치 (결재란 겹침)", () => {
  it("한 문단의 인라인 표 2개는 가로로 전진 배치 — 같은 x에 겹치지 않는다", async () => {
    // 공문 결재란 구조 재현: 호스트 문단(실텍스트 0) 안에 treatAsChar 표 2개 연속.
    // reflow가 합성한 lineseg textpos가 chars.length로 폴백하면 plan.start가 개체
    // index보다 커져 advanceTo 가로 전진에서 개체가 전부 빠지고 같은 x에 겹친다.
    const hwpx = await markdownToHwpx(
      "| 라벨표 |\n| --- |\n| 결재일자 |\n\n| 스탬프표 |\n| --- |\n| 주무관 |",
    )
    const zip = await JSZip.loadAsync(hwpx)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    // 생성기는 2행 이상 표를 부유(treatAsChar=0)로 앵커한다 — 이 테스트는 인라인 표의
    // 가로 전진을 검증하므로 결재란처럼 글자처럼 취급으로 되돌린다
    sec = sec.replace(/ textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None"/g, "")
      .replace(/treatAsChar="0"/g, 'treatAsChar="1"')
    // 두 번째 표를 첫 표의 호스트 문단으로 이동 (연속 인라인 개체)
    const starts = [...sec.matchAll(/<hp:tbl /g)].map(m => m.index!)
    assert.equal(starts.length, 2, "재현 전제: 표 2개 생성")
    const t2End = sec.indexOf("</hp:tbl>", starts[1]) + "</hp:tbl>".length
    const t2 = sec.slice(starts[1], t2End)
    const host2Start = sec.lastIndexOf("<hp:p ", starts[1])
    const host2End = sec.indexOf("</hp:p>", t2End) + "</hp:p>".length
    sec = sec.slice(0, host2Start) + sec.slice(host2End) // 둘째 호스트 문단 제거
    const t1End = sec.indexOf("</hp:tbl>") + "</hp:tbl>".length
    sec = sec.slice(0, t1End) + t2 + sec.slice(t1End) // 첫 표 바로 뒤에 삽입
    // 결재란처럼 좁은 표 — 본문 폭 표 둘은 한컴도 한 줄에 하나씩 놓는다(아래 테스트)
    sec = sec.replace(/(<hp:sz width=")\d+/g, "$115000").replace(/(<hp:cellSz width=")\d+/g, "$115000")
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })

    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    const textX = (t: string): number => {
      const m = [...r.svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)]
        .find(mm => mm[2].includes(t))
      assert.ok(m, `"${t}" 텍스트가 렌더에 없음`)
      return parseFloat(m![1])
    }
    const x1 = textX("결재일자")
    const x2 = textX("주무관")
    // 표1 폭만큼 전진해야 한다 (겹침이면 둘 다 문단 원점 부근 — 차이 수 pt 이하)
    assert.ok(x2 - x1 > 50, `둘째 인라인 표가 전진하지 않고 겹침: x1=${x1}, x2=${x2}`)
  })
})

describe("render: 가로(landscape) 문서 페이지 방향", () => {
  it('landscape="NARROWLY"면 페이지 W/H를 회전 — 무시하면 가로 문서 오른쪽이 잘린다', async () => {
    const hwpx = await markdownToHwpx("가로 문서 본문입니다.")
    const zip = await JSZip.loadAsync(hwpx)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    sec = sec.replace(/landscape="WIDELY"/, 'landscape="NARROWLY"')
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf), { reflow: true })
    // A4 세로 595.28×841.88 → 가로 841.88×…
    assert.equal(r.width, 841.88, `가로 문서 페이지 폭이 회전되지 않음: ${r.width}`)
  })
})

describe("render: 페이지 분할 — vertpos 동일(0) 문단 연속", () => {
  it("페이지 전체가 개체 하나인 문단(v0)이 연속되면 각각 새 페이지다 (의사일정 겹침)", async () => {
    // 한컴 저장본 패턴 합성: 최상위 문단 3개, 각각 lineseg vertpos=0 (페이지 로컬 리셋).
    // strict 역행(v < prevV)만 보면 0→0이 안 걸려 뒤 페이지들이 전부 겹친다.
    const base = await markdownToHwpx("페이지 분할 테스트")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    // 줄 높이는 쪽을 채우는 개체 몫(60000) — 작은 줄이 모두 0 이면 망가진 캐시로 보고 다시 조판한다(아래 '망가진 조판 캐시')
    const seg = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="60000"` +
      ` textheight="60000" baseline="51000" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`
    const para = (t: string) =>
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>${seg}</hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${para("첫페이지")}${para("둘째페이지")}${para("셋째페이지")}${m}`)
    zip.file(secName, sec)
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    const r = await renderHwpxToSvg(new Uint8Array(buf)) // 캐시 있음 — Tier-1 경로
    const pages = [...r.svg.matchAll(/data-page="(\d+)"/g)].map(m => +m[1])
    const nPages = pages.length ? Math.max(...pages) + 1 : 1
    assert.ok(nPages >= 3, `v0 연속 문단이 페이지로 갈라지지 않음 (pages=${nPages})`)
  })
})

describe("render: 실파일 e2e (corpus 존재 시)", { skip: !existsSync(CORPUS) }, () => {
  const read = (rel: string): Uint8Array => new Uint8Array(readFileSync(join(CORPUS, rel)))
  // base64 데이터 URI엔 "NaN"이 유효 부분열로 우연히 등장한다 — 좌표 검사에서 제외
  const geometry = (svg: string): string => svg.replace(/href="[^"]*"/g, "")

  it("결재문서(36427937) — 텍스트·이미지·표, NaN 없음", async () => {
    const file = "review/36427937_결재문서본문.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.ok(r.svg.startsWith("<svg"))
    assert.equal(r.width, 595.28)
    assert.ok(r.svg.includes("시행"))
    assert.ok(r.svg.includes("문화예술과"))
    assert.equal(r.stats.images, 2) // 로고 PNG 2
    assert.ok(r.stats.tables >= 3)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })

  it("사진대지(10772982) — uint32 음수 오프셋 사진 2장 모두, 셀 좌/우 배치", async () => {
    const file = "hwp5/10772982_4. 도시시설물 관리개선 사진.hwpx"
    if (!existsSync(join(CORPUS, file))) return
    const r = await renderHwpxToSvg(read(file))
    assert.equal(r.stats.images, 2)
    const xs = [...r.svg.matchAll(/<use href="#bin\d+" x="([\d.]+)"/g)].map(m => parseFloat(m[1]))
    assert.equal(xs.length, 2)
    // 두 사진은 서로 다른 열 셀 — x 간격이 셀 폭(238pt)급으로 벌어져야 함
    assert.ok(Math.abs(xs[0] - xs[1]) > 150, `사진 x 좌표가 같은 셀에 몰림: ${xs}`)
    assert.ok(!geometry(r.svg).includes("NaN"))
  })
})

describe("render: TAC 인라인 표 outMargin 좌/우 가로 배선 (rhwp #3396 동종)", () => {
  // 한글 문자 규칙: TAC 표의 가로 전진폭 = om좌 + 표폭 + om우, 괘선(표 자체)은 pen + om좌.
  // om 유무 두 렌더의 x 델타로 검증 — 폰트 폭 테이블에 무의존. om좌≠om우(비대칭)로 좌우 뒤바뀜도 잡는다.
  const OM_L = 850 // 8.5pt
  const OM_R = 283 // 2.83pt

  /** Tier-1(조판 캐시 명시) 문서: [앞표식][TAC 표(셀칸)][뒤표식] 한 줄. omL=null이면 outMargin 요소 자체 생략 */
  async function renderTacDoc(omL: number | null, omR: number, paraPrId = "0"): Promise<string> {
    const base = await markdownToHwpx("기준")
    const zip = await JSZip.loadAsync(base)
    const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))!
    let sec = await zip.file(secName)!.async("string")
    const seg = (horzsize: number) =>
      `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000"` +
      ` textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="${horzsize}" flags="393216"/></hp:linesegarray>`
    const tbl =
      `<hp:tbl id="777" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="1" noAdjust="0">` +
      `<hp:sz width="6000" widthRelTo="ABSOLUTE" height="2000" heightRelTo="ABSOLUTE" protect="0"/>` +
      `<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>` +
      (omL === null ? "" : `<hp:outMargin left="${omL}" right="${omR}" top="0" bottom="0"/>`) +
      `<hp:inMargin left="0" right="0" top="0" bottom="0"/>` +
      `<hp:tr><hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">` +
      `<hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>셀칸</hp:t></hp:run>${seg(6000)}</hp:p>` +
      `</hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>` +
      `<hp:cellSz width="6000" height="2000"/><hp:cellMargin left="0" right="0" top="0" bottom="0"/>` +
      `</hp:tc></hp:tr></hp:tbl>`
    const host =
      `<hp:p paraPrIDRef="${paraPrId}" styleIDRef="0"><hp:run charPrIDRef="0">` +
      `<hp:t>앞표식</hp:t>${tbl}<hp:t>뒤표식</hp:t></hp:run>${seg(42520)}</hp:p>`
    sec = sec.replace(/<\/hs:sec>|<\/hp:sec>/, m => `${host}${m}`)
    zip.file(secName, sec)
    if (paraPrId !== "0") {
      // 우정렬 paraPr 주입 — parseRenderStyles는 트리 전체를 걸으므로 위치 무관
      const headName = Object.keys(zip.files).find(n => /header\.xml$/.test(n))!
      let head = await zip.file(headName)!.async("string")
      head = head.replace(
        /<\/hh:head>/,
        `<hh:paraPr id="${paraPrId}"><hh:align horizontal="RIGHT"/></hh:paraPr></hh:head>`,
      )
      zip.file(headName, head)
    }
    const buf = await zip.generateAsync({ type: "nodebuffer" })
    return (await renderHwpxToSvg(new Uint8Array(buf))).svg
  }

  const textX = (svg: string, marker: string): number => {
    const m = [...svg.matchAll(/<text x="([\d.-]+)"[^>]*>([^<]*)<\/text>/g)].find(mm => mm[2].includes(marker))
    assert.ok(m, `"${marker}" 텍스트가 렌더에 없음`)
    return parseFloat(m![1])
  }

  it("JUSTIFY host — 괘선은 pen+om좌, 후속 텍스트는 om좌+om우만큼 추가 전진", async () => {
    const svg0 = await renderTacDoc(0, 0)
    const svg1 = await renderTacDoc(OM_L, OM_R)
    // 표 앞 텍스트는 불변
    assert.equal(textX(svg1, "앞표식"), textX(svg0, "앞표식"))
    // (b) 표 자체(셀 텍스트 = 표 x + cellMargin 0) = pen + om좌
    const dCell = textX(svg1, "셀칸") - textX(svg0, "셀칸")
    assert.ok(Math.abs(dCell - OM_L / 100) < 0.02, `표 x 시프트 ${dCell}pt (기대 ${OM_L / 100}pt = om좌)`)
    // (a) 후속 텍스트 전진폭 = om좌 + 표폭 + om우 → om합만큼 추가로 밀린다
    const dAfter = textX(svg1, "뒤표식") - textX(svg0, "뒤표식")
    assert.ok(Math.abs(dAfter - (OM_L + OM_R) / 100) < 0.02, `후속 텍스트 시프트 ${dAfter}pt (기대 ${(OM_L + OM_R) / 100}pt = om합)`)
  })

  it("RIGHT host — 전체 폭에 om 포함: 시작이 om합만큼 왼쪽, 표 우단은 om우만큼 안쪽, 우단 텍스트 불변", async () => {
    const svg0 = await renderTacDoc(0, 0, "77")
    const svg1 = await renderTacDoc(OM_L, OM_R, "77")
    // (c) 정렬용 전체 폭에 om 포함 → 줄 시작이 om합만큼 왼쪽으로
    const dFront = textX(svg0, "앞표식") - textX(svg1, "앞표식")
    assert.ok(Math.abs(dFront - (OM_L + OM_R) / 100) < 0.02, `우정렬 시작 시프트 ${dFront}pt (기대 ${(OM_L + OM_R) / 100}pt)`)
    // 표는 om우만큼 안쪽 (rhwp 오라클: 우정렬 표 우측 괘선 = 우여백 − om우)
    const dCell = textX(svg0, "셀칸") - textX(svg1, "셀칸")
    assert.ok(Math.abs(dCell - OM_R / 100) < 0.02, `우정렬 표 시프트 ${dCell}pt (기대 ${OM_R / 100}pt = om우)`)
    // 줄 끝(우단) 텍스트는 그대로 우여백에 붙는다
    const dAfter = textX(svg1, "뒤표식") - textX(svg0, "뒤표식")
    assert.ok(Math.abs(dAfter) < 0.02, `우단 텍스트가 움직임: ${dAfter}pt`)
  })

  it("om=0 문서는 outMargin 요소 유무와 무관하게 SVG 바이트 동일 (무회귀)", async () => {
    // 모든 가산이 +0이라 om 미배선 시절과 같은 좌표 — 요소가 아예 없는 문서(num(null)=0
    // 폴백)와도 바이트 동일해야 한다
    assert.equal(await renderTacDoc(0, 0), await renderTacDoc(null, 0))
  })
})

describe("render: XML 1.0 비허용 제어문자 방어 (rhwp #3382 동종)", () => {
  it("C0 제어문자를 제거해 산출 SVG가 well-formed XML을 유지한다", () => {
    // 제어문자를 그대로 흘리면 "PCDATA invalid Char value 3"으로 뷰어가 렌더를 중단한다.
    assert.equal(escapeXml("a\x03b"), "ab")
    for (const c of ["\x00", "\x08", "\x0B", "\x0C", "\x0E", "\x1F"]) {
      assert.equal(escapeXml(`x${c}y`), "xy", `제어문자 U+${c.charCodeAt(0).toString(16)}`)
    }
  })
  it("탭·개행·복귀는 XML 1.0 허용 문자라 유지한다", () => {
    assert.equal(escapeXml("a\tb\nc\rd"), "a\tb\nc\rd")
  })
  it("기존 마크업 이스케이프·한글·이모지는 무회귀", () => {
    assert.equal(escapeXml('<a & b>"'), "&lt;a &amp; b&gt;&quot;")
    assert.equal(escapeXml("한글 A😀"), "한글 A😀")
  })
  it("제어문자가 섞인 텍스트도 산출 SVG가 XML 파서를 통과한다", () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text>${escapeXml("사업\x03개요")}</text></svg>`
    const doc = createXmlParser().parseFromString(svg, "text/xml")
    assert.equal(doc.getElementsByTagName("text")[0]?.textContent, "사업개요")
  })
})
