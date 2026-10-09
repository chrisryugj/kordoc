#!/usr/bin/env node
// 전 벤치 묶음 러너 + 문서별 비교기 — 품질 사이클마다 "문서별 하락 0" 을 확인한다 (측정용, 게이트 아님).
//
// 사용법:
//   node bench/suite.mjs run <태그> [--root=<kordoc 체크아웃>] [--only=text,table,…] [--jobs=3]
//   node bench/suite.mjs cmp <기준 태그> <새 태그> [--only=…] [--top=15]
//   node bench/suite.mjs odl-predict <kordoc 루트> <출력 폴더> '<parse 옵션 JSON>'   (run 이 부르는 내부 단계)
//
// run 은 <root>/bench 의 벤치 스크립트를 그 루트의 dist/ 로 돌리고 결과 JSON 을 이 저장소의 bench/out/suite/<태그>/ 에 모은다.
// 기준선은 git worktree 로 옛 커밋을 따로 빌드해 --root 로 넘긴다 — 채점기도 그 체크아웃의 것이 돌므로, 채점기를 바꿨으면
// 기준선 체크아웃에 같은 채점기를 넣고 다시 잰다. ODL 은 KORDOC_ODL_BENCH(기본 ~/workspace/odl-bench-breakthrough-20260925)의
// PDF·정답·원본 채점기(.venv)로 잰다. 쪽당 시간은 병렬로 돈 값이라 참고만 — 속도 비교는 perf.mjs·perf-quality.mjs 단독 실행으로.
// cmp 는 벤치별 요약 A → B 와 문서별 DOWN/UP(지표 하나라도 내려가면 DOWN, 빠진 문서·실패도 DOWN)을 내고 DOWN 이 있으면 exit 1.

import { spawn, execFileSync } from "node:child_process"
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const here = fileURLToPath(new URL("..", import.meta.url))
const suiteDir = join(here, "bench", "out", "suite")
const ODL = process.env.KORDOC_ODL_BENCH ?? join(homedir(), "workspace", "odl-bench-breakthrough-20260925")
const [cmd, ...rest] = process.argv.slice(2)
const flag = (k, d) => { const a = rest.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const pos = rest.filter(x => !x.startsWith("--"))

// 순서 = 시작 순서(오래 걸리는 것 먼저)
const BENCHES = {
  score: { args: ["bench/score.mjs"], out: "score.json" },
  odl: { odl: {} },
  robust: { args: ["bench/ocr-robust.mjs"], out: "ocr-robust.json" },
  text: { args: ["bench/pdf-text-gt.mjs"], out: "pdf-text.json" },
  table: { args: ["bench/pdf-table-gt.mjs", "--no-ocr"], out: "pdf-table.json" },
  odlbest: { odl: { plain: true, htmlTables: true } },
  odlocr: { odl: { ocr: true } },
  ocr: { args: ["bench/ocr-accuracy.mjs"], out: "ocr-accuracy.json" },
  annex: { args: ["bench/annex-gt.mjs"], out: "annex.json" },
  formats: { args: ["bench/formats-sweep.mjs"], out: "formats.json" },
  roundtrip: { args: ["bench/roundtrip.mjs"], out: "roundtrip.json" },
  odlfast: { odl: { ocr: false } },
  gen: { args: ["bench/gen-repro.mjs"], out: "gen-repro.json" },
}

function runChild(args, cwd, log, exe = process.execPath) {
  return new Promise(res => {
    const fd = openSync(log, "a")
    const p = spawn(exe, args, { cwd, stdio: ["ignore", fd, fd] })
    p.on("close", code => { closeSync(fd); res(code ?? 1) })
  })
}

async function runBench(key, root, dir) {
  const b = BENCHES[key], log = join(dir, `${key}.log`), t0 = Date.now()
  writeFileSync(log, "")
  if (b.odl) {
    const pred = join(dir, key, "prediction")
    let code = await runChild([fileURLToPath(import.meta.url), "odl-predict", root, join(pred, "kordoc"), JSON.stringify(b.odl)], here, log)
    if (code === 0) code = await runChild(["src/evaluator.py", "--prediction-root", pred, "--engine", "kordoc", "--log-level", "WARNING"], ODL, log, join(ODL, ".venv", "bin", "python"))
    const ev = join(pred, "kordoc", "evaluation.json")
    if (code !== 0 || !existsSync(ev)) return { code: code || 1, sec: (Date.now() - t0) / 1000, error: "채점 결과 없음" }
    const j = JSON.parse(readFileSync(ev, "utf8"))
    j.timing = JSON.parse(readFileSync(join(pred, "kordoc", "timing.json"), "utf8"))
    writeFileSync(join(dir, `${key}.json`), JSON.stringify(j))
    return { code, sec: (Date.now() - t0) / 1000 }
  }
  const code = await runChild(b.args, root, log)
  const out = join(root, "bench", "out", b.out)
  // 벤치가 죽으면 옛 산출물이 남아 있다 — 이번 실행이 쓴 파일만 모은다
  if (!existsSync(out) || statSync(out).mtimeMs < t0) return { code: code || 1, sec: (Date.now() - t0) / 1000, error: "산출물 없음" }
  copyFileSync(out, join(dir, `${key}.json`))
  return { code, sec: (Date.now() - t0) / 1000 }
}

async function run() {
  const tag = pos[0]
  if (!tag) throw new Error("태그가 필요하다")
  const root = resolve(flag("root", here))
  const keys = (flag("only", null)?.split(",") ?? Object.keys(BENCHES)).filter(k => BENCHES[k])
  const jobs = Number(flag("jobs", 3))
  const dir = join(suiteDir, tag)
  mkdirSync(dir, { recursive: true })
  // 새 worktree 엔 bench/out 이 없다(gitignore) — 스스로 만들지 않는 벤치(gen-repro)가 있다
  mkdirSync(join(root, "bench", "out"), { recursive: true })
  const git = a => { try { return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim() } catch { return null } }
  const metaPath = join(dir, "meta.json")
  const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath, "utf8")) : { tag, benches: {} }
  Object.assign(meta, {
    root, head: git(["rev-parse", "HEAD"]), dirty: !!git(["status", "--porcelain", "--untracked-files=no"]),
    version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, distMtime: statSync(join(root, "dist", "index.js")).mtime,
  })
  const queue = [...keys]
  const worker = async () => {
    for (let k; (k = queue.shift());) {
      console.log(`▶ ${k}`)
      const r = await runBench(k, root, dir)
      meta.benches[k] = { ...r, at: new Date().toISOString() }
      writeFileSync(metaPath, JSON.stringify(meta, null, 1))
      console.log(`${r.code === 0 ? "✓" : "✗"} ${k} ${r.sec.toFixed(0)}s${r.error ? ` (${r.error})` : ""}`)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, keys.length) }, worker))
  console.log(`→ ${dir}`)
}

async function odlPredict() {
  const [root, out, optsJson] = pos
  const { parse } = await import(pathToFileURL(join(resolve(root), "dist", "index.js")).href)
  const opts = JSON.parse(optsJson || "{}")
  mkdirSync(join(out, "markdown"), { recursive: true })
  const files = readdirSync(join(ODL, "pdfs")).filter(f => f.endsWith(".pdf")).sort()
  const timing = { opts, docs: {} }
  let fail = 0
  for (const f of files) {
    const id = basename(f, ".pdf"), t0 = performance.now()
    let md = "", pages = 0
    try {
      const r = await parse(readFileSync(join(ODL, "pdfs", f)), opts)
      md = r.markdown ?? ""
      pages = r.metadata?.pageCount ?? 0
    } catch (e) { fail++; console.error("FAIL", f, String(e).slice(0, 160)) }
    writeFileSync(join(out, "markdown", id + ".md"), md)
    timing.docs[id] = { ms: Math.round(performance.now() - t0), pages }
  }
  const docs = Object.values(timing.docs)
  const ms = docs.reduce((s, d) => s + d.ms, 0), pages = docs.reduce((s, d) => s + d.pages, 0)
  Object.assign(timing, { fail, totalSec: ms / 1000, secPerPage: pages ? ms / 1000 / pages : null })
  writeFileSync(join(out, "timing.json"), JSON.stringify(timing))
  console.log(`odl ${JSON.stringify(opts)} docs=${files.length} fail=${fail} ${(ms / 1000).toFixed(1)}s`)
  if (fail) process.exit(1)
}

// ── 비교 ── 문서 지표는 클수록 좋음, 이름이 cer·phantom 으로 시작하는 것만 작을수록 좋음
const LOWER = /^(cer|phantom|pdfPhantom|secPerPage)/
const nums = o => o ? Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "number")) : null
const pick = (o, ks) => o ? nums(Object.fromEntries(ks.map(k => [k, o[k]]))) : null
const byKey = (rows, key, val) => new Map((rows ?? []).map(r => [key(r), val(r)]))
const odl = j => ({
  sum: { ...pick(j.metrics?.score, ["overall_mean", "nid_mean", "teds_mean", "mhs_mean"]), secPerPage: j.timing?.secPerPage },
  docs: byKey(j.documents, d => d.document_id, d => pick(d.scores, ["overall", "nid", "teds", "mhs"])),
})
const EXTRACT = {
  score: j => ({
    sum: {
      hwpxDocs: j.hwpx.docs, hwpxRecall: j.hwpx.matched / j.hwpx.refChars, hwpxTableExact: j.hwpx.exactCount / j.hwpx.tableCount,
      hwpxCellExact: j.hwpx.gates.cellExact?.value, hwpxContentNED: j.hwpx.gates.contentNED?.value,
      hwp5Pairs: j.hwp5.agg.pairs, hwp5Similarity: j.hwp5.agg.avgHwpxToHwp, hwp5TableExact: j.hwp5.agg.tables.exact / j.hwp5.agg.tables.ref,
      pdfCoverage: j.pdf.gates.coverage?.value,
    },
    docs: new Map([
      ...j.hwpx.docsDetail.map(d => [`hwpx:${d.file}`, d.ok === false ? null : nums({ recall: d.recall, phantom: d.phantomRate, order: d.order?.lis, tExact: d.tables?.exact, cellF1: d.tables?.cellF1, cellExact: d.tables?.cellExactRate, contentNED: d.tables?.contentNED })]),
      ...j.hwp5.pairs.map(d => [`hwp5:${d.file}`, d.ok === false ? null : nums({ sim: d.hwpxToHwp, simRev: d.hwpToHwpx, tExact: d.tables?.exact, cellExact: d.tables?.cellExact, content: d.tables?.contentNum })]),
      ...j.pdf.docsDetail.map(d => [`pdfcov:${d.file}`, d.ok === false ? null : nums({ coverage: d.coverage })]),
    ]),
  }),
  text: j => ({ sum: pick(j.summary, ["pairs", "recall", "precision", "order", "spaceF1"]), docs: byKey(j.rows, r => r.pair, r => r.ok === false ? null : pick(r, ["recall", "precision", "order", "spaceF1"])) }),
  table: j => ({
    sum: { ...pick(j.summary, ["pairs", "refTables", "matchedRate", "exactRate", "cellF1", "contentNED"]), nestedExact: j.summary.nested?.exactRate },
    docs: byKey(j.rows, r => r.pair, r => r.ok === false ? null : pick(r, ["matched", "exact", "cellF1", "contentNED"])),
  }),
  annex: j => ({
    sum: { pdfRecall: j.summary.pdf.recall, pdfPhantom: j.summary.pdf.phantom, pdfTableExact: j.summary.pdf.tableExact, pdfCellF1: j.summary.pdf.cellF1, pdfEqHit: j.summary.pdf.eqHit, hwpTableExact: j.summary.hwp.tableExact },
    docs: byKey(j.rows, r => `${r.set}/${r.stem}.${r.ext}`, r => nums({ recall: r.refChars ? r.matchedChars / r.refChars : 1, phantom: r.mdChars ? r.phantomChars / r.mdChars : 0, order: r.order, tExact: r.tableExact, cellF1: r.cellF1, eqHit: r.eqHit })),
  }),
  ocr: j => ({
    sum: pick(j.summary, ["docs", "pages", "cerMicro", "cerMedian", "charRecallMicro", "charPrecisionMicro", "hangulRecallMicro"]),
    docs: byKey(j.rows, r => `${r.doc}#${(r.pages ?? []).join(",")}`, r => pick(r, ["cer", "charRecall", "charPrecision", "hangulRecall"])),
  }),
  robust: j => ({
    sum: Object.fromEntries(Object.entries(j.summary).map(([v, s]) => [`cer:${v}`, s.cerMicro])),
    docs: byKey(j.rows, r => `${r.doc}#${r.page}`, r => nums(Object.fromEntries(Object.keys(j.summary).map(v => [`cer:${v}`, r[v]])))),
  }),
  formats: j => ({
    sum: { files: j.rows.length, recallMean: (r => r.reduce((s, x) => s + x, 0) / r.length)(j.rows.map(r => r.recall).filter(x => typeof x === "number")) },
    docs: byKey(j.rows, r => r.file, r => r.ok === false ? null : pick(r, ["recall"])),
  }),
  roundtrip: j => ({
    sum: { fwdCov: j.aggregate.fwdCovMicro, bwdCov: j.aggregate.bwdCovMicro, tableExact: j.aggregate.tables.exact / j.aggregate.tables.ref, cellExact: j.aggregate.tables.cellExactRate },
    docs: byKey(j.corpus, r => r.file, r => r.ok === false ? null : nums({ fwdCov: r.fwdCov, bwdCov: r.bwdCov, tExact: r.tables?.exact ?? 0 })),
  }),
  odl, odlbest: odl, odlocr: odl, odlfast: odl,
  gen: j => ({
    sum: {
      cases: j.rows.length, props: j.rows.reduce((s, r) => s + r.props, 0) / j.rows.length,
      matchRate: j.rows.reduce((s, r) => s + r.matched, 0) / j.rows.reduce((s, r) => s + r.gtParas, 0),
      precision: j.rows.reduce((s, r) => s + r.matched, 0) / j.rows.reduce((s, r) => s + r.genParas, 0),
    },
    docs: byKey(j.rows, r => r.name, r => nums({ props: r.props, matchRate: r.gtParas ? r.matched / r.gtParas : 1, precision: r.genParas ? r.matched / r.genParas : 1 })),
  }),
}

const fmt = x => typeof x !== "number" ? String(x) : Number.isInteger(x) ? String(x) : Math.abs(x) >= 100 ? x.toFixed(1) : x.toFixed(5)

function cmp() {
  const [a, b] = pos
  const top = Number(flag("top", 15))
  const keys = flag("only", null)?.split(",") ?? Object.keys(BENCHES)
  let downs = 0
  for (const k of keys) {
    const fa = join(suiteDir, a, `${k}.json`), fb = join(suiteDir, b, `${k}.json`)
    if (!existsSync(fa) || !existsSync(fb)) { if (existsSync(fa) !== existsSync(fb)) console.log(`\n## ${k}: 한쪽 결과 없음`); continue }
    const A = EXTRACT[k](JSON.parse(readFileSync(fa, "utf8"))), B = EXTRACT[k](JSON.parse(readFileSync(fb, "utf8")))
    console.log(`\n## ${k}`)
    for (const m of new Set([...Object.keys(A.sum ?? {}), ...Object.keys(B.sum ?? {})])) {
      const x = A.sum?.[m], y = B.sum?.[m]
      const d = typeof x === "number" && typeof y === "number" ? y - x : null
      const worse = d !== null && (LOWER.test(m) ? d > 1e-9 : d < -1e-9)
      console.log(`  ${m.padEnd(18)} ${fmt(x).padStart(10)} → ${fmt(y).padStart(10)}${d ? ` (${d > 0 ? "+" : ""}${fmt(d)})` : ""}${worse && m !== "secPerPage" ? " ▼" : ""}`)
    }
    const down = [], up = []
    let same = 0
    for (const [doc, ma] of A.docs) {
      const mb = B.docs.get(doc)
      if (ma && !mb) { down.push({ doc, worst: -Infinity, what: B.docs.has(doc) ? "실패" : "빠짐" }); continue }
      if (!ma) { if (mb) up.push({ doc, best: Infinity, what: "실패 → 성공" }); else same++; continue }
      let worst = 0, best = 0, wm = "", bm = ""
      for (const m of Object.keys(ma)) {
        if (typeof mb[m] !== "number") continue
        const d = (mb[m] - ma[m]) * (LOWER.test(m) ? -1 : 1)
        if (d < worst - 1e-9) { worst = d; wm = `${m} ${fmt(ma[m])}→${fmt(mb[m])}` }
        if (d > best + 1e-9) { best = d; bm = `${m} ${fmt(ma[m])}→${fmt(mb[m])}` }
      }
      if (worst < -1e-9) down.push({ doc, worst, what: wm + (best > 1e-9 ? ` · ${bm}` : "") })
      else if (best > 1e-9) up.push({ doc, best, what: bm })
      else same++
    }
    const added = [...B.docs.keys()].filter(d => !A.docs.has(d)).length
    console.log(`  문서 ${A.docs.size}${added ? ` (+새 ${added})` : ""} · DOWN ${down.length} · UP ${up.length} · 같음 ${same}`)
    down.sort((x, y) => x.worst - y.worst).slice(0, top).forEach(x => console.log(`    ▼ ${x.doc.slice(0, 90)}  ${x.what}`))
    up.sort((x, y) => y.best - x.best).slice(0, top).forEach(x => console.log(`    ▲ ${x.doc.slice(0, 90)}  ${x.what}`))
    downs += down.length
  }
  console.log(`\n${downs ? `❌ 문서별 하락 ${downs}건` : "✅ 문서별 하락 0"}`)
  if (downs) process.exit(1)
}

if (cmd === "run") await run()
else if (cmd === "cmp") cmp()
else if (cmd === "odl-predict") await odlPredict()
else { console.error("사용법: node bench/suite.mjs run <태그> [--root=] [--only=] [--jobs=] | cmp <A> <B> [--only=] [--top=]"); process.exit(1) }
