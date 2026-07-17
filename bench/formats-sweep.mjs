#!/usr/bin/env node
// docx / xlsx / hml(HWPML) 트랙 — 스모크(파싱 성공+비어있지 않음) + 자기참조 GT recall.
// hwpx-ref 패턴 이식: 포맷의 원본 XML에서 텍스트 유닛을 독립 추출해 kordoc md와 정렬.
//
// 유닛 추출 (파서와 코드 0% 공유):
//   docx : word/document.xml 본문 w:p 문단 (w:t 연결, w:instrText 등 필드코드 제외,
//          mc:Fallback 스킵 — Choice 이중 렌더, 텍스트박스 문단은 별도 유닛)
//   xlsx : xl/worksheets/*.xml 셀 — 문자열 셀(s/inlineStr/str)은 str 유닛,
//          숫자 셀은 num 유닛으로 분리 채점 (서식 적용 숫자·날짜는 표기 차이가 정상이라
//          str만 게이트, num은 보고)
//   hml  : 본문 P > TEXT > CHAR 텍스트 (헤더의 스타일 정의는 비대상)
//
// 게이트: parseErrors=0 · docxRecall·hmlRecall·xlsxStrRecall ≥ 플로어 (기준선 후 확정)
// 사용법: node bench/formats-sweep.mjs [--gate] [--doc=부분문자열] [--verbose]

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { parse } from "../dist/index.js"
import { parseXmlLite } from "./ref/hwpx-ref.mjs"
import { mdToPlain, normKey } from "./lib/normalize.mjs"
import { alignUnits } from "./lib/align.mjs"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const gateMode = args.includes("--gate")
const verbose = args.includes("--verbose")
const docFilter = (args.find(a => a.startsWith("--doc=")) ?? "").split("=")[1] ?? null

// 게이트 = 무후퇴 플로어 (2026-07-03 2차 상향, 2회 연속 측정 동일 확인:
// docx 0.998903 / xlsxStr 1.0 / hml 0.995974).
// 상향 근거 픽스: ①docx 병합표 그리드 배치 — 밀집 배열을 그리드로 오독해 gridSpan 뒤
// 셀 유실 (niied 0.675→1.0) ②docx 텍스트박스(txbxContent) 수집 + Fallback 스킵
// (kats 0.917→0.9985, arko 0.880→0.9998) ③추출기 시트 순서 사전순→워크북 순서 미러
// (goe str 0.984→1.0 — 파서 무죄, 추출기 순서 비대칭이었음)
// 이전 세대 픽스: 한셀(HCell) xlsx 접두 네임스페이스 인식 · HML P 앵커 표 소실 해소.
// 잔여 미달 (수용): kats "형용사또는명사" 소량 · hml bizinfo 0.973 (글상자/도형 텍스트)
// 2026-07-17 만점 잠금: HML 병합 헤더 셀 소실 수리(parseTable 이중 그리딩 제거) +
// docx OMML whitelist 대칭 + 중첩 링크 언랩 + xlsx num 토큰 multiset·toPrecision(15)
// 정규화로 4지표 전부 1.0 — 새 플로어가 기준. numRecall도 게이트 승격.
const GATES = { parseErrors: 0, docxRecall: 1, xlsxStrRecall: 1, hmlRecall: 1, xlsxNumRecall: 1 }

// 유닛 정렬 상한 — 초대형 스프레드시트(개표결과 25만+ 셀)는 align이 수십 분 걸려
// recall 모수에서 제외(스모크만). 초과 문서는 unitCapped로 보고.
const UNIT_CAP = 50_000

const round = (x, d = 6) => (x === null || x === undefined ? null : +x.toFixed(d))

// ─── 유닛 추출기 ────────────────────────────────────

function textOf(node, out = []) {
  for (const ch of node.children) {
    if (typeof ch === "string") out.push(ch)
    else textOf(ch, out)
  }
  return out
}

/** docx: 본문 w:p → 유닛. 필드 코드(instrText)·삭제 추적(delText)은 제외.
 *  파서 경계 미러: mc:Fallback은 Choice와 같은 텍스트박스의 이중 렌더라 스킵,
 *  텍스트박스(txbxContent) 문단은 앵커 문단과 별도 유닛 (파서가 별도 블록 출력) */
async function docxUnits(buf) {
  const zip = await JSZip.loadAsync(buf)
  const doc = zip.file("word/document.xml")
  if (!doc) throw new Error("word/document.xml 없음")
  const rootNode = parseXmlLite(await doc.async("string"))
  const units = []
  const paraText = p => {
    const parts = []
    const walkRun = n => {
      for (const c of n.children) {
        if (typeof c === "string") continue
        if (c.tag === "t") parts.push(textOf(c).join(""))
        else if (c.tag === "tab") parts.push(" ")
        else if (c.tag === "br" || c.tag === "cr") parts.push("\n")
        else if (c.tag === "instrtext" || c.tag === "deltext" || c.tag === "fldchar") continue
        // OMML 수식 — 파서는 $LaTeX$로 방출·mdToPlain이 수식 span 제거 (HWPX 수식
        // whitelist와 동일 정책) → GT도 수식 서브트리를 recall 모수에서 제외
        else if (c.tag === "omath" || c.tag === "omathpara") continue
        else if (c.tag === "fallback" || c.tag === "txbxcontent") continue
        else walkRun(c)
      }
    }
    walkRun(p)
    return parts.join("").trim()
  }
  // 텍스트박스 문단 — 파서 collectTextboxParagraphs 미러 (txbxContent 하위 p만, Fallback 스킵)
  const walkTxbx = (node, inTx) => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "fallback") continue
      const now = inTx || ch.tag === "txbxcontent"
      if (now && ch.tag === "p") {
        const t = paraText(ch)
        if (t) units.push(t)
      }
      walkTxbx(ch, now)
    }
  }
  const walkP = node => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "fallback") continue
      if (ch.tag === "p") {
        const t = paraText(ch)
        if (t) units.push(t)
        walkTxbx(ch, false) // 문단 안 텍스트박스 문단 — 별도 유닛
      } else walkP(ch)
    }
  }
  walkP(rootNode)
  return { units }
}

/** 시트 파일 순서 — 파서 미러 (workbook.xml 시트 순서 + rels 매핑, 실패 시 숫자 정렬).
 *  Object.keys().sort()는 사전순이라 sheet10이 sheet2 앞에 와 유닛 순서가 md와 어긋난다
 *  (align은 순서 민감 — goe 22시트에서 거짓 miss) */
async function orderedSheetPaths(zip) {
  const numeric = Object.keys(zip.files)
    .filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort((a, b) => +a.match(/(\d+)\.xml$/)[1] - +b.match(/(\d+)\.xml$/)[1])
  try {
    const relMap = new Map()
    const walkRel = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "relationship") relMap.set(ch.attrs.id, ch.attrs.target)
        else walkRel(ch)
      }
    }
    walkRel(parseXmlLite(await zip.file("xl/_rels/workbook.xml.rels").async("string")))
    const sheets = []
    const walkSheet = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "sheet") sheets.push(ch)
        else walkSheet(ch)
      }
    }
    walkSheet(parseXmlLite(await zip.file("xl/workbook.xml").async("string")))
    const paths = sheets
      .map((el, i) => {
        let t = relMap.get(el.attrs.id)
        if (!t) return `xl/worksheets/sheet${i + 1}.xml`
        if (t.startsWith("/")) t = t.slice(1)
        else if (!t.startsWith("xl/")) t = `xl/${t}`
        return t
      })
      .filter(p => zip.file(p))
    return paths.length ? paths : numeric
  } catch {
    return numeric
  }
}

/** xlsx: 셀 값 유닛 — 문자열/숫자 분리 */
async function xlsxUnits(buf) {
  const zip = await JSZip.loadAsync(buf)
  const sstFile = zip.file("xl/sharedStrings.xml")
  const sst = []
  if (sstFile) {
    const sstRoot = parseXmlLite(await sstFile.async("string"))
    const walkSi = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "si") sst.push(textOf(ch).join(""))
        else walkSi(ch)
      }
    }
    walkSi(sstRoot)
  }
  const strUnits = [], numUnits = []
  const sheetNames = await orderedSheetPaths(zip)
  for (const name of sheetNames) {
    const sheetRoot = parseXmlLite(await zip.file(name).async("string"))
    const walkC = node => {
      for (const ch of node.children) {
        if (typeof ch === "string") continue
        if (ch.tag === "c") {
          const t = ch.attrs.t ?? "n"
          let v = null
          for (const c of ch.children) {
            if (typeof c === "string") continue
            if (c.tag === "v") v = textOf(c).join("")
            else if (c.tag === "is") v = textOf(c).join("")
          }
          if (v === null || v === "") continue
          if (t === "s") { const s = sst[parseInt(v, 10)]; if (s?.trim()) strUnits.push(s.trim()) }
          else if (t === "inlineStr" || t === "str") { if (v.trim()) strUnits.push(v.trim()) }
          else numUnits.push(v.trim())
        } else walkC(ch)
      }
    }
    walkC(sheetRoot)
  }
  return { strUnits, numUnits }
}

/** hml: BODY 하위 P > TEXT > CHAR 텍스트 유닛 (HEAD의 스타일 정의 제외).
 *  파서 경계 미러: P 유닛 = 자기 CHAR 텍스트만 (TABLE/내부 P 진입 금지 — 셀 P는
 *  walkBody 재귀가 각자 유닛으로), FOOTNOTE류는 CHAR textOf에 이미 포함되므로
 *  별도 유닛 금지 (이중 계상 방지). */
function hmlUnits(xmlText) {
  const rootNode = parseXmlLite(xmlText)
  const units = []
  const walkBody = (node, inBody) => {
    for (const ch of node.children) {
      if (typeof ch === "string") continue
      if (ch.tag === "footnote" || ch.tag === "endnote" || ch.tag === "header" || ch.tag === "footer") continue
      const isBody = inBody || ch.tag === "body"
      if (ch.tag === "p" && isBody) {
        const parts = []
        const walkChar = n => {
          for (const c of n.children) {
            if (typeof c === "string") continue
            if (c.tag === "char") parts.push(textOf(c).join(""))
            else if (c.tag === "tab") parts.push(" ")
            else if (c.tag === "table" || c.tag === "p") continue // 구조 자식은 walkBody 소관
            else walkChar(c)
          }
        }
        walkChar(ch)
        const t = parts.join("").trim()
        if (t) units.push(t)
        // P 안의 표/개체는 자식 P를 각자 유닛으로 (재귀)
        walkBody(ch, isBody)
      } else walkBody(ch, isBody)
    }
  }
  walkBody(rootNode, false)
  return { units }
}

// ─── recall 계산 (alignUnits 재사용) ─────────────────
function recallOf(unitTexts, md) {
  const mdKey = normKey(mdToPlain(md).text)
  const units = unitTexts.map((t, i) => ({ id: i, kind: "body", text: normKey(t) })).filter(u => u.text)
  if (units.length === 0) return { recall: 1, refChars: 0, matched: 0, misses: [] }
  const { perUnit } = alignUnits(units, mdKey)
  let total = 0, matched = 0
  const misses = []
  for (let i = 0; i < units.length; i++) {
    total += perUnit[i].total
    matched += perUnit[i].matched
    if (perUnit[i].matched < perUnit[i].total) misses.push({ text: units[i].text.slice(0, 50), miss: perUnit[i].total - perUnit[i].matched })
  }
  misses.sort((a, b) => b.miss - a.miss)
  return { recall: total ? matched / total : 1, refChars: total, matched, misses: misses.slice(0, 5) }
}

/** 숫자 셀 recall — 셀 토큰 multiset 대조. normKey가 인접 숫자 셀을 한 자리수-run으로
 * 이어붙여 substring 정렬이 유닛을 쪼개는 거짓 miss(goe 0.984, IR 대조 무손실 실측)를
 * 차단한다. 숫자 셀은 파서가 v 원문을 셀 토큰으로 방출하므로 정확 토큰 대조가 진실. */
function numRecallOf(unitTexts, md) {
  if (unitTexts.length === 0) return { recall: 1, refChars: 0, matched: 0, misses: [] }
  // 파서는 숫자 셀을 parseFloat(x.toPrecision(15)).toString()로 방출(IEEE 754 오차 제거,
  // src/xlsx/parser.ts) — GT의 float 꼬리("3046.9300999999996")도 같은 왕복으로 정규화
  const canon = s => {
    const x = Number(s)
    return Number.isFinite(x) ? parseFloat(x.toPrecision(15)).toString() : s
  }
  const freq = new Map()
  for (const tok of md.split(/[|\n]|<\/?(?:t[dhr]|table|thead|tbody)\b[^>]*>|<br\s*\/?>/i)) {
    const t = tok.trim()
    if (t) { const k = canon(t); freq.set(k, (freq.get(k) ?? 0) + 1) }
  }
  let total = 0, matched = 0
  const missFreq = new Map()
  for (const raw of unitTexts) {
    const t = canon(raw.trim())
    if (!t) continue
    total += t.length
    const n = freq.get(t) ?? 0
    if (n > 0) { matched += t.length; freq.set(t, n - 1) }
    else missFreq.set(t, (missFreq.get(t) ?? 0) + 1)
  }
  const misses = [...missFreq].map(([text, cnt]) => ({ text: text.slice(0, 50), miss: text.length * cnt }))
  misses.sort((a, b) => b.miss - a.miss)
  return { recall: total ? matched / total : 1, refChars: total, matched, misses: misses.slice(0, 5) }
}

// ─── 메인 ──────────────────────────────────────────
const t0 = performance.now()
const base = join(root, "corpus", "formats")
const rows = []
let parseErrors = 0
const agg = { docx: { m: 0, t: 0 }, xlsxStr: { m: 0, t: 0 }, xlsxNum: { m: 0, t: 0 }, hml: { m: 0, t: 0 } }

for (const kind of ["docx", "xlsx", "hml"]) {
  let files = []
  try {
    files = (await readdir(join(base, kind))).filter(n => !n.startsWith(".")).sort()
  } catch { continue }
  for (const name of files) {
    const rel = `${kind}/${name}`
    if (docFilter && !rel.includes(docFilter)) continue
    const buf = await readFile(join(base, kind, name))
    const t = performance.now()
    let row = { file: rel, kind }
    try {
      const res = await parse(Buffer.from(buf), { filename: name })
      if (!res.success) {
        parseErrors++
        row = { ...row, ok: false, error: `${res.code}: ${String(res.error).slice(0, 120)}` }
      } else if (!res.markdown?.trim()) {
        parseErrors++
        row = { ...row, ok: false, error: "빈 마크다운" }
      } else {
        row.ok = true
        row.mdChars = res.markdown.length
        if (kind === "docx") {
          const { units } = await docxUnits(buf)
          if (units.length > UNIT_CAP) { row.unitCapped = units.length }
          else {
            const r = recallOf(units, res.markdown)
            row.recall = round(r.recall); row.refChars = r.refChars; row.topMisses = r.misses
            agg.docx.m += r.matched; agg.docx.t += r.refChars
          }
        } else if (kind === "xlsx") {
          const { strUnits, numUnits } = await xlsxUnits(buf)
          if (strUnits.length + numUnits.length > UNIT_CAP) { row.unitCapped = strUnits.length + numUnits.length }
          else {
            const rs = recallOf(strUnits, res.markdown)
            const rn = numRecallOf(numUnits, res.markdown)
            row.strRecall = round(rs.recall); row.numRecall = round(rn.recall)
            row.refChars = rs.refChars + rn.refChars; row.topMisses = rs.misses
            agg.xlsxStr.m += rs.matched; agg.xlsxStr.t += rs.refChars
            agg.xlsxNum.m += rn.matched; agg.xlsxNum.t += rn.refChars
          }
        } else {
          const { units } = hmlUnits(buf.toString("utf8"))
          if (units.length > UNIT_CAP) { row.unitCapped = units.length }
          else {
            const r = recallOf(units, res.markdown)
            row.recall = round(r.recall); row.refChars = r.refChars; row.topMisses = r.misses
            agg.hml.m += r.matched; agg.hml.t += r.refChars
          }
        }
      }
    } catch (err) {
      parseErrors++
      row = { ...row, ok: false, error: String(err?.message ?? err).slice(0, 200) }
    }
    row.ms = Math.round(performance.now() - t)
    rows.push(row)
    if (verbose) console.error(`${kind} ${row.ok ? (row.recall ?? row.strRecall ?? "-") : "ERR"} ${rel}${row.error ? " — " + row.error : ""}`)
  }
}

const rate = a => (a.t ? a.m / a.t : 1)
// 모수 하한 (2026-07-05 실측 docx 7/xlsx 11/hml 9의 ~절반) — 폴더 누락·미동기 시
// catch{continue}+rate(0/0)=1 로 조용한 만점 PASS가 나는 것 방지 (리뷰 #14)
const MIN_POP = { docx: 4, xlsx: 6, hml: 5 }
const kindCount = k => rows.filter(r => r.kind === k).length
const gates = {
  parseErrors: { value: parseErrors, threshold: GATES.parseErrors, pass: parseErrors === 0 },
  docxRecall: { value: round(rate(agg.docx)), threshold: GATES.docxRecall, pass: rate(agg.docx) >= GATES.docxRecall },
  xlsxStrRecall: { value: round(rate(agg.xlsxStr)), threshold: GATES.xlsxStrRecall, pass: rate(agg.xlsxStr) >= GATES.xlsxStrRecall },
  hmlRecall: { value: round(rate(agg.hml)), threshold: GATES.hmlRecall, pass: rate(agg.hml) >= GATES.hmlRecall },
  xlsxNumRecall: { value: round(rate(agg.xlsxNum)), threshold: GATES.xlsxNumRecall, pass: rate(agg.xlsxNum) >= GATES.xlsxNumRecall },
  population: {
    value: `docx ${kindCount("docx")}/xlsx ${kindCount("xlsx")}/hml ${kindCount("hml")}`,
    threshold: `≥ ${MIN_POP.docx}/${MIN_POP.xlsx}/${MIN_POP.hml}`,
    pass: docFilter != null ||
      (kindCount("docx") >= MIN_POP.docx && kindCount("xlsx") >= MIN_POP.xlsx && kindCount("hml") >= MIN_POP.hml),
  },
}
const pass = Object.values(gates).every(g => g.pass)

const report = {
  generatedAt: new Date().toISOString(),
  elapsedMs: Math.round(performance.now() - t0),
  files: rows.length, pass, gates,
  xlsxNumRecall: round(rate(agg.xlsxNum)), // 보고 전용 (서식 숫자·날짜 표기 차이)
  rows,
}
await mkdir(join(root, "out"), { recursive: true })
await writeFile(join(root, "out", "formats.json"), JSON.stringify(report, null, 1))

console.log(`\n══ formats 트랙 — ${rows.length}건 (docx ${rows.filter(r => r.kind === "docx").length} / xlsx ${rows.filter(r => r.kind === "xlsx").length} / hml ${rows.filter(r => r.kind === "hml").length}) (${Math.round(report.elapsedMs / 1000)}s) ══`)
for (const [k, g] of Object.entries(gates)) console.log(`  ${g.pass ? "✅" : "❌"} ${k.padEnd(14)} ${g.value} (기준 ${g.threshold})`)
console.log(`  xlsx num recall(보고): ${report.xlsxNumRecall}`)
for (const r of rows.filter(r => r.unitCapped)) console.log(`  ⚠ recall 제외(유닛 ${r.unitCapped} > ${UNIT_CAP}): ${r.file} — 스모크만`)
const worst = rows.filter(r => r.ok && (r.recall ?? r.strRecall) < 1).sort((a, b) => (a.recall ?? a.strRecall) - (b.recall ?? b.strRecall)).slice(0, 5)
for (const w of worst) console.log(`  ${(w.recall ?? w.strRecall)} ${w.file} ${JSON.stringify(w.topMisses?.[0] ?? "")}`)
for (const r of rows.filter(r => !r.ok)) console.log(`  ERR ${r.file} — ${r.error}`)
console.log(`report → bench/out/formats.json | ${pass ? "PASS ✅" : "FAIL ❌"}${gateMode ? "" : " (보고 전용 — --gate 시 exit code 반영)"}`)
if (gateMode && !pass) process.exit(1)
