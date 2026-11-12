/**
 * v4.15.7 — 칸 클립 없는 PDF 의 선 격자 중첩표, 이중 테두리 오인 방지, 양식 선택 상자 글.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import JSZip from "jszip"
import { buildTableGrids } from "../src/pdf/line-detector.js"
import type { LineSegment } from "../src/pdf/line-detector.js"
import { remapSymbolFontItems } from "../src/pdf/symbol-fonts.js"
import type { NormItem } from "../src/pdf/text-line.js"
import { markdownToHwpx, parseHwpx } from "../src/index.js"

const h = (y: number, x1: number, x2: number): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: 1 })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 1 })
const box = (x1: number, y1: number, x2: number, y2: number) => ({ hs: [h(y1, x1, x2), h(y2, x1, x2)], vs: [v(x1, y1, y2), v(x2, y1, y2)] })

describe("buildTableGrids — 선 격자 중첩표", () => {
  it("틀 안에 칸 여백(5pt)만큼 떠 있는 닫힌 표는 떼어 lineNested 격자로 낸다", () => {
    const frame = box(60, 60, 536, 623)
    // 안쪽 2×2 표 (65~531, 65~363) — 틀 왼·오른·아래 변에서 5pt(CONNECT_TOL) 떨어져 종전엔 틀과 한 격자로 뭉쳤다
    const inner = { hs: [h(363, 65, 531), h(331, 65, 531), h(65, 65, 531)], vs: [v(65, 65, 363), v(290, 65, 363), v(531, 65, 363)] }
    const grids = buildTableGrids([...frame.hs, ...inner.hs], [...frame.vs, ...inner.vs])
    const nested = grids.filter(g => g.lineNested)
    assert.equal(nested.length, 1)
    assert.equal(nested[0].rowYs.length - 1, 2)
    assert.equal(nested[0].colXs.length - 1, 2)
    const outer = grids.find(g => !g.lineNested)!
    assert.equal(outer.rowYs.length - 1, 1, "틀은 안쪽 표 괘선을 행 경계로 삼지 않는다")
    assert.equal(outer.colXs.length - 1, 1)
  })

  it("네 변이 바깥 상자에 바짝 붙은 안쪽 상자는 이중 테두리다 — 중첩표로 떼지 않는다", () => {
    const outerBox = box(65, 160, 490, 456)
    const innerBox = box(69.3, 165, 485.7, 451.5)
    const grids = buildTableGrids([...outerBox.hs, ...innerBox.hs], [...outerBox.vs, ...innerBox.vs])
    assert.equal(grids.filter(g => g.lineNested).length, 0)
  })
})

describe("양식 선택 상자", () => {
  it("PDF Marlett 체크박스 글리프(g f e d c [b])는 ☐ / ☑ 한 글자로", () => {
    const item = (text: string, x: number): NormItem => ({ text, x, y: 700, w: 8, h: 8, fontSize: 8, fontName: "g_d0_f9" } as NormItem)
    const items = [..."gfedc".split("").map(c => item(c, 155)), item(" ", 166), item("원천기술형", 170),
      ..."gfedcb".split("").map(c => item(c, 236)), item("혁신제품형", 250)]
    remapSymbolFontItems(items, () => "INPILL+Marlett")
    assert.deepEqual(items.map(i => i.text), ["☐", " ", "원천기술형", "☑", "혁신제품형"])
  })

  it("HWPX hp:checkBtn 은 상자 기호와 캡션을 낸다 — 캡션은 개체 폭이 좁으면(상자만 인쇄) 뺀다", async () => {
    const btn = (caption: string, value: string, width: number) =>
      `<hp:run charPrIDRef="0"><hp:checkBtn caption="${caption}" value="${value}" name="CheckBox1"><hp:formCharPr charPrIDRef="0"/>` +
      `<hp:sz width="${width}" widthRelTo="ABSOLUTE" height="1500" heightRelTo="ABSOLUTE" protect="0"/></hp:checkBtn></hp:run>`
    const buf = await markdownToHwpx("표시자리")
    const zip = await JSZip.loadAsync(buf)
    const xml = await zip.file("Contents/section0.xml")!.async("text")
    const next = xml.replace("<hp:t>표시자리</hp:t></hp:run>", "</hp:run>" +
      btn("원천기술형", "UNCHECKED", 5000) + btn("혁신제품형", "CHECKED", 5000) + btn("선택 상자", "CHECKED", 1297))
    assert.notEqual(next, xml)
    zip.file("Contents/section0.xml", next)
    const res = await parseHwpx((await zip.generateAsync({ type: "arraybuffer" })) as ArrayBuffer)
    assert.ok(res.markdown.includes("☐ 원천기술형"), res.markdown)
    assert.ok(res.markdown.includes("☑ 혁신제품형"), res.markdown)
    assert.ok(!res.markdown.includes("선택 상자"), res.markdown)
  })
})

describe("buildTableGrids — 떨어진 상자 둘", () => {
  // 보도자료 머리: "보도 일시" 상자(1행)와 14pt 아래 "담당 부서" 상자(2행) — 열 경계가 같다
  const xs = [59, 122, 273, 334, 536]
  const box = (top: number, rows: number[]) => ({
    hs: [top, ...rows].map(y => h(y, 59, 536)),
    vs: xs.map(x => v(x, rows[rows.length - 1], top)),
  })
  it("10pt 넘게 떨어진 같은 열 구조의 닫힌 상자는 따로 선 표다", () => {
    const a = box(722, [694]), b = box(679, [660, 641])
    assert.equal(buildTableGrids([...a.hs, ...b.hs], [...a.vs, ...b.vs]).length, 2)
  })
  it("맞닿은(5pt 안) 같은 열 구조 격자는 종전대로 잇는다", () => {
    const a = box(722, [694]), b = box(690, [660, 641])
    assert.equal(buildTableGrids([...a.hs, ...b.hs], [...a.vs, ...b.vs]).length, 1)
  })
})
