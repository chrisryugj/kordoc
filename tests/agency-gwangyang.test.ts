import { it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { markdownToHwpx, agencyNames, agencyStyle, incompatibleGongmunWarnings, parse } from "../src/index.js"
import { resolveGongmun } from "../src/hwpx/gongmun.js"
import { pickScheme } from "../src/hwpx/gongmun-scheme.js"

it("광양시 이름과 보고서 스타일이 공개 API 및 최종 스킴에 연결된다", () => {
  assert.equal(agencyNames().filter(n => n === "광양시").length, 1)
  assert.equal(agencyStyle(" 광양시 ").report?.docs, 1)
  const s = pickScheme(resolveGongmun({ preset: "report", agency: "광양시" }), true)
  assert.equal(s.body.font, "휴먼명조")
  assert.deepEqual(s.levels.slice(0, 3).map(x => [x.font, x.pt]), [["HY헤드라인M", 16], ["휴먼명조", 15], ["휴먼명조", 15]])
  assert.equal(s.table.headerFill, "#DFE6F7")
  assert.equal(s.table.pt, 13)
})

it("광양시 비교안의 명시 글꼴·크기·부호가 기관값보다 우선한다", () => {
  const g = resolveGongmun({ preset: "plan", agency: "광양시", fonts: { body: "함초롬바탕" }, bodyPt: 14, bullet2: "❍", bandColor: "#246044" })
  const s = pickScheme(g, true)
  assert.equal(s.body.font, "함초롬바탕")
  assert.equal(s.body.pt, 14)
  assert.equal(g.bullet2, "❍")
  assert.equal(g.bandColor, "#246044")
})

it("미조사 보도자료는 공통값 경고, 기안문은 기존 적용 제외 경고", () => {
  assert.equal(agencyStyle("광양시").press, null)
  assert.match(incompatibleGongmunWarnings({ preset: "press", agency: "광양시" }).join(), /보도자료.*공통 서식/)
  assert.match(incompatibleGongmunWarnings({ preset: "official", agency: "광양시" }).join(), /무시됨/)
})

it("광양시 HWPX를 생성하고 문안·표를 다시 읽을 수 있다", async () => {
  const buf = await markdownToHwpx("# 문서 서식 시범 적용\n\n> 문서 작성 시간을 줄이고자 함\n\n## 추진내용\n\n- 공통서식 적용\n  - 부서 의견 수렴\n    - 수정사항 반영\n\n| 구분 | 내용 |\n|---|---|\n| 대상 | 희망 부서 |", { gongmun: { preset: "report", agency: "광양시" } })
  const z = await JSZip.loadAsync(buf)
  const h = await z.file("Contents/header.xml")!.async("string")
  for (const font of ["휴먼명조", "한양중고딕", "HY헤드라인M"]) assert.ok(h.includes(`face="${font}"`))
  assert.ok(h.includes('faceColor="#DFE6F7"'))
  assert.ok(h.includes('faceColor="#003366"'))
  const result = await parse(buf)
  assert.ok(result.success)
  assert.ok(result.markdown.includes("부서 의견 수렴"))
  assert.ok(result.markdown.includes("희망 부서"))
})


it("광양시 보고서에만 표 골격 기본값을 적용하고 명시 선택을 보존한다", () => {
  assert.equal(resolveGongmun({ preset: "report", agency: "광양시" }).reportFrame, "gwangyang-1")
  assert.equal(resolveGongmun({ preset: "plan", agency: "광양시", reportFrame: "gwangyang-2" }).reportFrame, "gwangyang-2")
  assert.equal(resolveGongmun({ preset: "report" }).reportFrame, null)
  assert.equal(resolveGongmun({ preset: "press", agency: "광양시" }).reportFrame, null)
  assert.throws(() => resolveGongmun({ reportFrame: "bad" as never }), /reportFrame/)
})

it("두 골격이 편집 가능한 표로 생성되고 동일 문안을 유지한다", async () => {
  const md = "# 비교문서\n\n## 추진 개요\n\n| 구분 | 내용 |\n|---|---|\n| 대상 | 희망 부서 |"
  const headers: string[] = []
  for (const reportFrame of ["gwangyang-1", "gwangyang-2"] as const) {
    const buf = await markdownToHwpx(md, { gongmun: { preset: "report", agency: "광양시", reportFrame } })
    const z = await JSZip.loadAsync(buf)
    const xml = await z.file("Contents/section0.xml")!.async("string")
    assert.ok((xml.match(/<hp:tbl /g) ?? []).length >= 3)
    assert.ok(!xml.includes("<hp:pic"))
    assert.ok((await parse(buf)).markdown.includes("희망 부서"))
    headers.push(await z.file("Contents/header.xml")!.async("string"))
  }
  assert.ok(!headers[0].includes('faceColor="#94C83D"'))
  assert.ok(headers[1].includes('faceColor="#94C83D"'))
})

import { dataCellSpec } from "../src/hwpx/gen-table-bf.js"
it("병합 셀을 포함한 본문표 외곽과 헤더 경계가 기관 골격을 따른다", () => {
  const cell = { row: 0, rowEnd: 1, col: 0, colEnd: 2, rowCnt: 3, colCnt: 3, headerRows: 2 }
  assert.deepEqual(dataCellSpec({ ...cell, theme: "gwangyang-1" }), { t: "thin", b: "thin", l: "none", r: "none", fill: undefined })
  assert.deepEqual(dataCellSpec({ ...cell, theme: "gwangyang-2" }), { t: "thick", b: "thick", l: "thick", r: "thick", fill: undefined })
  assert.equal(dataCellSpec(cell).b, "double")
})


it("1안 제목 띠는 원본 장식 2개를 패키지에 넣고 셀 배경으로 참조한다", async () => {
  const buf = await markdownToHwpx("# 제목\n\n## 추진 배경\n\n| 구분 | 내용 |\n|---|---|\n| 1 | 첫 행 |\n| 2 | 둘째 행 |", { gongmun: { preset: "report", agency: "광양시" } })
  const z = await JSZip.loadAsync(buf)
  const header = await z.file("Contents/header.xml")!.async("string")
  const section = await z.file("Contents/section0.xml")!.async("string")
  const manifest = await z.file("Contents/content.hpf")!.async("string")
  const refs = [...header.matchAll(/<hc:img binaryItemIDRef="([^"]+)"/g)].map(m => m[1])
  assert.equal(refs.length, 2)
  for (const id of refs) assert.ok(manifest.includes(`id="${id}"`))
  const images = Object.keys(z.files).filter(n => /^BinData\/.+\.png$/.test(n))
  assert.equal(images.length, 2)
  assert.ok(header.includes('width="0.4 mm" color="#263056"'))
  assert.ok(header.includes('type="DASH" width="0.12 mm"'))
  assert.ok(section.includes('height="537"'))
  assert.ok(section.includes('height="565"'))
  const second = dataCellSpec({ theme: "gwangyang-1", row: 2, rowEnd: 2, col: 1, colEnd: 1, rowCnt: 4, colCnt: 3, headerRows: 1 })
  assert.deepEqual(second.t, ["0.12 mm", "#000000", "DASH"])
  assert.deepEqual(second.b, second.t)
})
