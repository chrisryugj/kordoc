/**
 * HWPX v3.0 파서 업그레이드 — 정보손실 0% 기능 테스트
 *
 * 합성 HWPX 픽스처(JSZip)로 진단에서 실증된 손실 케이스를 재현:
 * ctrl 선별 순회(머리말/꼬리말/각주), 하이퍼링크 URL, 표 캡션,
 * 자동번호/글머리표/개요, 중첩표 IRCell.blocks, 글상자+이미지 병행,
 * 변경추적/숨은텍스트 필터링, 무음 손실 경고.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { parseHwpxDocument } from "../src/hwpx/parser.js"

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function sec(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${body}</hs:sec>`
}

function para(text: string, attrs = ""): string {
  const prAttr = attrs.includes("paraPrIDRef") ? "" : `paraPrIDRef="0"`
  return `<hp:p id="0" ${prAttr} ${attrs}><hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run></hp:p>`
}

/** 셀 생성 — subList > p 구조 (실파일과 동일) */
function tc(inner: string, col: number, row: number, opts: { colSpan?: number; rowSpan?: number; header?: string } = {}): string {
  return `<hp:tc name="" header="${opts.header ?? "0"}" borderFillIDRef="0"><hp:subList>${inner}</hp:subList>` +
    `<hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="${opts.colSpan ?? 1}" rowSpan="${opts.rowSpan ?? 1}"/></hp:tc>`
}

async function makeHwpx(sectionXml: string, opts: { headerXml?: string; binData?: Record<string, Uint8Array> } = {}): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  if (opts.headerXml) zip.file("Contents/header.xml", opts.headerXml)
  zip.file("Contents/section0.xml", sectionXml)
  for (const [name, data] of Object.entries(opts.binData ?? {})) zip.file(name, data)
  return await zip.generateAsync({ type: "arraybuffer" })
}

const PNG_STUB = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** 자동번호/글머리표/개요 정의가 담긴 header.xml (실파일 구조 — 광진구/축산정책과 코퍼스 기반) */
const HEADER_WITH_NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head">
 <hh:refList>
  <hh:numberings itemCnt="1">
   <hh:numbering id="1" start="0">
    <hh:paraHead start="1" level="1" numFormat="DIGIT">^1.</hh:paraHead>
    <hh:paraHead start="1" level="2" numFormat="HANGUL_SYLLABLE">^2.</hh:paraHead>
    <hh:paraHead start="1" level="3" numFormat="DIGIT">^3)</hh:paraHead>
    <hh:paraHead start="1" level="4" numFormat="HANGUL_SYLLABLE">^4)</hh:paraHead>
    <hh:paraHead start="1" level="5" numFormat="DIGIT">(^5)</hh:paraHead>
    <hh:paraHead start="1" level="7" numFormat="CIRCLED_DIGIT">^7</hh:paraHead>
   </hh:numbering>
  </hh:numberings>
  <hh:bullets itemCnt="1">
   <hh:bullet id="1" char="-" useImage="0"/>
  </hh:bullets>
 </hh:refList>
 <hh:paraProperties>
  <hh:paraPr id="10"><hh:heading type="NUMBER" idRef="1" level="0"/></hh:paraPr>
  <hh:paraPr id="11"><hh:heading type="NUMBER" idRef="1" level="1"/></hh:paraPr>
  <hh:paraPr id="12"><hh:heading type="NUMBER" idRef="1" level="6"/></hh:paraPr>
  <hh:paraPr id="13"><hh:heading type="BULLET" idRef="1" level="0"/></hh:paraPr>
  <hh:paraPr id="20"><hh:heading type="OUTLINE" idRef="0" level="0"/></hh:paraPr>
  <hh:paraPr id="21"><hh:heading type="OUTLINE" idRef="0" level="1"/></hh:paraPr>
 </hh:paraProperties>
</hh:head>`

describe("hwpx v3 — <hp:ctrl> 선별 순회", () => {
  it("머리말/꼬리말이 본문 앞/뒤 문단으로 보존된다 (문서당 1회 dedupe)", async () => {
    const header = `<hp:ctrl><hp:header id="1" applyPageType="BOTH"><hp:subList>${para("머리말 텍스트")}</hp:subList></hp:header></hp:ctrl>`
    const footer = `<hp:ctrl><hp:footer id="2" applyPageType="BOTH"><hp:subList>${para("꼬리말 텍스트")}</hp:subList></hp:footer></hp:ctrl>`
    const body = `<hp:p id="0"><hp:run>${header}${header}${footer}<hp:t>본문 문단</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.blocks[0].text, "머리말 텍스트", "머리말이 본문 앞에 배치")
    assert.equal(result.blocks[result.blocks.length - 1].text, "꼬리말 텍스트", "꼬리말이 본문 뒤에 배치")
    const headerCount = result.blocks.filter(b => b.text === "머리말 텍스트").length
    assert.equal(headerCount, 1, "같은 머리말은 문서당 1회만")
    assert.ok(result.markdown.includes("본문 문단"))
  })

  it("ctrl 내부 각주(footNote)가 해당 문단의 footnoteText로 인라인 보존된다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:t>본문입니다</hp:t><hp:ctrl><hp:footNote number="1"><hp:subList>${para("각주 내용")}</hp:subList></hp:footNote></hp:ctrl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.blocks[0].footnoteText, "각주 내용")
    assert.ok(result.markdown.includes("(주: 각주 내용)"), `각주 인라인 표시: ${result.markdown}`)
  })

  it("책갈피(bookmark) 등 콘텐츠 없는 ctrl 자식은 경고 없이 스킵된다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:ctrl><hp:bookmark name="mark1"/></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.warnings, undefined)
    assert.ok(result.markdown.includes("본문"))
  })

  it("텍스트를 가진 미지원 ctrl 자식은 UNSUPPORTED_ELEMENT 경고를 남긴다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:ctrl><hp:weirdUnknown><hp:t>사라질 텍스트</hp:t></hp:weirdUnknown></hp:ctrl><hp:t>본문</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(result.warnings?.some(w => w.code === "UNSUPPORTED_ELEMENT" && w.message.includes("weirdUnknown")),
      `경고 목록: ${JSON.stringify(result.warnings)}`)
  })
})

describe("hwpx v3 — 하이퍼링크 URL (fieldBegin HYPERLINK)", () => {
  it("stringParam name=Path의 URL이 block.href로 연결된다 (실파일 구조)", async () => {
    const body = `<hp:p id="0"><hp:run><hp:t>신청방법: </hp:t>` +
      `<hp:ctrl><hp:fieldBegin id="1" type="HYPERLINK" name=""><hp:parameters cnt="2">` +
      `<hp:integerParam name="Prop">0</hp:integerParam>` +
      `<hp:stringParam name="Path">https://www.nie.re.kr/view.do?menuNo=600010&amp;edcId=E1</hp:stringParam>` +
      `</hp:parameters></hp:fieldBegin></hp:ctrl></hp:run>` +
      `<hp:run><hp:t>예약 누리집</hp:t><hp:ctrl><hp:fieldEnd beginIDRef="1"/></hp:ctrl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.blocks[0].href, "https://www.nie.re.kr/view.do?menuNo=600010&edcId=E1")
    assert.ok(result.markdown.includes("(https://www.nie.re.kr/view.do?menuNo=600010&edcId=E1)"),
      `마크다운 링크: ${result.markdown}`)
  })

  it("한컴 중복 스킴(http://https://)을 정리한다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:ctrl><hp:fieldBegin id="1" type="HYPERLINK"><hp:parameters cnt="1">` +
      `<hp:stringParam name="Path">http://https://www.nie.re.kr/a</hp:stringParam>` +
      `</hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>링크</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.blocks[0].href, "https://www.nie.re.kr/a")
  })

  it("CLICK_HERE 등 비하이퍼링크 필드의 안내문은 누출되지 않는다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:ctrl><hp:fieldBegin id="1" type="CLICK_HERE"><hp:parameters cnt="1">` +
      `<hp:stringParam name="Direction">본문을 입력하십시오</hp:stringParam>` +
      `</hp:parameters></hp:fieldBegin></hp:ctrl><hp:t>실제 본문</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!result.markdown.includes("본문을 입력하십시오"))
    assert.equal(result.blocks[0].href, undefined)
  })
})

describe("hwpx v3 — 표 캡션", () => {
  const capRows =
    `<hp:tr>${tc(para("머리1"), 0, 0)}${tc(para("머리2"), 1, 0)}</hp:tr>` +
    `<hp:tr>${tc(para("값1"), 0, 1)}${tc(para("값2"), 1, 1)}</hp:tr>`
  const wrapTbl = (caption: string, capBottom = false) =>
    `<hp:p id="0"><hp:run><hp:tbl rowCnt="2" colCnt="2">` +
    (capBottom ? capRows + caption : caption + capRows) +
    `</hp:tbl></hp:run></hp:p>`

  it("hp:caption > subList > p 텍스트가 IRTable.caption으로 보존된다", async () => {
    const caption = `<hp:caption side="TOP"><hp:subList>${para("표 1. 테스트 캡션")}</hp:subList></hp:caption>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption))))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "표 1. 테스트 캡션")
    assert.ok(result.markdown.includes("표 1. 테스트 캡션"), `캡션 출력: ${result.markdown}`)
  })

  it("side=BOTTOM 캡션(표 뒤 위치)도 IRTable.caption으로 보존된다 (#46)", async () => {
    const caption = `<hp:caption side="BOTTOM" fullSz="0" width="8504" gap="850" lastWidth="45315">` +
      `<hp:subList>${para("주1) 표 아래 캡션 텍스트")}</hp:subList></hp:caption>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption, true))))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "주1) 표 아래 캡션 텍스트")
    assert.ok(result.markdown.includes("주1) 표 아래 캡션 텍스트"), `캡션 출력: ${result.markdown}`)
  })

  it("캡션 내 다중 <hp:p>의 순서와 줄바꿈이 보존된다", async () => {
    const caption = `<hp:caption side="BOTTOM"><hp:subList>` +
      `${para("주1) 첫째 줄")}${para("주2) 둘째 줄")}` +
      `</hp:subList></hp:caption>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption, true))))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "주1) 첫째 줄\n주2) 둘째 줄", "다중 문단은 순서대로 줄바꿈 결합")
  })

  it("캡션 내 스타일이 다른 다중 <hp:run>의 텍스트 순서가 보존된다", async () => {
    const caption = `<hp:caption side="TOP"><hp:subList>` +
      `<hp:p id="0" paraPrIDRef="0">` +
      `<hp:run charPrIDRef="0"><hp:t>표 1. </hp:t></hp:run>` +
      `<hp:run charPrIDRef="1"><hp:t>강조 제목</hp:t></hp:run>` +
      `</hp:p></hp:subList></hp:caption>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption))))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "표 1. 강조 제목", "다중 run 텍스트는 순서대로 연결")
  })

  it("p > run > ctrl 안에 감싼 캡션도 활성 표에 보존된다", async () => {
    const caption = `<hp:p id="9"><hp:run><hp:ctrl><hp:caption side="BOTTOM"><hp:subList>` +
      `${para("ctrl 래핑 캡션")}</hp:subList></hp:caption></hp:ctrl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption, true))))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "ctrl 래핑 캡션")
  })

  it("활성 표 컨텍스트 밖의 캡션은 무음 드롭 없이 문단으로 보존된다 (#46 방어)", async () => {
    // 캡션이 <tbl> 자식이 아닌 섹션 직계로 존재하는 비정상 파일 — 텍스트가 통째 사라지면 안 됨
    const body = `<hp:p id="0"><hp:run>${para("본문")}</hp:run></hp:p>` +
      `<hp:caption side="BOTTOM"><hp:subList>${para("고아 캡션 텍스트")}</hp:subList></hp:caption>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(result.markdown.includes("고아 캡션 텍스트"), `고아 캡션 보존: ${result.markdown}`)
  })

  it("셀 문단 안 개체 캡션은 바깥 표 caption으로 오귀속되지 않는다", async () => {
    const objCaption = `<hp:p id="5" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:ctrl>` +
      `<hp:caption side="BOTTOM"><hp:subList>${para("그림 1. 개체 캡션")}</hp:subList></hp:caption>` +
      `</hp:ctrl></hp:run></hp:p>`
    const rows = `<hp:tr>${tc(para("셀 본문") + objCaption, 0, 0)}${tc(para("옆 셀"), 1, 0)}</hp:tr>`
    const body = `<hp:p id="0"><hp:run><hp:tbl rowCnt="1" colCnt="2">${rows}</hp:tbl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, undefined, "개체 캡션이 표 caption으로 오귀속되면 안 됨")
    assert.ok(result.markdown.includes("그림 1. 개체 캡션"), `개체 캡션 텍스트는 셀에 보존: ${result.markdown}`)
  })

  it("ctrl 래핑 캡션은 UNSUPPORTED_ELEMENT 거짓 경고를 남기지 않는다", async () => {
    const caption = `<hp:p id="9"><hp:run><hp:ctrl><hp:caption side="BOTTOM"><hp:subList>` +
      `${para("ctrl 래핑 캡션")}</hp:subList></hp:caption></hp:ctrl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(wrapTbl(caption, true))))

    const falseWarnings = (result.warnings ?? []).filter(w => w.code === "UNSUPPORTED_ELEMENT" && w.message.includes("caption"))
    assert.deepEqual(falseWarnings, [], "캡션은 보존되므로 텍스트 손실 경고 금지")
    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.caption, "ctrl 래핑 캡션")
  })
})

describe("hwpx v3 — 글머리표/자동번호 (numbering/bullet)", () => {
  it("NUMBER 7수준 카운터 — 증가/하위 리셋/포맷(DIGIT·가나다·①)이 한컴과 일치한다", async () => {
    const body = [
      para("첫째 항목", `paraPrIDRef="10"`),
      para("하위 항목", `paraPrIDRef="11"`),
      para("하위 항목 둘", `paraPrIDRef="11"`),
      para("둘째 항목", `paraPrIDRef="10"`),
      para("리셋된 하위", `paraPrIDRef="11"`),
      para("원문자 항목", `paraPrIDRef="12"`),
    ].join("")
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: HEADER_WITH_NUMBERING }))

    const texts = result.blocks.map(b => b.text)
    assert.equal(texts[0], "1. 첫째 항목")
    assert.equal(texts[1], "가. 하위 항목")
    assert.equal(texts[2], "나. 하위 항목 둘")
    assert.equal(texts[3], "2. 둘째 항목", "상위 레벨 카운터 증가")
    assert.equal(texts[4], "가. 리셋된 하위", "상위 레벨 증가 시 하위 카운터 리셋")
    assert.equal(texts[5], "① 원문자 항목", "CIRCLED_DIGIT 포맷")
  })

  it("BULLET 문단에 글머리 문자가 접두된다", async () => {
    const body = para("글머리 항목", `paraPrIDRef="13"`)
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: HEADER_WITH_NUMBERING }))

    assert.equal(result.blocks[0].text, "- 글머리 항목")
  })

  it("표 셀 안 문단에도 자동번호가 적용된다", async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="1"><hp:tr>${tc(para("셀 항목", `paraPrIDRef="10"`), 0, 0)}</hp:tr></hp:tbl>`
    const body = `<hp:p id="0"><hp:run>${tbl}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: HEADER_WITH_NUMBERING }))

    const tableBlock = result.blocks.find(b => b.type === "table")
    assert.equal(tableBlock?.table?.cells[0][0].text, "1. 셀 항목")
  })
})

describe("hwpx v3 — outline 헤딩", () => {
  it("paraPr heading type=OUTLINE level=N이 헤딩 레벨 + 개요번호로 변환된다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:secPr id="" outlineShapeIDRef="1"/></hp:run></hp:p>` +
      para("개요 제목", `paraPrIDRef="20"`) +
      para("개요 하위", `paraPrIDRef="21"`) +
      para("일반 본문")
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { headerXml: HEADER_WITH_NUMBERING }))

    const h1 = result.blocks.find(b => b.type === "heading" && b.level === 1)
    const h2 = result.blocks.find(b => b.type === "heading" && b.level === 2)
    assert.equal(h1?.text, "1. 개요 제목", "outline level 0 → 헤딩 1 + 개요번호")
    assert.equal(h2?.text, "가. 개요 하위", "outline level 1 → 헤딩 2 + 개요번호")
    assert.ok(result.outline?.some(o => o.text === "1. 개요 제목"), "outline 트리에 포함")
    const plain = result.blocks.find(b => b.text === "일반 본문")
    assert.equal(plain?.type, "paragraph", "outline 없는 문단은 본문 유지")
  })
})

describe("hwpx v3 — 중첩표 IRCell.blocks", () => {
  const nestedTbl = `<hp:tbl rowCnt="2" colCnt="2">` +
    `<hp:tr>${tc(para("내부A"), 0, 0)}${tc(para("내부B"), 1, 0)}</hp:tr>` +
    `<hp:tr>${tc(para("내부C"), 0, 1)}${tc(para("내부D"), 1, 1)}</hp:tr>` +
    `</hp:tbl>`
  const cellContent = `${para("셀 문단")}<hp:p id="9"><hp:run>${nestedTbl}</hp:run></hp:p>`
  const outerTbl = `<hp:tbl rowCnt="1" colCnt="2"><hp:tr>${tc(cellContent, 0, 0)}${tc(para("옆 셀"), 1, 0)}</hp:tr></hp:tbl>`
  const body = `<hp:p id="0"><hp:run>${outerTbl}</hp:run></hp:p>${para("표 다음 문단")}`

  it("중첩표가 호이스팅 없이 부모 IRCell.blocks에 보존된다", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    const tables = result.blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1, "최상위 표는 1개 (호이스팅 제거)")
    const cell = tables[0].table!.cells[0][0]
    assert.ok(cell.blocks?.some(b => b.type === "table"), "중첩표가 IRCell.blocks에 존재")
    const inner = cell.blocks!.find(b => b.type === "table")!.table!
    assert.equal(inner.rows, 2)
    assert.equal(inner.cells[0][0].text, "내부A")
    assert.ok(cell.blocks![0].type === "paragraph" && cell.blocks![0].text === "셀 문단", "셀 내 문단 순서 보존")
  })

  it("마크다운에서 중첩표가 셀 내부 HTML <table>로 재귀 렌더링된다 (마커/평탄화 제거)", async () => {
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!result.markdown.includes("[중첩 테이블"), "구 마커 형식 제거")
    const outerIdx = result.markdown.indexOf("<table>")
    const innerIdx = result.markdown.indexOf("<table>", outerIdx + 1)
    assert.ok(outerIdx >= 0 && innerIdx > outerIdx, "표 안에 표 HTML 중첩")
    assert.ok(result.markdown.includes("내부A"))
    assert.ok(result.markdown.indexOf("내부A") < result.markdown.indexOf("표 다음 문단"), "문서 순서 유지")
  })

  it("tc header=1 속성이 IRCell.isHeader로 보존된다", async () => {
    const tbl = `<hp:tbl rowCnt="1" colCnt="2"><hp:tr>${tc(para("제목셀"), 0, 0, { header: "1" })}${tc(para("값"), 1, 0)}</hp:tr></hp:tbl>`
    const result = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0"><hp:run>${tbl}</hp:run></hp:p>`)))

    const cells = result.blocks.find(b => b.type === "table")!.table!.cells
    assert.equal(cells[0][0].isHeader, true)
    assert.equal(cells[0][1].isHeader, undefined)
  })
})

describe("hwpx v3 — 글상자+이미지 병행, 셀 안 이미지", () => {
  it("drawText 있는 도형도 이미지를 추출한다 (상호배타 수정)", async () => {
    const pic = `<hp:pic id="1"><hp:img binaryItemIDRef="image1"/>` +
      `<hp:drawText><hp:subList>${para("상자 안 텍스트")}</hp:subList></hp:drawText></hp:pic>`
    const body = `<hp:p id="0"><hp:run>${pic}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { binData: { "BinData/image1.png": PNG_STUB } }))

    assert.equal(result.images?.length, 1, "이미지 추출")
    assert.ok(result.blocks.some(b => b.type === "image"), "이미지 블록 존재")
    assert.ok(result.markdown.includes("상자 안 텍스트"), "글상자 텍스트도 보존")
  })

  it("셀 안 이미지가 호이스팅 없이 IRCell.blocks로 위치 보존된다", async () => {
    const pic = `<hp:pic id="1"><hp:img binaryItemIDRef="image1"/></hp:pic>`
    const cellContent = `<hp:p id="0"><hp:run>${pic}</hp:run></hp:p>`
    const tbl = `<hp:tbl rowCnt="1" colCnt="2"><hp:tr>${tc(cellContent, 0, 0)}${tc(para("옆 셀"), 1, 0)}</hp:tr></hp:tbl>`
    const result = await parseHwpxDocument(await makeHwpx(sec(`<hp:p id="0"><hp:run>${tbl}</hp:run></hp:p>`),
      { binData: { "BinData/image1.png": PNG_STUB } }))

    assert.ok(!result.blocks.some(b => b.type === "image"), "최상위 호이스팅 없음")
    const cell = result.blocks.find(b => b.type === "table")!.table!.cells[0][0]
    assert.equal(cell.blocks?.[0].type, "image")
    assert.equal(cell.blocks?.[0].text, "image_001.png")
    assert.equal(result.images?.length, 1, "셀 내부 이미지도 바이너리 추출")
    assert.ok(result.markdown.includes("![image](image_001.png)"), `셀 이미지 마크다운 표시: ${result.markdown}`)
  })

  it("사용자 그림설명(shapeComment)은 보존, 자동생성 대체텍스트는 제외", async () => {
    const userPic = `<hp:pic id="1"><hp:img binaryItemIDRef="image1"/><hp:shapeComment>구청장 직인</hp:shapeComment></hp:pic>`
    const autoPic = `<hp:pic id="2"><hp:img binaryItemIDRef="image1"/><hp:shapeComment>그림입니다.
원본 그림의 이름: x.jpg</hp:shapeComment></hp:pic>`
    const body = `<hp:p id="0"><hp:run>${userPic}${autoPic}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { binData: { "BinData/image1.png": PNG_STUB } }))

    const imgs = result.blocks.filter(b => b.type === "image")
    assert.equal(imgs[0]?.footnoteText, "구청장 직인", "사용자 입력 alt 보존")
    assert.equal(imgs[1]?.footnoteText, undefined, "자동생성 대체텍스트 제외")
    assert.ok(!result.markdown.includes("원본 그림의 이름"))
  })

  it("도형 캡션(그림 캡션)이 문단으로 보존된다", async () => {
    const pic = `<hp:pic id="1"><hp:img binaryItemIDRef="image1"/>` +
      `<hp:caption side="BOTTOM"><hp:subList>${para("고온 스트레스 저감용 첨가제")}</hp:subList></hp:caption></hp:pic>`
    const body = `<hp:p id="0"><hp:run>${pic}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { binData: { "BinData/image1.png": PNG_STUB } }))

    assert.ok(result.markdown.includes("고온 스트레스 저감용 첨가제"), `그림 캡션 보존: ${result.markdown}`)
  })

  it("같은 ref를 참조하는 다수 image 블록 — 1회만 해제·데이터 공유 (대량 참조 메모리 폭발 방지)", async () => {
    const pics = [1, 2, 3].map(i => `<hp:pic id="${i}"><hp:img binaryItemIDRef="image1"/></hp:pic>`).join("")
    const body = `<hp:p id="0"><hp:run>${pics}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body), { binData: { "BinData/image1.png": PNG_STUB } }))

    assert.equal(result.images?.length, 1, "같은 ref는 1건만 추출")
    const imgs = result.blocks.filter(b => b.type === "image")
    assert.equal(imgs.length, 3, "블록은 참조 수만큼 유지")
    for (const b of imgs) assert.equal(b.text, "image_001.png", "모든 블록이 같은 파일명 참조")
    assert.equal(imgs[0].imageData!.data, imgs[1].imageData!.data, "데이터 버퍼 공유 (복사 1벌)")
    assert.equal(result.images![0].data, imgs[2].imageData!.data)
  })

  it("없는 ref 다수 참조 — 실패도 캐시해 SKIPPED_IMAGE 경고 1회", async () => {
    const pics = [1, 2].map(i => `<hp:pic id="${i}"><hp:img binaryItemIDRef="missing"/></hp:pic>`).join("")
    const body = `<hp:p id="0"><hp:run>${pics}</hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.equal(result.warnings?.filter(w => w.code === "SKIPPED_IMAGE").length, 1, "경고는 ref당 1회")
    assert.equal(result.blocks.filter(b => b.type === "paragraph" && b.text === "[이미지: missing]").length, 2,
      "실패 블록은 각각 paragraph로 전환")
  })
})

describe("hwpx v3 — 변경추적/메모/숨은텍스트", () => {
  it("변경추적 삭제 구간(deleteBegin~End)의 텍스트는 출력에서 제외된다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:t>남는 텍스트 </hp:t>` +
      `<hp:ctrl><hp:deleteBegin Id="1" TcId="1"/></hp:ctrl><hp:t>삭제된 텍스트</hp:t>` +
      `<hp:ctrl><hp:deleteEnd Id="1"/></hp:ctrl><hp:t> 이후 텍스트</hp:t></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!result.markdown.includes("삭제된 텍스트"), `삭제분 제외: ${result.markdown}`)
    assert.ok(result.markdown.includes("남는 텍스트"))
    assert.ok(result.markdown.includes("이후 텍스트"))
    assert.ok(result.warnings?.some(w => w.code === "HIDDEN_TEXT_FILTERED"), "필터링 경고")
  })

  it("hiddenComment 텍스트는 본문 혼입이 차단되고 HIDDEN_TEXT_FILTERED 경고가 남는다", async () => {
    const body = `<hp:p id="0"><hp:run><hp:t>본문</hp:t>` +
      `<hp:ctrl><hp:hiddenComment><hp:subList>${para("숨은 설명 텍스트")}</hp:subList></hp:hiddenComment></hp:ctrl></hp:run></hp:p>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!result.markdown.includes("숨은 설명 텍스트"))
    assert.ok(result.warnings?.some(w => w.code === "HIDDEN_TEXT_FILTERED"))
  })

  it("memogroup 텍스트는 본문 혼입이 차단된다", async () => {
    const body = para("본문 문단") +
      `<hp:memogroup><hp:memo id="1"><hp:subList>${para("메모 텍스트")}</hp:subList></hp:memo></hp:memogroup>`
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!result.markdown.includes("메모 텍스트"))
    assert.ok(result.warnings?.some(w => w.code === "HIDDEN_TEXT_FILTERED"))
  })
})

describe("hwpx v3 — 한컴 PUA 문자", () => {
  it("매핑된 BMP PUA(U+F0A0 등)가 표준 유니코드로 치환되어 출력된다", async () => {
    const body = para("\uF0A0 첫 항목 \uF0E8 화살표")
    const result = await parseHwpxDocument(await makeHwpx(sec(body)))

    assert.ok(!/[\uF020-\uF0FF]/.test(result.markdown), `PUA 잔존 없음: ${JSON.stringify(result.markdown)}`)
    assert.ok(result.markdown.includes("\u00B7"), "U+F0A0 매핑 (한컴 PDF 정답지 정합)")
    assert.ok(result.markdown.includes("\u2794"), "U+F0E8 매핑")
  })
})
