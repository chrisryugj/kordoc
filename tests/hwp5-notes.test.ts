/**
 * HWP5 주석(각주·미주) 안 표 — HWPX 짝과 같은 footnoteBlocks·Markdown (#149).
 *
 * HWPX 가 주석 안 표를 footnoteBlocks + 한 줄 HTML 표로 내자 HWP5 는 평탄화 글("A / B\nC / D")로 남아 hwp↔hwpx
 * 쌍 게이트가 깨졌다(rhwp 3-09월_교육_통합·3-11월_실전_통합 짝 11개 crossNED 0 → 0.002~0.005).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import JSZip from "jszip"
import { parseHwp5Document } from "../src/hwp5/parser.js"
import { parseHwpxDocument } from "../src/hwpx/parser.js"
import { charShape, ctrlIdBytes, listHeader, paraHeader, paraText, rec, simplePara, tableRec } from "./fixtures/hwp5-records.js"
import type { HwpRecord } from "../src/hwp5/record.js"

const CFB = createRequire(import.meta.url)("cfb")

/** 각주('fn  ')/미주('en  ') CTRL_HEADER — ctrl_id + number(u32) + 앞·뒤 장식(WCHAR) + 번호 모양(u32) */
function noteCtrl(level: number, id: "fn  " | "en  ", num: number): HwpRecord {
  const b = Buffer.alloc(16)
  ctrlIdBytes(id).copy(b, 0)
  b.writeUInt32LE(num, 4)
  return rec(0x47, level, b)
}

/** 본문 "본문" + 주석 1개(주석 문단 = 글자처럼 취급 2×2 표 A B / C D) */
function hwp5Doc(id: "fn  " | "en  "): Buffer {
  const cells = [["A", 0, 0], ["B", 1, 0], ["C", 0, 1], ["D", 1, 1]] as const
  const records: HwpRecord[] = [
    paraHeader(0), paraText(1, ["본문", { ctrl: id, ch: 0x11 }]), charShape(1, [[0, 0]]),
    noteCtrl(1, id, 1),
    listHeader(2, { col: 0, row: 0, w: 0, h: 0 }),
    paraHeader(2), paraText(3, [{ ctrl: "tbl " }]), charShape(3, [[0, 0]]),
    rec(0x47, 3, Buffer.concat([ctrlIdBytes("tbl "), Buffer.from([1, 0, 0, 0]), Buffer.alloc(38)])),
    tableRec(4, 2, 2),
    ...cells.flatMap(([t, col, row]) => [listHeader(4, { col, row, w: 4000, h: 1000 }), ...simplePara(t, [{ vertpos: 0, horzsize: 3700 }], { level: 4 })]),
  ]
  return packHwp5(records)
}

/** 구역 레코드 → HWP5 CFB 문서 */
function packHwp5(records: HwpRecord[]): Buffer {
  const section = Buffer.concat(records.flatMap(r => {
    const h = Buffer.alloc(4)
    h.writeUInt32LE(r.tagId | (r.level << 10) | (r.data.length << 20))
    return [h, r.data]
  }))
  const fileHeader = Buffer.alloc(256)
  fileHeader.write("HWP Document File", 0, "ascii")
  fileHeader.writeUInt32LE(0x05000300, 32)
  const cfb = CFB.utils.cfb_new()
  CFB.utils.cfb_add(cfb, "/FileHeader", fileHeader)
  CFB.utils.cfb_add(cfb, "/DocInfo", Buffer.alloc(0))
  CFB.utils.cfb_add(cfb, "/BodyText/Section0", section)
  return Buffer.from(CFB.write(cfb, { type: "buffer" }))
}

/** 같은 내용의 HWPX — 주석 머리 번호는 hp:autoNum, 둘째 문단에 2×2 표 */
async function hwpxDoc(tag: "footNote" | "endNote"): Promise<ArrayBuffer> {
  const kind = tag === "footNote" ? "FOOTNOTE" : "ENDNOTE"
  const p = (t: string) => `<hp:p id="0"><hp:run charPrIDRef="0"><hp:t>${t}</hp:t></hp:run></hp:p>`
  const tc = (t: string, c: number, r: number) => `<hp:tc><hp:subList>${p(t)}</hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="1" rowSpan="1"/></hp:tc>`
  const tbl = `<hp:tbl id="1" rowCnt="2" colCnt="2"><hp:tr>${tc("A", 0, 0)}${tc("B", 1, 0)}</hp:tr><hp:tr>${tc("C", 0, 1)}${tc("D", 1, 1)}</hp:tr></hp:tbl>`
  const autoNum = `<hp:ctrl><hp:autoNum num="1" numType="${kind}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/></hp:autoNum></hp:ctrl>`
  const note = `<hp:ctrl><hp:${tag} number="1" suffixChar="41"><hp:subList><hp:p id="0"><hp:run charPrIDRef="0">${autoNum}<hp:t/></hp:run></hp:p>` +
    `<hp:p id="0"><hp:run charPrIDRef="0">${tbl}<hp:t/></hp:run></hp:p></hp:subList></hp:${tag}></hp:ctrl>`
  const xml = `<?xml version="1.0" encoding="UTF-8"?><hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">` +
    `<hp:p id="0" paraPrIDRef="0"><hp:run charPrIDRef="0"><hp:t>본문</hp:t>${note}</hp:run></hp:p></hs:sec>`
  const zip = new JSZip()
  zip.file("mimetype", "application/hwp+zip")
  zip.file("Contents/section0.xml", xml)
  return await zip.generateAsync({ type: "arraybuffer" })
}

describe("HWP5 주석 안 표 — HWPX 짝과 같은 구조·Markdown (#149)", () => {
  for (const [id, tag] of [["en  ", "endNote"], ["fn  ", "footNote"]] as const) {
    it(`${tag}: footnoteBlocks 에 2×2 표, Markdown 은 HWPX 와 같은 줄`, async () => {
      const r5 = await parseHwp5Document(hwp5Doc(id))
      const p5 = r5.blocks.find(b => b.text?.startsWith("본문"))!
      assert.equal(p5.footnoteText, "1) A / B\nC / D", "평탄화 글은 종전 그대로")
      const t = p5.footnoteBlocks?.find(b => b.type === "table")?.table
      assert.ok(t, `footnoteBlocks 에 표: ${JSON.stringify(p5.footnoteBlocks)}`)
      assert.equal(t.rows, 2)
      assert.equal(t.cols, 2)
      assert.deepEqual(t.cells.flat().map(c => c.text), ["A", "B", "C", "D"])
      const line = "본문1) (주: 1) <table><tr><th>A</th><th>B</th></tr><tr><td>C</td><td>D</td></tr></table>)"
      assert.equal(r5.markdown, line)
      const rx = await parseHwpxDocument(await hwpxDoc(tag))
      assert.equal(rx.markdown, r5.markdown, "hwp↔hwpx 짝이 같은 Markdown")
      assert.equal(rx.blocks[0].footnoteText, p5.footnoteText)
    })
  }
})

describe("HWP5 각주 번호 — 한/글이 저장한 번호와 구역 주석 모양 (HWPX number·footNotePr 와 같게)", () => {
  /** 본문 "가" 각주(저장 번호 n) — 주석 글 "주" */
  const note = (n: number) => [
    paraHeader(0), paraText(1, ["가", { ctrl: "fn  ", ch: 0x11 }]), charShape(1, [[0, 0]]),
    noteCtrl(1, "fn  ", n), listHeader(2, { col: 0, row: 0, w: 0, h: 0 }), ...simplePara("주", [{ vertpos: 0, horzsize: 3700 }], { level: 2 }),
  ]
  const secd = (format: number) => {
    const shape = Buffer.alloc(28)
    shape.writeUInt32LE(format, 0)
    return [paraHeader(0), paraText(1, [{ ctrl: "secd" }]), charShape(1, [[0, 0]]),
      rec(0x47, 1, Buffer.concat([ctrlIdBytes("secd"), Buffer.alloc(36)])), rec(0x4a, 2, shape), rec(0x4a, 2, Buffer.alloc(28))]
  }
  const marks = async (records: HwpRecord[]) => (await parseHwp5Document(packHwp5(records))).blocks.map(b => b.footnoteText).filter(Boolean)

  it("저장된 번호를 쓴다 — 문서 차례로 센 계수기(1·2)가 아니라 5·7", async () => {
    assert.deepEqual(await marks([...note(5), ...note(7)]), ["5) 주", "7) 주"])
  })

  it("번호 모양은 구역의 각주 모양(표 134 — 1 = 원숫자)", async () => {
    assert.deepEqual(await marks([...secd(1), ...note(3)]), ["③) 주"])
  })
})
