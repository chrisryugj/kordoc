/**
 * HWP 5.x 본문 문단 더하기·빼기 — patch 의 블록 추가·삭제(HWPX 는 structure edit 가 한다).
 *
 * 더하기: 편집본에 새로 생긴 평문 문단을 바로 앞 원문 블록(문단 또는 표를 담은 문단) 뒤에, 그 문단의 문단 모양·첫 글자 모양으로
 * 끼운다(한글에서 Enter 와 같다). 제목·목록·표·강조·링크 같은 마크다운 서식이 든 새 블록은 건너뛴다(원문 서식을 고를 근거가 없다).
 * 빼기: 원문의 맨 문단(컨트롤·누름틀·각주 없음, 섹션 맨 위 레벨)만 레코드를 지운다. 구역 정의가 든 첫 문단은 컨트롤이 있어 지우지 않는다.
 * 끝나면 섹션 마지막 문단 표시를 다시 맞춘다(fixTopLevelLastMark).
 */
import { deleteParagraph, groupEnd, insertParagraph, newParagraph } from "./hwp5-cell-lines.js"
import type { ScanPara5, SectionScan5 } from "./hwp5-patch.js"

const TAG_CTRL_HEADER = 0x47

/** 끼울 자리의 기준 — 문단(그 문단 모양을 본뜬다)과 그 묶음 끝 */
export interface BodyAnchor { scan: SectionScan5; tpl: ScanPara5; at: number }

/** 원문 문단이 지울 수 있는 맨 문단인가 */
function plainBodyPara(scan: SectionScan5, p: ScanPara5): boolean {
  if (p.kind !== "body" || scan.records[p.headerIdx].level !== 0 || p.guides.length || p.notes?.length || p.rangeTagCount) return false
  for (let j = p.headerIdx + 1; j < groupEnd(scan, p.headerIdx); j++) if (scan.records[j].tagId === TAG_CTRL_HEADER) return false
  return true
}

/** 본문 맨 위 문단 → 그 뒤가 끼울 자리 */
export function anchorAfter(scan: SectionScan5, p: ScanPara5 | undefined): BodyAnchor | null {
  if (!p || p.kind !== "body" || scan.records[p.headerIdx].level !== 0) return null
  return { scan, tpl: p, at: groupEnd(scan, p.headerIdx) }
}

/**
 * 표를 담은 문단 뒤. 표 담은 문단은 배치용 모양(균등 배분·작은 글자)이 흔해 그대로 본뜨면 새 글이 어긋난다 —
 * 문단 모양은 가까운 글 문단(표 다음, 없으면 앞의 컨트롤 없는 본문 문단)에서, 자리는 표 뒤로
 */
export function anchorAfterHost(scan: SectionScan5, hostIdx: number, paras: ScanPara5[]): BodyAnchor | null {
  const k = paras.findIndex(p => p.headerIdx === hostIdx)
  const host = paras[k]
  if (!host || host.kind !== "body" || scan.records[host.headerIdx].level !== 0) return null
  const textual = (p: ScanPara5) => p.kind === "body" && scan.records[p.headerIdx].level === 0 && p.rawText.trim() !== "" && plainBodyPara(scan, p)
  const tpl = paras.slice(k + 1).find(textual) ?? paras.slice(0, k).reverse().find(textual) ?? host
  return { scan, tpl, at: groupEnd(scan, host.headerIdx) }
}

/** 새 블록 마크다운이 서식 없는 한 줄 글인가 — 그 글을 돌려준다 */
export function plainNewText(raw: string): string | null {
  const t = raw.trim()
  if (!t || t.includes("\n")) return null
  if (/^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|!\[|<)/.test(t) || /[\\*_`$<>[\]|]/.test(t)) return null
  return t
}

/** 원문 문단 지우기 — 못 지우면 false */
export function deleteBodyPara(scan: SectionScan5, p: ScanPara5 | undefined): boolean {
  if (!p || !scan.safe || !plainBodyPara(scan, p) || scan.repl.has(p.headerIdx)) return false
  deleteParagraph(scan, p.headerIdx)
  return true
}

/** 새 문단 끼우기 */
export function addBodyPara(anchor: BodyAnchor, text: string): void {
  insertParagraph(anchor.scan, anchor.at, 0, newParagraph(anchor.scan, anchor.tpl, text, 0))
}
