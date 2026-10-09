/**
 * PDF 링크 어노테이션 → 마크다운 링크.
 *
 * /Annots 의 Link(/URI) 어노테이션 rect 를 텍스트 아이템과 상관해 해당 run 을
 * [text](url) 로 감싼다. pdfjs getAnnotations() 가 주는 rect 는 PDF 사용자 좌표
 * (pt, bottom-up)로 텍스트 아이템과 같은 공간. escapeGfm 은 `](스킴…)` 링크
 * 스팬을 보호하므로 마커가 그대로 살아남는다.
 */

import { sanitizeHref } from "../utils.js"
import type { NormItem } from "./text-line.js"

/** pdfjs getAnnotations() 반환 원소 중 이 모듈이 쓰는 필드 */
export interface PdfAnnotation {
  subtype?: string
  url?: string
  rect?: number[]
}

/** rect 와 아이템의 세로 겹침 판정 여유 (pt) */
const LINK_Y_TOL = 2
/** 아이템이 rect 에 속한다고 볼 최소 수평 겹침 비율 */
const LINK_MIN_OVERLAP_RATIO = 0.5

/**
 * Link 어노테이션 rect 안의 텍스트 run 을 [text](url) 로 감싼다.
 * 시각적 줄 단위로 래핑 — 여러 줄에 걸친 링크는 줄마다 같은 url 로 반복.
 * rect 안에 텍스트가 없는 어노테이션(아이콘 링크 등)은 무시.
 */
export function applyLinkAnnotations(items: NormItem[], annots: PdfAnnotation[]): void {
  if (items.length === 0 || annots.length === 0) return
  const wrapped = new Set<NormItem>() // 겹치는 어노테이션의 이중 래핑 방지

  for (const a of annots) {
    if (a.subtype !== "Link" || !a.url || !a.rect || a.rect.length < 4) continue
    const url = sanitizeHref(a.url)
    if (!url) continue
    const x1 = Math.min(a.rect[0], a.rect[2]), x2 = Math.max(a.rect[0], a.rect[2])
    const y1 = Math.min(a.rect[1], a.rect[3]), y2 = Math.max(a.rect[1], a.rect[3])

    const matches: NormItem[] = []
    for (const item of items) {
      if (wrapped.has(item) || item.w <= 0 || !item.text.trim()) continue
      // baseline 이 rect 세로 범위 안 (밑줄형 링크 rect 가 baseline 아래로 살짝
      // 내려가는 경우 대비 여유 2pt)
      if (item.y < y1 - LINK_Y_TOL || item.y > y2 + LINK_Y_TOL) continue
      const overlap = Math.min(x2, item.x + item.w) - Math.max(x1, item.x)
      if (overlap / item.w < LINK_MIN_OVERLAP_RATIO) continue
      matches.push(item)
    }
    if (matches.length === 0) continue

    // 줄 단위 그룹핑 (y ±3, 취소선/밑줄 래핑과 동일 컨벤션) 후 x 순 래핑
    const lines = new Map<number, NormItem[]>()
    for (const m of matches) {
      const key = Math.round(m.y / 3)
      const arr = lines.get(key) || []
      arr.push(m)
      lines.set(key, arr)
    }
    for (const arr of lines.values()) {
      arr.sort((p, q) => p.x - q.x)
      arr[0].text = "[" + arr[0].text
      arr[arr.length - 1].text = arr[arr.length - 1].text + `](${url})`
      for (const m of arr) wrapped.add(m)
    }
  }
}

/** 마크다운 링크 한 개 — 그림 참조(`![…](…)`)는 뺀다 */
const MD_LINK = String.raw`(?<!!)\[([^\]\n]*)\]\(([^)\s]+)\)`

/**
 * 줄마다 감싼 링크를 문서 마크다운에서 다시 한 링크로 — 여러 줄에 걸친 링크 하나가 "[You can read](u) [more about](u)"처럼
 * 같은 url 을 줄 수만큼 되풀이하던 것을 사이 공백째 잇는다. 링크 글에 그어진 밑줄은 링크 표시일 뿐이라 링크 하나를 통째로
 * 감싼 `<u>` 는 뗀다
 */
export function mergeLinkRuns(markdown: string): string {
  // 줄마다 밑줄을 감싸면 두 줄 링크가 <u>[Our</u> <u>Mental Shortcuts](u)</u> 로 엇갈린다 — 링크 글 안의 줄 경계 밑줄 표지도 뗀다
  let out = markdown.replace(new RegExp(String.raw`<u>${MD_LINK}</u>`, "g"),
    (_m, text: string, url: string) => `[${text.replace(/<\/u>(\s*)<u>/g, "$1")}](${url})`)
  const run = new RegExp(MD_LINK + String.raw`(\s+)` + String.raw`(?<!!)\[([^\]\n]*)\]\(\2\)`, "g")
  for (let prev = ""; prev !== out;) {
    prev = out
    out = out.replace(run, (_m, a: string, url: string, _gap: string, b: string) => `[${a} ${b}](${url})`)
  }
  return out
}
