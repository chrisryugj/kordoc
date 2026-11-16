import { it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { OPS } from "../src/pdf/ops.js"
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import { takeFrameSpanningText } from "../src/pdf/frame-cell-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"

const word = (text: string, x: number, y: number, w: number, fs = 10): NormItem =>
  ({ text, x, y, w, h: fs, fontSize: fs, fontName: "F", isHidden: false })
const extract = (items: NormItem[], frames: number[][], width = 842, height = 595) =>
  extractPageBlocksWithLines(items, 1, {
    fnArray: frames.flatMap(() => [OPS.constructPath, OPS.stroke]),
    argsArray: frames.flatMap(frame => [[[OPS.rectangle], frame], []]),
  }, width, height)

it("reads a continuous title above framed panels before every panel", () => {
  const title = [word("2010", 107, 532, 103, 40), word("FIFA", 226, 532, 79, 40),
    word("South Africa", 311, 532, 105, 40), word("World Cup Finals", 422, 532, 182, 40),
    word("Groups", 619, 532, 105, 40)].map(item => ({ ...item, hasSpaceBefore: true }))
  const frames = Array.from({ length: 8 }, (_, i) => [34 + i * 98.5, 33, 90.6, 454])
  const items = [...title, ...frames.flatMap((frame, i) => [467, 418, 332, 210, 123]
    .map((y, r) => word(r ? `Country ${i}-${r}` : `Group ${i}`, frame[0] + 25, y, 40, r ? 10 : 14)))]
  const texts = extract(items, frames).map(b => b.text ?? "").join(" ")
  assert.ok(texts.indexOf("Groups") < texts.indexOf("Group 0"), texts)
  assert.match(texts, /FIFA South Africa World Cup Finals/)
  assert.ok(texts.indexOf("Country 0-4") < texts.indexOf("Group 1"), texts)
})

it("keeps full-width bullets and their wrapped tails around a framed diagram", () => {
  const frames = Array.from({ length: 12 }, (_, i) => [75 + i * 35, 330, 30, 210])
  const diagram = frames.map((frame, i) => word(`Step ${i}.`, frame[0] + 2, frame[1] + 10, 24))
  const items = [word("-", 96, 653, 6, 11), word("First complete long body sentence", 105, 653, 382, 11),
    word("with its wrapped ending.", 106, 636, 102, 11), word("-", 96, 617, 6, 11),
    word("Second complete long body sentence", 105, 617, 382, 11), word("and its own ending.", 106, 600, 92, 11),
    word("Diagram", 100, 572, 94, 13), ...diagram,
    ...[280, 224, 185, 146].flatMap((y, i) => [word(`① Section ${i}`, 100, y, 140, 13),
      word("-", 96, y - 20, 6, 11), word(`Explanation ${i} must remain here.`, 105, y - 20, 380, 11)])]
  const texts = extract(items, frames, 595, 842).map(b => b.text ?? "")
  assert.ok(texts.some(t => /First complete long body sentence.*with its wrapped ending/s.test(t)), texts.join("\n"))
  assert.ok(texts.some(t => /Second complete long body sentence.*and its own ending/s.test(t)), texts.join("\n"))
  const joined = texts.join("\n")
  for (let i = 0; i < 3; i++) assert.ok(joined.indexOf(`Explanation ${i}`) < joined.indexOf(`Section ${i + 1}`), joined)
})

it("keeps native one-column prose around an irregular closed flowchart", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/pdf-frame-prose-band.json", import.meta.url), "utf8"))
  const blocks = extractPageBlocksWithLines(fixture.items, 121, fixture.ops, 595, 842)
  const texts = blocks.map(b => b.text ?? "").join("\n")
  assert.match(texts, /- 전자적 형태[^\n]*확인 등의 검수절차 수행/)
  assert.match(texts, /- 기록물 진본확인[^\n]*수정·보완한 후 재이관/)
  assert.ok(blocks.filter(b => b.text?.startsWith("- ")).every(b => b.type === "list"))
  assert.ok(texts.indexOf("보유 기록물") < texts.indexOf("② 이관연장"), texts)
  assert.ok(texts.indexOf("특수기록관 소관") < texts.indexOf("③ 이관목록"), texts)
  assert.ok(texts.indexOf("국가기록원에서 검토") < texts.indexOf("④ 이관대상"), texts)
})

it("retains the unordered-list role of full-width warning paragraphs", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/pdf-frame-prose-band.json", import.meta.url), "utf8"))
  const marker = fixture.items.find((i: NormItem) => i.text === "-" && i.y > 650)
  assert.ok(marker)
  marker.text = "※"
  const warning = extractPageBlocksWithLines(fixture.items, 121, fixture.ops, 595, 842)
    .find(b => b.text?.startsWith("※"))
  assert.equal(warning?.type, "list")
  assert.equal(warning?.listType, "unordered")
})

it("does not reinterpret an overflowing line in independently established prose columns", () => {
  const items = Array.from({ length: 30 }, (_, i) => [
    word(`Left paragraph ${i}.`, 30, 760 - i * 20, i === 20 ? 280 : 220),
    word(`Right paragraph ${i}.`, 310, 750 - i * 20, 220),
  ]).flat()
  const original = [...items]
  assert.deepEqual(takeFrameSpanningText(items, 300, 1), [])
  assert.deepEqual(items, original)
})

it("leaves same-baseline independent columns and a neighboring column's next line separate", () => {
  const items = [word("Left column", 30, 700, 220), word("Right column", 280, 700, 220),
    word("Spanning prose", 30, 650, 400), word("left continuation", 30, 635, 130),
    word("independent right paragraph", 280, 635, 220)]
  const original = [...items]
  const spanning = takeFrameSpanningText(items, 270, 1)
  assert.deepEqual(spanning.map(b => b.text), ["Spanning prose"])
  assert.deepEqual(items, original.filter(i => i.text !== "Spanning prose"))
})
