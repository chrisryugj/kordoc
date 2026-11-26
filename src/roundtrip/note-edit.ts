/**
 * 각주·미주 글 고치기 (HWPX, #240). 마크다운에 각주 글은 달린 문단 끝 "(주: 1) 각주 글)" 로 나오고, 원문에서는 달린 문단 안
 * hp:footNote/hp:subList 의 문단이다. 소스맵이 달린 문단마다 각주 본문 문단을 올려 두므로(ScanParagraph.notes), 고친 각주의 문단만
 * 본문 문단과 같은 치환(바뀐 자리만)으로 고친다. 각주 번호는 개체가 그리는 글이라 건드리지 않고, 각주 수·순서가 바뀌는 편집은 알리고 둔다
 */

import { minimalTextSplices } from "./inline-edit.js"
import { NOTE_TEXT_UNSUPPORTED, normForMatch, noteParaEdit, planNoteEdits } from "./markdown-units.js"
import type { ScanParagraph, SpliceEdit } from "./source-map.js"

/** 각주 글 편집 → 각주 문단 splice. 옮기지 못하면 이유 문자열, 바뀐 각주가 없으면 빈 배열 */
export function noteEditSplices(host: ScanParagraph, xml: string | undefined, origNote: string, newNote: string): SpliceEdit[] | string {
  if (!host.notes?.length || xml === undefined) return NOTE_TEXT_UNSUPPORTED
  const plan = planNoteEdits(origNote, newNote, host.notes.map(paras => paras.map(p => p.text).join(" ")))
  if (typeof plan === "string") return plan
  const out: SpliceEdit[] = []
  for (const edit of plan) {
    const paras = host.notes[edit.index].filter(p => normForMatch(p.text) !== "")
    const one = noteParaEdit(paras.map(p => normForMatch(p.text)), edit.before, edit.after)
    if (!one) return "각주의 여러 문단에 걸친 수정은 미지원 — 각주 글 수정 미적용"
    // 문단 통째 쓰기로는 가지 않는다: 각주 첫 문단은 번호 개체 뒤 공백 hp:t 로 시작해, 통째로 쓰면 번호와 글 사이가 붙는다
    const sp = minimalTextSplices(paras[one.index], xml, one.before, one.after)
    if (!sp) return "각주 문단을 원문과 맞대지 못함 — 각주 글 수정 미적용"
    out.push(...sp)
  }
  return out
}
