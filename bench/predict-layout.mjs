#!/usr/bin/env node
// 생성 HWPX 의 한글 조판 예측 — 한컴 없이 본문 줄바꿈·벌어진 줄·고아 줄·압축을 본다.
//
// 폭은 라이브러리 실글꼴 폭표(src/hwpx/font-metrics.ts, faceClass `font:이름`) + 공백 0.5em + 금칙 +
// 어절/글자(ASCII 연속열 한 단어) 줄바꿈. 이 모델로 한글 2024(윈도) PDF 본문 154줄의 줄바꿈 위치를 전부
// 재현했다(v4.14.2, engine-spec (k)장). 부호 뒤 탭은 내어쓰기용 자동 탭(autoTabLeft)이면 내어쓰기 위치로.
// 표 안 문단은 건너뛴다.
//
// 사용법: node bench/predict-layout.mjs <file.hwpx> [--lines] [--loose]
//   --lines  줄마다 출력(⇥ 탭, ⍽ 묶음 빈칸)   --loose  공백이 두 배 넘게 늘어나는 줄 목록
// 전제: npm run build (dist/ 최신)
import { readFileSync } from "node:fs"
import JSZip from "jszip"
import { measureTextWidth, simulateWrap } from "../dist/index.js"

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith("--"))
if (!file) { console.error("사용법: node bench/predict-layout.mjs <file.hwpx> [--lines] [--loose]"); process.exit(1) }
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]*)"`))?.[1]
const num = (v, d = 0) => (v === undefined ? d : Number(v))

const zip = await JSZip.loadAsync(readFileSync(file))
const head = await zip.file("Contents/header.xml").async("string")
const sec = await zip.file("Contents/section0.xml").async("string")
const faces = new Map()
for (const m of (head.match(/<hh:fontface lang="HANGUL"[\s\S]*?<\/hh:fontface>/)?.[0] ?? "").matchAll(/<hh:font\b([^>]*)>/g)) faces.set(attr(m[1], "id"), attr(m[1], "face"))
const chars = new Map()
for (const m of head.matchAll(/<hh:charPr\b([^>]*)>([\s\S]*?)<\/hh:charPr>/g)) {
  chars.set(attr(m[1], "id"), {
    h: num(attr(m[1], "height"), 1000),
    ratio: num(m[2].match(/<hh:ratio\b[^>]*hangul="(\d+)"/)?.[1], 100),
    spacing: num(m[2].match(/<hh:spacing\b[^>]*hangul="(-?\d+)"/)?.[1], 0),
    face: faces.get(m[2].match(/<hh:fontRef\b[^>]*hangul="(\d+)"/)?.[1]),
  })
}
const autoTab = new Set([...head.matchAll(/<hh:tabPr id="(\d+)"[^>]*autoTabLeft="1"/g)].map((m) => m[1]))
const paras = new Map()
for (const m of head.matchAll(/<hh:paraPr\b([^>]*)>([\s\S]*?)<\/hh:paraPr>/g)) {
  const mg = m[2].match(/<hh:margin>([\s\S]*?)<\/hh:margin>/)?.[1] ?? ""
  const v = (n) => num(mg.match(new RegExp(`<hc:${n} value="(-?\\d+)"`))?.[1], 0)
  paras.set(attr(m[1], "id"), {
    left: v("left"), right: v("right"), intent: v("intent"), autoTab: autoTab.has(attr(m[1], "tabPrIDRef")),
    word: /breakNonLatinWord="BREAK_WORD"/.test(m[2]), align: m[2].match(/horizontal="(\w+)"/)?.[1],
  })
}
const pagePr = sec.match(/<hp:pagePr\b[^>]*>/)?.[0] ?? ""
const pm = sec.match(/<hp:pagePr[\s\S]*?<hp:margin\b[^>]*\/>/)?.[0] ?? ""
const bodyW = num(attr(pagePr, "width"), 59528) - num(attr(pm, "left")) - num(attr(pm, "right")) - num(attr(pm, "gutter"))

// 표 제거(본문 문단만)
let xml = sec
for (;;) { const m = xml.match(/<hp:tbl\b(?:(?!<hp:tbl\b)[\s\S])*?<\/hp:tbl>/); if (!m) break; xml = xml.slice(0, m.index) + xml.slice(m.index + m[0].length) }

const stat = { paras: 0, lines: 0, loose1: 0, loose15: 0, loose2: 0, orphan20: 0, orphan25: 0, squeezed: new Map() }
const loose = []
for (const p of xml.matchAll(/<hp:p\b([^>]*)>((?:(?!<hp:p\b)[\s\S])*?)<\/hp:p>/g)) {
  const pp = paras.get(attr(p[1], "paraPrIDRef")); if (!pp) continue
  const hang = pp.intent < 0 ? -pp.intent : 0
  let text = ""; const widths = []; let x = 0; let squeeze = null; let spaceW = 0
  for (const rm of p[2].matchAll(/<hp:run\b([^>]*)>([\s\S]*?)<\/hp:run>/g)) {
    const cp = chars.get(attr(rm[1], "charPrIDRef")); if (!cp) continue
    const opt = { spacingPct: cp.spacing, faceClass: cp.face ? `font:${cp.face}` : "hcr" }
    const body = rm[2].replace(/<hp:ctrl>[\s\S]*?<\/hp:ctrl>/g, "").replace(/<hp:secPr[\s\S]*?<\/hp:secPr>/g, "")
    for (const tm of body.matchAll(/<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>/g)) {
      for (const tok of tm[1].split(/(<[^>]+>)/)) {
        if (!tok) continue
        if (tok.startsWith("<hp:tab")) {
          const adv = pp.autoTab && hang > x + 0.5 ? hang - x : (Math.floor(x / 4000) + 1) * 4000 - x
          text += "\t"; widths.push(adv); x += adv; continue
        }
        const s = tok.startsWith("<hp:nbSpace") ? "\u00a0" : tok.startsWith("<") ? "" : tok.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        for (const ch of s) {
          const w = measureTextWidth(ch, cp.h, cp.ratio, opt)
          text += ch; widths.push(w); if (ch.length === 2) widths.push(0); x += w
          if (ch === " ") spaceW = w
        }
        if (s && (cp.ratio !== 100 || cp.spacing !== 0)) squeeze = `${cp.ratio}/${cp.spacing}`
      }
    }
  }
  if (!text.trim()) continue
  stat.paras++
  if (squeeze) stat.squeezed.set(squeeze, (stat.squeezed.get(squeeze) ?? 0) + 1)
  const avail = bodyW - pp.left - pp.right
  const firstW = avail - Math.max(pp.intent, 0), contW = avail - hang
  const w = simulateWrap(text, firstW, contW, 1000, 100, pp.word ? "keep" : "charAll", { widths })
  const lines = w.starts.map((s, k) => [s, w.starts[k + 1] ?? text.length])
  for (let k = 0; k < lines.length; k++) {
    const [a, b] = lines[k]
    let end = b; while (end > a && text[end - 1] === " ") end--
    const seg = text.slice(a, end)
    if (args.includes("--lines")) console.log(seg.replace(/\t/g, "⇥").replace(/\u00a0/g, "⍽"))
    if (k === lines.length - 1) {
      if (lines.length > 1) { const r = widths.slice(a, end).reduce((s, v) => s + v, 0) / contW; if (r <= 0.2) stat.orphan20++; if (r <= 0.25) stat.orphan25++ }
      continue
    }
    if (pp.align !== "JUSTIFY") continue
    // 탭 뒤 글만 양쪽 정렬 — 공백 수는 마지막 탭 뒤로
    const lastTab = seg.lastIndexOf("\t")
    const spaces = (seg.slice(lastTab + 1).match(/ /g) ?? []).length
    const natural = widths.slice(a, end).reduce((s, v) => s + v, 0)
    const looseness = ((k === 0 ? firstW : contW) - natural) / (Math.max(spaces, 1) * (spaceW || 750))
    stat.lines++
    if (looseness > 1) { stat.loose1++; loose.push([looseness, seg]) }
    if (looseness > 1.5) stat.loose15++
    if (looseness > 2) stat.loose2++
  }
}
const sq = [...stat.squeezed.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ")
console.log(`문단 ${stat.paras} · 양쪽 정렬 줄 ${stat.lines}: 공백 2배 초과 ${stat.loose1}·2.5배 ${stat.loose15}·3배 ${stat.loose2} · 고아 줄(마지막 줄 ≤20%) ${stat.orphan20}·≤25% ${stat.orphan25}`)
console.log(`압축 문단(장평/자간): ${sq || "없음"}`)
if (args.includes("--loose")) for (const [l, s] of loose.sort((a, b) => b[0] - a[0])) console.log(`  ${l.toFixed(2)}  ${s.replace(/\t/g, "⇥").replace(/\u00a0/g, "⍽")}`)
