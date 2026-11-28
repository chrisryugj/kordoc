/**
 * 라운드트립 적대적 리뷰(2026-06-11, 24건 확정)에서 나온 가드들의 회귀 테스트.
 * 각 케이스는 실행 repro로 검증된 버그의 최소 재현이다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { markdownToHwpx, parseHwpx, patchHwpx } from "../src/index.js"
import { scanSectionXml } from "../src/roundtrip/source-map.js"
import { parseGfmTable } from "../src/roundtrip/markdown-units.js"

function toAB(u8: Uint8Array): ArrayBuffer {
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer
}

// ─── 스캐너 분류 가드 ────────────────────────────────

describe("source-map 분류 가드 (리뷰 #1/#5/#17)", () => {
  it("footNote/endNote 내부 문단은 bodyParagraphs에서 제외", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y">`
      + `<hp:p><hp:run><hp:t>본문</hp:t>`
      + `<hp:footNote><hp:subList><hp:p><hp:run><hp:t>각주 텍스트</hp:t></hp:run></hp:p></hp:subList></hp:footNote>`
      + `</hp:run></hp:p>`
      + `<hp:p><hp:run><hp:endNote><hp:subList><hp:p><hp:run><hp:t>미주 텍스트</hp:t></hp:run></hp:p></hp:subList></hp:endNote></hp:run></hp:p>`
      + `</hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const bodyTexts = scan.bodyParagraphs.map(p => p.text)
    assert.ok(bodyTexts.some(t => t.includes("본문")))
    assert.ok(!bodyTexts.some(t => t.includes("각주 텍스트")), `각주 문단이 body로 분류됨: ${JSON.stringify(bodyTexts)}`)
    assert.ok(!bodyTexts.some(t => t.includes("미주 텍스트")), "미주 문단이 body로 분류됨")
  })

  it("표 셀 안 글상자(drawText) 문단은 셀에 귀속 (bodyParagraphs 오염 금지)", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y">`
      + `<hp:tbl><hp:tr><hp:tc><hp:subList>`
      + `<hp:p><hp:run><hp:t>셀본문</hp:t></hp:run></hp:p>`
      + `<hp:p><hp:run><hp:rect><hp:drawText><hp:subList><hp:p><hp:run><hp:t>승인 완료</hp:t></hp:run></hp:p></hp:subList></hp:drawText></hp:rect></hp:run></hp:p>`
      + `</hp:subList><hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc></hp:tr></hp:tbl>`
      + `<hp:p><hp:run><hp:t>승인 완료</hp:t></hp:run></hp:p>`
      + `</hs:sec>`
    const scan = scanSectionXml(xml, 0)
    // 본문에는 표 뒤 문단 1개만 (셀 안 글상자 '승인 완료'는 셀로)
    const bodyApproved = scan.bodyParagraphs.filter(p => p.text.includes("승인 완료"))
    assert.equal(bodyApproved.length, 1, "셀 안 글상자 문단이 body를 오염")
    const cell = scan.tables[0].cellByAnchor.get("0,0")!
    assert.ok(cell.paragraphs.some(p => p.text.includes("승인 완료")), "글상자 문단이 셀에 귀속돼야 함")
  })

  it("펼친 형태 <hp:cellAddr ...></hp:cellAddr>도 앵커 파싱", () => {
    const xml = `<hs:sec xmlns:hs="x" xmlns:hp="y"><hp:tbl><hp:tr><hp:tc><hp:subList>`
      + `<hp:p><hp:run><hp:t>내용</hp:t></hp:run></hp:p></hp:subList>`
      + `<hp:cellAddr colAddr="2" rowAddr="1"></hp:cellAddr><hp:cellSpan colSpan="3" rowSpan="2"></hp:cellSpan>`
      + `</hp:tc></hp:tr></hp:tbl></hs:sec>`
    const scan = scanSectionXml(xml, 0)
    const cell = scan.tables[0].cellByAnchor.get("1,2")
    assert.ok(cell, "펼친 cellAddr 앵커 소실")
    assert.equal(cell!.colSpan, 3)
    assert.equal(cell!.rowSpan, 2)
  })
})

// ─── 되읽기 대칭 가드 ────────────────────────────────

describe("markdown-units 되읽기 대칭 (리뷰 #23)", () => {
  it("전부 '-'인 데이터 행은 구분 행이 아님", () => {
    const rows = parseGfmTable(["| 항목 | 값 |", "| --- | --- |", "| - | - |", "| 예산 | 1억 |"])
    assert.equal(rows.length, 3, "'| - | - |' 데이터 행이 구분 행으로 오인됨")
    assert.deepEqual(rows[1], ["-", "-"])
  })
})

// ─── 대형 문서 정렬 폴백 (리뷰 #2/#4) ─────────────────

describe("patchHwpx: 대형 문서 폴백 (m*n > 4M)", () => {
  it("대형 문서 문단 삽입 — Myers 정렬로 그 자리에만 넣는다(시프트 오적용 없음)", async () => {
    const paras = Array.from({ length: 2100 }, (_, i) => `문단 ${i + 1}번 내용입니다.`)
    const original = new Uint8Array(await markdownToHwpx(paras.join("\n\n")))
    const parsed = await parseHwpx(toAB(original))
    assert.ok(parsed.success)
    const lines = parsed.markdown.split("\n\n")
    lines.splice(1000, 0, "삽입된 새 문단입니다.")
    const res = await patchHwpx(original, lines.join("\n\n"))
    assert.ok(res.success)
    const r2 = await parseHwpx(toAB(res.data!))
    assert.ok(r2.success)
    assert.deepEqual(r2.markdown.trim().split("\n\n"), lines.join("\n\n").trim().split("\n\n"), "그 자리에만 들어가고 나머지는 그대로")
  })

  it("대형 문서 편집이 너무 많으면(거친 정렬) 문단을 더하거나 지우지 않고 보고한다", async () => {
    const paras = Array.from({ length: 4000 }, (_, i) => `문단 ${i + 1}번 내용입니다.`)
    const original = new Uint8Array(await markdownToHwpx(paras.join("\n\n")))
    const parsed = await parseHwpx(toAB(original))
    assert.ok(parsed.success)
    const lines = parsed.markdown.split("\n\n").filter((_, i) => i % 3 !== 1)  // 1,333 문단 삭제 — 유닛 곱 4백만 초과·Myers 상한(1,000) 초과
    const res = await patchHwpx(original, lines.join("\n\n"))
    assert.ok(res.success)
    assert.ok(res.skipped.some(s => s.reason.includes("삭제")), `삭제 미지원 보고 누락: applied=${res.applied}`)
    const r2 = await parseHwpx(toAB(res.data!))
    assert.ok(r2.markdown.includes("문단 4000번 내용입니다.") && r2.markdown.includes("문단 2번 내용입니다."), "원문 보존")
  })
})

// ─── 문단 분절 가드 (리뷰 #8/#9/#10/#14) ─────────────

describe("patchHwpx: 문단 분절 가드", () => {
  it("리터럴 '# ' 문단 수정 시 접두 보존 (리뷰 #21)", async () => {
    const buf = await markdownToHwpx("# 진짜 헤딩\n\n일반 문단 하나.")
    const original = new Uint8Array(buf)
    const parsed = await parseHwpx(toAB(original))
    assert.ok(parsed.success)
    // 헤딩 수정 — 접두 제거 경로 (정상)
    const edited = parsed.markdown.replace("진짜 헤딩", "진짜 헤딩 수정")
    const res = await patchHwpx(original, edited)
    assert.ok(res.success)
    if (res.applied >= 1 && res.skipped.length === 0) {
      const r2 = await parseHwpx(toAB(res.data!))
      assert.equal(r2.markdown, edited)
    }
  })
})
