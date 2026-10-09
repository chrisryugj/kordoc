/**
 * 보도자료 연락처 표 — "담당 부서 | 부서 | 책임자·담당자 | 직위 | 이름 | 연락처". HWPX 원본은 코퍼스 470여 개가 모두 이 6열이지만,
 * 칸 클립 없이 점선으로 테두리만 그린 구버전 한컴 PDF 는 직위·이름·연락처 사이 세로선이 없고 이름과 연락처가 한 글 조각이라
 * 4열("과 장 정희철 (044-214-2730)" 한 칸)로 읽힌다. 끝 칸이 행마다 "직위 이름 (연락처)" 꼴이면 세 칸으로 가르고(담당자가 여럿이면
 * 줄마다 한 사람 — 세 칸에 줄째 모은다, 원본도 칸 안 줄마다 한 사람), 앞 두 열의 병합 칸(표 전체든 부서 블록이든)은 글줄이 병합
 * 행 수 이하면 줄마다 제 행 칸으로 나눈다(가로선이 없을 뿐 원본은 행마다 칸이다)
 */

import type { IRBlock, IRCell } from "../types.js"

export const CONTACT_HEAD = /^(?:담당\s*부서|<[^<>]+>)$/
export const CONTACT_ROLE = /^(?:책임자|담당자)$/
/** 직위(띄어 쓴 두 글자 "과 장" 포함) · 이름 2~4자 · 연락처(괄호 전화·전자우편) */
const PERSON = /^(.+?)\s+([가-힣]{2,4})\s+(\([^()]*\d[^()]*\)|\S+@\S+)$/

export function splitContactTables(blocks: IRBlock[]): void {
  for (const b of blocks) {
    const t = b.type === "table" ? b.table : undefined
    if (!t || t.cols !== 4 || t.rows < 2) continue
    const rows = t.cells
    if (!CONTACT_HEAD.test(rows[0][0].text.replace(/\s+/g, " ").trim())) continue
    // 줄마다 "직위 이름 (연락처)" 면 여러 사람, 아니면 칸 통째로 한 사람(줄 꺾인 칸) — 통째 먼저 재면 앞 사람 전체가 직위 자리에 든다
    const people = rows.map(r => {
      const lines = r[3].text.split("\n").map(line => PERSON.exec(line.replace(/\s+/g, " ").trim()))
      if (lines.length > 1 && lines.every(Boolean)) return lines as RegExpExecArray[]
      const whole = PERSON.exec(r[3].text.replace(/\s+/g, " ").trim())
      return whole ? [whole] : null
    })
    if (people.some(p => !p) || rows.some(r => !CONTACT_ROLE.test(r[2].text.replace(/\s+/g, "")) || r[2].rowSpan !== 1 || r[3].rowSpan !== 1)) continue
    // 앞 두 열 — 병합 칸만 줄마다 그 병합 행들로 나눈다 (행마다 칸이면 그대로)
    const lead: string[][] = []
    let ok = true
    for (const c of [0, 1]) {
      const col = rows.map(() => "")
      for (let r = 0; r < t.rows;) {
        const cell = rows[r][c], span = Math.min(Math.max(1, cell.rowSpan), t.rows - r)
        const lines = span === 1 ? [cell.text] : cell.text.split("\n").map(s => s.trim()).filter(Boolean)
        if (lines.length > span) { ok = false; break }
        lines.forEach((line, k) => { col[r + k] = line })
        r += span
      }
      if (!ok) break
      lead.push(col)
    }
    if (!ok) continue
    const one = (text: string): IRCell => ({ text, colSpan: 1, rowSpan: 1 })
    const part = (i: number, k: number) => one(people[i]!.map(p => p[k]).join("\n"))
    t.cells = rows.map((r, i) => [one(lead[0][i]), one(lead[1][i]), one(r[2].text), part(i, 1), part(i, 2), part(i, 3)])
    t.cols = 6
  }
}
