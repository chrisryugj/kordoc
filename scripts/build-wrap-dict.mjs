#!/usr/bin/env node
// PDF 줄 꺾임 붙여 쓰기 사전(src/pdf/wrap-dict-data.ts) 만들기. 법령 본문에서 한 어절로 붙여 쓴 한글 낱말을 모은다.
//
// 재료: 법제처 국가법령정보 공동활용 현행 법률 전체(1,720개)와 대통령령·총리령·부령 전체(3,518개) 본문(이름은 scripts/wrap-dict-laws.txt,
// 2026-11-24 받음). 법령은 저작권법 제7조 보호받지 않는 저작물이다. 벤치 코퍼스(bench/corpus)의 문서는 재료로 쓰지 않는다.
// 사전이 채점 정답을 외우지 않게 하려는 것이다.
//
// 뽑는 기준(결과를 보기 전에 정함): 세~열 음절 한글 어절, 3회 이상, 어느 쪼갬 자리든 띄어 쓴 이웃 어절 꼴("행정 처분")보다 4배 넘게
// 많음(줄 안 괄호 습관 parenJoins 와 같은 문턱). 끝 조사를 뗀 줄기가 따로 있으면 조사 붙은 꼴은 뺀다(찾을 때 조사를 떼고도 본다).
//
// 사용: node scripts/build-wrap-dict.mjs <법령 본문 파일(.md·.txt)…>  (법률 하나당 파일 하나, 조문 내용·항 글을 줄마다)
import { readFileSync, writeFileSync } from "node:fs"

const files = process.argv.slice(2)
if (!files.length) { console.error("사용: node scripts/build-wrap-dict.mjs <법령 본문 파일…>"); process.exit(1) }
const words = new Map(), bigrams = new Map()
const bump = (m, k) => m.set(k, (m.get(k) ?? 0) + 1)
for (const f of files) {
  for (const line of readFileSync(f, "utf8").split("\n")) {
    if (/^(#|\*\*|---)/.test(line)) continue
    const toks = line.split(/\s+/).map(t => t.match(/^[가-힣]+/)?.[0] ?? "")
    for (let i = 0; i < toks.length; i++) {
      if (toks[i]) bump(words, toks[i])
      if (toks[i] && toks[i + 1]) bump(bigrams, toks[i] + " " + toks[i + 1])
    }
  }
}
// line-wrap.ts DICT_PARTICLE 과 같은 목록
const PARTICLE = /(?:에서는|에서도|에서의|으로서|으로써|으로는|으로도|에게는|에게|에서|에는|에도|으로|까지|부터|이다|이며|이고|이나|과의|와의|의|을|를|이|가|은|는|에|로|과|와|도|만)$/
const joined = new Set()
for (const [w, n] of words) {
  if (n < 3 || w.length < 3 || w.length > 10) continue
  let spaced = 0
  for (let i = 1; i < w.length; i++) spaced = Math.max(spaced, bigrams.get(w.slice(0, i) + " " + w.slice(i)) ?? 0)
  if (n >= 4 * spaced) joined.add(w)
}
const keep = [...joined].filter(w => { const st = w.replace(PARTICLE, ""); return !(st !== w && st.length >= 3 && joined.has(st)) }).sort()
// 앞머리 압축: 정렬한 낱말마다 앞 낱말과 같은 앞머리 길이(0~9 한 자리) + 나머지. 낱말은 한글뿐이라 숫자가 경계다
let prev = ""
const packed = keep.map(w => { let k = 0; while (k < 9 && k < prev.length && prev[k] === w[k]) k++; prev = w; return k + w.slice(k) }).join("")
const out = "// 자동 생성: scripts/build-wrap-dict.mjs (법령 본문에서 붙여 쓴 한글 낱말, 앞머리 압축). 손으로 고치지 않는다\n" +
  `export const WRAP_DICT_PACKED = ${JSON.stringify(packed)}\n`
writeFileSync(new URL("../src/pdf/wrap-dict-data.ts", import.meta.url), out)
console.log(`파일 ${files.length} · 어절 ${words.size} · 사전 ${keep.length}낱말 · ${Buffer.byteLength(out)}바이트`)
