#!/usr/bin/env node
// 차트·SmartArt 글 재현율 — DOCX·PPTX·XLSX·HWPX·HWP(같은 이름 HWPX 의 차트 파트가 정답) 차트 파트가 든 코퍼스 문서 전부.
//
// 정답 (파서와 코드 0% 공유, 정규식 직독):
//   차트 파트(…/charts/chartN.xml, HWPX Chart/chartN.xml): c:title 의 a:t·c:v, 값 캐시의 c:v.
//     계열마다 되풀이되는 똑같은 c:cat·c:xVal 블록(같은 범위)은 한 번만. 숫자인 c:v 는 수치 단위(12자리 유효숫자로 맞춰 md 의 숫자 토큰 다중집합과 대조), 나머지는 글 단위(공백 뺀 부분 문자열 대조).
//   SmartArt 데이터 파트(…/diagrams/dataN.xml): type 이 없거나 node·asst 인 dgm:pt 의 a:t 를 이은 글 단위.
// kordoc 은 charts: true 로 읽는다(기본 출력에는 차트가 없다). 보고 전용 (게이트 아님). 사용법: node bench/chart-recall.mjs [--verbose]
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { parse } from "../dist/index.js"

const here = fileURLToPath(new URL("..", import.meta.url))
const corpus = join(here, "bench", "corpus")
const verbose = process.argv.includes("--verbose")
const CHART_RE = /(^|\/)charts?\/chart\d*\.xml$/i, DIAGRAM_RE = /(^|\/)diagrams\/data\d*\.xml$/i
const NUM_RE = /^-?\d+(\.\d+)?(e[-+]?\d+)?$/i
const decode = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
const num = v => String(Number(Number(v).toPrecision(12)))

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, out)
    else if (/\.(docx|pptx|xlsx|hwpx|hwp)$/i.test(e.name)) out.push(p)
  }
  return out
}

/** zip 의 차트·SmartArt 파트 → { text: 글 단위[], nums: 수치 단위[] } */
async function truthOf(buf) {
  let zip
  try { zip = await JSZip.loadAsync(buf) } catch { return null }
  const text = [], nums = []
  for (const name of Object.keys(zip.files)) {
    if (CHART_RE.test(name)) {
      const x = await zip.file(name).async("string")
      for (const t of x.match(/<c:title>[\s\S]*?<\/c:title>/g) ?? []) {
        const s = [...t.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => decode(m[1])).join("").trim()
        if (s) text.push(s)
      }
      // 계열마다 같은 항목·x 값 범위를 되풀이해 든다(같은 수식·같은 캐시). 똑같은 c:cat·c:xVal 블록은 한 번만 센다
      const seen = new Set()
      const body = x.replace(/<c:title>[\s\S]*?<\/c:title>/g, "")
        .replace(/<c:(cat|xVal)>[\s\S]*?<\/c:\1>/g, b => (seen.has(b) ? "" : (seen.add(b), b)))
      for (const m of body.matchAll(/<c:v>([^<]*)<\/c:v>/g)) {
        const v = decode(m[1]).trim()
        if (!v) continue
        if (NUM_RE.test(v)) nums.push(num(v))
        else text.push(v)
      }
    } else if (DIAGRAM_RE.test(name)) {
      const x = await zip.file(name).async("string")
      for (const m of x.matchAll(/<dgm:pt\b([^>]*)>([\s\S]*?)<\/dgm:pt>/g)) {
        const type = m[1].match(/\btype="([^"]+)"/)?.[1] ?? "node"
        if (type !== "node" && type !== "asst") continue
        const s = [...m[2].matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(t => decode(t[1])).join("").trim()
        if (s) text.push(s)
      }
    }
  }
  return text.length || nums.length ? { text, nums } : null
}

const key = s => s.replace(/\*\*|\\/g, "").replace(/\s+/g, "")
function score(truth, md) {
  const mdKey = key(md)
  let tT = 0, tM = 0
  const misses = []
  for (const u of truth.text) {
    const k = key(u)
    tT += k.length
    if (mdKey.includes(k)) tM += k.length
    else if (misses.length < 5) misses.push(u.slice(0, 40))
  }
  const bag = new Map()
  for (const t of md.match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi) ?? []) { const n = num(t); bag.set(n, (bag.get(n) ?? 0) + 1) }
  let nM = 0
  for (const n of truth.nums) { const c = bag.get(n) ?? 0; if (c > 0) { nM++; bag.set(n, c - 1) } else if (misses.length < 5) misses.push(`#${n}`) }
  return { tT, tM, nT: truth.nums.length, nM, misses }
}

const t0 = performance.now()
const rows = [], agg = {}
for (const file of await walk(corpus)) {
  const isHwp = /\.hwp$/i.test(file)
  const truth = await truthOf(await readFile(isHwp ? file + "x" : file).catch(() => null))
  if (!truth) continue
  const kind = file.split(".").pop().toLowerCase()
  const res = await parse(await readFile(file), { ocr: false, charts: true }).catch(e => ({ success: false, error: String(e) }))
  const r = res.success ? score(truth, res.markdown) : { tT: 0, tM: 0, nT: truth.nums.length, nM: 0, misses: [String(res.error).slice(0, 60)] }
  const a = (agg[kind] ??= { docs: 0, tT: 0, tM: 0, nT: 0, nM: 0 })
  a.docs++; a.tT += r.tT; a.tM += r.tM; a.nT += r.nT; a.nM += r.nM
  const row = { file: relative(corpus, file), kind, text: r.tT ? +(r.tM / r.tT).toFixed(4) : 1, num: r.nT ? +(r.nM / r.nT).toFixed(4) : 1, misses: r.misses }
  rows.push(row)
  if (verbose) console.error(`${kind} ${row.text}/${row.num} ${row.file}${r.misses.length ? " — " + r.misses.join(" · ") : ""}`)
}
const rate = (m, t) => (t ? +(m / t).toFixed(4) : 1)
const summary = Object.fromEntries(Object.entries(agg).map(([k, a]) => [k, { docs: a.docs, textRecall: rate(a.tM, a.tT), numRecall: rate(a.nM, a.nT), textChars: a.tT, nums: a.nT }]))
const all = Object.values(agg).reduce((s, a) => ({ tT: s.tT + a.tT, tM: s.tM + a.tM, nT: s.nT + a.nT, nM: s.nM + a.nM }), { tT: 0, tM: 0, nT: 0, nM: 0 })
const report = { generatedAt: new Date().toISOString(), elapsedMs: Math.round(performance.now() - t0), files: rows.length,
  textRecall: rate(all.tM, all.tT), numRecall: rate(all.nM, all.nT), summary, rows }
await mkdir(join(here, "bench", "out"), { recursive: true })
await writeFile(join(here, "bench", "out", "chart-recall.json"), JSON.stringify(report, null, 2))
console.log(`차트 글 재현율 ${report.textRecall} · 수치 ${report.numRecall} (${rows.length}문서)`)
for (const [k, s] of Object.entries(summary)) console.log(`  ${k}: ${s.docs}문서 글 ${s.textRecall} (${s.textChars}자) 수치 ${s.numRecall} (${s.nums}개)`)
