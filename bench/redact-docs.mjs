#!/usr/bin/env node
// 문서 단위 마스킹(redactDocument) 실코퍼스 점검 — 실제 HWPX/HWP 파일 안의 모든 글자 저장소를 가린 뒤
// 결과 파일에 PII 가 남는지, 결과가 다시 열리는지, 종전 경로(마크다운 편집 → patchHwpx/patchHwp)는
// 어디에 얼마나 남겼는지를 센다. 코퍼스의 PII 는 대부분 공무원 공개 연락처(담당자 전화·메일)다.
//
// 지표 (문서별 → 합계)
//   residual   : redactDocument 자체 재검사 잔존 — 결과 파일 컨테이너 + 재파싱 본문 (0 이어야 함)
//   unscanned  : 글자가 있을 자리인데 읽지 못한 파트·결과 재파싱 실패 (0 이어야 함)
//   leftover   : 결과 파일을 파서로 다시 읽은 마크다운에 redactMarkdown 이 찾는 PII (파서 경로 교차 검증, 0)
//   identity   : 탐지 0 건 문서는 결과가 원본과 같아야 함 (불필요한 변경 0). HWP 는 미할당 영역을 늘
//                비우므로 바이트 대신 OLE 스트림 내용을 비교한다 (비운 문서 수는 따로 센다)
//   oldLeaks   : 종전 경로 결과 파일을 같은 컨테이너 검사기로 훑은 잔존 — 위치별
//
// 사용법: node --import tsx bench/redact-docs.mjs [--gate] [--limit=N] [--dirs=a,b] [--no-old] [--rules=r,…]
//   기본은 bench/corpus 전체를 하위 폴더까지 (HWPX·HWP). --dirs 는 코퍼스 아래 폴더 목록.
//   --rules 는 적용 룰(기본 DEFAULT_REDACT_RULES) — opt-in 인명·주소 룰의 파일 단위 잔존 점검용
//   (src 를 직접 불러 tsx 로더가 필요하다 — redactDocument 는 아직 index 에서 재수출하지 않음)

import { readdir, readFile, realpath, stat } from "node:fs/promises"
import { join, extname, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { parse, patchHwpx, patchHwp } from "../src/index.ts"
import { redactMarkdown, DEFAULT_REDACT_RULES } from "../src/redact.ts"
import { redactDocument } from "../src/redact-doc.ts"
import { literalsFromMarkdown } from "../src/redact-scrub.ts"
import { scrubHwpx } from "../src/redact-hwpx.ts"
import { scrubHwp5 } from "../src/redact-hwp5.ts"

const root = fileURLToPath(new URL(".", import.meta.url))
const args = process.argv.slice(2)
const opt = (name) => { const a = args.find(x => x.startsWith(`--${name}=`)); return a ? a.slice(name.length + 3) : undefined }
const gateMode = args.includes("--gate")
const withOld = !args.includes("--no-old")
const limit = Number(opt("limit") ?? Infinity)
const DIRS = (opt("dirs") ?? "").split(",")
const RULES = opt("rules") ? opt("rules").split(",") : DEFAULT_REDACT_RULES
const CFB = createRequire(import.meta.url)("cfb")

/** 폴더 아래 모든 파일 — 하위 폴더·심링크까지 (같은 실경로는 한 번만) */
async function walk(dir, seen = new Set()) {
  let real
  try { real = await realpath(dir) } catch { return [] }
  if (seen.has(real)) return []
  seen.add(real)
  const out = []
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    let isDir = e.isDirectory(), isFile = e.isFile()
    if (e.isSymbolicLink()) { try { const st = await stat(p); isDir = st.isDirectory(); isFile = st.isFile() } catch { continue } }
    if (isDir) out.push(...await walk(p, seen))
    else if (isFile) out.push(p)
  }
  return out.sort()
}

/** HWP(OLE) 두 파일의 스트림 내용이 모두 같은가 — 미할당 영역만 다른 경우 true */
function sameStreams(a, b) {
  const ca = CFB.parse(Buffer.from(a)), cb = CFB.parse(Buffer.from(b))
  const map = (c) => new Map(c.FullPaths.map((p, i) => [p, c.FileIndex[i]]).filter(([, e]) => e.type === 2).map(([p, e]) => [p, Buffer.from(e.content ?? [])]))
  const ma = map(ca), mb = map(cb)
  if (ma.size !== mb.size) return false
  for (const [p, x] of ma) { const y = mb.get(p); if (!y || !x.equals(y)) return false }
  return true
}

const ab = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength)
const tally = { docs: 0, withHits: 0, errors: 0, residual: 0, unscanned: 0, leftover: 0, reparseFail: 0, identityBreak: 0, slackWiped: 0, fileHits: 0, mdHits: 0 }
const byWhere = {}, oldByWhere = {}, errKinds = {}, times = []
let oldLeakDocs = 0, oldLeaks = 0, oldPatchFail = 0
const samples = []
const corpusRoot = join(root, "corpus")
const seenFiles = new Set()

for (const dir of DIRS) {
  const files = (await walk(join(corpusRoot, dir))).filter(f => /\.(hwpx|hwp)$/i.test(f))
  for (const path of files) {
    if (tally.docs >= limit) break
    const f = relative(corpusRoot, path)
    if (seenFiles.has(f)) continue
    seenFiles.add(f)
    const bytes = new Uint8Array(await readFile(path))
    tally.docs++
    const t0 = performance.now()
    let r
    try {
      r = await redactDocument(bytes, { rules: RULES })
    } catch (e) {
      tally.errors++
      const k = String(e?.message ?? e).slice(0, 60)
      errKinds[k] = (errKinds[k] ?? 0) + 1
      continue
    }
    times.push(performance.now() - t0)
    tally.fileHits += r.fileHits.length
    tally.mdHits += r.markdownHits.length
    tally.residual += r.residual.length
    tally.unscanned += r.unscanned.length
    for (const h of r.fileHits) byWhere[h.where] = (byWhere[h.where] ?? 0) + 1
    if (r.residual.length && samples.length < 20) samples.push(`${f}: residual ${r.residual.map(h => `${h.rule} ${h.masked} @ ${h.part}`).join("; ")}`)
    if (r.unscanned.length && samples.length < 20) samples.push(`${f}: unscanned ${r.unscanned.join("; ")}`)
    const found = r.fileHits.length + r.markdownHits.length > 0
    if (found) tally.withHits++
    if (!found && r.data && r.changed) {
      if (r.format === "hwp" && sameStreams(r.data, bytes)) tally.slackWiped++
      else { tally.identityBreak++; if (samples.length < 20) samples.push(`${f}: 탐지 0건인데 내용이 바뀜`) }
    }
    if (r.data && r.changed) {
      const re = await parse(ab(r.data))
      if (!re.success) { tally.reparseFail++; samples.push(`${f}: 재파싱 실패 ${re.error}`) }
      else {
        const left = redactMarkdown(re.markdown, { rules: RULES }).hits
        tally.leftover += left.length
        if (left.length && samples.length < 20) samples.push(`${f}: leftover ${left.map(h => `${h.rule} ${h.masked}`).join("; ")}`)
      }
    }
    // 종전 경로 — 마크다운 편집 역반영
    if (withOld && found) {
      const parsed = await parse(ab(bytes))
      if (!parsed.success) continue
      const md = redactMarkdown(parsed.markdown, { rules: RULES })
      const isHwp = r.format === "hwp"
      const p = isHwp ? await patchHwp(bytes, md.text) : await patchHwpx(bytes, md.text)
      if (!p.success || !p.data) { oldPatchFail++; continue }
      const ctx = { rules: RULES, maskChar: "●", literals: literalsFromMarkdown(parsed.markdown, md.hits) }
      const check = await (isHwp ? scrubHwp5 : scrubHwpx)(p.data, ctx, "check")
      if (check.hits.length) { oldLeakDocs++; oldLeaks += check.hits.length }
      for (const h of check.hits) oldByWhere[h.where] = (oldByWhere[h.where] ?? 0) + 1
    }
  }
}

times.sort((a, b) => a - b)
const pct = (p) => times.length ? times[Math.min(times.length - 1, Math.floor(times.length * p))].toFixed(0) : "-"
console.log(`# redact 문서 단위 실코퍼스 — HWPX/HWP ${tally.docs}건 (PII 탐지 문서 ${tally.withHits}) · 룰 ${RULES.join(",")}`)
console.log(`오류 ${tally.errors} ${JSON.stringify(errKinds)}`)
console.log(`파일 안 가림 ${tally.fileHits}건 (본문 마크다운 탐지 ${tally.mdHits}) — 위치별 ${JSON.stringify(byWhere)}`)
console.log(`잔존(residual) ${tally.residual} · 미검사(unscanned) ${tally.unscanned} · 재파싱 잔여(leftover) ${tally.leftover} · 재파싱 실패 ${tally.reparseFail} · 무탐지 문서 내용 변경 ${tally.identityBreak} · 무탐지 HWP 미할당 영역만 비움 ${tally.slackWiped}`)
console.log(`처리 시간 p50 ${pct(0.5)}ms · p95 ${pct(0.95)}ms · max ${pct(1)}ms`)
if (withOld) console.log(`종전 경로(patchHwpx/patchHwp): ${oldLeakDocs}개 문서에 PII ${oldLeaks}건 잔존 — 위치별 ${JSON.stringify(oldByWhere)} (patch 실패 ${oldPatchFail})`)
for (const s of samples) console.log("  " + s)

if (gateMode) {
  const fails = []
  if (tally.residual > 0) fails.push(`residual ${tally.residual} > 0`)
  if (tally.unscanned > 0) fails.push(`unscanned ${tally.unscanned} > 0`)
  if (tally.leftover > 0) fails.push(`leftover ${tally.leftover} > 0`)
  if (tally.reparseFail > 0) fails.push(`재파싱 실패 ${tally.reparseFail} > 0`)
  if (tally.identityBreak > 0) fails.push(`무탐지 문서 내용 변경 ${tally.identityBreak} > 0`)
  if (fails.length) { console.log(`\n❌ 게이트 실패:\n  ${fails.join("\n  ")}`); process.exit(1) }
  console.log("\n✅ 게이트 통과")
}
