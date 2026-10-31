#!/usr/bin/env node
/**
 * HWP 5.x → HWPX 변환 충실도 — 같은 문서를 한컴이 .hwp 와 .hwpx 로 함께 저장한 짝에서, kordoc 변환본(hwpToHwpx)을 한컴 HWPX 와
 * XML 트리째 맞대어 속성 값·글 마디 단위 일치율을 잰다. 한컴이 쓴 HWPX 가 정답이다 — 같은 문서 모델의 다른 직렬화라 속성이 1:1 이다.
 *
 * 정답 짝(2026-10-31 확정, 결과를 보기 전에 정한 모수 — 바꾸지 않는다)
 *  - 같은 이름 .hwp + .hwpx 이고 HWPX 가 한컴 저장본: 다른 변환 도구가 남긴 META-INF/rhwp-*-origin 이 없고 Preview/PrvImage.png 가
 *    200바이트 이상(변환 도구본은 68바이트 빈 그림). 코퍼스 법령 별표·서식 짝 842개는 이 조건에서 빠진다(다른 도구의 변환본).
 *  - 같은 판: 한컴이 저장할 때 만든 미리보기 글(HWP PrvText 스트림 ↔ HWPX Preview/PrvText.txt, 공백 무시)이 같다.
 *  - 속성 대조는 정답 HWPX 가 xmlVersion 1.5(한글 2020 이상) 인 짝만 — 그 아래 판은 직렬화 꼴이 달라(hp:switch 없음·빈 속성 생략)
 *    글 일치만 잰다. 변환본은 xml 1.5 꼴로 쓴다.
 *
 * 지표
 *  - attrMatch : header.xml·section*.xml·masterpage*.xml 의 속성 값과 글 마디를 단위로, 정답과 같은 값의 비율(빠진 마디·덧붙은 마디의
 *                단위도 모수에 든다). 자식 마디는 이름 순서열로 맞대(앞뒤 50마디 안에서 다시 맞춤) 하나가 빠져도 뒤가 밀리지 않게 한다.
 *  - textMatch : 섹션마다 hp:t 글을 이은 것이 정답과 같은 짝의 비율(전 짝).
 *  - exact     : 대조 단위가 모두 같은 짝 수.
 *  - parts     : 패키지 항목(BinData·Contents·Chart 등, 미리보기·설정·version 은 제외) 이름 집합이 같은 짝 비율.
 *
 * 사용: node bench/hwp2hwpx.mjs [--doc=부분문자열] [--limit=N] [--show=N(문서별 첫 불일치 N개)] [--top=N(불일치 종류 상위 N)] [--gate]
 * 산출: bench/out/hwp2hwpx.json
 */
import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import JSZip from "jszip"
import { hwpToHwpx } from "../dist/index.js"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const flag = (k, d) => { const a = args.find(x => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : d }
const docFilter = flag("doc", null)
const limit = Number(flag("limit", "0")) || Infinity
const showN = Number(flag("show", "0"))
const topN = Number(flag("top", "25"))
const gateMode = args.includes("--gate")
/** 무후퇴 플로어 — 2026-10-31 실측(속성 0.99214·글 1·264짝) */
const GATES = { attrMatch: 0.9921, textMatch: 1, minPairs: 264 }

// ─── 정답 짝 ─────────────────────────────────────────

const CFB = (await import("cfb")).default
function hwpPrvText(buf) {
  try {
    const c = CFB.read(buf, { type: "buffer" })
    const e = CFB.find(c, "/PrvText")
    return e?.content ? Buffer.from(e.content).toString("utf16le") : null
  } catch { return null }
}
const squash = s => s.replace(/\s+/g, "").replace(/\u0000/g, "")

async function* walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) yield* walk(p)
    else yield p
  }
}

const pairs = []
const skipped = { notHancom: 0, otherVersion: 0, unreadable: 0 }
for await (const p of walk(join(root, "corpus"))) {
  if (!p.endsWith(".hwp") || !existsSync(p + "x")) continue
  if (docFilter && !p.includes(docFilter)) continue
  const hwpx = readFileSync(p + "x")
  let zip
  try { zip = await JSZip.loadAsync(hwpx) } catch { skipped.unreadable++; continue }
  const names = Object.keys(zip.files)
  const prv = zip.file("Preview/PrvImage.png")
  if (names.some(n => /^META-INF\/rhwp-/.test(n)) || !prv || (await prv.async("uint8array")).length < 200) { skipped.notHancom++; continue }
  const hwp = readFileSync(p)
  const a = hwpPrvText(hwp), b = await zip.file("Preview/PrvText.txt")?.async("string")
  if (a === null || b === undefined) { skipped.unreadable++; continue }
  if (squash(a) !== squash(b)) { skipped.otherVersion++; continue }
  const version = await zip.file("version.xml")?.async("string") ?? ""
  pairs.push({ rel: relative(join(root, "corpus"), p).slice(0, -4), hwp, zip, xml15: /xmlVersion="1\.5"/.test(version) })
  if (pairs.length >= limit) break
}

// ─── XML 트리 ────────────────────────────────────────

const ENT = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" }
const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#"
  ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e] ?? m)

function parseXml(s) {
  const top = { name: "#root", attrs: {}, children: [] }
  const stack = [top]
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g
  for (const m of s.matchAll(re)) {
    const cur = stack[stack.length - 1]
    if (m[1] !== undefined) { cur.children.push({ name: "#text", text: m[1] }); continue }
    if (m[3] === undefined) {
      if (m[6] !== undefined && stack.length > 1) cur.children.push({ name: "#text", text: decode(m[6]) })
      continue
    }
    if (m[2] === "/") { stack.pop(); continue }
    const attrs = {}
    for (const a of m[4].matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) if (!a[1].startsWith("xmlns")) attrs[a[1]] = decode(a[2] ?? a[3])
    const node = { name: m[3], attrs, children: [] }
    cur.children.push(node)
    if (m[5] !== "/") stack.push(node)
  }
  return top
}

/** 마디의 대조 단위 수 — 속성 하나·글 마디 하나가 1 */
function units(n) {
  if (n.name === "#text") return 1
  let k = Object.keys(n.attrs).length
  for (const c of n.children) k += units(c)
  return k
}

/** 자식 맞대기 — 이름이 같으면 짝, 다르면 앞뒤 WINDOW 안에서 가까운 쪽으로 다시 맞춘다 */
const WINDOW = 50
function alignChildren(a, b) {
  const out = []
  let i = 0, j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i].name === b[j].name) { out.push([a[i++], b[j++]]); continue }
    let di = -1, dj = -1
    for (let k = 1; k <= WINDOW && (di < 0 || dj < 0); k++) {
      if (dj < 0 && i < a.length && j + k < b.length && b[j + k].name === a[i].name) dj = k
      if (di < 0 && j < b.length && i + k < a.length && a[i + k].name === b[j].name) di = k
    }
    if (dj >= 0 && (di < 0 || dj <= di)) { for (let k = 0; k < dj; k++) out.push([null, b[j++]]) }
    else if (di >= 0) { for (let k = 0; k < di; k++) out.push([a[i++], null]) }
    else {
      if (i < a.length) out.push([a[i++], null])
      if (j < b.length) out.push([null, b[j++]])
    }
  }
  return out
}

function compareTree(ours, truth, path, acc) {
  if (truth.name === "#text") {
    acc.total++
    if (ours.text === truth.text) acc.match++
    else acc.miss(`${path}#text`, truth.text, ours.text)
    return
  }
  for (const k of new Set([...Object.keys(truth.attrs), ...Object.keys(ours.attrs)])) {
    acc.total++
    if (truth.attrs[k] === ours.attrs[k]) acc.match++
    else acc.miss(`${truth.name}@${k}`, truth.attrs[k], ours.attrs[k], path)
  }
  for (const [x, y] of alignChildren(ours.children, truth.children)) {
    if (x && y) compareTree(x, y, `${path}/${y.name}`, acc)
    else if (y) { acc.total += units(y); acc.miss(`missing ${y.name}`, `${path}/${y.name}`, undefined, path, units(y)) }
    else { acc.total += units(x); acc.miss(`extra ${x.name}`, undefined, `${path}/${x.name}`, path, units(x)) }
  }
}

const tText = n => n.name === "#text" ? "" : (n.name === "hp:t" ? n.children.map(c => c.name === "#text" ? c.text : "").join("") : "") + n.children.map(tText).join("")

// ─── 대조 ────────────────────────────────────────────

const PART_RE = /^(Contents\/(header|section\d+|masterpage\d+)\.xml)$/
const kinds = new Map()
const rows = []
const agg = { total: 0, match: 0, header: [0, 0], section: [0, 0] }
let textOk = 0, partsOk = 0, exact = 0, failed = 0
const t0 = performance.now()
for (const p of pairs) {
  const row = { pair: p.rel, xml15: p.xml15 }
  rows.push(row)
  let out
  try {
    out = await JSZip.loadAsync(await hwpToHwpx(new Uint8Array(p.hwp)))
  } catch (e) {
    row.error = String(e?.message ?? e).slice(0, 200)
    failed++
    continue
  }
  const partNames = z => Object.keys(z.files).filter(n => !z.files[n].dir && !/^(Preview\/|settings\.xml|version\.xml|META-INF\/)/.test(n)).sort()
  const want = partNames(p.zip), got = partNames(out)
  row.partsSame = want.join("|") === got.join("|")
  if (!row.partsSame) row.parts = { missing: want.filter(n => !got.includes(n)), extra: got.filter(n => !want.includes(n)) }
  else partsOk++
  let textSame = true
  const acc = { total: 0, match: 0, first: [], miss(kind, want, got, path, w = 1) {
    const k = kinds.get(kind) ?? { n: 0, docs: new Set(), ex: [] }
    k.n += w; k.docs.add(p.rel)
    if (k.ex.length < 3) k.ex.push({ doc: p.rel, want, got, path })
    kinds.set(kind, k)
    if (this.first.length < showN) this.first.push({ kind, want, got, path })
  } }
  for (const name of want.filter(n => PART_RE.test(n))) {
    const truth = parseXml(await p.zip.file(name).async("string"))
    const mine = got.includes(name) ? parseXml(await out.file(name).async("string")) : { name: "#root", attrs: {}, children: [] }
    if (/section/.test(name) && tText(truth) !== tText(mine)) textSame = false
    if (!p.xml15) continue
    const before = [acc.total, acc.match]
    compareTree(mine, truth, name, acc)
    const slot = name.includes("header") ? agg.header : agg.section
    slot[0] += acc.total - before[0]; slot[1] += acc.match - before[1]
  }
  row.textSame = textSame
  if (textSame) textOk++
  if (p.xml15) {
    row.units = acc.total
    row.attrMatch = acc.total ? +(acc.match / acc.total).toFixed(5) : 1
    agg.total += acc.total; agg.match += acc.match
    if (acc.total === acc.match && row.partsSame) exact++
    if (acc.first.length) row.first = acc.first
  }
}

const xml15 = pairs.filter(p => p.xml15).length
const summary = {
  pairs: pairs.length, xml15, failed, skipped,
  attrMatch: agg.total ? +(agg.match / agg.total).toFixed(5) : null,
  headerMatch: agg.header[0] ? +(agg.header[1] / agg.header[0]).toFixed(5) : null,
  sectionMatch: agg.section[0] ? +(agg.section[1] / agg.section[0]).toFixed(5) : null,
  textMatch: pairs.length ? +(textOk / pairs.length).toFixed(5) : null,
  partsMatch: pairs.length ? +(partsOk / pairs.length).toFixed(5) : null,
  exact,
}
const top = [...kinds].sort((a, b) => b[1].n - a[1].n).slice(0, topN)
  .map(([kind, k]) => ({ kind, units: k.n, docs: k.docs.size, examples: k.ex }))

console.log(`HWP→HWPX ${pairs.length}짝(xml1.5 ${xml15}) · 실패 ${failed} · 제외 ${JSON.stringify(skipped)} · ${((performance.now() - t0) / 1000).toFixed(0)}s`)
console.log(`  속성 일치 ${summary.attrMatch} (header ${summary.headerMatch} · section ${summary.sectionMatch}) · 글 일치 ${summary.textMatch} · 항목 ${summary.partsMatch} · 완전 일치 ${exact}/${xml15}`)
for (const t of top) console.log(`  ${String(t.units).padStart(8)} ${String(t.docs).padStart(4)}문서  ${t.kind}  예) ${JSON.stringify(t.examples[0]).slice(0, 220)}`)
if (showN) for (const r of rows) if (r.first || r.error) console.log(`\n# ${r.pair} ${r.error ?? ""}\n` + (r.first ?? []).map(f => `  ${f.kind} want=${JSON.stringify(f.want)?.slice(0, 120)} got=${JSON.stringify(f.got)?.slice(0, 120)} @${f.path ?? ""}`).join("\n"))
writeFileSync(join(root, "out", "hwp2hwpx.json"), JSON.stringify({ generatedAt: new Date().toISOString(), summary, top, rows }, null, 1))

if (gateMode) {
  const fails = []
  if (summary.attrMatch < GATES.attrMatch) fails.push(`attrMatch ${summary.attrMatch} < ${GATES.attrMatch}`)
  if (summary.textMatch < GATES.textMatch) fails.push(`textMatch ${summary.textMatch} < ${GATES.textMatch}`)
  if (pairs.length < GATES.minPairs) fails.push(`pairs ${pairs.length} < ${GATES.minPairs}`)
  if (failed) fails.push(`변환 실패 ${failed}`)
  console.log(fails.length ? `GATE FAIL — ${fails.join(" · ")}` : "GATE PASS")
  if (fails.length) process.exit(1)
}
