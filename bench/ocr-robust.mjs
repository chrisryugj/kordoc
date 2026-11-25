/** OCR 강건성 실측 — ocr-accuracy 와 같은 클린 텍스트층 페이지를 216dpi 로 렌더한 뒤
 *  실스캔형 열화(기울기·잡음·흐림·저해상도·JPEG·원근)를 결정적으로(시드 고정) 입혀 이미지 입력
 *  경로(parse(PNG/JPEG) → 내장 OCR)로 돌리고, 열화별 CER·문자 P/R·표 구조를 낸다.
 *
 *  정답·정규화는 ocr-accuracy 와 같다 (ocr-lib.mjs fair v2). clean 행은 같은 렌더를 PNG 로
 *  넣은 이미지 경로 기준선 — PDF 경로(ocr-accuracy)와는 좌표 환산(216dpi 가정)만 같다.
 *
 *  실행: node bench/ocr-robust.mjs [--limit=N] [--pages=K(기본 1)] [--doc=이름] [--variants=a,b] [--gate] [--dump=디렉토리]
 *  산출: bench/out/ocr-robust.json · 열화 이미지 표본은 --save 시 bench/out/ocr-robust/ ·
 *        --dump 시 페이지·열화별 GT/OCR IR 블록 JSON
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { parse } from "../dist/index.js"
import { collectIrGrids, scoreTables } from "./lib/table-score.mjs"
import { blockTexts, fairText, hangulOnly, charBagPR, editDistance, rasterGlyphCoverage } from "./ocr-lib.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const opt = (k, d) => (args.find(a => a.startsWith(`--${k}=`)) ?? "").split("=")[1] ?? d
const limit = Number(opt("limit", Infinity))
const pagesPerDoc = Number(opt("pages", 1))
const docFilter = opt("doc", null)
const gateMode = args.includes("--gate")
const save = args.includes("--save")
const dumpDir = opt("dump", null)

const SCALE = 3 // 216dpi — PDF OCR 렌더와 같은 기준
const MIN_PAGE_CHARS = 200
const MAX_CMP_CHARS = 20000

/** 열화 정의 — 순서 = 보고 순서. 모두 결정적(시드: 문서·페이지·열화 이름) */
const VARIANTS = {
  clean: [],
  "skew+1": [["rotate", 1]],
  "skew-2": [["rotate", -2]],
  "skew+3": [["rotate", 3]],
  noise: [["noise", 12]],
  blur: [["blur", 1.2]],
  dpi150: [["dpi", 150]],
  jpeg50: [["jpeg", 50]],
  // 휴대폰으로 비스듬히 찍은 페이지 — 한쪽 세로 변이 짧은 사다리꼴(원근)이라 글줄 기울기가 위아래로 달라진다(위 +·아래 −).
  // [오른쪽 변이 짧아지는 비율, 덧붙일 기울기°]. 게이트(cerMax)는 두지 않았다 — 37페이지 로컬 코퍼스 측정이라(아래 PR 측정 참고) 전체 코퍼스에서 래칫한다
  // 측정(2026-11-25, 37페이지): persp8 CER .296 → .078 · persp8+2 .351 → .133 (원근 펴기 전 → 후)
  persp8: [["persp", [0.08, 0]]],
  "persp8+2": [["persp", [0.08, 2]], ["blur", 0.7], ["jpeg", 70]],
  // 실스캔 흉내: 200dpi · 기울기 -1.2° · 흐림 0.7 · 잡음 σ8 · JPEG 60
  scan: [["dpi", 200], ["rotate", -1.2], ["blur", 0.7], ["noise", 8], ["jpeg", 60]],
}
const wanted = opt("variants", null)?.split(",") ?? Object.keys(VARIANTS)

// 무후퇴 플로어 (열화별 CER 상한·페이지 수) — 2026-09-24 v4.14.4 실측(OCR 쪽 + 정답지인 텍스트층 파싱의 자간 숫자·조각 표 수정) + 0.5pp 래칫.
// 실측: clean 0.0884 · skew+1 0.0921 · skew-2 0.0885 · skew+3 0.0985 · noise 0.0886 · blur 0.0926 ·
//       dpi150 0.0899 · jpeg50 0.0889 · scan 0.1022 (각 40쪽). OCR 쪽만 고친 중간값: clean 0.1731 · scan 0.1868,
//       v4.14.3: clean 0.1902 · skew+1 0.2250 · scan 0.2208, 2026-09-23: clean 0.2198 · scan 0.2204, 종전 엔진: skew+3 0.576 · scan 0.315
// v4.15.0: 14문서 추가 → 열화별 54쪽. 보강 후 기준선과 모든 문서·열화별 CER 완전 동일.
// clean .1066·skew+1 .1056·skew-2 .1060·skew+3 .1068·noise .1047·blur .1056·dpi150 .1017·jpeg50 .1105·scan .1175.
const GATES = {
  cerMax: { clean: 0.107, "skew+1": 0.106, "skew-2": 0.107, "skew+3": 0.107, noise: 0.105, blur: 0.106, dpi150: 0.102, jpeg50: 0.111, scan: 0.118 },
  minPages: 54,
}

function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function hashStr(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0 }

/** 네 점 대응으로 사영 변환(3×3) — from 의 점을 to 로 보낸다 */
function homography(from, to) {
  const A = [], b = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i]
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u)
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v)
  }
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r
    ;[A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]]
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]
      b[r] -= f * b[c]
    }
  }
  return [...b.map((v, i) => v / A[i][i]), 1]
}

async function degrade(sharp, rgba, W, H, steps, seedKey) {
  let buf = Buffer.from(rgba), w = W, h = H
  let format = "png", quality = 100
  const rnd = mulberry32(hashStr(seedKey))
  for (const [op, v] of steps) {
    if (op === "rotate") {
      const r = await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
        .rotate(v, { background: { r: 255, g: 255, b: 255, alpha: 1 } }).raw().toBuffer({ resolveWithObject: true })
      buf = r.data; w = r.info.width; h = r.info.height
    } else if (op === "persp") {
      // 출력 캔버스(같은 크기) 위 사다리꼴(왼쪽 변 그대로, 오른쪽 변을 k 만큼 줄여 가운데 정렬)을 기울기만큼 돌린 자리에 페이지를 놓는다
      const [k, deg] = v, t = (deg * Math.PI) / 180, cx = w / 2, cy = h / 2
      const rot = ([x, y]) => [cx + (x - cx) * Math.cos(t) - (y - cy) * Math.sin(t), cy + (x - cx) * Math.sin(t) + (y - cy) * Math.cos(t)]
      const quad = [[0, 0], [w, (h * k) / 2], [w, h * (1 - k / 2)], [0, h]].map(rot)
      const m = homography(quad, [[0, 0], [w, 0], [w, h], [0, h]])
      const out = Buffer.alloc(buf.length, 255)
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = m[6] * x + m[7] * y + m[8], sx = (m[0] * x + m[1] * y + m[2]) / d, sy = (m[3] * x + m[4] * y + m[5]) / d
        const x0 = Math.floor(sx), y0 = Math.floor(sy)
        if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) continue
        const fx = sx - x0, fy = sy - y0, i = (y0 * w + x0) * 4, o = (y * w + x) * 4
        for (let c = 0; c < 4; c++) out[o + c] = Math.round((buf[i + c] * (1 - fx) + buf[i + 4 + c] * fx) * (1 - fy) + (buf[i + w * 4 + c] * (1 - fx) + buf[i + w * 4 + 4 + c] * fx) * fy)
      }
      buf = out
    } else if (op === "blur") {
      buf = await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).blur(v).raw().toBuffer()
    } else if (op === "dpi") {
      const nw = Math.round(w * v / (SCALE * 72)), nh = Math.round(h * v / (SCALE * 72))
      buf = await sharp(buf, { raw: { width: w, height: h, channels: 4 } }).resize(nw, nh, { fit: "fill" }).raw().toBuffer()
      w = nw; h = nh
    } else if (op === "noise") {
      // 가우시안(Box-Muller), 휘도 상관 — 세 채널 같은 값
      const out = Buffer.from(buf)
      for (let i = 0; i < out.length; i += 4) {
        const u = Math.max(1e-12, rnd()), u2 = rnd()
        const n = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * u2) * v
        for (let c = 0; c < 3; c++) out[i + c] = Math.max(0, Math.min(255, Math.round(out[i + c] + n)))
      }
      buf = out
    } else if (op === "jpeg") { format = "jpeg"; quality = v }
  }
  const img = sharp(buf, { raw: { width: w, height: h, channels: 4 } }).removeAlpha()
  return { bytes: format === "jpeg" ? await img.jpeg({ quality }).toBuffer() : await img.png().toBuffer(), w, h, format }
}

const toAB = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
const pdfDir = join(root, "corpus", "pdf")
const modelDir = join(process.env.KORDOC_MODEL_CACHE?.trim() || join(homedir(), ".cache", "kordoc", "models"), "ppocr")
if (!existsSync(pdfDir) || !["det.onnx", "rec_korean.onnx", "rec_korean.yml"].every(f => existsSync(join(modelDir, f)))) {
  console.warn(`⚠️  [ocr-robust] 코퍼스 또는 OCR 모델 없음 — SKIP`)
  process.exit(0)
}
const sharp = (await import("sharp")).default
const { openPdf } = await import("./lib/pdf-engine.mjs")
let files = readdirSync(pdfDir).filter(f => f.endsWith(".pdf")).sort()
if (docFilter) files = files.filter(f => f.includes(docFilter))
if (Number.isFinite(limit)) files = files.slice(0, limit)
if (save) mkdirSync(join(root, "out", "ocr-robust"), { recursive: true })

const agg = Object.fromEntries(wanted.map(v => [v, { dist: 0, len: 0, hit: 0, hyp: 0, hHit: 0, hLen: 0, ms: 0, pages: 0, cers: [], ref: 0, matched: 0, f1s: [] }]))
const rows = []
for (const f of files) {
  const raw = readFileSync(join(pdfDir, f))
  const buf = () => toAB(Buffer.from(raw))
  const probe = await parse(buf())
  if (!probe.success || !probe.pageQuality?.length) continue
  const cand = probe.pageQuality.filter(q => !q.needsOcr && q.textChars >= MIN_PAGE_CHARS).slice(0, pagesPerDoc).map(q => q.page)
  if (!cand.length) continue
  const cov = await rasterGlyphCoverage(raw, cand)
  const pages = cand.filter(p => (cov.get(p) ?? 1) >= 0.8)
  if (!pages.length) continue

  const pdf = await openPdf(raw)
  const renders = new Map()
  try {
    for (const pn of pages) {
      // kordoc OCR 과 같은 PDFium 렌더
      const r = await pdf.render(pn, SCALE)
      renders.set(pn, { rgba: r.data, w: r.width, h: r.height })
    }
  } finally { pdf.close() }

  for (const pn of pages) {
    const gt = await parse(buf(), { pages: String(pn), removeHeaderFooter: false })
    if (!gt.success) continue
    const a = fairText(blockTexts(gt.blocks)).slice(0, MAX_CMP_CHARS)
    const ha = hangulOnly(a)
    const refGrids = collectIrGrids(gt.blocks).map(g => ({ rows: g.rows, cols: g.cols, cells: g.anchors }))
      .filter(g => g.cells.filter(x => x.text.trim()).length >= 3)
    const { rgba, w, h } = renders.get(pn)
    const row = { doc: f, page: pn, gtChars: a.length }
    for (const v of wanted) {
      const img = await degrade(sharp, rgba, w, h, VARIANTS[v], `${f}#${pn}#${v}`)
      if (save) writeFileSync(join(root, "out", "ocr-robust", `${f.replace(/\.pdf$/, "")}-p${pn}-${v}.${img.format === "jpeg" ? "jpg" : "png"}`), img.bytes)
      const t0 = performance.now()
      const res = await parse(toAB(img.bytes))
      const ms = performance.now() - t0
      if (dumpDir) {
        mkdirSync(dumpDir, { recursive: true })
        writeFileSync(join(dumpDir, `${f}#${pn}#${v}.json`), JSON.stringify({ pages: [pn], ms, gt: gt.blocks, ocr: res.success ? res.blocks : [] }))
      }
      const b = res.success ? fairText(blockTexts(res.blocks)).slice(0, MAX_CMP_CHARS) : ""
      const dist = editDistance(a, b)
      const bag = charBagPR(a, b), hg = charBagPR(ha, hangulOnly(b))
      const g = agg[v]
      g.dist += dist; g.len += a.length; g.hit += bag.hit; g.hyp += b.length; g.hHit += hg.hit; g.hLen += ha.length
      g.ms += ms; g.pages++; g.cers.push(a.length ? dist / a.length : 0)
      if (refGrids.length && res.success) {
        const s = scoreTables(refGrids, collectIrGrids(res.blocks))
        g.ref += refGrids.length; g.matched += refGrids.length - s.unmatchedRef; g.f1s.push(s.cellF1)
      }
      row[v] = +(a.length ? dist / a.length : 0).toFixed(4)
    }
    rows.push(row)
    console.log(`${f} p${pn} ` + wanted.map(v => `${v} ${(row[v] * 100).toFixed(1)}%`).join(" · "))
  }
}

const med = (xs) => xs.length ? +[...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)].toFixed(4) : null
const summary = Object.fromEntries(wanted.map(v => {
  const g = agg[v]
  return [v, {
    pages: g.pages,
    cerMicro: g.len ? +(g.dist / g.len).toFixed(4) : null,
    cerMedian: med(g.cers),
    charRecall: g.len ? +(g.hit / g.len).toFixed(4) : null,
    charPrecision: g.hyp ? +(g.hit / g.hyp).toFixed(4) : null,
    hangulRecall: g.hLen ? +(g.hHit / g.hLen).toFixed(4) : null,
    tableMatched: g.ref ? +(g.matched / g.ref).toFixed(4) : null,
    tableCellF1: g.f1s.length ? +(g.f1s.reduce((x, y) => x + y, 0) / g.f1s.length).toFixed(4) : null,
    secPerPage: g.pages ? +(g.ms / 1000 / g.pages).toFixed(2) : null,
  }]
}))
const full = !docFilter && !Number.isFinite(limit) && pagesPerDoc === 1
const gates = Object.fromEntries(wanted.filter(v => GATES.cerMax[v] != null).map(v => [v, {
  value: `${summary[v].cerMicro} (${summary[v].pages}쪽)`, threshold: `≤ ${GATES.cerMax[v]}, ≥ ${GATES.minPages}쪽`,
  pass: summary[v].cerMicro != null && summary[v].cerMicro <= GATES.cerMax[v] && summary[v].pages >= GATES.minPages,
}]))
const pass = !full || Object.values(gates).every(g => g.pass)
mkdirSync(join(root, "out"), { recursive: true })
writeFileSync(join(root, "out", "ocr-robust.json"), JSON.stringify({ generatedAt: new Date().toISOString(), variants: VARIANTS, summary, pass, gates, rows }, null, 2))
console.log("\n== OCR robustness (degraded renders → image input) ==")
console.log("variant".padEnd(8), "pages", "  CER  ", "median", "recall", "prec ", "한글R ", "tblMatch", "tblF1 ", "s/p")
for (const v of wanted) {
  const s = summary[v]
  const p = (x) => x == null ? "  -   " : (x * 100).toFixed(1).padStart(5) + "%"
  console.log(v.padEnd(8), String(s.pages).padStart(5), p(s.cerMicro), p(s.cerMedian), p(s.charRecall), p(s.charPrecision), p(s.hangulRecall), p(s.tableMatched).padStart(8), p(s.tableCellF1), s.secPerPage)
}
for (const [k, g] of Object.entries(gates)) console.log(`${g.pass ? "✅" : "❌"} ${k}: ${g.value} (${g.threshold})`)
console.log(`report → bench/out/ocr-robust.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용)"}`)
if (gateMode && !pass) process.exit(1)
