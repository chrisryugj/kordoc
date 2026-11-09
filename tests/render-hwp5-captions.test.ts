import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { DOMParser } from "../src/xml/dom.js"
import { buildHwp5RenderStyles, hwp5SectionToXml, renderHwp5Records, renderHwp5Pages } from "../src/render/hwp5-scene.js"
import { reflowSection } from "../src/render/reflow.js"
import { indexHwp5Tables } from "../src/hwp5/table-ids.js"
import type { HwpRecord } from "../src/hwp5/record.js"
import { rec, tableCtrl, simplePara, paraHeader, charShape, docCharShape, docParaShape } from "./fixtures/hwp5-records.js"

function caption(level: number, side = 2, paras?: HwpRecord[]): HwpRecord[] {
  const data = Buffer.alloc(30)
  data.writeUInt16LE(1, 0)
  data.writeUInt32LE(0xf0000000 + side, 8)
  data.writeUInt32LE(8504, 12)
  data.writeUInt16LE(850, 16)
  data.writeUInt32LE(20000, 18)
  return [rec(0x48, level, data), ...(paras ?? simplePara("(단위: 조 원)", [{ vertpos: 0, horzsize: 20000 }], { level }))]
}

function table(level = 0, cap = caption(level + 2)): HwpRecord[] {
  const ctrl = tableCtrl(level, [{ text: "값", w: 20000, h: 3000 }])
  ctrl.splice(1, 0, ...cap)
  return ctrl
}

function host(ctrl: HwpRecord[], level = 0): HwpRecord[] {
  return simplePara("", [{ vertpos: 0, horzsize: 30000, height: 5000 }], { level, parts: [{ ctrl: "tbl " }], ctrls: ctrl })
}

function dom(records: HwpRecord[]) {
  const xml = hwp5SectionToXml(records, { tableIds: indexHwp5Tables(records).ids, imageRef: () => null, warnings: [] })
  return new DOMParser().parseFromString(xml, "application/xml")
}

const styles = () => buildHwp5RenderStyles([docCharShape(), docCharShape({ baseSize: 200 }), docParaShape()])

describe("HWP5 표 캡션 렌더", () => {
  for (const [side, expected] of [[2, "TOP"], [3, "BOTTOM"]] as const) {
    it(expected + " 캡션의 글·위치·간격을 DOM과 SVG에 보존한다", () => {
      const records = host(table(0, caption(2, side)))
      const d = dom(records), cap = d.getElementsByTagName("hp:caption")[0]
      assert.ok(cap)
      assert.equal(cap.getAttribute("side"), expected)
      assert.equal(cap.getAttribute("width"), "8504")
      assert.equal(cap.getAttribute("gap"), "850")
      assert.equal(cap.getAttribute("lastWidth"), "20000")
      assert.equal(cap.textContent, "(단위: 조 원)")
      assert.equal(d.getElementsByTagName("hp:tc").length, 1)
      const r = renderHwp5Records(null, styles(), [records], new Map())
      assert.match([...r.pageSvgs.values()].join(""), /단위: 조 원/)
    })
  }

  it("셀 LIST_HEADER는 캡션으로 취급하지 않는다", () => {
    const d = dom(host(tableCtrl(0, [{ text: "칸", w: 20000, h: 3000 }])))
    assert.equal(d.getElementsByTagName("hp:caption").length, 0)
    assert.equal(d.getElementsByTagName("hp:tc")[0].textContent, "칸")
  })

  it("캡션 안의 중첩 TABLE보다 직계 TABLE을 선택한다", () => {
    const inner = tableCtrl(2, [{ text: "안쪽1", w: 8000, h: 1500 }, { text: "안쪽2", w: 8000, h: 1500 }])
    const d = dom(host(table(0, caption(2, 2, host(inner, 2)))))
    const tables = d.getElementsByTagName("hp:tbl")
    assert.equal(tables.length, 2)
    assert.equal(tables[0].getAttribute("colCnt"), "1")
    assert.equal(tables[1].getAttribute("colCnt"), "2")
    assert.match(d.getElementsByTagName("hp:caption")[0].textContent ?? "", /안쪽1안쪽2/)
    assert.match(tables[0].textContent ?? "", /값$/)
  })

  it("셀 안 중첩표의 level 4 캡션도 보존한다", () => {
    const outer = tableCtrl(0, [{ text: "", w: 30000, h: 8000 }])
    outer.splice(3, outer.length - 3, ...host(table(2), 2))
    const d = dom(host(outer))
    assert.equal(d.getElementsByTagName("hp:tbl").length, 2)
    assert.equal(d.getElementsByTagName("hp:caption")[0].textContent, "(단위: 조 원)")
  })

  it("저장 줄 없는 빈 캡션의 200HU 글자 모양을 유지한다", () => {
    const capRecords = caption(2, 2, [paraHeader(2), charShape(3, [[0, 1]])])
    capRecords[0].data.writeUInt32LE(0, 18)
    const records = host(table(0, capRecords))
    const d = dom(records), cap = d.getElementsByTagName("hp:caption")[0]
    assert.ok(cap)
    assert.equal(cap.getElementsByTagName("hp:p").length, 1)
    assert.equal(cap.getElementsByTagName("hp:run")[0].getAttribute("charPrIDRef"), "1")
    assert.equal(cap.getElementsByTagName("hp:lineseg").length, 0)
    assert.equal(styles().charPr.get("1")?.height, 200)
    reflowSection(d.documentElement! as unknown as Element, styles(), { BODY_W: 30000, BODY_H: 80000 })
    assert.equal(cap.getElementsByTagName("hp:lineseg")[0]?.getAttribute("vertsize"), "200")
    assert.equal(renderHwp5Records(null, styles(), [records], new Map()).pageSvgs.size, 1)
  })

  it("길이가 부족한 캡션 헤더는 셀 렌더를 방해하지 않는다", () => {
    const d = dom(host(table(0, [rec(0x48, 2, Buffer.alloc(8))])))
    assert.equal(d.getElementsByTagName("hp:caption").length, 0)
    assert.equal(d.getElementsByTagName("hp:tc")[0].textContent, "값")
  })

  for (const [name, text] of [["143E433F503322BD33.hwp", "단위: 조 원"], ["exam_social.hwp", "단위:%"]]) {
    const path = new URL("../bench/corpus/rhwp/" + name, import.meta.url)
    it(name + " 실제 문서의 단위 표시를 출력한다", { skip: !existsSync(path) }, () => {
      const r = renderHwp5Pages(readFileSync(path))
      assert.ok([...r.pageSvgs.values()].some(svg => svg.includes(text)))
    })
  }
})
