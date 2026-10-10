/**
 * 통계표 행 머리의 배분 정렬 두 음절 — "건  축"·"토  목"·"전  체" 처럼 두 음절을 칸 폭에 벌려 둔 행 머리를 칸 글 조립(cellTextToString)은
 * 칸 하나만 보고 어휘로만 판정해 붙이지 못했다: 문서에 "건축" 이 홀로 선 어절로 안 나오고(합성어 속뿐) 표 칸의 "건 축" 자체가 줄 안 띄움
 * 증거로 잡혔다(2025 건설업조사 보도자료 행 머리 70곳). 값 칸 둘 이상이 숫자인 행에서, 두 음절이 칸 폭을 꽉 채운 배분 정렬이고(칸 폭에서
 * 두 글자 높이를 뺀 것 이상, 줄 폭은 글자 높이 3배 이상) 붙인 꼴이 문서 줄 안 어절의 머리로 나오거나 시도 이름이면 붙인다. 가운데에 띄어 쓴
 * 이름표("충 북", 벼·고추 재배면적조사 — 원문도 띄움)는 칸을 채우지 않아, 서식 이름표("성  명")는 값 칸이 숫자가 아니라 걸리지 않는다.
 * 두 음절 사이에 진짜 공백 글리프가 있으면 원문이 띄운 칸이라 붙이지 않는다("인 정"·"보 험" — 제주4·3 보상 신청 표·가계대출 동향). 공백 글리프가
 * 없다고 원문이 붙인 것은 아니다(해외직접투자 보도자료 "전 체" 는 글리프 없이 띄움) — 그래서 어절 머리 증거는 그대로 둔다
 */

import type { IRCell } from "../types.js"
import { CELL_LINES } from "./table-meta.js"
import type { WrapLexicon } from "./line-wrap.js"

const NUMBER = /^[-+△▲▽]?\d[\d,]*(?:\.\d+)?%?$/
const SPREAD = /^([가-힣]) ([가-힣])$/

/** 숫자 값 행의 벌어진 두 음절 머리 칸을 제자리에서 붙인다 */
export function joinSpreadRowLabels(grid: IRCell[][], lex: WrapLexicon, regions: ReadonlySet<string>,
  boxOf: (cell: IRCell) => { x1: number; x2: number } | undefined, spaced: (cell: IRCell) => boolean): void {
  for (const row of grid) {
    if (row.filter(c => NUMBER.test(c.text.trim())).length < 2) continue
    for (const cell of row) {
      const m = SPREAD.exec(cell.text.trim())
      if (!m) continue
      const lines = CELL_LINES.get(cell), box = boxOf(cell)
      if (!lines || lines.length !== 1 || !box || spaced(cell)) continue
      const { l, r, h } = lines[0]
      if (r - l < 3 * h || r - l < box.x2 - box.x1 - 2 * h) continue
      const word = m[1] + m[2]
      if (lex.startsWord(word) || lex.isWord(word) || regions.has(word)) cell.text = word
    }
  }
}
