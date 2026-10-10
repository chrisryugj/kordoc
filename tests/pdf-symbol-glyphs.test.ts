/**
 * 유니코드 없는 기호 글리프(U+F000) 되살리기 — 윤곽 분류는 한컴 PDF 서브셋 글꼴의 실측 점 좌표(청년일자리 회복방안·한성숙 총리
 * 자파로프 회담·노인일자리 보도자료), 되살리기는 최소 TrueType 글꼴을 만들어 글리프 흐름과 아이템 글을 짝짓는다
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { classifyOutline, readOutline, restoreUnmappedGlyphs } from "../src/pdf/symbol-glyphs.js"
import type { PdfTextItem } from "../src/pdf/text-line.js"

type P = [number, number, boolean]
const on = (pts: number[][]): P[] => pts.map(([x, y]) => [x, y, true])

describe("classifyOutline — 모양이 분명한 기호만", () => {
  it("작은 오른쪽 삼각형은 ▸, 큰 것은 ► (겹친 꼭짓점이 있어도)", () => {
    assert.equal(classifyOutline({ upm: 1024, contours: [on([[439, 498], [439, 498], [439, 237], [662, 367]])] }), "▸")
    assert.equal(classifyOutline({ upm: 1000, contours: [on([[593, 320], [377, 192], [377, 451]])] }), "▸")
    assert.equal(classifyOutline({ upm: 1024, contours: [on([[5, 167], [506, 367], [5, 568]])] }), "►")
  })
  it("큰 네모 테두리는 □", () => {
    assert.equal(classifyOutline({ upm: 1000, contours: [on([[30, -60], [30, 880], [970, 880], [970, -60]]), on([[90, 0], [910, 0], [910, 820], [90, 820]])] }), "□")
  })
  it("겹 테두리 모서리 — 위 왼쪽은 《, 아래 오른쪽은 》", () => {
    const open = classifyOutline({ upm: 1024, contours: [
      on([[453, 725], [453, 826], [163, 826], [163, 361], [276, 361], [276, 725]]),
      on([[428, 751], [251, 751], [251, 387], [188, 387], [188, 800], [428, 800]]),
    ] })
    const close = classifyOutline({ upm: 1024, contours: [
      on([[348, -94], [348, 372], [234, 372], [234, 8], [58, 8], [58, -94]]),
      on([[323, -67], [82, -67], [82, -18], [260, -18], [260, 346], [323, 346]]),
    ] })
    assert.equal(open, "《")
    assert.equal(close, "》")
  })
  it("아래 화살표는 ↓", () => {
    assert.equal(classifyOutline({ upm: 1000, contours: [on([[662, 800], [662, 255], [883, 255], [487, -141], [87, 255], [308, 255], [308, 800]])] }), "↓")
  })
  it("칸 채움 막대와 원문자 숫자는 되살리지 않는다", () => {
    assert.equal(classifyOutline({ upm: 1024, contours: [on([[0, 411], [0, 411], [0, 322], [512, 322], [512, 411]])] }), null)
    const ring = (r: number): P[] => [[512 - r, 400, false], [512, 400 + r, false], [512 + r, 400, false], [512, 400 - r, false]]
    assert.equal(classifyOutline({ upm: 1024, contours: [ring(460), ring(400), on([[480, 200], [540, 200], [540, 600], [480, 600]])] }), null)
  })
})

/** 최소 TrueType — cmap 형식 4 로 U+E000 → 글리프 1(단순 윤곽 하나) */
function tinyFont(pts: Array<[number, number]>): Uint8Array {
  const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff]
  const be32 = (v: number) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
  const glyph: number[] = [...be16(1), ...be16(0), ...be16(0), ...be16(1000), ...be16(1000), ...be16(pts.length - 1), ...be16(0)]
  glyph.push(...pts.map(() => 1)) // 모두 곡선 위, x·y 는 2바이트 부호 있는 차분
  let px = 0, py = 0
  for (const [x] of pts) { glyph.push(...be16((x - px) & 0xffff)); px = x }
  for (const [, y] of pts) { glyph.push(...be16((y - py) & 0xffff)); py = y }
  if (glyph.length % 2) glyph.push(0)
  const head = new Array(54).fill(0)
  head.splice(18, 2, ...be16(1000)) // unitsPerEm
  const loca = [...be16(0), ...be16(0), ...be16(glyph.length / 2)] // 짧은 오프셋(÷2)
  const seg = (endc: number, startc: number, delta: number) => ({ endc, startc, delta })
  const segs = [seg(0xe000, 0xe000, (1 - 0xe000) & 0xffff), seg(0xffff, 0xffff, 1)]
  const sub = [...be16(4), ...be16(16 + 8 * segs.length), ...be16(0), ...be16(2 * segs.length), 0, 0, 0, 0, 0, 0]
  for (const s of segs) sub.push(...be16(s.endc))
  sub.push(0, 0)
  for (const s of segs) sub.push(...be16(s.startc))
  for (const s of segs) sub.push(...be16(s.delta))
  for (let k = 0; k < segs.length; k++) sub.push(0, 0)
  const cmap = [...be16(0), ...be16(1), ...be16(3), ...be16(1), ...be32(12), ...sub]
  const tables: Array<[string, number[]]> = [["cmap", cmap], ["glyf", glyph], ["head", head], ["loca", loca]]
  const out: number[] = [...be32(0x00010000), ...be16(tables.length), 0, 0, 0, 0, 0, 0]
  let off = 12 + 16 * tables.length
  const bodies: number[] = []
  for (const [tag, data] of tables) {
    out.push(...[...tag].map(c => c.charCodeAt(0)), 0, 0, 0, 0, ...be32(off), ...be32(data.length))
    bodies.push(...data)
    while (bodies.length % 4) bodies.push(0)
    off = 12 + 16 * tables.length + bodies.length
  }
  return new Uint8Array([...out, ...bodies])
}

describe("restoreUnmappedGlyphs — 글리프 흐름의 F000 을 아이템 글과 짝지어 바꾼다", () => {
  const triangle = tinyFont([[377, 451], [377, 192], [593, 320]])
  const item = (str: string): PdfTextItem => ({ str, transform: [10, 0, 0, 10, 0, 0], width: 10, height: 10, fontName: "f1" })
  const ops = (n: number) => ({
    fnArray: [OPS.setFont, OPS.showText],
    argsArray: [["f1", 10], [Array.from({ length: n }, () => ({ unicode: "", fontChar: "" }))]],
  })
  it("최소 글꼴의 윤곽을 읽는다", () => {
    const o = readOutline(triangle, 0xe000)
    assert.ok(o)
    assert.equal(o.contours.length, 1)
    assert.equal(classifyOutline(o), "▸")
  })
  it("아이템 글의 F000 을 차례로 기호로 바꾼다", () => {
    const items = [item("청년 고용"), item(" 재직자")]
    const { fnArray, argsArray } = ops(2)
    restoreUnmappedGlyphs(items, fnArray, argsArray, () => ({ data: triangle }))
    assert.deepEqual(items.map(i => i.str), ["▸청년 고용", "▸ 재직자"])
  })
  it("두 흐름의 F000 수가 다르면 그 글꼴은 손대지 않는다", () => {
    const items = [item("청년"), item("재직자")]
    const { fnArray, argsArray } = ops(1)
    restoreUnmappedGlyphs(items, fnArray, argsArray, () => ({ data: triangle }))
    assert.deepEqual(items.map(i => i.str), ["청년", "재직자"])
  })
  it("글꼴 데이터가 없거나 모르는 모양이면 F000 그대로(뒤에서 지운다)", () => {
    const items = [item("청년")]
    const { fnArray, argsArray } = ops(1)
    restoreUnmappedGlyphs(items, fnArray, argsArray, () => ({}))
    assert.equal(items[0].str, "청년")
  })
})
