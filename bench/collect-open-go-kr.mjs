#!/usr/bin/env node
// 정보공개포털(open.go.kr) 원문정보 첨부 수집기 — 연구목적 저속 수집(건당 3~5초). 교육청 등 기관구분 필터.
// 목록·다운로드가 세션 쿠키+브라우저 컨텍스트를 요구해(밖에서는 code 491) 헤드리스 크롬 안에서 페이지 함수를 호출한다.
// 사용법: node bench/collect-open-go-kr.mjs [최대파일수] [출력서브디렉토리] [검색어] [기관구분 C|W|B|E|P] [초중고포함 Y|N] [시작일 YYYYMMDD] [종료일] [첨부명필터] [첨부명제외]
// 예: node bench/collect-open-go-kr.mjs 60 corpus-gen/edu-2609 계획 E N 20250101 20260906 "계획" "일지|출장|근무|명단"
// 결재문서본문은 PDF만 제공되므로 hwpx 첨부만 받는다(hwp 는 이 맥에 변환기가 없어 제외). 저장은 bench/ 아래 상대경로.
import { mkdir, readdir, rename, stat } from "node:fs/promises"
import { join, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
const puppeteer = createRequire(import.meta.url)("puppeteer-core")

const [MAX = "30", OUT = "corpus-gen/edu-2609", KWD = "계획", SE = "E", EDU = "N", START = "20250101", END = "20260906", INC = "", EXC = ""] = process.argv.slice(2)
const BASE = "https://www.open.go.kr"
const outDir = fileURLToPath(new URL(`./${OUT}/`, import.meta.url))
const dlDir = join(outDir, ".dl")
await mkdir(dlDir, { recursive: true })
const existing = new Set(await readdir(outDir))
const incRe = INC ? new RegExp(INC) : null, excRe = EXC ? new RegExp(EXC) : null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jitter = () => 3000 + Math.random() * 2000

const browser = await puppeteer.launch({ headless: "new", executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" })
const page = await browser.newPage()
await page.setUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128 Safari/537.36")
page.on("dialog", async (d) => { console.log("  ! dialog:", d.message().slice(0, 80)); await d.dismiss().catch(() => {}) })
const cdp = await page.createCDPSession()
await cdp.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: dlDir })
await page.goto(`${BASE}/othicInfo/infoList/infoList.do`, { waitUntil: "networkidle2", timeout: 60000 })

async function listPage(viewPage) {
  const q = `kwd=${encodeURIComponent(KWD)}&preKwds=${encodeURIComponent(KWD)}&reSrchFlag=off&othbcSeCd=open&insttSeCd=${SE}&eduYn=${EDU}&startDate=${START}&endDate=${END}&insttCdNm=&insttCd=&searchMainYn=N&viewPage=${viewPage}&rowPage=50&sort=d`
  const res = await page.evaluate(async (q) => {
    const r = await fetch("/othicInfo/infoList/infoList.ajax", { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" }, body: q })
    return await r.json()
  }, q)
  const r = res.result ?? res
  if (r.code !== "200") throw new Error(`목록 code ${r.code}`)
  return { total: r.rtnTotal, items: r.rtnList ?? [] }
}

/** 다운로드 폴더에 새 파일이 완성될 때까지 대기 */
async function waitDownload(before, timeoutMs = 90000) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const now = (await readdir(dlDir)).filter((f) => !before.has(f) && !f.endsWith(".crdownload"))
    if (now.length) { await sleep(500); return now[0] }
    await sleep(500)
  }
  return null
}

let saved = 0, seenDocs = 0
outer: for (let vp = 1; vp <= 40 && saved < +MAX; vp++) {
  const { total, items } = await listPage(vp)
  if (vp === 1) console.log(`검색 결과 ${total}건 (${KWD} / ${SE} / eduYn=${EDU} / ${START}~${END})`)
  if (!items.length) break
  for (const it of items) {
    if (saved >= +MAX) break outer
    if (it.ORGNAL_YN !== "Y" || !/\.hwpx(\||$)/i.test(it.FILE_NM || "")) continue
    const atts = (it.FILE_NM || "").split("|").map((s) => s.replace(/^\[(본문|첨부)\]\s*/, "").trim()).filter((n) => /\.hwpx$/i.test(n) && (!incRe || incRe.test(n)) && !(excRe && excRe.test(n)))
    if (!atts.length) continue
    const no = it.PRDCTN_INSTT_REGIST_NO
    if ([...existing].some((f) => f.startsWith(no + "_"))) continue
    seenDocs++
    try {
      await page.goto(`${BASE}/othicInfo/infoList/infoListDetl2.do?prdnNstRgstNo=${no}&prdnDt=${it.PRDCTN_DT}&nstSeCd=${it.INSTT_SE_CD}&prevUrl=%2FothicInfo%2FinfoList%2FinfoList.do&offSet=0`, { waitUntil: "networkidle2", timeout: 60000 })
      await page.waitForSelector("a.btn_type05.down", { timeout: 30000 })
      const links = await page.evaluate(() => [...document.querySelectorAll("a.btn_type05.down")].map((a) => a.getAttribute("onclick") || "").map((s) => { const m = s.match(/wonmunStep1\('([^']+)',\s*'([^']+)'/); return m ? { id: m[1], name: m[2] } : null }).filter(Boolean))
      for (const l of links) {
        if (saved >= +MAX) break outer
        if (!atts.includes(l.name)) continue
        const before = new Set(await readdir(dlDir))
        await page.evaluate((id, name) => wonmunStep1(id, name, "N"), l.id, l.name)
        const got = await waitDownload(before)
        if (!got) { console.log(`  ! ${no} 다운로드 시간초과: ${l.name.slice(0, 40)}`); continue }
        const fname = `${no}_${l.name.replaceAll("/", "_")}`
        await rename(join(dlDir, got), join(outDir, fname))
        const sz = (await stat(join(outDir, fname))).size
        saved++; existing.add(fname)
        console.log(`  + [${saved}] ${fname.slice(0, 70)} (${(sz / 1024).toFixed(0)}KB) — ${it.PROC_INSTT_NM}`)
        await sleep(jitter())
      }
    } catch (e) { console.log(`  ! ${no}: ${e.message.slice(0, 100)}`) }
    await sleep(jitter())
  }
}
await browser.close()
console.log(`완료: ${saved}건 저장(후보 문서 ${seenDocs}) → ${outDir}`)
