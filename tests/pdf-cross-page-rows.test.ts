/**
 * PDF 쪽 넘김 표 — 쪼개진 행·쪽 경계에 걸친 칸 판정과 쪽 첫머리 클립 격자 보강.
 *
 * 법령 별표 한컴 PDF 실측(석유사업법 과태료 14쪽 151×76, 출입국관리법 과태료, 농어촌정비법 시설기준, 자동차종합검사
 * 시설·인력기준)을 합성 좌표로 옮겼다. 쪽을 넘은 칸의 뒤 조각은 글이 있어야 클립이 깔린다.
 */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { joinSplitParts, mergeCrossPageTables, nextItemHead } from "../src/pdf/table-parts.js"
import { mergeContinuedCells } from "../src/pdf/cell-continuation.js"
import { buildClipCellGrids } from "../src/pdf/clip-cells.js"
import { CLIP_TABLES, CONT_PARTS, FILLER_CELLS, ROW_RULES, TABLE_COLXS, recordCellLines } from "../src/pdf/table-meta.js"
import type { IRBlock, IRCell, IRTable } from "../src/types.js"
import type { LineSegment } from "../src/pdf/line-types.js"

/** 앵커 목록 → 덮인 자리까지 채운 IR 격자 ([행, 열, 글, 열병합, 행병합]) — 글이 null 이면 채움 칸(클립 없던 자리) */
function grid(rows: number, cols: number, anchors: Array<[number, number, string | null, number?, number?]>): IRTable {
  const cells: IRCell[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: "", colSpan: 1, rowSpan: 1 })))
  for (const [r, c, text, cs = 1, rs = 1] of anchors) {
    cells[r][c] = { text: text ?? "", colSpan: cs, rowSpan: rs }
    if (text === null) FILLER_CELLS.add(cells[r][c])
  }
  return { rows, cols, cells, hasHeader: rows > 1 }
}

/** 칸 글줄 기록 — [왼끝, 오른끝, 기준선] 줄마다 글자 크기 10 */
function lines(cell: IRCell, spec: Array<[number, number, number]>): void {
  recordCellLines(cell, spec.map(([l, r, y]) => ({ x: l, y, w: r - l, fontSize: 10, h: 10 })))
}

const h = (y: number, x1: number, x2: number, w = 0.36): LineSegment => ({ x1, y1: y, x2, y2: y, lineWidth: w })
const v = (x: number, y1: number, y2: number): LineSegment => ({ x1: x, y1, x2: x, y2, lineWidth: 0.36 })

describe("선 격자 표의 반복 머리행 아래 쪼개진 본문", () => {
  const blocksOf = (a: string, b: string): IRBlock[] => {
    const prev = grid(2, 2, [[0, 0, "현행"], [0, 1, "개정안"], [1, 0, "현행 조문 내용"], [1, 1, a]])
    const curr = grid(2, 2, [[0, 0, "현행"], [0, 1, "개정안"], [1, 0, "현행 조문 내용"], [1, 1, b]])
    for (const t of [prev, curr]) TABLE_COLXS.set(t, [50, 250, 500])
    lines(prev.cells[1][0], [[60, 180, 100], [60, 180, 80]])
    lines(prev.cells[1][1], [[260, 490, 100], [260, 490, 80]])
    lines(curr.cells[1][0], [[60, 180, 700], [60, 180, 680]])
    lines(curr.cells[1][1], [[260, 490, 700], [260, 400, 680]])
    return [
      { type: "table", table: prev, pageNumber: 1, bbox: { page: 1, x: 50, y: 70, width: 450, height: 630 } },
      { type: "table", table: curr, pageNumber: 2, bbox: { page: 2, x: 50, y: 70, width: 450, height: 630 } },
    ]
  }
  it("칸 글줄이 문장 중간에서 이어지면 같은 본문 행에 합친다", () => {
    const blocks = blocksOf("기관이 지원하는", "사업의 세부 내용을 검토한다.")
    mergeCrossPageTables(blocks)
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].table!.rows, 2)
    assert.match(blocks[0].table!.cells[1][1].text, /지원하는\n사업의/)
  })
  it("한 줄로 끝난 다른 이름표가 있으면 독립 데이터 행을 보존한다", () => {
    const blocks = blocksOf("기관이 지원하는", "사업의 세부 내용을 검토한다.")
    blocks[0].table!.cells[1][0].text = "가. 첫 기관"
    blocks[1].table!.cells[1][0].text = "나. 둘째 기관"
    lines(blocks[0].table!.cells[1][0], [[60, 130, 80]])
    mergeCrossPageTables(blocks)
    assert.equal(blocks[0].table!.rows, 3)
  })
  it("반복 머리행의 밑줄 유무가 달라도 같은 머리행이다", () => {
    const blocks = blocksOf("기관이 지원하는", "사업의 세부 내용을 검토한다.")
    for (const cell of blocks[0].table!.cells[0]) cell.text = `<u>${cell.text}</u>`
    mergeCrossPageTables(blocks)
    assert.equal(blocks[0].table!.rows, 2)
    assert.equal(blocks[0].table!.cells[0][0].text, "<u>현행</u>")
  })
})

describe("칸 이어짐 판정은 인라인 서식과 무관하다", () => {
  it("밑줄 친 관형형 뒤에도 다음 쪽 문장이 이어진다", () => {
    const prev = grid(1, 1, [[0, 0, "<u>기관이 지원하는</u>"]])
    const curr = grid(1, 1, [[0, 0, "<u>사업의 세부 내용을 검토한다.</u>"]])
    const joined = joinSplitParts(prev, [0, 200], curr, [0, 200])!
    assert.equal(joined.split, true)
    assert.equal(joined.table.rows, 1)
    assert.match(joined.table.cells[0][0].text, /<u>기관이 지원하는<\/u>\n<u>사업의/)
  })
  it("밑줄·취소선을 친 조문 번호도 다음 차례와 한 칸으로 잇는다", () => {
    const prev = grid(1, 1, [[0, 0, "<u>① 첫째 내용</u>\n~~② 둘째 내용~~"]])
    const curr = grid(1, 1, [[0, 0, "<u>③ 셋째 내용</u>"]])
    const joined = joinSplitParts(prev, [0, 200], curr, [0, 200])!
    assert.equal(joined.split, true)
    assert.equal(joined.table.rows, 1)
    assert.match(joined.table.cells[0][0].text, /~~② 둘째 내용~~\n<u>③ 셋째 내용<\/u>/)
  })
})

describe("쪽 경계에 걸친 위 정렬 칸 — 글이 바닥까지 차고 문장이 이어진다", () => {
  // 위반행위 | 근거 법조문(글 없이 다음 쪽으로 넘어가 클립 없음) | 횟수. 앞 쪽 "차." 칸은 2행, 다음 쪽 조각은 2행
  const make = (tail: string): IRTable => {
    const prev = grid(3, 3, [[0, 0, "자. 과실로"], [0, 1, "법 1"], [0, 2, "1회"], [1, 0, `차. 과실로 인하여 법 제75조제1항 및 제2항에서 ${tail}`, 1, 2], [1, 1, "법 제100조", 1, 2], [1, 2, "3회"], [2, 2, "4회"]])
    lines(prev.cells[1][0], [[5, 95, 99], [5, 95, 77], [5, 90, 55]]) // 줄 간격 22pt, 끝줄 기준선이 밑변(30) 위 25pt
    return prev
  }
  const next = (): IRTable => grid(2, 3, [[0, 0, "경우를 포함한다) 또는 제2항", 1, 2], [0, 1, null], [0, 2, "5회"], [1, 1, null], [1, 2, "6회"]])

  it("관형형으로 끊긴 칸은 다음 쪽 조각과 한 칸 — 옆 열 칸이 경계를 넘을 때", () => {
    const res = joinSplitParts(make("준용하는"), [0, 100, 200, 300], next(), [0, 100, 200, 300], 0, 30)
    assert.ok(res)
    assert.equal(res.table.rows, 5)
    assert.equal(res.table.cells[1][0].rowSpan, 4)
    assert.match(res.table.cells[1][0].text, /준용하는\n경우를/)
    assert.equal(res.table.cells[1][1].rowSpan, 4)
    assert.equal(res.table.cells[3][2].text, "5회", "다른 열은 행이 새로 시작한다")
  })

  it("문장이 끝난 칸은 다음 쪽 새 칸과 잇지 않는다", () => {
    const res = joinSplitParts(make("준용한다."), [0, 100, 200, 300], next(), [0, 100, 200, 300], 0, 30)
    assert.ok(res)
    assert.equal(res.table.cells[1][0].rowSpan, 2)
    assert.equal(res.table.cells[3][0].text, "경우를 포함한다) 또는 제2항")
  })
})

describe("쪼개진 행의 옆 칸이 클립 없이 넘어왔으면 뒤 조각 여러 행 칸도 앞 칸의 나머지", () => {
  const prev = (): IRTable => grid(2, 3, [[0, 0, "구분"], [0, 1, "종류"], [0, 2, "기준"], [1, 0, "관광농원"], [1, 1, "영농체험시설"], [1, 2, "○ 식량작물 등이 입식된 농장"]])

  it("앞 쪽 끝 행에서 시작한 칸들이 다음 쪽 첫 띠에 클립이 없으면 첫 열 3행 칸을 앞 칸에 잇는다", () => {
    const curr = grid(3, 3, [[0, 0, "사업", 1, 3], [0, 1, null], [0, 2, null], [1, 1, "지역특산물"], [1, 2, "○ 지역농수산물"], [2, 1, "체육시설"], [2, 2, "○ 영업시설"]])
    const res = joinSplitParts(prev(), [0, 30, 100, 300], curr, [0, 30, 100, 300])
    assert.ok(res)
    assert.equal(res.split, true)
    assert.equal(res.table.rows, 4)
    assert.equal(res.table.cells[1][0].text, "관광농원\n사업")
    assert.equal(res.table.cells[1][0].rowSpan, 3)
    assert.equal(res.table.cells[1][1].rowSpan, 1)
    assert.equal(res.table.cells[2][1].text, "지역특산물")
  })

  it("옆 칸 조각에 클립이 있으면(새 행) 여러 행 칸은 새 묶음이다", () => {
    const curr = grid(3, 3, [[0, 0, "사업", 1, 3], [0, 1, "음식물"], [0, 2, "○ 식품"], [1, 1, "지역특산물"], [1, 2, "○ 지역농수산물"], [2, 1, "체육시설"], [2, 2, "○ 영업시설"]])
    const res = joinSplitParts(prev(), [0, 30, 100, 300], curr, [0, 30, 100, 300])
    assert.ok(res)
    assert.equal(res.split, false)
    assert.equal(res.table.rows, 5)
  })
})

describe("내어쓰기 문단이 쪽에서 갈린 칸 — 글 이어짐", () => {
  it("앞 쪽 끝줄이 문단 머리 자리에서 꽉 차고 뒤 쪽 줄이 모두 내어쓴 자리에서 이어지면 쪼개진 행", () => {
    const prev = grid(2, 2, [[0, 0, "3) 보고"], [0, 1, "법"], [1, 0, "4) 법 제38조의"], [1, 1, "법"]])
    const curr = grid(1, 2, [[0, 0, "2제1항을 위반 하여 석유제품의 판매가격을"], [0, 1, "제49조"]])
    lines(prev.cells[1][0], [[66, 157, 35]])
    lines(curr.cells[0][0], [[75, 157, 771], [75, 157, 756], [75, 157, 740]])
    const res = joinSplitParts(prev, [58, 160, 214], curr, [58, 160, 214])
    assert.ok(res)
    assert.equal(res.split, true)
    assert.equal(res.table.rows, 2)
    assert.match(res.table.cells[1][0].text, /^4\) 법 제38조의\n2제1항/)
  })

  it("뒤 쪽 둘째 줄이 첫 줄보다 나오면(들여쓰기 새 문단) 잇지 않는다", () => {
    const prev = grid(2, 2, [[0, 0, "3) 보고"], [0, 1, "법"], [1, 0, "4) 법 제38조의"], [1, 1, "법"]])
    const curr = grid(1, 2, [[0, 0, "새 문단이 들여 써서 시작한다"], [0, 1, "제49조"]])
    lines(prev.cells[1][0], [[66, 157, 35]])
    lines(curr.cells[0][0], [[75, 157, 771], [66, 157, 756]])
    const res = joinSplitParts(prev, [58, 160, 214], curr, [58, 160, 214])
    assert.ok(res)
    assert.equal(res.split, false)
  })

  it("내어쓴 끝줄은 그 자리부터 칸 오른끝까지를 줄 폭으로 본다 (좁은 칸 \"(나) 그 / 밖 의\")", () => {
    const prev = grid(2, 1, [[0, 0, "(가) 주 단 위"], [1, 0, "(나) 그 밖 의"]])
    const curr = grid(1, 1, [[0, 0, "보 고 의 경 우"]])
    lines(prev.cells[1][0], [[84, 132, 58], [101, 132, 42]])
    lines(curr.cells[0][0], [[101, 132, 771], [101, 132, 756], [101, 113, 740]])
    const res = joinSplitParts(prev, [58.3, 133.2], curr, [58.3, 133.2])
    assert.ok(res)
    assert.equal(res.split, true)
    assert.equal(res.table.cells[1][0].text, "(나) 그 밖 의\n보 고 의 경 우")
  })
})

describe("쪽 넘김 열 경계 합집합", () => {
  it("짜임이 다른 조각의 1pt 떨어진 경계는 다른 열 경계로 남긴다 (원본 격자가 따로 센다)", () => {
    const prev = grid(1, 2, [[0, 0, "가"], [0, 1, "나"]])
    const curr = grid(1, 3, [[0, 0, "다"], [0, 1, "라"], [0, 2, "마"]])
    const res = joinSplitParts(prev, [58.3, 158.8, 536.6], curr, [58.3, 159.8, 300, 536.6])
    assert.ok(res)
    assert.deepEqual(res.colXs, [58.3, 158.8, 159.8, 300, 536.6])
  })

  it("같은 짜임이 쪽마다 1pt 안에서 어긋나면 같은 열이다", () => {
    const prev = grid(1, 3, [[0, 0, "가"], [0, 1, "나"], [0, 2, "다"]])
    const curr = grid(1, 3, [[0, 0, "라"], [0, 1, "마"], [0, 2, "바"]])
    const res = joinSplitParts(prev, [58.05, 108.06, 151.48, 539.11], curr, [58.05, 108.54, 150.52, 539.11])
    assert.ok(res)
    assert.deepEqual(res.colXs, [58.05, 108.06, 151.48, 539.11])
    assert.equal(res.table.cells[1][1].text, "마")
  })
})

describe("세 쪽에 걸친 칸 — 이어짐 조각을 붙인 표는 끝난 쪽에서 다음 조각과 잇는다", () => {
  it("쪽 전체가 한 칸인 가운데 쪽을 넘어 셋째 쪽 표 조각을 잇는다", () => {
    const clip = (t: IRTable, xs: number[]): IRTable => { CLIP_TABLES.add(t); TABLE_COLXS.set(t, xs); return t }
    const first = clip(grid(2, 1, [[0, 0, "2. 검사장비"], [1, 0, "비고 1. 검사장비는 형식승인을 받은 것이어야 한다."]]), [73.8, 521.5])
    const mid = clip(grid(1, 1, [[0, 0, "7. 부하검사 대상 자동차에 대하여 관능 및 기능검사 전에 자동차 소유자에"]]), [73.8, 521.5])
    CONT_PARTS.set(mid, { x1: 73.8, x2: 521.5 })
    lines(mid.cells[0][0], [[81, 516, 500], [81, 516, 80]])
    const last = clip(grid(3, 2, [[0, 0, "게 무부하 급가속을 하는 사유를 설명하여야 한다.", 2], [1, 0, "구 분"], [1, 1, "자 격"], [2, 0, "책임자"], [2, 1, "정비기사"]]), [73.8, 146.2, 521.5])
    lines(last.cells[0][0], [[81, 516, 763], [81, 200, 744]])
    const H = new Map([[1, 842], [2, 842], [3, 842]])
    const blocks: IRBlock[] = [
      { type: "table", table: first, pageNumber: 1, bbox: { page: 1, x: 73.8, y: 70, width: 447.7, height: 600 } },
      { type: "table", table: mid, pageNumber: 2, bbox: { page: 2, x: 73.8, y: 70, width: 447.7, height: 706 } },
      { type: "table", table: last, pageNumber: 3, bbox: { page: 3, x: 73.8, y: 500, width: 447.7, height: 276 } },
    ]
    mergeContinuedCells(blocks, H)
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 1)
    const t = blocks[0].table!
    assert.equal(t.rows, 4)
    assert.match(t.cells[1][0].text, /형식승인을 받은 것이어야 한다\.\n7\. 부하검사 .*소유자에\n게 무부하/)
    assert.equal(t.cells[2][0].text, "구 분")
  })
})

describe("쪽 번호가 두 조각 사이에 남아도 쪽 넘김 표를 잇는다", () => {
  // 응급의료기관 평가 기준집 p.29-30 실측을 옮겼다: 앞 쪽 끝 행 "가중치 1.5" 칸이 다음 쪽 두 행까지 세로 병합으로 이어진다.
  // 머리글·바닥글 제거는 3쪽 이상일 때만 돌아 -p 29-30·--no-header-footer 에서는 앞 쪽 쪽 번호 "21" 이 표 폭 안에 남는다
  const H = new Map([[1, 842], [2, 842]])
  const make = (between: IRBlock): IRBlock[] => {
    const clip = (t: IRTable): IRTable => { CLIP_TABLES.add(t); TABLE_COLXS.set(t, [72.3, 150, 400, 542]); return t }
    const prev = clip(grid(3, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "가중치"], [1, 0, "적시성"], [1, 1, "1) 병상포화 지수"], [1, 2, "1.2"],
      [2, 0, "기능성"], [2, 1, "1) 중증상병해당환자 분담률"], [2, 2, "1.5"]]))
    const curr = clip(grid(4, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "가중치"], [1, 0, null, 1, 3], [1, 1, "2) 중증상병해당환자 구성비"], [1, 2, null, 1, 2],
      [2, 1, "3) 최종치료 제공률"], [3, 1, "5) 협진의사 수준"], [3, 2, "-"]]))
    return [
      { type: "table", table: prev, pageNumber: 1, bbox: { page: 1, x: 72.3, y: 75, width: 469.7, height: 637 } },
      between,
      { type: "table", table: curr, pageNumber: 2, bbox: { page: 2, x: 72.3, y: 98, width: 469.7, height: 660 } },
    ]
  }
  const para = (text: string): IRBlock => ({ type: "paragraph", text, pageNumber: 1, bbox: { page: 1, x: 530, y: 47, width: 10, height: 10 } })

  it("앞 쪽 표 아래 쪽 끝 띠의 쪽 번호는 이음을 막지 않고 제자리에 남는다", () => {
    const blocks = make(para("21"))
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0].type, "table")
    assert.equal(blocks[1].text, "21")
    const t = blocks[0].table!
    assert.equal(t.rows, 6, "되풀이 머리 행은 빠진다")
    assert.equal(t.cells[2][2].text, "1.5")
    assert.equal(t.cells[2][2].rowSpan, 3, "가중치 칸이 다음 쪽 이어진 두 행까지 걸친다")
    assert.equal(t.cells[5][2].text, "-")
  })

  it("쪽 번호 꼴 \"- 21 -\" 도 같다", () => {
    const blocks = make(para("- 21 -"))
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 1)
  })

  it("뒤 쪽 표 위 쪽 첫머리 띠의 쪽 번호도 건너뛴다", () => {
    const blocks = make({ type: "paragraph", text: "22", pageNumber: 2, bbox: { page: 2, x: 290, y: 790, width: 12, height: 10 } })
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 1)
  })

  it("같은 자리의 본문 글(표 주석)은 종전대로 두 표로 가른다", () => {
    const blocks = make(para("※ 가중치는 권역응급의료센터 기준"))
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 2)
  })

  it("쪽 높이를 모르면(외부 호출) 쪽 번호 예외를 두지 않는다", () => {
    const blocks = make(para("21"))
    mergeCrossPageTables(blocks)
    assert.equal(blocks.filter(b => b.type === "table").length, 2)
  })
})

describe("쪽 번호를 남긴 다중 쪽 표 — 이어짐과 새 서식을 구별한다", () => {
  const H = new Map([[1, 842], [2, 842], [3, 842]])
  const clip = (t: IRTable): IRTable => { CLIP_TABLES.add(t); TABLE_COLXS.set(t, [72.3, 150, 400, 542]); return t }
  const block = (t: IRTable, page: number): IRBlock => ({ type: "table", table: clip(t), pageNumber: page,
    bbox: { page, x: 72.3, y: 75, width: 469.7, height: 683 } })
  const footer = (page: number, text = String(page + 20)): IRBlock => ({ type: "paragraph", text, pageNumber: page,
    bbox: { page, x: 290, y: 47, width: 12, height: 10 } })

  it("세 쪽에 걸친 빈 조각의 가중치와 세로 병합 범위를 되살리고 쪽 번호를 보존한다", () => {
    const first = grid(2, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "가중치"],
      [1, 0, "기능성"], [1, 1, "첫째"], [1, 2, "1.5"]])
    const mid = grid(4, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "가중치"],
      [1, 0, "분류 2"], [1, 1, "둘째"], [1, 2, null, 1, 3], [2, 0, "분류 3"], [2, 1, "셋째"], [3, 0, "분류 4"], [3, 1, "넷째"]])
    const last = grid(3, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "가중치"],
      [1, 0, "분류 5"], [1, 1, "다섯째"], [1, 2, null], [2, 0, "새 평가"], [2, 1, "여섯째"], [2, 2, "2.0"]])
    const blocks = [block(first, 1), footer(1), block(mid, 2), footer(2), block(last, 3)]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 1)
    assert.deepEqual(blocks.filter(b => b.type === "paragraph").map(b => b.text), ["21", "22"])
    const t = blocks[0].table!
    assert.equal(t.rows, 7)
    assert.equal(t.cells[1][2].text, "1.5")
    assert.equal(t.cells[1][2].rowSpan, 5)
    assert.equal(t.cells[6][2].text, "2.0")
  })

  it("쪽 번호 너머 사슬 첫머리와 이름표가 같은 새 양식은 이전 표에 붙이지 않는다", () => {
    const first = grid(2, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "평가 A"],
      [1, 0, "첫 데이터"], [1, 1, "첫 내용"], [1, 2, "첫 값"]])
    const mid = grid(1, 3, [[0, 0, "이어진 데이터"], [0, 1, "이어진 내용"], [0, 2, "이어진 값"]])
    const nextForm = grid(2, 3, [[0, 0, "구분"], [0, 1, "지표명"], [0, 2, "평가 B"],
      [1, 0, "다른 데이터"], [1, 1, "다른 내용"], [1, 2, "다른 값"]])
    const blocks = [block(first, 1), footer(1), block(mid, 2), block(nextForm, 3)]
    mergeCrossPageTables(blocks, H)
    const tables = blocks.filter(b => b.type === "table")
    assert.equal(tables.length, 2)
    assert.equal(tables[0].table!.rows, 3)
    assert.equal(tables[0].table!.cells[2][0].text, "이어진 데이터")
    assert.equal(tables[1].table!.cells[0][2].text, "평가 B")
    assert.equal(tables[1].pageNumber, 3)
  })

  it("양쪽에 단위 행이 있으면 쪽 끝 번호를 건너뛰어도 독립 표다", () => {
    const form = (value: string) => grid(2, 3, [[0, 0, "(단위: 명)", 3],
      [1, 0, "기관"], [1, 1, "인원"], [1, 2, value]])
    const blocks = [block(form("10"), 1), footer(1), block(form("20"), 2)]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 2)
    assert.equal(blocks[1].text, "21")
  })

  it("본문 영역의 숫자 문단은 쪽 번호 예외가 아니다", () => {
    const a = grid(1, 3, [[0, 0, "A"], [0, 1, "B"], [0, 2, "C"]])
    const b = grid(1, 3, [[0, 0, "D"], [0, 1, "E"], [0, 2, "F"]])
    const middle = footer(2, "2026")
    middle.bbox = { page: 2, x: 290, y: 300, width: 24, height: 10 }
    const next = block(b, 2)
    next.bbox = { page: 2, x: 72.3, y: 500, width: 469.7, height: 258 }
    const blocks = [block(a, 1), middle, next]
    mergeCrossPageTables(blocks, H)
    assert.equal(blocks.filter(b => b.type === "table").length, 2)
    assert.equal(blocks[1].text, "2026")
  })
})

describe("buildClipCellGrids — 쪽 첫머리 클립 없는 띠·떨어진 조각", () => {
  const prevPage = { lastCells: [{ x1: 72.3, y1: 78.9, x2: 103, y2: 482.6 }], clips: [] }

  it("격자 위에 테두리만 그어진 빈 띠는 앞 쪽에서 넘어온 행의 조각 — 빈 첫 행으로 더한다", () => {
    const rects = [
      { x1: 184.8, y1: 699.9, x2: 518.2, y2: 733.8 },
      { x1: 103, y1: 531.6, x2: 184.8, y2: 699.9 }, { x1: 184.8, y1: 531.6, x2: 518.2, y2: 699.9 },
      { x1: 72.3, y1: 494.7, x2: 518.2, y2: 531.6 },
    ]
    const strokesH = [h(763.1, 71.8, 518.8), h(733.8, 184.7, 518.8), h(699.9, 102.9, 518.8)]
    const strokesV = [v(72.3, 531.6, 763.1), v(103, 531.6, 763.1), v(184.8, 531.6, 763.1), v(518.2, 531.6, 763.1)]
    const text = [{ x: 300, y: 720 }, { x: 150, y: 600 }, { x: 300, y: 600 }, { x: 300, y: 510 }]
    const g = buildClipCellGrids(rects, strokesH, strokesV, 595, 841, text, [], prevPage).grids
    assert.equal(g.length, 1)
    assert.equal(g[0].rowYs[0], 763.1)
    assert.ok(g[0].cells!.filter(c => c.row === 0).every(c => c.filler))
    // 앞 쪽이 표 칸으로 끝나지 않았으면 그대로
    assert.equal(buildClipCellGrids(rects, strokesH, strokesV, 595, 841, text).grids[0].rowYs[0], 733.8)
  })

  it("쪽 첫 띠의 글 있는 조각만 클립이 깔려 떨어져 있어도 아래 전폭 칸 위에 함께 놓이면 한 표", () => {
    const band = [[58.3, 133.2], [168.6, 190.3], [190.3, 212.2], [447.6, 469.7], [469.7, 490.7]].map(([x1, x2]) => ({ x1, y1: 737.1, x2, y2: 783 }))
    const floor = { x1: 58.3, y1: 684, x2: 536.6, y2: 737.1 }
    const below = [{ x1: 58.3, y1: 600, x2: 133.2, y2: 684 }, { x1: 133.2, y1: 600, x2: 536.6, y2: 684 }]
    const text = [...band.map(b => ({ x: (b.x1 + b.x2) / 2, y: 760 })), { x: 300, y: 710 }, { x: 90, y: 640 }]
    const g = buildClipCellGrids([...band, floor, ...below], [], [], 595, 841, text, [], prevPage).grids
    assert.equal(g.length, 1)
    assert.equal(g[0].cells!.filter(c => !c.filler).length, 8)
    // 앞 쪽 표가 없으면 떨어진 조각은 따로 묶인다
    assert.equal(buildClipCellGrids([...band, floor, ...below], [], [], 595, 841, text).grids.length, 3)
  })
})

describe("두 행 머리 표의 쪽 넘김 — 되풀이 머리 두 행과 상위 세로 병합 칸", () => {
  // 구급차 관리·운용 안내 제5판 [별표 16] 30~31쪽 꼴: 머리 "구분|장비분류|구급차 구분"(앞 두 칸 세로 병합) 아래 "특수|일반",
  // 상위 항목 "나." 가 앞 쪽 끝까지 세로 병합되고 다음 쪽 조각 첫 행에 글 없는 세로 병합 칸으로 다시 그려진다
  const head: Array<[number, number, string | null, number?, number?]> = [[0, 0, "구분", 1, 2], [0, 1, "장비분류", 1, 2], [0, 2, "구급차 구분", 2, 1], [1, 2, "특수구급차"], [1, 3, "일반구급차"]]
  const blocks = (): IRBlock[] => {
    const prev = grid(4, 4, [...head, [2, 0, "나. 응급 처치용 의료장비", 1, 2], [2, 1, "1) 기도"], [2, 2, "기도확보장치"], [2, 3, "기도확보장치"], [3, 1, "2) 호흡"], [3, 2, "산소 마스크"], [3, 3, "산소 마스크"]])
    const curr = grid(4, 4, [...head, [2, 0, "", 1, 2], [2, 1, "3) 심장"], [2, 2, "자동심장충격기"], [2, 3, "-"], [3, 1, "4) 순환"], [3, 2, "정맥주사세트"], [3, 3, "정맥주사세트"]])
    return [
      { type: "table", table: prev, pageNumber: 1, bbox: { page: 1, x: 50, y: 70, width: 450, height: 630 } },
      { type: "table", table: curr, pageNumber: 2, bbox: { page: 2, x: 50, y: 70, width: 450, height: 630 } },
    ]
  }
  it("되풀이 머리 두 행을 모두 빼고, 상위 세로 병합 칸을 다음 쪽 행까지 늘린다", () => {
    const b = blocks()
    mergeCrossPageTables(b)
    assert.equal(b.length, 1)
    const t = b[0].table!
    assert.equal(t.cells.length, 6)
    assert.equal(t.cells.filter(r => r.some(c => c.text === "특수구급차")).length, 1)
    assert.equal(t.cells[2][0].text, "나. 응급 처치용 의료장비")
    assert.equal(t.cells[2][0].rowSpan, 4)
    assert.equal(t.cells[4][1].text, "3) 심장")
  })
})

describe("쪽 넘김 행 판정 — 번호 차례·항목 꼴·쪽 넘는 글 칸 (법령 별표)", () => {
  it("번호 열이 다음 차례로 이어지면 옆 칸 끝줄이 꽉 차도 새 행이다 (허용물질 \"12\" / 다음 쪽 \"13\")", () => {
    const prev = grid(2, 3, [[0, 0, "번호"], [0, 1, "허용물질"], [0, 2, "사용가능 조건"], [1, 0, "12"], [1, 1, "사람의 배설물(오줌만인 경우는 제외한다)"], [1, 2, "(1) 완전히 발효되어 부숙된 것일 것"]])
    const curr = grid(1, 3, [[0, 0, "13"], [0, 1, "벌레 등 자연적으로 생긴 유기체"], [0, 2, ""]])
    lines(prev.cells[1][0], [[15, 25, 40]])
    lines(prev.cells[1][1], [[45, 195, 40]])
    lines(prev.cells[1][2], [[205, 330, 40]])
    lines(curr.cells[0][0], [[15, 25, 760]])
    lines(curr.cells[0][1], [[45, 150, 760]])
    const res = joinSplitParts(prev, [0, 40, 200, 400], curr, [0, 40, 200, 400])!
    assert.equal(res.table.rows, 3)
    assert.equal(res.table.cells[2][0].text, "13")
  })

  it("\"가)\" 다음 \"나)\" 도 다음 항목 머리다 — 꼴이 다르면(\"가)\" / \"나.\") 아니다", () => {
    assert.equal(nextItemHead("가) 등록요건 중 일부가 미달하게 된 경우", "나) 등록요건의 전부가 미달하게 된 경우"), true)
    assert.equal(nextItemHead("가) 등록요건 중 일부", "나. 등록요건의 전부"), false)
    assert.equal(nextItemHead("가. 첫 항목", "나. 둘째 항목"), true)
  })

  it("글이 칸 끝까지 차 낱말 가운데서 쪽을 넘은 칸은 다음 쪽 새 행과 함께 두 행을 덮는다 (보안심사대행기관 처분기준 \"2) … 지정기\" / \"준에 미달하게 된 경우\")", () => {
    // 위반행위 | 세부 위반행위 | 근거 법령(다음 쪽 클립 없이 이어짐) | 처분. 쪽 경계에 괘선이 있다
    const prev = grid(1, 4, [[0, 0, "2) 법 제38조제1항에 따른 대행기관 지정기"], [0, 1, "가) 등록요건 중 일부가 미달하게 된 경우"], [0, 2, "법 제38조제2항제2호"], [0, 3, "지정취소"]])
    const curr = grid(1, 4, [[0, 0, "준에 미달하게 된 경우"], [0, 1, "나) 등록요건의 전부가 미달하게 된 경우"], [0, 2, null], [0, 3, "-"]])
    lines(prev.cells[0][0], [[3, 97, 40]])
    lines(prev.cells[0][1], [[103, 190, 40]])
    lines(prev.cells[0][2], [[205, 255, 40]])
    lines(prev.cells[0][3], [[265, 295, 40]])
    lines(curr.cells[0][0], [[3, 60, 760]])
    lines(curr.cells[0][1], [[103, 192, 760]])
    lines(curr.cells[0][3], [[278, 282, 760]])
    ROW_RULES.set(prev, { top: true, bottom: true, innerRuled: 0, innerOpen: 0 })
    ROW_RULES.set(curr, { top: true, bottom: true, innerRuled: 0, innerOpen: 0 })
    const res = joinSplitParts(prev, [0, 100, 200, 260, 300], curr, [0, 100, 200, 260, 300], 0, 30)!
    assert.equal(res.table.rows, 2)
    assert.equal(res.table.cells[0][0].rowSpan, 2)
    assert.equal(res.table.cells[0][0].text, "2) 법 제38조제1항에 따른 대행기관 지정기\n준에 미달하게 된 경우")
    assert.equal(res.table.cells[1][1].text, "나) 등록요건의 전부가 미달하게 된 경우")
    assert.equal(res.table.cells[1][3].text, "-")
  })

  it("다른 열에 다음 항목 증거가 없으면 끝줄이 칸을 채워도 두 행으로 둔다 (시험기준표 \"겉모양, 치수, 무게\" / \"화학성분\")", () => {
    const prev = grid(1, 4, [[0, 0, "2) 법 제38조제1항에 따른 대행기관 지정기"], [0, 1, "등록요건 중 일부가 미달하게 된 경우"], [0, 2, "법 제38조제2항제2호"], [0, 3, "지정취소"]])
    const curr = grid(1, 4, [[0, 0, "준에 미달하게 된 경우"], [0, 1, "등록요건의 전부가 미달하게 된 경우"], [0, 2, null], [0, 3, "-"]])
    lines(prev.cells[0][0], [[3, 97, 40]])
    lines(prev.cells[0][1], [[103, 140, 40]]) // 한 줄로 끝난 이름표 — 다음 쪽 다른 글이라 행은 새로 시작한다
    lines(prev.cells[0][2], [[205, 255, 40]])
    lines(prev.cells[0][3], [[265, 295, 40]])
    lines(curr.cells[0][0], [[3, 60, 760]])
    lines(curr.cells[0][1], [[103, 192, 760]])
    lines(curr.cells[0][3], [[278, 282, 760]])
    ROW_RULES.set(prev, { top: true, bottom: true, innerRuled: 0, innerOpen: 0 })
    ROW_RULES.set(curr, { top: true, bottom: true, innerRuled: 0, innerOpen: 0 })
    const res = joinSplitParts(prev, [0, 100, 200, 260, 300], curr, [0, 100, 200, 260, 300], 0, 30)!
    assert.equal(res.table.cells[0][0].rowSpan, 1)
    assert.equal(res.table.cells[1][0].text, "준에 미달하게 된 경우")
  })
})
