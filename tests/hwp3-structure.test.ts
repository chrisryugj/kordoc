/**
 * HWP3 구조 IR 회귀 — 표·글상자·단추(셀 기하 격자), 수식, 하이퍼텍스트, 각주·미주, 머리말·꼬리말, 숨은 설명,
 * 개요 번호, 채움 탭, 자동 번호, 겹친 셀. 한컴 HWP3→HWPX 변환본(rhwp 샘플)을 GT 로 삼은 HWP5 쌍 트랙 규칙의 합성 고정.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { parseHwp3Document } from "../src/hwp3/parser.js"
import { hwp3CellGrid } from "../src/hwp3/table.js"
import { decodeJohab } from "../src/hwp3/johab.js"
import type { IRBlock } from "../src/types.js"

// ─── 합성 HWP3 빌더 (regress-hwp3-rhwp.test.ts 와 같은 골격) ───

function buildHwp3(body: Buffer): ArrayBuffer {
  const sig = Buffer.alloc(30)
  Buffer.from("HWP Document File V3.00", "ascii").copy(sig)
  const file = Buffer.concat([sig, Buffer.alloc(128), Buffer.alloc(1008), body])
  return new Uint8Array(file).buffer
}
const PREAMBLE = Buffer.alloc(16) // 글꼴 7종 × 0 + 스타일 0
const END = Buffer.alloc(43) // 문단 리스트 끝 (char_count 0)
const u16 = (codes: number[]): Buffer => {
  const b = Buffer.alloc(codes.length * 2)
  codes.forEach((c, i) => b.writeUInt16LE(c, i * 2))
  return b
}
const ascii = (s: string): number[] => [...s].map(c => c.charCodeAt(0))

/** 문단 조각 — 문자 스트림 바이트 + 그 조각이 차지하는 hchar 수 */
interface Piece { bytes: Buffer; hchars: number }
const text = (s: string): Piece => ({ bytes: u16(ascii(s)), hchars: s.length })
function para(...pieces: Piece[]): Buffer {
  const header = Buffer.alloc(43)
  header[0] = 1 // followPrev=1 → ParaShape 없음
  header.writeUInt16LE(pieces.reduce((s, p) => s + p.hchars, 0), 1)
  return Buffer.concat([header, ...pieces.map(p => p.bytes)])
}
const list = (...paras: Buffer[]): Buffer => Buffer.concat([...paras, END])
const doc = (...paras: Buffer[]): ArrayBuffer => buildHwp3(Buffer.concat([PREAMBLE, list(...paras)]))

/** 8 byte 헤더(ch + u32 + ch2) 제어 문자 — 4 hchar */
function ctrl(ch: number, tail: Buffer): Piece {
  const h = Buffer.alloc(8)
  h.writeUInt16LE(ch, 0)
  h.writeUInt16LE(ch, 6)
  return { bytes: Buffer.concat([h, tail]), hchars: 4 }
}

interface CellSpec { x: number; y: number; w: number; h: number; text: string }
/** ch=10 개체 — 84 byte 정보 + 셀 정보 27 × n + 셀 문단 리스트 n + 캡션 리스트 */
function object(cells: CellSpec[], o: { type?: number; inline?: boolean; opt?: number; caption?: string } = {}): Piece {
  const info = Buffer.alloc(84)
  info[8] = o.inline === false ? 1 : 0
  info.writeUInt16LE(o.opt ?? 0, 14)
  info.writeUInt16LE(o.type ?? 0, 78)
  info.writeUInt16LE(cells.length, 80)
  const cellInfo = Buffer.alloc(27 * cells.length)
  cells.forEach((c, k) => {
    cellInfo.writeUInt16LE(c.x, k * 27 + 4)
    cellInfo.writeUInt16LE(c.y, k * 27 + 6)
    cellInfo.writeUInt16LE(c.w, k * 27 + 8)
    cellInfo.writeUInt16LE(c.h, k * 27 + 10)
  })
  const lists = cells.map(c => (c.text ? list(para(text(c.text))) : END))
  const caption = o.caption ? list(para(text(o.caption))) : END
  return ctrl(10, Buffer.concat([info, cellInfo, ...lists, caption]))
}

const md = (buf: ArrayBuffer): string => parseHwp3Document(buf).markdown
const blocks = (buf: ArrayBuffer): IRBlock[] => parseHwp3Document(buf).blocks
const tableOf = (bs: IRBlock[]) => bs.find(b => b.type === "table")!.table!

// ─── 표 격자 ─────────────────────────────────────────

describe("HWP3 표 — 셀 기하로 격자 복원 (종전: 셀 글을 본문 문단으로 흩뿌림)", () => {
  it("2×2 표 + 캡션", () => {
    const t = tableOf(blocks(doc(para(object([
      { x: 0, y: 0, w: 100, h: 50, text: "A" }, { x: 100, y: 0, w: 100, h: 50, text: "B" },
      { x: 0, y: 50, w: 100, h: 50, text: "C" }, { x: 100, y: 50, w: 100, h: 50, text: "D" },
    ], { inline: false, caption: "Table 1" })))))
    assert.equal(t.rows, 2)
    assert.equal(t.cols, 2)
    assert.deepEqual(t.cells.map(r => r.map(c => c.text)), [["A", "B"], ["C", "D"]])
    assert.equal(t.caption, "Table 1")
  })

  it("병합 — 왼쪽·위 변만 경계, 오른쪽·아래 끝은 이웃의 시작 (한컴 변환본 규칙)", () => {
    // 왼쪽 큰 셀(2행 병합) 높이가 오른쪽 두 칸 합보다 조금 길다 — 아래 변은 경계를 만들지 않는다 (가짜 행 없음)
    const g = hwp3CellGrid(Buffer.concat([
      [0, 0, 100, 230], [100, 0, 100, 100], [100, 100, 100, 100], [0, 230, 200, 50],
    ].map(([x, y, w, h]) => { const b = Buffer.alloc(27); b.writeUInt16LE(x, 4); b.writeUInt16LE(y, 6); b.writeUInt16LE(w, 8); b.writeUInt16LE(h, 10); return b })), 4)
    assert.equal(g.rows, 3)
    assert.equal(g.cols, 2)
    // 경계 y = 0·100·230(+끝 280) — 오른쪽 둘째 칸은 아래 이웃(230)까지 늘어 가짜 행(200~230)이 없다
    assert.deepEqual(g.cells.map(c => [c.row, c.col, c.rowSpan, c.colSpan]), [[0, 0, 2, 1], [0, 1, 1, 1], [1, 1, 1, 1], [2, 0, 1, 2]])
  })

  it("1단위 어긋난 왼쪽 변은 별도 열, 앞 셀 병합은 이웃 시작까지 (sample16 인력 투입표)", () => {
    const g = hwp3CellGrid(Buffer.concat([
      [0, 0, 1869, 50], [1869, 0, 100, 50], [0, 50, 1869, 50], [1870, 50, 99, 50],
    ].map(([x, y, w, h]) => { const b = Buffer.alloc(27); b.writeUInt16LE(x, 4); b.writeUInt16LE(y, 6); b.writeUInt16LE(w, 8); b.writeUInt16LE(h, 10); return b })), 4)
    assert.equal(g.cols, 3)
    assert.deepEqual(g.cells[2], { row: 1, col: 0, rowSpan: 1, colSpan: 2 })
  })

  it("겹친 앵커 셀은 글을 앞 셀에 이어 붙인다 — 글 손실 금지 (rhwp 는 버림)", () => {
    const t = tableOf(blocks(doc(para(object([
      { x: 0, y: 0, w: 100, h: 50, text: "first" }, { x: 0, y: 0, w: 100, h: 50, text: "dup" },
    ], { inline: false })))))
    assert.equal(t.cells[0][0].text, "first\ndup")
  })

  it("글상자(개체 종류 1)·단추(3)는 1×1 표, 글자처럼 취급이면 문단 글을 앞뒤로 나눈다", () => {
    const bs = blocks(doc(para(text("before"), object([{ x: 0, y: 0, w: 100, h: 50, text: "box" }], { type: 1 }), text("after"))))
    assert.deepEqual(bs.map(b => b.type === "table" ? `[${b.table!.cells[0][0].text}]` : b.text), ["before", "[box]", "after"])
  })

  it("하이퍼텍스트 개체(옵션 bit 4)는 표가 아니라 그 자리 글", () => {
    const bs = blocks(doc(para(text("see "), object([{ x: 0, y: 0, w: 100, h: 50, text: "link" }], { type: 3, opt: 0x10 }))))
    assert.equal(bs.some(b => b.type === "table"), false)
    assert.equal(bs[0].text, "see link")
  })

  it("수식(개체 종류 2)은 첫 셀 스크립트를 LaTeX 로 그 자리에", () => {
    // HWP5 EQEDIT 와 같은 변환기(hwpEquationToLatex) — 공백 배치는 변환기 몫
    assert.equal(md(doc(para(text("x "), object([{ x: 0, y: 0, w: 100, h: 50, text: "{a} over {b}" }], { type: 2 })))).replace(/ /g, ""), "x$\\frac{a}{b}$")
  })
})

// ─── 문단 컨트롤 ─────────────────────────────────────

describe("HWP3 문단 컨트롤 — HWP5·HWPX 와 같은 IR", () => {
  it("각주·미주(ch=17): 본문 자리 마커 N) + (주: N) 내용) — 종전엔 내용이 본문 문단 앞에 끼었다", () => {
    const info = Buffer.alloc(14)
    info.writeUInt16LE(3, 8) // 번호
    info.writeUInt16LE(1, 10) // 미주
    const bs = blocks(doc(para(text("body"), ctrl(17, Buffer.concat([info, list(para(text("note")))])), text("."))))
    assert.equal(bs.length, 1)
    assert.equal(bs[0].text, "body3).")
    assert.equal(bs[0].footnoteText, "3) note")
  })

  it("머리말은 본문 앞, 꼬리말은 뒤 1회 — 쪽 번호뿐인 꼬리말(크롬)은 버린다", () => {
    const head = Buffer.alloc(10)
    const foot = Buffer.alloc(10)
    foot[8] = 1
    const pageNo = Buffer.alloc(6) // ch=18 자동번호 종류 0(쪽)
    pageNo.writeUInt16LE(18, 4)
    const out = md(doc(
      para(ctrl(16, Buffer.concat([head, list(para(text("Header")))])), text("body")),
      para(ctrl(16, Buffer.concat([foot, list(para({ bytes: Buffer.concat([u16([18]), pageNo]), hchars: 4 }))])), text("more")),
    ))
    assert.equal(out, "Header\n\nbody\n\nmore")
  })

  it("숨은 설명(ch=15)은 본문에 넣지 않는다", () => {
    const r = parseHwp3Document(doc(para(text("A"), ctrl(15, Buffer.concat([Buffer.alloc(8), list(para(text("secret")))])), text("B"))))
    assert.equal(r.markdown, "AB")
    assert.ok(r.warnings?.some(w => w.code === "HIDDEN_TEXT_FILTERED"))
  })

  it("개요 번호(ch=28): 저장된 수준별 번호로 I./1)/(1)/가. … (종전 U+FFFC — 한컴 변환본도 라틴 I)", () => {
    const outline = (level: number, numbers: number[]): Piece => {
      const b = Buffer.alloc(62)
      b.writeUInt16LE(1, 0)
      b[3] = level
      numbers.forEach((n, k) => b.writeUInt16LE(n, 4 + k * 2))
      return { bytes: Buffer.concat([u16([28]), b]), hchars: 32 }
    }
    const out = md(doc(
      para(outline(0, [1]), text("One")),
      para(outline(2, [1, 1, 2]), text(" Two")),
      para(outline(3, [1, 1, 2, 1]), text("Three")),
    ))
    assert.equal(out, "I. One\n\n(2) Two\n\n가. Three")
  })

  it("채움 탭(점끌기 ≠ 0) 뒤 목차 쪽번호는 자른다, 보통 탭은 남긴다", () => {
    const tab = (leader: number): Piece => ({ bytes: u16([9, 600, leader, 9]), hchars: 4 })
    assert.equal(md(doc(para(text("Chapter"), tab(1), text("12")), para(text("a"), tab(0), text("b")))), "Chapter\n\na\tb")
  })

  it("자동 번호(ch=18) 그림 번호는 저장 번호로 — 종전 공백", () => {
    const fig = Buffer.alloc(6)
    fig.writeUInt16LE(3, 0) // 그림
    fig.writeUInt16LE(2, 2)
    fig.writeUInt16LE(18, 4)
    assert.equal(md(doc(para(text("Fig "), { bytes: Buffer.concat([u16([18]), fig]), hchars: 4 }, text(".")))), "Fig 2.")
  })

  it("마크다운은 builder 로 — 별표 등 GFM 특수문자 이스케이프 (종전 문단 이어붙이기라 '*다만' 이 강조로 먹혔다)", () => {
    assert.equal(md(doc(para(text("*note")))), "\\*note")
  })
})

describe("HWP3 사적 문장부호 — 한컴 변환본 대조 (SO-SUEOP)", () => {
  it("“ ” ‧ 《 》 — ∣ ↳", () => {
    assert.deepEqual([0x3062, 0x3063, 0x3066, 0x30bb, 0x30bd, 0x2014, 0x2223, 0x21b3].map(decodeJohab).map(c => String.fromCodePoint(c)).join(""), "“”‧《》—∣↳")
  })
})
