/**
 * 보이지 않는 틀 표 풀기 (v4.17.0) — 테두리 없는 틀은 글로, 선이 보이는 행 띠만 표로, 칸으로 조립한 분수는 수식으로.
 * 법령 별표 272건 중 103건이 본문 전체를 안 보이는 틀 표에 담는다(할부거래법 시행령 [별표 1]·대기환경보전법 시행령 [별표 8]).
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { CELL_BASELINES, CELL_EDGES, unframeLayoutTables, type Edges } from "../src/table/layout-frames.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import JSZip from "jszip"
import { extractHwpxStyles } from "../src/hwpx/styles.js"
import { parseSectionXml } from "../src/hwpx/section-walker.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"

const NONE: Edges = { t: false, b: false, l: false, r: false }
const BOX: Edges = { t: true, b: true, l: true, r: true }

/** [글, colSpan, rowSpan, 변] 행 목록 → IR 표. 위 행 병합에 덮인 자리는 건너뛰고 다음 칸을 놓는다 */
function table(rows: Array<Array<[string, number, number, Edges]>>, cols: number): IRTable {
  const cells: IRCell[][] = rows.map(() => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  rows.forEach((row, r) => {
    let c = 0
    for (const spec of row) {
      while (c < cols && cells[r][c].text === "\u0000") c++
      const [text, cs, rs, e] = spec
      const cell: IRCell = { text, colSpan: cs, rowSpan: rs }
      cells[r][c] = cell
      CELL_EDGES.set(cell, e)
      for (let dr = 0; dr < rs; dr++) for (let dc = 0; dc < cs; dc++) if (dr || dc) cells[r + dr][c + dc] = { text: "\u0000", colSpan: 1, rowSpan: 1 }
      c += cs
    }
  })
  for (const row of cells) for (const cell of row) if (cell.text === "\u0000") cell.text = ""
  return { rows: rows.length, cols, cells, hasHeader: true }
}

const md = (blocks: IRBlock[]): string => blocksToMarkdown(unframeLayoutTables(blocks))

describe("unframeLayoutTables", () => {
  it("선 없는 틀 안 분수 → 문단 + $\\frac$", () => {
    // 할부거래법 [별표 1] 모양: 1열 전폭 글 행 + "가. …A=P×r×"(2행 병합) 옆 분자/분모 칸, 둘 사이 가로선만
    const t = table([
      [["■ 할부거래에 관한 법률 시행령 [별표 1]", 3, 1, NONE]],
      [["가. 복리 계산방법: A=P×r×", 1, 2, NONE], ["(1+r)<sup>n</sup>", 2, 1, { ...NONE, b: true }]],
      [["(1+r)<sup>n</sup>-1", 2, 1, NONE]],
    ], 3)
    const out = md([{ type: "table", table: t }])
    assert.ok(!out.includes("<table"), out)
    assert.match(out, /가\. 복리 계산방법: A=P×r× \$\\frac\{\(1\+r\)\^\{n\}\}\{\(1\+r\)\^\{n\}-1\}\$/)
  })

  it("틀 안 보이는 표 띠만 표로 — 앞뒤 글 행은 문단, 선 밖 빈 들여쓰기 칸은 버림", () => {
    const t = table([
      [["1. 측정 결과가 없는 시설", 4, 1, NONE]],
      [["", 1, 2, NONE], ["구분", 1, 2, BOX], ["황함유량(%)", 2, 1, BOX]],
      [["0.5% 이하", 1, 1, BOX], ["1.0% 초과", 1, 1, BOX]],
      [["", 1, 1, NONE], ["부과계수", 1, 1, BOX], ["0.2", 1, 1, BOX], ["1.0", 1, 1, BOX]],
      [["비고: 가목 외 0.15", 4, 1, NONE]],
    ], 4)
    const blocks = unframeLayoutTables([{ type: "table", table: t }])
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "table", "paragraph"])
    const sub = blocks[1].table!
    assert.equal(sub.rows, 3)
    assert.equal(sub.cols, 3)
    assert.equal(sub.cells[0][0].text, "구분")
    assert.equal(sub.cells[0][0].rowSpan, 2)
    assert.equal(sub.cells[0][1].colSpan, 2)
  })

  it("선이 모두 보이는 표는 그대로 (같은 객체)", () => {
    const t = table([
      [["위반행위", 1, 1, BOX], ["과징금", 1, 1, BOX]],
      [["가. …", 1, 1, BOX], ["100만원", 1, 1, BOX]],
    ], 2)
    const blocks: IRBlock[] = [{ type: "table", table: t }]
    const out = unframeLayoutTables(blocks)
    assert.equal(out[0].table, t)
  })

  it("가로선만 긋는 표(booktabs)는 표로 남는다 — 온 폭 가로선 사이 칸 둘 이상", () => {
    const H: Edges = { t: true, b: true, l: false, r: false }
    const t = table([
      [["구분", 1, 1, H], ["금액", 1, 1, H]],
      [["가", 1, 1, H], ["10", 1, 1, H]],
    ], 2)
    assert.equal(unframeLayoutTables([{ type: "table", table: t }])[0].table, t)
  })

  it("가로선이 옆 칸까지 이어지면 분수가 아니다", () => {
    const B: Edges = { ...NONE, b: true }
    const t = table([
      [["a", 1, 1, B], ["b", 1, 1, B]],
      [["c", 1, 1, NONE], ["d", 1, 1, NONE]],
    ], 2)
    const out = md([{ type: "table", table: t }])
    assert.ok(!out.includes("\\frac"), out)
  })

  it("선이 다 보이는 표도 안 쓰는 격자선은 접는다 — 모양이 바뀌면 새 표, 속성은 유지", () => {
    // 3열 격자인데 모든 칸이 0~1열을 병합 — 1열 경계를 어느 칸도 안 쓴다
    const t = table([
      [["등급", 2, 1, BOX], ["금액", 1, 1, BOX]],
      [["1", 2, 1, BOX], ["23,000", 1, 1, BOX]],
    ], 3)
    t.sourceId = "tbl-1"
    const out = unframeLayoutTables([{ type: "table", table: t }])
    assert.equal(out.length, 1)
    assert.equal(out[0].table!.cols, 2)
    assert.equal(out[0].table!.sourceId, "tbl-1")
    assert.equal(out[0].table!.cells[0][0].colSpan, 1)
  })

  it("선 없이 붙은 빈 여백 행은 접는다 (A1)", () => {
    const V: Edges = { t: false, b: false, l: true, r: true }
    const t = table([
      [["구분", 1, 1, BOX], ["값", 1, 1, BOX]],
      [["", 1, 1, V], ["", 1, 1, V]],
      [["가", 1, 1, { ...V, b: true }], ["1", 1, 1, { ...V, b: true }]],
    ], 2)
    // 둘째 행: 세로선만 있고 윗선(첫 행 아랫변)이 보여 여백 행이 아니다 — 첫 행 아랫변을 지워 여백 행으로 만든다
    CELL_EDGES.set(t.cells[0][0], { ...BOX, b: false })
    CELL_EDGES.set(t.cells[0][1], { ...BOX, b: false })
    const out = unframeLayoutTables([{ type: "table", table: t }])
    assert.equal(out[0].table!.rows, 2)
    assert.equal(out[0].table!.cells[1][0].text, "가")
  })

  it("표 온 폭 두 칸 분수는 칸 두 개짜리 표일 때만 (P1)", () => {
    const B: Edges = { ...NONE, b: true }
    const form = table([
      [["위와 같이 신청합니다.", 2, 1, B]],
      [["○○시장 귀하", 2, 1, NONE]],
      [["첨부", 1, 1, NONE], ["없음", 1, 1, NONE]],
    ], 2)
    assert.ok(!md([{ type: "table", table: form }]).includes("\\frac"))
    // 왼쪽에 빈 여백 열이 하나 있어도 온 폭과 같다 (임금채권보장법 시행규칙 재산목록 "…장 귀하" / "210mm×297mm")
    const margin = table([
      [["", 1, 1, NONE], ["재산목록 본문 칸", 4, 1, { ...BOX, b: false }]],
      [["", 1, 1, NONE], ["○○지방고용노동청(지청)장 귀하", 4, 1, B]],
      [["", 1, 1, NONE], ["210mm×297mm(백상지 80g/㎡)", 4, 1, NONE]],
    ], 5)
    assert.ok(!md([{ type: "table", table: margin }]).includes("\\frac"))
    const frac = table([[["F", 1, 1, B]], [["P", 1, 1, NONE]]], 1)
    assert.match(md([{ type: "table", table: frac }]), /\$\\frac\{F\}\{P\}\$/)
  })

  it("테두리 정보 없는 표(다른 포맷)는 손대지 않는다", () => {
    const t: IRTable = { rows: 1, cols: 2, cells: [[{ text: "a", colSpan: 1, rowSpan: 1 }, { text: "b", colSpan: 1, rowSpan: 1 }]], hasHeader: false }
    assert.equal(unframeLayoutTables([{ type: "table", table: t }])[0].table, t)
  })

  it("칸 안 중첩표는 재귀로 — 선 없는 틀 칸의 보이는 중첩표는 표로 남는다", () => {
    const inner = table([[["x", 1, 1, BOX], ["y", 1, 1, BOX]]], 2)
    const outer = table([[["머리말", 1, 1, NONE]], [["", 1, 1, NONE]]], 1)
    outer.cells[1][0].blocks = [{ type: "paragraph", text: "안 글" }, { type: "table", table: inner }]
    const blocks = unframeLayoutTables([{ type: "table", table: outer }])
    assert.deepEqual(blocks.map(b => b.type), ["paragraph", "paragraph", "table"])
    assert.equal(blocks[2].table, inner)
  })

  it("목차 행은 제목 줄과 쪽 번호 줄을 기준선으로 짝짓는다 — 장 제목은 홀로 (현장실습 매뉴얼 목차 \"…운영지원 2 8\")", () => {
    const t = table([[["", 1, 1, NONE], ["Ⅰ. 직업계고 현장실습의 개요\n1. 직업계고 현장실습의 이해\n2. 현장실습 운영지원", 1, 1, NONE], ["2\n8", 1, 1, NONE]]], 3)
    CELL_BASELINES.set(t.cells[0][1], [583, 564, 545])
    CELL_BASELINES.set(t.cells[0][2], [563, 547])
    const texts = unframeLayoutTables([{ type: "table", table: t }]).map(b => b.text)
    assert.deepEqual(texts, ["Ⅰ. 직업계고 현장실습의 개요", "1. 직업계고 현장실습의 이해 2", "2. 현장실습 운영지원 8"])
    // 기준선이 없거나(다른 포맷) 짝이 안 맞으면 종전대로 한 문단
    const u = table([[["가\n나", 1, 1, NONE], ["2\n8", 1, 1, NONE]]], 2)
    CELL_BASELINES.set(u.cells[0][0], [583, 564])
    CELL_BASELINES.set(u.cells[0][1], [520, 500])
    assert.deepEqual(unframeLayoutTables([{ type: "table", table: u }]).map(b => b.text), ["가 나 2 8"])
  })
})

describe("HWPX borderFill → 보이는 대로", () => {
  // borderFill 1 = 네 변 NONE, 2 = 아래 변만 SOLID(분자 칸), 3 = 흰 SOLID(안 보임)
  const edge = (side: string, type: string, color = "#000000") => `<hh:${side}Border type="${type}" width="0.12 mm" color="${color}"/>`
  const bf = (id: number, b: string, rest = "NONE", color = "#000000") =>
    `<hh:borderFill id="${id}">${edge("left", rest, color)}${edge("right", rest, color)}${edge("top", rest, color)}${edge("bottom", b, color)}</hh:borderFill>`
  const header = `<?xml version="1.0" encoding="UTF-8"?>
<hh:head xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" version="1.4"><hh:refList><hh:borderFills>
${bf(1, "NONE")}${bf(2, "SOLID")}${bf(3, "SOLID", "SOLID", "#FFFFFF")}
</hh:borderFills></hh:refList></hh:head>`
  const tc = (bfId: number, c: number, r: number, cs: number, rs: number, t: string) =>
    `<hp:tc borderFillIDRef="${bfId}"><hp:subList><hp:p><hp:run><hp:t>${t}</hp:t></hp:run></hp:p></hp:subList><hp:cellAddr colAddr="${c}" rowAddr="${r}"/><hp:cellSpan colSpan="${cs}" rowSpan="${rs}"/></hp:tc>`
  const sec = `<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"><hp:p><hp:run><hp:tbl rowCnt="3" colCnt="2">
<hp:tr>${tc(3, 0, 0, 2, 1, "나. 단리 계산방법")}</hp:tr>
<hp:tr>${tc(1, 0, 1, 1, 2, "R=")}${tc(2, 1, 1, 1, 1, "F")}</hp:tr>
<hp:tr>${tc(1, 1, 2, 1, 1, "P")}</hp:tr>
</hp:tbl></hp:run></hp:p></hs:sec>`

  it("흰 선·NONE 틀은 글, 칸 사이 가로선 하나는 분수", async () => {
    const zip = new JSZip()
    zip.file("Contents/header.xml", header)
    const styles = await extractHwpxStyles(zip)
    assert.deepEqual(styles.borderEdges.get("2"), { t: false, b: true, l: false, r: false })
    assert.deepEqual(styles.borderEdges.get("3"), NONE)
    const blocks = parseSectionXml(sec, styles)
    assert.equal(blocks[0].type, "table")
    const out = blocksToMarkdown(unframeLayoutTables(blocks))
    assert.ok(!out.includes("<table") && !out.includes("| --- |"), out)
    assert.match(out, /나\. 단리 계산방법/)
    assert.match(out, /R= \$\\frac\{F\}\{P\}\$/)
  })
  it("테두리 참조 0은 명시적 선 없음이고 미등록 양수 참조는 미상으로 남는다", async () => {
    const zip = new JSZip()
    zip.file("Contents/header.xml", header)
    const styles = await extractHwpxStyles(zip)
    assert.deepEqual(styles.borderEdges.get("0"), NONE)
    assert.equal(styles.borderEdges.get("99"), undefined)
    const blocks = parseSectionXml(sec.replace(/borderFillIDRef="[13]"/g, 'borderFillIDRef="0"'), styles)
    assert.match(blocksToMarkdown(unframeLayoutTables(blocks)), /R= \$\\frac\{F\}\{P\}\$/)
    const unknown = parseSectionXml(sec.replace(/borderFillIDRef="[13]"/g, 'borderFillIDRef="99"'), styles)
    assert.equal(CELL_EDGES.get(unknown[0].table!.cells[0][0]), undefined)
  })
  it("접두사 없는 헤더의 테두리 정의도 참조 0 기본값에 가려지지 않는다", async () => {
    const zip = new JSZip()
    zip.file("Contents/header.xml", header.replace(/hh:/g, ""))
    const styles = await extractHwpxStyles(zip)
    assert.deepEqual(styles.borderEdges.get("2"), { t: false, b: true, l: false, r: false })
    assert.deepEqual(styles.borderEdges.get("0"), NONE)
  })
  it("테두리 정의가 없는 문서는 참조 0도 미상이고 원래 격자를 보존한다", async () => {
    const styles = await extractHwpxStyles(new JSZip())
    assert.equal(styles.borderEdges.get("0"), undefined)
    const blocks = parseSectionXml(sec.replace(/borderFillIDRef="[123]"/g, 'borderFillIDRef="0"'), styles)
    assert.equal(unframeLayoutTables(blocks)[0].table, blocks[0].table)
  })
})

describe("패치 편집본 모드 판별 (editedFromVisual)", () => {
  it("틀 표가 있는 문서에서 기본(visual) 출력을 고친 편집본을 가려낸다", async () => {
    const { editedFromVisual } = await import("../src/roundtrip/markdown-units.js")
    const keep = "<table>\n<tr><th>■ 별표 1</th></tr>\n<tr><td>가. 첫째</td></tr>\n</table>"
    const visual = "■ 별표 1\n\n가. 첫째"
    assert.equal(editedFromVisual(keep, visual, "■ 별표 1\n\n가. 고친 첫째"), true)
    assert.equal(editedFromVisual(keep, visual, keep.replace("첫째", "고친 첫째")), false)
    // 틀 표가 없는 문서(두 출력이 같음)는 늘 keep 경로
    assert.equal(editedFromVisual(visual, visual, "■ 별표 1\n\n가. 고친 첫째"), false)
  })
})
