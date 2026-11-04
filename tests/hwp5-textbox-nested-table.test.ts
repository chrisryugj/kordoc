/**
 * 글상자(사각형 drawText) 안 결재표의 칸 속 작은 표(서명·체크 칸).
 * 결재표 마지막 열 칸에 빈 작은 표만 들면 칸 글이 비어, 표 빌더의 후행 빈 열 자르기가 그 열을 통째로 잘랐다 —
 * HWP 는 그 열의 중첩표가 사라지고(실제 공문 1건 16개 중 4개가 빠져 12개만 남음), HWPX 는 칸 주소가 잘린 열을 가리켜 서수 폴백으로
 * 엉뚱한 칸에 붙었다. 픽스처는 합성 HWPX(make-source.mjs)를 한/글로 HWP 저장(textbox-nested.hwp)하고, 그 HWP 를
 * 다시 한/글로 HWPX 저장한 정답(textbox-nested.hwpx) — tests/fixtures/textbox-nested/README.md
 */
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "fs"
import { dirname, resolve } from "path"
import { fileURLToPath } from "url"
import JSZip from "jszip"
import { parse } from "../src/index.js"
import { buildTable } from "../src/table/builder.js"
import type { CellContext, IRBlock, IRTable } from "../src/types.js"

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/textbox-nested")
const HWP = readFileSync(resolve(DIR, "textbox-nested.hwp"))
const HWPX = readFileSync(resolve(DIR, "textbox-nested.hwpx"))
const ab = (b: Buffer): ArrayBuffer => new Uint8Array(b).buffer

/** 한/글 HWPX 정답: 바깥 표 크기, 칸 주소별 직계 중첩표 수, 글 조각 */
async function answerKey() {
  const xml = await (await JSZip.loadAsync(HWPX)).file("Contents/section0.xml")!.async("string")
  let depth = 0, inRect = false, inT = false, run = "", cellTables = 0
  let outer = ""
  const perCell = new Map<string, number>()
  const texts: string[] = []
  const re = /<(\/?)hp:(rect|tbl|tc|cellAddr|t)\b([^>]*?)(\/?)>|([^<]+)/g
  for (let m; (m = re.exec(xml));) {
    const [, close, tag, attrs, self, text] = m
    if (text !== undefined) { if (inT) run += text; continue }
    if (tag === "rect") inRect = !close
    else if (tag === "tbl" && !self) {
      if (close) depth--
      else {
        depth++
        if (depth === 1 && inRect) outer = `${/rowCnt="(\d+)"/.exec(attrs)![1]}x${/colCnt="(\d+)"/.exec(attrs)![1]}`
        if (depth === 2 && inRect) cellTables++
      }
    } else if (tag === "tc" && depth === 1 && !close) cellTables = 0
    else if (tag === "cellAddr" && depth === 1 && inRect && cellTables) {
      perCell.set(`${/rowAddr="(\d+)"/.exec(attrs)![1]},${/colAddr="(\d+)"/.exec(attrs)![1]}`, cellTables)
    } else if (tag === "t") {
      if (close && run.trim()) texts.push(run.trim())
      run = ""
      inT = !close && !self
    }
  }
  return { outer, perCell, nested: [...perCell.values()].reduce((s, n) => s + n, 0), texts }
}

function nestedCount(blocks: IRBlock[] | undefined, depth = 0): number {
  let n = 0
  for (const b of blocks ?? []) {
    if (b.type !== "table" || !b.table) continue
    if (depth >= 1) n++
    for (const row of b.table.cells) for (const c of row) n += nestedCount(c.blocks, depth + 1)
  }
  return n
}

/** 표의 칸 주소별 직계 중첩표 수 */
function perCellTables(t: IRTable): Map<string, number> {
  const out = new Map<string, number>()
  t.cells.forEach((row, r) => row.forEach((c, col) => {
    const n = (c.blocks ?? []).filter(b => b.type === "table").length
    if (n) out.set(`${r},${col}`, n)
  }))
  return out
}

const tables = (blocks: IRBlock[]): IRTable[] => blocks.filter(b => b.type === "table" && b.table).map(b => b.table!)
const norm = (s: string): string => s.replace(/[^\p{L}\p{N}]+/gu, "")

describe("글상자 안 결재표의 중첩표 (HWP·HWPX)", () => {
  it("정답(한/글 HWPX): 바깥 표 4×6, 중첩표 12개 — 마지막 열(5) 네 칸이 빈 작은 표만 품는다", async () => {
    const key = await answerKey()
    assert.equal(key.outer, "4x6")
    assert.equal(key.nested, 12)
    for (const r of [0, 1, 2, 3]) assert.equal(key.perCell.get(`${r},5`), 2, `칸 ${r},5`)
  })

  for (const [label, buf] of [["HWP", HWP], ["HWPX", HWPX]] as const) {
    it(`${label} layoutTables keep: 바깥 표 4×6, 중첩표 12개가 정답과 같은 칸에`, async () => {
      const key = await answerKey()
      const res = await parse(ab(buf), { layoutTables: "keep" })
      assert.ok(res.success)
      const [outer] = tables(res.blocks)
      assert.equal(`${outer.rows}x${outer.cols}`, key.outer)
      assert.equal(nestedCount(res.blocks), key.nested)
      assert.deepEqual(perCellTables(outer), key.perCell)
      for (const t of key.texts) assert.ok(norm(res.markdown).includes(norm(t)), t)
    })

    it(`${label} 기본(layoutTables visual): 보이는 테두리 표라 중첩표 12개 그대로, 안 쓰는 열 경계 2|3 만 접어 4×5`, async () => {
      const key = await answerKey()
      const res = await parse(ab(buf))
      assert.ok(res.success)
      const [outer] = tables(res.blocks)
      assert.equal(`${outer.rows}x${outer.cols}`, "4x5")
      assert.equal(nestedCount(res.blocks), key.nested)
      for (const r of [0, 1, 2, 3]) assert.equal(perCellTables(outer).get(`${r},4`), 2, `칸 ${r},4`)
      for (const t of key.texts) assert.ok(norm(res.markdown).includes(norm(t)), t)
    })
  }

  it("HWP 와 HWPX 의 표 IR 이 같다 (keep·기본)", async () => {
    for (const opts of [{ layoutTables: "keep" as const }, {}]) {
      const a = await parse(ab(HWP), opts), b = await parse(ab(HWPX), opts)
      const shape = (bl: IRBlock[]) => tables(bl).map(t => [t.rows, t.cols, [...perCellTables(t)]])
      assert.deepEqual(shape(a.blocks), shape(b.blocks))
    }
  })
})

describe("표 빌더 후행 빈 열 — 중첩표 앵커", () => {
  const cell = (text: string, colAddr: number, rowAddr: number, blocks?: IRBlock[]): CellContext =>
    ({ text, colSpan: 1, rowSpan: 1, colAddr, rowAddr, ...(blocks ? { blocks } : {}) }) as CellContext
  const emptyBox: IRBlock = { type: "table", table: { rows: 1, cols: 1, hasHeader: false, cells: [[{ text: "", colSpan: 1, rowSpan: 1 }]] } }

  it("글 없는 칸이 빈 중첩표를 품으면 그 열을 자르지 않는다", () => {
    const t = buildTable([[cell("결재", 0, 0), cell("", 1, 0, [emptyBox])], [cell("담당", 0, 1), cell("", 1, 1)]])
    assert.equal(t.cols, 2)
  })

  it("정말 빈 후행 열은 종전대로 자른다", () => {
    const t = buildTable([[cell("결재", 0, 0), cell("", 1, 0)], [cell("담당", 0, 1), cell("", 1, 1)]])
    assert.equal(t.cols, 1)
  })

  it("주소 없는 순차 배치 경로도 같다", () => {
    const seq = (text: string, blocks?: IRBlock[]): CellContext => ({ text, colSpan: 1, rowSpan: 1, ...(blocks ? { blocks } : {}) }) as CellContext
    assert.equal(buildTable([[seq("결재"), seq("", [emptyBox])]]).cols, 2)
    assert.equal(buildTable([[seq("결재"), seq("")]]).cols, 1)
  })
})
