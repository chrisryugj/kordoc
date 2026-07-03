#!/usr/bin/env node
// 강건성 fuzz 스윕 — 코퍼스 파일의 절단/비트플립 변형에 대해 parse()가
// "throw 없이, 멈춤 없이, 실패 시 반드시 code와 함께" 반환하는지를 게이트.
//
// 변형 (파일 상대경로 기반 시드 — 실행 순서/머신 무관 재현):
//   t50   : 앞 50%만 남기고 절단
//   t90   : 앞 90%만 남기고 절단
//   hflip : 첫 512B 안에서 8비트 플립 (매직/헤더 오염)
//   bflip : 전체 범위에서 8비트 플립 (본문 오염)
//
// 게이트: crash(throw)=0 · hang(>TIMEOUT 미반환)=0 · 실패인데 code 없음=0 · slow=0
//   slow = 반환은 했지만 TIMEOUT 초과 (동기 블로킹은 race로 못 끊음 — 이벤트루프 점유 감지).
//   기준선(2026-07-03): bflip eval-rda-2022.pdf 144.8s 1건 발굴 → findTwoColumnProseCutX
//   오염 좌표 폭주 가드로 2.3s 해소 — slow 게이트 0으로 잠금
// 사용법: node bench/fuzz-sweep.mjs [--gate] [--doc=부분문자열] [--verbose]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { parse, markdownToHwpx } from "../dist/index.js"

const root = new URL(".", import.meta.url).pathname
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null
const TIMEOUT_MS = 30_000

// ─── 결정적 PRNG (xorshift32, 경로 시드) ────────────
function djb2(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0
  return h || 1
}
function makeRng(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13; x >>>= 0
    x ^= x >> 17
    x ^= x << 5; x >>>= 0
    return x / 0xffffffff
  }
}

// ─── 변형 생성 ──────────────────────────────────────
function mutate(buf, variant, rng) {
  switch (variant) {
    case "t50": return buf.subarray(0, Math.max(1, Math.floor(buf.length * 0.5)))
    case "t90": return buf.subarray(0, Math.max(1, Math.floor(buf.length * 0.9)))
    case "hflip": {
      const out = Buffer.from(buf)
      const zone = Math.min(512, out.length)
      for (let i = 0; i < 8; i++) {
        const pos = Math.floor(rng() * zone)
        out[pos] ^= 1 << Math.floor(rng() * 8)
      }
      return out
    }
    case "bflip": {
      const out = Buffer.from(buf)
      for (let i = 0; i < 8; i++) {
        const pos = Math.floor(rng() * out.length)
        out[pos] ^= 1 << Math.floor(rng() * 8)
      }
      return out
    }
  }
}

const VARIANTS = ["t50", "t90", "hflip", "bflip"]

// ─── 메인 ──────────────────────────────────────────
async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else if (/\.(hwpx|hwp|pdf|docx|xlsx|hml)$/i.test(e.name)) yield p
  }
}

const t0 = performance.now()
const corpusDir = join(root, "corpus")
const files = []
for await (const f of walk(corpusDir)) files.push(f)
files.sort()

const rows = []
let crash = 0, hang = 0, noCode = 0, success = 0, failed = 0, slow = 0
for (const file of files) {
  const rel = relative(corpusDir, file)
  if (docFilter && !rel.includes(docFilter)) continue
  const orig = await readFile(file)
  for (const variant of VARIANTS) {
    const rng = makeRng(djb2(`${rel}:${variant}`))
    const mutated = Buffer.from(mutate(orig, variant, rng)) // parse가 detach해도 안전하게 복사본
    const t = performance.now()
    let outcome, code = null, error = null
    try {
      const res = await Promise.race([
        parse(mutated, { filename: rel.split("/").pop() }),
        new Promise(resolve => setTimeout(() => resolve("__timeout__"), TIMEOUT_MS).unref()),
      ])
      if (res === "__timeout__") { outcome = "hang"; hang++ }
      else if (res.success) { outcome = "success"; success++ }
      else {
        outcome = "error"; failed++
        code = res.code ?? null
        if (!code) noCode++
        error = String(res.error ?? "").slice(0, 120)
      }
    } catch (err) {
      outcome = "crash"; crash++
      error = String(err?.stack ?? err).slice(0, 300)
    }
    const ms = Math.round(performance.now() - t)
    if (outcome !== "hang" && ms > TIMEOUT_MS) { slow++; outcome = `slow-${outcome}` }
    rows.push({ file: rel, variant, outcome, code, ms, ...(error ? { error } : {}) })
    if (verbose || outcome === "crash" || outcome === "hang") {
      console.error(`${outcome.padEnd(7)} ${variant.padEnd(5)} ${ms}ms ${rel}${code ? " [" + code + "]" : ""}${outcome === "crash" ? "\n  " + error : ""}`)
    }
  }
}

// ─── markdownToHwpx fuzz (생성기 강건성) ─────────────
// markdownToHwpx는 MCP/CLI로 비신뢰 md를 받는다 — parse()와 같은 crash/hang/slow
// 게이트 + 산출물이 parse로 되읽히는지(genInvalid)까지 잠근다 (PR #39 게이트 공백 봉합).
const MD_ATOMS = [
  "# 제목", "본문 문단입니다", "- 리스트 항목", "1. 순서 항목", "2) 괄호 항목",
  "| a | b |\n| --- | --- |\n| 1 | 2 |",
  "<table><tr><td rowspan=\"2\">셀</td><td>b</td></tr><tr><td>c</td></tr></table>",
  "$$a + b$$", "$$\\frac{x}{y}$$", "$$\\begin{pmatrix} a \\\\ b \\end{pmatrix}$$",
  "$$", "$$ 미종결 수식 텍스트", "\\$\\$ 이스케이프", "$$x$$ 뒤 텍스트",
  "$$" + "{".repeat(2000), "$$" + "\\frac".repeat(500) + "$$",
  "```\ncode block\n```", "> 인용문", "***", "x".repeat(5000),
  "α β ∑ ∫ 한글 \\* \\| 이스케이프", "**굵게** *기울임* `코드`",
]
function makeMdDoc(rng) {
  const n = 3 + Math.floor(rng() * 12)
  const parts = []
  for (let i = 0; i < n; i++) parts.push(MD_ATOMS[Math.floor(rng() * MD_ATOMS.length)])
  return parts.join(rng() < 0.3 ? "\n" : "\n\n")
}
let genInvalid = 0
const GEN_RUNS = 60
for (let k = 0; k < GEN_RUNS; k++) {
  const rng = makeRng(djb2(`mdgen:${k}`))
  const md = makeMdDoc(rng)
  const opts = k % 3 === 0 ? { gongmun: { preset: "기안문" } } : undefined
  const t = performance.now()
  let outcome, error = null
  try {
    const res = await Promise.race([
      (async () => {
        const buf = await markdownToHwpx(md, opts)
        return parse(Buffer.from(buf), { filename: "mdgen.hwpx" })
      })(),
      new Promise(resolve => setTimeout(() => resolve("__timeout__"), TIMEOUT_MS).unref()),
    ])
    if (res === "__timeout__") { outcome = "hang"; hang++ }
    else if (res.success) { outcome = "success"; success++ }
    else { outcome = "gen-invalid"; genInvalid++; error = String(res.error ?? "").slice(0, 120) }
  } catch (err) {
    outcome = "crash"; crash++
    error = String(err?.stack ?? err).slice(0, 300)
  }
  const ms = Math.round(performance.now() - t)
  if (outcome !== "hang" && ms > TIMEOUT_MS) { slow++; outcome = `slow-${outcome}` }
  rows.push({ file: `mdgen#${k}${opts ? ":gongmun" : ""}`, variant: "mdgen", outcome, code: null, ms, ...(error ? { error } : {}) })
  if (verbose || outcome !== "success") console.error(`${outcome.padEnd(7)} mdgen ${ms}ms mdgen#${k}${error ? "\n  " + error : ""}`)
}

const gates = {
  crash: { value: crash, threshold: 0, pass: crash === 0 },
  hang: { value: hang, threshold: 0, pass: hang === 0 },
  noCode: { value: noCode, threshold: 0, pass: noCode === 0 },
  slow: { value: slow, threshold: 0, pass: slow === 0 },
  genInvalid: { value: genInvalid, threshold: 0, pass: genInvalid === 0 },
}
const pass = Object.values(gates).every(g => g.pass)
const codeDist = {}
for (const r of rows) if (r.code) codeDist[r.code] = (codeDist[r.code] ?? 0) + 1

const report = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - t0),
  runs: rows.length, success, failed, pass, gates, codeDist,
  slowest: [...rows].sort((a, b) => b.ms - a.ms).slice(0, 5).map(r => ({ file: r.file, variant: r.variant, ms: r.ms, outcome: r.outcome })),
  incidents: rows.filter(r => r.outcome === "crash" || r.outcome === "hang" || r.outcome === "gen-invalid" || r.outcome.startsWith("slow-") || (r.outcome === "error" && !r.code)),
}
await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "fuzz.json"), JSON.stringify(report, null, 1))

console.log(`\n══ fuzz 스윕 — ${files.length}파일 × ${VARIANTS.length}변형 + mdgen ${GEN_RUNS}런 = ${rows.length}런 (${Math.round(report.elapsedMs / 1000)}s) ══`)
for (const [k, g] of Object.entries(gates)) console.log(`  ${g.pass ? "✅" : "❌"} ${k.padEnd(7)} ${g.value} (기준 ${g.threshold})`)
console.log(`  성공 파싱 ${success} / 정상 실패 ${failed} | 에러코드 분포: ${Object.entries(codeDist).map(([k, v]) => `${k}×${v}`).join(" ")}`)
console.log(`  최장: ${report.slowest.map(s => `${s.ms}ms ${s.variant} ${s.file.split("/").pop()}`).join(" | ")}`)
console.log(`report → bench/out/fuzz.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
