/** 보도자료 연락처 표 — 칸 클립 없는 PDF 에서 4열로 뭉친 "직위 이름 연락처" 칸을 HWPX 서식처럼 6열로 (src/pdf/contact-table.ts) */

import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { splitContactTables } from "../src/pdf/contact-table.js"
import type { IRBlock, IRCell } from "../src/types.js"

const cell = (text: string, rowSpan = 1): IRCell => ({ text, colSpan: 1, rowSpan })
const block = (cells: IRCell[][]): IRBlock => ({ type: "table", table: { rows: cells.length, cols: cells[0].length, cells, hasHeader: false } })

describe("splitContactTables", () => {
  it("두 행 연락처 표: 앞 두 열 병합 칸은 줄마다 행으로, 끝 칸은 직위·이름·연락처 세 칸으로", () => {
    const b = block([
      [cell("담당 부서", 2), cell("예산실\n산업중소벤처예산과", 2), cell("책임자"), cell("과 장 정희철 (044-214-2730)")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 이대권 (daekwon@korea.kr)")],
    ])
    splitContactTables([b])
    assert.equal(b.table!.cols, 6)
    assert.deepEqual(b.table!.cells.map(r => r.map(c => c.text)), [
      ["담당 부서", "예산실", "책임자", "과 장", "정희철", "(044-214-2730)"],
      ["", "산업중소벤처예산과", "담당자", "사무관", "이대권", "(daekwon@korea.kr)"],
    ])
    assert.ok(b.table!.cells.flat().every(c => c.rowSpan === 1 && c.colSpan === 1))
  })

  it("부서마다 따로 병합된 앞 두 열·담당자 여럿인 끝 칸도 가른다 (반도체 제조업 점검 보도자료 156782525 — HWPX 는 담당자 칸 안 줄마다 한 사람)", () => {
    const b = block([
      [cell("담당 부서", 2), cell("안전보건감독국\n안전보건감독기획과", 2), cell("책임자"), cell("과 장 박상원 (044-202-8901)")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 강숭훈 (044-202-8914)\n주무관 성은창 (044-202-8915)")],
      [cell("담당 부서", 2), cell("충북권 중대산업사고예방센터", 2), cell("책임자"), cell("센터장 배영진 (043-870-5950)")],
      [cell(""), cell(""), cell("담당자"), cell("감독관 장용우 (043-870-5951)")],
    ])
    splitContactTables([b])
    assert.equal(b.table!.cols, 6)
    assert.deepEqual(b.table!.cells.map(r => r.map(c => c.text)), [
      ["담당 부서", "안전보건감독국", "책임자", "과 장", "박상원", "(044-202-8901)"],
      ["", "안전보건감독기획과", "담당자", "사무관\n주무관", "강숭훈\n성은창", "(044-202-8914)\n(044-202-8915)"],
      ["담당 부서", "충북권 중대산업사고예방센터", "책임자", "센터장", "배영진", "(043-870-5950)"],
      ["", "", "담당자", "감독관", "장용우", "(043-870-5951)"],
    ])
  })

  it("한 사람 칸이 줄 꺾여도 종전처럼 한 사람으로 (줄마다 가르지 않는다)", () => {
    const b = block([
      [cell("담당 부서", 2), cell("예산실", 2), cell("책임자"), cell("과 장 정희철\n(044-214-2730)")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 이대권 (daekwon@korea.kr)")],
    ])
    splitContactTables([b])
    assert.deepEqual(b.table!.cells[0].map(c => c.text), ["담당 부서", "예산실", "책임자", "과 장", "정희철", "(044-214-2730)"])
  })

  it("닫는 괄호가 빠지거나 이름에 붙은 연락처가 섞여도 가른다 (156775926 \"양재훈 (02-2100-1685\"·\"이승호(happysh89@korea.kr)\")", () => {
    const b = block([
      [cell("담당 부서", 2), cell("기획예산처\n인구구조혁신과", 2), cell("책임자"), cell("과 장 신대원 (044-214-1730)")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 이상후 (halamadrid@korea.kr)")],
      [cell("담당 부서", 2), cell("금융위원회\n청년정책과", 2), cell("책임자"), cell("과 장 양재훈 (02-2100-1685")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 이승호(happysh89@korea.kr)")],
    ])
    splitContactTables([b])
    assert.equal(b.table!.cols, 6)
    assert.deepEqual(b.table!.cells.map(r => r.slice(3).map(c => c.text)), [
      ["과 장", "신대원", "(044-214-1730)"], ["사무관", "이상후", "(halamadrid@korea.kr)"],
      ["과 장", "양재훈", "(02-2100-1685"], ["사무관", "이승호", "(happysh89@korea.kr)"],
    ])
  })

  it("모든 사람이 이름에 연락처를 붙여 쓴 표는 원문도 한 칸이라 그대로 4열 (156775911 \"과 장 김형수(044-201-3488)\")", () => {
    const b = block([
      [cell("담당 부서", 2), cell("국토교통부\n국가공간정보센터", 2), cell("책임자"), cell("과 장 김형수(044-201-3488)")],
      [cell(""), cell(""), cell("담당자"), cell("사무관 윤동영(044-201-3495)")],
    ])
    splitContactTables([b])
    assert.equal(b.table!.cols, 4)
  })

  it("연락처 모양이 아닌 4열 표는 그대로", () => {
    const b = block([[cell("구분"), cell("내용"), cell("책임자"), cell("홍길동")], [cell("가"), cell("나"), cell("담당자"), cell("비고 없음")]])
    splitContactTables([b])
    assert.equal(b.table!.cols, 4)
  })
})
