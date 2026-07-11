/**
 * HTML 표(병합·중첩) → HWPX 생성 — parse가 내보내는 <table> HTML을
 * markdownToHwpx가 구조 보존으로 되살리는 라운드트립 검증
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, parseHwpx } from "../src/index.js"

const MERGED = [
  "<table>",
  '<tr><th colspan="2">구분</th><th>내용</th></tr>',
  '<tr><td rowspan="2">사업</td><td>세부1</td><td>예산 100</td></tr>',
  "<tr><td>세부2</td><td>예산 200</td></tr>",
  "</table>",
].join("\n")

const NESTED = [
  "<table>",
  "<tr><th>항목</th><th>상세</th></tr>",
  "<tr><td>내역</td><td><table>",
  "<tr><th>중첩A</th><th>중첩B</th></tr>",
  "<tr><td>값1</td><td>값2</td></tr>",
  "</table></td></tr>",
  "</table>",
].join("\n")

describe("markdownToHwpx — HTML 표 생성", () => {
  it("병합셀(colspan/rowspan) 표가 구조 그대로 라운드트립된다", async () => {
    const buf = await markdownToHwpx(MERGED)
    const r = await parseHwpx(buf)
    assert.ok(r.success)
    assert.ok(r.markdown.includes('colspan="2"'), "colspan 보존")
    assert.ok(r.markdown.includes('rowspan="2"'), "rowspan 보존")
    for (const t of ["구분", "사업", "세부1", "세부2", "예산 100", "예산 200"]) {
      assert.ok(r.markdown.includes(t), `${t} 보존`)
    }
  })

  it("중첩표가 셀 안에 재귀 생성되어 라운드트립된다", async () => {
    const buf = await markdownToHwpx(NESTED)
    const r = await parseHwpx(buf)
    assert.ok(r.success)
    // 재파싱 결과에 중첩 <table>이 다시 나타나야 함
    const tableOpens = (r.markdown.match(/<table>/g) ?? []).length
    assert.ok(tableOpens >= 2, `중첩표 구조 보존 (table 태그 ${tableOpens}개)`)
    for (const t of ["중첩A", "중첩B", "값1", "값2", "내역"]) {
      assert.ok(r.markdown.includes(t), `${t} 보존`)
    }
  })

  it("중첩표·다중행 셀 확장 높이가 바깥 표 hp:sz에도 반영된다", async () => {
    const html = NESTED.replace("내역", "내역<br>둘째 줄<br>셋째 줄")
    const buf = await markdownToHwpx(html)
    const section = await (await JSZip.loadAsync(buf)).file("Contents/section0.xml")!.async("text")
    const outer = section.match(/<hp:tbl[^>]*rowCnt="2"[^>]*>[\s\S]*?<hp:sz[^>]*height="(\d+)"/)!
    assert.ok(outer, "바깥 HTML 표 hp:sz")
    assert.ok(Number(outer[1]) > 3000, `기본 2행 높이(3000)보다 확장: ${outer[1]}`)
  })

  it("셀 좌표·병합 스팬이 HWPX XML에 정확히 박힌다", async () => {
    const buf = await markdownToHwpx(MERGED)
    const zip = await JSZip.loadAsync(buf)
    const section = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(section.includes('<hp:cellSpan colSpan="2" rowSpan="1"/>'), "colspan=2 셀")
    assert.ok(section.includes('<hp:cellSpan colSpan="1" rowSpan="2"/>'), "rowspan=2 셀")
    // rowspan 점유로 둘째 데이터 행 첫 셀은 colAddr=1에서 시작
    assert.ok(section.includes('<hp:cellAddr colAddr="1" rowAddr="2"/>'), "병합 점유 반영 좌표")
    assert.ok(/rowCnt="3" colCnt="3"/.test(section), "그리드 치수")
  })

  it("HTML 엔티티가 셀 텍스트로 복원된다 (&amp; → &)", async () => {
    const html = '<table>\n<tr><th>회사</th></tr>\n<tr><td>A&amp;B</td></tr>\n</table>'
    const buf = await markdownToHwpx(html)
    const r = await parseHwpx(buf)
    assert.ok(r.success)
    assert.ok(r.markdown.includes("A&amp;B") || r.markdown.includes("A&B"), "엔티티 복원")
  })

  it("생성 표의 borderFill 참조가 1-based (테두리 렌더 회귀 방지)", async () => {
    const buf = await markdownToHwpx("| a | b |\n|---|---|\n| 1 | 2 |")
    const zip = await JSZip.loadAsync(buf)
    const header = await zip.file("Contents/header.xml")!.async("text")
    const section = await zip.file("Contents/section0.xml")!.async("text")
    assert.ok(!/borderFill id="0"/.test(header), "borderFill id=0 금지 (1-based 규약)")
    assert.ok(/<hh:borderFill id="2"[^>]*>[\s\S]*?type="SOLID"/.test(header), "SOLID 테두리 fill 존재")
    assert.ok(/hp:tc[^>]*borderFillIDRef="2"/.test(section), "셀이 SOLID fill 참조")
  })
})
