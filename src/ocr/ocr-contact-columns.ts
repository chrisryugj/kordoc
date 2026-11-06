/**
 * OCR 표의 연락처 열 가르기 — 보도자료 끝 "담당 부서" 표는 직급·이름·전화를 보이지 않는 칸으로 가른다("책임자 | 과 장 | 임혜영 | (044-215-2810)").
 * 선이 없어 OCR 격자에선 "과장 임혜영 (044-215-2810)" 이 한 칸이 된다(텍스트층 한컴 PDF 는 칸 클립으로 이미 갈린다).
 * 한 열에서 "직급(한글 5자 안) 이름(한글 2~4자) 전화·메일" 꼴 칸이 둘 이상·첫 그런 칸부터 채운 칸의 80% 이상이면 그 열을 세 열로 나눈다.
 * 꼴이 아닌 칸은 세 열에 걸치고, 왼쪽·위에서 걸친 칸은 두 열 더 걸친다(ocr-name-value-columns 와 같은 방식)
 */
import type { IRBlock, IRCell, IRTable } from "../types.js"

const CONTACT = /^([가-힣](?:\s*[가-힣]){0,4})\s+([가-힣]{2,4})\s*([^가-힣\s][^가-힣]{5,48})$/
const PHONE = /^\(?0\d{1,3}\)?[-\s]?\d{3,4}-\d{4}\)?$/
const MAIL = /^\(?[\w.+-]+@[\w-]+(?:\.[\w-]+)+\)?$/

/** 직급 · 이름 · 전화(또는 메일). OCR 이 메일 안에 넣은 공백("ckpar k0916@korea.kr")은 지운다 — 메일 주소엔 공백이 없다 */
function contactParts(text: string): [string, string, string] | null {
  const m = CONTACT.exec(text.trim())
  if (!m) return null
  const contact = m[3].includes("@") ? m[3].replace(/\s+/g, "") : m[3].trim()
  return PHONE.test(contact) || MAIL.test(contact) ? [m[1], m[2], contact] : null
}

/** 자리마다 그 자리를 차지한 앵커 칸 (앵커 자신 또는 왼쪽·위에서 걸친 칸) */
function owners(t: IRTable): IRCell[][] {
  const own: IRCell[][] = Array.from({ length: t.rows }, () => Array(t.cols))
  for (let r = 0; r < t.rows; r++) for (let c = 0; c < t.cols; c++) {
    if (own[r][c]) continue
    const cell = t.cells[r][c]
    for (let i = r; i < Math.min(t.rows, r + Math.max(1, cell.rowSpan ?? 1)); i++)
      for (let j = c; j < Math.min(t.cols, c + Math.max(1, cell.colSpan ?? 1)); j++) own[i][j] ??= cell
  }
  return own
}

function splitTable(t: IRTable): void {
  if (t.cells.length !== t.rows || t.cells.some(row => row.length !== t.cols)) return
  const own = owners(t)
  const anchor = (r: number, c: number) => own[r][c] === t.cells[r][c] ? t.cells[r][c] : null
  const targets: number[] = []
  for (let c = 0; c < t.cols; c++) {
    let filled = 0, hits = 0
    for (let r = 0; r < t.rows; r++) {
      const cell = anchor(r, c)
      if (!cell || (cell.colSpan ?? 1) !== 1 || cell.blocks?.length || !cell.text.trim()) continue
      if (contactParts(cell.text)) hits++
      // 첫 연락처 칸부터 센다 — 보도자료 표지는 위에 "보도일시 | … | 배포일시 | …" 행이 같은 격자에 붙는다(담당 두 행)
      if (hits) filled++
    }
    if (hits >= 2 && hits >= filled * 0.8) targets.push(c)
  }
  // 오른쪽 열부터 끼워 넣어 왼쪽 열 번호가 흔들리지 않게 한다
  for (const c of targets.reverse()) {
    const grown = new Set<IRCell>()
    for (let r = 0; r < t.rows; r++) {
      const cell = anchor(r, c)
      let added: IRCell[] = [{ text: "", colSpan: 1, rowSpan: 1 }, { text: "", colSpan: 1, rowSpan: 1 }]
      if (cell && (cell.colSpan ?? 1) === 1 && !cell.blocks?.length) {
        const parts = contactParts(cell.text)
        if (parts) { cell.text = parts[0]; added = [{ ...cell, text: parts[1] }, { ...cell, text: parts[2] }] }
        else cell.colSpan = 3
        grown.add(cell)
      } else if (!grown.has(own[r][c])) {
        own[r][c].colSpan = Math.max(1, own[r][c].colSpan ?? 1) + 2
        grown.add(own[r][c])
      }
      t.cells[r].splice(c + 1, 0, ...added)
    }
    t.cols += 2
  }
}

/** OCR 블록의 표마다 연락처 열을 가른다(제자리) */
export function splitOcrContactColumns(blocks: IRBlock[]): IRBlock[] {
  for (const b of blocks) if (b.type === "table" && b.table) splitTable(b.table)
  return blocks
}
