/**
 * 메모(한글 "메모 넣기") 결과 손질 (#180) — 메모가 붙은 블록 순번 찾기와 마크다운 끝 "메모" 절. HWPX·HWP5 파서가 같이 쓴다.
 * 메모는 본문 마크다운에 섞지 않는다(채점·patch 소스맵 불변) — 끝 절은 `memos` 옵션을 켰을 때만
 */

import type { IRBlock, MemoNote } from "./types.js"
import { escapeGfm, sanitizeText } from "./table/builder.js"

const squash = (s: string): string => sanitizeText(s).replace(/\s+/g, "")

/** 블록 글 — 표는 칸 글까지 (칸 안 메모를 그 표 블록에 붙이려고) */
function blockText(b: IRBlock): string {
  if (b.type !== "table" || !b.table) return b.text ?? ""
  return b.table.cells.flat().map(c => c?.text ?? "").join("\n")
}

/** 메모마다 붙은 문단이 든 블록 순번 — 문서 순서라 앞 메모의 블록부터 찾고, 없으면 처음부터. 칸 차례는 MemoNote 순서로 맞춘다 */
export function locateMemoBlocks(blocks: IRBlock[], memos: MemoNote[]): MemoNote[] {
  const keys = blocks.map(b => squash(blockText(b)))
  let from = 0
  return memos.map(m => {
    const k = squash(m.paragraph)
    let i = k ? keys.findIndex((t, j) => j >= from && t.includes(k)) : -1
    if (k && i < 0) i = keys.findIndex(t => t.includes(k))
    if (i >= 0) from = i
    const out: MemoNote = { text: m.text, anchor: m.anchor, paragraph: m.paragraph, offset: m.offset }
    if (i >= 0) out.blockIndex = i
    if (m.author !== undefined) out.author = m.author
    if (m.createdAt !== undefined) out.createdAt = m.createdAt
    if (m.number !== undefined) out.number = m.number
    return out
  })
}

/** 마크다운 끝 "메모" 절 — 메모마다 작성자·시각, 붙은 글, 메모 글 */
export function memosMarkdown(memos: MemoNote[]): string {
  const one = (s: string): string => escapeGfm(sanitizeText(s.replace(/\s*\n\s*/g, " / ")))
  const lines = memos.map((m, i) => {
    const when = m.createdAt?.replace("T", " ").replace(/(:\d\d)?Z?$/, "")
    const who = [m.author, when].filter(Boolean).join(", ")
    return `${i + 1}. ${who ? `(${one(who)}) ` : ""}「${one(m.anchor)}」 — ${one(m.text)}`
  })
  return `\n\n---\n\n**메모**\n\n${lines.join("\n")}\n`
}
