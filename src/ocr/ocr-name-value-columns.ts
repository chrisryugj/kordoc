/**
 * OCR 표의 이름·값 열 가르기 — 순위표(국적별 입국자 상위 10개국)는 연도 묶음마다 "국적 | 입국자" 두 열을 세로선 없이 빈칸으로만 가른다.
 * 검출 상자가 이름과 값을 한 상자로 읽어 칸 하나에 "중 국155,252" 가 붙고, 꺾인 이름은 "인도네 7,827\n시아" 로 값 뒤에 온다.
 * 한 열에서 이름(글자 2자+, 숫자 없음)과 수 하나로 된 칸이 다섯 이상·채운 칸의 80% 이상이면 그 열을 이름 열과 값 열로 나눈다.
 * 바로 위 머리 칸("국 적입국자")은 같은 행 다른 머리 칸이 공백으로 보여 준 갈림("국적 입국자")을 따라 가르고, 못 가르면 두 열에 걸친다.
 * 텍스트층 표는 글자 자리로 칸이 이미 갈려 이 처리를 타지 않는다(OCR 전용)
 */
import type { IRBlock, IRCell, IRTable } from "../types.js"

/** (여러 줄로 꺾일 수 있는) 이름 + 수 하나 (+ 같은 줄 군글자 둘까지, 다음 줄 이름 나머지) */
const NAME_VALUE = /^([^\d]*?)\s*(\d[\d,.]*\d|\d)([^\d\n]{0,2})(?:\n([^\d]*))?$/

interface Split { name: string; value: string }

function nameValue(text: string): Split | null {
  const m = NAME_VALUE.exec(text.trim())
  if (!m) return null
  const name = [m[1], m[4] ?? ""].map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean).join(" ")
  if ((name.match(/[가-힣A-Za-z]/g) ?? []).length < 2) return null
  return { name, value: (m[2] + m[3]).trim() }
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

/** 머리 칸 글의 공백 갈림 후보 [왼쪽, 오른쪽] (공백 뺀 글) — 한 글자 쪽은 글자 띄운 머리("국 적")의 틈이라 뺀다 */
function headerCuts(text: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const m of text.matchAll(/\s+/g)) {
    const l = text.slice(0, m.index).replace(/\s+/g, ""), r = text.slice(m.index! + m[0].length).replace(/\s+/g, "")
    if (l.length >= 2 && r.length >= 2) out.push([l, r])
  }
  return out
}

/** 공백 뺀 왼쪽 글이 left 가 되는 자리에서 원문을 가른다 */
function cutAt(text: string, left: string): [string, string] | null {
  let n = 0
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i])) n++
    if (n === left.length) return [text.slice(0, i + 1).trim(), text.slice(i + 1).trim()]
  }
  return null
}

function splitTable(t: IRTable): boolean {
  if (t.cells.length !== t.rows || t.cells.some(row => row.length !== t.cols)) return false
  const own = owners(t)
  const anchor = (r: number, c: number) => own[r][c] === t.cells[r][c] ? t.cells[r][c] : null
  // 가를 열과 그 열의 첫 이름·값 행
  const targets: Array<{ c: number; first: number }> = []
  for (let c = 0; c < t.cols; c++) {
    let filled = 0, hits = 0, grouped = 0, first = -1
    for (let r = 0; r < t.rows; r++) {
      const cell = anchor(r, c)
      if (!cell || (cell.colSpan ?? 1) !== 1 || cell.blocks?.length || !cell.text.trim()) continue
      const nv = nameValue(cell.text)
      if (nv) { hits++; if (first < 0) first = r; if (/,\d{2}|\.\d/.test(nv.value)) grouped++ }
      if (first >= 0) filled++
    }
    // 쉼표 묶음·소수 값이 둘 이상 — "제 3" 같은 번호 열은 값 열이 아니다
    if (hits >= 5 && hits >= filled * 0.8 && grouped >= 2) targets.push({ c, first })
  }
  if (!targets.length) return false
  // 첫 이름·값 행은 열들의 최빈 시작 행 — 첫 칸 오독("중 국19,36")으로 한 열만 늦게 시작해도 머리 행은 같다
  const starts = new Map<number, number>()
  for (const { first } of targets) starts.set(first, (starts.get(first) ?? 0) + 1)
  const start = [...starts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0]
  for (const tg of targets) if (tg.first > start) tg.first = start
  // 바로 위 머리 칸 갈림 — 같은 행 머리 칸들의 공백 갈림 가운데 가장 흔한 것(동률이면 가르지 않는다)
  const heads = targets.map(({ c, first }) => {
    const cell = first > 0 ? anchor(first - 1, c) : null
    return cell && (cell.colSpan ?? 1) === 1 && (cell.rowSpan ?? 1) === 1 && cell.text.trim() ? cell : null
  })
  const votes = new Map<string, number>()
  for (const h of heads) if (h) for (const [l, r] of headerCuts(h.text.trim())) votes.set(`${l}\u0000${r}`, (votes.get(`${l}\u0000${r}`) ?? 0) + 1)
  const [best, second] = [...votes].sort((a, b) => b[1] - a[1])
  const cut = best && (!second || best[1] > second[1]) ? best[0].split("\u0000") as [string, string] : null

  // 오른쪽 열부터 끼워 넣어 왼쪽 열 번호가 흔들리지 않게 한다
  for (const [k, { c, first }] of [...targets.entries()].reverse()) {
    const grown = new Set<IRCell>()
    for (let r = 0; r < t.rows; r++) {
      const cell = anchor(r, c)
      let right: IRCell = { text: "", colSpan: 1, rowSpan: 1 }
      if (cell && (cell.colSpan ?? 1) === 1 && !cell.blocks?.length) {
        const text = cell.text.trim()
        const nv = r >= first ? nameValue(text) : null
        const head = r === first - 1 && heads[k] === cell && cut && text.replace(/\s+/g, "") === cut.join("") ? cutAt(text, cut[0]) : null
        if (nv) { cell.text = nv.name; right = { ...cell, text: nv.value } }
        else if (head) { cell.text = head[0]; right = { ...cell, text: head[1] } }
        // 이름 없이 수만 든 칸은 값 열로
        else if (r >= first && text && /^[\d,.\s%()+-]+$/.test(text)) { right = { ...cell, text }; cell.text = "" }
        else cell.colSpan = 2
        // 아래로 걸친 칸은 짝(값 칸)도 같이 걸쳐 덮인 자리엔 빈 칸만 끼운다
        grown.add(cell)
      } else if (!grown.has(own[r][c])) {
        // 걸친 칸(머리 묶음 "2000"·내려온 "순위")은 한 열 더 걸친다
        own[r][c].colSpan = Math.max(1, own[r][c].colSpan ?? 1) + 1
        grown.add(own[r][c])
      }
      t.cells[r].splice(c + 1, 0, right)
    }
    t.cols++
  }
  return true
}

/** OCR 블록의 표마다 이름·값 열을 가른다(제자리) */
export function splitOcrNameValueColumns(blocks: IRBlock[]): IRBlock[] {
  for (const b of blocks) if (b.type === "table" && b.table) splitTable(b.table)
  return blocks
}
