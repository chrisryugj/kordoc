#!/usr/bin/env node
// 스키프트 외부 정답 수집기 — schift-io/schift-ko-pii-v7 (Hugging Face) 의 benchmark/benchmark_v3.jsonl
// (473문장, {"text","spans":[[start,end,label]],"category"}) 을 받아 redact-bench.mjs 외부 정답 트랙에 쓴다.
//
// 라이선스: Schift License v2.0 (Apache 2.0 + 연매출 1천만 달러 초과 법인의 상업 사용 제한, 연구·평가는 항상 허용).
// 그래서 저장소에 넣지 않고 gitignore 된 bench/corpus/schift/ 에 받는다. 리비전을 고정하고 SHA-256 을 확인한다.
//
// 사용법: node bench/collect-schift.mjs [--out=디렉토리(기본 bench/corpus/schift)]
import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash } from "node:crypto"

const REVISION = "9d9bc145c57371fd5fd70575b47f37af47a39728" // 2026-09 main
const URL_ = `https://huggingface.co/schift-io/schift-ko-pii-v7/resolve/${REVISION}/benchmark/benchmark_v3.jsonl`
const SHA256 = "3b317e6782535ca11c70a9b6c48874ec0e7dd199f80f46b2d7d98134114ff0d1"

const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="))
const outDir = outArg ? outArg.slice(6) : fileURLToPath(new URL("./corpus/schift/", import.meta.url))

const res = await fetch(URL_)
if (!res.ok) { console.error(`받기 실패: HTTP ${res.status} ${URL_}`); process.exit(1) }
const buf = Buffer.from(await res.arrayBuffer())
const got = createHash("sha256").update(buf).digest("hex")
if (got !== SHA256) { console.error(`SHA-256 불일치 — 기대 ${SHA256}, 받음 ${got} (리비전 ${REVISION})`); process.exit(1) }
await mkdir(outDir, { recursive: true })
const out = join(outDir, "benchmark_v3.jsonl")
await writeFile(out, buf)
await writeFile(join(outDir, "SOURCE.txt"), `${URL_}\nsha256 ${SHA256}\nlicense: Schift License v2.0 (Apache 2.0 + revenue threshold) — 저장소에 커밋하지 말 것\n`)
console.log(`${out} (${buf.length} bytes, ${buf.toString("utf8").trim().split("\n").length}줄)`)
