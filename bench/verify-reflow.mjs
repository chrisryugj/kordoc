/**
 * reflow 자기일관성 게이트 — 한컴 저장본(캐시 有)을 truth로 삼아 reflow 정확도 측정.
 *
 * 절차: 원본 render(truth) → linesegarray strip → render({reflow:true}) → 두 SVG의
 * <text> (내용·x·y) 대조. 폰트 근사로 exact는 아니므로 허용오차(줄 y ±px + 줄수 일치) 기준.
 *
 * 사용: node bench/verify-reflow.mjs [glob수 제한]
 */
import { renderHwpxToSvg } from "../dist/index.js"
import JSZip from "jszip"
import fs from "node:fs"
import path from "node:path"

const CORPUS = "bench/corpus/seoul"
const LIMIT = Number(process.argv[2] || 6)

function extractTexts(svg) {
  // <text ... x="X" y="Y" ...>content</text>
  const out = []
  const re = /<text\b[^>]*\bx="([\d.-]+)"[^>]*\by="([\d.-]+)"[^>]*>([^<]*)<\/text>/g
  let m
  while ((m = re.exec(svg))) out.push({ x: +m[1], y: +m[2], t: m[3] })
  return out
}

async function stripCache(buf) {
  const zip = await JSZip.loadAsync(buf)
  const secName = Object.keys(zip.files).find(n => /section0\.xml$/.test(n))
  let sec = await zip.file(secName).async("string")
  const before = (sec.match(/<hp:linesegarray/g) || []).length
  sec = sec.replace(/<hp:linesegarray[\s\S]*?<\/hp:linesegarray>/g, "")
  zip.file(secName, sec)
  const out = await zip.generateAsync({ type: "nodebuffer" })
  return { out, stripped: before }
}

function compare(truth, reflow) {
  const ySet = s => [...new Set(s.map(o => Math.round(o.y)))]
  // 내용별 그룹 → 그룹 내 y 정렬 → 순서 매칭 (표 셀 반복 텍스트·순서 밀림에 강건)
  const byContent = arr => {
    const m = new Map()
    for (const o of arr) {
      const k = o.t.trim()
      if (!k) continue
      if (!m.has(k)) m.set(k, [])
      m.get(k).push(o)
    }
    for (const v of m.values()) v.sort((a, b) => a.y - b.y)
    return m
  }
  const T = byContent(truth), R = byContent(reflow)
  let matched = 0, total = 0, dySum = 0, dyMax = 0, dxSum = 0
  for (const [k, tv] of T) {
    const rv = R.get(k) || []
    for (let i = 0; i < tv.length; i++) {
      total++
      if (i < rv.length) {
        matched++
        const dy = Math.abs(tv[i].y - rv[i].y), dx = Math.abs(tv[i].x - rv[i].x)
        dySum += dy; dxSum += dx; dyMax = Math.max(dyMax, dy)
      }
    }
  }
  return {
    truthTexts: truth.length, reflowTexts: reflow.length,
    truthLines: ySet(truth).length, reflowLines: ySet(reflow).length,
    matchPct: total ? Math.round((matched / total) * 100) : 0,
    dyAvg: matched ? +(dySum / matched).toFixed(1) : 0, dyMax: +dyMax.toFixed(1),
    dxAvg: matched ? +(dxSum / matched).toFixed(1) : 0,
  }
}

const files = fs.readdirSync(CORPUS).filter(f => f.endsWith(".hwpx")).slice(0, LIMIT)
console.log(`reflow 자기일관성 — ${CORPUS} ${files.length}건\n`)
let pass = 0
for (const f of files) {
  const buf = fs.readFileSync(path.join(CORPUS, f))
  try {
    const truth = await renderHwpxToSvg(buf)
    const { out, stripped } = await stripCache(buf)
    const reflow = await renderHwpxToSvg(out, { reflow: true })
    const c = compare(extractTexts(truth.svg), extractTexts(reflow.svg))
    // 게이트: 내용 매칭 ≥90%·평균 dy ≤ 200HWPUNIT(2pt)·평균 dx ≤ 150(1.5pt)
    const ok = c.matchPct >= 90 && c.dyAvg <= 200 && c.dxAvg <= 150
    if (ok) pass++
    console.log(`${ok ? "✅" : "⚠️ "} ${f.slice(0, 40)}`)
    console.log(`   strip ${stripped} · texts ${c.truthTexts}→${c.reflowTexts} · lines ${c.truthLines}→${c.reflowLines} · match ${c.matchPct}% · dyAvg ${c.dyAvg} dyMax ${c.dyMax} dxAvg ${c.dxAvg} (pt/100)`)
  } catch (e) {
    console.log(`❌ ${f.slice(0, 40)} — ${e.message}`)
  }
}
console.log(`\n게이트: ${pass}/${files.length} 통과`)
