#!/usr/bin/env node
// rhwp 샘플 코퍼스 수집기 — edwardkim/rhwp(MIT) 저장소의 samples/(HWP·HWPX)와
// pdf/(한글 2022 OCX 변환 PDF — rhwp 가 "권위 정답지"로 쓰는 한컴 산출물)를 짝지어
// bench/corpus/<출력>/ 로 복사한다. 네트워크 없음 — 로컬 클론을 인자로 받는다.
//
// 사용법: node bench/collect-rhwp.mjs <rhwp 클론 경로> [출력서브디렉토리=rhwp]
// 예: git clone --depth 1 https://github.com/edwardkim/rhwp.git /tmp/rhwp
//     node bench/collect-rhwp.mjs /tmp/rhwp
//
// 배치: samples/<하위>/<stem>.<hwp|hwpx> → corpus/rhwp/<하위>/<stem>.<ext>,
// 짝 PDF 는 같은 자리 <stem>.pdf 로 (score.mjs PDF 트랙·HWP5 쌍 트랙·pdf-table-gt 가 동명 짝으로 잡는다).
// PDF 우선순위: -2022 > -2020 > -hwpx-2020 > -hwp-2020 > -2024 (rhwp pdf/README: 2022·2020 이 정답지 등급,
// 2010 은 등급 미달이라 제외). 기존 코퍼스와 바이트가 같은 파일은 건너뛴다(sha1) — 중복 가중 방지.
// 결과 목록·rhwp 커밋은 <출력>/MANIFEST.json 에 남긴다(재현용).
import { readdir, readFile, mkdir, copyFile, writeFile, stat } from "node:fs/promises"
import { join, relative, dirname, extname, basename } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"

const args = process.argv.slice(2)
const src = args[0]
if (!src) {
  console.error("사용법: node bench/collect-rhwp.mjs <rhwp 클론 경로> [출력서브디렉토리]")
  process.exit(2)
}
const outName = args[1] ?? "rhwp"
const corpusRoot = fileURLToPath(new URL("./corpus/", import.meta.url))
const outDir = join(corpusRoot, outName)

async function* walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) yield* walk(p)
    else yield p
  }
}
const sha1 = buf => createHash("sha1").update(buf).digest("hex")

// 기존 코퍼스 해시 (출력 폴더 자신은 제외 — 재실행 멱등)
const known = new Set()
for await (const f of walk(corpusRoot)) {
  if (f.startsWith(outDir + "/")) continue
  if (!/\.(hwpx?|pdf)$/i.test(f)) continue
  known.add(sha1(await readFile(f)))
}

// samples: stem → { rel 디렉토리, 확장자별 경로 }
const samplesDir = join(src, "samples")
const stems = new Map()
for await (const f of walk(samplesDir)) {
  const ext = extname(f).toLowerCase()
  if (ext !== ".hwp" && ext !== ".hwpx") continue
  const relDir = relative(samplesDir, dirname(f))
  const stem = basename(f, extname(f))
  const key = join(relDir, stem)
  const e = stems.get(key) ?? { relDir, stem, files: {} }
  e.files[ext] = f
  stems.set(key, e)
}

// pdf: <stem>(-hwp|-hwpx)?-(2020|2022|2024).pdf — 하위 폴더 구조는 samples 와 같다
const PDF_RANK = { "2022": 0, "2020": 1, "hwpx-2020": 2, "hwp-2020": 3, "2024": 4 }
const pdfFor = new Map()
for await (const f of walk(join(src, "pdf"))) {
  const m = /^(.*?)-(?:(hwpx|hwp)-)?(2020|2022|2024)\.pdf$/.exec(basename(f))
  if (!m) continue
  const rank = PDF_RANK[m[2] ? `${m[2]}-${m[3]}` : m[3]]
  if (rank === undefined) continue
  const key = join(relative(join(src, "pdf"), dirname(f)), m[1])
  const cur = pdfFor.get(key)
  if (!cur || rank < cur.rank) pdfFor.set(key, { path: f, rank })
}

let commit = ""
try { commit = execFileSync("git", ["-C", src, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() } catch {}

const manifest = { source: "https://github.com/edwardkim/rhwp", commit, collectedAt: new Date().toISOString(), files: [], skippedDuplicates: [] }
const seen = new Set()
let copied = 0
for (const [key, e] of [...stems].sort(([a], [b]) => a.localeCompare(b))) {
  const dst = join(outDir, e.relDir)
  let kept = 0
  for (const [ext, path] of Object.entries(e.files)) {
    const buf = await readFile(path)
    const h = sha1(buf)
    if (known.has(h) || seen.has(h)) { manifest.skippedDuplicates.push(relative(src, path)); continue }
    seen.add(h)
    await mkdir(dst, { recursive: true })
    await copyFile(path, join(dst, e.stem + ext))
    manifest.files.push({ path: join(e.relDir, e.stem + ext), from: relative(src, path), sha1: h, bytes: buf.length })
    kept++
    copied++
  }
  const pdf = pdfFor.get(key)
  if (pdf && kept > 0) {
    const buf = await readFile(pdf.path)
    const h = sha1(buf)
    if (known.has(h) || seen.has(h)) { manifest.skippedDuplicates.push(relative(src, pdf.path)); continue }
    seen.add(h)
    await copyFile(pdf.path, join(dst, e.stem + ".pdf"))
    manifest.files.push({ path: join(e.relDir, e.stem + ".pdf"), from: relative(src, pdf.path), sha1: h, bytes: buf.length })
    copied++
  }
}
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, "MANIFEST.json"), JSON.stringify(manifest, null, 1))
const byExt = {}
for (const f of manifest.files) byExt[extname(f.path)] = (byExt[extname(f.path)] ?? 0) + 1
console.log(`rhwp ${commit.slice(0, 10)} → corpus/${outName}: ${copied}파일 ${JSON.stringify(byExt)} | 중복 제외 ${manifest.skippedDuplicates.length}`)
