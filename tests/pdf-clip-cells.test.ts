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
import { extractPageBlocksWithLines } from "../src/pdf/page-blocks.js"
import type { NormItem } from "../src/pdf/text-line.js"
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

  it("테두리 없는 틀 — 제목 아래(윗변 ≥ 20%)에서 시작하고 위에 본문 글이 있으면 1×1 틀 (별표·선서문 바깥 틀, v4.12.3)", () => {
    // 별표: 제목 두 줄(y≈150·180) 아래 y=270 부터 틀, 안에 중첩 클립 하나 + 글
    const frame = { x1: 58, y1: 270, x2: 508, y2: 760 }
    const inner = { x1: 100, y1: 400, x2: 300, y2: 420 }
    const text = [{ x: 200, y: 150 }, { x: 200, y: 180 }, { x: 200, y: 500 }]
    const { grids } = buildClipCellGrids([frame, inner], [], [], 595, 842, text)
    assert.equal(grids.length, 1, "획 없는 틀이지만 제목 아래 틀은 1×1 그리드")
    assert.deepEqual(grids[0].bbox, frame)
  })

  it("본문 영역 클립 — 여백 바로 안쪽(y1 ≈ 9%)에서 시작하고 바깥 글은 머리말뿐이면 틀이 아니다 (채용공고 회귀 방어)", () => {
    const body = { x1: 58, y1: 73, x2: 534, y2: 769 }
    const inner = { x1: 100, y1: 400, x2: 300, y2: 420 }
    const text = [{ x: 300, y: 40 }, { x: 200, y: 500 }, { x: 300, y: 800 }] // 머리말·본문·쪽번호
    const { grids } = buildClipCellGrids([body, inner], [], [], 595, 842, text)
    assert.equal(grids.length, 0)
    // 틀 위 글이 있어도 윗변이 20% 위면(머리말 영역 큰 문서) 본문 영역으로 본다
    const lowTop = { x1: 58, y1: 150, x2: 534, y2: 769 }
    assert.equal(buildClipCellGrids([lowTop, inner], [], [], 595, 842, [{ x: 200, y: 120 }, { x: 200, y: 500 }]).grids.length, 0)
    // 2단 배치의 단 상자(폭 38%)는 위에 글이 있어도 틀이 아니다 (채용공고 pair06 실측)
    const column = { x1: 468, y1: 127, x2: 795, y2: 497 }
    const colInner = { x1: 500, y1: 200, x2: 700, y2: 220 }
    assert.equal(buildClipCellGrids([column, colInner], [], [], 842, 595, [{ x: 600, y: 100 }, { x: 600, y: 300 }]).grids.length, 0)
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

describe("buildClipCellGrids — 1칸 틀·중첩표 (v4.12.2)", () => {
  // 지정서: 제목행 + 틀(테두리 획) + 꼬리행 3×1, 틀 안 "발신명의 | 직인" 1×2
  const title = { x1: 44, y1: 767, x2: 523, y2: 797 }
  const frame = { x1: 44, y1: 78, x2: 523, y2: 767 }
  const footer = { x1: 44, y1: 47, x2: 523, y2: 78 }
  const sealL = { x1: 166, y1: 141, x2: 336, y2: 209 }
  const sealR = { x1: 336, y1: 141, x2: 404, y2: 209 }
  const strokeOf = (r: { x1: number; y1: number; x2: number; y2: number }): { h: LineSegment[]; v: LineSegment[] } => ({
    h: [{ x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y1, lineWidth: 0.4 }, { x1: r.x1, y1: r.y2, x2: r.x2, y2: r.y2, lineWidth: 0.4 }],
    v: [{ x1: r.x1, y1: r.y1, x2: r.x1, y2: r.y2, lineWidth: 0.4 }, { x1: r.x2, y1: r.y1, x2: r.x2, y2: r.y2, lineWidth: 0.4 }],
  })

  it("틀 안 그리드는 clipParent 로 틀 사각형을 가리킨다 (같은 사각형이 문단마다 반복 클립돼도 한 번)", () => {
    const { grids, containers } = buildClipCellGrids([title, frame, frame, frame, sealL, sealR, footer], [], [], 595, 842)
    assert.deepEqual(containers, [frame])
    assert.equal(grids.length, 2)
    const outer = grids.find(g => g.rowYs.length === 4)!
    assert.ok(outer && !outer.clipParent, "바깥 3×1 은 최상위")
    const seal = grids.find(g => g.colXs.length === 3)!
    assert.deepEqual(seal.clipParent, frame)
  })

  it("테두리 획 4변이 있는 홀로 선 틀은 1×1 그리드 — 안쪽 상자 하나는 그 중첩표", () => {
    // 선서문: 바깥 틀(획 있음) 안에 선서 상자(획 있음) 하나
    const outer = { x1: 58, y1: 220, x2: 568, y2: 783 }
    const inner = { x1: 138, y1: 259, x2: 488, y2: 718 }
    const so = strokeOf(outer), si = strokeOf(inner)
    const { grids } = buildClipCellGrids([outer, inner, outer], [...so.h, ...si.h], [...so.v, ...si.v], 595, 842)
    assert.equal(grids.length, 2)
    const fr = grids.find(g => g.bbox.x1 === 58)!
    assert.equal(fr.cells!.length, 1)
    assert.ok(!fr.clipParent)
    const nested = grids.find(g => g.bbox.x1 === 138)!
    assert.deepEqual(nested.clipParent, outer)
  })

  it("획 없는 큰 컨테이너(한컴 본문 영역 클립)는 틀이 아니다 — 안의 표는 최상위 그리드로 남는다", () => {
    const body = { x1: 58, y1: 85, x2: 534, y2: 769 } // 페이지 면적의 65%, 획 없음
    const rects = [body, { x1: 62, y1: 450, x2: 300, y2: 500 }, { x1: 300, y1: 450, x2: 534, y2: 500 }, body]
    const { grids } = buildClipCellGrids(rects, [], [], 595, 842)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].colXs.length, 3)
    assert.ok(!grids[0].clipParent, "본문 영역은 부모로 잡지 않는다")
  })

  it("획 없는 바깥 틀 안에 획 있는 상자 하나만 있으면(선서문류) 그 상자는 1×1 표, 부모는 없음", () => {
    const outer = { x1: 58, y1: 220, x2: 568, y2: 783 }
    const inner = { x1: 138, y1: 259, x2: 488, y2: 718 }
    const si = strokeOf(inner)
    const { grids } = buildClipCellGrids([outer, inner, outer], si.h, si.v, 595, 842)
    assert.equal(grids.length, 1)
    assert.equal(grids[0].bbox.x1, 138)
    assert.equal(grids[0].cells!.length, 1)
    assert.ok(!grids[0].clipParent)
  })

  it("획 없는 컨테이너 안에 상자가 여럿(칩·표)이면 단독 상자는 종전대로 표가 아니다", () => {
    const body = { x1: 58, y1: 85, x2: 534, y2: 769 }
    const chip = { x1: 62, y1: 700, x2: 320, y2: 727 }
    const sc = strokeOf(chip)
    const other = { x1: 62, y1: 600, x2: 320, y2: 627 }
    const { grids } = buildClipCellGrids([body, chip, other], sc.h, sc.v, 595, 842)
    assert.equal(grids.length, 0)
  })
})

describe("extractPageBlocksWithLines — 틀 셀 blocks 에 중첩표 (v4.12.2)", () => {
  const item = (text: string, x: number, y: number, w = text.length * 10): NormItem =>
    ({ text, x, y, w, h: 10, fontSize: 10, fontName: "F", isHidden: false })

  it("지정서: 틀 셀 문단 사이 원문 순서에 '발신명의 | 직인' 표가 들어가고 꼬리행은 뒤에 남는다", () => {
    const ops = concat(
      clipRectOps(44, 767, 479, 30), clipRectOps(44, 78, 479, 689), clipRectOps(166, 141, 170, 68),
      clipRectOps(44, 78, 479, 689), clipRectOps(336, 141, 68, 68), clipRectOps(44, 47, 479, 31),
    )
    const items = [
      item("■ 항공보안법 시행규칙 [별지 제6호서식]", 50, 775, 300),
      item("보안검색교육기관 지정서", 200, 700), item("1. 명칭", 60, 600), item("년 월 일", 250, 300),
      item("국토교통부장관", 180, 170), item("직인", 350, 170),
      item("210mm×297mm[백상지 120g/㎡]", 300, 55, 200),
    ]
    const blocks = extractPageBlocksWithLines(items, 1, ops, 595, 842)
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 1, "최상위 표는 3×1 하나 — 발신명의 표가 밖으로 새지 않는다")
    const t = tables[0].table!
    assert.equal(t.rows, 3)
    assert.equal(t.cols, 1)
    const frameCell = t.cells[1][0]
    assert.ok(frameCell.blocks, "틀 셀은 blocks 를 가진다")
    const kinds = frameCell.blocks!.map(b => b.type === "table" ? "T" : "p")
    assert.deepEqual(kinds, ["p", "p", "p", "T"], "문단 3개 뒤에 중첩표 — 원문(위→아래) 순서")
    const seal = frameCell.blocks!.find(b => b.type === "table")!.table!
    assert.deepEqual(seal.cells[0].map(c => c.text), ["국토교통부장관", "직인"])
    assert.ok(frameCell.text.includes("국토교통부장관"), "셀 text 는 blocks 평탄화")
    assert.equal(t.cells[2][0].text, "210mm×297mm[백상지 120g/㎡]")
    const md = blocksToMarkdown(blocks)
    assert.ok(md.includes("<table>") && md.indexOf("직인") < md.indexOf("210mm"), "HTML 중첩표, 꼬리행이 마지막")
  })
})
