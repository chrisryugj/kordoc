#!/usr/bin/env node
// HWP5 ↔ PDF 표 셀 텍스트 대조 — 같은 서식의 HWP5 원본과 한컴 PDF 출력(법제처 별지서식 licbyl/)을
// 양쪽 다 kordoc 으로 파싱해 표 셀 텍스트 집합의 Jaccard 유사도를 낸다 (보고 전용 지표, v4.12.2).
//
// HWP5 IR 표(원본 구조)를 준거로 PDF 표 복원(클립 셀 그리드)이 셀을 얼마나 같은 단위로 자르는지
// 본다 — 텍스트 coverage 가 못 보는 셀 경계 붕괴·병합 차이를 잡는다. 중첩표는 collectIrGrids 로
// 재귀 수집(HWP 파서 IR 과 PDF 틀 셀 blocks 모두 같은 경계). HWP5 는 flattenLayoutTables 가
// 레이아웃 표를 문단으로 해체하므로 그 셀은 준거에서 빠진다(양측 대칭 아님 — 수치 해석 시 주의).
//
// 기준선 (2026-09-05 v4.12.1 스크래치 재현): 문서평균 Jaccard 0.90 (클립 셀 그리드 전 0.79)
//
// --linebreaks: PDF 셀 안 줄바꿈("신청합니<br>다.") 결합 가능성 실측 — 줄 경계마다 HWP 원문에서
//   같은 자리가 공백인지(어절 경계) 아닌지(글자 단위 줄나눔) 센다. 결합 규칙을 정하려면 이 비율이 먼저다.
//
// 사용법: node bench/cmp-hwp-pdf.mjs [corpus하위=licbyl] [--doc=부분문자열] [--verbose] [--linebreaks] [--json=경로]

import { readdir, readFile, writeFile } from "node:fs/promises"
import { join, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { collectIrGrids } from "./lib/table-score.mjs"
import { normKey, normText } from "./lib/normalize.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const pos = args.filter(a => !a.startsWith("--"))
const flag = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? "").split("=")[1] || d
const sub = pos[0] ?? "licbyl"
const docFilter = flag("doc", null)
const verbose = args.includes("--verbose")
const doLinebreaks = args.includes("--linebreaks")
const jsonOut = flag("json", null)
const dir = join(root, "corpus", sub)

const cellKeys = (blocks) => {
  const keys = new Set()
  for (const g of collectIrGrids(blocks)) for (const a of g.anchors) { const k = normKey(a.text); if (k) keys.add(k) }
  return keys
}
const jaccard = (a, b) => {
  if (a.size === 0 && b.size === 0) return null
  let inter = 0
  for (const k of a) if (b.has(k)) inter++
  return inter / (a.size + b.size - inter)
}
/** 모든 블록(표 셀 포함)의 문단 텍스트를 이어 붙인 정규화 원문 — 줄바꿈 판정용 */
const fullText = (blocks) => {
  const out = []
  const walk = (bs) => {
    for (const b of bs) {
      if (b.type === "table" && b.table) for (const row of b.table.cells) for (const c of row) { if (c.blocks?.length) walk(c.blocks); else if (c.text) out.push(c.text) }
      else if (b.text) out.push(b.text)
    }
  }
  walk(blocks)
  return normText(out.join("\n"))
}

const files = (await readdir(dir)).sort()
const stems = files.filter(f => f.endsWith(".hwp") && files.includes(f.slice(0, -4) + ".pdf") && (!docFilter || f.includes(docFilter))).map(f => f.slice(0, -4))
const rows = []
const lb = { breaks: 0, space: 0, nospace: 0, notFound: 0, samples: { space: [], nospace: [] } }
const t0 = performance.now()
for (const stem of stems) {
  const [hwp, pdf] = await Promise.all([
    parse(await readFile(join(dir, stem + ".hwp")), { filename: stem + ".hwp" }),
    parse(await readFile(join(dir, stem + ".pdf")), { filename: stem + ".pdf" }),
  ])
  if (!hwp.success || !pdf.success) { rows.push({ stem, error: hwp.success ? pdf.error : hwp.error }); continue }
  const hk = cellKeys(hwp.blocks), pk = cellKeys(pdf.blocks)
  const j = jaccard(hk, pk)
  const hwpTables = collectIrGrids(hwp.blocks).length, pdfTables = collectIrGrids(pdf.blocks).length
  rows.push({ stem, jaccard: j, hwpCells: hk.size, pdfCells: pk.size, hwpTables, pdfTables })
  if (verbose) console.error(`${j === null ? "  -  " : j.toFixed(3)} hwp ${hwpTables}표/${hk.size}셀 pdf ${pdfTables}표/${pk.size}셀  ${stem.slice(0, 70)}`)
  if (doLinebreaks) {
    // PDF 셀 텍스트의 줄 경계(앞줄 끝 ≤6자 + 뒷줄 첫 ≤6자)를 HWP 원문에서 찾아 그 자리의 공백 유무를 센다.
    // 어절 단위 줄나눔이면 원문에 공백이 있고, 글자 단위(한글 기본)면 없다 — 둘 다 나오면 결합 규칙 불가
    const hwpText = fullText(hwp.blocks)
    const hwpNoSpace = hwpText.replace(/ /g, "")
    for (const g of collectIrGrids(pdf.blocks)) for (const a of g.anchors) {
      const lines = a.text.split("\n").map(s => normText(s)).filter(Boolean)
      for (let i = 0; i + 1 < lines.length; i++) {
        const tail = lines[i].slice(-6).replace(/ /g, ""), head = lines[i + 1].slice(0, 6).replace(/ /g, "")
        if (tail.length < 2 || head.length < 2) continue
        lb.breaks++
        const idx = hwpNoSpace.indexOf(tail + head)
        if (idx < 0) { lb.notFound++; continue }
        // 공백 제거 원문의 위치를 원문 위치로 환산 — tail 끝 글자 뒤가 공백인가
        let seen = -1, pos = 0
        for (; pos < hwpText.length && seen < idx + tail.length - 1; pos++) if (hwpText[pos] !== " ") seen++
        const isSpace = hwpText[pos] === " "
        if (isSpace) { lb.space++; if (lb.samples.space.length < 8) lb.samples.space.push(`${lines[i].slice(-12)} ⏎ ${lines[i + 1].slice(0, 12)}`) }
        else { lb.nospace++; if (lb.samples.nospace.length < 8) lb.samples.nospace.push(`${lines[i].slice(-12)} ⏎ ${lines[i + 1].slice(0, 12)}`) }
      }
    }
  }
}
const scored = rows.filter(r => r.jaccard !== null && r.jaccard !== undefined)
const mean = scored.length ? scored.reduce((s, r) => s + r.jaccard, 0) / scored.length : null
const worst = [...scored].sort((a, b) => a.jaccard - b.jaccard).slice(0, 8)
console.log(`══ HWP5↔PDF 셀 대조 ${sub} — 쌍 ${stems.length} (채점 ${scored.length}, 오류 ${rows.filter(r => r.error).length}) ${((performance.now() - t0) / 1000).toFixed(0)}s ══`)
console.log(`  문서평균 Jaccard ${mean === null ? "-" : mean.toFixed(4)} | Jaccard=1 문서 ${scored.filter(r => r.jaccard === 1).length} | <0.5 문서 ${scored.filter(r => r.jaccard < 0.5).length}`)
console.log(`  표 수 hwp ${rows.reduce((s, r) => s + (r.hwpTables ?? 0), 0)} / pdf ${rows.reduce((s, r) => s + (r.pdfTables ?? 0), 0)}`)
for (const w of worst) console.log(`  ${w.jaccard.toFixed(3)} hwp ${w.hwpTables}표/${w.hwpCells}셀 pdf ${w.pdfTables}표/${w.pdfCells}셀  ${w.stem.slice(0, 70)}`)
if (doLinebreaks) {
  console.log(`  줄바꿈 ${lb.breaks}건: 어절 경계(공백) ${lb.space} / 글자 단위(공백 없음) ${lb.nospace} / 원문 미발견 ${lb.notFound}`)
  console.log(`   공백 예: ${lb.samples.space.join(" | ")}`)
  console.log(`   무공백 예: ${lb.samples.nospace.join(" | ")}`)
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ sub, mean, rows, linebreaks: doLinebreaks ? lb : undefined }, null, 2))
