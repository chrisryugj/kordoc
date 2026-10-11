import { it } from "node:test"
import assert from "node:assert/strict"
import { removeHeaderFooterBlocks, runningLinePatterns, stripAbsorbedRunningLines } from "../src/pdf/block-detect.js"
import type { IRBlock } from "../src/types.js"

function repeated(text: string, gap = 1, noteX = 50): IRBlock[] {
  return [1, 2, 3].flatMap(page => [
    { type: "table" as const, pageNumber: page, bbox: { page, x: 45, y: 97, width: 504, height: 600 } },
    { type: "paragraph" as const, text, pageNumber: page, bbox: { page, x: noteX, y: 97 - gap - 11, width: 269, height: 11 } },
  ])
}
const heights = new Map([[1, 830], [2, 830], [3, 830]])
it("반복 표 바로 아래 주석은 footer 영역에 들어가도 보존한다", () => {
  for (const label of ["주1) 2019a: 가계동향조사(소득부문)", "주: 통계 범위", "자료: 통계청", "출처: 공공데이터"]) {
    assert.deepEqual(removeHeaderFooterBlocks(repeated(label), heights, []), [])
  }
})
it("표와 떨어진 주석 모양 footer는 종전처럼 제거한다", () => {
  assert.deepEqual(removeHeaderFooterBlocks(repeated("자료: 통계청", 40), heights, []), [1, 3, 5])
})
it("표 옆의 반복 footer와 주석 표지 없는 running footer는 제거한다", () => {
  assert.deepEqual(removeHeaderFooterBlocks(repeated("자료: 통계청", 1, 550), heights, []), [1, 3, 5])
  assert.deepEqual(removeHeaderFooterBlocks(repeated("가계동향조사 보고서"), heights, []), [1, 3, 5])
})
it("드문드문 되풀이되는 절 제목(서식마다 첫 쪽)은 러닝 헤더가 아니다", () => {
  // 규제영향분석서: "Ⅰ. 규제의 필요성" 이 156쪽 중 10쪽(약 15쪽 간격) 머리 띠에 — 원본 서식의 제목이다
  const pages = [5, 21, 35, 49, 62]
  const blocks: IRBlock[] = pages.map(page => ({ type: "paragraph", text: "Ⅰ. 규제의 필요성", pageNumber: page, bbox: { page, x: 60, y: 780, width: 200, height: 14 } }))
  const hs = new Map(pages.map(p => [p, 830] as [number, number]))
  assert.deepEqual(removeHeaderFooterBlocks(blocks, hs, []), [])
  // 매 쪽 되풀이는 종전대로 머리글
  const every = [1, 2, 3, 4].map(page => ({ type: "paragraph" as const, text: "행정업무운영 편람", pageNumber: page, bbox: { page, x: 60, y: 780, width: 200, height: 14 } }))
  assert.deepEqual(removeHeaderFooterBlocks(every, new Map([1, 2, 3, 4].map(p => [p, 830] as [number, number])), []), [0, 1, 2, 3])
})
it("쪽 번호가 바뀌며 되풀이되는 바닥글은 드문드문해도 러닝 푸터다", () => {
  // hwp3-sample11 "DCT Technology Inc.\t55" — 여러 쪽에선 표에 흡수돼 따로 선 등장이 드문드문하다
  const pages = [6, 20, 41, 55]
  const blocks: IRBlock[] = pages.map(page => ({ type: "paragraph", text: `DCT Technology Inc.\t${page}`, pageNumber: page, bbox: { page, x: 60, y: 20, width: 400, height: 10 } }))
  assert.deepEqual(removeHeaderFooterBlocks(blocks, new Map(pages.map(p => [p, 830] as [number, number])), []), [0, 1, 2, 3])
})
it("쪽 머리 띠에 통째로 든 작은 표가 되풀이되면 러닝 헤더다 (괘선 상자 머리말)", () => {
  // exam_kor "2 | 홀수형" / "홀수형 | 3" (짝·홀 쪽 번갈아), 온새미로 본교재 짝수 쪽 "01 누적과 연결 & 세계와 자아의 관계"
  const cell = (text: string) => ({ text, colSpan: 1, rowSpan: 1 })
  const box = (page: number, texts: string[]): IRBlock => ({
    type: "table", pageNumber: page, bbox: { page, x: 62, y: 737, width: 471, height: 34 },
    table: { rows: 1, cols: texts.length, cells: [texts.map(cell)], hasHeader: false },
  })
  const pages = [2, 3, 4, 5, 6, 7, 8]
  const blocks = pages.map(p => box(p, p % 2 ? ["홀수형", "", String(p)] : [String(p), "", "홀수형"]))
  const hs = new Map(pages.map(p => [p, 841] as [number, number]))
  // 표 상자는 쪽 넘김 표 병합 뒤 따로 거른다(tables=true) — 글 차례에선 건드리지 않는다
  assert.deepEqual(removeHeaderFooterBlocks(blocks, hs, []), [])
  assert.deepEqual(removeHeaderFooterBlocks(blocks, hs, [], undefined, true), [0, 1, 2, 3, 4, 5, 6])
  // 머리 띠를 벗어난 본문 표는 되풀이돼도 그대로
  const body = pages.map(p => ({ ...box(p, ["구분", "내용"]), bbox: { page: p, x: 62, y: 400, width: 471, height: 34 } }))
  assert.deepEqual(removeHeaderFooterBlocks(body, hs, [], undefined, true), [])
  // 드문드문한 안건 표지 상자("제2차 재정운용전략협의회 | 26-2-1", 56쪽 중 4쪽)는 번호가 바뀌어도 머리말이 아니다
  const agenda = [5, 27, 47, 60].map((p, k) => box(p, ["제2차 재정운용전략협의회", `26-2-${k + 1}`]))
  assert.deepEqual(removeHeaderFooterBlocks(agenda, new Map([5, 27, 47, 60].map(p => [p, 841] as [number, number])), [], undefined, true), [])
})
it("쪽 아래 표 주석 상자(주 | 1) | …)는 바로 위 표에 딸린 글이라 되풀이돼도 남긴다", () => {
  // 사업체노동력조사 보도자료: 통계표 쪽마다 "주 | 1) | ( )내는 전년동기대비 증감률 | 2) | p: 잠정치"
  const cell = (text: string) => ({ text, colSpan: 1, rowSpan: 1 })
  const pages = [30, 31, 32]
  const blocks: IRBlock[] = pages.flatMap(page => [
    { type: "table" as const, pageNumber: page, bbox: { page, x: 58, y: 100, width: 436, height: 600 }, table: { rows: 1, cols: 1, cells: [[cell("통계")]], hasHeader: false } },
    { type: "table" as const, pageNumber: page, bbox: { page, x: 58, y: 72, width: 436, height: 23 },
      table: { rows: 2, cols: 3, cells: [["주", "1)", "( )내는 전년동기대비 증감률"].map(cell), ["", "2)", "p: 잠정치"].map(cell)], hasHeader: false } },
  ])
  assert.deepEqual(removeHeaderFooterBlocks(blocks, new Map(pages.map(p => [p, 841] as [number, number])), [], undefined, true), [])
})
it("본문 위첨자 참조 표시가 있는 쪽의 각주는 숫자만 바뀌며 되풀이돼도 꼬리말이 아니다", () => {
  // 선박 코드 부속서: 쪽마다 "3) 제19장 부속서 3의 2.3.4 참조 - 역주" 꼴 각주 — 숫자를 지우면 같은 글이라 러닝 푸터로 지워졌다
  const pages = [8, 9, 10]
  const blocks: IRBlock[] = pages.map((page, k) => ({ type: "paragraph", text: `${k + 3}) 제19장 부속서 3의 2.3.${k + 4} 참조 - 역주`, pageNumber: page, bbox: { page, x: 57, y: 29, width: 300, height: 25 } }))
  const hs = new Map(pages.map(p => [p, 841] as [number, number]))
  const notes = new Map(pages.map((p, k) => [p, { marks: [{ mark: `${k + 3})`, y: 500 }], seps: [60] }] as const))
  assert.deepEqual(removeHeaderFooterBlocks(blocks, hs, [], notes), [])
  // 참조 표시가 없는 쪽이면 종전대로 꼬리말
  assert.deepEqual(removeHeaderFooterBlocks(blocks, hs, []), [0, 1, 2])
})

// 쪽 테두리 틀 안 바닥글 — 따로 선 쪽에서 지운 꼴로, 쪽 높이 문단 끝 줄·쪽 끝까지 내려온 표 끝 행에 붙은 것을 걷는다 (hwp3-sample11)
const footer = (page: number, n: number, text = "DCT Technology Inc.\t"): IRBlock =>
  ({ type: "paragraph", text: `${text}${n}`, pageNumber: page, bbox: { page, x: 57, y: 58, width: 479, height: 12 } })
const cell = (text: string, rowSpan = 1) => ({ text, colSpan: 1, rowSpan })
const table = (page: number, rows: ReturnType<typeof cell>[][], y = 57): IRBlock =>
  ({ type: "table", pageNumber: page, bbox: { page, x: 57, y, width: 479, height: 300 }, table: { rows: rows.length, cols: rows[0].length, cells: rows, hasHeader: true } })
const hs = new Map(Array.from({ length: 30 }, (_, i) => [i + 1, 842] as [number, number]))
const running = () => runningLinePatterns([footer(2, 1), footer(3, 2), footer(4, 3)], hs)
it("쪽 높이 문단 끝 줄·쪽 끝 표 끝 행에 흡수된 바닥글을 걷는다 (hwp3-sample11 \"DCT Technology Inc. N\")", () => {
  assert.deepEqual([...running()], [["DCT Technology Inc. #", 1]])
  const page: IRBlock = { type: "paragraph", text: "SUN Enterprise 10000 : 메인프레임\n\nDCT Technology Inc. 5", pageNumber: 6, bbox: { page: 6, x: 57, y: 58, width: 479, height: 711 } }
  const onlyFooter: IRBlock = { type: "paragraph", text: "\nDCT Technology Inc. 26", pageNumber: 27, bbox: { page: 27, x: 57, y: 58, width: 479, height: 711 } }
  const out = stripAbsorbedRunningLines([page, table(17, [[cell("명령"), cell("설명")], [cell("ls"), cell("목록")], [cell("DCT Technology Inc."), cell("16")]]), onlyFooter], hs, running())
  assert.equal(out.length, 2)
  assert.equal(out[0].text, "SUN Enterprise 10000 : 메인프레임")
  assert.equal(out[1].table!.rows, 2)
  assert.deepEqual(out[1].table!.cells.map(r => r.map(c => c.text)), [["명령", "설명"], ["ls", "목록"]])
})
it("꼴·쪽 번호가 안 맞거나 띠에 안 닿거나 병합 칸이 걸친 행은 그대로 둔다", () => {
  const high: IRBlock = { type: "paragraph", text: "본문\nDCT Technology Inc. 5", pageNumber: 6, bbox: { page: 6, x: 57, y: 300, width: 479, height: 400 } }
  const wrongNo: IRBlock = { type: "paragraph", text: "본문\nDCT Technology Inc. 3", pageNumber: 10, bbox: { page: 10, x: 57, y: 58, width: 479, height: 400 } }
  const total = table(5, [[cell("구분"), cell("값")], [cell("합계"), cell("16")]])
  const spanned = table(9, [[cell("구분"), cell("값")], [cell("가", 2), cell("1")], [cell(""), cell("DCT Technology Inc. 8")]])
  const out = stripAbsorbedRunningLines([high, wrongNo, total, spanned], hs, running())
  assert.equal(out[0].text, "본문\nDCT Technology Inc. 5")
  assert.equal(out[1].text, "본문\nDCT Technology Inc. 3")
  assert.equal(out[2].table!.rows, 2)
  assert.equal(out[3].table!.rows, 3)
})
it("쪽 번호뿐인 꼴·줄 끝이 아닌 서식 번호(\"<붙임1>\")·숫자 없는 꼴·머리 띠 블록은 걷을 꼴이 아니다", () => {
  const pageNo = (page: number): IRBlock => ({ type: "paragraph", text: `- ${page} -`, pageNumber: page, bbox: { page, x: 280, y: 40, width: 30, height: 10 } })
  assert.equal(runningLinePatterns([pageNo(1), pageNo(2), pageNo(3)], hs).size, 0)
  assert.equal(runningLinePatterns([footer(5, 1, "<붙임"), footer(7, 2, "<붙임"), footer(9, 3, "<붙임")].map(b => ({ ...b, text: b.text + ">" })), hs).size, 0)
  const head = (page: number): IRBlock => ({ type: "paragraph", text: "2025 행정업무운영 편람", pageNumber: page, bbox: { page, x: 57, y: 790, width: 200, height: 12 } })
  assert.equal(runningLinePatterns([head(1), head(2), head(3)], hs).size, 0)
  // 숫자 없는 바닥 띠 꼴 — 쪽마다 아래에 되풀이되는 사업 담당 줄일 수 있다(함평 계획서 "축산과 가축위생팀장 김영수")
  const staff = (page: number): IRBlock => ({ ...footer(page, 0), text: "축산과 가축위생팀장 김영수" })
  assert.equal(runningLinePatterns([staff(1), staff(2), staff(3)], hs).size, 0)
})

// 숫자가 바뀌는 머리 띠 꼴 — 낱말에 붙지 않은 숫자(쪽 번호·도장)나 쪽마다 되풀이되는 글만 러닝 머리말이다
const top = (text: string, page: number): IRBlock => ({ type: "paragraph", text, pageNumber: page, bbox: { page, x: 60, y: 780, width: 200, height: 11 } })
const hs40 = new Map(Array.from({ length: 40 }, (_, i) => [i + 1, 842] as [number, number]))
it("연속 쪽의 첨부 이름표(\"<별지 서식 제3호>\"·\"<붙임2>\")는 서식 번호가 바뀌어도 머리말이 아니다 (pr-1674·pair06)", () => {
  assert.deepEqual(removeHeaderFooterBlocks([27, 28, 29, 30].map(p => top(`<별지 서식 제${p - 24}호>`, p)), hs40, []), [])
  assert.deepEqual(removeHeaderFooterBlocks([8, 9, 10].map(p => top(`<붙임${p - 6}>`, p)), hs40, []), [])
})
it("쪽 번호·내려받기 도장·되풀이되는 장 머리말은 숫자가 바뀌어도 지운다", () => {
  assert.deepEqual(removeHeaderFooterBlocks([1, 2, 3].map(p => top(`- ${p} -`, p)), hs40, []), [0, 1, 2])
  assert.deepEqual(removeHeaderFooterBlocks([1, 2, 3].map(p => top(`김유진 / 2026091716035${p}769 /`, p)), hs40, []), [0, 1, 2])
  assert.deepEqual(removeHeaderFooterBlocks([1, 2, 3, 4].map(p => top(`제${p < 3 ? 1 : 2}장 일반`, p)), hs40, []), [0, 1, 2, 3])
})
it("머리 띠의 드문 번호 글(강의 번호)은 쪽과 같이 늘 때만 지우고, 바닥 띠의 드문 번호 줄은 종전대로 지운다", () => {
  assert.deepEqual(removeHeaderFooterBlocks([[3, 1], [9, 2], [20, 3]].map(([p, n]) => top(`강의 0${n}.`, p)), hs40, []), [])
  assert.deepEqual(removeHeaderFooterBlocks([[6, 5], [17, 16], [25, 24]].map(([p, n]) => top(`DCT Technology Inc. ${n}`, p)), hs40, []), [0, 1, 2])
  const bottom = (text: string, page: number): IRBlock => ({ type: "paragraph", text, pageNumber: page, bbox: { page, x: 60, y: 30, width: 300, height: 11 } })
  assert.deepEqual(removeHeaderFooterBlocks([[5, "2.3.5"], [17, "2.2.6"], [36, "2.3.4"]].map(([p, n]) => bottom(`부속서 3의 ${n} 참조 - 역주`, p as number)), hs40, []), [0, 1, 2])
})
