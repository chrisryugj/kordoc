/**
 * 결함 회귀 잠금 (담당 E) — form(P1~P3) + render/diff/image.
 * 각 describe 앞 번호는 수정 지시서의 결함 번호.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { fillFormFields } from "../src/form/filler.js"
import { fillHwpx } from "../src/form/filler-hwpx.js"
import { extractFormFields } from "../src/form/recognize.js"
import {
  scanInlineSegments, findMatchingKey, normalizeValues, ValueCursor,
} from "../src/form/match.js"
import { escapeXmlText } from "../src/roundtrip/source-map.js"
import { diffBlocks } from "../src/diff/compare.js"
import { textDiff, similarity } from "../src/diff/text-diff.js"
import { inlineImagesIntoMarkdown } from "../src/image/transcode.js"
import { renderHwpxToSvg } from "../src/render/index.js"
import { measureTableHeight } from "../src/render/svg-render.js"
import { createXmlParser } from "../src/hwpx/parser-shared.js"
import type { IRBlock, IRTable, IRCell } from "../src/types.js"

// ─── 공용 픽스처 ─────────────────────────────────────

function makeTable(rows: string[][]): IRTable {
  return {
    rows: rows.length,
    cols: rows[0]?.length || 0,
    cells: rows.map(row => row.map(text => ({ text, colSpan: 1, rowSpan: 1 }))),
    hasHeader: rows.length > 1,
  }
}
const tableBlock = (t: IRTable): IRBlock => ({ type: "table", table: t })
const para = (text: string): IRBlock => ({ type: "paragraph", text })

const SEC_NS = `xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"`

function tcXml(row: number, col: number, inner: string): string {
  return `<hp:tc name="" header="0" borderFillIDRef="0">
    <hp:subList id="">${inner}</hp:subList>
    <hp:cellAddr colAddr="${col}" rowAddr="${row}"/><hp:cellSpan colSpan="1" rowSpan="1"/>
    <hp:cellSz width="2000" height="500"/>
  </hp:tc>`
}

function tcText(row: number, col: number, text: string): string {
  const run = text ? `<hp:run charPrIDRef="0"><hp:t>${text}</hp:t></hp:run>` : `<hp:run charPrIDRef="0"/>`
  return tcXml(row, col, `<hp:p id="0" paraPrIDRef="0" styleIDRef="0">${run}</hp:p>`)
}

function tableXml(rows: string[][]): string {
  const trs = rows.map((cells, r) => `<hp:tr>${cells.map((t, c) => tcText(r, c, t)).join("")}</hp:tr>`).join("")
  return `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl>${trs}</hp:tbl></hp:run></hp:p>`
}

async function makeHwpx(sectionBody: string): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${sectionBody}</hs:sec>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

async function sectionOf(buffer: ArrayBuffer): Promise<string> {
  const zip = await JSZip.loadAsync(buffer)
  return await zip.file("Contents/section0.xml")!.async("text")
}

// ─── #1 전략 1이 헤더행 이웃 라벨 셀을 덮어쓰지 않는다 ────────────

describe("#1 헤더+데이터 표의 헤더 행 보호 (전략 1 오염)", () => {
  it("IR: [품명|규격|수량] 헤더에 {품명:볼펜} — 규격이 덮이지 않고 데이터 행에 채움", () => {
    const blocks = [tableBlock(makeTable([
      ["품명", "규격", "수량"],
      ["", "", ""],
    ]))]
    const r = fillFormFields(blocks, { 품명: "볼펜" })
    const t = r.blocks[0].table!
    assert.equal(t.cells[0][1].text, "규격", "헤더 '규격' 보존")
    assert.equal(t.cells[0][2].text, "수량", "헤더 '수량' 보존")
    assert.equal(t.cells[1][0].text, "볼펜", "값은 데이터 행(전략 2)에")
  })

  it("hwpx: 동일 케이스 — 헤더 텍스트 보존 + 데이터 행 채움", async () => {
    const buffer = await makeHwpx(tableXml([["품명", "규격", "수량"], ["", "", ""]]))
    const r = await fillHwpx(buffer, { 품명: "볼펜" })
    const xml = await sectionOf(r.buffer)
    assert.ok(xml.includes("규격") && xml.includes("수량"), "헤더 라벨 보존")
    assert.ok(xml.includes("볼펜"), "데이터 행 채움")
    assert.equal(r.filled.length, 1)
    assert.equal(r.filled[0].row, 1, "전략 2의 데이터 행에 채워짐")
  })

  it("정상 케이스 보존: 라벨-값 서식의 짧은 플레이스홀더 값 셀은 계속 채워진다", () => {
    // 둘째 행이 라벨로 시작하는 표는 헤더 표가 아니다 — '미기재' 플레이스홀더 교체 유지
    const blocks = [tableBlock(makeTable([
      ["성명", "미기재"],
      ["주소", "미기재"],
    ]))]
    const r = fillFormFields(blocks, { 성명: "홍길동", 주소: "서울시" })
    const t = r.blocks[0].table!
    assert.equal(t.cells[0][1].text, "홍길동")
    assert.equal(t.cells[1][1].text, "서울시")
  })
})

// ─── #2 인라인 라벨 붕괴 — 확장 라벨 정확 매칭 ────────────────────

describe("#2 인라인 '신청인 성명:' / '대리인 성명:' 구분", () => {
  it("scanInlineSegments — 확장 라벨(extLabel)을 함께 반환하고 좌표는 핵심 라벨 기준", () => {
    const segs = scanInlineSegments("신청인 성명:  대리인 성명: ")
    assert.equal(segs.length, 2)
    assert.equal(segs[0].label, "성명")
    assert.equal(segs[0].extLabel, "신청인 성명")
    assert.equal(segs[1].extLabel, "대리인 성명")
  })

  it("IR: 두 라벨에 각자의 값 + '대리인' 어절 보존", () => {
    const r = fillFormFields([para("신청인 성명:  대리인 성명: ")], {
      "신청인 성명": "홍길동",
      "대리인 성명": "김철수",
    })
    assert.deepEqual(r.unmatched, [])
    const text = r.blocks[0].text!
    assert.ok(text.includes("홍길동"), text)
    assert.ok(text.includes("김철수"), text)
    assert.ok(text.includes("대리인"), `확장 매칭 시 직전 어절 보존: ${text}`)
    assert.ok(text.indexOf("홍길동") < text.indexOf("대리인"), `순서: ${text}`)
  })

  it("hwpx: 동일 케이스", async () => {
    const buffer = await makeHwpx(`<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>신청인 성명:  대리인 성명: </hp:t></hp:run></hp:p>`)
    const r = await fillHwpx(buffer, { "신청인 성명": "홍길동", "대리인 성명": "김철수" })
    assert.deepEqual(r.unmatched, [])
    const xml = await sectionOf(r.buffer)
    assert.ok(/신청인 성명:\s*홍길동\s+대리인 성명:\s*김철수/.test(xml), `채움 결과: ${xml.match(/<hp:t>[^<]*/)?.[0]}`)
  })

  it("과탐 없음: 값 어절이 다음 라벨에 흡수되지 않는다 ('강남구 전화:')", () => {
    const r = fillFormFields([para("주소: 서울시 강남구 전화: 02-000")], {
      주소: "부산시 해운대",
      전화: "02-120",
    })
    const text = r.blocks[0].text!
    assert.ok(text.includes("주소: 부산시 해운대"), text)
    assert.ok(text.includes("전화: 02-120"), text)
    assert.ok(!text.includes("강남구"), `주소 값 전체 교체 (확장 라벨 미발동): ${text}`)
  })
})

// ─── #3 splice 실패 시 배열 값 무음 소실 금지 ────────────────────

describe("#3 splice 실패한 배열 값은 unmatched로 보고된다", () => {
  it("배열 키가 일부 성공·일부 실패면 라벨을 unmatched에 보고 (무음 소실 금지)", async () => {
    // 두 번째 표의 값 셀은 run 없는 빈 문단 — splice 불가로 소비값이 유실되는 자리
    const failCell = tcXml(0, 1, `<hp:p id="9"></hp:p>`)
    const okTable = tableXml([["성명", ""]])
    const failTable = `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr>${tcText(0, 0, "성명")}${failCell}</hp:tr></hp:tbl></hp:run></hp:p>`
    const buffer = await makeHwpx(okTable + failTable)
    const r = await fillHwpx(buffer, { 성명: ["갑", "을"] })
    assert.deepEqual(r.filled.map(f => f.value), ["갑"], "성공분만 filled")
    assert.ok(r.unmatched.includes("성명"), `부분 실패 배열 라벨은 unmatched 보고: ${JSON.stringify(r.unmatched)}`)
    const xml = await sectionOf(r.buffer)
    assert.ok(xml.includes("갑"))
    assert.ok(!xml.includes(">을<"), "실패분은 기입되지 않음")
  })

  it("스칼라 키의 기존 계약 유지 — 전부 실패면 unmatched, 일부 성공이면 매칭 유지", async () => {
    const failOnly = `<hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl><hp:tr>${tcText(0, 0, "성명")}${tcXml(0, 1, `<hp:p id="9"></hp:p>`)}</hp:tr></hp:tbl></hp:run></hp:p>`
    const r1 = await fillHwpx(await makeHwpx(failOnly), { 성명: "홍길동" })
    assert.deepEqual(r1.unmatched, ["성명"])
    const r2 = await fillHwpx(await makeHwpx(tableXml([["성명", ""]]) + failOnly), { 성명: "홍길동" })
    assert.deepEqual(r2.unmatched, [], "스칼라는 한 곳이라도 성공하면 매칭 유지 (기존 계약)")
  })
})

// ─── #4 역방향 접두사 매칭 임계 0.75 ─────────────────────────────

describe("#4 findMatchingKey 역방향 접두사 임계", () => {
  const cursorOf = (v: Record<string, string>) => new ValueCursor(normalizeValues(v))

  it("셀 '대리인'(3)이 키 '대리인성명'(5)을 흡수하지 않는다 (3/5=0.6 < 0.75)", () => {
    assert.equal(findMatchingKey("대리인", cursorOf({ 대리인성명: "x" })), undefined)
  })

  it("셀 '생년월일'(4) → 키 '생년월일자'(5)는 유지 (4/5=0.8 ≥ 0.75)", () => {
    assert.equal(findMatchingKey("생년월일", cursorOf({ 생년월일자: "x" })), "생년월일자")
  })

  it("순방향(긴 셀 라벨 ← 짧은 키)은 기존 0.6 유지", () => {
    assert.equal(findMatchingKey("신청인성명", cursorOf({ 신청인: "x" })), "신청인")
  })
})

// ─── #5 전략 2가 전략 0(인셀 패턴) 편집을 폐기하지 않는다 ─────────

describe("#5 전략 2 × 전략 0 공존", () => {
  it("IR: 헤더 표 데이터 셀의 체크박스 편집 위에 값을 앞삽입", () => {
    const r = fillFormFields([tableBlock(makeTable([
      ["참석여부", "비고"],
      ["출석 □참석", ""],
    ]))], { 참석: "☑", 참석여부: "예" })
    const t = r.blocks[0].table!
    assert.equal(t.cells[1][0].text, "예 출석 ☑참석", "체크 보존 + 값 앞삽입")
    assert.deepEqual(r.filled.map(f => f.key).sort(), ["참석", "참석여부"])
  })

  it("hwpx: 동일 케이스 — fullText 폐기 금지", async () => {
    const buffer = await makeHwpx(tableXml([["참석여부", "비고"], ["출석 □참석", ""]]))
    const r = await fillHwpx(buffer, { 참석: "☑", 참석여부: "예" })
    const xml = await sectionOf(r.buffer)
    assert.ok(xml.includes("☑참석"), `체크 편집 보존: ${xml.match(/<hp:t>[^<]*참석[^<]*/)?.[0]}`)
    assert.ok(xml.includes("예 출석"), "전략 2 값 앞삽입")
    assert.deepEqual(r.filled.map(f => f.key).sort(), ["참석", "참석여부"], "두 편집 모두 filled 보고")
  })
})

// ─── #6 XML 불법 제어문자 스트립 ─────────────────────────────────

describe("#6 escapeXmlText — XML 1.0 불법 제어문자 제거", () => {
  it("C0 제어문자는 제거, \\t \\n \\r 은 보존", () => {
    assert.equal(escapeXmlText("a\x00b\x08c\x0bd\x1fe"), "abcde")
    assert.equal(escapeXmlText("a\tb\nc\rd"), "a\tb\nc\rd")
    assert.equal(escapeXmlText("a<b&c"), "a&lt;b&amp;c", "기존 이스케이프 유지")
  })

  it("제어문자 섞인 값으로 채워도 섹션 XML이 유효하다", async () => {
    const buffer = await makeHwpx(tableXml([["성명", ""]]))
    const r = await fillHwpx(buffer, { 성명: "홍\x08길동" })
    const xml = await sectionOf(r.buffer)
    assert.ok(xml.includes("홍길동"), "제어문자만 제거된 값")
    assert.ok(!xml.includes("\x08"), "불법 문자 없음")
  })
})

// ─── #7 normalizeValues 키 충돌 경고 ─────────────────────────────

describe("#7 입력 라벨 정규화 충돌 경고", () => {
  it("normalizeValues — 충돌 시 경고 수집 (무음 덮어쓰기 금지)", () => {
    const warnings: string[] = []
    const m = normalizeValues({ "성 명": "갑", "성명": "을" }, warnings)
    assert.equal(m.get("성명"), "을", "뒤 값이 이김 (기존 동작)")
    assert.equal(warnings.length, 1)
    assert.ok(warnings[0].includes("성명"), warnings[0])
  })

  it("fillFormFields 결과에 warnings로 노출", () => {
    const r = fillFormFields([tableBlock(makeTable([["성명", ""]]))], { "성 명": "갑", "성명": "을" })
    assert.ok(r.warnings && r.warnings.length === 1, JSON.stringify(r.warnings))
    const clean = fillFormFields([tableBlock(makeTable([["성명", ""]]))], { 성명: "을" })
    assert.equal(clean.warnings, undefined, "충돌 없으면 생략")
  })
})

// ─── #8 비정합 IRTable 방어 ──────────────────────────────────────

describe("#8 ragged IRTable 공개 API 크래시 방어", () => {
  const ragged: IRTable = {
    rows: 2, cols: 2, hasHeader: true,
    // 선언 rows/cols보다 짧은 cells + undefined 구멍
    cells: [[{ text: "성명", colSpan: 1, rowSpan: 1 }, undefined as unknown as IRCell]],
  }

  it("fillFormFields — 크래시 없이 통과", () => {
    const r = fillFormFields([tableBlock(ragged)], { 성명: "홍길동" })
    assert.ok(Array.isArray(r.filled))
  })

  it("extractFormFields — 크래시 없이 통과", () => {
    const r = extractFormFields([tableBlock(ragged)])
    assert.ok(Array.isArray(r.fields))
  })
})

// ─── #9 체크박스 빈 문자열 계약 ──────────────────────────────────

describe("#9 체크박스 — 빈 문자열은 체크하지 않는다", () => {
  it('{남: ""} 은 □남을 체크하지 않음', () => {
    const r = fillFormFields([tableBlock(makeTable([["구분", "□남 □여"]]))], { 남: "" })
    assert.equal(r.blocks[0].table!.cells[0][1].text, "□남 □여", "미변경")
    assert.equal(r.filled.length, 0)
  })

  it('{남: "☑"} 는 체크 (기존 동작)', () => {
    const r = fillFormFields([tableBlock(makeTable([["구분", "□남 □여"]]))], { 남: "☑" })
    assert.equal(r.blocks[0].table!.cells[0][1].text, "☑남 □여")
  })
})

// ─── #10/#16/#17 render — font-family 이스케이프·MIME 매직·음수 주소 ──

const HEAD_NS = `xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"`
const LINESEG = `<hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="42520" flags="393216"/></hp:linesegarray>`

async function makeRenderHwpx(sectionBody: string, opts?: { headerXml?: string; bin?: Record<string, Uint8Array> }): Promise<ArrayBuffer> {
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  if (opts?.headerXml) zip.file("Contents/header.xml", opts.headerXml)
  for (const [name, bytes] of Object.entries(opts?.bin ?? {})) zip.file(name, bytes)
  zip.file("Contents/section0.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<hs:sec ${SEC_NS}>${sectionBody}</hs:sec>`)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("#10 SVG font-family 이스케이프", () => {
  it("& 포함 글꼴명이 XML 이스케이프되어 방출된다", async () => {
    const header = `<?xml version="1.0" encoding="UTF-8"?><hh:head ${HEAD_NS}><hh:refList>
      <hh:fontfaces><hh:fontface lang="HANGUL" fontCnt="1"><hh:font id="0" face="Q&amp;A체"/></hh:fontface></hh:fontfaces>
      <hh:charProperties><hh:charPr id="0" height="1000"><hh:fontRef hangul="0"/></hh:charPr></hh:charProperties>
    </hh:refList></hh:head>`
    const buffer = await makeRenderHwpx(
      `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>글꼴테스트</hp:t></hp:run>${LINESEG}</hp:p>`,
      { headerXml: header },
    )
    const r = await renderHwpxToSvg(buffer)
    assert.ok(r.svg.includes("Q&amp;A체"), "이스케이프된 글꼴명")
    assert.ok(!r.svg.includes("Q&A체"), "비이스케이프 & 금지 (fill과 동일 처리)")
  })
})

describe("#16 sniffMime — 확장자 없는 GIF 매직", () => {
  it("BinData 파일명에 확장자가 없어도 GIF 매직으로 image/gif", async () => {
    const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0, 0, 0, 0])
    const buffer = await makeRenderHwpx(
      `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:pic><hp:sz width="5000" height="5000"/><hp:img binaryItemIDRef="img1"/></hp:pic></hp:run>${LINESEG}</hp:p>`,
      { bin: { "BinData/img1": gif } },
    )
    const r = await renderHwpxToSvg(buffer)
    assert.ok(r.svg.includes("data:image/gif;base64,"), `GIF MIME 감지: ${r.svg.match(/data:[^;]+/)?.[0]}`)
  })
})

describe("#17 렌더 음수 셀 주소 방어", () => {
  it("colAddr=-1 셀이 NaN 좌표를 만들지 않는다", async () => {
    const cell = `<hp:tc name="" header="0" borderFillIDRef="0"><hp:subList id=""><hp:p id="1" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>셀</hp:t></hp:run>${LINESEG}</hp:p></hp:subList><hp:cellAddr colAddr="-1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="8000" height="1000"/></hp:tc>`
    const buffer = await makeRenderHwpx(
      `<hp:p id="0" paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:tbl><hp:sz width="8000" height="1000"/><hp:tr>${cell}</hp:tr></hp:tbl></hp:run>${LINESEG}</hp:p>`,
    )
    const r = await renderHwpxToSvg(buffer)
    assert.ok(!r.svg.includes("NaN"), "NaN 좌표 없음")
  })
})

// ─── #13 중첩표 측정 메모 ────────────────────────────────────────

describe("#13 measureTableHeight 메모", () => {
  const nestedTbl = (() => {
    const inner = `<hp:tbl><hp:sz width="2000" height="700"/><hp:pos treatAsChar="1"/><hp:tr><hp:tc><hp:subList id=""><hp:p id="2"><hp:run charPrIDRef="0"><hp:t>안</hp:t></hp:run>${LINESEG}</hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="2000" height="700"/></hp:tc></hp:tr></hp:tbl>`
    const outerCell = `<hp:tc><hp:subList id=""><hp:p id="1"><hp:run charPrIDRef="0">${inner}</hp:run>${LINESEG}</hp:p></hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="4000" height="500"/></hp:tc>`
    return `<hp:tbl xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:tr>${outerCell}</hp:tr></hp:tbl>`
  })()

  it("메모 유무·재사용 모두 동일 결과 (캐시 정합)", () => {
    const doc = createXmlParser().parseFromString(nestedTbl, "text/xml")
    const tbl = doc.documentElement as unknown as Element
    const plain = measureTableHeight(tbl)
    const memo = { cell: new WeakMap<Element, number>(), table: new WeakMap<Element, number>() }
    assert.equal(measureTableHeight(tbl, memo), plain, "메모 첫 계산 동일")
    assert.equal(measureTableHeight(tbl, memo), plain, "메모 적중 동일")
  })
})

// ─── #11 simpleIntersect 부분수열 계약 ───────────────────────────

describe("#11 textDiff 대형 입력 폴백 — 가짜 equal 금지", () => {
  it("역순 대형 입력에서도 delete/equal 재조립 = A, insert/equal 재조립 = B", () => {
    const N = 2600 // (2N)² > 25M → simpleIntersect 폴백 경로
    const words = Array.from({ length: N }, (_, i) => `단어${i}`)
    const a = words.join(" ")
    const b = [...words].reverse().join(" ")
    const changes = textDiff(a, b)
    const rebuiltA = changes.filter(c => c.type !== "insert").map(c => c.text).join("")
    const rebuiltB = changes.filter(c => c.type !== "delete").map(c => c.text).join("")
    assert.equal(rebuiltA, a, "A 재조립 (부분수열 위반 시 깨짐)")
    assert.equal(rebuiltB, b, "B 재조립 (가짜 equal 시 깨짐)")
  })
})

// ─── #15 대형 문자열 근사 유사도 — shift-blind 교정 ──────────────

describe("#15 similarity 10k 초과 근사", () => {
  it("접두 1자 삽입된 동일 장문은 높은 유사도 (위치 정렬 샘플의 전량 불일치 교정)", () => {
    const base = "대한민국헌법전문과부칙을포함한긴본문".repeat(400) // 7,600자 ×2 > 10k
    const sim = similarity(base, "X" + base)
    assert.ok(sim > 0.9, `shift 강건: ${sim}`)
  })

  it("완전히 다른 장문은 낮은 유사도", () => {
    const a = "가나다라마바사".repeat(1000)
    const b = "일이삼사오육칠".repeat(1000)
    assert.ok(similarity(a, b) < 0.2)
  })
})

// ─── #12 alignBlocks 길이비 프리필터 — 판정 보존 ─────────────────

describe("#12 diffBlocks 길이 프리필터가 판정을 바꾸지 않는다", () => {
  it("경계(길이차 정확히 60%)는 여전히 modified", () => {
    // len 4 vs 10, b가 a로 시작 → sim = 1 − 6/10 = 0.4 = 임계 (프리필터가 죽이면 안 됨)
    const r = diffBlocks([para("abcd")], [para("abcdefghij")])
    assert.equal(r.stats.modified, 1)
  })

  it("길이차 60% 초과는 기존처럼 removed+added", () => {
    const r = diffBlocks([para("abc")], [para("abcdefghij")])
    assert.equal(r.stats.removed, 1)
    assert.equal(r.stats.added, 1)
  })

  it("표는 dimSim 가중 때문에 60%~86% 길이차에서도 modified 유지", () => {
    const tA = tableBlock(makeTable([["가나다라마바사아", ""]]))
    const tB = tableBlock(makeTable([["가나다라마바사아자차카타파하갸냐댜랴먀뱌샤야", ""]]))
    const r = diffBlocks([tA], [tB])
    assert.equal(r.stats.modified, 1, "표 쌍이 프리필터로 끊기면 안 됨")
  })

  it("#17 선언 rows > 실제 cells인 표 diff도 크래시 없음", () => {
    const ragged: IRTable = { rows: 2, cols: 2, hasHeader: false, cells: [[{ text: "가", colSpan: 1, rowSpan: 1 }]] }
    const r = diffBlocks([tableBlock(ragged)], [tableBlock(ragged)])
    assert.ok(r.diffs.length >= 1)
  })
})

// ─── #14 이미지 인라이너 단일 패스 ───────────────────────────────

describe("#14 inlineImagesIntoMarkdown 단일 패스", () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const imgs = [
    { filename: "a.png", data: png, mimeType: "image/png" },
    { filename: "b.png", data: png, mimeType: "image/png" },
  ]

  it("여러 이미지 참조를 한 번에 치환, 미등록 파일명은 원문 유지", () => {
    const md = "![image](a.png) 중간 ![image](images/b.png) 끝 ![image](other.png)"
    const out = inlineImagesIntoMarkdown(md, imgs)
    assert.ok(!out.includes("(a.png)") && !out.includes("(images/b.png)"), out.slice(0, 120))
    assert.equal((out.match(/data:image\/png;base64,/g) ?? []).length, 2)
    assert.ok(out.includes("![image](other.png)"), "미등록 참조는 그대로")
  })

  it("<img src> 경로도 맵 기반 치환 + 미등록 유지", () => {
    const out = inlineImagesIntoMarkdown('<img src="a.png"> <img src="c.png">', imgs)
    assert.ok(out.includes('src="data:image/png;base64,'))
    assert.ok(out.includes('src="c.png"'), "미등록 참조는 그대로")
  })
})
