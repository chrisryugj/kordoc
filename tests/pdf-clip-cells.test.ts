/**
 * 법령 별지서식 PDF 파싱 회귀 — 셀 클립 그리드·심볼 폰트 복원·기입 빈칸 보존 (v4.12.1).
 *
 * 법제처 별표서식 PDF(한컴 PDF 1.3) 실측: 외곽 표는 테두리 "없음" 셀이라 획 괘선이 없고
 * 셀마다 `W n` 클립 사각형만 있다. 처리절차 화살표는 Wingdings 0xE8, 기입란은 "년   월   일".
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { OPS } from "pdfjs-dist/legacy/build/pdf.mjs"
import { extractLines } from "../src/pdf/line-extract.js"
import { buildClipCellGrids, dropGridsInside } from "../src/pdf/clip-cells.js"
import { remapSymbolText, symbolFontTable, remapSymbolFontItems } from "../src/pdf/symbol-fonts.js"
import { collapseEvenSpacing } from "../src/pdf/text-line.js"
import { blocksToMarkdown } from "../src/table/builder.js"
import type { LineSegment, TableGrid } from "../src/pdf/line-types.js"

/** pdfjs v4 형식 사각형 클립 경로 ops: constructPath(rect) → eoClip → endPath */
function clipRectOps(x: number, y: number, w: number, h: number): { fn: number[]; args: unknown[][] } {
  return {
    fn: [OPS.constructPath, OPS.eoClip, OPS.endPath],
    args: [[[OPS.rectangle], [x, y, w, h]], [], []],
  }
}
function strokeRectOps(x: number, y: number, w: number, h: number): { fn: number[]; args: unknown[][] } {
  return { fn: [OPS.constructPath, OPS.stroke], args: [[[OPS.rectangle], [x, y, w, h]], []] }
}
function concat(...parts: Array<{ fn: number[]; args: unknown[][] }>) {
  return { fnArray: parts.flatMap(p => p.fn), argsArray: parts.flatMap(p => p.args) }
}

describe("extractLines — 클립 사각형 수집", () => {
  it("clip/eoClip 뒤 endPath 로 끝나는 사각형 경로를 clipRects 로 낸다 (선으로는 안 낸다)", () => {
    const ops = concat(clipRectOps(10, 10, 100, 20), clipRectOps(110, 10, 100, 20))
    const r = extractLines(ops.fnArray, ops.argsArray)
    assert.equal(r.clipRects.length, 2)
    assert.deepEqual(r.clipRects[0], { x1: 10, y1: 10, x2: 110, y2: 30 })
    assert.equal(r.horizontals.length, 0)
    assert.equal(r.verticals.length, 0)
  })

  it("클립 없는 endPath 경로·획 경로는 종전대로 (clipRects 비어 있음)", () => {
    const ops = concat(strokeRectOps(10, 10, 100, 20), { fn: [OPS.constructPath, OPS.endPath], args: [[[OPS.rectangle], [0, 0, 50, 50]], []] })
    const r = extractLines(ops.fnArray, ops.argsArray)
    assert.equal(r.clipRects.length, 0)
    assert.equal(r.horizontals.length, 2)
    assert.equal(r.verticals.length, 2)
  })
})

describe("buildClipCellGrids — 테두리 없는 표 복원", () => {
  // 2행 × 3열 타일 + 병합 셀 1개 (둘째 행 전폭)
  const rects = [
    { x1: 50, y1: 700, x2: 150, y2: 720 }, { x1: 150, y1: 700, x2: 300, y2: 720 }, { x1: 300, y1: 700, x2: 500, y2: 720 },
    { x1: 50, y1: 680, x2: 500, y2: 700 },
  ]

  it("타일링 클립을 셀로 확정한 그리드 — 병합 셀 colSpan 보존, 좌표는 클립 그대로", () => {
    const { grids } = buildClipCellGrids(rects, [], [], 595, 842)
    assert.equal(grids.length, 1)
    const g = grids[0]
    assert.deepEqual(g.colXs, [50, 150, 300, 500])
    assert.deepEqual(g.rowYs, [720, 700, 680])
    const merged = g.cells!.find(c => c.colSpan === 3)
    assert.ok(merged, "둘째 행 전폭 셀은 colSpan 3")
    assert.equal(merged!.row, 1)
    assert.equal(g.cells!.length, 4)
  })

  it("페이지 크기 클립·단독 클립(글상자 하나)은 표가 아니다", () => {
    const { grids } = buildClipCellGrids([{ x1: 0, y1: 0, x2: 595, y2: 842 }, { x1: 100, y1: 100, x2: 300, y2: 150 }], [], [], 595, 842)
    assert.equal(grids.length, 0)
  })

  it("다른 클립을 품는 틀은 자기 층의 셀이고, 안쪽 표는 별도 그리드 — 층이 섞이지 않는다", () => {
    const frame = { x1: 40, y1: 100, x2: 520, y2: 760 }
    const title = { x1: 40, y1: 760, x2: 520, y2: 790 } // 틀 위 제목행 (같은 층 이웃)
    const { grids, containers } = buildClipCellGrids([frame, { ...frame }, title, ...rects], [], [], 595, 842)
    assert.deepEqual(containers, [frame], "틀은 좌표 중복을 제거해 containers 로 보고된다")
    assert.equal(grids.length, 2, "안쪽 셀 그리드 + (제목행+틀) 바깥 그리드")
    const inner = grids.find(g => g.colXs.length === 4)!
    assert.equal(inner.bbox.x1, 50)
    assert.equal(inner.bbox.y2, 720)
    const outer = grids.find(g => g.colXs.length === 2)!
    assert.deepEqual(outer.rowYs, [790, 760, 100])
    assert.equal(outer.cells!.length, 2, "제목행 셀 + 틀 셀 — 안쪽 셀 경계가 바깥 열로 새지 않는다")
  })

  it("클립이 안 덮은 칸은 1×1 빈 셀로 채워 그리드가 온전하다", () => {
    // L자 — (300~500, 680~700) 칸 없음
    const partial = rects.slice(0, 3).concat([{ x1: 50, y1: 680, x2: 300, y2: 700 }])
    const g = buildClipCellGrids(partial, [], [], 595, 842).grids[0]
    assert.equal(g.cells!.length, 5)
    const filler = g.cells!.find(c => c.row === 1 && c.col === 2)
    assert.ok(filler)
    assert.deepEqual(filler!.bbox, { x1: 300, y1: 680, x2: 500, y2: 700 })
  })
})

describe("dropGridsInside — 클립 그리드와 line 그리드 중복 정리", () => {
  const mk = (x1: number, y1: number, x2: number, y2: number, rows = 2, cols = 2): TableGrid => ({
    rowYs: Array.from({ length: rows + 1 }, (_, i) => y2 - ((y2 - y1) * i) / rows),
    colXs: Array.from({ length: cols + 1 }, (_, i) => x1 + ((x2 - x1) * i) / cols),
    bbox: { x1, y1, x2, y2 }, vertexRadius: 1,
  })
  it("클립 그리드 안의 line 그리드와, 틀(container) 안의 line 그리드는 버린다", () => {
    const clip = mk(100, 100, 400, 300)
    const inner = mk(120, 120, 200, 160)
    const frameGrid = mk(50, 50, 500, 700, 3, 3)
    const other = mk(50, 720, 500, 800)
    const kept = dropGridsInside([inner, frameGrid, other], [clip], [{ x1: 50, y1: 50, x2: 500, y2: 700 }])
    assert.deepEqual(kept, [other])
  })
  it("클립 그리드도 틀도 없으면 그대로", () => {
    const g = mk(0, 0, 10, 10)
    assert.deepEqual(dropGridsInside([g], [], []), [g])
  })
})

describe("symbol-fonts — Wingdings 글리프 복원", () => {
  it("Wingdings 0xE8(è) → ➔, 0x6F(o) → □, 0xFC(ü) → ✔", () => {
    const t = symbolFontTable("INPILL+Wingdings-Regular")!
    assert.ok(t)
    assert.equal(remapSymbolText("è", t), "➔")
    assert.equal(remapSymbolText("o", t), "□")
    assert.equal(remapSymbolText("ü", t), "✔")
  })
  it("Wingdings 2·3, 일반 폰트는 표가 없다 (오매핑 방지)", () => {
    assert.equal(symbolFontTable("Wingdings 2"), undefined)
    assert.equal(symbolFontTable("Wingdings-3"), undefined)
    assert.equal(symbolFontTable("INPILL+Dotum"), undefined)
    assert.equal(symbolFontTable(undefined), undefined)
  })
  it("CP1252 로 이미 바뀐 0x80~0x9F 코드도 되돌린다 (0x95 • → Wingdings 0x95)", () => {
    const t = symbolFontTable("Wingdings")!
    assert.equal(remapSymbolText("•", t), t[0x95 - 0x21])
  })
  it("remapSymbolFontItems — 폰트 실명 해석기로 아이템 제자리 치환, 변경 수 반환", () => {
    const items = [
      { text: "è", x: 0, y: 0, w: 5, h: 5, fontSize: 10, fontName: "g_d0_f6", isHidden: false },
      { text: "접수", x: 0, y: 0, w: 5, h: 5, fontSize: 10, fontName: "g_d0_f1", isHidden: false },
    ]
    const n = remapSymbolFontItems(items, id => (id === "g_d0_f6" ? "ABCDEF+Wingdings-Regular" : "Dotum"))
    assert.equal(n, 1)
    assert.equal(items[0].text, "➔")
    assert.equal(items[1].text, "접수")
  })
})

describe("기입 빈칸 '년 월 일' 보존 — 균등배분 정리 예외", () => {
  it("PDF 셀 텍스트: 날짜 단위만 있으면 붙이지 않고, 진짜 균등배분은 붙인다", () => {
    assert.equal(collapseEvenSpacing("년 월 일"), "년 월 일")
    assert.equal(collapseEvenSpacing("시 분"), "시 분")
    assert.equal(collapseEvenSpacing("홍 보 담 당 관"), "홍보담당관")
    assert.equal(collapseEvenSpacing("발급일 년 월 일"), "발급일 년 월 일")
  })
  it("HWP/HWPX 공통 sanitizeText: 표 셀 '년 월 일' 유지, '현 장 대 응 단 장' 은 결합", () => {
    const md = blocksToMarkdown([
      { type: "table", table: { rows: 2, cols: 1, cells: [[{ text: "년 월 일", colSpan: 1, rowSpan: 1 }], [{ text: "현 장 대 응 단 장", colSpan: 1, rowSpan: 1 }]] } },
    ])
    assert.match(md, /년 월 일/)
    assert.match(md, /현장대응단장/)
  })
})

describe("1열 다행 표 — 셀 안 줄바꿈을 줄로 보존", () => {
  it("청구서류 1열 틀 표의 기입 항목이 한 줄로 뭉개지지 않는다", () => {
    const md = blocksToMarkdown([
      { type: "table", table: { rows: 2, cols: 1, cells: [[{ text: "요양보상청구서", colSpan: 1, rowSpan: 1 }], [{ text: "1. 소속 및 신분\n2. 성명\n3. 상병명", colSpan: 1, rowSpan: 1 }]] } },
    ])
    assert.equal(md.trim(), "요양보상청구서\n1. 소속 및 신분\n2. 성명\n3. 상병명")
  })
})

// LineSegment 타입 사용 확인 (미사용 import 방지)
const _seg: LineSegment = { x1: 0, y1: 0, x2: 1, y2: 0, lineWidth: 1, fromFill: false }
void _seg
