#!/usr/bin/env node
// HWP3 sample 의 압축 해제된 body 에서 첫 paragraph 의 hchar 시퀀스를 dump.
// 어디서 ? glyph 가 나오는지 진단.

import { readFileSync } from "fs"
import { inflateRawSync } from "zlib"
import { argv } from "process"

const path = argv[2]
if (!path) {
  console.error("usage: debug-hwp3-stream.mjs <hwp3-file>")
  process.exit(2)
}
const data = readFileSync(path)
console.log("file size:", data.length)

// signature 30 + DocInfo 128 + DocSummary 1008 = 1166
let pos = 30
const compressedFlag = data.readUInt8(30 + 124)
const infoBlockLen = data.readUInt16LE(30 + 126)
console.log("compressed:", compressedFlag, "info_block_length:", infoBlockLen)

pos += 128 + 1008 + infoBlockLen
const tail = data.subarray(pos)
const body = compressedFlag !== 0 ? inflateRawSync(tail) : tail
console.log("body size (decompressed):", body.length)

// font faces (7 langs)
let p = 0
for (let lang = 0; lang < 7; lang++) {
  const n = body.readUInt16LE(p)
  p += 2 + n * 40
}
const nStyles = body.readUInt16LE(p)
p += 2 + nStyles * 238
console.log("after font/styles, paragraph start at body offset:", p, `(nStyles=${nStyles})`)

// First N paragraphs
function readPara(buf, off, label) {
  const followPrev = buf.readUInt8(off)
  const charCount = buf.readUInt16LE(off + 1)
  if (charCount === 0) {
    console.log(`  ${label} empty para — list end at ${off}`)
    return null
  }
  const lineCount = buf.readUInt16LE(off + 3)
  const includeCharShape = buf.readUInt8(off + 5)
  console.log(`  ${label} off=${off} charCount=${charCount} lineCount=${lineCount} followPrev=${followPrev} include_cs=${includeCharShape}`)
  let p = off + 43 + (followPrev === 0 ? 187 : 0) + lineCount * 14
  if (includeCharShape !== 0) {
    for (let i = 0; i < charCount; i++) {
      const flag = buf.readUInt8(p)
      p += 1 + (flag !== 1 ? 31 : 0)
    }
  }
  return { dataStart: p, charCount, end: p }
}

let off = p
for (let i = 0; i < 6; i++) {
  const r = readPara(body, off, `[para#${i}]`)
  if (!r) break
  // dump first 50 hchars
  const hchars = []
  let cur = r.dataStart
  for (let j = 0; j < Math.min(r.charCount, 60); j++) {
    if (cur + 1 >= body.length) break
    const ch = body.readUInt16LE(cur)
    hchars.push(ch.toString(16).padStart(4, "0"))
    cur += 2
    // 제어 문자가 아닌 경우 매번 2 byte. 제어 문자면 추가 byte 가 있어 한 hchar 가 여러 byte.
    // 단순 dump 용이라 정확한 i++ 무시 — 처음 60 byte 만.
  }
  console.log(`    first hchars: ${hchars.join(" ")}`)
  // 진짜 paragraph 끝을 알아내려면 char stream 전체 처리해야 함 — 여기선 다음 para 위치를 추정 못함
  break  // 첫 para 만 dump
}
