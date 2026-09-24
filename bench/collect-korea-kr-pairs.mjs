#!/usr/bin/env node
// korea.kr 정책브리핑 보도자료 HWPX↔PDF(↔HWP) 동명 짝 수집기 — 연구목적 저속 수집 (1~1.6초 간격)
// 목록(pressReleaseList.do?pageIndex=N)에서 newsId 를 모으고, 보기 페이지의 첨부 목록에서
// 같은 이름의 .hwpx + .pdf (있으면 .hwp 도) 가 모두 있는 문서만 내려받는다. PDF 가 한컴 산출물이라
// hwpx IR 표를 GT 로 PDF 표 구조를 채점할 수 있다(pdf-table-gt) — 그래서 짝이 없는 첨부는 받지 않는다.
//
// 사용법: node bench/collect-korea-kr-pairs.mjs [최대짝수=150] [출력서브디렉토리=korea-kr-pairs]
//          [--pages=시작-끝(기본 20-120)] [--exclude=korea-kr,korea-kr2] [--also=docx,xlsx,xls,hml [--also-dir=폴더]]
// 파일명: {newsId}_{첨부 이름} — 기존 korea-kr 수집기와 같은 규약 (score.mjs 가 newsId 접두로 hwp 쌍을 잇는다).
import { writeFile, mkdir, readdir } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) kordoc-bench/4.14 (research; contact: ryuseungin@gmail.com)"
const args = process.argv.slice(2)
const pos = args.filter(a => !a.startsWith("--"))
const flag = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? "").split("=")[1] || d
const MAX = Number(pos[0] ?? 150)
const outName = pos[1] ?? "korea-kr-pairs"
const [P0, P1] = flag("pages", "20-120").split("-").map(Number)
const corpusRoot = fileURLToPath(new URL("./corpus/", import.meta.url))
const outDir = join(corpusRoot, outName)
const sleep = ms => new Promise(r => setTimeout(r, ms))
const pause = () => sleep(1000 + Math.random() * 600)
const headers = { "User-Agent": UA }

await mkdir(outDir, { recursive: true })
const ALSO = new Set(flag("also", "").split(",").filter(Boolean).map(s => s.toLowerCase()))
const alsoDir = join(corpusRoot, flag("also-dir", `${outName}-formats`))
if (ALSO.size) await mkdir(alsoDir, { recursive: true })
// 이미 받은 newsId (출력 폴더 + 제외 폴더) — 같은 보도자료 중복 방지
const seenNews = new Set()
for (const d of [outName, ...flag("exclude", "korea-kr,korea-kr2").split(",")]) {
  for (const f of await readdir(join(corpusRoot, d)).catch(() => [])) {
    const m = /^(\d+)_/.exec(f)
    if (m) seenNews.add(m[1])
  }
}

const decode = s => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").trim()
const safeName = t => t.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim()

async function attachments(newsId) {
  const res = await fetch(`https://www.korea.kr/briefing/pressReleaseView.do?newsId=${newsId}`, { headers })
  if (!res.ok) return []
  const html = await res.text()
  const out = []
  const re = /<a href="\/common\/download\.do\?fileId=(\d+)&amp;tblKey=GMN">\s*(?:<img[^>]*>)?\s*([^<]+?)\s*<\/a>/g
  for (const m of html.matchAll(re)) out.push({ fileId: m[1], name: decode(m[2]) })
  return out
}

let pairs = 0
outer: for (let page = P0; page <= P1; page++) {
  let list
  try {
    const res = await fetch(`https://www.korea.kr/briefing/pressReleaseList.do?pageIndex=${page}`, { headers })
    list = await res.text()
  } catch (e) { console.log(`! 목록 ${page}: ${e.message}`); continue }
  // 목록 본문의 보도자료 링크만 (사이드 배너의 다른 newsId 는 pressReleaseView 링크가 아님)
  const ids = [...new Set([...list.matchAll(/pressReleaseView\.do\?newsId=(\d+)/g)].map(m => m[1]))]
  await pause()
  for (const newsId of ids) {
    if (pairs >= MAX) break outer
    if (seenNews.has(newsId)) continue
    seenNews.add(newsId)
    let files
    try { files = await attachments(newsId) } catch (e) { console.log(`! ${newsId}: ${e.message}`); continue }
    await pause()
    // 곁가지(--also=docx,xlsx,xls,hml): 짝과 무관하게 이 포맷 첨부도 받는다 — formats 트랙 모수 보강용
    for (const f of files) {
      const m = /\.([a-z0-9]+)$/i.exec(f.name)
      if (!m || !ALSO.has(m[1].toLowerCase())) continue
      const res = await fetch(`https://www.korea.kr/common/download.do?fileId=${f.fileId}&tblKey=GMN`, { headers })
      const buf = Buffer.from(await res.arrayBuffer())
      await pause()
      if (!res.ok || buf.length < 1000) { console.log(`  ! ${newsId} ${f.name} HTTP ${res.status} ${buf.length}B`); continue }
      await writeFile(join(alsoDir, `${newsId}_${safeName(f.name)}`), buf)
      console.log(`  ~ ${newsId}_${f.name.slice(0, 60)}`)
    }
    // 같은 이름(확장자 제외) 묶음 — hwpx 와 pdf 가 둘 다 있어야 짝
    const byStem = new Map()
    for (const f of files) {
      const m = /^(.*)\.(hwpx|hwp|pdf)$/i.exec(f.name)
      if (!m) continue
      const g = byStem.get(m[1]) ?? {}
      g[m[2].toLowerCase()] = f
      byStem.set(m[1], g)
    }
    for (const [stem, g] of byStem) {
      if (!g.hwpx || !g.pdf) continue
      for (const ext of ["hwpx", "pdf", "hwp"]) {
        if (!g[ext]) continue
        const res = await fetch(`https://www.korea.kr/common/download.do?fileId=${g[ext].fileId}&tblKey=GMN`, { headers })
        const buf = Buffer.from(await res.arrayBuffer())
        await pause()
        if (!res.ok || buf.length < 1000) { console.log(`  ! ${newsId} ${ext} HTTP ${res.status} ${buf.length}B`); continue }
        const fname = `${newsId}_${safeName(stem)}.${ext}`
        await writeFile(join(outDir, fname), buf)
      }
      pairs++
      console.log(`+ [${pairs}] p${page} ${newsId}_${stem.slice(0, 60)}${g.hwp ? " (+hwp)" : ""}`)
      if (pairs >= MAX) break
    }
  }
}
console.log(`완료: ${pairs}짝 → corpus/${outName}`)
