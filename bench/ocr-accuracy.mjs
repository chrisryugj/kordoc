/** OCR 정확도 실측 — 텍스트층 PDF를 자기 정답지로 쓰는 CER/표 구조 벤치.
 *
 *  방법: 코퍼스 PDF에서 품질 신호가 깨끗한(needsOcr=false, 충분한 글자 수) 페이지를
 *  골라, ① 텍스트층 파싱(정답) ② 같은 페이지를 216dpi 래스터 → 내장 OCR 강제
 *  (`ocr:"force"`) — 두 결과의 문자 오류율(CER)과 표 구조(scoreTables)를 대조한다.
 *
 *  표본 검사: 래스터가 텍스트층을 실제로 그리지 못한 페이지(비내장 글꼴 대체 실패 —
 *  글자 중심 대비 검사 < 0.8)는 OCR 표본이 아니므로 사유와 함께 뺀다 (skippedPages).
 *
 *  정규화 두 벌 (ocr-lib.mjs 헤더): cer*(v2 fair — 마크업·혼동 글리프·리더 비대칭 제거)가
 *  주 지표, cer*Strict(v1 — 종전 정의)는 연속성용으로 같이 낸다. 둘 다 양쪽 동일 적용.
 *  CER 은 읽기 순서에 민감하다 — 정답 자체가 같은 파이프라인의 텍스트층 출력이라, 순서
 *  무관 인식률은 charRecall/charPrecision(문자 multiset)으로 따로 본다.
 *
 *  한계(정직하게): 정답이 "클린 렌더"라 실제 스캔의 노이즈·스큐·저해상도는 반영하지
 *  않는다 — 이 수치는 OCR 파이프라인의 상한(clean-render ceiling)이다. 열화 입력은
 *  bench/ocr-robust.mjs. 텍스트층 자체의 결함(숨은 글자·빠진 괄호)도 오차로 섞인다.
 *
 *  실행: node bench/ocr-accuracy.mjs [--limit=N] [--pages=K] [--doc=이름] [--gate] [--dump=디렉토리]
 *  산출: bench/out/ocr-accuracy.json (--dump 시 문서별 GT/OCR IR 블록 JSON — 오류 분석용)
 *  --gate: 무후퇴 플로어(GATES) 미달 시 exit 1. 코퍼스·OCR 모델이 없으면 SKIP(exit 0).
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { collectIrGrids, scoreTables } from "./lib/table-score.mjs"
import { blockTexts, normStrict, fairText, hangulOnly, charBagPR, editDistance, rasterGlyphCoverage } from "./ocr-lib.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const limit = Number((args.find(a => a.startsWith("--limit=")) ?? "").split("=")[1] ?? Infinity)
const pagesPerDoc = Number((args.find(a => a.startsWith("--pages=")) ?? "").split("=")[1] ?? 2)
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null
const gateMode = args.includes("--gate")
const dumpDir = (args.find(a => a.startsWith("--dump=")) ?? "").split("=")[1] || null

const MIN_PAGE_CHARS = 200      // 정답지로 쓸 최소 글자 수 (표지·간지 배제)
const MAX_CMP_CHARS = 20000     // CER 대조 상한 (O(n·m) DP 가드)
const MIN_GLYPH_COVERAGE = 0.8  // 래스터 글자 검사 하한 (코퍼스 82쪽 실측: 정상 ≥ 0.971, 글꼴 미렌더 nanet-seoul-minutes 0.088/0.071)

// 무후퇴 플로어 — 2026-09-24 실측(읽기 품질 2차: OCR 쪽 + 정답지인 텍스트층 파싱의 자간 숫자·괘선 조각 표 수정) 래칫.
// 같은 기기 반복 실행은 출력 해시까지 동일, 여유는 기기 간 onnxruntime 스레드·부동소수 차이 흡수용(CER +0.2pp, 문자 P/R −0.2pp,
// 표 매칭 한 표 차). 지표를 올리면 여기도 올린다
//   실측: cerMicro 0.09627 · charRecall 0.9834 · charPrecision 0.9775 · hangulRecall 0.99597 ·
//         표 41/51 매칭(0.8039) · exact 21 · cellF1 0.6179 · 40문서/80쪽 (OCR 쪽만 고친 중간값: 0.14729 · 표 41/58 · cellF1 0.5362,
//         종전 1차 라운드: 0.19225 · 표 37/59 · cellF1 0.3898). 표 모수 58 → 51 은 정답지 예산서 표가 괘선 표로 제대로 모인 결과
// v4.15.0: PDF 14건 보강 → 54문서/104쪽. 보강 후 기준선과 모든 문서별 품질 수치 동일(기존 모수 무후퇴).
// 실측 CER .09995·R .98117·P .97495·한글 R .99322·표 56/72(.7778)·cellF1 .5456.
const GATES = {
  cerMicroMax: 0.100, charRecallMin: 0.981, charPrecisionMin: 0.974, hangulRecallMin: 0.993,
  tableMatchedMin: 0.77, tableCellF1Min: 0.545, minDocs: 54, minPages: 104,
}

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

const pdfDir = join(root, "corpus", "pdf")
const modelDir = join(process.env.KORDOC_MODEL_CACHE?.trim() || join(homedir(), ".cache", "kordoc", "models"), "ppocr")
if (!existsSync(pdfDir) || !["det.onnx", "rec_korean.onnx", "rec_korean.yml"].every(f => existsSync(join(modelDir, f)))) {
  console.warn(`⚠️  [ocr-accuracy] 코퍼스(${pdfDir}) 또는 OCR 모델(${modelDir}) 없음 — SKIP (모델: kordoc check-ocr-models)`)
  process.exit(0)
}
let files = readdirSync(pdfDir).filter(f => f.endsWith(".pdf")).sort()
if (docFilter) files = files.filter(f => f.includes(docFilter))
if (Number.isFinite(limit)) files = files.slice(0, limit)

const rows = []
const skippedPages = []
let envFailures = 0
const A = { dist: 0, len: 0, distS: 0, lenS: 0, hit: 0, hyp: 0, hHit: 0, hLen: 0, pages: 0, ms: 0 }
const tblAgg = { refTables: 0, matched: 0, exact: 0, f1s: [], skippedRef: 0 }

for (const f of files) {
  // pdfjs가 넘긴 ArrayBuffer를 detach하므로 파스마다 새 사본
  const raw = readFileSync(join(pdfDir, f))
  const buf = () => toAB(Buffer.from(raw))
  const probe = await parse(buf())
  if (!probe.success || !probe.pageQuality?.length) { rows.push({ doc: f, skip: "parse/quality 없음" }); continue }

  const cand = probe.pageQuality
    .filter(q => !q.needsOcr && q.textChars >= MIN_PAGE_CHARS)
    .slice(0, pagesPerDoc).map(q => q.page)
  if (!cand.length) { rows.push({ doc: f, skip: "클린 텍스트층 페이지 없음" }); continue }
  const cov = await rasterGlyphCoverage(raw, cand)
  const clean = cand.filter(p => {
    const c = cov.get(p) ?? 1
    if (c >= MIN_GLYPH_COVERAGE) return true
    skippedPages.push({ doc: f, page: p, glyphCoverage: +c.toFixed(3), reason: "래스터에 텍스트층 글자가 그려지지 않음(글꼴 미렌더)" })
    return false
  })
  if (!clean.length) { rows.push({ doc: f, skip: "래스터 글자 검사 미달 (skippedPages)" }); continue }

  const pages = clean.join(",")
  // 머리글/바닥글 제거는 텍스트층 y-클러스터 기반이라 OCR 경로와 비대칭 — 양쪽 다 끔
  const gt = await parse(buf(), { pages, removeHeaderFooter: false })
  const t0 = performance.now()
  const ocr = await parse(buf(), { pages, removeHeaderFooter: false, ocr: "force" })
  const ocrMs = performance.now() - t0
  if (!gt.success || !ocr.success) { rows.push({ doc: f, skip: `재파싱 실패: ${gt.error ?? ocr.error ?? "?"}` }); continue }
  if (!ocr.warnings?.some(w => w.code === "OCR_APPLIED")) {
    envFailures++
    rows.push({ doc: f, skip: `OCR 미적용: ${ocr.warnings?.find(w => w.code === "OCR_FAILED")?.message ?? "?"}` })
    continue
  }

  if (dumpDir) {
    mkdirSync(dumpDir, { recursive: true })
    writeFileSync(join(dumpDir, f + ".json"), JSON.stringify({ pages: clean, ms: ocrMs, gt: gt.blocks, ocr: ocr.blocks, warnings: ocr.warnings }))
  }
  const gSegs = blockTexts(gt.blocks), oSegs = blockTexts(ocr.blocks)
  const a = fairText(gSegs).slice(0, MAX_CMP_CHARS)
  const b = fairText(oSegs).slice(0, MAX_CMP_CHARS)
  const as = normStrict(blockTexts(gt.blocks, { v1: true }).join(" ")).slice(0, MAX_CMP_CHARS)
  const bs = normStrict(blockTexts(ocr.blocks, { v1: true }).join(" ")).slice(0, MAX_CMP_CHARS)
  const dist = editDistance(a, b)
  const distS = editDistance(as, bs)
  const cer = a.length ? dist / a.length : 0
  const cerStrict = as.length ? distS / as.length : 0
  const bag = charBagPR(a, b)
  // 한글 음절만의 recall — 래스터에 글꼴이 안 그려진 페이지를 드러내는 보조 신호
  const ha = hangulOnly(a), hg = charBagPR(ha, hangulOnly(b))

  // 구조 채점 불가 ref 제외 — 비어있지 않은 셀 <3 이면 표 "구조"가 없다: 장식 벡터
  // 그리드(클립아트 창문 격자 — goe p3 5x6에 2셀)·단일 텍스트박스(1x1 제목/목차 박스).
  // 텍스트 자체는 recall/CER 트랙이 이미 채점하므로 이중 감점도 아니다. 문서명이 아닌
  // 구조 기준이며 제외 수는 skippedRefTables로 노출 (무음 컷 금지).
  const allRef = collectIrGrids(gt.blocks).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors }))
  const refGrids = allRef.filter(g => g.cells.filter(x => x.text.trim()).length >= 3)
  const skippedRef = allRef.length - refGrids.length
  const hyp = collectIrGrids(ocr.blocks)
  let tbl = null
  if (refGrids.length) {
    const s = scoreTables(refGrids, hyp)
    const matched = refGrids.length - s.unmatchedRef
    tbl = { ref: refGrids.length, matched, exact: s.exactCount, cellF1: s.cellF1, skippedRef }
    tblAgg.refTables += refGrids.length
    tblAgg.matched += matched
    tblAgg.exact += s.exactCount
    tblAgg.skippedRef += skippedRef
    if (s.cellF1 != null) tblAgg.f1s.push(s.cellF1)
  } else if (skippedRef > 0) {
    tblAgg.skippedRef += skippedRef
  }

  A.dist += dist; A.len += a.length; A.distS += distS; A.lenS += as.length
  A.hit += bag.hit; A.hyp += b.length; A.hHit += hg.hit; A.hLen += ha.length
  A.pages += clean.length; A.ms += ocrMs
  rows.push({
    doc: f, pages: clean, gtChars: a.length, dist, cer: +cer.toFixed(4), cerStrict: +cerStrict.toFixed(4),
    charRecall: +bag.recall.toFixed(4), charPrecision: +bag.precision.toFixed(4), hangulRecall: +hg.recall.toFixed(4),
    secPerPage: +(ocrMs / 1000 / clean.length).toFixed(2), tbl,
  })
  console.log(`${f} p[${pages}] CER ${(cer * 100).toFixed(2)}% (strict ${(cerStrict * 100).toFixed(2)}%) recall ${(bag.recall * 100).toFixed(1)}% prec ${(bag.precision * 100).toFixed(1)}% 한글recall ${(hg.recall * 100).toFixed(1)}% ${(ocrMs / 1000 / clean.length).toFixed(1)}s/p${tbl ? ` 표 ${tbl.matched}/${tbl.ref} cellF1 ${tbl.cellF1?.toFixed(3)}` : ""}`)
}

const scored = rows.filter(r => !r.skip)
const median = (xs) => xs.length ? +[...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)].toFixed(5) : null
const recall = A.len ? A.hit / A.len : null
const precision = A.hyp ? A.hit / A.hyp : null
const summary = {
  generatedAt: new Date().toISOString(),
  docs: scored.length, skipped: rows.length - scored.length,
  pages: A.pages,
  skippedPages,
  cerMicro: A.len ? +(A.dist / A.len).toFixed(5) : null,
  cerMedian: median(scored.map(r => r.cer)),
  charRecallMicro: recall != null ? +recall.toFixed(5) : null,
  charPrecisionMicro: precision != null ? +precision.toFixed(5) : null,
  charF1: recall != null && precision != null ? +(2 * recall * precision / Math.max(1e-9, recall + precision)).toFixed(5) : null,
  hangulRecallMicro: A.hLen ? +(A.hHit / A.hLen).toFixed(5) : null,
  cerMicroStrict: A.lenS ? +(A.distS / A.lenS).toFixed(5) : null,
  cerMedianStrict: median(scored.map(r => r.cerStrict)),
  secPerPage: A.pages ? +(A.ms / 1000 / A.pages).toFixed(2) : null,
  tables: tblAgg.refTables ? {
    refTables: tblAgg.refTables, matched: tblAgg.matched, exact: tblAgg.exact,
    matchedRate: +(tblAgg.matched / tblAgg.refTables).toFixed(4),
    exactRate: +(tblAgg.exact / tblAgg.refTables).toFixed(4),
    cellF1Mean: tblAgg.f1s.length ? +(tblAgg.f1s.reduce((x, y) => x + y, 0) / tblAgg.f1s.length).toFixed(4) : null,
    // 구조 채점 불가로 모수에서 뺀 ref (비어있지 않은 셀 <3 — 장식 그리드·단일 텍스트박스)
    skippedRefTables: tblAgg.skippedRef,
  } : null,
  note: "정답=같은 PDF의 클린 텍스트층, 입력=216dpi 렌더 강제 OCR — 실스캔 노이즈/스큐 미반영(상한치). cer=v2 fair 정규화, cerStrict=v1",
}

// 플로어는 전체 모수 집계값 기준 — --doc·--limit·--pages 부분 실행은 보고만 (환경 실패만 판정)
const full = !docFilter && !Number.isFinite(limit) && pagesPerDoc === 2
const gates = {
  cerMicro: { value: summary.cerMicro, threshold: `≤ ${GATES.cerMicroMax}`, pass: !full || (summary.cerMicro != null && summary.cerMicro <= GATES.cerMicroMax) },
  charRecall: { value: summary.charRecallMicro, threshold: `≥ ${GATES.charRecallMin}`, pass: !full || (summary.charRecallMicro ?? 0) >= GATES.charRecallMin },
  charPrecision: { value: summary.charPrecisionMicro, threshold: `≥ ${GATES.charPrecisionMin}`, pass: !full || (summary.charPrecisionMicro ?? 0) >= GATES.charPrecisionMin },
  hangulRecall: { value: summary.hangulRecallMicro, threshold: `≥ ${GATES.hangulRecallMin}`, pass: !full || (summary.hangulRecallMicro ?? 0) >= GATES.hangulRecallMin },
  tableMatched: { value: summary.tables?.matchedRate ?? null, threshold: `≥ ${GATES.tableMatchedMin}`, pass: !full || (summary.tables?.matchedRate ?? 0) >= GATES.tableMatchedMin },
  tableCellF1: { value: summary.tables?.cellF1Mean ?? null, threshold: `≥ ${GATES.tableCellF1Min}`, pass: !full || (summary.tables?.cellF1Mean ?? 0) >= GATES.tableCellF1Min },
  population: { value: `${summary.docs}/${summary.pages}`, threshold: `≥ ${GATES.minDocs}/${GATES.minPages}`, pass: !full || (summary.docs >= GATES.minDocs && summary.pages >= GATES.minPages) },
  environment: { value: envFailures, threshold: "0 (OCR 미적용 문서)", pass: envFailures === 0 },
}
const pass = Object.values(gates).every(g => g.pass)

mkdirSync(join(root, "out"), { recursive: true })
writeFileSync(join(root, "out", "ocr-accuracy.json"), JSON.stringify({ summary, pass, gates, rows }, null, 2))
console.log("\n== OCR accuracy (clean-render ceiling) ==")
console.log(JSON.stringify(summary, null, 2))
for (const [k, g] of Object.entries(gates)) console.log(`${g.pass ? "✅" : "❌"} ${k}: ${g.value} (${g.threshold})`)
console.log(`report → bench/out/ocr-accuracy.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
