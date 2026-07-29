/**
 * HWPX 빈 문단 보존 (#57) — keepEmptyParagraphs 옵션
 *
 * 이슈 재현: 텍스트 없는 hp:p(빈 문단)가 표 셀·본문 모두에서 소실되어
 * 행 줄맞춤 서식 문서(원규 번호 체계표 등)의 줄 대응이 깨진다.
 * 기본(off)은 현행 동작(빈 문단 제거) 그대로, 옵션 on일 때만
 * "원문 문단 수 = 줄 수" 대응을 보존한다. 빈 run 두 형태
 * (<hp:run></hp:run> / 자기닫힘 <hp:run/>) 모두 동일 취급.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx } from "../src/index.js"
import type { IRTable } from "../src/types.js"

/** 생성 hwpx의 section0.xml을 변형해 재패키징 */
async function makeHwpx(md: string, transform: (xml: string) => string): Promise<ArrayBuffer> {
  const buf = await markdownToHwpx(md)
  const zip = await JSZip.loadAsync(buf)
  const xml = await zip.file("Contents/section0.xml")!.async("text")
  const next = transform(xml)
  assert.notEqual(next, xml, "section0.xml 변형이 실제로 적용되어야 함 (needle 미일치)")
  zip.file("Contents/section0.xml", next)
  return (await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer
}

/** markdownToHwpx가 생성하는 표준 문단 형태 */
const para = (inner: string) => `<hp:p paraPrIDRef="0" styleIDRef="0">${inner}</hp:p>`
const textPara = (t: string) => para(`<hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run>`)
/** 빈 문단 — 생성본 형태 (열고 닫는 빈 run) */
const EMPTY_P = para('<hp:run charPrIDRef="0"></hp:run>')
/** 빈 문단 — 한컴 자기닫힘 run 형태 (이슈 재현 케이스) */
const EMPTY_P_SELF = para('<hp:run charPrIDRef="29"/>')

const TABLE_MD = "| 헤더1 | 헤더2 |\n|---|---|\n| 셀A | 셀B |"

/** 셀A 문단을 A/빈/빈(자기닫힘)/추가B 4문단으로 치환한 hwpx */
function cellAeeB(): Promise<ArrayBuffer> {
  return makeHwpx(TABLE_MD, xml =>
    xml.replace(textPara("셀A"), textPara("셀A") + EMPTY_P + EMPTY_P_SELF + textPara("추가B")))
}

function firstTable(blocks: Array<{ type: string; table?: IRTable }>): IRTable {
  const t = blocks.find(b => b.type === "table")?.table
  assert.ok(t, "표 블록 존재")
  return t!
}

describe("HWPX 빈 문단 보존 (#57)", () => {
  it("기본(off): 셀 안 빈 문단은 현행대로 제거된다 — 'A\\nB'", async () => {
    const r = await parseHwpx(await cellAeeB())
    assert.ok(r.success)
    const table = firstTable(r.blocks)
    assert.equal(table.cells[1][0].text, "셀A\n추가B")
  })

  it("keepEmptyParagraphs: 셀 빈 문단이 빈 줄로 보존된다 — 원문 4문단 = 4줄", async () => {
    const r = await parseHwpx(await cellAeeB(), { keepEmptyParagraphs: true })
    assert.ok(r.success)
    const table = firstTable(r.blocks)
    // A / 빈 / 빈(자기닫힘 run) / 추가B — 두 형태 모두 보존
    assert.equal(table.cells[1][0].text, "셀A\n\n\n추가B")
    // 마크다운 셀 개행 규칙(<br>)과 정합 — 빈 줄도 <br>로 재현
    assert.ok(r.markdown.includes("셀A<br><br><br>추가B"), `마크다운 <br> 보존: ${r.markdown}`)
    // 제목셀 재부착(무-trim 매칭)이 옵션 하에서도 동작
    assert.equal(table.cells[0][0].isHeader, true)
  })

  it("keepEmptyParagraphs: 셀 선두·후미 빈 문단도 줄 수로 보존된다", async () => {
    const buf = await makeHwpx(TABLE_MD, xml =>
      xml.replace(textPara("셀A"), EMPTY_P + textPara("셀A") + EMPTY_P_SELF))
    const r = await parseHwpx(buf, { keepEmptyParagraphs: true })
    assert.ok(r.success)
    // 빈 / 셀A / 빈 — 3문단 = 3줄 (기본 경로의 trim이 옵션 시 비활성)
    assert.equal(firstTable(r.blocks).cells[1][0].text, "\n셀A\n")

    // 같은 파일, 기본(off)은 종전대로 trim
    const r2 = await parseHwpx(buf)
    assert.ok(r2.success)
    assert.equal(firstTable(r2.blocks).cells[1][0].text, "셀A")
  })

  it("본문: 기본은 빈 문단 제거, 옵션 시 text:'' paragraph 블록으로 순서 보존", async () => {
    const buf = await makeHwpx("본문A\n\n본문B", xml =>
      xml.replace(textPara("본문B"), EMPTY_P + EMPTY_P_SELF + textPara("본문B")))

    const off = await parseHwpx(buf)
    assert.ok(off.success)
    assert.deepEqual(
      off.blocks.filter(b => b.type === "paragraph").map(b => b.text),
      ["본문A", "본문B"], "기본: 현행 동작 유지")

    const on = await parseHwpx(buf, { keepEmptyParagraphs: true })
    assert.ok(on.success)
    assert.deepEqual(
      on.blocks.filter(b => b.type === "paragraph").map(b => b.text),
      ["본문A", "", "", "본문B"], "옵션: 빈 문단이 text:'' 블록으로 순서대로")
    // 마크다운은 빈 문단을 표현할 수 없으므로 종전과 동일 (블록 소비자용 보존)
    assert.ok(on.markdown.includes("본문A"))
    assert.ok(on.markdown.includes("본문B"))
  })

  it("개체(표)만 있는 문단은 빈 문단으로 취급하지 않는다 (이중 줄 방지)", async () => {
    // 표를 나르는 문단은 텍스트가 없어도 개체 출력이 따로 있음 — 빈 블록 미방출
    const buf = await markdownToHwpx("본문A\n\n" + TABLE_MD + "\n\n본문B")
    const r = await parseHwpx(buf, { keepEmptyParagraphs: true })
    assert.ok(r.success)
    const paras = r.blocks.filter(b => b.type === "paragraph").map(b => b.text)
    assert.deepEqual(paras, ["본문A", "본문B"], `표 문단이 빈 문단으로 오인되지 않음: ${JSON.stringify(paras)}`)
  })
})
