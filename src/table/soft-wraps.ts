/**
 * 칸 폭에 밀려 어절 경계로 꺾인 칸 글 줄쌍(PDF 칸) — 칸 글(IR)은 줄 그대로 두고, 마크다운으로 낼 때(표 칸·틀을 푼 문단) 띄어 잇는다.
 * 칸 판정(쌓인 값 칸·연락처 칸 등)은 줄 단위로 보므로 IR 글을 바꾸지 않는다
 */
import type { IRCell } from "../types.js"

/** 칸 글에서 칸 폭에 밀려 어절 경계로 꺾인 줄쌍("앞 줄\n뒤 줄", 다듬은 글) — 틀을 풀어 문단으로 만들 때 이 줄쌍은 띄어 잇는다(PDF 칸) */
export const CELL_SOFT_WRAPS = new WeakMap<IRCell, Set<string>>()
/** 칸 글 → 문단 글들 — 줄마다 한 문단, 꺾인 줄쌍(CELL_SOFT_WRAPS)은 띄어 한 문단 */
export function cellParagraphs(cell: IRCell, text = cell.text): string[] {
  const soft = CELL_SOFT_WRAPS.get(cell)
  const out: string[] = []
  let last = ""
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    if (out.length && soft?.has(last + "\n" + line)) out[out.length - 1] += " " + line
    else out.push(line)
    last = line
  }
  return out
}
/** 칸을 복제·합칠 때 꺾인 줄쌍을 넘긴다 */
export function carrySoftWraps(from: IRCell, to: IRCell): void {
  const a = CELL_SOFT_WRAPS.get(from)
  if (!a || from === to) return
  const b = CELL_SOFT_WRAPS.get(to)
  CELL_SOFT_WRAPS.set(to, b ? new Set([...b, ...a]) : a)
}

/** 마크다운용 칸 글 — 꺾인 줄쌍 사이 줄바꿈만 공백으로, 나머지는 그대로 */
export function softWrappedText(cell: IRCell, text = cell.text): string {
  const soft = CELL_SOFT_WRAPS.get(cell)
  if (!soft || !text.includes("\n")) return text
  const lines = text.split("\n")
  let out = lines[0]
  for (let i = 1; i < lines.length; i++) out += (soft.has(lines[i - 1].trim() + "\n" + lines[i].trim()) && lines[i - 1].trim() && lines[i].trim() ? " " : "\n") + lines[i]
  return out
}
