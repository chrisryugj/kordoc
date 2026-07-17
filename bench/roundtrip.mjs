#!/usr/bin/env node
// 생성 라운드트립 충실도 — md→hwpx(generate)→재파싱→md 의 내용/표 보존 측정.
// gen-sweep(엔트리 해시 회귀)과 별개의 "품질" 트랙: 해시가 바뀌는 개선이 있어도
// 내용 충실도가 후퇴하지 않는지를 잰다.
//
// 트랙:
//   corpus  : 실코퍼스 hwpx 75건의 파싱 md를 입력으로 재생성·재파싱 (기본 게이트 대상)
//   fixture : 합성 md + 공문서 모드(gongmun) — 보고 위주 (공문 모드는 서식 변환이 의도라
//             완전 동일을 요구하지 않는다)
//
// 지표 (문서별 → micro 집계):
//   fwdCov  : M0 평문 3-gram이 M1에 남아있는 비율 (내용 손실 검출)
//   bwdCov  : M1 → M0 역방향 (phantom 검출)
//   표      : 원 IR 그리드를 참조 삼아 scoreTables 재사용 — exact/cellExact/contentNED
//
// 사용법: node bench/roundtrip.mjs [--gate] [--doc=부분문자열] [--verbose]
//   --gate 시 게이트 미달이면 exit 1 (기준선 2회 안정 확인 후 score 편입 판단)

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { parse, markdownToHwpx } from "../dist/index.js"
import { mdToPlain, normKey } from "./lib/normalize.mjs"
import { collectIrGrids, scoreTables, irAnchors } from "./lib/table-score.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

// 게이트 = 무후퇴 플로어 (기준선 2026-07-03 수술 후: fwd 0.999632 / bwd 0.99915 /
// tableExact 0.727848 / cellExact 0.991812 — 2회 안정 확인 후 상향).
// 2026-07-03 수술 3종: ①헤딩 왕복 소실 → generator OUTLINE paraPr (corpus 75건 md엔
// 헤딩 0개라 headingErrors 게이트는 fixture 트랙 h1~h6이 지킨다. h5/h6은 paraPr 매핑
// 축약으로 h4 복원 = 의도된 압축) ②리스트 번호 재시작·마커 변형(-→·) → MdBlock.marker
// 원본 보존 ③마스킹 별표 런 md HR/볼드 오독 → 파서 escapeGfm에 * 추가 + 생성기 센티널
// 언이스케이프 (fwd 0.947→0.9996의 주역).
// 잔여(수용): ④셀 내 <img> → "image" 텍스트化 (바이너리 없음) / hr → 대시 런 비대칭 /
// fixture basic의 인라인 강조(**굵게**) 마커 소실 — IR이 블록 단위라 재출력 불가.
// equationErrors: fixture $$…$$가 native 수식으로 갔다가 같은 LaTeX(공백 무시)로
// 돌아오는지 — 코퍼스 md에 $$가 없어 게이트 무감이던 구멍 봉합 (PR #39).
// lineErrors: lineCheck fixture의 실질 줄(정규화 ≥10자)이 왕복에서 통째로 보존되는지 —
// 번호 뒤 불필요 줄바꿈·문장 중간 끊김 클래스 고정 (2026-07-03 법령 md 실측 후 편입).
// 2026-07-11 v4.0.6 상향: 인라인 강조 run-span 왕복(자사 파일 채널)으로 fixture
// basic fwd 0.525→1·law 0.943→1, corpus fwd/bwd micro 1.0 도달 — fwd 0.999→0.9995,
// bwd 0.998→0.9995, tableExact 0.72→0.85(v4.0.5 0.8797 반영) 잠금.
// 2026-07-17 만점 잠금: 빈 행 GFM 보존 + 의도적 평탄화 표 whitelist(isIntentionalUnwrap)로
// corpus 75건 fwd/bwd/tableExact/cellExact 전부 1.0 도달 — 새 플로어가 기준.
const GATES = { fwdCovMicro: 1, bwdCovMicro: 1, tableExact: 1, cellExact: 1, genErrors: 0, headingErrors: 0, equationErrors: 0, lineErrors: 0 }

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

// ─── 3-gram 커버리지 (normKey 평문, 전체 텍스트) ───────
function trigramBag(s) {
  const bag = new Map()
  for (let i = 0; i + 3 <= s.length; i++) {
    const g = s.substr(i, 3)
    bag.set(g, (bag.get(g) ?? 0) + 1)
  }
  return bag
}
function coverage(refBag, outBag) {
  let total = 0, covered = 0
  for (const [g, n] of refBag) { total += n; covered += Math.min(n, outBag.get(g) ?? 0) }
  return { total, covered, coverage: total ? covered / total : 1 }
}

// ─── 라운드트립 1건 ────────────────────────────────
async function roundtrip(m0, genOpts) {
  const hwpx = await markdownToHwpx(m0, genOpts)
  const res1 = await parse(Buffer.from(hwpx), { filename: "roundtrip.hwpx" })
  if (!res1.success) return { ok: false, stage: "reparse", error: res1.error }
  return { ok: true, m1: res1.markdown, blocks1: res1.blocks }
}

// tableToMarkdown이 의도적으로 표가 아닌 형태로 방출하는 표 — 왕복 표 모수에서 제외
// (whitelist): 빈 표(방출 생략)·1×1(구조화 텍스트 언랩)·병합/중첩 없는 1열 표(라인 언랩).
// 조건은 src/table/builder.ts tableToMarkdown 분기 미러 — HTML 경로(병합·중첩, 수식 제외)를
// 타는 표는 표로 방출되므로 모수 유지.
const CELL_MATH_RE = /(^|[^\\])\$(?=\S)(?:[^$\n\\]|\\.)+?\S\$/
function isIntentionalUnwrap(t) {
  if (t.rows === 0 || t.cols === 0) return true
  const flat = t.cells.flat()
  const hasMerge = flat.some(c => c.rowSpan > 1 || c.colSpan > 1)
  const hasNested = flat.some(c => c.blocks?.some(b => b.type === "table" && b.table))
  const hasMath = flat.some(c => CELL_MATH_RE.test(c.text ?? ""))
  if ((hasMerge || hasNested) && !hasMath) return false // HTML 표로 방출 — 왕복 대상
  if (t.rows === 1 && t.cols === 1) return true
  if (t.cols === 1 && t.rows >= 2) return true
  return flat.every(c => !(c.text ?? "").trim()) // 전셀 빈 GFM 표 — 재파싱 시 열 트림으로 소실
}

/** blocks의 IRTable을 post-order(자식 먼저)로 수집 — collectIrGrids와 동일 경계 */
function collectRefTables(blocks, out = []) {
  const visit = (t, depth = 0) => {
    if (depth > 12) return
    for (const row of t.cells) {
      for (const c of row) {
        for (const b of c.blocks ?? []) if (b.type === "table" && b.table) visit(b.table, depth + 1)
      }
    }
    if (!isIntentionalUnwrap(t)) out.push(t)
  }
  for (const b of blocks) {
    if (b.type === "table" && b.table) visit(b.table)
  }
  return out
}

function scoreRound(m0, blocks0, rt) {
  const p0 = normKey(mdToPlain(m0).text)
  const p1 = normKey(mdToPlain(rt.m1).text)
  const b0 = trigramBag(p0), b1 = trigramBag(p1)
  const fwd = coverage(b0, b1)
  const bwd = coverage(b1, b0)
  // 표: 원 파싱 IR 그리드를 참조로 재파싱 그리드를 채점 (기존 채점기 재사용).
  // 의도적 평탄화 표(whitelist)는 ref 모수 제외 — isIntentionalUnwrap 참조.
  const refGrids = collectRefTables(blocks0).map(t => {
    const g = irAnchors(t)
    return { rows: g.rows, cols: g.cols, cells: g.anchors }
  })
  const tbl = scoreTables(refGrids, collectIrGrids(rt.blocks1))
  const h0 = (m0.match(/^#{1,6} /gm) ?? []).length
  const h1 = (rt.m1.match(/^#{1,6} /gm) ?? []).length
  return {
    ok: true,
    refGrams: fwd.total,
    fwdCov: round(fwd.coverage), bwdCov: round(bwd.coverage),
    fwdCovered: fwd.covered, bwdGrams: bwd.total, bwdCovered: bwd.covered,
    tables: {
      ref: tbl.tableCount, out: tbl.irTableCount, exact: tbl.exactCount,
      cellTotal: tbl.cellTotal, cellExact: tbl.cellExact, contentNED: round(tbl.contentNED),
    },
    headings: { ref: h0, out: h1 },
  }
}

// ─── fixture 트랙 (합성 md + 공문서 모드) ───────────
const FIXTURES = [
  { name: "basic", md: "# 제목1\n\n본문 **굵게** *기울임* `코드`\n\n## 제목2\n\n- 리스트1\n- 리스트2\n  - 하위 항목\n\n> 인용문\n" },
  // 헤딩 레벨 무결성 게이트 — 왕복 후 레벨·텍스트 시퀀스가 min(level,4) 매핑과 일치해야 함
  { name: "headings", md: "# 장제목\n\n## 절제목\n\n### 관제목\n\n#### 항제목\n\n##### 목제목\n\n###### 세목제목\n\n본문 문단.\n" },
  { name: "table-gfm", md: "| 구분 | 금액 | 비고 |\n| --- | --- | --- |\n| 세입 | 1,000 | 증가 |\n| 세출 | 900 | 감소 |\n" },
  { name: "table-merge", md: '<table><tr><th rowspan="2">구분</th><th colspan="2">내역</th></tr><tr><td>세입</td><td>세출</td></tr><tr><td>합계</td><td>1,000</td><td>900</td></tr></table>\n' },
  { name: "mixed", md: "# 사업 개요\n\n○ 기간: 2026년 상반기\n\n| 항목 | 값 |\n| --- | --- |\n| 예산 | 1억 |\n\n마무리 문단입니다.\n" },
  { name: "gongmun", md: "수신 내부결재\n\n제목 테스트 기안\n\n1. 관련: 행정안전부 공문\n\n2. 다음과 같이 보고합니다.\n\n가. 첫째 항목\n\n나. 둘째 항목\n\n붙임 1부.  끝.\n", opts: { gongmun: { preset: "기안문" } } },
  // 수식 왕복 무결성 게이트 — display math → native <hp:equation> → 인라인 $…$ 재파싱.
  // 고정점 형태(명시적 중괄호·\leq 등 정규 명령)로 작성 — 별칭 정규화까지 요구하지 않는다.
  { name: "equation", md: "수식 검증 문단.\n\n$$a \\pm b \\cdot c = \\frac{x}{y}$$\n\n중간 문단.\n\n$$\\sqrt{x^{2} + y^{2}} \\leq z$$\n\n$$\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}$$\n\n끝 문단.\n" },
  // 법령 문서 줄 무결성 게이트(lineCheck) — 조문 번호 뒤 분리·문장 중간 끊김 검출
  // (2026-07-03 민원처리법 전문 왕복 실측: 228문단 빈문단 0·쪼개짐 0 — 그 구조 클래스를 고정)
  { name: "law", lineCheck: true, md: "# 민원 처리에 관한 법률\n\n**제2조(정의)** 이 법에서 사용하는 용어의 뜻은 다음과 같다.\n\n1. \"민원\"이란 민원인이 행정기관에 대하여 처분 등 특정한 행위를 요구하는 것을 말하며, 그 종류는 다음 각 목과 같다.\n\n   가. 일반민원\n   1) 법정민원: 법령ㆍ훈령ㆍ예규ㆍ고시ㆍ자치법규 등에서 정한 일정 요건에 따라 인가ㆍ허가ㆍ승인ㆍ특허ㆍ면허 등을 신청하는 민원\n   2) 질의민원: 법령ㆍ제도ㆍ절차 등 행정업무에 관하여 행정기관의 설명이나 해석을 요구하는 민원\n\n2. \"민원인\"이란 행정기관에 민원을 제기하는 개인ㆍ법인 또는 단체를 말한다.\n\n**제4조(민원 처리 담당자의 의무와 보호)** ① 민원을 처리하는 담당자는 담당 민원을 신속ㆍ공정ㆍ친절ㆍ적법하게 처리하여야 한다. <개정 2022. 1. 11.>\n\n② 행정기관의 장은 민원 처리 담당자의 신체적ㆍ정신적 피해의 예방 및 치료 등 대통령령으로 정하는 필요한 조치를 하여야 한다. <신설 2022. 1. 11.>\n\n[제목개정 2022. 1. 11.]\n\n---\n\n> **[개정·예정] 제10조의2 (시행일: 2026. 12. 3.)**\n> ⑥항이 다음과 같이 개정됨: 「도로교통법」 인용이 변경. 그 외 본문은 동일.\n" },
]

// ─── 메인 ──────────────────────────────────────────
const t0 = performance.now()
const corpusDir = join(root, "corpus")
const files = []
for (const dir of ["review", "hwp5"]) {
  for (const e of await readdir(join(corpusDir, dir), { withFileTypes: true })) {
    if (e.isFile() && /\.hwpx$/i.test(e.name)) files.push(join(corpusDir, dir, e.name))
  }
}
files.sort()

const corpusRows = []
let genErrors = 0
for (const file of files) {
  const rel = relative(corpusDir, file)
  if (docFilter && !rel.includes(docFilter)) continue
  const buf = await readFile(file)
  // 확장자 .hwpx + OLE2 매직(실제 HWP5) — 자기 md가 없으니 제외 (score.mjs와 동일 정책)
  if (buf.length >= 4 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) continue
  const res0 = await parse(buf, { filename: basename(file) })
  if (!res0.success) { corpusRows.push({ file: rel, ok: false, stage: "parse0", error: res0.error }); continue }
  try {
    const rt = await roundtrip(res0.markdown, undefined)
    if (!rt.ok) { genErrors++; corpusRows.push({ file: rel, ...rt }); continue }
    const row = { file: rel, ...scoreRound(res0.markdown, res0.blocks, rt) }
    corpusRows.push(row)
    if (verbose) console.error(`corpus fwd=${row.fwdCov} bwd=${row.bwdCov} tbl=${row.tables.exact}/${row.tables.ref} ${rel}`)
  } catch (err) {
    genErrors++
    corpusRows.push({ file: rel, ok: false, stage: "generate", error: String(err?.message ?? err).slice(0, 300) })
  }
}

// 헤딩 시퀀스 — 레벨은 min(4) 매핑 (paraPr h4가 h4~h6 겸용), 텍스트는 원문 그대로
const headingSeq = md => [...md.matchAll(/^(#{1,6}) (.+)$/gm)].map(m => `${Math.min(m[1].length, 4)}|${m[2].trim()}`)
// 수식 시퀀스 — 입력 $$…$$(블록)·재파싱 $…$(인라인) 양쪽을 공백 무시 LaTeX로 정규화
const mathSeq = md => [...md.matchAll(/\$\$([\s\S]+?)\$\$|\$([^$\n]+)\$/g)].map(m => (m[1] ?? m[2]).replace(/\s+/g, ""))
// 줄 키 — 마크다운 장식·공백 제거 후 실질 내용만 (짧은 줄은 마커 정규화 노이즈라 제외)
const lineKeys = md => md.split("\n").map(l => l.trim())
  .filter(l => l && !/^[-—─*_]{3,}$/.test(l))
  .map(l => l.replace(/[\\*_`>#|]/g, "").replace(/\s+/g, ""))
  .filter(k => k.length >= 10)

const fixtureRows = []
let headingErrors = 0
let equationErrors = 0
let lineErrors = 0
for (const f of FIXTURES) {
  try {
    const rt = await roundtrip(f.md, f.opts)
    if (!rt.ok) { fixtureRows.push({ name: f.name, ...rt }); continue }
    // fixture는 원 IR이 없으므로 표 참조를 입력 md의 재파싱 아닌 자체 생성물 기준으로만 —
    // 텍스트 커버리지 + md 왕복 텍스트만 본다 (표 구조는 corpus 트랙 소관)
    const p0 = normKey(mdToPlain(f.md).text)
    const p1 = normKey(mdToPlain(rt.m1).text)
    const fwd = coverage(trigramBag(p0), trigramBag(p1))
    const bwd = coverage(trigramBag(p1), trigramBag(p0))
    // 헤딩 왕복 무결성 — 레벨(min4)+텍스트 시퀀스 완전 일치 (2026-07-03 수술 후 게이트)
    const h0 = headingSeq(f.md), h1 = headingSeq(rt.m1)
    const headingOk = h0.length === h1.length && h0.every((x, i) => x === h1[i])
    if (!headingOk) headingErrors++
    // 수식 왕복 무결성 — LaTeX 내용(공백 무시) 시퀀스 완전 일치 (PR #39 게이트)
    const e0 = mathSeq(f.md), e1 = mathSeq(rt.m1)
    const equationOk = e0.length === e1.length && e0.every((x, i) => x === e1[i])
    if (!equationOk) equationErrors++
    // 줄 무결성(lineCheck fixture) — 원본 실질 줄이 왕복에서 통째로 남아야 한다
    let lines = null
    if (f.lineCheck) {
      const k1 = new Set(lineKeys(rt.m1))
      const missing = lineKeys(f.md).filter(k => !k1.has(k))
      lines = { ref: lineKeys(f.md).length, missing: missing.length, ok: missing.length === 0 }
      if (!lines.ok) lineErrors++
    }
    fixtureRows.push({ name: f.name, ok: true, gongmun: !!f.opts, fwdCov: round(fwd.coverage), bwdCov: round(bwd.coverage), refGrams: fwd.total, headings: { ref: h0.length, out: h1.length, ok: headingOk }, equations: { ref: e0.length, out: e1.length, ok: equationOk }, ...(lines ? { lines } : {}) })
  } catch (err) {
    fixtureRows.push({ name: f.name, ok: false, stage: "generate", error: String(err?.message ?? err).slice(0, 300) })
  }
}

// ─── 집계 ──────────────────────────────────────────
const okRows = corpusRows.filter(r => r.ok)
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0)
const fwdMicro = sum(okRows, r => r.fwdCovered) / Math.max(1, sum(okRows, r => r.refGrams))
const bwdMicro = sum(okRows, r => r.bwdCovered) / Math.max(1, sum(okRows, r => r.bwdGrams))
const tblRef = sum(okRows, r => r.tables.ref), tblExact = sum(okRows, r => r.tables.exact)
const cellTotal = sum(okRows, r => r.tables.cellTotal), cellExact = sum(okRows, r => r.tables.cellExact)
const tableExactRate = tblRef ? tblExact / tblRef : 1
const cellExactRate = cellTotal ? cellExact / cellTotal : 1

const gates = {
  fwdCovMicro: { value: round(fwdMicro), threshold: GATES.fwdCovMicro, pass: fwdMicro >= GATES.fwdCovMicro },
  bwdCovMicro: { value: round(bwdMicro), threshold: GATES.bwdCovMicro, pass: bwdMicro >= GATES.bwdCovMicro },
  tableExact: { value: round(tableExactRate), threshold: GATES.tableExact, pass: tableExactRate >= GATES.tableExact },
  cellExact: { value: round(cellExactRate), threshold: GATES.cellExact, pass: cellExactRate >= GATES.cellExact },
  genErrors: { value: genErrors, threshold: GATES.genErrors, pass: genErrors <= GATES.genErrors },
  headingErrors: { value: headingErrors, threshold: GATES.headingErrors, pass: headingErrors <= GATES.headingErrors },
  equationErrors: { value: equationErrors, threshold: GATES.equationErrors, pass: equationErrors <= GATES.equationErrors },
  lineErrors: { value: lineErrors, threshold: GATES.lineErrors, pass: lineErrors <= GATES.lineErrors },
}
const pass = Object.values(gates).every(g => g.pass)

const report = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - t0),
  corpusDocs: okRows.length,
  pass, gates,
  aggregate: {
    fwdCovMicro: round(fwdMicro), bwdCovMicro: round(bwdMicro),
    tables: { ref: tblRef, exact: tblExact, cellTotal, cellExact, cellExactRate: round(cellExactRate) },
  },
  worstFwd: [...okRows].sort((a, b) => a.fwdCov - b.fwdCov).slice(0, 10).map(r => ({ file: r.file, fwdCov: r.fwdCov, bwdCov: r.bwdCov })),
  fixtures: fixtureRows,
  corpus: corpusRows,
}
await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "roundtrip.json"), JSON.stringify(report, null, 1))

console.log(`\n══ 생성 라운드트립 충실도 — corpus ${okRows.length}건 / fixture ${fixtureRows.length}건 (${Math.round(report.elapsedMs / 1000)}s) ══`)
for (const [k, g] of Object.entries(gates)) {
  console.log(`  ${g.pass ? "✅" : "❌"} ${k.padEnd(12)} ${g.value} (기준 ${g.threshold})`)
}
console.log(`  표: ref=${tblRef} exact=${tblExact} | 셀 ${cellExact}/${cellTotal}`)
console.log("[worst fwd 5]")
for (const w of report.worstFwd.slice(0, 5)) console.log(`  ${w.fwdCov} bwd=${w.bwdCov} ${w.file}`)
console.log("[fixtures]")
for (const f of fixtureRows) console.log(`  ${f.ok ? (f.gongmun ? "공문" : "  ") : "ERR"} fwd=${f.fwdCov ?? "-"} bwd=${f.bwdCov ?? "-"}${f.headings?.ref ? ` 헤딩${f.headings.ok ? "✓" : "✗"} ${f.headings.out}/${f.headings.ref}` : ""}${f.equations?.ref ? ` 수식${f.equations.ok ? "✓" : "✗"} ${f.equations.out}/${f.equations.ref}` : ""}${f.lines ? ` 줄${f.lines.ok ? "✓" : "✗"} ${f.lines.ref - f.lines.missing}/${f.lines.ref}` : ""} ${f.name}${f.error ? " — " + f.error : ""}`)
console.log(`report → bench/out/roundtrip.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
