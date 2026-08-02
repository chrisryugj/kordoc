/** OCR 정확도 실측 — 텍스트층 PDF를 자기 정답지로 쓰는 CER/표 구조 벤치.
 *
 *  방법: 코퍼스 PDF에서 품질 신호가 깨끗한(needsOcr=false, 충분한 글자 수) 페이지를
 *  골라, ① 텍스트층 파싱(정답) ② 같은 페이지를 216dpi 래스터 → 내장 OCR 강제
 *  (`ocr:"force"`) — 두 결과의 문자 오류율(CER)과 표 구조(scoreTables)를 대조한다.
 *
 *  한계(정직하게): 정답이 "클린 렌더"라 실제 스캔의 노이즈·스큐·저해상도는 반영하지
 *  않는다 — 이 수치는 OCR 파이프라인의 상한(clean-render ceiling)이다. 텍스트층
 *  자체의 자잘한 결함(합자·공백 정책)도 CER에 오차로 섞인다.
 *
 *  실행: node bench/ocr-accuracy.mjs [--limit=N] [--pages=K] [--doc=이름]
 *  산출: bench/out/ocr-accuracy.json
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { collectIrGrids, scoreTables } from "./lib/table-score.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const limit = Number((args.find(a => a.startsWith("--limit=")) ?? "").split("=")[1] ?? Infinity)
const pagesPerDoc = Number((args.find(a => a.startsWith("--pages=")) ?? "").split("=")[1] ?? 2)
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

const MIN_PAGE_CHARS = 200      // 정답지로 쓸 최소 글자 수 (표지·간지 배제)
const MAX_CMP_CHARS = 20000     // CER 대조 상한 (O(n·m) DP 가드)

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)

/** IR 블록 → 평문 (markdown 문법 노이즈 없이 본문+표 셀 텍스트만) */
function textOf(blocks) {
  const out = []
  for (const b of blocks ?? []) {
    if (b.type === "table" && b.table) {
      const { rows, cols, cells } = b.table
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const cell = cells[r]?.[c]
        if (cell?.text) out.push(cell.text)
      }
    } else if (b.text) out.push(b.text)
  }
  return out.join(" ")
}

// 목차 리더(·····/....)는 텍스트층에만 있는 장식 — OCR이 안 뱉는 게 정상이라 대조에서 제거
const norm = (s) => s.normalize("NFC").replace(/[·.․‥…]{3,}/g, "").replace(/\s+/g, "")
const hangulOnly = (s) => s.replace(/[^가-힣]/g, "")

/** 문자 multiset 대조 — 읽기 순서와 무관한 인식률 (recall=정답 글자 중 살아남은 비율) */
function charBagPR(gt, hyp) {
  const bag = new Map()
  for (const ch of gt) bag.set(ch, (bag.get(ch) ?? 0) + 1)
  let hit = 0
  for (const ch of hyp) {
    const n = bag.get(ch) ?? 0
    if (n > 0) { bag.set(ch, n - 1); hit++ }
  }
  return { recall: gt.length ? hit / gt.length : 1, precision: hyp.length ? hit / hyp.length : 1 }
}

/** 문자 편집거리 (two-row DP) */
function editDistance(a, b) {
  if (a === b) return 0
  const n = a.length, m = b.length
  if (!n || !m) return Math.max(n, m)
  let prev = new Uint32Array(m + 1), cur = new Uint32Array(m + 1)
  for (let j = 0; j <= m; j++) prev[j] = j
  for (let i = 1; i <= n; i++) {
    cur[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= m; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, cur] = [cur, prev]
  }
  return prev[m]
}

const pdfDir = join(root, "corpus", "pdf")
let files = readdirSync(pdfDir).filter(f => f.endsWith(".pdf")).sort()
if (docFilter) files = files.filter(f => f.includes(docFilter))
if (Number.isFinite(limit)) files = files.slice(0, limit)

const rows = []
let sumDist = 0, sumLen = 0, sumPages = 0, sumOcrMs = 0
let sumHit = 0, sumHypLen = 0, sumHitP = 0
const tblAgg = { refTables: 0, matched: 0, exact: 0, f1s: [] }

for (const f of files) {
  // pdfjs가 넘긴 ArrayBuffer를 detach하므로 파스마다 새 사본
  const raw = readFileSync(join(pdfDir, f))
  const buf = () => toAB(Buffer.from(raw))
  const probe = await parse(buf())
  if (!probe.success || !probe.pageQuality?.length) { rows.push({ doc: f, skip: "parse/quality 없음" }); continue }

  const clean = probe.pageQuality
    .filter(q => !q.needsOcr && q.textChars >= MIN_PAGE_CHARS)
    .slice(0, pagesPerDoc).map(q => q.page)
  if (!clean.length) { rows.push({ doc: f, skip: "클린 텍스트층 페이지 없음" }); continue }

  const pages = clean.join(",")
  // 머리글/바닥글 제거는 텍스트층 y-클러스터 기반이라 OCR 경로와 비대칭 — 양쪽 다 끔
  const gt = await parse(buf(), { pages, removeHeaderFooter: false })
  const t0 = performance.now()
  const ocr = await parse(buf(), { pages, removeHeaderFooter: false, ocr: "force" })
  const ocrMs = performance.now() - t0
  if (!gt.success || !ocr.success) { rows.push({ doc: f, skip: `재파싱 실패: ${gt.error ?? ocr.error ?? "?"}` }); continue }

  const a = norm(textOf(gt.blocks)).slice(0, MAX_CMP_CHARS)
  const b = norm(textOf(ocr.blocks)).slice(0, MAX_CMP_CHARS)
  const dist = editDistance(a, b)
  const cer = a.length ? dist / a.length : 0
  const { recall, precision } = charBagPR(a, b)
  // 한글 음절만의 recall — 래스터에 글꼴이 안 그려진 페이지(비내장 폰트 치환 실패)를 드러낸다
  const hg = charBagPR(hangulOnly(a), hangulOnly(b))

  const refGrids = collectIrGrids(gt.blocks).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors }))
  const hyp = collectIrGrids(ocr.blocks)
  let tbl = null
  if (refGrids.length) {
    const s = scoreTables(refGrids, hyp)
    const matched = refGrids.length - s.unmatchedRef
    tbl = { ref: refGrids.length, matched, exact: s.exactCount, cellF1: s.cellF1 }
    tblAgg.refTables += refGrids.length
    tblAgg.matched += matched
    tblAgg.exact += s.exactCount
    if (s.cellF1 != null) tblAgg.f1s.push(s.cellF1)
  }

  sumDist += dist; sumLen += a.length
  sumHit += Math.round(recall * a.length); sumHypLen += b.length
  sumHitP += Math.round(precision * b.length)
  sumPages += clean.length; sumOcrMs += ocrMs
  rows.push({ doc: f, pages: clean, gtChars: a.length, dist, cer: +cer.toFixed(4), charRecall: +recall.toFixed(4), charPrecision: +precision.toFixed(4), hangulRecall: +hg.recall.toFixed(4), secPerPage: +(ocrMs / 1000 / clean.length).toFixed(2), tbl })
  console.log(`${f} p[${pages}] CER ${(cer * 100).toFixed(2)}% recall ${(recall * 100).toFixed(1)}% prec ${(precision * 100).toFixed(1)}% 한글recall ${(hg.recall * 100).toFixed(1)}% ${(ocrMs / 1000 / clean.length).toFixed(1)}s/p${tbl ? ` 표 ${tbl.matched}/${tbl.ref} cellF1 ${tbl.cellF1?.toFixed(3)}` : ""}`)
}

const scored = rows.filter(r => !r.skip)
const scoredCer = scored.map(r => r.cer)
const summary = {
  generatedAt: new Date().toISOString(),
  docs: scored.length, skipped: rows.length - scored.length,
  pages: sumPages,
  cerMicro: sumLen ? +(sumDist / sumLen).toFixed(5) : null,
  cerMedian: scoredCer.length ? +scoredCer.sort((x, y) => x - y)[Math.floor(scoredCer.length / 2)].toFixed(5) : null,
  charRecallMicro: sumLen ? +(sumHit / sumLen).toFixed(5) : null,
  charPrecisionMicro: sumHypLen ? +(sumHitP / sumHypLen).toFixed(5) : null,
  secPerPage: sumPages ? +(sumOcrMs / 1000 / sumPages).toFixed(2) : null,
  tables: tblAgg.refTables ? {
    refTables: tblAgg.refTables, matched: tblAgg.matched, exact: tblAgg.exact,
    matchedRate: +(tblAgg.matched / tblAgg.refTables).toFixed(4),
    exactRate: +(tblAgg.exact / tblAgg.refTables).toFixed(4),
    cellF1Mean: tblAgg.f1s.length ? +(tblAgg.f1s.reduce((x, y) => x + y, 0) / tblAgg.f1s.length).toFixed(4) : null,
  } : null,
  note: "정답=같은 PDF의 클린 텍스트층, 입력=216dpi 렌더 강제 OCR — 실스캔 노이즈/스큐 미반영(상한치)",
}
mkdirSync(join(root, "out"), { recursive: true })
writeFileSync(join(root, "out", "ocr-accuracy.json"), JSON.stringify({ summary, rows }, null, 2))
console.log("\n== OCR accuracy (clean-render ceiling) ==")
console.log(JSON.stringify(summary, null, 2))
