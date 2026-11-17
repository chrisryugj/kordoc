/**
 * 목차 쪽 번호 — 생성한 문서를 kordoc 조판(reflow)으로 쪽을 나눠, 장 머리·붙임 줄이 그려진 쪽을 목차 쪽 칸에 넣는다.
 *
 * gen-gongmun 이 대상 문단 앞에 `<!--kordoc-toc:N-->`(N = 목차 쪽 칸 차례, body = 본문 첫 쪽)를 달아 둔다.
 * 측정용 사본에서만 그 문단에 id 를 주고(렌더 영역 sourceId 로 찾는다), 표를 담은 문단은 표 id 로 찾는다.
 * 넣는 번호는 문서에 찍히는 번호다 — 본문 첫 쪽에서 쪽 번호를 1로 새로 시작하면 그 쪽이 1.
 * 한글 조판과 줄바꿈이 어긋나면 쪽이 하나씩 다를 수 있다(조판 예측은 실글꼴 폭표 기준).
 */

import { renderHwpxPages } from "../render/svg-render.js"
import { TOC_PAGE_CELL } from "./gen-frame-seoul-front.js"

const MARK = /<!--kordoc-toc:(\w+)-->/g

/** 표시를 지운 최종 section XML — 쪽을 못 재면 쪽 칸은 빈 채로 */
export async function fillTocPages(sectionXml: string, build: (section: string) => Promise<ArrayBuffer>, warnings?: string[]): Promise<string> {
  const final = sectionXml.replace(MARK, "")
  if (!final.includes(`name="${TOC_PAGE_CELL}`)) return final
  // 대상 문단 — 표를 담은 문단(장 띠·장 상자·제목표)은 첫 글보다 앞에 온 표 id
  const targets = new Map<string, { table?: string; para: string }>()
  for (const m of sectionXml.matchAll(/<!--kordoc-toc:(\w+)--><hp:p /g)) {
    const head = sectionXml.slice(m.index!, m.index! + 4000)
    const tbl = /<hp:tbl id="(\d+)"/.exec(head), txt = head.indexOf("<hp:t>")
    targets.set(m[1], { table: tbl && (txt < 0 || tbl.index < txt) ? tbl[1] : undefined, para: `kordoc-toc-${m[1]}` })
  }
  let pages: Map<string, number>
  try {
    const measure = sectionXml.replace(/<!--kordoc-toc:(\w+)--><hp:p /g, '<hp:p id="kordoc-toc-$1" ')
    const { scene } = await renderHwpxPages(await build(measure), { reflow: true }, () => new Set())
    pages = new Map()
    for (const [mark, t] of targets) {
      const r = scene.regions.find((g) => (t.table ? g.type === "table" && g.sourceId === t.table : g.type === "paragraph" && g.sourceId === t.para))
      if (r) pages.set(mark, r.page)
    }
  } catch (e) {
    warnings?.push(`목차 쪽 번호를 재지 못해 비워 둡니다(${e instanceof Error ? e.message : String(e)})`)
    return final
  }
  // 본문 첫 쪽에서 쪽 번호를 새로 시작하면(newNum) 그 쪽 기준
  const bodyAt = sectionXml.indexOf("<!--kordoc-toc:body-->")
  const restart = bodyAt >= 0 && /^<!--kordoc-toc:body--><hp:p [^>]*>(?:(?!<\/hp:run>)[\s\S])*?<hp:newNum /.test(sectionXml.slice(bodyAt, bodyAt + 2000))
  const base = restart && pages.has("body") ? pages.get("body")! - 1 : 0
  let missing = 0
  const out = final.replace(new RegExp(`(<hp:tc name="${TOC_PAGE_CELL}(\\d+)"[\\s\\S]*?<hp:t>)(</hp:t>)`, "g"), (all, pre: string, n: string, end: string) => {
    const p = pages.get(n)
    if (p === undefined) { missing++; return all }
    return `${pre}${p - base}${end}`
  })
  if (missing) warnings?.push(`목차 쪽 번호 ${missing}칸을 재지 못해 비워 둡니다`)
  return out
}
