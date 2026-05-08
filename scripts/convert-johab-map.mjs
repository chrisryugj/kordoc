#!/usr/bin/env node
// rhwp의 johab_map.rs JOHAB_SYMBOLS 테이블을 kordoc TS 모듈로 변환.
// 입력: rhwp/src/parser/hwp3/johab_map.rs
// 출력: kordoc/src/hwp3/johab-symbols.ts

import { readFileSync, writeFileSync } from "fs"
import { argv } from "process"

const inPath = argv[2]
const outPath = argv[3]
if (!inPath || !outPath) {
  console.error("usage: convert-johab-map.mjs <johab_map.rs> <johab-symbols.ts>")
  process.exit(2)
}

const src = readFileSync(inPath, "utf-8")
const re = /^\s*\(0x([0-9A-Fa-f]+),\s*'\\u\{([0-9A-Fa-f]+)\}'\),\s*$/gm
const pairs = []
let m
while ((m = re.exec(src)) !== null) {
  pairs.push([parseInt(m[1], 16), parseInt(m[2], 16)])
}
pairs.sort((a, b) => a[0] - b[0])

// flat array (key, value, key, value, ...) — 메모리 절약 + 이진 탐색 단순화
const out = [
  "// Auto-generated from rhwp/src/parser/hwp3/johab_map.rs — DO NOT EDIT.",
  "// Pairs of (johab-code, unicode-codepoint), sorted by key for binary search.",
  "// Total entries: " + pairs.length,
  "",
  "export const JOHAB_SYMBOLS: ReadonlyArray<number> = Object.freeze([",
]
const CHUNK = 8
for (let i = 0; i < pairs.length; i += CHUNK) {
  const slice = pairs.slice(i, i + CHUNK)
  const parts = slice.map(([k, v]) => `0x${k.toString(16).toUpperCase().padStart(4, "0")},0x${v.toString(16).toUpperCase().padStart(4, "0")}`)
  out.push("  " + parts.join(", ") + ",")
}
out.push("])")
out.push("")
writeFileSync(outPath, out.join("\n"), "utf-8")
console.log(`wrote ${pairs.length} entries → ${outPath}`)
