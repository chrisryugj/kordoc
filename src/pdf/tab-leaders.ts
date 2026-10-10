/**
 * 탭 채움 리더 — 목차 탭의 점선 채움은 가운뎃점으로 찍힌다. 제작기·판에 따라 점마다 따로(SO-SUEOP "I.소설의 이해 ······ 3", 점마다
 * 글자 위치 이동), 두세 점씩 조각으로(pcccr 첨부), 한 글자열로(행정업무운영 편람 목차 "········") 나온다. 채움선은 글이 아니다 —
 * HWPX·HWP5 파서도 탭 채움을 내지 않는다. 채움은 쪽 번호 앞에 선다: 같은 줄에서 가운뎃점만 든 조각들이 글자 크기보다 좁은 간격으로
 * 이어져 점이 넷 이상이고 오른쪽에 쪽 번호가 따라오면 탭 하나로 바꾼다(자리는 남긴다 — 지우면 쪽 번호가 앞 글에 붙는다, 균등배분 붙임
 * "1 총 칙 1" → "총칙1"). 쪽 번호 없는 점 줄은 글로 친 구분선이다(DOCX 서식 "······" — 원본 글). 마침표 리더(Word·LibreOffice 목차
 * "....")는 ODL 정답이 글로 담아 그대로 둔다
 */

import type { NormItem } from "./text-line.js"

const MIN_DOTS = 4
/** 글 속 채움 — 가운뎃점 넷 이상 뒤 쪽 번호 */
const INLINE = /\s*·{4,}\s*(?=\d{1,4}\s*$)/
const PAGE_NO = /^\d{1,4}$/
const DOTS = /^·+$/

export function dropTabLeaderDots(items: NormItem[]): NormItem[] {
  if (!items.some(it => it.text.includes("·"))) return items
  const sameLine = (a: NormItem, b: NormItem) => Math.abs(a.y - b.y) <= Math.max(a.fontSize, b.fontSize) * 0.3
  // 채움 오른쪽 같은 줄에 쪽 번호 아이템이 있는가
  const pageNoAfter = (right: number, ref: NormItem) => items.some(it => PAGE_NO.test(it.text.trim()) && sameLine(it, ref) && it.x >= right - 2)
  const drop = new Set<NormItem>()
  const edit = new Map<NormItem, { text: string; right?: number }>()
  for (const it of items) if (!DOTS.test(it.text.trim()) && it.text.includes("····") && INLINE.test(it.text)) edit.set(it, { text: it.text.replace(INLINE, "\t") })
  // 가운뎃점만 든 조각 — 같은 기준선에서 이웃 조각 사이(앞 조각 끝 → 뒤 조각 시작)가 글자 크기의 0.7배 이하면 한 채움.
  // 좌표가 정수로 반올림돼(normalizeItems) 점 하나짜리 조각은 겹치거나 2~5pt 로 흔들린다
  const byLine = new Map<number, NormItem[]>()
  for (const d of items) if (DOTS.test(d.text.trim())) byLine.set(Math.round(d.y * 2), [...(byLine.get(Math.round(d.y * 2)) ?? []), d])
  for (const line of byLine.values()) {
    line.sort((a, b) => a.x - b.x)
    let run: NormItem[] = []
    const flush = () => {
      const last = run[run.length - 1]
      const dots = run.reduce((n, d) => n + d.text.trim().length, 0)
      if (dots >= MIN_DOTS && pageNoAfter(last.x + last.w, last)) {
        edit.set(run[0], { text: "\t", right: last.x + last.w })
        for (const d of run.slice(1)) drop.add(d)
      }
      run = []
    }
    for (const d of line) {
      const prev = run[run.length - 1]
      if (prev && !(d.x > prev.x && d.x - (prev.x + prev.w) <= Math.max(prev.fontSize, d.fontSize) * 0.7)) flush()
      run.push(d)
    }
    if (run.length) flush()
  }
  if (!drop.size && !edit.size) return items
  return items.filter(it => !drop.has(it)).map(it => {
    const e = edit.get(it)
    return e ? { ...it, text: e.text, w: (e.right ?? it.x + it.w) - it.x } : it
  })
}
